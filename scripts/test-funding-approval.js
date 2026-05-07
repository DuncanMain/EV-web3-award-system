#!/usr/bin/env node
require('dotenv').config();
const { ethers } = require('ethers');

const PROVIDER_URL = process.env.POLYGON_RPC_ENDPOINT || 'https://rpc-amoy.polygon.technology/';
const PRIVATE_KEY = process.env.TREASURY_SIGNER_KEY;
const TOKEN_CONTRACT = process.env.TOKEN_CONTRACT_ADDRESS || '0x605871D30DC278a036F09e2ace771df8a224624B';

const ABI = [
  'function transfer(address to, uint256 amount) public returns (bool)',
  'function transferFrom(address from, address to, uint256 amount) public returns (bool)',
  'function balanceOf(address account) public view returns (uint256)',
  'function approve(address spender, uint256 amount) public returns (bool)',
  'function allowance(address owner, address spender) public view returns (uint256)',
];

async function testFundingAndApproval() {
  const provider = new ethers.JsonRpcProvider(PROVIDER_URL);
  const treasurySigner = new ethers.Wallet(PRIVATE_KEY, provider);
  const treasuryAddress = treasurySigner.address;

  // Create a test user wallet
  const testWallet = ethers.Wallet.createRandom();
  const userSigner = testWallet.connect(provider);
  const userAddress = userSigner.address;

  const contract = new ethers.Contract(TOKEN_CONTRACT, ABI, treasurySigner);
  const userContract = new ethers.Contract(TOKEN_CONTRACT, ABI, userSigner);

  console.log('🔧 Testing Treasury → User Funding → Approval Flow\n');
  console.log('Treasury:', treasuryAddress);
  console.log('Test User:', userAddress);
  console.log('Token Contract:', TOKEN_CONTRACT);
  console.log('');

  try {
    // Step 1: Check treasury has enough tokens
    console.log('📋 Step 1: Checking balances...');
    const treasuryTokens = await contract.balanceOf(treasuryAddress);
    const treasuryMatic = await provider.getBalance(treasuryAddress);
    const userTokens = await contract.balanceOf(userAddress);
    const userMatic = await provider.getBalance(userAddress);

    console.log(`  Treasury SPARKZ: ${ethers.formatEther(treasuryTokens)} (needs >= 10)`);
    console.log(`  Treasury MATIC: ${ethers.formatEther(treasuryMatic)} (needs >= 0.01 for funding)`);
    console.log(`  User SPARKZ: ${ethers.formatEther(userTokens)}`);
    console.log(`  User MATIC: ${ethers.formatEther(userMatic)} (should be 0 initially)`);
    console.log('');

    if (Number(treasuryTokens) < ethers.parseEther('10')) {
      console.error('❌ Treasury has insufficient SPARKZ tokens!');
      return;
    }

    if (Number(treasuryMatic) < ethers.parseEther('0.01')) {
      console.error('❌ Treasury has insufficient MATIC for gas!');
      return;
    }

    // Step 2: Award 10 tokens to user
    console.log('💎 Step 2: Awarding 10 SPARKZ to user...');
    const awardTx = await contract.transfer(userAddress, ethers.parseEther('10'));
    const awardReceipt = await awardTx.wait();
    console.log(`  ✓ Award tx: ${awardTx.hash}`);
    console.log(`  ✓ Block: ${awardReceipt.blockNumber}`);

    // Verify user received tokens
    const userTokensAfterAward = await contract.balanceOf(userAddress);
    console.log(`  User SPARKZ after award: ${ethers.formatEther(userTokensAfterAward)}`);
    console.log('');

    // Step 3: Fund user with MATIC
    console.log('💰 Step 3: Funding user with 0.005 MATIC...');
    const fundTx = await treasurySigner.sendTransaction({
      to: userAddress,
      value: ethers.parseEther('0.005'),
    });
    console.log(`  ✓ Funding tx: ${fundTx.hash}`);
    const fundReceipt = await fundTx.wait();
    console.log(`  ✓ Block: ${fundReceipt.blockNumber}`);

    // Verify user got MATIC
    const userMaticAfterFunding = await provider.getBalance(userAddress);
    console.log(`  User MATIC after funding: ${ethers.formatEther(userMaticAfterFunding)}`);
    console.log('');

    // Step 4: User calls approve
    console.log('🔐 Step 4: User approving treasury to spend tokens...');
    try {
      const approveTx = await userContract.approve(treasuryAddress, ethers.MaxUint256);
      console.log(`  ✓ Approve tx: ${approveTx.hash}`);
      const approveReceipt = await approveTx.wait();
      console.log(`  ✓ Block: ${approveReceipt.blockNumber}`);

      // Verify approval
      const allowance = await contract.allowance(userAddress, treasuryAddress);
      console.log(`  User allowance for treasury: ${ethers.formatEther(allowance)}`);
      console.log('');

      // Step 5: Treasury calls transferFrom
      console.log('🔄 Step 5: Treasury spending user tokens (transferFrom)...');
      const spendTx = await contract.transferFrom(userAddress, treasuryAddress, ethers.parseEther('10'));
      console.log(`  ✓ Spend tx: ${spendTx.hash}`);
      const spendReceipt = await spendTx.wait();
      console.log(`  ✓ Block: ${spendReceipt.blockNumber}`);

      // Final balances
      const userTokensFinal = await contract.balanceOf(userAddress);
      const treasuryTokensFinal = await contract.balanceOf(treasuryAddress);
      console.log('');
      console.log('✅ FULL FLOW SUCCESSFUL!');
      console.log(`  User SPARKZ: ${ethers.formatEther(userTokensAfterAward)} → ${ethers.formatEther(userTokensFinal)}`);
      console.log(`  Treasury SPARKZ: ${ethers.formatEther(treasuryTokens)} → ${ethers.formatEther(treasuryTokensFinal)}`);
    } catch (approveErr) {
      console.error('❌ Approval failed:', approveErr.message || approveErr);
    }
  } catch (err) {
    console.error('❌ Fatal error:', err.message || err);
  }
}

testFundingAndApproval();
