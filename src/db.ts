import { readdir, readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Pool, type PoolClient } from "pg";

const DEFAULT_DATABASE_URL = "postgresql://gaia:gaia-local@127.0.0.1:5432/gaia";
const MIGRATIONS_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "migrations");

export function createPool(connectionString = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL): Pool {
  return new Pool({ connectionString, max: 5, application_name: "gaia-daemon" });
}

export type ChannelState = { threadId: string | null; workspacePath: string | null };

export async function getOrCreateChannel(pool: Pool, channelId: string, name: string): Promise<ChannelState> {
  const result = await pool.query<{ codex_thread_id: string | null; workspace_path: string | null }>(`
    INSERT INTO channels (discord_channel_id, name)
    VALUES ($1, $2)
    ON CONFLICT (discord_channel_id) DO UPDATE SET name = EXCLUDED.name, updated_at = now()
    RETURNING codex_thread_id, workspace_path
  `, [channelId, name]);
  return {
    threadId: result.rows[0]?.codex_thread_id ?? null,
    workspacePath: result.rows[0]?.workspace_path ?? null,
  };
}

export async function setChannelThread(pool: Pool, channelId: string, threadId: string | null): Promise<void> {
  await pool.query("UPDATE channels SET codex_thread_id = $2, updated_at = now() WHERE discord_channel_id = $1", [channelId, threadId]);
}

export async function setChannelWorkspace(pool: Pool, channelId: string, workspacePath: string | null): Promise<void> {
  await pool.query("UPDATE channels SET workspace_path = $2, codex_thread_id = NULL, updated_at = now() WHERE discord_channel_id = $1", [channelId, workspacePath]);
}

export async function createApproval(
  pool: Pool,
  approval: { requestId: string; channelId: string; kind: string; agent: string; risk: string },
): Promise<void> {
  await pool.query(`
    INSERT INTO approvals (request_id, channel_id, status, request)
    VALUES ($1, $2, 'pending', $3)
  `, [approval.requestId, approval.channelId, {
    kind: approval.kind,
    agent: approval.agent,
    risk: approval.risk,
  }]);
}

export async function decideApproval(
  pool: Pool,
  requestId: string,
  status: "approved" | "denied" | "expired",
): Promise<boolean> {
  const result = await pool.query(`
    UPDATE approvals
    SET status = $2, decision = $3, decided_at = now()
    WHERE request_id = $1 AND status = 'pending'
  `, [requestId, status, { status }]);
  return result.rowCount === 1;
}

export async function expirePendingApprovals(pool: Pool, requestId?: string): Promise<number> {
  const result = requestId
    ? await pool.query(`UPDATE approvals SET status = 'expired', decision = '{"status":"expired"}'::jsonb, decided_at = now() WHERE status = 'pending' AND request_id = $1`, [requestId])
    : await pool.query(`UPDATE approvals SET status = 'expired', decision = '{"status":"expired"}'::jsonb, decided_at = now() WHERE status = 'pending'`);
  return result.rowCount ?? 0;
}

export async function migrationStatus(pool: Pool): Promise<string> {
  const expected = (await readdir(MIGRATIONS_DIRECTORY)).filter((filename) => /^\d+_[a-z0-9_-]+\.sql$/.test(filename)).sort();
  const applied = await pool.query<{ version: string }>("SELECT version FROM schema_migrations ORDER BY version");
  return applied.rows.map(({ version }) => version).join("\n") === expected.join("\n")
    ? `OK - ${expected.length} migrations applied`
    : "ERROR - run `npm run migrate`";
}

export async function logAction(
  pool: Pool,
  entry: { channelId: string; agent: string; action: string; details?: Record<string, unknown> },
): Promise<void> {
  await pool.query(`
    INSERT INTO action_log (channel_id, agent, action, details)
    VALUES ($1, $2, $3, $4)
  `, [entry.channelId, entry.agent, entry.action, entry.details ?? {}]);
}

export async function saveMessage(
  pool: Pool,
  message: { discordId?: string; channelId: string; role: "user" | "gaia" | "system"; content: string; turnId?: string },
): Promise<boolean> {
  const result = await pool.query(`
    INSERT INTO messages (discord_message_id, channel_id, role, content, codex_turn_id)
    VALUES ($1, $2, $3, $4, $5)
    ON CONFLICT (discord_message_id) DO NOTHING
  `, [message.discordId ?? null, message.channelId, message.role, message.content, message.turnId ?? null]);
  return result.rowCount === 1;
}

export async function messageExists(pool: Pool, discordMessageId: string): Promise<boolean> {
  return (await pool.query("SELECT 1 FROM messages WHERE discord_message_id = $1", [discordMessageId])).rowCount === 1;
}

export async function setMessageTurn(pool: Pool, discordMessageId: string, turnId: string): Promise<void> {
  await pool.query("UPDATE messages SET codex_turn_id = $2 WHERE discord_message_id = $1", [discordMessageId, turnId]);
}

async function applyMigration(client: PoolClient, filename: string, sql: string): Promise<boolean> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('gaia_migrations'))");
    const existing = await client.query("SELECT 1 FROM schema_migrations WHERE version = $1", [filename]);
    if (existing.rowCount) {
      await client.query("COMMIT");
      return false;
    }
    await client.query(sql);
    await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [filename]);
    await client.query("COMMIT");
    return true;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

export async function runMigrations(pool: Pool): Promise<string[]> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  const filenames = (await readdir(MIGRATIONS_DIRECTORY))
    .filter((filename) => /^\d+_[a-z0-9_-]+\.sql$/.test(filename))
    .sort();
  const applied: string[] = [];
  for (const filename of filenames) {
    const client = await pool.connect();
    try {
      if (await applyMigration(client, filename, await readFile(join(MIGRATIONS_DIRECTORY, filename), "utf8"))) {
        applied.push(filename);
      }
    } finally {
      client.release();
    }
  }
  return applied;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== "migrate") throw new Error("Usage: node src/db.ts migrate");
  const pool = createPool();
  try {
    const applied = await runMigrations(pool);
    console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date");
  } finally {
    await pool.end();
  }
}
