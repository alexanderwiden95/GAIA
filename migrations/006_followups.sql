CREATE TABLE followups (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  source_channel_id text NOT NULL REFERENCES channels (discord_channel_id),
  source_discord_id text NOT NULL,
  tool_call_id text NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('explicit_date', 'promise', 'unresolved_question', 'stalled_topic')),
  title text NOT NULL CHECK (length(title) BETWEEN 1 AND 240),
  due_at timestamptz,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed', 'dismissed')),
  notified_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX followups_due_idx ON followups (due_at) WHERE status = 'open' AND notified_at IS NULL;

CREATE TABLE proactive_digests (
  local_date date PRIMARY KEY,
  sent_at timestamptz NOT NULL DEFAULT now()
);

-- Dynamic tools are fixed when a Codex thread starts. Preserve visible history in
-- PostgreSQL/shared memory, but start one fresh Codex context after this upgrade.
UPDATE channels SET codex_thread_id = NULL, updated_at = now() WHERE codex_thread_id IS NOT NULL;
