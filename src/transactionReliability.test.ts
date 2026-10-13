import { ethers } from 'ethers';
import {
  prepareAndBroadcastTransaction,
  TransactionReliabilityError,
} from './transactionReliability';
import {
  TreasuryTransactionPreparationError,
  TreasuryTransactions,
} from './database/service';

jest.mock('./database/service', () => ({
  TreasuryTransactionPreparationError: class TreasuryTransactionPreparationError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'TreasuryTransactionPreparationError';
    }
  },
  TreasuryTransactions: {
    prepare: jest.fn(),
    markSubmitted: jest.fn(),
    markUnknown: jest.fn(),
  },
}));

const mockedTreasury = TreasuryTransactions as jest.Mocked<typeof TreasuryTransactions>;

function context(hash: string, nonce = 7) {
  return {
    chain_id: '80002',
    tx_hash: hash,
    tx_context: {
      chainId: '80002',
      signerAddress: '0x0000000000000000000000000000000000000001',
      nonce,
      to: '0x0000000000000000000000000000000000000002',
      value: '0',
      gasLimit: '21000',
      maxFeePerGas: '100',
      maxPriorityFeePerGas: '10',
      type: 2,
      accessList: [],
    },
  } as const;
}

function setupProvider() {
  let pendingCalls = 0;
  const provider = {
    getTransactionCount: jest.fn(async () => {
      pendingCalls += 1;
      if (pendingCalls < 3) throw Object.assign(new Error('temporary internal error'), { code: 19 });
      return 7;
    }),
    getFeeData: jest.fn().mockResolvedValue({ maxFeePerGas: 100n, maxPriorityFeePerGas: 10n, gasPrice: null }),
    estimateGas: jest.fn().mockResolvedValue(21_000n),
    broadcastTransaction: jest.fn().mockResolvedValue({ hash: ethers.keccak256('0x1234') }),
  };
  const signer = {
    provider,
    getAddress: jest.fn().mockResolvedValue('0x0000000000000000000000000000000000000001'),
    signTransaction: jest.fn().mockResolvedValue('0x1234'),
  } as unknown as ethers.Signer;
  return { provider, signer };
}

describe('prepareAndBroadcastTransaction', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('retries transient nonce reads and persists complete signing context before broadcast', async () => {
    const { provider, signer } = setupProvider();
    const txHash = ethers.keccak256('0x1234');
    mockedTreasury.prepare.mockImplementation(async request => {
      await request.getPendingNonce();
      const prepared = await request.prepare(7);
      return {
        alreadyPrepared: false,
        rawTransaction: prepared.rawTransaction,
        lease: { ...context(txHash), operation_key: request.operationKey },
      } as never;
    });

    const result = await prepareAndBroadcastTransaction({
      operationKey: 'award:test',
      targetType: 'token_operation',
      signer,
      chainId: '80002',
      to: '0x0000000000000000000000000000000000000002',
      data: '0xabcd',
    });

    expect(provider.getTransactionCount).toHaveBeenCalledTimes(3);
    expect(provider.estimateGas).toHaveBeenCalledTimes(1);
    expect(signer.signTransaction).toHaveBeenCalledTimes(1);
    expect(provider.broadcastTransaction).toHaveBeenCalledTimes(1);
    expect(result.txHash).toBe(txHash);
    expect(mockedTreasury.markSubmitted).toHaveBeenCalledWith('award:test', txHash);
    const signedRequest = (signer.signTransaction as jest.Mock).mock.calls[0][0];
    expect(signedRequest).toMatchObject({
      nonce: 7,
      chainId: '80002',
      gasLimit: 21_000n,
      maxFeePerGas: 100n,
      maxPriorityFeePerGas: 10n,
      type: 2,
    });
    expect(JSON.stringify(context(txHash))).not.toContain('rawTransaction');
  });

  it('retains the exact saved hash when broadcast becomes ambiguous and never retries send', async () => {
    const { provider, signer } = setupProvider();
    const txHash = ethers.keccak256('0x1234');
    provider.broadcastTransaction.mockRejectedValueOnce(Object.assign(new Error('HTTP 500 https://rpc.example.test/?secret=x'), {
      code: 'SERVER_ERROR',
      error: { code: 19, traceId: 'trace-123' },
    }));
    mockedTreasury.prepare.mockImplementation(async request => {
      await request.getPendingNonce();
      const prepared = await request.prepare(7);
      return { alreadyPrepared: false, rawTransaction: prepared.rawTransaction, lease: { ...context(txHash), operation_key: request.operationKey } } as never;
    });

    const failed = prepareAndBroadcastTransaction({
      operationKey: 'spend:test',
      targetType: 'token_operation',
      signer,
      chainId: 80002,
      to: '0x0000000000000000000000000000000000000002',
    });
    await expect(failed).rejects.toBeInstanceOf(TransactionReliabilityError);
    try {
      await failed;
    } catch (error) {
      const diagnostic = (error as TransactionReliabilityError).diagnostic;
      expect(diagnostic).toMatchObject({
        stage: 'broadcast',
        errorCode: 'CHAIN_OUTCOME_UNKNOWN',
        savedHash: txHash,
        retryable: false,
        rpcMethod: 'eth_sendRawTransaction',
        providerCode: 'SERVER_ERROR',
        rpcCode: 19,
        traceId: 'trace-123',
      });
      expect(JSON.stringify(diagnostic)).not.toContain('rpc.example.test');
      expect(JSON.stringify(diagnostic)).not.toContain('secret');
      expect(mockedTreasury.markUnknown).toHaveBeenCalledWith('spend:test', diagnostic);
    }
    expect(provider.broadcastTransaction).toHaveBeenCalledTimes(1);
  });

  it('does not broadcast when preparation read fails and reports retryable no movement', async () => {
    const { provider, signer } = setupProvider();
    provider.estimateGas.mockRejectedValue(Object.assign(new Error('unknown block'), { code: 26 }));
    mockedTreasury.prepare.mockImplementation(async request => {
      await request.getPendingNonce();
      const prepared = await request.prepare(7);
      return { alreadyPrepared: false, rawTransaction: prepared.rawTransaction, lease: { ...context(ethers.keccak256('0x1234')), operation_key: request.operationKey } } as never;
    });

    const failed = prepareAndBroadcastTransaction({
      operationKey: 'award:prepare-failure',
      targetType: 'token_operation',
      signer,
      chainId: '80002',
      to: '0x0000000000000000000000000000000000000002',
    });
    await expect(failed).rejects.toMatchObject({
      diagnostic: expect.objectContaining({
        stage: 'prepare',
        errorCode: 'RPC_READ_UNAVAILABLE',
        retryable: true,
        rpcMethod: 'eth_estimateGas',
      }),
    });
    expect(signer.signTransaction).not.toHaveBeenCalled();
    expect(provider.broadcastTransaction).not.toHaveBeenCalled();
  });

  it('classifies a deterministic estimate revert as permanent no movement', async () => {
    const { provider, signer } = setupProvider();
    provider.estimateGas.mockRejectedValue(Object.assign(new Error('execution reverted: allowance'), {
      code: 'CALL_EXCEPTION',
      data: '0x08c379a0',
    }));
    mockedTreasury.prepare.mockImplementation(async request => {
      await request.getPendingNonce();
      const prepared = await request.prepare(7);
      return { alreadyPrepared: false, rawTransaction: prepared.rawTransaction, lease: { ...context(ethers.keccak256('0x1234')), operation_key: request.operationKey } } as never;
    });

    await expect(prepareAndBroadcastTransaction({
      operationKey: 'award:permanent-prepare-failure',
      targetType: 'token_operation',
      signer,
      chainId: '80002',
      to: '0x0000000000000000000000000000000000000002',
    })).rejects.toMatchObject({
      diagnostic: expect.objectContaining({
        stage: 'prepare',
        errorCode: 'TRANSACTION_ESTIMATE_REJECTED',
        retryable: false,
        category: 'preflight',
        rpcMethod: 'eth_estimateGas',
      }),
    });
    expect(signer.signTransaction).not.toHaveBeenCalled();
    expect(provider.broadcastTransaction).not.toHaveBeenCalled();
  });

  it('classifies an invalid signing context as permanent no movement', async () => {
    const { provider, signer } = setupProvider();
    mockedTreasury.prepare.mockImplementation(async request => {
      await request.getPendingNonce();
      const prepared = await request.prepare(7);
      return {
        alreadyPrepared: false,
        rawTransaction: prepared.rawTransaction,
        lease: { ...context(prepared.txHash), operation_key: request.operationKey },
      } as never;
    });

    await expect(prepareAndBroadcastTransaction({
      operationKey: 'award:invalid-signing-context',
      targetType: 'token_operation',
      signer,
      chainId: 80002,
      to: '0x0000000000000000000000000000000000000002',
      accessList: [{ address: 'not-an-address', storageKeys: [] }] as unknown as ethers.AccessList,
    })).rejects.toMatchObject({
      diagnostic: expect.objectContaining({
        stage: 'prepare',
        errorCode: 'SIGNING_CONTEXT_INVALID',
        retryable: false,
        category: 'preflight',
      }),
    });
    expect(provider.broadcastTransaction).not.toHaveBeenCalled();
  });

  it.each([
    ['advisory lock timeout', 'TREASURY_NONCE_LOCK_TIMEOUT', 'TREASURY_NONCE_LOCK_TIMEOUT', 'prepare', true, 'database_unavailable'],
    ['active nonce contention', 'TREASURY_NONCE_BUSY_RETRYABLE:spend:other:10:prepared', 'TREASURY_NONCE_BUSY_RETRYABLE', 'prepare', true, 'database_unavailable'],
    ['invalid pending nonce', 'TREASURY_PENDING_NONCE_UNAVAILABLE', 'TREASURY_PENDING_NONCE_UNAVAILABLE', 'prepare', true, 'rpc_unavailable'],
    ['unavailable allocated nonce', 'TREASURY_NONCE_UNAVAILABLE', 'TREASURY_NONCE_UNAVAILABLE', 'prepare', true, 'database_unavailable'],
    ['abandoned nonce gap', 'TREASURY_NONCE_GAP_REQUIRES_REVIEW:spend:other:10:prepared', 'TREASURY_NONCE_GAP_REQUIRES_REVIEW', 'prepare', false, 'review_required'],
    ['unclassified lease persistence failure', 'LEASE_INSERT_FAILED', 'TRANSACTION_HASH_PERSISTENCE_FAILED', 'persist_hash', true, 'database_unavailable'],
  ])('keeps the preparation boundary for %s', async (_label, message, errorCode, stage, retryable, category) => {
    const { provider, signer } = setupProvider();
    mockedTreasury.prepare.mockRejectedValueOnce(new TreasuryTransactionPreparationError(message));

    await expect(prepareAndBroadcastTransaction({
      operationKey: `coordinator:${_label}`,
      targetType: 'token_operation',
      signer,
      chainId: 80002,
      to: '0x0000000000000000000000000000000000000002',
    })).rejects.toMatchObject({
      diagnostic: expect.objectContaining({
        errorCode,
        stage,
        retryable,
        category,
      }),
    });
    expect(signer.signTransaction).not.toHaveBeenCalled();
    expect(provider.broadcastTransaction).not.toHaveBeenCalled();
  });

  it('treats a saved lease as idempotent and does not broadcast it again', async () => {
    const { provider, signer } = setupProvider();
    const txHash = ethers.keccak256('0x1234');
    mockedTreasury.prepare
      .mockImplementationOnce(async request => {
        await request.getPendingNonce();
        const prepared = await request.prepare(7);
        return { alreadyPrepared: false, rawTransaction: prepared.rawTransaction, lease: { ...context(txHash), operation_key: request.operationKey } } as never;
      })
      .mockResolvedValueOnce({ alreadyPrepared: true, lease: { ...context(txHash), operation_key: 'award:repeat', status: 'submitted' } } as never);

    const input = {
      operationKey: 'award:repeat',
      targetType: 'token_operation' as const,
      signer,
      chainId: '80002',
      to: '0x0000000000000000000000000000000000000002',
    };
    await prepareAndBroadcastTransaction(input);
    const replay = await prepareAndBroadcastTransaction(input);
    expect(replay).toMatchObject({ txHash, alreadyPrepared: true, broadcasted: false });
    expect(provider.broadcastTransaction).toHaveBeenCalledTimes(1);
  });

  it('fails closed when a prepared lease exists without a persisted raw transaction', async () => {
    const { provider, signer } = setupProvider();
    const txHash = ethers.keccak256('0x1234');
    mockedTreasury.prepare.mockResolvedValueOnce({
      alreadyPrepared: true,
      lease: { ...context(txHash), operation_key: 'award:prepared', status: 'prepared' },
    } as never);

    await expect(prepareAndBroadcastTransaction({
      operationKey: 'award:prepared',
      targetType: 'token_operation',
      signer,
      chainId: '80002',
      to: '0x0000000000000000000000000000000000000002',
    })).rejects.toMatchObject({
      diagnostic: expect.objectContaining({
        stage: 'persist_hash',
        errorCode: 'TRANSACTION_PREPARED_REVIEW_REQUIRED',
        savedHash: txHash,
        retryable: false,
      }),
    });
    expect(provider.broadcastTransaction).not.toHaveBeenCalled();
    expect(mockedTreasury.markUnknown).toHaveBeenCalledWith(
      'award:prepared',
      expect.objectContaining({ errorCode: 'TRANSACTION_PREPARED_REVIEW_REQUIRED' }),
    );
  });

  it('routes concurrent award and spend sends through distinct shared nonce leases', async () => {
    const { provider, signer } = setupProvider();
    (provider.getTransactionCount as jest.Mock).mockResolvedValue(11);
    const allocatedNonces: number[] = [];
    let nextNonce = 11;
    let queue = Promise.resolve();
    mockedTreasury.prepare.mockImplementation(async request => {
      let release!: () => void;
      const previous = queue;
      queue = new Promise<void>(resolve => { release = resolve; });
      await previous;
      try {
        const nonce = Math.max(await request.getPendingNonce(), nextNonce);
        nextNonce = nonce + 1;
        allocatedNonces.push(nonce);
        const prepared = await request.prepare(nonce);
        return {
          alreadyPrepared: false,
          rawTransaction: prepared.rawTransaction,
          lease: {
            operation_key: request.operationKey,
            target_type: request.targetType,
            chain_id: String(request.chainId),
            signer_address: '0x0000000000000000000000000000000000000001',
            nonce,
            tx_hash: prepared.txHash,
            tx_context: prepared.context,
            status: 'prepared',
          },
        } as never;
      } finally {
        release();
      }
    });

    await Promise.all([
      prepareAndBroadcastTransaction({
        operationKey: 'award:concurrent',
        targetType: 'token_operation',
        signer,
        chainId: 80002,
        to: '0x0000000000000000000000000000000000000002',
        data: '0xabcd',
      }),
      prepareAndBroadcastTransaction({
        operationKey: 'spend:concurrent',
        targetType: 'token_operation',
        signer,
        chainId: 80002,
        to: '0x0000000000000000000000000000000000000002',
        data: '0xdcba',
      }),
    ]);

    expect(allocatedNonces).toEqual([11, 12]);
    expect(new Set(allocatedNonces).size).toBe(2);
    expect(mockedTreasury.markSubmitted).toHaveBeenCalledTimes(2);
    expect(provider.broadcastTransaction).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['tuple access-list entries', [['0x0000000000000000000000000000000000000003', ['0x' + '11'.repeat(32)]]] as unknown as ethers.AccessList],
    ['object access-list entries', [{ address: '0x0000000000000000000000000000000000000003', storageKeys: ['0x' + '22'.repeat(32)] }] as unknown as ethers.AccessList],
  ])('persists normalized signing context for %s', async (_label, accessList) => {
    const { provider, signer } = setupProvider();
    const txHash = ethers.keccak256('0x1234');
    mockedTreasury.prepare.mockImplementation(async request => {
      await request.getPendingNonce();
      const prepared = await request.prepare(7);
      return {
        alreadyPrepared: false,
        rawTransaction: prepared.rawTransaction,
        lease: { ...context(txHash), operation_key: request.operationKey, tx_context: prepared.context },
      } as never;
    });

    const result = await prepareAndBroadcastTransaction({
      operationKey: `access-list:${_label}`,
      targetType: 'standalone',
      signer,
      chainId: '80002',
      to: '0x0000000000000000000000000000000000000002',
      accessList,
    });

    expect(result.context.accessList).toEqual([
      ['0x0000000000000000000000000000000000000003', [expect.stringMatching(/^0x[0-9a-f]{64}$/)]],
    ]);
  });
});
