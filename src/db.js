const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : undefined
});

pool.on('error', (err) => {
  // Surface unexpected errors so the process can be restarted by the host.
  console.error('Unexpected Postgres error', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool
};
