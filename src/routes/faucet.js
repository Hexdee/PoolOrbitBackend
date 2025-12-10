const express = require('express');
const { ethers } = require('ethers');
require('dotenv').config();

const router = express.Router();

const RPC_URL = process.env.RPC_URL;
const RELAYER_PK = process.env.RELAYER_PRIVATE_KEY;
const USDT_ADDRESS = process.env.USDT_ADDRESS;
const USDC_ADDRESS = process.env.USDC_ADDRESS;

if (!RPC_URL) {
  throw new Error('RPC_URL is required for faucet');
}
if (!RELAYER_PK) {
  console.warn('RELAYER_PRIVATE_KEY missing; faucet will not be enabled');
}

const provider = new ethers.JsonRpcProvider(RPC_URL);
const signer = RELAYER_PK ? new ethers.Wallet(RELAYER_PK, provider) : null;

const erc20MintAbi = [
  'function decimals() view returns (uint8)',
  'function mint(address to, uint256 amount) returns (bool)',
];

async function getDecimals(address) {
  const token = new ethers.Contract(address, erc20MintAbi, provider);
  try {
    return Number(await token.decimals());
  } catch {
    return 18;
  }
}

async function mintToken(tokenAddress, to, amountHuman) {
  if (!signer) throw new Error('Faucet signer unavailable');
  const decimals = await getDecimals(tokenAddress);
  const amount = BigInt(Math.floor(Number(amountHuman) * 10 ** decimals));
  const token = new ethers.Contract(tokenAddress, erc20MintAbi, signer);
  const tx = await token.mint(to, amount);
  await tx.wait();
  return tx.hash;
}

router.post('/', async (req, res, next) => {
  try {
    if (!signer) {
      return res.status(400).json({ error: 'Faucet not enabled' });
    }
    const { address, amountUsdt = 100, amountUsdc = 100 } = req.body || {};
    if (!address || !ethers.isAddress(address)) {
      return res.status(400).json({ error: 'Invalid address' });
    }

    const txs = [];
    if (USDT_ADDRESS && Number(amountUsdt) > 0) {
      const hash = await mintToken(USDT_ADDRESS, address, Number(amountUsdt));
      txs.push(hash);
    }
    if (USDC_ADDRESS && Number(amountUsdc) > 0) {
      const hash = await mintToken(USDC_ADDRESS, address, Number(amountUsdc));
      txs.push(hash);
    }
    res.json({ data: { txs } });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
