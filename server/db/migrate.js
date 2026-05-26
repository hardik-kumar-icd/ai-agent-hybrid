#!/usr/bin/env node
/**
 * Simple migration runner. No external dependencies (uses pg only).
 *
 * USAGE:
 *   node server/db/migrate.js
 *
 * BEHAVIOR:
 *   - Reads all .sql files from server/db/migrations/ in alphabetical order
 *   - For each file, checks schema_migrations to see if it was already applied
 *   - Applies new migrations inside a transaction
 *   - Records each successful migration in schema_migrations
 *
 * Safe to run repeatedly — only NEW migrations execute.
 *
 * UPDATE: now auto-loads server/.env so DATABASE_URL doesn't have to be
 * manually exported before running. Matches the pattern used by other
 * scripts in the repo (e.g. scripts/ingestTickets.js).
 */

const path = require('path');
// Load env vars from server/.env (this file lives at server/db/migrate.js
// so .env is one directory up).
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const { getPool, getClient, query, close } = require('./index');

async function ensureMigrationsTable() {
  // The schema_migrations table is created by 001_initial.sql, but we
  // need it to exist BEFORE we try to read which migrations have been
  // applied. So create it explicitly here (idempotent).
  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
}

async function getAppliedMigrations() {
  const result = await query('SELECT version FROM schema_migrations ORDER BY version');
  if (!result) return new Set();
  return new Set(result.rows.map((r) => r.version));
}

async function applyMigration(client, version, sql) {
  console.log(`[migrate] Applying ${version}...`);
  try {
    await client.query('BEGIN');
    await client.query(sql);
    await client.query(
      'INSERT INTO schema_migrations (version) VALUES ($1) ON CONFLICT DO NOTHING',
      [version]
    );
    await client.query('COMMIT');
    console.log(`[migrate] ✓ ${version}`);
    return true;
  } catch (err) {
    await client.query('ROLLBACK');
    console.error(`[migrate] ✗ ${version} FAILED:`, err.message);
    return false;
  }
}

async function main() {
  const pool = getPool();
  if (!pool) {
    console.error('[migrate] DATABASE_URL is not set. Cannot run migrations.');
    console.error('[migrate] Check that server/.env contains DATABASE_URL=postgres://...');
    process.exit(1);
  }

  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();

  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  if (files.length === 0) {
    console.log('[migrate] No migration files found in', migrationsDir);
    await close();
    return;
  }

  const client = await getClient();
  if (!client) {
    console.error('[migrate] Could not acquire DB client');
    process.exit(1);
  }

  let appliedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  try {
    for (const file of files) {
      const version = file.replace(/\.sql$/, '');
      if (applied.has(version)) {
        console.log(`[migrate] skip ${version} (already applied)`);
        skippedCount += 1;
        continue;
      }

      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      const ok = await applyMigration(client, version, sql);
      if (ok) appliedCount += 1;
      else { failedCount += 1; break; }
    }
  } finally {
    client.release();
    await close();
  }

  console.log(`\n[migrate] Done. Applied: ${appliedCount}, Skipped: ${skippedCount}, Failed: ${failedCount}`);
  if (failedCount > 0) process.exit(1);
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[migrate] Unexpected error:', err);
    process.exit(1);
  });
}

module.exports = { main };
