-- 005_retrievals_drop_message_fk.sql
--
-- Drop 4-light v2 writes retrieval telemetry mid-turn (fire-and-forget via
-- setImmediate) from the agent, BEFORE telemetryService.logTurn writes the
-- assistant messages row at end-of-turn. The retrievals_message_id_fkey to
-- messages(id) therefore can never be satisfied at insert time under v2's
-- documented fire-and-forget model, so every insert failed and the table
-- stayed empty.
--
-- The message_id column + index are retained, and the same assistantMessageId
-- UUID still lands via logTurn, so `retrievals JOIN messages ON id = message_id`
-- keeps working — it's just no longer FK-enforced. Retention is unaffected:
-- retentionCleanup.js deletes by conversation, and retrievals.conversation_id
-- keeps its own ON DELETE CASCADE FK to conversations.
--
-- IF EXISTS makes this a safe no-op on the production DB where the constraint
-- was already dropped manually during the v2 debugging session.

ALTER TABLE IF EXISTS retrievals
  DROP CONSTRAINT IF EXISTS retrievals_message_id_fkey;
