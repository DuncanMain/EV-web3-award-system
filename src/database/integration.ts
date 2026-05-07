import { NormalisedSession, AwardMetadata, AwardType } from '../types';
import { Users, Awards, Balances, Spends } from './service';
import { resolveUidToAddress, generateDeterministicWallet } from '../user/userService';
import { ethers } from 'ethers';

/**
 * Approve user for spending tokens (treasury-funded).
 * Sends MATIC to user wallet for gas, then calls approve() via user's derived wallet.
 * Includes retry logic for failed approvals.
 *
 * @param uid - User ID for wallet derivation
 * @param treasurySigner - Treasury signer for funding gas and getting provider
 * @param treasuryAddress - Treasury address for approval
 */
export async function approveUserForSpendingViaFunding(
  uid: string,
  treasurySigner: ethers.Signer,
  treasuryAddress: string
): Promise<void> {
  const maxRetries = 3;
  const baseDelay = 2000; // 2 seconds

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      const provider = treasurySigner.provider;
      if (!provider) throw new Error('Provider not available');

      const derivationSalt = process.env.USER_ADDRESS_DERIVATION_SALT || 'nvf-award-core-v1';

      // Derive user wallet
      const userWallet = generateDeterministicWallet(uid, derivationSalt);
      const userSigner = userWallet.connect(provider);

      // Send small amount of MATIC (0.005) to user wallet for gas
      const gasAmount = ethers.parseEther('0.005');
      const fundTx = await treasurySigner.sendTransaction({
        to: userWallet.address,
        value: gasAmount,
      });
      await fundTx.wait();

      // User now has gas - call approve via their wallet
      const contractAddress = process.env.TOKEN_CONTRACT_ADDRESS || '0x605871D30DC278a036F09e2ace771df8a224624B';
      const approveTx = await userSigner.sendTransaction({
        to: contractAddress,
        data: new ethers.Interface(['function approve(address spender, uint256 amount) public returns (bool)'])
          .encodeFunctionData('approve', [treasuryAddress, ethers.MaxUint256]),
      });
      await approveTx.wait();

      console.log(`✓ Approval completed for user ${uid} on attempt ${attempt}`);
      return; // Success - exit retry loop
  } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error(`✗ Approval attempt ${attempt}/${maxRetries} failed for user ${uid}:`, errorMsg);

      if (attempt === maxRetries) {
        // Final attempt failed
        console.error(`💀 All ${maxRetries} approval attempts failed for user ${uid} - user will be unable to spend tokens`);
        throw new Error(`Failed to approve user ${uid} after ${maxRetries} attempts: ${errorMsg}`);
      }

      // Wait before retry with exponential backoff
      const delay = baseDelay * Math.pow(2, attempt - 1); // 2s, 4s, 8s
      console.log(`⏳ Retrying approval for user ${uid} in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}

/**
 * Revoke the treasury's spending allowance on the user's derived managed wallet.
 * Called when the user switches to custodial mode so the treasury can no longer
 * call transferFrom on the managed wallet on-chain.
 *
 * Flow: treasury funds gas → derived wallet calls approve(treasury, 0)
 *
 * @param uid - User ID for wallet derivation
 * @param treasurySigner - Treasury signer (funds the tiny gas amount)
 * @param treasuryAddress - Treasury address whose allowance will be revoked
 */
export async function revokeAllowanceOnManagedWallet(
  uid: string,
  treasurySigner: ethers.Signer,
  treasuryAddress: string
): Promise<void> {
  const provider = treasurySigner.provider;
  if (!provider) throw new Error('Provider not available');

  const derivationSalt = process.env.USER_ADDRESS_DERIVATION_SALT || 'nvf-award-core-v1';
  const userWallet = generateDeterministicWallet(uid, derivationSalt);
  const userSigner = userWallet.connect(provider);

  const contractAddress = process.env.TOKEN_CONTRACT_ADDRESS || '0x605871D30DC278a036F09e2ace771df8a224624B';

  // Check current allowance — skip on-chain txs if already zero
  const tokenAbi = ['function allowance(address owner, address spender) view returns (uint256)'];
  const tokenReadonly = new ethers.Contract(contractAddress, tokenAbi, provider);
  const currentAllowance: bigint = await tokenReadonly.allowance(userWallet.address, treasuryAddress);
  if (currentAllowance === 0n) {
    console.log(`ℹ️  Allowance already zero for managed wallet of user ${uid} — skipping revoke`);
    return;
  }

  // Fund gas: send a small amount of MATIC to the derived wallet
  const gasAmount = ethers.parseEther('0.002');
  const fundTx = await treasurySigner.sendTransaction({
    to: userWallet.address,
    value: gasAmount,
  });
  await fundTx.wait();

  // Call approve(treasury, 0) from the derived wallet
  const approveTx = await userSigner.sendTransaction({
    to: contractAddress,
    data: new ethers.Interface(['function approve(address spender, uint256 amount) public returns (bool)'])
      .encodeFunctionData('approve', [treasuryAddress, 0n]),
  });
  await approveTx.wait();

  console.log(`✓ Treasury allowance revoked on managed wallet for user ${uid}`);
}

/**
 * Move all SPARKZ tokens from the user's derived managed wallet to a target address.
 * The treasury has a MaxUint256 allowance on every managed wallet, so it can call
 * transferFrom without needing the user's private key.
 *
 * @param uid              - User ID for wallet derivation
 * @param targetAddress    - Address to receive all tokens
 * @param treasurySigner   - Treasury signer (has approval on managed wallet)
 * @param tokenContractAddress - ERC20 token contract address
 * @returns txHash and human-readable amount moved
 */
export async function moveFundsFromManagedWallet(
  uid: string,
  targetAddress: string,
  treasurySigner: ethers.Signer,
  tokenContractAddress: string
): Promise<{ txHash: string; amount: string }> {
  const provider = treasurySigner.provider;
  if (!provider) throw new Error('Provider not available');

  const derivationSalt = process.env.USER_ADDRESS_DERIVATION_SALT || 'nvf-award-core-v1';
  const userWallet = generateDeterministicWallet(uid, derivationSalt);

  const tokenAbi = [
    'function balanceOf(address account) view returns (uint256)',
    'function transferFrom(address from, address to, uint256 amount) returns (bool)',
  ];
  const token = new ethers.Contract(tokenContractAddress, tokenAbi, treasurySigner);

  const balance: bigint = await token.balanceOf(userWallet.address);
  if (balance === 0n) {
    throw new Error('Managed wallet balance is already zero — nothing to move');
  }

  const tx = await token.transferFrom(userWallet.address, targetAddress, balance);
  await tx.wait();

  const amount = ethers.formatEther(balance);
  console.log(`✓ Moved ${amount} SPARKZ from managed wallet of user ${uid} to ${targetAddress} (tx: ${tx.hash})`);
  return { txHash: tx.hash as string, amount };
}

/**
 * Record an award in the database
 * Called after successful on-chain execution
 *
 * @param normalised - Normalized CDR session
 * @param amount - SPARKZ tokens awarded
 * @param dedupKey - Deduplication key for idempotency
 * @param txHash - On-chain transaction hash
 * @param cdrData - Optional raw CDR data to store
 * @param metadata - Optional peak/off-peak and timing metadata
 */
export async function recordAward(
  normalised: NormalisedSession,
  amount: number,
  dedupKey: string,
  txHash: string,
  cdrData?: string,
  metadata?: AwardMetadata
) {
  // Use the registered wallet if present, otherwise fall back to the managed wallet.
  let user = await Users.findByUid(normalised.uid);
  const walletAddress = user?.wallet_address || resolveUidToAddress(normalised.uid);
  if (!user) {
    user = await Users.create(normalised.uid, walletAddress);
  }

  // Record the award
  const award = await Awards.create({
    userId: user.id,
    sessionId: normalised.sessionId,
    providerId: normalised.providerId,
    dedupKey,
    amount: amount.toString(),
    cdrData,
    txHash,
    awardedAt: new Date(),
    awardType: metadata?.awardType,
    isOffPeak: metadata?.isOffPeak ?? false,
    countryCode: metadata?.countryCode,
    localTime: metadata?.localTime,
  });

  // Update balance for the user
  const existingBalance = await Balances.findByUser(user.id);
  const amountString = amount.toString();
  const newBalance = existingBalance
    ? (Number(existingBalance.balance) + amount).toString()
    : amountString;
  const totalAwarded = existingBalance
    ? (Number(existingBalance.total_awarded) + amount).toString()
    : amountString;
  const totalSpent = existingBalance ? existingBalance.total_spent : '0';

  await Balances.upsert({
    userId: user.id,
    walletAddress,
    balance: newBalance,
    totalAwarded,
    totalSpent,
  });

  return award;
}

export async function recordSpend(
  userWallet: string,
  amount: number,
  txHash: string,
  sessionId?: string,
  uid?: string
) {
  let user = uid ? await Users.findByUid(uid) : undefined;
  if (!user) {
    user = await Users.findByWallet(userWallet);
  }
  if (!user) {
    user = await Users.create(`wallet-${userWallet}`, userWallet);
  }

  const amountString = amount.toString();
  await Spends.create({
    userId: user.id,
    walletAddress: userWallet,
    amount: amountString,
    txHash,
    sessionId,
  });

  const existingBalance = await Balances.findByUser(user.id);
  const newBalance = existingBalance
    ? (Number(existingBalance.balance) - amount).toString()
    : '0';
  const totalAwarded = existingBalance ? existingBalance.total_awarded : '0';
  const totalSpent = existingBalance
    ? (Number(existingBalance.total_spent) + amount).toString()
    : amountString;

  await Balances.upsert({
    userId: user.id,
    walletAddress: userWallet,
    balance: newBalance,
    totalAwarded,
    totalSpent,
  });

  return {
    user,
    txHash,
  };
}

/**
 * Check if an award has already been recorded (deduplication)
 * @param dedupKey - Deduplication key
 * @returns True if award already exists in database
 */
export async function awardExists(dedupKey: string): Promise<boolean> {
  return Awards.exists(dedupKey);
}
