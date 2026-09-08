import { spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const LABEL = "com.alexanderwiden.gaia";
const BACKUP_DIRECTORY = process.env.GAIA_BACKUP_DIR?.trim() || join(homedir(), "Library", "Application Support", "GAIA", "backups");
const LAUNCH_AGENT = join(homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const RETAINED_BACKUPS = 14;

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

export function launchAgentPlist(node = process.execPath, root = ROOT): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key><array><string>${xml(node)}</string><string>--env-file-if-exists=.env</string><string>src/index.ts</string></array>
  <key>WorkingDirectory</key><string>${xml(root)}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>/dev/null</string>
  <key>StandardErrorPath</key><string>/dev/null</string>
</dict></plist>
`;
}

async function run(command: string, args: string[], input?: string): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: [input ? "pipe" : "ignore", "inherit", "inherit"] });
    if (input && child.stdin) createReadStream(input).pipe(child.stdin);
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolvePromise() : reject(new Error(`${basename(command)} exited with status ${code ?? "unknown"}`)));
  });
}

async function docker(args: string[], input?: string): Promise<void> {
  await run("docker", ["compose", ...args], input);
}

async function dockerOutput(args: string[]): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn("docker", ["compose", ...args], { cwd: ROOT, stdio: ["ignore", "pipe", "ignore"] });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output = `${output}${chunk}`.slice(-1_000); });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolvePromise(output) : reject(new Error("Could not inspect local PostgreSQL activity")));
  });
}

async function databaseInUse(): Promise<boolean> {
  const output = await dockerOutput(["exec", "-T", "postgres", "psql", "-U", "gaia", "-d", "postgres", "-tAc", "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE application_name = 'gaia-daemon')"]);
  return output.trim() === "t";
}

async function serviceLoaded(): Promise<boolean> {
  if (process.platform !== "darwin") return false;
  return new Promise((resolvePromise, reject) => {
    const child = spawn("launchctl", ["print", `gui/${process.getuid?.()}/${LABEL}`], { stdio: "ignore" });
    child.once("error", reject);
    child.once("exit", (code) => resolvePromise(code === 0));
  });
}

export async function pruneBackups(directory = BACKUP_DIRECTORY, keep = RETAINED_BACKUPS): Promise<string[]> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const backups = (await readdir(directory)).filter((name) => /^gaia-\d{8}T\d{6}(?:\.\d{3})?Z\.dump$/.test(name)).sort().reverse();
  const removed = backups.slice(keep);
  await Promise.all(removed.map((name) => rm(join(directory, name))));
  return removed;
}

export async function backupDatabase(directory = BACKUP_DIRECTORY): Promise<string> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const timestamp = new Date().toISOString().replaceAll(/[-:]/g, "");
  const destination = join(directory, `gaia-${timestamp}.dump`);
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    await new Promise<void>((resolvePromise, reject) => {
      const output = createWriteStream(temporary, { flags: "wx", mode: 0o600 });
      const child = spawn("docker", ["compose", "exec", "-T", "postgres", "pg_dump", "-U", "gaia", "-d", "gaia", "-Fc"], { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] });
      let exited = false;
      let closed = false;
      const done = (): void => { if (exited && closed) resolvePromise(); };
      child.stdout.pipe(output);
      output.once("close", () => { closed = true; done(); });
      output.once("error", reject);
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code !== 0) reject(new Error(`pg_dump exited with status ${code ?? "unknown"}`));
        else { exited = true; done(); }
      });
    });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  await pruneBackups(directory);
  return destination;
}

export async function restoreDatabase(path: string, confirmed: boolean): Promise<void> {
  if (!confirmed) throw new Error("Restore is destructive; repeat with --confirm after stopping GAIA");
  if (await serviceLoaded() || await databaseInUse()) throw new Error("GAIA is still running; stop every daemon instance before restore");
  const source = resolve(path);
  if (!(await stat(source)).isFile()) throw new Error("Backup path must be a file");
  await verifyBackup(source);
  await docker(["exec", "-T", "postgres", "dropdb", "-U", "gaia", "--force", "--if-exists", "gaia"]);
  await docker(["exec", "-T", "postgres", "createdb", "-U", "gaia", "-O", "gaia", "gaia"]);
  await docker(["exec", "-T", "postgres", "pg_restore", "-U", "gaia", "-d", "gaia", "--exit-on-error"], source);
}

export async function verifyBackup(path: string): Promise<void> {
  const database = `gaia_verify_${process.pid}`;
  try {
    await docker(["exec", "-T", "postgres", "createdb", "-U", "gaia", "-O", "gaia", database]);
    await docker(["exec", "-T", "postgres", "pg_restore", "-U", "gaia", "-d", database, "--exit-on-error"], resolve(path));
    await docker(["exec", "-T", "postgres", "psql", "-U", "gaia", "-d", database, "-v", "ON_ERROR_STOP=1", "-c", "SELECT count(*) FROM schema_migrations"]);
  } finally {
    await docker(["exec", "-T", "postgres", "dropdb", "-U", "gaia", "--force", "--if-exists", database]).catch(() => undefined);
  }
}

export async function latestBackupStatus(directory = BACKUP_DIRECTORY): Promise<string> {
  try {
    const names = (await readdir(directory)).filter((name) => /^gaia-\d{8}T\d{6}(?:\.\d{3})?Z\.dump$/.test(name)).sort();
    if (!names.length) return "ERROR - run `npm run backup`";
    const newest = await stat(join(directory, names.at(-1)!));
    const hours = Math.floor((Date.now() - newest.mtimeMs) / 3_600_000);
    return hours > 48 ? `ERROR - newest backup is ${hours} hours old` : `OK - newest backup is ${hours} hours old`;
  } catch {
    return "ERROR - run `npm run backup`";
  }
}

async function install(): Promise<void> {
  if (Number(process.versions.node.split(".")[0]) !== 24) throw new Error("Run service installation with Node.js 24 (`nvm use`)");
  await docker(["up", "-d", "--wait"]);
  for (const localSecret of [join(ROOT, ".env"), join(ROOT, "client-secret.json")]) await chmod(localSecret, 0o600).catch(() => undefined);
  await mkdir(dirname(LAUNCH_AGENT), { recursive: true });
  await writeFile(LAUNCH_AGENT, launchAgentPlist(), { mode: 0o600 });
  const domain = `gui/${process.getuid?.()}`;
  if (await serviceLoaded()) await run("launchctl", ["bootout", domain, LAUNCH_AGENT]);
  await run("launchctl", ["bootstrap", domain, LAUNCH_AGENT]);
}

async function uninstall(): Promise<void> {
  const domain = `gui/${process.getuid?.()}`;
  if (await serviceLoaded()) await run("launchctl", ["bootout", domain, LAUNCH_AGENT]);
  if (await serviceLoaded()) throw new Error("GAIA did not stop; restore is blocked");
  await rm(LAUNCH_AGENT, { force: true });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = process.argv[2];
  if (command === "install") await install();
  else if (command === "uninstall") await uninstall();
  else if (command === "backup") console.log(await backupDatabase());
  else if (command === "prune") console.log(`Removed ${(await pruneBackups()).length} old backups`);
  else if (command === "restore" && process.argv[3]) await restoreDatabase(process.argv[3], process.argv.includes("--confirm"));
  else if (command === "verify" && process.argv[3]) await verifyBackup(process.argv[3]);
  else throw new Error("Usage: operations.ts install|uninstall|backup|prune|restore <dump> --confirm|verify <dump>");
}
