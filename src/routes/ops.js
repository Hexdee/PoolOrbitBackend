const express = require('express');
const { ethers } = require('ethers');
const db = require('../db');

const router = express.Router();

const OPS_TOKEN = process.env.OPS_STATUS_TOKEN;

function requireOpsAuth(req, res, next) {
  if (!OPS_TOKEN || OPS_TOKEN.length === 0) return next();
  const auth = String(req.headers.authorization || '');
  if (auth === `Bearer ${OPS_TOKEN}`) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

const factoryReadAbi = [
  'function owner() view returns (address)',
  'function TREASURY() view returns (address)',
  'function keyHash() view returns (bytes32)',
  'function subscriptionId() view returns (uint256)',
  'function requestConfirmations() view returns (uint16)',
  'function callbackGasLimit() view returns (uint32)',
  'function randomWordsCount() view returns (uint32)',
  'function vrfNativePayment() view returns (bool)',
];

const vrfSubscriptionAbi = [
  'function getSubscription(uint256 subId) view returns (uint96 balance, uint96 nativeBalance, uint64 reqCount, address owner, address[] consumers)',
  'function pendingRequestExists(uint256 subId) view returns (bool)',
];

function asNumber(value) {
  if (value === undefined || value === null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

router.get('/status', requireOpsAuth, async (req, res, next) => {
  try {
    const RPC_URL = process.env.RPC_URL;
    const FACTORY_ADDRESS = process.env.FACTORY_ADDRESS;
    const RELAYER_PK = process.env.RELAYER_PRIVATE_KEY;
    const RELAYER_ADDRESS = process.env.RELAYER_ADDRESS;

    if (!RPC_URL) {
      return res.status(500).json({ error: 'RPC_URL is not configured' });
    }
    if (!FACTORY_ADDRESS) {
      return res.status(500).json({ error: 'FACTORY_ADDRESS is not configured' });
    }

    const provider = new ethers.JsonRpcProvider(RPC_URL);
    const [net, headBlock] = await Promise.all([
      provider.getNetwork(),
      provider.getBlockNumber(),
    ]);

    const relayerAddress =
      (RELAYER_PK && RELAYER_PK.length > 0
        ? new ethers.Wallet(RELAYER_PK).address
        : null) ||
      (RELAYER_ADDRESS && ethers.isAddress(RELAYER_ADDRESS)
        ? RELAYER_ADDRESS
        : null);

    const relayerBalanceWei = relayerAddress
      ? await provider.getBalance(relayerAddress)
      : null;

    const factory = new ethers.Contract(FACTORY_ADDRESS, factoryReadAbi, provider);
    const [
      factoryOwner,
      factoryTreasury,
      keyHash,
      factorySubId,
      requestConfirmations,
      callbackGasLimit,
      randomWordsCount,
      vrfNativePayment,
    ] = await Promise.all([
      factory.owner(),
      factory.TREASURY(),
      factory.keyHash(),
      factory.subscriptionId(),
      factory.requestConfirmations(),
      factory.callbackGasLimit(),
      factory.randomWordsCount(),
      factory.vrfNativePayment(),
    ]);

    const vrfCoordinatorEnv = process.env.VRF_COORDINATOR;
    const vrfSubIdEnv = process.env.VRF_SUBSCRIPTION_ID;
    const vrfCoordinator =
      vrfCoordinatorEnv && ethers.isAddress(vrfCoordinatorEnv)
        ? vrfCoordinatorEnv
        : null;

    const vrfSubId =
      vrfSubIdEnv && vrfSubIdEnv.length > 0
        ? BigInt(vrfSubIdEnv)
        : factorySubId
          ? BigInt(factorySubId.toString())
          : null;

    let vrf = null;
    if (vrfCoordinator && vrfSubId && vrfSubId > 0n) {
      const coordinator = new ethers.Contract(
        vrfCoordinator,
        vrfSubscriptionAbi,
        provider
      );
      const [sub, pending] = await Promise.all([
        coordinator.getSubscription(vrfSubId),
        coordinator.pendingRequestExists(vrfSubId).catch(() => null),
      ]);
      vrf = {
        coordinator: vrfCoordinator,
        subscriptionId: vrfSubId.toString(),
        owner: sub.owner,
        consumers: sub.consumers,
        pendingRequestExists: pending,
        linkBalanceJuels: sub.balance.toString(),
        nativeBalanceWei: sub.nativeBalance.toString(),
        requestCount: sub.reqCount.toString(),
      };
    }

    const dbStats = {
      indexerCheckpoint: null,
      indexerCheckpointUpdatedAt: null,
      relayerLastUpdatedAt: null,
      relayerPendingPools: null,
    };
    try {
      const checkpointRes = await db.query(
        "SELECT value, updated_at FROM indexer_state WHERE key = 'last_block' LIMIT 1"
      );
      if (checkpointRes.rows.length) {
        dbStats.indexerCheckpoint = asNumber(checkpointRes.rows[0].value);
        dbStats.indexerCheckpointUpdatedAt = checkpointRes.rows[0].updated_at;
      }

      const relayerLastRes = await db.query(
        'SELECT MAX(updated_at) AS last_updated_at FROM relayer_state'
      );
      dbStats.relayerLastUpdatedAt = relayerLastRes.rows[0]?.last_updated_at || null;

      const relayerPendingRes = await db.query(
        `SELECT COUNT(*)::int AS cnt
         FROM pools p
         LEFT JOIN relayer_state r ON p.pool_id = r.pool_id
         WHERE p.closed = TRUE AND (r.last_action IS NULL OR r.last_action <> 'completed')`
      );
      dbStats.relayerPendingPools = relayerPendingRes.rows[0]?.cnt ?? null;
    } catch (err) {
      // Allow ops endpoint to still return on-chain data even if DB is transiently unavailable.
      console.warn('ops/status DB query failed:', err);
    }

    return res.json({
      data: {
        chain: {
          chainId: Number(net.chainId),
          headBlock,
        },
        contracts: {
          factory: FACTORY_ADDRESS,
          owner: factoryOwner,
          treasury: factoryTreasury,
          vrf: {
            keyHash: keyHash,
            subscriptionId: factorySubId?.toString?.() ?? String(factorySubId),
            requestConfirmations: Number(requestConfirmations),
            callbackGasLimit: Number(callbackGasLimit),
            randomWordsCount: Number(randomWordsCount),
            nativePayment: Boolean(vrfNativePayment),
          },
        },
        relayer: {
          enabled: !!(RELAYER_PK && RELAYER_PK.length > 0),
          address: relayerAddress,
          balanceWei: relayerBalanceWei ? relayerBalanceWei.toString() : null,
        },
        vrf,
        db: dbStats,
      },
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;

