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
import { ProactivityService, type ProactiveDelivery } from "../src/scheduler.ts";

test("foundation migrations are repeatable", async (context) => {
  const pool = createPool();
  context.after(() => pool.end());
  await runMigrations(pool);
  assert.deepEqual(await runMigrations(pool), []);
  const tables = await pool.query<{ table_name: string }>(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN ('channels', 'messages', 'approvals', 'action_log', 'memories', 'followups', 'proactive_digests')
    ORDER BY table_name
  `);
  assert.deepEqual(tables.rows.map((row) => row.table_name), ["action_log", "approvals", "channels", "followups", "memories", "messages", "proactive_digests"]);
  assert.equal((await pool.query("SELECT extversion FROM pg_extension WHERE extname = 'vector'")).rowCount, 1);
  assert.equal((await pool.query("SELECT 1 FROM pg_indexes WHERE indexname IN ('messages_search_idx', 'memories_search_idx')")).rowCount, 2);
});

test("proactive notifications survive restart without duplication and owner actions persist", async (context) => {
  const pool = createPool();
  const channelId = "999999999999999972";
  const now = new Date("2026-09-08T10:00:00.000Z");
  const deliveries: ProactiveDelivery[] = [];
  const config = { channelId, timezone: "UTC", digestTime: "09:00", quietStart: "22:00", quietEnd: "07:00" };
  await runMigrations(pool);
  await getOrCreateChannel(pool, channelId, "scheduler-test");
  await pool.query("DELETE FROM followups WHERE tool_call_id LIKE 'scheduler-%'");
  await pool.query("DELETE FROM followups WHERE source_channel_id = $1", [channelId]);
  await pool.query("DELETE FROM proactive_digests WHERE local_date = '2026-09-08'");
  context.after(async () => {
    await pool.query("DELETE FROM followups WHERE source_channel_id = $1", [channelId]);
    await pool.query("DELETE FROM followups WHERE tool_call_id LIKE 'scheduler-%'");
    await pool.query("DELETE FROM proactive_digests WHERE local_date = '2026-09-08'");
    await pool.query("DELETE FROM channels WHERE discord_channel_id = $1", [channelId]);
    await pool.end();
  });

  const service = new ProactivityService(pool, config, async (delivery) => { deliveries.push(delivery); }, () => now);
  const dueId = await service.record({
    channelId,
    sourceDiscordId: "999999999999999973",
    toolCallId: "scheduler-due",
    kind: "explicit_date",
    title: "Check the contract",
    dueAt: "2026-09-08T09:00:00Z",
  });
  assert.equal(await service.record({
    channelId,
    sourceDiscordId: "999999999999999973",
    toolCallId: "scheduler-due",
    kind: "explicit_date",
    title: "Check the contract",
    dueAt: "2026-09-08T09:00:00Z",
  }), dueId);
  await service.runOnce();
  await service.runOnce();
  const restarted = new ProactivityService(pool, config, async (delivery) => { deliveries.push(delivery); }, () => now);
  await restarted.runOnce();
  assert.deepEqual(deliveries.map((delivery) => delivery.type), ["followup", "digest"]);

  const raceId = await service.record({ channelId, sourceDiscordId: "0", toolCallId: "scheduler-race", kind: "promise", title: "Race", dueAt: "2026-09-08T09:00:00Z" });
  let raceService!: ProactivityService;
  raceService = new ProactivityService(pool, config, async (delivery) => {
    if (delivery.type === "followup") await raceService.update(delivery.followup.id, "snooze");
  }, () => now);
  await raceService.runOnce();
  const raced = (await pool.query("SELECT due_at, notified_at FROM followups WHERE id = $1", [raceId])).rows[0];
  assert.equal(raced.due_at.toISOString(), "2026-09-09T10:00:00.000Z");
  assert.equal(raced.notified_at, null);

  const completeId = await service.record({ channelId, sourceDiscordId: "1", toolCallId: "scheduler-complete", kind: "promise", title: "Complete", dueAt: null });
  const dismissId = await service.record({ channelId, sourceDiscordId: "2", toolCallId: "scheduler-dismiss", kind: "unresolved_question", title: "Dismiss", dueAt: null });
  const snoozeId = await service.record({ channelId, sourceDiscordId: "3", toolCallId: "scheduler-snooze", kind: "stalled_topic", title: "Snooze", dueAt: "2026-09-08T09:00:00Z" });
  assert.equal(await service.update(completeId, "complete"), true);
  assert.equal(await service.update(dismissId, "dismiss"), true);
  assert.equal(await service.update(snoozeId, "snooze"), true);
  const rows = await pool.query("SELECT id::text, status, due_at, notified_at FROM followups WHERE id = ANY($1::bigint[]) ORDER BY id", [[completeId, dismissId, snoozeId]]);
  assert.deepEqual(rows.rows.map((row) => row.status), ["completed", "dismissed", "open"]);
  assert.equal(rows.rows[2].due_at.toISOString(), "2026-09-09T10:00:00.000Z");
  assert.equal(rows.rows[2].notified_at, null);
});

test("deleting a summary source deletes the derived summary", async (context) => {
  const pool = createPool();
  const channelId = "999999999999999971";
  await runMigrations(pool);
  await getOrCreateChannel(pool, channelId, "summary-source-test");
  context.after(async () => {
    await pool.query("DELETE FROM messages WHERE channel_id = $1", [channelId]);
    await pool.query("DELETE FROM channels WHERE discord_channel_id = $1", [channelId]);
    await pool.end();
  });
  const rows = await pool.query<{ id: string }>(`
    INSERT INTO messages (channel_id, role, content) VALUES ($1, 'user', 'first'), ($1, 'gaia', 'second') RETURNING id
  `, [channelId]);
  const memory = await pool.query<{ id: string }>(`
    INSERT INTO memories (kind, content, source_channel_id, source_message_start_id, source_message_end_id)
    VALUES ('summary', 'summary', $1, $2, $3) RETURNING id
  `, [channelId, rows.rows[0]!.id, rows.rows[1]!.id]);
  await pool.query("DELETE FROM messages WHERE id = $1", [rows.rows[0]!.id]);
  assert.equal((await pool.query("SELECT 1 FROM memories WHERE id = $1", [memory.rows[0]!.id])).rowCount, 0);
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
