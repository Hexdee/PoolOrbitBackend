#!/usr/bin/env node

/**
 * One-off helper to resync pool totals from participants.
 * Usage:
 *   node scripts/recompute-pool-totals.js           # fix all pools
 *   node scripts/recompute-pool-totals.js <poolId>  # fix a single pool
 */

require('dotenv').config();
const { Pool } = require('pg');

const poolId = process.argv[2] || null;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required');
  process.exit(1);
}

const ssl =
  process.env.DATABASE_SSL && process.env.DATABASE_SSL !== 'false'
    ? { rejectUnauthorized: false }
    : false;

const db = new Pool({
  connectionString: databaseUrl,
  ssl,
});

async function main() {
  try {
    console.log(
      poolId
        ? `Recomputing totals for pool ${poolId}...`
        : 'Recomputing totals for all pools...'
    );

    const res = await db.query(
      `
      WITH sums AS (
        SELECT
          pool_id,
          COALESCE(SUM(amount), 0)::numeric AS amt,
          COALESCE(SUM(entries), 0)::numeric AS ent
        FROM participants
        WHERE ($1::text IS NULL OR pool_id = $1)
        GROUP BY pool_id
      )
      UPDATE pools p
      SET
        deposited = s.amt,
        total_entries = s.ent,
        participant_count = (
          SELECT COUNT(DISTINCT participant_address)
          FROM participants pt
          WHERE pt.pool_id = p.pool_id
        )
      FROM sums s
      WHERE p.pool_id = s.pool_id
      RETURNING p.pool_id, p.deposited, p.total_entries, p.participant_count
      `,
      [poolId]
    );

    if (!res.rowCount) {
      console.log('No pools updated (check pool id or participant data).');
    } else {
      res.rows.forEach((row) => {
        console.log(
          `Updated ${row.pool_id}: deposited=${row.deposited} total_entries=${row.total_entries} participants=${row.participant_count}`
        );
      });
    }
  } finally {
    await db.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
