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
import { Awards, Spends, Users, Balances } from './database/service';
import { RawSession, OCPICDRFormat } from './types';
import { getRules, setRules, AwardRuleConfig } from './config/awardRules';
import { getOffPeakWindows, setOffPeakWindows } from './config/offPeakWindows';
import { TimeRange, OffPeakConfig } from './types';

const app = express();
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN }));
app.use(express.json());

// Configuration
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY;
const USER_IDENTITY_HEADER = (process.env.USER_IDENTITY_HEADER || 'x-contract-id').toLowerCase();
const ENABLE_TEST_UID_LOOKUP = process.env.ENABLE_TEST_UID_LOOKUP !== 'false';
const POLYGON_RPC_URL = process.env.POLYGON_RPC_URL || 'https://rpc-amoy.polygon.technology/';
const TOKEN_CONTRACT_ADDRESS = process.env.TOKEN_CONTRACT_ADDRESS || '0x605871D30DC278a036F09e2ace771df8a224624B';
const TREASURY_ADDRESS = process.env.TREASURY_ADDRESS;

// Admin credentials (override via env vars)
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'NVF@dm1n2026';

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

function getRequestContractId(req: Request): string | null {
  const raw = req.header(USER_IDENTITY_HEADER) || req.header('X-Contract-Id');
  if (!raw) {
    return null;
  }
  const normalized = normalizeUid(String(raw));
  return normalized || null;
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

async function getWalletPayload(normalizedUid: string) {
  const walletConfig = await getUserWalletConfig(normalizedUid);
  const userAddress = walletConfig.walletAddress;

  // Get user (if exists)
  const user = await Users.findByUid(normalizedUid);
  if (!user) {
    return {
      status: 'success',
      uid: normalizedUid,
      walletAddress: userAddress,
      managedWalletAddress: getManagedWalletAddress(normalizedUid),
      walletMode: walletConfig.walletMode,
      isRegistered: false,
      balance: '0',
      totalAwarded: '0',
      totalSpent: '0',
      treasuryAddress: TREASURY_ADDRESS || null,
      tokenContractAddress: TOKEN_CONTRACT_ADDRESS,
      history: [],
    };
  }

  // Get balance
  const balance = await Balances.findByUser(user.id);
  const currentBalance = balance ? balance.balance : '0';
  const totalAwarded = balance ? balance.total_awarded : '0';
  const totalSpent = balance ? balance.total_spent : '0';

  // Get recent transactions (last 20 combined)
  const awards = await Awards.findByUser(user.id);
  const spends = await Spends.findByUser(user.id);

  const transactions: Array<{
    type: 'award' | 'spend';
    amount: string;
    label: string;
    txHash: string;
    timestamp: Date;
    isOffPeak?: boolean;
    countryCode?: string;
    localTime?: string;
    awardType?: string;
  }> = [
    ...awards.slice(0, 20).map(a => ({
      type: 'award' as const,
      amount: a.amount,
      label: a.dedup_key,
      txHash: a.tx_hash,
      timestamp: a.awarded_at,
      isOffPeak: a.is_off_peak,
      countryCode: a.country_code,
      localTime: a.local_time,
      awardType: a.award_type,
    })),
    ...spends.slice(0, 20).map(s => ({
      type: 'spend' as const,
      amount: s.amount,
      label: s.session_id || 'Manual spend',
      txHash: s.tx_hash,
      timestamp: s.created_at,
    })),
  ]
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())
    .slice(0, 10);

  return {
    status: 'success',
    uid: normalizedUid,
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

/**
 * API Key authentication middleware
 * Validates API_KEY header for protected endpoints
 */
function validateApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!API_KEY) {
    // If no API_KEY configured in env, skip validation (development mode)
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

/**
 * Health check endpoint (no authentication required)
 */
app.get('/ingest/health', (req: Request, res: Response) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * CDR Ingestion endpoint
 * POST /ingest/cdr
 * 
 * Accepts raw CDR data, processes award if eligible, returns status
 * Requires X-API-Key header for authentication
 */
app.post('/ingest/cdr', validateApiKey, async (req: Request, res: Response) => {
  try {
    const cdr: RawSession | OCPICDRFormat = req.body;

    // Validate required fields — supports both legacy flat format and OCPI 2.2 format
    const sessionId = cdr.SessionID || cdr.id;
    const providerId = cdr.ProviderID || cdr.custom_data?.provider_id || cdr.party_id;
    const contractId = cdr.cdr_token?.contract_id;

    if (!sessionId || !providerId || !contractId) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing required fields: session id (SessionID or id), provider id (ProviderID, party_id, or custom_data.provider_id), and cdr_token.contract_id',
      });
    }

    // Check for duplicates
    const dedupKey = `${sessionId}-${providerId}`;
    const exists = await Awards.exists(dedupKey);

    if (exists) {
      return res.status(200).json({
        status: 'duplicate',
        sessionId,
        providerId,
        message: 'CDR already processed',
      });
    }

    // Process award
    const result = await processAwardFromCDR(cdr, treasurySigner);

    if (!result.success) {
      return res.status(400).json({
        status: 'error',
        sessionId,
        providerId,
        error: result.error,
      });
    }

    return res.status(200).json({
      status: 'accepted',
      sessionId,
      providerId,
      uid: result.uid,
      eligible: result.eligible,
      tokensAwarded: result.amount,
      txHash: result.txHash,
      message: result.eligible ? `${result.amount} SPARKZ awarded` : 'CDR accepted but not eligible for reward',
    });
  } catch (err) {
    console.error('CDR ingestion error:', err);
    res.status(500).json({
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
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
      return res.status(400).json({
        status: 'error',
        message: 'Missing or invalid fields: uid, amount (must be > 0)',
      });
    }

    // Resolve uid to wallet address
    const walletConfig = await getUserWalletConfig(normalizedUid);
    if (walletConfig.walletMode === 'custodial') {
      return res.status(400).json({
        status: 'error',
        uid: normalizedUid,
        error: 'This user is using an external wallet. Submit the spend from the connected wallet instead.',
      });
    }

    const userAddress = walletConfig.walletAddress;

    // Execute spend (first attempt)
    let spendResult = await processSpend(
      {
        userAddress,
        amount,
        sessionId,
      },
      treasurySigner
    );

    // If spend fails (commonly due to missing allowance), auto-approve and retry once.
    if (!spendResult.success) {
      try {
        const treasuryAddress = process.env.TREASURY_ADDRESS;
        if (treasuryAddress) {
          await approveUserForSpendingViaFunding(normalizedUid, treasurySigner, treasuryAddress);

          spendResult = await processSpend(
            {
              userAddress,
              amount,
              sessionId,
            },
            treasurySigner
          );
        }
      } catch (approvalErr) {
        console.error('Spend auto-approval failed:', approvalErr);
      }
    }

    if (!spendResult.success) {
      return res.status(400).json({
        status: 'error',
        uid: normalizedUid,
        error: spendResult.error,
      });
    }

    return res.status(200).json({
      status: 'success',
      uid: normalizedUid,
      sessionId,
      providerId,
      tokensSpent: spendResult.amount,
      txHash: spendResult.txHash,
      timestamp: new Date().toISOString(),
      label,
    });
  } catch (err) {
    console.error('Spend error:', err);
    res.status(500).json({
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    });
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
      return res.status(401).json({
        status: 'error',
        message: `Missing identity header: ${USER_IDENTITY_HEADER}`,
      });
    }

    const { sessionId, providerId, amount, label } = req.body;
    const normalizedUid = normalizeUid(contractId);

    if (!normalizedUid || !amount || amount <= 0) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing or invalid fields: amount (must be > 0)',
      });
    }

    const walletConfig = await getUserWalletConfig(normalizedUid);
    if (walletConfig.walletMode === 'custodial') {
      return res.status(400).json({
        status: 'error',
        uid: normalizedUid,
        error: 'This user is using an external wallet. Submit the spend from the connected wallet instead.',
      });
    }

    const userAddress = walletConfig.walletAddress;

    let spendResult = await processSpend(
      {
        userAddress,
        amount,
        sessionId,
      },
      treasurySigner
    );

    if (!spendResult.success) {
      try {
        const treasuryAddress = process.env.TREASURY_ADDRESS;
        if (treasuryAddress) {
          await approveUserForSpendingViaFunding(normalizedUid, treasurySigner, treasuryAddress);

          spendResult = await processSpend(
            {
              userAddress,
              amount,
              sessionId,
            },
            treasurySigner
          );
        }
      } catch (approvalErr) {
        console.error('Spend auto-approval failed:', approvalErr);
      }
    }

    if (!spendResult.success) {
      return res.status(400).json({
        status: 'error',
        uid: normalizedUid,
        error: spendResult.error,
      });
    }

    return res.status(200).json({
      status: 'success',
      uid: normalizedUid,
      sessionId,
      providerId,
      tokensSpent: spendResult.amount,
      txHash: spendResult.txHash,
      timestamp: new Date().toISOString(),
      label,
    });
  } catch (err) {
    console.error('Spend (me) error:', err);
    res.status(500).json({
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
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
 * Record a custodial spend after the user confirms it in their own wallet.
 * POST /spend/custodial-record
 */
app.post('/spend/custodial-record', validateApiKey, async (req: Request, res: Response) => {
  try {
    const { uid, walletAddress, amount, txHash, sessionId } = req.body;
    const normalizedUid = normalizeUid(String(uid || ''));

    if (!normalizedUid || !walletAddress || !txHash || !amount || amount <= 0) {
      return res.status(400).json({
        status: 'error',
        message: 'Missing or invalid fields: uid, walletAddress, txHash, amount (must be > 0)',
      });
    }

    if (!ethers.isAddress(walletAddress)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid wallet address',
      });
    }

    if (!/^0x[a-fA-F0-9]{64}$/.test(txHash)) {
      return res.status(400).json({
        status: 'error',
        message: 'Invalid transaction hash',
      });
    }

    const walletConfig = await getUserWalletConfig(normalizedUid);
    if (walletConfig.walletMode !== 'custodial') {
      return res.status(400).json({
        status: 'error',
        message: 'User is not in custodial wallet mode',
      });
    }

    if (walletConfig.walletAddress.toLowerCase() !== ethers.getAddress(walletAddress).toLowerCase()) {
      return res.status(400).json({
        status: 'error',
        message: 'Wallet address does not match the linked custodial wallet',
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

    await recordSpend(walletConfig.walletAddress, Number(amount), txHash, sessionId, normalizedUid);
    return res.status(200).json({
      status: 'success',
      uid: normalizedUid,
      txHash,
      message: 'Custodial spend recorded',
    });
  } catch (err) {
    console.error('Custodial spend record error:', err);
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
    const payload = await getWalletPayload(normalizedUid);
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

    const payload = await getWalletPayload(contractId);
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
 * Get recent transactions (all users)
 * GET /transactions?limit=10
 * Requires X-API-Key header for authentication
 */
app.get('/transactions', validateApiKey, async (req: Request, res: Response) => {
  try {
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 500);
    const awards = (await Awards.getAll()).slice(0, limit);
    const spends = (await Spends.getAll()).slice(0, limit);

    const transactions = [
      ...awards.map(a => ({
        type: 'award',
        amount: a.amount,
        txHash: a.tx_hash,
        timestamp: a.awarded_at,
      })),
      ...spends.map(s => ({
        type: 'spend',
        amount: s.amount,
        txHash: s.tx_hash,
        timestamp: s.created_at,
      })),
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
  const { username, password } = req.body;
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) {
    res.status(401).json({ status: 'error', message: 'Invalid credentials' });
    return;
  }
  const token = crypto.randomBytes(32).toString('hex');
  adminSessions.add(token);
  res.json({ status: 'ok', token });
});

/**
 * Admin logout
 * POST /admin/logout
 */
app.post('/admin/logout', validateAdmin, (req: Request, res: Response) => {
  const token = req.header('Authorization')!.slice(7);
  adminSessions.delete(token);
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

  setOffPeakWindows(windows as OffPeakConfig);
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

// Start server
app.listen(PORT, () => {
  console.log(`🚀 NVF Award System API running on port ${PORT}`);
  console.log(`📍 Health: GET http://localhost:${PORT}/ingest/health`);
  console.log(`📍 Ingest CDR: POST http://localhost:${PORT}/ingest/cdr`);
  console.log(`📍 Spend: POST http://localhost:${PORT}/spend`);
  console.log(`📍 Spend (identity): POST http://localhost:${PORT}/spend/me`);
  console.log(`📍 Wallet Query: GET http://localhost:${PORT}/wallet/:uid`);
  console.log(`📍 Wallet Query (identity): GET http://localhost:${PORT}/wallet/me`);
  console.log(`📍 Transactions: GET http://localhost:${PORT}/transactions`);
});
