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
import { Awards, Spends, Users, Balances, LinkedWallets } from './database/service';
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
    description: 'Error response',
    content: {
      'application/json': {
        schema: { $ref: '#/components/schemas/ErrorResponse' },
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
      '/spend/me': {
        post: {
          tags: ['Spends'],
          summary: 'Spend SPARKZ using the x-contract-id identity header',
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
          properties: {
            status: { type: 'string', example: 'error' },
            message: { type: 'string' },
            error: { type: 'string' },
          },
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
          required: ['amount'],
          properties: {
            amount: { type: 'number', example: 5 },
            sessionId: { type: 'string', example: 'spend-001' },
            providerId: { type: 'string', example: 'NF' },
            label: { type: 'string', example: 'Charging discount' },
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
    const userAddress = walletConfig.managedWalletAddress;

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
    const userAddress = walletConfig.managedWalletAddress;

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

    const checksumWalletAddress = ethers.getAddress(walletAddress);
    const linkedWalletAddresses = (await LinkedWallets.findByUid(normalizedUid)).map(w => w.wallet_address.toLowerCase());
    if (!linkedWalletAddresses.includes(checksumWalletAddress.toLowerCase())) {
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

// Serve frontend static files
import path from 'path';
const frontendBuild = path.join(__dirname, '..', 'frontend', 'dist');
if (fs.existsSync(frontendBuild)) {
  app.use(express.static(frontendBuild));
  app.get('*', (req: Request, res: Response) => {
    res.sendFile(path.join(frontendBuild, 'index.html'));
  });
}

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
