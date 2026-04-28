const { Client } = require('pg');
require('dotenv').config();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required to reset the database');
  process.exit(1);
}

const ssl =
  process.env.DATABASE_SSL && process.env.DATABASE_SSL !== 'false'
    ? { rejectUnauthorized: false }
    : false;

(async () => {
  const client = new Client({
    connectionString: databaseUrl,
    ssl,
  });
  await client.connect();

  try {
    const knownTables = [
      'winners',
      'participants',
      'pools',
      'templates',
      'tokens',
      'indexer_state',
      'relayer_state',
    ];

    const { rows } = await client.query(
      `SELECT tablename
       FROM pg_catalog.pg_tables
       WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
      [knownTables]
    );
    const existing = rows.map((r) => r.tablename);

    if (existing.length === 0) {
      console.log('No PoolOrbit tables found. Nothing to reset.');
      return;
    }

    console.log('Resetting database tables (full wipe)...');
    console.log(`Tables: ${existing.join(', ')}`);

    await client.query('BEGIN');
    await client.query(
      `TRUNCATE TABLE ${existing.map((t) => `"${t}"`).join(', ')}
       RESTART IDENTITY CASCADE`
    );
    await client.query('COMMIT');

    console.log('Done. All pool history + state tables cleared.');
    console.log('Restart the indexer to reimport from START_BLOCK.');
  } catch (err) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // ignore rollback errors
    }
    console.error('Reset failed:', err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})();
