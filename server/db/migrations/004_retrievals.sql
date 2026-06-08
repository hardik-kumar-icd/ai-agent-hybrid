-- =============================================================================
-- Migration 004: retrievals
-- =============================================================================
--
-- Drop 4-light — retrieval telemetry. Every RAG search lookup writes one row
-- so admins can see WHAT was retrieved at WHAT confidence per message.
--
-- Designed for analytics use cases:
--   - Find low-confidence retrievals that became refusals (failure patterns)
--   - Per-source quality trends over time
--   - Correlation with downstream feedback (join via message_id)
--
-- Schema choices:
--   - One row per (message_id, source, query) — typically 1-3 rows per turn
--   - `top_match_text` capped to 500 chars to keep table small
--   - `passed_floor` partial index supports the common "find refusals" query
--   - CASCADE deletes match the existing convention (messages, feedback)
-- =============================================================================

CREATE TABLE retrievals (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id       UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id  UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source           TEXT NOT NULL,
  query            TEXT NOT NULL,
  top_match_id     TEXT,
  top_match_score  REAL,
  top_match_text   TEXT,
  result_count     INTEGER NOT NULL DEFAULT 0,
  floor            REAL,
  passed_floor     BOOLEAN NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Per-message lookup (for admin drill-down — show retrievals alongside the message)
CREATE INDEX idx_retrievals_message ON retrievals(message_id);

-- Per-conversation lookup
CREATE INDEX idx_retrievals_conv ON retrievals(conversation_id);

-- Source-score analytics (e.g., "show all visor_faqs queries below 0.55")
CREATE INDEX idx_retrievals_source_score ON retrievals(source, top_match_score);

-- Failure-pattern index: time-ordered list of refused retrievals
CREATE INDEX idx_retrievals_low_conf
  ON retrievals(created_at DESC)
  WHERE passed_floor = false;
