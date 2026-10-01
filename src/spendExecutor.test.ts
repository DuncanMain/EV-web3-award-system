import { ethers } from 'ethers';
import { processSpend, prepareSpend, recoverSpendOperation } from './spendExecutor';
import { spendIntentFingerprint, spendOperationKey } from './database/tokenOperation';

jest.mock('./contract');
jest.mock('./spendEvidence', () => ({
  verifySpendEvidence: jest.fn().mockResolvedValue({
    valid: true,
    proof: {
      txHash: `0x${'b'.repeat(64)}`,
      chainId: '80002',
      tokenContractAddress: '0x605871D30DC278a036F09e2ace771df8a224624B',
      sourceWallet: '0x1111111111111111111111111111111111111111',
      treasuryRecipient: '0x2222222222222222222222222222222222222222',
      amountUnits: '2000000000000000000',
      transferMethod: 'transferFrom',
      transactionFrom: '0x9999999999999999999999999999999999999999',
      blockNumber: 1,
      logIndex: 0,
    },
  }),
}));
jest.mock('./database/integration', () => ({
  recordSpend: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('./database/service', () => ({
  TokenOperations: {
    findByKey: jest.fn(),
    claim: jest.fn(),
    markSubmitted: jest.fn(),
    markConfirmed: jest.fn(),
    markProjected: jest.fn(),
    markProjectionError: jest.fn(),
    markUnknown: jest.fn(),
    markFailed: jest.fn(),
    markPreflightFailed: jest.fn(),
  },
}));

describe('bounded spend execution', () => {
  const mockContract = {
    transferFrom: jest.fn().mockResolvedValue({
      hash: `0x${'b'.repeat(64)}`,
      wait: jest.fn().mockResolvedValue({ status: 1 }),
    }),
  };
  const request = {
    userAddress: '0x1111111111111111111111111111111111111111',
    amount: 2,
    uid: 'contract-1',
    sessionId: 'session-1',
    providerId: 'provider-1',
    operationKey: 'reservation:reservation-1',
    reservationId: 'reservation-1',
  };
  const readonlyInterface = new ethers.Interface([
    'function allowance(address owner,address spender) view returns (uint256)',
    'function balanceOf(address owner) view returns (uint256)',
  ]);
  const mockProvider = {
    getNetwork: jest.fn().mockResolvedValue({ chainId: 80002n }),
    call: jest.fn(async (transaction: { data?: string }) => {
      const selector = (transaction.data || '').slice(0, 10);
      if (selector === readonlyInterface.getFunction('allowance')?.selector) {
        return readonlyInterface.encodeFunctionResult('allowance', [ethers.MaxUint256]);
      }
      return readonlyInterface.encodeFunctionResult('balanceOf', [ethers.parseUnits('100', 18)]);
    }),
  } as unknown as ethers.Provider;
  const mockSigner = {
    getAddress: jest.fn().mockResolvedValue('0x9999999999999999999999999999999999999999'),
    provider: mockProvider,
  } as unknown as ethers.Signer;

  function installStatefulOperations() {
    const serviceMock = require('./database/service');
    const operations = new Map<string, any>();
    serviceMock.TokenOperations.findByKey.mockImplementation(async (key: string) => operations.get(key));
    serviceMock.TokenOperations.claim.mockImplementation(async (input: any) => {
      const existing = operations.get(input.operationKey);
      if (existing) {
        if (existing.request_fingerprint && existing.request_fingerprint !== input.requestFingerprint) {
          throw new Error('TOKEN_OPERATION_INTENT_MISMATCH');
        }
        if (existing.status === 'failed' && existing.error_message?.startsWith('PREFLIGHT:')) {
          existing.status = 'submitting';
          existing.movement_outcome = 'unknown';
          existing.error_message = null;
          return { operation: existing, acquired: true };
        }
        return { operation: existing, acquired: false };
      }
      const operation = {
        operation_key: input.operationKey,
        request_fingerprint: input.requestFingerprint,
        status: 'submitting',
        amount: input.amount,
        uid: input.uid,
        wallet_address: input.walletAddress,
        session_id: input.sessionId,
        tx_hash: null,
        intent_context: {
          assetContext: {
            tokenContractAddress: '0x605871D30DC278a036F09e2ace771df8a224624B',
            chainId: '80002',
            treasuryAddress: '0x2222222222222222222222222222222222222222',
            signerAddress: '0x9999999999999999999999999999999999999999',
          },
        },
      };
      operations.set(input.operationKey, operation);
      return { operation, acquired: true };
    });
    serviceMock.TokenOperations.markSubmitted.mockImplementation(async (key: string, hash: string) => {
      const operation = operations.get(key);
      operation.tx_hash = hash;
      operation.status = 'submitted';
      return operation;
    });
    serviceMock.TokenOperations.markConfirmed.mockImplementation(async (key: string) => {
      const operation = operations.get(key);
      operation.status = 'confirmed';
      return operation;
    });
    serviceMock.TokenOperations.markProjected.mockImplementation(async (key: string) => {
      const operation = operations.get(key);
      operation.status = 'projected';
      return operation;
    });
    serviceMock.TokenOperations.markProjectionError.mockImplementation(async (key: string, message: string) => {
      const operation = operations.get(key);
      operation.status = 'confirmed';
      operation.error_message = message;
      return operation;
    });
    serviceMock.TokenOperations.markUnknown.mockImplementation(async (key: string, message: string) => {
      const operation = operations.get(key);
      operation.status = 'unknown';
      operation.error_message = message;
      return operation;
    });
    serviceMock.TokenOperations.markPreflightFailed.mockImplementation(async (key: string, message: string) => {
      const operation = operations.get(key);
      operation.status = 'failed';
      operation.movement_outcome = 'no_movement';
      operation.error_message = `PREFLIGHT:${message}`;
      return operation;
    });
    return operations;
  }

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TREASURY_ADDRESS = '0x2222222222222222222222222222222222222222';
    process.env.CHAIN_ID = '80002';
    process.env.TOKEN_CONTRACT_ADDRESS = '0x605871D30DC278a036F09e2ace771df8a224624B';
    const contractMock = require('./contract');
    contractMock.getContract.mockReturnValue(mockContract);
    mockContract.transferFrom.mockResolvedValue({
      hash: `0x${'b'.repeat(64)}`,
      wait: jest.fn().mockResolvedValue({ status: 1 }),
    });
    (mockContract.transferFrom as any).staticCall = jest.fn().mockResolvedValue(true);
    (mockProvider.call as unknown as jest.Mock).mockImplementation(async (transaction: { data?: string }) => {
      const selector = (transaction.data || '').slice(0, 10);
      if (selector === readonlyInterface.getFunction('allowance')?.selector) {
        return readonlyInterface.encodeFunctionResult('allowance', [ethers.MaxUint256]);
      }
      return readonlyInterface.encodeFunctionResult('balanceOf', [ethers.parseUnits('100', 18)]);
    });
  });

  it('rejects an amount that would be rounded in the database', () => {
    expect(prepareSpend({ userAddress: request.userAddress, amount: 0.005 })).toEqual({ valid: false });
  });

  it('rejects a keyless direct spend before asset reads, claims, or broadcast', async () => {
    const serviceMock = require('./database/service');
    const result = await processSpend({
      ...request,
      operationKey: undefined,
      idempotencyKey: undefined,
      reservationId: undefined,
    }, mockSigner);

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('SPEND_IDEMPOTENCY_KEY_REQUIRED'),
    });
    expect(serviceMock.TokenOperations.findByKey).not.toHaveBeenCalled();
    expect(serviceMock.TokenOperations.claim).not.toHaveBeenCalled();
    expect(mockContract.transferFrom).not.toHaveBeenCalled();
  });

  it.each([
    ['operationKey', ' '],
    ['idempotencyKey', ''],
    ['idempotencyKey', 123],
  ])('rejects malformed %s before any provider or ledger work', async (field, value) => {
    const serviceMock = require('./database/service');
    const result = await processSpend({
      ...request,
      operationKey: field === 'operationKey' ? value : undefined,
      idempotencyKey: field === 'idempotencyKey' ? value : undefined,
    } as any, mockSigner);

    expect(result).toMatchObject({
      success: false,
      error: expect.stringContaining('INVALID_OPERATION_KEY'),
    });
    expect(serviceMock.TokenOperations.findByKey).not.toHaveBeenCalled();
    expect(serviceMock.TokenOperations.claim).not.toHaveBeenCalled();
    expect(mockContract.transferFrom).not.toHaveBeenCalled();
  });

  it('submits only once for concurrent requests with one operation key', async () => {
    installStatefulOperations();
    const first = processSpend(request, mockSigner);
    const second = processSpend(request, mockSigner);
    const results = await Promise.all([first, second]);

    expect(mockContract.transferFrom).toHaveBeenCalledTimes(1);
    expect(results.some(result => result.success)).toBe(true);
    expect(results.some(result => result.pending)).toBe(true);
  });

  it('submits only once for concurrent requests sharing a caller idempotency key', async () => {
    installStatefulOperations();
    const keyedRequest = {
      ...request,
      operationKey: undefined,
      reservationId: undefined,
      idempotencyKey: 'concurrent-caller-key',
    };
    const first = processSpend(keyedRequest, mockSigner);
    const second = processSpend(keyedRequest, mockSigner);
    const results = await Promise.all([first, second]);

    expect(mockContract.transferFrom).toHaveBeenCalledTimes(1);
    expect(results.map(result => result.operationKey)).toEqual([
      spendOperationKey('contract-1', 'concurrent-caller-key'),
      spendOperationKey('contract-1', 'concurrent-caller-key'),
    ]);
  });

  it('replays a confirmed spend after projection failure without rebroadcasting', async () => {
    installStatefulOperations();
    const integrationMock = require('./database/integration');
    integrationMock.recordSpend.mockRejectedValueOnce(new Error('database unavailable'));

    const first = await processSpend(request, mockSigner);
    expect(first.success).toBe(false);
    expect(first.pending).toBe(true);
    expect(first.txHash).toBe(`0x${'b'.repeat(64)}`);

    integrationMock.recordSpend.mockResolvedValueOnce(undefined);
    const replay = await processSpend(request, mockSigner);
    expect(replay.success).toBe(true);
    expect(replay.txHash).toBe(`0x${'b'.repeat(64)}`);
    expect(mockContract.transferFrom).toHaveBeenCalledTimes(1);
  });

  it('keeps an ambiguous allowance-looking submission claimed and does not resubmit', async () => {
    installStatefulOperations();
    mockContract.transferFrom.mockRejectedValueOnce(new Error('insufficient allowance after broadcast'));

    const first = await processSpend(request, mockSigner);
    expect(first.success).toBe(false);
    expect(first.pending).toBe(true);
    expect(first.requiresReview).toBe(true);

    const replay = await processSpend(request, mockSigner);
    expect(replay.success).toBe(false);
    expect(replay.requiresReview).toBe(true);
    expect(mockContract.transferFrom).toHaveBeenCalledTimes(1);
    const serviceMock = require('./database/service');
    expect(serviceMock.TokenOperations.markPreflightFailed).not.toHaveBeenCalled();
  });

  it('marks a genuine readonly allowance failure before any send call', async () => {
    installStatefulOperations();
    (mockProvider.call as unknown as jest.Mock).mockImplementation(async (transaction: { data?: string }) => {
      const selector = (transaction.data || '').slice(0, 10);
      if (selector === readonlyInterface.getFunction('allowance')?.selector) {
        return readonlyInterface.encodeFunctionResult('allowance', [0n]);
      }
      return readonlyInterface.encodeFunctionResult('balanceOf', [ethers.parseUnits('100', 18)]);
    });

    const result = await processSpend(request, mockSigner);

    expect(result.success).toBe(false);
    expect(result.preflightFailure).toBe(true);
    expect(result.requiresReview).not.toBe(true);
    expect(mockContract.transferFrom).not.toHaveBeenCalled();
    expect(require('./database/service').TokenOperations.markPreflightFailed).toHaveBeenCalledTimes(1);
  });

  it('marks an unavailable readonly preflight as no-movement and retryable', async () => {
    installStatefulOperations();
    (mockProvider.call as unknown as jest.Mock).mockRejectedValueOnce(new Error('missing revert data'));

    const result = await processSpend(request, mockSigner);

    expect(result.success).toBe(false);
    expect(result.preflightFailure).toBe(true);
    expect(result.requiresReview).not.toBe(true);
    expect(result.pending).toBe(true);
    expect(mockContract.transferFrom).not.toHaveBeenCalled();
    const serviceMock = require('./database/service');
    expect(serviceMock.TokenOperations.markPreflightFailed).toHaveBeenCalledWith(
      request.operationKey,
      expect.stringContaining('SPEND_PREFLIGHT_UNAVAILABLE'),
    );
    expect(serviceMock.TokenOperations.markUnknown).not.toHaveBeenCalled();
  });

  it('does not treat an empty CALL_EXCEPTION from static preflight as an allowance failure', async () => {
    installStatefulOperations();
    (mockContract.transferFrom as any).staticCall = jest.fn().mockRejectedValue({
      code: 'CALL_EXCEPTION',
      data: '0x',
      action: 'call',
      message: 'missing revert data',
    });

    const result = await processSpend(request, mockSigner);

    expect(result.preflightFailure).toBe(true);
    expect(result.preflightApprovalEligible).toBe(false);
    expect(result.pending).toBe(true);
    expect(result.requiresReview).not.toBe(true);
    expect(require('./database/service').TokenOperations.markPreflightFailed).toHaveBeenCalledWith(
      request.operationKey,
      expect.stringContaining('SPEND_PREFLIGHT_UNAVAILABLE'),
    );
  });

  it('retries the same operation key after a no-movement readonly preflight failure', async () => {
    installStatefulOperations();
    (mockProvider.call as unknown as jest.Mock).mockRejectedValueOnce(new Error('missing revert data'));

    const first = await processSpend(request, mockSigner);
    expect(first.preflightFailure).toBe(true);
    expect(first.pending).toBe(true);

    (mockProvider.call as unknown as jest.Mock).mockImplementation(async (transaction: { data?: string }) => {
      const selector = (transaction.data || '').slice(0, 10);
      if (selector === readonlyInterface.getFunction('allowance')?.selector) {
        return readonlyInterface.encodeFunctionResult('allowance', [ethers.MaxUint256]);
      }
      return readonlyInterface.encodeFunctionResult('balanceOf', [ethers.parseUnits('100', 18)]);
    });

    const replay = await processSpend(request, mockSigner);
    expect(replay.success).toBe(true);
    expect(replay.operationKey).toBe(request.operationKey);
    expect(mockContract.transferFrom).toHaveBeenCalledTimes(1);
  });

  it('does not project a mined transaction when token evidence has no matching Transfer log', async () => {
    installStatefulOperations();
    const evidenceMock = require('./spendEvidence').verifySpendEvidence as jest.Mock;
    evidenceMock.mockResolvedValueOnce({
      valid: false,
      failure: { code: 'MISSING_TRANSFER_EVENT', message: 'no matching event', pending: false },
    });

    const result = await processSpend(request, mockSigner);

    expect(result.success).toBe(false);
    expect(result.operationStatus).toBe('failed');
    expect(result.requiresReview).toBe(true);
    expect(require('./database/service').TokenOperations.markFailed).toHaveBeenCalledTimes(1);
    expect(require('./database/integration').recordSpend).not.toHaveBeenCalled();
  });

  it('returns the durable unknown movement outcome while receipt evidence is pending', async () => {
    installStatefulOperations();
    const evidenceMock = require('./spendEvidence').verifySpendEvidence as jest.Mock;
    evidenceMock.mockResolvedValueOnce({
      valid: false,
      failure: { code: 'PROVIDER_ERROR', message: 'temporary RPC read failure', pending: false },
    });

    const result = await processSpend(request, mockSigner);

    expect(result).toMatchObject({
      success: false,
      pending: true,
      requiresReview: false,
      movementOutcome: 'unknown',
    });
    expect(result.txHash).toBe(`0x${'b'.repeat(64)}`);

    const replay = await processSpend(request, mockSigner);
    expect(replay.success).toBe(true);
    expect(replay.txHash).toBe(`0x${'b'.repeat(64)}`);
    expect(mockContract.transferFrom).toHaveBeenCalledTimes(1);
  });

  it('retains the known spend operation when saving a failed evidence state fails', async () => {
    installStatefulOperations();
    const evidenceMock = require('./spendEvidence').verifySpendEvidence as jest.Mock;
    evidenceMock.mockResolvedValueOnce({
      valid: false,
      failure: { code: 'MISSING_TRANSFER_EVENT', message: 'no matching event', pending: false },
    });
    const serviceMock = require('./database/service');
    serviceMock.TokenOperations.markFailed.mockRejectedValueOnce(new Error('database unavailable'));

    const result = await processSpend(request, mockSigner);

    expect(result).toMatchObject({ success: false, pending: true, requiresReview: true, txHash: `0x${'b'.repeat(64)}` });
    expect(result.error).toContain('durable failure state could not be saved');
    expect(require('./database/integration').recordSpend).not.toHaveBeenCalled();
  });

  it('returns saved spend recovery state when the provider context is unavailable', async () => {
    const operations = installStatefulOperations();
    const savedKey = request.operationKey as string;
    operations.set(savedKey, {
      operation_key: savedKey,
      operation_type: 'spend',
      request_fingerprint: 'saved-fingerprint',
      status: 'submitted',
      amount: '2.00',
      uid: request.uid,
      wallet_address: request.userAddress,
      session_id: request.sessionId,
      tx_hash: `0x${'c'.repeat(64)}`,
      intent_context: {
        assetContext: {
          tokenContractAddress: '0x605871D30DC278a036F09e2ace771df8a224624B',
          chainId: '80002',
          treasuryAddress: '0x2222222222222222222222222222222222222222',
          signerAddress: '0x9999999999999999999999999999999999999999',
        },
      },
    });
    operations.get(savedKey).request_fingerprint = spendIntentFingerprint({
      uid: request.uid,
      walletAddress: request.userAddress,
      amount: 2,
      sessionId: request.sessionId,
      providerId: request.providerId,
      reservationId: request.reservationId,
    });
    (mockProvider.getNetwork as jest.Mock).mockRejectedValueOnce(new Error('RPC unavailable'));

    const result = await processSpend(request, mockSigner);

    expect(result).toMatchObject({ success: false, pending: true, requiresReview: true, txHash: `0x${'c'.repeat(64)}` });
    expect(result.operationStatus).toBe('submitted');
    expect(mockContract.transferFrom).not.toHaveBeenCalled();
  });

  it('rejects changed spend intent before unavailable-context recovery', async () => {
    const operations = installStatefulOperations();
    const savedKey = request.operationKey as string;
    operations.set(savedKey, {
      operation_key: savedKey,
      operation_type: 'spend',
      request_fingerprint: spendIntentFingerprint({
        uid: request.uid,
        walletAddress: request.userAddress,
        amount: request.amount,
        sessionId: request.sessionId,
        providerId: request.providerId,
        reservationId: request.reservationId,
      }),
      status: 'submitted',
      amount: '2.00',
      uid: request.uid,
      wallet_address: request.userAddress,
      session_id: request.sessionId,
      provider_id: request.providerId,
      reservation_id: request.reservationId,
      tx_hash: `0x${'d'.repeat(64)}`,
      intent_context: {
        assetContext: {
          tokenContractAddress: '0x605871D30DC278a036F09e2ace771df8a224624B',
          chainId: '80002',
          treasuryAddress: '0x2222222222222222222222222222222222222222',
          signerAddress: '0x9999999999999999999999999999999999999999',
        },
      },
    });
    (mockProvider.getNetwork as jest.Mock).mockRejectedValueOnce(new Error('RPC unavailable'));

    const result = await processSpend({ ...request, amount: 3 }, mockSigner);

    expect(result).toMatchObject({ success: false, requiresReview: true, operationStatus: 'submitted' });
    expect(result.error).toContain('TOKEN_OPERATION_INTENT_MISMATCH');
    expect(result.pending).not.toBe(true);
    expect(mockContract.transferFrom).not.toHaveBeenCalled();
  });

  it('replays by the returned operation key without requiring the original caller key', async () => {
    installStatefulOperations();
    const keyedRequest = {
      ...request,
      operationKey: undefined,
      reservationId: undefined,
      idempotencyKey: 'caller-key',
    };

    const first = await processSpend(keyedRequest, mockSigner);
    const replay = await processSpend({
      ...keyedRequest,
      operationKey: first.operationKey,
      idempotencyKey: undefined,
    }, mockSigner);

    expect(first.operationKey).toBeDefined();
    expect(replay.success).toBe(true);
    expect(replay.txHash).toBe(first.txHash);
    expect(mockContract.transferFrom).toHaveBeenCalledTimes(1);
  });

  it('derives one stable operation key from the exact caller idempotency key', async () => {
    installStatefulOperations();
    const keyedRequest = {
      ...request,
      operationKey: undefined,
      reservationId: undefined,
      idempotencyKey: ' caller-key ',
    };

    const first = await processSpend(keyedRequest, mockSigner);
    const replay = await processSpend(keyedRequest, mockSigner);

    expect(first.operationKey).toBe(spendOperationKey('contract-1', ' caller-key '));
    expect(replay.success).toBe(true);
    expect(replay.operationKey).toBe(first.operationKey);
    expect(mockContract.transferFrom).toHaveBeenCalledTimes(1);
  });

  it('recovers a saved spend by verifying its hash and projecting without a replacement transfer', async () => {
    const operations = installStatefulOperations();
    const savedHash = `0x${'e'.repeat(64)}`;
    operations.set(request.operationKey, {
      operation_key: request.operationKey,
      operation_type: 'spend',
      request_fingerprint: spendIntentFingerprint({
        uid: request.uid,
        walletAddress: request.userAddress,
        amount: request.amount,
        sessionId: request.sessionId,
        providerId: request.providerId,
        reservationId: request.reservationId,
      }),
      status: 'submitted',
      amount: '2.00',
      uid: request.uid,
      wallet_address: request.userAddress,
      session_id: request.sessionId,
      provider_id: request.providerId,
      reservation_id: request.reservationId,
      tx_hash: savedHash,
      intent_context: {
        assetContext: {
          tokenContractAddress: '0x605871D30DC278a036F09e2ace771df8a224624B',
          chainId: '80002',
          treasuryAddress: '0x2222222222222222222222222222222222222222',
          signerAddress: '0x9999999999999999999999999999999999999999',
        },
      },
    });

    const recovered = await recoverSpendOperation(request.operationKey, mockSigner);

    expect(recovered).toMatchObject({
      success: true,
      txHash: savedHash,
      operationStatus: 'projected',
      dbStored: true,
    });
    expect(require('./database/service').TokenOperations.markConfirmed).toHaveBeenCalledWith(request.operationKey);
    expect(require('./database/integration').recordSpend).toHaveBeenCalledWith(
      request.userAddress,
      request.amount,
      savedHash,
      request.sessionId,
      request.uid,
    );
    expect(mockContract.transferFrom).not.toHaveBeenCalled();
  });

  it('keeps recovery pending when saved evidence is not yet readable and never broadcasts', async () => {
    const operations = installStatefulOperations();
    const savedHash = `0x${'f'.repeat(64)}`;
    operations.set(request.operationKey, {
      operation_key: request.operationKey,
      operation_type: 'spend',
      request_fingerprint: spendIntentFingerprint({
        uid: request.uid,
        walletAddress: request.userAddress,
        amount: request.amount,
        sessionId: request.sessionId,
        providerId: request.providerId,
        reservationId: request.reservationId,
      }),
      status: 'submitted',
      amount: '2.00',
      uid: request.uid,
      wallet_address: request.userAddress,
      session_id: request.sessionId,
      provider_id: request.providerId,
      reservation_id: request.reservationId,
      tx_hash: savedHash,
      intent_context: {
        assetContext: {
          tokenContractAddress: '0x605871D30DC278a036F09e2ace771df8a224624B',
          chainId: '80002',
          treasuryAddress: '0x2222222222222222222222222222222222222222',
          signerAddress: '0x9999999999999999999999999999999999999999',
        },
      },
    });
    const evidenceMock = require('./spendEvidence').verifySpendEvidence as jest.Mock;
    evidenceMock.mockResolvedValueOnce({
      valid: false,
      failure: { code: 'PROVIDER_ERROR', message: 'temporary provider failure', pending: false },
    });

    const recovered = await recoverSpendOperation(request.operationKey, mockSigner);

    expect(recovered).toMatchObject({
      success: false,
      pending: true,
      requiresReview: false,
      txHash: savedHash,
    });
    expect(require('./database/integration').recordSpend).not.toHaveBeenCalled();
    expect(mockContract.transferFrom).not.toHaveBeenCalled();
  });

  it('blocks recovery when the saved spend fingerprint no longer matches its durable intent', async () => {
    const operations = installStatefulOperations();
    operations.set(request.operationKey, {
      operation_key: request.operationKey,
      operation_type: 'spend',
      request_fingerprint: 'corrupted-saved-fingerprint',
      status: 'submitted',
      amount: '2.00',
      uid: request.uid,
      wallet_address: request.userAddress,
      session_id: request.sessionId,
      provider_id: request.providerId,
      reservation_id: request.reservationId,
      tx_hash: `0x${'1'.repeat(64)}`,
      intent_context: {
        assetContext: {
          tokenContractAddress: '0x605871D30DC278a036F09e2ace771df8a224624B',
          chainId: '80002',
          treasuryAddress: '0x2222222222222222222222222222222222222222',
          signerAddress: '0x9999999999999999999999999999999999999999',
        },
      },
    });

    const recovered = await recoverSpendOperation(request.operationKey, mockSigner);

    expect(recovered).toMatchObject({
      success: false,
      requiresReview: true,
      error: expect.stringContaining('SPEND_RECOVERY_INTENT_INVALID'),
    });
    expect(require('./database/service').TokenOperations.markConfirmed).not.toHaveBeenCalled();
    expect(require('./database/integration').recordSpend).not.toHaveBeenCalled();
    expect(mockContract.transferFrom).not.toHaveBeenCalled();
  });

  it('does not advertise or recover a projected spend without its saved hash', async () => {
    const operations = installStatefulOperations();
    operations.set(request.operationKey, {
      operation_key: request.operationKey,
      operation_type: 'spend',
      status: 'projected',
      amount: '2.00',
      uid: request.uid,
      wallet_address: request.userAddress,
      session_id: request.sessionId,
      tx_hash: null,
    });

    const recovered = await recoverSpendOperation(request.operationKey, mockSigner);

    expect(recovered).toMatchObject({
      success: false,
      pending: true,
      requiresReview: true,
      error: expect.stringContaining('SPEND_RECOVERY_CHAIN_HASH_REQUIRED'),
    });
    expect(require('./database/integration').recordSpend).not.toHaveBeenCalled();
    expect(mockContract.transferFrom).not.toHaveBeenCalled();
  });
});
