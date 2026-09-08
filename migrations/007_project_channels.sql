-- Dynamic tools are fixed when a Codex thread starts. Preserve visible history
-- and shared memory while giving existing channels the project-creation tool.
UPDATE channels SET codex_thread_id = NULL, updated_at = now() WHERE codex_thread_id IS NOT NULL;
