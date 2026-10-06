import { NormalisedSession, AwardMetadata, AwardType } from '../types';
import { ApprovalPreparations, Users, Awards, Balances, Spends } from './service';
import { getDatabase } from './connection';
import { resolveUidToAddress, generateDeterministicWallet } from '../user/userService';
import { ethers } from 'ethers';
import {
  canonicalTokenAmount,
  getTokenAssetContext,
  requireCanonicalTransactionHash,
  requireUnambiguousTransactionMatch,
} from './tokenOperation';
import { createHash } from 'crypto';

function normalizeTxHash(txHash: string): string {
  return txHash.trim().toLowerCase();
}

function sameTokenAmount(left: unknown, right: unknown): boolean {
  const a = canonicalTokenAmount(String(left));
  const b = canonicalTokenAmount(right);
  return !!a && !!b && a.units === b.units;
}

const approvalInterface = new ethers.Interface([
  'function approve(address spender, uint256 amount) public returns (bool)',
]);

/**
 * Estimate the native currency needed by the managed wallet's approval call.
 * The target is deliberately derived from the current chain estimate and fee
 * quote, then doubled so a small fee/estimate movement does not strand the
 * sponsored approval halfway through preparation.
 */
export async function estimateManagedApprovalGasTarget(
  provider: ethers.Provider,
  walletAddress: string,
  tokenContractAddress: string,
  treasuryAddress: string,
): Promise<bigint> {
  const data = approvalInterface.encodeFunctionData('approve', [treasuryAddress, ethers.MaxUint256]);
  const [gasLimit, feeData] = await Promise.all([
    provider.estimateGas({ from: walletAddress, to: tokenContractAddress, data }),
    provider.getFeeData(),
  ]);
  const feePerGas = feeData.maxFeePerGas ?? feeData.gasPrice;
  if (!feePerGas || feePerGas <= 0n || gasLimit <= 0n) {
    throw new Error('APPROVAL_GAS_ESTIMATE_UNAVAILABLE: chain did not return a usable gas estimate and fee quote');
  }
  return gasLimit * 2n * feePerGas;
}

type ReadOnlyApprovalRecoveryProof = {
  proved: boolean;
  reason: string;
};

/**
 * A legacy `unknown` preparation can only be resumed when read-only chain
 * data proves that the funding transfer settled and the managed wallet has
 * never accepted a transaction. If either latest or pending nonce has moved,
 * the approval may have broadcast (or another wallet transaction may have
 * consumed the nonce), so the caller remains in operator review.
 */
async function proveUnknownFundingOnlyPreparation(
  provider: ethers.Provider,
  preparation: {
    funding_tx_hash?: string | null;
    approval_tx_hash?: string | null;
  },
  walletAddress: string,
  treasurySignerAddress: string,
): Promise<ReadOnlyApprovalRecoveryProof> {
  const fundingHash = preparation.funding_tx_hash;
  if (!fundingHash || preparation.approval_tx_hash) {
    return { proved: false, reason: 'funding hash is missing or an approval hash is already present' };
  }
  try {
    // Keep these reads sequential. Some free Polygon RPC plans reject a
    // JSON-RPC batch containing more than three requests; Promise.all can
    // make ethers combine these independent reads into one oversized batch.
    const fundingReceipt = await provider.getTransactionReceipt(fundingHash);
    const fundingTransaction = await provider.getTransaction(fundingHash);
    const latestNonce = await provider.getTransactionCount(walletAddress, 'latest');
    const pendingNonce = await provider.getTransactionCount(walletAddress, 'pending');
    const expectedWallet = walletAddress.toLowerCase();
    const expectedTreasury = treasurySignerAddress.toLowerCase();
    const receiptMatches = !!fundingReceipt
      && Number(fundingReceipt.status) === 1
      && typeof fundingReceipt.to === 'string'
      && fundingReceipt.to.toLowerCase() === expectedWallet
      && typeof fundingReceipt.from === 'string'
      && fundingReceipt.from.toLowerCase() === expectedTreasury;
    const transactionMatches = !!fundingTransaction
      && normalizeTxHash(fundingTransaction.hash) === normalizeTxHash(fundingHash)
      && typeof fundingTransaction.to === 'string'
      && fundingTransaction.to.toLowerCase() === expectedWallet
      && typeof fundingTransaction.from === 'string'
      && fundingTransaction.from.toLowerCase() === expectedTreasury
      && fundingTransaction.value > 0n;
    if (!receiptMatches || !transactionMatches) {
      return { proved: false, reason: 'funding transaction receipt or sender/recipient proof did not match' };
    }
    if (latestNonce !== 0 || pendingNonce !== 0) {
      return { proved: false, reason: 'managed wallet nonce is no longer zero; an approval or other wallet transaction may have broadcast' };
    }
    return { proved: true, reason: 'confirmed funding with unchanged latest and pending wallet nonce' };
  } catch (err) {
    return {
      proved: false,
      reason: `read-only recovery proof unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

type ApprovalRecoveryDetails = {
  stage: 'funding' | 'approval' | 'preparation';
  operationKey: string;
  txHash?: string;
  durableStateWriteFailed?: boolean;
  cause?: string;
};

/**
 * Errors from a preparation that may have broadcast a transaction must carry
 * review state on the first failing request.  The API can then preserve the
 * operation key/hash and avoid treating the error as a safe preflight retry.
 */
function approvalRecoveryError(message: string, details: ApprovalRecoveryDetails): Error & ApprovalRecoveryDetails & {
  code: 'APPROVAL_PREPARATION_REVIEW_REQUIRED';
  pending: true;
  requiresReview: true;
  retryable: false;
  preflightFailure: false;
} {
  return Object.assign(new Error(message), {
    code: 'APPROVAL_PREPARATION_REVIEW_REQUIRED' as const,
    pending: true as const,
    requiresReview: true as const,
    retryable: false as const,
    preflightFailure: false as const,
    ...details,
  });
}

/**
 * Approve user for spending tokens (treasury-funded).
 * Sends MATIC to user wallet for gas, then calls approve() via user's derived wallet.
 * Performs one serialized preparation attempt; ambiguous funding/approval
 * failures are surfaced for explicit operator retry.
 *
 * @param uid - User ID for wallet derivation
 * @param treasurySigner - Treasury signer for funding gas and getting provider
 * @param treasuryAddress - Treasury address for approval
 */
export async function approveUserForSpendingViaFunding(
  uid: string,
  treasurySigner: ethers.Signer,
  treasuryAddress: string,
  requiredAmount?: number
): Promise<void> {
  const provider = treasurySigner.provider;
  if (!provider) throw new Error('Provider not available');
  const derivationSalt = process.env.USER_ADDRESS_DERIVATION_SALT || 'nvf-award-core-v1';
  const userWallet = generateDeterministicWallet(uid, derivationSalt);
  const assetContext = await getTokenAssetContext(treasurySigner, treasuryAddress);
  const contractAddress = assetContext.tokenContractAddress;
  const lockKey = `${userWallet.address.toLowerCase()}:${contractAddress}:${assetContext.chainId}:${treasuryAddress.toLowerCase()}`;
  const preparationKey = `approval:${createHash('sha256').update(lockKey).digest('hex')}`;

  await withApprovalPreparationLock(lockKey, async () => {
    const userSigner = userWallet.connect(provider);
    const tokenReadonly = new ethers.Contract(
      contractAddress,
      ['function allowance(address owner, address spender) view returns (uint256)'],
      provider,
    );
    const requiredCanonical = requiredAmount === undefined ? undefined : canonicalTokenAmount(requiredAmount);
    if (requiredAmount !== undefined && !requiredCanonical) {
      throw new Error('UNSUPPORTED_TOKEN_PRECISION: approval amount must use at most 2 decimals');
    }
    const requiredWei = requiredCanonical
      ? ethers.parseUnits(requiredCanonical.decimal, 18)
      : 1n;
    const currentAllowance: bigint = await tokenReadonly.allowance(userWallet.address, treasuryAddress);
    if (currentAllowance >= requiredWei) {
      console.log(`ℹ️  Existing token allowance covers user ${uid}; skipping approval transaction`);
      return;
    }

    const preparationClaim = await ApprovalPreparations.claim({
      operationKey: preparationKey,
      walletAddress: userWallet.address,
      tokenContractAddress: contractAddress,
      chainId: assetContext.chainId,
      treasuryAddress,
    });
    let preparation = preparationClaim.record;
    if (!preparationClaim.acquired && preparation.status === 'unknown') {
      // A previous approval call may have failed before the provider returned
      // an approval hash.  Do not infer safety from that error text.  Resume
      // only when read-only receipt, sender/recipient, and nonce checks prove
      // that the durable funding transfer settled and the managed wallet has
      // not accepted any transaction since.
      const proof = await proveUnknownFundingOnlyPreparation(
        provider,
        preparation,
        userWallet.address,
        assetContext.signerAddress,
      );
      if (!proof.proved) {
        throw approvalRecoveryError(
          `Approval preparation remains unresolved; operator review is required before another approval submission (${proof.reason})`,
          {
            stage: 'preparation',
            operationKey: preparationKey,
            txHash: preparation.approval_tx_hash || preparation.funding_tx_hash || undefined,
            cause: proof.reason,
          },
        );
      }
      const recovered = await ApprovalPreparations.recoverFundedAfterReadOnlyProof(preparationKey);
      if (!recovered) {
        const current = await ApprovalPreparations.findByKey(preparationKey);
        if (!current || current.status !== 'funded') {
          throw approvalRecoveryError(
            'Read-only approval recovery proof passed, but the durable preparation state could not be advanced safely',
            {
              stage: 'preparation',
              operationKey: preparationKey,
              txHash: preparation.funding_tx_hash || undefined,
            },
          );
        }
        preparation = current;
      } else {
        preparation = recovered;
      }
    }
    if (!preparationClaim.acquired && preparation.status !== 'funded') {
      throw approvalRecoveryError(
        `Approval preparation is retained in ${preparation.status} state for ${preparationKey}${preparation.error_message ? ` (${preparation.error_message})` : ''}`,
        {
          stage: 'preparation',
          operationKey: preparationKey,
          txHash: preparation.approval_tx_hash || preparation.funding_tx_hash || undefined,
        },
      );
    }

    // A previously confirmed funding transfer may still be below the current
    // measured target. Transition it back to `funding` before a top-up so the
    // next process cannot send another transfer while this attempt is
    // ambiguous.
    if (preparation.status === 'funded') {
      const nativeBalance = await provider.getBalance(userWallet.address);
      const gasTarget = await estimateManagedApprovalGasTarget(
        provider,
        userWallet.address,
        contractAddress,
        treasuryAddress,
      );
      if (nativeBalance < gasTarget) {
        const fundingClaim = await ApprovalPreparations.claimFundingTopUp(preparationKey);
        if (!fundingClaim.acquired) {
          throw approvalRecoveryError(
            `Managed-wallet approval gas is below the measured target, but another process owns the durable top-up attempt (${fundingClaim.record.status})`,
            {
              stage: 'funding',
              operationKey: preparationKey,
              txHash: fundingClaim.record.funding_tx_hash || preparation.funding_tx_hash || undefined,
            },
          );
        }
        preparation = fundingClaim.record;
      }
    }

    // A funding submission/confirmation error is ambiguous. The durable row
    // prevents a later request or process restart from sending another
    // funding transfer. The amount itself is measured from the approval gas
    // estimate and current fee quote instead of assuming a fixed .005.
    if (preparation.status === 'funding') {
      const nativeBalance = await provider.getBalance(userWallet.address);
      const gasTarget = await estimateManagedApprovalGasTarget(
        provider,
        userWallet.address,
        contractAddress,
        treasuryAddress,
      );
      if (nativeBalance < gasTarget) {
        const gasAmount = gasTarget - nativeBalance;
        let fundTx: ethers.TransactionResponse | undefined;
        try {
          fundTx = await treasurySigner.sendTransaction({
            to: userWallet.address,
            value: gasAmount,
          });
          await ApprovalPreparations.markFundingSubmitted(preparationKey, fundTx.hash);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          let durableStateWriteFailed = false;
          try {
            await ApprovalPreparations.markUnknown(
              preparationKey,
              `funding submission outcome is unknown: ${message}`,
              { fundingTxHash: fundTx?.hash, clearFundingHash: !fundTx?.hash },
            );
          } catch {
            durableStateWriteFailed = true;
          }
          throw approvalRecoveryError(
            `Funding submission outcome is unknown and requires operator review: ${message}`,
            {
              stage: 'funding',
              operationKey: preparationKey,
              txHash: fundTx?.hash,
              durableStateWriteFailed,
              cause: message,
            },
          );
        }
        try {
          const fundReceipt = await fundTx.wait();
          if (!fundReceipt || fundReceipt.status !== 1) {
            throw new Error(`Gas funding transaction was not confirmed successfully: ${fundTx.hash}`);
          }
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          let durableStateWriteFailed = false;
          try {
            await ApprovalPreparations.markUnknown(
              preparationKey,
              `funding confirmation outcome is unknown: ${message}`,
              { fundingTxHash: fundTx.hash },
            );
          } catch {
            durableStateWriteFailed = true;
          }
          throw approvalRecoveryError(
            `Funding confirmation outcome is unknown and requires operator review: ${message}`,
            {
              stage: 'funding',
              operationKey: preparationKey,
              txHash: fundTx.hash,
              durableStateWriteFailed,
              cause: message,
            },
          );
        }
      }
      try {
        await ApprovalPreparations.markFunded(preparationKey);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw approvalRecoveryError(
          `Funding is confirmed but its durable preparation state could not be saved: ${message}`,
          {
            stage: 'funding',
            operationKey: preparationKey,
            txHash: preparation.funding_tx_hash || undefined,
            cause: message,
          },
        );
      }
    }

    // A conditional durable transition gives exactly one process permission
    // to submit approval. If the process dies after broadcast, every later
    // request sees `approving`/`unknown` and refuses to rebroadcast.
    const approvalClaim = await ApprovalPreparations.claimApprovalSubmission(preparationKey);
    if (!approvalClaim.acquired) {
      const retained = approvalClaim.record;
      throw approvalRecoveryError(
        `Approval preparation is retained in ${retained.status} state for ${preparationKey}; operator review is required before another submission`,
        {
          stage: 'approval',
          operationKey: preparationKey,
          txHash: retained.approval_tx_hash || retained.funding_tx_hash || undefined,
        },
      );
    }

    let approveTx: ethers.TransactionResponse | undefined;
    try {
      approveTx = await userSigner.sendTransaction({
        to: contractAddress,
        data: approvalInterface.encodeFunctionData('approve', [treasuryAddress, ethers.MaxUint256]),
      });
      await ApprovalPreparations.markApprovalSubmitted(preparationKey, approveTx.hash);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      let durableStateWriteFailed = false;
      try {
        await ApprovalPreparations.markUnknown(preparationKey, `approval submission outcome is unknown: ${message}`);
      } catch {
        durableStateWriteFailed = true;
      }
      throw approvalRecoveryError(
        `Approval submission outcome is unknown and requires operator review: ${message}`,
        {
          stage: 'approval',
          operationKey: preparationKey,
          txHash: approveTx?.hash,
          durableStateWriteFailed,
          cause: message,
        },
      );
    }
    try {
      const approveReceipt = await approveTx.wait();
      if (!approveReceipt || approveReceipt.status !== 1) {
        throw new Error(`Approval transaction was not confirmed successfully: ${approveTx.hash}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      let durableStateWriteFailed = false;
      try {
        await ApprovalPreparations.markUnknown(preparationKey, `approval confirmation outcome is unknown: ${message}`);
      } catch {
        durableStateWriteFailed = true;
      }
      throw approvalRecoveryError(
        `Approval confirmation outcome is unknown and requires operator review: ${message}`,
        {
          stage: 'approval',
          operationKey: preparationKey,
          txHash: approveTx.hash,
          durableStateWriteFailed,
          cause: message,
        },
      );
    }
    try {
      await ApprovalPreparations.markApproved(preparationKey);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw approvalRecoveryError(
        `Approval is confirmed but its durable preparation state could not be saved: ${message}`,
        {
          stage: 'approval',
          operationKey: preparationKey,
          txHash: approveTx.hash,
          cause: message,
        },
      );
    }
    console.log(`✓ Approval completed for user ${uid}`);
  });
}

const approvalPreparationLocks = new Map<string, Promise<void>>();

async function withApprovalPreparationLock<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = approvalPreparationLocks.get(key);
  let release!: () => void;
  const current = new Promise<void>(resolve => { release = resolve; });
  approvalPreparationLocks.set(key, current);
  if (previous) await previous;
  try {
    return await work();
  } finally {
    release();
    if (approvalPreparationLocks.get(key) === current) approvalPreparationLocks.delete(key);
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
  metadata?: AwardMetadata,
  intendedWalletAddress?: string
) {
  const db = getDatabase();
  const normalizedHash = requireCanonicalTransactionHash(txHash);
  const canonicalAmount = canonicalTokenAmount(amount);
  if (!canonicalAmount) throw new Error('UNSUPPORTED_TOKEN_PRECISION');
  const walletForLock = (intendedWalletAddress || resolveUidToAddress(normalised.uid)).toLowerCase();
  return db.transaction(async trx => {
    await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`award-tx:${normalizedHash}`]);
    await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`award-dedup:${dedupKey}`]);
    await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`balance-user:${normalised.uid}:${walletForLock}`]);
    // A transaction hash is the chain-level idempotency key.  If a retry gets
    // here after a confirmed transfer, return the original projection rather
    // than inserting another ledger row or applying balance twice.
    const txHashMatches = await trx('awards')
      .whereRaw('lower(tx_hash) = lower(?)', [normalizedHash])
      .limit(2);
    const byTxHash = requireUnambiguousTransactionMatch(txHashMatches, 'award');
    if (byTxHash) {
      if (byTxHash.session_id !== normalised.sessionId || byTxHash.provider_id !== normalised.providerId
        || byTxHash.dedup_key !== dedupKey || !sameTokenAmount(byTxHash.amount, canonicalAmount.decimal)) {
        throw new Error('AWARD_TX_HASH_INTENT_MISMATCH');
      }
      if (intendedWalletAddress) {
        const owner = await trx('users').where({ id: byTxHash.user_id }).first();
        if (!owner || owner.uid !== normalised.uid
          || owner.wallet_address.toLowerCase() !== intendedWalletAddress.toLowerCase()) {
          throw new Error('AWARD_TX_HASH_OWNER_MISMATCH');
        }
      }
      return byTxHash;
    }

    const byDedup = await trx('awards').where({ dedup_key: dedupKey }).first();
    if (byDedup) {
      if (byDedup.session_id !== normalised.sessionId || byDedup.provider_id !== normalised.providerId
        || !sameTokenAmount(byDedup.amount, canonicalAmount.decimal)) {
        throw new Error('AWARD_DEDUP_INTENT_MISMATCH');
      }
      if (intendedWalletAddress) {
        const owner = await trx('users').where({ id: byDedup.user_id }).first();
        if (!owner || owner.uid !== normalised.uid
          || owner.wallet_address.toLowerCase() !== intendedWalletAddress.toLowerCase()) {
          throw new Error('AWARD_DEDUP_OWNER_MISMATCH');
        }
      }
      return byDedup;
    }

    // Use the registered wallet if present, otherwise fall back to the managed wallet.
    let user = intendedWalletAddress
      ? await trx('users')
        .where({ uid: normalised.uid })
        .whereRaw('lower(wallet_address) = lower(?)', [intendedWalletAddress])
        .first()
      : await trx('users').where({ uid: normalised.uid }).orderBy('created_at', 'asc').first();
    const walletAddress = user?.wallet_address || intendedWalletAddress || resolveUidToAddress(normalised.uid);
    if (!user) {
      const [created] = await trx('users').insert({
        uid: normalised.uid,
        wallet_address: walletAddress,
        wallet_name: null,
      }).returning('*');
      user = created;
    }

    const awardedAt = new Date();
    const [award] = await trx('awards').insert({
        user_id: user.id,
        session_id: normalised.sessionId,
        provider_id: normalised.providerId,
        dedup_key: dedupKey,
        amount: canonicalAmount.decimal,
        cdr_data: cdrData || null,
        tx_hash: normalizedHash,
        awarded_at: awardedAt,
        award_type: metadata?.awardType || null,
        is_off_peak: metadata?.isOffPeak ?? false,
        country_code: metadata?.countryCode || null,
        local_time: metadata?.localTime || null,
        status: 'confirmed',
        error_message: null,
        confirmed_at: awardedAt,
      }).returning('*');

    // Balance projection is part of the same transaction as the award row.
    // SQL arithmetic avoids the lost-update race from read/modify/write.
    const balance = await trx('balances').where({ user_id: user.id }).first();
    if (balance) {
      await trx('balances').where({ user_id: user.id }).update({
        balance: trx.raw('balance + ?', [canonicalAmount.decimal]),
        total_awarded: trx.raw('total_awarded + ?', [canonicalAmount.decimal]),
        last_synced: trx.fn.now(),
        updated_at: trx.fn.now(),
      });
    } else {
      await trx('balances').insert({
        user_id: user.id,
        wallet_address: walletAddress,
        balance: canonicalAmount.decimal,
        total_awarded: canonicalAmount.decimal,
        total_spent: '0',
      });
    }

    return award;
  });
}

export async function recordSpend(
  userWallet: string,
  amount: number,
  txHash: string,
  sessionId?: string,
  uid?: string
) {
  const db = getDatabase();
  const normalizedHash = requireCanonicalTransactionHash(txHash);
  const canonicalAmount = canonicalTokenAmount(amount);
  if (!canonicalAmount) throw new Error('UNSUPPORTED_TOKEN_PRECISION');
  return db.transaction(async trx => {
    await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`spend-tx:${normalizedHash}`]);
    await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`balance-user:${uid || ''}:${userWallet.toLowerCase()}`]);
    const spendHashMatches = await trx('spends')
      .whereRaw('lower(tx_hash) = lower(?)', [normalizedHash])
      .limit(2);
    const existingSpend = requireUnambiguousTransactionMatch(spendHashMatches, 'spend');
    if (existingSpend) {
      if (!sameTokenAmount(existingSpend.amount, canonicalAmount.decimal)
        || existingSpend.wallet_address.toLowerCase() !== userWallet.toLowerCase()
        || (sessionId || null) !== (existingSpend.session_id || null)) {
        throw new Error('SPEND_TX_HASH_INTENT_MISMATCH');
      }
      const user = await trx('users').where({ id: existingSpend.user_id }).first();
      if (uid && (!user || user.uid !== uid)) {
        throw new Error('SPEND_TX_HASH_OWNER_MISMATCH');
      }
      return { user, txHash };
    }

    let user = uid
      ? await trx('users')
        .where({ uid })
        .whereRaw('lower(wallet_address) = lower(?)', [userWallet])
        .orderBy('created_at', 'asc')
        .first()
      : undefined;
    if (!user && !uid) {
      user = await trx('users')
        .whereRaw('lower(wallet_address) = lower(?)', [userWallet])
        .orderBy('created_at', 'asc')
        .first();
    }
    if (!user) {
      const [created] = await trx('users').insert({
        uid: uid || `wallet-${userWallet}`,
        wallet_address: userWallet,
        wallet_name: null,
      }).returning('*');
      user = created;
    }

    const amountString = canonicalAmount.decimal;
    const confirmedAt = new Date();
    const [spend] = await trx('spends').insert({
        user_id: user.id,
        wallet_address: userWallet,
        amount: amountString,
        tx_hash: normalizedHash,
        session_id: sessionId || null,
        status: 'confirmed',
        error_message: null,
        confirmed_at: confirmedAt,
      }).returning('*');

    const balance = await trx('balances').where({ user_id: user.id }).first();
    if (balance) {
      await trx('balances').where({ user_id: user.id }).update({
        balance: trx.raw('balance - ?', [amountString]),
        total_spent: trx.raw('total_spent + ?', [amountString]),
        last_synced: trx.fn.now(),
        updated_at: trx.fn.now(),
      });
    } else {
      await trx('balances').insert({
        user_id: user.id,
        wallet_address: userWallet,
        // No authoritative opening balance is available in this projection.
        // Apply the known spend delta to zero so the mirror exposes the
        // deficit instead of silently omitting the movement. Chain balance
        // remains the authority for shared/external wallets.
        balance: `-${amountString}`,
        total_awarded: '0',
        total_spent: amountString,
      });
    }

    return { user, txHash, spend };
  });
}

/**
 * Check if an award has already been recorded (deduplication)
 * @param dedupKey - Deduplication key
 * @returns True if award already exists in database
 */
export async function awardExists(dedupKey: string): Promise<boolean> {
  return Awards.exists(dedupKey);
}
