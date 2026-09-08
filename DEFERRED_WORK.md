# GAIA Deferred Work

This backlog contains work intentionally excluded from version 1. Implement one
item at a time only when requested or when its stated trigger is observed. Before
starting an item, inspect the current repository and `IMPLEMENTATION_PLAN.md`,
change its status to `IN PROGRESS`, define any missing product decisions, and add
an implementation record with checks before marking it `DONE`.

Status values: `DEFERRED`, `IN PROGRESS`, `BLOCKED`, `DONE`.

## Deferred Features

### Proactive external monitoring

**Status:** DEFERRED

**Scope:** Let GAIA proactively inspect selected Gmail, Calendar, GitHub, browser,
or Mac health sources instead of using them only during owner-initiated turns.

**Decide first:** Enable sources independently; define polling intervals, quiet
hours, notification channel, sensitive preview rules, and what creates a durable
follow-up. Start with one source rather than a general polling framework.

**Boundaries:** Treat fetched content as untrusted. Reads must use least-privilege
credentials. Existing approval rules still apply to every external mutation. Do
not log credentials or external content.

**Done when:** The selected source is polled durably without duplicate alerts,
resumes after restart, respects quiet hours, and can be disabled independently.

### Multiple users and shared spaces

**Status:** DEFERRED

**Scope:** Support more than one owner, including roles, organizations, or shared
channels.

**Decide first:** Define identity ownership, tenant boundaries, administrator
roles, channel membership, memory visibility, approval authority, and offboarding.
This changes the current single-owner security and data model and should not be
implemented as a small extension to the owner-ID allowlist.

**Boundaries:** Authorization must be enforced at every database, Discord,
memory, integration, and approval boundary. Cross-user memory must default to
private. Add migrations only after the access model is explicit.

**Done when:** Tests prove isolation between users and organizations, shared
channel behavior is explicit, and only authorized users can view data or approve
actions.

### Voice conversations

**Status:** DEFERRED

**Scope:** Add speech input and spoken responses while preserving the existing
conversation, memory, and approval model.

**Decide first:** Choose Discord voice or a separate local interface, push-to-talk
or continuous listening, transcription and synthesis providers, retention, and
cost limits.

**Boundaries:** Never record continuously without a clear active indicator.
Require visual confirmation for consequential actions; spoken consent alone must
not weaken HADES or external-mutation approvals.

**Done when:** The owner can start and stop recording, review the transcript,
receive a spoken response, and complete approval-required work safely.

### Local web or PWA interface over Tailscale

**Status:** DEFERRED

**Scope:** Provide a local browser interface as an alternative to Discord and
make it reachable only through an explicitly configured Tailscale network.

**Decide first:** Determine whether Discord history remains authoritative, how
threads synchronize, and whether the interface is local-only or bound to a
Tailscale address.

**Boundaries:** Do not expose a public listener. Add authentication and CSRF
protection even on a tailnet. Reuse the daemon's conversation and approval paths
rather than creating a second agent runtime.

**Done when:** Desktop and mobile browsers can chat and handle approvals over the
tailnet, unauthorized clients are rejected, and no public interface is exposed.

### Native applications

**Status:** DEFERRED

**Scope:** Add a native iOS, Android, or macOS client beyond Discord's official
applications.

**Trigger:** Implement only when Discord or a PWA has a measured limitation that
requires native capabilities such as system integrations, notifications, or
offline behavior.

**Boundaries:** Define a secure daemon transport and device enrollment before
building a client. Do not duplicate conversation, memory, or approval logic in
each application.

**Done when:** The selected client authenticates securely, preserves channel and
approval isolation, and solves the documented platform limitation.

### Publicly reachable endpoint

**Status:** DEFERRED

**Scope:** Allow access without Discord or Tailscale through an internet-facing
service.

**Decide first:** Document the concrete need, hosting location, identity provider,
abuse controls, rate limits, audit requirements, and incident response plan.

**Boundaries:** This reverses the version 1 no-inbound-port decision. Require TLS,
strong authentication, authorization, request limits, secret management, and an
independent security review before exposure.

**Done when:** External testing confirms authentication, tenant isolation if
applicable, rate limiting, safe failure behavior, monitoring, and no unintended
service exposure.

### GAIA-managed end-to-end encryption

**Status:** DEFERRED

**Scope:** Encrypt conversation content so transport and storage providers cannot
read plaintext. Discord is not end-to-end encrypted, so this likely requires a
different client and transport rather than a bot-only change.

**Decide first:** Define the threat model, trusted endpoints, key ownership,
device enrollment, recovery, search and memory behavior, metadata leakage, and
which inference services may receive plaintext.

**Boundaries:** Do not design custom cryptographic primitives. Use reviewed
protocols and libraries and obtain a specialist security review.

**Done when:** The documented threat model is met, key rotation and recovery work,
and independent review finds no plaintext leak through transport, logs, backups,
or provider storage outside the accepted boundary.

### Sleep-independent cloud workers

**Status:** DEFERRED

**Scope:** Continue selected scheduling or agent work while the owner's Mac is
asleep or offline.

**Decide first:** Choose which tasks may run remotely, what data may leave the
Mac, how state synchronizes, and how conflicts and duplicate delivery are handled.

**Boundaries:** Keep local-only data local unless explicitly approved. Use one
small worker for one measured need before introducing queues or distributed job
infrastructure.

**Done when:** Selected jobs run while the Mac is offline, synchronize exactly
once or idempotently, and recover cleanly from network partitions.

### Multiple model providers or API billing

**Status:** DEFERRED

**Scope:** Add another model provider or direct OpenAI Platform API billing in
addition to the current Codex ChatGPT OAuth runtime.

**Trigger:** Add a provider only for a documented capability, reliability, cost,
or quota gap. Do not build a generic provider abstraction speculatively.

**Boundaries:** Keep credentials in Keychain, expose provider and cost in status
and logs without leaking secrets, and never silently fall back to separately
billed API usage.

**Done when:** The owner explicitly selects the provider, billing is visible,
failure does not cause surprise spend, and existing security and approval
behavior remains intact.

### Visual workflow builder

**Status:** DEFERRED

**Scope:** Let the owner create and inspect repeatable GAIA workflows visually.

**Trigger:** First collect recurring workflows that cannot be represented clearly
as saved prompts or scheduled follow-ups. Build around one real workflow.

**Boundaries:** Generated workflows must use the same permission layer,
validation, action log, and HADES rules as direct conversations. Avoid a general
execution engine until the required workflow semantics are known.

**Done when:** One real workflow can be created, validated, run, inspected, and
stopped without bypassing approvals.

### Autonomous consequential actions

**Status:** DEFERRED

**Scope:** Allow purchases, account changes, deployments, or destructive
maintenance without per-action owner confirmation.

**Trigger:** Reassess only for a narrow, reversible, repeatedly approved action
with clear limits and a demonstrated need. Broad autonomy remains out of scope.

**Boundaries:** Define hard value and target limits, allowlists, idempotency,
rollback, audit records, revocation, and a kill switch. HADES operations should
remain explicitly confirmed unless the owner approves a narrowly specified policy
after security review.

**Done when:** Tests prove the action cannot exceed its policy, duplicate, or
continue after revocation, and recovery is verified with no data or financial
loss.

## Conditional Engineering Work

### Durable Discord outbox and reconciliation

**Status:** DEFERRED

**Trigger:** A measured delivery failure or duplicate occurs outside Discord's
nonce-idempotency window, or delivery guarantees become a product requirement.

**Scope:** Persist outgoing Discord operations and reconcile uncertain results
after restart. Do not introduce a general message broker unless the database
outbox is insufficient.

**Done when:** Crash tests around send and acknowledgement boundaries produce one
visible message and one durable result.

### pgvector approximate-nearest-neighbor index

**Status:** DEFERRED

**Trigger:** Memory row counts and measured query latency show exact cosine scans
no longer meet an agreed response-time target.

**Scope:** Add and tune the smallest suitable pgvector index for the existing
384-dimensional embeddings, then compare recall and latency against exact scans.

**Done when:** Benchmarks show a useful latency improvement with acceptable recall
and documented index maintenance behavior.

### Full image decoding and validation

**Status:** DEFERRED

**Trigger:** Malformed images bypass signature checks, cause downstream failures,
or become a recurring support issue.

**Scope:** Decode accepted PNG, JPEG, GIF, and WebP attachments with an existing
maintained dependency before passing them to Codex. Reject invalid dimensions,
resource bombs, and malformed content with a clear message.

**Done when:** Focused malformed-image and resource-limit tests fail safely and
valid images continue to work.

### Persistent or broader approvals

**Status:** DEFERRED

**Trigger:** Repeated approve-once prompts create a measured usability problem for
a narrow, non-destructive operation.

**Scope:** Remember only an exact, revocable operation pattern with explicit
target and expiry. Codex's broad session grants are not sufficient.

**Boundaries:** Never persist approval for HADES actions, communications,
authentication changes, purchases, force operations, or unconstrained commands.

**Done when:** The owner can inspect and revoke grants, scope cannot widen through
input variation, expiry is enforced, and audit records explain every automatic
approval.
