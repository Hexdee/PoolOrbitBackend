/* eslint-disable no-console */
require('dotenv').config();
const { ethers } = require('ethers');
const db = require('../db');

const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS;
const RPC_URL = process.env.RPC_URL;
const WS_RPC_URL = process.env.WS_RPC_URL;
const RELAYER_PK = process.env.RELAYER_PRIVATE_KEY;
const RELAYER_ENABLED = !!RELAYER_PK;
const RELAYER_INTERVAL_MS = process.env.RELAYER_INTERVAL_MS
  ? parseInt(process.env.RELAYER_INTERVAL_MS, 10)
  : 15000;
const RELAYER_FINALIZE_BATCH = process.env.RELAYER_FINALIZE_BATCH
  ? parseInt(process.env.RELAYER_FINALIZE_BATCH, 10)
  : 50;
const START_BLOCK = process.env.START_BLOCK
  ? parseInt(process.env.START_BLOCK, 10)
  : undefined;
const BATCH_SIZE = process.env.BATCH_SIZE
  ? parseInt(process.env.BATCH_SIZE, 10)
  : 500;
const FINALITY = process.env.FINALITY_CONFIRMATIONS
  ? parseInt(process.env.FINALITY_CONFIRMATIONS, 10)
  : 0;
const NEAR_HEAD_THRESHOLD = process.env.NEAR_HEAD_THRESHOLD
  ? parseInt(process.env.NEAR_HEAD_THRESHOLD, 10)
  : 2000;
const BLOCK_POLL_INTERVAL_MS = process.env.BLOCK_POLL_INTERVAL_MS
  ? parseInt(process.env.BLOCK_POLL_INTERVAL_MS, 10)
  : 5000;

if (!FACTORY_ADDRESS) {
  throw new Error('FACTORY_ADDRESS env is required for indexer');
}
if (!RPC_URL) {
  throw new Error('RPC_URL env is required for indexer');
}

// HTTP provider is always available (used for backfill and writes)
const httpProvider = new ethers.JsonRpcProvider(RPC_URL);
const writeProvider = httpProvider;
// WS provider is created/recreated below
let provider = WS_RPC_URL
  ? new ethers.WebSocketProvider(WS_RPC_URL)
  : httpProvider;
const relayerSigner = RELAYER_ENABLED
  ? new ethers.Wallet(RELAYER_PK, writeProvider)
  : null;

const factoryIface = new ethers.Interface([
  'event TemplateRegistered(uint256 indexed templateId, address pool)',
  'event TemplateStatusUpdated(uint256 indexed templateId, bool active)',
  'event PoolCreated(uint256 indexed templateId, address pool)',
]);

const poolIface = new ethers.Interface([
  'event TicketPurchased(address indexed account, uint256 amount, uint256 cumulativeEntries)',
  'event PoolClosed(uint256 jackpotAmount, uint256 consolationAmount, uint256 treasuryAmount)',
  'event PrizeClaimed(address indexed winner, uint256 indexed ticketNumber, uint8 rewardType, uint256 amount)',
]);

const erc20Iface = new ethers.Interface([
  'function symbol() view returns (string)',
  'function name() view returns (string)',
  'function decimals() view returns (uint8)',
]);

const factoryReadAbi = [
  'function getTemplate(uint256) view returns (tuple(address token,uint256 poolSize,uint256 entryFee,bool exists,bool active,address currentPool))',
];

const poolWriteAbi = [
  'function closed() view returns (bool)',
  'function randomSeedCount() view returns (uint8)',
  'function totalEntries() view returns (uint256)',
  'function winnersFinalized() view returns (bool)',
  'function jackpotPayed() view returns (bool)',
  'function consolationPayoutIndex() view returns (uint256)',
  'function generatedConsolationWinners() view returns (uint32)',
  'function consolationPrizeEach() view returns (uint256)',
  'function consolationWinnerBps() view returns (uint96)',
  'function finalizeWinners()',
  'function batchFinalizeWinners(uint256 iterations)',
  'function payJackpotWinner()',
  'function batchConsolationPayout(uint256 iterations)',
  'function sweepResidualToTreasury()',
];

const stateKey = 'last_block';

async function ensureStateTable() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS indexer_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS relayer_state (
      pool_id TEXT PRIMARY KEY,
      last_action TEXT,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
}

async function getCheckpoint() {
  const { rows } = await db.query(
    'SELECT value FROM indexer_state WHERE key = $1',
    [stateKey]
  );
  if (rows.length) return parseInt(rows[0].value, 10);
  if (START_BLOCK !== undefined) return START_BLOCK;
  throw new Error('No checkpoint found and START_BLOCK not set');
}

async function setCheckpoint(blockNumber) {
  await db.query(
    `INSERT INTO indexer_state (key, value, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [stateKey, String(blockNumber)]
  );
}

async function ensureToken(tokenAddress) {
  const { rows } = await db.query(
    'SELECT address FROM tokens WHERE LOWER(address) = LOWER($1)',
    [tokenAddress]
  );
  if (rows.length) return;
  try {
    const symbol = await provider
      .call({
        to: tokenAddress,
        data: erc20Iface.encodeFunctionData('symbol', []),
      })
      .then((data) => erc20Iface.decodeFunctionResult('symbol', data)[0])
      .catch(() => 'TKN');
    const name = await provider
      .call({
        to: tokenAddress,
        data: erc20Iface.encodeFunctionData('name', []),
      })
      .then((data) => erc20Iface.decodeFunctionResult('name', data)[0])
      .catch(() => 'Token');
    const decimals = await provider
      .call({
        to: tokenAddress,
        data: erc20Iface.encodeFunctionData('decimals', []),
      })
      .then((data) =>
        Number(erc20Iface.decodeFunctionResult('decimals', data)[0])
      )
      .catch(() => 18);
    await db.query(
      `INSERT INTO tokens (address, symbol, name, decimals)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (address) DO NOTHING`,
      [tokenAddress, symbol, name, decimals]
    );
  } catch (err) {
    console.warn(`Failed to fetch token metadata for ${tokenAddress}`, err);
  }
}

async function upsertTemplate(templateId, meta = {}) {
  const factory = new ethers.Contract(
    FACTORY_ADDRESS,
    factoryReadAbi,
    provider
  );
  const tpl = await factory.getTemplate(templateId);
  if (!tpl.exists) return;
  const tokenAddress = tpl.token;
  await ensureToken(tokenAddress);
  await db.query(
    `INSERT INTO templates (template_id, token_address, pool_size, entry_fee, active, exists_in_contract, active_pool_id, created_tx_hash, created_block_number, created_block_time)
     VALUES ($1, $2, $3, $4, $5, TRUE, $6, $7, $8, $9)
     ON CONFLICT (template_id) DO UPDATE
       SET token_address = EXCLUDED.token_address,
           pool_size = EXCLUDED.pool_size,
           entry_fee = EXCLUDED.entry_fee,
           active = EXCLUDED.active,
           exists_in_contract = TRUE,
           active_pool_id = EXCLUDED.active_pool_id,
           created_tx_hash = COALESCE(templates.created_tx_hash, EXCLUDED.created_tx_hash),
           created_block_number = COALESCE(templates.created_block_number, EXCLUDED.created_block_number),
           created_block_time = COALESCE(templates.created_block_time, EXCLUDED.created_block_time)`,
    [
      templateId,
      tokenAddress,
      tpl.poolSize.toString(),
      tpl.entryFee.toString(),
      tpl.active,
      tpl.currentPool,
      meta.txHash || null,
      meta.blockNumber || null,
      meta.blockTime || null,
    ]
  );

  if (tpl.currentPool && tpl.currentPool !== ethers.ZeroAddress) {
    await upsertPoolFromTemplate(
      tpl.currentPool,
      templateId,
      tpl.token,
      tpl.poolSize.toString(),
      tpl.entryFee.toString()
    );
  }
}

async function upsertPoolFromTemplate(
  poolAddress,
  templateId,
  tokenAddress,
  poolSize,
  entryFee,
  meta = {}
) {
  await ensureToken(tokenAddress);
  await db.query(
    `INSERT INTO pools (pool_id, template_id, pool_address, pool_size, entry_fee, deposited, total_entries, participant_count, created_tx_hash, created_block_number, created_block_time, closed, block_time, token_address)
     VALUES ($1, $2, $1, $3, $4, 0, 0, 0, $6, $7, $8, FALSE, NOW(), $5)
     ON CONFLICT (pool_id) DO UPDATE
       SET template_id = EXCLUDED.template_id,
           pool_size = EXCLUDED.pool_size,
           entry_fee = EXCLUDED.entry_fee,
           token_address = EXCLUDED.token_address,
           created_tx_hash = COALESCE(pools.created_tx_hash, EXCLUDED.created_tx_hash),
           created_block_number = COALESCE(pools.created_block_number, EXCLUDED.created_block_number),
           created_block_time = COALESCE(pools.created_block_time, EXCLUDED.created_block_time)`,
    [
      poolAddress,
      templateId,
      poolSize,
      entryFee,
      tokenAddress,
      meta.txHash || null,
      meta.blockNumber || null,
      meta.blockTime || null,
    ]
  );
}

async function handleFactoryLog(log) {
  let parsed;
  try {
    parsed = factoryIface.parseLog(log);
  } catch {
    return { newPools: [] };
  }
  if (parsed.name === 'TemplateRegistered') {
    const templateId = parsed.args.templateId.toString();
    const block = await provider.getBlock(log.blockNumber);
    const meta = {
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
      blockTime: block?.timestamp
        ? new Date(Number(block.timestamp) * 1000)
        : null,
    };
    await upsertTemplate(templateId, meta);
    return { newPools: [parsed.args.pool] };
  }
  if (parsed.name === 'TemplateStatusUpdated') {
    const templateId = parsed.args.templateId.toString();
    await db.query(`UPDATE templates SET active = $2 WHERE template_id = $1`, [
      templateId,
      parsed.args.active,
    ]);
    return { newPools: [] };
  }
  if (parsed.name === 'PoolCreated') {
    const templateId = parsed.args.templateId.toString();
    const poolAddress = parsed.args.pool;
    const block = await provider.getBlock(log.blockNumber);
    const meta = {
      txHash: log.transactionHash,
      blockNumber: log.blockNumber,
      blockTime: block?.timestamp
        ? new Date(Number(block.timestamp) * 1000)
        : null,
    };
    await upsertTemplate(templateId, meta);
    const factory = new ethers.Contract(
      FACTORY_ADDRESS,
      factoryReadAbi,
      provider
    );
    const tpl = await factory.getTemplate(templateId);
    await upsertPoolFromTemplate(
      poolAddress,
      templateId,
      tpl.token,
      tpl.poolSize.toString(),
      tpl.entryFee.toString(),
      meta
    );
    return { newPools: [poolAddress] };
  }
  return { newPools: [] };
}

async function handlePoolLog(log) {
  let parsed;
  try {
    parsed = poolIface.parseLog(log);
  } catch {
    return;
  }
  const poolId = log.address;
  const blockNumber = log.blockNumber;
  const txHash = log.transactionHash;
  const logIndex =
    log.index !== undefined
      ? Number(log.index)
      : log.logIndex !== undefined
      ? Number(log.logIndex)
      : 0;
  const block = await provider.getBlock(blockNumber);
  const blockTime = block?.timestamp
    ? new Date(Number(block.timestamp) * 1000)
    : new Date();
  if (parsed.name === 'TicketPurchased') {
    const account = parsed.args.account;
    const amount = parsed.args.amount;
    console.log(
      `TicketPurchased pool=${poolId} account=${account} amount=${amount.toString()} tx=${txHash} logIndex=${logIndex}`
    );
    const poolRes = await db.query(
      'SELECT entry_fee, deposited, total_entries FROM pools WHERE pool_id = $1',
      [poolId]
    );
    if (!poolRes.rows.length) return;
    const entryFee = BigInt(poolRes.rows[0].entry_fee || '0');
    const amountBig = BigInt(amount);
    const entries = entryFee > 0n ? amountBig / entryFee : 0n;
    await db.query(
      `INSERT INTO participants (pool_id, participant_address, amount, entries, tx_hash, block_number, block_time, log_index, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $7)
       ON CONFLICT (tx_hash, log_index) DO NOTHING`,
      [
        poolId,
        account,
        amountBig.toString(),
        entries.toString(),
        txHash,
        blockNumber,
        blockTime,
        logIndex,
      ]
    );
    await db.query(
      `UPDATE pools
       SET deposited = deposited + $2::numeric,
           total_entries = total_entries + $3::numeric,
           participant_count = (
             SELECT COUNT(DISTINCT participant_address) FROM participants WHERE pool_id = $1
           )
       WHERE pool_id = $1`,
      [poolId, amountBig.toString(), entries.toString()]
    );
    return;
  }

  if (parsed.name === 'PoolClosed') {
    const jackpotAmount = parsed.args.jackpotAmount.toString();
    const consolationAmount = parsed.args.consolationAmount.toString();
    console.log(
      `PoolClosed pool=${poolId} jackpot=${jackpotAmount} consolation=${consolationAmount} tx=${txHash} logIndex=${logIndex}`
    );
    await db.query(
      `UPDATE pools
       SET closed = TRUE,
           jackpot_amount = $2,
           consolation_amount = $3,
           closed_tx_hash = $4,
           closed_block_number = $5,
           closed_block_time = $6
       WHERE pool_id = $1`,
      [poolId, jackpotAmount, consolationAmount, txHash, blockNumber, blockTime]
    );
    return;
  }

  if (parsed.name === 'PrizeClaimed') {
    const winner = parsed.args.winner;
    const rewardType = Number(parsed.args.rewardType);
    const amount = parsed.args.amount.toString();
    const prizeType = rewardType === 0 ? 'jackpot' : 'consolation';
    console.log(
      `PrizeClaimed detected pool=${poolId} winner=${winner} type=${prizeType} amount=${amount} tx=${txHash} logIndex=${logIndex}`
    );
    try {
      await db.query(
        `INSERT INTO winners (pool_id, winner_address, amount, prize_type, tx_hash, block_number, block_time, log_index, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $7)
         ON CONFLICT (tx_hash, log_index) DO NOTHING`,
        [
          poolId,
          winner,
          amount,
          prizeType,
          txHash,
          blockNumber,
          blockTime,
          logIndex,
        ]
      );
      if (prizeType === 'jackpot') {
        await db.query(
          `UPDATE pools SET jackpot_winner = $2, jackpot_amount = COALESCE(jackpot_amount, $3) WHERE pool_id = $1`,
          [poolId, winner, amount]
        );
      }
    } catch (err) {
      console.warn(
        `Failed to insert winner for ${poolId} (log ${txHash}@${logIndex}):`,
        err
      );
    }
    return;
  }
}

async function getKnownPools() {
  const { rows } = await db.query('SELECT pool_id FROM pools');
  return rows.map((r) => r.pool_id);
}

async function getClosedPools() {
  const { rows } = await db.query(
    'SELECT pool_id FROM pools WHERE closed = TRUE'
  );
  return rows.map((r) => r.pool_id);
}

async function getRelayerCheckpoint(poolId) {
  const { rows } = await db.query(
    'SELECT last_action FROM relayer_state WHERE pool_id = $1',
    [poolId]
  );
  return rows.length ? rows[0].last_action : null;
}

async function setRelayerCheckpoint(poolId, action) {
  await db.query(
    `INSERT INTO relayer_state (pool_id, last_action, updated_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (pool_id) DO UPDATE SET last_action = EXCLUDED.last_action, updated_at = NOW()`,
    [poolId, action]
  );
}

async function processRange(fromBlock, toBlock, poolAddresses) {
  const topics = [
    [
      factoryIface.encodeFilterTopics('TemplateRegistered', [])[0],
      factoryIface.encodeFilterTopics('TemplateStatusUpdated', [])[0],
      factoryIface.encodeFilterTopics('PoolCreated', [])[0],
    ],
  ];

  console.log(`Processing blocks ${fromBlock} -> ${toBlock}`);
  const factoryLogs = await provider.getLogs({
    address: FACTORY_ADDRESS,
    fromBlock,
    toBlock,
    topics,
  });

  // Process factory logs and collect newly created pools
  for (const log of factoryLogs) {
    try {
      const { newPools } = await handleFactoryLog(log);
      poolAddresses.push(...newPools);
    } catch (err) {
      console.warn(`Factory log error at block ${log.blockNumber}:`, err);
    }
  }

  // Deduplicate pool list
  const dedupMap = new Map();
  for (const addr of poolAddresses) {
    const key = addr.toLowerCase();
    if (!dedupMap.has(key)) dedupMap.set(key, addr);
  }
  const poolSet = Array.from(dedupMap.values());
  if (!poolSet.length) {
    console.log(`No pool addresses to process for blocks ${fromBlock}-${toBlock}`);
    return poolSet;
  }

  const poolTopics = [
    [
      poolIface.encodeFilterTopics('TicketPurchased', [])[0],
      poolIface.encodeFilterTopics('PoolClosed', [])[0],
      poolIface.encodeFilterTopics('PrizeClaimed', [])[0],
    ],
  ];

  const poolLogs = await provider.getLogs({
    address: poolSet,
    fromBlock,
    toBlock,
    topics: poolTopics,
  });
  if (poolLogs.length === 0) {
    console.log(
      `No pool logs found for ${poolSet.length} pools in blocks ${fromBlock}-${toBlock}`
    );
  } else {
    const tally = { TicketPurchased: 0, PoolClosed: 0, PrizeClaimed: 0, other: 0 };
    for (const l of poolLogs) {
      try {
        const parsed = poolIface.parseLog(l);
        if (tally[parsed.name] !== undefined) tally[parsed.name] += 1;
        else tally.other += 1;
      } catch {
        tally.other += 1;
      }
    }
    console.log(
      `Pool logs in ${fromBlock}-${toBlock}: total=${poolLogs.length} ` +
        `TicketPurchased=${tally.TicketPurchased} PoolClosed=${tally.PoolClosed} PrizeClaimed=${tally.PrizeClaimed} other=${tally.other}`
    );
  }

  for (const log of poolLogs) {
    try {
      await handlePoolLog(log);
    } catch (err) {
      console.warn(`Pool log error at block ${log.blockNumber}:`, err);
    }
  }
  return poolSet;
}

async function evaluatePool(poolId) {
  if (!RELAYER_ENABLED || !relayerSigner) return;
  const pool = new ethers.Contract(poolId, poolWriteAbi, relayerSigner);
  const lastAction = await getRelayerCheckpoint(poolId);
  if (lastAction === 'completed') return;
  let closed,
    randomSeedCount,
    winnersFinalized,
    jackpotPayed,
    totalEntries,
    consolationPayoutIndex,
    generatedConsolationWinners,
    consolationWinnerBps;
  try {
    [
      closed,
      randomSeedCount,
      winnersFinalized,
      jackpotPayed,
      totalEntries,
      consolationPayoutIndex,
      generatedConsolationWinners,
      consolationWinnerBps,
    ] = await Promise.all([
      pool.closed(),
      pool.randomSeedCount(),
      pool.winnersFinalized(),
      pool.jackpotPayed(),
      pool.totalEntries(),
      pool.consolationPayoutIndex(),
      pool.generatedConsolationWinners(),
      pool.consolationWinnerBps(),
    ]);
  } catch (err) {
    console.warn(`Relayer read failed for ${poolId}:`, err);
    return;
  }

  if (!closed) return; // not ready
  if (Number(randomSeedCount) === 0) return; // randomness not ready

  try {
    if (!winnersFinalized) {
      const iterations = Math.max(1, RELAYER_FINALIZE_BATCH);
      await pool.batchFinalizeWinners(iterations);
      await setRelayerCheckpoint(poolId, 'finalize');
      return;
    }

    if (!jackpotPayed) {
      await pool.payJackpotWinner();
      await setRelayerCheckpoint(poolId, 'jackpot');
      return;
    }

    // Consolation payouts
    const totalEntriesNum = Number(totalEntries);
    const targetWinners = Math.min(
      totalEntriesNum > 0 ? totalEntriesNum - 1 : 0,
      Math.floor((Number(consolationWinnerBps) * totalEntriesNum) / 10000)
    );
    const remaining = targetWinners - Number(consolationPayoutIndex);
    if (remaining > 0) {
      const iterations = Math.min(remaining, RELAYER_FINALIZE_BATCH);
      await pool.batchConsolationPayout(iterations);
      await setRelayerCheckpoint(poolId, 'consolation');
      return;
    }

    // Sweep residuals once all payouts done
    await pool.sweepResidualToTreasury();
    await setRelayerCheckpoint(poolId, 'completed');
  } catch (err) {
    console.warn(`Relayer action failed for ${poolId}:`, err);
  }
}

async function relayerLoop() {
  if (!RELAYER_ENABLED) return;
  if (relayerLoop.running) return;
  relayerLoop.running = true;
  const pools = await getClosedPools();
  for (const poolId of pools) {
    await evaluatePool(poolId);
  }
  relayerLoop.running = false;
}
relayerLoop.running = false;

async function main() {
  await ensureStateTable();
  let lastProcessed = await getCheckpoint();
  let pools = await getKnownPools();
  console.log(`Starting from block ${lastProcessed}, pools: ${pools.length}`);

  // Backfill loop until near head
  while (true) {
    const latest = await provider.getBlockNumber();
    const target = latest - FINALITY;
    const gap = target - lastProcessed;
    if (gap <= NEAR_HEAD_THRESHOLD) break;
    const from = lastProcessed + 1;
    const to = Math.min(from + BATCH_SIZE - 1, target);
    pools = await processRange(from, to, pools);
    await setCheckpoint(to);
    lastProcessed = to;
  }

  console.log(`Switching to tail mode from block ${lastProcessed}`);

  // Tail mode: serialize processing to avoid overlap
  let processing = false;
  const processFinalizedGap = async (blockNumber) => {
    if (processing) return;
    processing = true;
    try {
      const target = blockNumber - FINALITY;
      if (target > lastProcessed) {
        const from = lastProcessed + 1;
        const to = target;
        pools = await processRange(from, to, pools);
        await setCheckpoint(to);
        lastProcessed = to;
      }
    } catch (err) {
      console.error('Tail mode error', err);
    } finally {
      processing = false;
    }
  };

  const attachBlockListener = () => {
    if (provider && provider.on) {
      provider.on('block', processFinalizedGap);
    }
  };
  attachBlockListener();

  // Handle WS disconnects: backfill via HTTP and recreate WS provider
  const reconnect = async () => {
    try {
      const latest = await httpProvider.getBlockNumber();
      const target = latest - FINALITY;
      if (target > lastProcessed) {
        const from = lastProcessed + 1;
        const to = target;
        pools = await processRange(from, to, pools);
        await setCheckpoint(to);
        lastProcessed = to;
      }
    } catch (err) {
      console.error('Reconnect backfill failed', err);
    }
    if (WS_RPC_URL) {
      try {
        provider = new ethers.WebSocketProvider(WS_RPC_URL);
        provider.on('close', reconnect);
        provider.on('error', reconnect);
        attachBlockListener();
      } catch (err) {
        console.error('Failed to recreate WS provider', err);
        setTimeout(reconnect, 3000);
      }
    }
  };

  if (WS_RPC_URL && provider instanceof ethers.WebSocketProvider) {
    provider.on('close', reconnect);
    provider.on('error', reconnect);
  }

  // Fallback polling in case WS drops or misses events
  setInterval(async () => {
    const latest = await httpProvider.getBlockNumber();
    await processFinalizedGap(latest);
  }, BLOCK_POLL_INTERVAL_MS);

  if (RELAYER_ENABLED) {
    console.log('Relayer enabled; starting relayer loop');
    setInterval(relayerLoop, RELAYER_INTERVAL_MS);
  } else {
    console.log('Relayer disabled (RELAYER_PRIVATE_KEY not set)');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
