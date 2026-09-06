import assert from "node:assert/strict";
import test from "node:test";

import {
  createApproval,
  createPool,
  decideApproval,
  getOrCreateChannel,
  logAction,
  messageExists,
  runMigrations,
  saveMessage,
  setChannelThread,
  setChannelWorkspace,
  setMessageTurn,
} from "../src/db.ts";

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
  await pool.query("DELETE FROM action_log WHERE channel_id = $1", [channelId]);
  await pool.query("DELETE FROM approvals WHERE channel_id = $1", [channelId]);
  await pool.query("DELETE FROM messages WHERE channel_id = $1", [channelId]);
  await pool.query("DELETE FROM channels WHERE discord_channel_id = $1", [channelId]);
  context.after(async () => {
    await pool.query("DELETE FROM action_log WHERE channel_id = $1", [channelId]);
    await pool.query("DELETE FROM approvals WHERE channel_id = $1", [channelId]);
    await pool.query("DELETE FROM messages WHERE channel_id = $1", [channelId]);
    await pool.query("DELETE FROM channels WHERE discord_channel_id = $1", [channelId]);
    await pool.end();
  });

  assert.deepEqual(await getOrCreateChannel(pool, channelId, "phase-2-test"), { threadId: null, workspacePath: null });
  await setChannelThread(pool, channelId, "thread-test");
  await setChannelWorkspace(pool, channelId, "/tmp/gaia-workspace-test");
  assert.deepEqual(await getOrCreateChannel(pool, channelId, "renamed"), {
    threadId: null,
    workspacePath: "/tmp/gaia-workspace-test",
  });
  assert.equal(await saveMessage(pool, { discordId: messageId, channelId, role: "user", content: "hello" }), true);
  assert.equal(await saveMessage(pool, { discordId: messageId, channelId, role: "user", content: "hello" }), false);
  assert.equal(await messageExists(pool, messageId), true);
  await setMessageTurn(pool, messageId, "turn-test");

  const stored = await pool.query("SELECT name, codex_thread_id FROM channels WHERE discord_channel_id = $1", [channelId]);
  const message = await pool.query("SELECT content, codex_turn_id FROM messages WHERE discord_message_id = $1", [messageId]);
  assert.deepEqual(stored.rows[0], { name: "renamed", codex_thread_id: null });
  assert.deepEqual(message.rows[0], { content: "hello", codex_turn_id: "turn-test" });

  const approvalId = "99999999-9999-4999-8999-999999999999";
  await createApproval(pool, { requestId: approvalId, channelId, kind: "command", agent: "GAIA", risk: "local command" });
  assert.equal(await decideApproval(pool, approvalId, "approved"), true);
  assert.equal(await decideApproval(pool, approvalId, "denied"), false);
  await logAction(pool, { channelId, agent: "GAIA", action: "approval_approved", details: { kind: "command" } });
  assert.deepEqual((await pool.query("SELECT status, request, decision FROM approvals WHERE request_id = $1", [approvalId])).rows[0], {
    status: "approved",
    request: { kind: "command", agent: "GAIA", risk: "local command" },
    decision: { status: "approved" },
  });
});
