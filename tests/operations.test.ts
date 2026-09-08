import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { JsonLogger, redact } from "../src/logger.ts";
import { launchAgentPlist, pruneBackups } from "../src/operations.ts";

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
