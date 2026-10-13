import { NormalisedSession, AwardMetadata, AwardType } from '../types';
import type { TransactionDiagnostic } from '../types';
import { ApprovalPreparations, TreasuryTransactions, Users, Awards, Balances, Spends } from './service';
import { getDatabase } from './connection';
import { resolveUidToAddress, generateDeterministicWallet } from '../user/userService';
import { ethers } from 'ethers';
import {
  canonicalTokenAmount,
  getTokenAssetContext,
  requireCanonicalTransactionHash,
  requireUnambiguousTransactionMatch,
} from './tokenOperation';
import { createHash, randomUUID } from 'crypto';
import {
  createTransactionDiagnostic,
  isPreBroadcastTransactionDiagnostic,
  prepareAndBroadcastTransaction,
  TransactionReliabilityError,
} from '../transactionReliability';
import { isTransientRpcReadError, withNullableRpcReadRetry, withRpcReadRetry } from '../rpcProvider';
import { verifySpendEvidence } from '../spendEvidence';
import type { SpendEvidenceFailure } from '../spendEvidence';

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
const managedMoveInterface = new ethers.Interface([
  'function transferFrom(address from,address to,uint256 amount)',
]);

function standaloneActionSuffix(actionKey?: string): string {
  const source = actionKey?.trim() || randomUUID();
  if (source.length > 240) throw new Error('STANDALONE_ACTION_KEY_TOO_LONG');
  return createHash('sha256').update(source).digest('hex');
}

async function reconcileOriginalNativeTransfer(
  provider: ethers.Provider,
  tx: {
    txHash: string;
    context: { signerAddress: string; to: string; value: string };
  },
  label: string,
): Promise<void> {
  let transaction: ethers.TransactionResponse | null;
  let receipt: ethers.TransactionReceipt | null;
  try {
    transaction = await withNullableRpcReadRetry(() => provider.getTransaction(tx.txHash));
    receipt = await withNullableRpcReadRetry(() => provider.getTransactionReceipt(tx.txHash));
  } catch (error) {
    throw new Error(`${label} original transaction evidence is unavailable; operator review is required: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!transaction || !receipt) {
    throw new Error(`${label} original transaction is still pending; operator review is required`);
  }
  if (transaction.hash.toLowerCase() !== tx.txHash.toLowerCase()
    || transaction.from.toLowerCase() !== tx.context.signerAddress.toLowerCase()
    || transaction.to?.toLowerCase() !== tx.context.to.toLowerCase()
    || transaction.value !== BigInt(tx.context.value)) {
    throw new Error(`${label} original transaction intent does not match its saved signing context; operator review is required`);
  }
  if (Number(receipt.status) !== 1) {
    throw new Error(`${label} original transaction failed on-chain; operator review is required`);
  }
}

type ManagedMoveOutcome = 'unknown' | 'no_movement' | 'review';

/**
 * Preserve the original standalone move identity when confirmation or
 * duplicate evidence fails. The saved hash is never replaced and this path
 * deliberately has no broadcast call.
 */
async function throwManagedMoveFailure(
  operationKey: string,
  tx: { txHash: string; context: { nonce: number | string } },
  diagnostic: TransactionDiagnostic,
  message: string,
  movementOutcome: ManagedMoveOutcome,
): Promise<never> {
  let durableStateWriteFailed = false;
  try {
    if (movementOutcome === 'no_movement') {
      await TreasuryTransactions.markFailed(operationKey, diagnostic, message);
    } else {
      await TreasuryTransactions.markUnknown(operationKey, diagnostic, message);
    }
  } catch {
    durableStateWriteFailed = true;
  }
  const failure = Object.assign(new TransactionReliabilityError(diagnostic), {
    code: diagnostic.errorCode,
    message,
    operationKey,
    txHash: tx.txHash,
    nonce: Number(tx.context.nonce),
    pending: diagnostic.retryable,
    requiresReview: movementOutcome === 'review',
    movementOutcome,
    durableStateWriteFailed,
  });
  throw failure;
}

/**
 * Surface a managed-wallet preflight failure with the same structured fields
 * used after a durable lease exists. No treasury lease is created before this
 * helper runs, so the result proves that no token movement was attempted.
 */
function throwManagedMovePreflightFailure(
  operationKey: string,
  diagnostic: TransactionDiagnostic,
  message: string,
): never {
  const failure = Object.assign(new TransactionReliabilityError(diagnostic), {
    code: diagnostic.errorCode,
    errorCode: diagnostic.errorCode,
    stage: diagnostic.stage,
    operationKey,
    txHash: diagnostic.savedHash || null,
    ...(diagnostic.nonce === undefined ? {} : { nonce: diagnostic.nonce }),
    pending: diagnostic.retryable,
    requiresReview: false,
    retryable: diagnostic.retryable,
    preflightFailure: true,
    movementOutcome: 'no_movement' as const,
    message,
  });
  throw failure;
}

function throwManagedMovePreparationFailure(
  operationKey: string,
  error: unknown,
): never {
  const diagnostic = error instanceof TransactionReliabilityError
    ? error.diagnostic
    : createTransactionDiagnostic('prepare', 'TRANSACTION_PREPARATION_FAILED', error, {
      retryable: false,
      category: 'preflight',
    });
  const requiresReview = diagnostic.category === 'review_required' || !isPreBroadcastTransactionDiagnostic(diagnostic);
  const movementOutcome: ManagedMoveOutcome = requiresReview
    ? (diagnostic.savedHash ? 'unknown' : 'review')
    : 'no_movement';
  const failure = Object.assign(
    error instanceof Error ? error : new Error(diagnostic.errorCode),
    {
      code: diagnostic.errorCode,
      errorCode: diagnostic.errorCode,
      diagnostic,
      operationKey,
      txHash: diagnostic.savedHash || null,
      ...(diagnostic.nonce === undefined ? {} : { nonce: diagnostic.nonce }),
      pending: diagnostic.savedHash ? true : diagnostic.retryable,
      requiresReview,
      retryable: diagnostic.retryable,
      preflightFailure: isPreBroadcastTransactionDiagnostic(diagnostic),
      movementOutcome,
    },
  );
  throw failure;
}

function throwManagedFundingFailure(
  operationKey: string,
  error: unknown,
  fallback: {
    stage: TransactionDiagnostic['stage'];
    rpcMethod: string;
    savedHash?: string;
  },
): never {
  const sourceDiagnostic = error instanceof TransactionReliabilityError ? error.diagnostic : undefined;
  const diagnostic = sourceDiagnostic || createTransactionDiagnostic(
    fallback.stage,
    fallback.stage === 'receipt' ? 'RECEIPT_READ_UNAVAILABLE' : 'RPC_READ_UNAVAILABLE',
    error,
    {
      rpcMethod: fallback.rpcMethod,
      retryable: isTransientRpcReadError(error),
      category: isTransientRpcReadError(error) ? 'confirmation_pending' : 'review_required',
      ...(fallback.savedHash ? { savedHash: fallback.savedHash } : {}),
    },
  );
  const fundingTxHash = diagnostic.savedHash || fallback.savedHash;
  const publicDiagnostic: TransactionDiagnostic = {
    ...diagnostic,
    ...(fundingTxHash ? {} : { savedHash: undefined }),
  };
  delete publicDiagnostic.savedHash;
  const preBroadcast = isPreBroadcastTransactionDiagnostic(diagnostic);
  const requiresReview = diagnostic.category === 'review_required' || !preBroadcast;
  const failure = Object.assign(
    error instanceof Error ? error : new Error(diagnostic.errorCode),
    {
      code: diagnostic.errorCode,
      errorCode: diagnostic.errorCode,
      diagnostic: publicDiagnostic,
      operationKey,
      txHash: null,
      fundingTxHash,
      ...(diagnostic.nonce === undefined ? {} : { nonce: diagnostic.nonce }),
      pending: fundingTxHash ? true : diagnostic.retryable,
      requiresReview,
      retryable: diagnostic.retryable,
      preflightFailure: preBroadcast,
      movementOutcome: (requiresReview ? 'review' : preBroadcast ? 'no_movement' : 'unknown') as ManagedMoveOutcome,
    },
  );
  throw failure;
}

function managedMoveEvidenceDiagnostic(
  tx: { txHash: string; context: { nonce: number | string } },
  failure: SpendEvidenceFailure,
): TransactionDiagnostic {
  return {
    stage: 'receipt',
    category: failure.pending ? 'confirmation_pending' : 'review_required',
    ...(failure.diagnostic || {}),
    rpcMethod: failure.diagnostic?.rpcMethod || 'spendEvidence.read',
    errorCode: failure.code,
    retryable: failure.diagnostic?.retryable ?? failure.pending,
    savedHash: tx.txHash,
    nonce: Number(tx.context.nonce),
  };
}

function managedMoveReceiptDiagnostic(
  tx: { txHash: string; context: { nonce: number | string } },
  error?: unknown,
  receipt?: ethers.TransactionReceipt | null,
): { diagnostic: TransactionDiagnostic; movementOutcome: ManagedMoveOutcome; message: string } {
  if (error) {
    const retryable = isTransientRpcReadError(error);
    return {
      diagnostic: createTransactionDiagnostic('receipt', 'RECEIPT_READ_UNAVAILABLE', error, {
        rpcMethod: 'provider.waitForTransaction',
        retryable,
        category: retryable ? 'confirmation_pending' : 'review_required',
        savedHash: tx.txHash,
        nonce: Number(tx.context.nonce),
      }),
      movementOutcome: retryable ? 'unknown' : 'review',
      message: `Managed-wallet transfer receipt lookup failed for original transaction ${tx.txHash}`,
    };
  }
  if (!receipt) {
    return {
      diagnostic: createTransactionDiagnostic('receipt', 'RECEIPT_PENDING', undefined, {
        rpcMethod: 'provider.waitForTransaction',
        retryable: true,
        category: 'confirmation_pending',
        savedHash: tx.txHash,
        nonce: Number(tx.context.nonce),
      }),
      movementOutcome: 'unknown',
      message: `Managed-wallet transfer receipt is still pending for original transaction ${tx.txHash}`,
    };
  }
  if (Number(receipt.status) === 0) {
    return {
      diagnostic: createTransactionDiagnostic('receipt', 'TRANSACTION_FAILED', undefined, {
        rpcMethod: 'provider.waitForTransaction',
        retryable: false,
        category: 'review_required',
        savedHash: tx.txHash,
        nonce: Number(tx.context.nonce),
      }),
      movementOutcome: 'no_movement',
      message: `Managed-wallet transfer mined with a failed receipt for original transaction ${tx.txHash}; no replacement was submitted`,
    };
  }
  return {
    diagnostic: createTransactionDiagnostic('receipt', 'MALFORMED_RECEIPT', undefined, {
      rpcMethod: 'provider.waitForTransaction',
      retryable: false,
      category: 'review_required',
      savedHash: tx.txHash,
      nonce: Number(tx.context.nonce),
    }),
    movementOutcome: 'review',
    message: `Managed-wallet transfer returned an invalid receipt status for original transaction ${tx.txHash}`,
  };
}

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
  const gasLimit = await withRpcReadRetry(
    () => provider.estimateGas({ from: walletAddress, to: tokenContractAddress, data }),
  );
  const feeData = await withRpcReadRetry(() => provider.getFeeData());
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
    const fundingReceipt = await withNullableRpcReadRetry(() => provider.getTransactionReceipt(fundingHash));
    const fundingTransaction = await withNullableRpcReadRetry(() => provider.getTransaction(fundingHash));
    const latestNonce = await withRpcReadRetry(() => provider.getTransactionCount(walletAddress, 'latest'));
    const pendingNonce = await withRpcReadRetry(() => provider.getTransactionCount(walletAddress, 'pending'));
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
  /** Native treasury funding hash, kept separate from approval/SPARKZ hashes. */
  fundingTxHash?: string;
  diagnostic?: TransactionDiagnostic;
  durableStateWriteFailed?: boolean;
  cause?: string;
  movementOutcome?: 'unknown' | 'no_movement' | 'confirmed' | 'review';
};

/**
 * Errors from a preparation that may have broadcast a transaction must carry
 * review state on the first failing request.  The API can then preserve the
 * operation key/hash and avoid treating the error as a safe preflight retry.
 */
function approvalRecoveryError(
  message: string,
  details: ApprovalRecoveryDetails,
  options: {
    pending?: boolean;
    requiresReview?: boolean;
    retryable?: boolean;
    preflightFailure?: boolean;
  } = {},
): Error & ApprovalRecoveryDetails & {
  code: 'APPROVAL_PREPARATION_REVIEW_REQUIRED';
  pending: boolean;
  requiresReview: boolean;
  retryable: boolean;
  preflightFailure: boolean;
  diagnostic?: TransactionDiagnostic;
  fundingTxHash?: string;
} {
  const retryable = options.retryable ?? false;
  return Object.assign(new Error(message), {
    code: 'APPROVAL_PREPARATION_REVIEW_REQUIRED' as const,
    pending: options.pending ?? true,
    requiresReview: options.requiresReview ?? true,
    retryable,
    preflightFailure: options.preflightFailure ?? false,
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
    const currentAllowance: bigint = await withRpcReadRetry(
      () => tokenReadonly.allowance(userWallet.address, treasuryAddress) as Promise<bigint>,
    );
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
            ...(preparation.approval_tx_hash
              ? { txHash: preparation.approval_tx_hash }
              : { fundingTxHash: preparation.funding_tx_hash || undefined }),
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
              fundingTxHash: preparation.funding_tx_hash || undefined,
            },
          );
        }
        preparation = current;
      } else {
        preparation = recovered;
      }
    }
    const resumableFundingAttempt = preparation.status === 'funding'
      && Boolean(preparation.funding_attempt_key);
    if (!preparationClaim.acquired && preparation.status !== 'funded' && !resumableFundingAttempt) {
      throw approvalRecoveryError(
        `Approval preparation is retained in ${preparation.status} state for ${preparationKey}${preparation.error_message ? ` (${preparation.error_message})` : ''}`,
        {
          stage: 'preparation',
          operationKey: preparationKey,
          ...(preparation.approval_tx_hash
            ? { txHash: preparation.approval_tx_hash }
            : { fundingTxHash: preparation.funding_tx_hash || undefined }),
        },
      );
    }

    let fundingAttemptKey = preparation.funding_attempt_key || undefined;
    let fundingAttemptValue = preparation.funding_attempt_value || undefined;

    // A previously confirmed funding transfer may still be below the current
    // measured target. Transition it back to `funding` before a top-up so the
    // next process cannot send another transfer while this attempt is
    // ambiguous.
    if (preparation.status === 'funded') {
      const nativeBalance = await withRpcReadRetry(() => provider.getBalance(userWallet.address));
      const gasTarget = await estimateManagedApprovalGasTarget(
        provider,
        userWallet.address,
        contractAddress,
        treasuryAddress,
      );
      if (nativeBalance < gasTarget) {
        fundingAttemptValue = (gasTarget - nativeBalance).toString();
        // A confirmed preparation may later need another top-up for the
        // same amount. Give each newly claimed top-up its own durable lease
        // identity; retries use the key persisted by claimFundingTopUp.
        fundingAttemptKey = `${preparationKey}:topup:${randomUUID()}`;
        const fundingClaim = await ApprovalPreparations.claimFundingTopUp(
          preparationKey,
          fundingAttemptKey,
          fundingAttemptValue,
        );
        if (!fundingClaim.acquired) {
          throw approvalRecoveryError(
            `Managed-wallet approval gas is below the measured target, but another process owns the durable top-up attempt (${fundingClaim.record.status})`,
            {
              stage: 'funding',
              operationKey: preparationKey,
              fundingTxHash: fundingClaim.record.funding_tx_hash || preparation.funding_tx_hash || undefined,
            },
          );
        }
        preparation = fundingClaim.record;
        fundingAttemptKey = preparation.funding_attempt_key || fundingAttemptKey;
        fundingAttemptValue = preparation.funding_attempt_value || fundingAttemptValue;
      }
    }

    // A funding submission/confirmation error is ambiguous. The durable row
    // prevents a later request or process restart from sending another
    // funding transfer. The amount itself is measured from the approval gas
    // estimate and current fee quote instead of assuming a fixed .005.
    if (preparation.status === 'funding') {
      let gasAmount: bigint | undefined;
      if (fundingAttemptValue) {
        try {
          gasAmount = BigInt(fundingAttemptValue);
        } catch {
          throw approvalRecoveryError(
            'Managed-wallet approval funding attempt has an invalid durable amount; operator review is required',
            {
              stage: 'funding',
              operationKey: preparationKey,
              cause: 'invalid funding_attempt_value',
            },
          );
        }
      } else {
        const nativeBalance = await withRpcReadRetry(() => provider.getBalance(userWallet.address));
        const gasTarget = await estimateManagedApprovalGasTarget(
          provider,
          userWallet.address,
          contractAddress,
          treasuryAddress,
        );
        if (nativeBalance < gasTarget) gasAmount = gasTarget - nativeBalance;
      }
      if (fundingAttemptValue && (!gasAmount || gasAmount <= 0n)) {
        throw approvalRecoveryError(
          'Managed-wallet approval funding attempt has a non-positive durable amount; operator review is required',
          {
            stage: 'funding',
            operationKey: preparationKey,
            cause: 'invalid funding_attempt_value',
          },
        );
      }
      if (gasAmount && gasAmount > 0n) {
        let fundingResult: Awaited<ReturnType<typeof prepareAndBroadcastTransaction>> | undefined;
        let fundingWasAlreadyPrepared = false;
        const fundingOperationKey = fundingAttemptKey || `${preparationKey}:funding:${gasAmount.toString()}`;
        try {
          fundingResult = await prepareAndBroadcastTransaction({
            operationKey: fundingOperationKey,
            targetOperationKey: preparationKey,
            targetType: 'approval_funding',
            signer: treasurySigner,
            chainId: preparation.chain_id,
            to: userWallet.address,
            value: gasAmount,
          });
          if (fundingResult.alreadyPrepared) {
            // A process may have restarted after the original lease was
            // submitted but before this approval row was advanced. Reconcile
            // that exact saved hash read-only before any approval side effect;
            // never create a replacement funding transfer for the same key.
            await reconcileOriginalNativeTransfer(
              provider,
              fundingResult,
              'Managed-wallet approval gas funding',
            );
            fundingWasAlreadyPrepared = true;
          }
          await ApprovalPreparations.markFundingSubmitted(
            preparationKey,
            fundingResult.txHash,
            {
              nonce: fundingResult.context.nonce,
              context: fundingResult.context,
              attemptKey: fundingOperationKey,
            },
          );
        } catch (err) {
          const diagnostic = err instanceof TransactionReliabilityError ? err.diagnostic : undefined;
          const message = diagnostic?.errorCode || (err instanceof Error ? err.message : String(err));
          if (diagnostic && isPreBroadcastTransactionDiagnostic(diagnostic)) {
            let durableStateWriteFailed = false;
            try {
              await ApprovalPreparations.markFundingPreflightFailed(
                preparationKey,
                message,
                diagnostic,
              );
            } catch {
              durableStateWriteFailed = true;
            }
            throw approvalRecoveryError(
              `Funding preparation failed before broadcast; no movement was attempted: ${message}`,
              {
                stage: 'funding',
                operationKey: preparationKey,
                durableStateWriteFailed,
                cause: message,
                movementOutcome: 'no_movement',
                diagnostic,
              },
              {
                pending: diagnostic.retryable,
                requiresReview: false,
                retryable: diagnostic.retryable,
                preflightFailure: true,
              },
            );
          }
          let durableStateWriteFailed = false;
          const savedFundingHash = diagnostic?.savedHash
            || fundingResult?.txHash
            || preparation.funding_tx_hash
            || undefined;
          try {
            await ApprovalPreparations.markUnknown(
              preparationKey,
              `funding submission requires review: ${message}`,
              {
                fundingTxHash: savedFundingHash,
                fundingAttemptKey: fundingOperationKey,
                clearFundingHash: !savedFundingHash,
                diagnostic,
              },
            );
          } catch {
            durableStateWriteFailed = true;
          }
          throw approvalRecoveryError(
            `Funding submission outcome is unknown and requires operator review: ${message}`,
            {
              stage: 'funding',
              operationKey: preparationKey,
              fundingTxHash: savedFundingHash,
              diagnostic,
              durableStateWriteFailed,
              cause: message,
            },
          );
        }
        if (!fundingWasAlreadyPrepared) {
          try {
            const fundReceipt = await withNullableRpcReadRetry(() => provider.waitForTransaction(fundingResult!.txHash));
            if (!fundReceipt || fundReceipt.status !== 1) {
              throw new Error(`Gas funding transaction was not confirmed successfully: ${fundingResult!.txHash}`);
            }
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            const diagnostic = createTransactionDiagnostic(
              'receipt',
              'RECEIPT_READ_UNAVAILABLE',
              err,
              {
                rpcMethod: 'provider.waitForTransaction',
                retryable: isTransientRpcReadError(err),
                category: 'confirmation_pending',
                savedHash: fundingResult!.txHash,
                nonce: fundingResult!.context.nonce,
              },
            );
            let durableStateWriteFailed = false;
            try {
              await ApprovalPreparations.markUnknown(
                preparationKey,
                `funding confirmation outcome is unknown: ${message}`,
                {
                  fundingTxHash: fundingResult!.txHash,
                  fundingAttemptKey: fundingOperationKey,
                  diagnostic,
                },
              );
            } catch {
              durableStateWriteFailed = true;
            }
            throw approvalRecoveryError(
              `Funding confirmation outcome is unknown and requires operator review: ${message}`,
              {
                stage: 'funding',
                operationKey: preparationKey,
                fundingTxHash: fundingResult!.txHash,
                diagnostic,
                durableStateWriteFailed,
                cause: message,
              },
            );
          }
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
            fundingTxHash: preparation.funding_tx_hash || undefined,
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
          ...(retained.approval_tx_hash
            ? { txHash: retained.approval_tx_hash }
            : { fundingTxHash: retained.funding_tx_hash || undefined }),
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
      const diagnostic = createTransactionDiagnostic(
        'broadcast',
        'APPROVAL_SUBMISSION_OUTCOME_UNKNOWN',
        err,
        {
          rpcMethod: 'signer.sendTransaction',
          retryable: false,
          category: 'review_required',
          ...(approveTx?.hash ? { savedHash: approveTx.hash } : {}),
        },
      );
      let durableStateWriteFailed = false;
      try {
        await ApprovalPreparations.markUnknown(
          preparationKey,
          `approval submission outcome is unknown: ${message}`,
          { diagnostic },
        );
      } catch {
        durableStateWriteFailed = true;
      }
      throw approvalRecoveryError(
        `Approval submission outcome is unknown and requires operator review: ${message}`,
        {
          stage: 'approval',
          operationKey: preparationKey,
          txHash: approveTx?.hash,
          diagnostic,
          durableStateWriteFailed,
          cause: message,
        },
      );
    }
    try {
      const approveReceipt = await withNullableRpcReadRetry(() => approveTx!.wait());
      if (!approveReceipt || approveReceipt.status !== 1) {
        throw new Error(`Approval transaction was not confirmed successfully: ${approveTx.hash}`);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const diagnostic = createTransactionDiagnostic(
        'receipt',
        'RECEIPT_READ_UNAVAILABLE',
        err,
        {
          rpcMethod: 'transaction.wait',
          retryable: isTransientRpcReadError(err),
          category: 'confirmation_pending',
          savedHash: approveTx.hash,
        },
      );
      let durableStateWriteFailed = false;
      try {
        await ApprovalPreparations.markUnknown(
          preparationKey,
          `approval confirmation outcome is unknown: ${message}`,
          { diagnostic },
        );
      } catch {
        durableStateWriteFailed = true;
      }
      throw approvalRecoveryError(
        `Approval confirmation outcome is unknown and requires operator review: ${message}`,
        {
          stage: 'approval',
          operationKey: preparationKey,
          txHash: approveTx.hash,
          diagnostic,
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
  treasuryAddress: string,
  actionKey?: string,
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
  const currentAllowance: bigint = await withRpcReadRetry(
    () => tokenReadonly.allowance(userWallet.address, treasuryAddress) as Promise<bigint>,
  );
  if (currentAllowance === 0n) {
    console.log(`ℹ️  Allowance already zero for managed wallet of user ${uid} — skipping revoke`);
    return;
  }

  // Fund gas: send a small amount of MATIC to the derived wallet
  const gasAmount = ethers.parseEther('0.002');
  const chain = await withRpcReadRetry(() => provider.getNetwork());
  const fundingOperationKey = `maintenance:revoke:${uid}:funding:${standaloneActionSuffix(actionKey)}`;
  let funding: Awaited<ReturnType<typeof prepareAndBroadcastTransaction>> | undefined;
  let fundingFailureStage: TransactionDiagnostic['stage'] = 'prepare';
  let fundingFailureMethod = 'treasury.prepare';
  try {
    funding = await prepareAndBroadcastTransaction({
      operationKey: fundingOperationKey,
      targetType: 'standalone',
      signer: treasurySigner,
      chainId: String(chain.chainId),
      to: userWallet.address,
      value: gasAmount,
    });
    if (funding.alreadyPrepared) {
      fundingFailureStage = 'receipt';
      fundingFailureMethod = 'provider.transactionEvidence';
      await reconcileOriginalNativeTransfer(provider, funding, 'Allowance-revoke gas funding');
    } else {
      fundingFailureStage = 'receipt';
      fundingFailureMethod = 'provider.waitForTransaction';
      const receipt = await withNullableRpcReadRetry(() => provider.waitForTransaction(funding!.txHash));
      if (!receipt || Number(receipt.status) !== 1) throw new Error('Allowance-revoke gas funding is not confirmed');
    }
  } catch (error) {
    throwManagedFundingFailure(fundingOperationKey, error, {
      stage: fundingFailureStage,
      rpcMethod: fundingFailureMethod,
      ...(funding?.txHash ? { savedHash: funding.txHash } : {}),
    });
  }

  // Call approve(treasury, 0) from the derived wallet
  const approveTx = await userSigner.sendTransaction({
    to: contractAddress,
    data: new ethers.Interface(['function approve(address spender, uint256 amount) public returns (bool)'])
      .encodeFunctionData('approve', [treasuryAddress, 0n]),
  });
  const approveReceipt = await withNullableRpcReadRetry(() => approveTx.wait());
  if (!approveReceipt || Number(approveReceipt.status) !== 1) throw new Error('Allowance revoke transaction is not confirmed');

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
  tokenContractAddress: string,
  actionKey?: string,
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
  // The action identity is supplied by the caller and is deliberately kept
  // independent of the current balance, target, and token.  Those values are
  // immutable intent in the saved signing context, so a retry after a lost
  // response can reconcile the original hash even when the wallet balance has
  // since reached zero.  A missing key denotes a new logical action.
  const operationKey = `maintenance:move:${uid}:${standaloneActionSuffix(actionKey)}`;
  const existingLease = await TreasuryTransactions.findByOperationKey(operationKey);
  let balance: bigint;
  let chainId: string;
  let destination = tokenContractAddress;
  let data: string;
  let value: bigint = 0n;
  let accessList: ethers.AccessList | undefined;

  if (existingLease) {
    if (existingLease.target_type !== 'standalone' || !existingLease.tx_context) {
      throw new Error('TREASURY_TRANSACTION_INTENT_MISMATCH');
    }
    const savedContext = existingLease.tx_context;
    if (savedContext.to.toLowerCase() !== tokenContractAddress.toLowerCase()
      || typeof savedContext.data !== 'string') {
      throw new Error('TREASURY_TRANSACTION_INTENT_MISMATCH');
    }
    let decoded: ethers.Result;
    try {
      decoded = managedMoveInterface.decodeFunctionData('transferFrom', savedContext.data);
    } catch {
      throw new Error('TREASURY_TRANSACTION_INTENT_MISMATCH');
    }
    const savedSource = String(decoded[0]);
    const savedTarget = String(decoded[1]);
    if (savedSource.toLowerCase() !== userWallet.address.toLowerCase()
      || savedTarget.toLowerCase() !== targetAddress.toLowerCase()) {
      throw new Error('TREASURY_TRANSACTION_INTENT_MISMATCH');
    }
    try {
      balance = BigInt(decoded[2].toString());
      value = BigInt(savedContext.value || '0');
    } catch {
      throw new Error('TREASURY_TRANSACTION_INTENT_MISMATCH');
    }
    if (balance <= 0n) throw new Error('TREASURY_TRANSACTION_INTENT_MISMATCH');
    chainId = String(savedContext.chainId);
    destination = savedContext.to;
    data = savedContext.data;
    accessList = savedContext.accessList as ethers.AccessList | undefined;
  } else {
    try {
      balance = await withRpcReadRetry(
        () => token.balanceOf(userWallet.address) as Promise<bigint>,
      );
    } catch (error) {
      const retryable = isTransientRpcReadError(error);
      throwManagedMovePreflightFailure(
        operationKey,
        createTransactionDiagnostic('preflight', 'RPC_READ_UNAVAILABLE', error, {
          rpcMethod: 'eth_call',
          retryable,
          category: retryable ? 'rpc_unavailable' : 'preflight',
        }),
        `Managed-wallet balance could not be read before transfer preparation; no movement was attempted${retryable ? ', retry the same move key after the token network recovers' : ''}`,
      );
    }
    if (balance === 0n) {
      throwManagedMovePreflightFailure(
        operationKey,
        createTransactionDiagnostic('preflight', 'MANAGED_WALLET_BALANCE_EMPTY', undefined, {
          rpcMethod: 'eth_call',
          retryable: false,
          category: 'preflight',
        }),
        'Managed wallet balance is already zero — nothing to move',
      );
    }
    let treasuryAddress: string;
    try {
      treasuryAddress = await treasurySigner.getAddress();
    } catch (error) {
      const retryable = isTransientRpcReadError(error);
      throwManagedMovePreflightFailure(
        operationKey,
        createTransactionDiagnostic('preflight', 'RPC_READ_UNAVAILABLE', error, {
          rpcMethod: 'signer.getAddress',
          retryable,
          category: retryable ? 'rpc_unavailable' : 'preflight',
        }),
        `Managed-wallet treasury permission could not be read before transfer preparation; no movement was attempted${retryable ? ', retry the same move key after the token network recovers' : ''}`,
      );
    }
    const tokenReadonly = new ethers.Contract(
      tokenContractAddress,
      ['function allowance(address owner, address spender) view returns (uint256)'],
      provider,
    );
    let allowance: bigint;
    try {
      allowance = await withRpcReadRetry(
        () => tokenReadonly.allowance(userWallet.address, treasuryAddress) as Promise<bigint>,
      );
    } catch (error) {
      const retryable = isTransientRpcReadError(error);
      throwManagedMovePreflightFailure(
        operationKey,
        createTransactionDiagnostic('preflight', 'RPC_READ_UNAVAILABLE', error, {
          rpcMethod: 'eth_call',
          retryable,
          category: retryable ? 'rpc_unavailable' : 'preflight',
        }),
        `Managed-wallet treasury permission could not be read before transfer preparation; no movement was attempted${retryable ? ', retry the same move key after the token network recovers' : ''}`,
      );
    }
    if (allowance < balance) {
      throwManagedMovePreflightFailure(
        operationKey,
        createTransactionDiagnostic('preflight', 'MANAGED_WALLET_ALLOWANCE_UNAVAILABLE', undefined, {
          rpcMethod: 'eth_call',
          retryable: false,
          category: 'preflight',
        }),
        'The managed wallet treasury permission is insufficient for this transfer. Enable the approved treasury permission for managed mode, then retry the same move key; no movement was attempted',
      );
    }
    let chain: ethers.Networkish;
    try {
      chain = await withRpcReadRetry(() => provider.getNetwork());
    } catch (error) {
      const retryable = isTransientRpcReadError(error);
      throwManagedMovePreflightFailure(
        operationKey,
        createTransactionDiagnostic('preflight', 'CHAIN_CONTEXT_UNAVAILABLE', error, {
          rpcMethod: 'eth_chainId',
          retryable,
          category: retryable ? 'rpc_unavailable' : 'preflight',
        }),
        `Managed-wallet chain context could not be read before transfer preparation; no movement was attempted${retryable ? ', retry the same move key after the token network recovers' : ''}`,
      );
    }
    chainId = String(chain.chainId);
    data = managedMoveInterface.encodeFunctionData('transferFrom', [userWallet.address, targetAddress, balance]);
  }

  let tx: Awaited<ReturnType<typeof prepareAndBroadcastTransaction>>;
  try {
    tx = await prepareAndBroadcastTransaction({
      operationKey,
      targetType: 'standalone',
      signer: treasurySigner,
      chainId,
      to: destination,
      data,
      value,
      ...(accessList === undefined ? {} : { accessList }),
    });
  } catch (error) {
    throwManagedMovePreparationFailure(operationKey, error);
  }
  if (tx.alreadyPrepared) {
    const evidence = await verifySpendEvidence({
      provider,
      tokenContractAddress,
      chainId: BigInt(chainId),
      sourceWallet: userWallet.address,
      treasuryRecipient: targetAddress,
      amountUnits: balance,
      txHash: tx.txHash,
    });
    if (!evidence.valid) {
      const diagnostic = managedMoveEvidenceDiagnostic(tx, evidence.failure);
      const movementOutcome: ManagedMoveOutcome = evidence.failure.code === 'TRANSACTION_FAILED'
        ? 'no_movement'
        : (evidence.failure.pending || diagnostic.retryable ? 'unknown' : 'review');
      await throwManagedMoveFailure(
        operationKey,
        tx,
        diagnostic,
        `Managed-wallet transfer duplicate could not be reconciled safely for original transaction ${tx.txHash}: ${evidence.failure.code}`,
        movementOutcome,
      );
    }
  } else {
    let receipt: ethers.TransactionReceipt | null = null;
    try {
      receipt = await withNullableRpcReadRetry(() => provider.waitForTransaction(tx.txHash));
    } catch (error) {
      const failure = managedMoveReceiptDiagnostic(tx, error);
      await throwManagedMoveFailure(operationKey, tx, failure.diagnostic, failure.message, failure.movementOutcome);
    }
    if (!receipt || Number(receipt.status) !== 1) {
      const failure = managedMoveReceiptDiagnostic(tx, undefined, receipt);
      await throwManagedMoveFailure(operationKey, tx, failure.diagnostic, failure.message, failure.movementOutcome);
    }
  }

  const amount = ethers.formatEther(balance);
  console.log(`✓ Moved ${amount} SPARKZ from managed wallet of user ${uid} to ${targetAddress} (tx: ${tx.txHash})`);
  return { txHash: tx.txHash, amount };
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
    await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`users-active:${normalised.uid}`]);
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
      : await trx('users').where({ uid: normalised.uid, is_active: true }).first();
    const walletAddress = user?.wallet_address || intendedWalletAddress || resolveUidToAddress(normalised.uid);
    if (!user) {
      const hasExistingUid = await trx('users').where({ uid: normalised.uid }).first('id');
      const [created] = await trx('users').insert({
        uid: normalised.uid,
        wallet_address: walletAddress,
        wallet_name: null,
        is_active: !hasExistingUid,
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
    if (uid) {
      await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`users-active:${uid}`]);
    }
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
        .first()
      : undefined;
    if (!user && !uid) {
      user = await trx('users')
        .whereRaw('lower(wallet_address) = lower(?)', [userWallet])
        .orderBy('created_at', 'asc')
        .first();
    }
    if (!user) {
      const hasExistingUid = uid
        ? await trx('users').where({ uid }).first('id')
        : undefined;
      const [created] = await trx('users').insert({
        uid: uid || `wallet-${userWallet}`,
        wallet_address: userWallet,
        wallet_name: null,
        is_active: !hasExistingUid,
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
