# GAIA

Private local daemon connecting one Discord owner to Codex and PostgreSQL.

## Requirements

- Node.js 24 (`nvm use` reads `.nvmrc`)
- Docker Desktop with Compose
- Codex CLI `0.153.4`, authenticated with `codex login`
- A private Discord server and bot

## Discord Setup

1. In the Discord Developer Portal, create an application named GAIA and add its
   bot. Disable public installation and leave Administrator disabled.
2. Under Bot, enable only the privileged Message Content intent. Presence and
   Server Members intents are not needed.
3. Install the application into a private server with only the `bot` and
   `applications.commands` scopes. Grant View Channels, Read Message History,
   Send Messages, and Use Application Commands. Add future permissions only
   when a feature starts using them.
4. Create a dedicated GAIA category and text channels. Remove server-wide View
   Channels from the bot role, then explicitly allow View Channel, Read Message
   History, Send Messages, and Use Application Commands on the GAIA category.
   This prevents the bot from seeing unrelated channels. Ordinary conversation
   is mention-free inside configured channels.
5. Keep the bot token out of Discord messages, shell history, and files. If it
   is exposed, reset it in the Developer Portal and replace the Keychain entry.

Enable Developer Mode in Discord, then copy the owner user ID, server ID, and
allowed channel IDs into an ignored local environment file:

```sh
cp .env.example .env
```

Store the bot token in macOS Keychain. Omitting the password after the final
`-w` makes `security` prompt without putting the token in shell history:

```sh
security add-generic-password -U -a gaia -s gaia.discord.bot-token -w
```

`GAIA_DISCORD_TOKEN` in the ignored `.env` file is supported only as a local
development fallback.

Discord desktop and mobile clients both use the same channels and slash
commands. GAIA reconnects through Discord's outbound Gateway connection; no
inbound application port or paid Discord feature is required.

## Attachments

GAIA accepts Discord-hosted PNG, JPEG, GIF, and WebP files up to Discord's free
10 MiB limit, plus plain text, Markdown, CSV, and JSON files up to 256 KiB so
they fit safely in model context. Other
types, oversized files, redirects, and non-Discord download hosts are rejected
with a visible message. Accepted files are downloaded with generated names to
an isolated temporary directory, treated as untrusted data, and deleted after
the turn finishes.

## Workspaces and Approvals

Channels remain conversation-only until the owner enrolls an existing local
directory with `/gaia workspace path:<absolute path or ~/path>`. GAIA resolves
symlinks and stores the canonical path, rejects missing paths and the filesystem
root, and starts fresh Codex context whenever the workspace boundary changes.
Use `/gaia unworkspace` to return the channel to conversation-only mode.

Workspace turns use Codex `workspace-write` sandboxing and its strict
`untrusted` approval policy. Command, file-change, and additional-permission
requests appear as Discord messages showing the agent, action, target, reason,
and risk, with **Approve once** and **Deny** buttons. Only the configured owner
can decide; unanswered requests expire and fail closed after ten minutes.
Destructive requests are labeled HADES-class and always require a button click.
GAIA posts bounded command and file-change summaries after execution.

Approval and action records contain only status and redacted categorical
metadata, not command text, file contents, or credentials. Remembered approvals
are intentionally not offered; use approve-once for every request.

## Run

Install packages once, then start PostgreSQL, apply migrations, and start GAIA:

```sh
nvm use
npm install
npm run dev
```

Run migrations independently or stop PostgreSQL without deleting its volume:

```sh
npm run migrate
docker compose down
```

GAIA makes outbound Discord and Codex connections. It opens no application
listener. PostgreSQL is the only published port and is bound to
`127.0.0.1:5432`.

## Check

```sh
npm test
npm run test:db
npm run typecheck
npm audit
```

In an allowed Discord channel, send ordinary messages to talk with GAIA. Each
channel keeps an independent Codex thread across daemon restarts. Use `/gaia
new` to clear that channel's context, `/gaia stop` to interrupt its active turn,
and `/gaia status` to check the daemon, database, Discord gateway, Codex app
server, and ChatGPT login. Only the configured owner can receive a response.
