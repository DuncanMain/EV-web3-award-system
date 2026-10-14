import type { SparkzReservationSettlement } from './types';

export type SparkzReservationTrackingContext = {
  reservationId: string;
  contractId: string;
  apiBaseUrl: string;
  sessionId: string;
  providerId: string;
};

export type SparkzWalletQueryErrorClassification = {
  kind: 'invalid_address' | 'not_linked' | 'unavailable' | 'unknown';
  code: string | null;
  statusCode: number | null;
  retryable: boolean;
  message: string;
};

type ErrorRecord = Record<string, unknown>;

function errorRecord(value: unknown): ErrorRecord | null {
  return value && typeof value === 'object' ? value as ErrorRecord : null;
}

function numericStatus(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Turn wallet query failures into safe UI guidance. The two caller/linkage
 * failures must not be retried automatically; an unavailable dependency can
 * be retried through the read-only wallet GET action.
 */
export function classifyWalletQueryError(error: unknown): SparkzWalletQueryErrorClassification {
  const record = errorRecord(error);
  const codeValue = record?.code ?? record?.errorCode;
  const code = codeValue === undefined || codeValue === null ? null : String(codeValue).toUpperCase();
  const statusCode = numericStatus(record?.httpStatus ?? record?.statusCode ?? record?.status);

  if (code === 'INVALID_WALLET_ADDRESS') {
    return {
      kind: 'invalid_address',
      code,
      statusCode,
      retryable: false,
      message: 'The linked wallet address is invalid. Check the wallet address for this eMAID.',
    };
  }
  if (code === 'WALLET_NOT_LINKED') {
    return {
      kind: 'not_linked',
      code,
      statusCode,
      retryable: false,
      message: 'This wallet is not linked to this eMAID. Link the wallet before using custodial mode.',
    };
  }

  const unavailable = code === 'WALLET_QUERY_UNAVAILABLE'
    || statusCode === null
    || statusCode >= 500;
  if (unavailable) {
    return {
      kind: 'unavailable',
      code,
      statusCode,
      retryable: true,
      message: 'SPARKZ balance is temporarily unavailable. Retry shortly.',
    };
  }

  return {
    kind: 'unknown',
    code,
    statusCode,
    retryable: false,
    message: 'The SPARKZ account could not be loaded. Check the account link and try again.',
  };
}

/** Keep endpoint joining predictable when an integration supplies a trailing slash. */
export function normalizeApiBaseUrl(value: string): string {
  return value.replace(/\/+$/, '');
}

export function apiUrl(baseUrl: string, path: string): string {
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;
  return `${normalizeApiBaseUrl(baseUrl)}${normalizedPath}`;
}

export function sessionScopeKey(contractId: string, sessionId?: string, providerId?: string): string {
  return [contractId, sessionId || '', providerId || ''].join('\u0000');
}

export function isTerminalReservationSettlement(data: SparkzReservationSettlement): boolean {
  if (data.requiresReview === true || data.receiptStatus === 'invalid' || data.receiptStatus === 'orphaned') {
    return false;
  }
  if (data.status === 'released') {
    return data.receiptStatus === 'none' && data.spendReceipt === null && data.txHash === null;
  }
  return data.status === 'settled'
    && data.receiptStatus === 'settled'
    && Boolean(data.spendReceipt?.signature)
    && Boolean(data.spendReceipt?.canonicalPayload);
}

/**
 * The API authenticates the owner through x-contract-id. These additional
 * checks ensure a proxy cannot accidentally associate a response with another
 * session or provider before it reaches callbacks or UI state.
 */
export function matchesReservationContext(
  data: SparkzReservationSettlement,
  context: SparkzReservationTrackingContext,
): boolean {
  if (data.reservationId !== context.reservationId) return false;
  if (!context.sessionId || !context.providerId) return false;
  return data.sessionId === context.sessionId && data.providerId === context.providerId;
}
