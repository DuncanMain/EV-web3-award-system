import { ethers } from 'ethers';
import {
  RpcReadRetryOptions,
  withNullableRpcReadRetry,
  withRpcReadRetry,
} from './rpcProvider';

const TX_HASH_PATTERN = /^0x[0-9a-fA-F]{64}$/;
const TRANSFER_TOPIC = ethers.id('Transfer(address,address,uint256)').toLowerCase();
const TOKEN_INTERFACE = new ethers.Interface([
  'function transfer(address to,uint256 amount)',
  'function transferFrom(address from,address to,uint256 amount)',
  'function approve(address spender,uint256 amount)',
]);
const TRANSFER_INTERFACE = new ethers.Interface([
  'event Transfer(address indexed from,address indexed to,uint256 value)',
]);

export type SpendEvidenceFailureCode =
  | 'INVALID_TX_HASH'
  | 'INVALID_ADDRESS'
  | 'INVALID_AMOUNT'
  | 'INVALID_CHAIN_ID'
  | 'TRANSACTION_NOT_FOUND'
  | 'RECEIPT_PENDING'
  | 'TRANSACTION_FAILED'
  | 'TRANSACTION_IDENTITY_MISMATCH'
  | 'RECEIPT_IDENTITY_MISMATCH'
  | 'WRONG_CHAIN'
  | 'WRONG_TOKEN_CONTRACT'
  | 'MALFORMED_CALL'
  | 'UNSUPPORTED_TOKEN_CALL'
  | 'WRONG_SENDER'
  | 'WRONG_RECIPIENT'
  | 'WRONG_AMOUNT'
  | 'MISSING_TRANSFER_EVENT'
  | 'MALFORMED_TRANSFER_LOG'
  | 'MALFORMED_RECEIPT'
  | 'PROVIDER_ERROR';

export interface SpendEvidenceFailure {
  code: SpendEvidenceFailureCode;
  message: string;
  pending: boolean;
}

export interface SpendEvidenceRequest {
  provider: ethers.Provider;
  tokenContractAddress: string;
  chainId: bigint | number | string;
  sourceWallet: string;
  treasuryRecipient: string;
  /** Exact ERC20 base units. Convert an 18-decimal amount with ethers.parseUnits. */
  amountUnits: bigint | string;
  txHash: string;
  /** Optional test hook; production uses the bounded provider-read policy. */
  readRetry?: RpcReadRetryOptions;
}

export interface SpendEvidenceProof {
  txHash: string;
  chainId: string;
  tokenContractAddress: string;
  sourceWallet: string;
  treasuryRecipient: string;
  amountUnits: string;
  transferMethod: 'transfer' | 'transferFrom';
  transactionFrom: string;
  blockNumber: number;
  logIndex: number;
}

export type SpendEvidenceResult =
  | { valid: true; proof: SpendEvidenceProof }
  | { valid: false; failure: SpendEvidenceFailure };

function failure(
  code: SpendEvidenceFailureCode,
  message: string,
  pending = false
): SpendEvidenceResult {
  return { valid: false, failure: { code, message, pending } };
}

function canonicalAddress(value: unknown, fieldName: string): string | SpendEvidenceFailure {
  if (typeof value !== 'string') {
    return {
      code: 'INVALID_ADDRESS',
      message: `${fieldName} must be a valid Ethereum address`,
      pending: false,
    };
  }
  try {
    return ethers.getAddress(value);
  } catch {
    return {
      code: 'INVALID_ADDRESS',
      message: `${fieldName} must be a valid Ethereum address`,
      pending: false,
    };
  }
}

function parseChainId(value: unknown): bigint | SpendEvidenceFailure {
  if (typeof value === 'bigint') {
    return value >= 0n
      ? value
      : { code: 'INVALID_CHAIN_ID', message: 'chainId must be a non-negative integer', pending: false };
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0
      ? BigInt(value)
      : { code: 'INVALID_CHAIN_ID', message: 'chainId must be a non-negative safe integer', pending: false };
  }
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return BigInt(value);
  return { code: 'INVALID_CHAIN_ID', message: 'chainId must be a non-negative integer', pending: false };
}

function parseAmountUnits(value: unknown): bigint | SpendEvidenceFailure {
  if (typeof value === 'bigint') {
    return value >= 0n
      ? value
      : { code: 'INVALID_AMOUNT', message: 'amountUnits must be a non-negative integer string or bigint', pending: false };
  }
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return BigInt(value);
  return {
    code: 'INVALID_AMOUNT',
    message: 'amountUnits must be an exact non-negative integer string or bigint; floating numbers are unsupported',
    pending: false,
  };
}

function formatProviderError(operation: string, error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return `${operation} failed while verifying spend evidence: ${detail}`;
}

/**
 * Verifies a mined ERC20 spend without writing state or submitting a
 * transaction. A successful calldata decode is never sufficient: the receipt
 * must contain the expected token's successful Transfer event.
 */
export async function verifySpendEvidence(
  input: SpendEvidenceRequest
): Promise<SpendEvidenceResult> {
  if (!TX_HASH_PATTERN.test(input.txHash)) {
    return failure('INVALID_TX_HASH', 'txHash must be a 32-byte 0x-prefixed transaction hash');
  }
  const txHash = input.txHash.toLowerCase();

  const tokenContract = canonicalAddress(input.tokenContractAddress, 'tokenContractAddress');
  if (typeof tokenContract !== 'string') return { valid: false, failure: tokenContract };
  const sourceWallet = canonicalAddress(input.sourceWallet, 'sourceWallet');
  if (typeof sourceWallet !== 'string') return { valid: false, failure: sourceWallet };
  const treasuryRecipient = canonicalAddress(input.treasuryRecipient, 'treasuryRecipient');
  if (typeof treasuryRecipient !== 'string') return { valid: false, failure: treasuryRecipient };

  const expectedChainId = parseChainId(input.chainId);
  if (typeof expectedChainId !== 'bigint') return { valid: false, failure: expectedChainId };
  const expectedAmount = parseAmountUnits(input.amountUnits);
  if (typeof expectedAmount !== 'bigint') return { valid: false, failure: expectedAmount };

  let network: ethers.Network;
  let transaction: ethers.TransactionResponse | null;
  try {
    network = await withRpcReadRetry(
      () => input.provider.getNetwork(),
      input.readRetry,
    );
    transaction = await withNullableRpcReadRetry(
      () => input.provider.getTransaction(txHash),
      input.readRetry,
    );
  } catch (error) {
    return failure('PROVIDER_ERROR', formatProviderError('transaction lookup', error));
  }

  let actualChainId: bigint;
  try {
    actualChainId = BigInt(network.chainId);
  } catch {
    return failure('PROVIDER_ERROR', 'provider returned an invalid chain ID');
  }
  if (actualChainId !== expectedChainId) {
    return failure(
      'WRONG_CHAIN',
      `transaction provider chain ${actualChainId.toString()} does not match expected chain ${expectedChainId.toString()}`
    );
  }
  if (!transaction) {
    return failure('TRANSACTION_NOT_FOUND', `transaction ${txHash} was not found`);
  }
  if (typeof transaction.hash !== 'string' || transaction.hash.toLowerCase() !== txHash) {
    return failure(
      'TRANSACTION_IDENTITY_MISMATCH',
      `provider returned transaction hash ${transaction.hash || 'missing'} for requested hash ${txHash}`
    );
  }

  if (transaction.chainId !== undefined && transaction.chainId !== null) {
    let transactionChainId: bigint;
    try {
      transactionChainId = BigInt(transaction.chainId);
    } catch {
      return failure('TRANSACTION_IDENTITY_MISMATCH', 'provider returned an invalid transaction chain ID');
    }
    // A legacy unprotected transaction may expose chainId 0. The verified
    // provider network remains authoritative for that legacy case.
    if (transactionChainId !== 0n && transactionChainId !== expectedChainId) {
      return failure(
        'WRONG_CHAIN',
        `transaction chain ${transactionChainId.toString()} does not match expected chain ${expectedChainId.toString()}`
      );
    }
  }

  // A transaction targeting another contract cannot become valid through a
  // later receipt. Reject it before issuing the additional receipt read.
  if (!transaction.to || transaction.to.toLowerCase() !== tokenContract.toLowerCase()) {
    return failure(
      'WRONG_TOKEN_CONTRACT',
      `transaction target ${transaction.to || 'null'} does not match expected token contract ${tokenContract}`
    );
  }

  let receipt: ethers.TransactionReceipt | null;
  try {
    receipt = await withNullableRpcReadRetry(
      () => input.provider.getTransactionReceipt(txHash),
      input.readRetry,
    );
  } catch (error) {
    return failure('PROVIDER_ERROR', formatProviderError('receipt lookup', error));
  }
  if (!receipt) {
    return failure('RECEIPT_PENDING', `transaction ${txHash} has no mined receipt yet`, true);
  }

  if (typeof receipt.hash !== 'string' || receipt.hash.toLowerCase() !== txHash) {
    return failure(
      'RECEIPT_IDENTITY_MISMATCH',
      `provider returned receipt hash ${receipt.hash || 'missing'} for requested hash ${txHash}`
    );
  }

  if (!receipt.to || receipt.to.toLowerCase() !== tokenContract.toLowerCase()) {
    return failure(
      'WRONG_TOKEN_CONTRACT',
      `receipt target ${receipt.to || 'null'} does not match expected token contract ${tokenContract}`
    );
  }

  const transactionFrom = canonicalAddress(transaction.from, 'transaction.from');
  if (typeof transactionFrom !== 'string') return { valid: false, failure: transactionFrom };
  const receiptFrom = canonicalAddress(receipt.from, 'receipt.from');
  if (typeof receiptFrom !== 'string') {
    return { valid: false, failure: {
      code: 'RECEIPT_IDENTITY_MISMATCH',
      message: receiptFrom.message,
      pending: false,
    } };
  }
  if (receiptFrom.toLowerCase() !== transactionFrom.toLowerCase()) {
    return failure(
      'RECEIPT_IDENTITY_MISMATCH',
      `receipt sender ${receiptFrom} does not match transaction sender ${transactionFrom}`
    );
  }

  // Only an exactly identified receipt with an explicit failed status proves
  // that no token movement occurred.  Unknown or malformed status values
  // remain reviewable and must never be downgraded to no-movement.
  if (receipt.status === 0) {
    return failure(
      'TRANSACTION_FAILED',
      `transaction ${txHash} mined with unsuccessful receipt status ${String(receipt.status)}`
    );
  }
  if (receipt.status !== 1) {
    return failure(
      'MALFORMED_RECEIPT',
      `transaction ${txHash} returned an invalid receipt status ${String(receipt.status)}`
    );
  }

  let parsedCall: ethers.TransactionDescription | null;
  try {
    parsedCall = TOKEN_INTERFACE.parseTransaction({
      data: transaction.data,
      value: transaction.value,
    });
  } catch {
    return failure('MALFORMED_CALL', 'transaction calldata is not a valid ERC20 transfer or transferFrom call');
  }
  if (!parsedCall) {
    return failure('MALFORMED_CALL', 'transaction calldata is empty or undecodable');
  }
  if (parsedCall.name !== 'transfer' && parsedCall.name !== 'transferFrom') {
    return failure('UNSUPPORTED_TOKEN_CALL', `token call ${parsedCall.name} is not transfer or transferFrom`);
  }

  let callSource: string;
  let callRecipient: string;
  let callAmount: bigint;
  try {
    if (parsedCall.name === 'transfer') {
      callSource = transactionFrom;
      callRecipient = ethers.getAddress(String(parsedCall.args[0]));
      callAmount = BigInt(parsedCall.args[1]);
    } else {
      callSource = ethers.getAddress(String(parsedCall.args[0]));
      callRecipient = ethers.getAddress(String(parsedCall.args[1]));
      callAmount = BigInt(parsedCall.args[2]);
    }
  } catch {
    return failure('MALFORMED_CALL', 'ERC20 transfer calldata contains invalid arguments');
  }
  if (callSource.toLowerCase() !== sourceWallet.toLowerCase()) {
    return failure('WRONG_SENDER', `ERC20 call sender ${callSource} does not match expected source ${sourceWallet}`);
  }
  if (callRecipient.toLowerCase() !== treasuryRecipient.toLowerCase()) {
    return failure('WRONG_RECIPIENT', `ERC20 call recipient ${callRecipient} does not match expected treasury ${treasuryRecipient}`);
  }
  if (callAmount !== expectedAmount) {
    return failure('WRONG_AMOUNT', `ERC20 call amount ${callAmount.toString()} does not match expected ${expectedAmount.toString()}`);
  }

  let sawTransferLog = false;
  let malformedTransferLog = false;
  let wrongSender = false;
  let wrongRecipient = false;
  let wrongAmount = false;

  const logs = Array.isArray(receipt.logs) ? receipt.logs : [];
  for (let index = 0; index < logs.length; index += 1) {
    const log = logs[index];
    if (!log || typeof log.address !== 'string' || !Array.isArray(log.topics) || typeof log.data !== 'string') {
      malformedTransferLog = true;
      continue;
    }
    if (log.address.toLowerCase() !== tokenContract.toLowerCase()) continue;
    if (!log.topics[0] || typeof log.topics[0] !== 'string' || log.topics[0].toLowerCase() !== TRANSFER_TOPIC) continue;
    sawTransferLog = true;

    let parsedLog: ethers.LogDescription | null;
    try {
      parsedLog = TRANSFER_INTERFACE.parseLog({ topics: log.topics, data: log.data });
    } catch {
      malformedTransferLog = true;
      continue;
    }
    if (!parsedLog) {
      malformedTransferLog = true;
      continue;
    }

    try {
      const eventSource = ethers.getAddress(String(parsedLog.args[0]));
      const eventRecipient = ethers.getAddress(String(parsedLog.args[1]));
      const eventAmount = BigInt(parsedLog.args[2]);
      if (eventSource.toLowerCase() === sourceWallet.toLowerCase() &&
          eventRecipient.toLowerCase() === treasuryRecipient.toLowerCase() &&
          eventAmount === expectedAmount) {
        return {
          valid: true,
          proof: {
            txHash,
            chainId: expectedChainId.toString(),
            tokenContractAddress: tokenContract,
            sourceWallet,
            treasuryRecipient,
            amountUnits: expectedAmount.toString(),
            transferMethod: parsedCall.name,
            transactionFrom,
            blockNumber: receipt.blockNumber,
            logIndex: log.index ?? index,
          },
        };
      }
      if (eventSource.toLowerCase() !== sourceWallet.toLowerCase()) wrongSender = true;
      if (eventRecipient.toLowerCase() !== treasuryRecipient.toLowerCase()) wrongRecipient = true;
      if (eventAmount !== expectedAmount) wrongAmount = true;
    } catch {
      malformedTransferLog = true;
    }
  }

  if (malformedTransferLog) {
    return failure('MALFORMED_TRANSFER_LOG', 'token Transfer log is malformed or contains invalid arguments');
  }
  if (!sawTransferLog) {
    return failure('MISSING_TRANSFER_EVENT', 'successful receipt contains no Transfer event from the expected token contract');
  }
  if (wrongSender) return failure('WRONG_SENDER', 'token Transfer event sender does not match expected source wallet');
  if (wrongRecipient) return failure('WRONG_RECIPIENT', 'token Transfer event recipient does not match expected treasury');
  if (wrongAmount) return failure('WRONG_AMOUNT', 'token Transfer event amount does not match expected amountUnits');
  return failure('MALFORMED_TRANSFER_LOG', 'token Transfer event could not be verified');
}
