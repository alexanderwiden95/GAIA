import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GOOGLE_SCOPES, saveGoogleCredentials } from "./integrations.ts";

const path = process.argv[2];
if (!path) throw new Error("Usage: npm run google:login -- /path/to/google-desktop-client.json");
if (process.platform !== "darwin") throw new Error("Google login currently requires macOS Keychain");

const downloaded = JSON.parse(await readFile(path, "utf8")) as { installed?: { client_id?: unknown; client_secret?: unknown } };
const clientId = downloaded.installed?.client_id;
const clientSecret = downloaded.installed?.client_secret;
if (typeof clientId !== "string" || (clientSecret !== undefined && typeof clientSecret !== "string")) throw new Error("Expected a Google Desktop app OAuth client JSON file");

const verifier = randomBytes(64).toString("base64url");
const challenge = createHash("sha256").update(verifier).digest("base64url");
const state = randomBytes(32).toString("base64url");
const callback = Promise.withResolvers<string>();
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (url.pathname !== "/oauth/callback" || url.searchParams.get("state") !== state) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Invalid OAuth callback.");
    return;
  }
  const code = url.searchParams.get("code");
  if (!code) {
    response.writeHead(400, { "content-type": "text/plain; charset=utf-8" }).end("Google authorization was denied.");
    callback.reject(new Error("Google authorization was denied"));
    return;
  }
  response.writeHead(200, { "content-type": "text/plain; charset=utf-8" }).end("GAIA Google authorization complete. You may close this tab.");
  callback.resolve(code);
});

try {
  await new Promise<void>((resolve, reject) => server.listen(0, "127.0.0.1", resolve).once("error", reject));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not start the loopback OAuth callback");
  const redirectUri = `http://127.0.0.1:${address.port}/oauth/callback`;
  const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authorization.search = new URLSearchParams({ client_id: clientId, redirect_uri: redirectUri, response_type: "code", scope: GOOGLE_SCOPES.join(" "), access_type: "offline", prompt: "consent", code_challenge: challenge, code_challenge_method: "S256", state }).toString();
  await promisify(execFile)("/usr/bin/open", [authorization.toString()]);
  console.log("Complete Google authorization in the opened system browser.");
  const timeout = setTimeout(() => callback.reject(new Error("Google authorization timed out")), 5 * 60_000);
  const code = await callback.promise.finally(() => clearTimeout(timeout));
  const body = new URLSearchParams({ client_id: clientId, code, code_verifier: verifier, grant_type: "authorization_code", redirect_uri: redirectUri });
  if (clientSecret) body.set("client_secret", clientSecret);
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body, signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`Google token exchange failed with status ${response.status}`);
  const token = await response.json() as { refresh_token?: unknown; scope?: unknown };
  if (typeof token.refresh_token !== "string" || typeof token.scope !== "string") throw new Error("Google did not return a refresh token and granted scopes");
  const scopes = token.scope.split(" ");
  const missing = GOOGLE_SCOPES.filter((scope) => !scopes.includes(scope));
  if (missing.length) throw new Error("Google consent did not grant all required Gmail, Calendar, and Tasks scopes");
  saveGoogleCredentials({ clientId, clientSecret, refreshToken: token.refresh_token, scopes });
  console.log("Google credentials saved in macOS Keychain.");
} finally {
  server.close();
}
