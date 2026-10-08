/**
 * NVF Award System REST API
 * 
 * Exposes endpoints for CDR ingestion, spend processing, and wallet queries
 * Secured with API Key authentication (except health checks)
 */

import 'dotenv/config';

import crypto from 'crypto';
import fs from 'fs';
import cors from 'cors';
import express, { Request, Response, NextFunction } from 'express';
import { ethers } from 'ethers';
import { processAwardFromCDR, processSpend } from './index';
import { recoverSpendOperation } from './spendExecutor';
import type { SpendOperationRequest, ReliableSpendExecutionResult } from './spendExecutor';
import { approveUserForSpendingViaFunding, moveFundsFromManagedWallet, recordSpend, revokeAllowanceOnManagedWallet } from './database/integration';
import { getManagedWalletAddress, getUserWalletConfig, resolveActiveUidAddress, setUserWalletMode, WalletMode } from './user/userService';
import { Awards, Spends, Users, Balances, LinkedWallets, SpendReceipts, SpendReservations, AuditLogs, ReconciliationReports, TokenOperations } from './database/service';
import type { AuditLogRecord, TokenOperationRecord } from './database/service';
import {
  RawSession,
  OCPICDRFormat,
  NormalisedSession,
  CdrNormalisationMetadata,
} from './types';
import { getRules } from './config/awardRules';
import { TimeRange, OffPeakConfig } from './types';
import { withPolicySnapshot } from './config/policyContext';
import {
  createRewardPolicyRepository,
  RewardPolicyRepository,
} from './config/policyPersistence';
import {
  createSpendReceiptPayload,
  signSpendReceipt,
  SignedSpendReceipt,
  verifySpendReceiptAgainstTrustedSigner,
} from './receipt';
import { reconcileBalance, summarizeReconciliation } from './reconciliation';
import { getDatabase } from './database/connection';
import { getTokenOperationSchemaStatus } from './database/tokenOperationSchema';
import { detectCdrProtocol, getCdrNormalisationErrorInfo, validateAndNormaliseCdr } from './normaliser';
import { prepareAward, recoverAwardOperation } from './awardExecutor';
import { calculateReservationSettlement } from './reservation';
import { buildReservationApprovalTransaction } from './reservationApproval';
import { exceedsTokenOperationCap, MAX_TOKENS_PER_OPERATION } from './config/tokenLimits';
import {
  assetContextMismatch,
  awardOperationKey,
  canonicalTokenAmount,
  getTokenAssetContext,
  reservationOperationKey,
  spendIntentFingerprint,
  spendOperationKey,
} from './database/tokenOperation';
import { verifySpendEvidence } from './spendEvidence';
import type { SpendEvidenceFailure } from './spendEvidence';
import { createAdminOperationsRouter, getAdminOperationRecoveryStatus } from './adminOperations';
import type { AdminRecoveryOutcome } from './adminOperations';
import { createRpcProvider, getPolygonRpcUrl } from './rpcProvider';
import { presentAuditEvent } from './auditPresentation';

const app = express();
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN }));
app.use(express.json());

// Configuration
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const BEIA_API_KEY = process.env.BEIA_API_KEY;
const INGEST_API_KEY = process.env.INGEST_API_KEY;
const USER_IDENTITY_HEADER = (process.env.USER_IDENTITY_HEADER || 'x-contract-id').toLowerCase();
const ENABLE_TEST_UID_LOOKUP = process.env.ENABLE_TEST_UID_LOOKUP !== 'false';
const POLYGON_RPC_URL = getPolygonRpcUrl();
const TOKEN_CONTRACT_ADDRESS = process.env.TOKEN_CONTRACT_ADDRESS || '0x605871D30DC278a036F09e2ace771df8a224624B';
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS;
const TREASURY_GAS_WARNING_THRESHOLD_MATIC = process.env.TREASURY_GAS_WARNING_THRESHOLD_MATIC || '0.05';
function getAdminAlertWebhookUrl(): string | undefined {
  return process.env.ADMIN_ALERT_WEBHOOK_URL;
}

function toSafeAdminAuditEvent(event: AuditLogRecord) {
  return {
    id: event.id,
    event_type: event.event_type,
    actor_type: event.actor_type,
    actor_id: event.actor_id ?? null,
    target_type: event.target_type ?? null,
    target_id: event.target_id ?? null,
    status: event.status,
    created_at: event.created_at,
    presentation: presentAuditEvent(event),
  };
}

// Admin credentials must be configured for admin login.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const BEIA_ADMIN_EMAIL = (process.env.BEIA_ADMIN_EMAIL || '').trim().toLowerCase();
const BEIA_ADMIN_PASSWORD = process.env.BEIA_ADMIN_PASSWORD;

// In-memory admin session tokens
const adminSessions = new Map<string, string>();

// The repository is deliberately lazy. Health, authentication, and other
// non-calculation routes can still start while an additive policy migration
// is pending; routes that read or calculate rewards fail visibly until the
// durable singleton is available.
let rewardPolicyRepository: RewardPolicyRepository | null = null;

function getRewardPolicyRepository(): RewardPolicyRepository {
  if (!rewardPolicyRepository) {
    rewardPolicyRepository = createRewardPolicyRepository(getDatabase());
  }
  return rewardPolicyRepository;
}

function sendRewardPolicyUnavailable(res: Response, error: unknown, operation: 'read' | 'write' | 'calculation'): void {
  console.error(`Reward policy ${operation} failed:`, toServerAuditDiagnostic(error));
  res.status(503).json({
    status: 'error',
    code: 'REWARD_POLICY_UNAVAILABLE',
    retryable: true,
    message: 'The durable reward policy is temporarily unavailable. Try again later.',
  });
}

function sendTokenOperationRecoveryUnavailable(
  res: Response,
  error: unknown,
  operation: 'award' | 'spend',
): void {
  console.error(`Token operation ${operation} recovery lookup failed:`, toServerAuditDiagnostic(error));
  res.status(503).json({
    status: 'error',
    code: 'TOKEN_OPERATION_RECOVERY_UNAVAILABLE',
    retryable: true,
    message: 'Unable to check token operation recovery state right now. Retry the same request shortly.',
  });
}

function getTreasurySignerKey(): string {
  if (process.env.TREASURY_SIGNER_KEY) {
    return process.env.TREASURY_SIGNER_KEY;
  }

  const keyFile = process.env.TREASURY_SIGNER_KEY_FILE;
  if (keyFile) {
    try {
      const key = fs.readFileSync(keyFile, 'utf8').trim();
      if (key) {
        return key;
      }
      throw new Error(`Key file ${keyFile} is empty`);
    } catch (err) {
      throw new Error(`Failed to read TREASURY_SIGNER_KEY_FILE at ${keyFile}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  throw new Error('TREASURY_SIGNER_KEY or TREASURY_SIGNER_KEY_FILE must be configured');
}

const treasurySigner = (() => {
  const key = getTreasurySignerKey();
  return new ethers.Wallet(key, createRpcProvider(POLYGON_RPC_URL));
})();

function normalizeUid(value: string): string {
  const trimmed = value.trim();
  if (trimmed.toLowerCase().startsWith('uid=')) {
    return trimmed.slice(4).trim();
  }
  return trimmed;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Stable identity/protocol shape shared by preview responses and ingestion
 * audit metadata. `uid` remains the legacy output alias elsewhere in the API;
 * this object always names the owner as eMAID for operator visibility.
 */
function cdrNormalisationMetadata(normalised: NormalisedSession): CdrNormalisationMetadata {
  const eMAID = normalised.eMAID || normalised.emaid || normalised.uid;
  return {
    eMAID,
    emaid: eMAID,
    protocol: normalised.protocol || 'UNKNOWN',
    sourceField: normalised.sourceField || 'unknown',
    ...(normalised.tokenMetadata ? { tokenMetadata: normalised.tokenMetadata } : {}),
    ...(normalised.chargingSessionId ? { chargingSessionId: normalised.chargingSessionId } : {}),
  };
}

function cdrNormalisationErrorMetadata(error: unknown, raw?: unknown) {
  const structured = getCdrNormalisationErrorInfo(error);
  if (structured) return structured;
  if (raw && typeof raw === 'object') {
    return {
      code: 'INVALID_PAYLOAD' as const,
      message: 'The CDR payload is invalid or incomplete.',
      protocol: detectCdrProtocol(raw),
      sourceFields: [],
    };
  }
  return undefined;
}

function isCustodialProjectionIntentMismatch(err: unknown): boolean {
  const message = getErrorMessage(err);
  return message.includes('SPEND_TX_HASH_INTENT_MISMATCH')
    || message.includes('SPEND_TX_HASH_OWNER_MISMATCH');
}

function sendJsonError(
  res: Response,
  statusCode: number,
  body: { status?: 'error'; message?: string; error?: string; code?: string } & Record<string, unknown>
) {
  return res.status(statusCode).json({
    status: 'error',
    ...body,
  });
}

function isEmailAddress(value?: string | null): boolean {
  return Boolean(value && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value));
}

function getRegisteredAdminEmail(): string | null {
  return isEmailAddress(ADMIN_EMAIL) ? ADMIN_EMAIL : null;
}

function getRegisteredAdmins(): Array<{ email: string; password: string }> {
  return [
    { email: ADMIN_EMAIL, password: ADMIN_PASSWORD || '' },
    { email: BEIA_ADMIN_EMAIL, password: BEIA_ADMIN_PASSWORD || '' },
  ].filter((admin) => isEmailAddress(admin.email) && Boolean(admin.password));
}

async function getReadinessChecks(): Promise<Array<{
  key: string;
  label: string;
  status: 'pass' | 'fail' | 'warn';
  message: string;
}>> {
  const checks: Array<{
    key: string;
    label: string;
    status: 'pass' | 'fail' | 'warn';
    message: string;
  }> = [];

  const addCheck = (key: string, label: string, passed: boolean, passMessage: string, failMessage: string, failStatus: 'fail' | 'warn' = 'fail') => {
    checks.push({
      key,
      label,
      status: passed ? 'pass' : failStatus,
      message: passed ? passMessage : failMessage,
    });
  };

  addCheck('api_key', 'General API key', Boolean(API_KEY), 'API_KEY configured', 'API_KEY is not configured', 'warn');
  addCheck('ingest_api_key', 'Ingest API key', Boolean(INGEST_API_KEY), 'INGEST_API_KEY configured', 'INGEST_API_KEY is not configured');
  addCheck('admin_email', 'Admin email login', Boolean(getRegisteredAdminEmail()), 'Admin email configured', 'Set ADMIN_EMAIL to the registered admin email address');
  addCheck('admin_password', 'Admin password', Boolean(ADMIN_PASSWORD), 'ADMIN_PASSWORD configured', 'ADMIN_PASSWORD is not configured');
  addCheck('manual_uid_lookup', 'Manual contract lookup', !ENABLE_TEST_UID_LOOKUP, 'Manual /wallet/:uid lookup disabled', 'ENABLE_TEST_UID_LOOKUP should be false in pilot/production', 'warn');
  addCheck('token_contract', 'Token contract address', ethers.isAddress(TOKEN_CONTRACT_ADDRESS), 'Token contract address is valid', 'TOKEN_CONTRACT_ADDRESS is missing or invalid');
  addCheck('treasury_address', 'Treasury address', !TREASURY_ADDRESS || ethers.isAddress(TREASURY_ADDRESS), 'Treasury address is valid or derived from signer', 'TREASURY_ADDRESS is invalid');
  addCheck('admin_alerts', 'Admin alert delivery', Boolean(getAdminAlertWebhookUrl()), 'ADMIN_ALERT_WEBHOOK_URL configured', 'ADMIN_ALERT_WEBHOOK_URL is not configured; alerts will be audited but not sent', 'warn');

  try {
    await treasurySigner.getAddress();
    checks.push({
      key: 'treasury_signer',
      label: 'Treasury signer',
      status: 'pass',
      message: 'Treasury signer key loaded',
    });
  } catch (err) {
    checks.push({
      key: 'treasury_signer',
      label: 'Treasury signer',
      status: 'fail',
      message: 'Treasury signer is unavailable; check the local signer configuration',
    });
  }

  if (!process.env.DATABASE_URL) {
    checks.push({
      key: 'database',
      label: 'Database',
      status: 'fail',
      message: 'DATABASE_URL is not configured',
    });
  } else {
    try {
      await getDatabase().raw('select 1');
      checks.push({
        key: 'database',
        label: 'Database',
        status: 'pass',
        message: 'Database connection is healthy',
      });
      try {
        const schema = await getTokenOperationSchemaStatus(getDatabase());
        if (schema.stagedReady) {
          checks.push({
            key: 'token_operation_schema',
            label: 'Durable token operation schema',
            status: 'pass',
            message: 'Durable operation tables and real transaction-hash guards are ready',
          });
        } else {
          checks.push({
            key: 'token_operation_schema',
            label: 'Durable token operation schema',
            status: 'fail',
            message: schema.validDuplicateGroups > 0
              ? 'Valid transaction-hash duplicates require operator review before durable operation staging'
              : `Required durable operation safeguards are missing: ${schema.missing.join(', ')}`,
          });
        }
        if (schema.invalidLegacyRows > 0 || !schema.strictMigrationReady) {
          checks.push({
            key: 'token_operation_legacy_hash_review',
            label: 'Historical transaction hashes',
            status: 'warn',
            message: schema.invalidLegacyRows > 0
              ? `${schema.invalidLegacyRows} legacy projection row(s) retain a non-standard transaction hash; they are preserved for review${schema.strictMigrationReady ? '' : ' and the strict historical guard remains deferred'}`
              : 'The strict historical transaction-hash migration guard remains deferred',
          });
        }
      } catch (err) {
        console.error('Durable token operation schema readiness failed:', err instanceof Error ? err.message : String(err));
        checks.push({
          key: 'token_operation_schema',
          label: 'Durable token operation schema',
          status: 'fail',
          message: 'Durable token operation schema readiness is temporarily unavailable',
        });
      }
      try {
        const policy = await getRewardPolicyRepository().load();
        checks.push({
          key: 'reward_policy',
          label: 'Durable reward policy',
          status: 'pass',
          message: `Reward policy revision ${policy.revision} is available`,
        });
      } catch (err) {
        console.error('Durable reward policy readiness failed:', toServerAuditDiagnostic(err));
        checks.push({
          key: 'reward_policy',
          label: 'Durable reward policy',
          status: 'fail',
          message: 'Durable reward policy is unavailable; run the additive policy migration before calculating awards',
        });
      }
    } catch (err) {
      checks.push({
        key: 'database',
        label: 'Database',
        status: 'fail',
        message: 'Database connection is unavailable; check the local database service',
      });
    }
  }

  return checks;
}

function getRequestContractId(req: Request): string | null {
  const raw = req.header(USER_IDENTITY_HEADER) || req.header('X-Contract-Id');
  if (!raw) {
    return null;
  }
  const normalized = normalizeUid(String(raw));
  return normalized || null;
}

const SESSION_SPEND_STATUSES = new Set(['CHARGER_OPENED', 'PLUGGED_IN', 'SESSION_STARTED']);

function getMissingFields(body: Record<string, unknown>, fields: string[]): string[] {
  return fields.filter(field => !body[field]);
}

function getPositiveAmount(value: unknown): number | null {
  const amount = canonicalTokenAmount(value);
  return amount && amount.units > 0n ? amount.value : null;
}

function hasSupportedTokenPrecision(value: unknown): boolean {
  return Boolean(canonicalTokenAmount(value));
}

function makeConfigurationError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

/**
 * The RPC provider is authoritative for the active chain. CHAIN_ID is an
 * explicit operator assertion and therefore must agree with it when set.
 * This is deliberately resolved at request time so tests and controlled
 * configuration reloads cannot retain a stale chain assertion.
 */
async function getAuthoritativeChainId(): Promise<bigint> {
  const provider = treasurySigner.provider;
  if (!provider) {
    throw makeConfigurationError('CHAIN_CONTEXT_UNAVAILABLE', 'Configured RPC provider is unavailable');
  }

  let providerChainId: bigint;
  try {
    providerChainId = BigInt((await provider.getNetwork()).chainId);
  } catch (err) {
    throw makeConfigurationError(
      'CHAIN_CONTEXT_UNAVAILABLE',
      `Unable to read the configured RPC network: ${getErrorMessage(err)}`,
    );
  }

  const configuredChainId = process.env.CHAIN_ID;
  if (configuredChainId !== undefined && !/^\d+$/.test(configuredChainId)) {
    throw makeConfigurationError('CONFIGURED_CHAIN_ID_INVALID', 'CHAIN_ID must be a non-negative integer');
  }
  if (configuredChainId !== undefined && BigInt(configuredChainId) !== providerChainId) {
    throw makeConfigurationError(
      'CONFIGURED_CHAIN_MISMATCH',
      `Configured CHAIN_ID ${configuredChainId} differs from RPC provider chain ${providerChainId.toString()}`,
    );
  }
  return providerChainId;
}

function canonicalTxHash(value: unknown): string | undefined {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
    ? value.toLowerCase()
    : undefined;
}

function normaliseOptionalContext(value: unknown): string | null {
  return value === undefined || value === null ? null : String(value);
}

function getOptionalFiniteNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function spendValidationError(res: Response, code: string, message: string, extra?: Record<string, unknown>) {
  return sendJsonError(res, 400, {
    code,
    message,
    ...(extra || {}),
  });
}

function isStableSpendKey(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function tokenCapError(res: Response, operation: 'award' | 'spend', requestedAmount: number) {
  return sendJsonError(res, 400, {
    code: 'TOKEN_AMOUNT_CAP_EXCEEDED',
    message: `${operation} amount cannot exceed ${MAX_TOKENS_PER_OPERATION} SPARKZ`,
    operation,
    requestedAmount,
    maximumAmount: MAX_TOKENS_PER_OPERATION,
  });
}

function getPublicRewardRates() {
  const rules = getRules().rules;
  const toRate = (
    key: 'offPeakCharging' | 'v2gDischarge',
    label: string,
    description: string
  ) => {
    const rule = rules[key];
    return {
      key,
      label,
      enabled: rule.enabled,
      tokensPerKWh: rule.tokensPerKWh,
      kWhPerSparkz: rule.tokensPerKWh > 0 ? Number((1 / rule.tokensPerKWh).toFixed(2)) : null,
      description: rule.description || description,
    };
  };

  return [
    toRate('offPeakCharging', 'Off-peak charging', 'SPARKZ earned for eligible off-peak charging'),
    toRate('v2gDischarge', 'V2G discharge', 'SPARKZ earned for eligible vehicle-to-grid discharge'),
  ];
}

function ensureTestUidLookupEnabled(req: Request, res: Response, next: NextFunction): void {
  if (!ENABLE_TEST_UID_LOOKUP) {
    res.status(403).json({
      status: 'error',
      message: 'Manual contract ID lookup is disabled. Use authenticated identity endpoint /wallet/me.',
    });
    return;
  }
  next();
}

function getLinkedWalletSignatureMessage(uid: string, walletAddress: string, action: 'link' | 'unlink'): string {
  return [
    `NEVERFLAT ${action} wallet address`,
    `EMP contract: ${uid}`,
    `Wallet address: ${ethers.getAddress(walletAddress)}`,
  ].join('\n');
}

function verifyLinkedWalletSignature(uid: string, walletAddress: string, action: 'link' | 'unlink', signature?: string): void {
  if (!signature) {
    throw new Error('Wallet signature is required');
  }

  const checksumWalletAddress = ethers.getAddress(walletAddress);
  const recoveredAddress = ethers.verifyMessage(
    getLinkedWalletSignatureMessage(uid, checksumWalletAddress, action),
    signature
  );

  if (recoveredAddress.toLowerCase() !== checksumWalletAddress.toLowerCase()) {
    throw new Error(`Signature must be from wallet address ${checksumWalletAddress}`);
  }
}

async function getWalletPayload(normalizedUid: string, walletAddressOverride?: string) {
  const walletConfig = await getUserWalletConfig(normalizedUid);
  const userAddress = walletAddressOverride && ethers.isAddress(walletAddressOverride)
    ? ethers.getAddress(walletAddressOverride)
    : walletConfig.walletAddress;

  // Get user (if exists)
  const user = walletAddressOverride
    ? await Users.findByUidAndWallet(normalizedUid, userAddress)
    : await Users.findByUid(normalizedUid);
  const linkedUsers = await Users.findAllByWallet(userAddress);
  const contractIds = linkedUsers.length ? linkedUsers.map(u => u.uid) : [normalizedUid];
  const walletName = linkedUsers.find(u => u.wallet_name)?.wallet_name || null;
  const linkedWalletRecords = await LinkedWallets.findByUid(normalizedUid);
  const linkedWalletAddresses = linkedWalletRecords.map(w => w.wallet_address);
  if (walletAddressOverride) {
    const allowedWalletAddresses = [
      walletConfig.walletAddress,
      walletConfig.managedWalletAddress,
      ...linkedWalletAddresses,
    ].map(address => address.toLowerCase());

    if (!allowedWalletAddresses.includes(userAddress.toLowerCase())) {
      throw new Error('Wallet address is not linked to this EMP contract');
    }
  }
  const linkedWallets = linkedWalletRecords.map(w => ({
    walletAddress: w.wallet_address,
    walletName: w.wallet_name || null,
  }));
  const linkedWalletNamesByAddress = new Map(
    linkedWalletRecords.map(w => [w.wallet_address.toLowerCase(), w.wallet_name || null])
  );
  const linkedWalletUsers = (await Promise.all(
    linkedWalletAddresses.map(address => Users.findAllByWallet(address))
  )).flat();

  let onChainBalance: string | null = null;
  let balanceReadError: string | undefined;
  try {
    onChainBalance = Number(ethers.formatEther(await getOnChainTokenBalance(userAddress))).toFixed(2);
  } catch (err) {
    balanceReadError = err instanceof Error ? err.message : String(err);
    console.warn(`Unable to read on-chain balance for ${userAddress}:`, balanceReadError);
  }

  if (!user) {
    return {
      status: 'success',
      uid: normalizedUid,
      contractIds,
      linkedWalletAddresses,
      linkedWallets,
      walletName,
      walletAddress: userAddress,
      managedWalletAddress: getManagedWalletAddress(normalizedUid),
      walletMode: walletConfig.walletMode,
      isRegistered: false,
      balance: onChainBalance || '0.00',
      ...(balanceReadError ? {
        balanceStatus: 'unavailable',
        balanceSource: 'none',
        balanceWarning: 'Live token balance is temporarily unavailable; retry before starting a spend.',
      } : {
        balanceStatus: 'confirmed',
        balanceSource: 'chain',
      }),
      totalAwarded: '0',
      totalSpent: '0',
      treasuryAddress: TREASURY_ADDRESS || null,
      tokenContractAddress: TOKEN_CONTRACT_ADDRESS,
      history: [],
    };
  }

  const profileUsers = linkedUsers.length ? linkedUsers : [user];
  const userIds = profileUsers.map(u => u.id);
  const activityUsers = [...profileUsers, ...linkedWalletUsers]
    .filter((candidate, index, all) => all.findIndex(user => user.id === candidate.id) === index);
  const activityUserIds = activityUsers.map(u => u.id);

  // Get balance and recent transactions across every contract ID linked to this wallet.
  const balances = await Promise.all(userIds.map(userId => Balances.findByUser(userId)));
  const databaseBalance = balances
    .reduce((sum, balance) => sum + Number(balance?.balance || 0), 0)
    .toFixed(2);
  const currentBalance = onChainBalance || databaseBalance;
  const totalAwarded = balances.reduce((sum, balance) => sum + Number(balance?.total_awarded || 0), 0).toFixed(2);
  const totalSpent = balances.reduce((sum, balance) => sum + Number(balance?.total_spent || 0), 0).toFixed(2);

  const awards = (await Promise.all(activityUserIds.map(userId => Awards.findByUser(userId)))).flat();
  const spends = (await Promise.all(activityUserIds.map(userId => Spends.findByUser(userId)))).flat();
  const usersById = new Map(activityUsers.map(u => [u.id, u]));

  const transactions: Array<{
    type: 'award' | 'spend';
    uid?: string | null;
    amount: string;
    label: string;
    txHash: string;
    timestamp: Date;
    walletAddress?: string;
    walletName?: string | null;
    isOffPeak?: boolean;
    countryCode?: string;
    localTime?: string;
    awardType?: string;
    status?: string;
  }> = [
    ...awards.slice(0, 20).map(a => ({
      type: 'award' as const,
      uid: usersById.get(a.user_id)?.uid || null,
      amount: a.amount,
      label: a.dedup_key,
      txHash: a.tx_hash,
      timestamp: a.awarded_at,
      walletAddress: usersById.get(a.user_id)?.wallet_address,
      walletName: usersById.get(a.user_id)?.wallet_name || null,
      isOffPeak: a.is_off_peak,
      countryCode: a.country_code,
      localTime: a.local_time,
      awardType: a.award_type,
      status: a.status || 'confirmed',
    })),
    ...spends.slice(0, 20).map(s => ({
      type: 'spend' as const,
      uid: usersById.get(s.user_id)?.uid || null,
      amount: s.amount,
      label: s.session_id || 'Manual spend',
      txHash: s.tx_hash,
      timestamp: s.created_at,
      walletAddress: s.wallet_address,
      walletName: linkedWalletNamesByAddress.get(s.wallet_address.toLowerCase()) || usersById.get(s.user_id)?.wallet_name || null,
      status: s.status || 'confirmed',
    })),
  ]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 10);

  return {
    status: 'success',
    uid: normalizedUid,
    contractIds,
    linkedWalletAddresses,
    linkedWallets,
    walletName,
    walletAddress: userAddress,
    managedWalletAddress: walletConfig.managedWalletAddress,
    walletMode: walletConfig.walletMode,
    isRegistered: true,
    balance: currentBalance,
    ...(balanceReadError ? {
      balanceStatus: 'unavailable',
      balanceSource: 'database',
      balanceWarning: 'Live token balance is temporarily unavailable; showing the last recorded balance. Retry before confirming a spend.',
    } : {
      balanceStatus: 'confirmed',
      balanceSource: 'chain',
    }),
    totalAwarded,
    totalSpent,
    treasuryAddress: TREASURY_ADDRESS || null,
    tokenContractAddress: TOKEN_CONTRACT_ADDRESS,
    history: transactions,
  };
}

async function getOnChainTokenBalance(address: string): Promise<bigint> {
  const provider = treasurySigner.provider;
  if (!provider) {
    throw new Error('Provider not available');
  }

  const token = new ethers.Contract(
    TOKEN_CONTRACT_ADDRESS,
    ['function balanceOf(address account) view returns (uint256)'],
    provider
  );

  return token.balanceOf(address) as Promise<bigint>;
}

function isTreasuryGasIssue(error?: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error || '');
  const normalized = text.toLowerCase();
  return normalized.includes('insufficient funds')
    || normalized.includes('insufficient matic')
    || normalized.includes('intrinsic gas')
    || normalized.includes('gas required exceeds')
    || normalized.includes('replacement fee too low')
    || normalized.includes('underpriced');
}

function isNetworkIssue(error?: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error || '');
  const normalized = text.toLowerCase();
  return normalized.includes('network')
    || normalized.includes('timeout')
    || normalized.includes('rpc')
    || normalized.includes('server error')
    || normalized.includes('connection')
    || normalized.includes('temporarily unavailable');
}

function toUserFacingAwardError(error?: unknown, stage?: string): string {
  const text = error instanceof Error ? error.message : String(error || '');
  if (text.startsWith('AWARD_CHARGING_SESSION_COLLISION_REVIEW:')) {
    return 'This charging session was already claimed under another CDR and requires operator review; no replacement award was submitted.';
  }
  if (stage === 'normalisation' || stage === 'validation') {
    return 'The charging session could not be processed because required charging data was invalid or incomplete.';
  }
  if (isTreasuryGasIssue(error)) {
    return 'The reward could not be settled right now. The operations team has been notified.';
  }
  if (isNetworkIssue(error)) {
    return 'The reward network is temporarily unavailable. Please retry the request shortly.';
  }
  return 'The reward could not be processed. Please retry the request or contact support.';
}

function toUserFacingAuditError(error?: unknown): string {
  if (isNetworkIssue(error)) {
    return 'The audit log is temporarily unavailable. Please retry shortly.';
  }
  return 'The audit log could not be loaded. Please retry shortly.';
}

function toServerAuditDiagnostic(error: unknown): string {
  const errorType = error instanceof Error && error.name ? error.name : typeof error;
  const message = getErrorMessage(error)
    .replace(
      /\b(password|passwd|secret|token|api[_-]?key|authorization)\s*([:=])\s*("[^"]*"|'[^']*'|[^\s;,]+)/gi,
      '$1$2[redacted]',
    )
    .replace(/(?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?):\/\/[^\s]+/gi, '[redacted database URL]')
    .slice(0, 500);
  return `${errorType}: ${message || 'unknown error'}`;
}

function toUserFacingSpendError(error?: unknown): string {
  const text = error instanceof Error ? error.message : String(error || '');
  const normalized = text.toLowerCase();
  if (normalized.includes('spend_preflight_unavailable')) {
    return 'The token network could not be read, so no SPARKZ were spent. Wait for the network to recover and retry this same spend.';
  }
  if (normalized.includes('approval_preparation_review_required')
    || normalized.includes('approval preparation')
    || normalized.includes('spend approval recovery')) {
    return 'The managed-wallet approval is waiting for chain recovery; no spend transaction was recorded. Retry this same spend after the network recovers.';
  }
  if (normalized.includes('submission outcome is unknown')
    || normalized.includes('transaction hash could not be durably saved')) {
    return 'The spend may have reached the chain but is not confirmed. Do not create a new spend; retry this same request to recover the original outcome.';
  }
  if (normalized.includes('insufficient balance') || normalized.includes('exceeds balance')) {
    return 'There are not enough SPARKZ available for this spend.';
  }
  if (normalized.includes('allowance') || normalized.includes('approve')) {
    return 'Your wallet is not ready to spend yet. Please try again shortly or contact support.';
  }
  if (isTreasuryGasIssue(error)) {
    return 'The spend could not be completed right now. The operations team has been notified.';
  }
  if (isNetworkIssue(error)) {
    return 'The spend network is temporarily unavailable. Please try again shortly.';
  }
  return 'The spend could not be completed. Please try again or contact support.';
}

function toUserFacingWalletError(error?: unknown): string {
  const text = getErrorMessage(error);
  const normalized = text.toLowerCase();
  if (normalized.includes('wallet address is not linked')) {
    return 'Wallet address is not linked to this EMP contract.';
  }
  if (normalized.includes('wallet signature is required')) {
    return 'A wallet signature is required for this request.';
  }
  if (normalized.includes('signature must be from wallet address')) {
    return 'The wallet signature does not match the requested wallet address.';
  }
  if (normalized.includes('managed wallet balance is already zero')) {
    return 'The managed wallet has no SPARKZ to move.';
  }
  if (isNetworkIssue(error) || normalized.includes('provider')) {
    return 'The wallet service is temporarily unavailable. Please retry shortly.';
  }
  return 'The wallet request could not be completed. Please retry shortly.';
}

function toUserFacingCustodialError(error?: unknown): string {
  const text = getErrorMessage(error);
  if (text === 'Invalid wallet address') return text;
  if (text === 'Wallet address is not linked to this EMP contract') return text;
  if (text === 'Spend amount must be positive and use at most 2 decimal places') return text;
  if (text.startsWith('Missing or invalid fields: uid, walletAddress, amount')) {
    return 'Missing or invalid fields: uid, walletAddress, amount (amount must be greater than 0 and use at most 2 decimal places).';
  }
  if (text === 'Treasury address is not configured') {
    return 'The configured treasury recipient is unavailable. Please retry later.';
  }
  if (text === 'Wallet signature is required') return text;
  if (isNetworkIssue(error) || text.toLowerCase().includes('provider')) {
    return 'The custodial spend network is temporarily unavailable. Please retry shortly.';
  }
  return 'The custodial spend request could not be completed. Please retry shortly.';
}

function toUserFacingSpendEvidenceFailure(failure: SpendEvidenceFailure): string {
  switch (failure.code) {
    case 'TRANSACTION_NOT_FOUND':
    case 'RECEIPT_PENDING':
      return 'The custodial transfer is not mined yet. Retry the same request after the receipt is available.';
    case 'PROVIDER_ERROR':
      return 'The transaction receipt could not be checked because the chain provider is temporarily unavailable.';
    case 'TRANSACTION_FAILED':
      return 'The custodial transaction failed on chain; no spend was recorded.';
    case 'WRONG_CHAIN':
    case 'WRONG_TOKEN_CONTRACT':
    case 'TRANSACTION_IDENTITY_MISMATCH':
    case 'RECEIPT_IDENTITY_MISMATCH':
    case 'MALFORMED_CALL':
    case 'UNSUPPORTED_TOKEN_CALL':
    case 'WRONG_SENDER':
    case 'WRONG_RECIPIENT':
    case 'WRONG_AMOUNT':
    case 'MISSING_TRANSFER_EVENT':
    case 'MALFORMED_TRANSFER_LOG':
    case 'MALFORMED_RECEIPT':
      return 'The transaction receipt does not match the requested custodial spend.';
    default:
      return 'The custodial transaction evidence is invalid for this spend.';
  }
}

function toUserFacingReceiptError(error?: unknown): string {
  const text = getErrorMessage(error).toLowerCase();
  if (text.includes('receipt') && text.includes('context')) {
    return 'The spend receipt does not match the original operation and requires operator review.';
  }
  return 'The spend receipt could not be processed. Please retry the same request shortly.';
}

async function getTokenAllowance(owner: string, spender: string): Promise<bigint> {
  const provider = treasurySigner.provider;
  if (!provider) throw new Error('Provider not available');
  const token = new ethers.Contract(
    TOKEN_CONTRACT_ADDRESS,
    ['function allowance(address owner, address spender) view returns (uint256)'],
    provider
  );
  return token.allowance(owner, spender);
}

async function processSpendWithAutoApproval(input: {
  uid: string;
  userAddress: string;
  amount: number;
  sessionId?: string;
  providerId?: string;
  reservationId?: string;
  operationKey?: string;
  idempotencyKey?: string;
  auditContext: string;
  onApprovalFailure: (approvalErr: unknown) => Promise<void>;
}): Promise<ReliableSpendExecutionResult> {
  // One logical request must use one operation key across an approval retry.
  // New manual requests must bring a stable key. Reservation settlement
  // supplies its durable reservation operation key explicitly.
  if (input.operationKey !== undefined && !isStableSpendKey(input.operationKey)) {
    return {
      success: false,
      amount: input.amount,
      userAddress: input.userAddress,
      error: 'INVALID_OPERATION_KEY: operationKey must be a non-empty string',
    };
  }
  if (input.idempotencyKey !== undefined && !isStableSpendKey(input.idempotencyKey)) {
    return {
      success: false,
      amount: input.amount,
      userAddress: input.userAddress,
      error: 'INVALID_OPERATION_KEY: idempotencyKey must be a non-empty string',
    };
  }
  const operationKey = input.operationKey !== undefined
    ? input.operationKey
    : input.idempotencyKey !== undefined
      ? spendOperationKey(input.uid, input.idempotencyKey)
      : undefined;
  if (!operationKey) {
    return {
      success: false,
      amount: input.amount,
      userAddress: input.userAddress,
      error: 'SPEND_IDEMPOTENCY_KEY_REQUIRED: a stable idempotencyKey or internal operationKey is required before a spend can be attempted',
    };
  }
  const spendRequest: SpendOperationRequest = {
    userAddress: input.userAddress,
    amount: input.amount,
    sessionId: input.sessionId,
    providerId: input.providerId,
    uid: input.uid,
    reservationId: input.reservationId,
    operationKey,
    idempotencyKey: input.idempotencyKey,
  };
  let spendResult = await processSpend(
    spendRequest,
    treasurySigner
  );

  if (spendResult.success) {
    return spendResult;
  }

  // Never retry allowance funding after a submission may already have
  // happened.  Only a clear preflight/allowance failure is eligible for the
  // existing approval recovery path.
  if (
    spendResult.pending
    || spendResult.requiresReview
    || spendResult.txHash
    || !spendResult.preflightFailure
    // A provider/read failure is a safe no-movement retry, but it is not an
    // allowance or balance result. Do not fund a managed wallet or submit an
    // approval transaction until the token preflight itself is readable.
    || spendResult.preflightApprovalEligible === false
  ) {
    return spendResult;
  }

  try {
    const treasuryAddress = process.env.TREASURY_ADDRESS;
    if (treasuryAddress) {
      await approveUserForSpendingViaFunding(input.uid, treasurySigner, treasuryAddress, input.amount);

      spendResult = await processSpend(spendRequest, treasurySigner);
    }
  } catch (approvalErr) {
    console.error('Spend auto-approval failed:', approvalErr);
    if (isTreasuryGasIssue(approvalErr)) {
      await auditTreasuryGasWarning(`spend.${input.auditContext}.auto_approval_failure`, approvalErr);
    }
    await input.onApprovalFailure(approvalErr);
    // Approval preparation persists funding/approval state before any wallet
    // transaction.  An error after that claim is not a safe preflight
    // rejection: the next request must recover the same operation rather than
    // release its key and attempt another approval or spend.
    return {
      ...spendResult,
      success: false,
      pending: true,
      requiresReview: true,
      preflightFailure: false,
      operationStatus: 'unknown',
      error: `Spend approval recovery requires operator review: ${getErrorMessage(approvalErr)}`,
    };
  }

  return spendResult;
}

function makeTokenRecoveryError(message: string, details: Record<string, unknown> = {}): Error & Record<string, unknown> {
  return Object.assign(new Error(message), details);
}

/**
 * A settled reservation may be replayed only from the original durable spend
 * intent.  The reservation row has the hash and projection state, but its
 * receipt must retain the operation's owner, amount, session, reservation,
 * and asset context.  Without this check, a receipt outage followed by a
 * configuration change could mint a new receipt that relabels an old token
 * transfer with the current token/signer configuration.
 */
async function validateSettledReservationRecoveryContext(
  session: NormalisedSession,
  reservation: {
    id: string;
    uid: string;
    wallet_address: string;
    session_id: string;
    provider_id: string;
    settled_amount?: string | null;
    tx_hash?: string | null;
  },
  reservationSessionId: string,
): Promise<void> {
  let operation;
  try {
    operation = await TokenOperations.findByKey(reservationOperationKey(reservation.id));
  } catch (err) {
    throw makeTokenRecoveryError(
      `Original reservation operation could not be checked: ${getErrorMessage(err)}`,
      { pending: true, requiresReview: true, reservationId: reservation.id, txHash: reservation.tx_hash, financialStatus: 'unknown' },
    );
  }

  const operationAmount = operation && canonicalTokenAmount(operation.amount);
  const settledAmount = canonicalTokenAmount(reservation.settled_amount);
  const operationHash = operation && canonicalTxHash(operation.tx_hash);
  const reservationHash = canonicalTxHash(reservation.tx_hash);
  const ownerMatches = operation
    && typeof operation.wallet_address === 'string'
    && operation.wallet_address.toLowerCase() === reservation.wallet_address.toLowerCase();
  const operationContextMatches = operation
    && operation.operation_type === 'spend'
    && operation.uid === session.uid
    && operation.uid === reservation.uid
    && ownerMatches
    && operation.reservation_id === reservation.id
    && operation.session_id === reservationSessionId
    && operation.session_id === reservation.session_id
    && operation.provider_id === session.providerId
    && operation.provider_id === reservation.provider_id
    && operationAmount
    && settledAmount
    && operationAmount.units === settledAmount.units
    && operationHash
    && reservationHash
    && operationHash === reservationHash
    && operation.status !== 'failed'
    && operation.status !== 'unknown';

  if (!operation || !operationContextMatches) {
    throw makeTokenRecoveryError(
      'Settled reservation lacks a matching durable spend intent and requires operator review.',
      { pending: true, requiresReview: true, reservationId: reservation.id, txHash: reservation.tx_hash, financialStatus: 'confirmed' },
    );
  }

  let currentAssetContext;
  try {
    currentAssetContext = await getTokenAssetContext(treasurySigner, await getTreasuryWalletAddress());
  } catch (err) {
    throw makeTokenRecoveryError(
      `Original reservation asset context could not be checked: ${getErrorMessage(err)}`,
      { pending: true, requiresReview: true, reservationId: reservation.id, txHash: reservation.tx_hash, financialStatus: 'confirmed' },
    );
  }
  const assetMismatch = assetContextMismatch(operation.intent_context, currentAssetContext);
  if (assetMismatch) {
    throw makeTokenRecoveryError(
      `Settled reservation receipt recovery is blocked because the original asset context no longer matches: ${assetMismatch}`,
      { pending: true, requiresReview: true, reservationId: reservation.id, txHash: reservation.tx_hash, financialStatus: 'confirmed' },
    );
  }
}

/**
 * Reserve a durable no-movement operation before releasing a zero-settlement
 * hold.  A zero amount is valid for the token-operation ledger and lets a
 * retry distinguish an intentional release from an old settling row that has
 * no recovery intent.  The amount, owner, wallet, reservation, session and
 * provider are fingerprinted so a positive spend can never reuse this key.
 */
async function ensureZeroSettlementOperation(
  session: NormalisedSession,
  reservation: {
    id: string;
    uid: string;
    wallet_address: string;
  },
  reservationSessionId: string,
): Promise<void> {
  const operationKey = reservationOperationKey(reservation.id);
  let assetContext;
  try {
    assetContext = await getTokenAssetContext(treasurySigner, await getTreasuryWalletAddress());
  } catch (err) {
    throw makeTokenRecoveryError(
      `Zero-settlement recovery context could not be checked: ${getErrorMessage(err)}`,
      {
        pending: true,
        settlementPending: true,
        retryable: false,
        requiresReview: true,
        reservationId: reservation.id,
        financialStatus: 'unknown',
      },
    );
  }

  const requestFingerprint = spendIntentFingerprint({
    uid: session.uid,
    walletAddress: reservation.wallet_address,
    amount: 0,
    sessionId: reservationSessionId,
    providerId: session.providerId,
    reservationId: reservation.id,
  });
  let claim;
  try {
    claim = await TokenOperations.claim({
      operationKey,
      operationType: 'spend',
      requestFingerprint,
      uid: session.uid,
      walletAddress: reservation.wallet_address,
      amount: '0.00',
      sessionId: reservationSessionId,
      providerId: session.providerId,
      reservationId: reservation.id,
      intentContext: { assetContext },
    });
  } catch (err) {
    const requiresReview = getErrorMessage(err).includes('TOKEN_OPERATION_INTENT_MISMATCH');
    throw makeTokenRecoveryError(
      `Zero-settlement recovery intent could not be claimed: ${getErrorMessage(err)}`,
      {
        pending: true,
        settlementPending: true,
        retryable: !requiresReview,
        requiresReview,
        reservationId: reservation.id,
        financialStatus: 'unknown',
      },
    );
  }

  const operation = claim?.operation;
  if (!operation) {
    throw makeTokenRecoveryError(
      'Zero-settlement recovery intent is missing and requires operator review.',
      {
        pending: true,
        settlementPending: true,
        retryable: false,
        requiresReview: true,
        reservationId: reservation.id,
        financialStatus: 'unknown',
      },
    );
  }
  const operationAmount = canonicalTokenAmount(operation.amount);
  if (!operationAmount || operationAmount.units !== 0n || operation.status === 'failed') {
    throw makeTokenRecoveryError(
      'Zero-settlement recovery found a conflicting or failed token operation and requires operator review.',
      {
        pending: true,
        settlementPending: true,
        retryable: false,
        requiresReview: true,
        reservationId: reservation.id,
        financialStatus: 'unknown',
      },
    );
  }
  const assetMismatch = assetContextMismatch(operation.intent_context, assetContext);
  if (assetMismatch) {
    throw makeTokenRecoveryError(
      `Zero-settlement recovery is blocked because the original asset context no longer matches: ${assetMismatch}`,
      {
        pending: true,
        settlementPending: true,
        retryable: false,
        requiresReview: true,
        reservationId: reservation.id,
        financialStatus: 'unknown',
      },
    );
  }

  try {
    const projected = await TokenOperations.markProjected(operationKey);
    if (!projected) throw new Error('zero-settlement operation disappeared before projection');
  } catch (err) {
    throw makeTokenRecoveryError(
      `Zero-settlement recovery intent projection is pending: ${getErrorMessage(err)}`,
      {
        pending: true,
        settlementPending: true,
        retryable: true,
        requiresReview: false,
        reservationId: reservation.id,
        financialStatus: 'unknown',
      },
    );
  }
}

async function settleReservationFromCdr(session: NormalisedSession) {
  const reservationSessionId = (session as NormalisedSession & { reservationSessionId?: string }).reservationSessionId
    || session.sessionId;
  let reservation = await SpendReservations.findBySession(session.uid, reservationSessionId, session.providerId);
  if (reservation && (reservation.status === 'settled' || reservation.status === 'released')) {
    // A prior request may have settled the token movement but failed while
    // creating the receipt.  Recover the receipt from the known tx hash and
    // return the durable reservation instead of attempting another transfer.
    if (reservation.status === 'released') return reservation;
    if (!reservation.tx_hash) {
      throw makeTokenRecoveryError(
        'Reservation is marked settled without a transaction hash and requires operator review.',
        { pending: true, retryable: false, requiresReview: true, reservationId: reservation.id, financialStatus: 'unknown' },
      );
    }
    let spendReceipt: SignedSpendReceipt | undefined;
    try {
      // Always validate the original durable spend intent before reusing or
      // creating a receipt. A receipt row is not permission to relabel a
      // transfer after configuration has changed.
      await validateSettledReservationRecoveryContext(session, reservation, reservationSessionId);
      spendReceipt = await createAndStoreSpendReceipt({
        uid: session.uid,
        walletAddress: reservation.wallet_address,
        amount: Number(reservation.settled_amount || 0),
        sessionId: reservationSessionId,
        providerId: session.providerId,
        txHash: reservation.tx_hash,
      });
    } catch (err) {
      throw makeTokenRecoveryError(
        `Reservation is settled on-chain but receipt recovery is pending: ${getErrorMessage(err)}`,
        {
          pending: true,
          retryable: !(err as Error & { requiresReview?: boolean }).requiresReview,
          reservationId: reservation.id,
          txHash: reservation.tx_hash,
          financialStatus: 'confirmed',
          requiresReview: Boolean((err as Error & { requiresReview?: boolean }).requiresReview),
        },
      );
    }
    return { ...reservation, spendReceipt };
  }

  // A reservation found in `reserved` state must be claimed before the chain
  // call.  A previously `settling` row without a durable token operation is
  // an ambiguous historical state: do not create a new operation that might
  // duplicate an earlier submission; leave it for operator review.
  let claimedByThisRequest = false;
  if (reservation?.status === 'reserved') {
    const claimed = await SpendReservations.claimForSettlement(session.uid, reservationSessionId, session.providerId);
    if (claimed) {
      reservation = claimed;
      claimedByThisRequest = true;
    } else {
      reservation = await SpendReservations.findBySession(session.uid, reservationSessionId, session.providerId);
    }
  }
  if (!reservation) {
    reservation = await SpendReservations.claimForSettlement(session.uid, reservationSessionId, session.providerId);
    claimedByThisRequest = Boolean(reservation);
  }
  if (!reservation) return null;
  if (reservation.status === 'settled' || reservation.status === 'released') {
    // Another request completed the reservation while this request was
    // claiming it. Re-enter the terminal recovery path, which can recreate a
    // missing receipt from the persisted transaction hash.
    return settleReservationFromCdr(session);
  }
  if (reservation.status === 'settling' && !claimedByThisRequest) {
    let recoveryOperation;
    try {
      recoveryOperation = await TokenOperations.findByKey(reservationOperationKey(reservation.id));
    } catch (err) {
      throw makeTokenRecoveryError(
        `Reservation settlement state cannot be checked: ${getErrorMessage(err)}`,
        { pending: true, requiresReview: true, reservationId: reservation.id, financialStatus: 'unknown' },
      );
    }
    if (!recoveryOperation) {
      throw makeTokenRecoveryError(
        'Reservation is stuck settling without a durable token operation and requires operator review.',
        { pending: true, requiresReview: true, reservationId: reservation.id, financialStatus: 'unknown' },
      );
    }
  }
  const deliveredKwh = session.energyDirection === 'CHARGE' ? session.energyKWh : 0;
  const { settledAmount: amount } = calculateReservationSettlement(Number(reservation.reserved_amount), deliveredKwh);
  try {
    if (amount === 0) {
      await ensureZeroSettlementOperation(session, reservation, reservationSessionId);
      try {
        return await SpendReservations.complete(reservation.id, deliveredKwh, 0);
      } catch (err) {
        await SpendReservations.retry(reservation.id, `Reservation release projection pending: ${getErrorMessage(err)}`);
        const requiresReview = Boolean((err as Error & { requiresReview?: boolean }).requiresReview);
        throw makeTokenRecoveryError(
          `Reservation release projection is pending: ${getErrorMessage(err)}`,
          {
            pending: true,
            settlementPending: true,
            retryable: !requiresReview,
            requiresReview,
            reservationId: reservation.id,
            financialStatus: 'unknown',
          },
        );
      }
    }
    const isManagedReservation = reservation.wallet_address.toLowerCase() === getManagedWalletAddress(session.uid).toLowerCase();
    const spendResult = isManagedReservation
      ? await processSpendWithAutoApproval({
        uid: session.uid, userAddress: reservation.wallet_address, amount,
        sessionId: reservationSessionId, providerId: session.providerId,
        reservationId: reservation.id, operationKey: reservationOperationKey(reservation.id),
        auditContext: 'reservation_settlement',
        onApprovalFailure: async () => undefined,
      })
      : await processSpend({
        userAddress: reservation.wallet_address, amount, sessionId: reservationSessionId,
        uid: session.uid, providerId: session.providerId,
        reservationId: reservation.id, operationKey: reservationOperationKey(reservation.id),
      }, treasurySigner);
    if (!spendResult.success || !spendResult.txHash) {
      await SpendReservations.retry(reservation.id, spendResult.error || 'Reservation settlement pending');
      const requiresReview = spendResult.requiresReview === true
        || (spendResult.requiresReview === undefined
          && !spendResult.pending
          && !spendResult.preflightFailure
          && !spendResult.txHash);
      const preflightFailure = Boolean(spendResult.preflightFailure);
      const retryable = preflightFailure || Boolean(spendResult.pending && !requiresReview);
      throw makeTokenRecoveryError(spendResult.error || 'Reservation settlement pending', {
        pending: Boolean(spendResult.pending || preflightFailure),
        spendPending: Boolean(spendResult.pending),
        settlementPending: true,
        preflightFailure,
        retryable,
        requiresReview,
        reservationId: reservation.id,
        txHash: spendResult.txHash,
        movementOutcome: spendResult.movementOutcome,
        financialStatus: spendResult.txHash ? 'confirmed_or_pending' : 'unknown',
      });
    }

    let completed;
    try {
      completed = await SpendReservations.complete(reservation.id, deliveredKwh, spendResult.amount, spendResult.txHash);
    } catch (err) {
      await SpendReservations.retry(reservation.id, `Confirmed spend recorded; reservation projection pending: ${getErrorMessage(err)}`);
      const requiresReview = Boolean((err as Error & { requiresReview?: boolean }).requiresReview);
      throw makeTokenRecoveryError(
        `Reservation settlement is confirmed but reservation projection is pending: ${getErrorMessage(err)}`,
        {
          pending: true,
          settlementPending: true,
          retryable: !requiresReview,
          requiresReview,
          reservationId: reservation.id,
          txHash: spendResult.txHash,
          financialStatus: 'confirmed',
        },
      );
    }

    let spendReceipt: SignedSpendReceipt;
    try {
      spendReceipt = await createAndStoreSpendReceipt({
        uid: session.uid, walletAddress: reservation.wallet_address, amount: spendResult.amount,
        sessionId: reservationSessionId, providerId: session.providerId, txHash: spendResult.txHash,
      });
    } catch (err) {
      // The reservation remains settled and the known hash remains the
      // recovery key.  Never reset it to reserved after a confirmed transfer.
      const requiresReview = Boolean((err as Error & { requiresReview?: boolean }).requiresReview);
      throw makeTokenRecoveryError(
        `Reservation is settled on-chain but receipt persistence is pending: ${getErrorMessage(err)}`,
        {
          pending: true,
          settlementPending: true,
          retryable: !requiresReview,
          requiresReview,
          reservationId: reservation.id,
          txHash: spendResult.txHash,
          financialStatus: 'confirmed',
        },
      );
    }
    await safeAuditLog({
      eventType: 'spend.reservation_settled', actorType: 'ingest_client', actorId: session.providerId,
      targetType: 'spend_reservation', targetId: reservation.id, status: 'success',
      metadata: { reservedAmount: reservation.reserved_amount, settledAmount: spendResult.amount,
        releasedAmount: completed.released_amount, deliveredKwh, receiptId: spendReceipt.payload.receiptId },
    });
    return {
      ...completed,
      spendReceipt,
      authorizationCleanupRequired: !isManagedReservation && Number(completed.released_amount || 0) > 0,
    };
  } catch (err) {
    // Preserve a claimed reservation for every ambiguous/confirmed failure.
    // `retry` intentionally leaves it in settling so a later request resumes
    // the same token operation rather than submitting a new one.
    if (!(err && typeof err === 'object' && 'reservationId' in err)) {
      await SpendReservations.retry(reservation.id, getErrorMessage(err));
    }
    throw err;
  }
}

async function getTreasuryWalletAddress(): Promise<string | null> {
  if (TREASURY_ADDRESS && ethers.isAddress(TREASURY_ADDRESS)) {
    return ethers.getAddress(TREASURY_ADDRESS);
  }

  try {
    return await treasurySigner.getAddress();
  } catch {
    return null;
  }
}

async function createCustodialSpendIntent(input: {
  uid: string;
  walletAddress: string;
  amount: number;
  sessionId?: string;
  providerId?: string;
}) {
  const treasuryAddress = await getTreasuryWalletAddress();
  if (!treasuryAddress) {
    throw new Error('Treasury address is not configured');
  }

  const canonicalAmount = canonicalTokenAmount(input.amount);
  if (!canonicalAmount || canonicalAmount.units <= 0n) {
    throw new Error('Spend amount must be positive and use at most 2 decimal places');
  }
  const chainId = await getAuthoritativeChainId();
  const checksumWalletAddress = ethers.getAddress(input.walletAddress);
  const tokenInterface = new ethers.Interface(['function transfer(address to, uint256 amount) returns (bool)']);
  const amountWei = ethers.parseUnits(canonicalAmount.decimal, 18);
  const data = tokenInterface.encodeFunctionData('transfer', [treasuryAddress, amountWei]);
  const intentMaterial = [
    input.uid,
    checksumWalletAddress,
    canonicalAmount.decimal,
    input.sessionId || '',
    input.providerId || '',
    TOKEN_CONTRACT_ADDRESS,
    treasuryAddress,
    chainId.toString(),
    data,
  ].join('|');

  return {
    intentId: `csi_${crypto.createHash('sha256').update(intentMaterial).digest('hex').slice(0, 24)}`,
    contractId: input.uid,
    walletAddress: checksumWalletAddress,
    amount: canonicalAmount.decimal,
    sessionId: input.sessionId || null,
    providerId: input.providerId || null,
    chainId: Number(chainId),
    tokenContractAddress: TOKEN_CONTRACT_ADDRESS,
    treasuryAddress,
    retryable: true,
    transaction: {
      from: checksumWalletAddress,
      to: TOKEN_CONTRACT_ADDRESS,
      value: '0',
      data,
    },
  };
}

async function createReservationApprovalIntent(input: {
  uid: string;
  walletAddress: string;
  amount: number;
  sessionId: string;
  providerId: string;
}) {
  const treasuryAddress = await getTreasuryWalletAddress();
  if (!treasuryAddress) throw new Error('Treasury address is not configured');
  const checksumWalletAddress = await validateCustodialSpendIntentInput(input);
  const activeReserved = await SpendReservations.getActiveTotal(input.uid, checksumWalletAddress);
  const requiredAllowance = Number((activeReserved + input.amount).toFixed(2));
  const chainId = await getAuthoritativeChainId();
  const transaction = buildReservationApprovalTransaction({
    tokenContractAddress: TOKEN_CONTRACT_ADDRESS,
    treasuryAddress,
    walletAddress: checksumWalletAddress,
    allowanceSparkz: requiredAllowance,
  });
  return {
    status: 'requires_signature',
    contractId: input.uid,
    walletAddress: checksumWalletAddress,
    amount: input.amount.toString(),
    requiredAllowance: requiredAllowance.toString(),
    sessionId: input.sessionId,
    providerId: input.providerId,
    chainId: Number(chainId),
    tokenContractAddress: TOKEN_CONTRACT_ADDRESS,
    treasuryAddress,
    transaction,
  };
}

async function validateCustodialSpendIntentInput(input: {
  uid: string;
  walletAddress: string;
  amount: number;
}): Promise<string> {
  if (!input.uid || !input.walletAddress || !input.amount || input.amount <= 0 || !hasSupportedTokenPrecision(input.amount)) {
    throw new Error('Missing or invalid fields: uid, walletAddress, amount (must be > 0 and use at most 2 decimal places)');
  }
  if (!ethers.isAddress(input.walletAddress)) {
    throw new Error('Invalid wallet address');
  }

  const checksumWalletAddress = ethers.getAddress(input.walletAddress);
  const linkedWalletAddresses = (await LinkedWallets.findByUid(input.uid)).map(w => w.wallet_address.toLowerCase());
  if (!linkedWalletAddresses.includes(checksumWalletAddress.toLowerCase())) {
    throw new Error('Wallet address is not linked to this EMP contract');
  }

  return checksumWalletAddress;
}

async function auditTreasuryGasWarning(context: string, trigger?: unknown): Promise<void> {
  const provider = treasurySigner.provider;
  const treasuryAddress = await getTreasuryWalletAddress();
  if (!provider || !treasuryAddress) {
    return;
  }

  try {
    const threshold = ethers.parseEther(TREASURY_GAS_WARNING_THRESHOLD_MATIC);
    const balance = await provider.getBalance(treasuryAddress);
    if (balance >= threshold && !isTreasuryGasIssue(trigger)) {
      return;
    }

    await safeAuditLog({
      eventType: 'treasury.gas_low',
      actorType: 'system',
      actorId: 'api',
      targetType: 'treasury_wallet',
      targetId: treasuryAddress,
      status: 'warning',
      metadata: {
        context,
        balanceMatic: ethers.formatEther(balance),
        thresholdMatic: TREASURY_GAS_WARNING_THRESHOLD_MATIC,
        trigger: trigger instanceof Error ? trigger.message : trigger ? String(trigger) : null,
      },
    });
  } catch (err) {
    await safeAuditLog({
      eventType: 'treasury.gas_check_failed',
      actorType: 'system',
      actorId: 'api',
      targetType: 'treasury_wallet',
      targetId: treasuryAddress,
      status: 'warning',
      metadata: {
        context,
        thresholdMatic: TREASURY_GAS_WARNING_THRESHOLD_MATIC,
        error: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

async function runBalanceReconciliation(limit = 500) {
  const users = (await Users.getAll()).slice(0, limit);
  const items = await Promise.all(users.map(async (user) => {
    const balance = await Balances.findByUser(user.id);
    try {
      const chainBalance = Number(ethers.formatEther(await getOnChainTokenBalance(user.wallet_address))).toFixed(6);
      return reconcileBalance({
        uid: user.uid,
        walletAddress: user.wallet_address,
        dbBalance: balance?.balance ?? null,
        chainBalance,
      });
    } catch (err) {
      return reconcileBalance({
        uid: user.uid,
        walletAddress: user.wallet_address,
        dbBalance: balance?.balance ?? null,
        chainError: err instanceof Error ? err.message : String(err),
      });
    }
  }));
  const summary = summarizeReconciliation(items);
  const report = await ReconciliationReports.create({
    status: summary.status,
    checkedCount: summary.checkedCount,
    matchedCount: summary.matchedCount,
    mismatchCount: summary.mismatchCount,
    items: items as unknown as Record<string, unknown>[],
    metadata: {
      tokenContractAddress: TOKEN_CONTRACT_ADDRESS,
      limit,
      generatedBy: 'admin_api',
    },
  });

  await safeAuditLog({
    eventType: 'reconciliation.balance_run',
    actorType: 'admin_session',
    actorId: 'admin_api',
    targetType: 'reconciliation_report',
    targetId: report.id,
    status: report.status,
    metadata: {
      checkedCount: report.checked_count,
      matchedCount: report.matched_count,
      mismatchCount: report.mismatch_count,
    },
  });

  return report;
}

async function createAndStoreSpendReceipt(input: {
  uid: string;
  walletAddress: string;
  amount: number;
  sessionId?: string;
  providerId?: string;
  txHash: string;
}): Promise<SignedSpendReceipt & { dbStored: boolean; dbError?: string }> {
  const amount = canonicalTokenAmount(input.amount);
  if (!amount || amount.units <= 0n) {
    throw makeConfigurationError('INVALID_TOKEN_AMOUNT', 'Spend receipt amount must be positive and use at most 2 decimal places');
  }
  const txHash = canonicalTxHash(input.txHash);
  if (!txHash) {
    throw makeConfigurationError('INVALID_TX_HASH', 'Spend receipt transaction hash is malformed');
  }

  const chainId = await getAuthoritativeChainId();
  if (chainId > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw makeConfigurationError('CHAIN_ID_UNSUPPORTED', 'Receipt chain ID exceeds the supported JSON integer range');
  }
  let tokenContractAddress: string;
  try {
    tokenContractAddress = ethers.getAddress(TOKEN_CONTRACT_ADDRESS);
  } catch {
    throw makeConfigurationError('TOKEN_CONTRACT_INVALID', 'Configured token contract address is invalid');
  }
  const walletAddress = ethers.getAddress(input.walletAddress);
  const trustedSignerAddress = await treasurySigner.getAddress();
  const expectedSessionId = normaliseOptionalContext(input.sessionId);
  const expectedProviderId = normaliseOptionalContext(input.providerId);

  const invalidStoredReceipt = (reason: string): Error & Record<string, unknown> => makeTokenRecoveryError(
    `Stored spend receipt for ${txHash} does not match the requested immutable intent: ${reason}`,
    { receiptConflict: true, requiresReview: true, txHash },
  );

  const validateStoredReceipt = (record: {
    uid?: string;
    wallet_address?: string;
    amount?: string;
    session_id?: string | null;
    provider_id?: string | null;
    token_tx_hash?: string;
    token_contract_address?: string;
    chain_id?: number;
    signer_address?: string;
    canonical_payload: string;
    signature: string;
  }): SignedSpendReceipt & { dbStored: boolean } => {
    let payload: Record<string, unknown>;
    try {
      const parsed = JSON.parse(record.canonical_payload);
      if (!parsed || typeof parsed !== 'object') throw new Error('payload is not an object');
      payload = parsed as Record<string, unknown>;
    } catch (err) {
      throw invalidStoredReceipt(`canonical payload is invalid: ${getErrorMessage(err)}`);
    }

    if (payload.version !== '1.0' || payload.status !== 'settled') {
      throw invalidStoredReceipt('status or payload version is unsupported');
    }
    if (payload.contractId !== input.uid) {
      throw invalidStoredReceipt('contract ID differs');
    }
    let payloadWallet: string;
    let payloadToken: string;
    try {
      payloadWallet = ethers.getAddress(String(payload.walletAddress));
      payloadToken = ethers.getAddress(String(payload.tokenContractAddress));
    } catch {
      throw invalidStoredReceipt('wallet or token contract address is invalid');
    }
    if (payloadWallet.toLowerCase() !== walletAddress.toLowerCase()) {
      throw invalidStoredReceipt('wallet address differs');
    }
    if (payloadToken.toLowerCase() !== tokenContractAddress.toLowerCase()) {
      throw invalidStoredReceipt('token contract differs');
    }
    const payloadAmount = canonicalTokenAmount(payload.amount);
    if (!payloadAmount || payloadAmount.units !== amount.units) {
      throw invalidStoredReceipt('amount differs');
    }
    if (normaliseOptionalContext(payload.sessionId) !== expectedSessionId) {
      throw invalidStoredReceipt('session ID differs');
    }
    if (normaliseOptionalContext(payload.providerId) !== expectedProviderId) {
      throw invalidStoredReceipt('provider ID differs');
    }
    if (canonicalTxHash(payload.tokenTxHash) !== txHash) {
      throw invalidStoredReceipt('transaction hash differs');
    }
    if (String(payload.chainId) !== chainId.toString()) {
      throw invalidStoredReceipt('chain ID differs from the configured RPC network');
    }

    if (record.uid !== undefined && record.uid !== input.uid) {
      throw invalidStoredReceipt('database owner differs');
    }
    if (record.wallet_address !== undefined && record.wallet_address.toLowerCase() !== walletAddress.toLowerCase()) {
      throw invalidStoredReceipt('database wallet differs');
    }
    if (record.amount !== undefined) {
      const recordAmount = canonicalTokenAmount(record.amount);
      if (!recordAmount || recordAmount.units !== amount.units) throw invalidStoredReceipt('database amount differs');
    }
    if (normaliseOptionalContext(record.session_id) !== expectedSessionId) {
      throw invalidStoredReceipt('database session ID differs');
    }
    if (normaliseOptionalContext(record.provider_id) !== expectedProviderId) {
      throw invalidStoredReceipt('database provider ID differs');
    }
    if (record.token_tx_hash !== undefined && canonicalTxHash(record.token_tx_hash) !== txHash) {
      throw invalidStoredReceipt('database transaction hash differs');
    }
    if (record.token_contract_address !== undefined) {
      try {
        if (ethers.getAddress(record.token_contract_address).toLowerCase() !== tokenContractAddress.toLowerCase()) {
          throw invalidStoredReceipt('database token contract differs');
        }
      } catch (err) {
        if ((err as Error & { receiptConflict?: boolean }).receiptConflict) throw err;
        throw invalidStoredReceipt('database token contract is invalid');
      }
    }
    if (record.chain_id !== undefined && Number(record.chain_id) !== Number(chainId)) {
      throw invalidStoredReceipt('database chain ID differs');
    }
    if (!record.signer_address) throw invalidStoredReceipt('database signer is missing');
    if (record.signer_address.toLowerCase() !== trustedSignerAddress.toLowerCase()) {
      throw invalidStoredReceipt('database signer differs from the configured signer');
    }

    const trusted = verifySpendReceiptAgainstTrustedSigner(
      payload as unknown as SignedSpendReceipt['payload'],
      record.signature,
      record.signer_address,
      trustedSignerAddress,
    );
    if (!trusted.valid) throw invalidStoredReceipt(trusted.failure?.message || 'signature is not trusted');

    return {
      payload: payload as unknown as SignedSpendReceipt['payload'],
      signature: record.signature,
      signerAddress: record.signer_address,
      canonicalPayload: record.canonical_payload,
      dbStored: true,
    };
  };

  const existing = await SpendReceipts.findByTxHash(txHash) || (
    input.txHash !== txHash ? await SpendReceipts.findByTxHash(input.txHash) : undefined
  );
  if (existing) return validateStoredReceipt(existing);

  const payload = createSpendReceiptPayload({
    contractId: input.uid,
    walletAddress,
    amount: amount.decimal,
    sessionId: expectedSessionId,
    providerId: expectedProviderId,
    tokenTxHash: txHash,
    tokenContractAddress,
    chainId: Number(chainId),
    status: 'settled',
  });
  const signed = await signSpendReceipt(payload, treasurySigner);

  try {
    await SpendReceipts.create({
      receiptId: payload.receiptId,
      uid: payload.contractId,
      walletAddress: payload.walletAddress,
      amount: payload.amount,
      sessionId: payload.sessionId,
      providerId: payload.providerId,
      status: payload.status,
      tokenTxHash: payload.tokenTxHash,
      tokenContractAddress: payload.tokenContractAddress,
      chainId: payload.chainId,
      signerAddress: signed.signerAddress,
      canonicalPayload: signed.canonicalPayload,
      signature: signed.signature,
      issuedAt: new Date(payload.issuedAt),
    });
    await safeAuditLog({
      eventType: 'spend_receipt.created',
      actorType: 'system',
      actorId: 'api',
      targetType: 'spend_receipt',
      targetId: payload.receiptId,
      status: 'success',
      metadata: {
        uid: payload.contractId,
        walletAddress: payload.walletAddress,
        amount: payload.amount,
        sessionId: payload.sessionId,
        providerId: payload.providerId,
        tokenTxHash: payload.tokenTxHash,
        chainId: payload.chainId,
      },
    });
  } catch (err) {
    const dbError = err instanceof Error ? err.message : String(err);
    console.error('Spend receipt persistence error:', dbError);
    await safeAuditLog({
      eventType: 'spend_receipt.persistence_failed',
      actorType: 'system',
      actorId: 'api',
      targetType: 'token_tx',
      targetId: payload.tokenTxHash,
      status: 'error',
      metadata: {
        uid: payload.contractId,
        walletAddress: payload.walletAddress,
        amount: payload.amount,
        sessionId: payload.sessionId,
        providerId: payload.providerId,
        receiptId: payload.receiptId,
        error: dbError,
      },
    });
    // A receipt write failure after a confirmed token transfer is a pending
    // recovery state, never a successful financial response.  The tx hash is
    // the stable retry key and the next request will reuse it.
    let raced;
    try {
      raced = await SpendReceipts.findByTxHash(txHash) || (
        input.txHash !== txHash ? await SpendReceipts.findByTxHash(input.txHash) : undefined
      );
    } catch (raceErr) {
      throw Object.assign(new Error(`Spend receipt persistence pending: ${dbError}; recovery lookup failed: ${getErrorMessage(raceErr)}`), {
        txHash,
        receiptPending: true,
      });
    }
    if (raced) {
      return validateStoredReceipt(raced);
    }
    throw Object.assign(new Error(`Spend receipt persistence pending: ${dbError}`), {
      txHash,
      receiptPending: true,
    });
  }

  return {
    ...signed,
    dbStored: true,
  };
}

async function safeAuditLog(data: {
  eventType: string;
  actorType: string;
  actorId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  status: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  try {
    await AuditLogs.create(data);
    if (shouldAlertAdmin(data)) {
      void sendAdminAlert(data);
    }
  } catch (err) {
    console.warn('Audit log write failed:', err instanceof Error ? err.message : String(err));
  }
}

function shouldAlertAdmin(data: {
  eventType: string;
  status: string;
}): boolean {
  if (data.eventType.startsWith('admin_alert.')) {
    return false;
  }
  if (data.status === 'warning' || data.status === 'retry_required') {
    return true;
  }
  return data.status === 'error' && (
    data.eventType.includes('failed')
    || data.eventType.includes('unhandled_error')
    || data.eventType === 'reconciliation.balance_run'
  );
}

function countMatching(events: AuditLogRecord[], predicate: (event: AuditLogRecord) => boolean): number {
  return events.filter(predicate).length;
}

async function getPilotMetrics(hours = 24) {
  const boundedHours = Math.min(Math.max(Number.isFinite(hours) ? hours : 24, 1), 168);
  const since = new Date(Date.now() - boundedHours * 60 * 60 * 1000);
  const events = await AuditLogs.getSince(since, 5000);
  const eventTypes = events.reduce<Record<string, number>>((counts, event) => {
    counts[event.event_type] = (counts[event.event_type] || 0) + 1;
    return counts;
  }, {});
  const lastEventAt = events[0]?.created_at
    ? new Date(events[0].created_at).toISOString()
    : null;

  return {
    windowHours: boundedHours,
    since: since.toISOString(),
    generatedAt: new Date().toISOString(),
    totalEvents: events.length,
    lastEventAt,
    awards: {
      completed: eventTypes['award.completed'] || 0,
      notEligible: eventTypes['award.not_eligible'] || 0,
      duplicates: eventTypes['award.duplicate'] || 0,
      failures: countMatching(events, event => event.event_type.startsWith('award.') && event.status === 'error'),
    },
    spends: {
      completed: eventTypes['spend.completed'] || 0,
      custodialRecorded: eventTypes['spend.custodial_recorded'] || 0,
      custodialIntentsCreated: eventTypes['spend.custodial_intent_created'] || 0,
      retryRequired: countMatching(events, event => event.event_type.startsWith('spend.') && event.status === 'retry_required'),
      failures: countMatching(events, event => event.event_type.startsWith('spend.') && event.status === 'error'),
    },
    operations: {
      warnings: countMatching(events, event => event.status === 'warning'),
      errors: countMatching(events, event => event.status === 'error'),
      retryRequired: countMatching(events, event => event.status === 'retry_required'),
      deliveredAlerts: eventTypes['admin_alert.delivered'] || 0,
      skippedAlerts: eventTypes['admin_alert.delivery_skipped'] || 0,
      reconciliationRuns: eventTypes['reconciliation.balance_run'] || 0,
    },
    eventTypes,
  };
}

type AdminAlertDeliveryResult = {
  status: 'sent' | 'delivery_skipped' | 'delivery_failed';
  reason?: 'admin_email_not_configured' | 'admin_alert_webhook_not_configured' | 'request_failed' | 'non_success_response';
  webhookStatus?: number;
};

async function sendAdminAlert(data: {
  eventType: string;
  actorType: string;
  actorId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  status: string;
  metadata?: Record<string, unknown>;
}): Promise<AdminAlertDeliveryResult> {
  const adminEmail = getRegisteredAdminEmail();
  const webhookUrl = getAdminAlertWebhookUrl();
  if (!adminEmail || !webhookUrl) {
    try {
      await AuditLogs.create({
        eventType: 'admin_alert.delivery_skipped',
        actorType: 'system',
        actorId: 'api',
        targetType: data.targetType || null,
        targetId: data.targetId || null,
        status: 'warning',
        metadata: {
          reason: !adminEmail ? 'admin_email_not_configured' : 'admin_alert_webhook_not_configured',
          sourceEventType: data.eventType,
          sourceStatus: data.status,
        },
      });
    } catch {
      // Alert audit evidence must never break the user/API path.
    }
    return {
      status: 'delivery_skipped',
      reason: !adminEmail ? 'admin_email_not_configured' : 'admin_alert_webhook_not_configured',
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to: adminEmail,
        subject: `NEVERFLAT ${data.status}: ${data.eventType}`,
        eventType: data.eventType,
        status: data.status,
        actorType: data.actorType,
        actorId: data.actorId || null,
        targetType: data.targetType || null,
        targetId: data.targetId || null,
        metadata: data.metadata || {},
        createdAt: new Date().toISOString(),
      }),
      signal: controller.signal,
    });

    const deliveryResult: AdminAlertDeliveryResult = response.ok
      ? { status: 'sent', webhookStatus: response.status }
      : { status: 'delivery_failed', reason: 'non_success_response', webhookStatus: response.status };
    try {
      await AuditLogs.create({
        eventType: response.ok ? 'admin_alert.delivered' : 'admin_alert.delivery_failed',
        actorType: 'system',
        actorId: 'api',
        targetType: data.targetType || null,
        targetId: data.targetId || null,
        status: response.ok ? 'success' : 'error',
        metadata: {
          adminEmail,
          webhookStatus: response.status,
          sourceEventType: data.eventType,
          sourceStatus: data.status,
        },
      });
    } catch (auditErr) {
      console.warn('Admin alert delivery audit write failed:', toServerAuditDiagnostic(auditErr));
    }
    return deliveryResult;
  } catch (err) {
    try {
      await AuditLogs.create({
        eventType: 'admin_alert.delivery_failed',
        actorType: 'system',
        actorId: 'api',
        targetType: data.targetType || null,
        targetId: data.targetId || null,
        status: 'error',
        metadata: {
          adminEmail,
          sourceEventType: data.eventType,
          sourceStatus: data.status,
          error: err instanceof Error ? err.message : String(err),
        },
      });
    } catch {
      // Alert audit evidence must never break the user/API path.
    }
    return { status: 'delivery_failed', reason: 'request_failed' };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * API Key authentication middleware
 * Validates API_KEY header for protected endpoints
 */
function validateApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!API_KEY && !BEIA_API_KEY) {
    if (process.env.NODE_ENV === 'production') {
      res.status(503).json({
        status: 'error',
        message: 'API key authentication is not configured',
      });
      return;
    }

    // If no API_KEY configured outside production, skip validation for local development.
    return next();
  }

  const auth = req.header('Authorization');
  const adminToken = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (adminToken && adminSessions.has(adminToken)) {
    return next();
  }

  const apiKey = req.header('X-API-Key');
  if (!apiKey) {
    res.status(401).json({
      status: 'error',
      message: 'Missing API key: X-API-Key header required',
    });
    return;
  }

  if (apiKey !== API_KEY && apiKey !== BEIA_API_KEY) {
    res.status(403).json({
      status: 'error',
      message: 'Invalid API key',
    });
    return;
  }

  next();
}

function buildOpenApiSpec(req: Request) {
  const forwardedProtocol = req.get('x-forwarded-proto')?.split(',')[0]?.trim();
  const protocol = forwardedProtocol || (process.env.NODE_ENV === 'production' ? 'https' : req.protocol);
  const baseUrl = `${protocol}://${req.get('host')}`;
  const cdrRequestExamples = {
    neverflat: {
      summary: 'Canonical NEVERFLAT payload (recommended)',
      description: 'This is the payload format used by the NEVERFLAT admin panel.',
      value: {
        SessionID: 'session-20260914-001',
        ProviderID: 'nvf-demo',
        cdr_token: { contract_id: 'demo-user-001' },
        EVSEID: 'DE*ABC*E*001',
        StartTime: '2026-09-14T05:00:00.000Z',
        EndTime: '2026-09-14T06:00:00.000Z',
        Energy: '12',
        EnergyDirection: 'CHARGE',
      },
    },
    ocpi: {
      summary: 'OCPI-style payload',
      description: 'Supported compatibility format. The EVSE country prefix is used for reward rules.',
      value: {
        id: 'cdr-session-20260914-001',
        country_code: 'DE',
        party_id: 'NF',
        cdr_token: { contract_id: 'demo-user-001' },
        cdr_location: { evse_id: 'DE*ABC*E*001' },
        start_date_time: '2026-09-14T05:00:00.000Z',
        end_date_time: '2026-09-14T06:00:00.000Z',
        total_energy: 12,
        energyDirection: 'CHARGE',
      },
    },
  };
  const cdrRequestBody = {
    required: true,
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/CdrRequest' },
        examples: cdrRequestExamples,
      },
    },
  };
  const errorResponse = {
    description: 'Request failed. Inspect `message` or `error` for the specific cause.',
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/ErrorResponse' },
        examples: {
          validationFailed: {
            summary: 'Missing or invalid request data',
            value: {
              status: 'error',
              code: 'INVALID_REQUEST',
              message: 'amount must be a number greater than zero',
            },
          },
          missingApiKey: {
            summary: 'API authentication is missing',
            value: {
              status: 'error',
              message: 'Missing API key: X-API-Key header required',
            },
          },
          invalidApiKey: {
            summary: 'API authentication was rejected',
            value: {
              status: 'error',
              message: 'Invalid API key',
            },
          },
          identityMissing: {
            summary: 'Gridware contract identity is missing',
            value: {
              status: 'error',
              message: `Missing identity header: ${USER_IDENTITY_HEADER}`,
            },
          },
          resourceNotFound: {
            summary: 'The requested wallet or configuration was not found',
            value: {
              status: 'error',
              message: 'Wallet not found for the supplied contract ID',
            },
          },
          rewardNetworkUnavailable: {
            summary: 'Temporary blockchain or RPC failure',
            value: {
              status: 'error',
              error: 'The reward network is temporarily unavailable. Please retry the request shortly.',
            },
          },
        },
      },
    },
  };
  const invalidCdrResponse = {
    description: 'The CDR is incomplete, malformed, or internally inconsistent.',
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/ErrorResponse' },
        examples: {
          missingEvse: {
            summary: 'Required EVSE identifier is missing',
            value: {
              status: 'error',
              code: 'INVALID_CDR',
              message: 'evseId is required',
            },
          },
          invalidDirection: {
            summary: 'Energy direction is invalid',
            value: {
              status: 'error',
              code: 'INVALID_CDR',
              message: 'energy direction must be CHARGE or DISCHARGE',
            },
          },
        },
      },
    },
  };
  const apiKeySecurity = [{ ApiKeyAuth: [] }];
  const ingestApiKeySecurity = [{ IngestApiKeyAuth: [] }, { ApiKeyAuth: [] }, { AdminBearerAuth: [] }];
  const adminSecurity = [{ AdminBearerAuth: [] }];

  return {
    openapi: '3.0.3',
    info: {
      title: 'NEVERFLAT SPARKZ Award System API',
      version: '1.1.0',
      description: 'Backend API for CDR ingestion, SPARKZ rewards, spends, wallet management, and award administration.',
    },
    servers: [{ url: baseUrl }],
    tags: [
      { name: 'Health' },
      { name: 'Awards' },
      { name: 'Spends' },
      { name: 'Wallets' },
      { name: 'Transactions' },
      { name: 'Admin' },
    ],
    paths: {
      '/ingest/health': {
        get: {
          tags: ['Health'],
          summary: 'Health check',
          responses: {
            200: {
              description: 'Service is healthy',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      status: { type: 'string', example: 'ok' },
                      timestamp: { type: 'string', format: 'date-time' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/ingest/cdr': {
        post: {
          tags: ['Awards'],
          summary: 'Ingest a charging CDR and award SPARKZ if eligible',
          description: 'Processes a final CDR. Use the canonical NEVERFLAT example unless an OCPI payload is required. Session IDs must be unique.',
          security: ingestApiKeySecurity,
          requestBody: cdrRequestBody,
          responses: {
            200: {
              description: 'CDR accepted, duplicate, or accepted but not eligible',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/CdrResponse' },
                },
              },
            },
            202: {
              description: 'Award is known but reservation or receipt recovery is pending. Retry the identical CDR unless requiresReview is true.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/CdrResponse' },
                },
              },
            },
            400: invalidCdrResponse,
            401: errorResponse,
            403: errorResponse,
            500: errorResponse,
          },
        },
      },
      '/ingest/cdr/preview': {
        post: {
          tags: ['Awards'],
          summary: 'Validate and preview a CDR without side effects',
          description: 'Runs the same validation, normalisation, and reward rules as ingestion without database writes or blockchain settlement.',
          security: ingestApiKeySecurity,
          requestBody: cdrRequestBody,
          responses: {
            200: {
              description: 'CDR is valid and the reward calculation was previewed',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/CdrPreviewResponse' },
                },
              },
            },
            400: invalidCdrResponse,
            401: errorResponse,
            403: errorResponse,
          },
        },
      },
      '/spend': {
        post: {
          tags: ['Spends'],
          summary: 'Spend SPARKZ for a contract ID',
          security: apiKeySecurity,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SpendRequest' },
              },
            },
          },
          responses: {
            200: {
              description: 'Spend completed',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SpendResponse' },
                },
              },
            },
            202: {
              description: 'Spend or receipt recovery is pending. Retry with the same idempotencyKey or returned operationKey.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SpendResponse' },
                },
              },
            },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            500: errorResponse,
          },
        },
      },
      '/spend/session': {
        post: {
          tags: ['Spends'],
          summary: 'Get charging-session SPARKZ spend eligibility',
          description: 'BEIA calls this when a user opens a charger, plugs in, or starts a session. This endpoint never spends tokens.',
          security: apiKeySecurity,
          parameters: [{ $ref: '#/components/parameters/ContractIdHeader' }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SpendSessionRequest' },
              },
            },
          },
          responses: {
            200: {
              description: 'Wallet and spend eligibility for the charging session',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SpendSessionResponse' },
                },
              },
            },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            404: errorResponse,
            500: errorResponse,
          },
        },
      },
      '/spend/reservation-approval-intent': {
        post: {
          tags: ['Spends'],
          summary: 'Build a capped external-wallet approval for a reservation',
          security: apiKeySecurity,
          parameters: [{ $ref: '#/components/parameters/ContractIdHeader' }],
          requestBody: {
            required: true,
            content: { 'application/json': { schema: { $ref: '#/components/schemas/ReservationApprovalRequest' } } },
          },
          responses: {
            200: { description: 'Approval transaction requires the connected wallet signature' },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
          },
        },
      },
      '/spend/me': {
        post: {
          tags: ['Spends'],
          summary: 'Reserve SPARKZ for settlement from the final CDR',
          security: apiKeySecurity,
          parameters: [{ $ref: '#/components/parameters/ContractIdHeader' }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SpendMeRequest' },
              },
            },
          },
          responses: {
            200: {
              description: 'SPARKZ reserved; no token transfer has occurred',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ReservationResponse' },
                },
              },
            },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            500: errorResponse,
          },
        },
      },
      '/spend/reservations/{reservationId}': {
        get: {
          tags: ['Spends'],
          summary: 'Get a reservation and its final CDR settlement',
           description: 'BEIA polls this endpoint and forwards a settled or released result to the EMP. The endpoint reports persisted state and does not itself recover a missing receipt.',
          security: apiKeySecurity,
          parameters: [
            { $ref: '#/components/parameters/ContractIdHeader' },
            {
              name: 'reservationId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' },
            },
          ],
          responses: {
            200: {
              description: 'Current reservation and settlement state',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ReservationStatusResponse' },
                },
              },
            },
            401: errorResponse,
            403: errorResponse,
            404: errorResponse,
            500: errorResponse,
          },
        },
      },
      '/spend/custodial-record': {
        post: {
          tags: ['Spends'],
          summary: 'Record a spend made from a linked external wallet',
          security: apiKeySecurity,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CustodialSpendRecordRequest' },
              },
            },
          },
          responses: {
            200: {
              description: 'Custodial spend recorded',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/MessageResponse' },
                },
              },
            },
            202: {
              description: 'The transfer is verified but its projection or signed receipt is pending; retry the identical request.',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/MessageResponse' },
                },
              },
            },
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            500: errorResponse,
          },
        },
      },
      '/spend-receipts/verify': {
        post: {
          tags: ['Spends'],
          summary: 'Verify a signed SPARKZ spend receipt',
          description: 'The configured NEVERFLAT receipt signer is authoritative. signerAddress is optional for compatibility; when supplied it must match the configured signer.',
          security: apiKeySecurity,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['payload', 'signature'],
                  properties: {
                    payload: { type: 'object', additionalProperties: true },
                    signature: { type: 'string' },
                    signerAddress: { type: 'string', description: 'Optional claimed signer; it is checked against the configured signer.' },
                  },
                },
              },
            },
          },
          responses: {
            200: {
              description: 'Receipt validity under the configured signer trust boundary',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      status: { type: 'string', enum: ['valid', 'invalid'] },
                      valid: { type: 'boolean' },
                      signerAddress: { type: 'string' },
                      recoveredSignerAddress: { type: 'string', nullable: true },
                      failure: { type: 'object', nullable: true, additionalProperties: true },
                    },
                  },
                },
              },
            },
            400: errorResponse,
          },
        },
      },
      '/wallet/{uid}': {
        get: {
          tags: ['Wallets'],
          summary: 'Get wallet state by contract ID',
          security: apiKeySecurity,
          parameters: [
            { $ref: '#/components/parameters/UidPath' },
            { $ref: '#/components/parameters/WalletAddressQuery' },
          ],
          responses: {
            200: {
              description: 'Wallet details',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/WalletResponse' },
                },
              },
            },
            401: errorResponse,
            403: errorResponse,
            500: errorResponse,
          },
        },
      },
      '/wallet/me': {
        get: {
          tags: ['Wallets'],
          summary: 'Get wallet state using the x-contract-id identity header',
          security: apiKeySecurity,
          parameters: [
            { $ref: '#/components/parameters/ContractIdHeader' },
            { $ref: '#/components/parameters/WalletAddressQuery' },
          ],
          responses: {
            200: {
              description: 'Wallet details',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/WalletResponse' },
                },
              },
            },
            401: errorResponse,
            403: errorResponse,
            500: errorResponse,
          },
        },
      },
      '/wallet/{uid}/mode': {
        post: {
          tags: ['Wallets'],
          summary: 'Switch active wallet mode',
          security: apiKeySecurity,
          parameters: [{ $ref: '#/components/parameters/UidPath' }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/WalletModeRequest' },
              },
            },
          },
          responses: {
            200: {
              description: 'Wallet mode updated',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/WalletModeResponse' },
                },
              },
            },
            400: errorResponse,
            409: {
              description: 'Source wallet still has SPARKZ balance',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/SourceWalletBalanceResponse' },
                },
              },
            },
          },
        },
      },
      '/wallet/{uid}/profile': {
        patch: {
          tags: ['Wallets'],
          summary: 'Set wallet display name',
          security: apiKeySecurity,
          parameters: [{ $ref: '#/components/parameters/UidPath' }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/WalletProfileRequest' },
              },
            },
          },
          responses: {
            200: {
              description: 'Wallet profile updated',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/WalletResponse' },
                },
              },
            },
            400: errorResponse,
          },
        },
      },
      '/wallet/{uid}/contract-ids': {
        post: {
          tags: ['Wallets'],
          summary: 'Link another contract ID to the active wallet',
          security: apiKeySecurity,
          parameters: [{ $ref: '#/components/parameters/UidPath' }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/ContractIdLinkRequest' },
              },
            },
          },
          responses: {
            200: {
              description: 'Contract ID linked',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/WalletResponse' },
                },
              },
            },
            400: errorResponse,
          },
        },
      },
      '/wallet/{uid}/linked-wallets': {
        post: {
          tags: ['Wallets'],
          summary: 'Link an external blockchain wallet to a contract ID',
          security: apiKeySecurity,
          parameters: [{ $ref: '#/components/parameters/UidPath' }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/LinkedWalletRequest' },
              },
            },
          },
          responses: {
            200: {
              description: 'Wallet address linked',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/WalletResponse' },
                },
              },
            },
            400: errorResponse,
          },
        },
      },
      '/wallet/{uid}/linked-wallets/{walletAddress}/profile': {
        patch: {
          tags: ['Wallets'],
          summary: 'Name a linked external wallet',
          security: apiKeySecurity,
          parameters: [
            { $ref: '#/components/parameters/UidPath' },
            { $ref: '#/components/parameters/WalletAddressPath' },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/WalletNameRequest' },
              },
            },
          },
          responses: {
            200: {
              description: 'Linked wallet profile updated',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/WalletResponse' },
                },
              },
            },
            400: errorResponse,
            404: errorResponse,
          },
        },
      },
      '/wallet/{uid}/linked-wallets/{walletAddress}': {
        delete: {
          tags: ['Wallets'],
          summary: 'Unlink an external blockchain wallet',
          security: apiKeySecurity,
          parameters: [
            { $ref: '#/components/parameters/UidPath' },
            { $ref: '#/components/parameters/WalletAddressPath' },
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/SignatureRequest' },
              },
            },
          },
          responses: {
            200: {
              description: 'Wallet address unlinked',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/WalletResponse' },
                },
              },
            },
            400: errorResponse,
          },
        },
      },
      '/wallet/{uid}/move-funds': {
        post: {
          tags: ['Wallets'],
          summary: 'Move all SPARKZ from managed wallet to target address',
          security: apiKeySecurity,
          parameters: [{ $ref: '#/components/parameters/UidPath' }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/MoveFundsRequest' },
              },
            },
          },
          responses: {
            200: {
              description: 'Funds moved',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/MoveFundsResponse' },
                },
              },
            },
            400: errorResponse,
          },
        },
      },
      '/transactions': {
        get: {
          tags: ['Transactions'],
          summary: 'List recent awards and spends',
          security: apiKeySecurity,
          parameters: [
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', default: 50, maximum: 500 },
            },
          ],
          responses: {
            200: {
              description: 'Recent transactions',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/TransactionsResponse' },
                },
              },
            },
            401: errorResponse,
            403: errorResponse,
            500: errorResponse,
          },
        },
      },
      '/admin/login': {
        post: {
          tags: ['Admin'],
          summary: 'Create an admin session token',
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AdminLoginRequest' },
              },
            },
          },
          responses: {
            200: {
              description: 'Admin token created',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      status: { type: 'string', example: 'ok' },
                      token: { type: 'string' },
                    },
                  },
                },
              },
            },
            401: errorResponse,
          },
        },
      },
      '/admin/logout': {
        post: {
          tags: ['Admin'],
          summary: 'Destroy an admin session token',
          security: adminSecurity,
          responses: {
            200: {
              description: 'Logged out',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/OkResponse' },
                },
              },
            },
            401: errorResponse,
          },
        },
      },
      '/admin/rules': {
        get: {
          tags: ['Admin'],
          summary: 'Get award rules',
          security: adminSecurity,
          responses: {
            200: {
              description: 'Current rules',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/AdminRulesResponse' },
                },
              },
            },
            401: errorResponse,
          },
        },
        put: {
          tags: ['Admin'],
          summary: 'Update award rules',
          security: adminSecurity,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/AdminRulesUpdateRequest' },
              },
            },
          },
          responses: {
            200: {
              description: 'Rules updated',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/AdminRulesResponse' },
                },
              },
            },
            400: errorResponse,
            401: errorResponse,
          },
        },
      },
      '/admin/off-peak': {
        get: {
          tags: ['Admin'],
          summary: 'Get off-peak charging windows',
          security: adminSecurity,
          responses: {
            200: {
              description: 'Current off-peak windows',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/OffPeakResponse' },
                },
              },
            },
            401: errorResponse,
          },
        },
        put: {
          tags: ['Admin'],
          summary: 'Replace off-peak charging windows',
          security: adminSecurity,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/OffPeakUpdateRequest' },
              },
            },
          },
          responses: {
            200: {
              description: 'Off-peak windows updated',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/OffPeakResponse' },
                },
              },
            },
            400: errorResponse,
            401: errorResponse,
          },
        },
      },
      '/admin/off-peak/{countryCode}': {
        delete: {
          tags: ['Admin'],
          summary: 'Remove one country from off-peak charging windows',
          security: adminSecurity,
          parameters: [
            {
              name: 'countryCode',
              in: 'path',
              required: true,
              schema: { type: 'string', example: 'GB' },
            },
          ],
          responses: {
            200: {
              description: 'Country removed',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/OffPeakResponse' },
                },
              },
            },
            400: errorResponse,
            401: errorResponse,
            404: errorResponse,
          },
        },
      },
    },
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
        },
        IngestApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'X-Ingest-API-Key',
          description: 'CDR ingestion credential. A dedicated key is enforced when configured; otherwise an issued API key is accepted. X-API-Key is also supported.',
        },
        AdminBearerAuth: {
          type: 'http',
          scheme: 'bearer',
        },
      },
      parameters: {
        UidPath: {
          name: 'uid',
          in: 'path',
          required: true,
          description: 'EMP contract ID. Route keeps uid naming for backward compatibility.',
          schema: { type: 'string', example: '000' },
        },
        ContractIdHeader: {
          name: 'x-contract-id',
          in: 'header',
          required: true,
          schema: { type: 'string', example: '000' },
        },
        WalletAddressPath: {
          name: 'walletAddress',
          in: 'path',
          required: true,
          schema: { type: 'string', example: '0x281cdB9F9407Ad029a6d7d5d9989a8362CDb7A59' },
        },
        WalletAddressQuery: {
          name: 'walletAddress',
          in: 'query',
          required: false,
          schema: { type: 'string', example: '0x281cdB9F9407Ad029a6d7d5d9989a8362CDb7A59' },
        },
      },
      schemas: {
        ErrorResponse: {
          type: 'object',
          required: ['status'],
          description: 'A failed request. `message` describes request/authentication problems; `error` describes processing failures. At least one is returned.',
          properties: {
            status: { type: 'string', enum: ['error'], example: 'error' },
            code: {
              type: 'string',
              description: 'Stable machine-readable error code when one is available.',
              example: 'INVALID_REQUEST',
            },
            message: {
              type: 'string',
              description: 'Specific validation, identity, authentication, or not-found reason.',
              example: 'Missing API key: X-API-Key header required',
            },
            error: {
              type: 'string',
              description: 'Safe processing-failure detail suitable for display or logging.',
              example: 'The reward network is temporarily unavailable. Please retry the request shortly.',
            },
          },
          anyOf: [
            { required: ['message'] },
            { required: ['error'] },
          ],
        },
        OkResponse: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'ok' },
          },
        },
        MessageResponse: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'success' },
            uid: { type: 'string', example: '000' },
            txHash: { type: 'string', example: '0xabc...' },
            receiptStatus: { type: 'string', nullable: true },
            pending: { type: 'boolean', nullable: true },
            retryable: { type: 'boolean', nullable: true },
            requiresReview: { type: 'boolean', nullable: true },
            projectionStatus: { type: 'string', nullable: true },
            spendReceipt: { type: 'object', nullable: true, additionalProperties: true },
            message: { type: 'string' },
          },
        },
        CdrRequest: {
          description: 'A complete final CDR in either the canonical NEVERFLAT format or the supported OCPI-style format. Do not combine the two formats in one request.',
          oneOf: [
            { $ref: '#/components/schemas/NeverflatCdrRequest' },
            { $ref: '#/components/schemas/OcpiCdrRequest' },
          ],
        },
        CdrToken: {
          type: 'object',
          required: ['contract_id'],
          properties: {
            contract_id: {
              type: 'string',
              minLength: 1,
              description: 'External contract ID. For the demo account use demo-user-001.',
              example: 'demo-user-001',
            },
            uid: { type: 'string', description: 'Optional OCPI token UID.' },
            type: { type: 'string', description: 'Optional OCPI token type.' },
            country_code: { type: 'string', minLength: 2, maxLength: 2 },
            party_id: { type: 'string' },
          },
          additionalProperties: true,
        },
        NeverflatCdrRequest: {
          type: 'object',
          title: 'Canonical NEVERFLAT CDR',
          description: 'Recommended public integration contract and the format used by the admin panel.',
          required: [
            'SessionID',
            'ProviderID',
            'cdr_token',
            'EVSEID',
            'StartTime',
            'EndTime',
            'Energy',
            'EnergyDirection',
          ],
          properties: {
            SessionID: { type: 'string', minLength: 1, example: 'session-20260914-001' },
            ProviderID: { type: 'string', minLength: 1, example: 'nvf-demo' },
            cdr_token: { $ref: '#/components/schemas/CdrToken' },
            EVSEID: {
              type: 'string',
              minLength: 2,
              description: 'EVSE identifier. Its country prefix drives country-specific reward rules.',
              example: 'DE*ABC*E*001',
            },
            StartTime: { type: 'string', format: 'date-time' },
            EndTime: { type: 'string', format: 'date-time' },
            Energy: {
              type: 'string',
              pattern: '^-?[0-9]+(?:\\.[0-9]+)*$',
              description: 'Energy in kWh. A numeric string is used by the admin integration.',
              example: '12',
            },
            EnergyDirection: {
              type: 'string',
              enum: ['CHARGE', 'DISCHARGE'],
              example: 'CHARGE',
            },
          },
          additionalProperties: false,
        },
        OcpiCdrRequest: {
          type: 'object',
          title: 'OCPI-style CDR',
          description: 'Supported compatibility contract. energyDirection is optional; when omitted, the sign of total_energy determines direction.',
          required: [
            'id',
            'party_id',
            'cdr_token',
            'cdr_location',
            'start_date_time',
            'end_date_time',
            'total_energy',
          ],
          properties: {
            id: { type: 'string', minLength: 1, example: 'cdr-session-20260914-001' },
            country_code: {
              type: 'string',
              minLength: 2,
              maxLength: 2,
              description: 'OCPI party country code. Reward rules use the EVSE ID country prefix.',
              example: 'DE',
            },
            party_id: { type: 'string', minLength: 1, example: 'NF' },
            cdr_token: { $ref: '#/components/schemas/CdrToken' },
            cdr_location: {
              type: 'object',
              required: ['evse_id'],
              properties: {
                evse_id: { type: 'string', minLength: 2, example: 'DE*ABC*E*001' },
              },
              additionalProperties: true,
            },
            start_date_time: { type: 'string', format: 'date-time' },
            end_date_time: { type: 'string', format: 'date-time' },
            total_energy: { type: 'number', example: 40 },
            energyDirection: {
              type: 'string',
              enum: ['CHARGE', 'DISCHARGE'],
              description: 'Optional explicit override for the sign-based direction inference.',
              example: 'CHARGE',
            },
          },
          additionalProperties: false,
        },
        CdrNormalisationMetadata: {
          type: 'object',
          required: ['eMAID', 'emaid', 'protocol', 'sourceField'],
          properties: {
            eMAID: { type: 'string', description: 'Canonical charging-contract ownership identifier.' },
            emaid: { type: 'string', description: 'Lower-camel alias of the canonical eMAID.' },
            protocol: { type: 'string', enum: ['OCPI', 'OICP', 'MIXED', 'UNKNOWN'] },
            sourceField: { type: 'string', description: 'Wire field that supplied the canonical eMAID.' },
            chargingSessionId: { type: 'string', description: 'Explicit OCPI session_id provenance used by the forward replacement guard.' },
            tokenMetadata: {
              type: 'object',
              description: 'Optional non-owning token/RFID metadata retained for audit only.',
              properties: {
                uid: { type: 'string' },
                type: { type: 'string' },
                countryCode: { type: 'string' },
                partyId: { type: 'string' },
                variant: { type: 'string' },
              },
              additionalProperties: false,
            },
          },
          additionalProperties: false,
        },
        CdrNormalisationError: {
          type: 'object',
          required: ['code', 'message', 'protocol', 'sourceFields'],
          properties: {
            code: {
              type: 'string',
              enum: ['INVALID_PAYLOAD', 'MISSING_EMAID', 'UID_ONLY', 'CONFLICTING_IDENTIFIERS', 'INVALID_EMAID'],
            },
            message: { type: 'string' },
            protocol: { type: 'string', enum: ['OCPI', 'OICP', 'MIXED', 'UNKNOWN'] },
            sourceFields: { type: 'array', items: { type: 'string' } },
          },
          additionalProperties: false,
        },
        CdrResponse: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'accepted' },
            sessionId: { type: 'string', example: 'cdr-session-001' },
            providerId: { type: 'string', example: 'NF' },
            uid: { type: 'string', example: '000' },
            normalisation: { $ref: '#/components/schemas/CdrNormalisationMetadata' },
            normalisationError: { $ref: '#/components/schemas/CdrNormalisationError' },
            policy: { $ref: '#/components/schemas/PolicyMetadata' },
            eligible: { type: 'boolean', example: true },
            tokensAwarded: { type: 'number', example: 10 },
            txHash: { type: 'string', example: '0xabc...' },
            awardTxHash: { type: 'string', nullable: true, description: 'Award transaction hash when reservation recovery has a separate pending hash.' },
            reservationId: { type: 'string', nullable: true },
            reservationTxHash: { type: 'string', nullable: true },
            operationStatus: { type: 'string', nullable: true },
            pending: { type: 'boolean' },
            retryable: { type: 'boolean' },
            requiresReview: { type: 'boolean' },
            preflightFailure: { type: 'boolean', nullable: true },
            spendPending: { type: 'boolean', nullable: true },
            financialStatus: { type: 'string', nullable: true },
            message: { type: 'string', example: '10 SPARKZ awarded' },
            reservationSettlement: {
              type: 'object',
              nullable: true,
              additionalProperties: true,
            },
          },
        },
        CdrPreviewResponse: {
          type: 'object',
          required: ['status', 'sideEffects', 'eligible', 'tokensAwarded', 'uid', 'dedupKey', 'normalisation', 'normalised'],
          properties: {
            status: { type: 'string', enum: ['preview'], example: 'preview' },
            sideEffects: { type: 'boolean', enum: [false], example: false },
            eligible: { type: 'boolean', example: true },
            tokensAwarded: { type: 'number', example: 3 },
            uid: { type: 'string', example: 'demo-user-001' },
            dedupKey: { type: 'string', example: 'session-20260914-001-nvf-demo' },
            normalisation: { $ref: '#/components/schemas/CdrNormalisationMetadata' },
            normalisationError: { $ref: '#/components/schemas/CdrNormalisationError' },
            policy: { $ref: '#/components/schemas/PolicyMetadata' },
            normalised: {
              type: 'object',
              required: ['sessionId', 'providerId', 'eMAID', 'protocol', 'sourceField', 'uid', 'evseId', 'startTime', 'endTime', 'energyKWh', 'energyDirection'],
              properties: {
                sessionId: { type: 'string' },
                providerId: { type: 'string' },
                eMAID: { type: 'string' },
                emaid: { type: 'string' },
                protocol: { type: 'string', enum: ['OCPI', 'OICP', 'MIXED', 'UNKNOWN'] },
                sourceField: { type: 'string' },
                tokenMetadata: { $ref: '#/components/schemas/CdrNormalisationMetadata/properties/tokenMetadata' },
                chargingSessionId: { type: 'string', description: 'Explicit OCPI session_id provenance used by the forward replacement guard.' },
                uid: { type: 'string' },
                evseId: { type: 'string' },
                startTime: { type: 'string', format: 'date-time' },
                endTime: { type: 'string', format: 'date-time' },
                energyKWh: { type: 'number' },
                energyDirection: { type: 'string', enum: ['CHARGE', 'DISCHARGE'] },
              },
            },
            metadata: { type: 'object', additionalProperties: true },
          },
        },
        PolicyMetadata: {
          type: 'object',
          required: ['revision', 'updatedAt'],
          properties: {
            revision: { type: 'integer', example: 3 },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        SpendSessionRequest: {
          type: 'object',
          required: ['sessionId', 'providerId', 'chargerId', 'status'],
          properties: {
            sessionId: { type: 'string', example: 'spend-001' },
            providerId: { type: 'string', example: 'NF' },
            chargerId: { type: 'string', example: 'charger-001' },
            status: {
              type: 'string',
              enum: ['CHARGER_OPENED', 'PLUGGED_IN', 'SESSION_STARTED'],
              example: 'PLUGGED_IN',
            },
            countryCode: { type: 'string', example: 'GB' },
            estimatedKwh: { type: 'number', example: 24.5 },
            estimatedCost: { type: 'number', example: 5 },
          },
        },
        SpendSessionResponse: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'success' },
            contractId: { type: 'string', example: '000' },
            sessionId: { type: 'string', example: 'spend-001' },
            providerId: { type: 'string', example: 'NF' },
            chargerId: { type: 'string', example: 'charger-001' },
            sessionStatus: { type: 'string', example: 'PLUGGED_IN' },
            wallet: {
              type: 'object',
              properties: {
                availableBalance: { type: 'number', example: 12.4 },
                totalEarned: { type: 'number', example: 20 },
                totalSpent: { type: 'number', example: 7.6 },
                mode: { type: 'string', enum: ['managed', 'custodial', 'unknown'], example: 'managed' },
              },
            },
            spend: {
              type: 'object',
              properties: {
                eligible: { type: 'boolean', example: true },
                maxSpendable: { type: 'number', example: 12.4 },
                suggestedAmount: { type: 'number', example: 5 },
                label: { type: 'string', example: 'Charging discount' },
                message: { type: 'string', example: 'You have 12.40 SPARKZ available' },
              },
            },
            recentActivity: {
              type: 'array',
              items: { $ref: '#/components/schemas/Transaction' },
            },
            rewardRates: {
              type: 'array',
              items: { $ref: '#/components/schemas/RewardRate' },
            },
          },
        },
        RewardRate: {
          type: 'object',
          properties: {
            key: { type: 'string', example: 'offPeakCharging' },
            label: { type: 'string', example: 'Off-peak charging' },
            enabled: { type: 'boolean', example: true },
            tokensPerKWh: { type: 'number', example: 0.25 },
            kWhPerSparkz: { type: 'number', nullable: true, example: 4 },
            description: { type: 'string', example: '1 SPARKZ per 4 kWh' },
          },
        },
        SpendRequest: {
          type: 'object',
          required: ['uid', 'amount'],
          anyOf: [
            { required: ['idempotencyKey'] },
            { required: ['operationKey'] },
          ],
          properties: {
            uid: { type: 'string', example: '000' },
            amount: { type: 'number', example: 5 },
            sessionId: { type: 'string', example: 'spend-001' },
            providerId: { type: 'string', example: 'NF' },
            label: { type: 'string', example: 'Charging discount' },
            idempotencyKey: { type: 'string', minLength: 1, description: 'Stable caller key required for a new manual spend and its retries; the exact key bytes are preserved' },
            operationKey: { type: 'string', minLength: 1, description: 'Opaque recovery key returned for an existing pending manual spend; it cannot create a new spend' },
          },
        },
        SpendMeRequest: {
          type: 'object',
          required: ['amount', 'sessionId', 'providerId'],
          properties: {
            amount: { type: 'number', example: 5 },
            sessionId: { type: 'string', example: 'spend-001' },
            providerId: { type: 'string', example: 'NF' },
            label: { type: 'string', example: 'Charging discount' },
            walletAddress: { type: 'string', description: 'Required for an active external wallet' },
            authorizationTxHash: { type: 'string', description: 'Confirmed approval transaction; required for an external wallet' },
          },
        },
        ReservationApprovalRequest: {
          type: 'object',
          required: ['walletAddress', 'amount', 'sessionId', 'providerId'],
          properties: {
            walletAddress: { type: 'string' },
            amount: { type: 'number', example: 5 },
            sessionId: { type: 'string', example: 'spend-001' },
            providerId: { type: 'string', example: 'NF' },
          },
        },
        SpendResponse: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'success' },
            uid: { type: 'string', example: '000' },
            sessionId: { type: 'string', example: 'spend-001' },
            providerId: { type: 'string', example: 'NF' },
            tokensSpent: { type: 'number', example: 5 },
            txHash: { type: 'string', example: '0xabc...' },
            operationKey: { type: 'string', nullable: true },
            operationStatus: { type: 'string', nullable: true },
            movementOutcome: { type: 'string', enum: ['unknown', 'confirmed', 'no_movement', 'review'], nullable: true, description: 'Durable token-movement classification; do not infer it from operationStatus.' },
            pending: { type: 'boolean' },
            retryable: { type: 'boolean' },
            requiresReview: { type: 'boolean' },
            preflightFailure: { type: 'boolean', nullable: true },
            financialStatus: { type: 'string', nullable: true },
            receiptStatus: { type: 'string', nullable: true },
            spendReceipt: { type: 'object', nullable: true, additionalProperties: true },
            projectionStatus: { type: 'string', nullable: true },
            recoveredProjection: { type: 'boolean', nullable: true },
            duplicate: { type: 'boolean', nullable: true },
            timestamp: { type: 'string', format: 'date-time' },
            label: { type: 'string', example: 'Charging discount' },
          },
        },
        ReservationResponse: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'success' },
            uid: { type: 'string', example: '000' },
            sessionId: { type: 'string', example: 'spend-001' },
            providerId: { type: 'string', example: 'NF' },
            reservation: {
              type: 'object',
              properties: {
                id: { type: 'string', format: 'uuid' },
                status: { type: 'string', enum: ['reserved'] },
                amount: { type: 'string', example: '5.00' },
                kWhEntitlement: { type: 'string', example: '5.00' },
                availableBalance: { type: 'number', example: 7.4 },
              },
            },
            timestamp: { type: 'string', format: 'date-time' },
            label: { type: 'string', example: 'Charging discount' },
          },
        },
        ReservationStatusResponse: {
          type: 'object',
          required: ['status', 'reservationId', 'sessionId', 'providerId', 'reservedSparkz', 'freeKwh', 'updatedAt'],
          properties: {
            status: { type: 'string', enum: ['reserved', 'settling', 'settled', 'released'] },
            reservationId: { type: 'string', format: 'uuid' },
            sessionId: { type: 'string' },
            providerId: { type: 'string' },
            reservedSparkz: { type: 'string', example: '5.00' },
            settledSparkz: { type: 'string', nullable: true, example: '3.00' },
            releasedSparkz: { type: 'string', nullable: true, example: '2.00' },
            deliveredKwh: { type: 'string', nullable: true, example: '3.000' },
            freeKwh: { type: 'string', example: '3.00' },
            txHash: { type: 'string', nullable: true },
            spendReceipt: { type: 'object', nullable: true, additionalProperties: true },
            receiptStatus: { type: 'string', enum: ['not_created', 'pending', 'settled', 'none'] },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        CustodialSpendRecordRequest: {
          type: 'object',
          required: ['uid', 'walletAddress', 'amount', 'txHash'],
          properties: {
            uid: { type: 'string', example: '000' },
            walletAddress: { type: 'string', example: '0x281cdB9F9407Ad029a6d7d5d9989a8362CDb7A59' },
            amount: { type: 'number', example: 5 },
            txHash: { type: 'string', example: '0xabc...' },
            sessionId: { type: 'string', example: 'spend-001' },
            providerId: { type: 'string', example: 'NF' },
          },
        },
        WalletResponse: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'success' },
            uid: { type: 'string', example: '000' },
            contractIds: { type: 'array', items: { type: 'string' }, example: ['000'] },
            linkedWalletAddresses: { type: 'array', items: { type: 'string' } },
            linkedWallets: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  walletAddress: { type: 'string' },
                  walletName: { type: 'string', nullable: true },
                },
              },
            },
            walletName: { type: 'string', nullable: true },
            walletAddress: { type: 'string' },
            managedWalletAddress: { type: 'string' },
            walletMode: { type: 'string', enum: ['managed', 'custodial'] },
            isRegistered: { type: 'boolean' },
            balance: { type: 'string', example: '33.00' },
            balanceStatus: { type: 'string', enum: ['confirmed', 'unavailable'], example: 'confirmed' },
            balanceSource: { type: 'string', enum: ['chain', 'database', 'none'], example: 'chain' },
            balanceWarning: { type: 'string', nullable: true, example: 'Live token balance is temporarily unavailable; showing the last recorded balance.' },
            totalAwarded: { type: 'string', example: '40.00' },
            totalSpent: { type: 'string', example: '7.00' },
            treasuryAddress: { type: 'string', nullable: true },
            tokenContractAddress: { type: 'string' },
            history: {
              type: 'array',
              items: { $ref: '#/components/schemas/Transaction' },
            },
            message: { type: 'string' },
          },
        },
        WalletModeRequest: {
          type: 'object',
          required: ['mode'],
          properties: {
            mode: { type: 'string', enum: ['managed', 'custodial'] },
            walletAddress: { type: 'string', example: '0x281cdB9F9407Ad029a6d7d5d9989a8362CDb7A59' },
            allowSplit: { type: 'boolean', example: false },
          },
        },
        WalletModeResponse: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'success' },
            uid: { type: 'string', example: '000' },
            walletAddress: { type: 'string' },
            managedWalletAddress: { type: 'string' },
            walletMode: { type: 'string', enum: ['managed', 'custodial'] },
            treasuryAddress: { type: 'string', nullable: true },
            tokenContractAddress: { type: 'string' },
          },
        },
        SourceWalletBalanceResponse: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'error' },
            uid: { type: 'string', example: '000' },
            code: { type: 'string', example: 'SOURCE_WALLET_HAS_BALANCE' },
            message: { type: 'string' },
            sourceWalletAddress: { type: 'string' },
            sourceBalance: { type: 'string', example: '15.0' },
            targetWalletAddress: { type: 'string' },
          },
        },
        WalletProfileRequest: {
          type: 'object',
          properties: {
            walletName: { type: 'string', nullable: true, example: 'My Main wallet' },
            walletAddress: { type: 'string', example: '0x281cdB9F9407Ad029a6d7d5d9989a8362CDb7A59' },
          },
        },
        ContractIdLinkRequest: {
          type: 'object',
          required: ['contractId'],
          properties: {
            contractId: { type: 'string', example: '001' },
            uid: { type: 'string', example: '001' },
            walletAddress: { type: 'string', example: '0x281cdB9F9407Ad029a6d7d5d9989a8362CDb7A59' },
          },
        },
        LinkedWalletRequest: {
          type: 'object',
          required: ['walletAddress', 'signature'],
          properties: {
            walletAddress: { type: 'string', example: '0x281cdB9F9407Ad029a6d7d5d9989a8362CDb7A59' },
            signature: { type: 'string', example: '0x...' },
          },
        },
        WalletNameRequest: {
          type: 'object',
          properties: {
            walletName: { type: 'string', nullable: true, example: 'My External wallet' },
          },
        },
        SignatureRequest: {
          type: 'object',
          required: ['signature'],
          properties: {
            signature: { type: 'string', example: '0x...' },
          },
        },
        MoveFundsRequest: {
          type: 'object',
          required: ['targetAddress'],
          properties: {
            targetAddress: { type: 'string', example: '0x281cdB9F9407Ad029a6d7d5d9989a8362CDb7A59' },
          },
        },
        MoveFundsResponse: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'success' },
            txHash: { type: 'string', example: '0xabc...' },
            amount: { type: 'string', example: '15.0' },
            targetAddress: { type: 'string' },
          },
        },
        Transaction: {
          type: 'object',
          properties: {
            type: { type: 'string', enum: ['award', 'spend'] },
            uid: { type: 'string', nullable: true },
            walletAddress: { type: 'string', nullable: true },
            walletName: { type: 'string', nullable: true },
            amount: { type: 'string' },
            label: { type: 'string' },
            txHash: { type: 'string' },
            sessionId: { type: 'string', nullable: true },
            timestamp: { type: 'string', format: 'date-time' },
            isOffPeak: { type: 'boolean' },
            countryCode: { type: 'string' },
            localTime: { type: 'string' },
            awardType: { type: 'string' },
          },
        },
        TransactionsResponse: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'ok' },
            transactionCount: { type: 'integer', example: 1 },
            transactions: {
              type: 'array',
              items: { $ref: '#/components/schemas/Transaction' },
            },
          },
        },
        AdminLoginRequest: {
          type: 'object',
          required: ['username', 'password'],
          properties: {
            username: { type: 'string', example: 'admin' },
            password: { type: 'string', format: 'password' },
          },
        },
        AdminRulesResponse: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'ok' },
            rules: { type: 'object' },
            policy: { $ref: '#/components/schemas/PolicyMetadata' },
            revision: { type: 'integer', example: 3 },
            updatedAt: { type: 'string', format: 'date-time' },
          },
        },
        AdminRulesUpdateRequest: {
          type: 'object',
          properties: {
            offPeakChargingTokensPerKWh: { type: 'number', example: 0.25 },
            v2gDischargeTokensPerKWh: { type: 'number', example: 1 },
            offPeakChargingEnabled: { type: 'boolean', example: true },
            v2gDischargeEnabled: { type: 'boolean', example: true },
          },
        },
        OffPeakResponse: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'ok' },
            policy: { $ref: '#/components/schemas/PolicyMetadata' },
            revision: { type: 'integer', example: 3 },
            updatedAt: { type: 'string', format: 'date-time' },
            windows: {
              type: 'object',
              additionalProperties: {
                type: 'array',
                items: { $ref: '#/components/schemas/TimeRange' },
              },
              example: {
                GB: [{ start: '22:00', end: '06:00' }],
              },
            },
          },
        },
        OffPeakUpdateRequest: {
          type: 'object',
          required: ['windows'],
          properties: {
            windows: {
              type: 'object',
              additionalProperties: {
                type: 'array',
                items: { $ref: '#/components/schemas/TimeRange' },
              },
              example: {
                GB: [{ start: '22:00', end: '06:00' }],
              },
            },
          },
        },
        TimeRange: {
          type: 'object',
          required: ['start', 'end'],
          properties: {
            start: { type: 'string', example: '22:00' },
            end: { type: 'string', example: '06:00' },
          },
        },
      },
    },
  };
}

/**
 * OpenAPI specification (no authentication required)
 */
app.get('/openapi.json', (req: Request, res: Response) => {
  res.json(buildOpenApiSpec(req));
});

/**
 * Swagger UI documentation page (no authentication required)
 */
app.get(['/api-docs', '/docs'], (_req: Request, res: Response) => {
  res.type('html').send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>NEVERFLAT SPARKZ API Docs</title>
    <link rel="stylesheet" href="https://unpkg.com/swagger-ui-dist@5/swagger-ui.css" />
    <style>
      body { margin: 0; background: #f7f8fb; }
      .topbar { display: none; }
      .swagger-ui .info { margin: 28px 0; }
    </style>
  </head>
  <body>
    <div id="swagger-ui"></div>
    <script src="https://unpkg.com/swagger-ui-dist@5/swagger-ui-bundle.js"></script>
    <script>
      window.ui = SwaggerUIBundle({
        url: '/openapi.json',
        dom_id: '#swagger-ui',
        deepLinking: true,
        persistAuthorization: true,
        displayRequestDuration: true
      });
    </script>
  </body>
</html>`);
});

function validateIngestApiKey(req: Request, res: Response, next: NextFunction): void {
  const auth = req.header('Authorization');
  const adminToken = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (adminToken && adminSessions.has(adminToken)) {
    return next();
  }

  const apiKey = req.header('X-Ingest-API-Key') || req.header('X-API-Key');
  const acceptedKeys = (INGEST_API_KEY
    ? [INGEST_API_KEY, BEIA_API_KEY]
    : [API_KEY, BEIA_API_KEY]
  ).filter((key): key is string => Boolean(key));

  if (acceptedKeys.length === 0) {
    res.status(503).json({
      status: 'error',
      message: 'Ingest API key authentication is not configured',
    });
    return;
  }

  if (!apiKey) {
    res.status(401).json({
      status: 'error',
      message: 'Missing ingest API key: X-Ingest-API-Key or X-API-Key header required',
    });
    return;
  }

  if (!acceptedKeys.includes(apiKey)) {
    void safeAuditLog({
      eventType: 'auth.ingest_key_rejected',
      actorType: 'api_client',
      actorId: 'ingest',
      targetType: 'endpoint',
      targetId: '/ingest/cdr',
      status: 'error',
      metadata: {},
    });
    res.status(403).json({
      status: 'error',
      message: 'Invalid ingest API key',
    });
    return;
  }

  next();
}

/**
 * Health check endpoint (no authentication required)
 */
app.get('/ingest/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * Verify a signed spend receipt for FE/EMP integration checks.
 * POST /spend-receipts/verify
 */
app.post('/spend-receipts/verify', validateApiKey, async (req: Request, res: Response) => {
  try {
    const { payload, signature, signerAddress } = req.body;
    if (!payload || typeof payload !== 'object' || !signature) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required fields: payload and signature',
      });
    }

    const trustedSignerAddress = await treasurySigner.getAddress();
    const claimedSignerAddress = signerAddress ?? trustedSignerAddress;
    if (typeof claimedSignerAddress !== 'string' || !claimedSignerAddress) {
      return res.status(400).json({
        status: 'error',
        message: 'signerAddress must be a non-empty string when provided',
      });
    }

    const verification = verifySpendReceiptAgainstTrustedSigner(
      payload,
      signature,
      claimedSignerAddress,
      trustedSignerAddress,
    );
    const valid = verification.valid;
    return res.status(200).json({
      status: valid ? 'valid' : 'invalid',
      valid,
      signerAddress: trustedSignerAddress,
      receiptId: payload.receiptId || null,
      recoveredSignerAddress: verification.recoveredSignerAddress || null,
      failure: verification.failure || null,
    });
  } catch (err) {
    return res.status(400).json({
      status: 'error',
      valid: false,
      message: 'The receipt could not be verified because the request is invalid.',
    });
  }
});

/**
 * CDR preview endpoint for AU/pilot payload validation and performance evidence.
 * POST /ingest/cdr/preview
 *
 * Normalises the payload and applies reward rules without writing to the DB or
 * submitting an on-chain transaction.
 */
app.post('/ingest/cdr/preview', validateIngestApiKey, async (req: Request, res: Response) => {
  try {
    const cdr: RawSession | OCPICDRFormat = req.body;
    const normalised = validateAndNormaliseCdr(cdr);
    let policy;
    try {
      policy = await getRewardPolicyRepository().load();
    } catch (err) {
      return sendRewardPolicyUnavailable(res, err, 'calculation');
    }
    const award = await withPolicySnapshot(policy, () => prepareAward(normalised));

    if (exceedsTokenOperationCap(award.amount)) {
      return tokenCapError(res, 'award', award.amount);
    }

    return res.status(200).json({
      status: 'preview',
      sideEffects: false,
      eligible: award.eligible,
      tokensAwarded: award.amount,
      uid: award.uid,
      dedupKey: award.dedupKey,
      normalisation: cdrNormalisationMetadata(normalised),
      normalised: {
        sessionId: normalised.sessionId,
        providerId: normalised.providerId,
        eMAID: normalised.eMAID || normalised.uid,
        emaid: normalised.emaid || normalised.eMAID || normalised.uid,
        protocol: normalised.protocol || 'UNKNOWN',
        sourceField: normalised.sourceField || 'unknown',
        ...(normalised.tokenMetadata ? { tokenMetadata: normalised.tokenMetadata } : {}),
        ...(normalised.chargingSessionId ? { chargingSessionId: normalised.chargingSessionId } : {}),
        uid: normalised.uid,
        evseId: normalised.evseId,
        startTime: normalised.startTime.toISOString(),
        endTime: normalised.endTime.toISOString(),
        energyKWh: normalised.energyKWh,
        energyDirection: normalised.energyDirection,
      },
      metadata: award.metadata || {},
      policy: {
        revision: policy.revision,
        updatedAt: policy.updatedAt,
      },
    });
  } catch (err) {
    const normalisationError = cdrNormalisationErrorMetadata(err, req.body);
    await safeAuditLog({
      eventType: 'award.preview_failed',
      actorType: 'ingest_client',
      actorId: null,
      targetType: 'cdr_preview',
      targetId: null,
      status: 'error',
      metadata: {
        error: err instanceof Error ? err.message : String(err),
        ...(normalisationError ? { normalisationError } : {}),
      },
    });
    return res.status(400).json({
      status: 'error',
      code: 'INVALID_CDR',
      message: normalisationError?.message || 'The CDR could not be validated because its charging data is invalid or incomplete.',
      ...(normalisationError ? { normalisationError } : {}),
    });
  }
});

/**
 * CDR Ingestion endpoint
 * POST /ingest/cdr
 * 
 * Accepts raw CDR data, processes award if eligible, returns status
 * Requires X-API-Key header for authentication
 */
app.post('/ingest/cdr', validateIngestApiKey, async (req: Request, res: Response) => {
  try {
    const cdr: RawSession | OCPICDRFormat = req.body;

    let normalised: NormalisedSession;
    try {
      normalised = validateAndNormaliseCdr(cdr);
    } catch (validationError) {
      const normalisationError = cdrNormalisationErrorMetadata(validationError, cdr);
      await safeAuditLog({
        eventType: 'award.validation_failed',
        actorType: 'ingest_client',
        actorId: cdr?.ProviderID || cdr?.party_id || cdr?.custom_data?.provider_id || null,
        targetType: 'cdr',
        targetId: cdr?.SessionID || cdr?.id || null,
        status: 'error',
        metadata: {
          reason: 'invalid_cdr',
          error: getErrorMessage(validationError),
          ...(normalisationError ? { normalisationError } : {}),
        },
      });
      return res.status(400).json({
        status: 'error',
        code: 'INVALID_CDR',
        message: getErrorMessage(validationError),
        ...(normalisationError ? { normalisationError } : {}),
      });
    }

    const { sessionId, providerId, uid: contractId } = normalised;
    const normalisation = cdrNormalisationMetadata(normalised);

    // Look up the durable award operation before calculating today's rules.
    // A replay must use its stored intent/fingerprint; a changed CDR must be
    // rejected by the executor before any reservation is settled.
    let existingAwardOperation;
    try {
      existingAwardOperation = await TokenOperations.findByKey(
        awardOperationKey(normalised.providerId, normalised.sessionId)
      );
    } catch (err) {
      sendTokenOperationRecoveryUnavailable(res, err, 'award');
      return;
    }

    // A new calculation must use one durable, immutable policy snapshot for
    // both the cap preflight and executor. Recovered operations retain their
    // saved intent and do not need today's policy to replay.
    let policy;
    if (!existingAwardOperation) {
      try {
        policy = await getRewardPolicyRepository().load();
      } catch (err) {
        return sendRewardPolicyUnavailable(res, err, 'calculation');
      }
    }
    const preparedAward = existingAwardOperation
      ? undefined
      : await withPolicySnapshot(policy!, () => prepareAward(normalised));
    if (preparedAward && exceedsTokenOperationCap(preparedAward.amount)) {
      await safeAuditLog({
        eventType: 'award.validation_failed',
        actorType: 'ingest_client',
        actorId: String(providerId),
        targetType: 'cdr',
        targetId: String(sessionId),
        status: 'error',
        metadata: {
          reason: 'token_amount_cap_exceeded',
          normalisation,
          requestedAmount: preparedAward.amount,
          maximumAmount: MAX_TOKENS_PER_OPERATION,
        },
      });
      return tokenCapError(res, 'award', preparedAward.amount);
    }

    // The executor owns legacy deduplication and the durable operation claim.
    // Running a raw `Awards.exists(dedupKey)` check here would reintroduce the
    // old ambiguous key collision: a legacy row could cause a different
    // provider/session tuple to be reported as a duplicate before its exact
    // intent was checked.  Let processAwardFromCDR verify the tuple and
    // recover an existing operation without making another chain call.
    const dedupKey = `${sessionId}-${providerId}`;

    await auditTreasuryGasWarning('award.ingest.before_execution');

    // Process award
    const result = policy
      ? await withPolicySnapshot(policy, () => processAwardFromCDR(cdr, treasurySigner))
      : await processAwardFromCDR(cdr, treasurySigner);

    if (!result.success) {
      if (isTreasuryGasIssue(result.error)) {
        await auditTreasuryGasWarning('award.ingest.failure', result.error);
      }
      await safeAuditLog({
        eventType: 'award.failed',
        actorType: 'ingest_client',
        actorId: String(providerId),
        targetType: 'award_dedup_key',
        targetId: result.dedupKey || dedupKey,
          status: result.requiresReview
            ? 'requires_review'
            : (result.stage === 'execution' ? 'retry_required' : 'error'),
          metadata: {
          sessionId,
          providerId,
          uid: result.uid || contractId,
          normalisation,
          stage: result.stage,
          error: result.error,
        },
      });
      const chargingSessionCollision = typeof result.error === 'string'
        && result.error.startsWith('AWARD_CHARGING_SESSION_COLLISION_REVIEW:');
      return res.status(result.pending ? 202 : 400).json({
        status: result.pending ? 'pending' : 'error',
        ...(chargingSessionCollision ? { code: 'AWARD_CHARGING_SESSION_COLLISION_REVIEW' } : {}),
        sessionId,
        providerId,
        normalisation,
        txHash: result.txHash || null,
          operationStatus: result.operationStatus || null,
          pending: Boolean(result.pending),
          retryable: Boolean(result.pending && !result.requiresReview),
          requiresReview: Boolean(result.requiresReview),
        error: toUserFacingAwardError(result.error, result.stage),
      });
    }

    await safeAuditLog({
      eventType: result.eligible ? 'award.completed' : 'award.not_eligible',
      actorType: 'ingest_client',
      actorId: String(providerId),
      targetType: 'award_dedup_key',
      targetId: result.dedupKey || dedupKey,
      status: 'success',
      metadata: {
        sessionId,
        providerId,
        uid: result.uid,
        normalisation,
        amount: result.amount,
        txHash: result.txHash || null,
        eligible: result.eligible,
      },
    });

    // Reservation settlement is deliberately after durable award validation
    // and recovery. A changed owner/CDR can therefore never debit a matching
    // reservation before the award operation rejects its fingerprint.
    let reservationSettlement;
    try {
      reservationSettlement = await settleReservationFromCdr(normalised);
    } catch (err) {
      const recovery = err as Error & {
        pending?: boolean;
        spendPending?: boolean;
        settlementPending?: boolean;
        preflightFailure?: boolean;
        retryable?: boolean;
        reservationId?: string;
        txHash?: string;
        financialStatus?: string;
        movementOutcome?: string;
        requiresReview?: boolean;
      };
      if (recovery.pending || recovery.settlementPending || recovery.reservationId || recovery.txHash) {
        const errorText = getErrorMessage(err);
        const requiresReview = recovery.requiresReview === undefined
          ? (!recovery.txHash && recovery.financialStatus === 'unknown')
          : recovery.requiresReview;
        const retryable = recovery.retryable === undefined
          ? (!requiresReview && (Boolean(recovery.pending) || Boolean(recovery.txHash)))
          : recovery.retryable;
        await safeAuditLog({
          eventType: 'spend.reservation_recovery_pending',
          actorType: 'ingest_client',
          actorId: String(providerId),
          targetType: 'spend_reservation',
          targetId: recovery.reservationId || null,
          status: requiresReview ? 'requires_review' : 'retry_required',
          metadata: {
            error: errorText,
            txHash: recovery.txHash || null,
            awardTxHash: result.txHash || null,
            requiresReview,
            retryable,
          },
        });
        return res.status(202).json({
          status: 'pending',
          sessionId,
          providerId,
          uid: result.uid,
          normalisation,
          ...(policy ? { policy: { revision: policy.revision, updatedAt: policy.updatedAt } } : {}),
          eligible: result.eligible,
          tokensAwarded: result.amount,
          awardTxHash: result.txHash || null,
          txHash: recovery.txHash || result.txHash || null,
          operationStatus: result.operationStatus || null,
          reservationId: recovery.reservationId || null,
          reservationTxHash: recovery.txHash || null,
          movementOutcome: recovery.movementOutcome || null,
          financialStatus: recovery.financialStatus || 'pending',
          pending: true,
          retryable,
          requiresReview,
          spendPending: Boolean(recovery.spendPending),
          preflightFailure: Boolean(recovery.preflightFailure),
          error: requiresReview
            ? 'Award outcome is known but reservation settlement requires operator review.'
            : 'Award outcome is known but reservation settlement is pending recovery. Retry the same CDR or poll the reservation status.',
        });
      }
      throw err;
    }

    return res.status(200).json({
      status: result.duplicate ? 'duplicate' : 'accepted',
      sessionId,
      providerId,
      uid: result.uid,
      normalisation,
      eligible: result.eligible,
      tokensAwarded: result.amount,
      txHash: result.txHash,
      awardTxHash: result.txHash || null,
      operationStatus: result.operationStatus || null,
      ...(policy ? { policy: { revision: policy.revision, updatedAt: policy.updatedAt } } : {}),
      message: result.eligible ? `${result.amount} SPARKZ awarded` : 'CDR accepted but not eligible for reward',
      reservationSettlement,
    });
  } catch (err) {
    console.error('CDR ingestion error:', err);
    if (isTreasuryGasIssue(err)) {
      await auditTreasuryGasWarning('award.ingest.unhandled_error', err);
    }
    await safeAuditLog({
      eventType: 'award.unhandled_error',
      actorType: 'ingest_client',
      actorId: null,
      targetType: 'endpoint',
      targetId: '/ingest/cdr',
      status: 'error',
      metadata: {
        error: err instanceof Error ? err.message : String(err),
      },
    });
    res.status(500).json({
      status: 'error',
      error: toUserFacingAwardError(err),
    });
  }
});

/**
 * Session-context spend prompt endpoint.
 * POST /spend/session
 *
 * Resolves contract identity and returns wallet/session spend eligibility.
 * This endpoint never spends tokens.
 */
app.post('/spend/session', validateApiKey, async (req: Request, res: Response) => {
  try {
    const contractId = getRequestContractId(req);
    if (!contractId) {
      return res.status(401).json({
        status: 'error',
        message: `Missing identity header: ${USER_IDENTITY_HEADER}`,
      });
    }

    const normalizedUid = normalizeUid(contractId);
    const {
      sessionId,
      providerId,
      chargerId,
      status: sessionStatus,
      countryCode,
      estimatedKwh,
      estimatedCost,
    } = req.body || {};

    const missingFields = getMissingFields(req.body || {}, ['sessionId', 'providerId', 'chargerId', 'status']);

    if (!normalizedUid || missingFields.length) {
      return sendJsonError(res, 400, {
        code: 'MISSING_REQUIRED_FIELDS',
        message: `Missing required fields: ${missingFields.join(', ')}`,
        missingFields,
      });
    }

    if (typeof sessionStatus !== 'string' || !SESSION_SPEND_STATUSES.has(sessionStatus)) {
      return sendJsonError(res, 400, {
        code: 'INVALID_SESSION_STATUS',
        message: 'Invalid status. Use CHARGER_OPENED, PLUGGED_IN, or SESSION_STARTED.',
      });
    }

    const numericEstimatedKwh = getOptionalFiniteNumber(estimatedKwh);
    const numericEstimatedCost = getOptionalFiniteNumber(estimatedCost);

    if (estimatedKwh !== undefined && numericEstimatedKwh === undefined) {
      return sendJsonError(res, 400, {
        code: 'INVALID_ESTIMATED_KWH',
        message: 'estimatedKwh must be a number when provided.',
      });
    }

    if (estimatedCost !== undefined && numericEstimatedCost === undefined) {
      return sendJsonError(res, 400, {
        code: 'INVALID_ESTIMATED_COST',
        message: 'estimatedCost must be a number when provided.',
      });
    }

    // This endpoint presents the active reward policy to the operator/user.
    // Load it after API authentication and evaluate the rates inside the same
    // immutable request snapshot used by award calculations; never advertise
    // bundled defaults after a durable policy update or restart.
    let policy;
    try {
      policy = await getRewardPolicyRepository().load();
    } catch (err) {
      return sendRewardPolicyUnavailable(res, err, 'read');
    }
    const rewardRates = withPolicySnapshot(policy, () => getPublicRewardRates());

    const walletPayload = await getWalletPayload(normalizedUid);
    const onChainBalance = Number(walletPayload.balance || 0);
    const reservedBalance = await SpendReservations.getActiveTotal(normalizedUid, walletPayload.walletAddress);
    const availableBalance = Math.max(0, onChainBalance - reservedBalance);
    const totalEarned = Number(walletPayload.totalAwarded || 0);
    const totalSpent = Number(walletPayload.totalSpent || 0);
    const hasSpendableSparkz = Number.isFinite(availableBalance) && availableBalance > 0;
    // Final energy is unknown at session start; the user chooses the reservation.
    const suggestedAmount = 0;

    return res.status(200).json({
      status: 'success',
      contractId: normalizedUid,
      sessionId,
      providerId,
      chargerId,
      sessionStatus,
      countryCode: countryCode || null,
      estimatedKwh: numericEstimatedKwh,
      estimatedCost: numericEstimatedCost,
      wallet: {
        availableBalance,
        reservedBalance,
        totalEarned,
        totalSpent,
        mode: walletPayload.walletMode || 'unknown',
      },
      spend: {
        eligible: hasSpendableSparkz,
        maxSpendable: hasSpendableSparkz ? availableBalance : 0,
        suggestedAmount,
        label: 'Charging discount',
        message: hasSpendableSparkz
          ? `You have ${availableBalance.toFixed(2)} SPARKZ available to reserve`
          : 'No SPARKZ are available for this charging session',
      },
      recentActivity: walletPayload.history || [],
      rewardRates,
      policy: { revision: policy.revision, updatedAt: policy.updatedAt },
    });
  } catch (err) {
    console.error('Spend session error:', err);
    return res.status(500).json({
      status: 'error',
      code: 'SPEND_SESSION_UNAVAILABLE',
      message: 'The charging session could not be loaded right now. Please retry shortly.',
    });
  }
});

/**
 * Spend endpoint
 * POST /spend
 * 
 * Accepts spend request with uid, amount, label
 * Resolves uid to wallet address and executes spend
 * Requires X-API-Key header for authentication
 */
app.post('/spend', validateApiKey, async (req: Request, res: Response) => {
  try {
    const { uid, amount, label } = req.body;
    const idempotencyKey = req.body?.idempotencyKey;
    const operationKey = req.body?.operationKey;
    const amountProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'amount');
    const normalizedUid = normalizeUid(String(uid || ''));
    let sessionId = typeof req.body?.sessionId === 'string' ? req.body.sessionId : undefined;
    let providerId = typeof req.body?.providerId === 'string' ? req.body.providerId : undefined;

    if ((idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !idempotencyKey.trim()))
      || (operationKey !== undefined && (typeof operationKey !== 'string' || !operationKey.trim()))) {
      return spendValidationError(res, 'INVALID_OPERATION_KEY', 'idempotencyKey and operationKey must be non-empty strings when provided');
    }
    if (typeof operationKey === 'string' && !/^(?:spend|request):/.test(operationKey)) {
      return spendValidationError(res, 'INVALID_OPERATION_KEY', 'operationKey is only valid for an existing manual spend operation');
    }
    if (!isStableSpendKey(idempotencyKey) && !isStableSpendKey(operationKey)) {
      return spendValidationError(
        res,
        'IDEMPOTENCY_KEY_REQUIRED',
        'A stable non-empty idempotencyKey is required for a new manual spend; use a returned operationKey only to recover an existing spend',
      );
    }

    let amountValue = getPositiveAmount(amount);
    const requestedOperationKey = typeof operationKey === 'string'
      ? operationKey
      : typeof idempotencyKey === 'string'
        ? spendOperationKey(normalizedUid, idempotencyKey)
        : undefined;

    // Validate
    if (!normalizedUid) {
      await safeAuditLog({
        eventType: 'spend.validation_failed',
        actorType: 'api_client',
        actorId: normalizedUid || null,
        targetType: 'spend_request',
        targetId: sessionId || null,
        status: 'error',
        metadata: {
          uid: normalizedUid,
          amount,
          sessionId,
          providerId,
          reason: 'missing_or_invalid_uid_or_amount',
        },
      });
      return res.status(400).json({
        status: 'error',
        code: 'INVALID_SPEND_REQUEST',
        message: 'Missing or invalid fields: uid, amount (must be > 0)',
      });
    }

    let existingSpendOperation;
    if (requestedOperationKey) {
      try {
        existingSpendOperation = await TokenOperations.findByKey(requestedOperationKey);
      } catch (err) {
        sendTokenOperationRecoveryUnavailable(res, err, 'spend');
        return;
      }
      if (typeof operationKey === 'string' && !existingSpendOperation) {
        return spendValidationError(res, 'OPERATION_NOT_FOUND', 'operationKey must identify an existing manual spend operation');
      }
      if (existingSpendOperation) {
        if (existingSpendOperation.operation_type !== 'spend') {
          return spendValidationError(res, 'INVALID_OPERATION_KEY', 'operationKey does not identify a manual spend operation');
        }
        if (existingSpendOperation.uid !== normalizedUid) {
          return spendValidationError(res, 'TOKEN_OPERATION_INTENT_MISMATCH', 'operationKey belongs to a different contract identity');
        }
        const originalAmount = canonicalTokenAmount(existingSpendOperation.amount);
        if (!originalAmount || originalAmount.units <= 0n) {
          return spendValidationError(res, 'TOKEN_OPERATION_REVIEW_REQUIRED', 'stored spend amount is invalid and requires operator review');
        }
        if (!amountProvided) {
          amountValue = originalAmount.value;
        } else if (amountValue === null) {
          return spendValidationError(res, 'INVALID_SPEND_REQUEST', 'amount must be greater than 0 and use at most 2 decimal places');
        } else if (canonicalTokenAmount(amountValue)?.units !== originalAmount.units) {
          return spendValidationError(res, 'TOKEN_OPERATION_INTENT_MISMATCH', 'amount differs from the original manual spend operation');
        }
        const originalSessionId = existingSpendOperation.session_id || undefined;
        const originalProviderId = existingSpendOperation.provider_id || undefined;
        if (sessionId !== undefined && sessionId !== originalSessionId) {
          return spendValidationError(res, 'TOKEN_OPERATION_INTENT_MISMATCH', 'sessionId differs from the original manual spend operation');
        }
        if (providerId !== undefined && providerId !== originalProviderId) {
          return spendValidationError(res, 'TOKEN_OPERATION_INTENT_MISMATCH', 'providerId differs from the original manual spend operation');
        }
        sessionId = originalSessionId;
        providerId = originalProviderId;
        if (typeof idempotencyKey === 'string'
          && spendOperationKey(normalizedUid, idempotencyKey) !== requestedOperationKey) {
          return spendValidationError(res, 'TOKEN_OPERATION_INTENT_MISMATCH', 'idempotencyKey does not match operationKey');
        }
      }
    }

    if (amountValue === null || !hasSupportedTokenPrecision(amountValue)) {
      await safeAuditLog({
        eventType: 'spend.validation_failed',
        actorType: 'api_client',
        actorId: normalizedUid || null,
        targetType: 'spend_request',
        targetId: sessionId || null,
        status: 'error',
        metadata: {
          uid: normalizedUid,
          amount,
          sessionId,
          providerId,
          reason: 'missing_or_invalid_uid_or_amount',
        },
      });
      return res.status(400).json({
        status: 'error',
        code: 'INVALID_SPEND_REQUEST',
        message: 'Missing or invalid fields: uid, amount (must be > 0 and use at most 2 decimal places)',
      });
    }

    if (exceedsTokenOperationCap(amountValue) && !existingSpendOperation) {
      return tokenCapError(res, 'spend', amountValue);
    }

    // Resolve uid to wallet address
    const walletConfig = await getUserWalletConfig(normalizedUid);
    // Keep the original owner address for a keyed replay even if the active
    // wallet profile has since changed.
    const userAddress = existingSpendOperation?.wallet_address || walletConfig.managedWalletAddress;

    // Manual spends must respect reservations held by this actual wallet.
    // New manual requests have already been required to carry a stable key;
    // keyed recovery skips this balance precheck after intent validation.
    if (!existingSpendOperation) {
      const onChainBalance = Number(ethers.formatEther(await getOnChainTokenBalance(userAddress)));
      const reservedBalance = await SpendReservations.getActiveTotal(normalizedUid, userAddress);
      const availableBalance = Math.max(0, onChainBalance - reservedBalance);
      if (amountValue > availableBalance) {
        return spendValidationError(res, 'INSUFFICIENT_SPARKZ', 'amount exceeds available SPARKZ balance after active reservations', {
          availableBalance,
          requestedAmount: amountValue,
          reservedBalance,
        });
      }
    }

    await auditTreasuryGasWarning('spend.legacy.before_execution');

    const spendResult = await processSpendWithAutoApproval({
      uid: normalizedUid,
      userAddress,
      amount: amountValue,
      sessionId,
      providerId,
      operationKey: typeof operationKey === 'string' ? operationKey : undefined,
      idempotencyKey: typeof idempotencyKey === 'string' ? idempotencyKey : undefined,
      auditContext: 'legacy',
      onApprovalFailure: async approvalErr => {
        await safeAuditLog({
          eventType: 'spend.auto_approval_failed',
          actorType: 'api_client',
          actorId: normalizedUid,
          targetType: 'wallet',
          targetId: userAddress,
          status: 'retry_required',
          metadata: {
            uid: normalizedUid,
            amount,
            sessionId,
            providerId,
            error: getErrorMessage(approvalErr),
          },
        });
      },
    });

    if (!spendResult.success) {
      if (isTreasuryGasIssue(spendResult.error)) {
        await auditTreasuryGasWarning('spend.legacy.failure', spendResult.error);
      }
      await safeAuditLog({
        eventType: 'spend.failed',
        actorType: 'api_client',
        actorId: normalizedUid,
        targetType: 'wallet',
        targetId: userAddress,
        status: 'retry_required',
        metadata: {
          uid: normalizedUid,
          amount,
          sessionId,
          providerId,
          movementOutcome: spendResult.movementOutcome || null,
          error: spendResult.error,
        },
      });
      return res.status(spendResult.pending ? 202 : 400).json({
        status: spendResult.pending ? 'pending' : 'error',
        uid: normalizedUid,
        txHash: spendResult.txHash || null,
        operationKey: spendResult.operationKey || null,
        operationStatus: spendResult.operationStatus || null,
        movementOutcome: spendResult.movementOutcome || null,
        pending: Boolean(spendResult.pending),
        retryable: Boolean(spendResult.pending && !spendResult.requiresReview),
        requiresReview: Boolean(spendResult.requiresReview),
        preflightFailure: Boolean(spendResult.preflightFailure),
        error: toUserFacingSpendError(spendResult.error),
      });
    }

    let spendReceipt: SignedSpendReceipt & { dbStored: boolean; dbError?: string };
    try {
      spendReceipt = await createAndStoreSpendReceipt({
        uid: normalizedUid,
        walletAddress: userAddress,
        amount: spendResult.amount,
        sessionId,
        providerId,
        txHash: spendResult.txHash!,
      });
    } catch (err) {
      const recovery = err as Error & { receiptConflict?: boolean; requiresReview?: boolean; receiptPending?: boolean };
      if (recovery.receiptConflict || recovery.requiresReview) {
        return res.status(409).json({
          status: 'error',
          code: 'SPEND_RECEIPT_CONTEXT_MISMATCH',
          uid: normalizedUid,
          txHash: spendResult.txHash,
          movementOutcome: spendResult.movementOutcome || 'confirmed',
          receiptStatus: 'invalid',
          pending: false,
          retryable: false,
          requiresReview: true,
          error: toUserFacingReceiptError(err),
        });
      }
      if (!recovery.receiptPending) throw err;
      return res.status(202).json({
        status: 'pending',
        uid: normalizeUid(String(req.body.uid || '')),
        sessionId,
        providerId,
        tokensSpent: spendResult.amount,
        txHash: spendResult.txHash,
        operationKey: spendResult.operationKey || null,
        movementOutcome: spendResult.movementOutcome || 'confirmed',
        financialStatus: 'confirmed',
        receiptStatus: 'pending',
        pending: true,
        retryable: true,
        requiresReview: false,
        error: 'The spend is confirmed but its receipt is pending persistence. Retry with the same idempotencyKey or returned operationKey.',
      });
    }
    await safeAuditLog({
      eventType: 'spend.completed',
      actorType: 'api_client',
      actorId: 'manual_spend',
      targetType: 'token_tx',
      targetId: spendResult.txHash,
      status: 'success',
      metadata: {
        uid: normalizedUid,
        walletAddress: userAddress,
        amount: spendResult.amount,
        sessionId,
        providerId,
        movementOutcome: spendResult.movementOutcome || null,
        receiptId: spendReceipt.payload.receiptId,
      },
    });

    return res.status(200).json({
      status: 'success',
      uid: normalizedUid,
      sessionId,
      providerId,
      tokensSpent: spendResult.amount,
      txHash: spendResult.txHash,
      operationKey: spendResult.operationKey,
      movementOutcome: spendResult.movementOutcome || null,
      timestamp: new Date().toISOString(),
      label,
      spendReceipt,
    });
  } catch (err) {
    console.error('Spend error:', err);
    if (isTreasuryGasIssue(err)) {
      await auditTreasuryGasWarning('spend.legacy.unhandled_error', err);
    }
    await safeAuditLog({
      eventType: 'spend.unhandled_error',
      actorType: 'api_client',
      actorId: null,
      targetType: 'endpoint',
      targetId: '/spend',
      status: 'error',
      metadata: {
        error: err instanceof Error ? err.message : String(err),
      },
    });
    res.status(500).json({
      status: 'error',
      error: toUserFacingSpendError(err),
    });
  }
});

/** Build a capped ERC-20 approval for an external wallet reservation. */
app.post('/spend/reservation-approval-intent', validateApiKey, async (req: Request, res: Response) => {
  try {
    const contractId = getRequestContractId(req);
    if (!contractId) return res.status(401).json({ status: 'error', message: `Missing identity header: ${USER_IDENTITY_HEADER}` });
    const normalizedUid = normalizeUid(contractId);
    const { walletAddress, amount, sessionId, providerId } = req.body || {};
    const amountValue = getPositiveAmount(amount);
    if (!sessionId || !providerId || amountValue === null || !hasSupportedTokenPrecision(amountValue)) {
      return spendValidationError(res, 'INVALID_RESERVATION_APPROVAL', 'walletAddress, amount (at most 2 decimal places), sessionId and providerId are required');
    }
    if (exceedsTokenOperationCap(amountValue)) {
      return tokenCapError(res, 'spend', amountValue);
    }
    const walletConfig = await getUserWalletConfig(normalizedUid);
    if (walletConfig.walletMode !== 'custodial') {
      return spendValidationError(res, 'MANAGED_WALLET_NO_APPROVAL_REQUIRED', 'Managed wallets do not require user authorization');
    }
    if (!walletAddress || walletConfig.walletAddress.toLowerCase() !== String(walletAddress).toLowerCase()) {
      return spendValidationError(res, 'WALLET_MISMATCH', 'walletAddress must be the active linked wallet');
    }
    const approvalIntent = await createReservationApprovalIntent({
      uid: normalizedUid, walletAddress, amount: amountValue, sessionId, providerId,
    });
    return res.status(200).json(approvalIntent);
  } catch (err) {
    return res.status(400).json({ status: 'error', message: toUserFacingSpendError(err) });
  }
});

/**
 * Spend endpoint using authenticated identity context
 * POST /spend/me
 *
 * Contract ID is resolved from USER_IDENTITY_HEADER (default: x-contract-id).
 */
app.post('/spend/me', validateApiKey, async (req: Request, res: Response) => {
  try {
    const contractId = getRequestContractId(req);
    if (!contractId) {
      await safeAuditLog({
        eventType: 'spend.identity_missing',
        actorType: 'api_client',
        actorId: null,
        targetType: 'endpoint',
        targetId: '/spend/me',
        status: 'error',
        metadata: {
          requiredHeader: USER_IDENTITY_HEADER,
        },
      });
      return res.status(401).json({
        status: 'error',
        message: `Missing identity header: ${USER_IDENTITY_HEADER}`,
      });
    }

    const { sessionId, providerId, amount, label, walletAddress, authorizationTxHash } = req.body;
    const normalizedUid = normalizeUid(contractId);

    if (!sessionId || typeof sessionId !== 'string') {
      await safeAuditLog({
        eventType: 'spend.validation_failed',
        actorType: 'contract_identity',
        actorId: normalizedUid || null,
        targetType: 'spend_request',
        targetId: null,
        status: 'error',
        metadata: {
          uid: normalizedUid,
          amount,
          sessionId,
          providerId,
          reason: 'missing_session_id',
        },
      });
      return spendValidationError(res, 'MISSING_SESSION_ID', 'sessionId is required');
    }

    if (!providerId || typeof providerId !== 'string') {
      await safeAuditLog({
        eventType: 'spend.validation_failed',
        actorType: 'contract_identity',
        actorId: normalizedUid || null,
        targetType: 'spend_request',
        targetId: sessionId || null,
        status: 'error',
        metadata: {
          uid: normalizedUid,
          amount,
          sessionId,
          providerId,
          reason: 'missing_provider_id',
        },
      });
      return spendValidationError(res, 'MISSING_PROVIDER_ID', 'providerId is required');
    }

    const amountValue = getPositiveAmount(amount);

    if (!normalizedUid || amountValue === null || !hasSupportedTokenPrecision(amountValue)) {
      await safeAuditLog({
        eventType: 'spend.validation_failed',
        actorType: 'contract_identity',
        actorId: normalizedUid || null,
        targetType: 'spend_request',
        targetId: sessionId || null,
        status: 'error',
        metadata: {
          uid: normalizedUid,
          amount,
          sessionId,
          providerId,
          reason: 'missing_or_invalid_amount',
        },
      });
      return spendValidationError(res, 'INVALID_AMOUNT', 'amount must be greater than 0 and use at most 2 decimal places');
    }

    if (exceedsTokenOperationCap(amountValue)) {
      return tokenCapError(res, 'spend', amountValue);
    }

    const walletConfig = await getUserWalletConfig(normalizedUid);
    const userAddress = walletConfig.walletAddress;
    const isExternalWallet = walletConfig.walletMode === 'custodial';
    if (isExternalWallet && (!walletAddress || String(walletAddress).toLowerCase() !== userAddress.toLowerCase())) {
      return spendValidationError(res, 'WALLET_MISMATCH', 'walletAddress must be the active linked wallet');
    }

    // Return the original reservation before applying current balance or
    // allowance checks. A retry is an intent lookup; a lower current balance
    // must not turn it into a new reservation or an insufficient-funds error.
    const existingReservation = await SpendReservations.findBySession(normalizedUid, sessionId, providerId);
    if (existingReservation) {
      if (existingReservation.wallet_address.toLowerCase() !== userAddress.toLowerCase()
        || Number(existingReservation.reserved_amount) !== amountValue) {
        return spendValidationError(res, 'RESERVATION_INTENT_MISMATCH', 'session reservation does not match the original wallet or amount');
      }
      const retryOnChainBalance = Number(ethers.formatEther(await getOnChainTokenBalance(userAddress)));
      const retryReservedBalance = await SpendReservations.getActiveTotal(normalizedUid, userAddress);
      return res.status(200).json({
        status: 'success',
        uid: normalizedUid,
        sessionId,
        providerId,
        reservation: {
          id: existingReservation.id,
          status: existingReservation.status,
          amount: existingReservation.reserved_amount,
          kWhEntitlement: existingReservation.reserved_amount,
          availableBalance: Math.max(0, retryOnChainBalance - retryReservedBalance),
        },
        timestamp: new Date().toISOString(),
        label,
      });
    }

    const onChainBalance = Number(ethers.formatEther(await getOnChainTokenBalance(userAddress)));
    const reservedBalance = await SpendReservations.getActiveTotal(normalizedUid, userAddress);
    const availableBalance = Math.max(0, onChainBalance - reservedBalance);

    if (amountValue > availableBalance) {
      await safeAuditLog({
        eventType: 'spend.validation_failed',
        actorType: 'contract_identity',
        actorId: normalizedUid,
        targetType: 'spend_request',
        targetId: sessionId,
        status: 'error',
        metadata: {
          uid: normalizedUid,
          amount: amountValue,
          availableBalance,
          sessionId,
          providerId,
          reason: 'insufficient_sparkz',
        },
      });
      return spendValidationError(res, 'INSUFFICIENT_SPARKZ', 'amount exceeds available SPARKZ balance', {
        availableBalance,
        requestedAmount: amountValue,
      });
    }

    let authorizationAmount: number | undefined;
    if (isExternalWallet) {
      if (!authorizationTxHash || typeof authorizationTxHash !== 'string') {
        return spendValidationError(res, 'MISSING_WALLET_AUTHORIZATION', 'External wallet approval transaction is required');
      }
      const treasuryAddress = await getTreasuryWalletAddress();
      if (!treasuryAddress) throw new Error('Treasury address is not configured');
      const activeReserved = await SpendReservations.getActiveTotal(normalizedUid, userAddress);
      const requiredAllowance = activeReserved + amountValue;
      const allowance = Number(ethers.formatEther(await getTokenAllowance(userAddress, treasuryAddress)));
      if (allowance < requiredAllowance) {
        return spendValidationError(res, 'INSUFFICIENT_WALLET_AUTHORIZATION', 'External wallet approval is not confirmed or is too small', {
          requiredAllowance, currentAllowance: allowance,
        });
      }
      authorizationAmount = allowance;
    }

    let reserved;
    try {
      const reservationInput = {
        uid: normalizedUid, walletAddress: userAddress, sessionId, providerId,
        amount: amountValue, onChainBalance,
        // The reservation service invokes this callback while holding its
        // wallet lock. Keep onChainBalance for compatibility with older
        // service implementations while making the lock-held refresh the
        // financial authority once the worker-owned service supports it.
        getOnChainBalance: async () => Number(ethers.formatEther(await getOnChainTokenBalance(userAddress))),
        authorizationTxHash: isExternalWallet ? authorizationTxHash : undefined,
        authorizationAmount,
      };
      reserved = await SpendReservations.reserve(
        reservationInput as Parameters<typeof SpendReservations.reserve>[0],
      );
    } catch (err) {
      const message = getErrorMessage(err);
      if (message.startsWith('INSUFFICIENT_SPARKZ:')) {
        const atomicAvailable = Number(message.split(':')[1] || 0);
        return spendValidationError(res, 'INSUFFICIENT_SPARKZ', 'amount exceeds available SPARKZ balance', {
          availableBalance: atomicAvailable, requestedAmount: amountValue,
        });
      }
      throw err;
    }
    await safeAuditLog({
      eventType: 'spend.reserved',
      actorType: 'contract_identity',
      actorId: normalizedUid,
      targetType: 'spend_reservation',
      targetId: reserved.reservation.id,
      status: 'success',
      metadata: {
        uid: normalizedUid,
        walletAddress: userAddress,
        amount: reserved.reservation.reserved_amount,
        sessionId,
        providerId,
        existing: reserved.existing,
      },
    });

    return res.status(200).json({
      status: 'success',
      uid: normalizedUid,
      sessionId,
      providerId,
      reservation: {
        id: reserved.reservation.id,
        status: reserved.reservation.status,
        amount: reserved.reservation.reserved_amount,
        kWhEntitlement: reserved.reservation.reserved_amount,
        availableBalance: reserved.availableBalance,
      },
      timestamp: new Date().toISOString(),
      label,
    });
  } catch (err) {
    console.error('Spend (me) error:', err);
    if (isTreasuryGasIssue(err)) {
      await auditTreasuryGasWarning('spend.identity.unhandled_error', err);
    }
    await safeAuditLog({
      eventType: 'spend.unhandled_error',
      actorType: 'contract_identity',
      actorId: null,
      targetType: 'endpoint',
      targetId: '/spend/me',
      status: 'error',
      metadata: {
        error: err instanceof Error ? err.message : String(err),
      },
    });
    res.status(500).json({
      status: 'error',
      error: toUserFacingSpendError(err),
    });
  }
});

/** BEIA polls this after reserving so it can forward the final CDR settlement to the EMP. */
app.get('/spend/reservations/:reservationId', validateApiKey, async (req: Request, res: Response) => {
  try {
    const contractId = getRequestContractId(req);
    if (!contractId) {
      return res.status(401).json({
        status: 'error',
        message: `Missing identity header: ${USER_IDENTITY_HEADER}`,
      });
    }

    const normalizedUid = normalizeUid(contractId);
    const reservationId = String(req.params.reservationId || '').trim();
    if (!UUID_PATTERN.test(reservationId)) {
      return res.status(400).json({
        status: 'error',
        code: 'INVALID_RESERVATION_ID',
        message: 'Reservation ID must be a valid UUID',
      });
    }
    const reservation = await SpendReservations.findByIdForUid(reservationId, normalizedUid);
    if (!reservation) {
      return res.status(404).json({
        status: 'error',
        message: 'Reservation not found for this contract ID',
      });
    }

    const receiptRecord = reservation.tx_hash
      ? await SpendReceipts.findByTxHash(reservation.tx_hash)
      : undefined;
    let spendReceipt: Record<string, unknown> | null = null;
    if (receiptRecord) {
      try {
        spendReceipt = {
          payload: JSON.parse(receiptRecord.canonical_payload),
          signature: receiptRecord.signature,
          signerAddress: receiptRecord.signer_address,
          canonicalPayload: receiptRecord.canonical_payload,
        };
      } catch {
        spendReceipt = null;
      }
    }

    const receiptStatus = reservation.status === 'released'
      ? 'none'
      : spendReceipt
        ? 'settled'
        : reservation.tx_hash
          ? 'pending'
          : 'not_created';

    return res.status(200).json({
      status: reservation.status,
      reservationId: reservation.id,
      sessionId: reservation.session_id,
      providerId: reservation.provider_id,
      reservedSparkz: reservation.reserved_amount,
      settledSparkz: reservation.settled_amount || null,
      releasedSparkz: reservation.released_amount || null,
      deliveredKwh: reservation.delivered_kwh || null,
      freeKwh: reservation.settled_amount || '0.00',
      txHash: reservation.tx_hash || null,
      spendReceipt,
      receiptStatus,
      updatedAt: reservation.updated_at,
    });
  } catch (err) {
    console.error('Reservation status error:', err);
    return res.status(500).json({
      status: 'error',
      error: toUserFacingSpendError(err),
    });
  }
});

/**
 * Wallet mode switch endpoint
 * POST /wallet/:uid/mode
 */
app.post('/wallet/:uid/mode', validateApiKey, async (req: Request, res: Response) => {
  try {
    const normalizedUid = normalizeUid(req.params.uid || '');
    const { mode, walletAddress, allowSplit } = req.body as {
      mode?: WalletMode;
      walletAddress?: string;
      allowSplit?: boolean;
    };

    if (!normalizedUid || !mode || !['managed', 'custodial'].includes(mode)) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing or invalid fields: uid and mode (managed or custodial) are required',
      });
    }

    const currentConfig = await getUserWalletConfig(normalizedUid);
    if (currentConfig.walletMode !== mode && !allowSplit) {
      const sourceWalletAddress = currentConfig.walletAddress;
      const sourceBalance = await getOnChainTokenBalance(sourceWalletAddress);

      if (sourceBalance > 0n) {
        const sourceBalanceHuman = ethers.formatEther(sourceBalance);
        const targetWalletAddress = mode === 'managed'
          ? currentConfig.managedWalletAddress
          : (walletAddress || 'the external wallet');

        return res.status(409).json({
          status: 'error',
          uid: normalizedUid,
          code: 'SOURCE_WALLET_HAS_BALANCE',
          message: `${sourceBalanceHuman} SPARKZ remains in the current wallet. Move those funds to the new wallet before switching, or continue anyway to keep balances in both wallets.`,
          sourceWalletAddress,
          sourceBalance: sourceBalanceHuman,
          targetWalletAddress,
        });
      }
    }

    const result = await setUserWalletMode(normalizedUid, mode, walletAddress);
    await safeAuditLog({
      eventType: 'wallet.mode_changed',
      actorType: 'api_client',
      actorId: normalizedUid,
      targetType: 'wallet',
      targetId: result.walletAddress,
      status: 'success',
      metadata: {
        uid: normalizedUid,
        mode,
        managedWalletAddress: result.managedWalletAddress,
        allowSplit: Boolean(allowSplit),
      },
    });

    // When switching to custodial, revoke the treasury's on-chain allowance on the
    // derived managed wallet so it cannot call transferFrom even if the API is bypassed.
    if (mode === 'custodial' && TREASURY_ADDRESS) {
      (async () => {
        try {
          await revokeAllowanceOnManagedWallet(normalizedUid, treasurySigner, TREASURY_ADDRESS);
        } catch (revokeErr) {
          console.error(`⚠️  Failed to revoke managed wallet allowance for user ${normalizedUid}:`, revokeErr instanceof Error ? revokeErr.message : String(revokeErr));
        }
      })();
    }

    return res.status(200).json({
      status: 'success',
      ...result,
      treasuryAddress: TREASURY_ADDRESS || null,
      tokenContractAddress: TOKEN_CONTRACT_ADDRESS,
    });
  } catch (err) {
    res.status(400).json({
      status: 'error',
      message: toUserFacingWalletError(err),
    });
  }
});

/**
 * Wallet profile endpoint
 * PATCH /wallet/:uid/profile
 *
 * Saves a user-facing wallet name against the active blockchain address.
 */
app.patch('/wallet/:uid/profile', validateApiKey, async (req: Request, res: Response) => {
  try {
    const normalizedUid = normalizeUid(req.params.uid || '');
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      return res.status(400).json({
        status: 'error',
        code: 'INVALID_WALLET_PROFILE',
        message: 'Body must be an object with an optional walletName string',
      });
    }
    const { walletName, walletAddress } = req.body as { walletName?: string | null; walletAddress?: string };

    if (!normalizedUid) {
      return res.status(400).json({ status: 'error', message: 'Missing wallet ID' });
    }
    if (walletName !== undefined && walletName !== null && typeof walletName !== 'string') {
      return res.status(400).json({
        status: 'error',
        code: 'INVALID_WALLET_PROFILE',
        message: 'walletName must be a string or null',
      });
    }

    const activeWalletAddress = walletAddress && ethers.isAddress(walletAddress)
      ? ethers.getAddress(walletAddress)
      : (await getUserWalletConfig(normalizedUid)).walletAddress;

    await Users.linkContractId(normalizedUid, activeWalletAddress, walletName?.trim() || null);
    await Users.updateWalletNameByAddress(activeWalletAddress, walletName?.trim() || null);
    const payload = await getWalletPayload(normalizedUid, activeWalletAddress);
    return res.status(200).json({
      ...payload,
      message: 'Wallet name updated',
    });
  } catch (err) {
    res.status(400).json({
      status: 'error',
      message: toUserFacingWalletError(err),
    });
  }
});

/**
 * Link another contract/wallet ID to the same active blockchain address.
 * POST /wallet/:uid/contract-ids
 */
app.post('/wallet/:uid/contract-ids', validateApiKey, async (req: Request, res: Response) => {
  try {
    const normalizedUid = normalizeUid(req.params.uid || '');
    const nextContractId = normalizeUid(String(req.body?.contractId || req.body?.uid || ''));
    const requestWalletAddress = String(req.body?.walletAddress || '');

    if (!normalizedUid || !nextContractId) {
      return res.status(400).json({ status: 'error', message: 'Missing wallet ID or contract ID' });
    }

    const walletConfig = await getUserWalletConfig(normalizedUid);
    const activeWalletAddress = requestWalletAddress && ethers.isAddress(requestWalletAddress)
      ? ethers.getAddress(requestWalletAddress)
      : walletConfig.walletAddress;
    const existingLinkedUsers = await Users.findAllByWallet(activeWalletAddress);
    const walletName = existingLinkedUsers.find(u => u.wallet_name)?.wallet_name || null;

    await Users.linkContractId(nextContractId, activeWalletAddress, walletName);
    if (walletName) {
      await Users.updateWalletNameByAddress(activeWalletAddress, walletName);
    }

    const payload = await getWalletPayload(normalizedUid, activeWalletAddress);
    return res.status(200).json({
      ...payload,
      message: 'Contract ID linked to wallet',
    });
  } catch (err) {
    res.status(400).json({
      status: 'error',
      message: toUserFacingWalletError(err),
    });
  }
});

/**
 * Link a blockchain wallet address to the current EMP contract.
 * POST /wallet/:uid/linked-wallets
 */
app.post('/wallet/:uid/linked-wallets', validateApiKey, async (req: Request, res: Response) => {
  try {
    const normalizedUid = normalizeUid(req.params.uid || '');
    const walletAddress = String(req.body?.walletAddress || '');
    const signature = String(req.body?.signature || '');

    if (!normalizedUid) {
      return res.status(400).json({ status: 'error', message: 'Missing EMP contract number' });
    }

    if (!walletAddress || !ethers.isAddress(walletAddress)) {
      return res.status(400).json({ status: 'error', message: 'Missing or invalid wallet address' });
    }

    const checksumWalletAddress = ethers.getAddress(walletAddress);
    verifyLinkedWalletSignature(normalizedUid, checksumWalletAddress, 'link', signature);

    await Users.linkLinkedWallet(normalizedUid, checksumWalletAddress);

    const payload = await getWalletPayload(normalizedUid, checksumWalletAddress);
    return res.status(200).json({
      ...payload,
      message: 'Wallet address linked',
    });
  } catch (err) {
    res.status(400).json({
      status: 'error',
      message: toUserFacingWalletError(err),
    });
  }
});

/**
 * Name a linked blockchain wallet address.
 * PATCH /wallet/:uid/linked-wallets/:walletAddress/profile
 */
app.patch('/wallet/:uid/linked-wallets/:walletAddress/profile', validateApiKey, async (req: Request, res: Response) => {
  try {
    const normalizedUid = normalizeUid(req.params.uid || '');
    const walletAddress = String(req.params.walletAddress || '');
    const walletName = typeof req.body?.walletName === 'string' && req.body.walletName.trim()
      ? req.body.walletName.trim().slice(0, 120)
      : null;

    if (!normalizedUid) {
      return res.status(400).json({ status: 'error', message: 'Missing EMP contract number' });
    }

    if (!walletAddress || !ethers.isAddress(walletAddress)) {
      return res.status(400).json({ status: 'error', message: 'Missing or invalid wallet address' });
    }

    const checksumWalletAddress = ethers.getAddress(walletAddress);
    const updated = await LinkedWallets.updateName(normalizedUid, checksumWalletAddress, walletName);
    if (!updated) {
      return res.status(404).json({ status: 'error', message: 'Wallet address is not linked to this EMP contract' });
    }
    await Users.linkContractId(normalizedUid, checksumWalletAddress, walletName);
    await Users.updateWalletNameByAddress(checksumWalletAddress, walletName);

    const payload = await getWalletPayload(normalizedUid, checksumWalletAddress);
    return res.status(200).json({
      ...payload,
      message: walletName ? 'Linked wallet name saved' : 'Linked wallet name cleared',
    });
  } catch (err) {
    res.status(400).json({
      status: 'error',
      message: toUserFacingWalletError(err),
    });
  }
});

/**
 * Remove a linked blockchain wallet address from the current EMP contract.
 * DELETE /wallet/:uid/linked-wallets/:walletAddress
 */
app.delete('/wallet/:uid/linked-wallets/:walletAddress', validateApiKey, async (req: Request, res: Response) => {
  try {
    const normalizedUid = normalizeUid(req.params.uid || '');
    const walletAddress = String(req.params.walletAddress || '');
    const signature = String(req.body?.signature || '');

    if (!normalizedUid) {
      return res.status(400).json({ status: 'error', message: 'Missing EMP contract number' });
    }

    if (!walletAddress || !ethers.isAddress(walletAddress)) {
      return res.status(400).json({ status: 'error', message: 'Missing or invalid wallet address' });
    }

    const checksumWalletAddress = ethers.getAddress(walletAddress);
    verifyLinkedWalletSignature(normalizedUid, checksumWalletAddress, 'unlink', signature);

    await Users.unlinkLinkedWallet(normalizedUid, checksumWalletAddress);

    const payload = await getWalletPayload(normalizedUid);
    return res.status(200).json({
      ...payload,
      message: 'Wallet address unlinked',
    });
  } catch (err) {
    res.status(400).json({
      status: 'error',
      message: toUserFacingWalletError(err),
    });
  }
});

/**
 * Move all tokens from the user's managed wallet to a target address.
 * The treasury uses its existing MaxUint256 allowance to execute transferFrom.
 * POST /wallet/:uid/move-funds
 */
app.post('/wallet/:uid/move-funds', validateApiKey, async (req: Request, res: Response) => {
  try {
    const normalizedUid = normalizeUid(req.params.uid || '');
    const { targetAddress } = req.body as { targetAddress?: string };

    if (!normalizedUid) {
      return res.status(400).json({ status: 'error', message: 'Missing uid' });
    }
    if (!targetAddress || !ethers.isAddress(targetAddress)) {
      return res.status(400).json({ status: 'error', message: 'Missing or invalid targetAddress' });
    }

    const { txHash, amount } = await moveFundsFromManagedWallet(
      normalizedUid,
      targetAddress,
      treasurySigner,
      TOKEN_CONTRACT_ADDRESS
    );

    return res.status(200).json({ status: 'success', txHash, amount, targetAddress });
  } catch (err) {
    res.status(400).json({
      status: 'error',
      message: toUserFacingWalletError(err),
    });
  }
});

/**
 * Build a custodial spend transaction for a user-managed wallet to sign.
 * POST /spend/custodial-intent
 */
app.post('/spend/custodial-intent', validateApiKey, async (req: Request, res: Response) => {
  const { uid, walletAddress, amount, sessionId, providerId } = req.body;
  const normalizedUid = normalizeUid(String(uid || ''));

  try {
    const numericAmount = Number(amount);
    const checksumWalletAddress = await validateCustodialSpendIntentInput({
      uid: normalizedUid,
      walletAddress,
      amount: numericAmount,
    });
    const spendIntent = await createCustodialSpendIntent({
      uid: normalizedUid,
      walletAddress: checksumWalletAddress,
      amount: numericAmount,
      sessionId,
      providerId,
    });

    await safeAuditLog({
      eventType: 'spend.custodial_intent_created',
      actorType: 'api_client',
      actorId: normalizedUid,
      targetType: 'wallet',
      targetId: checksumWalletAddress,
      status: 'requires_signature',
      metadata: {
        uid: normalizedUid,
        amount: numericAmount,
        sessionId,
        providerId,
        intentId: spendIntent.intentId,
      },
    });

    return res.status(200).json({
      status: 'requires_signature',
      uid: normalizedUid,
      message: 'Confirm this SPARKZ spend in your wallet.',
      spendIntent,
    });
  } catch (err) {
    await safeAuditLog({
      eventType: 'spend.custodial_intent_failed',
      actorType: 'api_client',
      actorId: normalizedUid || null,
      targetType: 'wallet',
      targetId: typeof walletAddress === 'string' ? walletAddress : null,
      status: 'error',
      metadata: {
        uid: normalizedUid,
        walletAddress,
        amount,
        sessionId,
        providerId,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return res.status(400).json({
      status: 'error',
      message: toUserFacingCustodialError(err),
    });
  }
});

/**
 * Record a custodial spend signing/submission outcome that the caller could
 * not confirm. A reported failure does not prove that no transaction exists;
 * callers must check/recover any existing hash before signing another spend.
 * POST /spend/custodial-failure
 */
app.post('/spend/custodial-failure', validateApiKey, async (req: Request, res: Response) => {
  const { uid, walletAddress, amount, sessionId, providerId, intentId, reason } = req.body;
  const normalizedUid = normalizeUid(String(uid || ''));

  try {
    const numericAmount = Number(amount);
    const checksumWalletAddress = await validateCustodialSpendIntentInput({
      uid: normalizedUid,
      walletAddress,
      amount: numericAmount,
    });
    const spendIntent = await createCustodialSpendIntent({
      uid: normalizedUid,
      walletAddress: checksumWalletAddress,
      amount: numericAmount,
      sessionId,
      providerId,
    });

    await safeAuditLog({
      eventType: 'spend.custodial_failed',
      actorType: 'api_client',
      actorId: normalizedUid,
      targetType: 'custodial_spend_intent',
      targetId: intentId || spendIntent.intentId,
      status: 'retry_required',
      metadata: {
        uid: normalizedUid,
        walletAddress: checksumWalletAddress,
        amount: numericAmount,
        sessionId,
        providerId,
        intentId: spendIntent.intentId,
        reason: typeof reason === 'string' ? reason.slice(0, 500) : null,
      },
    });

    return res.status(200).json({
      status: 'retry_required',
      uid: normalizedUid,
      message: 'The wallet spend outcome is not final. Check or recover any existing transaction hash before signing another spend.',
      spendIntent,
    });
  } catch (err) {
    await safeAuditLog({
      eventType: 'spend.custodial_failure_report_failed',
      actorType: 'api_client',
      actorId: normalizedUid || null,
      targetType: 'custodial_spend_intent',
      targetId: intentId || null,
      status: 'error',
      metadata: {
        uid: normalizedUid,
        walletAddress,
        amount,
        sessionId,
        providerId,
        reason,
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return res.status(400).json({
      status: 'error',
      message: toUserFacingCustodialError(err),
    });
  }
});

/**
 * Record a custodial spend after the user confirms it in their own wallet.
 * POST /spend/custodial-record
 */
app.post('/spend/custodial-record', validateApiKey, async (req: Request, res: Response) => {
  try {
    const { uid, walletAddress, amount, txHash, sessionId, providerId } = req.body;
    const normalizedUid = normalizeUid(String(uid || ''));
    const amountValue = getPositiveAmount(amount);
    const canonicalAmount = canonicalTokenAmount(amount);
    const canonicalHash = canonicalTxHash(txHash);

    if (!normalizedUid || !walletAddress || !canonicalHash || amountValue === null || !canonicalAmount) {
      await safeAuditLog({
        eventType: 'spend.custodial_validation_failed',
        actorType: 'api_client',
        actorId: normalizedUid || null,
        targetType: 'token_tx',
        targetId: txHash || null,
        status: 'error',
        metadata: {
          uid: normalizedUid,
          walletAddress,
          amount,
          sessionId,
          providerId,
          reason: 'missing_or_invalid_required_fields',
        },
      });
      return res.status(400).json({
        status: 'error',
        code: 'INVALID_CUSTODIAL_SPEND',
        message: 'Missing or invalid fields: uid, walletAddress, txHash, amount (must be > 0 and use at most 2 decimal places)',
      });
    }

    if (!ethers.isAddress(walletAddress)) {
      await safeAuditLog({
        eventType: 'spend.custodial_validation_failed',
        actorType: 'api_client',
        actorId: normalizedUid,
        targetType: 'wallet',
        targetId: walletAddress,
        status: 'error',
        metadata: {
          uid: normalizedUid,
          reason: 'invalid_wallet_address',
        },
      });
      return res.status(400).json({
        status: 'error',
        message: 'Invalid wallet address',
      });
    }

    const checksumWalletAddress = ethers.getAddress(walletAddress);
    const linkedWalletAddresses = (await LinkedWallets.findByUid(normalizedUid)).map(w => w.wallet_address.toLowerCase());
    if (!linkedWalletAddresses.includes(checksumWalletAddress.toLowerCase())) {
      await safeAuditLog({
        eventType: 'spend.custodial_validation_failed',
        actorType: 'api_client',
        actorId: normalizedUid,
        targetType: 'wallet',
        targetId: checksumWalletAddress,
        status: 'error',
        metadata: {
          uid: normalizedUid,
          txHash,
          reason: 'wallet_not_linked',
        },
      });
      return res.status(400).json({
        status: 'error',
        message: 'Wallet address is not linked to this EMP contract',
      });
    }

    let chainId: bigint;
    try {
      chainId = await getAuthoritativeChainId();
    } catch (err) {
      return res.status(503).json({
        status: 'error',
        code: (err as Error & { code?: string }).code || 'CHAIN_CONTEXT_UNAVAILABLE',
        retryable: false,
        requiresReview: true,
        message: 'The configured chain could not be verified. Operator review is required before recording this spend.',
      });
    }

    const treasuryAddress = await getTreasuryWalletAddress();
    if (!treasuryAddress) {
      return res.status(503).json({
        status: 'error',
        code: 'TREASURY_ADDRESS_UNAVAILABLE',
        retryable: false,
        requiresReview: true,
        message: 'Configured treasury recipient is unavailable',
      });
    }
    let tokenContractAddress: string;
    try {
      tokenContractAddress = ethers.getAddress(TOKEN_CONTRACT_ADDRESS);
    } catch {
      return res.status(503).json({
        status: 'error',
        code: 'TOKEN_CONTRACT_INVALID',
        retryable: false,
        requiresReview: true,
        message: 'Configured token contract address is invalid',
      });
    }

    const evidence = await verifySpendEvidence({
      provider: treasurySigner.provider!,
      tokenContractAddress,
      chainId,
      sourceWallet: checksumWalletAddress,
      treasuryRecipient: treasuryAddress,
      amountUnits: ethers.parseUnits(canonicalAmount.decimal, 18),
      txHash: canonicalHash!,
    });
    if (!evidence.valid) {
      const failure: SpendEvidenceFailure = evidence.failure;
      const pending = failure.pending || failure.code === 'PROVIDER_ERROR';
      const statusCode = failure.pending ? 202 : failure.code === 'PROVIDER_ERROR' ? 503 : 400;
      return res.status(statusCode).json({
        status: failure.pending ? 'pending' : 'error',
        code: 'SPEND_EVIDENCE_INVALID',
        proofFailure: failure.code,
        uid: normalizedUid,
        txHash: canonicalHash,
        pending,
        retryable: pending,
        requiresReview: false,
        financialStatus: 'unconfirmed',
        receiptStatus: 'not_created',
        error: toUserFacingSpendEvidenceFailure(failure),
      });
    }

    let existingSpend;
    let existingReceipt;
    try {
      existingSpend = await Spends.findByTxHash(canonicalHash)
        || (txHash !== canonicalHash ? await Spends.findByTxHash(txHash) : undefined);
      existingReceipt = await SpendReceipts.findByTxHash(canonicalHash)
        || (txHash !== canonicalHash ? await SpendReceipts.findByTxHash(txHash) : undefined);
    } catch (err) {
      // Chain evidence is already confirmed, but recovery cannot decide
      // whether the projection/receipt exists. Preserve the exact hash and
      // let the caller retry instead of returning a false success or creating
      // a duplicate projection.
      return res.status(202).json({
        status: 'pending',
        code: 'CUSTODIAL_RECOVERY_LOOKUP_PENDING',
        uid: normalizedUid,
        txHash: canonicalHash,
        financialStatus: 'confirmed',
        projectionStatus: 'pending',
        receiptStatus: 'pending',
        pending: true,
        retryable: true,
        requiresReview: false,
        error: 'The confirmed custodial transfer could not be checked for an existing projection. Retry the same request shortly.',
      });
    }

    if (existingSpend) {
      const existingAmount = canonicalTokenAmount(existingSpend.amount);
      const existingSessionId = normaliseOptionalContext(existingSpend.session_id);
      if (!existingAmount
        || existingAmount.units !== canonicalAmount.units
        || existingSpend.wallet_address.toLowerCase() !== checksumWalletAddress.toLowerCase()
        || existingSessionId !== normaliseOptionalContext(sessionId)) {
        return res.status(409).json({
          status: 'error',
          code: 'CUSTODIAL_TX_HASH_INTENT_MISMATCH',
          txHash: canonicalHash,
          requiresReview: true,
          retryable: false,
          message: 'Transaction hash is already bound to a different custodial spend intent',
        });
      }
      if (!existingSpend.user_id) {
        return res.status(409).json({
          status: 'error',
          code: 'CUSTODIAL_HISTORIC_CONTEXT_INCOMPLETE',
          txHash: canonicalHash,
          requiresReview: true,
          retryable: false,
          receiptStatus: existingReceipt ? 'settled' : 'missing',
          message: 'The historical custodial spend has no explicit owner context; operator review is required',
        });
      }
      let existingSpendOwner;
      try {
        existingSpendOwner = await Users.findByUidAndWallet(normalizedUid, checksumWalletAddress);
      } catch (err) {
        return res.status(202).json({
          status: 'pending',
          code: 'CUSTODIAL_OWNER_LOOKUP_PENDING',
          uid: normalizedUid,
          txHash: canonicalHash,
          financialStatus: 'confirmed',
          projectionStatus: 'pending',
          receiptStatus: existingReceipt ? 'settled' : 'missing',
          pending: true,
          retryable: true,
          requiresReview: false,
          error: 'The existing custodial spend owner could not be checked. Retry the same request shortly.',
        });
      }
      if (!existingSpendOwner || existingSpendOwner.id !== existingSpend.user_id) {
        return res.status(409).json({
          status: 'error',
          code: 'CUSTODIAL_TX_HASH_INTENT_MISMATCH',
          txHash: canonicalHash,
          requiresReview: true,
          retryable: false,
          receiptStatus: existingReceipt ? 'settled' : 'missing',
          message: 'Transaction hash is already projected for a different eMAID owner',
        });
      }
      if (!existingReceipt) {
        return res.status(409).json({
          status: 'error',
          code: 'CUSTODIAL_HISTORIC_CONTEXT_INCOMPLETE',
          txHash: canonicalHash,
          requiresReview: true,
          retryable: false,
          receiptStatus: 'missing',
          message: 'A historical custodial spend exists without a receipt; operator review is required',
        });
      }
      try {
        const spendReceipt = await createAndStoreSpendReceipt({
          uid: normalizedUid,
          walletAddress: checksumWalletAddress,
          amount: amountValue!,
          sessionId,
          providerId,
          txHash: canonicalHash,
        });
        return res.status(200).json({
          status: 'success',
          duplicate: true,
          uid: normalizedUid,
          txHash: canonicalHash,
          message: 'Custodial spend already recorded',
          spendReceipt,
        });
      } catch (err) {
        const recovery = err as Error & { receiptConflict?: boolean; requiresReview?: boolean; receiptPending?: boolean };
        if (recovery.receiptConflict || recovery.requiresReview) {
          return res.status(409).json({
            status: 'error',
            code: 'CUSTODIAL_RECEIPT_CONTEXT_MISMATCH',
            txHash: canonicalHash,
            requiresReview: true,
            retryable: false,
            receiptStatus: 'invalid',
            message: toUserFacingReceiptError(err),
          });
        }
        if (recovery.receiptPending) {
          return res.status(202).json({
            status: 'pending',
            uid: normalizedUid,
            txHash: canonicalHash,
            financialStatus: 'confirmed',
            receiptStatus: 'pending',
            pending: true,
            retryable: true,
            requiresReview: false,
            error: 'The custodial spend is confirmed but its receipt is pending persistence.',
          });
        }
        throw err;
      }
    }

    if (existingReceipt) {
      // A validated receipt is the immutable recovery context for a transfer
      // whose projection write failed. Re-check it against the current
      // request and chain evidence, then perform the idempotent projection.
      let spendReceipt: SignedSpendReceipt & { dbStored: boolean; dbError?: string };
      try {
        spendReceipt = await createAndStoreSpendReceipt({
          uid: normalizedUid,
          walletAddress: checksumWalletAddress,
          amount: amountValue!,
          sessionId,
          providerId,
          txHash: canonicalHash,
        });
      } catch (err) {
        const recovery = err as Error & { receiptConflict?: boolean; requiresReview?: boolean; receiptPending?: boolean };
        if (recovery.receiptConflict || recovery.requiresReview) {
          return res.status(409).json({
            status: 'error',
            code: 'CUSTODIAL_RECEIPT_CONTEXT_MISMATCH',
            txHash: canonicalHash,
            requiresReview: true,
            retryable: false,
            receiptStatus: 'invalid',
            message: toUserFacingReceiptError(err),
          });
        }
        if (recovery.receiptPending) {
          return res.status(202).json({
            status: 'pending',
            uid: normalizedUid,
            txHash: canonicalHash,
            financialStatus: 'confirmed',
            receiptStatus: 'pending',
            pending: true,
            retryable: true,
            requiresReview: false,
            error: 'The custodial spend receipt is pending validation or persistence.',
          });
        }
        throw err;
      }

      try {
        await recordSpend(checksumWalletAddress, amountValue!, canonicalHash, sessionId, normalizedUid);
      } catch (err) {
        const message = getErrorMessage(err);
        if (isCustodialProjectionIntentMismatch(err)) {
          return res.status(409).json({
            status: 'error',
            code: 'CUSTODIAL_TX_HASH_INTENT_MISMATCH',
            txHash: canonicalHash,
            requiresReview: true,
            retryable: false,
            receiptStatus: 'settled',
            message,
          });
        }
        return res.status(202).json({
          status: 'pending',
          uid: normalizedUid,
          txHash: canonicalHash,
          financialStatus: 'confirmed',
          projectionStatus: 'pending',
          receiptStatus: 'settled',
          pending: true,
          retryable: true,
          requiresReview: false,
          spendReceipt,
          error: 'The custodial transfer receipt is valid but its database projection is pending. Retry the exact request.',
        });
      }

      return res.status(200).json({
        status: 'success',
        duplicate: true,
        recoveredProjection: true,
        uid: normalizedUid,
        txHash: canonicalHash,
        message: 'Custodial spend projection recovered from its validated receipt',
        spendReceipt,
      });
    }

    // Persist the signed receipt before the spend projection. If projection
    // fails, the receipt carries the immutable context needed for an exact
    // retry; no second chain transfer is possible or necessary.
    let spendReceipt: SignedSpendReceipt & { dbStored: boolean; dbError?: string };
    try {
      spendReceipt = await createAndStoreSpendReceipt({
        uid: normalizedUid,
        walletAddress: checksumWalletAddress,
        amount: amountValue!,
        sessionId,
        providerId,
        txHash: canonicalHash,
      });
    } catch (err) {
      const recovery = err as Error & { receiptConflict?: boolean; requiresReview?: boolean; receiptPending?: boolean };
      if (recovery.receiptConflict || recovery.requiresReview) {
        return res.status(409).json({
          status: 'error',
          code: 'CUSTODIAL_RECEIPT_CONTEXT_MISMATCH',
          txHash: canonicalHash,
          requiresReview: true,
          retryable: false,
          receiptStatus: 'invalid',
          message: toUserFacingReceiptError(err),
        });
      }
      if (!recovery.receiptPending) throw err;
      return res.status(202).json({
        status: 'pending',
        uid: normalizedUid,
        txHash: canonicalHash,
        financialStatus: 'confirmed',
        receiptStatus: 'pending',
        pending: true,
        retryable: true,
        requiresReview: false,
        error: 'The custodial transfer receipt is pending persistence. Retry the exact request.',
      });
    }

    try {
      await recordSpend(checksumWalletAddress, amountValue!, canonicalHash, sessionId, normalizedUid);
    } catch (err) {
      const message = getErrorMessage(err);
      if (isCustodialProjectionIntentMismatch(err)) {
        return res.status(409).json({
          status: 'error',
          code: 'CUSTODIAL_TX_HASH_INTENT_MISMATCH',
          txHash: canonicalHash,
          requiresReview: true,
          retryable: false,
          receiptStatus: 'settled',
          message,
        });
      }
      return res.status(202).json({
        status: 'pending',
        uid: normalizedUid,
        txHash: canonicalHash,
        financialStatus: 'confirmed',
        projectionStatus: 'pending',
        receiptStatus: 'settled',
        pending: true,
        retryable: true,
        requiresReview: false,
        spendReceipt,
        error: 'The custodial transfer receipt is valid but its database projection is pending. Retry the exact request.',
      });
    }
    await safeAuditLog({
      eventType: 'spend.custodial_recorded',
      actorType: 'api_client',
      actorId: normalizedUid,
      targetType: 'token_tx',
      targetId: canonicalHash,
      status: 'success',
      metadata: {
        uid: normalizedUid,
        walletAddress: checksumWalletAddress,
        amount: amountValue,
        sessionId,
        providerId,
        receiptId: spendReceipt.payload.receiptId,
      },
    });

    return res.status(200).json({
      status: 'success',
      uid: normalizedUid,
      txHash: canonicalHash,
      message: 'Custodial spend recorded',
      spendReceipt,
    });
  } catch (err) {
    console.error('Custodial spend record error:', err);
    const recovery = err as Error & { receiptPending?: boolean; txHash?: string; requiresReview?: boolean };
    await safeAuditLog({
      eventType: 'spend.custodial_unhandled_error',
      actorType: 'api_client',
      actorId: null,
      targetType: 'endpoint',
      targetId: '/spend/custodial-record',
      status: 'error',
      metadata: {
        error: err instanceof Error ? err.message : String(err),
      },
    });
    if (recovery.requiresReview) {
      return res.status(409).json({
        status: 'error',
        code: 'CUSTODIAL_REVIEW_REQUIRED',
        txHash: recovery.txHash || canonicalTxHash(req.body.txHash) || null,
        requiresReview: true,
        retryable: false,
        error: toUserFacingReceiptError(err),
      });
    }
    if (recovery.receiptPending || recovery.txHash) {
      return res.status(202).json({
        status: 'pending',
        uid: normalizeUid(String(req.body.uid || '')),
        txHash: recovery.txHash || canonicalTxHash(req.body.txHash) || null,
        financialStatus: 'confirmed',
        receiptStatus: 'pending',
        pending: true,
        retryable: true,
        requiresReview: false,
        error: 'The custodial spend is recorded or confirmed but its receipt is pending persistence.',
      });
    }
    return res.status(500).json({
      status: 'error',
      code: 'CUSTODIAL_SPEND_UNAVAILABLE',
      message: 'The custodial spend could not be completed. Please retry the same request shortly.',
    });
  }
});

/**
 * Wallet query endpoint for authenticated user context
 * GET /wallet/me
 */
app.get('/wallet/me', validateApiKey, async (req: Request, res: Response) => {
  try {
    const contractId = getRequestContractId(req);
    if (!contractId) {
      return res.status(401).json({
        status: 'error',
        message: `Missing identity header: ${USER_IDENTITY_HEADER}`,
      });
    }

    const walletAddress = typeof req.query.walletAddress === 'string' ? req.query.walletAddress : '';
    const payload = await getWalletPayload(contractId, walletAddress);
    return res.status(200).json(payload);
  } catch (err) {
    console.error('Wallet query (me) error:', err);
    res.status(500).json({
      status: 'error',
      code: 'WALLET_QUERY_UNAVAILABLE',
      message: 'The wallet could not be loaded right now. Please retry shortly.',
    });
  }
});

/**
 * Wallet query endpoint
 * GET /wallet/:uid
 *
 * Returns wallet balance and recent transaction history.
 * For unknown UIDs, returns a zero-balance wallet view so the UI can load cleanly.
 */
app.get('/wallet/:uid', validateApiKey, ensureTestUidLookupEnabled, async (req: Request, res: Response) => {
  try {
    const normalizedUid = normalizeUid(req.params.uid || '');
    const walletAddress = typeof req.query.walletAddress === 'string' ? req.query.walletAddress : '';
    const payload = await getWalletPayload(normalizedUid, walletAddress);
    return res.status(200).json(payload);
  } catch (err) {
    console.error('Wallet query error:', err);
    res.status(500).json({
      status: 'error',
      code: 'WALLET_QUERY_UNAVAILABLE',
      message: 'The wallet could not be loaded right now. Please retry shortly.',
    });
  }
});

/**
 * Get recent transactions (all users)
 * GET /transactions?limit=10
 * Requires X-API-Key header for authentication
 */
app.get('/transactions', validateApiKey, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
    const awards = (await Awards.getAll()).slice(0, limit);
    const spends = (await Spends.getAll()).slice(0, limit);
    const usersById = new Map((await Users.getAll()).map(user => [user.id, user]));

    const transactions = [
      ...awards.map(a => {
        const user = usersById.get(a.user_id);
        return {
        type: 'award' as const,
        uid: user?.uid || null,
        walletAddress: user?.wallet_address || null,
        walletName: user?.wallet_name || null,
        amount: a.amount,
        txHash: a.tx_hash,
        timestamp: a.awarded_at,
        status: a.status || 'confirmed',
        };
      }),
      ...spends.map(s => {
        const user = usersById.get(s.user_id);
        return {
        type: 'spend' as const,
        uid: user?.uid || null,
        walletAddress: s.wallet_address || user?.wallet_address || null,
        walletName: user?.wallet_name || null,
        amount: s.amount,
        txHash: s.tx_hash,
        sessionId: s.session_id || null,
        timestamp: s.created_at,
        status: s.status || 'confirmed',
        };
      }),
    ]
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
      .slice(0, limit);

    res.json({
      status: 'ok',
      transactionCount: transactions.length,
      transactions,
    });
  } catch (err) {
    console.error('Transactions query error:', err);
    res.status(500).json({
      status: 'error',
      code: 'TRANSACTIONS_UNAVAILABLE',
      message: 'Transactions could not be loaded right now. Please retry shortly.',
    });
  }
});

/**
 * Admin session authentication middleware
 */
function validateAdmin(req: Request, res: Response, next: NextFunction): void {
  const auth = req.header('Authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  const adminIdentity = token ? adminSessions.get(token) : undefined;
  if (!token || !adminIdentity) {
    res.status(401).json({ status: 'error', message: 'Admin authentication required' });
    return;
  }
  (req as Request & { adminIdentity?: string }).adminIdentity = adminIdentity;
  next();
}

function adminRecoveryCode(error: unknown): string {
  const text = getErrorMessage(error);
  const knownCodes = [
    'CHAIN_HASH_REQUIRED',
    'SPEND_RECEIPT_RECOVERY_REQUIRED',
    'ALREADY_PROJECTED',
    'FAILED_OPERATION_REVIEW_REQUIRED',
    'AWARD_CDR_SNAPSHOT_REQUIRED',
    'MOVEMENT_REVIEW_REQUIRED',
    'AWARD_RECOVERY_CHAIN_HASH_REQUIRED',
    'AWARD_RECOVERY_CHAIN_READ_UNAVAILABLE',
    'AWARD_RECOVERY_EVIDENCE_BLOCKED',
    'AWARD_RECOVERY_ASSET_CONTEXT_MISMATCH',
    'SPEND_RECOVERY_CHAIN_HASH_REQUIRED',
    'SPEND_RECOVERY_CHAIN_READ_UNAVAILABLE',
    'SPEND_RECOVERY_EVIDENCE_BLOCKED',
    'SPEND_RECOVERY_ASSET_CONTEXT_MISMATCH',
    'SPEND_RECOVERY_ASSET_CONTEXT_UNAVAILABLE',
    'SPEND_RECOVERY_CONFIRMATION_STATE_UNAVAILABLE',
    'SPEND_RECOVERY_LOOKUP_UNAVAILABLE',
    'SPEND_RECOVERY_INTENT_INVALID',
    'SPEND_RECEIPT_RECOVERY_PENDING',
    'SPEND_RECEIPT_RECOVERY_BLOCKED',
    'TOKEN_OPERATION_RECOVERY_SNAPSHOT_INVALID',
    'TOKEN_OPERATION_NOT_FOUND',
    'TOKEN_OPERATION_INTENT_MISMATCH',
    'RESERVATION_RECOVERY_BLOCKED',
  ];
  return knownCodes.find(code => text.includes(code)) || 'RECOVERY_REVIEW_REQUIRED';
}

function adminRecoveryMessage(code: string, pending: boolean, requiresReview: boolean): string {
  if (code === 'CHAIN_HASH_REQUIRED'
    || code === 'AWARD_RECOVERY_CHAIN_HASH_REQUIRED'
    || code === 'SPEND_RECOVERY_CHAIN_HASH_REQUIRED') {
    return 'Recovery is blocked because the saved operation has no canonical transaction hash; no replacement transfer was submitted.';
  }
  if (code === 'AWARD_CDR_SNAPSHOT_REQUIRED') {
    return 'Recovery is blocked because the original award CDR recovery snapshot is unavailable; no replacement award was submitted.';
  }
  if (code === 'ALREADY_PROJECTED') {
    return 'The operation is already projected; retry the same key only to complete its existing receipt state.';
  }
  if (code === 'TOKEN_OPERATION_RECOVERY_SNAPSHOT_INVALID') {
    return 'Recovery is blocked because the saved award context is missing or does not match its durable fingerprint; no replacement award was submitted.';
  }
  if (code === 'SPEND_RECOVERY_ASSET_CONTEXT_MISMATCH') {
    return 'Recovery is blocked because the saved spend asset context differs from the current configured token context; no replacement transfer was submitted.';
  }
  if (code === 'AWARD_RECOVERY_ASSET_CONTEXT_MISMATCH') {
    return 'Recovery is blocked because the saved award asset context differs from the current configured token context; no replacement transfer was submitted.';
  }
  if (code === 'SPEND_RECOVERY_EVIDENCE_BLOCKED' || code === 'AWARD_RECOVERY_EVIDENCE_BLOCKED') {
    return 'Recovery is blocked because the saved transaction evidence does not prove the original owner, asset, recipient, and amount; no replacement transfer was submitted.';
  }
  if (code === 'SPEND_RECEIPT_RECOVERY_PENDING') {
    return 'The spend projection is complete, but its signed receipt is not stored yet. Retry the same operation key; no replacement transfer will be submitted.';
  }
  if (code === 'SPEND_RECEIPT_RECOVERY_BLOCKED') {
    return 'The spend projection is complete, but its signed receipt could not be safely completed; operator review is required and no replacement transfer was submitted.';
  }
  if (code === 'RESERVATION_RECOVERY_BLOCKED') {
    return 'Reservation recovery is blocked because the original settlement context is incomplete or inconsistent; no duplicate settlement was submitted.';
  }
  if (pending && !requiresReview) {
    return 'The saved transaction could not be verified yet. Retry the same operation key after the chain or database becomes available.';
  }
  if (requiresReview) {
    return 'Recovery requires operator review; no replacement transfer was submitted.';
  }
  return 'The saved operation could not be recovered safely. Retry the same operation key or inspect its state.';
}

function adminRecoveryResult(
  operation: TokenOperationRecord,
  result: {
    success: boolean;
    amount: number;
    uid?: string;
    userAddress?: string;
    txHash?: string;
    operationKey?: string;
    operationStatus?: string;
    pending?: boolean;
    requiresReview?: boolean;
    movementOutcome?: string;
    error?: string;
  },
  extras: { receiptStatus?: string; spendReceipt?: unknown } = {},
): { outcome: AdminRecoveryOutcome; auditStatus: string; auditMetadata: Record<string, unknown> } {
  const code = result.success ? 'RECOVERY_COMPLETED' : adminRecoveryCode(result.error);
  const pending = Boolean(result.pending);
  const requiresReview = Boolean(result.requiresReview);
  const projectionStatus = result.success || result.operationStatus === 'projected'
    ? 'projected'
    : result.operationStatus || operation.status;
  const receiptStatus = extras.receiptStatus || (operation.operation_type === 'spend' ? 'not_attempted' : 'not_applicable');
  const common = {
    operationKey: operation.operation_key,
    operationType: operation.operation_type,
    eMAID: operation.uid,
    transactionHash: result.txHash || operation.tx_hash || null,
    amount: result.amount,
    projectionStatus,
    receiptStatus,
    movementOutcome: result.movementOutcome || operation.movement_outcome || 'unknown',
    noReplacementTransfer: true,
  };
  if (result.success) {
    return {
      outcome: {
        statusCode: 200,
        body: {
          status: 'ok',
          recoveryStatus: 'completed',
          ...common,
          ...(extras.spendReceipt !== undefined ? { spendReceipt: extras.spendReceipt } : {}),
        },
      },
      auditStatus: 'success',
      auditMetadata: { resultCode: code, projectionStatus, receiptStatus },
    };
  }
  const status = pending && !requiresReview ? 'pending' : requiresReview ? 'blocked' : 'error';
  return {
    outcome: {
      statusCode: status === 'pending' ? 202 : status === 'blocked' ? 409 : 422,
      body: {
        status,
        recoveryStatus: status,
        code,
        message: adminRecoveryMessage(code, pending, requiresReview),
        retryable: status === 'pending',
        requiresReview,
        ...common,
      },
    },
    auditStatus: status === 'pending' ? 'retry_required' : 'error',
    auditMetadata: { resultCode: code, projectionStatus, receiptStatus },
  };
}

async function writeAdminRecoveryAudit(input: {
  eventType: string;
  actorId: string;
  operationKey: string;
  status: string;
  metadata?: Record<string, unknown>;
}): Promise<boolean> {
  try {
    await AuditLogs.create({
      eventType: input.eventType,
      actorType: 'admin',
      actorId: input.actorId,
      targetType: 'token_operation',
      targetId: input.operationKey,
      status: input.status,
      metadata: input.metadata || {},
    });
    return true;
  } catch (err) {
    console.error('Admin recovery audit write failed:', toServerAuditDiagnostic(err));
    return false;
  }
}

function recoveryAuditFailure(
  operation: TokenOperationRecord,
  completed: boolean,
  projectionStatus: string,
  receiptStatus: string,
): AdminRecoveryOutcome {
  return {
    statusCode: 503,
    body: {
      status: 'error',
      code: completed ? 'RECOVERY_COMPLETED_AUDIT_UNAVAILABLE' : 'RECOVERY_OUTCOME_AUDIT_UNAVAILABLE',
      recoveryStatus: completed ? 'completed_audit_pending' : 'audit_pending',
      operationKey: operation.operation_key,
      operationType: operation.operation_type,
      projectionStatus,
      receiptStatus,
      noReplacementTransfer: true,
      message: completed
        ? 'Recovery completed, but its outcome audit could not be recorded. Retry the same operation key; no new chain movement will be submitted.'
        : 'Recovery outcome could not be audited. Retry the same operation key after the audit store recovers.',
    },
  };
}

async function executeAdminOperationRecovery(operationKey: string, actorId: string): Promise<AdminRecoveryOutcome> {
  let operation: TokenOperationRecord | undefined;
  try {
    operation = await TokenOperations.findByKey(operationKey);
  } catch (err) {
    return {
      statusCode: 503,
      body: {
        status: 'error',
        code: 'RECOVERY_LOOKUP_UNAVAILABLE',
        message: 'The operation could not be checked for recovery. Retry the same operation key later.',
        retryable: true,
        noReplacementTransfer: true,
      },
    };
  }
  if (!operation) {
    return {
      statusCode: 404,
      body: {
        status: 'error',
        code: 'TOKEN_OPERATION_NOT_FOUND',
        message: 'The requested token operation was not found; no transfer was submitted.',
        noReplacementTransfer: true,
      },
    };
  }

  const eligibility = getAdminOperationRecoveryStatus(operation);
  const requestAuditWritten = await writeAdminRecoveryAudit({
    eventType: 'admin.recovery_requested',
    actorId,
    operationKey,
    status: 'pending',
    metadata: {
      operationType: operation.operation_type,
      operationStatus: operation.status,
      eligibility: eligibility.reasonCode,
    },
  });
  if (!requestAuditWritten) {
    return {
      statusCode: 503,
      body: {
        status: 'error',
        code: 'RECOVERY_AUDIT_UNAVAILABLE',
        message: 'Recovery was not started because the request audit could not be recorded.',
        retryable: true,
        noReplacementTransfer: true,
      },
    };
  }

  if (!eligibility.eligible) {
    const blocked = {
      success: false,
      amount: Number(operation.amount) || 0,
      uid: operation.uid,
      userAddress: operation.wallet_address,
      operationKey: operation.operation_key,
      operationStatus: operation.status,
      pending: false,
      requiresReview: true,
      movementOutcome: operation.movement_outcome || 'review',
      error: eligibility.reasonCode,
    };
    const built = adminRecoveryResult(operation, blocked);
    const outcomeAuditWritten = await writeAdminRecoveryAudit({
      eventType: 'admin.recovery_blocked',
      actorId,
      operationKey,
      status: built.auditStatus,
      metadata: built.auditMetadata,
    });
    return outcomeAuditWritten
      ? built.outcome
      : recoveryAuditFailure(operation, false, operation.status, 'not_attempted');
  }

  let reservation: Awaited<ReturnType<typeof SpendReservations.findByIdForUid>> | undefined;
  if (operation.operation_type === 'spend' && operation.reservation_id) {
    try {
      reservation = await SpendReservations.findByIdForUid(operation.reservation_id, operation.uid);
    } catch (err) {
      const blocked = {
        success: false,
        amount: Number(operation.amount) || 0,
        uid: operation.uid,
        userAddress: operation.wallet_address,
        operationKey: operation.operation_key,
        operationStatus: operation.status,
        pending: true,
        requiresReview: true,
        movementOutcome: 'review',
        error: `RESERVATION_RECOVERY_BLOCKED: reservation lookup unavailable: ${getErrorMessage(err)}`,
      };
      const built = adminRecoveryResult(operation, blocked);
      const outcomeAuditWritten = await writeAdminRecoveryAudit({
        eventType: 'admin.recovery_blocked', actorId, operationKey, status: built.auditStatus, metadata: built.auditMetadata,
      });
      return outcomeAuditWritten ? built.outcome : recoveryAuditFailure(operation, false, operation.status, 'not_attempted');
    }
    const operationHash = canonicalTxHash(operation.tx_hash);
    const reservationHash = canonicalTxHash(reservation?.tx_hash);
    const reservationWallet = typeof reservation?.wallet_address === 'string' ? reservation.wallet_address : undefined;
    const operationWallet = typeof operation.wallet_address === 'string' ? operation.wallet_address : undefined;
    const reservationContextMatches = Boolean(reservation
      && reservation.uid === operation.uid
      && reservationWallet
      && operationWallet
      && reservationWallet.toLowerCase() === operationWallet.toLowerCase()
      && reservation.session_id === operation.session_id
      && reservation.provider_id === operation.provider_id
      && reservationHash === operationHash);
    const safeTerminalReservation = reservation?.status === 'settled' || reservation?.status === 'released';
    const deliveredKwh = reservation?.delivered_kwh === undefined || reservation.delivered_kwh === null
      ? undefined
      : Number(reservation.delivered_kwh);
    const validDeliveredKwh = deliveredKwh === undefined
      || (Number.isFinite(deliveredKwh) && deliveredKwh >= 0);
    const hasSavedDeliveredKwh = deliveredKwh !== undefined && Number.isFinite(deliveredKwh) && deliveredKwh >= 0;
    const operationAmount = canonicalTokenAmount(operation.amount);
    const settledAmount = canonicalTokenAmount(reservation?.settled_amount);
    const reservedAmount = canonicalTokenAmount(reservation?.reserved_amount);
    const terminalAmountMatches = safeTerminalReservation
      && Boolean(operationAmount && settledAmount && operationAmount.units === settledAmount.units);
    const settlingReady = reservation?.status === 'settling' && hasSavedDeliveredKwh;
    const settlingAmountWithinHold = reservation?.status === 'settling'
      && Boolean(operationAmount && reservedAmount && operationAmount.units <= reservedAmount.units);
    const supportedReservationState = (safeTerminalReservation && terminalAmountMatches)
      || (settlingReady && settlingAmountWithinHold);
    if (!reservation || !reservationContextMatches || !validDeliveredKwh || !supportedReservationState) {
      const blocked = {
        success: false,
        amount: Number(operation.amount) || 0,
        uid: operation.uid,
        userAddress: operation.wallet_address,
        operationKey: operation.operation_key,
        operationStatus: operation.status,
        pending: false,
        requiresReview: true,
        movementOutcome: 'review',
        error: 'RESERVATION_RECOVERY_BLOCKED: original reservation settlement context is incomplete or inconsistent; delivered session context is required',
      };
      const built = adminRecoveryResult(operation, blocked);
      const outcomeAuditWritten = await writeAdminRecoveryAudit({
        eventType: 'admin.recovery_blocked', actorId, operationKey, status: built.auditStatus, metadata: built.auditMetadata,
      });
      return outcomeAuditWritten ? built.outcome : recoveryAuditFailure(operation, false, operation.status, 'not_attempted');
    }
  }

  let result: {
    success: boolean;
    amount: number;
    uid?: string;
    userAddress?: string;
    txHash?: string;
    operationKey?: string;
    operationStatus?: string;
    pending?: boolean;
    requiresReview?: boolean;
    movementOutcome?: string;
    error?: string;
  };
  let receiptStatus = operation.operation_type === 'spend' ? 'not_attempted' : 'not_applicable';
  let spendReceipt: SignedSpendReceipt | undefined;
  try {
    if (operation.operation_type === 'award') {
      result = await recoverAwardOperation(operation.operation_key, treasurySigner, { requireFreshEvidence: true });
    } else {
      result = await recoverSpendOperation(operation.operation_key, treasurySigner);
    }

    const recoveredTxHash = result.txHash;
    if (operation.operation_type === 'spend' && result.success && recoveredTxHash) {
      if (reservation && reservation.status === 'settling'
        && reservation.delivered_kwh !== undefined && reservation.delivered_kwh !== null) {
        try {
          const completedReservation = await SpendReservations.complete(
            reservation.id,
            Number(reservation.delivered_kwh),
            result.amount,
            recoveredTxHash,
          );
          const completedAmount = canonicalTokenAmount(completedReservation?.settled_amount);
          const resultAmount = canonicalTokenAmount(result.amount);
          const completedHash = canonicalTxHash(completedReservation?.tx_hash);
          const completedWallet = typeof completedReservation?.wallet_address === 'string'
            ? completedReservation.wallet_address.toLowerCase()
            : undefined;
          const savedOperationWallet = typeof operation.wallet_address === 'string'
            ? operation.wallet_address.toLowerCase()
            : undefined;
          const completionMatches = Boolean(completedReservation
            && completedReservation.status === 'settled'
            && completedReservation.uid === operation.uid
            && savedOperationWallet
            && completedWallet === savedOperationWallet
            && completedReservation.session_id === operation.session_id
            && completedReservation.provider_id === operation.provider_id
            && completedAmount && resultAmount
            && completedAmount.units === resultAmount.units
            && completedHash === recoveredTxHash);
          if (!completionMatches) {
            throw Object.assign(new Error('completed reservation state does not match the saved spend intent'), {
              requiresReview: true,
            });
          }
          reservation = completedReservation;
        } catch (err) {
          result = {
            ...result,
            success: false,
            pending: true,
            requiresReview: Boolean((err as Error & { requiresReview?: boolean }).requiresReview),
            error: `RESERVATION_RECOVERY_BLOCKED: original reservation could not be completed safely: ${getErrorMessage(err)}`,
          };
        }
      }
      if (result.success) {
        try {
          spendReceipt = await createAndStoreSpendReceipt({
            uid: operation.uid,
            walletAddress: operation.wallet_address,
            amount: result.amount,
            sessionId: operation.session_id || undefined,
            providerId: operation.provider_id || undefined,
            txHash: recoveredTxHash,
          });
          receiptStatus = 'stored';
        } catch (err) {
          const recovery = err as Error & { receiptPending?: boolean; requiresReview?: boolean };
          receiptStatus = recovery.requiresReview ? 'blocked' : 'pending';
          result = {
            ...result,
            success: false,
            pending: !recovery.requiresReview,
            requiresReview: Boolean(recovery.requiresReview),
            error: recovery.requiresReview
              ? `SPEND_RECEIPT_RECOVERY_BLOCKED: ${getErrorMessage(err)}`
              : `SPEND_RECEIPT_RECOVERY_PENDING: ${getErrorMessage(err)}`,
          };
        }
      }
    }
  } catch (err) {
    console.error('Admin recovery execution failed:', toServerAuditDiagnostic(err));
    let latestOperation = operation;
    try {
      latestOperation = await TokenOperations.findByKey(operation.operation_key) || operation;
    } catch (lookupError) {
      console.error('Admin recovery post-failure state lookup failed:', toServerAuditDiagnostic(lookupError));
    }
    const projectionComplete = latestOperation.status === 'projected';
    const receiptStageFailure = operation.operation_type === 'spend' && projectionComplete;
    if (receiptStageFailure) receiptStatus = 'pending';
    const failedResult = {
      success: false,
      amount: Number(latestOperation.amount) || 0,
      uid: latestOperation.uid,
      userAddress: latestOperation.wallet_address,
      operationKey: latestOperation.operation_key,
      operationStatus: latestOperation.status,
      txHash: latestOperation.tx_hash || undefined,
      pending: receiptStageFailure,
      requiresReview: !receiptStageFailure,
      movementOutcome: latestOperation.movement_outcome || (projectionComplete ? 'confirmed' : 'review'),
      error: receiptStageFailure ? 'SPEND_RECEIPT_RECOVERY_PENDING' : 'RECOVERY_EXECUTION_FAILED',
    };
    const failedBuilt = adminRecoveryResult(latestOperation, failedResult, { receiptStatus });
    const failureAuditWritten = await writeAdminRecoveryAudit({
      eventType: 'admin.recovery_failed',
      actorId,
      operationKey,
      status: failedBuilt.auditStatus,
      metadata: failedBuilt.auditMetadata,
    });
    return failureAuditWritten
      ? failedBuilt.outcome
      : recoveryAuditFailure(latestOperation, false, String(failedResult.operationStatus), receiptStatus);
  }

  const built = adminRecoveryResult(operation, result, { receiptStatus, spendReceipt });
  const outcomeAuditWritten = await writeAdminRecoveryAudit({
    eventType: built.outcome.body.status === 'ok' ? 'admin.recovery_succeeded'
      : built.outcome.body.status === 'pending' ? 'admin.recovery_pending' : 'admin.recovery_failed',
    actorId,
    operationKey,
    status: built.auditStatus,
    metadata: built.auditMetadata,
  });
  if (!outcomeAuditWritten) {
    return recoveryAuditFailure(
      operation,
      built.outcome.body.status === 'ok',
      String(built.outcome.body.projectionStatus || operation.status),
      receiptStatus,
    );
  }
  return built.outcome;
}

// Read-only operation visibility is mounted after the same session middleware
// as the existing admin routes. Recovery only projects already-verified
// operations and never enters an on-chain submission path.
app.use('/admin/operations', validateAdmin, createAdminOperationsRouter({
  recover: ({ operationKey, actorId }) => executeAdminOperationRecovery(operationKey, actorId),
}));

/**
 * Admin login
 * POST /admin/login
 */
app.post('/admin/login', (req: Request, res: Response) => {
  const { username, email, password } = req.body;
  const submittedEmail = String(email || username || '').trim().toLowerCase();
  const registeredAdmins = getRegisteredAdmins();
  const registeredAdmin = registeredAdmins.find((admin) => admin.email === submittedEmail);
  if (registeredAdmins.length === 0) {
    void safeAuditLog({
      eventType: 'admin.login_unconfigured',
      actorType: 'admin',
      actorId: submittedEmail || null,
      targetType: 'admin_session',
      targetId: null,
      status: 'error',
      metadata: {
        adminEmailConfigured: false,
        adminPasswordConfigured: false,
      },
    });
    res.status(503).json({
      status: 'error',
      message: 'Admin login is not configured. Set ADMIN_EMAIL and ADMIN_PASSWORD.',
    });
    return;
  }

  if (!registeredAdmin || password !== registeredAdmin.password) {
    void safeAuditLog({
      eventType: 'admin.login_failed',
      actorType: 'admin',
      actorId: submittedEmail || null,
      targetType: 'admin_session',
      targetId: null,
      status: 'error',
      metadata: {},
    });
    res.status(401).json({ status: 'error', message: 'Invalid credentials' });
    return;
  }
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.set(token, registeredAdmin.email);
  void safeAuditLog({
    eventType: 'admin.login_succeeded',
    actorType: 'admin',
    actorId: registeredAdmin.email,
    targetType: 'admin_session',
    targetId: token.slice(0, 8),
    status: 'success',
    metadata: {},
  });
  res.json({ status: 'ok', token, adminEmail: registeredAdmin.email });
});

/**
 * Admin logout
 * POST /admin/logout
 */
app.post('/admin/logout', validateAdmin, (req: Request, res: Response) => {
  const token = req.header('Authorization')!.slice(7);
  adminSessions.delete(token);
  void safeAuditLog({
    eventType: 'admin.logout',
    actorType: 'admin_session',
    actorId: token.slice(0, 8),
    targetType: 'admin_session',
    targetId: token.slice(0, 8),
    status: 'success',
    metadata: {},
  });
  res.json({ status: 'ok' });
});

/**
 * Get current award rules
 * GET /admin/rules
 */
app.get('/admin/rules', validateAdmin, (req: Request, res: Response) => {
  void (async () => {
    try {
      const policy = await getRewardPolicyRepository().load();
      res.json({
        status: 'ok',
        rules: policy.rules,
        policy: { revision: policy.revision, updatedAt: policy.updatedAt },
        revision: policy.revision,
        updatedAt: policy.updatedAt,
      });
    } catch (err) {
      sendRewardPolicyUnavailable(res, err, 'read');
    }
  })();
});

/**
 * Update award rules
 * PUT /admin/rules
 */
app.put('/admin/rules', validateAdmin, (req: Request, res: Response) => {
  const body = req.body;
  const allowedRuleFields = new Set([
    'offPeakChargingTokensPerKWh',
    'v2gDischargeTokensPerKWh',
    'offPeakChargingEnabled',
    'v2gDischargeEnabled',
  ]);

  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    res.status(400).json({
      status: 'error',
      code: 'INVALID_REWARD_RULES_BODY',
      message: 'Request body must be a non-empty object containing supported reward rule fields',
    });
    return;
  }

  const bodyKeys = Object.keys(body);
  if (bodyKeys.length === 0) {
    res.status(400).json({
      status: 'error',
      code: 'INVALID_REWARD_RULES_BODY',
      message: 'Request body must be a non-empty object containing supported reward rule fields',
    });
    return;
  }

  const unknownFields = bodyKeys.filter((field) => !allowedRuleFields.has(field));
  if (unknownFields.length > 0) {
    res.status(400).json({
      status: 'error',
      code: 'INVALID_REWARD_RULES_FIELD',
      message: `Unsupported reward rule field(s): ${unknownFields.join(', ')}`,
    });
    return;
  }

  const {
    offPeakChargingTokensPerKWh,
    v2gDischargeTokensPerKWh,
    offPeakChargingEnabled,
    v2gDischargeEnabled,
  } = body as Record<string, unknown>;

  if (offPeakChargingTokensPerKWh !== undefined && (typeof offPeakChargingTokensPerKWh !== 'number' || !Number.isFinite(offPeakChargingTokensPerKWh) || offPeakChargingTokensPerKWh < 0)) {
    res.status(400).json({ status: 'error', message: 'offPeakChargingTokensPerKWh must be a non-negative number' });
    return;
  }
  if (v2gDischargeTokensPerKWh !== undefined && (typeof v2gDischargeTokensPerKWh !== 'number' || !Number.isFinite(v2gDischargeTokensPerKWh) || v2gDischargeTokensPerKWh < 0)) {
    res.status(400).json({ status: 'error', message: 'v2gDischargeTokensPerKWh must be a non-negative number' });
    return;
  }
  if (offPeakChargingEnabled !== undefined && typeof offPeakChargingEnabled !== 'boolean') {
    res.status(400).json({ status: 'error', message: 'offPeakChargingEnabled must be a boolean' });
    return;
  }
  if (v2gDischargeEnabled !== undefined && typeof v2gDischargeEnabled !== 'boolean') {
    res.status(400).json({ status: 'error', message: 'v2gDischargeEnabled must be a boolean' });
    return;
  }

  void (async () => {
    try {
      const updatedPolicy = await getRewardPolicyRepository().update(current => ({
        rules: {
          ...current.rules,
          rules: {
            offPeakCharging: {
              ...current.rules.rules.offPeakCharging,
              ...(offPeakChargingTokensPerKWh !== undefined && { tokensPerKWh: offPeakChargingTokensPerKWh }),
              ...(offPeakChargingEnabled !== undefined && { enabled: Boolean(offPeakChargingEnabled) }),
            },
            v2gDischarge: {
              ...current.rules.rules.v2gDischarge,
              ...(v2gDischargeTokensPerKWh !== undefined && { tokensPerKWh: v2gDischargeTokensPerKWh }),
              ...(v2gDischargeEnabled !== undefined && { enabled: Boolean(v2gDischargeEnabled) }),
            },
          },
        },
      }));
      void safeAuditLog({
        eventType: 'admin.rules_updated',
        actorType: 'admin_session',
        actorId: req.header('Authorization')?.slice(7, 15) || null,
        targetType: 'award_rules',
        targetId: updatedPolicy.rules.version,
        status: 'success',
        metadata: {
          revision: updatedPolicy.revision,
          updated: updatedPolicy.rules,
        },
      });
      res.json({
        status: 'ok',
        rules: updatedPolicy.rules,
        policy: { revision: updatedPolicy.revision, updatedAt: updatedPolicy.updatedAt },
        revision: updatedPolicy.revision,
        updatedAt: updatedPolicy.updatedAt,
      });
    } catch (err) {
      sendRewardPolicyUnavailable(res, err, 'write');
    }
  })();
});

// ─── Off-Peak Windows Admin ──────────────────────────────────────────────────

/** Validates a single TimeRange object has valid HH:MM format */
function isValidTimeRange(slot: any): slot is TimeRange {
  if (!slot || typeof slot !== 'object') return false;
  const validClock = (value: unknown): value is string => {
    if (typeof value !== 'string' || !/^\d{2}:\d{2}$/.test(value)) return false;
    const [hours, minutes] = value.split(':').map(Number);
    return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
  };
  return validClock(slot.start) && validClock(slot.end);
}

/** Validates a country code aligns with CDR-style ISO alpha-2 regions */
function isValidCdrCountryCode(code: string): boolean {
  if (!/^[A-Z]{2}$/.test(code)) return false;

  // If Intl.DisplayNames is available in the runtime, reject unknown region codes.
  if (typeof Intl !== 'undefined' && typeof Intl.DisplayNames !== 'undefined') {
    const regionNames = new Intl.DisplayNames(['en'], { type: 'region' });
    const name = regionNames.of(code);
    return Boolean(name && name !== code);
  }

  // Fallback for environments without Intl.DisplayNames support.
  return true;
}

/**
 * Get all off-peak windows
 * GET /admin/off-peak
 */
app.get('/admin/off-peak', validateAdmin, (_req: Request, res: Response) => {
  void (async () => {
    try {
      const policy = await getRewardPolicyRepository().load();
      res.json({
        status: 'ok',
        windows: policy.offPeakWindows,
        policy: { revision: policy.revision, updatedAt: policy.updatedAt },
        revision: policy.revision,
        updatedAt: policy.updatedAt,
      });
    } catch (err) {
      sendRewardPolicyUnavailable(res, err, 'read');
    }
  })();
});

/**
 * Get recent audit events
 * GET /admin/audit?limit=100
 */
app.get('/admin/audit', validateAdmin, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 100, 500);
    const status = typeof req.query.status === 'string' ? req.query.status : undefined;
    const eventType = typeof req.query.eventType === 'string' ? req.query.eventType : undefined;
    const events = await AuditLogs.getRecent(limit, { status, eventType });
    res.json({
      status: 'ok',
      count: events.length,
      events: events.map(toSafeAdminAuditEvent),
    });
  } catch (err) {
    // Keep database/provider details in server diagnostics only. This route
    // serves audit data and must never surface the reward error vocabulary.
    console.error('Admin audit query failed:', toServerAuditDiagnostic(err));
    const safeMessage = toUserFacingAuditError(err);
    res.status(500).json({
      status: 'error',
      code: 'AUDIT_LOG_UNAVAILABLE',
      retryable: true,
      message: safeMessage,
      error: safeMessage,
    });
  }
});

/**
 * Pilot operational metrics derived from audit events.
 * GET /admin/pilot-metrics?hours=24
 */
app.get('/admin/pilot-metrics', validateAdmin, async (req: Request, res: Response) => {
  try {
    const requestedHours = Number(req.query.hours || 24);
    const metrics = await getPilotMetrics(requestedHours);
    res.json({ status: 'ok', metrics });
  } catch (err) {
    console.error('Admin pilot metrics query failed:', toServerAuditDiagnostic(err));
    res.status(500).json({
      status: 'error',
      code: 'PILOT_METRICS_UNAVAILABLE',
      message: 'Pilot metrics could not be loaded right now. Please retry shortly.',
    });
  }
});

/**
 * Pilot readiness checks for deployment evidence.
 * GET /admin/readiness
 */
app.get('/admin/readiness', validateAdmin, async (_req: Request, res: Response) => {
  const checks = await getReadinessChecks();
  const failed = checks.filter(check => check.status === 'fail');
  const warnings = checks.filter(check => check.status === 'warn');
  res.status(failed.length ? 503 : 200).json({
    status: failed.length ? 'not_ready' : warnings.length ? 'ready_with_warnings' : 'ready',
    failedCount: failed.length,
    warningCount: warnings.length,
    checks,
  });
});

/**
 * Send a test alert to the registered admin alert target.
 * POST /admin/alerts/test
 */
app.post('/admin/alerts/test', validateAdmin, async (req: Request, res: Response) => {
  const adminEmail = getRegisteredAdminEmail();
  const actorId = req.header('Authorization')?.slice(7, 15) || null;

  await safeAuditLog({
    eventType: 'admin_alert.test_requested',
    actorType: 'admin_session',
    actorId,
    targetType: 'admin_email',
    targetId: adminEmail,
    status: 'success',
    metadata: {
      webhookConfigured: Boolean(getAdminAlertWebhookUrl()),
    },
  });

  const delivery = await sendAdminAlert({
    eventType: 'admin_alert.test',
    actorType: 'admin_session',
    actorId,
    targetType: 'admin_email',
    targetId: adminEmail,
    status: 'warning',
    metadata: {
      message: 'Manual NEVERFLAT admin alert test',
      requestedAt: new Date().toISOString(),
    },
  });

  const webhookConfigured = Boolean(getAdminAlertWebhookUrl());
  res.status(delivery.status === 'delivery_failed' ? 502 : 202).json({
    status: delivery.status === 'sent' ? 'sent_or_queued' : delivery.status,
    message: delivery.status === 'sent'
      ? 'Test alert sent to configured admin alert webhook.'
      : delivery.status === 'delivery_failed'
        ? 'Test alert delivery failed; inspect the audit log and retry after the alert target is healthy.'
        : 'Test alert recorded, but delivery was skipped because admin email or alert webhook is not configured.',
    deliveryReason: delivery.reason,
    webhookStatus: delivery.webhookStatus,
    adminEmailConfigured: Boolean(adminEmail),
    webhookConfigured,
  });
});

/**
 * Export a point-in-time TRL7 evidence snapshot for reviewers/operators.
 * GET /admin/evidence-pack
 */
app.get('/admin/evidence-pack', validateAdmin, async (_req: Request, res: Response) => {
  try {
    const readinessChecks = await getReadinessChecks();
    const failed = readinessChecks.filter(check => check.status === 'fail');
    const warnings = readinessChecks.filter(check => check.status === 'warn');
    const latestReconciliation = await ReconciliationReports.latest();
    const recentRetryEvents = await AuditLogs.getRecent(25, { status: 'retry_required' });
    const recentWarningEvents = await AuditLogs.getRecent(25, { status: 'warning' });
    const recentErrorEvents = await AuditLogs.getRecent(25, { status: 'error' });
    const recentAlertEvents = await AuditLogs.getRecent(25, { eventType: 'admin_alert.delivered' });
    const pilotMetrics = await getPilotMetrics(24);

    res.status(200).json({
      status: 'ok',
      generatedAt: new Date().toISOString(),
      readiness: {
        status: failed.length ? 'not_ready' : warnings.length ? 'ready_with_warnings' : 'ready',
        failedCount: failed.length,
        warningCount: warnings.length,
        checks: readinessChecks,
      },
      configuration: {
        apiKeyConfigured: Boolean(API_KEY),
        ingestApiKeyConfigured: Boolean(INGEST_API_KEY),
        adminEmailConfigured: Boolean(getRegisteredAdminEmail()),
        adminAlertWebhookConfigured: Boolean(getAdminAlertWebhookUrl()),
        manualUidLookupEnabled: ENABLE_TEST_UID_LOOKUP,
        tokenContractAddress: TOKEN_CONTRACT_ADDRESS,
        treasuryAddress: await getTreasuryWalletAddress(),
        polygonRpcConfigured: Boolean(POLYGON_RPC_URL),
      },
      reconciliation: {
        latest: latestReconciliation || null,
      },
      pilotMetrics,
      audit: {
        retryRequired: recentRetryEvents,
        warnings: recentWarningEvents,
        errors: recentErrorEvents,
        deliveredAlerts: recentAlertEvents,
      },
    });
  } catch (err) {
    console.error('Admin evidence pack failed:', toServerAuditDiagnostic(err));
    res.status(500).json({
      status: 'error',
      code: 'EVIDENCE_PACK_UNAVAILABLE',
      retryable: true,
      message: 'The evidence pack could not be generated. Please retry shortly.',
      error: 'The evidence pack could not be generated. Please retry shortly.',
    });
  }
});

/**
 * Run DB-vs-chain wallet balance reconciliation
 * POST /admin/reconciliation/run
 */
app.post('/admin/reconciliation/run', validateAdmin, async (req: Request, res: Response) => {
  try {
    if (req.body !== undefined && (req.body === null || typeof req.body !== 'object' || Array.isArray(req.body))) {
      res.status(400).json({
        status: 'error',
        code: 'INVALID_RECONCILIATION_BODY',
        message: 'Request body must be an object containing an optional limit',
      });
      return;
    }
    const rawLimit = req.body?.limit;
    const limit = rawLimit === undefined ? 500 : rawLimit;
    if (typeof limit !== 'number' || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      res.status(400).json({
        status: 'error',
        code: 'INVALID_RECONCILIATION_LIMIT',
        message: 'limit must be an integer between 1 and 1000',
      });
      return;
    }
    const report = await runBalanceReconciliation(limit);
    res.json({ status: 'ok', report });
  } catch (err) {
    console.error('Admin reconciliation run failed:', toServerAuditDiagnostic(err));
    res.status(500).json({
      status: 'error',
      code: 'RECONCILIATION_UNAVAILABLE',
      retryable: true,
      message: 'The reconciliation report could not be generated. Please retry shortly.',
      error: 'The reconciliation report could not be generated. Please retry shortly.',
    });
  }
});

/**
 * Get latest or recent reconciliation reports
 * GET /admin/reconciliation?limit=20
 */
app.get('/admin/reconciliation', validateAdmin, async (req: Request, res: Response) => {
  try {
    const rawLimit = req.query.limit;
    const limit = rawLimit === undefined ? 20 : (typeof rawLimit === 'string' && /^\d+$/.test(rawLimit) ? Number(rawLimit) : NaN);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
      res.status(400).json({
        status: 'error',
        code: 'INVALID_RECONCILIATION_LIMIT',
        message: 'limit must be an integer between 1 and 100',
      });
      return;
    }
    const reports = await ReconciliationReports.getRecent(limit);
    res.json({
      status: 'ok',
      count: reports.length,
      latest: reports[0] || null,
      reports,
    });
  } catch (err) {
    console.error('Admin reconciliation reports failed:', toServerAuditDiagnostic(err));
    res.status(500).json({
      status: 'error',
      code: 'RECONCILIATION_UNAVAILABLE',
      retryable: true,
      message: 'The reconciliation reports could not be loaded. Please retry shortly.',
      error: 'The reconciliation reports could not be loaded. Please retry shortly.',
    });
  }
});

/**
 * Replace entire off-peak window config
 * PUT /admin/off-peak
 * Body: { windows: OffPeakConfig }
 */
app.put('/admin/off-peak', validateAdmin, (req: Request, res: Response) => {
  const { windows } = req.body || {};
  if (!windows || typeof windows !== 'object' || Array.isArray(windows)) {
    res.status(400).json({ status: 'error', message: 'Body must contain a "windows" object' });
    return;
  }

  const MAX_SLOTS = 6;
  for (const [country, slots] of Object.entries(windows)) {
    if (!isValidCdrCountryCode(country)) {
      res.status(400).json({ status: 'error', message: `Invalid country code: "${country}". Must be a valid ISO alpha-2 CDR country code.` });
      return;
    }
    if (!Array.isArray(slots) || slots.length === 0) {
      res.status(400).json({ status: 'error', message: `Country "${country}" must have at least one time slot` });
      return;
    }
    if ((slots as any[]).length > MAX_SLOTS) {
      res.status(400).json({ status: 'error', message: `Country "${country}" exceeds maximum of ${MAX_SLOTS} slots` });
      return;
    }
    for (const slot of slots as any[]) {
      if (!isValidTimeRange(slot)) {
        res.status(400).json({ status: 'error', message: `Invalid time slot in "${country}". Each slot must have start and end in HH:MM format.` });
        return;
      }
    }
  }

  void (async () => {
    try {
      const updatedPolicy = await getRewardPolicyRepository().update({
        offPeakWindows: windows as OffPeakConfig,
      });
      void safeAuditLog({
        eventType: 'admin.off_peak_updated',
        actorType: 'admin_session',
        actorId: req.header('Authorization')?.slice(7, 15) || null,
        targetType: 'off_peak_windows',
        targetId: 'all',
        status: 'success',
        metadata: {
          revision: updatedPolicy.revision,
          updated: updatedPolicy.offPeakWindows,
        },
      });
      res.json({
        status: 'ok',
        windows: updatedPolicy.offPeakWindows,
        policy: { revision: updatedPolicy.revision, updatedAt: updatedPolicy.updatedAt },
        revision: updatedPolicy.revision,
        updatedAt: updatedPolicy.updatedAt,
      });
    } catch (err) {
      sendRewardPolicyUnavailable(res, err, 'write');
    }
  })();
});

/**
 * Remove a country from off-peak config
 * DELETE /admin/off-peak/:countryCode
 */
app.delete('/admin/off-peak/:countryCode', validateAdmin, (req: Request, res: Response) => {
  const code = (req.params.countryCode || '').toUpperCase();
  if (!isValidCdrCountryCode(code)) {
    res.status(400).json({ status: 'error', message: 'Country code must be a valid ISO alpha-2 CDR country code' });
    return;
  }
  void (async () => {
    let removed: TimeRange[] | undefined;
    try {
      const updatedPolicy = await getRewardPolicyRepository().update(current => {
        if (!current.offPeakWindows[code]) {
          const error = new Error(`REWARD_POLICY_COUNTRY_NOT_FOUND:${code}`) as Error & { code?: string };
          error.code = 'REWARD_POLICY_COUNTRY_NOT_FOUND';
          throw error;
        }
        removed = current.offPeakWindows[code];
        const { [code]: _removed, ...rest } = current.offPeakWindows;
        return { offPeakWindows: rest as OffPeakConfig };
      });
      void safeAuditLog({
        eventType: 'admin.off_peak_country_removed',
        actorType: 'admin_session',
        actorId: req.header('Authorization')?.slice(7, 15) || null,
        targetType: 'off_peak_country',
        targetId: code,
        status: 'success',
        metadata: {
          removed: removed || null,
          revision: updatedPolicy.revision,
          updated: updatedPolicy.offPeakWindows,
        },
      });
      res.json({
        status: 'ok',
        windows: updatedPolicy.offPeakWindows,
        policy: { revision: updatedPolicy.revision, updatedAt: updatedPolicy.updatedAt },
        revision: updatedPolicy.revision,
        updatedAt: updatedPolicy.updatedAt,
      });
    } catch (err) {
      if ((err as { code?: string })?.code === 'REWARD_POLICY_COUNTRY_NOT_FOUND') {
        res.status(404).json({ status: 'error', message: `Country "${code}" not found in off-peak config` });
        return;
      }
      sendRewardPolicyUnavailable(res, err, 'write');
    }
  })();
});

// Error handling middleware
app.use((err: any, req: Request, res: Response, next: Function) => {
  const errorType = typeof err?.type === 'string' ? err.type : '';
  if (errorType === 'entity.parse.failed') {
    res.status(400).json({
      status: 'error',
      code: 'INVALID_JSON',
      message: 'Request body must contain valid JSON',
    });
    return;
  }
  if (errorType === 'entity.too.large') {
    res.status(413).json({
      status: 'error',
      code: 'REQUEST_BODY_TOO_LARGE',
      message: 'Request body is too large',
    });
    return;
  }
  console.error('Unhandled error:', toServerAuditDiagnostic(err));
  res.status(500).json({
    status: 'error',
    code: 'INTERNAL_SERVER_ERROR',
    message: 'The server could not complete the request. Try again later.',
  });
});

// Serve frontend static files
import path from 'path';
const frontendBuild = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(frontendBuild)) {
  app.use(express.static(frontendBuild));
  app.get('*', (req: Request, res: Response) => {
    res.sendFile(path.join(frontendBuild, 'index.html'));
  });
}

app.use((req: Request, res: Response) => {
  res.status(404).json({
    status: 'error',
    code: 'ROUTE_NOT_FOUND',
    message: 'The requested API route was not found',
  });
});

export { app };

export function startServer() {
  return app.listen(PORT, () => {
  console.log(`🚀 NVF Award System API running on port ${PORT}`);
  console.log(`📍 Health: GET http://localhost:${PORT}/ingest/health`);
  console.log(`📍 Ingest CDR: POST http://localhost:${PORT}/ingest/cdr`);
  console.log(`📍 Spend: POST http://localhost:${PORT}/spend`);
  console.log(`📍 Spend (identity): POST http://localhost:${PORT}/spend/me`);
  console.log(`📍 Wallet Query: GET http://localhost:${PORT}/wallet/:uid`);
  console.log(`📍 Wallet Query (identity): GET http://localhost:${PORT}/wallet/me`);
  console.log(`📍 Transactions: GET http://localhost:${PORT}/transactions`);
});

}

if (require.main === module) {
  startServer();
}
