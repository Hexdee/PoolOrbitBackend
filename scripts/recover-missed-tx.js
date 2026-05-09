#!/usr/bin/env node
/* eslint-disable no-console */
require('dotenv').config();
const { Pool } = require('pg');
const { JsonRpcProvider } = require('ethers');
const { execSync } = require('child_process');

function parseArgs(argv) {
  const out = {
    tx: null,
    buffer: 50,
    restart: false,
    processName: 'poolorbit-indexer',
    rpc: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--tx') out.tx = argv[++i];
    else if (a === '--buffer') out.buffer = parseInt(argv[++i], 10);
    else if (a === '--restart') out.restart = true;
    else if (a === '--process') out.processName = argv[++i];
    else if (a === '--rpc') out.rpc = argv[++i];
  }
  return out;
}

async function main() {
  const { tx, buffer, restart, processName, rpc } = parseArgs(
    process.argv.slice(2),
  );
  if (!tx) {
    throw new Error(
      'Missing --tx <hash>. Example: node scripts/recover-missed-tx.js --tx 0xabc --buffer 100 --restart',
    );
  }
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is required');
  }
  const rpcUrl = rpc || process.env.RPC_URL;
  if (!rpcUrl) {
    throw new Error('RPC_URL is required');
  }
  if (!Number.isFinite(buffer) || buffer < 0) {
    throw new Error('--buffer must be a non-negative integer');
  }

  const provider = new JsonRpcProvider(rpcUrl);
  const receipt = await provider.getTransactionReceipt(tx);
  if (!receipt) {
    throw new Error(`Transaction receipt not found for ${tx}`);
  }

  const txBlock = Number(receipt.blockNumber);
  const rewindTo = Math.max(0, txBlock - 1 - buffer);

  const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl:
      process.env.DATABASE_SSL && process.env.DATABASE_SSL !== 'false'
        ? { rejectUnauthorized: false }
        : false,
  });

  try {
    await db.query(`
      CREATE TABLE IF NOT EXISTS indexer_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const prev = await db.query(
      `SELECT value FROM indexer_state WHERE key = 'last_block' LIMIT 1`,
    );
    const prevValue = prev.rows[0] ? Number(prev.rows[0].value) : null;

    await db.query(
      `INSERT INTO indexer_state (key, value, updated_at)
       VALUES ('last_block', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [String(rewindTo)],
    );

    console.log(`tx:        ${tx}`);
    console.log(`tx block:  ${txBlock}`);
    console.log(`buffer:    ${buffer}`);
    console.log(`rewindTo:  ${rewindTo}`);
    console.log(`previous checkpoint: ${prevValue === null ? 'none' : prevValue}`);
    console.log('Checkpoint updated.');
  } finally {
    await db.end();
  }

  if (restart) {
    try {
      execSync(`pm2 restart ${processName}`, { stdio: 'inherit' });
      console.log(`PM2 process restarted: ${processName}`);
    } catch (err) {
      console.error(
        `Failed to restart PM2 process "${processName}". Restart manually with: pm2 restart ${processName}`,
      );
      throw err;
    }
  } else {
    console.log(
      'Next step: restart indexer manually (e.g., pm2 restart poolorbit-indexer).',
    );
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
