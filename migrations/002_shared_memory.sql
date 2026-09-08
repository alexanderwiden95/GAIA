ALTER TABLE messages
  ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  ADD COLUMN embedding vector(384),
  ADD COLUMN embedding_model text,
  ADD COLUMN embedded_at timestamptz;

CREATE INDEX messages_search_idx ON messages USING gin (search_vector);

CREATE TABLE memories (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('explicit', 'summary')),
  content text NOT NULL,
  source_channel_id text NOT NULL REFERENCES channels (discord_channel_id) ON DELETE CASCADE,
  source_message_start_id bigint REFERENCES messages (id) ON DELETE CASCADE,
  source_message_end_id bigint REFERENCES messages (id) ON DELETE CASCADE,
  search_vector tsvector GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  embedding vector(384),
  embedding_model text,
  embedded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (source_message_start_id IS NULL OR source_message_end_id IS NOT NULL),
  CHECK (source_message_end_id IS NULL OR source_message_start_id IS NOT NULL)
);

CREATE INDEX memories_search_idx ON memories USING gin (search_vector);
CREATE INDEX memories_source_idx ON memories (source_channel_id, source_message_end_id);
