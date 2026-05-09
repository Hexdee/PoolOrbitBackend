#!/usr/bin/env node
/* eslint-disable no-console */
require('dotenv').config();
const db = require('../src/db');

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }

  const { rows } = await db.query(
    `SELECT
      p.pool_id,
      p.closed,
      p.template_id,
      p.deposited,
      p.pool_size,
      t.active AS template_active,
      t.active_pool_id,
      r.last_action,
      (
        (p.closed = FALSE AND t.active = TRUE AND t.active_pool_id = p.pool_id)
        OR
        (p.closed = TRUE AND (r.last_action IS NULL OR r.last_action <> 'completed'))
      ) AS is_monitored
    FROM pools p
    LEFT JOIN templates t ON t.template_id = p.template_id
    LEFT JOIN relayer_state r ON r.pool_id = p.pool_id
    ORDER BY
      is_monitored DESC,
      p.closed ASC,
      p.template_id ASC,
      p.pool_id ASC`,
  );

  const monitored = rows.filter((row) => row.is_monitored);

  console.log(`Total pools in DB: ${rows.length}`);
  console.log(`Monitored by indexer: ${monitored.length}`);
  console.log('');

  if (!monitored.length) {
    console.log('No monitored pools found.');
    return;
  }

  for (const row of monitored) {
    const mode =
      row.closed === false
        ? 'active-template-active-pool'
        : 'closed-not-completed';
    console.log(
      [
        `pool=${row.pool_id}`,
        `template=${row.template_id}`,
        `closed=${row.closed}`,
        `deposited=${row.deposited ?? 'null'}`,
        `size=${row.pool_size ?? 'null'}`,
        `templateActive=${row.template_active}`,
        `activePool=${row.active_pool_id ?? 'null'}`,
        `relayerLastAction=${row.last_action ?? 'null'}`,
        `reason=${mode}`,
      ].join(' | '),
    );
  }
}

main()
  .catch((err) => {
    console.error(err.message || err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await db.pool.end();
  });
