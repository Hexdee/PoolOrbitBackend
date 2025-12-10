-- PoolOrbit backend schema aligned to the PoolOrbitFactory + Pool contracts.
-- Values are stored in base token units (e.g., USDC 6 decimals).

DROP TABLE IF EXISTS tokens CASCADE;
DROP TABLE IF EXISTS templates CASCADE;
DROP TABLE IF EXISTS pools CASCADE;
DROP TABLE IF EXISTS participants CASCADE;
DROP TABLE IF EXISTS winners CASCADE;
DROP TABLE IF EXISTS indexer_state;

CREATE TABLE IF NOT EXISTS tokens (
  address TEXT PRIMARY KEY,
  symbol TEXT NOT NULL,
  name TEXT NOT NULL,
  decimals INTEGER NOT NULL DEFAULT 18,
  logo_url TEXT
);

CREATE TABLE IF NOT EXISTS templates (
  template_id BIGINT PRIMARY KEY,
  token_address TEXT NOT NULL REFERENCES tokens(address),
  pool_size NUMERIC(40, 0) NOT NULL,
  entry_fee NUMERIC(40, 0) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  exists_in_contract BOOLEAN NOT NULL DEFAULT TRUE,
  active_pool_id TEXT,
  created_tx_hash TEXT,
  created_block_number BIGINT,
  created_block_time TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS pools (
  pool_id TEXT PRIMARY KEY,
  template_id BIGINT NOT NULL REFERENCES templates(template_id),
  pool_address TEXT,
  pool_size NUMERIC(40, 0) NOT NULL,
  entry_fee NUMERIC(40, 0) NOT NULL,
  deposited NUMERIC(40, 0) NOT NULL DEFAULT 0,
  total_entries NUMERIC(40, 0) NOT NULL DEFAULT 0,
  participant_count INTEGER NOT NULL DEFAULT 0,
  created_tx_hash TEXT,
  created_block_number BIGINT,
  created_block_time TIMESTAMPTZ,
  closed BOOLEAN NOT NULL DEFAULT FALSE,
  block_time TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  token_address TEXT NOT NULL REFERENCES tokens(address),
  jackpot_winner TEXT,
  jackpot_amount NUMERIC(40, 0),
  consolation_amount NUMERIC(40, 0),
  closed_tx_hash TEXT,
  closed_block_number BIGINT,
  closed_block_time TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS participants (
  id SERIAL PRIMARY KEY,
  pool_id TEXT NOT NULL REFERENCES pools(pool_id) ON DELETE CASCADE,
  participant_address TEXT NOT NULL,
  amount NUMERIC(40, 0) NOT NULL,
  entries NUMERIC(40, 0) NOT NULL,
  tx_hash TEXT,
  block_number BIGINT,
  block_time TIMESTAMPTZ,
  log_index INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS winners (
  id SERIAL PRIMARY KEY,
  pool_id TEXT NOT NULL REFERENCES pools(pool_id) ON DELETE CASCADE,
  winner_address TEXT NOT NULL,
  amount NUMERIC(40, 0) NOT NULL,
  prize_type TEXT NOT NULL CHECK (prize_type IN ('jackpot', 'consolation')),
  tx_hash TEXT,
  block_number BIGINT,
  block_time TIMESTAMPTZ,
  log_index INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_templates_token ON templates(token_address);
CREATE INDEX IF NOT EXISTS idx_pools_template ON pools(template_id);
CREATE INDEX IF NOT EXISTS idx_pools_token ON pools(token_address);
CREATE INDEX IF NOT EXISTS idx_participants_user ON participants(participant_address);
CREATE INDEX IF NOT EXISTS idx_participants_tx ON participants(tx_hash);
CREATE INDEX IF NOT EXISTS idx_winners_tx ON winners(tx_hash);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_participants_tx_log'
  ) THEN
    ALTER TABLE participants
      ADD CONSTRAINT uq_participants_tx_log UNIQUE (tx_hash, log_index);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'uq_winners_tx_log'
  ) THEN
    ALTER TABLE winners
      ADD CONSTRAINT uq_winners_tx_log UNIQUE (tx_hash, log_index);
  END IF;
END$$;

-- Indexer checkpoint
CREATE TABLE IF NOT EXISTS indexer_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Relayer checkpoint
CREATE TABLE IF NOT EXISTS relayer_state (
  pool_id TEXT PRIMARY KEY,
  last_action TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- -- Seed tokens (Hardhat demo)
-- INSERT INTO tokens (address, symbol, name, decimals)
-- VALUES
--   ('0x68B1D87F95878fE05B998F19b66F4baba5De1aed', 'USDC', 'USD Coin', 6),
--   ('0x3Aa5ebB10DC797CAC828524e59A333d0A371443c', 'USDT', 'Tether USD', 6)
-- ON CONFLICT (address) DO NOTHING;

-- -- Seed templates matching the PoolOrbitFactory templates (demo template id 5)
-- INSERT INTO templates (template_id, token_address, pool_size, entry_fee, active, exists_in_contract, active_pool_id)
-- VALUES
--   (5, '0x68B1D87F95878fE05B998F19b66F4baba5De1aed', 1000000000, 1000000, TRUE, TRUE, 'pool-5a'),
--   (6, '0x3Aa5ebB10DC797CAC828524e59A333d0A371443c', 5000000000, 5000000, TRUE, TRUE, 'pool-6a')
-- ON CONFLICT (template_id) DO NOTHING;

-- -- Active pools (current pool per template)
-- INSERT INTO pools (
--   pool_id, template_id, pool_address, pool_size, entry_fee, deposited, total_entries,
--   participant_count, closed, block_time, token_address
-- ) VALUES
--   ('pool-5a', 5, '0x1111111111111111111111111111111111111111', 1000000000, 1000000, 420000000, 420, 3, FALSE, NOW() - INTERVAL '2 hours', '0x68B1D87F95878fE05B998F19b66F4baba5De1aed'),
--   ('pool-6a', 6, '0x2222222222222222222222222222222222222222', 5000000000, 5000000, 1250000000, 250, 2, FALSE, NOW() - INTERVAL '6 hours', '0x3Aa5ebB10DC797CAC828524e59A333d0A371443c')
-- ON CONFLICT (pool_id) DO NOTHING;

-- -- Historical pools
-- INSERT INTO pools (
--   pool_id, template_id, pool_address, pool_size, entry_fee, deposited, total_entries,
--   participant_count, closed, block_time, token_address, jackpot_winner, jackpot_amount, consolation_amount
-- ) VALUES
--   ('pool-5-prev', 5, '0x3333333333333333333333333333333333333333', 1000000000, 1000000, 1000000000, 1000, 2, TRUE, NOW() - INTERVAL '10 days', '0x68B1D87F95878fE05B998F19b66F4baba5De1aed', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', 400000000, 100000000),
--   ('pool-6-prev', 6, '0x4444444444444444444444444444444444444444', 5000000000, 5000000, 5000000000, 1000, 2, TRUE, NOW() - INTERVAL '20 days', '0x3Aa5ebB10DC797CAC828524e59A333d0A371443c', '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', 2000000000, 500000000)
-- ON CONFLICT (pool_id) DO NOTHING;

-- -- Participants for sample pools (amounts in base units)
-- INSERT INTO participants (pool_id, participant_address, amount, entries, created_at) VALUES
--   ('pool-5a', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', 150000000, 150, NOW() - INTERVAL '90 minutes'),
--   ('pool-5a', '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', 120000000, 120, NOW() - INTERVAL '70 minutes'),
--   ('pool-5a', '0x90F79bf6EB2c4f870365E785982E1f101E93b906', 150000000, 150, NOW() - INTERVAL '30 minutes'),
--   ('pool-6a', '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266', 500000000, 100, NOW() - INTERVAL '5 hours'),
--   ('pool-6a', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', 750000000, 150, NOW() - INTERVAL '4 hours'),
--   ('pool-5-prev', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', 400000000, 400, NOW() - INTERVAL '12 days'),
--   ('pool-5-prev', '0x90F79bf6EB2c4f870365E785982E1f101E93b906', 600000000, 600, NOW() - INTERVAL '11 days'),
--   ('pool-6-prev', '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', 2000000000, 400, NOW() - INTERVAL '21 days'),
--   ('pool-6-prev', '0x90F79bf6EB2c4f870365E785982E1f101E93b906', 3000000000, 600, NOW() - INTERVAL '20 days');

-- -- Winners for historical pools
-- INSERT INTO winners (pool_id, winner_address, amount, prize_type, created_at) VALUES
--   ('pool-5-prev', '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', 400000000, 'jackpot', NOW() - INTERVAL '10 days'),
--   ('pool-5-prev', '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', 25000000, 'consolation', NOW() - INTERVAL '10 days'),
--   ('pool-6-prev', '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', 2000000000, 'jackpot', NOW() - INTERVAL '20 days'),
--   ('pool-6-prev', '0x90F79bf6EB2c4f870365E785982E1f101E93b906', 50000000, 'consolation', NOW() - INTERVAL '20 days');
