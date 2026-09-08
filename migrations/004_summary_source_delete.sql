ALTER TABLE memories
  DROP CONSTRAINT memories_source_message_start_id_fkey,
  DROP CONSTRAINT memories_source_message_end_id_fkey,
  ADD CONSTRAINT memories_source_message_start_id_fkey FOREIGN KEY (source_message_start_id) REFERENCES messages (id) ON DELETE CASCADE,
  ADD CONSTRAINT memories_source_message_end_id_fkey FOREIGN KEY (source_message_end_id) REFERENCES messages (id) ON DELETE CASCADE;
