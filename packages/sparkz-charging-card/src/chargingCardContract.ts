import type { SparkzReservationSettlement } from './types';

export type SparkzReservationTrackingContext = {
  reservationId: string;
  contractId: string;
  apiBaseUrl: string;
  sessionId: string;
  providerId: string;
};

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
