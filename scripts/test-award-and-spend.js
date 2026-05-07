require('dotenv').config();
const { ethers } = require('ethers');
const { processAwardFromCDR, processSpend } = require('./dist/index');

// Load treasury signer
const treasuryPrivateKey = process.env.TREASURY_SIGNER_KEY;
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS;
const TOKEN_CONTRACT_ADDRESS = '0x605871D30DC278a036F09e2ace771df8a224624B'; // SPARKZ token

if (!treasuryPrivateKey) {
  console.error('❌ TREASURY_SIGNER_KEY not configured in .env');
  process.exit(1);
}

const rpcUrl = 'https://rpc-amoy.polygon.technology/';
const provider = new ethers.JsonRpcProvider(rpcUrl);
const treasurySigner = new ethers.Wallet(treasuryPrivateKey, provider);
const derivationSalt = process.env.USER_ADDRESS_DERIVATION_SALT || 'nvf-award-core-v1';

// ERC20 ABI (minimal - just what we need)
const ERC20_ABI = [
  'function approve(address spender, uint256 amount) public returns (bool)',
  'function allowance(address owner, address spender) public view returns (uint256)',
  'function balanceOf(address account) public view returns (uint256)',
];

// Derive user's wallet from UID
function generateDeterministicWallet(uid, salt) {
  const seed = ethers.solidityPacked(['string', 'string'], [uid, salt]);
  const hdNode = ethers.HDNodeWallet.fromSeed(seed);
  return hdNode.derivePath("m/44'/60'/0'/0/0");
}

async function runTest() {
  const testId = Math.random().toString(36).substring(7);
  const uid = `spend-test-${testId}`;
  
  console.log('🚀 Testing Award → Manual Approve → Spend Flow\n');
  console.log('Test ID:', testId);
  console.log('User UID:', uid);

  try {
    // Step 1: Award tokens to test user
    console.log('\n📍 Step 1: Awarding tokens...');
    
    const userWallet = generateDeterministicWallet(uid, derivationSalt);
    const userAddress = userWallet.address;
    console.log('User Address:', userAddress);

    // Create a test CDR with session in off-peak hours (use yesterday at 23:00 UTC)
    // Off-peak: 22:00-06:00 for DE
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    
    const offPeakStart = new Date(yesterday);
    offPeakStart.setHours(23, 0, 0, 0); // 11 PM yesterday
    
    const offPeakEnd = new Date(offPeakStart);
    offPeakEnd.setHours(23, 30, 0, 0); // 11:30 PM yesterday

    const sampleCDR = {
      SessionID: `sess-${testId}`,
      ProviderID: 'prov-DE',
      EVSEID: 'DE*ABC*E12345',
      'Session Start': offPeakStart.toISOString(),
      'Session End': offPeakEnd.toISOString(),
      'Consumed Energy': '40', // 40 kWh @ off-peak = 10 tokens (1 token per 4 kWh)
      UID: uid,
    };

    const awardResult = await processAwardFromCDR(sampleCDR, treasurySigner);

    if (!awardResult.success) {
      console.error('❌ Award failed:', awardResult.error);
      process.exit(1);
    }

    const awardAmount = awardResult.amount;
    console.log('✅ Award successful');
    console.log('   Amount:', awardAmount, 'SPARKZ');
    console.log('   Tx Hash:', awardResult.txHash);
    console.log('   🔗 View: https://amoy.polygonscan.com/tx/' + awardResult.txHash);

    // Step 2: Wait and check user balance
    console.log('\n📍 Step 2: Waiting for award to confirm...');
    await new Promise(resolve => setTimeout(resolve, 5000));

    const tokenContract = new ethers.Contract(TOKEN_CONTRACT_ADDRESS, ERC20_ABI, provider);
    const userBalance = await tokenContract.balanceOf(userAddress);
    console.log('✅ User balance:', ethers.formatEther(userBalance), 'SPARKZ');

    // Step 3: Manually approve tokens for spend
    console.log('\n📍 Step 3: Approving tokens for spending...');
    console.log('   User wallet will approve treasury to spend up to', awardAmount, 'tokens');

    const userSigner = userWallet.connect(provider);
    
    // Fund user with gas first
    console.log('   Funding user wallet with gas...');
    const gasFundTx = await treasurySigner.sendTransaction({
      to: userAddress,
      value: ethers.parseEther('0.01'), // 0.01 MATIC for gas
    });
    await gasFundTx.wait();
    console.log('   ✓ Gas funded');

    // Now call approve from user's wallet
    const contract = new ethers.Contract(TOKEN_CONTRACT_ADDRESS, ERC20_ABI, userSigner);
    const approveTx = await contract.approve(TREASURY_ADDRESS, ethers.parseEther(awardAmount.toString()));
    const approveReceipt = await approveTx.wait();
    console.log('✅ Approval successful');
    console.log('   Tx Hash:', approveReceipt.hash);
    console.log('   🔗 View: https://amoy.polygonscan.com/tx/' + approveReceipt.hash);

    // Step 4: Check allowance was set
    console.log('\n📍 Step 4: Verifying allowance...');
    const allowance = await tokenContract.allowance(userAddress, TREASURY_ADDRESS);
    console.log('✅ Allowance set:', ethers.formatEther(allowance), 'SPARKZ');

    // Step 5: Execute spend
    console.log('\n📍 Step 5: Executing spend via treasury...');

    const spendRequest = {
      userAddress: userAddress,
      amount: awardAmount,
      sessionId: `spend-${testId}`,
    };

    // Treasury will execute transferFrom
    const spendResult = await processSpend(spendRequest, treasurySigner);

    if (!spendResult.success) {
      console.error('❌ Spend failed:', spendResult.error);
      process.exit(1);
    }

    console.log('✅ Spend successful!');
    console.log('   Amount:', spendResult.amount, 'SPARKZ');
    console.log('   Tx Hash:', spendResult.txHash);
    console.log('   DB Stored:', spendResult.dbStored);
    console.log('   🔗 View: https://amoy.polygonscan.com/tx/' + spendResult.txHash);

    // Step 6: Verify final balance
    console.log('\n📍 Step 6: Verifying final balance...');
    await new Promise(resolve => setTimeout(resolve, 3000));
    const finalBalance = await tokenContract.balanceOf(userAddress);
    console.log('✅ Final user balance:', ethers.formatEther(finalBalance), 'SPARKZ');
    console.log('   Spent:', awardAmount, 'SPARKZ');

    console.log('\n✅ Full flow completed successfully!');

  } catch (error) {
    console.error('\n💥 Error:', error.message);
    if (error.reason) console.error('Reason:', error.reason);
    process.exit(1);
  }
}

runTest();
