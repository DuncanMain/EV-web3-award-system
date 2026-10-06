import { createHash } from 'crypto';
import { ethers } from 'ethers';
import { NormalisedSession } from '../types';

/**
 * Transaction hashes are the chain-level idempotency key.  Keep this check
 * at the persistence boundary so malformed values cannot become durable
 * movement identifiers or bypass the database's lower-case uniqueness guard.
 */
export const CANONICAL_TRANSACTION_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;

export function canonicalTransactionHash(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return CANONICAL_TRANSACTION_HASH_PATTERN.test(trimmed) ? trimmed.toLowerCase() : undefined;
}

export function requireCanonicalTransactionHash(value: unknown, field = 'transaction hash'): string {
  const hash = canonicalTransactionHash(value);
  if (!hash) {
    throw new Error(`INVALID_TRANSACTION_HASH: ${field} must be a 0x-prefixed 32-byte hexadecimal hash`);
  }
  return hash;
}

/** Never choose a row when legacy projection data is ambiguous. */
export function requireUnambiguousTransactionMatch<T>(
  matches: T[],
  projection: 'award' | 'spend' | 'receipt' | 'operation',
): T | undefined {
  if (matches.length > 1) {
    throw new Error(`${projection.toUpperCase()}_TX_HASH_AMBIGUOUS_REVIEW: multiple projections share this transaction hash`);
  }
  return matches[0];
}

export interface TokenAssetContext {
  tokenContractAddress: string;
  chainId: string;
  treasuryAddress: string | null;
  signerAddress: string;
}

export interface CanonicalTokenAmount {
  /** Token units at the two-decimal storage boundary (cents). */
  units: bigint;
  decimal: string;
  value: number;
}

function decimalText(value: unknown): string | undefined {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return undefined;
    return String(value);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  return undefined;
}

function decimalParts(value: unknown): { whole: string; fraction: string } | undefined {
  const text = decimalText(value);
  if (!text || !/^\d+(?:\.\d+)?$/.test(text)) return undefined;
  const [whole, fraction = ''] = text.split('.');
  return { whole: whole.replace(/^0+(?=\d)/, ''), fraction };
}

/**
 * Convert a positive/zero token amount to one exact two-decimal value.
 * Numeric values are parsed from their shortest decimal representation; a
 * value such as `0.1 + 0.2` therefore fails instead of being epsilon-rounded
 * into a different on-chain amount.
 */
export function canonicalTokenAmount(value: unknown): CanonicalTokenAmount | undefined {
  const parts = decimalParts(value);
  if (!parts || parts.fraction.length > 2) return undefined;
  const units = BigInt(parts.whole) * 100n + BigInt((parts.fraction + '00').slice(0, 2));
  const decimal = `${parts.whole}.${(parts.fraction + '00').slice(0, 2)}`;
  return { units, decimal, value: Number(units) / 100 };
}

/** Return the exact two-decimal floor for an energy/entitlement value. */
export function truncateTokenAmount(value: unknown): CanonicalTokenAmount | undefined {
  const parts = decimalParts(value);
  if (!parts) return undefined;
  const units = BigInt(parts.whole) * 100n + BigInt((parts.fraction + '00').slice(0, 2));
  const decimal = `${parts.whole}.${(parts.fraction + '00').slice(0, 2)}`;
  return { units, decimal, value: Number(units) / 100 };
}

/**
 * Capture the asset and recipient configuration with the movement intent.
 * A later retry must not silently use a different token contract, chain, or
 * treasury after a process restart/configuration change.
 */
export async function getTokenAssetContext(
  signer: ethers.Signer,
  configuredTreasuryAddress?: string | null,
): Promise<TokenAssetContext> {
  if (!signer.provider) {
    throw new Error('CHAIN_CONTEXT_UNAVAILABLE: signer provider is required to verify the configured chain');
  }
  const tokenContractAddress = (
    process.env.TOKEN_CONTRACT_ADDRESS
      || '0x605871D30DC278a036F09e2ace771df8a224624B'
  ).toLowerCase();
  const configuredChainId = process.env.CHAIN_ID;
  let chainId = configuredChainId || '80002';
  try {
    const providerChainId = (await signer.provider.getNetwork()).chainId.toString();
    if (configuredChainId && providerChainId !== configuredChainId) {
      throw new Error(`CONFIGURED_CHAIN_MISMATCH: configured chain ${configuredChainId} differs from provider chain ${providerChainId}`);
    }
    chainId = providerChainId;
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('CONFIGURED_CHAIN_MISMATCH:')) throw err;
    throw new Error(`CHAIN_CONTEXT_UNAVAILABLE: ${err instanceof Error ? err.message : String(err)}`);
  }

  let signerAddress: string;
  try {
    signerAddress = (await signer.getAddress()).toLowerCase();
  } catch (err) {
    throw new Error(`SIGNER_ADDRESS_UNAVAILABLE: ${err instanceof Error ? err.message : String(err)}`);
  }

  const treasuryAddress = configuredTreasuryAddress
    || process.env.TREASURY_ADDRESS
    || signerAddress;
  return {
    tokenContractAddress,
    chainId,
    treasuryAddress: treasuryAddress ? treasuryAddress.toLowerCase() : null,
    signerAddress,
  };
}

export function assetContextMismatch(
  storedIntentContext: Record<string, unknown> | null | undefined,
  current: TokenAssetContext,
): string | undefined {
  const stored = storedIntentContext?.assetContext;
  if (!stored || typeof stored !== 'object') {
    return 'original token asset context is unavailable; operator review is required';
  }
  const asset = stored as Record<string, unknown>;
  const storedContract = typeof asset.tokenContractAddress === 'string'
    ? asset.tokenContractAddress.toLowerCase()
    : undefined;
  const storedChain = asset.chainId === undefined || asset.chainId === null
    ? undefined
    : String(asset.chainId);
  const storedTreasury = typeof asset.treasuryAddress === 'string'
    ? asset.treasuryAddress.toLowerCase()
    : asset.treasuryAddress === null ? null : undefined;
  const storedSigner = typeof asset.signerAddress === 'string'
    ? asset.signerAddress.toLowerCase()
    : undefined;
  const currentTreasury = current.treasuryAddress
    ? current.treasuryAddress.toLowerCase()
    : null;

  if (!storedContract || storedChain === undefined || storedTreasury === undefined || !storedSigner) {
    return 'original token asset context is incomplete; operator review is required';
  }

  if (storedContract && storedContract !== current.tokenContractAddress.toLowerCase()) {
    return `token contract changed from ${storedContract} to ${current.tokenContractAddress}`;
  }
  if (storedChain && storedChain !== current.chainId) {
    return `chain changed from ${storedChain} to ${current.chainId}`;
  }
  if (storedTreasury !== undefined && storedTreasury !== currentTreasury) {
    return `treasury changed from ${storedTreasury || 'none'} to ${currentTreasury || 'none'}`;
  }
  if (storedSigner !== current.signerAddress.toLowerCase()) {
    return `signer changed from ${storedSigner} to ${current.signerAddress}`;
  }
  return undefined;
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map(key => {
      const nested = (value as Record<string, unknown>)[key];
      return `${JSON.stringify(key)}:${canonicalize(nested)}`;
    }).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function tokenIntentFingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

/** A length-delimited tuple avoids the collision risk of `${a}-${b}`. */
export function awardOperationKey(providerId: string, sessionId: string): string {
  const tuple = `${providerId.length}:${providerId}${sessionId.length}:${sessionId}`;
  return `award:${createHash('sha256').update(tuple).digest('hex')}`;
}

export function awardIntentFingerprint(
  session: NormalisedSession,
  amount: number,
  walletAddress: string
): string {
  return tokenIntentFingerprint({
    providerId: session.providerId,
    sessionId: session.sessionId,
    uid: session.uid,
    walletAddress: walletAddress.toLowerCase(),
    evseId: session.evseId,
    startTime: session.startTime.toISOString(),
    endTime: session.endTime.toISOString(),
    energyKWh: session.energyKWh,
    energyDirection: session.energyDirection,
    cdrId: session.cdrId || null,
    reservationSessionId: session.reservationSessionId || null,
    timeZone: session.timeZone || null,
    timeZoneSource: session.timeZoneSource || null,
  });
}

export function reservationOperationKey(reservationId: string): string {
  return `reservation:${reservationId}`;
}

export function spendOperationKey(uid: string, idempotencyKey: string): string {
  const tuple = `${uid.length}:${uid}${idempotencyKey.length}:${idempotencyKey}`;
  return `spend:${createHash('sha256').update(tuple).digest('hex')}`;
}

export function spendIntentFingerprint(input: {
  uid: string;
  walletAddress: string;
  amount: number;
  sessionId?: string | null;
  providerId?: string | null;
  reservationId?: string | null;
  idempotencyKey?: string | null;
}): string {
  const amount = canonicalTokenAmount(input.amount);
  if (!amount) throw new Error('UNSUPPORTED_TOKEN_PRECISION');
  return tokenIntentFingerprint({
    uid: input.uid,
    walletAddress: input.walletAddress.toLowerCase(),
    amount: amount.decimal,
    sessionId: input.sessionId || null,
    providerId: input.providerId || null,
    reservationId: input.reservationId || null,
  });
}
