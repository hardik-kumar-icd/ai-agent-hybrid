/**
 * Embedding Cache — small in-process LRU for OpenAI embedding API calls.
 *
 * Why this exists: every chat turn calls embeddings.embedQuery() which is
 * a network round-trip to OpenAI (~300-500ms). For repeat queries — common
 * customer questions like "åpningstider?" — that's wasted latency.
 *
 * What this is NOT:
 *  - Not a cross-process cache (each Node worker has its own copy). Fine
 *    for our PM2 single-fork setup. If we ever go cluster, switch to Redis.
 *  - Not an answer cache (final LLM answer is always regenerated fresh).
 *  - Not a retrieval cache (Pinecone query still runs every time).
 *
 * Sizing:
 *  - Max 100 entries: a typical FAQ-heavy chat session sees ~20-50 unique
 *    queries; 100 covers an active session comfortably.
 *  - 5-minute TTL: balances "rapid repeat queries are free" with "fresh
 *    embeddings if the embedding model is updated mid-deploy".
 *  - Each entry is ~12KB (3072-dim float32 vector) → 100 entries ≈ 1.2MB.
 *
 * Cache key:
 *  - Normalized query string: lowercased + whitespace-collapsed.
 *  - Two users typing "Hva er åpningstider?" and "hva er åpningstider"
 *    hit the same cache entry. Same intent, same embedding.
 */

const MAX_ENTRIES = 100;
const TTL_MS = 5 * 60 * 1000; // 5 minutes

// Map preserves insertion order, which we use for LRU eviction.
// Key: normalized query string
// Value: { vector: number[], expiresAt: number }
const cache = new Map();

let stats = {
  hits: 0,
  misses: 0,
  evictions: 0,
  expirations: 0,
};

/**
 * Normalize a query string for cache lookups.
 * Lowercase + collapse whitespace + trim.
 */
function normalize(query) {
  if (!query || typeof query !== 'string') return '';
  return query.toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Get a cached embedding if present and not expired.
 * Also bumps the entry to "most recently used" position.
 *
 * @param {string} query
 * @returns {number[] | null} The cached vector, or null on miss
 */
function getCachedEmbedding(query) {
  const key = normalize(query);
  if (!key) return null;

  const entry = cache.get(key);
  if (!entry) {
    stats.misses += 1;
    return null;
  }

  // Expired?
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    stats.expirations += 1;
    stats.misses += 1;
    return null;
  }

  // LRU bump: re-insert so it's at the "newest" end of the Map's iteration order
  cache.delete(key);
  cache.set(key, entry);

  stats.hits += 1;
  return entry.vector;
}

/**
 * Store an embedding in the cache. Evicts the oldest entry if full.
 *
 * @param {string} query
 * @param {number[]} vector
 */
function setCachedEmbedding(query, vector) {
  const key = normalize(query);
  if (!key || !Array.isArray(vector)) return;

  // Evict oldest if at capacity (and key not already present)
  if (cache.size >= MAX_ENTRIES && !cache.has(key)) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey) {
      cache.delete(oldestKey);
      stats.evictions += 1;
    }
  }

  cache.set(key, {
    vector,
    expiresAt: Date.now() + TTL_MS,
  });
}

/**
 * Diagnostics — exposed for admin endpoints / logging.
 */
function getCacheStats() {
  return {
    ...stats,
    size: cache.size,
    maxSize: MAX_ENTRIES,
    ttlMs: TTL_MS,
    hitRate: stats.hits + stats.misses > 0
      ? (stats.hits / (stats.hits + stats.misses) * 100).toFixed(1) + '%'
      : 'n/a',
  };
}

/**
 * Reset the cache (for tests or admin "clear cache" action).
 */
function clearCache() {
  cache.clear();
  stats = { hits: 0, misses: 0, evictions: 0, expirations: 0 };
}

module.exports = {
  getCachedEmbedding,
  setCachedEmbedding,
  getCacheStats,
  clearCache,
};
