#!/usr/bin/env node
/* eslint-disable no-console */

// Prune pools from the DB that should no longer be tracked:
// - "Legacy" non-active pools with zero deposits (not referenced by templates.active_pool_id)
// - Closed pools where the relayer has marked them as completed
//
// Usage:
//   cd backend
//   node scripts/prune-pools.js
//
// Notes:
// - participants/winners rows are removed automatically via ON DELETE CASCADE.

const { Client } = require('pg');
require('dotenv').config();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required to prune pools');
  process.exit(1);
}

const ssl =
  process.env.DATABASE_SSL && process.env.DATABASE_SSL !== 'false'
    ? { rejectUnauthorized: false }
    : false;

(async () => {
  const client = new Client({ connectionString: databaseUrl, ssl });
  await client.connect();

  try {
    await client.query('BEGIN');

    // 1) Delete completed closed pools (relayer_state last_action = completed)
    const completed = await client.query(
      `WITH to_delete AS (
         SELECT p.pool_id
         FROM pools p
         JOIN relayer_state r ON r.pool_id = p.pool_id
         WHERE p.closed = TRUE AND r.last_action = 'completed'
       )
       DELETE FROM pools p
       USING to_delete d
       WHERE p.pool_id = d.pool_id
       RETURNING p.pool_id`
    );
    const completedIds = completed.rows.map((r) => r.pool_id);

    // Cleanup relayer_state rows for pools that no longer exist
    await client.query(
      `DELETE FROM relayer_state r
       WHERE NOT EXISTS (SELECT 1 FROM pools p WHERE p.pool_id = r.pool_id)`
    );

    // 2) Delete legacy empty pools that are not the active pool for any template.
    //    We keep non-empty pools even if inactive (defensive).
    const legacy = await client.query(
      `WITH to_delete AS (
         SELECT p.pool_id
         FROM pools p
         LEFT JOIN templates t ON t.active_pool_id = p.pool_id AND t.active = TRUE
         WHERE p.closed = FALSE
           AND (p.deposited IS NULL OR p.deposited = 0)
           AND t.active_pool_id IS NULL
       )
       DELETE FROM pools p
       USING to_delete d
       WHERE p.pool_id = d.pool_id
       RETURNING p.pool_id`
    );
    const legacyIds = legacy.rows.map((r) => r.pool_id);

    await client.query('COMMIT');

    console.log('Prune complete.');
    console.log(`- Deleted completed pools: ${completedIds.length}`);
    if (completedIds.length) console.log(completedIds.join('\n'));
    console.log(`- Deleted legacy empty pools: ${legacyIds.length}`);
    if (legacyIds.length) console.log(legacyIds.join('\n'));
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore
    }
    console.error('Prune failed:', err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})();
