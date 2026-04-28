#!/usr/bin/env node
/* eslint-disable no-console */

// Generates a new mnemonic-based wallet using ethers v6.
// Prints the seed phrase, address #1 (m/44'/60'/0'/0/0), and its private key.
//
// Usage:
//   cd backend
//   node scripts/generate-wallet.js

const { HDNodeWallet, Wallet } = require('ethers');

function main() {
  const base = Wallet.createRandom(); // HDNodeWallet in ethers v6
  const phrase = base.mnemonic?.phrase;
  if (!phrase) {
    throw new Error('Failed to generate mnemonic phrase');
  }

  const path = "m/44'/60'/0'/0/0";
  const wallet1 = HDNodeWallet.fromPhrase(phrase, undefined, path);

  console.log('Seed phrase (mnemonic):');
  console.log(phrase);
  console.log('');
  console.log(`Derivation path: ${path}`);
  console.log(`Address #1: ${wallet1.address}`);
  console.log(`Private key #1: ${wallet1.privateKey}`);
}

try {
  main();
} catch (err) {
  console.error(err);
  process.exitCode = 1;
}

