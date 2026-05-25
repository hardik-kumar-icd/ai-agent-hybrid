/**
 * Postgres connection pool.
 *
 * Used by all repository modules. The pool is lazily created the first time
 * something queries — so if Postgres isn't configured (or is down), the rest
 * of the app still boots fine and telemetry just silently no-ops.
 *
 * Environment variables:
 *   DATABASE_URL    — Postgres connection string (required if you want telemetry)
 *                      Example: postgres://visor_app:PWD@localhost:5432/visor_agent
 *   DB_SSL          — 'true' to require TLS (default: false for localhost)
 *   DB_POOL_MAX     — max pool size (default: 10)
 *   DB_IDLE_MS      — idle connection timeout (default: 30000)
 *
 * The pool is exported so other modules can run transactions or raw queries
 * directly if needed. Most code should use the helper functions instead.
 */

const { Pool } = require('pg');

let pool = null;
let poolDisabled = false;

function getPool() {
  if (poolDisabled) return null;
  if (pool) return pool;

  if (!process.env.DATABASE_URL) {
    console.warn('[DB] DATABASE_URL not set — telemetry disabled');
    poolDisabled = true;
    return null;
  }

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    max: parseInt(process.env.DB_POOL_MAX || '10', 10),
    idleTimeoutMillis: parseInt(process.env.DB_IDLE_MS || '30000', 10),
    connectionTimeoutMillis: 5000,
  });

  pool.on('error', (err) => {
    // Don't crash the app on idle-connection errors
    console.error('[DB] Pool error (continuing):', err.message);
  });

  return pool;
}

/**
 * Run a parameterized query. Returns the QueryResult or null on error.
 * Never throws — telemetry should never block a chat response.
 */
async function query(text, params = []) {
  const p = getPool();
  if (!p) return null;
  try {
    return await p.query(text, params);
  } catch (err) {
    console.error('[DB] Query error:', err.message);
    console.error('[DB] SQL:', text.slice(0, 200));
    return null;
  }
}

/**
 * Get a dedicated client (for transactions).
 * Caller MUST release it: client.release().
 */
async function getClient() {
  const p = getPool();
  if (!p) return null;
  try {
    return await p.connect();
  } catch (err) {
    console.error('[DB] Failed to acquire client:', err.message);
    return null;
  }
}

/**
 * Healthcheck — returns true if a trivial query succeeds.
 */
async function healthCheck() {
  const result = await query('SELECT 1 as ok');
  return result?.rows?.[0]?.ok === 1;
}

/**
 * Shut down the pool cleanly (for tests / graceful exit).
 */
async function close() {
  if (!pool) return;
  try {
    await pool.end();
  } catch (_) { /* ignore */ }
  pool = null;
}

module.exports = {
  getPool,
  getClient,
  query,
  healthCheck,
  close,
};
