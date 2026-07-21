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
import { approveUserForSpendingViaFunding, moveFundsFromManagedWallet, recordSpend, revokeAllowanceOnManagedWallet } from './database/integration';
import { getManagedWalletAddress, getUserWalletConfig, resolveActiveUidAddress, setUserWalletMode, WalletMode } from './user/userService';
import { Awards, Spends, Users, Balances, LinkedWallets, SpendReceipts, SpendReservations, AuditLogs, ReconciliationReports } from './database/service';
import type { AuditLogRecord } from './database/service';
import { RawSession, OCPICDRFormat, SpendExecutionResult } from './types';
import { getRules, setRules, AwardRuleConfig } from './config/awardRules';
import { getOffPeakWindows, setOffPeakWindows } from './config/offPeakWindows';
import { TimeRange, OffPeakConfig } from './types';
import { createSpendReceiptPayload, signSpendReceipt, SignedSpendReceipt, verifySpendReceipt } from './receipt';
import { reconcileBalance, summarizeReconciliation } from './reconciliation';
import { getDatabase } from './database/connection';
import { normaliseSession } from './normaliser';
import { prepareAward } from './awardExecutor';
import { calculateReservationSettlement } from './reservation';
import { buildReservationApprovalTransaction } from './reservationApproval';

const app = express();
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN }));
app.use(express.json());

// Configuration
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const INGEST_API_KEY = process.env.INGEST_API_KEY;
const USER_IDENTITY_HEADER = (process.env.USER_IDENTITY_HEADER || 'x-contract-id').toLowerCase();
const ENABLE_TEST_UID_LOOKUP = process.env.ENABLE_TEST_UID_LOOKUP !== 'false';
const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL || 'https://polygon-amoy.drpc.org';
const TOKEN_CONTRACT_ADDRESS = process.env.TOKEN_CONTRACT_ADDRESS || '0x605871D30DC278a036F09e2ace771df8a224624B';
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS;
const TREASURY_GAS_WARNING_THRESHOLD_MATIC = process.env.TREASURY_GAS_WARNING_THRESHOLD_MATIC || '0.05';
const ADMIN_ALERT_WEBHOOK_URL = process.env.ADMIN_ALERT_WEBHOOK_URL;

// Admin credentials must be configured for admin login.
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;

// In-memory admin session tokens
const adminSessions = new Set<string>();

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
  return new ethers.Wallet(key, new ethers.JsonRpcProvider(POLYGON_RPC_URL));
})();

function normalizeUid(value: string): string {
  const trimmed = value.trim();
  if (trimmed.toLowerCase().startsWith('uid=')) {
    return trimmed.slice(4).trim();
  }
  return trimmed;
}

function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  addCheck('admin_alerts', 'Admin alert delivery', Boolean(ADMIN_ALERT_WEBHOOK_URL), 'ADMIN_ALERT_WEBHOOK_URL configured', 'ADMIN_ALERT_WEBHOOK_URL is not configured; alerts will be audited but not sent', 'warn');

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
      message: err instanceof Error ? err.message : String(err),
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
    } catch (err) {
      checks.push({
        key: 'database',
        label: 'Database',
        status: 'fail',
        message: err instanceof Error ? err.message : String(err),
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
  const amount = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : null;
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

  let onChainBalance = '0.00';
  try {
    onChainBalance = Number(ethers.formatEther(await getOnChainTokenBalance(userAddress))).toFixed(2);
  } catch (err) {
    console.warn(`Unable to read on-chain balance for ${userAddress}:`, err instanceof Error ? err.message : String(err));
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
      balance: onChainBalance,
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
  const currentBalance = onChainBalance;
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

function toUserFacingSpendError(error?: unknown): string {
  const text = error instanceof Error ? error.message : String(error || '');
  const normalized = text.toLowerCase();
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
  auditContext: string;
  onApprovalFailure: (approvalErr: unknown) => Promise<void>;
}): Promise<SpendExecutionResult> {
  let spendResult = await processSpend(
    {
      userAddress: input.userAddress,
      amount: input.amount,
      sessionId: input.sessionId,
    },
    treasurySigner
  );

  if (spendResult.success) {
    return spendResult;
  }

  try {
    const treasuryAddress = process.env.TREASURY_ADDRESS;
    if (treasuryAddress) {
      await approveUserForSpendingViaFunding(input.uid, treasurySigner, treasuryAddress);

      spendResult = await processSpend(
        {
          userAddress: input.userAddress,
          amount: input.amount,
          sessionId: input.sessionId,
        },
        treasurySigner
      );
    }
  } catch (approvalErr) {
    console.error('Spend auto-approval failed:', approvalErr);
    if (isTreasuryGasIssue(approvalErr)) {
      await auditTreasuryGasWarning(`spend.${input.auditContext}.auto_approval_failure`, approvalErr);
    }
    await input.onApprovalFailure(approvalErr);
  }

  return spendResult;
}

async function settleReservationFromCdr(cdr: RawSession | OCPICDRFormat) {
  const session = normaliseSession(cdr);
  const reservation = await SpendReservations.claimForSettlement(session.uid, session.sessionId, session.providerId);
  if (!reservation) return null;
  const deliveredKwh = session.energyDirection === 'CHARGE' ? session.energyKWh : 0;
  const { settledAmount: amount } = calculateReservationSettlement(Number(reservation.reserved_amount), deliveredKwh);
  try {
    if (amount === 0) return await SpendReservations.complete(reservation.id, deliveredKwh, 0);
    const isManagedReservation = reservation.wallet_address.toLowerCase() === getManagedWalletAddress(session.uid).toLowerCase();
    const spendResult = isManagedReservation
      ? await processSpendWithAutoApproval({
        uid: session.uid, userAddress: reservation.wallet_address, amount,
        sessionId: session.sessionId, auditContext: 'reservation_settlement',
        onApprovalFailure: async () => undefined,
      })
      : await processSpend({ userAddress: reservation.wallet_address, amount, sessionId: session.sessionId }, treasurySigner);
    if (!spendResult.success || !spendResult.txHash) throw new Error(spendResult.error || 'Reservation settlement failed');
    const completed = await SpendReservations.complete(reservation.id, deliveredKwh, spendResult.amount, spendResult.txHash);
    const spendReceipt = await createAndStoreSpendReceipt({
      uid: session.uid, walletAddress: reservation.wallet_address, amount: spendResult.amount,
      sessionId: session.sessionId, providerId: session.providerId, txHash: spendResult.txHash,
    });
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
    await SpendReservations.retry(reservation.id, getErrorMessage(err));
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

  const network = { chainId: BigInt(process.env.CHAIN_ID || '80002') };
  const checksumWalletAddress = ethers.getAddress(input.walletAddress);
  const tokenInterface = new ethers.Interface(['function transfer(address to, uint256 amount) returns (bool)']);
  const amountWei = ethers.parseEther(input.amount.toString());
  const data = tokenInterface.encodeFunctionData('transfer', [treasuryAddress, amountWei]);
  const intentMaterial = [
    input.uid,
    checksumWalletAddress,
    input.amount.toString(),
    input.sessionId || '',
    input.providerId || '',
    TOKEN_CONTRACT_ADDRESS,
    treasuryAddress,
    network.chainId.toString(),
    data,
  ].join('|');

  return {
    intentId: `csi_${crypto.createHash('sha256').update(intentMaterial).digest('hex').slice(0, 24)}`,
    contractId: input.uid,
    walletAddress: checksumWalletAddress,
    amount: input.amount.toString(),
    sessionId: input.sessionId || null,
    providerId: input.providerId || null,
    chainId: Number(network.chainId),
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
  const network = { chainId: BigInt(process.env.CHAIN_ID || '80002') };
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
    chainId: Number(network.chainId),
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
  if (!input.uid || !input.walletAddress || !input.amount || input.amount <= 0) {
    throw new Error('Missing or invalid fields: uid, walletAddress, amount (must be > 0)');
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
  const provider = treasurySigner.provider;
  const network = provider ? await provider.getNetwork() : { chainId: 80002n };
  const payload = createSpendReceiptPayload({
    contractId: input.uid,
    walletAddress: input.walletAddress,
    amount: input.amount,
    sessionId: input.sessionId || null,
    providerId: input.providerId || null,
    tokenTxHash: input.txHash,
    tokenContractAddress: TOKEN_CONTRACT_ADDRESS,
    chainId: Number(network.chainId),
    status: 'settled',
  });
  const signed = await signSpendReceipt(payload, treasurySigner);

  let dbStored = false;
  let dbError: string | undefined;
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
    dbStored = true;
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
    dbError = err instanceof Error ? err.message : String(err);
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
  }

  return {
    ...signed,
    dbStored,
    dbError,
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

async function sendAdminAlert(data: {
  eventType: string;
  actorType: string;
  actorId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  status: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const adminEmail = getRegisteredAdminEmail();
  if (!adminEmail || !ADMIN_ALERT_WEBHOOK_URL) {
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
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch(ADMIN_ALERT_WEBHOOK_URL, {
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
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * API Key authentication middleware
 * Validates API_KEY header for protected endpoints
 */
function validateApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!API_KEY) {
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

  if (apiKey !== API_KEY) {
    res.status(403).json({
      status: 'error',
      message: 'Invalid API key',
    });
    return;
  }

  next();
}

function buildOpenApiSpec(req: Request) {
  const baseUrl = `${req.protocol}://${req.get('host')}`;
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
  const apiKeySecurity = [{ ApiKeyAuth: [] }];
  const adminSecurity = [{ AdminBearerAuth: [] }];

  return {
    openapi: '3.0.3',
    info: {
      title: 'NEVERFLAT SPARKZ Award System API',
      version: '1.0.0',
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
          security: apiKeySecurity,
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/CdrRequest' },
              },
            },
          },
          responses: {
            200: {
              description: 'CDR accepted, duplicate, or accepted but not eligible',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/CdrResponse' },
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
            400: errorResponse,
            401: errorResponse,
            403: errorResponse,
            500: errorResponse,
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
            message: { type: 'string' },
          },
        },
        CdrRequest: {
          type: 'object',
          required: ['id', 'party_id', 'cdr_token'],
          properties: {
            id: { type: 'string', example: 'cdr-session-001' },
            party_id: { type: 'string', example: 'NF' },
            custom_data: {
              type: 'object',
              properties: {
                provider_id: { type: 'string', example: 'NF' },
              },
            },
            cdr_token: {
              type: 'object',
              required: ['contract_id'],
              properties: {
                contract_id: { type: 'string', example: '000' },
              },
            },
            start_date_time: { type: 'string', format: 'date-time' },
            end_date_time: { type: 'string', format: 'date-time' },
            total_energy: { type: 'number', example: 40 },
            country_code: { type: 'string', example: 'GB' },
            SessionID: { type: 'string', example: 'legacy-session-001' },
            ProviderID: { type: 'string', example: 'NF' },
            'Session Start': { type: 'string', format: 'date-time' },
            'Session End': { type: 'string', format: 'date-time' },
            'Consumed Energy': { type: 'string', example: '40' },
          },
        },
        CdrResponse: {
          type: 'object',
          properties: {
            status: { type: 'string', example: 'accepted' },
            sessionId: { type: 'string', example: 'cdr-session-001' },
            providerId: { type: 'string', example: 'NF' },
            uid: { type: 'string', example: '000' },
            eligible: { type: 'boolean', example: true },
            tokensAwarded: { type: 'number', example: 10 },
            txHash: { type: 'string', example: '0xabc...' },
            message: { type: 'string', example: '10 SPARKZ awarded' },
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
          properties: {
            uid: { type: 'string', example: '000' },
            amount: { type: 'number', example: 5 },
            sessionId: { type: 'string', example: 'spend-001' },
            providerId: { type: 'string', example: 'NF' },
            label: { type: 'string', example: 'Charging discount' },
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
        CustodialSpendRecordRequest: {
          type: 'object',
          required: ['uid', 'walletAddress', 'amount', 'txHash'],
          properties: {
            uid: { type: 'string', example: '000' },
            walletAddress: { type: 'string', example: '0x281cdB9F9407Ad029a6d7d5d9989a8362CDb7A59' },
            amount: { type: 'number', example: 5 },
            txHash: { type: 'string', example: '0xabc...' },
            sessionId: { type: 'string', example: 'spend-001' },
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
  if (!INGEST_API_KEY) {
    return validateApiKey(req, res, next);
  }

  const apiKey = req.header('X-Ingest-API-Key') || req.header('X-API-Key');
  if (!apiKey) {
    res.status(401).json({
      status: 'error',
      message: 'Missing ingest API key: X-Ingest-API-Key header required',
    });
    return;
  }

  if (apiKey !== INGEST_API_KEY) {
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
app.post('/spend-receipts/verify', validateApiKey, (req: Request, res: Response) => {
  try {
    const { payload, signature, signerAddress } = req.body;
    if (!payload || typeof payload !== 'object' || !signature) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required fields: payload and signature',
      });
    }

    const expectedSignerAddress = signerAddress || TREASURY_ADDRESS;
    if (!expectedSignerAddress || !ethers.isAddress(expectedSignerAddress)) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing or invalid signerAddress. Provide signerAddress or configure TREASURY_ADDRESS.',
      });
    }

    const valid = verifySpendReceipt(payload, signature, expectedSignerAddress);
    return res.status(200).json({
      status: valid ? 'valid' : 'invalid',
      valid,
      signerAddress: ethers.getAddress(expectedSignerAddress),
      receiptId: payload.receiptId || null,
    });
  } catch (err) {
    return res.status(400).json({
      status: 'error',
      valid: false,
      message: err instanceof Error ? err.message : String(err),
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
    const normalised = normaliseSession(cdr);
    const award = prepareAward(normalised);

    return res.status(200).json({
      status: 'preview',
      sideEffects: false,
      eligible: award.eligible,
      tokensAwarded: award.amount,
      uid: award.uid,
      dedupKey: award.dedupKey,
      normalised: {
        sessionId: normalised.sessionId,
        providerId: normalised.providerId,
        uid: normalised.uid,
        evseId: normalised.evseId,
        startTime: normalised.startTime.toISOString(),
        endTime: normalised.endTime.toISOString(),
        energyKWh: normalised.energyKWh,
        energyDirection: normalised.energyDirection,
      },
      metadata: award.metadata || {},
    });
  } catch (err) {
    await safeAuditLog({
      eventType: 'award.preview_failed',
      actorType: 'ingest_client',
      actorId: null,
      targetType: 'cdr_preview',
      targetId: null,
      status: 'error',
      metadata: {
        error: err instanceof Error ? err.message : String(err),
      },
    });
    return res.status(400).json({
      status: 'error',
      message: err instanceof Error ? err.message : String(err),
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

    // Validate required fields — supports both legacy flat format and OCPI 2.2 format
    const sessionId = cdr.SessionID || cdr.id;
    const providerId = cdr.ProviderID || cdr.custom_data?.provider_id || cdr.party_id;
    const contractId = cdr.cdr_token?.contract_id || cdr.cdr_token_contract_id;

    if (!sessionId || !providerId || !contractId) {
      await safeAuditLog({
        eventType: 'award.validation_failed',
        actorType: 'ingest_client',
        actorId: providerId ? String(providerId) : null,
        targetType: 'cdr',
        targetId: sessionId ? String(sessionId) : null,
        status: 'error',
        metadata: {
          sessionId,
          providerId,
          reason: 'missing_required_fields',
        },
      });
      return res.status(400).json({
        status: 'error',
        message: 'Missing required fields: session id (SessionID or id), provider id (ProviderID, party_id, or custom_data.provider_id), and cdr_token.contract_id',
      });
    }

    const reservationSettlement = await settleReservationFromCdr(cdr);

    // Check for duplicates
    const dedupKey = `${sessionId}-${providerId}`;
    const exists = await Awards.exists(dedupKey);

    if (exists) {
      await safeAuditLog({
        eventType: 'award.duplicate',
        actorType: 'ingest_client',
        actorId: String(providerId),
        targetType: 'award_dedup_key',
        targetId: dedupKey,
        status: 'duplicate',
        metadata: {
          sessionId,
          providerId,
        },
      });
      return res.status(200).json({
        status: 'duplicate',
        sessionId,
        providerId,
        message: 'CDR already processed',
        reservationSettlement,
      });
    }

    await auditTreasuryGasWarning('award.ingest.before_execution');

    // Process award
    const result = await processAwardFromCDR(cdr, treasurySigner);

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
        status: result.stage === 'execution' ? 'retry_required' : 'error',
        metadata: {
          sessionId,
          providerId,
          uid: result.uid || contractId,
          stage: result.stage,
          error: result.error,
        },
      });
      return res.status(400).json({
        status: 'error',
        sessionId,
        providerId,
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
        amount: result.amount,
        txHash: result.txHash || null,
        eligible: result.eligible,
      },
    });

    return res.status(200).json({
      status: 'accepted',
      sessionId,
      providerId,
      uid: result.uid,
      eligible: result.eligible,
      tokensAwarded: result.amount,
      txHash: result.txHash,
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

    const walletPayload = await getWalletPayload(normalizedUid);
    const onChainBalance = Number(walletPayload.balance || 0);
    const reservedBalance = await SpendReservations.getActiveTotal(normalizedUid);
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
      rewardRates: getPublicRewardRates(),
    });
  } catch (err) {
    console.error('Spend session error:', err);
    return res.status(500).json({
      status: 'error',
      message: err instanceof Error ? err.message : String(err),
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
    const { uid, sessionId, providerId, amount, label } = req.body;
    const normalizedUid = normalizeUid(String(uid || ''));

    // Validate
    if (!normalizedUid || !amount || amount <= 0) {
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
        message: 'Missing or invalid fields: uid, amount (must be > 0)',
      });
    }

    // Resolve uid to wallet address
    const walletConfig = await getUserWalletConfig(normalizedUid);
    const userAddress = walletConfig.managedWalletAddress;

    await auditTreasuryGasWarning('spend.legacy.before_execution');

    const spendResult = await processSpendWithAutoApproval({
      uid: normalizedUid,
      userAddress,
      amount,
      sessionId,
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
          error: spendResult.error,
        },
      });
      return res.status(400).json({
        status: 'error',
        uid: normalizedUid,
        error: toUserFacingSpendError(spendResult.error),
      });
    }

    const spendReceipt = await createAndStoreSpendReceipt({
      uid: normalizedUid,
      walletAddress: userAddress,
      amount: spendResult.amount,
      sessionId,
      providerId,
      txHash: spendResult.txHash!,
    });
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
    if (!sessionId || !providerId || amountValue === null) {
      return spendValidationError(res, 'INVALID_RESERVATION_APPROVAL', 'walletAddress, amount, sessionId and providerId are required');
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
    return res.status(400).json({ status: 'error', message: getErrorMessage(err) });
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

    if (!normalizedUid || amountValue === null) {
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
      return spendValidationError(res, 'INVALID_AMOUNT', 'amount must be greater than 0');
    }

    const walletConfig = await getUserWalletConfig(normalizedUid);
    const userAddress = walletConfig.walletAddress;
    const isExternalWallet = walletConfig.walletMode === 'custodial';
    if (isExternalWallet && (!walletAddress || String(walletAddress).toLowerCase() !== userAddress.toLowerCase())) {
      return spendValidationError(res, 'WALLET_MISMATCH', 'walletAddress must be the active linked wallet');
    }
    const onChainBalance = Number(ethers.formatEther(await getOnChainTokenBalance(userAddress)));
    const reservedBalance = await SpendReservations.getActiveTotal(normalizedUid);
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
      reserved = await SpendReservations.reserve({
        uid: normalizedUid, walletAddress: userAddress, sessionId, providerId,
        amount: amountValue, onChainBalance,
        authorizationTxHash: isExternalWallet ? authorizationTxHash : undefined,
        authorizationAmount,
      });
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
      error: err instanceof Error ? err.message : String(err),
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
    const { walletName, walletAddress } = req.body as { walletName?: string | null; walletAddress?: string };

    if (!normalizedUid) {
      return res.status(400).json({ status: 'error', message: 'Missing wallet ID' });
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
      error: err instanceof Error ? err.message : String(err),
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
      error: err instanceof Error ? err.message : String(err),
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

    await getUserWalletConfig(normalizedUid);
    await LinkedWallets.add(normalizedUid, checksumWalletAddress);
    await Users.linkContractId(normalizedUid, checksumWalletAddress);

    const payload = await getWalletPayload(normalizedUid, checksumWalletAddress);
    return res.status(200).json({
      ...payload,
      message: 'Wallet address linked',
    });
  } catch (err) {
    res.status(400).json({
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
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
      error: err instanceof Error ? err.message : String(err),
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

    await LinkedWallets.remove(normalizedUid, checksumWalletAddress);
    const user = await Users.findByUidAndWallet(normalizedUid, checksumWalletAddress);
    if (user && !(await Users.hasActivity(user.id))) {
      await Users.deleteByUidAndWallet(normalizedUid, checksumWalletAddress);
    }

    const payload = await getWalletPayload(normalizedUid);
    return res.status(200).json({
      ...payload,
      message: 'Wallet address unlinked',
    });
  } catch (err) {
    res.status(400).json({
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
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
      error: err instanceof Error ? err.message : String(err),
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
      message: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * Record that a custodial spend signing/submission attempt failed.
 * Returns the same deterministic spend intent so the frontend can prompt retry.
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
      message: 'The wallet spend was not completed. Please retry and sign the same spend transaction.',
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
      message: err instanceof Error ? err.message : String(err),
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

    if (!normalizedUid || !walletAddress || !txHash || !amount || amount <= 0) {
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
        message: 'Missing or invalid fields: uid, walletAddress, txHash, amount (must be > 0)',
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

    if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
      await safeAuditLog({
        eventType: 'spend.custodial_validation_failed',
        actorType: 'api_client',
        actorId: normalizedUid,
        targetType: 'token_tx',
        targetId: txHash,
        status: 'error',
        metadata: {
          uid: normalizedUid,
          walletAddress,
          reason: 'invalid_transaction_hash',
        },
      });
      return res.status(400).json({
        status: 'error',
        message: 'Invalid transaction hash',
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

    const existingSpend = await Spends.findByTxHash(txHash);
    if (existingSpend) {
      return res.status(200).json({
        status: 'success',
        uid: normalizedUid,
        txHash,
        message: 'Custodial spend already recorded',
      });
    }

    await recordSpend(checksumWalletAddress, Number(amount), txHash, sessionId, normalizedUid);
    const spendReceipt = await createAndStoreSpendReceipt({
      uid: normalizedUid,
      walletAddress: checksumWalletAddress,
      amount: Number(amount),
      sessionId,
      providerId,
      txHash,
    });
    await safeAuditLog({
      eventType: 'spend.custodial_recorded',
      actorType: 'api_client',
      actorId: normalizedUid,
      targetType: 'token_tx',
      targetId: txHash,
      status: 'success',
      metadata: {
        uid: normalizedUid,
        walletAddress: checksumWalletAddress,
        amount: Number(amount),
        sessionId,
        providerId,
        receiptId: spendReceipt.payload.receiptId,
      },
    });

    return res.status(200).json({
      status: 'success',
      uid: normalizedUid,
      txHash,
      message: 'Custodial spend recorded',
      spendReceipt,
    });
  } catch (err) {
    console.error('Custodial spend record error:', err);
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
    res.status(500).json({
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
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
      error: err instanceof Error ? err.message : String(err),
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
      error: err instanceof Error ? err.message : String(err),
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
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * Admin session authentication middleware
 */
function validateAdmin(req: Request, res: Response, next: NextFunction): void {
  const auth = req.header('Authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || !adminSessions.has(token)) {
    res.status(401).json({ status: 'error', message: 'Admin authentication required' });
    return;
  }
  next();
}

/**
 * Admin login
 * POST /admin/login
 */
app.post('/admin/login', (req: Request, res: Response) => {
  const { username, email, password } = req.body;
  const submittedEmail = String(email || username || '').trim().toLowerCase();
  const registeredAdminEmail = getRegisteredAdminEmail();
  if (!registeredAdminEmail || !ADMIN_PASSWORD) {
    void safeAuditLog({
      eventType: 'admin.login_unconfigured',
      actorType: 'admin',
      actorId: submittedEmail || null,
      targetType: 'admin_session',
      targetId: null,
      status: 'error',
      metadata: {
        adminEmailConfigured: Boolean(registeredAdminEmail),
        adminPasswordConfigured: Boolean(ADMIN_PASSWORD),
      },
    });
    res.status(503).json({
      status: 'error',
      message: 'Admin login is not configured. Set ADMIN_EMAIL and ADMIN_PASSWORD.',
    });
    return;
  }

  if (submittedEmail !== registeredAdminEmail || password !== ADMIN_PASSWORD) {
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
  adminSessions.add(token);
  void safeAuditLog({
    eventType: 'admin.login_succeeded',
    actorType: 'admin',
    actorId: registeredAdminEmail,
    targetType: 'admin_session',
    targetId: token.slice(0, 8),
    status: 'success',
    metadata: {},
  });
  res.json({ status: 'ok', token, adminEmail: registeredAdminEmail });
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
  res.json({ status: 'ok', rules: getRules() });
});

/**
 * Update award rules
 * PUT /admin/rules
 */
app.put('/admin/rules', validateAdmin, (req: Request, res: Response) => {
  const { offPeakChargingTokensPerKWh, v2gDischargeTokensPerKWh, offPeakChargingEnabled, v2gDischargeEnabled } = req.body;

  if (offPeakChargingTokensPerKWh !== undefined && (typeof offPeakChargingTokensPerKWh !== 'number' || offPeakChargingTokensPerKWh < 0)) {
    res.status(400).json({ status: 'error', message: 'offPeakChargingTokensPerKWh must be a non-negative number' });
    return;
  }
  if (v2gDischargeTokensPerKWh !== undefined && (typeof v2gDischargeTokensPerKWh !== 'number' || v2gDischargeTokensPerKWh < 0)) {
    res.status(400).json({ status: 'error', message: 'v2gDischargeTokensPerKWh must be a non-negative number' });
    return;
  }

  const current = getRules();
  const updated: AwardRuleConfig = {
    ...current,
    rules: {
      offPeakCharging: {
        ...current.rules.offPeakCharging,
        ...(offPeakChargingTokensPerKWh !== undefined && { tokensPerKWh: offPeakChargingTokensPerKWh }),
        ...(offPeakChargingEnabled !== undefined && { enabled: Boolean(offPeakChargingEnabled) }),
      },
      v2gDischarge: {
        ...current.rules.v2gDischarge,
        ...(v2gDischargeTokensPerKWh !== undefined && { tokensPerKWh: v2gDischargeTokensPerKWh }),
        ...(v2gDischargeEnabled !== undefined && { enabled: Boolean(v2gDischargeEnabled) }),
      },
    },
  };

  setRules(updated);
  void safeAuditLog({
    eventType: 'admin.rules_updated',
    actorType: 'admin_session',
    actorId: req.header('Authorization')?.slice(7, 15) || null,
    targetType: 'award_rules',
    targetId: updated.version,
    status: 'success',
    metadata: {
      previous: current,
      updated,
    },
  });
  res.json({ status: 'ok', rules: updated });
});

// ─── Off-Peak Windows Admin ──────────────────────────────────────────────────

/** Validates a single TimeRange object has valid HH:MM format */
function isValidTimeRange(slot: any): slot is TimeRange {
  if (!slot || typeof slot !== 'object') return false;
  const hhMM = /^\d{2}:\d{2}$/;
  return hhMM.test(slot.start) && hhMM.test(slot.end);
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
  res.json({ status: 'ok', windows: getOffPeakWindows() });
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
    res.json({ status: 'ok', count: events.length, events });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      error: toUserFacingAwardError(err),
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
    res.status(500).json({
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
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
      webhookConfigured: Boolean(ADMIN_ALERT_WEBHOOK_URL),
    },
  });

  await sendAdminAlert({
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

  res.status(202).json({
    status: ADMIN_ALERT_WEBHOOK_URL && adminEmail ? 'sent_or_queued' : 'delivery_skipped',
    message: ADMIN_ALERT_WEBHOOK_URL && adminEmail
      ? 'Test alert sent to configured admin alert webhook.'
      : 'Test alert recorded, but delivery was skipped because admin email or alert webhook is not configured.',
    adminEmailConfigured: Boolean(adminEmail),
    webhookConfigured: Boolean(ADMIN_ALERT_WEBHOOK_URL),
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
        adminAlertWebhookConfigured: Boolean(ADMIN_ALERT_WEBHOOK_URL),
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
    res.status(500).json({
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
  }
});

/**
 * Run DB-vs-chain wallet balance reconciliation
 * POST /admin/reconciliation/run
 */
app.post('/admin/reconciliation/run', validateAdmin, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(Number(req.body?.limit || 500), 1000);
    const report = await runBalanceReconciliation(limit);
    res.json({ status: 'ok', report });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      error: toUserFacingSpendError(err),
    });
  }
});

/**
 * Get latest or recent reconciliation reports
 * GET /admin/reconciliation?limit=20
 */
app.get('/admin/reconciliation', validateAdmin, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const reports = await ReconciliationReports.getRecent(limit);
    res.json({
      status: 'ok',
      count: reports.length,
      latest: reports[0] || null,
      reports,
    });
  } catch (err) {
    res.status(500).json({
      status: 'error',
      error: toUserFacingSpendError(err),
    });
  }
});

/**
 * Replace entire off-peak window config
 * PUT /admin/off-peak
 * Body: { windows: OffPeakConfig }
 */
app.put('/admin/off-peak', validateAdmin, (req: Request, res: Response) => {
  const { windows } = req.body;
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

  const previous = getOffPeakWindows();
  setOffPeakWindows(windows as OffPeakConfig);
  void safeAuditLog({
    eventType: 'admin.off_peak_updated',
    actorType: 'admin_session',
    actorId: req.header('Authorization')?.slice(7, 15) || null,
    targetType: 'off_peak_windows',
    targetId: 'all',
    status: 'success',
    metadata: {
      previous,
      updated: getOffPeakWindows(),
    },
  });
  res.json({ status: 'ok', windows: getOffPeakWindows() });
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
  const current = getOffPeakWindows();
  if (!current[code]) {
    res.status(404).json({ status: 'error', message: `Country "${code}" not found in off-peak config` });
    return;
  }
  const { [code]: _removed, ...rest } = current;
  setOffPeakWindows(rest as OffPeakConfig);
  void safeAuditLog({
    eventType: 'admin.off_peak_country_removed',
    actorType: 'admin_session',
    actorId: req.header('Authorization')?.slice(7, 15) || null,
    targetType: 'off_peak_country',
    targetId: code,
    status: 'success',
    metadata: {
      removed: current[code],
      updated: getOffPeakWindows(),
    },
  });
  res.json({ status: 'ok', windows: getOffPeakWindows() });
});

// Error handling middleware
app.use((err: any, req: Request, res: Response, next: Function) => {
  console.error('Unhandled error:', err);
  res.status(500).json({
    status: 'error',
    error: err.message || 'Internal server error',
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
