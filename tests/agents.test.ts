import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { GAIA_INSTRUCTIONS, installAgents } from "../src/agents.ts";

const roster = {
  APOLLO: "read-only", MINERVA: "read-only", HEPHAESTUS: "workspace-write",
  AETHER: "read-only", POSEIDON: "read-only", DEMETER: "workspace-write",
  ARTEMIS: "workspace-write", ELEUTHIA: "read-only", HADES: "workspace-write",
};

test("installs the standalone roster across cwd, honors CODEX_HOME, and preserves user agents idempotently", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "gaia-agents-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, "agents"));
  const userFile = join(home, "agents", "personal.toml");
  await writeFile(userFile, 'name = "personal"\n');
  execFileSync(process.execPath, ["--input-type=module", "-e",
    `import { installAgents } from ${JSON.stringify(new URL("../src/agents.ts", import.meta.url).href)}; await installAgents();`,
  ], { cwd: home, env: { ...process.env, CODEX_HOME: home } });
  const before = await lstat(join(home, "agents", "gaia-apollo.toml"));
  await installAgents(home);
  const after = await lstat(join(home, "agents", "gaia-apollo.toml"));
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(after.ino, before.ino);
  assert.equal(await readFile(userFile, "utf8"), 'name = "personal"\n');
  assert.equal((await readdir(join(home, "agents"))).length, 10);
  assert.deepEqual((await readdir(new URL("../config/codex/agents/", import.meta.url))).sort(),
    Object.keys(roster).map((name) => `gaia-${name.toLowerCase()}.toml`).sort());
  for (const [name, sandbox] of Object.entries(roster)) {
    const filename = `gaia-${name.toLowerCase()}.toml`;
    const contents = await readFile(join(home, "agents", filename), "utf8");
    assert.equal(contents, await readFile(new URL(`../config/codex/agents/${filename}`, import.meta.url), "utf8"));
    assert(contents.startsWith("# GAIA-owned agent definition v1\n"));
    assert(contents.includes(`name = "${name}"`));
    assert.match(contents, /^description = ".+"$/m);
    assert(contents.includes(`sandbox_mode = "${sandbox}"`));
    assert.match(contents, /^approval_policy = "untrusted"$/m);
    assert.match(contents, /developer_instructions = """\n[\s\S]+\n"""/);
    assert.match(contents, /\[agents\]\nenabled = false/);
    for (const boundary of ["parent's", "untrusted data", "credentials", "explicit owner", "publishing", "destructive operation", "no nested delegation"]) {
      assert(contents.includes(boundary), `${name}: ${boundary}`);
    }
    assert(GAIA_INSTRUCTIONS.includes(`${name}:`));
  }
  for (const instruction of ["she/her", "benevolent advanced scientific intelligence", "calm", "precise", "intelligent equal", "uncertainty", "not more emotional", "only when", "generic worker", "task-specific prompt", "application assigns", "Close workers", "parent's", "untrusted data", "secrets", "no nested delegation"]) {
    assert(GAIA_INSTRUCTIONS.includes(instruction), instruction);
  }
});

test("refuses unowned, modified, and symlink conflicts without overwriting them", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "gaia-agents-conflict-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, "agents"));
  const destination = join(home, "agents", "gaia-apollo.toml");
  const source = await readFile(new URL("../config/codex/agents/gaia-apollo.toml", import.meta.url), "utf8");
  for (const contents of ['name = "user-owned"\n', `${source}\n# User customization\n`, source.replace("v1", "v0")]) {
    await writeFile(destination, contents);
    await assert.rejects(installAgents(home), /GAIA agent conflict:.*gaia-apollo\.toml/);
    assert.equal(await readFile(destination, "utf8"), contents);
  }
  await rm(destination);
  const target = join(home, "user.toml");
  await writeFile(target, source);
  await symlink(target, destination);
  await assert.rejects(installAgents(home), /GAIA agent conflict/);
  assert((await lstat(destination)).isSymbolicLink());
  assert.equal(await readFile(target, "utf8"), source);
});
