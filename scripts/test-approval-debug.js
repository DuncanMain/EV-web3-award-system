require('dotenv').config();
const { ethers } = require('ethers');

// Derive user's wallet
function generateDeterministicWallet(uid, derivationSalt) {
  const seed = ethers.solidityPacked(['string', 'string'], [uid, derivationSalt]);
  const hdNode = ethers.HDNodeWallet.fromSeed(seed);
  const wallet = hdNode.derivePath("m/44'/60'/0'/0/0");
  return wallet;
}

const uid = 'user-test-approve';
const derivationSalt = process.env.USER_ADDRESS_DERIVATION_SALT || 'nvf-award-core-v1';
const userWallet = generateDeterministicWallet(uid, derivationSalt);

const provider = new ethers.JsonRpcProvider('https://rpc-amoy.polygon.technology/');
const userSigner = userWallet.connect(provider);

async function testApproval() {
  console.log('🧪 Testing manual approval...\n');
  console.log('User:', userWallet.address);
  
  const contractAddress = '0x605871D30DC278a036F09e2ace771df8a224624B';
  const treasuryAddress = '0x3c67B7754EEAe43BAEc8ab82E8Dfc793B8A90C41';

  try {
    // Check user balance first
    const balanceAbi = ['function balanceOf(address account) public view returns (uint256)'];
    const contract = new ethers.Contract(contractAddress, balanceAbi, provider);
    const balance = await contract.balanceOf(userWallet.address);
    console.log('User balance:', ethers.formatEther(balance), 'tokens\n');

    // Now try approval
    console.log('Calling approve()...');
    const approveTx = await userSigner.sendTransaction({
      to: contractAddress,
      data: new ethers.Interface(['function approve(address spender, uint256 amount) public returns (bool)'])
        .encodeFunctionData('approve', [treasuryAddress, ethers.MaxUint256]),
    });

    console.log('✅ Approval tx sent:', approveTx.hash);
    console.log('Waiting for confirmation...');
    
    const receipt = await approveTx.wait();
    console.log('✅ Approval confirmed!');
    console.log('Block:', receipt.blockNumber);

  } catch (error) {
    console.error('❌ Approval failed:', error.message);
    if (error.data) {
      console.log('Error data:', error.data);
    }
  }
}

testApproval();