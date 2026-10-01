import { ethers } from 'ethers';
import { NormalisedSession, AwardMetadata, AwardResult, RawSession, OCPICDRFormat, NonOwningTokenMetadata, CdrProtocol } from './types';
import { calculateAwardTokens, getAwardCalculationContext, getDeduplicationKey, formatLocalTime } from './config/awardRules';
import { validateAndNormaliseCdr } from './normaliser';
import { getContract } from './contract';
import { getUserWalletConfig } from './user/userService';
import { recordAward, approveUserForSpendingViaFunding } from './database/integration';
import { TokenOperations } from './database/service';
import { assetContextMismatch, awardIntentFingerprint, awardOperationKey, canonicalTokenAmount, canonicalTransactionHash, getTokenAssetContext } from './database/tokenOperation';
import { verifySpendEvidence, SpendEvidenceResult } from './spendEvidence';
import { getTreasuryAddress } from './treasury/treasuryConfig';
import { exceedsTokenOperationCap, MAX_TOKENS_PER_OPERATION } from './config/tokenLimits';

/**
 * Result of executing an award (from raw CDR through to on-chain execution)
 */
export interface ExecutionResult {
  success: boolean;
  dedupKey: string;
  eligible: boolean;
  amount: number;
  uid: string;
  txHash?: string;
  dbStored?: boolean;
  dbError?: string;
  error?: string;
  operationStatus?: string;
  pending?: boolean;
  requiresReview?: boolean;
  duplicate?: boolean;
  stage: 'normalisation' | 'calculation' | 'validation' | 'execution' | 'complete';
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isAwardChargingSessionCollisionError(err: unknown): err is Error & { code?: string } {
  return Boolean(err)
    && typeof err === 'object'
    && ((err as { code?: unknown }).code === 'AWARD_CHARGING_SESSION_COLLISION_REVIEW'
      || (err instanceof Error && err.message.startsWith('AWARD_CHARGING_SESSION_COLLISION_REVIEW:')));
}

function failedExecutionResult(overrides: Partial<ExecutionResult>): ExecutionResult {
  return {
    success: false,
    dedupKey: '',
    eligible: false,
    amount: 0,
    uid: '',
    stage: 'normalisation',
    ...overrides,
  };
}

/**
 * Evaluates reward eligibility and prepares award execution based on rules configuration.
 * Returns details for treasury → user transfer if eligible.
 * Note: uid will need to be resolved to a wallet address at the API layer.
 */
export function prepareAward(session: NormalisedSession): AwardResult {
  const calculationContext = getAwardCalculationContext(session);
  const amount = calculateAwardTokens(session);
  const eligible = amount > 0;
  const dedupKey = getDeduplicationKey(session);

  return {
    eligible,
    amount,
    uid: session.uid,
    dedupKey,
    metadata: {
      isOffPeak: calculationContext.isOffPeak,
      countryCode: calculationContext.countryCode,
      localTime: formatLocalTime(session.startTime, calculationContext.timeZone || undefined),
      energyDirection: session.energyDirection,
      awardType: calculationContext.awardType || 'OFF_PEAK_CHARGING', // Default if no type determined
      // These additive fields freeze the policy/timezone context used for a
      // new operation. The public AwardMetadata shape remains compatible.
      timeZone: calculationContext.timeZone,
      timeZoneSource: calculationContext.timeZoneSource,
      localStartTime: calculationContext.localStartTime,
      eligibilityBasis: calculationContext.eligibilityBasis,
      configurationSnapshot: calculationContext.configurationSnapshot,
      configurationFingerprint: calculationContext.configurationFingerprint,
    } as AwardResult['metadata'],
  };
}

/** Versioned input snapshot retained with new award claims for restart recovery. */
export const AWARD_RECOVERY_SNAPSHOT_VERSION = 1 as const;

export interface AwardRecoverySnapshot {
  version: typeof AWARD_RECOVERY_SNAPSHOT_VERSION;
  fingerprint: string;
  normalisedSession: {
    sessionId: string;
    providerId: string;
    eMAID: string;
    emaid: string;
    protocol: CdrProtocol;
    sourceField: string;
    tokenMetadata?: NonOwningTokenMetadata;
    uid: string;
    evseId: string;
    startTime: string;
    endTime: string;
    energyKWh: number;
    energyDirection: 'CHARGE' | 'DISCHARGE';
    cdrId?: string;
    reservationSessionId?: string;
    chargingSessionId?: string;
    timeZone?: string;
    timeZoneSource?: string;
  };
  /** Original wire input, when it was available at claim time. */
  rawCDR?: RawSession | OCPICDRFormat;
}

type RecoveryInput = {
  normalised: NormalisedSession;
  rawCDR: RawSession | OCPICDRFormat;
};

type StoredRecoveryInput = {
  normalised: NormalisedSession;
  rawCDR?: RawSession | OCPICDRFormat;
};

const RECOVERY_SNAPSHOT_KEY = 'recoverySnapshot';
const VALID_RECOVERY_PROTOCOLS = new Set(['OCPI', 'OICP', 'MIXED', 'UNKNOWN']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function snapshotInvalid(message = 'stored award recovery snapshot is malformed'): Error {
  return new Error(`TOKEN_OPERATION_RECOVERY_SNAPSHOT_INVALID: ${message}`);
}

function cloneSnapshotValue<T>(value: T, label: string): T {
  try {
    const encoded = JSON.stringify(value);
    if (!encoded) throw new Error('empty JSON value');
    return JSON.parse(encoded) as T;
  } catch {
    throw snapshotInvalid(`${label} is not JSON serialisable`);
  }
}

function serialiseNormalisedSession(normalised: NormalisedSession): AwardRecoverySnapshot['normalisedSession'] {
  const startTime = normalised.startTime instanceof Date ? normalised.startTime : new Date(normalised.startTime);
  const endTime = normalised.endTime instanceof Date ? normalised.endTime : new Date(normalised.endTime);
  if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime())) {
    throw snapshotInvalid('normalised session dates are invalid');
  }
  const eMAID = normalised.eMAID || normalised.emaid || normalised.uid;
  if (!eMAID || typeof eMAID !== 'string' || normalised.uid !== eMAID) {
    throw snapshotInvalid('normalised session ownership identity is invalid');
  }
  if (!normalised.protocol || !VALID_RECOVERY_PROTOCOLS.has(normalised.protocol)) {
    throw snapshotInvalid('normalised session protocol is invalid');
  }
  if (!normalised.sourceField || typeof normalised.sourceField !== 'string') {
    throw snapshotInvalid('normalised session source field is invalid');
  }
  if (!Number.isFinite(normalised.energyKWh) || normalised.energyKWh < 0) {
    throw snapshotInvalid('normalised session energy is invalid');
  }
  if (normalised.energyDirection !== 'CHARGE' && normalised.energyDirection !== 'DISCHARGE') {
    throw snapshotInvalid('normalised session energy direction is invalid');
  }

  return {
    sessionId: normalised.sessionId,
    providerId: normalised.providerId,
    eMAID,
    emaid: eMAID,
    protocol: normalised.protocol,
    sourceField: normalised.sourceField,
    ...(normalised.tokenMetadata ? { tokenMetadata: cloneSnapshotValue(normalised.tokenMetadata, 'token metadata') } : {}),
    uid: normalised.uid,
    evseId: normalised.evseId,
    startTime: startTime.toISOString(),
    endTime: endTime.toISOString(),
    energyKWh: normalised.energyKWh,
    energyDirection: normalised.energyDirection,
    ...(normalised.cdrId ? { cdrId: normalised.cdrId } : {}),
    ...(normalised.reservationSessionId ? { reservationSessionId: normalised.reservationSessionId } : {}),
    ...(normalised.chargingSessionId ? { chargingSessionId: normalised.chargingSessionId } : {}),
    ...(normalised.timeZone ? { timeZone: normalised.timeZone } : {}),
    ...(normalised.timeZoneSource ? { timeZoneSource: normalised.timeZoneSource } : {}),
  };
}

/** Build the immutable snapshot stored in a newly claimed award operation. */
export function createAwardRecoverySnapshot(
  normalised: NormalisedSession,
  amount: number,
  walletAddress: string,
  rawCDR?: RawSession | OCPICDRFormat,
): AwardRecoverySnapshot {
  const snapshot: AwardRecoverySnapshot = {
    version: AWARD_RECOVERY_SNAPSHOT_VERSION,
    fingerprint: awardIntentFingerprint(normalised, amount, walletAddress),
    normalisedSession: serialiseNormalisedSession(normalised),
  };
  if (rawCDR !== undefined) {
    if (!isRecord(rawCDR)) throw snapshotInvalid('original CDR is not an object');
    snapshot.rawCDR = cloneSnapshotValue(rawCDR, 'original CDR');
  }
  return snapshot;
}

function deserialiseNormalisedSession(value: unknown): NormalisedSession {
  if (!isRecord(value)) throw snapshotInvalid('normalised session is missing');
  const requiredStrings = ['sessionId', 'providerId', 'eMAID', 'emaid', 'sourceField', 'uid', 'evseId'];
  for (const key of requiredStrings) {
    if (typeof value[key] !== 'string' || !value[key]) throw snapshotInvalid(`normalised session ${key} is invalid`);
  }
  if (value.eMAID !== value.emaid || value.eMAID !== value.uid) {
    throw snapshotInvalid('normalised session ownership aliases disagree');
  }
  if (typeof value.protocol !== 'string' || !VALID_RECOVERY_PROTOCOLS.has(value.protocol)) {
    throw snapshotInvalid('normalised session protocol is invalid');
  }
  if (typeof value.startTime !== 'string' || typeof value.endTime !== 'string') {
    throw snapshotInvalid('normalised session dates are missing');
  }
  const startTime = new Date(value.startTime);
  const endTime = new Date(value.endTime);
  if (Number.isNaN(startTime.getTime()) || Number.isNaN(endTime.getTime()) || endTime < startTime) {
    throw snapshotInvalid('normalised session dates are invalid');
  }
  if (typeof value.energyKWh !== 'number' || !Number.isFinite(value.energyKWh) || value.energyKWh < 0) {
    throw snapshotInvalid('normalised session energy is invalid');
  }
  if (value.energyDirection !== 'CHARGE' && value.energyDirection !== 'DISCHARGE') {
    throw snapshotInvalid('normalised session energy direction is invalid');
  }
  if (value.tokenMetadata !== undefined && !isRecord(value.tokenMetadata)) {
    throw snapshotInvalid('normalised session token metadata is invalid');
  }

  const sessionId = value.sessionId as string;
  const providerId = value.providerId as string;
  const eMAID = value.eMAID as string;
  const sourceField = value.sourceField as string;
  const uid = value.uid as string;
  const evseId = value.evseId as string;
  const protocol = value.protocol as CdrProtocol;
  return {
    sessionId,
    providerId,
    eMAID,
    emaid: eMAID,
    protocol,
    sourceField,
    ...(value.tokenMetadata ? { tokenMetadata: cloneSnapshotValue(value.tokenMetadata, 'token metadata') as NonOwningTokenMetadata } : {}),
    uid,
    evseId,
    startTime,
    endTime,
    energyKWh: value.energyKWh,
    energyDirection: value.energyDirection,
    ...(typeof value.cdrId === 'string' && value.cdrId ? { cdrId: value.cdrId } : {}),
    ...(typeof value.reservationSessionId === 'string' && value.reservationSessionId ? { reservationSessionId: value.reservationSessionId } : {}),
    ...(typeof value.chargingSessionId === 'string' && value.chargingSessionId ? { chargingSessionId: value.chargingSessionId } : {}),
    ...(typeof value.timeZone === 'string' && value.timeZone ? { timeZone: value.timeZone } : {}),
    ...(typeof value.timeZoneSource === 'string' && value.timeZoneSource ? { timeZoneSource: value.timeZoneSource as NormalisedSession['timeZoneSource'] } : {}),
  };
}

/** Parse a stored snapshot without exposing its raw CDR or arbitrary metadata. */
export function parseAwardRecoverySnapshot(intentContext: unknown): AwardRecoverySnapshot | undefined {
  if (!isRecord(intentContext) || intentContext[RECOVERY_SNAPSHOT_KEY] === undefined) return undefined;
  const value = intentContext[RECOVERY_SNAPSHOT_KEY];
  if (!isRecord(value) || value.version !== AWARD_RECOVERY_SNAPSHOT_VERSION) {
    throw snapshotInvalid('snapshot version is unsupported');
  }
  if (typeof value.fingerprint !== 'string' || !/^[0-9a-f]{64}$/.test(value.fingerprint)) {
    throw snapshotInvalid('snapshot fingerprint is invalid');
  }
  const normalisedSession = deserialiseNormalisedSession(value.normalisedSession);
  let rawCDR: RawSession | OCPICDRFormat | undefined;
  if (value.rawCDR !== undefined) {
    if (!isRecord(value.rawCDR)) throw snapshotInvalid('original CDR is invalid');
    rawCDR = cloneSnapshotValue(value.rawCDR, 'original CDR');
  }
  return {
    version: AWARD_RECOVERY_SNAPSHOT_VERSION,
    fingerprint: value.fingerprint,
    normalisedSession: serialiseNormalisedSession(normalisedSession),
    ...(rawCDR ? { rawCDR } : {}),
  };
}

function savedAwardMetadata(intentContext: Record<string, unknown> | null | undefined): AwardMetadata | undefined {
  if (!intentContext) return undefined;
  const metadata = Object.fromEntries(
    Object.entries(intentContext).filter(([key]) => key !== 'assetContext' && key !== RECOVERY_SNAPSHOT_KEY),
  );
  return Object.keys(metadata).length ? metadata as unknown as AwardMetadata : undefined;
}

function validateStoredRecoverySnapshot(
  operation: { request_fingerprint?: string; uid?: string; amount: string; wallet_address: string },
  snapshot: AwardRecoverySnapshot,
  requireRawCDR: boolean,
): StoredRecoveryInput {
  if (requireRawCDR && !snapshot.rawCDR) throw snapshotInvalid('original CDR snapshot is unavailable');
  const amount = Number(operation.amount);
  const canonicalAmount = canonicalTokenAmount(operation.amount);
  if (!canonicalAmount || !Number.isFinite(amount)) throw snapshotInvalid('stored award amount is invalid');
  if (operation.uid && operation.uid !== snapshot.normalisedSession.uid) {
    throw snapshotInvalid('stored eMAID differs from the durable owner');
  }
  const normalised = deserialiseNormalisedSession(snapshot.normalisedSession);
  const expectedFingerprint = awardIntentFingerprint(normalised, amount, operation.wallet_address);
  if (snapshot.fingerprint !== expectedFingerprint || operation.request_fingerprint !== expectedFingerprint) {
    throw snapshotInvalid('stored snapshot fingerprint differs from the durable award intent');
  }
  if (snapshot.rawCDR) {
    let rawNormalised: NormalisedSession;
    try {
      rawNormalised = validateAndNormaliseCdr(snapshot.rawCDR);
    } catch {
      throw snapshotInvalid('original CDR snapshot cannot be validated');
    }
    if (awardIntentFingerprint(rawNormalised, amount, operation.wallet_address) !== expectedFingerprint
      || rawNormalised.eMAID !== normalised.eMAID
      || rawNormalised.protocol !== normalised.protocol
      || rawNormalised.sourceField !== normalised.sourceField) {
      throw snapshotInvalid('original CDR snapshot differs from the canonical session');
    }
  }
  return {
    normalised,
    ...(snapshot.rawCDR ? { rawCDR: snapshot.rawCDR } : {}),
  };
}

function resolveRecoveryInput(
  operation: { request_fingerprint?: string; uid?: string; amount: string; wallet_address: string; intent_context?: Record<string, unknown> | null },
  currentNormalised: NormalisedSession,
  currentRawCDR: RawSession | OCPICDRFormat,
  requireRawCDR = false,
): RecoveryInput {
  const snapshot = parseAwardRecoverySnapshot(operation.intent_context);
  if (!snapshot) return { normalised: currentNormalised, rawCDR: currentRawCDR };
  const savedChargingSessionId = snapshot.normalisedSession.chargingSessionId;
  if (savedChargingSessionId && savedChargingSessionId !== currentNormalised.chargingSessionId) {
    throw new Error(
      'TOKEN_OPERATION_CHARGING_SESSION_MISMATCH: original CDR is bound to a different charging session identity; operator review is required',
    );
  }
  const stored = validateStoredRecoverySnapshot(operation, snapshot, requireRawCDR);
  return {
    normalised: stored.normalised,
    rawCDR: stored.rawCDR || currentRawCDR,
  };
}

/** Validate a saved claim before any recovery fast path can return. */
function awardRecoveryIntentMismatch(
  operation: {
    operation_type?: string;
    request_fingerprint?: string;
    uid?: string;
    wallet_address?: string;
    charging_session_id?: string | null;
  },
  normalised: NormalisedSession,
  amount: number,
): string | undefined {
  if (operation.operation_type && operation.operation_type !== 'award') {
    return 'operation key does not identify an award operation';
  }
  if (operation.uid && operation.uid !== normalised.uid) {
    return 'saved award owner differs from the CDR eMAID';
  }
  if (operation.charging_session_id && operation.charging_session_id !== normalised.chargingSessionId) {
    return 'original CDR is bound to a different charging session identity; operator review is required';
  }
  if (operation.request_fingerprint && operation.wallet_address) {
    const fingerprint = awardIntentFingerprint(normalised, amount, operation.wallet_address);
    if (fingerprint !== operation.request_fingerprint) {
      return 'saved award fingerprint differs from the CDR financial intent';
    }
  }
  return undefined;
}

/**
 * Executes the award by transferring tokens from treasury to user.
 * Uses standard ERC20 transfer function.
 * @param signer - Treasury signer with token transfer permission
 * @param to - Recipient wallet address (resolved from uid)
 * @param amount - Number of SPARKZ tokens to award
 */
export async function executeAward(signer: ethers.Signer, to: string, amount: number): Promise<string> {
  const tx = await submitAward(signer, to, amount);
  await tx.wait();
  return tx.hash;
}

/** Submit without waiting so the transaction hash can be durably recorded. */
async function submitAward(
  signer: ethers.Signer,
  to: string,
  amount: number
): Promise<ethers.ContractTransactionResponse> {
  const canonicalAmount = canonicalTokenAmount(amount);
  if (!canonicalAmount || canonicalAmount.units <= 0n) throw new Error('UNSUPPORTED_TOKEN_PRECISION');
  const contract = getContract(signer);
  // Use standard ERC20 transfer function: transfer(to, amount)
  const tx = await contract.transfer(to, ethers.parseUnits(canonicalAmount.decimal, 18));
  return tx as ethers.ContractTransactionResponse;
}

function pendingAwardResult(
  awardResult: AwardResult,
  operationStatus: string,
  error: string,
  txHash?: string,
  requiresReview = false
): ExecutionResult {
  return {
    success: false,
    dedupKey: awardResult.dedupKey,
    eligible: awardResult.eligible,
    amount: awardResult.amount,
    uid: awardResult.uid,
    txHash,
    operationStatus,
    pending: true,
    requiresReview,
    error,
    stage: 'execution',
  };
}

async function projectAwardOperation(
  operation: {
    operation_key: string;
    status: string;
    operation_type?: string;
    legacy_key?: string | null;
    request_fingerprint?: string;
    uid?: string;
    tx_hash?: string | null;
    amount: string;
    wallet_address?: string;
    intent_context?: Record<string, unknown> | null;
    movement_outcome?: string | null;
  },
  awardResult: AwardResult,
  normalised: NormalisedSession,
  rawCDR: RawSession | OCPICDRFormat,
  walletMode: 'managed' | 'custodial',
  treasurySigner: ethers.Signer,
  verifyEvidence: (() => Promise<SpendEvidenceResult>) | undefined,
  triggerManagedApproval = false,
  requireFreshEvidence = false,
  preverifiedEvidence?: SpendEvidenceResult,
): Promise<ExecutionResult> {
  const originalAmount = Number(operation.amount);
  const replayMetadata = savedAwardMetadata(operation.intent_context) || awardResult.metadata;
  const replayAward = {
    ...awardResult,
    amount: originalAmount,
    eligible: originalAmount > 0,
    metadata: replayMetadata,
  };

  if (operation.status === 'failed') {
    const needsReview = operation.movement_outcome !== 'no_movement';
    if (needsReview) {
      return pendingAwardResult(
        replayAward,
        'failed',
        'Award evidence or durable failure state requires operator review; no replacement transfer was submitted.',
        operation.tx_hash || undefined,
        true,
      );
    }
    return failedExecutionResult({
      dedupKey: replayAward.dedupKey,
      eligible: replayAward.eligible,
      amount: originalAmount,
      uid: replayAward.uid,
      txHash: operation.tx_hash || undefined,
      operationStatus: 'failed',
      requiresReview: false,
      error: 'Award operation is marked failed; no replacement transfer was submitted.',
      stage: 'execution',
    });
  }

  if (operation.status === 'projected') {
    return {
      success: true,
      dedupKey: replayAward.dedupKey,
      eligible: replayAward.eligible,
      amount: originalAmount,
      uid: replayAward.uid,
      txHash: operation.tx_hash || undefined,
      dbStored: true,
      duplicate: true,
      operationStatus: 'projected',
      stage: 'complete',
    };
  }

  if (!operation.tx_hash) {
    if (originalAmount === 0) {
      try {
        await TokenOperations.markProjected(operation.operation_key);
      } catch (err) {
        return {
          ...pendingAwardResult(
            replayAward,
            operation.status,
            `The zero-award decision is saved but completion is pending: ${getErrorMessage(err)}`,
            undefined,
          ),
          requiresReview: false,
        };
      }
      return {
        success: true,
        dedupKey: replayAward.dedupKey,
        eligible: false,
        amount: 0,
        uid: replayAward.uid,
        duplicate: operation.status !== 'submitting',
        operationStatus: 'projected',
        stage: 'complete',
      };
    }
    return pendingAwardResult(
      replayAward,
      operation.status,
      'Token award submission is unresolved and requires operator review before retrying.',
      undefined,
      true
    );
  }

  if ((operation.status === 'submitted' || operation.status === 'unknown' || requireFreshEvidence) && verifyEvidence) {
    if (!verifyEvidence) {
      return pendingAwardResult(replayAward, operation.status, 'Award transaction is awaiting confirmation.', operation.tx_hash);
    }
    let evidence: SpendEvidenceResult;
    if (preverifiedEvidence) {
      evidence = preverifiedEvidence;
    } else {
      try {
        evidence = await verifyEvidence();
      } catch (err) {
        return pendingAwardResult(
          replayAward,
          operation.status,
          `Award transaction confirmation is pending: ${getErrorMessage(err)}`,
          operation.tx_hash
        );
      }
    }
    if (!evidence.valid) {
      if (evidence.failure.code === 'RECEIPT_PENDING'
        || evidence.failure.code === 'PROVIDER_ERROR'
        || evidence.failure.code === 'TRANSACTION_NOT_FOUND') {
        return pendingAwardResult(
          replayAward,
          operation.status,
          `Award transaction confirmation is pending: ${evidence.failure.message}`,
          operation.tx_hash,
          evidence.failure.code === 'TRANSACTION_NOT_FOUND',
        );
      }
      const movementOutcome = evidence.failure.code === 'TRANSACTION_FAILED' ? 'no_movement' : 'review';
      try {
        await TokenOperations.markFailed(
          operation.operation_key,
          `Award evidence rejected: ${evidence.failure.message}`,
          movementOutcome,
        );
      } catch (err) {
        return pendingAwardResult(
          replayAward,
          operation.status,
          `Award evidence was rejected, but durable failure state could not be saved: ${getErrorMessage(err)}`,
          operation.tx_hash,
          true,
        );
      }
      if (movementOutcome === 'review') {
        return pendingAwardResult(
          replayAward,
          'failed',
          `Award transfer was not projected because chain evidence requires operator review (${evidence.failure.code}): ${evidence.failure.message}`,
          operation.tx_hash,
          true,
        );
      }
      return failedExecutionResult({
        dedupKey: replayAward.dedupKey,
        eligible: replayAward.eligible,
        amount: originalAmount,
        uid: replayAward.uid,
        txHash: operation.tx_hash,
        operationStatus: 'failed',
        requiresReview: false,
        error: `Award transfer was not projected because chain evidence was rejected (${evidence.failure.code}): ${evidence.failure.message}`,
        stage: 'execution',
      });
    }
    try {
      await TokenOperations.markConfirmed(operation.operation_key);
    } catch (err) {
      return pendingAwardResult(
        replayAward,
        'submitted',
        `Award was confirmed on-chain but confirmation state could not be saved: ${getErrorMessage(err)}`,
        operation.tx_hash
      );
    }
  }

  try {
    await recordAward(
      normalised,
      originalAmount,
      replayAward.dedupKey,
      operation.tx_hash,
      JSON.stringify(rawCDR),
      replayAward.metadata,
      operation.wallet_address,
    );
  } catch (err) {
    try {
      await TokenOperations.markProjectionError(operation.operation_key, getErrorMessage(err));
    } catch {
      // The operation row still retains the transaction hash.  A later
      // replay can retry this projection even if the error update also failed.
    }
    return {
      ...pendingAwardResult(
        replayAward,
        'confirmed',
        `Award transfer is confirmed, but database projection is pending: ${getErrorMessage(err)}`,
        operation.tx_hash
      ),
      dbStored: false,
      dbError: getErrorMessage(err),
    };
  }

  try {
    await TokenOperations.markProjected(operation.operation_key);
  } catch (err) {
    return {
      ...pendingAwardResult(
        replayAward,
        'confirmed',
        `Award transfer is confirmed, but operation completion is pending: ${getErrorMessage(err)}`,
        operation.tx_hash
      ),
      dbStored: true,
      dbError: getErrorMessage(err),
    };
  }

  if (triggerManagedApproval && walletMode === 'managed') {
    (async () => {
      try {
        const treasuryAddress = getTreasuryAddress();
        await approveUserForSpendingViaFunding(replayAward.uid, treasurySigner, treasuryAddress);
        console.log(`✓ Approval completed for user ${replayAward.uid}`);
      } catch (approvalErr) {
        console.error(`✗ Approval failed for user ${replayAward.uid}:`, getErrorMessage(approvalErr));
      }
    })();
  }

  return {
    success: true,
    dedupKey: replayAward.dedupKey,
    eligible: true,
    amount: originalAmount,
    uid: replayAward.uid,
    txHash: operation.tx_hash,
    dbStored: true,
    operationStatus: 'projected',
    stage: 'complete',
  };
}

/**
 * Recover a future award directly from its durable operation snapshot.
 *
 * This is deliberately an operation-key recovery primitive, rather than an
 * admin retry route. It never claims or submits a new transfer. A new award
 * claim stores the canonical session and original wire CDR before submission,
 * so a process that lost the caller's CDR can still verify and project the
 * existing operation. Historical rows without this snapshot fail closed.
 */
export async function recoverAwardOperation(
  operationKey: string,
  treasurySigner: ethers.Signer,
  options: { requireFreshEvidence?: boolean } = {},
): Promise<ExecutionResult> {
  const requireFreshEvidence = options.requireFreshEvidence === true;
  let operation;
  try {
    operation = await TokenOperations.findByKey(operationKey);
  } catch (err) {
    return failedExecutionResult({
      error: `Operation recovery lookup failed: ${getErrorMessage(err)}`,
      stage: 'execution',
    });
  }
  if (!operation) {
    return failedExecutionResult({
      error: 'TOKEN_OPERATION_NOT_FOUND: award operation was not found',
      stage: 'validation',
    });
  }
  if (operation.operation_type && operation.operation_type !== 'award') {
    return failedExecutionResult({
      error: 'TOKEN_OPERATION_INTENT_MISMATCH: operation is not an award',
      stage: 'validation',
    });
  }

  if (requireFreshEvidence && operation.status !== 'projected') {
    const txHash = canonicalTransactionHash(operation.tx_hash);
    if (!txHash) {
      return failedExecutionResult({
        uid: operation.uid || '',
        amount: Number(operation.amount) || 0,
        txHash: operation.tx_hash || undefined,
        operationStatus: operation.status,
        pending: true,
        requiresReview: true,
        error: 'AWARD_RECOVERY_CHAIN_HASH_REQUIRED: a canonical saved transaction hash is required; no award transfer was submitted',
        stage: 'validation',
      });
    }
  }

  // A completed award with a canonical hash is already a safe idempotent
  // result.  Repeating its operation key must not depend on the caller's CDR
  // snapshot and must never enter a transfer path.  Hashless projected rows
  // (including zero-award decisions) remain blocked by the admin eligibility
  // layer and are not treated as recoverable movement.
  if (operation.status === 'projected') {
    const txHash = canonicalTransactionHash(operation.tx_hash);
    if (!txHash) {
      return failedExecutionResult({
        uid: operation.uid || '',
        amount: Number(operation.amount) || 0,
        operationStatus: operation.status,
        requiresReview: true,
        error: 'AWARD_RECOVERY_CHAIN_HASH_REQUIRED: a canonical saved transaction hash is required for a projected award',
        stage: 'validation',
      });
    }
    return {
      success: true,
      dedupKey: operation.legacy_key || operation.operation_key,
      eligible: Number(operation.amount) > 0,
      amount: Number(operation.amount) || 0,
      uid: operation.uid || '',
      txHash,
      dbStored: true,
      duplicate: true,
      operationStatus: 'projected',
      stage: 'complete',
    };
  }

  let recoveryInput: RecoveryInput;
  try {
    const snapshot = parseAwardRecoverySnapshot(operation.intent_context);
    if (!snapshot) throw snapshotInvalid('original award recovery snapshot is unavailable');
    const storedRecovery = validateStoredRecoverySnapshot(operation, snapshot, true);
    if (!storedRecovery.rawCDR) throw snapshotInvalid('original CDR snapshot is unavailable');
    recoveryInput = {
      normalised: storedRecovery.normalised,
      rawCDR: storedRecovery.rawCDR,
    };
    if (operation.operation_key !== awardOperationKey(
      recoveryInput.normalised.providerId,
      recoveryInput.normalised.sessionId,
    )) {
      throw snapshotInvalid('stored session does not match the operation key');
    }
  } catch (err) {
    return failedExecutionResult({
      uid: operation.uid || '',
      amount: Number(operation.amount) || 0,
      txHash: operation.tx_hash || undefined,
      operationStatus: operation.status,
      requiresReview: true,
      error: getErrorMessage(err),
      stage: 'validation',
    });
  }

  const amount = Number(operation.amount);
  const awardResult: AwardResult = {
    eligible: amount > 0,
    amount,
    uid: recoveryInput.normalised.uid,
    dedupKey: operation.legacy_key || `${recoveryInput.normalised.sessionId}-${recoveryInput.normalised.providerId}`,
    metadata: savedAwardMetadata(operation.intent_context),
  };

  let walletMode: 'managed' | 'custodial';
  try {
    walletMode = (await getUserWalletConfig(awardResult.uid)).walletMode;
  } catch {
    walletMode = 'custodial';
  }

  let assetContext: Awaited<ReturnType<typeof getTokenAssetContext>>;
  try {
    assetContext = await getTokenAssetContext(treasurySigner, getTreasuryAddress());
  } catch (err) {
    return pendingAwardResult(
      awardResult,
      operation.status,
      `Award recovery could not verify the original asset context and remains pending: ${getErrorMessage(err)}`,
      operation.tx_hash || undefined,
      true,
    );
  }
  const assetMismatch = assetContextMismatch(operation.intent_context, assetContext);
  if (assetMismatch) {
    return {
      ...pendingAwardResult(
        awardResult,
        operation.status,
        `AWARD_RECOVERY_ASSET_CONTEXT_MISMATCH: original asset context no longer matches: ${assetMismatch}`,
        operation.tx_hash || undefined,
        true,
      ),
      amount,
    };
  }

  const provider = treasurySigner.provider;
  const verifyEvidence = operation.tx_hash && provider
    ? () => {
      const existingAmount = canonicalTokenAmount(operation.amount);
      if (!existingAmount) {
        return Promise.resolve({
          valid: false,
          failure: {
            code: 'INVALID_AMOUNT',
            message: 'stored award amount is not an exact two-decimal value',
            pending: false,
          },
        } as SpendEvidenceResult);
      }
      return verifySpendEvidence({
        provider,
        tokenContractAddress: assetContext.tokenContractAddress,
        chainId: assetContext.chainId,
        sourceWallet: assetContext.signerAddress,
        treasuryRecipient: operation.wallet_address,
        amountUnits: ethers.parseUnits(existingAmount.decimal, 18),
        txHash: operation.tx_hash as string,
      });
    }
    : undefined;

  let preverifiedEvidence: SpendEvidenceResult | undefined;
  if (requireFreshEvidence) {
    if (!verifyEvidence) {
      return pendingAwardResult(
        awardResult,
        operation.status,
        'AWARD_RECOVERY_CHAIN_READ_UNAVAILABLE: the saved award hash could not be verified without a read-only provider',
        operation.tx_hash || undefined,
        true,
      );
    }
    try {
      preverifiedEvidence = await verifyEvidence();
    } catch (err) {
      return pendingAwardResult(
        awardResult,
        operation.status,
        `AWARD_RECOVERY_CHAIN_READ_UNAVAILABLE: ${getErrorMessage(err)}`,
        operation.tx_hash || undefined,
        false,
      );
    }
    if (!preverifiedEvidence.valid) {
      const requiresReview = !['RECEIPT_PENDING', 'PROVIDER_ERROR'].includes(preverifiedEvidence.failure.code);
      return pendingAwardResult(
        awardResult,
        operation.status,
        `AWARD_RECOVERY_EVIDENCE_BLOCKED: ${preverifiedEvidence.failure.code}`,
        operation.tx_hash || undefined,
        requiresReview,
      );
    }
  }

  return projectAwardOperation(
    operation,
    awardResult,
    recoveryInput.normalised,
    recoveryInput.rawCDR,
    walletMode,
    treasurySigner,
    verifyEvidence,
    false,
    requireFreshEvidence,
    preverifiedEvidence,
  );
}

/**
 * Complete reward execution pipeline orchestrator.
 * 
 * Orchestrates the full flow from raw CDR to on-chain execution:
 * 1. Normalise raw CDR data
 * 2. Calculate tokens based on rules
 * 3. Validate against business rules
 * 4. Resolve user UID to Polygon address (auto-creates if first time)
 * 5. Execute on-chain transfer (required)
 * 
 * @param rawCDR - Raw CDR data (OCPI format or custom)
 * @param treasurySigner - ethers.Signer for treasury (required for on-chain execution)
 * @param deduplicationCheck - Optional function to check if (dedupKey) has been processed
 * @returns ExecutionResult with status, amounts, and transaction hash
 */
export async function processAwardFromCDR(
  rawCDR: RawSession | OCPICDRFormat,
  treasurySigner: ethers.Signer,
  deduplicationCheck?: (dedupKey: string) => Promise<boolean>
): Promise<ExecutionResult> {
  try {
    // Stage 1: Normalise
    let normalised: NormalisedSession;
    try {
      // Financial execution uses the strict CDR boundary validator. The
      // permissive library normaliser remains available for compatibility,
      // but missing timestamps/energy must never reach a token claim.
      normalised = validateAndNormaliseCdr(rawCDR);
    } catch (err) {
      return failedExecutionResult({
        error: `Normalisation failed: ${getErrorMessage(err)}`,
        stage: 'normalisation',
      });
    }

    // Look up an existing claim before applying current policy calculations.
    // A confirmed/submitted operation must be recoverable with its original
    // amount even if rates, timezone rules, or the cap changed after the
    // first request.
    const operationKey = awardOperationKey(normalised.providerId, normalised.sessionId);
    let existingOperation;
    try {
      existingOperation = await TokenOperations.findByKey(operationKey);
    } catch (err) {
      return failedExecutionResult({
        dedupKey: `${normalised.sessionId}-${normalised.providerId}`,
        eligible: false,
        amount: 0,
        uid: normalised.uid,
        error: `Operation recovery lookup failed: ${getErrorMessage(err)}`,
        stage: 'execution',
      });
    }

    let awardResult: AwardResult;
    if (existingOperation) {
      const savedAmount = Number(existingOperation.amount);
      awardResult = {
        eligible: savedAmount > 0,
        amount: savedAmount,
        uid: existingOperation.uid || normalised.uid,
        dedupKey: existingOperation.legacy_key || `${normalised.sessionId}-${normalised.providerId}`,
        metadata: savedAwardMetadata(existingOperation.intent_context),
      };
    } else {
      try {
        awardResult = prepareAward(normalised);
      } catch (err) {
        return failedExecutionResult({
          dedupKey: normalised.uid ? `${normalised.sessionId}-${normalised.providerId}` : '',
          uid: normalised.uid,
          error: `Calculation failed: ${getErrorMessage(err)}`,
          stage: 'calculation',
        });
      }
    }

    let recoveryInput: RecoveryInput = { normalised, rawCDR };
    if (existingOperation) {
      try {
        recoveryInput = resolveRecoveryInput(existingOperation, normalised, rawCDR);
      } catch (err) {
        return failedExecutionResult({
          dedupKey: awardResult.dedupKey,
          eligible: Number(existingOperation.amount) > 0,
          amount: Number(existingOperation.amount),
          uid: existingOperation.uid || normalised.uid,
          txHash: existingOperation.tx_hash || undefined,
          operationStatus: existingOperation.status,
          requiresReview: true,
          error: getErrorMessage(err),
          stage: 'validation',
        });
      }
    }

    if (exceedsTokenOperationCap(awardResult.amount) && !existingOperation) {
      return failedExecutionResult({
        dedupKey: awardResult.dedupKey,
        eligible: awardResult.eligible,
        amount: awardResult.amount,
        uid: awardResult.uid,
        error: `TOKEN_AMOUNT_CAP_EXCEEDED: award amount cannot exceed ${MAX_TOKENS_PER_OPERATION} SPARKZ`,
        stage: 'validation',
      });
    }

    // Stage 3: Validate (check idempotency if checker provided)
    if (deduplicationCheck && !existingOperation) {
      try {
        const alreadyProcessed = await deduplicationCheck(awardResult.dedupKey);
        if (alreadyProcessed) {
          return failedExecutionResult({
            dedupKey: awardResult.dedupKey,
            eligible: awardResult.eligible,
            amount: awardResult.amount,
            uid: awardResult.uid,
            error: 'Session already processed (deduplication)',
            stage: 'validation',
          });
        }
      } catch (err) {
        return failedExecutionResult({
          dedupKey: awardResult.dedupKey,
          eligible: awardResult.eligible,
          amount: awardResult.amount,
          uid: awardResult.uid,
          error: `Deduplication check failed: ${getErrorMessage(err)}`,
          stage: 'validation',
        });
      }
    }

    // Stage 4: Resolve user UID to Polygon address (auto-creates if first time).
    // This also supplies the immutable intended owner for a zero-award decision.
    let userWalletAddress: string;
    let walletMode: 'managed' | 'custodial';
    if (existingOperation) {
      // The owner is part of the original financial intent. A later wallet
      // relink must not redirect recovery to a different address.
      userWalletAddress = existingOperation.wallet_address;
      try {
        walletMode = (await getUserWalletConfig(awardResult.uid)).walletMode;
      } catch {
        walletMode = 'custodial';
      }
    } else {
      try {
        const walletConfig = await getUserWalletConfig(awardResult.uid);
        userWalletAddress = walletConfig.walletAddress;
        walletMode = walletConfig.walletMode;
      } catch (err) {
        return failedExecutionResult({
          dedupKey: awardResult.dedupKey,
          eligible: true,
          amount: awardResult.amount,
          uid: awardResult.uid,
          error: `Address resolution failed: ${getErrorMessage(err)}`,
          stage: 'validation',
        });
      }
    }

    if (existingOperation) {
      const savedAmount = Number(existingOperation.amount);
      const recoveryMismatch = awardRecoveryIntentMismatch(existingOperation, normalised, savedAmount);
      if (recoveryMismatch) {
        return failedExecutionResult({
          dedupKey: awardResult.dedupKey,
          eligible: savedAmount > 0,
          amount: savedAmount,
          uid: normalised.uid,
          txHash: existingOperation.tx_hash || undefined,
          operationStatus: existingOperation.status,
          requiresReview: true,
          error: `TOKEN_OPERATION_INTENT_MISMATCH: ${recoveryMismatch}`,
          stage: 'validation',
        });
      }
    }

    // A zero-award decision has no asset movement to verify. It can safely
    // finish a previously interrupted projection even when the current RPC
    // context is unavailable.
    if (existingOperation && Number(existingOperation.amount) === 0 && !existingOperation.tx_hash) {
      return projectAwardOperation(
        existingOperation,
        awardResult,
        recoveryInput.normalised,
        recoveryInput.rawCDR,
        walletMode,
        treasurySigner,
        undefined,
      );
    }

    let assetContext: Awaited<ReturnType<typeof getTokenAssetContext>>;
    try {
      assetContext = await getTokenAssetContext(treasurySigner, getTreasuryAddress());
    } catch (err) {
      if (existingOperation) {
        return pendingAwardResult(
          { ...awardResult, amount: Number(existingOperation.amount), eligible: Number(existingOperation.amount) > 0 },
          existingOperation.status,
          `Award recovery could not verify the original asset context and remains pending: ${getErrorMessage(err)}`,
          existingOperation.tx_hash || undefined,
          true,
        );
      }
      return failedExecutionResult({
        dedupKey: awardResult.dedupKey,
        eligible: awardResult.eligible,
        amount: awardResult.amount,
        uid: awardResult.uid,
        error: `Asset context unavailable: ${getErrorMessage(err)}`,
        stage: 'execution',
      });
    }
    const assetMismatch = existingOperation
      ? assetContextMismatch(existingOperation.intent_context, assetContext)
      : undefined;
    if (assetMismatch && existingOperation) {
      const storedOperation = existingOperation;
      return {
        ...pendingAwardResult(
          { ...awardResult, amount: Number(storedOperation.amount), eligible: Number(storedOperation.amount) > 0 },
          storedOperation.status,
          `Award recovery is blocked because the original asset context no longer matches: ${assetMismatch}`,
          storedOperation.tx_hash || undefined,
          true,
        ),
        amount: Number(storedOperation.amount),
      };
    }

    const canonicalAmount = canonicalTokenAmount(awardResult.amount);
    if (!canonicalAmount) {
      return failedExecutionResult({
        dedupKey: awardResult.dedupKey,
        eligible: awardResult.eligible,
        amount: awardResult.amount,
        uid: awardResult.uid,
        error: 'UNSUPPORTED_TOKEN_PRECISION: award amount cannot be represented at two-decimal storage precision',
        stage: 'validation',
      });
    }
    const requestFingerprint = awardIntentFingerprint(normalised, awardResult.amount, userWalletAddress);

    let recoverySnapshot: AwardRecoverySnapshot | undefined;
    if (!existingOperation) {
      try {
        recoverySnapshot = createAwardRecoverySnapshot(
          normalised,
          awardResult.amount,
          userWalletAddress,
          rawCDR,
        );
      } catch (err) {
        return failedExecutionResult({
          dedupKey: awardResult.dedupKey,
          eligible: awardResult.eligible,
          amount: awardResult.amount,
          uid: awardResult.uid,
          error: `Award recovery snapshot could not be saved: ${getErrorMessage(err)}`,
          stage: 'validation',
        });
      }
    }

    const claimIntentContext = {
      ...(awardResult.metadata || {}),
      assetContext,
      ...(recoverySnapshot ? { [RECOVERY_SNAPSHOT_KEY]: recoverySnapshot } : {}),
    };

    // Stage 5: claim durable operation before any chain call.  Existing
    // legacy awards are retained as a duplicate only after their tuple has
    // been checked by TokenOperations.claim.
    try {
      const claim = await TokenOperations.claim({
        operationKey,
        operationType: 'award',
        requestFingerprint,
        uid: normalised.uid,
        walletAddress: userWalletAddress,
        amount: canonicalAmount.decimal,
        sessionId: normalised.sessionId,
        providerId: normalised.providerId,
        chargingSessionId: normalised.chargingSessionId,
        intentContext: claimIntentContext,
        legacyKey: awardResult.dedupKey,
      });

      if (claim.legacyRecord) {
        return {
          success: true,
          dedupKey: awardResult.dedupKey,
          eligible: Number(claim.legacyRecord.amount) > 0,
          amount: Number(claim.legacyRecord.amount),
          uid: awardResult.uid,
          txHash: claim.legacyRecord.tx_hash,
          dbStored: true,
          duplicate: true,
          operationStatus: 'projected',
          stage: 'complete',
        };
      }

      const claimedAssetMismatch = assetContextMismatch(claim.operation?.intent_context, assetContext);
      if (claimedAssetMismatch && claim.operation) {
        return {
          ...pendingAwardResult(
            { ...awardResult, amount: Number(claim.operation.amount), eligible: Number(claim.operation.amount) > 0 },
            claim.operation.status,
            `Award recovery is blocked because the original asset context no longer matches: ${claimedAssetMismatch}`,
            claim.operation.tx_hash || undefined,
            true,
          ),
          amount: Number(claim.operation.amount),
        };
      }

      if (!claim.acquired) {
        const existing = claim.operation;
        let claimedRecoveryInput: RecoveryInput;
        try {
          claimedRecoveryInput = resolveRecoveryInput(existing, normalised, rawCDR);
        } catch (err) {
          return failedExecutionResult({
            dedupKey: awardResult.dedupKey,
            eligible: Number(existing.amount) > 0,
            amount: Number(existing.amount),
            uid: existing.uid || normalised.uid,
            txHash: existing.tx_hash || undefined,
            operationStatus: existing.status,
            requiresReview: true,
            error: getErrorMessage(err),
            stage: 'validation',
          });
        }
        const provider = treasurySigner.provider;
        const verifyEvidenceForExisting = existing.tx_hash && provider
          ? () => {
            const existingAmount = canonicalTokenAmount(existing.amount);
            if (!existingAmount) {
              return Promise.resolve({
                valid: false,
                failure: {
                  code: 'INVALID_AMOUNT',
                  message: 'stored award amount is not an exact two-decimal value',
                  pending: false,
                },
              } as SpendEvidenceResult);
            }
            return verifySpendEvidence({
              provider,
              tokenContractAddress: assetContext.tokenContractAddress,
              chainId: assetContext.chainId,
              sourceWallet: assetContext.signerAddress,
              treasuryRecipient: existing.wallet_address,
              amountUnits: ethers.parseUnits(existingAmount.decimal, 18),
              txHash: existing.tx_hash as string,
            });
          }
          : undefined;
        return projectAwardOperation(
          existing,
          awardResult,
          claimedRecoveryInput.normalised,
          claimedRecoveryInput.rawCDR,
          walletMode,
          treasurySigner,
          verifyEvidenceForExisting,
        );
      }

      if (!awardResult.eligible) {
        try {
          await TokenOperations.markProjected(operationKey);
        } catch (err) {
          return {
            ...pendingAwardResult(
              awardResult,
              'submitting',
              `The zero-award decision was saved as an intent but completion is pending: ${getErrorMessage(err)}`,
              undefined,
            ),
            requiresReview: false,
          };
        }
        return {
          success: true,
          dedupKey: awardResult.dedupKey,
          eligible: false,
          amount: 0,
          uid: awardResult.uid,
          operationStatus: 'projected',
          stage: 'complete',
        };
      }

      let tx: ethers.ContractTransactionResponse;
      try {
        tx = await submitAward(treasurySigner, userWalletAddress, awardResult.amount);
      } catch (err) {
        try {
          await TokenOperations.markUnknown(operationKey, `Submission outcome is unknown: ${getErrorMessage(err)}`);
        } catch {
          // The durable claim remains in place even if the error update is
          // unavailable.  A retry still fails closed on the claim.
        }
        return pendingAwardResult(
          awardResult,
          'unknown',
          `Award submission outcome is unknown and requires operator review: ${getErrorMessage(err)}`,
          undefined,
          true
        );
      }

      try {
        await TokenOperations.markSubmitted(operationKey, tx.hash);
      } catch (err) {
        // We know a hash in process memory, but it was not durably saved.  Do
        // not resubmit; retain the claim and surface this for review.
        try {
          await TokenOperations.markUnknown(operationKey, `Transaction hash could not be persisted: ${getErrorMessage(err)}`);
        } catch {
          // See comment above: the claim itself prevents an automatic replay.
        }
        return pendingAwardResult(
          awardResult,
          'unknown',
          `Award was submitted but its transaction hash could not be durably saved; operator review is required.`,
          tx.hash,
          true
        );
      }

      return projectAwardOperation(
        {
          operation_key: operationKey,
          status: 'submitted',
          tx_hash: tx.hash,
          amount: canonicalAmount.decimal,
          wallet_address: userWalletAddress,
          intent_context: claimIntentContext,
        },
        awardResult,
        normalised,
        rawCDR,
        walletMode,
        treasurySigner,
        async () => verifySpendEvidence({
          provider: treasurySigner.provider as ethers.Provider,
          tokenContractAddress: assetContext.tokenContractAddress,
          chainId: assetContext.chainId,
          sourceWallet: assetContext.signerAddress,
          treasuryRecipient: userWalletAddress,
          amountUnits: ethers.parseUnits(canonicalAmount.decimal, 18),
          txHash: tx.hash,
        }),
        true,
      );
    } catch (err) {
      if (isAwardChargingSessionCollisionError(err)) {
        return failedExecutionResult({
          dedupKey: awardResult.dedupKey,
          eligible: awardResult.eligible,
          amount: awardResult.amount,
          uid: awardResult.uid,
          operationStatus: 'review',
          pending: true,
          requiresReview: true,
          error: err.message,
          stage: 'validation',
        });
      }
      return failedExecutionResult({
        dedupKey: awardResult.dedupKey,
        eligible: awardResult.eligible,
        amount: awardResult.amount,
        uid: awardResult.uid,
        error: `On-chain execution failed: ${getErrorMessage(err)}`,
        stage: 'execution',
      });
    }
  } catch (err) {
    return failedExecutionResult({
      error: `Unexpected error: ${getErrorMessage(err)}`,
      stage: 'normalisation',
    });
  }
}
