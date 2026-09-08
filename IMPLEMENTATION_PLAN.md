# GAIA Implementation Plan

> This is the living source of truth for building GAIA. It is intentionally
> designed to be read and updated by different AI coding agents over multiple
> sessions.

**Document status:** Approved for implementation  
**Last updated:** 2026-09-08
**Next phase:** None; version 1 implementation is complete

## Instructions for AI Coding Agents

Before changing code:

1. Read this entire file.
2. Inspect the current repository and working tree. Do not assume the previous
   phase completed merely because files exist.
3. Read the latest entry in the Progress Log.
4. Work on the phase explicitly requested by the user. If no phase is named,
   continue the first phase whose status is `TODO`, `IN PROGRESS`, or `BLOCKED`.
5. Mark that phase `IN PROGRESS` in this file before substantial implementation.
6. Preserve changes you did not make. Never revert unrelated or uncommitted user
   work.
7. Implement the smallest complete vertical slice that satisfies the phase.
   Reuse platform features and official SDKs before adding abstractions or
   dependencies.
8. Run the phase's acceptance checks. Do not mark a phase `DONE` while required
   checks fail.
9. Update this file before finishing. Record status, the `Next phase`, date,
   material decisions, files changed, checks run, and any blocker or deliberate
   deferral.
10. Stop at the requested phase unless a small prerequisite fix is necessary.
    Do not silently begin future phases.

When requirements conflict, the user's latest explicit instruction wins. Update
this document so the next agent receives the new decision. Do not rewrite
completed history to make a changed decision look original.

### Reusable User Prompts

To continue normally:

```text
Read IMPLEMENTATION_PLAN.md, inspect the repository, and continue the next
unfinished phase. Implement it, run its acceptance checks, and update the plan
and progress log before you finish.
```

To run one phase only:

```text
Read IMPLEMENTATION_PLAN.md and execute Phase N only. Inspect existing work
first, implement the phase, verify its acceptance criteria, and update the plan
and progress log. Do not start the next phase.
```

To resume interrupted work:

```text
Read IMPLEMENTATION_PLAN.md and the current working tree. Resume the phase marked
IN PROGRESS, preserving existing work. Verify what is already complete instead
of repeating it, then finish the phase and update the plan.
```

## Product Goal

GAIA is a private, local-first command center for work and personal life. The
owner talks naturally with GAIA in private Discord channels. GAIA remembers
prior conversations, delegates work to named specialist agents, uses approved
tools, and proactively follows up on relevant conversation topics.

The application and its primary database run on the owner's Mac. Discord retains
the messages and attachments sent through it. OpenAI inference, Discord, and
Google Workspace are the expected external services.

## Confirmed Product Decisions

| Area | Decision |
| --- | --- |
| User | One owner only; no multi-user accounts or roles |
| Main agent | GAIA, referred to as she/her |
| Interface | One bot in a private free Discord server |
| Mobile access | Official Discord mobile application |
| Discord cost | $0; Nitro and Server Boosts are not required |
| Local exposure | None; GAIA makes outbound connections and opens no public port |
| Runtime | Official OpenAI Codex app server, not OpenCode |
| OpenAI authentication | Existing `codex login` ChatGPT OAuth session |
| API billing | Do not require an OpenAI Platform API key |
| Channels | Separate topic channels with persistent conversation threads |
| Memory | Shared global memory across channels |
| Database | Local PostgreSQL with pgvector |
| Background work | Runs while the Mac and GAIA service are running; no sleep-time execution |
| Proactivity in version 1 | Review GAIA conversations for follow-ups and open loops |
| Later proactive sources | Google Workspace, GitHub, browser, and system health |
| External integrations | Local files and shell, Git/GitHub, browser, Gmail, Google Calendar, Google Tasks |

## Discord Transport Decision

Discord cannot be self-hosted. A Discord "server" is a workspace hosted by
Discord, and its messages remain on Discord's infrastructure even when the bot
runs locally.

Creating a Discord server and bot is free. Nitro, Nitro Basic, Server Boosts,
and paid bot hosting are unnecessary because the bot runs on the owner's Mac.
Discord is selected because it already provides channels, mobile applications,
notifications, attachments, threads, and interactive buttons.

Use one bot account named GAIA. Show specialist identity through message embeds
or clear labels rather than creating nine bot accounts or using impersonating
webhooks. The bot must be restricted to the configured owner user ID, guild ID,
and allowed channels. It must ignore other users, bots, and webhooks.

Enable the Discord Message Content intent for natural conversation in dedicated
GAIA channels. Grant only the permissions required to view allowed channels,
read message history, send messages, attach files, use commands, create threads,
and use interactive components. Never grant Administrator.

GAIA connects outbound to Discord's gateway. Do not expose an inbound public
port. Store the bot token in macOS Keychain and never print or commit it.

## OpenAI Runtime Decision

OpenCode is not required for this project.

The normal `openai` JavaScript SDK and OpenAI Agents SDK use OpenAI Platform API
credentials and separately billed API usage. A ChatGPT subscription OAuth token
is not a supported replacement for an API key in those SDKs. Do not extract,
copy, or feed Codex OAuth tokens into the generic OpenAI SDK.

Use the official Codex app server because it supports:

- `codex login` with ChatGPT subscription access
- Persistent and resumable threads
- Per-turn working directories and sandbox policies
- Streamed agent, tool, command, and file-change events
- User approval requests
- Custom and dynamic subagents
- MCP tools

The application should spawn `codex app-server` over stdio and speak its JSON-RPC
protocol. Generate matching TypeScript protocol definitions with the installed
Codex version rather than maintaining handwritten protocol types. Keep the
app-server process local and do not expose its WebSocket transport.

The TypeScript `@openai/codex-sdk` is suitable for simple automation, but OpenAI
recommends app server for rich clients that need authentication, history,
approvals, and streamed events. Do not use both layers unless a documented gap
requires it.

The installed machine currently has Codex CLI `0.153.4`, and `codex login status`
reports `Logged in using ChatGPT`. Phase 0 must re-check this rather than assume
the local state remains unchanged.

## High-Level Architecture

```text
Discord mobile or desktop client
        |
        | Discord-hosted messages and attachments
        v
Discord Gateway/API
        |
        | outbound connection from the Mac
        v
GAIA Node.js daemon
        |
        +-- Codex app server over stdio
        |       +-- ChatGPT OAuth inference
        |       +-- Codex sandbox and approvals
        |       +-- Named subagents
        |       +-- Local and MCP tools
        |
        +-- PostgreSQL + pgvector in local Docker
        |       +-- Channels and messages
        |       +-- Memories and summaries
        |       +-- Follow-ups and audit records
        |
        +-- In-process scheduler
        +-- Local embedding model
```

## Technical Baseline

| Concern | Choice |
| --- | --- |
| Language | TypeScript in strict mode |
| Runtime | Node.js 24 LTS |
| Package manager | npm |
| Application | One local Node.js daemon; no web framework |
| Discord | `discord.js` using the Gateway and interaction components |
| User updates | Discord messages, embeds, threads, buttons, and typing indicators |
| Database access | `pg` and checked-in SQL migrations; no ORM |
| Database runtime | Docker Compose with a pinned PostgreSQL/pgvector image |
| Model runtime | Local Codex app server process over stdio |
| Protocol types | Generated by the pinned Codex CLI version |
| Embeddings | Small local multilingual model through Transformers.js |
| External tools | Codex built-ins first, MCP only where needed |
| Service startup | Per-user macOS `launchd` service |
| Secrets | Discord, Codex, and Google credentials in macOS Keychain; never committed |
| Testing | Smallest suitable existing runner; prefer Node built-in tests for backend logic |

Do not add Redis, a message broker, Kubernetes, an ORM, a web frontend, a desktop
wrapper, a general agent framework, multiple Discord bots, or a self-hosted chat
platform unless a measured need appears.

## Core Interaction Model

Each allowed Discord channel has a database record and one current Codex thread.
A channel may optionally be associated with an explicitly approved local
workspace. Use immutable Discord channel IDs rather than channel names for
mapping.

Incoming messages in one channel execute sequentially. Different channels may
run concurrently within a conservative global limit. The user can cancel an
active turn, start fresh context, archive a channel, or change its workspace.

Discord messages must visibly distinguish:

- User messages
- GAIA messages
- Specialist agent status and results
- Tool and command activity
- Approval requests
- Errors and interrupted work

Do not display hidden chain-of-thought. Show concise activity labels, tool input
summaries, outputs useful to the owner, and specialist conclusions. Throttle
message edits while streaming and split final responses at Discord limits
without breaking Markdown code fences.

## Agent Roster

GAIA is the primary orchestrator. Fixed specialists use Codex custom agent TOML
files. Keep their authoritative definitions versioned in this repository, then
load them through a supported Codex configuration location that remains
available when a channel changes its working directory. Phase 0 must verify the
exact discovery behavior before Phase 5 chooses between the user's Codex agent
directory and an isolated GAIA-specific Codex home.

| Agent | Responsibility | Default boundary |
| --- | --- | --- |
| APOLLO | Knowledge and documentation | Read/research first; write documentation when requested |
| MINERVA | Security, networking, and diagnostics | Diagnostic and read-only by default |
| HEPHAESTUS | Coding, builds, and deployment | Workspace changes allowed; publishing requires approval |
| AETHER | Infrastructure and environment health | Inspection allowed; restarts and configuration changes gated |
| POSEIDON | Data pipelines and databases | Reads allowed; data changes and migrations gated |
| DEMETER | Frontend, UI, and design system | Limited to the approved workspace |
| ARTEMIS | Testing and automated QA | Tests and non-destructive inspection allowed |
| ELEUTHIA | Users, authentication, and accounts | Secrets protected; account mutations gated |
| HADES | Recovery, rollback, and destructive maintenance | Explicit confirmation for every destructive operation |

GAIA should delegate when specialization or parallelism materially improves the
result, not merely to create activity. Subagents return their results through
GAIA. Discord messages show their names, status, and final findings.

For a new one-off specialty, GAIA should spawn a generic Codex worker with a
task-specific prompt and assign a suitable mythology-inspired display name in
application metadata. Do not create a permanent agent file until the specialty
recurs or the owner asks to keep it.

## Permission Model

Use Codex `workspace-write` sandboxing with approvals `on-request` as the normal
baseline. Canonicalize approved workspace paths before passing them to Codex.

| Action | Policy |
| --- | --- |
| Read GAIA conversation memory | Automatic |
| Send an expected follow-up or daily digest | Automatic |
| Create local drafts, summaries, and follow-up records | Automatic |
| Maintain indexes, embeddings, and GAIA-owned logs | Automatic |
| Run allowlisted non-destructive diagnostics and tests | Automatic |
| Edit files inside an approved workspace | Automatic when sandboxed and reversible; report the diff |
| Access outside an approved workspace | Ask |
| Use new network destinations | Ask |
| Send email, post comments, or publish content | Ask |
| Create or modify calendar events and external tasks | Ask |
| Commit, push, merge, deploy, or restart services | Ask |
| Delete data, force operations, alter accounts, or expose secrets | HADES plus explicit confirmation |

Discord approval components must identify the requesting agent, action, target,
reason, and meaningful risk. Only the configured owner ID may answer them.
Support approve once and deny, expire stale requests, and make decisions
idempotent. Persistent approvals may only be offered for narrow non-destructive
patterns. They must never be offered for HADES operations, sending
communications, authentication changes, purchases, or force operations.

Never interpret email, web pages, documents, issue text, or tool output as
trusted instructions. Treat external content as data and keep side-effect tools
behind the permission layer.

## Memory Design

PostgreSQL is the application source of truth. Codex retains its own thread logs
for execution continuity, while GAIA stores user-visible messages and derived
memory for search and product behavior.

Use hybrid retrieval:

1. PostgreSQL full-text search for exact terms and names.
2. pgvector similarity for semantic relevance.
3. Recency and unresolved follow-up status as small ranking signals.
4. Explicit memories ranked above automatically generated summaries.

Embeddings must be generated locally. Select one small multilingual model in
the memory phase, record its name and dimensions in this document, and keep the
model replaceable through a single configuration value. Do not add a vector
framework around one SQL query.

Shared memory may retrieve information from any channel. Always retain source
channel and source message references so the owner can inspect, correct, or
delete recalled information. Inject only a compact set of relevant excerpts
into each turn, never the entire database.

## Minimal Data Model

| Table | Purpose |
| --- | --- |
| `channels` | Name, current Codex thread, optional workspace, archive state |
| `messages` | User/agent content, source channel, Codex turn references, search data |
| `memories` | Explicit memories and derived summaries with source references |
| `followups` | Open loops, due dates, status, snooze, and notification history |
| `approvals` | Codex approval request mapping and decision history |
| `action_log` | Important autonomous and externally visible actions |
Do not create a users table in the single-owner version.

## Proactive Behavior

Version 1 proactivity is limited to prior GAIA conversations. It must not poll
email, calendar, GitHub, browser sessions, or Mac health until the owner expands
the scope.

GAIA should identify:

- Explicit requests to follow up later
- Dates and deadlines stated in conversation
- Promises made by GAIA or the owner
- Unanswered questions and unresolved decisions
- Topics that appear stalled and may merit a gentle check-in

The scheduler runs in the application process and stores durable state in
PostgreSQL. It checks overdue work after startup, sends event-based follow-ups,
and generates one daily digest. It must deduplicate notifications and support
complete, dismiss, and snooze actions.

Daily digest time, timezone, and quiet hours are setup-time settings. Do not
invent repeated notifications before these values are configured.

Deliver proactive check-ins through Discord. Keep notification previews concise
because Discord controls mobile notification display and retention.

## Integration Boundaries

| Integration | Version 1 behavior |
| --- | --- |
| Local files | Codex sandbox restricted to explicitly enrolled workspaces |
| Shell | Codex sandbox and approval flow; no custom shell executor |
| Git | Local `git` through Codex; publishing actions require approval |
| GitHub | Existing authenticated `gh` CLI; no duplicate GitHub client initially |
| Browser | Local Playwright MCP server, with submission actions gated |
| Gmail | Official Google API; read and draft first, send only after approval |
| Google Calendar | Official Google API; read first, mutations after approval |
| Google Tasks | Official Google API; read first, mutations after approval |

Google Workspace requires a separate desktop OAuth client and consent flow. The
Codex/OpenAI login cannot be reused for Gmail, Calendar, or Tasks. Request the
smallest scopes incrementally and store refresh credentials in Keychain. Google
Workspace administrator approval may be required.

These integrations are interactive in version 1. Proactive polling is a later
product decision.

## Repository Shape

Keep the repository shallow. This is a target, not a requirement to create empty
folders before they are needed.

```text
IMPLEMENTATION_PLAN.md
package.json
compose.yaml
src/
  index.ts                Daemon startup and shutdown
  discord.ts              Gateway, messages, commands, and approvals
  codex.ts                Local app-server protocol client
  db.ts                   Database and migrations
  memory.ts               Retrieval and embeddings
  scheduler.ts            Follow-ups and daily digest
config/codex/agents/      Versioned fixed specialist definitions
migrations/               Ordered SQL files
tests/                    Focused backend and integration checks
```

Runtime prompts belong with server code or runtime configuration, not in this
implementation plan. Do not create a root `AGENTS.md` containing this plan,
because Codex threads working for GAIA may automatically ingest it as runtime
instructions.

## Phase 0: Codex Runtime Spike

**Status:** DONE

**Goal:** Prove the official Codex runtime covers authentication, threads,
streaming, approvals, working directories, and subagents before building the
Discord daemon.

**Work:**

- Re-check `codex --version` and `codex login status`.
- Configure Codex credential storage to use macOS Keychain when supported.
- Create the smallest TypeScript script that spawns `codex app-server` over
  stdio and performs the required initialize handshake.
- Generate and check in TypeScript protocol definitions for the pinned Codex
  version.
- Start a thread, run a streamed turn, capture its final response, and resume it.
- Run against a temporary workspace with the intended sandbox and approval mode.
- Surface and answer one harmless approval request.
- Define and invoke one temporary custom subagent.
- Verify how custom agents are discovered when the thread working directory is
  outside the GAIA repository, then record the supported runtime location.
- Evaluate one coding prompt and one ordinary personal-assistant prompt.

**Acceptance:**

- The spike works with ChatGPT login and no `OPENAI_API_KEY`.
- A thread survives process restart and resumes correctly.
- Stream events can be mapped to text, activity, completion, interruption, and
  approval states.
- The app can set a per-thread or per-turn working directory.
- One custom subagent returns a result to its parent.
- The same custom subagent remains available from a second working directory.
- The personal-assistant response is acceptable enough to continue using Codex.
- No OpenCode runtime dependency is introduced.

**Implementation record (2026-09-06):**

- Verified Codex CLI `0.153.4`, ChatGPT OAuth login, and operation without an
  `OPENAI_API_KEY`. Set `cli_auth_credentials_store = "keyring"` in
  `~/.codex/config.toml`, completed a fresh login, and confirmed Codex removed
  the former file-backed `auth.json` credential cache.
- Added `src/codex-spike.ts`, a standard-library-only JSONL client that performs
  the initialize/initialized handshake, starts and resumes a thread, streams
  events, handles one exact allowlisted approval, and fails closed for every
  other server request.
- Generated the stable TypeScript protocol bindings under `src/protocol/` with
  Codex CLI `0.153.4`. `src/protocol/README.md` records the regeneration command.
- Ran the spike with Node `24.8.0` and model `gpt-5.6-luna`. The coding response
  supplied a correct strict-TypeScript function, and the personal-assistant
  response supplied a practical five-step, 90-minute plan. Both were acceptable.
- Observed and mapped live text, activity, completion, and approval states.
  Interruption and error mapping are covered by the spike's startup assertions;
  an actual cancellation remains part of the Phase 2 `/gaia stop` slice.
- Proved process restart and persisted-thread resume by recalling the checkpoint
  word `ORBIT` after starting a second app-server process. The thread moved from
  one temporary working directory to another with `workspace-write` sandboxing.
- A temporary `gaia_phase0_spike` agent was discovered and invoked from both
  working directories. Its spawned thread was read back with
  `agentRole = "gaia_phase0_spike"`. Fixed Phase 5 agents will therefore remain
  authoritative in this repository and be installed into `~/.codex/agents/`;
  project-scoped `.codex/agents/` is unsuitable when channel workspaces differ.
- Added `package.json`, `package-lock.json`, `tsconfig.json`, `.nvmrc`, and
  `.gitignore`. Runtime dependencies remain empty; TypeScript and Node types are
  development-only. No OpenCode package or runtime was added.
- Checks passed: `npm run protocol:generate`, `npm run typecheck`,
  `npm run spike`, `npm audit`, `codex --version`, and `codex login status`.
  The spike cleaned up its temporary agent, workspaces, and Codex threads.
- This directory is not yet a Git repository, so no commit was possible or
  attempted. The generated sources are present for the repository's eventual
  initial commit.

## Phase 1: Daemon and Database Foundation

**Status:** DONE

**Goal:** Establish the smallest runnable local daemon, Discord connection, and
database.

**Work:**

- Use Node.js 24 LTS, TypeScript strict mode, npm, and `discord.js`.
- Add Docker Compose for a pinned PostgreSQL/pgvector image bound only to
  localhost.
- Add ordered SQL migrations and a minimal migration command.
- Create the `channels`, `messages`, `approvals`, and `action_log` tables.
- Load the Discord bot token from Keychain or a local ignored development secret.
- Connect to Discord and reject every guild, user, and channel not explicitly
  allowed by configuration.
- Add a `/gaia status` command that checks the daemon, database, Discord, and
  Codex process.
- Add local development and test commands to the README.

**Acceptance:**

- One documented command starts PostgreSQL and the local daemon.
- Migrations run repeatedly without corrupting state.
- GAIA appears online in the private Discord server.
- Messages from unauthorized users, guilds, channels, bots, and webhooks are
  ignored.
- `/gaia status` reports actionable failures without exposing secrets.
- No inbound network port is opened.

**Implementation record (2026-09-06):**

- Added the Node 24 daemon using `discord.js` and `pg`, with graceful SIGINT and
  SIGTERM shutdown and one documented `npm run dev` startup command.
- Added a pinned PostgreSQL/pgvector Compose service exposed only on
  `127.0.0.1:5432`, ordered SQL migrations, advisory-lock serialization, and the
  `channels`, `messages`, `approvals`, and `action_log` foundation tables.
- Added fail-closed Discord authorization for the configured owner, guild, and
  channels, including explicit bot and webhook rejection. Focused tests exercise
  every rejected source because the private server intentionally has no second
  user account for a live unauthorized-user check.
- Added `/gaia status` for database, Discord gateway, Codex installation, and
  ChatGPT authentication health. The live private-server response reported all
  checks `OK`; a persistent Codex app-server process remains correctly deferred
  to the Phase 2 protocol wrapper.
- Created and installed the private GAIA Discord application and server. Public
  bot installation is disabled with no default public install link, Message
  Content is the only privileged intent, Administrator was not granted, and the
  install uses only the documented bot permissions plus the `bot` and
  `applications.commands` scopes.
- Stored the bot token only in macOS Keychain under service
  `gaia.discord.bot-token`; the ignored local `.env` contains only Discord IDs
  and the local database URL. No token was printed or written to the repository.
- Checks passed: `npm run dev`, repeated migrations, `npm run typecheck`,
  `npm test`, `npm run test:db`, `npm audit`, `docker compose config --quiet`,
  live `/gaia status`, graceful shutdown, and an application-listener check.
  PostgreSQL is healthy on loopback and the Node daemon opens no listening port.
- Authorized natural-language messages deliberately remain a no-op until the
  Phase 2 persistent chat slice. This directory is still not a Git repository,
  so no commit was possible or attempted.
- Browser network diagnostics used while resolving Discord's rejected private
  setting exposed the human Discord web-session authorization header in the tool
  transcript. The GAIA bot token was not exposed. The owner was advised to
  change the Discord password and revoke sessions but explicitly deferred it;
  treat that account session as compromised until rotation is completed.

## Phase 2: Persistent Discord Chat Vertical Slice

**Status:** DONE

**Goal:** Hold a real, persistent conversation with GAIA through Discord.

**Work:**

- Wrap the Codex app-server stdio process with request correlation, event
  handling, clean shutdown, and restart behavior.
- Map each allowed Discord channel ID to a resumable Codex thread.
- Persist user-visible messages and turn identifiers.
- Show typing state and update a placeholder response at a rate that respects
  Discord limits, then send a correctly split final response.
- Queue turns sequentially per channel and cap global concurrency.
- Add `/gaia new`, `/gaia stop`, and retry behavior.
- Render long text, Markdown, code blocks, errors, and interrupted turns safely.

**Acceptance:**

- The owner can hold independent conversations in two allowed Discord channels.
- Restarting the daemon preserves channel mappings and conversation history.
- A channel resumes the correct Codex thread.
- Progress appears without triggering Discord rate-limit errors.
- `/gaia stop` cancels an active turn without damaging later turns.
- Messages from one channel cannot be written into another.

**Implementation record (2026-09-06):**

- Added `src/codex.ts`, a typed persistent app-server client with JSONL request
  correlation, streamed turn collection, interruption, clean shutdown, and
  automatic process restart on the next request. Unimplemented approvals fail
  closed, and chat remains read-only until Phase 4 enrolls workspaces.
- Bound each Discord channel to its own durable Codex thread and persisted
  owner/GAIA messages plus Codex turn IDs. Duplicate Discord message IDs are
  ignored, turns serialize within a channel, and two channels may run globally
  in parallel.
- Added throttled placeholder edits and typing refreshes, safe Discord message
  splitting with continued backtick or tilde code fences, visible interruption
  and failure states, and bounded retries for idempotent Discord operations.
- Added `/gaia new` and `/gaia stop`; extended `/gaia status` to report the live
  app-server. Added the `work` text channel to the private Discord server and
  its ID to the ignored local `.env` so two-channel behavior could be exercised.
- Live checks in `generale` and `work` proved concurrent independent turns,
  distinct ORCHID/COBALT context, correct resume after daemon restart, visible
  progress without rate-limit errors, cancellation of a five-minute sleep,
  a successful turn after cancellation, `/gaia new`, and app-server recovery
  after its child process was terminated. The daemon remains running under
  Node `24.8.0`.
- Added focused tests for queue isolation/concurrency, Unicode and fenced
  Markdown splitting, repeatable persistence, duplicate suppression, and turn
  mapping. Checks passed under Node `24.8.0`: `npm run typecheck`, `npm test`,
  `npm run test:db`, `npm audit`, `docker compose config --quiet`, live daemon
  startup/restart, and the Discord checks above.
- Files changed: `src/codex.ts`, `src/db.ts`, `src/discord.ts`, `src/index.ts`,
  `tests/discord.test.ts`, `tests/db.integration.ts`, `README.md`, the ignored
  `.env`, and this plan. This directory is still not a Git repository, so no
  commit was possible or attempted.

## Phase 3: Discord Transport Hardening

**Status:** DONE

**Goal:** Make the free Discord transport safe and reliable on desktop and mobile.

**Work:**

- Document creation of a private Discord application, server, bot, and dedicated
  GAIA channel category.
- Enable only the required Message Content intent and bot permissions.
- Register control commands and keep ordinary conversation mention-free inside
  allowed GAIA channels.
- Handle Discord disconnects, reconnects, duplicate events, rate limits, and
  transient API failures.
- Split long responses and preserve Markdown code fences.
- Validate attachment type and size, download required files to an isolated
  temporary directory, and clean them after use.
- Document the free 10 MB attachment limit and avoid requiring Nitro.

**Acceptance:**

- The owner can use GAIA from the official Discord desktop and mobile clients.
- The bot has no Administrator permission and cannot see unrelated channels.
- Reconnects do not duplicate prompts or responses.
- Long responses remain readable and valid Markdown.
- Oversized or unsafe attachments fail with a clear message.
- No inbound network port or paid Discord feature is required.

**Implementation record (2026-09-06):**

- Hardened message creation with Discord nonces so transient retries are
  idempotent, suppressed all generated mentions, logged Gateway disconnect,
  reconnect, resume, and REST rate-limit events without request data, and kept
  database message IDs as the replay deduplication boundary.
- Added Discord-CDN-only attachment handling with manual redirect rejection,
  download timeouts, streamed size enforcement, MIME/header checks, image magic
  signatures, UTF-8 and JSON validation, generated filenames, mode `0600`, and
  guaranteed temporary-directory cleanup. Images use Discord's free 10 MiB
  ceiling; text, Markdown, CSV, and JSON use a 256 KiB model-context ceiling.
- Isolated conversation threads in a dedicated temporary working directory,
  allowlisted the Codex child environment, enumerated and disabled every
  configured MCP server, and disabled shell, web, apps, hooks, browser,
  subagent, skill, and other local tools. Text attachments are injected as
  bounded untrusted data and images use native local-image input. Phase 4 will
  deliberately re-enable tools only inside enrolled workspaces and approvals.
- Added queue draining and repeated active-turn interruption during shutdown so
  attachment files are removed even when the daemon stops mid-turn. Separated
  turn failure rendering from final Discord delivery so a persistence failure
  cannot overwrite an already visible response.
- Expanded `README.md` with private application/server/category setup, the sole
  Message Content privileged intent, current least-privilege bot permissions,
  explicit category isolation, Keychain rotation guidance, mobile behavior,
  free-tier limits, and supported attachment types.
- Live Discord checks accepted and read a text attachment, accepted an image,
  rejected ZIP with a clear error, removed temporary files after normal and
  interrupted turns, and rendered the normal channel controls at a 390x844
  viewport. Forced and subsequent natural Gateway reconnects resumed with
  replayed events; the RECONNECT prompt and response remained exactly one row
  each. No Discord rate-limit errors occurred.
- Existing no-Administrator and category isolation settings remain in place.
  The Node daemon opens no listening socket and requires no Nitro or paid bot
  hosting. Its Codex child was verified not to inherit `GAIA_DISCORD_TOKEN`,
  `DATABASE_URL`, or `OPENAI_API_KEY`.
- Added focused attachment metadata/byte, context-size, Unicode, extended-fence,
  queue, authorization, duplicate, and persistence checks. Checks passed under
  Node `24.8.0`: `npm run typecheck`, `npm test`, `npm run test:db`, `npm audit`,
  `docker compose config --quiet`, listener inspection, secret-environment
  inspection, and the live checks above.
- Deliberate limits: image signatures are checked without adding decoder
  dependencies; add full decoders if malformed-image handling becomes a real
  issue. Nonce retries cover Discord REST failures without a durable outbox;
  add one with Phase 9 crash recovery if measured failures require it.
- Files changed: `src/codex.ts`, `src/db.ts`, `src/discord.ts`, `src/index.ts`,
  `tests/discord.test.ts`, `tests/db.integration.ts`, `README.md`, and this plan.
  This directory is still not a Git repository, so no commit was possible or
  attempted.

## Phase 4: Workspaces and Approvals

**Status:** DONE

**Goal:** Let GAIA act locally while preserving clear boundaries and human
control.

**Work:**

- Add workspace enrollment and channel-to-workspace mapping.
- Resolve and canonicalize paths before enrollment.
- Start turns with the correct `cwd`, sandbox, and approval policy.
- Convert Codex command, file-change, and permission requests into Discord
  approval components.
- Support approve once and deny; add narrow remembered approvals only if Codex
  exposes them safely.
- Add requesting agent, target, reason, and risk to every approval.
- Record decisions and important actions without storing secrets.
- Add user-visible Discord summaries or attachments for diffs and activity.

**Acceptance:**

- A channel can work inside one enrolled workspace.
- An attempt to reach outside it asks or fails safely.
- The owner can approve or deny a pending action from Discord desktop and mobile.
- Denial returns useful context to the requesting agent.
- HADES-class actions always require explicit confirmation.

**Implementation record (2026-09-06):**

- Added owner-only `/gaia workspace` and `/gaia unworkspace` controls. Enrollment
  resolves symlinks to an existing canonical directory, rejects the filesystem
  root, stores one workspace per channel, and starts fresh Codex context whenever
  the boundary changes so read-only settings cannot leak across modes.
- Unenrolled channels keep shell tools disabled and remain read-only. Enrolled
  channels use their canonical `cwd`, `workspace-write` sandbox, and Codex's
  stricter `untrusted` approval policy. A live probe found that `on-request`
  permitted an in-workspace `rm`; `untrusted` is therefore required to make the
  HADES confirmation boundary mechanical rather than prompt-dependent.
- Mapped current and legacy Codex command and file-change approvals plus current
  permission-profile requests to standard Discord buttons. Every prompt shows
  agent, action, target, reason, and risk; only the configured owner can approve
  once or deny, requests expire after ten minutes, and decisions are atomic.
- Added bounded command and file-change summaries. Approval and action records
  deliberately retain only categorical status/risk metadata, never commands,
  paths, diffs, file contents, or credentials. Remembered approvals were not
  added because the available generic session grants are broader than needed.
- Reused the existing `workspace_path`, `approvals`, and `action_log` schema, so
  no migration or dependency was added. Updated focused authorization,
  canonicalization, HADES classification, mapping, and idempotent-decision tests.
- Live Node 24 Codex checks proved no shell tool in an unenrolled thread, writes
  inside an enrolled workspace, safe failure outside it, approve and deny paths,
  file-change approval/activity, useful denial context, and explicit HADES
  gating. Live Discord checks in `work` enrolled this repository, approved one
  write, displayed its command summary, denied a HADES-class delete, and kept the
  target intact using Discord's desktop/mobile-native button components.
- Checks passed: Node `24.8.0` `npm run typecheck`, `npm test`, `npm run test:db`,
  `npm audit`, `docker compose config --quiet`, `git diff --check`, daemon restart,
  no Node listening socket, direct app-server acceptance probes, and the live
  Discord checks above. Files changed: `src/codex.ts`, `src/db.ts`,
  `src/discord.ts`, `tests/discord.test.ts`, `tests/db.integration.ts`,
  `README.md`, and this plan. The repository is now under Git; no commit was
  requested or made.

## Phase 5: GAIA and Named Agents

**Status:** DONE

**Goal:** Make GAIA a visible orchestrator with the fixed specialist roster.

**Work:**

- Define GAIA's runtime instructions separately from this build plan.
- Add the nine fixed Codex custom agent definitions under
  `config/codex/agents/` and install or load them using the Phase 0 decision.
- Give every specialist a narrow role and appropriate sandbox defaults.
- Instruct GAIA to delegate only when useful and to consolidate results.
- Map subagent lifecycle events to visible Discord status and final results.
- Add an application display name for one-off dynamic specialists.
- Cap concurrent subagents conservatively.

**Acceptance:**

- GAIA delegates suitable work to at least two different named specialists.
- Discord identifies which agent is working and what it returned.
- Subagent noise does not flood the primary conversation.
- A dynamic one-off specialist works without creating permanent configuration.
- HADES cannot perform a destructive operation without owner confirmation.

**Implementation record (2026-09-07):**

- Added GAIA's orchestration instructions in `src/agents.ts` and all nine scoped
  specialist TOMLs under `config/codex/agents/`. Startup installs identical,
  versioned definitions into `CODEX_HOME/agents` or `~/.codex/agents`; conflicting
  files and symlinks fail safely without overwriting user configuration.
- Enabled delegation only in enrolled workspace channels, preserving no-shell,
  no-delegation conversation-only channels. Set Codex's concurrency cap to two
  spawned threads per session (up to four across the two active channels).
  Fixed definitions disable nested delegation; role defaults never replace the
  parent's sandbox or strict `untrusted` approval boundary.
- Added both legacy collaboration and native child-lifecycle event handling,
  verified thread ancestry, fixed-role identities, and mythology-inspired
  application names for generic one-off workers. No permanent dynamic-agent
  configuration, database migration, or dependency was added.
- Routed child command/file/permission approvals to the correct owner's channel
  with the actual agent name. Kept child text, turn completion, and patch targets
  separate from the parent; guarded stale approvals and asynchronous ancestry
  lookups against collector replacement and cancellation. Cancellation checks
  terminal child state before releasing the channel, stopping the app-server
  if a child cannot be stopped safely.
- Added one throttled, edited Discord specialist status message with the latest
  six agents and bounded result excerpts; GAIA consolidates full findings.
  Specialist tool chatter remains categorical audit data. Final status content
  is persisted as a system message. Fixed a Discord nonce-length error found by
  the live check and retried child metadata reads that race spawn persistence.
- Kept configured MCP servers disabled using self-contained, transport-valid
  CLI overrides after standalone config loading rejected partial disabled
  entries. The user's Codex config and credentials were not changed.
- Live Codex checks passed with the default model and `gpt-5.5`: APOLLO and
  MINERVA returned actual named results, a generic worker returned a result,
  HADES deletion was denied and its temporary target survived, the runtime
  reported a cap of two, and conversation-only tools remained unavailable.
  Live Discord checks in `work` showed named/dynamic results in one status
  message, a HADES-labeled owner approval, useful denial, and an intact target.
- Checks passed under Node `24.8.0`: unit tests, database integration tests,
  typecheck, live `test:agents` checks, audit, Compose validation, and scoped
  whitespace checks. Unit regressions cover ancestry/channel isolation, stale
  approvals, reused child turns, terminal cancellation, result recovery,
  installation conflicts, and bounded Discord rendering.
- Deliberate limits: specialist delegation requires an enrolled workspace;
  narrow role defaults are not independent security compartments. Some models
  expose interruption but no close-agent tool; completed child histories remain
  in Codex, and the daemon verifies no child turn remains active at completion.
  Physical Discord mobile-app testing was not repeated; messages and approval
  buttons use the existing native Discord components.
- Files changed: `src/agents.ts`, `src/codex.ts`, `src/discord.ts`, nine agent
  TOMLs, `tests/agents.test.ts`, `tests/codex.test.ts`,
  `tests/agents.integration.ts`, `tests/discord.test.ts`, `package.json`,
  `README.md`, and this plan. No commit was requested or made; Phase 6 is next.

## Phase 6: Shared Memory

**Status:** DONE

**Goal:** Recall relevant information across channels without replaying all prior
messages.

**Work:**

- Add the `memories` table and PostgreSQL full-text indexes.
- Select and document a local multilingual embedding model and dimensions.
- Add pgvector columns and indexes after measuring the initial dataset shape.
- Embed new messages and memories asynchronously without a separate queue service.
- Add hybrid retrieval with compact source references.
- Add explicit remember, inspect, correct, and forget operations.
- Summarize long channels and keep summaries linked to their source range.
- Add retrieval limits so irrelevant history cannot dominate the prompt.

**Acceptance:**

- A fact stated in one channel can be recalled from another relevant channel.
- Exact names work through full-text search.
- Paraphrased concepts work through vector search.
- A Discord command or response can show where a recalled memory came from.
- Correcting or deleting a memory changes subsequent retrieval.
- Embeddings are produced locally without an OpenAI API key.

**Implementation record (2026-09-08):**

- Added generated `simple` full-text vectors and GIN indexes for visible messages
  and memories, plus source-linked explicit and extractive-summary memories. The
  initial database contained 52 visible messages, so pgvector uses exact cosine
  scans; no ANN index or vector framework was added.
- Selected `Xenova/paraphrase-multilingual-MiniLM-L12-v2` through pinned
  Transformers.js `3.8.1`, producing 384-dimensional normalized embeddings
  locally. The model name is configurable in one environment value, stored with
  every vector, and a changed model triggers background re-embedding rather than
  mixing vector spaces. A patched `sharp` override keeps the dependency audit
  clean without exposing image processing to memory content.
- Added startup backfill and serialized in-process asynchronous indexing with
  bounded retries and graceful shutdown draining. New owner and GAIA messages
  are embedded without a queue service; every 50 visible channel messages create
  a bounded extractive summary linked to the exact source message range.
- Added hybrid global retrieval with explicit memories weighted above summaries
  and messages, small recency signals, a five-result/6,000-character prompt cap,
  and current-message exclusion. Recalled data carries Discord channel and
  interaction/message references and is marked untrusted in both runtime
  instructions and the per-turn data envelope.
- Added owner-only `/gaia remember`, `/gaia memories`, `/gaia correct`, and
  `/gaia forget` controls. Corrections replace content and vectors atomically;
  deletion removes local memory while clearly leaving Discord history intact.
- Checks passed under Node `24.8.0`: typecheck, 30 unit tests, three database
  integration tests, live local-model exact/semantic/source/correction/deletion
  and backfill checks, clean npm audit, Compose validation, whitespace checks,
  and daemon startup with all 52 existing visible messages backfilled. The daemon
  is running; no physical mobile-client pass was repeated because commands use
  the existing native Discord slash-command transport.
- Files changed: `src/memory.ts`, `src/discord.ts`, `src/index.ts`,
  `src/agents.ts`, migrations `002`-`005`, memory and database tests,
  `package.json`, `package-lock.json`, `tsconfig.json`, `.env.example`,
  `README.md`, and this plan. No commit was requested or made; Phase 7 is next.

## Phase 7: Conversation-Based Proactivity

**Status:** DONE

**Goal:** Let GAIA follow up without waiting for a new user message.

**Work:**

- Add the `followups` table and a GAIA-owned tool for recording follow-ups.
- Detect explicit dates, promises, unresolved questions, and stalled topics.
- Add a durable in-process scheduler that catches up after restart.
- Add complete, dismiss, and snooze actions.
- Configure timezone, daily digest time, and quiet hours.
- Generate one daily digest from open follow-ups and relevant conversation memory.
- Deliver reminders and digests in one configured Discord channel.
- Keep notification text concise and avoid sensitive details where possible.

**Acceptance:**

- GAIA can create a follow-up from a conversation and notify at the due time.
- Restarting the service does not lose or duplicate a due notification.
- The owner can complete, dismiss, and snooze from Discord.
- One daily digest is sent at the configured time, not during quiet hours.
- No email, calendar, GitHub, browser, or system-health polling occurs.

**Implementation record (2026-09-08):**

- Added durable source-linked follow-ups for explicit dates, promises, unresolved
  questions, and stalled topics. GAIA records them through Codex's pinned
  app-server dynamic-tool protocol; calls are accepted only from the active root
  turn, validated at the application boundary, and idempotent by tool call ID.
- Added an in-process PostgreSQL scheduler that checks overdue rows at startup
  and every 30 seconds, respects IANA timezone and overnight quiet-hour settings,
  retries failed delivery, and sends at most one non-empty digest per local day.
  Stable Discord nonces plus persisted notification timestamps prevent duplicate
  delivery during normal retries and restarts.
- Added concise reminders in one configured allowed Discord channel with
  owner-only Complete, Snooze 24h, and Dismiss buttons. The same durable actions
  are available through `/gaia followup`; snoozing safely wins a race with the
  scheduler's post-delivery update.
- Configured the ignored local environment for the first allowed channel at
  `08:30 Europe/Stockholm`, with quiet hours from `22:00` to `07:00`. The five
  proactive settings are required and fail startup validation rather than using
  invented defaults. `/gaia status` now reports scheduler health.
- Live Codex checks recorded correctly timezone-qualified examples of all four
  categories. A real overdue test reminder was delivered to Discord and then
  dismissed. Integration checks exercised due-time delivery, one daily digest,
  restart deduplication, idempotent recording, every owner action, and the
  delivery/snooze race; native Discord buttons reuse the already validated
  owner-only interaction transport.
- Checks passed under Node `24.8.0`: typecheck, 33 unit tests, four database
  integration tests, local embedding acceptance, clean npm audit, Compose
  validation, whitespace checks, migration state/cleanup checks, and repeated
  daemon startup. The daemon is running with migration `006` applied.
- Deliberate limits: digest entries are concise conversation-derived follow-up
  records rather than broad memory excerpts. Delivery uses persisted state and
  Discord nonce idempotency, not a general durable outbox; add outbox
  reconciliation in Phase 9 if failures outside Discord's nonce window occur.
  Dynamic tools require the pinned experimental app-server capability, so this
  phase starts one fresh Codex context per existing channel while preserving
  Discord history and shared memory.
- Files changed for Phase 7: `src/scheduler.ts`, `src/codex.ts`, `src/discord.ts`,
  `src/index.ts`, `src/agents.ts`, migration `006`, scheduler/Codex/database tests,
  `.env.example`, the ignored `.env`, `README.md`, and this plan. No commit was
  requested or made; Phase 8 is next.

## Phase 8: Interactive Integrations

**Status:** DONE

**Goal:** Add the requested tools for user-initiated work without expanding
proactive monitoring.

**Work:**

- Verify local Git operations and the existing authenticated `gh` CLI through
  Codex.
- Add a local Playwright MCP server for browser automation.
- Create a Google Workspace desktop OAuth client and incremental consent flow.
- Add Gmail read/search and draft tools, then approval-gated send.
- Add Google Calendar read tools, then approval-gated mutations.
- Add Google Tasks read tools, then approval-gated mutations.
- Store refresh credentials in macOS Keychain.
- Treat all fetched external content as untrusted data.

**Acceptance:**

- GAIA can inspect a repository and GitHub state in an approved workspace.
- GAIA can navigate a page; form submission requires the configured approval.
- GAIA can summarize selected Gmail messages and create a draft without sending.
- Sending email requires explicit approval.
- GAIA can read Calendar and Tasks; mutations require explicit approval.
- No Google credential or message content appears in logs.

**Implementation record (2026-09-08):**

- Verified local Git `2.50.1` and the existing Keychain-authenticated `gh` CLI
  through an enrolled Codex workspace. A live read-only turn inspected repository
  state and reported the GitHub repository name and visibility through the normal
  command/network approval path; no duplicate GitHub client was added.
- Added pinned Playwright MCP `0.0.80` as GAIA's reserved local MCP server. It is
  available only in enrolled workspaces, runs headless with an isolated profile,
  writes artifacts under the system temporary directory, receives no GAIA or
  Google credentials, and leaves every unrelated user-configured MCP disabled.
- Routed Playwright's native MCP elicitation requests through the existing durable
  owner-only Discord approve-once flow. Requests are accepted only for the exact
  active root turn and validated tool metadata; prompts show safe operation and
  target detail while redacting form values, scripts, and dropped data. All
  browser writes require approval. Live navigation returned `Example Domain`;
  a form was filled after approval and its submit click was denied and blocked.
- Added native-fetch Gmail, Calendar, and Tasks dynamic tools without a Google SDK
  or integration framework. Reads and Gmail draft creation are automatic for an
  active owner turn. Gmail send and every Calendar/Tasks mutation require approval;
  external deletes are presented as HADES. Approval cannot outlive cancellation,
  completion, or collector replacement.
- Added a PKCE/state-protected Google Desktop OAuth login using a random loopback
  callback and system browser. The downloaded Desktop client, refresh token, and
  granted scopes are stored under `gaia.google.oauth` in macOS Keychain; access
  tokens remain memory-only and never enter Codex, Playwright, action records, or
  application logs. The user chose to retain the downloaded `client-secret.json`
  locally, and its exact filename is ignored by Git.
- Google Desktop clients do not support incremental authorization, despite the
  original work-item wording, so Gmail read/compose, Calendar events, and Tasks
  scopes are requested together and verified after consent. The user created the
  required Cloud client and enabled all three APIs. Live checks passed for Gmail
  search/read, unsent draft creation, owner-approved self-send, Calendar read and
  owner-approved create/update/delete, and Tasks read and owner-approved
  create/complete/delete. Temporary Calendar and Tasks records were removed.
- External API results are bounded and explicitly marked untrusted before model
  use. As required for useful summaries, selected results remain part of Codex's
  private conversation execution history; GAIA's database action log and process
  output contain no Google message content or credentials. No proactive external
  polling was added.
- Checks passed under Node `24.8.0`: typecheck, 37 unit tests, four database tests,
  local embedding acceptance, clean npm audit, Compose validation, and whitespace
  checks. Live checks covered Git/GitHub, browser navigation and denied submission,
  Google auth/status, all requested reads, Gmail draft/send, and reversible
  Calendar/Tasks mutations. Files changed for Phase 8: `.gitignore`,
  `src/integrations.ts`, `src/google-login.ts`, `src/codex.ts`, `src/discord.ts`,
  `src/index.ts`, `src/agents.ts`, integration/Codex tests, `package.json`,
  `package-lock.json`, `README.md`, and this plan. No commit was requested or made;
  Phase 9 is next.

## Phase 9: Local Operations and Recovery

**Status:** DONE

**Goal:** Make GAIA dependable for daily local use.

**Work:**

- Install the application as a per-user `launchd` service.
- Add structured local logs with rotation and secret redaction.
- Add database backup, restore, and retention commands.
- Add graceful shutdown for Discord work, Codex turns, and the database pool.
- Extend `/gaia status` with database, Codex auth, scheduler, integrations, and
  recent failures.
- Add focused tests for authorization, channel isolation, approval mapping,
  memory ranking, scheduler deduplication, and recovery.
- Have MINERVA perform a threat review and ARTEMIS run the acceptance suite.
- Document update and rollback procedures.

**Acceptance:**

- GAIA starts after user login and recovers from an application crash.
- The owner can diagnose an expired Codex or Google login through
  `/gaia status` and local logs.
- A database backup can be restored into a clean local database.
- Logs rotate and contain no known secrets.
- Required automated checks pass.
- The full product works without exposing any inbound public network interface.

**Implementation record (2026-09-08):**

- Added a generated owner-only per-user LaunchAgent pinned to Node `24.8.0`,
  absolute repository paths, and fixed system/Homebrew command paths. PostgreSQL
  now uses `restart: unless-stopped`; the installer starts it before bootstrap.
  A forced `SIGKILL` changed the daemon PID and launchd restarted GAIA after its
  ten-second throttle. The running daemon and PostgreSQL remain loopback-only,
  and the Node process has no listening TCP socket.
- Added standard-library JSONL logging under `~/Library/Logs/GAIA`, with 1 MiB
  rotation, five retained generations, persisted recent failures, bounded
  messages, and centralized secret redaction. Codex stderr now passes through
  this boundary. Existing records parsed as JSON and contained none of the
  configured secret values.
- Added owner-only PostgreSQL custom-format backup, retention, verification, and
  explicit destructive restore commands. Backups are atomically published only
  after completion; the newest 14 are retained. Restore verifies the dump in a
  clean temporary database, then refuses while either the LaunchAgent or any
  tagged GAIA database process is active. A real backup restored cleanly with all
  six migrations.
- Shutdown now stops scheduler delivery, denies outstanding approvals, interrupts
  and drains Discord turns while the gateway remains available, then closes
  memory, Codex, and PostgreSQL without one cleanup failure skipping the others.
  Startup expires stale approvals and enforces Codex CLI `0.153.4`.
- `/gaia status` now derives overall health from migrations, backup age, Discord,
  Codex, Playwright configuration, a real Google token refresh, scheduler health,
  and redacted recent failures. A live formatter check reported all components
  `OK`.
- Added focused log redaction/rotation, LaunchAgent, backup retention, stale
  approval recovery, and memory ranking checks. Existing authorization, channel
  isolation, approval mapping, scheduler deduplication, and recovery tests remain
  passing.
- MINERVA iteratively reviewed the diff and identified unsafe restore ordering,
  partial backup publication, incomplete redaction, incomplete daemon detection,
  an unscoped fixture mutation, and an unsafe temporary review harness. Production
  findings were fixed and the temporary harness was deleted. ARTEMIS inspected
  the scripts and passed 40 unit tests, four database tests, typecheck, Compose
  validation, and whitespace checks without modifying files.
- Checks passed under Node `24.8.0`: `npm test`, `npm run test:db`,
  `npm run test:memory`, `npm run typecheck`, `npm audit`, Compose and whitespace
  checks, Google refresh, structured-log and permission inspection, clean restore,
  forced crash restart, database process tagging, and listener inspection.
- Deliberate limit: Discord delivery still uses persisted state and stable nonces
  rather than a general durable outbox. Add reconciliation only after a measured
  failure outside Discord's nonce window. The user-deferred Discord web-session
  rotation remains recorded in Phase 1.
- Files changed: `src/logger.ts`, `src/operations.ts`, daemon services and focused
  tests, `package.json`, `compose.yaml`, `README.md`, and this plan. No commit was
  requested or made.

## Deferred Until Requested

- Proactive email, calendar, GitHub, browser, or machine-health monitoring
- Multiple users, roles, organizations, or shared channels
- Voice conversations
- A local web/PWA interface over Tailscale
- Native iOS, Android, or macOS applications beyond Discord's clients
- A publicly reachable endpoint
- Full end-to-end encryption implemented by GAIA
- Cloud workers that continue while the Mac sleeps
- Multiple model providers or direct OpenAI Platform API billing
- A visual workflow builder
- Autonomous purchases, account changes, deployments, or destructive maintenance

## Known Risks and Required Reassessment

| Risk | Response |
| --- | --- |
| Codex is optimized for software work | Phase 0 explicitly tests ordinary personal-assistant dialogue before commitment |
| Codex app-server protocol evolves | Pin Codex, generate matching protocol types, and add a startup compatibility check |
| ChatGPT subscription limits apply | Surface clear rate/auth errors; do not silently switch to API billing |
| Shared memory can surface private context in another channel | Keep source references, retrieve narrowly, and let the owner delete or correct memories |
| Mac sleep makes GAIA unavailable | Accepted for version 1; catch up durable follow-ups after restart |
| Discord retains messages and attachments | Treat Discord as a cloud copy; deleting local memory does not delete Discord history |
| Discord is not end-to-end encrypted | Do not use it for work data that employer policy forbids sending to Discord or OpenAI |
| Discord API limits or outages interrupt chat | Queue conservatively, throttle updates, retry transient failures, and show status clearly |
| A leaked bot token grants bot access | Keep it in Keychain, grant minimal permissions, and document immediate token rotation |
| Google Workspace may block unapproved OAuth apps | Request scopes incrementally and surface administrator approval as a setup blocker |
| Agents can be manipulated by external content | Treat external content as data and gate every consequential side effect |

## Definition of Done for Every Phase

A phase is only `DONE` when:

- Its acceptance criteria have been exercised.
- Relevant automated checks pass.
- New configuration is documented without committing secrets.
- Failures produce actionable user-facing or logged errors.
- This file contains the final phase status and a Progress Log entry.
- Deliberate shortcuts identify their ceiling and the condition for revisiting them.

## Progress Log

Append one row after each implementation session. Keep entries concise and do
not delete prior rows.

| Date | Phase | Status | Summary | Checks | Decisions or blockers |
| --- | --- | --- | --- | --- | --- |
| 2026-09-06 | Planning | DONE | Selected local PWA over Tailscale and official Codex app server over OpenCode/Discord | Official docs reviewed; local Codex ChatGPT login confirmed | Begin with Phase 0 |
| 2026-09-06 | Planning update | DONE | Replaced the local PWA with one free private Discord bot while keeping the daemon, database, and Codex runtime local | Discord and Tailscale pricing reviewed | Discord stores chat content; no Nitro or paid hosting required |
| 2026-09-06 | Phase 0 | DONE | Added a typed stdio app-server spike and generated protocol bindings; proved streaming, exact approval handling, workspace changes, restart/resume, coding and personal prompts, and one custom agent from two working directories | `npm run protocol:generate`; `npm run typecheck`; `npm run spike`; `npm audit`; Codex version/auth checks | ChatGPT OAuth now uses macOS Keychain; install versioned fixed agents into `~/.codex/agents/`; next is Phase 1; directory is not yet a Git repository |
| 2026-09-06 | Phase 1 | DONE | Added the local Discord daemon, fail-closed source authorization, Keychain token loading, live status command, pinned loopback-only pgvector service, schema, and repeatable migrations; created the private GAIA server and installed the least-privilege bot | `npm run dev`; `npm run typecheck`; `npm test`; `npm run test:db`; `npm audit`; Compose validation; live `/gaia status`; graceful shutdown and listener checks | Natural chat and persistent Codex app-server lifecycle begin in Phase 2; human Discord web-session token appeared in diagnostic output and the owner deferred rotation; directory is not yet a Git repository |
| 2026-09-06 | Phase 2 | DONE | Added persistent per-channel Codex chat, durable visible messages and turn IDs, throttled streaming, safe Markdown splitting, bounded queues, `/gaia new`, `/gaia stop`, and process recovery; added and configured the private `work` channel | Node 24 `npm run typecheck`; `npm test`; `npm run test:db`; `npm audit`; Compose validation; live two-channel concurrency/isolation, daemon resume, cancellation/recovery, `/gaia new`, and Codex child restart | Chat is read-only until Phase 4; idempotent Discord operations retry but message creation is not blindly retried; next is Phase 3; directory is not yet a Git repository |
| 2026-09-06 | Phase 3 | DONE | Hardened reconnects, nonce retries, mentions, Markdown, attachment validation/download/cleanup, shutdown draining, Codex environment and tool isolation, and private Discord setup documentation | Node 24 typecheck/unit/DB/audit/Compose checks; live text/image acceptance, ZIP rejection, forced Gateway resume with replay deduplication, shutdown cleanup, mobile viewport, secret-env and listener checks | Text context is capped at 256 KiB; image validation uses signatures; durable outbox remains Phase 9 territory; next is Phase 4; directory is not yet a Git repository |
| 2026-09-06 | Phase 4 | DONE | Added canonical per-channel workspace enrollment, isolated workspace/read-only thread settings, Discord approve-once/deny components for command/file/permission requests, HADES labeling, bounded activity summaries, and redacted idempotent audit records | Node 24 typecheck/unit/DB/audit/Compose/diff/listener checks; direct app-server workspace, outside-boundary, command/file approve-deny, and HADES probes; live Discord enrollment, approve, deny, and activity checks | Workspace changes start fresh context; strict `untrusted` replaced `on-request` after a live `rm` bypass; broad remembered approvals deferred; next is Phase 5 |
| 2026-09-07 | Phase 5 | DONE | Added GAIA runtime instructions, nine installed specialists, dynamic display names, bounded Discord status/results, child-aware approvals, isolated event routing, and terminal cancellation checks | Node 24 unit/DB/typecheck/audit/Compose/scoped diff checks; live default-model and gpt-5.5 delegation, dynamic worker, cap configuration, HADES denial and conversation-only checks; live Discord named results and HADES deny with target preservation | Delegation is workspace-only; two workers per session; no broad grants or new dependencies; some models have interruption but no close tool; next is Phase 6 |
| 2026-09-08 | Phase 6 | DONE | Added local multilingual message/memory embeddings, hybrid cross-channel retrieval, source-linked summaries, startup backfill, bounded prompt context, and explicit remember/inspect/correct/forget commands | Node 24 typecheck; 30 unit tests; three DB tests; live local-model exact, paraphrase, source, mutation, deletion, and backfill checks; clean audit; Compose/diff checks; daemon startup and 52-message backfill | Exact vector scans fit the initial dataset; vectors retain model identity; no ANN index, vector framework, queue service, or repeated physical mobile pass; next is Phase 7 |
| 2026-09-08 | Phase 7 | DONE | Added Codex-recorded conversation follow-ups, durable due scheduling and daily digests, timezone/quiet hours, one proactive Discord channel, and complete/snooze/dismiss controls | Node 24 typecheck; 33 unit and four DB tests; memory/audit/Compose/diff checks; live all-category dynamic-tool calls, real Discord reminder, migration, cleanup, and repeated daemon startup | Uses pinned experimental dynamic tools and one-time fresh Codex contexts; stable Discord nonces instead of a general outbox; digest stays limited to conversation-derived open loops; next is Phase 8 |
| 2026-09-08 | Phase 8 | DONE | Added approved Git/GitHub access, isolated local Playwright MCP, Keychain-backed Google Desktop OAuth, and Gmail/Calendar/Tasks read, draft, send, and mutation tools | Node 24 typecheck; 37 unit and four DB tests; memory/audit/Compose/diff checks; live GitHub, browser navigation/denied submit, Google reads, Gmail draft/self-send, and reversible Calendar/Tasks mutations | Desktop OAuth scopes are requested together because Google does not support incremental auth; all browser writes and external mutations use approve-once, deletes show HADES; no proactive polling; next is Phase 9 |
| 2026-09-08 | Phase 9 | DONE | Added launchd crash recovery, rotating redacted logs, verified database backup/restore/retention, stale-approval and shutdown recovery, pinned runtime checks, and deeper status | Node 24 typecheck; 40 unit and four DB tests; memory/audit/Compose/diff checks; clean restore, crash restart, Google refresh, log/permission/secret and listener checks; MINERVA and ARTEMIS | Version 1 complete; stable Discord nonces remain instead of a general outbox until measured failures require one |

## Authoritative References

- Codex SDK: <https://developers.openai.com/codex/sdk/>
- Codex app server: <https://developers.openai.com/codex/app-server/>
- Codex authentication: <https://developers.openai.com/codex/auth/>
- Codex subagents: <https://developers.openai.com/codex/agent-configuration/subagents/>
- Codex permissions: <https://developers.openai.com/codex/permission-modes/>
- Discord developer documentation: <https://discord.com/developers/docs/intro>
- Discord Nitro pricing: <https://discord.com/nitro>
