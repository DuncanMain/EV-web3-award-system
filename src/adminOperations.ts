import { Router, Request, Response } from 'express';
import type { Knex } from 'knex';
import { getDatabase } from './database/connection';
import type { TokenOperationRecord } from './database/service';

/** The admin view intentionally defaults to the records that still need attention. */
export const DEFAULT_ADMIN_OPERATION_LIMIT = 25;
export const MAX_ADMIN_OPERATION_LIMIT = 100;
const MAX_ADMIN_OPERATION_OFFSET = 100_000;

export type AdminOperationScope = 'unresolved' | 'all';

export interface AdminOperationsQuery {
  limit: number;
  offset: number;
  scope: AdminOperationScope;
  emaid?: string;
}

export interface AdminOperationRecoveryStatus {
  eligible: boolean;
  reasonCode: string;
  reason: string;
}

/**
 * Internal columns selected for the read-only operations view.  The recovery
 * snapshot is inspected server-side to derive a safe eligibility result, but
 * mapTokenOperationRecord deliberately excludes intent_context and every
 * other raw request/CDR payload from the response.
 */
export interface AdminOperationRow {
  id: string;
  operationKey: string;
  operationType: TokenOperationRecord['operation_type'];
  eMAID: string;
  walletAddress: string;
  amount: string;
  sessionId: string | null;
  providerId: string | null;
  reservationId: string | null;
  status: TokenOperationRecord['status'];
  movementOutcome: NonNullable<TokenOperationRecord['movement_outcome']>;
  transactionHash: string | null;
  errorMessage: string | null;
  errorCode: string | null;
  failureStage: string | null;
  diagnostic: AdminOperationDiagnostic | null;
  submittedAt: string | null;
  confirmedAt: string | null;
  projectedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  nextAction: string;
  recovery: AdminOperationRecoveryStatus;
}

export interface AdminOperationDiagnostic {
  stage: string;
  rpcMethod?: string;
  rpcCode?: string;
  httpStatus?: number;
  traceId?: string;
  /** Safe configured endpoint label; never a provider URL. */
  rpcEndpoint?: string;
  /** Ordered safe endpoint evidence for an idempotent read. */
  rpcFailover?: Array<{
    label: string;
    outcome: 'success' | 'failed' | 'null';
    providerCode?: string;
    rpcCode?: string;
    httpStatus?: number;
    traceId?: string;
  }>;
  errorCode: string;
  retryable: boolean;
  savedHash?: string;
  nonce?: string;
}

export interface AdminOperationsResponse {
  status: 'ok';
  count: number;
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
  operations: AdminOperationRow[];
}

export interface AdminRecoveryRequest {
  operationKey: string;
  actorId: string;
}

export interface AdminRecoveryOutcome {
  statusCode: number;
  body: Record<string, unknown>;
}

export interface AdminOperationsRouterOptions {
  recover?: (input: AdminRecoveryRequest) => Promise<AdminRecoveryOutcome>;
  getAdminIdentity?: (req: Request) => string | null;
}

export class AdminOperationsQueryError extends Error {
  readonly code = 'INVALID_OPERATIONS_QUERY';

  constructor(message: string) {
    super(message);
    this.name = 'AdminOperationsQueryError';
  }
}

function queryValue(query: unknown, key: string): unknown {
  if (!query || typeof query !== 'object') return undefined;
  return (query as Record<string, unknown>)[key];
}

function queryString(query: unknown, key: string): string | undefined {
  const value = queryValue(query, key);
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new AdminOperationsQueryError(`${key} must be a single query value`);
  }
  return value;
}

function parseBoundedInteger(value: string | undefined, key: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new AdminOperationsQueryError(`${key} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min) {
    throw new AdminOperationsQueryError(`${key} must be at least ${min}`);
  }
  if (parsed > max) {
    throw new AdminOperationsQueryError(`${key} must be no greater than ${max}`);
  }
  return parsed;
}

/** Parse and validate the small, bounded query surface of GET /admin/operations. */
export function parseAdminOperationsQuery(query: unknown): AdminOperationsQuery {
  if (queryValue(query, 'uid') !== undefined) {
    throw new AdminOperationsQueryError('uid is not supported; filter by emaid');
  }
  const scopeValue = queryString(query, 'scope');
  const scope = (scopeValue === undefined ? 'unresolved' : scopeValue.trim()) as AdminOperationScope;
  if (scope !== 'unresolved' && scope !== 'all') {
    throw new AdminOperationsQueryError('scope must be either unresolved or all');
  }

  const emaidValue = queryString(query, 'emaid');
  const emaid = emaidValue?.trim();
  if (emaid !== undefined && !emaid) {
    throw new AdminOperationsQueryError('emaid must not be empty');
  }
  if (emaid && emaid.length > 255) {
    throw new AdminOperationsQueryError('emaid is too long');
  }

  return {
    limit: parseBoundedInteger(queryString(query, 'limit'), 'limit', DEFAULT_ADMIN_OPERATION_LIMIT, 1, MAX_ADMIN_OPERATION_LIMIT),
    offset: parseBoundedInteger(queryString(query, 'offset'), 'offset', 0, 0, MAX_ADMIN_OPERATION_OFFSET),
    scope,
    ...(emaid ? { emaid } : {}),
  };
}

export function applyAdminOperationFilters(query: Knex.QueryBuilder, params: AdminOperationsQuery): Knex.QueryBuilder {
  if (params.scope === 'unresolved') {
    query.whereNot('status', 'projected');
  }
  if (params.emaid) {
    // `uid` is the existing database column.  It is queried only through the
    // canonical eMAID parameter and is never returned under the UID label.
    query.where({ uid: params.emaid });
  }
  return query;
}

function safeText(value: unknown, maxLength = 255): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

function safeDiagnosticToken(value: unknown, maxLength = 80): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value).trim();
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(text) ? text.slice(0, maxLength) : null;
}

function safeDiagnosticErrorCode(value: unknown): string | null {
  const text = safeDiagnosticToken(value, 64)?.toUpperCase();
  return text && /^[A-Z][A-Z0-9_.-]{2,63}$/.test(text) ? text : null;
}

function safeDiagnosticStage(value: unknown): string | null {
  const text = typeof value === 'string' ? value.toLowerCase() : '';
  return [
    'asset_context',
    'preflight',
    'prepare',
    'persist_hash',
    'broadcast',
    'receipt',
    'projection',
    'recovery',
    'validation',
  ].includes(text) ? text : null;
}

function safeRpcFailover(value: unknown): AdminOperationDiagnostic['rpcFailover'] {
  if (!Array.isArray(value)) return undefined;
  const entries = value.flatMap(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const label = safeDiagnosticToken(record.label, 40);
    const outcome: 'success' | 'failed' | 'null' | undefined = record.outcome === 'success' || record.outcome === 'failed' || record.outcome === 'null'
      ? record.outcome
      : undefined;
    if (!label || !outcome) return [];
    const providerCode = safeDiagnosticToken(record.providerCode, 48);
    const rpcCode = safeDiagnosticToken(record.rpcCode ?? record.providerCode, 32);
    const httpStatus = typeof record.httpStatus === 'number'
      && Number.isInteger(record.httpStatus)
      && record.httpStatus >= 100
      && record.httpStatus <= 599
      ? record.httpStatus
      : undefined;
    const traceId = safeDiagnosticToken(record.traceId ?? record.requestId);
    return [{
      label,
      outcome,
      ...(providerCode ? { providerCode } : {}),
      ...(rpcCode ? { rpcCode } : {}),
      ...(httpStatus === undefined ? {} : { httpStatus }),
      ...(traceId ? { traceId } : {}),
    }];
  });
  return entries.length ? entries : undefined;
}

function canonicalDiagnosticHash(value: unknown): string | null {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value.trim())
    ? value.trim().toLowerCase()
    : null;
}

function mapOperationDiagnostic(record: TokenOperationRecord): {
  errorCode: string | null;
  failureStage: string | null;
  diagnostic: AdminOperationDiagnostic | null;
} {
  const candidate = record as TokenOperationRecord & {
    error_code?: unknown;
    errorCode?: unknown;
    failure_stage?: unknown;
    failureStage?: unknown;
    diagnostic_context?: unknown;
    diagnostic?: unknown;
  };
  const intent = record.intent_context && typeof record.intent_context === 'object'
    ? record.intent_context as Record<string, unknown>
    : {};
  const source = candidate.diagnostic_context && typeof candidate.diagnostic_context === 'object'
    ? candidate.diagnostic_context as unknown as Record<string, unknown>
    : candidate.diagnostic && typeof candidate.diagnostic === 'object'
      ? candidate.diagnostic as unknown as Record<string, unknown>
      : intent.diagnostic && typeof intent.diagnostic === 'object'
        ? intent.diagnostic as Record<string, unknown>
        : undefined;
  // Persisted diagnostic context carries the precise transaction stage. A
  // legacy top-level failureStage/errorCode may still say only "execution" or
  // "failed", so it must not hide the nested operator evidence.
  const failureStage = safeDiagnosticStage(source?.stage)
    || safeDiagnosticStage(candidate.failure_stage ?? candidate.failureStage);
  const errorCode = safeDiagnosticErrorCode(source?.errorCode)
    || safeDiagnosticErrorCode(candidate.error_code ?? candidate.errorCode);
  if (!source && !failureStage && !errorCode) {
    return { errorCode: null, failureStage: null, diagnostic: null };
  }
  const diagnosticStage = failureStage || safeDiagnosticStage(source?.stage) || 'recovery';
  const diagnosticErrorCode = errorCode || safeDiagnosticErrorCode(source?.errorCode) || 'OPERATION_FAILED';
  const diagnostic: AdminOperationDiagnostic = {
    stage: diagnosticStage,
    errorCode: diagnosticErrorCode,
    retryable: typeof source?.retryable === 'boolean' ? source.retryable : false,
  };
  const rpcMethod = safeDiagnosticToken(source?.rpcMethod);
  const rpcCode = safeDiagnosticToken(source?.rpcCode ?? source?.providerCode, 32);
  const traceId = safeDiagnosticToken(source?.traceId ?? source?.requestId);
  const rpcEndpoint = safeDiagnosticToken(source?.rpcEndpoint ?? source?.endpointLabel, 40);
  const rpcFailover = safeRpcFailover(source?.rpcFailover ?? source?.failover);
  const savedHash = canonicalDiagnosticHash(source?.savedHash);
  const nonce = source?.nonce !== undefined && /^(?:0|[1-9]\d*)$/.test(String(source.nonce))
    ? String(source.nonce)
    : null;
  const httpStatus = typeof source?.httpStatus === 'number'
    && Number.isInteger(source.httpStatus)
    && source.httpStatus >= 100
    && source.httpStatus <= 599
    ? source.httpStatus
    : null;
  if (rpcMethod) diagnostic.rpcMethod = rpcMethod;
  if (rpcCode) diagnostic.rpcCode = rpcCode;
  if (httpStatus !== null) diagnostic.httpStatus = httpStatus;
  if (traceId) diagnostic.traceId = traceId;
  if (rpcEndpoint) diagnostic.rpcEndpoint = rpcEndpoint;
  if (rpcFailover) diagnostic.rpcFailover = rpcFailover;
  if (savedHash) diagnostic.savedHash = savedHash;
  if (nonce) diagnostic.nonce = nonce;
  return { errorCode: errorCode || null, failureStage: failureStage || null, diagnostic };
}

/** Return an allowlisted operational category instead of exposing raw DB/provider errors. */
export function safeOperationErrorCategory(value: unknown): string | null {
  const text = safeText(value, 2_000);
  if (!text) return null;
  const lower = text.toLowerCase();
  if (lower.includes('recovery_award_cdr_context_unavailable')) {
    return 'Award confirmed; original CDR unavailable for projection';
  }
  if (lower.includes('preflight') || lower.includes('balance')) return 'Preflight check failed';
  if (lower.includes('reservation')) return 'Reservation operation failed';
  if (lower.includes('approval') || lower.includes('allowance')) return 'Approval preparation requires review';
  if (lower.includes('legacy')) return 'Legacy operation requires review';
  if (lower.includes('rpc') || lower.includes('provider') || lower.includes('chain')
    || lower.includes('transaction') || lower.includes('network')) {
    return 'Chain outcome requires review';
  }
  return 'Operation failed; review the operation state';
}

function isoTimestamp(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** Give operators a safe, state-based next step without offering a mutation. */
export function getAdminOperationNextAction(record: Pick<TokenOperationRecord, 'status' | 'movement_outcome' | 'tx_hash'> & {
  diagnostic?: Pick<AdminOperationDiagnostic, 'retryable'> | null;
}): string {
  if (record.status === 'projected') {
    return 'Verify projection and receipt state; the operation is projected.';
  }
  if (record.movement_outcome === 'review') {
    return 'Operator review required before any follow-up.';
  }
  if (record.status === 'unknown') {
    return record.tx_hash
      ? 'Reconcile the transaction hash before any follow-up.'
      : 'Operator review required; the chain outcome is unknown.';
  }
  if (record.status === 'failed' && record.movement_outcome === 'no_movement') {
    if (record.diagnostic?.retryable) {
      return 'The chain dependency is temporarily unavailable; retry the same operation key after it recovers.';
    }
    return 'Review the failure; no chain movement was recorded.';
  }
  if (record.status === 'failed') {
    if (record.movement_outcome === 'confirmed') {
      return 'Chain movement is recorded; verify projection and receipt state before any follow-up.';
    }
    return 'Review the failure and confirm chain state before any follow-up.';
  }
  if (record.status === 'submitting' || record.status === 'submitted') {
    return 'Await chain confirmation and reconcile the transaction hash.';
  }
  if (record.status === 'confirmed') {
    return 'Confirm projection and reconciliation state.';
  }
  return 'Operator review required before any follow-up.';
}

function hasCanonicalTransactionHash(value: unknown): boolean {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value.trim());
}

function hasAwardRecoverySnapshot(record: TokenOperationRecord): boolean {
  const context = record.intent_context;
  if (!context || typeof context !== 'object' || Array.isArray(context)) return false;
  const snapshot = (context as Record<string, unknown>).recoverySnapshot;
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
  const rawCDR = (snapshot as Record<string, unknown>).rawCDR;
  return Boolean(rawCDR && typeof rawCDR === 'object' && !Array.isArray(rawCDR));
}

/** Derive a safe server-side recovery explanation without exposing intent data. */
export function getAdminOperationRecoveryStatus(record: TokenOperationRecord): AdminOperationRecoveryStatus {
  if (record.status === 'projected') {
    if (record.operation_type === 'spend' && hasCanonicalTransactionHash(record.tx_hash)) {
      return {
        eligible: true,
        reasonCode: 'SPEND_RECEIPT_RECOVERY_REQUIRED',
        reason: 'The spend projection is complete; the saved transaction hash can be rechecked to finish a missing receipt without a new transfer.',
      };
    }
    if (record.operation_type === 'spend') {
      return {
        eligible: false,
        reasonCode: 'CHAIN_HASH_REQUIRED',
        reason: 'The spend is projected but has no saved canonical transaction hash for receipt recovery.',
      };
    }
    if (hasCanonicalTransactionHash(record.tx_hash)) {
      return {
        eligible: true,
        reasonCode: 'ALREADY_PROJECTED',
        reason: 'The award projection is already complete; repeating the operation key is idempotent and will not submit a new transfer.',
      };
    }
    return {
      eligible: false,
      reasonCode: 'ALREADY_PROJECTED',
      reason: 'The award projection is already complete; no administrator recovery action is required.',
    };
  }
  const persistedDiagnostic = mapOperationDiagnostic(record).diagnostic;
  if (record.status === 'failed' && record.movement_outcome === 'no_movement' && persistedDiagnostic?.retryable) {
    return {
      eligible: false,
      reasonCode: 'DEPENDENCY_RETRY_REQUIRED',
      reason: 'No chain movement was recorded because a dependency was unavailable; retry the same operation key after it recovers. No replacement transfer is authorized.',
    };
  }
  if (record.status === 'failed' && record.movement_outcome === 'confirmed') {
    return {
      eligible: false,
      reasonCode: 'CHAIN_MOVEMENT_CONFIRMED',
      reason: 'Chain movement is confirmed; inspect the projection and receipt state before any follow-up.',
    };
  }
  if (record.status === 'failed') {
    return {
      eligible: false,
      reasonCode: 'FAILED_OPERATION_REVIEW_REQUIRED',
      reason: 'The operation is already failed and cannot be replaced by administrator recovery.',
    };
  }
  if (!hasCanonicalTransactionHash(record.tx_hash)) {
    return {
      eligible: false,
      reasonCode: 'CHAIN_HASH_REQUIRED',
      reason: 'A saved canonical transaction hash is required before read-only recovery can verify chain movement.',
    };
  }
  if (record.operation_type === 'award' && !hasAwardRecoverySnapshot(record)) {
    return {
      eligible: false,
      reasonCode: 'AWARD_CDR_SNAPSHOT_REQUIRED',
      reason: 'The original award CDR recovery snapshot is unavailable; operator review is required and no replacement award is allowed.',
    };
  }
  if (record.movement_outcome === 'review') {
    return {
      eligible: false,
      reasonCode: 'MOVEMENT_REVIEW_REQUIRED',
      reason: 'The saved movement outcome already requires operator review before projection.',
    };
  }
  return {
    eligible: true,
    reasonCode: 'CHAIN_EVIDENCE_REQUIRED',
    reason: 'The saved hash can be verified and the existing database projection or receipt can be completed without a new transfer.',
  };
}

/** Map a database row to the allowlisted admin response shape. */
export function mapTokenOperationRecord(record: TokenOperationRecord): AdminOperationRow {
  const movementOutcome = record.movement_outcome || 'unknown';
  const diagnostic = mapOperationDiagnostic(record);
  return {
    id: safeText(record.id, 128) || '',
    operationKey: safeText(record.operation_key, 255) || '',
    operationType: record.operation_type,
    eMAID: safeText(record.uid, 255) || '',
    walletAddress: safeText(record.wallet_address, 128) || '',
    amount: String(record.amount ?? '0'),
    sessionId: safeText(record.session_id),
    providerId: safeText(record.provider_id),
    reservationId: safeText(record.reservation_id, 128),
    status: record.status,
    movementOutcome,
    transactionHash: safeText(record.tx_hash, 255),
    errorMessage: safeOperationErrorCategory(record.error_message),
    errorCode: diagnostic.errorCode,
    failureStage: diagnostic.failureStage,
    diagnostic: diagnostic.diagnostic,
    submittedAt: isoTimestamp(record.submitted_at),
    confirmedAt: isoTimestamp(record.confirmed_at),
    projectedAt: isoTimestamp(record.projected_at),
    createdAt: isoTimestamp(record.created_at),
    updatedAt: isoTimestamp(record.updated_at),
    nextAction: getAdminOperationNextAction({
      status: record.status,
      movement_outcome: movementOutcome,
      tx_hash: record.tx_hash,
      diagnostic: diagnostic.diagnostic,
    }),
    recovery: getAdminOperationRecoveryStatus(record),
  };
}

function isMissingOperationsSchemaError(error: unknown): boolean {
  const candidate = error as { code?: unknown; message?: unknown };
  if (candidate?.code === '42P01') return true;
  const message = typeof candidate?.message === 'string' ? candidate.message : String(error);
  return /relation\s+["']?(?:token_operations|approval_preparations)["']?\s+does not exist/i.test(message);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sendUnavailable(res: Response, error: unknown): void {
  const missingSchema = isMissingOperationsSchemaError(error);
  res.status(missingSchema ? 503 : 500).json({
    status: missingSchema ? 'unavailable' : 'error',
    code: missingSchema ? 'OPERATIONS_SCHEMA_UNAVAILABLE' : 'OPERATIONS_UNAVAILABLE',
    retryable: !missingSchema,
    message: missingSchema
      ? 'Transaction visibility is unavailable because the token operation ledger has not been migrated.'
      : 'Transaction visibility is temporarily unavailable. Try again later.',
    count: 0,
    total: 0,
    operations: [],
  });
}

const OPERATION_COLUMNS = [
  'id',
  'operation_key',
  'operation_type',
  'uid',
  'wallet_address',
  'amount',
  'session_id',
  'provider_id',
  'reservation_id',
  'status',
  'movement_outcome',
  'intent_context',
  'diagnostic_context',
  'tx_hash',
  'error_message',
  'submitted_at',
  'confirmed_at',
  'projected_at',
  'created_at',
  'updated_at',
] as const;

/**
 * Create the authenticated read-only operations router.  The caller mounts
 * this router behind the existing validateAdmin middleware, for example:
 * `app.use('/admin/operations', validateAdmin, createAdminOperationsRouter())`.
 */
export function createAdminOperationsRouter(options: AdminOperationsRouterOptions = {}): Router {
  const router = Router();

  router.post('/recover', async (req: Request, res: Response) => {
    if (!options.recover) {
      res.status(503).json({
        status: 'error',
        code: 'RECOVERY_UNAVAILABLE',
        message: 'Operator recovery is temporarily unavailable.',
      });
      return;
    }
    const actorId = options.getAdminIdentity?.(req)
      || (req as Request & { adminIdentity?: string }).adminIdentity
      || null;
    if (!actorId) {
      res.status(401).json({ status: 'error', code: 'ADMIN_AUTHENTICATION_REQUIRED', message: 'Admin authentication required' });
      return;
    }
    const body = req.body;
    const keys = body && typeof body === 'object' && !Array.isArray(body)
      ? Object.keys(body as Record<string, unknown>)
      : [];
    const operationKey = body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>).operationKey
      : undefined;
    if (keys.length !== 1 || keys[0] !== 'operationKey' || typeof operationKey !== 'string' || !operationKey.trim()) {
      res.status(400).json({
        status: 'error',
        code: 'INVALID_RECOVERY_REQUEST',
        message: 'Body must contain only a non-empty operationKey; owner, amount, hash, and CDR overrides are not accepted.',
      });
      return;
    }
    try {
      const outcome = await options.recover({ operationKey, actorId });
      res.status(outcome.statusCode).json(outcome.body);
    } catch (error) {
      console.error('Admin operation recovery failed:', errorMessage(error));
      res.status(500).json({
        status: 'error',
        code: 'RECOVERY_FAILED',
        message: 'Operator recovery could not be completed. Retry the same operation key or inspect the operation state.',
      });
    }
  });

  router.get('/', async (req: Request, res: Response) => {
    let params: AdminOperationsQuery;
    try {
      params = parseAdminOperationsQuery(req.query);
    } catch (error) {
      if (error instanceof AdminOperationsQueryError) {
        res.status(400).json({ status: 'error', code: error.code, message: error.message });
        return;
      }
      res.status(400).json({ status: 'error', code: 'INVALID_OPERATIONS_QUERY', message: 'Invalid operations query' });
      return;
    }

    try {
      const db = getDatabase();
      const countQuery = applyAdminOperationFilters(db('token_operations'), params);
      const rowsQuery = applyAdminOperationFilters(db('token_operations'), params)
        .select(OPERATION_COLUMNS)
        .orderBy('updated_at', 'desc')
        .orderBy('created_at', 'desc')
        .orderBy('id', 'desc')
        .limit(params.limit)
        .offset(params.offset);
      const [countRow, rows] = await Promise.all([
        countQuery.count({ count: '*' }).first() as Promise<{ count?: string | number } | undefined>,
        rowsQuery as Promise<TokenOperationRecord[]>,
      ]);
      const total = Number(countRow?.count || 0);
      const operations = rows.map(mapTokenOperationRecord);
      const hasMore = params.offset + operations.length < total;
      res.json({
        status: 'ok',
        count: operations.length,
        total,
        limit: params.limit,
        offset: params.offset,
        hasMore,
        nextOffset: hasMore ? params.offset + params.limit : null,
        operations,
      } satisfies AdminOperationsResponse);
    } catch (error) {
      // Keep database details out of the authenticated admin response while
      // retaining a diagnostic for the local server operator.
      console.error('Admin operations query failed:', errorMessage(error));
      sendUnavailable(res, error);
    }
  });

  return router;
}
