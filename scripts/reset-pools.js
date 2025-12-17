const { Client } = require('pg');
require('dotenv').config();

(async () => {
// Build PG config from env; supports DATABASE_URL or discrete PG* vars and optional SSL.
const makePgConfig = () => {
  const sslRequired =
    process.env.PGSSLMODE === 'require' ||
    process.env.PGSSL === 'true' ||
    (process.env.DATABASE_URL || '').includes('sslmode=require');

  if (process.env.DATABASE_URL) {
    return {
      connectionString: process.env.DATABASE_URL,
      ssl: sslRequired ? { rejectUnauthorized: false } : undefined,
    };
  }

  return {
    host: process.env.PGHOST || 'localhost',
    port: process.env.PGPORT ? Number(process.env.PGPORT) : 5432,
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD,
    database: process.env.PGDATABASE || 'poolorbit',
    ssl: sslRequired ? { rejectUnauthorized: false } : undefined,
  };
};

const client = new Client(makePgConfig());
  await client.connect();

  try {
    console.log('Deleting active pools...');
    console.log('Deleting pools...');
    await client.query(`DELETE FROM pools WHERE closed = false;`);
    console.log('Resetting indexer checkpoint...');
    await client.query(`DELETE FROM indexer_state WHERE key = 'last_block';`);
    console.log('Done. Restart the indexer to reimport pools.');
  } catch (err) {
    console.error('Reset failed:', err);
    process.exitCode = 1;
  } finally {
    await client.end();
  }
})();
