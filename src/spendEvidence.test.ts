import { ethers } from 'ethers';
import { SpendEvidenceRequest, verifySpendEvidence } from './spendEvidence';

const TOKEN = '0x2222222222222222222222222222222222222222';
const SOURCE = '0x1111111111111111111111111111111111111111';
const TREASURY = '0x3333333333333333333333333333333333333333';
const SPENDER = '0x4444444444444444444444444444444444444444';
const TX_HASH = `0x${'a'.repeat(64)}`;
const AMOUNT = ethers.parseUnits('5', 18);

const tokenInterface = new ethers.Interface([
  'function transfer(address to,uint256 amount)',
  'function transferFrom(address from,address to,uint256 amount)',
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);

function transferLog(
  source = SOURCE,
  recipient = TREASURY,
  amount = AMOUNT,
  address = TOKEN
) {
  const event = tokenInterface.getEvent('Transfer');
  if (!event) throw new Error('Transfer event fixture is unavailable');
  const encoded = tokenInterface.encodeEventLog(event, [source, recipient, amount]);
  return { address, topics: encoded.topics, data: encoded.data, index: 0 };
}

function transaction(
  data: string,
  from = SOURCE,
  to = TOKEN,
  chainId: bigint = 80002n,
  hash = TX_HASH
): ethers.TransactionResponse {
  return {
    hash,
    from,
    to,
    data,
    value: 0n,
    chainId,
  } as unknown as ethers.TransactionResponse;
}

function receipt(
  logs: unknown[],
  status: number | null = 1,
  from = SOURCE,
  to = TOKEN,
  hash = TX_HASH
): ethers.TransactionReceipt {
  return {
    hash,
    from,
    to,
    status,
    blockNumber: 123,
    logs,
  } as unknown as ethers.TransactionReceipt;
}

function providerFor(
  tx: ethers.TransactionResponse | null,
  minedReceipt: ethers.TransactionReceipt | null,
  chainId: bigint | number = 80002n
): ethers.Provider {
  return {
    getNetwork: jest.fn().mockResolvedValue({ chainId }),
    getTransaction: jest.fn().mockResolvedValue(tx),
    getTransactionReceipt: jest.fn().mockResolvedValue(minedReceipt),
  } as unknown as ethers.Provider;
}

function request(overrides: Partial<SpendEvidenceRequest> = {}): SpendEvidenceRequest {
  const data = tokenInterface.encodeFunctionData('transfer', [TREASURY, AMOUNT]);
  return {
    provider: providerFor(
      transaction(data),
      receipt([transferLog()])
    ),
    tokenContractAddress: TOKEN,
    chainId: 80002,
    sourceWallet: SOURCE,
    treasuryRecipient: TREASURY,
    amountUnits: AMOUNT.toString(),
    txHash: TX_HASH,
    ...overrides,
  };
}

describe('verifySpendEvidence', () => {
  it('accepts a successful transfer proved by the expected Transfer event', async () => {
    const result = await verifySpendEvidence(request());

    expect(result).toMatchObject({
      valid: true,
      proof: {
        txHash: TX_HASH,
        chainId: '80002',
        tokenContractAddress: ethers.getAddress(TOKEN),
        sourceWallet: ethers.getAddress(SOURCE),
        treasuryRecipient: ethers.getAddress(TREASURY),
        amountUnits: AMOUNT.toString(),
        transferMethod: 'transfer',
        transactionFrom: ethers.getAddress(SOURCE),
        blockNumber: 123,
        logIndex: 0,
      },
    });
  });

  it('retries transient receipt errors and then verifies the same read-only evidence', async () => {
    const evidenceProvider = providerFor(
      transaction(tokenInterface.encodeFunctionData('transfer', [TREASURY, AMOUNT])),
      receipt([transferLog()]),
    );
    const getReceipt = evidenceProvider.getTransactionReceipt as jest.Mock;
    getReceipt
      .mockRejectedValueOnce({ error: { code: 26, message: 'Unknown block' } })
      .mockResolvedValueOnce(receipt([transferLog()]));

    const result = await verifySpendEvidence(request({
      provider: evidenceProvider,
      readRetry: { delayMs: 0 },
    }));

    expect(result).toMatchObject({ valid: true });
    expect(getReceipt).toHaveBeenCalledTimes(2);
  });

  it('retries a transient transaction timeout but exhausts the fixed budget safely', async () => {
    const evidenceProvider = providerFor(
      transaction(tokenInterface.encodeFunctionData('transfer', [TREASURY, AMOUNT])),
      receipt([transferLog()]),
    );
    const getTransaction = evidenceProvider.getTransaction as jest.Mock;
    getTransaction
      .mockRejectedValueOnce({ code: 'UNKNOWN_ERROR', error: { code: 30, message: 'Request timeout' } })
      .mockRejectedValueOnce({ code: 'UNKNOWN_ERROR', error: { code: 30, message: 'Request timeout' } })
      .mockRejectedValueOnce({ code: 'UNKNOWN_ERROR', error: { code: 30, message: 'Request timeout' } });

    const result = await verifySpendEvidence(request({
      provider: evidenceProvider,
      readRetry: { delayMs: 0 },
    }));

    expect(result).toMatchObject({
      valid: false,
      failure: { code: 'PROVIDER_ERROR', pending: false },
    });
    expect(getTransaction).toHaveBeenCalledTimes(3);
    expect(evidenceProvider.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it('does not retry a deterministic transaction or receipt mismatch', async () => {
    const evidenceProvider = providerFor(
      transaction(
        tokenInterface.encodeFunctionData('transfer', [TREASURY, AMOUNT]),
        SOURCE,
        '0x5555555555555555555555555555555555555555',
      ),
      receipt([transferLog()]),
    );

    const result = await verifySpendEvidence(request({
      provider: evidenceProvider,
      readRetry: { delayMs: 0 },
    }));

    expect(result).toMatchObject({ valid: false, failure: { code: 'WRONG_TOKEN_CONTRACT' } });
    expect(evidenceProvider.getTransaction).toHaveBeenCalledTimes(1);
    expect(evidenceProvider.getTransactionReceipt).not.toHaveBeenCalled();
  });

  it('accepts transferFrom when the call and event prove the expected wallet to treasury movement', async () => {
    const data = tokenInterface.encodeFunctionData('transferFrom', [SOURCE, TREASURY, AMOUNT]);
    const result = await verifySpendEvidence(request({
      provider: providerFor(
        transaction(data, SPENDER),
        receipt([transferLog()], 1, SPENDER)
      ),
    }));

    expect(result).toMatchObject({ valid: true, proof: { transferMethod: 'transferFrom' } });
  });

  it('rejects calldata-only evidence without a successful Transfer event', async () => {
    const data = tokenInterface.encodeFunctionData('transfer', [TREASURY, AMOUNT]);
    const result = await verifySpendEvidence(request({
      provider: providerFor(transaction(data), receipt([])),
    }));

    expect(result).toMatchObject({
      valid: false,
      failure: { code: 'MISSING_TRANSFER_EVENT', pending: false },
    });
  });

  it('returns structured missing, pending, and failed transaction outcomes', async () => {
    await expect(verifySpendEvidence(request({
      provider: providerFor(null, null),
    }))).resolves.toMatchObject({
      valid: false,
      failure: { code: 'TRANSACTION_NOT_FOUND', pending: false },
    });

    await expect(verifySpendEvidence(request({
      provider: providerFor(
        transaction(tokenInterface.encodeFunctionData('transfer', [TREASURY, AMOUNT])),
        null
      ),
    }))).resolves.toMatchObject({
      valid: false,
      failure: { code: 'RECEIPT_PENDING', pending: true },
    });

    const data = tokenInterface.encodeFunctionData('transfer', [TREASURY, AMOUNT]);
    await expect(verifySpendEvidence(request({
      provider: providerFor(transaction(data), receipt([], 0)),
    }))).resolves.toMatchObject({
      valid: false,
      failure: { code: 'TRANSACTION_FAILED', pending: false },
    });

    await expect(verifySpendEvidence(request({
      provider: providerFor(transaction(data), receipt([], null)),
    }))).resolves.toMatchObject({
      valid: false,
      failure: { code: 'MALFORMED_RECEIPT', pending: false },
    });

    const wrongHash = `0x${'b'.repeat(64)}`;
    await expect(verifySpendEvidence(request({
      provider: providerFor(transaction(data), receipt([], 0, SOURCE, TOKEN, wrongHash)),
    }))).resolves.toMatchObject({
      valid: false,
      failure: { code: 'RECEIPT_IDENTITY_MISMATCH', pending: false },
    });

    const unknownStatusReceipt = { ...receipt([], 1), status: undefined } as unknown as ethers.TransactionReceipt;
    await expect(verifySpendEvidence(request({
      provider: providerFor(transaction(data), unknownStatusReceipt),
    }))).resolves.toMatchObject({
      valid: false,
      failure: { code: 'MALFORMED_RECEIPT', pending: false },
    });
  });

  it('rejects malformed hashes, amounts, addresses, and wrong chains before evidence lookup', async () => {
    await expect(verifySpendEvidence(request({ txHash: '0x1234' }))).resolves.toMatchObject({
      valid: false,
      failure: { code: 'INVALID_TX_HASH' },
    });
    await expect(verifySpendEvidence(request({ amountUnits: 5 as unknown as string }))).resolves.toMatchObject({
      valid: false,
      failure: { code: 'INVALID_AMOUNT' },
    });
    await expect(verifySpendEvidence(request({ tokenContractAddress: '0xnot-an-address' }))).resolves.toMatchObject({
      valid: false,
      failure: { code: 'INVALID_ADDRESS' },
    });
    await expect(verifySpendEvidence(request({
      provider: providerFor(transaction(tokenInterface.encodeFunctionData('transfer', [TREASURY, AMOUNT])), receipt([]), 1n),
    }))).resolves.toMatchObject({
      valid: false,
      failure: { code: 'WRONG_CHAIN' },
    });
  });

  it('rejects the wrong token contract and unsupported or malformed calls', async () => {
    const data = tokenInterface.encodeFunctionData('transfer', [TREASURY, AMOUNT]);
    await expect(verifySpendEvidence(request({
      provider: providerFor(transaction(data, SOURCE, '0x5555555555555555555555555555555555555555'), receipt([transferLog()])),
    }))).resolves.toMatchObject({ valid: false, failure: { code: 'WRONG_TOKEN_CONTRACT' } });

    const approve = new ethers.Interface(['function approve(address spender,uint256 amount)']);
    await expect(verifySpendEvidence(request({
      provider: providerFor(transaction(approve.encodeFunctionData('approve', [TREASURY, AMOUNT])), receipt([])),
    }))).resolves.toMatchObject({ valid: false, failure: { code: 'UNSUPPORTED_TOKEN_CALL' } });

    await expect(verifySpendEvidence(request({
      provider: providerFor(transaction('0x1234'), receipt([])),
    }))).resolves.toMatchObject({ valid: false, failure: { code: 'MALFORMED_CALL' } });
  });

  it('binds provider transaction and receipt identities to the requested hash and asset', async () => {
    const data = tokenInterface.encodeFunctionData('transfer', [TREASURY, AMOUNT]);
    const differentHash = `0x${'b'.repeat(64)}`;

    await expect(verifySpendEvidence(request({
      provider: providerFor(
        transaction(data, SOURCE, TOKEN, 80002n, differentHash),
        receipt([transferLog()])
      ),
    }))).resolves.toMatchObject({
      valid: false,
      failure: { code: 'TRANSACTION_IDENTITY_MISMATCH' },
    });

    await expect(verifySpendEvidence(request({
      provider: providerFor(
        transaction(data),
        receipt([transferLog()], 1, SOURCE, TOKEN, differentHash)
      ),
    }))).resolves.toMatchObject({
      valid: false,
      failure: { code: 'RECEIPT_IDENTITY_MISMATCH' },
    });

    const wrongReceiptFrom = '0x7777777777777777777777777777777777777777';
    await expect(verifySpendEvidence(request({
      provider: providerFor(
        transaction(data),
        receipt([transferLog()], 1, wrongReceiptFrom)
      ),
    }))).resolves.toMatchObject({
      valid: false,
      failure: { code: 'RECEIPT_IDENTITY_MISMATCH' },
    });

    await expect(verifySpendEvidence(request({
      provider: providerFor(
        transaction(data),
        receipt([transferLog()], 1, SOURCE, '0x8888888888888888888888888888888888888888')
      ),
    }))).resolves.toMatchObject({
      valid: false,
      failure: { code: 'WRONG_TOKEN_CONTRACT' },
    });
  });

  it('rejects a nonzero typed transaction chain mismatch but permits legacy chainId zero', async () => {
    const data = tokenInterface.encodeFunctionData('transfer', [TREASURY, AMOUNT]);
    await expect(verifySpendEvidence(request({
      provider: providerFor(
        transaction(data, SOURCE, TOKEN, 1n),
        receipt([transferLog()])
      ),
    }))).resolves.toMatchObject({
      valid: false,
      failure: { code: 'WRONG_CHAIN' },
    });

    const legacyResult = await verifySpendEvidence(request({
      provider: providerFor(
        transaction(data, SOURCE, TOKEN, 0n),
        receipt([transferLog()])
      ),
    }));
    expect(legacyResult).toMatchObject({ valid: true });
  });

  it('rejects wrong sender, recipient, amount, and malformed Transfer logs', async () => {
    const data = tokenInterface.encodeFunctionData('transfer', [TREASURY, AMOUNT]);
    await expect(verifySpendEvidence(request({
      provider: providerFor(transaction(data, SPENDER), receipt([transferLog()], 1, SPENDER)),
    }))).resolves.toMatchObject({ valid: false, failure: { code: 'WRONG_SENDER' } });

    const wrongRecipient = '0x6666666666666666666666666666666666666666';
    await expect(verifySpendEvidence(request({
      provider: providerFor(transaction(data), receipt([transferLog(SOURCE, wrongRecipient)])),
    }))).resolves.toMatchObject({ valid: false, failure: { code: 'WRONG_RECIPIENT' } });

    await expect(verifySpendEvidence(request({
      provider: providerFor(transaction(data), receipt([transferLog(SOURCE, TREASURY, AMOUNT + 1n)])),
    }))).resolves.toMatchObject({ valid: false, failure: { code: 'WRONG_AMOUNT' } });

    await expect(verifySpendEvidence(request({
      provider: providerFor(transaction(data), receipt([{
        address: TOKEN,
        topics: [ethers.id('Transfer(address,address,uint256)'), '0x1234'],
        data: '0x',
        index: 0,
      }])),
    }))).resolves.toMatchObject({ valid: false, failure: { code: 'MALFORMED_TRANSFER_LOG' } });
  });
});
