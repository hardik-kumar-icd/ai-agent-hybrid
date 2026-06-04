-- =============================================================================
-- Migration 003: message_feedback
-- =============================================================================
--
-- Drop 3 — Customer feedback collection (thumbs up/down + structured tags +
-- optional free-text comment) for the learning module.
--
-- Schema design choices:
--   - message_id is the PRIMARY KEY → one feedback per message, simple UPSERT
--   - No history table; latest edit overwrites prior feedback (per Visor's
--     decision: keep current state only, no edit history)
--   - tags stored as JSONB array, supports multi-select on thumbs-down
--   - rating CHECK constraint limits values to 'up'/'down'
--   - CASCADE deletes if message or conversation is removed
--
-- Foreign-key references match the existing pattern from messages table.
-- =============================================================================

CREATE TABLE message_feedback (
  message_id      UUID PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  conversation_id UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  rating          TEXT NOT NULL CHECK (rating IN ('up', 'down')),
  tags            JSONB,
  comment         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for browsing feedback by conversation (admin dashboard use case)
CREATE INDEX idx_message_feedback_conv
  ON message_feedback(conversation_id);

-- Index for aggregating feedback by rating (analytics: thumbs-down rate over time)
CREATE INDEX idx_message_feedback_rating
  ON message_feedback(rating);

-- Index for time-ordered listing (admin dashboard: newest first)
CREATE INDEX idx_message_feedback_created
  ON message_feedback(created_at DESC);

-- Index for finding thumbs-down feedback specifically (failure analysis is the
-- most common analytics query)
CREATE INDEX idx_message_feedback_down
  ON message_feedback(created_at DESC)
  WHERE rating = 'down';
