/**
 * Order Lookup Guard
 *
 * Order status/details tools accept order_id + email straight from chat text
 * with no proof of ownership beyond "does the CMS record match" — so both
 * "fixed email, guess order_id" and "fixed order_id, guess email" enumeration
 * patterns are otherwise only bounded by the general per-IP chat rate limit.
 *
 * This tracks failed lookups per order_id and per email independently (either
 * key tripping the threshold locks that key) so a burst of guesses against
 * either axis gets locked out, without needing the caller's IP threaded
 * through the LLM tool-calling path.
 */

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const MAX_FAILURES = 5; // per key, within WINDOW_MS

const failures = new Map(); // key -> { count, windowStart, lockedUntil }

function normalizeKey(prefix, value) {
  return `${prefix}:${String(value || '').trim().toLowerCase()}`;
}

function keysFor(order_id, email) {
  const keys = [];
  if (order_id) keys.push(normalizeKey('order', order_id));
  if (email) keys.push(normalizeKey('email', email));
  return keys;
}

function isLocked(keys) {
  const now = Date.now();
  for (const key of keys) {
    const entry = failures.get(key);
    if (entry?.lockedUntil && now < entry.lockedUntil) {
      return true;
    }
  }
  return false;
}

function recordFailure(keys) {
  const now = Date.now();
  for (const key of keys) {
    let entry = failures.get(key);
    if (!entry || now - entry.windowStart > WINDOW_MS) {
      entry = { count: 0, windowStart: now, lockedUntil: null };
    }
    entry.count += 1;
    if (entry.count >= MAX_FAILURES) {
      entry.lockedUntil = now + LOCKOUT_MS;
    }
    failures.set(key, entry);
  }
}

function recordSuccess(keys) {
  for (const key of keys) failures.delete(key);
}

// Periodic cleanup so the Map doesn't grow unbounded under sustained abuse.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of failures.entries()) {
    const expiry = Math.max(entry.lockedUntil || 0, entry.windowStart + WINDOW_MS);
    if (now > expiry) failures.delete(key);
  }
}, 5 * 60 * 1000).unref();

module.exports = {
  keysFor,
  isLocked,
  recordFailure,
  recordSuccess,
};
