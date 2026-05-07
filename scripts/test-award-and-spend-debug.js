require('dotenv').config();
const { ethers } = require('ethers');
const { processAwardFromCDR, processSpend } = require('./dist/index');

// Optional: Test database connection
async function testDatabaseConnection() {
  try {
    const { getDatabase } = require('./dist/database/connection');
    const db = getDatabase();
    const result = await db.raw('SELECT NOW()');
    console.log('✅ Database connected');
    return true;
  } catch (err) {
    console.log('⚠️  Database not available:', err.message);
    console.log('   (Awards/spends will execute on-chain but won\'t be logged to DB)\n');
    return false;
  }
}

const treasuryPrivateKey = process.env.TREASURY_SIGNER_KEY;
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS;

if (!treasuryPrivateKey) {
  console.error('❌ TREASURY_SIGNER_KEY not configured in .env');
  process.exit(1);
}

const rpcUrl = 'https://rpc-amoy.polygon.technology/';
const provider = new ethers.JsonRpcProvider(rpcUrl);
const treasurySigner = new ethers.Wallet(treasuryPrivateKey, provider);
const derivationSalt = process.env.USER_ADDRESS_DERIVATION_SALT || 'nvf-award-core-v1';

const ERC20_ABI = [
  'function approve(address spender, uint256 amount) public returns (bool)',
  'function allowance(address owner, address spender) public view returns (uint256)',
  'function balanceOf(address account) public view returns (uint256)',
];

function generateDeterministicWallet(uid, salt) {
  const seed = ethers.solidityPacked(['string', 'string'], [uid, salt]);
  const hdNode = ethers.HDNodeWallet.fromSeed(seed);
  return hdNode.derivePath("m/44'/60'/0'/0/0");
}

async function runTest() {
  const testId = Math.random().toString(36).substring(7);
  const uid = `spend-test-${testId}`;
  
  console.log('🚀 Testing Award → Spend Flow with Database Logging\n');
  console.log('Test ID:', testId);
  console.log('User UID:', uid);

  // Test database connection
  const dbAvailable = await testDatabaseConnection();

  try {
    const userWallet = generateDeterministicWallet(uid, derivationSalt);
    const userAddress = userWallet.address;
    console.log('User Address:', userAddress);

    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    
    const offPeakStart = new Date(yesterday);
    offPeakStart.setHours(23, 0, 0, 0);
    
    const offPeakEnd = new Date(offPeakStart);
    offPeakEnd.setHours(23, 30, 0, 0);

    const sampleCDR = {
      SessionID: `sess-${testId}`,
      ProviderID: 'prov-DE',
      EVSEID: 'DE*ABC*E12345',
      'Session Start': offPeakStart.toISOString(),
      'Session End': offPeakEnd.toISOString(),
      'Consumed Energy': '40',
      UID: uid,
    };

    // Step 1: Award
    console.log('\n📍 Step 1: Awarding tokens...');
    const awardResult = await processAwardFromCDR(sampleCDR, treasurySigner);

    if (!awardResult.success) {
      console.error('❌ Award failed:', awardResult.error);
      process.exit(1);
    }

    const awardAmount = awardResult.amount;
    console.log('✅ Award on-chain: ' + awardAmount + ' SPARKZ');
    console.log('   Tx: ' + awardResult.txHash);
    console.log('   DB Stored:', awardResult.dbStored);
    if (awardResult.dbError) console.log('   DB Error:', awardResult.dbError);

    // Step 2: Check balance
    console.log('\n📍 Step 2: Checking balance...');
    await new Promise(resolve => setTimeout(resolve, 3000));

    const TOKEN_CONTRACT = '0x605871D30DC278a036F09e2ace771df8a224624B';
    const tokenContract = new ethers.Contract(TOKEN_CONTRACT, ERC20_ABI, provider);
    const userBalance = await tokenContract.balanceOf(userAddress);
    console.log('✅ User balance:', ethers.formatEther(userBalance), 'SPARKZ');

    // Step 3: Approve
    console.log('\n📍 Step 3: Approving for spend...');

    const userSigner = userWallet.connect(provider);
    
    const gasFundTx = await treasurySigner.sendTransaction({
      to: userAddress,
      value: ethers.parseEther('0.01'),
    });
    await gasFundTx.wait();

    const contract = new ethers.Contract(TOKEN_CONTRACT, ERC20_ABI, userSigner);
    const approveTx = await contract.approve(TREASURY_ADDRESS, ethers.parseEther(awardAmount.toString()));
    const approveReceipt = await approveTx.wait();
    console.log('✅ Approval tx: ' + approveReceipt.hash);

    // Step 4: Spend
    console.log('\n📍 Step 4: Executing spend...');

    const spendRequest = {
      userAddress: userAddress,
      amount: awardAmount,
      sessionId: `spend-${testId}`,
    };

    const spendResult = await processSpend(spendRequest, treasurySigner);

    if (!spendResult.success) {
      console.error('❌ Spend failed:', spendResult.error);
      process.exit(1);
    }

    console.log('✅ Spend on-chain: ' + spendResult.amount + ' SPARKZ');
    console.log('   Tx: ' + spendResult.txHash);
    console.log('   DB Stored:', spendResult.dbStored);
    if (spendResult.dbError) console.log('   DB Error:', spendResult.dbError);

    // Step 5: Final balance
    console.log('\n📍 Step 5: Verifying final balance...');
    await new Promise(resolve => setTimeout(resolve, 2000));
    const finalBalance = await tokenContract.balanceOf(userAddress);
    console.log('✅ Final balance:', ethers.formatEther(finalBalance), 'SPARKZ');

    console.log('\n✅ Test completed!');
    
    if (!dbAvailable) {
      console.log('\n💡 NOTE: Database logging is disabled');
      console.log('   To enable, ensure PostgreSQL is running on DATABASE_URL');
      console.log('   Run: npm run db:migrate');
    }

  } catch (error) {
    console.error('\n💥 Error:', error.message);
    process.exit(1);
  }
}

runTest();
