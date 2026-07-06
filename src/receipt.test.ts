import { ethers } from 'ethers';
import {
  canonicalizeReceiptPayload,
  createSpendReceiptPayload,
  signSpendReceipt,
  verifySpendReceipt,
} from './receipt';

describe('spend receipts', () => {
  const signer = ethers.Wallet.createRandom();

  it('signs and verifies a settled spend receipt', async () => {
    const payload = createSpendReceiptPayload({
      contractId: 'contract-123',
      walletAddress: '0x1111111111111111111111111111111111111111',
      amount: 5,
      sessionId: 'session-1',
      providerId: 'provider-a',
      tokenTxHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      tokenContractAddress: '0x2222222222222222222222222222222222222222',
      chainId: 80002,
      issuedAt: new Date('2026-07-06T12:00:00.000Z'),
    });

    const signed = await signSpendReceipt(payload, signer);

    expect(signed.payload.status).toBe('settled');
    expect(signed.payload.receiptId).toMatch(/^spr_[a-f0-9]{24}$/);
    expect(verifySpendReceipt(payload, signed.signature, signer.address)).toBe(true);
  });

  it('rejects tampered receipt payloads', async () => {
    const payload = createSpendReceiptPayload({
      contractId: 'contract-123',
      walletAddress: '0x1111111111111111111111111111111111111111',
      amount: 5,
      tokenTxHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      tokenContractAddress: '0x2222222222222222222222222222222222222222',
      chainId: 80002,
      issuedAt: new Date('2026-07-06T12:00:00.000Z'),
    });
    const signed = await signSpendReceipt(payload, signer);

    const tampered = {
      ...payload,
      amount: '50',
    };

    expect(verifySpendReceipt(tampered, signed.signature, signer.address)).toBe(false);
  });

  it('canonicalizes payload keys in stable order', () => {
    const payload = createSpendReceiptPayload({
      contractId: 'contract-123',
      walletAddress: '0x1111111111111111111111111111111111111111',
      amount: '7',
      tokenTxHash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      tokenContractAddress: '0x2222222222222222222222222222222222222222',
      chainId: 80002,
      issuedAt: new Date('2026-07-06T12:00:00.000Z'),
    });

    const canonical = canonicalizeReceiptPayload(payload);

    expect(canonical.indexOf('"amount"')).toBeLessThan(canonical.indexOf('"chainId"'));
    expect(canonical.indexOf('"receiptId"')).toBeLessThan(canonical.indexOf('"sessionId"'));
  });
});
