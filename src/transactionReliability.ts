import { ethers } from 'ethers';
import {
  TreasuryTransactionPreparationError,
  TreasuryTransactions,
  TreasuryTransactionTargetType,
} from './database/service';
import {
  extractRpcDiagnostic,
  isTransientRpcReadError,
  withRpcReadRetry,
} from './rpcProvider';
import type {
  PreparedTransactionContext,
  PreparedTreasuryTransaction,
  TransactionDiagnostic,
  TransactionDiagnosticCategory,
  TransactionDiagnosticStage,
} from './types';

export interface TreasuryTransactionRequest {
  operationKey: string;
  targetOperationKey?: string;
  targetType: TreasuryTransactionTargetType;
  signer: ethers.Signer;
  chainId: string | number;
  to: string;
  data?: string;
  value?: ethers.BigNumberish;
  accessList?: ethers.AccessList;
}

export interface TransactionReliabilityResult {
  txHash: string;
  context: PreparedTransactionContext;
  broadcasted: boolean;
  alreadyPrepared: boolean;
}

export class TransactionReliabilityError extends Error {
  readonly diagnostic: TransactionDiagnostic;

  constructor(diagnostic: TransactionDiagnostic) {
    super(diagnostic.errorCode);
    this.name = 'TransactionReliabilityError';
    this.diagnostic = diagnostic;
  }
}

/** A diagnostic at or before durable hash persistence proves no broadcast. */
export function isPreBroadcastTransactionDiagnostic(diagnostic: TransactionDiagnostic | undefined): boolean {
  return Boolean(diagnostic
    && !diagnostic.savedHash
    && ['asset_context', 'preflight', 'prepare', 'persist_hash'].includes(diagnostic.stage));
}

function boundedString(value: unknown, max = 96): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return text ? text.slice(0, max) : undefined;
}

function safeProviderDetails(error: unknown): Pick<
  TransactionDiagnostic,
  'providerCode' | 'rpcCode' | 'httpStatus' | 'traceId' | 'rpcEndpoint' | 'rpcFailover'
> {
  const details = extractRpcDiagnostic(error);
  return {
    ...(details.providerCode ? { providerCode: details.providerCode } : {}),
    ...(details.rpcCode === undefined ? {} : { rpcCode: details.rpcCode }),
    ...(details.httpStatus === undefined ? {} : { httpStatus: details.httpStatus }),
    ...(details.traceId ? { traceId: details.traceId } : {}),
    ...(details.endpointLabel ? { rpcEndpoint: details.endpointLabel } : {}),
    ...(details.failover?.length ? { rpcFailover: details.failover } : {}),
  };
}

function diagnosticFor(
  stage: TransactionDiagnosticStage,
  errorCode: string,
  error: unknown,
  options: {
    rpcMethod?: string;
    retryable?: boolean;
    category?: TransactionDiagnosticCategory;
    savedHash?: string;
    nonce?: number;
  } = {},
): TransactionDiagnostic {
  return {
    stage,
    errorCode,
    retryable: options.retryable ?? false,
    ...(options.category ? { category: options.category } : {}),
    ...(options.rpcMethod ? { rpcMethod: options.rpcMethod } : {}),
    ...safeProviderDetails(error),
    ...(options.savedHash ? { savedHash: options.savedHash } : {}),
    ...(options.nonce === undefined ? {} : { nonce: options.nonce }),
  };
}

export function createTransactionDiagnostic(
  stage: TransactionDiagnosticStage,
  errorCode: string,
  error: unknown,
  options: {
    rpcMethod?: string;
    retryable?: boolean;
    category?: TransactionDiagnosticCategory;
    savedHash?: string;
    nonce?: number;
  } = {},
): TransactionDiagnostic {
  return diagnosticFor(stage, errorCode, error, options);
}

function requestValue(value: ethers.BigNumberish | undefined): bigint {
  if (value === undefined) return 0n;
  return BigInt(value.toString());
}

function toContext(
  request: TreasuryTransactionRequest,
  signerAddress: string,
  nonce: number,
  tx: ethers.TransactionRequest,
): PreparedTransactionContext {
  const accessList = tx.accessList as unknown;
  let normalizedAccessList: Array<[string, string[]]> | undefined;
  if (accessList !== null && accessList !== undefined) {
    const entries = accessList as unknown[];
    normalizedAccessList = entries.map(entry => {
      if (Array.isArray(entry)) {
        return [ethers.getAddress(String(entry[0])), [...(entry[1] as string[])]] as [string, string[]];
      }
      const objectEntry = entry as { address?: unknown; storageKeys?: unknown };
      if (typeof objectEntry.address !== 'string' || !Array.isArray(objectEntry.storageKeys)) {
        throw new Error('INVALID_ACCESS_LIST');
      }
      return [ethers.getAddress(objectEntry.address), objectEntry.storageKeys.map(key => String(key))] as [string, string[]];
    });
  }
  const context: PreparedTransactionContext = {
    chainId: String(request.chainId),
    signerAddress,
    nonce,
    to: ethers.getAddress(request.to),
    // `baseRequest` always supplies data to ethers, including the explicit
    // `0x` value for native transfers. Persist that actual signing field so a
    // standalone lease can be compared against the complete request intent.
    data: typeof tx.data === 'string' ? tx.data : '0x',
    value: requestValue(request.value).toString(),
    ...(tx.gasLimit === undefined || tx.gasLimit === null ? {} : { gasLimit: BigInt(tx.gasLimit.toString()).toString() }),
    ...(tx.gasPrice === undefined || tx.gasPrice === null ? {} : { gasPrice: BigInt(tx.gasPrice.toString()).toString() }),
    ...(tx.maxFeePerGas === undefined || tx.maxFeePerGas === null ? {} : { maxFeePerGas: BigInt(tx.maxFeePerGas.toString()).toString() }),
    ...(tx.maxPriorityFeePerGas === undefined || tx.maxPriorityFeePerGas === null ? {} : { maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas.toString()).toString() }),
    ...(tx.type === undefined || tx.type === null
      ? (tx.gasPrice === undefined || tx.gasPrice === null ? {} : { type: 0 })
      : { type: Number(tx.type) }),
    ...(normalizedAccessList === undefined ? {} : { accessList: normalizedAccessList }),
  };
  return context;
}

/**
 * Prepare, durably save, and broadcast one treasury transaction. Reads are
 * retried within the existing bounded read policy. One signed transaction
 * identity is retained; an ambiguous raw send may be replayed to a configured
 * fallback endpoint using the same bytes and original hash.
 */
export async function prepareAndBroadcastTransaction(
  request: TreasuryTransactionRequest,
): Promise<TransactionReliabilityResult> {
  const provider = request.signer.provider;
  if (!provider) {
    const diagnostic = diagnosticFor('asset_context', 'PROVIDER_REQUIRED', undefined, {
      retryable: true,
      category: 'rpc_unavailable',
    });
    throw new TransactionReliabilityError(diagnostic);
  }

  let signerAddress: string;
  try {
    signerAddress = ethers.getAddress(await request.signer.getAddress());
  } catch (error) {
    throw new TransactionReliabilityError(diagnosticFor('prepare', 'SIGNER_ADDRESS_UNAVAILABLE', error, {
      rpcMethod: 'signer.getAddress', retryable: true, category: 'rpc_unavailable',
    }));
  }

  const prepared = await TreasuryTransactions.prepare({
    operationKey: request.operationKey,
    targetOperationKey: request.targetOperationKey,
    targetType: request.targetType,
    chainId: request.chainId,
    signerAddress,
    to: request.to,
    data: request.data,
    value: request.value,
    accessList: request.accessList,
    getPendingNonce: async () => {
      try {
        return await withRpcReadRetry(() => provider.getTransactionCount(signerAddress, 'pending'));
      } catch (error) {
        throw new TransactionReliabilityError(diagnosticFor('prepare', 'RPC_READ_UNAVAILABLE', error, {
          rpcMethod: 'eth_getTransactionCount',
          retryable: isTransientRpcReadError(error),
          category: 'rpc_unavailable',
        }));
      }
    },
    prepare: async nonce => {
      let feeData: ethers.FeeData;
      try {
        feeData = await withRpcReadRetry(() => provider.getFeeData());
      } catch (error) {
        throw new TransactionReliabilityError(diagnosticFor('prepare', 'RPC_READ_UNAVAILABLE', error, {
          rpcMethod: 'provider.getFeeData',
          retryable: isTransientRpcReadError(error),
          category: 'rpc_unavailable', nonce,
        }));
      }

      const baseRequest: ethers.TransactionRequest = {
        to: request.to,
        data: request.data || '0x',
        value: requestValue(request.value),
        nonce,
        chainId: request.chainId,
        ...(request.accessList === undefined ? {} : { accessList: request.accessList }),
      };
      if (feeData.maxFeePerGas !== null && feeData.maxPriorityFeePerGas !== null) {
        baseRequest.type = 2;
        baseRequest.maxFeePerGas = feeData.maxFeePerGas;
        baseRequest.maxPriorityFeePerGas = feeData.maxPriorityFeePerGas;
      } else if (feeData.gasPrice !== null) {
        baseRequest.gasPrice = feeData.gasPrice;
      } else {
        throw new TransactionReliabilityError(diagnosticFor('prepare', 'FEE_DATA_UNAVAILABLE', undefined, {
          rpcMethod: 'provider.getFeeData', retryable: true, category: 'rpc_unavailable', nonce,
        }));
      }

      try {
        baseRequest.gasLimit = await withRpcReadRetry(() => provider.estimateGas({
          ...baseRequest,
          from: signerAddress,
        }));
      } catch (error) {
        const retryable = isTransientRpcReadError(error);
        throw new TransactionReliabilityError(diagnosticFor(
          'prepare',
          retryable ? 'RPC_READ_UNAVAILABLE' : 'TRANSACTION_ESTIMATE_REJECTED',
          error,
          {
          rpcMethod: 'eth_estimateGas',
          retryable,
          category: retryable ? 'rpc_unavailable' : 'preflight', nonce,
          },
        ));
      }

      let rawTransaction: string;
      try {
        if (typeof (request.signer as ethers.Signer & { signTransaction?: unknown }).signTransaction !== 'function') {
          throw new Error('SIGN_TRANSACTION_UNAVAILABLE');
        }
        rawTransaction = await (request.signer as ethers.Signer & { signTransaction(tx: ethers.TransactionRequest): Promise<string> }).signTransaction(baseRequest);
      } catch (error) {
        throw new TransactionReliabilityError(diagnosticFor('prepare', 'SIGN_TRANSACTION_FAILED', error, {
          rpcMethod: 'signTransaction', retryable: false, category: 'preflight', nonce,
        }));
      }
      const txHash = ethers.keccak256(rawTransaction);
      let context: PreparedTransactionContext;
      try {
        context = toContext(request, signerAddress, nonce, baseRequest);
      } catch (error) {
        throw new TransactionReliabilityError(diagnosticFor('prepare', 'SIGNING_CONTEXT_INVALID', error, {
          retryable: false, category: 'preflight', nonce,
        }));
      }
      return {
        txHash,
        rawTransaction,
        context,
      } satisfies PreparedTreasuryTransaction;
    },
  }).catch(error => {
    if (error instanceof TransactionReliabilityError) throw error;
    const preparationMessage = error instanceof Error ? error.message : String(error);
    const preparationCode = preparationMessage.split(':', 1)[0].slice(0, 96);
    // These are bounded coordinator outcomes from TreasuryTransactions.prepare.
    // They happen before the signed hash is durably saved and must retain their
    // real stage/code instead of being reported as hash-persistence failures.
    const coordinatorDiagnostics: Record<string, {
      stage: TransactionDiagnosticStage;
      retryable: boolean;
      category: TransactionDiagnosticCategory;
      rpcMethod?: string;
    }> = {
      TREASURY_NONCE_LOCK_TIMEOUT: {
        stage: 'prepare',
        retryable: true,
        category: 'database_unavailable',
      },
      TREASURY_NONCE_BUSY_RETRYABLE: {
        stage: 'prepare',
        retryable: true,
        category: 'database_unavailable',
      },
      TREASURY_PENDING_NONCE_UNAVAILABLE: {
        stage: 'prepare',
        retryable: true,
        category: 'rpc_unavailable',
        rpcMethod: 'eth_getTransactionCount',
      },
      TREASURY_NONCE_UNAVAILABLE: {
        stage: 'prepare',
        retryable: true,
        category: 'database_unavailable',
      },
      TREASURY_NONCE_GAP_REQUIRES_REVIEW: {
        stage: 'prepare',
        retryable: false,
        category: 'review_required',
      },
    };
    const coordinatorDiagnostic = error instanceof TreasuryTransactionPreparationError
      ? coordinatorDiagnostics[preparationCode]
      : undefined;
    const permanentPreparationCodes = [
      'TREASURY_TRANSACTION_INTENT_MISMATCH',
      'TREASURY_TRANSACTION_CONTEXT_MISMATCH',
      'TOKEN_OPERATION_NOT_FOUND',
      'TOKEN_OPERATION_TERMINAL_STATE',
      'TOKEN_OPERATION_TX_HASH_MISMATCH',
      'APPROVAL_PREPARATION_NOT_FOUND',
      'APPROVAL_PREPARATION_TERMINAL_STATE',
      'APPROVAL_FUNDING_ATTEMPT_MISMATCH',
      'APPROVAL_FUNDING_TX_HASH_MISMATCH',
    ];
    const permanentPreparationCode = error instanceof TreasuryTransactionPreparationError
      ? permanentPreparationCodes.find(code => code === preparationCode)
      : undefined;
    const permanentPreparation = error instanceof TreasuryTransactionPreparationError
      && Boolean(permanentPreparationCode);
    const diagnostic = diagnosticFor(
      coordinatorDiagnostic?.stage
        ?? (error instanceof TreasuryTransactionPreparationError ? 'persist_hash' : 'prepare'),
      coordinatorDiagnostic
        ? preparationCode
        : permanentPreparationCode
        ? permanentPreparationCode
        : error instanceof TreasuryTransactionPreparationError ? 'TRANSACTION_HASH_PERSISTENCE_FAILED' : 'TRANSACTION_PREPARATION_FAILED',
      error,
      {
        retryable: coordinatorDiagnostic?.retryable ?? !permanentPreparation,
        category: coordinatorDiagnostic?.category
          ?? (permanentPreparation ? 'review_required' : 'database_unavailable'),
        ...(coordinatorDiagnostic?.rpcMethod ? { rpcMethod: coordinatorDiagnostic.rpcMethod } : {}),
      },
    );
    throw new TransactionReliabilityError(diagnostic);
  });

  if (prepared.alreadyPrepared) {
    // A committed `prepared` lease means the signed bytes were saved but the
    // process may have stopped before broadcast. Raw bytes are intentionally
    // never persisted, so a retry cannot safely send this transaction. Keep
    // the original hash and move the lease/target into review instead of
    // pretending that the chain saw it.
    if (prepared.lease.status === 'prepared') {
      const diagnostic = diagnosticFor('persist_hash', 'TRANSACTION_PREPARED_REVIEW_REQUIRED', undefined, {
        retryable: false,
        category: 'review_required',
        savedHash: prepared.lease.tx_hash,
        nonce: Number.isSafeInteger(Number(prepared.lease.nonce)) ? Number(prepared.lease.nonce) : undefined,
      });
      try {
        await TreasuryTransactions.markUnknown(request.operationKey, diagnostic);
      } catch {
        // The in-memory diagnostic remains authoritative if the durable
        // review-state update is temporarily unavailable.
      }
      throw new TransactionReliabilityError(diagnostic);
    }
    return {
      txHash: prepared.lease.tx_hash,
      context: prepared.lease.tx_context,
      broadcasted: false,
      alreadyPrepared: true,
    };
  }

  try {
    const response = await provider.broadcastTransaction(
      // The raw bytes exist only for this in-memory call and are not included
      // in the diagnostic or durable lease.
      prepared.rawTransaction as string,
    );
    if (response.hash.toLowerCase() !== prepared.lease.tx_hash.toLowerCase()) {
      const diagnostic = diagnosticFor('broadcast', 'BROADCAST_HASH_MISMATCH', undefined, {
        rpcMethod: 'eth_sendRawTransaction', retryable: false, category: 'review_required',
        savedHash: prepared.lease.tx_hash, nonce: Number(prepared.lease.nonce),
      });
      try {
        await TreasuryTransactions.markUnknown(request.operationKey, diagnostic);
      } catch {
        // The in-memory diagnostic remains authoritative if the durable
        // review-state update is temporarily unavailable.
      }
      throw new TransactionReliabilityError(diagnostic);
    }
    await TreasuryTransactions.markSubmitted(request.operationKey, prepared.lease.tx_hash);
    return {
      txHash: prepared.lease.tx_hash,
      context: prepared.lease.tx_context,
      broadcasted: true,
      alreadyPrepared: false,
    };
  } catch (error) {
    if (error instanceof TransactionReliabilityError) throw error;
    const diagnostic = diagnosticFor('broadcast', 'CHAIN_OUTCOME_UNKNOWN', error, {
      rpcMethod: 'eth_sendRawTransaction', retryable: false, category: 'review_required',
      savedHash: prepared.lease.tx_hash, nonce: Number(prepared.lease.nonce),
    });
    try {
      await TreasuryTransactions.markUnknown(request.operationKey, diagnostic);
    } catch {
      // The in-memory diagnostic remains authoritative if the durable
      // review-state update is temporarily unavailable.
    }
    throw new TransactionReliabilityError(diagnostic);
  }
}
