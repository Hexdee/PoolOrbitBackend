const express = require('express');
const db = require('../db');
const { parseLimit, parseOffset, fillPercentageSelect } = require('./helpers');

const router = express.Router();

router.get('/', async (req, res, next) => {
  const limit = parseLimit(req.query.limit, 50, 200);
  const offset = parseOffset(req.query.offset);
  const status = req.query.status;
  const token = req.query.token;
  const templateId = req.query.templateId ? Number.parseInt(req.query.templateId, 10) : undefined;

  if (req.query.templateId && Number.isNaN(templateId)) {
    return res.status(400).json({ error: 'templateId must be a number' });
  }

  const whereParts = ['1=1'];
  const params = [];
  if (status === 'closed') {
    whereParts.push('p.closed = TRUE');
  } else if (status === 'active' || !status) {
    // default to active pools if no status is provided
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
              p.token_address,
              p.created_tx_hash,
              p.created_block_number,
              p.created_block_time,
              p.closed_tx_hash,
              p.closed_block_number,
              p.closed_block_time,
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

router.get('/:poolId', async (req, res, next) => {
  const { poolId } = req.params;
  try {
    const { rows: poolRows } = await db.query(
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
              p.created_tx_hash,
              p.created_block_number,
              p.created_block_time,
              p.closed_tx_hash,
              p.closed_block_number,
              p.closed_block_time,
              tok.decimals AS token_decimals,
              tok.symbol AS token_symbol,
              tok.logo_url AS token_logo,
              ${fillPercentageSelect} AS fill_percentage
       FROM pools p
       JOIN tokens tok ON tok.address = p.token_address
       WHERE p.pool_id = $1
       LIMIT 1`,
      [poolId]
    );

    if (!poolRows.length) {
      return res.status(404).json({ error: 'Pool not found' });
    }

    const { rows: participants } = await db.query(
      `SELECT participant_address,
              amount,
              entries,
              tx_hash,
              block_number,
              block_time,
              created_at
       FROM participants
       WHERE pool_id = $1
       ORDER BY COALESCE(block_time, created_at) DESC`,
      [poolId]
    );

    const { rows: winners } = await db.query(
      `SELECT winner_address,
              amount,
              prize_type,
              tx_hash,
              block_number,
              block_time,
              created_at
       FROM winners
       WHERE pool_id = $1
       ORDER BY prize_type DESC, COALESCE(block_time, created_at) DESC`,
      [poolId]
    );

    res.json({
      pool: poolRows[0],
      participants,
      winners
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
