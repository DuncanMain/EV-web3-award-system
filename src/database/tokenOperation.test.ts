import { ethers } from 'ethers';
import {
  assetContextMismatch,
  canonicalTokenAmount,
  canonicalTransactionHash,
  getTokenAssetContext,
  requireCanonicalTransactionHash,
  requireUnambiguousTransactionMatch,
  spendIntentFingerprint,
  truncateTokenAmount,
} from './tokenOperation';

describe('token operation intent and asset context', () => {
  const signerAddress = '0x9999999999999999999999999999999999999999';
  const token = '0x605871D30DC278a036F09e2ace771df8a224624B';
  const treasury = '0x8888888888888888888888888888888888888888';

  beforeEach(() => {
    process.env.CHAIN_ID = '80002';
    process.env.TOKEN_CONTRACT_ADDRESS = token;
    process.env.TREASURY_ADDRESS = treasury;
  });

  it.each([
    [2.3, '2.30', 230n],
    ['19.99', '19.99', 1999n],
    ['0', '0.00', 0n],
  ])('canonicalises exact token amount %p', (input, decimal, units) => {
    expect(canonicalTokenAmount(input)).toMatchObject({ decimal, units });
  });

  it('rejects excess precision and floating point artifacts instead of rounding them', () => {
    expect(canonicalTokenAmount(0.005)).toBeUndefined();
    expect(canonicalTokenAmount(0.1 + 0.2)).toBeUndefined();
    expect(canonicalTokenAmount('1e-2')).toBeUndefined();
    expect(truncateTokenAmount('0.005')).toMatchObject({ decimal: '0.00', units: 0n });
    expect(truncateTokenAmount('19.999')).toMatchObject({ decimal: '19.99', units: 1999n });
  });

  it('accepts only canonical 32-byte transaction hashes and never treats a UID as one', () => {
    const mixedCase = `0x${'Ab'.repeat(32)}`;
    expect(canonicalTransactionHash(`  ${mixedCase} `)).toBe(mixedCase.toLowerCase());
    expect(canonicalTransactionHash('uid-only-contract')).toBeUndefined();
    expect(canonicalTransactionHash(`0x${'a'.repeat(63)}`)).toBeUndefined();
    expect(() => requireCanonicalTransactionHash('uid-only-contract')).toThrow('INVALID_TRANSACTION_HASH');
  });

  it('fails closed when a legacy projection hash resolves to more than one row', () => {
    expect(requireUnambiguousTransactionMatch([{ id: 1 }], 'award')).toEqual({ id: 1 });
    expect(() => requireUnambiguousTransactionMatch([{ id: 1 }, { id: 2 }], 'spend'))
      .toThrow('SPEND_TX_HASH_AMBIGUOUS_REVIEW');
    expect(() => requireUnambiguousTransactionMatch([{ id: 1 }, { id: 2 }], 'receipt'))
      .toThrow('RECEIPT_TX_HASH_AMBIGUOUS_REVIEW');
    expect(() => requireUnambiguousTransactionMatch([{ id: 1 }, { id: 2 }], 'operation'))
      .toThrow('OPERATION_TX_HASH_AMBIGUOUS_REVIEW');
  });

  it('does not include the caller idempotency key in the spend financial fingerprint', () => {
    const base = {
      uid: 'contract-1',
      walletAddress: signerAddress,
      amount: 2.3,
      sessionId: 'session-1',
      providerId: 'provider-1',
    };
    expect(spendIntentFingerprint({ ...base, idempotencyKey: 'caller-key' }))
      .toBe(spendIntentFingerprint({ ...base }));
  });

  it('preserves the pre-guard award fingerprint regardless of physical-session metadata', () => {
    const base = {
      sessionId: 'cdr-001',
      providerId: 'provider-1',
      uid: 'contract-1',
      walletAddress: signerAddress,
      evseId: 'DE*NVF*E*001',
      startTime: new Date('2026-09-14T05:00:00Z'),
      endTime: new Date('2026-09-14T06:00:00Z'),
      energyKWh: 4,
      energyDirection: 'CHARGE' as const,
    };
    const { awardIntentFingerprint } = require('./tokenOperation') as typeof import('./tokenOperation');
    const legacy = awardIntentFingerprint(base, 1, signerAddress);
    expect(awardIntentFingerprint({ ...base, chargingSessionId: 'physical-001' }, 1, signerAddress))
      .toBe(legacy);
    expect(awardIntentFingerprint({ ...base, chargingSessionId: 'physical-002' }, 1, signerAddress))
      .toBe(legacy);
  });

  it('freezes the configured asset and signer context', async () => {
    const signer = {
      getAddress: jest.fn().mockResolvedValue(signerAddress),
      provider: { getNetwork: jest.fn().mockResolvedValue({ chainId: 80002n }) },
    } as unknown as ethers.Signer;
    await expect(getTokenAssetContext(signer, treasury)).resolves.toEqual({
      tokenContractAddress: token.toLowerCase(),
      chainId: '80002',
      treasuryAddress: treasury.toLowerCase(),
      signerAddress: signerAddress.toLowerCase(),
    });
  });

  it('rejects configured chain mismatches and provider failures', async () => {
    const mismatchSigner = {
      getAddress: jest.fn().mockResolvedValue(signerAddress),
      provider: { getNetwork: jest.fn().mockResolvedValue({ chainId: 1n }) },
    } as unknown as ethers.Signer;
    await expect(getTokenAssetContext(mismatchSigner, treasury))
      .rejects.toThrow('CONFIGURED_CHAIN_MISMATCH');

    const failedSigner = {
      getAddress: jest.fn().mockResolvedValue(signerAddress),
      provider: { getNetwork: jest.fn().mockRejectedValue(new Error('RPC unavailable')) },
    } as unknown as ethers.Signer;
    await expect(getTokenAssetContext(failedSigner, treasury))
      .rejects.toThrow('CHAIN_CONTEXT_UNAVAILABLE');

    const providerlessSigner = {
      getAddress: jest.fn().mockResolvedValue(signerAddress),
    } as unknown as ethers.Signer;
    await expect(getTokenAssetContext(providerlessSigner, treasury))
      .rejects.toThrow('CHAIN_CONTEXT_UNAVAILABLE');
  });

  it('blocks recovery when the saved contract, chain, signer, or treasury changed', () => {
    const saved = { assetContext: {
      tokenContractAddress: token,
      chainId: '80002',
      treasuryAddress: treasury,
      signerAddress,
    } };
    expect(assetContextMismatch(saved, {
      tokenContractAddress: token.toLowerCase(),
      chainId: '80002',
      treasuryAddress: treasury.toLowerCase(),
      signerAddress: signerAddress.toLowerCase(),
    })).toBeUndefined();
    expect(assetContextMismatch(saved, {
      tokenContractAddress: '0x7777777777777777777777777777777777777777',
      chainId: '80002',
      treasuryAddress: treasury,
      signerAddress,
    })).toContain('token contract changed');
    expect(assetContextMismatch(saved, {
      tokenContractAddress: token,
      chainId: '1',
      treasuryAddress: treasury,
      signerAddress,
    })).toContain('chain changed');
    expect(assetContextMismatch(saved, {
      tokenContractAddress: token,
      chainId: '80002',
      treasuryAddress: signerAddress,
      signerAddress,
    })).toContain('treasury changed');
    expect(assetContextMismatch(saved, {
      tokenContractAddress: token,
      chainId: '80002',
      treasuryAddress: treasury,
      signerAddress: '0x6666666666666666666666666666666666666666',
    })).toContain('signer changed');
  });
});
