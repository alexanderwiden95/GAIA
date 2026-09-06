import { CodexClient } from "./codex.ts";
import { createPool, runMigrations } from "./db.ts";
import { loadDiscordToken, parseAccessConfig, startDiscord, type DiscordService } from "./discord.ts";

const pool = createPool();
const codex = new CodexClient();
let discord: DiscordService | null = null;
let shuttingDown: Promise<void> | null = null;

async function shutdown(): Promise<void> {
  if (!shuttingDown) {
    shuttingDown = (async () => {
      await discord?.close();
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
  const config = parseAccessConfig();
  await codex.start();
  discord = await startDiscord(pool, codex, config, await loadDiscordToken());
  console.log(applied.length ? `GAIA ready; applied ${applied.join(", ")}` : "GAIA ready");
} catch (error) {
  await shutdown();
  console.error(error instanceof Error ? error.message : "GAIA failed to start");
  process.exitCode = 1;
}
