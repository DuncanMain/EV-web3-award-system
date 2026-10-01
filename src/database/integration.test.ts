import { ethers } from 'ethers';
import { approveUserForSpendingViaFunding } from './integration';

jest.mock('../user/userService', () => ({
  generateDeterministicWallet: jest.fn(() => ({
    address: '0x1111111111111111111111111111111111111111',
    connect: jest.fn(),
  })),
}));

jest.mock('./service', () => ({
  ApprovalPreparations: {
    claim: jest.fn().mockResolvedValue({
      acquired: true,
      record: { status: 'funding' },
    }),
    markFundingSubmitted: jest.fn().mockResolvedValue(undefined),
    markFunded: jest.fn().mockResolvedValue(undefined),
    claimFundingTopUp: jest.fn().mockResolvedValue({ acquired: true, record: { status: 'funding' } }),
    recoverFundedAfterReadOnlyProof: jest.fn().mockResolvedValue(undefined),
    findByKey: jest.fn(),
    markApproving: jest.fn().mockResolvedValue(undefined),
    claimApprovalSubmission: jest.fn().mockResolvedValue({
      acquired: true,
      record: { status: 'approving' },
    }),
    markApprovalSubmitted: jest.fn().mockResolvedValue(undefined),
    markApproved: jest.fn().mockResolvedValue(undefined),
    markUnknown: jest.fn().mockResolvedValue(undefined),
  },
}));

describe('managed-wallet approval preparation', () => {
  const allowanceInterface = new ethers.Interface([
    'function allowance(address owner,address spender) view returns (uint256)',
  ]);
  const userSendTransaction = jest.fn();
  const treasurySendTransaction = jest.fn();
  const provider = {
    getNetwork: jest.fn().mockResolvedValue({ chainId: 80002n }),
    getBalance: jest.fn(),
    estimateGas: jest.fn().mockResolvedValue(50_000n),
    getFeeData: jest.fn().mockResolvedValue({ maxFeePerGas: 1_000_000_000n, gasPrice: 1_000_000_000n }),
    getTransactionReceipt: jest.fn(),
    getTransaction: jest.fn(),
    getTransactionCount: jest.fn().mockResolvedValue(0),
    call: jest.fn(async (transaction: { data?: string }) => allowanceInterface.encodeFunctionResult('allowance', [0n])),
  } as unknown as ethers.Provider;
  const treasurySigner = {
    provider,
    getAddress: jest.fn().mockResolvedValue('0x2222222222222222222222222222222222222222'),
    sendTransaction: treasurySendTransaction,
  } as unknown as ethers.Signer;
  const userSigner = { sendTransaction: userSendTransaction };

  beforeEach(() => {
    jest.clearAllMocks();
    const preparations = require('./service').ApprovalPreparations;
    preparations.claim.mockResolvedValue({ acquired: true, record: { status: 'funding' } });
    preparations.claimApprovalSubmission.mockResolvedValue({ acquired: true, record: { status: 'approving' } });
    preparations.recoverFundedAfterReadOnlyProof.mockResolvedValue(undefined);
    preparations.claimFundingTopUp.mockResolvedValue({ acquired: true, record: { status: 'funding' } });
    preparations.findByKey.mockResolvedValue(undefined);
    process.env.TOKEN_CONTRACT_ADDRESS = '0x605871D30DC278a036F09e2ace771df8a224624B';
    const walletModule = require('../user/userService');
    walletModule.generateDeterministicWallet.mockReturnValue({
      address: '0x1111111111111111111111111111111111111111',
      connect: jest.fn(() => userSigner),
    });
    provider.getBalance = jest.fn().mockResolvedValue(ethers.parseEther('0.01'));
    userSendTransaction.mockResolvedValue({
      hash: `0x${'a'.repeat(64)}`,
      wait: jest.fn().mockResolvedValue({ status: 1 }),
    });
    treasurySendTransaction.mockResolvedValue({
      hash: `0x${'b'.repeat(64)}`,
      wait: jest.fn().mockResolvedValue({ status: 1 }),
    });
  });

  it('checks native balance and avoids unnecessary repeated gas funding', async () => {
    await approveUserForSpendingViaFunding(
      'managed-user',
      treasurySigner,
      '0x2222222222222222222222222222222222222222',
      5,
    );

    expect(treasurySendTransaction).not.toHaveBeenCalled();
    expect(userSendTransaction).toHaveBeenCalledTimes(1);
  });

  it('does not retry an ambiguous funding submission automatically', async () => {
    provider.getBalance = jest.fn().mockResolvedValue(0n);
    treasurySendTransaction.mockResolvedValueOnce({
      hash: `0x${'c'.repeat(64)}`,
      wait: jest.fn().mockRejectedValue(new Error('RPC dropped after funding broadcast')),
    });

    await expect(approveUserForSpendingViaFunding(
      'ambiguous-user',
      treasurySigner,
      '0x2222222222222222222222222222222222222222',
      5,
    )).rejects.toThrow('RPC dropped after funding broadcast');

    expect(treasurySendTransaction).toHaveBeenCalledTimes(1);
    expect(userSendTransaction).not.toHaveBeenCalled();
  });

  it('blocks a later request when durable funding state remains ambiguous', async () => {
    provider.getBalance = jest.fn().mockResolvedValue(0n);
    const preparations = require('./service').ApprovalPreparations;
    preparations.claim.mockResolvedValue({
      acquired: false,
      record: { status: 'unknown', error_message: 'funding response was lost' },
    });

    await expect(approveUserForSpendingViaFunding(
      'ambiguous-retry-user',
      treasurySigner,
      '0x2222222222222222222222222222222222222222',
      5,
    )).rejects.toMatchObject({
      code: 'APPROVAL_PREPARATION_REVIEW_REQUIRED',
      requiresReview: true,
      pending: true,
    });

    expect(treasurySendTransaction).not.toHaveBeenCalled();
    expect(userSendTransaction).not.toHaveBeenCalled();
  });

  it('resumes a legacy unknown approval only after read-only funding and nonce proof', async () => {
    const preparations = require('./service').ApprovalPreparations;
    const fundingHash = `0x${'f'.repeat(64)}`;
    preparations.claim.mockResolvedValue({
      acquired: false,
      record: {
        status: 'unknown',
        funding_tx_hash: fundingHash,
        approval_tx_hash: null,
      },
    });
    preparations.recoverFundedAfterReadOnlyProof.mockResolvedValue({ status: 'funded' });
    provider.getTransactionReceipt = jest.fn().mockResolvedValue({
      status: 1,
      from: '0x2222222222222222222222222222222222222222',
      to: '0x1111111111111111111111111111111111111111',
    });
    provider.getTransaction = jest.fn().mockResolvedValue({
      hash: fundingHash,
      from: '0x2222222222222222222222222222222222222222',
      to: '0x1111111111111111111111111111111111111111',
      value: ethers.parseEther('0.005'),
    });
    provider.getTransactionCount = jest.fn().mockResolvedValue(0);
    provider.getBalance = jest.fn().mockResolvedValue(ethers.parseEther('0.01'));

    await approveUserForSpendingViaFunding(
      'legacy-unknown-user',
      treasurySigner,
      '0x2222222222222222222222222222222222222222',
      5,
    );

    expect(preparations.recoverFundedAfterReadOnlyProof).toHaveBeenCalledTimes(1);
    expect(userSendTransaction).toHaveBeenCalledTimes(1);
    expect(treasurySendTransaction).not.toHaveBeenCalled();
  });

  it('tops up recovered funding to the measured target before approving', async () => {
    const preparations = require('./service').ApprovalPreparations;
    const fundingHash = `0x${'f'.repeat(64)}`;
    preparations.claim.mockResolvedValue({
      acquired: false,
      record: { status: 'unknown', funding_tx_hash: fundingHash, approval_tx_hash: null },
    });
    preparations.recoverFundedAfterReadOnlyProof.mockResolvedValue({
      status: 'funded',
      funding_tx_hash: fundingHash,
      approval_tx_hash: null,
    });
    preparations.claimFundingTopUp.mockResolvedValue({ acquired: true, record: { status: 'funding' } });
    provider.getTransactionReceipt = jest.fn().mockResolvedValue({
      status: 1,
      from: '0x2222222222222222222222222222222222222222',
      to: '0x1111111111111111111111111111111111111111',
    });
    provider.getTransaction = jest.fn().mockResolvedValue({
      hash: fundingHash,
      from: '0x2222222222222222222222222222222222222222',
      to: '0x1111111111111111111111111111111111111111',
      value: ethers.parseEther('0.005'),
    });
    provider.getTransactionCount = jest.fn().mockResolvedValue(0);
    provider.getBalance = jest.fn().mockResolvedValue(ethers.parseEther('0.005'));
    provider.estimateGas = jest.fn().mockResolvedValue(100_000n);
    provider.getFeeData = jest.fn().mockResolvedValue({ maxFeePerGas: 100_000_000_000n, gasPrice: null });

    await approveUserForSpendingViaFunding(
      'legacy-underfunded-user',
      treasurySigner,
      '0x2222222222222222222222222222222222222222',
      5,
    );

    expect(preparations.claimFundingTopUp).toHaveBeenCalledTimes(1);
    expect(treasurySendTransaction).toHaveBeenCalledWith(expect.objectContaining({
      value: 15_000_000_000_000_000n,
    }));
    expect(userSendTransaction).toHaveBeenCalledTimes(1);
  });

  it('does not fund when another process owns the durable top-up claim', async () => {
    const preparations = require('./service').ApprovalPreparations;
    preparations.claim.mockResolvedValue({
      acquired: false,
      record: {
        status: 'funded',
        funding_tx_hash: `0x${'f'.repeat(64)}`,
        approval_tx_hash: null,
      },
    });
    preparations.claimFundingTopUp.mockResolvedValue({
      acquired: false,
      record: {
        status: 'funding',
        funding_tx_hash: `0x${'f'.repeat(64)}`,
        approval_tx_hash: null,
      },
    });
    provider.getBalance = jest.fn().mockResolvedValue(ethers.parseEther('0.005'));
    provider.estimateGas = jest.fn().mockResolvedValue(100_000n);
    provider.getFeeData = jest.fn().mockResolvedValue({ maxFeePerGas: 100_000_000_000n, gasPrice: null });

    await expect(approveUserForSpendingViaFunding(
      'top-up-loser-user',
      treasurySigner,
      '0x2222222222222222222222222222222222222222',
      5,
    )).rejects.toMatchObject({
      code: 'APPROVAL_PREPARATION_REVIEW_REQUIRED',
      requiresReview: true,
      pending: true,
      stage: 'funding',
    });

    expect(treasurySendTransaction).not.toHaveBeenCalled();
    expect(userSendTransaction).not.toHaveBeenCalled();
  });

  it('keeps an unknown approval blocked when the managed-wallet nonce moved', async () => {
    const preparations = require('./service').ApprovalPreparations;
    const fundingHash = `0x${'f'.repeat(64)}`;
    preparations.claim.mockResolvedValue({
      acquired: false,
      record: { status: 'unknown', funding_tx_hash: fundingHash, approval_tx_hash: null },
    });
    provider.getTransactionReceipt = jest.fn().mockResolvedValue({
      status: 1,
      from: '0x2222222222222222222222222222222222222222',
      to: '0x1111111111111111111111111111111111111111',
    });
    provider.getTransaction = jest.fn().mockResolvedValue({
      hash: fundingHash,
      from: '0x2222222222222222222222222222222222222222',
      to: '0x1111111111111111111111111111111111111111',
      value: ethers.parseEther('0.005'),
    });
    provider.getTransactionCount = jest.fn().mockResolvedValue(1);

    await expect(approveUserForSpendingViaFunding(
      'nonce-moved-user',
      treasurySigner,
      '0x2222222222222222222222222222222222222222',
      5,
    )).rejects.toMatchObject({
      code: 'APPROVAL_PREPARATION_REVIEW_REQUIRED',
      requiresReview: true,
      pending: true,
    });

    expect(preparations.recoverFundedAfterReadOnlyProof).not.toHaveBeenCalled();
    expect(userSendTransaction).not.toHaveBeenCalled();
  });

  it('funds the measured buffered approval gas target instead of a fixed amount', async () => {
    const preparations = require('./service').ApprovalPreparations;
    provider.getBalance = jest.fn().mockResolvedValue(0n);
    provider.estimateGas = jest.fn().mockResolvedValue(100_000n);
    provider.getFeeData = jest.fn().mockResolvedValue({ maxFeePerGas: 1_000_000_000n, gasPrice: null });

    await approveUserForSpendingViaFunding(
      'measured-gas-user',
      treasurySigner,
      '0x2222222222222222222222222222222222222222',
      5,
    );

    expect(treasurySendTransaction).toHaveBeenCalledWith(expect.objectContaining({
      value: 200_000_000_000_000n,
    }));
    expect(preparations.markFundingSubmitted).toHaveBeenCalledTimes(1);
  });

  it('serializes concurrent preparation calls and keeps the second call from funding again', async () => {
    provider.getBalance = jest.fn().mockResolvedValue(0n);
    const preparations = require('./service').ApprovalPreparations;
    let claimCount = 0;
    preparations.claim.mockImplementation(async () => {
      claimCount += 1;
      return claimCount === 1
        ? { acquired: true, record: { status: 'funding' } }
        : { acquired: false, record: { status: 'unknown', error_message: 'first call unresolved' } };
    });
    treasurySendTransaction.mockResolvedValueOnce({
      hash: `0x${'d'.repeat(64)}`,
      wait: jest.fn().mockRejectedValue(new Error('funding receipt unavailable')),
    });

    const results = await Promise.allSettled([
      approveUserForSpendingViaFunding('concurrent-approval', treasurySigner, '0x2222222222222222222222222222222222222222', 5),
      approveUserForSpendingViaFunding('concurrent-approval', treasurySigner, '0x2222222222222222222222222222222222222222', 5),
    ]);
    expect(results.every(result => result.status === 'rejected')).toBe(true);
    expect(treasurySendTransaction).toHaveBeenCalledTimes(1);
    expect(userSendTransaction).not.toHaveBeenCalled();
  });

  it('requires review when another process atomically owns the funded approval claim', async () => {
    provider.getBalance = jest.fn().mockResolvedValue(ethers.parseEther('0.01'));
    const preparations = require('./service').ApprovalPreparations;
    preparations.claim.mockResolvedValueOnce({ acquired: true, record: { status: 'funding' } });
    preparations.claimApprovalSubmission.mockResolvedValueOnce({
      acquired: false,
      record: {
        status: 'approving',
        approval_tx_hash: null,
        funding_tx_hash: `0x${'e'.repeat(64)}`,
      },
    });

    await expect(approveUserForSpendingViaFunding(
      'funded-loser-user',
      treasurySigner,
      '0x2222222222222222222222222222222222222222',
      5,
    )).rejects.toMatchObject({
      code: 'APPROVAL_PREPARATION_REVIEW_REQUIRED',
      pending: true,
      requiresReview: true,
      preflightFailure: false,
      retryable: false,
    });

    expect(userSendTransaction).not.toHaveBeenCalled();
  });

  it('returns structured review state on the first ambiguous approval failure', async () => {
    provider.getBalance = jest.fn().mockResolvedValue(ethers.parseEther('0.01'));
    const preparations = require('./service').ApprovalPreparations;
    preparations.claimApprovalSubmission.mockResolvedValueOnce({
      acquired: true,
      record: { status: 'approving' },
    });
    userSendTransaction.mockRejectedValueOnce(new Error('approval RPC dropped after broadcast'));

    await expect(approveUserForSpendingViaFunding(
      'first-review-user',
      treasurySigner,
      '0x2222222222222222222222222222222222222222',
      5,
    )).rejects.toMatchObject({
      code: 'APPROVAL_PREPARATION_REVIEW_REQUIRED',
      pending: true,
      requiresReview: true,
      preflightFailure: false,
      retryable: false,
      stage: 'approval',
    });
  });
});
