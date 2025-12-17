const { Client } = require('pg');
require('dotenv').config();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is required to run migrations');
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
