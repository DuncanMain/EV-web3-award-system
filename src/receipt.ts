import { createHash, randomUUID } from 'crypto';
import { ethers } from 'ethers';

export type SpendReceiptStatus = 'reserved' | 'settled' | 'rejected' | 'expired' | 'cancelled';

export interface SpendReceiptPayload {
  version: '1.0';
  receiptId: string;
  status: SpendReceiptStatus;
  contractId: string;
  walletAddress: string;
  amount: string;
  sessionId?: string | null;
  providerId?: string | null;
  tokenTxHash: string;
  tokenContractAddress: string;
  chainId: number;
  issuedAt: string;
}

export interface SignedSpendReceipt {
  payload: SpendReceiptPayload;
  signature: string;
  signerAddress: string;
  canonicalPayload: string;
}

function sortForCanonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortForCanonicalJson);
  }

  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        const nested = (value as Record<string, unknown>)[key];
        if (nested !== undefined) {
          acc[key] = sortForCanonicalJson(nested);
        }
        return acc;
      }, {});
  }

  return value;
}

export function canonicalizeReceiptPayload(payload: SpendReceiptPayload): string {
  return JSON.stringify(sortForCanonicalJson(payload));
}

export function createSpendReceiptPayload(input: {
  contractId: string;
  walletAddress: string;
  amount: number | string;
  sessionId?: string | null;
  providerId?: string | null;
  tokenTxHash: string;
  tokenContractAddress: string;
  chainId: number;
  issuedAt?: Date;
  status?: SpendReceiptStatus;
}): SpendReceiptPayload {
  const issuedAt = input.issuedAt || new Date();
  const receiptSeed = [
    input.contractId,
    input.walletAddress.toLowerCase(),
    input.amount.toString(),
    input.sessionId || '',
    input.providerId || '',
    input.tokenTxHash.toLowerCase(),
    issuedAt.toISOString(),
    randomUUID(),
  ].join('|');
  const digest = createHash('sha256').update(receiptSeed).digest('hex').slice(0, 24);

  return {
    version: '1.0',
    receiptId: `spr_${digest}`,
    status: input.status || 'settled',
    contractId: input.contractId,
    walletAddress: ethers.getAddress(input.walletAddress),
    amount: input.amount.toString(),
    sessionId: input.sessionId || null,
    providerId: input.providerId || null,
    tokenTxHash: input.tokenTxHash,
    tokenContractAddress: ethers.getAddress(input.tokenContractAddress),
    chainId: input.chainId,
    issuedAt: issuedAt.toISOString(),
  };
}

export async function signSpendReceipt(
  payload: SpendReceiptPayload,
  signer: ethers.Signer
): Promise<SignedSpendReceipt> {
  const canonicalPayload = canonicalizeReceiptPayload(payload);
  const signature = await signer.signMessage(canonicalPayload);
  const signerAddress = await signer.getAddress();

  return {
    payload,
    signature,
    signerAddress,
    canonicalPayload,
  };
}

export function verifySpendReceipt(
  payload: SpendReceiptPayload,
  signature: string,
  expectedSignerAddress: string
): boolean {
  const recovered = ethers.verifyMessage(canonicalizeReceiptPayload(payload), signature);
  return recovered.toLowerCase() === expectedSignerAddress.toLowerCase();
}
