import { ethers } from 'ethers';
import { approveUserForSpendingViaFunding, moveFundsFromManagedWallet, revokeAllowanceOnManagedWallet } from './integration';
import { TransactionReliabilityError } from '../transactionReliability';

jest.mock('../spendEvidence', () => ({
  verifySpendEvidence: jest.fn(),
}));

jest.mock('../user/userService', () => ({
  generateDeterministicWallet: jest.fn(() => ({
    address: '0x1111111111111111111111111111111111111111',
    connect: jest.fn(),
  })),
}));

jest.mock('./service', () => ({
  TreasuryTransactions: {
    findByOperationKey: jest.fn().mockResolvedValue(undefined),
    prepare: jest.fn(async (request: any) => {
      const nonce = await request.getPendingNonce();
      const prepared = await request.prepare(nonce);
      return {
        alreadyPrepared: false,
        rawTransaction: prepared.rawTransaction,
        lease: {
          operation_key: request.operationKey,
          chain_id: String(request.chainId),
          signer_address: '0x2222222222222222222222222222222222222222',
          nonce,
          tx_hash: prepared.txHash,
          tx_context: prepared.context,
        },
      };
    }),
    markSubmitted: jest.fn().mockResolvedValue(undefined),
    markUnknown: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
  },
  ApprovalPreparations: {
    claim: jest.fn().mockResolvedValue({
      acquired: true,
      record: { status: 'funding' },
    }),
    markFundingSubmitted: jest.fn().mockResolvedValue(undefined),
    markFundingPreflightFailed: jest.fn().mockResolvedValue(undefined),
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
  const treasuryBroadcastTransaction = jest.fn();
  const treasurySignTransaction = jest.fn();
  const provider = {
    getNetwork: jest.fn().mockResolvedValue({ chainId: 80002n }),
    getBalance: jest.fn(),
    estimateGas: jest.fn().mockResolvedValue(50_000n),
    getFeeData: jest.fn().mockResolvedValue({ maxFeePerGas: 1_000_000_000n, gasPrice: 1_000_000_000n }),
    getTransactionReceipt: jest.fn(),
    getTransaction: jest.fn(),
    getTransactionCount: jest.fn().mockResolvedValue(0),
    broadcastTransaction: treasuryBroadcastTransaction,
    waitForTransaction: jest.fn().mockResolvedValue({ status: 1 }),
    call: jest.fn(async (transaction: { data?: string }) => allowanceInterface.encodeFunctionResult('allowance', [0n])),
  } as unknown as ethers.Provider;
  const treasurySigner = {
    provider,
    getAddress: jest.fn().mockResolvedValue('0x2222222222222222222222222222222222222222'),
    sendTransaction: treasurySendTransaction,
    signTransaction: treasurySignTransaction,
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
    const treasury = require('./service').TreasuryTransactions;
    treasury.findByOperationKey.mockResolvedValue(undefined);
    process.env.TOKEN_CONTRACT_ADDRESS = '0x605871D30DC278a036F09e2ace771df8a224624B';
    const walletModule = require('../user/userService');
    walletModule.generateDeterministicWallet.mockReturnValue({
      address: '0x1111111111111111111111111111111111111111',
      connect: jest.fn(() => userSigner),
    });
    provider.getBalance = jest.fn().mockResolvedValue(ethers.parseEther('0.01'));
    provider.estimateGas = jest.fn().mockResolvedValue(50_000n);
    provider.getFeeData = jest.fn().mockResolvedValue({ maxFeePerGas: 1_000_000_000n, gasPrice: 1_000_000_000n });
    provider.waitForTransaction = jest.fn().mockResolvedValue({ status: 1 });
    userSendTransaction.mockResolvedValue({
      hash: `0x${'a'.repeat(64)}`,
      wait: jest.fn().mockResolvedValue({ status: 1 }),
    });
    treasurySendTransaction.mockResolvedValue({
      hash: `0x${'b'.repeat(64)}`,
      wait: jest.fn().mockResolvedValue({ status: 1 }),
    });
    treasurySignTransaction.mockResolvedValue('0x1234');
    treasuryBroadcastTransaction.mockResolvedValue({ hash: ethers.keccak256('0x1234') });
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
    treasuryBroadcastTransaction.mockRejectedValueOnce(new Error('RPC dropped after funding broadcast'));

    await expect(approveUserForSpendingViaFunding(
      'ambiguous-user',
      treasurySigner,
      '0x2222222222222222222222222222222222222222',
      5,
    )).rejects.toThrow('CHAIN_OUTCOME_UNKNOWN');

    expect(treasuryBroadcastTransaction).toHaveBeenCalledTimes(1);
    expect(userSendTransaction).not.toHaveBeenCalled();
  });

  it('propagates sanitized funding diagnostics through the approval recovery error', async () => {
    provider.getBalance = jest.fn().mockResolvedValue(0n);
    const diagnostic = {
      stage: 'prepare' as const,
      errorCode: 'RPC_READ_UNAVAILABLE',
      retryable: true,
      category: 'rpc_unavailable' as const,
      rpcMethod: 'eth_estimateGas',
      providerCode: 'SERVER_ERROR',
      rpcCode: 19,
      httpStatus: 500,
      traceId: 'trace-funding-1',
    };
    const treasury = require('./service').TreasuryTransactions;
    treasury.prepare.mockRejectedValueOnce(new TransactionReliabilityError(diagnostic));
    const preparations = require('./service').ApprovalPreparations;

    await expect(approveUserForSpendingViaFunding(
      'structured-funding-error-user',
      treasurySigner,
      '0x2222222222222222222222222222222222222222',
      5,
    )).rejects.toMatchObject({
      diagnostic,
      stage: 'funding',
      retryable: true,
      preflightFailure: true,
    });
    expect(preparations.markFundingPreflightFailed).toHaveBeenCalledWith(
      expect.any(String),
      'RPC_READ_UNAVAILABLE',
      diagnostic,
    );
  });

  it('persists a precise saved funding hash and receipt diagnostic', async () => {
    provider.getBalance = jest.fn().mockResolvedValue(0n);
    provider.waitForTransaction = jest.fn().mockRejectedValue(new Error('receipt lookup failed'));
    const preparations = require('./service').ApprovalPreparations;

    await expect(approveUserForSpendingViaFunding(
      'structured-receipt-error-user',
      treasurySigner,
      '0x2222222222222222222222222222222222222222',
      5,
    )).rejects.toMatchObject({
      stage: 'funding',
      fundingTxHash: expect.any(String),
      diagnostic: expect.objectContaining({
        stage: 'receipt',
        rpcMethod: 'provider.waitForTransaction',
        errorCode: 'RECEIPT_READ_UNAVAILABLE',
        savedHash: expect.any(String),
      }),
    });
    expect(preparations.markUnknown).toHaveBeenCalledWith(
      expect.any(String),
      expect.stringContaining('funding confirmation outcome is unknown'),
      expect.objectContaining({
        fundingTxHash: expect.any(String),
        diagnostic: expect.objectContaining({ stage: 'receipt' }),
      }),
    );
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

  it('reconciles an already-prepared funding lease before approving and never rebroadcasts it', async () => {
    provider.getBalance = jest.fn().mockResolvedValue(0n);
    const fundingHash = `0x${'c'.repeat(64)}`;
    const treasury = require('./service').TreasuryTransactions;
    treasury.prepare.mockResolvedValueOnce({
      alreadyPrepared: true,
      lease: {
        tx_hash: fundingHash,
        tx_context: {
          chainId: '80002',
          signerAddress: '0x2222222222222222222222222222222222222222',
          nonce: 4,
          to: '0x1111111111111111111111111111111111111111',
          value: '100000000000000',
        },
      },
    });
    provider.getTransaction = jest.fn().mockResolvedValue({
      hash: fundingHash,
      from: '0x2222222222222222222222222222222222222222',
      to: '0x1111111111111111111111111111111111111111',
      value: 100000000000000n,
    });
    provider.getTransactionReceipt = jest.fn().mockResolvedValue({
      status: 1,
      from: '0x2222222222222222222222222222222222222222',
      to: '0x1111111111111111111111111111111111111111',
    });

    await approveUserForSpendingViaFunding(
      'already-prepared-funding-user',
      treasurySigner,
      '0x2222222222222222222222222222222222222222',
      5,
    );

    expect(treasuryBroadcastTransaction).not.toHaveBeenCalled();
    expect(treasury.markSubmitted).not.toHaveBeenCalled();
    expect(require('./service').ApprovalPreparations.markFundingSubmitted).toHaveBeenCalledWith(
      expect.any(String),
      fundingHash,
      expect.objectContaining({ nonce: 4 }),
    );
    expect(userSendTransaction).toHaveBeenCalledTimes(1);
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
    expect(treasurySignTransaction).toHaveBeenCalledWith(expect.objectContaining({
      value: 15_000_000_000_000_000n,
    }));
    expect(userSendTransaction).toHaveBeenCalledTimes(1);
  });

  it('resumes a claimed top-up with its persisted amount and operation key', async () => {
    const preparations = require('./service').ApprovalPreparations;
    const treasury = require('./service').TreasuryTransactions;
    const priorHash = `0x${'f'.repeat(64)}`;
    const topUpHash = `0x${'e'.repeat(64)}`;
    const attemptKey = 'approval:resume-topup:topup:attempt-1';
    const context = {
      chainId: '80002',
      signerAddress: '0x2222222222222222222222222222222222222222',
      nonce: 9,
      to: '0x1111111111111111111111111111111111111111',
      value: '15000000000000000',
    };
    preparations.claim.mockResolvedValue({
      acquired: false,
      record: {
        status: 'funding',
        funding_tx_hash: priorHash,
        funding_attempt_key: attemptKey,
        funding_attempt_value: '15000000000000000',
        approval_tx_hash: null,
      },
    });
    treasury.prepare.mockResolvedValueOnce({
      alreadyPrepared: true,
      lease: { tx_hash: topUpHash, tx_context: context },
    });
    provider.getTransaction = jest.fn().mockResolvedValue({
      hash: topUpHash,
      from: context.signerAddress,
      to: context.to,
      value: BigInt(context.value),
    });
    provider.getTransactionReceipt = jest.fn().mockResolvedValue({
      status: 1,
      from: context.signerAddress,
      to: context.to,
    });

    await approveUserForSpendingViaFunding(
      'resume-topup-user',
      treasurySigner,
      '0x2222222222222222222222222222222222222222',
      5,
    );

    expect(treasury.prepare).toHaveBeenCalledWith(expect.objectContaining({
      operationKey: attemptKey,
      value: 15_000_000_000_000_000n,
    }));
    expect(provider.getBalance).not.toHaveBeenCalled();
    expect(provider.estimateGas).not.toHaveBeenCalled();
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

    expect(treasurySignTransaction).toHaveBeenCalledWith(expect.objectContaining({
      value: 200_000_000_000_000n,
    }));
    expect(preparations.markFundingSubmitted).toHaveBeenCalledTimes(1);
  });

  it('marks a permanent funding preparation rejection as no movement', async () => {
    provider.getBalance = jest.fn().mockResolvedValue(0n);
    provider.estimateGas = jest.fn()
      .mockResolvedValueOnce(100_000n)
      .mockRejectedValueOnce(Object.assign(new Error('execution reverted'), {
        code: 'CALL_EXCEPTION',
        data: '0x08c379a0',
      }));
    const preparations = require('./service').ApprovalPreparations;

    await expect(approveUserForSpendingViaFunding(
      'permanent-funding-preparation-user',
      treasurySigner,
      '0x2222222222222222222222222222222222222222',
      5,
    )).rejects.toMatchObject({
      code: 'APPROVAL_PREPARATION_REVIEW_REQUIRED',
      pending: false,
      requiresReview: false,
      retryable: false,
      preflightFailure: true,
      movementOutcome: 'no_movement',
    });
    expect(preparations.markFundingPreflightFailed).toHaveBeenCalledWith(
      expect.any(String),
      'TRANSACTION_ESTIMATE_REJECTED',
      expect.objectContaining({ retryable: false, stage: 'prepare' }),
    );
    expect(treasuryBroadcastTransaction).not.toHaveBeenCalled();
    expect(userSendTransaction).not.toHaveBeenCalled();
  });

  it('marks a signer failure during funding preparation as no movement', async () => {
    provider.getBalance = jest.fn().mockResolvedValue(0n);
    provider.estimateGas = jest.fn().mockResolvedValue(100_000n);
    treasurySignTransaction.mockRejectedValueOnce(new Error('hardware signer unavailable'));
    const preparations = require('./service').ApprovalPreparations;

    await expect(approveUserForSpendingViaFunding(
      'signer-funding-preparation-user',
      treasurySigner,
      '0x2222222222222222222222222222222222222222',
      5,
    )).rejects.toMatchObject({
      code: 'APPROVAL_PREPARATION_REVIEW_REQUIRED',
      pending: false,
      requiresReview: false,
      retryable: false,
      preflightFailure: true,
      movementOutcome: 'no_movement',
    });
    expect(preparations.markFundingPreflightFailed).toHaveBeenCalledWith(
      expect.any(String),
      'SIGN_TRANSACTION_FAILED',
      expect.objectContaining({ retryable: false, stage: 'prepare' }),
    );
    expect(treasuryBroadcastTransaction).not.toHaveBeenCalled();
    expect(userSendTransaction).not.toHaveBeenCalled();
  });

  it('retains a transient funding preparation failure as retryable no movement', async () => {
    provider.getBalance = jest.fn().mockResolvedValue(0n);
    provider.estimateGas = jest.fn()
      .mockResolvedValueOnce(100_000n)
      .mockRejectedValue(Object.assign(new Error('temporary internal error'), { code: 19 }));
    const preparations = require('./service').ApprovalPreparations;

    await expect(approveUserForSpendingViaFunding(
      'transient-funding-preparation-user',
      treasurySigner,
      '0x2222222222222222222222222222222222222222',
      5,
    )).rejects.toMatchObject({
      code: 'APPROVAL_PREPARATION_REVIEW_REQUIRED',
      pending: true,
      requiresReview: false,
      retryable: true,
      preflightFailure: true,
      movementOutcome: 'no_movement',
    });
    expect(preparations.markFundingPreflightFailed).toHaveBeenCalledWith(
      expect.any(String),
      'RPC_READ_UNAVAILABLE',
      expect.objectContaining({ retryable: true, stage: 'prepare' }),
    );
    expect(provider.estimateGas).toHaveBeenCalledTimes(4);
    expect(treasuryBroadcastTransaction).not.toHaveBeenCalled();
    expect(userSendTransaction).not.toHaveBeenCalled();
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
    treasuryBroadcastTransaction.mockRejectedValueOnce(new Error('funding receipt unavailable'));

    const results = await Promise.allSettled([
      approveUserForSpendingViaFunding('concurrent-approval', treasurySigner, '0x2222222222222222222222222222222222222222', 5),
      approveUserForSpendingViaFunding('concurrent-approval', treasurySigner, '0x2222222222222222222222222222222222222222', 5),
    ]);
    expect(results.every(result => result.status === 'rejected')).toBe(true);
    expect(treasuryBroadcastTransaction).toHaveBeenCalledTimes(1);
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

  it('reconciles a managed-wallet move from its saved intent before reading the current balance', async () => {
    const tokenAddress = '0x605871D30DC278a036F09e2ace771df8a224624B';
    const targetAddress = '0x3333333333333333333333333333333333333333';
    const moveInterface = new ethers.Interface(['function transferFrom(address from,address to,uint256 amount)']);
    const amount = ethers.parseEther('1.23');
    const savedHash = `0x${'c'.repeat(64)}`;
    const savedContext = {
      chainId: '80002',
      signerAddress: '0x2222222222222222222222222222222222222222',
      nonce: 7,
      to: tokenAddress,
      data: moveInterface.encodeFunctionData('transferFrom', [
        '0x1111111111111111111111111111111111111111',
        targetAddress,
        amount,
      ]),
      value: '0',
      accessList: [],
    };
    const treasury = require('./service').TreasuryTransactions;
    treasury.findByOperationKey.mockResolvedValueOnce({
      target_type: 'standalone',
      status: 'unknown',
      tx_hash: savedHash,
      tx_context: savedContext,
    });
    treasury.prepare.mockResolvedValueOnce({
      alreadyPrepared: true,
      lease: { tx_hash: savedHash, tx_context: savedContext },
    });
    const evidence = require('../spendEvidence').verifySpendEvidence;
    evidence.mockResolvedValueOnce({ valid: true });
    // The current chain allowance and balance may have changed since the
    // original send; a saved lease must still reconcile without either read.
    provider.call = jest.fn(() => { throw new Error('allowance and balance must not be read on replay'); });
    provider.getBalance = jest.fn(() => { throw new Error('balance must not be read on replay'); });

    const result = await moveFundsFromManagedWallet(
      'managed-move-user',
      targetAddress,
      treasurySigner,
      tokenAddress,
      'stable-action',
    );

    expect(result).toEqual({ txHash: savedHash, amount: '1.23' });
    expect(provider.call).not.toHaveBeenCalled();
    expect(provider.getBalance).not.toHaveBeenCalled();
    expect(treasury.prepare).toHaveBeenCalledWith(expect.objectContaining({
      operationKey: expect.stringMatching(/^maintenance:move:managed-move-user:/),
      data: savedContext.data,
      value: 0n,
    }));
  });

  it('returns a structured no-movement failure when a new move lacks treasury allowance', async () => {
    const tokenAddress = '0x605871D30DC278a036F09e2ace771df8a224624B';
    const targetAddress = '0x3333333333333333333333333333333333333333';
    const balanceInterface = new ethers.Interface(['function balanceOf(address account) view returns (uint256)']);
    const allowanceInterface = new ethers.Interface(['function allowance(address owner,address spender) view returns (uint256)']);
    const balanceSelector = balanceInterface.getFunction('balanceOf')!.selector;
    provider.call = jest.fn(async (transaction: { data?: string }) => transaction.data?.startsWith(balanceSelector)
      ? balanceInterface.encodeFunctionResult('balanceOf', [ethers.parseEther('1.23')])
      : allowanceInterface.encodeFunctionResult('allowance', [0n]));
    const treasury = require('./service').TreasuryTransactions;
    treasury.findByOperationKey.mockResolvedValueOnce(undefined);

    await expect(moveFundsFromManagedWallet(
      'managed-move-zero-allowance-user',
      targetAddress,
      treasurySigner,
      tokenAddress,
      'zero-allowance-action',
    )).rejects.toMatchObject({
      code: 'MANAGED_WALLET_ALLOWANCE_UNAVAILABLE',
      errorCode: 'MANAGED_WALLET_ALLOWANCE_UNAVAILABLE',
      stage: 'preflight',
      operationKey: expect.stringMatching(/^maintenance:move:managed-move-zero-allowance-user:/),
      txHash: null,
      movementOutcome: 'no_movement',
      pending: false,
      retryable: false,
      requiresReview: false,
      diagnostic: expect.objectContaining({
        stage: 'preflight',
        rpcMethod: 'eth_call',
        errorCode: 'MANAGED_WALLET_ALLOWANCE_UNAVAILABLE',
        retryable: false,
      }),
    });
    await expect(moveFundsFromManagedWallet(
      'managed-move-zero-allowance-user',
      targetAddress,
      treasurySigner,
      tokenAddress,
      'zero-allowance-action',
    )).rejects.toThrow('Enable the approved treasury permission');
    expect(treasury.prepare).not.toHaveBeenCalled();
    expect(treasuryBroadcastTransaction).not.toHaveBeenCalled();
  });

  it('keeps the original move identity at the top level when broadcast becomes ambiguous', async () => {
    const tokenAddress = '0x605871D30DC278a036F09e2ace771df8a224624B';
    const targetAddress = '0x3333333333333333333333333333333333333333';
    const balanceInterface = new ethers.Interface(['function balanceOf(address account) view returns (uint256)']);
    const allowanceInterface = new ethers.Interface(['function allowance(address owner,address spender) view returns (uint256)']);
    const balanceSelector = balanceInterface.getFunction('balanceOf')!.selector;
    provider.call = jest.fn(async (transaction: { data?: string }) => transaction.data?.startsWith(balanceSelector)
      ? balanceInterface.encodeFunctionResult('balanceOf', [ethers.parseEther('1.23')])
      : allowanceInterface.encodeFunctionResult('allowance', [ethers.MaxUint256]));
    const treasury = require('./service').TreasuryTransactions;
    treasury.findByOperationKey.mockResolvedValueOnce(undefined);
    treasuryBroadcastTransaction.mockRejectedValueOnce(Object.assign(new Error('primary send response lost'), {
      code: 'SERVER_ERROR',
      info: { responseStatus: '500 Internal Server Error', responseBody: JSON.stringify({ error: { code: 19 } }) },
    }));

    await expect(moveFundsFromManagedWallet(
      'managed-move-broadcast-unknown-user',
      targetAddress,
      treasurySigner,
      tokenAddress,
      'broadcast-unknown-action',
    )).rejects.toMatchObject({
      operationKey: expect.stringMatching(/^maintenance:move:managed-move-broadcast-unknown-user:/),
      txHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
      pending: true,
      requiresReview: true,
      movementOutcome: 'unknown',
      diagnostic: expect.objectContaining({
        stage: 'broadcast',
        savedHash: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        rpcMethod: 'eth_sendRawTransaction',
      }),
    });
    expect(treasury.markUnknown).toHaveBeenCalledWith(
      expect.stringMatching(/^maintenance:move:managed-move-broadcast-unknown-user:/),
      expect.objectContaining({ stage: 'broadcast', savedHash: expect.any(String) }),
    );
    expect(treasuryBroadcastTransaction).toHaveBeenCalledTimes(1);
  });

  it('keeps revoke gas funding as auxiliary evidence when its original send is ambiguous', async () => {
    const allowanceInterface = new ethers.Interface(['function allowance(address owner,address spender) view returns (uint256)']);
    provider.call = jest.fn(async () => allowanceInterface.encodeFunctionResult('allowance', [ethers.MaxUint256]));
    treasuryBroadcastTransaction.mockRejectedValueOnce(Object.assign(new Error('funding send response lost'), {
      code: 'SERVER_ERROR',
      info: { responseStatus: '500 Internal Server Error', responseBody: JSON.stringify({ error: { code: 19 } }) },
    }));

    const expectedFundingHash = ethers.keccak256('0x1234');
    await expect(revokeAllowanceOnManagedWallet(
      'managed-revoke-funding-user',
      treasurySigner,
      '0x2222222222222222222222222222222222222222',
      'revoke-funding-action',
    )).rejects.toMatchObject({
      fundingTxHash: expectedFundingHash,
      txHash: null,
      diagnostic: expect.not.objectContaining({ savedHash: expect.anything() }),
      requiresReview: true,
      movementOutcome: 'review',
    });
  });

  it('rejects a changed target or token for an existing managed-wallet move action', async () => {
    const tokenAddress = '0x605871D30DC278a036F09e2ace771df8a224624B';
    const differentTarget = '0x4444444444444444444444444444444444444444';
    const moveInterface = new ethers.Interface(['function transferFrom(address from,address to,uint256 amount)']);
    const savedContext = {
      chainId: '80002',
      signerAddress: '0x2222222222222222222222222222222222222222',
      nonce: 8,
      to: tokenAddress,
      data: moveInterface.encodeFunctionData('transferFrom', [
        '0x1111111111111111111111111111111111111111',
        '0x3333333333333333333333333333333333333333',
        ethers.parseEther('1'),
      ]),
      value: '0',
      accessList: [],
    };
    const treasury = require('./service').TreasuryTransactions;
    treasury.findByOperationKey.mockResolvedValueOnce({
      target_type: 'standalone',
      status: 'unknown',
      tx_hash: `0x${'d'.repeat(64)}`,
      tx_context: savedContext,
    });
    provider.call = jest.fn();

    await expect(moveFundsFromManagedWallet(
      'managed-move-conflict-user',
      differentTarget,
      treasurySigner,
      tokenAddress,
      'stable-action',
    )).rejects.toThrow('TREASURY_TRANSACTION_INTENT_MISMATCH');
    expect(treasury.prepare).not.toHaveBeenCalled();
    expect(provider.call).not.toHaveBeenCalled();
  });

  it('persists the original move hash and receipt diagnostic when confirmation is unavailable', async () => {
    const tokenAddress = '0x605871D30DC278a036F09e2ace771df8a224624B';
    const targetAddress = '0x3333333333333333333333333333333333333333';
    const moveInterface = new ethers.Interface(['function transferFrom(address from,address to,uint256 amount)']);
    const savedHash = `0x${'e'.repeat(64)}`;
    const savedContext = {
      chainId: '80002',
      signerAddress: '0x2222222222222222222222222222222222222222',
      nonce: 12,
      to: tokenAddress,
      data: moveInterface.encodeFunctionData('transferFrom', [
        '0x1111111111111111111111111111111111111111',
        targetAddress,
        ethers.parseEther('1.23'),
      ]),
      value: '0',
      accessList: [],
    };
    const treasury = require('./service').TreasuryTransactions;
    treasury.findByOperationKey.mockResolvedValueOnce({
      target_type: 'standalone',
      status: 'submitted',
      tx_hash: savedHash,
      tx_context: savedContext,
    });
    treasury.prepare.mockResolvedValueOnce({
      alreadyPrepared: false,
      lease: { tx_hash: savedHash, tx_context: savedContext },
    });
    treasuryBroadcastTransaction.mockResolvedValueOnce({ hash: savedHash });
    provider.waitForTransaction = jest.fn().mockRejectedValue({
      code: 'SERVER_ERROR',
      info: { responseStatus: '500 Internal Server Error', responseBody: JSON.stringify({ error: { code: 19 } }) },
    });

    await expect(moveFundsFromManagedWallet(
      'managed-move-receipt-outage-user',
      targetAddress,
      treasurySigner,
      tokenAddress,
      'stable-action',
    )).rejects.toMatchObject({
      diagnostic: expect.objectContaining({
        stage: 'receipt',
        errorCode: 'RECEIPT_READ_UNAVAILABLE',
        savedHash,
        nonce: 12,
        rpcMethod: 'provider.waitForTransaction',
        rpcCode: 19,
      }),
      operationKey: expect.stringMatching(/^maintenance:move:managed-move-receipt-outage-user:/),
      txHash: savedHash,
      nonce: 12,
      pending: true,
      movementOutcome: 'unknown',
    });
    expect(treasury.markUnknown).toHaveBeenCalledWith(
      expect.stringMatching(/^maintenance:move:managed-move-receipt-outage-user:/),
      expect.objectContaining({ savedHash, nonce: 12 }),
      expect.stringContaining(savedHash),
    );
    expect(treasuryBroadcastTransaction).toHaveBeenCalledTimes(1);
  });

  it('classifies a failed original move receipt as proven no movement', async () => {
    const tokenAddress = '0x605871D30DC278a036F09E2ace771df8a224624B';
    const targetAddress = '0x3333333333333333333333333333333333333333';
    const moveInterface = new ethers.Interface(['function transferFrom(address from,address to,uint256 amount)']);
    const savedHash = `0x${'a'.repeat(64)}`;
    const savedContext = {
      chainId: '80002',
      signerAddress: '0x2222222222222222222222222222222222222222',
      nonce: 14,
      to: tokenAddress,
      data: moveInterface.encodeFunctionData('transferFrom', [
        '0x1111111111111111111111111111111111111111',
        targetAddress,
        ethers.parseEther('1.23'),
      ]),
      value: '0',
      accessList: [],
    };
    const treasury = require('./service').TreasuryTransactions;
    treasury.findByOperationKey.mockResolvedValueOnce({ target_type: 'standalone', status: 'submitted', tx_hash: savedHash, tx_context: savedContext });
    treasury.prepare.mockResolvedValueOnce({ alreadyPrepared: false, lease: { tx_hash: savedHash, tx_context: savedContext } });
    treasuryBroadcastTransaction.mockResolvedValueOnce({ hash: savedHash });
    provider.waitForTransaction = jest.fn().mockResolvedValueOnce({ status: 0 });

    await expect(moveFundsFromManagedWallet(
      'managed-move-no-movement-user',
      targetAddress,
      treasurySigner,
      tokenAddress,
      'stable-action',
    )).rejects.toMatchObject({
      diagnostic: expect.objectContaining({ errorCode: 'TRANSACTION_FAILED', savedHash, nonce: 14 }),
      movementOutcome: 'no_movement',
      pending: false,
      requiresReview: false,
    });
    expect(treasury.markFailed).toHaveBeenCalledWith(
      expect.stringMatching(/^maintenance:move:managed-move-no-movement-user:/),
      expect.objectContaining({ errorCode: 'TRANSACTION_FAILED', savedHash }),
      expect.stringContaining(savedHash),
    );
    expect(treasury.markUnknown).not.toHaveBeenCalled();
  });

  it('persists duplicate evidence failure against the original move hash without resubmitting', async () => {
    const tokenAddress = '0x605871D30DC278a036F09e2ace771df8a224624B';
    const targetAddress = '0x3333333333333333333333333333333333333333';
    const moveInterface = new ethers.Interface(['function transferFrom(address from,address to,uint256 amount)']);
    const savedHash = `0x${'f'.repeat(64)}`;
    const savedContext = {
      chainId: '80002',
      signerAddress: '0x2222222222222222222222222222222222222222',
      nonce: 13,
      to: tokenAddress,
      data: moveInterface.encodeFunctionData('transferFrom', [
        '0x1111111111111111111111111111111111111111',
        targetAddress,
        ethers.parseEther('1.23'),
      ]),
      value: '0',
      accessList: [],
    };
    const treasury = require('./service').TreasuryTransactions;
    treasury.findByOperationKey.mockResolvedValueOnce({
      target_type: 'standalone',
      status: 'unknown',
      tx_hash: savedHash,
      tx_context: savedContext,
    });
    treasury.prepare.mockResolvedValueOnce({
      alreadyPrepared: true,
      lease: { tx_hash: savedHash, tx_context: savedContext },
    });
    const evidence = require('../spendEvidence').verifySpendEvidence;
    evidence.mockResolvedValueOnce({
      valid: false,
      failure: {
        code: 'RECEIPT_PENDING',
        message: 'receipt pending',
        pending: true,
        diagnostic: {
          rpcMethod: 'eth_getTransactionReceipt',
          providerCode: 'SERVER_ERROR',
          rpcCode: 26,
          httpStatus: 400,
          traceId: 'trace-receipt-26',
          retryable: true,
        },
      },
    });

    await expect(moveFundsFromManagedWallet(
      'managed-move-evidence-outage-user',
      targetAddress,
      treasurySigner,
      tokenAddress,
      'stable-action',
    )).rejects.toMatchObject({
      diagnostic: expect.objectContaining({
        stage: 'receipt',
        errorCode: 'RECEIPT_PENDING',
        savedHash,
        nonce: 13,
        rpcMethod: 'eth_getTransactionReceipt',
        rpcCode: 26,
        traceId: 'trace-receipt-26',
      }),
      operationKey: expect.stringMatching(/^maintenance:move:managed-move-evidence-outage-user:/),
      txHash: savedHash,
      nonce: 13,
      pending: true,
      movementOutcome: 'unknown',
    });
    expect(treasury.markUnknown).toHaveBeenCalledWith(
      expect.stringMatching(/^maintenance:move:managed-move-evidence-outage-user:/),
      expect.objectContaining({ savedHash, rpcCode: 26 }),
      expect.stringContaining(savedHash),
    );
    expect(treasuryBroadcastTransaction).not.toHaveBeenCalled();
  });
});
