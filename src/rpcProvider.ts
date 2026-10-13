import { ethers } from 'ethers';
import type { JsonRpcError, JsonRpcPayload, JsonRpcResult } from 'ethers';
import type { RpcEndpointEvidence } from './types';

/** The local Polygon Amoy endpoint remains environment-configurable. */
export const DEFAULT_POLYGON_RPC_URL = 'https://polygon-amoy.drpc.org';
/** Verified read-only Polygon Amoy backup for the normal 80002 setup. */
export const DEFAULT_POLYGON_RPC_FALLBACK_URL = 'https://polygon-amoy-bor-rpc.publicnode.com';
export const DEFAULT_POLYGON_CHAIN_ID = 80002;

/**
 * dRPC's free endpoint rejects large JSON-RPC batches and can leave a read
 * hanging for longer than an API request should wait.  Keep each request
 * bounded and disable ethers' automatic batching at the provider boundary.
 * The SDK network is pinned to the configured chain so it cannot silently
 * accept a different endpoint; FailoverJsonRpcProvider still performs an
 * explicit eth_chainId check before each endpoint is used.
 */
export const RPC_REQUEST_TIMEOUT_MS = 10_000;
/** Bound SDK/provider calls too, including test doubles and custom providers. */
export const RPC_READ_TIMEOUT_MS = RPC_REQUEST_TIMEOUT_MS;
export const RPC_BATCH_MAX_COUNT = 1;
export const RPC_READ_MAX_ATTEMPTS = 3;
export const RPC_READ_RETRY_DELAY_MS = 100;
/**
 * A failover endpoint gets a fraction of the outer read budget.  This leaves
 * enough wall time for a stalled primary to be abandoned and the fallback to
 * be checked for the same chain before the SDK-level read deadline expires.
 */
export const RPC_FAILOVER_ENDPOINT_TIMEOUT_MS = Math.max(500, Math.floor(RPC_READ_TIMEOUT_MS / 4));
export const RPC_FAILOVER_MAX_ENDPOINTS = 2;

export type RpcReadRetryOptions = {
  /** Test hooks may shorten the delay; production attempts remain bounded. */
  maxAttempts?: number;
  delayMs?: number;
  timeoutMs?: number;
  sleep?: (delayMs: number) => Promise<void>;
};

export interface RpcEndpointConfig {
  /** Private transport URL; never copied into public diagnostics. */
  url: string;
  /** Stable safe label used in diagnostics. */
  label: string;
}

export interface RpcDiagnosticDetails {
  providerCode?: string;
  rpcCode?: number;
  httpStatus?: number;
  traceId?: string;
  endpointLabel?: string;
  failover?: RpcEndpointEvidence[];
}

const DIAGNOSTIC_MAX_DEPTH = 6;
const DIAGNOSTIC_MAX_BODY_LENGTH = 8_192;
const DIAGNOSTIC_TEXT_LENGTH = 96;

function boundedDiagnosticText(value: unknown, max = DIAGNOSTIC_TEXT_LENGTH): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return text ? text.slice(0, max) : undefined;
}

function diagnosticHttpStatus(value: unknown): number | undefined {
  const match = String(value ?? '').match(/\b([1-5]\d{2})\b/);
  if (!match) return undefined;
  const status = Number(match[1]);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : undefined;
}

function diagnosticTrace(value: unknown): string | undefined {
  return boundedDiagnosticText(value, DIAGNOSTIC_TEXT_LENGTH);
}

const RPC_FAILOVER_METADATA = Symbol.for('neverflat.rpc.failover');

interface RpcFailoverMetadata {
  endpointLabel?: string;
  failover: RpcEndpointEvidence[];
}

function safeEndpointEvidence(value: unknown): RpcEndpointEvidence | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const label = boundedDiagnosticText(record.label, 40);
  const outcome = record.outcome === 'success' || record.outcome === 'failed' || record.outcome === 'null'
    ? record.outcome
    : undefined;
  if (!label || !outcome) return undefined;
  const providerCode = boundedDiagnosticText(record.providerCode, 48);
  const traceId = boundedDiagnosticText(record.traceId, DIAGNOSTIC_TEXT_LENGTH);
  const rpcCode = typeof record.rpcCode === 'number' && Number.isFinite(record.rpcCode)
    ? record.rpcCode
    : typeof record.rpcCode === 'string' && /^-?\d{1,8}$/.test(record.rpcCode)
    ? Number(record.rpcCode)
    : undefined;
  const httpStatus = typeof record.httpStatus === 'number' && Number.isInteger(record.httpStatus)
    && record.httpStatus >= 100 && record.httpStatus <= 599
    ? record.httpStatus
    : undefined;
  return {
    label,
    outcome,
    ...(providerCode ? { providerCode } : {}),
    ...(rpcCode === undefined ? {} : { rpcCode }),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(traceId ? { traceId } : {}),
  };
}

function readRpcFailoverMetadata(value: unknown): RpcFailoverMetadata | undefined {
  if (!value || (typeof value !== 'object' && typeof value !== 'function')) return undefined;
  try {
    const metadata = (value as { [RPC_FAILOVER_METADATA]?: unknown })[RPC_FAILOVER_METADATA];
    if (!metadata || typeof metadata !== 'object') return undefined;
    const record = metadata as Record<string, unknown>;
    const failover = Array.isArray(record.failover)
      ? record.failover.map(safeEndpointEvidence).filter((entry): entry is RpcEndpointEvidence => Boolean(entry))
      : [];
    if (failover.length === 0) return undefined;
    const endpointLabel = boundedDiagnosticText(record.endpointLabel, 40);
    return {
      ...(endpointLabel ? { endpointLabel } : {}),
      failover,
    };
  } catch {
    return undefined;
  }
}

function attachRpcFailoverMetadata(
  value: unknown,
  failover: RpcEndpointEvidence[],
  endpointLabel?: string,
): unknown {
  const metadata: RpcFailoverMetadata = {
    ...(endpointLabel ? { endpointLabel } : {}),
    failover: failover.map(entry => safeEndpointEvidence(entry)).filter((entry): entry is RpcEndpointEvidence => Boolean(entry)),
  };
  if (!metadata.failover.length) return value;
  if (value && (typeof value === 'object' || typeof value === 'function')) {
    try {
      Object.defineProperty(value, RPC_FAILOVER_METADATA, {
        configurable: true,
        enumerable: false,
        value: metadata,
        writable: true,
      });
      return value;
    } catch {
      // Some provider wrappers freeze their error object.  The safe wrapper
      // below preserves only the public message/code and the metadata.
    }
  }
  const message = value instanceof Error ? value.message : boundedDiagnosticText(value) || 'RPC request failed';
  const wrapped = Object.assign(new Error(message), {
    ...(value && typeof value === 'object' ? value : {}),
    cause: value,
  });
  Object.defineProperty(wrapped, RPC_FAILOVER_METADATA, {
    configurable: true,
    enumerable: false,
    value: metadata,
    writable: true,
  });
  return wrapped;
}

function endpointEvidence(
  label: string,
  outcome: RpcEndpointEvidence['outcome'],
  error?: unknown,
): RpcEndpointEvidence {
  const details = error ? extractRpcDiagnostic(error) : {};
  return {
    label,
    outcome,
    ...(details.providerCode ? { providerCode: details.providerCode } : {}),
    ...(details.rpcCode === undefined ? {} : { rpcCode: details.rpcCode }),
    ...(details.httpStatus === undefined ? {} : { httpStatus: details.httpStatus }),
    ...(details.traceId ? { traceId: details.traceId } : {}),
  };
}

/**
 * Extract only the small allowlisted provider fields that are safe to expose.
 * Ethers wraps dRPC failures in `info.responseBody`, which is a JSON string;
 * parse that bounded field so nested JSON-RPC codes and trace IDs survive.
 */
export function extractRpcDiagnostic(error: unknown): RpcDiagnosticDetails {
  const providerCodes: string[] = [];
  const rpcCodes: number[] = [];
  const statuses: number[] = [];
  const traces: string[] = [];
  const endpointLabels: string[] = [];
  const failoverEvidence: RpcEndpointEvidence[] = [];
  const seen = new Set<unknown>();

  const visit = (value: unknown, depth: number, keyHint?: string): void => {
    if (value === null || value === undefined || depth > DIAGNOSTIC_MAX_DEPTH) return;
    const metadata = readRpcFailoverMetadata(value);
    if (metadata) {
      if (metadata.endpointLabel) endpointLabels.push(metadata.endpointLabel);
      failoverEvidence.push(...metadata.failover);
    }
    if (typeof value === 'string') {
      if ((keyHint === 'responseBody' || keyHint === 'body' || keyHint === 'response_body')
        && value.length <= DIAGNOSTIC_MAX_BODY_LENGTH) {
        try {
          visit(JSON.parse(value), depth + 1, 'parsedResponseBody');
        } catch {
          // A non-JSON body still has no safe structured fields to expose.
        }
      }
      if (keyHint === 'responseStatus' || keyHint === 'status' || keyHint === 'statusCode' || keyHint === 'httpStatus') {
        const status = diagnosticHttpStatus(value);
        if (status !== undefined) statuses.push(status);
      }
      if (keyHint === 'traceId' || keyHint === 'trace_id' || keyHint === 'trace') {
        const trace = diagnosticTrace(value);
        if (trace) traces.push(trace);
      }
      if (keyHint === 'message') {
        const match = value.match(/(?:trace[-_ ]?id|request[-_ ]?id)\s*[:=]\s*([A-Za-z0-9][A-Za-z0-9._-]{3,95})/i);
        if (match) traces.push(match[1].slice(0, DIAGNOSTIC_TEXT_LENGTH));
      }
      return;
    }
    if (typeof value === 'number') {
      if (keyHint === 'code') rpcCodes.push(value);
      if (keyHint === 'status' || keyHint === 'statusCode' || keyHint === 'httpStatus') {
        const status = diagnosticHttpStatus(value);
        if (status !== undefined) statuses.push(status);
      }
      return;
    }
    if (typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    const record = value as Record<string, unknown>;
    for (const [key, child] of Object.entries(record)) {
      if (key === 'code') {
        if (typeof child === 'number' && Number.isFinite(child)) rpcCodes.push(child);
        else {
          const text = boundedDiagnosticText(child);
          if (text && !/^-?\d+$/.test(text)) providerCodes.push(text);
          else if (text) rpcCodes.push(Number(text));
        }
      }
      if (key === 'status' || key === 'statusCode' || key === 'httpStatus' || key === 'responseStatus') {
        const status = diagnosticHttpStatus(child);
        if (status !== undefined) statuses.push(status);
      }
      if (key === 'traceId' || key === 'trace_id' || key === 'trace') {
        const trace = diagnosticTrace(child);
        if (trace) traces.push(trace);
      }
      visit(child, depth + 1, key);
    }
  };

  visit(error, 0);
  const providerCode = providerCodes.find(value => value.length > 0);
  const rpcCode = rpcCodes.find(value => Number.isInteger(value) && value >= -32_768 && value <= 32_768);
  const httpStatus = statuses.find(value => Number.isInteger(value) && value >= 100 && value <= 599);
  const traceId = traces.find(value => value.length > 0);
  const endpointLabel = endpointLabels.find(value => value.length > 0);
  const failover = failoverEvidence.filter((entry, index, values) => values.findIndex(candidate => (
    candidate.label === entry.label
      && candidate.outcome === entry.outcome
      && candidate.providerCode === entry.providerCode
      && candidate.rpcCode === entry.rpcCode
      && candidate.httpStatus === entry.httpStatus
      && candidate.traceId === entry.traceId
  )) === index);
  return {
    ...(providerCode ? { providerCode } : {}),
    ...(rpcCode === undefined ? {} : { rpcCode }),
    ...(httpStatus === undefined ? {} : { httpStatus }),
    ...(traceId ? { traceId } : {}),
    ...(endpointLabel ? { endpointLabel } : {}),
    ...(failover.length ? { failover } : {}),
  };
}

function normaliseRpcUrl(value: string): string {
  const url = value.trim();
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error('RPC_ENDPOINT_INVALID');
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
    throw new Error('RPC_ENDPOINT_INVALID');
  }
  return url;
}

/** Compare endpoint identity without making a transport URL public. */
function rpcUrlIdentity(value: string): string {
  const parsed = new URL(normaliseRpcUrl(value));
  const protocol = parsed.protocol.toLowerCase();
  const hostname = parsed.hostname.toLowerCase();
  const defaultPort = (protocol === 'https:' && parsed.port === '443')
    || (protocol === 'http:' && parsed.port === '80');
  const port = parsed.port && !defaultPort ? `:${parsed.port}` : '';
  const pathname = parsed.pathname.replace(/\/+$/, '') || '/';
  return `${protocol}//${hostname}${port}${pathname}${parsed.search}`;
}

export function getConfiguredChainId(): number {
  const configured = process.env.CHAIN_ID?.trim();
  if (!configured) return DEFAULT_POLYGON_CHAIN_ID;
  if (!/^\d+$/.test(configured)) throw new Error('CONFIGURED_CHAIN_ID_INVALID');
  const chainId = Number(configured);
  if (!Number.isSafeInteger(chainId) || chainId < 0) throw new Error('CONFIGURED_CHAIN_ID_INVALID');
  return chainId;
}

export function getPolygonRpcUrl(): string {
  return process.env.POLYGON_RPC_URL?.trim() || DEFAULT_POLYGON_RPC_URL;
}

export function getPolygonRpcFallbackUrls(primaryUrl = getPolygonRpcUrl()): string[] {
  const configured = process.env.POLYGON_RPC_FALLBACK_URLS?.trim()
    || process.env.POLYGON_RPC_FALLBACK_URL?.trim();
  if (configured) {
    return configured.split(',').map(value => value.trim()).filter(Boolean).slice(0, RPC_FAILOVER_MAX_ENDPOINTS - 1);
  }
  if (rpcUrlIdentity(primaryUrl) === rpcUrlIdentity(DEFAULT_POLYGON_RPC_URL)
    && getConfiguredChainId() === DEFAULT_POLYGON_CHAIN_ID) {
    return [DEFAULT_POLYGON_RPC_FALLBACK_URL];
  }
  return [];
}

export function getPolygonRpcFallbackUrl(primaryUrl = getPolygonRpcUrl()): string | undefined {
  return getPolygonRpcFallbackUrls(primaryUrl)[0];
}

function endpointConfigs(primaryUrl: string, fallbackUrls: string | string[] | undefined): RpcEndpointConfig[] {
  const candidates = [primaryUrl, ...(typeof fallbackUrls === 'string' ? [fallbackUrls] : (fallbackUrls || []))];
  const seen = new Set<string>();
  const endpoints: RpcEndpointConfig[] = [];
  for (const candidate of candidates) {
    if (endpoints.length >= RPC_FAILOVER_MAX_ENDPOINTS) break;
    const url = normaliseRpcUrl(candidate);
    const identity = rpcUrlIdentity(url);
    if (seen.has(identity)) continue;
    seen.add(identity);
    endpoints.push({
      url,
      label: endpoints.length === 0 ? 'primary' : `fallback-${endpoints.length}`,
    });
  }
  if (endpoints.length === 0) throw new Error('RPC_ENDPOINT_REQUIRED');
  return endpoints;
}

function responseForId(
  response: Array<JsonRpcResult | JsonRpcError>,
  id: unknown,
): JsonRpcResult | JsonRpcError | undefined {
  return response.find(entry => entry.id === id);
}

function malformedRpcResponse(reason: string): Error {
  return Object.assign(new Error(`Malformed JSON-RPC response: ${reason}`), {
    code: 'RPC_MALFORMED_RESPONSE',
  });
}

function validateRpcResponse(
  body: unknown,
  payload: JsonRpcPayload | Array<JsonRpcPayload>,
): Array<JsonRpcResult | JsonRpcError> {
  const expected = Array.isArray(payload) ? payload : [payload];
  const response = Array.isArray(body) ? body : [body];
  if (response.length !== expected.length || response.length === 0) {
    throw malformedRpcResponse('response count does not match request');
  }
  const seenIds = new Set<unknown>();
  for (const request of expected) {
    const entry = response.find(candidate => (
      !!candidate && typeof candidate === 'object' && (candidate as { id?: unknown }).id === request.id
    )) as Record<string, unknown> | undefined;
    if (!entry) throw malformedRpcResponse('response id does not match request');
    if (entry.jsonrpc !== '2.0') throw malformedRpcResponse('missing jsonrpc 2.0 envelope');
    if (seenIds.has(entry.id)) throw malformedRpcResponse('duplicate response id');
    seenIds.add(entry.id);
    const hasResult = Object.prototype.hasOwnProperty.call(entry, 'result');
    const hasError = Object.prototype.hasOwnProperty.call(entry, 'error');
    if (hasResult === hasError) throw malformedRpcResponse('response must contain exactly one result or error');
    if (hasError) {
      const error = entry.error;
      if (!error || typeof error !== 'object' || typeof (error as { code?: unknown }).code !== 'number') {
        throw malformedRpcResponse('RPC error envelope is invalid');
      }
    }
  }
  return response as Array<JsonRpcResult | JsonRpcError>;
}

function responseError(response: JsonRpcError): Error {
  const error = Object.assign(new Error(response.error.message || 'RPC request failed'), {
    code: response.error.code,
    ...(response.error.data === undefined ? {} : { data: response.error.data }),
    info: { response: response.error },
  });
  return error;
}

function chainMismatchError(actual: unknown, expected: number): Error {
  return Object.assign(new Error(`RPC endpoint chain ID ${String(actual)} differs from configured chain ${expected}`), {
    code: 'CHAIN_ID_MISMATCH',
    actualChainId: boundedDiagnosticText(actual, 32),
    expectedChainId: expected,
  });
}

function chainIdFromResult(response: JsonRpcResult | JsonRpcError, expected: number): number {
  if ('error' in response) throw responseError(response);
  let chainId: number;
  try {
    chainId = Number(BigInt(String(response.result)));
  } catch {
    throw new Error('RPC_CHAIN_ID_INVALID');
  }
  if (!Number.isSafeInteger(chainId) || chainId < 0) throw new Error('RPC_CHAIN_ID_INVALID');
  if (chainId !== expected) throw chainMismatchError(chainId, expected);
  return chainId;
}

function isNullPropagationMethod(method: string): boolean {
  return method === 'eth_getTransactionByHash' || method === 'eth_getTransactionReceipt';
}

function isWriteMethod(method: string): boolean {
  return method === 'eth_sendRawTransaction'
    || method === 'eth_sendTransaction'
    || method === 'personal_sendTransaction';
}

/**
 * Sequential, same-payload failover for JSON-RPC.  Ethers' FallbackProvider
 * broadcasts writes to multiple providers; this provider deliberately sends
 * one exact payload at a time, and only advances after a transient transport
 * or RPC failure.  A raw transaction is therefore never re-signed or given a
 * replacement nonce by failover.
 */
export class FailoverJsonRpcProvider extends ethers.JsonRpcProvider {
  private readonly endpoints: Array<RpcEndpointConfig & { validatedChainId?: number }>;
  private readonly expectedChainId: number;
  private readonly endpointTimeoutMs: number;
  private lastFailoverEvidence: RpcEndpointEvidence[] = [];

  constructor(
    configs: RpcEndpointConfig[],
    expectedChainId: number,
    endpointTimeoutMs = RPC_FAILOVER_ENDPOINT_TIMEOUT_MS,
  ) {
    const [primary] = configs;
    const network = ethers.Network.from(expectedChainId);
    const request = new ethers.FetchRequest(primary.url);
    request.timeout = RPC_REQUEST_TIMEOUT_MS;
    super(request, network, {
      batchMaxCount: RPC_BATCH_MAX_COUNT,
      staticNetwork: network,
    });
    this.endpoints = configs.map(config => ({ ...config }));
    this.expectedChainId = expectedChainId;
    this.endpointTimeoutMs = Math.max(100, Math.min(RPC_READ_TIMEOUT_MS, Math.floor(endpointTimeoutMs)));
  }

  /** Last sanitised endpoint evidence, useful to an API/audit adapter. */
  getLastRpcFailoverEvidence(): RpcEndpointEvidence[] {
    return this.lastFailoverEvidence.map(entry => ({ ...entry }));
  }

  /** Validate the selected endpoint even though the SDK network is static. */
  override async getNetwork(): Promise<ethers.Network> {
    await this._send({ id: 0, method: 'eth_chainId', params: [], jsonrpc: '2.0' });
    return await super.getNetwork();
  }

  private async requestEndpoint(
    endpoint: RpcEndpointConfig,
    payload: JsonRpcPayload | Array<JsonRpcPayload>,
    timeoutMs: number,
  ): Promise<Array<JsonRpcResult | JsonRpcError>> {
    const request = new ethers.FetchRequest(endpoint.url);
    request.timeout = Math.max(1, Math.floor(timeoutMs));
    request.body = JSON.stringify(payload);
    request.setHeader('content-type', 'application/json');
    const response = await request.send();
    response.assertOk();
    let body: unknown;
    try {
      body = response.bodyJson;
    } catch {
      throw malformedRpcResponse('response body is not valid JSON');
    }
    return validateRpcResponse(body, payload);
  }

  private async validateEndpoint(
    endpoint: RpcEndpointConfig & { validatedChainId?: number },
    deadline: number,
  ): Promise<void> {
    if (endpoint.validatedChainId === this.expectedChainId) return;
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw Object.assign(new Error('RPC_FAILOVER_TIMEOUT'), { code: 'TIMEOUT' });
    const chainPayload: JsonRpcPayload = { id: 0, method: 'eth_chainId', params: [], jsonrpc: '2.0' };
    const response = await this.requestEndpoint(endpoint, chainPayload, remaining);
    const entry = responseForId(response, chainPayload.id);
    if (!entry) throw new Error('RPC_CHAIN_ID_RESPONSE_MISSING');
    endpoint.validatedChainId = chainIdFromResult(entry, this.expectedChainId);
  }

  override async _send(payload: JsonRpcPayload | Array<JsonRpcPayload>): Promise<Array<JsonRpcResult>> {
    const requests = Array.isArray(payload) ? payload : [payload];
    // Only a raw, already-signed transaction can be replayed safely at a
    // second endpoint.  Provider-managed sendTransaction calls may sign or
    // allocate a nonce remotely, so a transient response must remain
    // ambiguous instead of being submitted again.
    const allowWriteFailover = requests.every(request => !isWriteMethod(request.method) || request.method === 'eth_sendRawTransaction');
    const deadline = Date.now() + (this.endpointTimeoutMs * this.endpoints.length);
    const evidence: RpcEndpointEvidence[] = [];
    let lastError: unknown;
    let lastNullResponse: Array<JsonRpcResult | JsonRpcError> | undefined;

    for (const endpoint of this.endpoints) {
      const endpointDeadline = Math.min(deadline, Date.now() + this.endpointTimeoutMs);
      if (endpointDeadline <= Date.now()) break;
      try {
        if (requests.some(request => request.method !== 'eth_chainId')) {
          await this.validateEndpoint(endpoint, endpointDeadline);
        }
        const response = await this.requestEndpoint(endpoint, payload, endpointDeadline - Date.now());
        const responseErrors = response.filter((entry): entry is JsonRpcError => 'error' in entry);
        if (responseErrors.length > 0) {
          const error = responseError(responseErrors[0]);
          const entry = endpointEvidence(endpoint.label, 'failed', error);
          evidence.push(entry);
          if (!isTransientRpcReadError(error)) {
            responseErrors[0].error = attachRpcFailoverMetadata(
              responseErrors[0].error,
              evidence,
              endpoint.label,
            ) as JsonRpcError['error'];
            this.lastFailoverEvidence = evidence;
            return response as Array<JsonRpcResult>;
          }
          if (!allowWriteFailover && requests.some(request => isWriteMethod(request.method))) {
            responseErrors[0].error = attachRpcFailoverMetadata(
              responseErrors[0].error,
              evidence,
              endpoint.label,
            ) as JsonRpcError['error'];
            this.lastFailoverEvidence = evidence;
            return response as Array<JsonRpcResult>;
          }
          lastError = error;
          continue;
        }

        for (const request of requests.filter(item => item.method === 'eth_chainId')) {
          const chainResponse = responseForId(response, request.id);
          if (!chainResponse) throw new Error('RPC_CHAIN_ID_RESPONSE_MISSING');
          endpoint.validatedChainId = chainIdFromResult(chainResponse, this.expectedChainId);
        }

        const nullResult = requests.length === 1
          && isNullPropagationMethod(requests[0].method)
          && responseForId(response, requests[0].id)
          && 'result' in responseForId(response, requests[0].id)!
          && (responseForId(response, requests[0].id) as JsonRpcResult).result === null;
        if (nullResult && this.endpoints.length > 1 && endpoint !== this.endpoints[this.endpoints.length - 1]) {
          evidence.push(endpointEvidence(endpoint.label, 'null'));
          lastNullResponse = response;
          continue;
        }

        evidence.push(endpointEvidence(endpoint.label, 'success'));
        this.lastFailoverEvidence = evidence.length > 1 || evidence.some(entry => entry.outcome !== 'success')
          ? evidence
          : [];
        return response as Array<JsonRpcResult>;
      } catch (error) {
        const entry = endpointEvidence(endpoint.label, 'failed', error);
        evidence.push(entry);
        lastError = error;
        const retryable = isTransientRpcReadError(error) || (
          typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'CHAIN_ID_MISMATCH'
        ) || (
          typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'RPC_MALFORMED_RESPONSE'
        );
        if (!retryable || (!allowWriteFailover && requests.some(request => isWriteMethod(request.method)))) {
          this.lastFailoverEvidence = evidence;
          throw attachRpcFailoverMetadata(error, evidence, endpoint.label);
        }
      }
    }

    if (lastNullResponse) {
      this.lastFailoverEvidence = evidence;
      return attachRpcFailoverMetadata(lastNullResponse, evidence) as Array<JsonRpcResult>;
    }
    const finalError = lastError || Object.assign(new Error('RPC_FAILOVER_UNAVAILABLE'), { code: 'NETWORK_ERROR' });
    this.lastFailoverEvidence = evidence;
    throw attachRpcFailoverMetadata(finalError, evidence);
  }
}

export function createRpcProvider(
  rpcUrl = getPolygonRpcUrl(),
  fallbackRpcUrls: string | string[] | undefined = getPolygonRpcFallbackUrls(rpcUrl),
  expectedChainId = getConfiguredChainId(),
  endpointTimeoutMs = RPC_FAILOVER_ENDPOINT_TIMEOUT_MS,
): FailoverJsonRpcProvider {
  return new FailoverJsonRpcProvider(
    endpointConfigs(rpcUrl, fallbackRpcUrls),
    expectedChainId,
    endpointTimeoutMs,
  );
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
  const diagnostic = extractRpcDiagnostic(error);
  if (diagnostic.rpcCode !== undefined && [19, 26, 30].includes(diagnostic.rpcCode)) return true;
  if (diagnostic.httpStatus !== undefined
    && [408, 425, 429, 500, 502, 503, 504].includes(diagnostic.httpStatus)) return true;
  if (diagnostic.providerCode && [
    'NETWORK_ERROR',
    'TIMEOUT',
    'TIMEOUT_ERROR',
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'ENETUNREACH',
  ].includes(diagnostic.providerCode.toUpperCase())) return true;
  if (diagnostic.providerCode?.toUpperCase() === 'SERVER_ERROR'
    && diagnostic.httpStatus === undefined) return true;
  const numericCodes = collectErrorCodes(error, new Set())
    .map(code => typeof code === 'number' ? code : Number(code))
    .filter(code => Number.isFinite(code));
  if (numericCodes.some(code => [19, 26, 30].includes(code))) return true;

  const stringCodes = collectErrorCodes(error, new Set())
    .filter((code): code is string => typeof code === 'string')
    .map(code => code.toUpperCase());
  if (stringCodes.some(code => [
    'NETWORK_ERROR',
    'TIMEOUT',
    'TIMEOUT_ERROR',
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'ENETUNREACH',
  ].includes(code))) return true;
  if (stringCodes.includes('SERVER_ERROR') && diagnostic.httpStatus === undefined) return true;
  if (numericCodes.some(code => [408, 425, 429, 500, 502, 503, 504].includes(code))) return true;

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

function withReadTimeout<T>(read: () => Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(Object.assign(new Error('RPC_READ_TIMEOUT'), { code: 'TIMEOUT' }));
    }, timeoutMs);
  });
  return Promise.race([read(), timeout]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
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
  const timeoutMs = Math.max(1, Math.min(30_000, Math.floor(options.timeoutMs ?? RPC_READ_TIMEOUT_MS)));
  const sleep = options.sleep || defaultSleep;
  const deadline = Date.now() + timeoutMs;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const remaining = Math.max(1, deadline - Date.now());
      return await withReadTimeout(read, Math.min(timeoutMs, remaining));
    } catch (error) {
      lastError = error;
      if (!isTransientRpcReadError(error) || attempt >= maxAttempts) throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw error;
      if (delayMs > 0) await sleep(Math.min(delayMs * attempt, remaining));
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
  const timeoutMs = Math.max(1, Math.min(30_000, Math.floor(options.timeoutMs ?? RPC_READ_TIMEOUT_MS)));
  const sleep = options.sleep || defaultSleep;
  const deadline = Date.now() + timeoutMs;

  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const remaining = Math.max(1, deadline - Date.now());
      const result = await withReadTimeout(read, Math.min(timeoutMs, remaining));
      if (result !== null || attempt >= maxAttempts) return result;
      const remainingAfterResult = deadline - Date.now();
      if (remainingAfterResult <= 0) return result;
      if (delayMs > 0) await sleep(Math.min(delayMs * attempt, remainingAfterResult));
    } catch (error) {
      lastError = error;
      if (!isTransientRpcReadError(error) || attempt >= maxAttempts) throw error;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw error;
      if (delayMs > 0) await sleep(Math.min(delayMs * attempt, remaining));
    }
  }
  if (lastError !== undefined) throw lastError;
  return null;
}
