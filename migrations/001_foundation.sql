CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE channels (
  discord_channel_id text PRIMARY KEY CHECK (discord_channel_id ~ '^[0-9]+$'),
  name text NOT NULL,
  codex_thread_id text,
  workspace_path text,
  is_archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE messages (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  discord_message_id text UNIQUE,
  channel_id text NOT NULL REFERENCES channels (discord_channel_id),
  role text NOT NULL CHECK (role IN ('user', 'gaia', 'specialist', 'tool', 'system')),
  content text NOT NULL,
  codex_turn_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX messages_channel_created_idx ON messages (channel_id, created_at);

CREATE TABLE approvals (
  request_id text PRIMARY KEY,
  channel_id text REFERENCES channels (discord_channel_id),
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'denied', 'expired')),
  request jsonb NOT NULL,
  decision jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  decided_at timestamptz
);

CREATE TABLE action_log (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  channel_id text REFERENCES channels (discord_channel_id),
  agent text NOT NULL,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX action_log_created_idx ON action_log (created_at);
