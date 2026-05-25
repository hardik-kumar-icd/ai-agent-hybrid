-- ============================================================================
-- Migration 001 — Initial schema for telemetry + retrieval tracing
-- ============================================================================
-- Creates three core tables:
--   1. conversations   — one row per chat session (durable across page loads)
--   2. messages        — one row per turn (user OR assistant)
--   3. retrievals      — one row per KB chunk that helped answer a message
--
-- All identifiers are UUIDs. Foreign keys ON DELETE CASCADE so a deletion
-- request on a single conversation removes all its messages + retrievals
-- in one statement.
--
-- Indexes prioritize common admin queries: by conversation, by path, by date.
-- ============================================================================

-- Enable pgcrypto for gen_random_uuid()
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ---------------------------------------------------------------------------
-- conversations
-- ---------------------------------------------------------------------------
-- conversation_id is the public-facing UUID the widget sends in the
-- X-Conversation-Id header. This stays stable across the customer's session.
-- The internal id is what other tables reference.
CREATE TABLE IF NOT EXISTS conversations (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id   TEXT UNIQUE NOT NULL,        -- public ID from widget
  user_email_hash   TEXT,                        -- SHA-256, FK to pii_identifiers
  user_order_hash   TEXT,                        -- SHA-256, FK to pii_identifiers
  language          TEXT,                        -- 'nb' | 'en'
  user_agent        TEXT,
  ip_country        TEXT,                        -- ISO 3166-1 alpha-2 (no full IP stored)
  started_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_message_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  message_count     INTEGER NOT NULL DEFAULT 0,
  metadata          JSONB
);

CREATE INDEX IF NOT EXISTS idx_conversations_started_at
  ON conversations(started_at DESC);

CREATE INDEX IF NOT EXISTS idx_conversations_email_hash
  ON conversations(user_email_hash)
  WHERE user_email_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_order_hash
  ON conversations(user_order_hash)
  WHERE user_order_hash IS NOT NULL;

-- ---------------------------------------------------------------------------
-- messages
-- ---------------------------------------------------------------------------
-- One row per turn. role = 'user' for customer input, 'assistant' for replies.
-- content is ALREADY PII-redacted by the application layer before INSERT
-- (emails → [REDACTED_EMAIL], phones → [REDACTED_PHONE]).
CREATE TABLE IF NOT EXISTS messages (
  id                UUID PRIMARY KEY,            -- generated in app for SSE messageId
  conversation_id   UUID NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role              TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  content           TEXT NOT NULL,               -- PII-redacted before storage
  language          TEXT,
  path              TEXT,                        -- 'fast' | 'complex' | 'order' | NULL
  model             TEXT,                        -- e.g. 'gpt-4o-mini', 'gpt-4o'
  tool_calls        JSONB,                       -- list of tool names invoked
  embedding_cached  BOOLEAN,                     -- true if RAG search used cache
  latency_ms        INTEGER,
  token_count       INTEGER,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation
  ON messages(conversation_id);

CREATE INDEX IF NOT EXISTS idx_messages_created_at
  ON messages(created_at DESC);

CREATE INDEX IF NOT EXISTS idx_messages_path
  ON messages(path)
  WHERE path IS NOT NULL;

-- For "slow request" queries
CREATE INDEX IF NOT EXISTS idx_messages_slow
  ON messages(created_at DESC, latency_ms DESC)
  WHERE role = 'assistant' AND latency_ms > 5000;

-- ---------------------------------------------------------------------------
-- retrievals
-- ---------------------------------------------------------------------------
-- One row per chunk that was retrieved + presented to the model. Lets us
-- audit "what did the agent see when it answered this question?" — gold
-- for debugging hallucinations and identifying KB gaps.
CREATE TABLE IF NOT EXISTS retrievals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id        UUID NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  query             TEXT NOT NULL,
  chunk_id          TEXT,                        -- Pinecone chunk_id metadata
  source            TEXT,                        -- e.g. 'visor_faqs', 'products'
  score             NUMERIC(6,4),                -- cosine score, 4 decimals
  rank              INTEGER NOT NULL,            -- 1-based position in results
  text_preview      TEXT,                        -- first ~300 chars of chunk
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_retrievals_message
  ON retrievals(message_id);

CREATE INDEX IF NOT EXISTS idx_retrievals_source
  ON retrievals(source);

CREATE INDEX IF NOT EXISTS idx_retrievals_chunk
  ON retrievals(chunk_id)
  WHERE chunk_id IS NOT NULL;

-- ---------------------------------------------------------------------------
-- schema_migrations
-- ---------------------------------------------------------------------------
-- Tracks which migrations have run. Migration runner inserts a row after
-- each successful apply.
CREATE TABLE IF NOT EXISTS schema_migrations (
  version           TEXT PRIMARY KEY,
  applied_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
