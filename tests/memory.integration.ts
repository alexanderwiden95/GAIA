import assert from "node:assert/strict";

import { createPool, getOrCreateChannel, runMigrations } from "../src/db.ts";
import { EMBEDDING_DIMENSIONS, MemoryService } from "../src/memory.ts";

const pool = createPool();
const memory = new MemoryService(pool);
const sourceChannel = "999999999999999981";
const targetChannel = "999999999999999982";

try {
  await runMigrations(pool);
  await getOrCreateChannel(pool, sourceChannel, "memory-source");
  await getOrCreateChannel(pool, targetChannel, "memory-target");
  await pool.query("DELETE FROM memories WHERE source_channel_id IN ($1, $2)", [sourceChannel, targetChannel]);
  await pool.query("DELETE FROM messages WHERE channel_id IN ($1, $2)", [sourceChannel, targetChannel]);

  const oldMessageId = "999999999999999984";
  await pool.query("INSERT INTO messages (discord_message_id, channel_id, role, content) VALUES ($1, $2, 'user', $3)", [oldMessageId, targetChannel, "Jag föredrar möten på eftermiddagen."]);
  memory.start();
  await memory.close();
  assert.equal((await pool.query("SELECT 1 FROM messages WHERE discord_message_id = $1 AND vector_dims(embedding) = $2", [oldMessageId, EMBEDDING_DIMENSIONS])).rowCount, 1);

  const sourceDiscordId = "999999999999999983";
  const id = await memory.remember(sourceChannel, "Project Borealis launches from Kiruna in early winter.", sourceDiscordId);
  const exact = await memory.retrieve("Borealis Kiruna");
  assert(exact.some((item) => item.id === id && item.channelId === sourceChannel));
  assert.equal(exact.find((item) => item.id === id)?.sourceDiscordId, sourceDiscordId);
  assert((await memory.inspect("Borealis Kiruna")).some((item) => item.id === id));

  const semantic = await memory.retrieve("Where in northern Sweden will the project begin?");
  assert(semantic.some((item) => item.type === "memory" && item.id === id), "local vector search should recall a paraphrased concept");
  assert.equal((await pool.query<{ dimensions: number }>("SELECT vector_dims(embedding) AS dimensions FROM memories WHERE id = $1", [id])).rows[0]?.dimensions, EMBEDDING_DIMENSIONS);

  const rankingMessage = await pool.query<{ id: string }>("INSERT INTO messages (channel_id, role, content) VALUES ($1, 'user', 'rankzebra') RETURNING id::text", [sourceChannel]);
  await pool.query("INSERT INTO memories (kind, content, source_channel_id, source_message_start_id, source_message_end_id) VALUES ('summary', 'rankzebra', $1, $2, $2)", [sourceChannel, rankingMessage.rows[0]!.id]);
  await memory.remember(sourceChannel, "rankzebra");
  const ranked = (await memory.retrieve("rankzebra")).filter((item) => item.content === "rankzebra");
  assert.deepEqual(ranked.slice(0, 2).map((item) => item.kind), ["explicit", "summary"]);

  assert.equal(await memory.correct(id, "Project Borealis was renamed Aurora and launches from Tromso."), true);
  assert((await memory.retrieve("Aurora Tromso")).some((item) => item.id === id));
  assert.equal(await memory.forget(id), true);
  assert(!(await memory.retrieve("Aurora Tromso")).some((item) => item.type === "memory" && item.id === id));
  console.log("Shared-memory exact, semantic, source, correction, deletion, and local embedding checks passed");
} finally {
  await pool.query("DELETE FROM memories WHERE source_channel_id IN ($1, $2)", [sourceChannel, targetChannel]).catch(() => undefined);
  await pool.query("DELETE FROM messages WHERE channel_id IN ($1, $2)", [sourceChannel, targetChannel]).catch(() => undefined);
  await pool.query("DELETE FROM channels WHERE discord_channel_id IN ($1, $2)", [sourceChannel, targetChannel]).catch(() => undefined);
  await memory.close();
  await pool.end();
}
