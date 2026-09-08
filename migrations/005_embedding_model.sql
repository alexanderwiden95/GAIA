ALTER TABLE messages ADD COLUMN IF NOT EXISTS embedding_model text;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS embedding_model text;
