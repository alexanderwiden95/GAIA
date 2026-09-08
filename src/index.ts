import { CodexClient } from "./codex.ts";
import { createPool, expirePendingApprovals, getOrCreateChannel, managedChannelIds, runMigrations } from "./db.ts";
import { loadDiscordToken, parseAccessConfig, startDiscord, type DiscordService } from "./discord.ts";
import { IntegrationService } from "./integrations.ts";
import { MemoryService } from "./memory.ts";
import { parseProactivityConfig } from "./scheduler.ts";
import { logError, logInfo } from "./logger.ts";

const pool = createPool();
const integrations = new IntegrationService();
const codex = new CodexClient(integrations);
const memory = new MemoryService(pool);
let discord: DiscordService | null = null;
let shuttingDown: Promise<void> | null = null;

async function shutdown(): Promise<void> {
  if (!shuttingDown) {
    shuttingDown = (async () => {
      const failures: unknown[] = [];
      await discord?.close().catch((error) => failures.push(error));
      const services = await Promise.allSettled([memory.close(), codex.stop()]);
      failures.push(...services.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((result) => result.reason));
      await pool.end().catch((error) => failures.push(error));
      for (const failure of failures) logError("shutdown", failure);
      if (failures.length) throw new Error("One or more services failed to stop cleanly");
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
  const expired = await expirePendingApprovals(pool);
  memory.start();
  const config = parseAccessConfig();
  const proactivityConfig = parseProactivityConfig();
  await getOrCreateChannel(pool, proactivityConfig.channelId, "proactive");
  for (const channelId of await managedChannelIds(pool)) config.channelIds.add(channelId);
  await codex.start();
  discord = await startDiscord(pool, codex, memory, integrations, config, await loadDiscordToken(), proactivityConfig);
  logInfo("daemon", `${applied.length ? `Ready; applied ${applied.join(", ")}` : "Ready"}${expired ? `; expired ${expired} stale approvals` : ""}`);
} catch (error) {
  await shutdown();
  logError("daemon", error instanceof Error ? error : "GAIA failed to start");
  process.exitCode = 1;
}

process.on("unhandledRejection", (error) => logError("process", error));
process.on("uncaughtExceptionMonitor", (error) => logError("process", error));
