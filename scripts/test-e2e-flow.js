#!/usr/bin/env node
/**
 * End-to-end test: Award → Auto-Approval → Spend
 * Tests the complete pipeline from CDR to token movement
 */
require('dotenv').config();
const { ethers } = require('ethers');

const PROVIDER_URL = 'https://rpc-amoy.polygon.technology/';
const PRIVATE_KEY = process.env.TREASURY_SIGNER_KEY;
const TOKEN_CONTRACT = '0x605871D30DC278a036F09e2ace771df8a224624B';

if (!PRIVATE_KEY) {
  console.error('❌ TREASURY_SIGNER_KEY not configured');
  process.exit(1);
}

const ABI = [
  'function transfer(address to, uint256 amount) public returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) public returns (bool)',
  'function balanceOf(address account) public view returns (uint256)',
  'function approve(address spender, uint256 amount) public returns (bool)',
  'function allowance(address owner, address spender) public view returns (uint256)',
];

async function testE2E() {
  const provider = new ethers.JsonRpcProvider(PROVIDER_URL);
  const treasurySigner = new ethers.Wallet(PRIVATE_KEY, provider);
  const treasuryAddress = treasurySigner.address;

  // Use compiled dist version
  const { processAwardFromCDR } = require('./dist/awardExecutor');
  const { processSpend } = require('./dist/spendExecutor');
  const { resolveUidToAddress, generateDeterministicWallet } = require('./dist/user/userService');

  const contract = new ethers.Contract(TOKEN_CONTRACT, ABI, treasurySigner);

  console.log('🚀 E2E Test: Award → Auto-Approve → Spend\n');
  console.log('Treasury:', treasuryAddress);
  console.log('');

  const testUID = `e2e-test-${Date.now()}`;
  const userAddress = resolveUidToAddress(testUID);

  console.log('Test UID:', testUID);
  console.log('User Address:', userAddress);
  console.log('');

  try {
    // Step 1: Execute award
    console.log('📍 Step 1: Executing award (10 SPARKZ via V2G discharge)...');
    const sampleCDR = {
      SessionID: `sess-${Date.now()}`,
      ProviderID: 'test-provider',
      EVSEID: 'DE*ABC*E12345',
      UID: testUID,
      "Session Start": new Date(Date.now() - 3600000).toISOString(),
      "Session End": new Date().toISOString(),
      "Consumed Energy": '-10', // Negative = DISCHARGE (V2G), 1 token per kWh = 10 tokens
      "Energy Direction": 'DISCHARGE', // V2G discharge = 1 token per kWh
    };

    const awardResult = await processAwardFromCDR(sampleCDR, treasurySigner);

    if (!awardResult.success) {
      console.error('❌ Award failed:', awardResult.error);
      return;
    }

    console.log('✅ Award successful');
    console.log(`   TX: ${awardResult.txHash}`);
    console.log(`   Amount: ${awardResult.amount} SPARKZ`);
    console.log('');

    // Verify user received tokens
    const userBalance = await contract.balanceOf(userAddress);
    console.log(`   User balance after award: ${ethers.formatEther(userBalance)} SPARKZ`);

    // Step 2: Wait for auto-approval to complete
    console.log('');
    console.log('📍 Step 2: Waiting for auto-approval...');
    console.log('   (Auto-approval fires asynchronously after award)');
    console.log('   (Waiting 25 seconds for MATIC funding + approve to complete)');

    await new Promise(resolve => setTimeout(resolve, 25000));

    // Check user MATIC balance
    const userMatic = await provider.getBalance(userAddress);
    console.log(`   User MATIC balance: ${ethers.formatEther(userMatic)}`);

    // Check allowance
    const allowance = await contract.allowance(userAddress, treasuryAddress);
    console.log(`   User allowance for treasury: ${ethers.formatEther(allowance)}`);
    console.log('');

    // Step 3: Execute spend
    console.log('📍 Step 3: Executing spend (send 10 SPARKZ back to treasury)...');
    const spendRequest = {
      userAddress: userAddress,
      amount: awardResult.amount,
      sessionId: `spend-${Date.now()}`,
    };

    const spendResult = await processSpend(spendRequest, treasurySigner);

    if (!spendResult.success) {
      console.error('❌ Spend failed:', spendResult.error);
      console.log('');
      console.log('Debug info:');
      console.log('   User MATIC:', ethers.formatEther(userMatic));
      console.log('   Allowance:', ethers.formatEther(allowance));
      return;
    }

    console.log('✅ Spend successful');
    console.log(`   TX: ${spendResult.txHash}`);
    console.log(`   Amount: ${spendResult.amount} SPARKZ`);
    console.log('');

    // Final verification
    const finalBalance = await contract.balanceOf(userAddress);
    console.log('Final balances:');
    console.log(`   User SPARKZ: ${ethers.formatEther(finalBalance)}`);
    console.log('');
    console.log('✅ ✅ ✅ E2E FLOW COMPLETE!');
  } catch (err) {
    console.error('❌ Error:', err.message || err);
  }
}

testE2E();
