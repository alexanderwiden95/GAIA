import assert from "node:assert/strict";
import test from "node:test";

import {
  ChannelTaskQueue,
  isAllowedSource,
  parseAccessConfig,
  splitDiscordMessage,
  validateAttachmentBytes,
  validateDiscordAttachment,
  type DiscordSource,
} from "../src/discord.ts";

const access = parseAccessConfig({
  GAIA_OWNER_ID: "123456789012345678",
  GAIA_GUILD_ID: "223456789012345678",
  GAIA_CHANNEL_IDS: "323456789012345678, 423456789012345678",
});
const allowed: DiscordSource = {
  guildId: "223456789012345678",
  channelId: "323456789012345678",
  userId: "123456789012345678",
  isBot: false,
  webhookId: null,
};

test("only the configured owner, guild, and channels are accepted", () => {
  assert.equal(isAllowedSource(allowed, access), true);
  for (const source of [
    { ...allowed, userId: "999456789012345678" },
    { ...allowed, guildId: "999456789012345678" },
    { ...allowed, channelId: "999456789012345678" },
    { ...allowed, guildId: null },
    { ...allowed, isBot: true },
    { ...allowed, webhookId: "523456789012345678" },
  ]) assert.equal(isAllowedSource(source, access), false);
});

test("invalid authorization configuration fails closed", () => {
  assert.throws(() => parseAccessConfig({}), /GAIA_CHANNEL_IDS/);
  assert.throws(() => parseAccessConfig({
    GAIA_OWNER_ID: "not-an-id",
    GAIA_GUILD_ID: "223456789012345678",
    GAIA_CHANNEL_IDS: "323456789012345678",
  }), /GAIA_OWNER_ID/);
});

test("long Discord messages preserve fenced code blocks", () => {
  const chunks = splitDiscordMessage(`Before\n\n\`\`\`ts\nconst value = "${"x".repeat(4_000)}";\n\`\`\`\n\nAfter`);
  assert(chunks.length > 2);
  assert(chunks.every((chunk) => chunk.length <= 2_000));
  assert.equal(chunks[0]?.endsWith("\n```"), true);
  assert.equal(chunks[1]?.startsWith("```ts\n"), true);
  assert.equal(chunks.at(-1)?.endsWith("After"), true);
});

test("message splitting keeps Unicode and alternate fences intact", () => {
  const chunks = splitDiscordMessage(`~~~~js\n${"a".repeat(1_980)}😀${"b".repeat(100)}\n~~~~`);
  assert(chunks.every((chunk) => chunk.length <= 2_000));
  assert(chunks.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk) && !/^[\uDC00-\uDFFF]/.test(chunk)));
  assert.equal(chunks[0]?.endsWith("\n~~~~"), true);
  assert.equal(chunks[1]?.startsWith("~~~~js\n"), true);
});

test("turns are sequential per channel and globally capped", async () => {
  const queue = new ChannelTaskQueue(2);
  const order: string[] = [];
  let active = 0;
  let maximum = 0;
  const task = (name: string) => async () => {
    order.push(`${name}:start`);
    maximum = Math.max(maximum, ++active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active--;
    order.push(`${name}:end`);
  };

  await Promise.all([
    queue.run("a", task("a1")),
    queue.run("a", task("a2")),
    queue.run("b", task("b1")),
    queue.run("c", task("c1")),
  ]);
  assert.equal(maximum, 2);
  assert(order.indexOf("a1:end") < order.indexOf("a2:start"));
});

test("attachments are limited to safe Discord-hosted types and sizes", () => {
  const valid = {
    contentType: "image/png",
    id: "123456789012345678",
    name: "diagram.png",
    size: 1_024,
    url: "https://cdn.discordapp.com/attachments/1/2/diagram.png?ex=1",
  };
  assert.deepEqual(validateDiscordAttachment(valid), { contentType: "image/png", isImage: true });
  assert.throws(() => validateDiscordAttachment({ ...valid, size: 10 * 1024 * 1024 + 1 }), /10 MiB/);
  assert.throws(() => validateDiscordAttachment({ ...valid, contentType: "application/zip" }), /unsupported type/);
  assert.throws(() => validateDiscordAttachment({ ...valid, url: "https://example.com/diagram.png" }), /Discord's CDN/);
  assert.throws(() => validateDiscordAttachment({ ...valid, url: "http://cdn.discordapp.com/diagram.png" }), /Discord's CDN/);
  assert.doesNotThrow(() => validateAttachmentBytes("image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
  assert.throws(() => validateAttachmentBytes("image/png", Buffer.from("not png")), /do not match/);
  assert.doesNotThrow(() => validateAttachmentBytes("application/json", Buffer.from('{"ok":true}')));
  assert.throws(() => validateAttachmentBytes("application/json", Buffer.from("not json")), /not valid JSON/);
  assert.throws(() => validateAttachmentBytes("text/plain", Buffer.from([0xff])), /UTF-8/);
  assert.equal(validateAttachmentBytes("text/plain", Buffer.from("hello")), "hello");
  assert.throws(() => validateAttachmentBytes("text/plain", Buffer.alloc(256 * 1024 + 1, 0x61)), /256 KiB/);
});

test("longer Markdown fence delimiters remain balanced", () => {
  const delimiter = "`".repeat(12);
  const chunks = splitDiscordMessage(`${delimiter}js\n${"x".repeat(4_000)}\n${delimiter}`);
  assert(chunks.every((chunk) => chunk.length <= 2_000));
  assert.equal(chunks[0]?.endsWith(`\n${delimiter}`), true);
  assert.equal(chunks[1]?.startsWith(`${delimiter}js\n`), true);
});
