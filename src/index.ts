import { CodexClient } from "./codex.ts";
import { createPool, runMigrations } from "./db.ts";
import { loadDiscordToken, parseAccessConfig, startDiscord, type DiscordService } from "./discord.ts";
import { IntegrationService } from "./integrations.ts";
import { MemoryService } from "./memory.ts";
import { parseProactivityConfig } from "./scheduler.ts";

const pool = createPool();
const integrations = new IntegrationService();
const codex = new CodexClient(integrations);
const memory = new MemoryService(pool);
let discord: DiscordService | null = null;
let shuttingDown: Promise<void> | null = null;

async function shutdown(): Promise<void> {
  if (!shuttingDown) {
    shuttingDown = (async () => {
      await discord?.close();
      await memory.close();
      await codex.stop();
      await pool.end();
    })();
  }
  await shuttingDown;
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void shutdown().then(() => process.exit(0), () => process.exit(1));
  });
}

try {
  const applied = await runMigrations(pool);
  memory.start();
  const config = parseAccessConfig();
  const proactivityConfig = parseProactivityConfig();
  if (!config.channelIds.has(proactivityConfig.channelId)) throw new Error("GAIA_PROACTIVE_CHANNEL_ID must also appear in GAIA_CHANNEL_IDS");
  await codex.start();
  discord = await startDiscord(pool, codex, memory, integrations, config, await loadDiscordToken(), proactivityConfig);
  console.log(applied.length ? `GAIA ready; applied ${applied.join(", ")}` : "GAIA ready");
} catch (error) {
  await shutdown();
  console.error(error instanceof Error ? error.message : "GAIA failed to start");
  process.exitCode = 1;
}
