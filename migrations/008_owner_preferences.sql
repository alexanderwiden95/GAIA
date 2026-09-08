CREATE TABLE owner_preferences (
  key text PRIMARY KEY CHECK (key IN ('language', 'tone', 'response_length', 'formatting', 'progress_updates', 'workflow')),
  value text NOT NULL CHECK (length(btrim(value)) BETWEEN 1 AND 240),
  source_channel_id text NOT NULL REFERENCES channels (discord_channel_id),
  source_discord_id text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- New dynamic tools require fresh threads. Conversation history is preserved.
UPDATE channels SET codex_thread_id = NULL, updated_at = now() WHERE codex_thread_id IS NOT NULL;
