import { appendFileSync, mkdirSync, readFileSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type LogLevel = "info" | "warn" | "error";
export type RecentFailure = { timestamp: string; component: string; message: string };

export function redact(value: string, env: NodeJS.ProcessEnv = process.env): string {
  let safe = value;
  for (const name of ["DATABASE_URL", "GAIA_DISCORD_TOKEN", "OPENAI_API_KEY"]) {
    const secret = env[name];
    if (secret && secret.length >= 6) safe = safe.replaceAll(secret, "[REDACTED]");
  }
  safe = safe
    .replace(/(["'](?:Authorization|Cookie|Set-Cookie)["']\s*:\s*)(?:"[^"\r\n]*"|'[^'\r\n]*')/gi, "$1\"[REDACTED]\"")
    .replace(/\b(Authorization|Cookie|Set-Cookie)\s*[:=]\s*[^\r\n]+/gi, "$1: [REDACTED]")
    .replace(/Bearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/:\/\/([^:/\s]+):([^@/\s]+)@/g, "://$1:[REDACTED]@")
    .replace(/((?:authorization|cookie|password|refresh[_-]?token|secret|token)["']?\s*[:=]\s*["']?)[^\s"',}]+/gi, "$1[REDACTED]");
  return safe;
}

export class JsonLogger {
  readonly path: string;
  private readonly maximumBytes: number;
  private readonly retainedFiles: number;
  private readonly failures: RecentFailure[] = [];

  constructor(directory = process.env.GAIA_LOG_DIR?.trim() || join(homedir(), "Library", "Logs", "GAIA"), maximumBytes = 1_048_576, retainedFiles = 5) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, "gaia.jsonl");
    this.maximumBytes = maximumBytes;
    this.retainedFiles = retainedFiles;
    try {
      for (const line of readFileSync(this.path, "utf8").trim().split("\n").slice(-100)) {
        const record = JSON.parse(line) as { timestamp?: unknown; level?: unknown; component?: unknown; message?: unknown };
        if (record.level === "error" && typeof record.timestamp === "string" && typeof record.component === "string" && typeof record.message === "string") {
          this.failures.push({ timestamp: record.timestamp, component: record.component, message: record.message });
          if (this.failures.length > 5) this.failures.shift();
        }
      }
    } catch {
      // A missing or partially written log must not prevent startup.
    }
  }

  write(level: LogLevel, component: string, message: unknown): void {
    const timestamp = new Date().toISOString();
    const safe = redact(message instanceof Error ? message.message : String(message)).slice(0, 2_000);
    if (level === "error") {
      this.failures.push({ timestamp, component, message: safe });
      if (this.failures.length > 5) this.failures.shift();
    }
    this.rotate();
    appendFileSync(this.path, `${JSON.stringify({ timestamp, level, component, message: safe })}\n`, { encoding: "utf8", mode: 0o600 });
  }

  recentFailures(): readonly RecentFailure[] {
    return this.failures;
  }

  private rotate(): void {
    try {
      if (statSync(this.path).size < this.maximumBytes) return;
    } catch {
      return;
    }
    for (let index = this.retainedFiles - 1; index >= 1; index--) {
      try {
        renameSync(`${this.path}.${index}`, `${this.path}.${index + 1}`);
      } catch {
        // Missing generations are expected.
      }
    }
    renameSync(this.path, `${this.path}.1`);
  }
}

export const logger = new JsonLogger();
export const logInfo = (component: string, message: unknown): void => logger.write("info", component, message);
export const logWarn = (component: string, message: unknown): void => logger.write("warn", component, message);
export const logError = (component: string, message: unknown): void => logger.write("error", component, message);
