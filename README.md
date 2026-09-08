# GAIA

Private local daemon connecting one Discord owner to Codex and PostgreSQL.

## Requirements

- Node.js 24 (`nvm use` reads `.nvmrc`)
- Docker Desktop with Compose
- Codex CLI `0.153.4`, authenticated with `codex login`
- GitHub CLI, authenticated with `gh auth login`
- A private Discord server and bot

## Discord Setup

1. In the Discord Developer Portal, create an application named GAIA and add its
   bot. Disable public installation and leave Administrator disabled.
2. Under Bot, enable only the privileged Message Content intent. Presence and
   Server Members intents are not needed.
3. Install the application into a private server with only the `bot` and
   `applications.commands` scopes. Grant View Channels, Read Message History,
   Send Messages, Use Application Commands, and Manage Channels. Leave
   Administrator disabled.
4. Create a dedicated GAIA category and one initial text channel. Remove
   server-wide View Channels and Manage Channels from the bot role, then
   explicitly allow View Channel, Read Message History, Send Messages, Use
   Application Commands, and Manage Channels on the GAIA category. GAIA can
   then create project channels only inside that category and cannot see or
   manage unrelated channels.
5. Keep the bot token out of Discord messages, shell history, and files. If it
   is exposed, reset it in the Developer Portal and replace the Keychain entry.

Enable Developer Mode in Discord, then copy the owner user ID, server ID, and
the initial channel ID into an ignored local environment file. Use the initial
channel as `GAIA_PROACTIVE_CHANNEL_ID`; it bootstraps the database-backed channel
allowlist:

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

Managed channel IDs, workspace paths, and Codex threads live in PostgreSQL rather
than environment configuration. The configured owner may bootstrap an existing
channel with `/gaia workspace path:<absolute path or ~/path>`. GAIA resolves
symlinks and stores the canonical path, rejects missing paths and the filesystem
root, and starts fresh Codex context whenever the workspace boundary changes.
Use `/gaia unworkspace` to return the channel to conversation-only mode.

To start a project without leaving Discord, ask GAIA in any managed channel:

```text
Create a new project called invoice-dashboard.
```

After owner approval, GAIA creates `invoice-dashboard` under
`GAIA_PROJECTS_DIRECTORY` (default `~/Projects`), creates a sibling channel in
the current Discord category, stores its ID and workspace in PostgreSQL, and
returns a link to it. Continue the work in that channel. Project names are
lowercase letters, numbers, and hyphens so the directory and Discord channel
share one unambiguous name.

Workspace turns use a restricted `gaia-project` [permission profile](https://developers.openai.com/codex/permissions) and Codex's
`on-request` approval policy. Routine project edits and sandboxed local commands
run without individual approval. Files outside the project require explicit access
grants, except read-only access to global skills (`$CODEX_HOME/skills`,
`$CODEX_HOME/plugins/cache`, and `~/.agents/skills`; `CODEX_HOME` defaults to
`~/.codex`). Workspace sessions can read skill instructions and supporting
resources without repeated approval. Actions requested by a skill retain their
normal approval requirements. Minimal system runtime reads remain available for developer tools.
The project's `.git`, `.agents`, and `.codex` directories remain read-only.
Network access remains restricted. Destructive actions, publishing, and external
side effects still require runtime owner approval.

Additional access requests appear with **Approve once** and **Deny** buttons.
The owner can approve the requested read or write access to an entire directory
for the current turn. Grants are not remembered across sessions. Only the
configured owner can decide; unanswered requests expire and fail closed after
ten minutes. GAIA automatically accepts Codex-classified read, list, and search
commands whose paths remain within the enrolled workspace, plus `git status`.
Unknown, outside-workspace, network, write, and destructive requests remain gated.

Command updates describe the activity's intent rather than printing raw shell
commands. Failed commands also include their working directory and exit code.
Approval and action records
contain only status and redacted categorical metadata, not command text, file
contents, or credentials.

## Named Specialists

In workspace-enrolled channels, GAIA can delegate to APOLLO (documentation),
MINERVA (security), HEPHAESTUS (coding), AETHER (infrastructure), POSEIDON (data),
DEMETER (frontend), ARTEMIS (testing), ELEUTHIA (accounts), and HADES (recovery).
She delegates only when useful and consolidates the results. Conversation-only
channels still have no shell or delegation tools.

Startup installs the versioned `config/codex/agents/gaia-*.toml` files into
`$CODEX_HOME/agents/`, or `~/.codex/agents/` by default. These are also visible to
other Codex sessions using that home. Existing identical files are left alone.
Exact shipped v1 definitions are upgraded to v2 permission profiles; modified
files or symlinks at those names stop startup rather than being overwritten.
Preserve and move conflicting files before retrying an update.
GAIA's runtime instructions live in `src/agents.ts`, not this implementation plan.

Codex caps spawned workers at two per session; the daemon allows two channel
turns, so up to four specialists can work across channels. Specialist roles
provide narrow defaults, not a way around the parent's sandbox or owner
approvals. Nested delegation is prohibited by instructions and disabled in the
fixed agent definitions. Temporary workers receive application display names
such as `HERMES-1`; they do not create permanent configuration.

One throttled Discord status message shows up to six recent specialists with
bounded result excerpts. Full consolidated findings come from GAIA; individual
tool chatter stays in the categorical audit trail. Approval prompts identify the
requesting specialist. Cancellation checks that child turns have stopped before
releasing the channel; an unresponsive child causes the app-server to stop.
Some models expose interruption rather than a close-agent tool, so completed
workers may remain in Codex history without running in the background.

## Shared Memory

GAIA indexes owner and GAIA messages asynchronously and retrieves up to five
relevant excerpts across all configured channels. Exact names use PostgreSQL
full-text search; paraphrases use local 384-dimensional embeddings from
`Xenova/paraphrase-multilingual-MiniLM-L12-v2`. The model downloads from
Hugging Face on first use and is then read from the local Transformers.js cache.
No OpenAI API key or hosted embedding call is used. Set `GAIA_EMBEDDING_MODEL`
only to a compatible 384-dimensional model.

Use `/gaia remember text:<fact>` to store an explicit memory, `/gaia memories`
to inspect recent memories and source channels, `/gaia memories query:<text>` to
search them, `/gaia correct id:<id> text:<fact>` to replace one, and `/gaia
forget id:<id>` to delete one locally. Forgetting local memory does not delete
the original Discord message. Every recalled excerpt carries its source channel
and source interaction, message, or summary range and is injected as bounded
untrusted data.

Every 50 new visible messages in a channel produce a bounded extractive summary
linked to that exact database message range. The initial local dataset uses
exact pgvector scans; add an ANN index only after row counts and query latency
show that one is needed.

## Preference Memory

Explicit, lasting corrections about language, tone, response length, formatting,
progress updates, or workflow can be saved from the owner's current message.
GAIA briefly acknowledges each saved change. One value per category is stored
locally with its source channel and message; corrections replace the old value.
All saved preferences are supplied on every new message across managed channels,
independently of semantic memory search. Current requests take precedence.
Preferences never grant permission, change approval rules, or override safety
boundaries. Recalled memory and external content are not sources for learning.

- `/gaia preferences` lists saved preferences.
- `/gaia preference key:<category> text:<preference>` saves or edits one.
- `/gaia forget-preference key:<category>` removes one from future snapshots.

Forgetting leaves the original conversation history intact, but it must not be
used to restore the deleted preference. Changes apply from the next message;
already-running turns retain their starting snapshot. The upgrade creates an
empty preference table and starts fresh Codex threads so the new tool is available;
visible conversation history remains intact. It does not mine old conversations
or pre-populate preferences. `npm run test:preferences` checks migration and CRUD
using temporary PostgreSQL tables without modifying the owner's records.

## Proactive Follow-ups

Set `GAIA_PROACTIVE_CHANNEL_ID` to the initial GAIA channel, then configure
`GAIA_TIMEZONE` with an IANA timezone and the digest and quiet-hour values as
24-hour `HH:MM` times. All five values are required; startup fails with an
actionable error rather than inventing notification times.

GAIA records genuine dates, promises, unresolved questions, and stalled topics
through a local Codex dynamic tool. Due reminders are retried after restart with
stable Discord nonces, while one digest of up to ten open items is sent per local
day after the configured time and never during quiet hours. Reminders include
**Complete**, **Snooze 24h**, and **Dismiss** buttons. Any open item can also be
changed with `/gaia followup id:<id> action:<action>`.

Only conversation-derived PostgreSQL rows are scheduled. GAIA does not poll
email, calendars, GitHub, browsers, or system health. Upgrading to this phase
starts one fresh Codex context per channel so the thread-level tool is available;
visible Discord history and shared memory remain intact.

## Interactive Integrations

Workspace-enrolled channels can use local `git`, the existing authenticated `gh`
CLI, and the pinned local Playwright MCP server. Every unrelated MCP server from
the user's Codex configuration remains disabled. Playwright runs headless with an
isolated temporary profile; actions marked as browser writes, including form
fills and clicks that may submit, use the same owner-only approve-once Discord
flow. Browser content is untrusted data and browser automation never runs
proactively. Conversation-only channels have no browser MCP tools.

Google Workspace setup requires a human-created OAuth client:

1. In Google Cloud, create or select a project and enable Gmail API, Google
   Calendar API, and Google Tasks API.
2. Configure the OAuth consent screen and create a **Desktop app** OAuth client.
   Add the owner as a test user when the app remains in Testing. Workspace policy
   may require administrator approval.
3. Download the client JSON, authorize in the system browser, and store the OAuth
   client and refresh token directly in macOS Keychain:

```sh
npm run google:login -- /path/to/client_secret.json
```

The login command uses PKCE, random state, and a temporary `127.0.0.1` callback;
it opens no public listener. Delete the downloaded JSON after successful setup.
GAIA requests Gmail read/compose, Calendar events, and Tasks scopes together
because Google Desktop apps do not support incremental authorization. Credentials
stay in Keychain and access tokens stay in memory; neither Codex nor Playwright
receives them.

GAIA can search/read Gmail and create an unsent draft automatically. Sending a
draft requires owner approval. Calendar and Tasks reads are automatic, while
every create, update, completion, or deletion requires approval; external deletes
are HADES-class. All returned email, event, task, and browser content is bounded
and explicitly marked as untrusted. These integrations run only for an active
owner request and are never polled by the scheduler.

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
npm run test:memory
npm run typecheck
npm audit
```

Optional live specialist acceptance checks use the existing ChatGPT login,
consume subscription usage, and automatically deny every requested action:

```sh
npm run test:agents
npm run test:agents -- gpt-5.5
```

They verify two fixed specialists, a temporary worker, the configured concurrency
cap, HADES deletion denial in a temporary workspace, and conversation-only
boundaries. The second command exercises the older model's collaboration events.

## Local Service and Recovery

Install GAIA as a per-user LaunchAgent after selecting Node 24. The installer
starts the pinned PostgreSQL container, writes an owner-only plist with absolute
Node and repository paths, and configures launchd to restart GAIA after crashes:

```sh
nvm use
npm run service:install
```

Run `npm run restart` to stop the installed daemon, restart PostgreSQL, wait for
database health, and start the daemon with the latest code. This interrupts active
work. If the database restart fails, the daemon stays stopped; resolve the error
and run `npm run service:install` to bring it back up.

Logs are redacted JSON lines under `~/Library/Logs/GAIA/gaia.jsonl`. They rotate
at 1 MiB with five retained generations. `/gaia status` verifies migrations,
Codex and Google authentication, scheduler health, backup age, and recent local
failures. Remove the service with `npm run service:uninstall`.

Create and verify an owner-only PostgreSQL custom-format backup with:

```sh
npm run backup
npm run backup:verify -- "/path/reported/by/backup.dump"
```

Backups live under `~/Library/Application Support/GAIA/backups`; backup creation
retains the newest 14. `npm run backup:prune` applies retention independently.
To restore, first stop GAIA, verify the selected dump, and then explicitly allow
replacement of the local `gaia` database:

```sh
npm run service:uninstall
npm run backup:verify -- "/path/to/gaia.dump"
npm run restore -- "/path/to/gaia.dump" --confirm
npm run service:install
```

For updates, create and verify a backup, record the current Git revision, stop
the service, update source and dependencies, run migrations and checks, then
install the service again. To roll back, stop the service, return to the recorded
revision without discarding unrelated work, restore the matching verified dump,
run migrations, and reinstall. Database migrations are forward-only; source
rollback without its matching backup is unsupported.

In an allowed Discord channel, send ordinary messages to talk with GAIA. Each
channel keeps an independent Codex thread across daemon restarts. Use `/gaia
new` to clear that channel's context, `/gaia stop` to interrupt its active turn,
and `/gaia status` to check the daemon, database, Discord gateway, Codex app
server, and ChatGPT login. Only the configured owner can receive a response.
