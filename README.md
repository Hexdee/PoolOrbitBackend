# PoolOrbit Backend (Express + Postgres)

APIs for PoolOrbitFactory + Pool contract data (templates, pools, participants, winners).

## Quickstart

```bash
cd backend
cp .env.example .env
# update DATABASE_URL if needed
npm install
npm run dev
```

Database setup (with sample schema + seed data):

```bash
psql "$DATABASE_URL" -f sql/schema.sql
```

Seed data matches the Hardhat demo addresses in `smart-contract/deployments/hardhat-demo.json`. Update the token/template rows for other networks.

## Environment

- `DATABASE_URL`: Postgres connection string.
- `DATABASE_SSL`: set to `true` for managed DBs that require SSL.
- `PORT`: server port (default `4000`).
- Amounts are stored in base token units (e.g., USDC 6 decimals); format them client-side.
- Indexer env: `RPC_URL`, `FACTORY_ADDRESS`, `START_BLOCK` (optional if `indexer_state` is already populated), `FINALITY_CONFIRMATIONS` (default 0), `BATCH_SIZE`.
- Events are stored with transaction hashes/block info (participants entries, winners, pool creation/closure, template creation) for on-chain verification.
- Tail mode: optional `WS_RPC_URL` (preferred), `NEAR_HEAD_THRESHOLD` (defaults to 2000 blocks) to switch from batch backfill to live block subscription.
- Robustness: tail mode is serialized to avoid overlapping ranges; participants/winners have unique (tx_hash, log_index) constraints and inserts use `ON CONFLICT DO NOTHING`; fallback polling runs every `BLOCK_POLL_INTERVAL_MS` (default 5000 ms) in case WS misses blocks.

## Endpoints

- `GET /health` — liveness check.
- `GET /templates` — template configs (PoolOrbit templateId, token, pool_size, entry_fee, active_pool_id).
- `GET /pools` — active pools by default (use `status=closed|active`, `token`, `templateId`, `limit`, `offset`).
- `GET /pools/:poolId` — pool detail plus participants and winners.
- `GET /analytics/pools/historical` — historical pools (filters: `status`, `templateId`, `token`, `limit`, `offset`).
- `GET /analytics/pools/featured` — top active pools by fill percentage (optional `token`, `limit`).
- `GET /analytics/pools/user/:address` — pools a user participated in (optional `status`, `limit`, `offset`).
- `GET /analytics/winners/recent` — past winners (optional `token`, `limit`).
- `GET /analytics/winners/jackpot` — jackpot totals overall and per token (or pass `token` for a single token).

List endpoints return `{ data: [...] }` for easy consumption by the Next.js dashboard (`src/app/lib/api.ts`).

## Indexer

The indexer ingests on-chain events (factory + pools) into Postgres.

Run:
```bash
cd backend
RPC_URL=<https-endpoint> \
FACTORY_ADDRESS=<pool_orbit_factory> \
START_BLOCK=<factory_deploy_block_or_checkpoint> \
npm run indexer:run
```

It keeps a checkpoint in `indexer_state` (`key=last_block`). `BATCH_SIZE` defaults to 1000, `FINALITY_CONFIRMATIONS` defaults to 6. It processes TemplateRegistered/PoolCreated/TemplateStatusUpdated and TicketPurchased/PoolClosed/PrizeClaimed, upserting templates, pools, participants, and winners. If templates/pools are created before the indexer starts, the initial backfill is just those blocks (cheap and recommended).

## PM2 (Production)

Start processes (first time):
```bash
cd backend
pm2 start npm --name poolorbit-api -- run start
pm2 start npm --name poolorbit-indexer -- run indexer:run
pm2 save
```

Common PM2 commands:
```bash
pm2 status
pm2 logs poolorbit-api --lines 200
pm2 logs poolorbit-indexer --lines 200
pm2 restart poolorbit-api --update-env
pm2 restart poolorbit-indexer --update-env
pm2 stop poolorbit-api
pm2 stop poolorbit-indexer
pm2 delete poolorbit-api
pm2 delete poolorbit-indexer
pm2 resurrect
```

Enable PM2 startup on reboot (Ubuntu/systemd):
```bash
pm2 startup systemd -u $USER --hp $HOME
# run the sudo command PM2 prints
pm2 save
```

## Deploy Script

One-command production deploy:
```bash
cd backend
npm run deploy:prod
```

Deploy script with custom branch:
```bash
cd backend
bash scripts/deploy-prod.sh main
```

Skip git pull (deploy current checkout only):
```bash
cd backend
DO_PULL=0 bash scripts/deploy-prod.sh
```
