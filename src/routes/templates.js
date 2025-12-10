const express = require('express');
const db = require('../db');
const { parseLimit, parseOffset } = require('./helpers');

const router = express.Router();

router.get('/', async (req, res, next) => {
  const limit = parseLimit(req.query.limit, 100, 200);
  const offset = parseOffset(req.query.offset);

  try {
    const { rows } = await db.query(
      `SELECT t.template_id,
              t.token_address,
              t.pool_size,
              t.entry_fee,
              t.active,
              t.exists_in_contract,
              t.active_pool_id,
              t.created_tx_hash,
              t.created_block_number,
              t.created_block_time,
              tok.decimals AS token_decimals,
              tok.symbol AS token_symbol,
              tok.logo_url AS token_logo
       FROM templates t
       JOIN tokens tok ON tok.address = t.token_address
       ORDER BY t.template_id ASC
       LIMIT $1 OFFSET $2`,
      [limit, offset]
    );
    res.json({ data: rows });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
