#!/usr/bin/env node
/* eslint-disable no-console */
require('dotenv').config();
const { ethers } = require('ethers');

const poolIface = new ethers.Interface([
  'event TicketPurchased(address indexed account, uint256 amount, uint256 cumulativeEntries)',
  'event PoolClosed(uint256 jackpotAmount, uint256 consolationAmount, uint256 treasuryAmount)',
  'event PrizeClaimed(address indexed winner, uint256 indexed ticketNumber, uint8 rewardType, uint256 amount)',
]);

function parseArgs(argv) {
  const out = {
    from: null,
    to: null,
    pool: null,
    tx: null,
    rpc: process.env.RPC_URL || null,
    topics: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--from') out.from = Number(argv[++i]);
    else if (a === '--to') out.to = Number(argv[++i]);
    else if (a === '--pool') out.pool = argv[++i];
    else if (a === '--tx') out.tx = argv[++i].toLowerCase();
    else if (a === '--rpc') out.rpc = argv[++i];
    else if (a === '--no-topics') out.topics = false;
  }

  return out;
}

function uniqueTxHashes(logs) {
  const set = new Set();
  for (const l of logs) set.add((l.transactionHash || '').toLowerCase());
  return Array.from(set);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.rpc) throw new Error('Missing RPC URL. Set RPC_URL or pass --rpc');
  if (!Number.isFinite(args.from) || !Number.isFinite(args.to)) {
    throw new Error('Provide --from <block> and --to <block>');
  }
  if (!args.pool) {
    throw new Error('Provide --pool <poolAddress>');
  }
  if (args.to < args.from) {
    throw new Error('--to must be >= --from');
  }

  const provider = new ethers.JsonRpcProvider(args.rpc);
  const address = ethers.getAddress(args.pool);

  const topics = args.topics
    ? [
        [
          poolIface.encodeFilterTopics('TicketPurchased', [])[0],
          poolIface.encodeFilterTopics('PoolClosed', [])[0],
          poolIface.encodeFilterTopics('PrizeClaimed', [])[0],
        ],
      ]
    : undefined;

  console.log(
    `Fetching logs: pool=${address} from=${args.from} to=${args.to} topics=${args.topics ? 'pool-events-only' : 'all'}`,
  );

  const logs = await provider.getLogs({
    address,
    fromBlock: args.from,
    toBlock: args.to,
    topics,
  });

  const txHashes = uniqueTxHashes(logs);
  console.log(`Raw logs returned: ${logs.length}`);
  console.log(`Unique tx hashes: ${txHashes.length}`);
  if (txHashes.length) {
    console.log('Tx hashes:');
    for (const h of txHashes) console.log(`- ${h}`);
  }

  let parsedCount = 0;
  let failedCount = 0;
  const eventCounts = {
    TicketPurchased: 0,
    PoolClosed: 0,
    PrizeClaimed: 0,
    Unknown: 0,
  };

  console.log('\nDetailed logs:');
  for (const log of logs) {
    const txHash = (log.transactionHash || '').toLowerCase();
    const idx =
      log.index !== undefined ? log.index : log.logIndex !== undefined ? log.logIndex : 0;
    let name = 'Unknown';
    try {
      const parsed = poolIface.parseLog(log);
      parsedCount += 1;
      name = parsed.name;
      if (eventCounts[name] !== undefined) eventCounts[name] += 1;
      else eventCounts.Unknown += 1;
    } catch {
      failedCount += 1;
      eventCounts.Unknown += 1;
    }

    const targetMark = args.tx && txHash === args.tx ? ' <-- TARGET TX' : '';
    console.log(
      `block=${log.blockNumber} logIndex=${idx} topic0=${log.topics?.[0]} event=${name} tx=${txHash}${targetMark}`,
    );
  }

  console.log('\nDecode summary:');
  console.log(`Parsed: ${parsedCount}`);
  console.log(`Parse failed: ${failedCount}`);
  console.log(
    `Counts: TicketPurchased=${eventCounts.TicketPurchased}, PoolClosed=${eventCounts.PoolClosed}, PrizeClaimed=${eventCounts.PrizeClaimed}, Unknown=${eventCounts.Unknown}`,
  );

  if (args.tx) {
    const found = txHashes.includes(args.tx);
    console.log(`\nTarget tx ${args.tx} ${found ? 'WAS' : 'WAS NOT'} returned by getLogs`);
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
