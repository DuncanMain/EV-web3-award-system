require('dotenv').config();
const { ethers } = require('ethers');
const { processSpend } = require('./dist/index');

// Derive user's wallet from UID
function generateDeterministicAddress(uid, derivationSalt) {
  const seed = ethers.solidityPacked(['string', 'string'], [uid, derivationSalt]);
  const hdNode = ethers.HDNodeWallet.fromSeed(seed);
  const wallet = hdNode.derivePath("m/44'/60'/0'/0/0");
  return wallet;
}

const uid = 'user-123';
const derivationSalt = process.env.USER_ADDRESS_DERIVATION_SALT || 'nvf-award-core-v1';
const userWallet = generateDeterministicAddress(uid, derivationSalt);
const userSigner = userWallet.connect(new ethers.JsonRpcProvider('https://rpc-amoy.polygon.technology/'));

// Spend request for the 10 tokens we awarded
const spendRequest = {
  userAddress: userWallet.address,
  amount: 10,
  sessionId: 'spend-test-session',
};

async function runSpendTest() {
  console.log('🚀 Running spend test with ERC20 transfer...');
  console.log('User address:', userWallet.address);
  console.log('Amount to spend:', spendRequest.amount, 'SPARKZ');

  try {
    const result = await processSpend(spendRequest, userSigner);
    
    console.log('\n📊 Spend execution result:');
    console.log('Success:', result.success);
    console.log('Amount:', result.amount, 'SPARKZ');

    if (result.txHash) {
      console.log('✅ Transaction hash:', result.txHash);
      console.log('🔗 View on PolygonScan: https://amoy.polygonscan.com/tx/' + result.txHash);
    } else if (result.error) {
      console.log('❌ Error:', result.error);
    }

    if (result.dbStored !== undefined) {
      console.log('💾 Database stored:', result.dbStored);
    }

  } catch (error) {
    console.error('💥 Error:', error.message);
  }
}

runSpendTest();