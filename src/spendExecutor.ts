import { ethers } from 'ethers';
import { SpendRequest, SpendResult, SpendExecutionResult } from './types';
import { getContract } from './contract';
import { getTreasuryAddress } from './treasury/treasuryConfig';
import { recordSpend } from './database/integration';
import { TokenOperations, TokenOperationRecord, TokenMovementOutcome } from './database/service';
import { assetContextMismatch, canonicalTokenAmount, getTokenAssetContext, requireCanonicalTransactionHash, spendIntentFingerprint, spendOperationKey } from './database/tokenOperation';
import { verifySpendEvidence, SpendEvidenceResult } from './spendEvidence';

/**
 * Note: For spend execution to work, users must have approved the treasury
 * contract to spend tokens on their behalf via ERC20 approve().
 */

export interface SpendOperationRequest extends SpendRequest {
  /** Contract identity, when the API has resolved it. */
  uid?: string;
  providerId?: string;
  /** Reservation or caller-supplied idempotency key. */
  operationKey?: string;
  idempotencyKey?: string;
  reservationId?: string;
}

export interface ReliableSpendExecutionResult extends SpendExecutionResult {
  operationKey?: string;
  operationStatus?: string;
  pending?: boolean;
  requiresReview?: boolean;
  preflightFailure?: boolean;
  /** Whether managed-wallet auto-approval may run after this preflight result. */
  preflightApprovalEligible?: boolean;
  dbStored?: boolean;
  dbError?: string;
  duplicate?: boolean;
  /** Durable movement classification; callers must not infer this from status. */
  movementOutcome?: TokenMovementOutcome;
}

/**
 * Validates requested spend and prepares spend execution.
 * Token storage and the ERC-20 call both support two decimal places. Reject
 * finer precision rather than sending one amount on-chain and projecting a
 * silently rounded amount in PostgreSQL.
 */
export function prepareSpend(request: SpendRequest): SpendResult {
  const canonicalAmount = canonicalTokenAmount(request.amount);
  return {
    valid: !!(canonicalAmount && canonicalAmount.units > 0n && request.userAddress),
  };
}

/** Submit without waiting so the hash can be durably recorded first. */
async function submitSpend(
  treasurySigner: ethers.Signer,
  userAddress: string,
  treasuryAddress: string,
  amount: number | string
): Promise<ethers.ContractTransactionResponse> {
  const canonicalAmount = canonicalTokenAmount(amount);
  if (!canonicalAmount || canonicalAmount.units <= 0n) {
    throw new Error('UNSUPPORTED_TOKEN_PRECISION');
  }
  const contract = getContract(treasurySigner);
  const tx = await contract.transferFrom(
    userAddress,
    treasuryAddress,
    ethers.parseUnits(canonicalAmount.decimal, 18)
  );
  return tx as ethers.ContractTransactionResponse;
}

/**
 * Executes the spend by transferring tokens from user back to treasury. This
 * compatibility helper retains its original wait-for-confirmation behaviour;
 * processSpend uses submitSpend directly so the hash is saved first.
 */
export async function executeSpend(
  treasurySigner: ethers.Signer,
  userAddress: string,
  treasuryAddress: string,
  amount: number
): Promise<string> {
  const tx = await submitSpend(treasurySigner, userAddress, treasuryAddress, amount);
  await tx.wait();
  return tx.hash;
}

function pendingSpendResult(
  request: SpendOperationRequest,
  operationStatus: string,
  error: string,
  txHash?: string,
  requiresReview = false,
  movementOutcome?: TokenMovementOutcome,
): ReliableSpendExecutionResult {
  return {
    success: false,
    amount: request.amount,
    userAddress: request.userAddress,
    operationKey: request.operationKey,
    txHash,
    operationStatus,
    pending: true,
    requiresReview,
    ...(movementOutcome ? { movementOutcome } : {}),
    error,
  };
}

/** Validate a saved spend claim before an unavailable-context recovery return. */
function spendRecoveryIntentMismatch(
  operation: {
    operation_type?: string;
    request_fingerprint?: string;
    uid?: string;
    wallet_address?: string;
    amount?: string;
    session_id?: string | null;
    provider_id?: string | null;
    reservation_id?: string | null;
  },
  request: SpendOperationRequest,
  uid: string,
): string | undefined {
  if (operation.operation_type && operation.operation_type !== 'spend') {
    return 'operation key does not identify a spend operation';
  }
  if (operation.uid && operation.uid !== uid) {
    return 'saved spend owner differs from the request eMAID';
  }
  if (operation.wallet_address && request.userAddress
    && operation.wallet_address.toLowerCase() !== request.userAddress.toLowerCase()) {
    return 'saved spend wallet differs from the request wallet';
  }
  const savedAmount = operation.amount === undefined ? undefined : canonicalTokenAmount(operation.amount);
  const requestedAmount = canonicalTokenAmount(request.amount);
  if (!savedAmount || !requestedAmount) return 'saved or requested spend amount is not an exact two-decimal value';
  if (savedAmount.units !== requestedAmount.units) return 'saved spend amount differs from the request';
  const sessionId = request.sessionId === undefined ? operation.session_id || null : request.sessionId;
  const providerId = request.providerId === undefined ? operation.provider_id || null : request.providerId;
  const reservationId = request.reservationId === undefined ? operation.reservation_id || null : request.reservationId;
  if (operation.session_id !== undefined && request.sessionId !== undefined
    && (operation.session_id || null) !== (request.sessionId || null)) {
    return 'saved spend session differs from the request';
  }
  if (operation.provider_id !== undefined && request.providerId !== undefined
    && (operation.provider_id || null) !== (request.providerId || null)) {
    return 'saved spend provider differs from the request';
  }
  if (operation.reservation_id !== undefined && request.reservationId !== undefined
    && (operation.reservation_id || null) !== (request.reservationId || null)) {
    return 'saved spend reservation differs from the request';
  }
  if (operation.request_fingerprint) {
    const fingerprint = spendIntentFingerprint({
      uid,
      walletAddress: operation.wallet_address || request.userAddress,
      amount: requestedAmount.value,
      sessionId,
      providerId,
      reservationId,
    });
    if (fingerprint !== operation.request_fingerprint) {
      return 'saved spend fingerprint differs from the request financial intent';
    }
  }
  return undefined;
}

class KnownSpendPreflightFailure extends Error {
  readonly safeToRetry = true;

  constructor(message: string) {
    super(message);
    this.name = 'KnownSpendPreflightFailure';
  }
}

/**
 * Classify provider/RPC failures by their structured ethers error code and
 * revert-data shape. A token revert with actual revert data remains a known
 * contract-level failure and may trigger managed-wallet allowance recovery;
 * an unavailable/empty read cannot establish that the token rejected the
 * spend and must remain a no-movement retry.
 */
function isUnavailableReadonlyError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const candidate = error as { code?: unknown; data?: unknown };
  const code = typeof candidate.code === 'string' ? candidate.code : undefined;
  if (code && new Set([
    'NETWORK_ERROR',
    'SERVER_ERROR',
    'TIMEOUT',
    'TIMEOUT_ERROR',
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'ENETUNREACH',
    'INSUFFICIENT_FUNDS',
    'BAD_DATA',
  ]).has(code)) return true;
  if (code !== 'CALL_EXCEPTION') return false;
  return candidate.data === undefined
    || candidate.data === null
    || candidate.data === '0x'
    || candidate.data === '0X';
}

function preflightErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function preflightFailureResult(
  request: SpendOperationRequest,
  operationKey: string,
  error: string,
  approvalEligible: boolean,
  movementOutcome: TokenMovementOutcome = 'no_movement',
): ReliableSpendExecutionResult {
  return {
    success: false,
    amount: request.amount,
    userAddress: request.userAddress,
    operationKey,
    operationStatus: 'failed',
    pending: !approvalEligible,
    preflightFailure: true,
    preflightApprovalEligible: approvalEligible,
    movementOutcome,
    error,
  };
}

/**
 * Perform all readonly checks before the send call. Once submitSpend starts,
 * every thrown error is treated as ambiguous, regardless of message text.
 */
async function preflightSpend(
  treasurySigner: ethers.Signer,
  userAddress: string,
  treasuryAddress: string,
  amount: number,
  assetContext: Awaited<ReturnType<typeof getTokenAssetContext>>,
): Promise<void> {
  const canonicalAmount = canonicalTokenAmount(amount);
  if (!canonicalAmount) throw new Error('UNSUPPORTED_TOKEN_PRECISION');
  const amountUnits = ethers.parseUnits(canonicalAmount.decimal, 18);
  const provider = treasurySigner.provider;
  if (!provider) throw new Error('SPEND_PREFLIGHT_UNAVAILABLE: provider is required');

  const tokenReadonly = new ethers.Contract(
    assetContext.tokenContractAddress,
    [
      'function allowance(address owner,address spender) view returns (uint256)',
      'function balanceOf(address owner) view returns (uint256)',
    ],
    provider,
  );
  let allowance: bigint;
  let balance: bigint;
  try {
    [allowance, balance] = await Promise.all([
      tokenReadonly.allowance(userAddress, assetContext.signerAddress) as Promise<bigint>,
      tokenReadonly.balanceOf(userAddress) as Promise<bigint>,
    ]);
  } catch (err) {
    throw new Error(`SPEND_PREFLIGHT_UNAVAILABLE: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (allowance < amountUnits) {
    throw new KnownSpendPreflightFailure(
      `insufficient allowance for ${assetContext.signerAddress}: ${allowance.toString()} < ${amountUnits.toString()}`,
    );
  }
  if (balance < amountUnits) {
    throw new KnownSpendPreflightFailure(
      `transfer amount exceeds balance: ${balance.toString()} < ${amountUnits.toString()}`,
    );
  }

  // A static call/estimate is still readonly and catches token-level reverts
  // before submitSpend. It is deliberately optional for contract test doubles;
  // allowance and balance checks above remain mandatory in production.
  const contract = getContract(treasurySigner) as ethers.Contract & {
    transferFrom?: {
      staticCall?: (from: string, to: string, value: bigint) => Promise<unknown>;
      estimateGas?: (from: string, to: string, value: bigint) => Promise<bigint>;
    };
  };
  if (contract.transferFrom?.staticCall) {
    try {
      await contract.transferFrom.staticCall(userAddress, treasuryAddress, amountUnits);
    } catch (err) {
      if (isUnavailableReadonlyError(err)) {
        throw new Error(`SPEND_PREFLIGHT_UNAVAILABLE: ${preflightErrorMessage(err)}`);
      }
      throw new KnownSpendPreflightFailure(
        `token transfer preflight reverted: ${preflightErrorMessage(err)}`,
      );
    }
  } else if (contract.transferFrom?.estimateGas) {
    try {
      await contract.transferFrom.estimateGas(userAddress, treasuryAddress, amountUnits);
    } catch (err) {
      if (isUnavailableReadonlyError(err)) {
        throw new Error(`SPEND_PREFLIGHT_UNAVAILABLE: ${preflightErrorMessage(err)}`);
      }
      throw new KnownSpendPreflightFailure(
        `token transfer gas estimate reverted: ${preflightErrorMessage(err)}`,
      );
    }
  }
}

async function readTokenBalance(
  provider: ethers.Provider,
  tokenContractAddress: string,
  walletAddress: string,
): Promise<number> {
  const token = new ethers.Contract(
    tokenContractAddress,
    ['function balanceOf(address owner) view returns (uint256)'],
    provider,
  );
  const units = await token.balanceOf(walletAddress) as bigint;
  return Number(ethers.formatUnits(units, 18));
}

function evidencePending(failureCode: string): boolean {
  return failureCode === 'RECEIPT_PENDING'
    || failureCode === 'PROVIDER_ERROR'
    || failureCode === 'TRANSACTION_NOT_FOUND';
}

async function projectSpendOperation(
  operation: TokenOperationRecord | {
    operation_key: string;
    status: string;
    operation_type?: string;
    request_fingerprint?: string;
    tx_hash?: string | null;
    amount: string;
    uid: string;
    wallet_address: string;
    session_id?: string | null;
    intent_context?: Record<string, unknown> | null;
    movement_outcome?: TokenMovementOutcome | null;
  },
  request: SpendOperationRequest,
  verifyEvidence: (() => Promise<SpendEvidenceResult>) | undefined
): Promise<ReliableSpendExecutionResult> {
  const originalAmount = Number(operation.amount);
  let movementOutcome: TokenMovementOutcome = operation.movement_outcome || 'unknown';
  const replayRequest: SpendOperationRequest = {
    ...request,
    uid: operation.uid || request.uid,
    userAddress: operation.wallet_address || request.userAddress,
    amount: originalAmount,
    sessionId: operation.session_id || request.sessionId,
    operationKey: operation.operation_key,
  };

  if (operation.status === 'failed') {
    const needsReview = operation.movement_outcome !== 'no_movement';
    if (needsReview) {
      return pendingSpendResult(
        replayRequest,
        'failed',
        'Spend evidence or durable failure state requires operator review; no replacement transfer was submitted.',
        operation.tx_hash || undefined,
        true,
        movementOutcome,
      );
    }
    return {
      success: false,
      amount: originalAmount,
      userAddress: replayRequest.userAddress,
      operationKey: operation.operation_key,
      txHash: operation.tx_hash || undefined,
      operationStatus: 'failed',
      requiresReview: false,
      movementOutcome,
      error: 'Spend operation is marked failed; no replacement transfer was submitted.',
    };
  }

  if (operation.status === 'projected') {
    return {
      success: true,
      amount: originalAmount,
      userAddress: replayRequest.userAddress,
      operationKey: operation.operation_key,
      txHash: operation.tx_hash || undefined,
      dbStored: true,
      duplicate: true,
      operationStatus: 'projected',
      movementOutcome,
    };
  }

  if (!operation.tx_hash) {
    return pendingSpendResult(
      replayRequest,
      operation.status,
      'Spend submission is unresolved and requires operator review before retrying.',
      undefined,
      true,
      movementOutcome,
    );
  }

  if (operation.status === 'submitted' || operation.status === 'unknown') {
    if (!verifyEvidence) {
      return pendingSpendResult(
        replayRequest,
        operation.status,
        'Spend transaction is awaiting confirmation.',
        operation.tx_hash,
        false,
        movementOutcome,
      );
    }
    let evidence: SpendEvidenceResult;
    try {
      evidence = await verifyEvidence();
    } catch (err) {
      return pendingSpendResult(
        replayRequest,
        operation.status,
        `Spend transaction confirmation is pending: ${err instanceof Error ? err.message : String(err)}`,
        operation.tx_hash,
        false,
        movementOutcome,
      );
    }
    if (!evidence.valid) {
      if (evidencePending(evidence.failure.code)) {
        return pendingSpendResult(
          replayRequest,
          operation.status,
          `Spend transaction confirmation is pending: ${evidence.failure.message}`,
          operation.tx_hash,
          evidence.failure.code === 'TRANSACTION_NOT_FOUND',
          movementOutcome,
        );
      }
      const evidenceMovementOutcome: TokenMovementOutcome = evidence.failure.code === 'TRANSACTION_FAILED'
        ? 'no_movement'
        : 'review';
      try {
        const failedOperation = await TokenOperations.markFailed(
          operation.operation_key,
          `Spend evidence rejected: ${evidence.failure.message}`,
          evidenceMovementOutcome,
        );
        movementOutcome = evidenceMovementOutcome === 'review'
          ? 'review'
          : failedOperation?.movement_outcome || evidenceMovementOutcome;
      } catch (err) {
        return pendingSpendResult(
          replayRequest,
          operation.status,
          `Spend evidence was rejected, but durable failure state could not be saved: ${err instanceof Error ? err.message : String(err)}`,
          operation.tx_hash,
          true,
          evidenceMovementOutcome,
        );
      }
      if (movementOutcome === 'review') {
        return pendingSpendResult(
          replayRequest,
          'failed',
          `Spend transfer was not projected because chain evidence requires operator review (${evidence.failure.code}): ${evidence.failure.message}`,
          operation.tx_hash,
          true,
          movementOutcome,
        );
      }
      return {
        success: false,
        amount: originalAmount,
        userAddress: replayRequest.userAddress,
        operationKey: operation.operation_key,
        txHash: operation.tx_hash,
        operationStatus: 'failed',
        requiresReview: false,
        movementOutcome,
        error: `Spend transfer was not projected because chain evidence was rejected (${evidence.failure.code}): ${evidence.failure.message}`,
      };
    }
    try {
      const confirmedOperation = await TokenOperations.markConfirmed(operation.operation_key);
      movementOutcome = confirmedOperation?.movement_outcome || 'confirmed';
    } catch (err) {
      return pendingSpendResult(
        replayRequest,
        'submitted',
        `Spend was confirmed on-chain but confirmation state could not be saved: ${err instanceof Error ? err.message : String(err)}`,
        operation.tx_hash,
        false,
        movementOutcome,
      );
    }
  }

  try {
    await recordSpend(
      replayRequest.userAddress,
      originalAmount,
      operation.tx_hash,
      replayRequest.sessionId,
      replayRequest.uid,
    );
  } catch (err) {
    const dbError = err instanceof Error ? err.message : String(err);
    try {
      await TokenOperations.markProjectionError(operation.operation_key, dbError);
    } catch {
      // The operation retains its transaction hash and can be projected on a
      // later request even if this status update also hit a DB outage.
    }
    return {
      ...pendingSpendResult(
        replayRequest,
        'confirmed',
        `Spend transfer is confirmed, but database projection is pending: ${dbError}`,
        operation.tx_hash,
        false,
        movementOutcome,
      ),
      dbStored: false,
      dbError,
    };
  }

  try {
    const projectedOperation = await TokenOperations.markProjected(operation.operation_key);
    movementOutcome = projectedOperation?.movement_outcome || movementOutcome;
  } catch (err) {
    const dbError = err instanceof Error ? err.message : String(err);
    return {
      ...pendingSpendResult(
        replayRequest,
        'confirmed',
        `Spend transfer is confirmed, but operation completion is pending: ${dbError}`,
        operation.tx_hash,
        false,
        movementOutcome,
      ),
      dbStored: true,
      dbError,
    };
  }

  return {
    success: true,
    amount: originalAmount,
    userAddress: replayRequest.userAddress,
    operationKey: operation.operation_key,
    txHash: operation.tx_hash,
    dbStored: true,
    operationStatus: 'projected',
    movementOutcome,
  };
}

/**
 * Recover a saved spend without entering the new-spend executor. This path is
 * intentionally read-only on the chain: it verifies the durable transaction
 * hash and only then completes the existing database projection.
 */
export async function recoverSpendOperation(
  operationKey: string,
  treasurySigner: ethers.Signer,
): Promise<ReliableSpendExecutionResult> {
  if (!isNonEmptyOperationKey(operationKey)) {
    return {
      success: false,
      amount: 0,
      userAddress: '',
      requiresReview: true,
      error: 'INVALID_OPERATION_KEY: operationKey must be a non-empty string',
    };
  }

  let operation: TokenOperationRecord | undefined;
  try {
    operation = await TokenOperations.findByKey(operationKey);
  } catch (err) {
    return {
      success: false,
      amount: 0,
      userAddress: '',
      pending: true,
      requiresReview: true,
      operationKey,
      error: `SPEND_RECOVERY_LOOKUP_UNAVAILABLE: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!operation) {
    return {
      success: false,
      amount: 0,
      userAddress: '',
      requiresReview: true,
      operationKey,
      error: 'TOKEN_OPERATION_NOT_FOUND: spend operation was not found',
    };
  }
  if (operation.operation_type !== 'spend') {
    return {
      success: false,
      amount: Number(operation.amount) || 0,
      userAddress: operation.wallet_address,
      operationKey,
      operationStatus: operation.status,
      requiresReview: true,
      error: 'TOKEN_OPERATION_INTENT_MISMATCH: operation is not a spend',
    };
  }

  const amount = canonicalTokenAmount(operation.amount);
  const request: SpendOperationRequest = {
    userAddress: operation.wallet_address,
    amount: amount?.value || Number(operation.amount) || 0,
    uid: operation.uid,
    sessionId: operation.session_id || undefined,
    providerId: operation.provider_id || undefined,
    reservationId: operation.reservation_id || undefined,
    operationKey: operation.operation_key,
  };
  if (!amount || amount.units <= 0n) {
    return pendingSpendResult(
      request,
      operation.status,
      'SPEND_RECOVERY_INTENT_INVALID: saved spend amount is not a positive exact token amount',
      operation.tx_hash || undefined,
      true,
      'review',
    );
  }

  if (operation.status === 'projected' && !operation.tx_hash) {
    return pendingSpendResult(
      request,
      operation.status,
      'SPEND_RECOVERY_CHAIN_HASH_REQUIRED: a canonical saved transaction hash is required for projected receipt recovery',
      undefined,
      true,
      'review',
    );
  }

  if (!operation.request_fingerprint) {
    return pendingSpendResult(
      request,
      operation.status,
      'SPEND_RECOVERY_INTENT_INVALID: saved spend intent fingerprint is unavailable; operator review is required',
      operation.tx_hash || undefined,
      true,
      'review',
    );
  }
  const savedIntentMismatch = spendRecoveryIntentMismatch(operation, request, operation.uid);
  if (savedIntentMismatch) {
    return pendingSpendResult(
      request,
      operation.status,
      `SPEND_RECOVERY_INTENT_INVALID: ${savedIntentMismatch}`,
      operation.tx_hash || undefined,
      true,
      'review',
    );
  }

  if (operation.status === 'failed') {
    return {
      success: false,
      amount: amount.value,
      userAddress: operation.wallet_address,
      operationKey: operation.operation_key,
      txHash: operation.tx_hash || undefined,
      operationStatus: operation.status,
      requiresReview: operation.movement_outcome !== 'no_movement',
      movementOutcome: operation.movement_outcome || 'review',
      error: 'SPEND_RECOVERY_BLOCKED: saved spend is already failed and will not be replaced',
    };
  }

  let txHash: string;
  try {
    txHash = requireCanonicalTransactionHash(operation.tx_hash, 'saved spend transaction hash');
  } catch {
    return pendingSpendResult(
      request,
      operation.status,
      'SPEND_RECOVERY_CHAIN_HASH_REQUIRED: a canonical saved transaction hash is required; no replacement transfer was submitted',
      undefined,
      true,
      'review',
    );
  }

  let assetContext: Awaited<ReturnType<typeof getTokenAssetContext>>;
  try {
    assetContext = await getTokenAssetContext(treasurySigner, getTreasuryAddress());
  } catch (err) {
    return pendingSpendResult(
      request,
      operation.status,
      `SPEND_RECOVERY_ASSET_CONTEXT_UNAVAILABLE: ${err instanceof Error ? err.message : String(err)}`,
      txHash,
      false,
      operation.movement_outcome || 'unknown',
    );
  }
  const assetMismatch = assetContextMismatch(operation.intent_context, assetContext);
  if (assetMismatch) {
    return pendingSpendResult(
      request,
      operation.status,
      `SPEND_RECOVERY_ASSET_CONTEXT_MISMATCH: ${assetMismatch}`,
      txHash,
      true,
      'review',
    );
  }

  const provider = treasurySigner.provider;
  if (!provider) {
    return pendingSpendResult(
      request,
      operation.status,
      'SPEND_RECOVERY_CHAIN_READ_UNAVAILABLE: signer provider is unavailable',
      txHash,
      false,
      operation.movement_outcome || 'unknown',
    );
  }
  let evidence: SpendEvidenceResult;
  try {
    evidence = await verifySpendEvidence({
      provider,
      tokenContractAddress: assetContext.tokenContractAddress,
      chainId: assetContext.chainId,
      sourceWallet: operation.wallet_address,
      treasuryRecipient: assetContext.treasuryAddress || getTreasuryAddress(),
      amountUnits: ethers.parseUnits(amount.decimal, 18),
      txHash,
    });
  } catch (err) {
    return pendingSpendResult(
      request,
      operation.status,
      `SPEND_RECOVERY_CHAIN_READ_UNAVAILABLE: ${err instanceof Error ? err.message : String(err)}`,
      txHash,
      false,
      operation.movement_outcome || 'unknown',
    );
  }
  if (!evidence.valid) {
    const requiresReview = !['RECEIPT_PENDING', 'PROVIDER_ERROR'].includes(evidence.failure.code);
    return pendingSpendResult(
      request,
      operation.status,
      `SPEND_RECOVERY_EVIDENCE_BLOCKED: ${evidence.failure.code}`,
      txHash,
      requiresReview,
      requiresReview ? 'review' : operation.movement_outcome || 'unknown',
    );
  }

  // A projected spend may still be missing its signed receipt.  Verify the
  // saved hash above before allowing the API to finish that receipt; the
  // projected branch must never turn a hashless or unverified row into a
  // successful recovery result.
  if (operation.status === 'projected') {
    return {
      success: true,
      amount: amount.value,
      userAddress: operation.wallet_address,
      operationKey: operation.operation_key,
      txHash,
      dbStored: true,
      duplicate: true,
      operationStatus: 'projected',
      movementOutcome: operation.movement_outcome || 'confirmed',
    };
  }

  let confirmedOperation: TokenOperationRecord | undefined;
  try {
    confirmedOperation = await TokenOperations.markConfirmed(operation.operation_key);
  } catch (err) {
    return pendingSpendResult(
      request,
      operation.status,
      `SPEND_RECOVERY_CONFIRMATION_STATE_UNAVAILABLE: ${err instanceof Error ? err.message : String(err)}`,
      txHash,
      true,
      'review',
    );
  }

  return projectSpendOperation(
    {
      ...operation,
      ...(confirmedOperation || {}),
      status: 'confirmed',
      tx_hash: txHash,
    },
    request,
    undefined,
  );
}

function isNonEmptyOperationKey(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Process a spend request and record the transaction in the database.
 * Every request must carry a stable caller or internal operation key. A
 * generated key would make a retry indistinguishable from a new transfer.
 */
export async function processSpend(
  request: SpendOperationRequest,
  treasurySigner: ethers.Signer
): Promise<ReliableSpendExecutionResult> {
  const validation = prepareSpend(request);
  if (!validation.valid) {
    return {
      success: false,
      amount: request.amount,
      userAddress: request.userAddress,
      error: 'Invalid spend request (amount must be positive and use at most 2 decimal places)',
    };
  }
  const canonicalAmount = canonicalTokenAmount(request.amount);
  if (!canonicalAmount) {
    return {
      success: false,
      amount: request.amount,
      userAddress: request.userAddress,
      error: 'Invalid spend request (amount must be positive and use at most 2 decimal places)',
    };
  }

  if (request.operationKey !== undefined && !isNonEmptyOperationKey(request.operationKey)) {
    return {
      success: false,
      amount: request.amount,
      userAddress: request.userAddress,
      error: 'INVALID_OPERATION_KEY: operationKey must be a non-empty string',
    };
  }
  if (request.idempotencyKey !== undefined && !isNonEmptyOperationKey(request.idempotencyKey)) {
    return {
      success: false,
      amount: request.amount,
      userAddress: request.userAddress,
      error: 'INVALID_OPERATION_KEY: idempotencyKey must be a non-empty string',
    };
  }

  const uid = request.uid || '';
  const idempotencyKey = isNonEmptyOperationKey(request.idempotencyKey)
    ? request.idempotencyKey
    : null;
  const operationKey = request.operationKey !== undefined
    ? request.operationKey
    : idempotencyKey
      ? spendOperationKey(uid, idempotencyKey)
      : undefined;
  if (!operationKey) {
    return {
      success: false,
      amount: request.amount,
      userAddress: request.userAddress,
      error: 'SPEND_IDEMPOTENCY_KEY_REQUIRED: a stable idempotencyKey or internal operationKey is required before a spend can be attempted',
    };
  }
  const requestWithOperationKey: SpendOperationRequest = { ...request, operationKey };
  const fingerprint = spendIntentFingerprint({
    uid,
    walletAddress: request.userAddress,
    amount: canonicalAmount.value,
    sessionId: request.sessionId,
    providerId: request.providerId,
    reservationId: request.reservationId,
    idempotencyKey,
  });

  let treasuryAddress: string;
  let assetContext: Awaited<ReturnType<typeof getTokenAssetContext>>;
  try {
    treasuryAddress = getTreasuryAddress();
    assetContext = await getTokenAssetContext(treasurySigner, treasuryAddress);
  } catch (err) {
    let existing: TokenOperationRecord | undefined;
    try { existing = await TokenOperations.findByKey(operationKey); } catch { /* preserve ordinary new-request failure */ }
    if (existing) {
      const recoveryMismatch = spendRecoveryIntentMismatch(existing, requestWithOperationKey, uid);
      if (recoveryMismatch) {
        return {
          success: false,
          amount: Number(existing.amount),
          userAddress: existing.wallet_address,
          operationKey,
          txHash: existing.tx_hash || undefined,
          operationStatus: existing.status,
          requiresReview: true,
          movementOutcome: existing.movement_outcome || 'unknown',
          error: `TOKEN_OPERATION_INTENT_MISMATCH: ${recoveryMismatch}`,
        };
      }
      if (existing.status === 'projected') {
        return pendingSpendResult(
          { ...requestWithOperationKey, amount: Number(existing.amount), userAddress: existing.wallet_address, uid: existing.uid },
          existing.status,
          `Spend recovery could not verify the original asset context and remains pending: ${err instanceof Error ? err.message : String(err)}`,
          existing.tx_hash || undefined,
          true,
          existing.movement_outcome || 'unknown',
        );
      }
      if (existing.status === 'failed' && existing.movement_outcome === 'no_movement') {
        return {
          success: false,
          amount: Number(existing.amount),
          userAddress: existing.wallet_address,
          operationKey,
          txHash: existing.tx_hash || undefined,
          operationStatus: 'failed',
          requiresReview: false,
          movementOutcome: existing.movement_outcome,
          error: 'Spend operation is marked failed; no replacement transfer was submitted.',
        };
      }
      return pendingSpendResult(
        { ...requestWithOperationKey, amount: Number(existing.amount), userAddress: existing.wallet_address, uid: existing.uid },
        existing.status,
        `Spend recovery could not verify the original asset context and remains pending: ${err instanceof Error ? err.message : String(err)}`,
        existing.tx_hash || undefined,
        true,
        existing.movement_outcome || 'unknown',
      );
    }
    return {
      success: false,
      amount: request.amount,
      userAddress: request.userAddress,
      operationKey,
      error: `Spend asset context unavailable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  try {
    const claim = await TokenOperations.claim({
      operationKey,
      operationType: 'spend',
      requestFingerprint: fingerprint,
      uid,
      walletAddress: request.userAddress,
      amount: canonicalAmount.decimal,
      sessionId: request.sessionId || null,
      providerId: request.providerId || null,
      reservationId: request.reservationId || null,
      intentContext: { assetContext },
      getOnChainBalance: !request.reservationId
        ? () => readTokenBalance(treasurySigner.provider as ethers.Provider, assetContext.tokenContractAddress, request.userAddress)
        : undefined,
    });

    const claimedAssetMismatch = assetContextMismatch(claim.operation.intent_context, assetContext);
    if (claimedAssetMismatch) {
      return {
        success: false,
        amount: Number(claim.operation.amount),
        userAddress: claim.operation.wallet_address,
        operationKey,
        txHash: claim.operation.tx_hash || undefined,
        operationStatus: claim.operation.status,
        pending: true,
        requiresReview: true,
        movementOutcome: claim.operation.movement_outcome || 'unknown',
        error: `Spend recovery is blocked because the original asset context no longer matches: ${claimedAssetMismatch}`,
      };
    }

    if (!claim.acquired) {
      const existing = claim.operation;
      const provider = treasurySigner.provider;
      return projectSpendOperation(
        existing,
        requestWithOperationKey,
        existing.tx_hash && provider
          ? () => {
            const existingAmount = canonicalTokenAmount(existing.amount);
            if (!existingAmount) {
              return Promise.resolve({
                valid: false,
                failure: {
                  code: 'INVALID_AMOUNT',
                  message: 'stored spend amount is not an exact two-decimal value',
                  pending: false,
                },
              } as SpendEvidenceResult);
            }
            return verifySpendEvidence({
              provider,
              tokenContractAddress: assetContext.tokenContractAddress,
              chainId: assetContext.chainId,
              sourceWallet: existing.wallet_address,
              treasuryRecipient: assetContext.treasuryAddress || treasuryAddress,
              amountUnits: ethers.parseUnits(existingAmount.decimal, 18),
              txHash: existing.tx_hash as string,
            });
          }
          : undefined,
      );
    }

    try {
      await preflightSpend(
        treasurySigner,
        request.userAddress,
        treasuryAddress,
        canonicalAmount.value,
        assetContext,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const approvalEligible = err instanceof KnownSpendPreflightFailure;
      let movementOutcome: TokenMovementOutcome = 'unknown';
      try {
        // This block runs before submitSpend is entered. Even an RPC/read
        // failure therefore proves that no token transfer was broadcast by
        // this operation. Retain a durable no-movement marker so the same
        // request key can safely retry after the provider or allowance state
        // is repaired.
        const failedOperation = await TokenOperations.markPreflightFailed(operationKey, message);
        movementOutcome = failedOperation?.movement_outcome || 'unknown';
      } catch {
        // Retain the claim and fail closed if even the no-movement status
        // update fails. The operation is still never resubmitted implicitly.
      }
      return preflightFailureResult(
        requestWithOperationKey,
        operationKey,
        `Spend preflight failed: ${message}`,
        approvalEligible,
        movementOutcome,
      );
    }

    let tx: ethers.ContractTransactionResponse;
    try {
      tx = await submitSpend(treasurySigner, request.userAddress, treasuryAddress, canonicalAmount.value);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      try {
        await TokenOperations.markUnknown(operationKey, `Submission outcome is unknown: ${message}`);
      } catch {
        // Retain the durable claim and fail closed if the status update fails.
      }
      return pendingSpendResult(
        requestWithOperationKey,
        'unknown',
        `Spend submission outcome is unknown and requires operator review: ${message}`,
        undefined,
        true,
        'unknown',
      );
    }

    try {
      await TokenOperations.markSubmitted(operationKey, tx.hash);
    } catch (err) {
      try {
        await TokenOperations.markUnknown(operationKey, `Transaction hash could not be persisted: ${err instanceof Error ? err.message : String(err)}`);
      } catch {
        // Keep the claim. A replay is deliberately prevented even without a
        // durable hash, because the submission may already have happened.
      }
      return pendingSpendResult(
        requestWithOperationKey,
        'unknown',
        'Spend was submitted but its transaction hash could not be durably saved; operator review is required.',
        tx.hash,
        true,
        'unknown',
      );
    }

    return projectSpendOperation(
      {
        operation_key: operationKey,
        status: 'submitted',
        tx_hash: tx.hash,
        amount: canonicalAmount.decimal,
        uid,
        wallet_address: request.userAddress,
        session_id: request.sessionId || null,
        intent_context: { assetContext },
      },
      requestWithOperationKey,
      async () => verifySpendEvidence({
        provider: treasurySigner.provider as ethers.Provider,
        tokenContractAddress: assetContext.tokenContractAddress,
        chainId: assetContext.chainId,
        sourceWallet: request.userAddress,
        treasuryRecipient: assetContext.treasuryAddress || treasuryAddress,
        amountUnits: ethers.parseUnits(canonicalAmount.decimal, 18),
        txHash: tx.hash,
      }),
    );
  } catch (err) {
    return {
      success: false,
      amount: request.amount,
      userAddress: request.userAddress,
      operationKey,
      error: `Spend operation could not be claimed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
