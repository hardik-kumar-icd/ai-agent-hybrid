-- 006_learned_qa.sql
--
-- Drop 2 (Episodic Memory) — Phase A: learned_qa storage.
--
-- Canonical store for validated Q&A pairs ("episodic memory"). A candidate is
-- created when an assistant answer receives a thumbs-up (promotion is wired in
-- Phase B). Candidates start as 'pending' and only become retrievable after an
-- admin approves them (approval-gated, per the Learning Approval design) — at
-- which point Phase C embeds the approved entry into the Pinecone 'learned_qa'
-- source using the SAME 3072-dim model as the rest of the KB.
--
-- question / answer are copied from the (already PII-redacted) messages rows,
-- so no further redaction is needed here.
--
-- source_message_id / source_conversation_id use ON DELETE SET NULL (NOT
-- cascade) so an approved, embedded learned answer survives retention purge of
-- the original conversation after PII_RETENTION_DAYS.

CREATE TABLE IF NOT EXISTS learned_qa (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  question               TEXT NOT NULL,
  answer                 TEXT NOT NULL,
  language               TEXT,                              -- 'nb' | 'en'
  status                 TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'approved', 'rejected')),
  source_message_id      UUID REFERENCES messages(id)      ON DELETE SET NULL,
  source_conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  embedding_id           TEXT,                              -- Pinecone vector id once embedded; NULL until live
  embedded_at            TIMESTAMPTZ,                       -- when pushed to Pinecone; NULL until live
  approved_by            TEXT,                              -- admin identifier (audit); NULL until approved
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One candidate per source message — makes promotion idempotent (UPSERT on a
-- repeated thumbs-up). NULLs are exempt, so retention-purged rows never clash.
CREATE UNIQUE INDEX IF NOT EXISTS uq_learned_qa_source_message
  ON learned_qa (source_message_id)
  WHERE source_message_id IS NOT NULL;

-- Serves both the approval queue (WHERE status = 'pending') and the Phase C
-- embed worker (WHERE status = 'approved' AND embedding_id IS NULL).
CREATE INDEX IF NOT EXISTS idx_learned_qa_status
  ON learned_qa (status, created_at DESC);
