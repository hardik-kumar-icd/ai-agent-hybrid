/**
 * PII identifiers repository.
 *
 * Stores SHA-256 hashes of customer identifiers (email, order_id) separate
 * from the conversations table. Enables atomic right-to-erasure: delete the
 * hash row and all conversations referencing it become unfindable.
 *
 * Normalization rules (applied BEFORE hashing):
 *   - emails: lowercase + trim whitespace
 *   - order_id: uppercase + trim + strip leading '#'
 *
 * This means "Customer@Example.com" and "customer@example.com" hash to the
 * same value — important for right-to-access when the user might enter
 * their email in different casing.
 */

const crypto = require('crypto');
const { query } = require('../index');

/**
 * Normalize an identifier before hashing.
 */
function normalize(identifier, type) {
  if (!identifier || typeof identifier !== 'string') return null;
  let v = identifier.trim();
  if (!v) return null;
  if (type === 'email') return v.toLowerCase();
  if (type === 'order_id') return v.toUpperCase().replace(/^#+/, '');
  return v;
}

/**
 * Hash an identifier (deterministic — same input always yields same hash).
 * Returns 64-character hex string, or null if input is empty.
 */
function hashIdentifier(identifier, type) {
  const normalized = normalize(identifier, type);
  if (!normalized) return null;
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Record (upsert) an identifier observation.
 *
 * @param {string} identifier  - raw email or order_id
 * @param {string} type        - 'email' | 'order_id'
 * @returns {Promise<string|null>} the hash, or null
 */
async function recordIdentifier(identifier, type) {
  const hash = hashIdentifier(identifier, type);
  if (!hash) return null;

  await query(
    `INSERT INTO pii_identifiers (identifier_hash, identifier_type, conversation_count)
     VALUES ($1, $2, 1)
     ON CONFLICT (identifier_hash) DO UPDATE
       SET last_seen = NOW(),
           conversation_count = pii_identifiers.conversation_count + 1`,
    [hash, type]
  );

  return hash;
}

/**
 * Find a PII row by raw identifier (hashes it internally).
 * Used by the future right-to-access endpoint.
 */
async function findByIdentifier(identifier, type) {
  const hash = hashIdentifier(identifier, type);
  if (!hash) return null;

  const result = await query(
    'SELECT * FROM pii_identifiers WHERE identifier_hash = $1 AND identifier_type = $2',
    [hash, type]
  );
  return result?.rows?.[0] || null;
}

/**
 * Delete a PII identifier row by hash.
 * Used by retention cleanup + future right-to-erasure endpoint.
 *
 * Important: this does NOT cascade to conversations (no FK constraint).
 * Caller must also delete matching conversations separately if doing erasure.
 */
async function deleteByHash(hash) {
  if (!hash) return false;
  const result = await query(
    'DELETE FROM pii_identifiers WHERE identifier_hash = $1 RETURNING id',
    [hash]
  );
  return result?.rows?.length > 0;
}

module.exports = {
  hashIdentifier,
  recordIdentifier,
  findByIdentifier,
  deleteByHash,
  // exported for tests
  _internals: { normalize },
};
