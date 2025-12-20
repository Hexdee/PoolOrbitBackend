const express = require('express');
const db = require('../db');
const { parseLimit, parseOffset, fillPercentageSelect } = require('./helpers');

const router = express.Router();

router.get('/pools/historical', async (req, res, next) => {
  const limit = parseLimit(req.query.limit, 25, 200);
  const offset = parseOffset(req.query.offset);
  const status = req.query.status;
  const templateId = req.query.templateId
    ? Number.parseInt(req.query.templateId, 10)
    : undefined;
  const token = req.query.token;

  if (req.query.templateId && Number.isNaN(templateId)) {
    return res.status(400).json({ error: 'templateId must be a number' });
  }

  const whereParts = ['1=1'];
  const params = [];
  if (status === 'closed') {
    whereParts.push('p.closed = TRUE');
  } else if (status === 'active') {
    whereParts.push('p.closed = FALSE');
  }
  if (!Number.isNaN(templateId) && templateId !== undefined) {
    params.push(templateId);
    whereParts.push(`p.template_id = $${params.length}`);
  }
  if (token) {
    params.push(token.toLowerCase());
    whereParts.push(`LOWER(p.token_address) = $${params.length}`);
  }

  params.push(limit, offset);

  try {
    const { rows } = await db.query(
      `SELECT p.pool_id,
              p.template_id,
              p.deposited,
              p.total_entries,
              p.participant_count,
              p.closed,
              p.pool_size,
              p.entry_fee,
              p.jackpot_winner,
              p.jackpot_amount,
              p.block_time,
              p.closed_tx_hash,
              p.closed_block_number,
              p.closed_block_time,
              p.token_address,
              tok.decimals AS token_decimals,
              tok.symbol AS token_symbol,
              tok.logo_url AS token_logo,
              ${fillPercentageSelect} AS fill_percentage
       FROM pools p
       JOIN tokens tok ON tok.address = p.token_address
       WHERE ${whereParts.join(' AND ')}
       ORDER BY p.block_time DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

router.get('/pools/featured', async (req, res, next) => {
  const limit = parseLimit(req.query.limit, 3, 50);
  const token = req.query.token;
  const whereParts = ['p.closed = FALSE'];
  const params = [];

  if (token) {
    params.push(token.toLowerCase());
    whereParts.push(`LOWER(p.token_address) = $${params.length}`);
  }

  params.push(limit);

  try {
    const { rows } = await db.query(
      `SELECT p.pool_id,
              p.template_id,
              p.deposited,
              p.total_entries,
              p.participant_count,
              p.closed,
              p.pool_size,
              p.entry_fee,
              p.jackpot_winner,
              p.jackpot_amount,
              p.block_time,
              p.token_address,
              tok.decimals AS token_decimals,
              tok.symbol AS token_symbol,
              tok.logo_url AS token_logo,
              ${fillPercentageSelect} AS fill_percentage
       FROM pools p
       JOIN tokens tok ON tok.address = p.token_address
       WHERE ${whereParts.join(' AND ')}
       ORDER BY fill_percentage DESC, p.block_time DESC
       LIMIT $${params.length}`,
      params
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

router.get('/pools/user/:address', async (req, res, next) => {
  const user = req.params.address;
  const limit = parseLimit(req.query.limit, 25, 200);
  const offset = parseOffset(req.query.offset);
  const status = req.query.status;

  const whereParts = ['1=1'];
  const params = [user];
  if (status === 'closed') {
    whereParts.push('p.closed = TRUE');
  } else if (status === 'active') {
    whereParts.push('p.closed = FALSE');
  }

  params.push(limit, offset);

  try {
    const { rows } = await db.query(
      `SELECT p.pool_id,
              p.template_id,
              p.deposited,
              p.total_entries,
              p.participant_count,
              p.closed,
              p.pool_size,
              p.entry_fee,
              p.jackpot_winner,
              p.jackpot_amount,
              p.block_time,
              p.created_tx_hash,
              p.created_block_number,
              p.created_block_time,
              p.token_address,
              tok.decimals AS token_decimals,
              tok.symbol AS token_symbol,
              tok.logo_url AS token_logo,
              SUM(part.amount) AS user_amount,
              SUM(part.entries) AS user_entries,
              ${fillPercentageSelect} AS fill_percentage
       FROM participants part
       JOIN pools p ON p.pool_id = part.pool_id
       JOIN tokens tok ON tok.address = p.token_address
       WHERE ${whereParts.join(' AND ')}
       GROUP BY p.pool_id, p.template_id, p.deposited, p.total_entries, p.participant_count,
                p.closed, p.pool_size, p.entry_fee, p.jackpot_winner, p.jackpot_amount,
                p.block_time, p.token_address, tok.decimals, tok.symbol, tok.logo_url
       ORDER BY p.block_time DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

// Detailed user pool history in a single query for My Pool History page
router.get('/pools/user/:address/history', async (req, res, next) => {
  const user = req.params.address;
  const limit = parseLimit(req.query.limit, 25, 200);
  const offset = parseOffset(req.query.offset);
  const status = req.query.status;

  const whereParts = ['LOWER(part.participant_address) = LOWER($1)'];
  const params = [user];
  if (status === 'closed') {
    whereParts.push('p.closed = TRUE');
  } else if (status === 'active') {
    whereParts.push('p.closed = FALSE');
  }

  params.push(limit, offset);

  try {
    const { rows } = await db.query(
      `WITH user_participation AS (
         SELECT part.pool_id,
                SUM(part.amount) AS user_amount,
                SUM(part.entries) AS user_entries,
                ARRAY_AGG(part.tx_hash ORDER BY part.block_number DESC NULLS LAST, part.log_index DESC NULLS LAST) AS tx_hashes
         FROM participants part
         WHERE LOWER(part.participant_address) = LOWER($1)
         GROUP BY part.pool_id
       ),
       user_wins AS (
         SELECT w.pool_id,
                SUM(w.amount) AS win_amount
         FROM winners w
         WHERE LOWER(w.winner_address) = LOWER($1)
           AND (w.prize_type IN ('jackpot', 'consolation') OR w.prize_type IS NULL)
         GROUP BY w.pool_id
       )
       SELECT p.pool_id,
              p.template_id,
              p.deposited,
              p.total_entries,
              p.participant_count,
              p.closed,
              p.pool_size,
              p.entry_fee,
              p.jackpot_winner,
              p.jackpot_amount,
              p.block_time,
              p.created_tx_hash,
              p.created_block_number,
              p.created_block_time,
              p.closed_tx_hash,
              p.closed_block_number,
              p.closed_block_time,
              p.token_address,
              tok.decimals AS token_decimals,
              tok.symbol AS token_symbol,
              tok.logo_url AS token_logo,
              up.user_amount,
              up.user_entries,
              up.tx_hashes[1] AS user_last_tx_hash,
              uw.win_amount AS user_win_amount,
              ${fillPercentageSelect} AS fill_percentage
       FROM user_participation up
       JOIN pools p ON p.pool_id = up.pool_id
       JOIN tokens tok ON tok.address = p.token_address
       LEFT JOIN user_wins uw ON uw.pool_id = p.pool_id
       WHERE ${whereParts.join(' AND ')}
         AND EXISTS (
           SELECT 1 FROM participants part
           WHERE part.pool_id = p.pool_id
             AND LOWER(part.participant_address) = LOWER($1)
         )
       ORDER BY p.block_time DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

router.get('/winners/recent', async (req, res, next) => {
  const limit = parseLimit(req.query.limit, 10, 100);
  const token = req.query.token;
  const whereParts = ['wj.pool_id IS NOT NULL'];
  const params = [];

  if (token) {
    params.push(token.toLowerCase());
    whereParts.push(`LOWER(p.token_address) = $${params.length}`);
  }

  try {
    const { rows } = await db.query(
      `WITH consol AS (
         SELECT pool_id,
                json_agg(json_build_object('winner_address', winner_address, 'amount', amount)) AS consolation_winners
         FROM winners
         WHERE prize_type = 'consolation'
         GROUP BY pool_id
       ),
       wj AS (
         SELECT DISTINCT ON (pool_id) pool_id, winner_address, amount, tx_hash, block_number, block_time
         FROM winners
         WHERE prize_type = 'jackpot'
         ORDER BY pool_id, block_number DESC NULLS LAST, log_index DESC NULLS LAST
       )
       SELECT p.pool_id,
              wj.winner_address AS jackpot_winner,
              wj.amount AS jackpot_amount,
              COALESCE(wj.block_time, p.block_time) AS block_time,
              wj.block_number AS block_number,
              wj.tx_hash AS jackpot_tx_hash,
              p.pool_size,
              p.token_address,
              tok.decimals AS token_decimals,
              tok.symbol AS token_symbol,
              tok.logo_url AS token_logo,
              COALESCE(c.consolation_winners, '[]') AS consolation_winners
       FROM wj
       JOIN pools p ON p.pool_id = wj.pool_id
       JOIN tokens tok ON tok.address = p.token_address
       LEFT JOIN consol c ON c.pool_id = p.pool_id
       WHERE ${whereParts.join(' AND ')}
       ORDER BY COALESCE(wj.block_time, p.block_time) DESC
       LIMIT $${params.length + 1}`,
      [...params, limit]
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

router.get('/winners/jackpot', async (req, res, next) => {
  const token = req.query.token;

  try {
    if (token) {
      const { rows } = await db.query(
        `SELECT p.token_address,
                tok.symbol,
                tok.decimals,
                COALESCE(SUM(w.amount), 0) AS total_jackpot
         FROM winners w
         JOIN pools p ON p.pool_id = w.pool_id
         JOIN tokens tok ON tok.address = p.token_address
         WHERE w.prize_type = 'jackpot' AND LOWER(p.token_address) = LOWER($1)
         GROUP BY p.token_address, tok.symbol, tok.decimals`,
        [token]
      );
      return res.json({ data: rows[0] || null });
    }

    const { rows: perToken } = await db.query(
      `SELECT p.token_address,
              tok.symbol,
              tok.decimals,
              COALESCE(SUM(w.amount), 0) AS total_jackpot
       FROM winners w
       JOIN pools p ON p.pool_id = w.pool_id
       JOIN tokens tok ON tok.address = p.token_address
       WHERE w.prize_type = 'jackpot'
       GROUP BY p.token_address, tok.symbol, tok.decimals
       ORDER BY total_jackpot DESC`
    );
    const { rows: overall } = await db.query(
      `SELECT COALESCE(SUM(amount), 0) AS total_jackpot
       FROM winners
       WHERE prize_type = 'jackpot'`
    );

    res.json({
      data: {
        overall: overall[0]?.total_jackpot || 0,
        perToken,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
