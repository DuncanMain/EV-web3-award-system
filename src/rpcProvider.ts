import { ethers } from 'ethers';

/** The local Polygon Amoy endpoint remains environment-configurable. */
export const DEFAULT_POLYGON_RPC_URL = 'https://polygon-amoy.drpc.org';

/**
 * dRPC's free endpoint rejects large JSON-RPC batches and can leave a read
 * hanging for longer than an API request should wait.  Keep each request
 * bounded and disable ethers' automatic batching at the provider boundary.
 * The network is intentionally not marked static: chain identity is still
 * checked by the normal evidence and asset-context paths.
 */
export const RPC_REQUEST_TIMEOUT_MS = 10_000;
export const RPC_BATCH_MAX_COUNT = 1;
export const RPC_READ_MAX_ATTEMPTS = 3;
export const RPC_READ_RETRY_DELAY_MS = 100;

export type RpcReadRetryOptions = {
  /** Test hooks may shorten the delay; production attempts remain bounded. */
  maxAttempts?: number;
  delayMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
};

export function getPolygonRpcUrl(): string {
  return process.env.POLYGON_RPC_URL || DEFAULT_POLYGON_RPC_URL;
}

export function createRpcProvider(rpcUrl = getPolygonRpcUrl()): ethers.JsonRpcProvider {
  const request = new ethers.FetchRequest(rpcUrl);
  request.timeout = RPC_REQUEST_TIMEOUT_MS;
  return new ethers.JsonRpcProvider(request, undefined, {
    batchMaxCount: RPC_BATCH_MAX_COUNT,
  });
}

function collectErrorCodes(value: unknown, seen: Set<unknown>, depth = 0): Array<string | number> {
  if (value === null || value === undefined || depth > 5) return [];
  if (typeof value === 'number' || typeof value === 'string') {
    return [value];
  }
  if (typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);

  const candidate = value as Record<string, unknown>;
  const codes: Array<string | number> = [];
  if (typeof candidate.code === 'number' || typeof candidate.code === 'string') {
    codes.push(candidate.code);
  }
  for (const key of ['error', 'info', 'response', 'body', 'data']) {
    codes.push(...collectErrorCodes(candidate[key], seen, depth + 1));
  }
  return codes;
}

/**
 * dRPC has returned these provider-level failures for otherwise valid reads.
 * Numeric codes may be nested below ethers' UNKNOWN_ERROR/SERVER_ERROR
 * wrapper, so the check deliberately inspects the bounded error tree.
 */
export function isTransientRpcReadError(error: unknown): boolean {
  const numericCodes = collectErrorCodes(error, new Set())
    .map(code => typeof code === 'number' ? code : Number(code))
    .filter(code => Number.isFinite(code));
  if (numericCodes.some(code => [19, 26, 30].includes(code))) return true;

  const stringCodes = collectErrorCodes(error, new Set())
    .filter((code): code is string => typeof code === 'string')
    .map(code => code.toUpperCase());
  if (stringCodes.some(code => [
    'NETWORK_ERROR',
    'SERVER_ERROR',
    'TIMEOUT',
    'TIMEOUT_ERROR',
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'ENETUNREACH',
  ].includes(code))) return true;

  let message = '';
  if (error instanceof Error) {
    message = error.message;
  } else if (typeof error === 'string') {
    message = error;
  } else {
    const candidate = error as { message?: unknown } | null;
    if (candidate && typeof candidate.message === 'string') {
      message = candidate.message;
    } else {
      try {
        message = JSON.stringify(error);
      } catch {
        // Circular provider wrappers still get their structured code checks;
        // an unsafe diagnostic serialization must not disable retry policy.
        message = '';
      }
    }
  }
  return /(?:unknown block|request timeout|temporary internal error|timed? out|network error|server response 5\d\d|internal server error)/i.test(message || '');
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, delayMs));
}

/**
 * Retry only idempotent provider reads.  A null result can be retried when a
 * transaction or receipt is still propagating; after the fixed budget the
 * caller receives the final null and applies its normal pending/not-found
 * classification.  This helper must never wrap a transaction submission or
 * any database/state mutation.
 */
export async function withRpcReadRetry<T>(
  read: () => Promise<T>,
  options: RpcReadRetryOptions = {},
): Promise<T> {
  const maxAttempts = Math.min(
    RPC_READ_MAX_ATTEMPTS,
    Math.max(1, Math.floor(options.maxAttempts ?? RPC_READ_MAX_ATTEMPTS)),
  );
  const delayMs = Math.max(0, Math.min(1_000, Math.floor(options.delayMs ?? RPC_READ_RETRY_DELAY_MS)));
  const sleep = options.sleep || defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
      if (!isTransientRpcReadError(error) || attempt >= maxAttempts) throw error;
      if (delayMs > 0) await sleep(delayMs * attempt);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function withNullableRpcReadRetry<T>(
  read: () => Promise<T | null>,
  options: RpcReadRetryOptions = {},
): Promise<T | null> {
  const maxAttempts = Math.min(
    RPC_READ_MAX_ATTEMPTS,
    Math.max(1, Math.floor(options.maxAttempts ?? RPC_READ_MAX_ATTEMPTS)),
  );
  const delayMs = Math.max(0, Math.min(1_000, Math.floor(options.delayMs ?? RPC_READ_RETRY_DELAY_MS)));
  const sleep = options.sleep || defaultSleep;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await read();
      if (result !== null || attempt >= maxAttempts) return result;
      if (delayMs > 0) await sleep(delayMs * attempt);
    } catch (error) {
      lastError = error;
      if (!isTransientRpcReadError(error) || attempt >= maxAttempts) throw error;
      if (delayMs > 0) await sleep(delayMs * attempt);
    }
  }
  if (lastError !== undefined) throw lastError;
  return null;
}
