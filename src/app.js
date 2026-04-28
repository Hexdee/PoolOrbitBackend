const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
const templatesRouter = require('./routes/templates');
const poolsRouter = require('./routes/pools');
const analyticsRouter = require('./routes/analytics');
const opsRouter = require('./routes/ops');

const app = express();

// Allow all origins and handle preflight explicitly; adjust if you need to restrict later.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, Authorization'
  );
  res.header(
    'Access-Control-Allow-Methods',
    'GET,POST,PUT,PATCH,DELETE,OPTIONS'
  );
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }
  next();
});
app.use(cors());
app.use(express.json());
app.use(morgan('dev'));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/templates', templatesRouter);
app.use('/pools', poolsRouter);
app.use('/analytics', analyticsRouter);
app.use('/ops', opsRouter);
if (process.env.ENABLE_FAUCET === 'true') {
  // Lazy-require so mainnet deployments don't need faucet env/config.
  // eslint-disable-next-line global-require
  const faucetRouter = require('./routes/faucet');
  app.use('/faucet', faucetRouter);
}

// Basic error handler to avoid leaking stack traces in responses.
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal Server Error' });
});

module.exports = app;
