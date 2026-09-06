import assert from "node:assert/strict";
import test from "node:test";

import { createPool, getOrCreateChannel, runMigrations, saveMessage, setChannelThread, setMessageTurn } from "../src/db.ts";

test("foundation migrations are repeatable", async (context) => {
  const pool = createPool();
  context.after(() => pool.end());
  await runMigrations(pool);
  assert.deepEqual(await runMigrations(pool), []);
  const tables = await pool.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('channels', 'messages', 'approvals', 'action_log')
    ORDER BY table_name
  `);
  assert.deepEqual(tables.rows.map((row) => row.table_name), ["action_log", "approvals", "channels", "messages"]);
  assert.equal((await pool.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'")).rowCount, 1);
});

test("channel threads and visible messages persist without duplicates", async (context) => {
  const pool = createPool();
  const channelId = "999999999999999991";
  const messageId = "999999999999999992";
  await runMigrations(pool);
  await pool.query("DELETE FROM messages WHERE channel_id = $1", [channelId]);
  await pool.query("DELETE FROM channels WHERE discord_channel_id = $1", [channelId]);
  context.after(async () => {
    await pool.query("DELETE FROM messages WHERE channel_id = $1", [channelId]);
    await pool.query("DELETE FROM channels WHERE discord_channel_id = $1", [channelId]);
    await pool.end();
  });

  assert.equal(await getOrCreateChannel(pool, channelId, "phase-2-test"), null);
  await setChannelThread(pool, channelId, "thread-test");
  assert.equal(await getOrCreateChannel(pool, channelId, "renamed"), "thread-test");
  assert.equal(await saveMessage(pool, { discordId: messageId, channelId, role: "user", content: "hello" }), true);
  assert.equal(await saveMessage(pool, { discordId: messageId, channelId, role: "user", content: "hello" }), false);
  await setMessageTurn(pool, messageId, "turn-test");

  const stored = await pool.query("SELECT name, codex_thread_id FROM channels WHERE discord_channel_id = $1", [channelId]);
  const message = await pool.query("SELECT content, codex_turn_id FROM messages WHERE discord_message_id = $1", [messageId]);
  assert.deepEqual(stored.rows[0], { name: "renamed", codex_thread_id: "thread-test" });
  assert.deepEqual(message.rows[0], { content: "hello", codex_turn_id: "turn-test" });
});
