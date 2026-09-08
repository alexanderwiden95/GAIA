import type { Pool } from "pg";
import { logError, redact } from "./logger.ts";

const POLL_INTERVAL_MS = 5 * 60_000;

export type FollowupKind = "explicit_date" | "promise" | "unresolved_question" | "stalled_topic";

export type Followup = {
  id: string;
  kind: FollowupKind;
  title: string;
  dueAt: Date | null;
};

export type ProactivityConfig = {
  channelId: string;
  timezone: string;
  digestTime: string;
  quietStart: string;
  quietEnd: string;
};

export type ProactiveDelivery =
  | { type: "followup"; key: string; followup: Followup }
  | { type: "digest"; key: string; date: string; followups: Followup[] };

type Clock = () => Date;
type Deliver = (delivery: ProactiveDelivery) => Promise<void>;

function requiredTime(value: string | undefined, name: string): string {
  const time = value?.trim() ?? "";
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error(`${name} must use 24-hour HH:MM format`);
  return time;
}

export function parseProactivityConfig(env: NodeJS.ProcessEnv = process.env): ProactivityConfig {
  const channelId = env.GAIA_PROACTIVE_CHANNEL_ID?.trim() ?? "";
  if (!/^\d{17,20}$/.test(channelId)) throw new Error("GAIA_PROACTIVE_CHANNEL_ID must be a Discord channel ID");
  const timezone = env.GAIA_TIMEZONE?.trim() ?? "";
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: timezone }).format();
  } catch {
    throw new Error("GAIA_TIMEZONE must be an IANA timezone such as Europe/Stockholm");
  }
  return {
    channelId,
    timezone,
    digestTime: requiredTime(env.GAIA_DAILY_DIGEST_TIME, "GAIA_DAILY_DIGEST_TIME"),
    quietStart: requiredTime(env.GAIA_QUIET_HOURS_START, "GAIA_QUIET_HOURS_START"),
    quietEnd: requiredTime(env.GAIA_QUIET_HOURS_END, "GAIA_QUIET_HOURS_END"),
  };
}

function localDateTime(now: Date, timezone: string): { date: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((entry) => entry.type === type)!.value;
  return { date: `${part("year")}-${part("month")}-${part("day")}`, time: `${part("hour")}:${part("minute")}` };
}

export function isQuietTime(time: string, start: string, end: string): boolean {
  if (start === end) return false;
  return start < end ? time >= start && time < end : time >= start || time < end;
}

export class ProactivityService {
  private readonly pool: Pool;
  private readonly config: ProactivityConfig;
  private readonly deliver: Deliver;
  private readonly clock: Clock;
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | null = null;
  private lastSuccessAt: Date | null = null;
  private lastError: string | null = null;

  constructor(pool: Pool, config: ProactivityConfig, deliver: Deliver, clock: Clock = () => new Date()) {
    this.pool = pool;
    this.config = config;
    this.deliver = deliver;
    this.clock = clock;
  }

  start(): void {
    void this.runOnce().catch((error) => logError("scheduler", error));
    this.timer = setInterval(() => void this.runOnce().catch((error) => logError("scheduler", error)), POLL_INTERVAL_MS);
  }

  async close(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }

  async record(input: {
    channelId: string;
    sourceDiscordId: string;
    toolCallId: string;
    kind: FollowupKind;
    title: string;
    dueAt: string | null;
  }): Promise<string> {
    const title = input.title.replaceAll(/\s+/g, " ").trim();
    if (!title || title.length > 240) throw new Error("Follow-up title must contain 1-240 characters");
    const dueAt = input.dueAt === null ? null : new Date(input.dueAt);
    if (dueAt && (!Number.isFinite(dueAt.getTime()) || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(input.dueAt!))) {
      throw new Error("dueAt must be null or an ISO 8601 timestamp with a timezone offset");
    }
    const result = await this.pool.query<{ id: string }>(`
      INSERT INTO followups (source_channel_id, source_discord_id, tool_call_id, kind, title, due_at)
      VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (tool_call_id) DO UPDATE SET tool_call_id = EXCLUDED.tool_call_id
      RETURNING id::text
    `, [input.channelId, input.sourceDiscordId, input.toolCallId, input.kind, title, dueAt]);
    return result.rows[0]!.id;
  }

  async update(id: string, action: "complete" | "dismiss" | "snooze"): Promise<boolean> {
    const result = action === "snooze"
      ? await this.pool.query(`
          UPDATE followups SET due_at = $2, notified_at = NULL, updated_at = now()
          WHERE id = $1 AND status = 'open'
        `, [id, new Date(this.clock().getTime() + 24 * 60 * 60_000)])
      : await this.pool.query(`
          UPDATE followups SET status = $2, updated_at = now()
          WHERE id = $1 AND status = 'open'
        `, [id, action === "complete" ? "completed" : "dismissed"]);
    return result.rowCount === 1;
  }

  async runOnce(): Promise<void> {
    if (this.running) return this.running;
    this.running = this.tick().then(() => {
      this.lastSuccessAt = this.clock();
      this.lastError = null;
    }, (error) => {
      this.lastError = redact(error instanceof Error ? error.message : "scheduler failure");
      throw error;
    }).finally(() => { this.running = null; });
    return this.running;
  }

  status(): string {
    if (!this.timer) return "ERROR - scheduler stopped";
    if (this.lastError) return `ERROR - ${this.lastError}`;
    return `OK - ${this.config.timezone}; digest ${this.config.digestTime}${this.lastSuccessAt ? `; checked ${this.lastSuccessAt.toISOString()}` : ""}`;
  }

  currentTimeContext(): string {
    return `${this.clock().toISOString()} (${this.config.timezone})`;
  }

  private async tick(): Promise<void> {
    const now = this.clock();
    const local = localDateTime(now, this.config.timezone);
    if (isQuietTime(local.time, this.config.quietStart, this.config.quietEnd)) return;

    const due = await this.pool.query<{ id: string; kind: FollowupKind; title: string; due_at: Date | null }>(`
      SELECT id::text, kind, title, due_at FROM followups
      WHERE status = 'open' AND notified_at IS NULL AND due_at <= $1
      ORDER BY due_at, id LIMIT 20
    `, [now]);
    for (const row of due.rows) {
      const followup = this.map(row);
      await this.deliver({ type: "followup", key: `gaia-f-${followup.id}`, followup });
      await this.pool.query(`
        UPDATE followups SET notified_at = $2, updated_at = now()
        WHERE id = $1 AND status = 'open' AND notified_at IS NULL AND due_at <= $2
      `, [followup.id, now]);
    }

    if (local.time < this.config.digestTime) return;
    if ((await this.pool.query("SELECT 1 FROM proactive_digests WHERE local_date = $1", [local.date])).rowCount) return;
    const open = await this.pool.query<{ id: string; kind: FollowupKind; title: string; due_at: Date | null }>(`
      SELECT id::text, kind, title, due_at FROM followups WHERE status = 'open' ORDER BY due_at NULLS LAST, id LIMIT 10
    `);
    if (!open.rows.length) return;
    await this.deliver({ type: "digest", key: `gaia-d-${local.date.replaceAll("-", "")}`, date: local.date, followups: open.rows.map((row) => this.map(row)) });
    await this.pool.query("INSERT INTO proactive_digests (local_date) VALUES ($1) ON CONFLICT DO NOTHING", [local.date]);
  }

  private map(row: { id: string; kind: FollowupKind; title: string; due_at: Date | null }): Followup {
    return { id: row.id, kind: row.kind, title: row.title, dueAt: row.due_at };
  }
}
