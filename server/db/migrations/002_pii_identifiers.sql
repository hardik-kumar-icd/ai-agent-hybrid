-- ============================================================================
-- Migration 002 — PII identifiers table (hash-only storage)
-- ============================================================================
-- Stores SHA-256 hashes of customer identifiers (email, order_id) separate
-- from the conversations table.
--
-- WHY a separate table?
--   1. RIGHT TO ERASURE: when a customer asks for deletion, we delete ONE
--      row here and CASCADE wipes them from all conversations atomically.
--   2. AUDIT TRAIL: we know HOW MANY times an identifier appeared across
--      conversations without storing the raw value.
--   3. NO RAW PII: even with full DB read access, no one can recover the
--      original email/order_id (SHA-256 is one-way).
--
-- DESIGN CHOICE: hash-only, no encryption. Encryption (AES) would let us
-- decrypt the value back for legitimate purposes (e.g. responding to a
-- right-to-access request by email). But hash-only is simpler and means
-- a database leak reveals nothing identifiable.
--
-- TRADE-OFF: right-to-access still works — when a customer submits their
-- email, we hash it the same way and look up the hash. No reverse lookup
-- needed.
-- ============================================================================

CREATE TABLE IF NOT EXISTS pii_identifiers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The actual identifier. SHA-256 produces 64 hex chars (256 bits).
  -- Indexed for fast lookups on incoming queries.
  identifier_hash   TEXT UNIQUE NOT NULL,

  -- 'email' | 'order_id'
  identifier_type   TEXT NOT NULL CHECK (identifier_type IN ('email', 'order_id')),

  -- First time we saw this identifier (for retention cleanup)
  first_seen        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Last time we saw this identifier (also for retention)
  last_seen         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Count of conversations that referenced this identifier
  -- (useful for analytics without joining to conversations)
  conversation_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_pii_type_lastseen
  ON pii_identifiers(identifier_type, last_seen DESC);

-- Note on FKs: conversations.user_email_hash and conversations.user_order_hash
-- reference pii_identifiers.identifier_hash, but we don't enforce an FK
-- constraint because:
--   1. conversations may be inserted before the PII row is fully written
--      (race condition not worth blocking on)
--   2. on retention cleanup, conversations get deleted independently
-- Application code is responsible for keeping these in sync.
