import { execFile as execFileCallback } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  ComponentType,
  Events,
  GatewayIntentBits,
  MessageFlags,
  RESTEvents,
  SlashCommandBuilder,
  type Attachment,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Message,
} from "discord.js";
import type { Pool } from "pg";

import { CodexClient, type CodexActivity, type CodexAgentActivity, type CodexApproval, type CodexAttachment } from "./codex.ts";
import {
  createApproval,
  decideApproval,
  getOrCreateChannel,
  logAction,
  messageExists,
  saveMessage,
  setChannelThread,
  setChannelWorkspace,
  setMessageTurn,
} from "./db.ts";
import { formatMemoryContext, MemoryService, type MemoryResult } from "./memory.ts";
import type { IntegrationService } from "./integrations.ts";
import { ProactivityService, type ProactiveDelivery, type ProactivityConfig } from "./scheduler.ts";

const execFile = promisify(execFileCallback);
const KEYCHAIN_ACCOUNT = "gaia";
const KEYCHAIN_SERVICE = "gaia.discord.bot-token";
const SNOWFLAKE = /^\d{17,20}$/;
const DISCORD_MESSAGE_LIMIT = 2_000;
const STREAM_EDIT_INTERVAL_MS = 1_500;
const GLOBAL_TURN_LIMIT = 2;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
const MAX_TEXT_ATTACHMENT_BYTES = 256 * 1024;
const ALLOWED_ATTACHMENT_TYPES = new Set([
  "application/json",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "text/csv",
  "text/markdown",
  "text/plain",
]);
const IMAGE_ATTACHMENT_TYPES = new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]);
const ATTACHMENT_EXTENSIONS: Record<string, string> = {
  "application/json": ".json",
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "text/csv": ".csv",
  "text/markdown": ".md",
  "text/plain": ".txt",
};
const DISCORD_CDN_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const NO_MENTIONS = { parse: [] as const };
const APPROVAL_TIMEOUT_MS = 10 * 60_000;

export type AccessConfig = {
  ownerId: string;
  guildId: string;
  channelIds: ReadonlySet<string>;
};

export type DiscordSource = {
  guildId: string | null;
  channelId: string;
  userId: string;
  isBot: boolean;
  webhookId?: string | null;
};

type AttachmentMetadata = Pick<Attachment, "contentType" | "id" | "name" | "size" | "url">;

class AttachmentError extends Error {}
class WorkspaceError extends Error {}

export function validateDiscordAttachment(attachment: AttachmentMetadata): { contentType: string; isImage: boolean } {
  const contentType = attachment.contentType?.split(";", 1)[0]?.toLowerCase() ?? "";
  if (attachment.size > MAX_ATTACHMENT_BYTES) throw new AttachmentError(`Attachment ${JSON.stringify(attachment.name)} exceeds Discord's free 10 MiB limit.`);
  if (!ALLOWED_ATTACHMENT_TYPES.has(contentType)) {
    throw new AttachmentError(`Attachment ${JSON.stringify(attachment.name)} has unsupported type ${JSON.stringify(contentType || "unknown")}.`);
  }
  let url: URL;
  try {
    url = new URL(attachment.url);
  } catch {
    throw new AttachmentError(`Attachment ${JSON.stringify(attachment.name)} has an invalid Discord URL.`);
  }
  if (url.protocol !== "https:" || !DISCORD_CDN_HOSTS.has(url.hostname) || url.username || url.password) {
    throw new AttachmentError(`Attachment ${JSON.stringify(attachment.name)} is not hosted on Discord's CDN.`);
  }
  return { contentType, isImage: IMAGE_ATTACHMENT_TYPES.has(contentType) };
}

export function validateAttachmentBytes(contentType: string, bytes: Uint8Array): string | undefined {
  const buffer = Buffer.from(bytes);
  // ponytail: signatures reject disguised images; add full decoders only if malformed-image handling proves necessary.
  const matches =
    contentType === "image/png" ? buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      : contentType === "image/jpeg" ? buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff
        : contentType === "image/gif" ? ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii"))
          : contentType === "image/webp" ? buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP"
            : true;
  if (!matches) throw new AttachmentError(`Attachment contents do not match declared type ${JSON.stringify(contentType)}.`);
  if (!IMAGE_ATTACHMENT_TYPES.has(contentType)) {
    if (bytes.byteLength > MAX_TEXT_ATTACHMENT_BYTES) throw new AttachmentError("Text attachments cannot exceed 256 KiB.");
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      throw new AttachmentError(`Attachment contents are not valid UTF-8 ${JSON.stringify(contentType)} data.`);
    }
    if (text.includes("\0")) throw new AttachmentError("Text attachments cannot contain null bytes.");
    if (contentType === "application/json") {
      try {
        JSON.parse(text);
      } catch {
        throw new AttachmentError("JSON attachment is not valid JSON.");
      }
    }
    return text;
  }
}

async function downloadDiscordAttachments(attachments: Iterable<Attachment>): Promise<{
  files: CodexAttachment[];
  cleanup: () => Promise<void>;
}> {
  const validated = [...attachments].map((attachment) => ({ attachment, ...validateDiscordAttachment(attachment) }));
  if (!validated.length) return { files: [], cleanup: async () => undefined };
  const directory = await mkdtemp(join(tmpdir(), "gaia-discord-"));
  try {
    const files: CodexAttachment[] = [];
    for (const { attachment, contentType, isImage } of validated) {
      const response = await fetch(attachment.url, { redirect: "error", signal: AbortSignal.timeout(30_000) });
      if (!response.ok || !response.body) throw new AttachmentError(`Could not download attachment ${JSON.stringify(attachment.name)} from Discord.`);
      const responseType = response.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase();
      if (responseType && responseType !== contentType) throw new AttachmentError(`Attachment ${JSON.stringify(attachment.name)} changed type while downloading.`);
      const declaredLength = Number(response.headers.get("content-length"));
      if (Number.isFinite(declaredLength) && declaredLength > MAX_ATTACHMENT_BYTES) {
        throw new AttachmentError(`Attachment ${JSON.stringify(attachment.name)} exceeds Discord's free 10 MiB limit.`);
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        length += chunk.value.byteLength;
        if (length > MAX_ATTACHMENT_BYTES) {
          await reader.cancel();
          throw new AttachmentError(`Attachment ${JSON.stringify(attachment.name)} exceeds Discord's free 10 MiB limit.`);
        }
        chunks.push(chunk.value);
      }
      const bytes = Buffer.concat(chunks, length);
      const content = validateAttachmentBytes(contentType, bytes);
      const path = join(directory, `${attachment.id}${ATTACHMENT_EXTENSIONS[contentType]}`);
      await writeFile(path, bytes, { mode: 0o600 });
      files.push({ name: attachment.name, path, isImage, content });
    }
    return { files, cleanup: () => rm(directory, { recursive: true, force: true }) };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    if (error instanceof AttachmentError) throw error;
    throw new AttachmentError("Discord attachment download failed. Try uploading it again.");
  }
}

function requiredSnowflake(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  if (!SNOWFLAKE.test(value)) throw new Error(`${name} must be a Discord snowflake`);
  return value;
}

export function parseAccessConfig(env: NodeJS.ProcessEnv = process.env): AccessConfig {
  const channelIds = new Set((env.GAIA_CHANNEL_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean));
  if (!channelIds.size) throw new Error("GAIA_CHANNEL_IDS must contain at least one Discord channel ID");
  for (const id of channelIds) {
    if (!SNOWFLAKE.test(id)) throw new Error("GAIA_CHANNEL_IDS must contain only Discord snowflakes");
  }
  return {
    ownerId: requiredSnowflake(env, "GAIA_OWNER_ID"),
    guildId: requiredSnowflake(env, "GAIA_GUILD_ID"),
    channelIds,
  };
}

export function isAllowedSource(source: DiscordSource, config: AccessConfig): boolean {
  return !source.isBot && !source.webhookId && source.userId === config.ownerId &&
    source.guildId === config.guildId && config.channelIds.has(source.channelId);
}

export async function canonicalizeWorkspace(input: string): Promise<string> {
  const trimmed = input.trim();
  if (!trimmed) throw new WorkspaceError("Workspace path is required.");
  const expanded = trimmed === "~" ? homedir() : trimmed.startsWith("~/") ? join(homedir(), trimmed.slice(2)) : trimmed;
  const canonical = await realpath(resolve(expanded)).catch(() => {
    throw new WorkspaceError("Workspace must be an existing directory.");
  });
  if (!(await stat(canonical)).isDirectory()) throw new WorkspaceError("Workspace must be an existing directory.");
  if (dirname(canonical) === canonical) throw new WorkspaceError("The filesystem root cannot be enrolled as a workspace.");
  return canonical;
}

type Fence = { opener: string; closer: string };

function fenceState(text: string, initial: Fence | null): Fence | null {
  let open = initial;
  for (const match of text.matchAll(/^(`{3,}|~{3,})([^\n]*)$/gm)) {
    const delimiter = match[1]!;
    if (delimiter.length > 512) continue;
    if (open) {
      if (delimiter[0] === open.closer[0] && delimiter.length >= open.closer.length && !match[2]!.trim()) open = null;
    } else {
      open = { opener: match[0].slice(0, 512), closer: delimiter };
    }
  }
  return open;
}

export function splitDiscordMessage(input: string, limit = DISCORD_MESSAGE_LIMIT): string[] {
  const text = input.trimEnd() || "(No response.)";
  if (limit < 1_024) throw new Error("Discord message limit is too small");
  const chunks: string[] = [];
  let remaining = text;
  let openFence: Fence | null = null;

  while (remaining) {
    const prefix = openFence ? `${openFence.opener}\n` : "";
    const capacity = limit - prefix.length - (openFence?.closer.length ?? 512) - 1;
    let length = Math.min(capacity, remaining.length);
    if (length < remaining.length) {
      const candidate = remaining.slice(0, length);
      const newline = candidate.lastIndexOf("\n");
      const space = candidate.lastIndexOf(" ");
      const boundary = Math.max(newline, space);
      if (boundary >= Math.floor(capacity / 2)) length = boundary + 1;
    }
    if (length < remaining.length && /[\uD800-\uDBFF]/.test(remaining[length - 1]!) && /[\uDC00-\uDFFF]/.test(remaining[length]!)) length--;
    const part = remaining.slice(0, length);
    remaining = remaining.slice(length);
    const nextFence = fenceState(part, openFence);
    chunks.push(`${prefix}${part}${nextFence ? `\n${nextFence.closer}` : ""}`.trimEnd());
    openFence = nextFence;
  }
  return chunks;
}

export class ChannelTaskQueue {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly waiters: Array<() => void> = [];
  private readonly limit: number;
  private active = 0;

  constructor(limit = GLOBAL_TURN_LIMIT) {
    if (limit < 1) throw new Error("Global turn limit must be positive");
    this.limit = limit;
  }

  run<T>(channelId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(channelId) ?? Promise.resolve();
    const execution = previous.then(() => this.withSlot(task));
    const tail = execution.then(() => undefined, () => undefined);
    this.tails.set(channelId, tail);
    void tail.then(() => {
      if (this.tails.get(channelId) === tail) this.tails.delete(channelId);
    });
    return execution;
  }

  async onIdle(): Promise<void> {
    await Promise.all(this.tails.values());
  }

  private async withSlot<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.active--;
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

export async function loadDiscordToken(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const localToken = env.GAIA_DISCORD_TOKEN?.trim();
  if (localToken) return localToken;
  if (process.platform !== "darwin") throw new Error("GAIA_DISCORD_TOKEN is required outside macOS");
  try {
    const { stdout } = await execFile("/usr/bin/security", [
      "find-generic-password",
      "-a", KEYCHAIN_ACCOUNT,
      "-s", KEYCHAIN_SERVICE,
      "-w",
    ], { encoding: "utf8", timeout: 5_000 });
    const token = stdout.trim();
    if (token) return token;
  } catch {
    // The actionable error below deliberately omits Keychain and process output.
  }
  throw new Error(`Discord bot token not found in ${KEYCHAIN_SERVICE}; see README.md`);
}

async function codexHealth(codex: CodexClient): Promise<string> {
  try {
    const version = await execFile("codex", ["--version"], { encoding: "utf8", timeout: 5_000 });
    const auth = await execFile("codex", ["login", "status"], { encoding: "utf8", timeout: 5_000 });
    if (!`${auth.stdout}${auth.stderr}`.includes("Logged in using ChatGPT")) {
      return "ERROR - run `codex login` with ChatGPT";
    }
    return codex.isReady() ? `OK - ${version.stdout.trim()}; app-server ready` : "ERROR - app-server stopped; next turn will restart it";
  } catch {
    return "ERROR - install Codex or run `codex login`";
  }
}

async function statusText(client: Client, pool: Pool, codex: CodexClient, integrations: IntegrationService, proactivity: ProactivityService): Promise<string> {
  const database = await pool.query("SELECT 1").then(() => "OK").catch(() => "ERROR - run `docker compose up -d --wait` and `npm run migrate`");
  const discord = client.isReady() ? "OK - gateway ready" : "ERROR - gateway disconnected";
  const codexStatus = await codexHealth(codex);
  return ["GAIA: OK", `Database: ${database}`, `Discord: ${discord}`, `Codex: ${codexStatus}`, `Browser: ${codex.isReady() ? "OK - local Playwright MCP configured" : "ERROR - Codex app-server stopped"}`, `Google: ${integrations.status()}`, `Scheduler: ${proactivity.status()}`].join("\n");
}

async function retryDiscord<T>(operation: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (const delay of [0, 500, 1_500]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    try {
      return await operation();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function replyWithRetry(message: Message, content: string, nonce: string): Promise<Message> {
  return retryDiscord(() => message.reply({ content, allowedMentions: NO_MENTIONS, nonce, enforceNonce: true }));
}

export function specialistStatus(agents: readonly CodexAgentActivity[]): string {
  const lines = agents.slice(-6).map(({ agent, status, summary }) => {
    const excerpt = summary.replaceAll(/[`*_~<>@]/g, "").replaceAll(/\s+/g, " ").trim();
    return `**${agent}: ${status}**${excerpt ? `\n${excerpt.slice(0, 230)}${excerpt.length > 230 ? "..." : ""}` : ""}`;
  });
  return `**Specialists**${agents.length > 6 ? ` (latest 6 of ${agents.length})` : ""}\n${lines.join("\n\n")}`;
}

class DiscordChat {
  private readonly queue = new ChannelTaskQueue();
  private readonly activeThreads = new Map<string, string>();
  private readonly pool: Pool;
  private readonly codex: CodexClient;
  private readonly config: AccessConfig;
  private readonly memory: MemoryService;
  private readonly proactivity: ProactivityService;
  private closing = false;

  constructor(pool: Pool, codex: CodexClient, config: AccessConfig, memory: MemoryService, proactivity: ProactivityService) {
    this.pool = pool;
    this.codex = codex;
    this.config = config;
    this.memory = memory;
    this.proactivity = proactivity;
  }

  enqueue(message: Message): Promise<void> {
    if (this.closing) return Promise.resolve();
    const content = message.content.trim();
    if (!content && !message.attachments.size) return Promise.resolve();
    return this.queue.run(message.channelId, () => this.respond(message, content));
  }

  newConversation(channelId: string, channelName: string): Promise<void> {
    return this.queue.run(channelId, async () => {
      await getOrCreateChannel(this.pool, channelId, channelName);
      await setChannelThread(this.pool, channelId, null);
    });
  }

  enrollWorkspace(channelId: string, channelName: string, input: string): Promise<string> {
    return this.queue.run(channelId, async () => {
      const workspacePath = await canonicalizeWorkspace(input);
      await getOrCreateChannel(this.pool, channelId, channelName);
      await setChannelWorkspace(this.pool, channelId, workspacePath);
      await logAction(this.pool, { channelId, agent: "GAIA", action: "workspace_enrolled" });
      return workspacePath;
    });
  }

  removeWorkspace(channelId: string, channelName: string): Promise<void> {
    return this.queue.run(channelId, async () => {
      await getOrCreateChannel(this.pool, channelId, channelName);
      await setChannelWorkspace(this.pool, channelId, null);
      await logAction(this.pool, { channelId, agent: "GAIA", action: "workspace_removed" });
    });
  }

  async stop(channelId: string): Promise<boolean> {
    const threadId = this.activeThreads.get(channelId);
    return threadId ? this.codex.interrupt(threadId) : false;
  }

  async close(): Promise<void> {
    this.closing = true;
    const idle = this.queue.onIdle().then(() => true);
    while (!await Promise.race([idle, new Promise<false>((resolve) => setTimeout(() => resolve(false), 100))])) {
      await Promise.all([...this.activeThreads.values()].map((threadId) => this.codex.interrupt(threadId).catch(() => false)));
    }
  }

  private async respond(message: Message, content: string): Promise<void> {
    if (this.closing) return;
    if (!message.inGuild()) throw new Error("Authorized Discord messages must belong to a guild");
    const channelId = message.channelId;
    const channelName = message.channel.name;
    const storedContent = [content, ...message.attachments.map((attachment) => `[Attachment: ${attachment.name}]`)].filter(Boolean).join("\n");
    const channel = await getOrCreateChannel(this.pool, channelId, channelName);
    if (await messageExists(this.pool, message.id)) return;

    let downloaded: Awaited<ReturnType<typeof downloadDiscordAttachments>>;
    try {
      downloaded = await downloadDiscordAttachments(message.attachments.values());
    } catch (error) {
      const response = error instanceof AttachmentError ? error.message : "Discord attachment download failed. Try uploading it again.";
      const sent = await replyWithRetry(message, response, message.id);
      await saveMessage(this.pool, { discordId: message.id, channelId, role: "user", content: storedContent });
      await saveMessage(this.pool, { discordId: sent.id, channelId, role: "gaia", content: response });
      this.memory.enqueueMessage(message.id, channelId);
      this.memory.enqueueMessage(sent.id, channelId);
      return;
    }

    try {
      await retryDiscord(() => message.channel.sendTyping());
      const placeholder = await replyWithRetry(message, "Thinking...", message.id);
      // ponytail: nonce retries cover REST failures; add a durable outbox with Phase 9 crash recovery if needed.
      if (!await saveMessage(this.pool, { discordId: message.id, channelId, role: "user", content: storedContent })) return;
      this.memory.enqueueMessage(message.id, channelId);
      const typing = setInterval(() => {
        void retryDiscord(() => message.channel.sendTyping()).catch(() => undefined);
      }, 8_000);
      let editTimer: NodeJS.Timeout | null = null;
      let edits = Promise.resolve();
      let streamedText = "";
      let startedTurnId: string | undefined;
      let turnIdSave = Promise.resolve();
      let activitySends = Promise.resolve();
      const agents = new Map<string, CodexAgentActivity>();
      let agentMessage: Message | undefined;
      let agentTimer: NodeJS.Timeout | undefined;
      const flushAgents = (): void => {
        if (agentTimer) clearTimeout(agentTimer);
        agentTimer = undefined;
        if (!agents.size) return;
        const content = specialistStatus([...agents.values()]);
        activitySends = activitySends.then(async () => {
          if (agentMessage) await retryDiscord(() => agentMessage!.edit({ content, allowedMentions: NO_MENTIONS }));
          else agentMessage = await replyWithRetry(message, content, `${message.id}-a`);
        }).catch(() => console.error("Failed to display specialist status"));
      };

      const queueEdit = (): void => {
        editTimer = null;
        const preview = splitDiscordMessage(streamedText)[0] ?? "Thinking...";
        edits = edits.then(() => retryDiscord(() => placeholder.edit({ content: preview, allowedMentions: NO_MENTIONS })).then(() => undefined)).catch(() => undefined);
      };
      const scheduleEdit = (text: string): void => {
        streamedText = text;
        if (!editTimer) editTimer = setTimeout(queueEdit, STREAM_EDIT_INTERVAL_MS);
      };

      let response: string;
      let responseTurnId: string | undefined;
      try {
        const codexThreadId = await this.codex.openThread(channel.threadId, channel.workspacePath);
        if (!channel.threadId) await setChannelThread(this.pool, channelId, codexThreadId);
        this.activeThreads.set(channelId, codexThreadId);
        const memory = content ? formatMemoryContext(await this.memory.retrieve(content, message.id)) : "";
        const input = `${memory ? `${memory}\n\n` : ""}Current time and owner timezone: ${this.proactivity.currentTimeContext()}\nCurrent owner request:\n${content}`;
        const result = await this.codex.runTurn(codexThreadId, input, {
          onText: scheduleEdit,
          onStarted: (turnId) => {
            startedTurnId = turnId;
            turnIdSave = setMessageTurn(this.pool, message.id, turnId);
            void turnIdSave.catch(() => undefined);
            if (this.closing) void this.codex.interrupt(codexThreadId).catch(() => undefined);
          },
          onApproval: (approval) => this.requestApproval(message, approval),
          onFollowup: (followup) => this.proactivity.record({
            channelId,
            sourceDiscordId: message.id,
            toolCallId: followup.callId,
            kind: followup.kind,
            title: followup.title,
            dueAt: followup.dueAt,
          }),
          onActivity: (activity) => {
            activitySends = activitySends.then(() => this.showActivity(message, activity)).catch(() => undefined);
          },
          onAgent: (activity) => {
            agents.set(activity.threadId, activity);
            if (!agentTimer) agentTimer = setTimeout(flushAgents, STREAM_EDIT_INTERVAL_MS);
          },
        }, downloaded.files);
        await turnIdSave;
        await activitySends;
        response = result.status === "interrupted"
          ? `${result.text}${result.text ? "\n\n" : ""}_Turn stopped._`
          : result.text;
        responseTurnId = result.turnId;
      } catch {
        response = "GAIA could not complete that turn. Try again; if it persists, run `/gaia status`.";
        responseTurnId = startedTurnId;
        console.error("Failed to complete a Discord turn");
      }
      try {
        flushAgents();
        await activitySends;
        if (agentMessage) await saveMessage(this.pool, { discordId: agentMessage.id, channelId, role: "system", content: specialistStatus([...agents.values()]), turnId: responseTurnId }).catch(() => console.error("Failed to persist specialist status"));
        await this.finishResponse(placeholder, channelId, response, responseTurnId, edits, editTimer);
      } finally {
        if (agentTimer) clearTimeout(agentTimer);
        clearInterval(typing);
        if (editTimer) clearTimeout(editTimer);
        this.activeThreads.delete(channelId);
      }
    } finally {
      await downloaded.cleanup();
    }
  }

  private async requestApproval(message: Message, approval: CodexApproval): Promise<"approve" | "deny"> {
    const requestId = randomUUID();
    const approveId = `gaia-approval:${requestId}:approve`;
    const denyId = `gaia-approval:${requestId}:deny`;
    const details = [
      "**Approval required**",
      `**Agent:** ${approval.agent}`,
      `**Action:** ${approval.action}`,
      `**Target:** ${this.limit(approval.target, 600)}`,
      `**Reason:** ${this.limit(approval.reason, 350)}`,
      `**Risk:** ${approval.risk}`,
    ].join("\n");
    const components = [new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId(approveId).setLabel("Approve once").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId(denyId).setLabel("Deny").setStyle(ButtonStyle.Danger),
    )];

    await createApproval(this.pool, {
      requestId,
      channelId: message.channelId,
      kind: approval.kind,
      agent: approval.agent,
      risk: approval.risk,
    });
    let prompt: Message | null = null;
    try {
      const nonce = requestId.replaceAll("-", "").slice(0, 25);
      const sent = await retryDiscord(() => message.reply({ content: details, components, allowedMentions: NO_MENTIONS, nonce, enforceNonce: true }));
      prompt = sent;
      const interaction = await sent.awaitMessageComponent({
        componentType: ComponentType.Button,
        time: APPROVAL_TIMEOUT_MS,
        filter: (candidate) => {
          if (candidate.customId !== approveId && candidate.customId !== denyId) return false;
          if (isAllowedSource({
            guildId: candidate.guildId,
            channelId: candidate.channelId,
            userId: candidate.user.id,
            isBot: candidate.user.bot,
          }, this.config)) return true;
          void candidate.reply({ content: "Only the configured GAIA owner can decide approvals.", flags: MessageFlags.Ephemeral }).catch(() => undefined);
          return false;
        },
      });
      const approved = interaction.customId === approveId;
      const status = approved ? "approved" : "denied";
      if (!await decideApproval(this.pool, requestId, status)) {
        await interaction.update({ content: `${details}\n\nThis request was already resolved.`, components: [] });
        return "deny";
      }
      await interaction.update({ content: `${details}\n\n**Decision:** ${approved ? "Approved once" : "Denied"}`, components: [] }).catch(() => undefined);
      await logAction(this.pool, { channelId: message.channelId, agent: approval.agent, action: `approval_${status}`, details: { kind: approval.kind, risk: approval.risk } }).catch(() => undefined);
      return approved ? "approve" : "deny";
    } catch {
      await decideApproval(this.pool, requestId, "expired").catch(() => false);
      await prompt?.edit({ content: `${details}\n\n**Decision:** Expired and denied`, components: [] }).catch(() => undefined);
      await logAction(this.pool, { channelId: message.channelId, agent: approval.agent, action: "approval_expired", details: { kind: approval.kind, risk: approval.risk } }).catch(() => undefined);
      return "deny";
    }
  }

  private async showActivity(message: Message, activity: CodexActivity): Promise<void> {
    const label = activity.kind === "command" ? "Command" : "File changes";
    const nonce = randomUUID().replaceAll("-", "").slice(0, 25);
    // Specialist tool chatter stays in the audit trail; one edited status message carries their results.
    if (!activity.agent || activity.agent === "GAIA") await retryDiscord(() => message.reply({
      content: `**${label} ${activity.status}**\n${this.limit(activity.summary, 1_500)}`,
      allowedMentions: NO_MENTIONS,
      nonce,
      enforceNonce: true,
    }));
    await logAction(this.pool, {
      channelId: message.channelId,
      agent: activity.agent ?? "GAIA",
      action: `${activity.kind}_${activity.status}`,
      details: activity.count === undefined ? {} : { files: activity.count },
    });
  }

  private limit(value: string, maximum: number): string {
    const safe = value.replaceAll("`", "'").replaceAll("@", "(at)");
    return safe.length <= maximum ? safe : `${safe.slice(0, maximum - 3)}...`;
  }

  private async finishResponse(
    placeholder: Message,
    channelId: string,
    text: string,
    turnId: string | undefined,
    pendingEdits: Promise<void>,
    editTimer: NodeJS.Timeout | null,
  ): Promise<void> {
    if (editTimer) clearTimeout(editTimer);
    await pendingEdits;
    const chunks = splitDiscordMessage(text);
    const first = await retryDiscord(() => placeholder.edit({ content: chunks[0]!, allowedMentions: NO_MENTIONS }));
    await saveMessage(this.pool, { discordId: first.id, channelId, role: "gaia", content: chunks[0]!, turnId });
    this.memory.enqueueMessage(first.id, channelId);
    for (const [index, chunk] of chunks.slice(1).entries()) {
      const sent = await replyWithRetry(placeholder, chunk, `${placeholder.id}-${index}`);
      await saveMessage(this.pool, { discordId: sent.id, channelId, role: "gaia", content: chunk, turnId });
      this.memory.enqueueMessage(sent.id, channelId);
    }
  }
}

function interactionChannelName(interaction: ChatInputCommandInteraction): string {
  const channel = interaction.channel;
  return !channel || channel.isDMBased() ? interaction.channelId : channel.name;
}

async function handleInteraction(
  interaction: ChatInputCommandInteraction,
  client: Client,
  pool: Pool,
  codex: CodexClient,
  chat: DiscordChat,
  memory: MemoryService,
  integrations: IntegrationService,
  proactivity: ProactivityService,
  config: AccessConfig,
): Promise<void> {
  if (!isAllowedSource({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    isBot: interaction.user.bot,
  }, config)) return;
  if (interaction.commandName !== "gaia") return;
  const subcommand = interaction.options.getSubcommand(false);
  if (!subcommand) return;
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  if (subcommand === "status") {
    await interaction.editReply(await statusText(client, pool, codex, integrations, proactivity));
  } else if (subcommand === "new") {
    await chat.newConversation(interaction.channelId, interactionChannelName(interaction));
    await interaction.editReply("Started a new conversation for this channel.");
  } else if (subcommand === "stop") {
    await interaction.editReply(await chat.stop(interaction.channelId) ? "Stopping the active turn." : "No turn is active in this channel.");
  } else if (subcommand === "workspace") {
    try {
      const workspace = await chat.enrollWorkspace(interaction.channelId, interactionChannelName(interaction), interaction.options.getString("path", true));
      await interaction.editReply({ content: `Enrolled workspace and started fresh context for this channel: ${workspace.replaceAll("@", "(at)")}`, allowedMentions: NO_MENTIONS });
    } catch (error) {
      if (!(error instanceof WorkspaceError)) throw error;
      await interaction.editReply(error.message);
    }
  } else if (subcommand === "unworkspace") {
    await chat.removeWorkspace(interaction.channelId, interactionChannelName(interaction));
    await interaction.editReply("Removed this channel's workspace and started fresh conversation-only context.");
  } else if (subcommand === "remember") {
    await getOrCreateChannel(pool, interaction.channelId, interactionChannelName(interaction));
    const text = interaction.options.getString("text", true).trim();
    if (!text) {
      await interaction.editReply("Memory text cannot be blank.");
      return;
    }
    const id = await memory.remember(interaction.channelId, text, interaction.id);
    await interaction.editReply(`Remembered as memory ${id}.`);
  } else if (subcommand === "memories") {
    const results = await memory.inspect(interaction.options.getString("query")?.trim());
    await interaction.editReply(results.length ? results.map(formatMemoryResult).join("\n\n").slice(0, 2_000) : "No matching memories.");
  } else if (subcommand === "correct") {
    const id = requiredMemoryId(interaction.options.getString("id", true));
    if (!id) {
      await interaction.editReply("Memory ID must be numeric.");
      return;
    }
    const text = interaction.options.getString("text", true).trim();
    if (!text) {
      await interaction.editReply("Memory text cannot be blank.");
      return;
    }
    const changed = await memory.correct(id, text);
    await interaction.editReply(changed ? `Corrected memory ${id}.` : `Memory ${id} was not found.`);
  } else if (subcommand === "forget") {
    const id = requiredMemoryId(interaction.options.getString("id", true));
    if (!id) {
      await interaction.editReply("Memory ID must be numeric.");
      return;
    }
    await interaction.editReply(await memory.forget(id) ? `Forgot memory ${id}. Discord history is unchanged.` : `Memory ${id} was not found.`);
  } else if (subcommand === "followup") {
    const id = requiredMemoryId(interaction.options.getString("id", true));
    if (!id) {
      await interaction.editReply("Follow-up ID must be numeric.");
      return;
    }
    const action = interaction.options.getString("action", true) as "complete" | "dismiss" | "snooze";
    const changed = await proactivity.update(id, action);
    await interaction.editReply(changed ? followupActionText(id, action) : `Open follow-up ${id} was not found.`);
  }
}

function followupActionText(id: string, action: "complete" | "dismiss" | "snooze"): string {
  return action === "snooze" ? `Snoozed follow-up ${id} for 24 hours.` : `${action === "complete" ? "Completed" : "Dismissed"} follow-up ${id}.`;
}

async function handleFollowupButton(interaction: ButtonInteraction, proactivity: ProactivityService, config: AccessConfig): Promise<void> {
  if (!isAllowedSource({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    userId: interaction.user.id,
    isBot: interaction.user.bot,
  }, config)) return;
  const match = /^gaia-followup:(\d+):(complete|dismiss|snooze)$/.exec(interaction.customId);
  if (!match) return;
  await interaction.deferUpdate();
  const id = match[1]!;
  const action = match[2] as "complete" | "dismiss" | "snooze";
  const changed = await proactivity.update(id, action);
  await interaction.editReply({
    content: `${interaction.message.content}\n\n${changed ? followupActionText(id, action) : `Follow-up ${id} was already resolved.`}`.slice(0, 2_000),
    components: [],
    allowedMentions: NO_MENTIONS,
  });
}

function requiredMemoryId(value: string): string | null {
  if (!/^\d+$/.test(value)) return null;
  return BigInt(value) <= 9_223_372_036_854_775_807n ? value : null;
}

function formatMemoryResult(result: MemoryResult): string {
  const range = result.sourceDiscordId ? `, Discord interaction ${result.sourceDiscordId}` : result.sourceStartId ? `, messages ${result.sourceStartId}-${result.sourceEndId}` : "";
  const text = result.content.replaceAll("@", "(at)").slice(0, 500);
  return `**Memory ${result.id}** (${result.kind}, #${result.channelName} ${result.channelId}${range})\n${text}${result.content.length > 500 ? "..." : ""}`;
}

export type DiscordService = {
  client: Client;
  close: () => Promise<void>;
};

function followupButtons(id: string): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`gaia-followup:${id}:complete`).setLabel("Complete").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`gaia-followup:${id}:snooze`).setLabel("Snooze 24h").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId(`gaia-followup:${id}:dismiss`).setLabel("Dismiss").setStyle(ButtonStyle.Danger),
  );
}

async function sendProactive(client: Client, channelId: string, delivery: ProactiveDelivery): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isSendable()) throw new Error("Configured proactive Discord channel is unavailable or not sendable");
  if (delivery.type === "followup") {
    const title = delivery.followup.title.replaceAll("@", "(at)").slice(0, 500);
    await retryDiscord(async () => {
      await channel.send({
        content: `**Follow-up ${delivery.followup.id}**\n${title}`,
        components: [followupButtons(delivery.followup.id)],
        allowedMentions: NO_MENTIONS,
        nonce: delivery.key,
        enforceNonce: true,
      });
    });
    return;
  }
  const lines = delivery.followups.map((item) => `- **${item.id}** ${item.title.replaceAll("@", "(at)").slice(0, 240)}`);
  await retryDiscord(async () => {
    await channel.send({
      content: `**Daily follow-up digest**\n${lines.length ? lines.join("\n") : "No open follow-ups."}`.slice(0, 2_000),
      allowedMentions: NO_MENTIONS,
      nonce: delivery.key,
      enforceNonce: true,
    });
  });
}

export async function startDiscord(pool: Pool, codex: CodexClient, memory: MemoryService, integrations: IntegrationService, config: AccessConfig, token: string, proactivityConfig: ProactivityConfig): Promise<DiscordService> {
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });

  const proactivity = new ProactivityService(pool, proactivityConfig, (delivery) => sendProactive(client, proactivityConfig.channelId, delivery));
  const chat = new DiscordChat(pool, codex, config, memory, proactivity);
  const interactions = new Set<Promise<void>>();
  client.on(Events.MessageCreate, (message) => {
    if (!isAllowedSource({
      guildId: message.guildId,
      channelId: message.channelId,
      userId: message.author.id,
      isBot: message.author.bot,
      webhookId: message.webhookId,
    }, config)) return;
    void chat.enqueue(message).catch(() => console.error("Failed to queue Discord message"));
  });
  client.on(Events.InteractionCreate, (interaction) => {
    if (interaction.isChatInputCommand()) {
      const task = handleInteraction(interaction, client, pool, codex, chat, memory, integrations, proactivity, config).catch(async () => {
        console.error("Failed to handle Discord interaction");
        if (interaction.deferred || interaction.replied) await interaction.editReply("GAIA could not complete that command. Try again.").catch(() => undefined);
      });
      interactions.add(task);
      void task.finally(() => interactions.delete(task));
    } else if (interaction.isButton() && interaction.customId.startsWith("gaia-followup:")) {
      const task = handleFollowupButton(interaction, proactivity, config).catch(() => console.error("Failed to handle follow-up action"));
      interactions.add(task);
      void task.finally(() => interactions.delete(task));
    }
  });
  client.on(Events.Error, () => console.error("Discord client error"));
  client.on(Events.ShardDisconnect, (event, shardId) => console.warn(`Discord shard ${shardId} disconnected with code ${event.code}`));
  client.on(Events.ShardReconnecting, (shardId) => console.warn(`Discord shard ${shardId} reconnecting`));
  client.on(Events.ShardResume, (shardId, replayedEvents) => console.log(`Discord shard ${shardId} resumed; replayed ${replayedEvents} events`));
  client.rest.on(RESTEvents.RateLimited, (rateLimit) => console.warn(`Discord REST rate limited; retrying in ${Math.ceil(rateLimit.timeToReset)} ms`));

  try {
    await client.login(token);
    if (!client.application) throw new Error("Discord application is unavailable after login");
    await client.application.commands.set([
      new SlashCommandBuilder()
        .setName("gaia")
        .setDescription("GAIA controls")
        .addSubcommand((command) => command.setName("status").setDescription("Check local services"))
        .addSubcommand((command) => command.setName("new").setDescription("Start fresh context in this channel"))
        .addSubcommand((command) => command.setName("stop").setDescription("Stop the active turn in this channel"))
        .addSubcommand((command) => command.setName("workspace").setDescription("Enroll an existing local workspace for this channel")
          .addStringOption((option) => option.setName("path").setDescription("Absolute path or ~/path").setRequired(true)))
        .addSubcommand((command) => command.setName("unworkspace").setDescription("Remove this channel's enrolled workspace"))
        .addSubcommand((command) => command.setName("remember").setDescription("Store an explicit shared memory")
          .addStringOption((option) => option.setName("text").setDescription("Fact to remember").setRequired(true).setMinLength(1).setMaxLength(2_000)))
        .addSubcommand((command) => command.setName("memories").setDescription("Inspect shared memories and their sources")
          .addStringOption((option) => option.setName("query").setDescription("Optional semantic search").setMaxLength(500)))
        .addSubcommand((command) => command.setName("correct").setDescription("Correct an existing shared memory")
          .addStringOption((option) => option.setName("id").setDescription("Numeric memory ID").setRequired(true))
          .addStringOption((option) => option.setName("text").setDescription("Corrected fact").setRequired(true).setMinLength(1).setMaxLength(2_000)))
        .addSubcommand((command) => command.setName("forget").setDescription("Delete a shared memory locally")
          .addStringOption((option) => option.setName("id").setDescription("Numeric memory ID").setRequired(true)))
        .addSubcommand((command) => command.setName("followup").setDescription("Resolve or snooze an open follow-up")
          .addStringOption((option) => option.setName("id").setDescription("Numeric follow-up ID").setRequired(true))
          .addStringOption((option) => option.setName("action").setDescription("Action").setRequired(true)
            .addChoices(
              { name: "Complete", value: "complete" },
              { name: "Dismiss", value: "dismiss" },
              { name: "Snooze 24 hours", value: "snooze" },
            )))
        .toJSON(),
    ], config.guildId);
    proactivity.start();
    return {
      client,
      close: async () => {
        client.destroy();
        await chat.close();
        await proactivity.close();
        await Promise.all(interactions);
      },
    };
  } catch (error) {
    client.destroy();
    throw error;
  }
}
