require('dotenv').config();
const { ethers } = require('ethers');
const { processAwardFromCDR, processSpend } = require('./dist/index');

// Load treasury signer
const treasuryPrivateKey = process.env.TREASURY_SIGNER_KEY;
if (!treasuryPrivateKey) {
  console.error('TREASURY_SIGNER_KEY not configured in .env');
  process.exit(1);
}

const treasurySigner = new ethers.Wallet(treasuryPrivateKey, new ethers.JsonRpcProvider('https://rpc-amoy.polygon.technology/'));

// Derive user's wallet from UID
function generateDeterministicAddress(uid, derivationSalt) {
  const seed = ethers.solidityPacked(['string', 'string'], [uid, derivationSalt]);
  const hdNode = ethers.HDNodeWallet.fromSeed(seed);
  const wallet = hdNode.derivePath("m/44'/60'/0'/0/0");
  return wallet.address;
}

const uid = 'user-test-spend';
const derivationSalt = process.env.USER_ADDRESS_DERIVATION_SALT || 'nvf-award-core-v1';
const userAddress = generateDeterministicAddress(uid, derivationSalt);

// Sample CDR
const sampleCDR = {
  SessionID: 'sess-spend-test',
  ProviderID: 'prov-DE',
  EVSEID: 'DE*ABC*E12345',
  "Session Start": '2023-10-01T02:00:00Z',
  "Session End": '2023-10-01T03:00:00Z',
  "Consumed Energy": '40',
  UID: uid,
};

async function runFullFlow() {
  console.log('🚀 Testing full award → auto-approve → spend flow...\n');
  console.log('User UID:', uid);
  console.log('User Address:', userAddress);

  try {
    // Step 1: Award
    console.log('📍 Step 1: Executing award...');
    const awardResult = await processAwardFromCDR(sampleCDR, treasurySigner);
    
    if (!awardResult.success) {
      console.error('❌ Award failed:', awardResult.error);
      process.exit(1);
    }

    console.log('✅ Award successful');
    console.log('   Amount:', awardResult.amount, 'SPARKZ');
    console.log('   Tx Hash:', awardResult.txHash);
    console.log('   DB Stored:', awardResult.dbStored);

    // Step 2: Wait for approval to complete
    console.log('\n📍 Step 2: Waiting for auto-approval to complete...');
    console.log('   (Treasury funds user gas + calls approve)');
    
    // Wait a bit for approval to process
    await new Promise(resolve => setTimeout(resolve, 10000));
    console.log('✅ Approval window passed (transactions may still be pending)');

    // Step 3: Spend
    console.log('\n📍 Step 3: Executing spend...');
    const spendRequest = {
      userAddress: userAddress,
      amount: 10,
      sessionId: 'spend-test-session',
    };

    const spendResult = await processSpend(spendRequest, treasurySigner);

    console.log('Result:');
    console.log('   Success:', spendResult.success);
    console.log('   Amount:', spendResult.amount, 'SPARKZ');
    
    if (spendResult.txHash) {
      console.log('✅ Spend successful!');
      console.log('   Tx Hash:', spendResult.txHash);
      console.log('   🔗 View: https://amoy.polygonscan.com/tx/' + spendResult.txHash);
    } else if (spendResult.error) {
      console.log('❌ Spend failed:', spendResult.error);
      console.log('\n💡 Analysis:');
      if (spendResult.error.includes('insufficient allowance')) {
        console.log('   → Approval may not have completed yet');
        console.log('   → Check if approval tx is pending on-chain');
      } else if (spendResult.error.includes('insufficient funds')) {
        console.log('   → User may not have enough tokens');
      }
    }

  } catch (error) {
    console.error('💥 Error:', error.message);
  }
}

runFullFlow();