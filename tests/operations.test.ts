import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JsonLogger, redact } from "../src/logger.ts";
import { launchAgentPlist, pruneBackups } from "../src/operations.ts";

test("restart orders services and leaves the daemon stopped if database startup fails", { skip: process.platform !== "darwin" }, async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "gaia-restart-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const log = join(directory, "calls");
  for (const command of ["docker", "launchctl"]) {
    await writeFile(join(directory, command), `#!/bin/sh
printf '%s %s\\n' '${command}' "$*" >> "$RESTART_TEST_LOG"
if [ "$1" = "compose" ] && [ "$2" = "up" ] && [ "$RESTART_TEST_FAIL" = "1" ]; then exit 1; fi
`, { mode: 0o700 });
  }
  const env = { PATH: directory, RESTART_TEST_LOG: log };
  const script = new URL("../src/operations.ts", import.meta.url).pathname;
  await promisify(execFile)(process.execPath, [script, "restart"], { env });
  const calls = (await readFile(log, "utf8")).trim().split("\n");
  assert.equal(calls.length, 5);
  assert.match(calls[0]!, /^launchctl print gui\//);
  assert.match(calls[1]!, /^launchctl bootout gui\//);
  assert.equal(calls[2], "docker compose restart postgres");
  assert.equal(calls[3], "docker compose up -d --wait");
  assert.match(calls[4]!, /^launchctl bootstrap gui\//);
  await writeFile(log, "");
  await assert.rejects(promisify(execFile)(process.execPath, [script, "restart"], {
    env: { ...env, RESTART_TEST_FAIL: "1" },
  }));
  assert(!(await readFile(log, "utf8")).includes("bootstrap"));
});

test("structured logs redact secrets and rotate", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "gaia-log-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const logger = new JsonLogger(directory, 100, 2);
  logger.write("error", "test", "Authorization: Basic dXNlcjpwYXNz Cookie: session=private; csrf=hidden password=hunter2 postgresql://gaia:secret@localhost/gaia");
  logger.write("info", "test", "rotate");
  const content = await readFile(`${logger.path}.1`, "utf8");
  const record = JSON.parse(content) as Record<string, string>;
  assert.equal(record.level, "error");
  assert.equal(record.component, "test");
  assert(!content.includes("dXNlcjpwYXNz"));
  assert(!content.includes("private"));
  assert(!content.includes("hidden"));
  assert(!content.includes("hunter2"));
  assert(!content.includes(":secret@"));
  assert.equal(logger.recentFailures().length, 1);
  assert(!redact("Cookie: first=one; second=two\nAuthorization: Basic abc123").match(/one|two|abc123/));
  assert(!redact('{"Cookie":"theme=dark; session=EXAMPLE"}').includes("EXAMPLE"));
});

test("LaunchAgent pins its executable and restart policy", () => {
  const plist = launchAgentPlist("/node-24/bin/node", "/repo&gaia");
  assert(plist.includes("/node-24/bin/node"));
  assert(plist.includes("/repo&amp;gaia"));
  assert(plist.includes("<key>RunAtLoad</key><true/>"));
  assert(plist.includes("<key>SuccessfulExit</key><false/>"));
  assert(plist.includes("/opt/homebrew/bin"));
});

test("backup retention keeps the newest files", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "gaia-backup-test-"));
  context.after(() => rm(directory, { recursive: true, force: true }));
  const names = ["gaia-20260908T100000Z.dump", "gaia-20260908T110000Z.dump", "gaia-20260908T120000Z.dump"];
  await Promise.all(names.map((name) => import("node:fs/promises").then(({ writeFile }) => writeFile(join(directory, name), "test"))));
  assert.deepEqual(await pruneBackups(directory, 2), [names[0]]);
});
