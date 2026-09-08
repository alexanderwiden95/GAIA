import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import type { Pool } from "pg";
import { createPool } from "../src/db.ts";
import { forgetPreference, listPreferences, savePreference } from "../src/preferences.ts";

test("preferences persist across channels, replace values, and can be forgotten", async () => {
  const pool = createPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // All migration and CRUD writes are confined to connection-local temporary tables.
    await client.query("SET LOCAL search_path TO pg_temp");
    await client.query("CREATE TEMP TABLE channels (discord_channel_id text PRIMARY KEY, codex_thread_id text, updated_at timestamptz)");
    await client.query("INSERT INTO channels VALUES ('one', 'old-thread', now()), ('two', NULL, now())");
    await client.query(await readFile(new URL("../migrations/008_owner_preferences.sql", import.meta.url), "utf8"));
    assert.equal((await client.query("SELECT codex_thread_id FROM channels WHERE discord_channel_id = 'one'")).rows[0].codex_thread_id, null);
    const store = client as unknown as Pool;
    await savePreference(store, { key: "tone", value: "Formal" }, "one", "first");
    await savePreference(store, { key: "tone", value: "Direct" }, "two", "correction");
    await savePreference(store, { key: "language", value: "Swedish" }, "one", "third");
    assert.deepEqual(await listPreferences(store), [{ key: "language", value: "Swedish" }, { key: "tone", value: "Direct" }]);
    const source = await client.query("SELECT source_channel_id, source_discord_id FROM owner_preferences WHERE key = 'tone'");
    assert.deepEqual(source.rows[0], { source_channel_id: "two", source_discord_id: "correction" });
    await savePreference(store, { key: "tone", value: "Direct" }, "one", "duplicate");
    assert.equal((await client.query("SELECT source_discord_id FROM owner_preferences WHERE key = 'tone'")).rows[0].source_discord_id, "correction");
    assert.equal(await forgetPreference(store, "tone"), true);
    assert.equal(await forgetPreference(store, "tone"), false);
    assert.deepEqual(await listPreferences(store), [{ key: "language", value: "Swedish" }]);
  } finally {
    await client.query("ROLLBACK");
    client.release();
    await pool.end();
  }
});
