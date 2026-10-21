import crypto from 'crypto';
import type { Knex } from 'knex';
import { getDatabase } from './database/connection';
import { canonicalTransactionHash } from './database/tokenOperation';
import { REWARD_POLICY_ROW_ID, REWARD_POLICY_TABLE } from './config/policyPersistence';
import { ADMIN_CORRECTION_ANNOTATIONS_TABLE } from './database/migrations/025_add_admin_correction_annotations';
import type {
  AdminCorrectionAnnotation,
  AdminCorrectionAnnotationListResponse,
  AdminCorrectionAnnotationReferenceType,
  AdminCorrectionAnnotationRequest,
  AdminCorrectionAnnotationResponse,
  AdminCorrectionAnnotationSubjectType,
  AdminEvidenceActivityAtSource,
  AdminEvidenceAsset,
  AdminEvidenceAssetProvenance,
  AdminEvidenceFormat,
  AdminEvidenceHistoricalPolicy,
  AdminEvidenceMovementOutcome,
  AdminEvidenceOperationType,
  AdminEvidencePolicySource,
  AdminEvidenceQuery,
  AdminEvidenceReportResponse,
  AdminEvidenceRow,
  AdminEvidenceScope,
  AdminEvidenceTotalsByAsset,
} from './adminEvidence.types';

export const ADMIN_EVIDENCE_DEFAULT_LIMIT = 100;
export const ADMIN_EVIDENCE_MAX_LIMIT = 500;
export const ADMIN_EVIDENCE_MAX_OFFSET = 100_000;
export const ADMIN_EVIDENCE_MAX_SOURCE_ROWS = 5_000;
export const ADMIN_EVIDENCE_MAX_PERIOD_DAYS = 366;
export const ADMIN_ANNOTATION_DEFAULT_LIMIT = 25;
export const ADMIN_ANNOTATION_MAX_LIMIT = 100;
export const ADMIN_ANNOTATION_MAX_OFFSET = 100_000;
const ADMIN_REFERENCE_CANDIDATE_LIMIT = 10;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/i;
const SAFE_TOKEN_ADDRESS_PATTERN = /^0x[0-9a-f]{40}$/i;
const SAFE_CHAIN_ID_PATTERN = /^\d{1,80}$/;
const SAFE_TEXT_CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const SAFE_RECONCILIATION_STATUS_PATTERN = /^[A-Za-z0-9_.:-]{1,80}$/;
const RECONCILIATION_MATCH_STATUSES = new Set(['matched', 'ok', 'success', 'reconciled']);

type SourceName = 'token_operation' | 'award' | 'spend';
type MovementDirection = 'issued' | 'returned';

interface RawEvidenceRow {
  source: SourceName;
  id: string;
  operationKey: string | null;
  operationType: AdminEvidenceOperationType;
  uid: string | null;
  walletAddress: string | null;
  userId: string | null;
  amount: unknown;
  sessionId: string | null;
  providerId: string | null;
  reservationId: string | null;
  status: string | null;
  movementOutcome: AdminEvidenceMovementOutcome | null;
  txHash: string | null;
  intentContext: Record<string, unknown> | null;
  createdAt: Date | string | null;
  submittedAt: Date | string | null;
  confirmedAt: Date | string | null;
  projectedAt: Date | string | null;
  updatedAt: Date | string | null;
  activityAt: Date | string | null;
  activityAtSource: AdminEvidenceActivityAtSource;
  direction: MovementDirection;
  rank: number;
}

interface SourceRead {
  rows: RawEvidenceRow[];
  available: boolean;
  truncated: boolean;
}

interface UserLookup {
  uid: string | null;
  walletAddress: string | null;
}

interface ResolvedReference {
  provenance: AdminCorrectionAnnotation['resolvedReference']['provenance'];
  operationKey: string | null;
  chainId: string | null;
  tokenContractAddress: string | null;
  uid: string | null;
  walletAddress: string | null;
}

export class AdminEvidenceError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(statusCode: number, code: string, message: string) {
    super(message);
    this.name = 'AdminEvidenceError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function valueFromQuery(query: unknown, key: string): unknown {
  if (!query || typeof query !== 'object') return undefined;
  return (query as Record<string, unknown>)[key];
}

function queryString(query: unknown, key: string): string | undefined {
  const value = valueFromQuery(query, key);
  if (value === undefined) return undefined;
  if (Array.isArray(value) || typeof value !== 'string') {
    throw new AdminEvidenceError(400, 'INVALID_EVIDENCE_QUERY', `${key} must be a single query value`);
  }
  return value;
}

function parseBoundedInteger(value: string | undefined, key: string, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new AdminEvidenceError(400, 'INVALID_EVIDENCE_QUERY', `${key} must be a non-negative integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new AdminEvidenceError(400, 'INVALID_EVIDENCE_QUERY', `${key} must be between ${min} and ${max}`);
  }
  return parsed;
}

function parseIsoDate(value: string | undefined, key: string, fallback: Date): Date {
  if (value === undefined) return fallback;
  if (!value.endsWith('Z')) {
    throw new AdminEvidenceError(400, 'INVALID_EVIDENCE_PERIOD', `${key} must be an ISO timestamp ending in Z`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AdminEvidenceError(400, 'INVALID_EVIDENCE_PERIOD', `${key} must be a valid ISO timestamp`);
  }
  return parsed;
}

/** Parse the bounded read/export query shared by JSON and CSV responses. */
export function parseAdminEvidenceQuery(query: unknown, now = new Date()): AdminEvidenceQuery {
  const requestedTo = parseIsoDate(queryString(query, 'to'), 'to', now);
  const requestedFrom = parseIsoDate(
    queryString(query, 'from'),
    'from',
    new Date(requestedTo.getTime() - 30 * 24 * 60 * 60 * 1000),
  );
  if (requestedFrom > requestedTo) {
    throw new AdminEvidenceError(400, 'INVALID_EVIDENCE_PERIOD', 'from must be earlier than or equal to to');
  }
  if (requestedTo.getTime() - requestedFrom.getTime() > ADMIN_EVIDENCE_MAX_PERIOD_DAYS * 24 * 60 * 60 * 1000) {
    throw new AdminEvidenceError(400, 'INVALID_EVIDENCE_PERIOD', 'from/to must describe a window of at most 366 days');
  }

  const scopeValue = queryString(query, 'scope');
  const scope = (scopeValue === undefined ? 'all' : scopeValue.trim()) as AdminEvidenceScope;
  if (scope !== 'all' && scope !== 'unresolved') {
    throw new AdminEvidenceError(400, 'INVALID_EVIDENCE_QUERY', 'scope must be either all or unresolved');
  }

  const formatValue = queryString(query, 'format');
  const format = (formatValue === undefined ? 'json' : formatValue.trim()) as AdminEvidenceFormat;
  if (format !== 'json' && format !== 'csv') {
    throw new AdminEvidenceError(400, 'INVALID_EVIDENCE_QUERY', 'format must be either json or csv');
  }

  const emaidValue = queryString(query, 'emaid')?.trim();
  if (emaidValue !== undefined && (!emaidValue || emaidValue.length > 255)) {
    throw new AdminEvidenceError(400, 'INVALID_EVIDENCE_QUERY', 'emaid must be between 1 and 255 characters');
  }
  const operationTypeValue = queryString(query, 'operationType');
  const operationType = operationTypeValue?.trim() as AdminEvidenceOperationType | undefined;
  if (operationType !== undefined && operationType !== 'award' && operationType !== 'spend') {
    throw new AdminEvidenceError(400, 'INVALID_EVIDENCE_QUERY', 'operationType must be award or spend');
  }
  const statusValue = queryString(query, 'status')?.trim();
  if (statusValue !== undefined && (!statusValue || statusValue.length > 40 || !/^[A-Za-z0-9_.:-]+$/.test(statusValue))) {
    throw new AdminEvidenceError(400, 'INVALID_EVIDENCE_QUERY', 'status must be a safe status token no longer than 40 characters');
  }

  return {
    from: requestedFrom.toISOString(),
    to: requestedTo.toISOString(),
    limit: parseBoundedInteger(queryString(query, 'limit'), 'limit', ADMIN_EVIDENCE_DEFAULT_LIMIT, 1, ADMIN_EVIDENCE_MAX_LIMIT),
    offset: parseBoundedInteger(queryString(query, 'offset'), 'offset', 0, 0, ADMIN_EVIDENCE_MAX_OFFSET),
    scope,
    ...(emaidValue ? { emaid: emaidValue } : {}),
    ...(operationType ? { operationType } : {}),
    ...(statusValue ? { status: statusValue } : {}),
    format,
  };
}

function objectValue(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function arrayValue(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string' || !value.trim()) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function safeString(value: unknown, maxLength = 320): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || SAFE_TEXT_CONTROL_PATTERN.test(trimmed)) return null;
  return trimmed;
}

function safeStatus(value: unknown, maxLength = 40): string | null {
  const text = safeString(value, maxLength);
  return text && SAFE_RECONCILIATION_STATUS_PATTERN.test(text) ? text : null;
}

function parseDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function iso(value: unknown): string | null {
  const date = parseDate(value);
  return date ? date.toISOString() : null;
}

function parseDecimal(value: unknown, scale = 2): bigint | null {
  const text = typeof value === 'number' && Number.isFinite(value) ? String(value) : typeof value === 'string' ? value.trim() : '';
  if (!/^-?\d+(?:\.\d+)?$/.test(text)) return null;
  const negative = text.startsWith('-');
  const unsigned = negative ? text.slice(1) : text;
  const [whole, fraction = ''] = unsigned.split('.');
  if (fraction.length > scale) return null;
  const units = BigInt(whole) * (10n ** BigInt(scale)) + BigInt((fraction + '0'.repeat(scale)).slice(0, scale) || '0');
  return negative ? -units : units;
}

function formatDecimal(value: bigint, scale = 2): string {
  const negative = value < 0n;
  const absolute = negative ? -value : value;
  const divisor = 10n ** BigInt(scale);
  const whole = absolute / divisor;
  const fraction = String(absolute % divisor).padStart(scale, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${fraction}`;
}

function canonicalHash(value: unknown): string | null {
  return canonicalTransactionHash(value) || null;
}

function assetFromContext(intentContext: Record<string, unknown> | null): AdminEvidenceAsset {
  const asset = objectValue(intentContext?.assetContext);
  const chainId = typeof asset?.chainId === 'string' && SAFE_CHAIN_ID_PATTERN.test(asset.chainId) ? asset.chainId : null;
  const tokenContractAddress = typeof asset?.tokenContractAddress === 'string' && SAFE_TOKEN_ADDRESS_PATTERN.test(asset.tokenContractAddress)
    ? asset.tokenContractAddress.toLowerCase()
    : null;
  if (!chainId || !tokenContractAddress) {
    return { chainId: null, tokenContractAddress: null, provenance: 'legacy_unknown' };
  }
  return { chainId, tokenContractAddress, provenance: 'stored_operation_context' };
}

function assetKey(asset: AdminEvidenceAsset): string {
  return `${asset.chainId || 'unknown'}|${asset.tokenContractAddress || 'unknown'}|${asset.provenance === 'stored_operation_context' ? 'known' : 'unknown'}`;
}

function operationPolicy(intentContext: Record<string, unknown> | null, operationType: AdminEvidenceOperationType): AdminEvidenceHistoricalPolicy {
  if (operationType === 'spend') {
    return { source: 'not_applicable', revision: null, rulesVersion: null, safePolicyFingerprint: null };
  }
  const snapshotText = typeof intentContext?.configurationSnapshot === 'string' ? intentContext.configurationSnapshot : null;
  const fingerprint = typeof intentContext?.configurationFingerprint === 'string'
    && SAFE_FINGERPRINT_PATTERN.test(intentContext.configurationFingerprint)
    ? intentContext.configurationFingerprint.toLowerCase()
    : null;
  if (!snapshotText || !fingerprint || snapshotText.length > 10_000) {
    return { source: 'unknown', revision: null, rulesVersion: null, safePolicyFingerprint: null };
  }
  const expected = crypto.createHash('sha256').update(snapshotText, 'utf8').digest('hex');
  if (expected !== fingerprint) {
    return { source: 'unknown', revision: null, rulesVersion: null, safePolicyFingerprint: null };
  }
  const snapshot = objectValue(snapshotText);
  const revision = typeof snapshot?.policyRevision === 'number' && Number.isSafeInteger(snapshot.policyRevision) && snapshot.policyRevision >= 0
    ? snapshot.policyRevision
    : null;
  const rulesVersion = typeof snapshot?.version === 'string' && /^[A-Za-z0-9._-]{1,120}$/.test(snapshot.version)
    ? snapshot.version
    : null;
  if (revision === null && rulesVersion === null) {
    return { source: 'unknown', revision: null, rulesVersion: null, safePolicyFingerprint: null };
  }
  return { source: 'operation_snapshot', revision, rulesVersion, safePolicyFingerprint: fingerprint };
}

function userLookupValue(row: Record<string, unknown> | undefined): UserLookup {
  return {
    uid: safeString(row?.uid, 255),
    walletAddress: safeString(row?.wallet_address, 128),
  };
}

function movementOutcomeFor(source: SourceName, status: string | null, movementOutcome: unknown): AdminEvidenceMovementOutcome | null {
  if (source === 'token_operation') {
    if (movementOutcome === 'confirmed' || movementOutcome === 'no_movement' || movementOutcome === 'unknown' || movementOutcome === 'review') return movementOutcome;
    return status === 'confirmed' || status === 'projected' ? 'confirmed' : status === 'failed' ? 'no_movement' : 'unknown';
  }
  if (status === 'confirmed' || status === 'projected' || !status) return 'confirmed';
  if (status === 'failed') return 'no_movement';
  if (status === 'unknown') return 'unknown';
  return 'review';
}

function activityFor(source: SourceName, row: Record<string, unknown>): { at: Date | null; source: AdminEvidenceActivityAtSource } {
  if (source === 'token_operation') {
    const confirmed = parseDate(row.confirmed_at);
    if (confirmed) return { at: confirmed, source: 'confirmed_at' };
    const fallback = parseDate(row.projected_at) || parseDate(row.updated_at) || parseDate(row.created_at);
    return { at: fallback, source: fallback ? 'projection_or_created_at' : 'unknown' };
  }
  const confirmed = parseDate(row.confirmed_at);
  if (confirmed) return { at: confirmed, source: 'confirmed_at' };
  const fallback = source === 'award' ? parseDate(row.awarded_at) || parseDate(row.created_at) : parseDate(row.created_at);
  return { at: fallback, source: fallback ? 'projection_or_created_at' : 'unknown' };
}

function mapRawRow(source: SourceName, row: Record<string, unknown>, user?: UserLookup): RawEvidenceRow | null {
  const id = safeString(row.id, 128);
  if (!id) return null;
  const operationType = source === 'token_operation'
    ? row.operation_type === 'spend' ? 'spend' : row.operation_type === 'award' ? 'award' : null
    : source;
  if (!operationType) return null;
  const status = safeStatus(row.status, 40);
  const activity = activityFor(source, row);
  return {
    source,
    id,
    operationKey: safeString(row.operation_key, 240),
    operationType,
    uid: source === 'token_operation' ? safeString(row.uid, 255) : user?.uid || null,
    walletAddress: source === 'token_operation'
      ? safeString(row.wallet_address, 128)
      : safeString(row.wallet_address, 128) || user?.walletAddress || null,
    userId: safeString(row.user_id, 128),
    amount: row.amount,
    sessionId: safeString(row.session_id, 255),
    providerId: safeString(row.provider_id, 255),
    reservationId: safeString(row.reservation_id, 128),
    status,
    movementOutcome: movementOutcomeFor(source, status, row.movement_outcome),
    txHash: canonicalHash(row.tx_hash),
    intentContext: objectValue(row.intent_context),
    createdAt: row.created_at as Date | string | null,
    submittedAt: row.submitted_at as Date | string | null,
    confirmedAt: row.confirmed_at as Date | string | null,
    projectedAt: row.projected_at as Date | string | null,
    updatedAt: row.updated_at as Date | string | null,
    activityAt: activity.at,
    activityAtSource: activity.source,
    direction: operationType === 'award' ? 'issued' : 'returned',
    rank: source === 'token_operation' ? 3 : 2,
  };
}

function tableDatePredicate(query: Knex.QueryBuilder, source: SourceName, from: Date, to: Date): void {
  query.where(function (this: Knex.QueryBuilder) {
    this.whereBetween('created_at', [from, to]);
    if (source === 'token_operation') {
      this.orWhereBetween('confirmed_at', [from, to])
        .orWhereBetween('projected_at', [from, to])
        .orWhereBetween('updated_at', [from, to]);
    } else if (source === 'award') {
      this.orWhereBetween('awarded_at', [from, to]).orWhereBetween('confirmed_at', [from, to]);
    } else {
      this.orWhereBetween('confirmed_at', [from, to]);
    }
  });
}

/**
 * Project only the two asset identifiers and the bounded policy snapshot from
 * the JSON context.  The retained context can also contain raw CDRs,
 * diagnostics, and recovery material; those values must never be materialised
 * by an evidence read.
 */
function safeIntentContextColumn(db: Pick<Knex, 'raw'>): Knex.Raw {
  const context = 'to_jsonb("intent_context")';
  return db.raw(`case when "intent_context" is null then null else jsonb_build_object(
    'assetContext', jsonb_build_object(
      'chainId', ${context}->'assetContext'->>'chainId',
      'tokenContractAddress', ${context}->'assetContext'->>'tokenContractAddress'
    ),
    'configurationSnapshot', case
      when length(${context}->>'configurationSnapshot') <= 10000
      then ${context}->>'configurationSnapshot'
      else null
    end,
    'configurationFingerprint', lower(${context}->>'configurationFingerprint')
  ) end as "intent_context"`);
}

async function readSourceRows(db: Knex, source: SourceName, from: Date, to: Date): Promise<SourceRead> {
  const table = source === 'token_operation' ? 'token_operations' : source === 'award' ? 'awards' : 'spends';
  if (!(await db.schema.hasTable(table))) return { rows: [], available: false, truncated: false };
  const columns = source === 'token_operation'
    ? ['id', 'operation_key', 'operation_type', 'uid', 'wallet_address', 'amount', 'session_id', 'provider_id', 'reservation_id', 'status', 'movement_outcome', 'tx_hash', safeIntentContextColumn(db), 'submitted_at', 'confirmed_at', 'projected_at', 'created_at', 'updated_at']
    : source === 'award'
      ? ['id', 'user_id', 'amount', 'session_id', 'provider_id', 'status', 'tx_hash', 'awarded_at', 'confirmed_at', 'created_at']
      : ['id', 'user_id', 'wallet_address', 'amount', 'session_id', 'status', 'tx_hash', 'confirmed_at', 'created_at'];
  const query = db(table).select(columns);
  tableDatePredicate(query, source, from, to);
  const orderColumn = source === 'token_operation' ? 'updated_at' : source === 'award' ? 'awarded_at' : 'created_at';
  const rows = await query.orderBy(orderColumn, 'desc').orderBy('id', 'desc').limit(ADMIN_EVIDENCE_MAX_SOURCE_ROWS + 1) as unknown as Array<Record<string, unknown>>;
  const truncated = rows.length > ADMIN_EVIDENCE_MAX_SOURCE_ROWS;
  return {
    rows: rows.slice(0, ADMIN_EVIDENCE_MAX_SOURCE_ROWS).flatMap(row => {
      const mapped = mapRawRow(source, row);
      return mapped ? [mapped] : [];
    }),
    available: true,
    truncated,
  };
}

async function loadUsers(db: Knex, rows: RawEvidenceRow[]): Promise<Map<string, UserLookup>> {
  const ids = [...new Set(rows.map(row => row.userId).filter((id): id is string => Boolean(id)))];
  if (!ids.length || !(await db.schema.hasTable('users'))) return new Map();
  const users = await db('users').select(['id', 'uid', 'wallet_address'])
    .whereIn('id', ids.slice(0, ADMIN_EVIDENCE_MAX_SOURCE_ROWS * 3)) as unknown as Array<Record<string, unknown>>;
  return new Map(users.flatMap(row => {
    const id = safeString(row.id, 128);
    return id ? [[id, userLookupValue(row)] as [string, UserLookup]] : [];
  }));
}

function applyUserLookup(rows: RawEvidenceRow[], users: Map<string, UserLookup>): RawEvidenceRow[] {
  return rows.map(row => {
    if (row.source === 'token_operation' || !row.userId) return row;
    const user = users.get(row.userId);
    return user ? { ...row, uid: user.uid, walletAddress: row.walletAddress || user.walletAddress } : row;
  });
}

function isUnresolved(row: RawEvidenceRow): boolean {
  if (row.source !== 'token_operation') return row.movementOutcome !== 'confirmed';
  return row.status !== 'projected' || row.movementOutcome !== 'confirmed';
}

function safeExceptionCategory(row: RawEvidenceRow): string | null {
  if (row.movementOutcome === 'review') return 'review_required';
  if (row.status === 'unknown' || row.movementOutcome === 'unknown') return 'chain_outcome_unknown';
  if (row.status === 'failed') return row.movementOutcome === 'no_movement' ? 'no_movement' : 'operation_failed';
  if (row.source === 'token_operation' && row.status === 'confirmed') return 'projection_pending';
  if (row.status === 'confirmed' && row.movementOutcome !== 'confirmed') return 'projection_pending';
  return null;
}

function rowHashKey(row: RawEvidenceRow): string | null {
  if (!row.txHash) return null;
  return `${row.txHash}|${assetKey(assetFromContext(row.intentContext))}`;
}

function knownOwnerMismatch(left: RawEvidenceRow, right: RawEvidenceRow): boolean {
  if (left.userId && right.userId && left.userId !== right.userId) return true;
  if (left.uid && right.uid && left.uid !== right.uid) return true;
  if (left.walletAddress && right.walletAddress
    && left.walletAddress.toLowerCase() !== right.walletAddress.toLowerCase()) return true;
  return false;
}

function sameMovement(left: RawEvidenceRow, right: RawEvidenceRow): boolean {
  const leftAmount = parseDecimal(left.amount);
  const rightAmount = parseDecimal(right.amount);
  return left.direction === right.direction
    && leftAmount !== null
    && rightAmount !== null
    && leftAmount === rightAmount
    && !knownOwnerMismatch(left, right);
}

interface DedupedRows {
  rows: RawEvidenceRow[];
  invalidHashCount: number;
  unknownMovementCount: number;
  unknownAssetCount: number;
  duplicateConflictCount: number;
  warnings: string[];
}

function dedupeRows(input: RawEvidenceRow[]): DedupedRows {
  const warnings = new Set<string>();
  let invalidHashCount = 0;
  let unknownMovementCount = 0;
  let unknownAssetCount = 0;
  let duplicateConflictCount = 0;
  const byHash = new Map<string, RawEvidenceRow[]>();
  const withoutHash: RawEvidenceRow[] = [];
  for (const row of input) {
    if (!row.txHash) {
      if (parseDecimal(row.amount) !== null && row.movementOutcome === 'confirmed') invalidHashCount += 1;
      if (row.movementOutcome !== 'confirmed') unknownMovementCount += 1;
      if (row.movementOutcome === 'confirmed' && assetFromContext(row.intentContext).provenance !== 'stored_operation_context') unknownAssetCount += 1;
      withoutHash.push(row);
      continue;
    }
    const group = byHash.get(row.txHash) || [];
    group.push(row);
    byHash.set(row.txHash, group);
    if (row.movementOutcome !== 'confirmed') unknownMovementCount += 1;
  }

  const selected: RawEvidenceRow[] = [...withoutHash];
  for (const [hash, group] of byHash.entries()) {
    const byAsset = new Map<string, RawEvidenceRow[]>();
    for (const row of group) {
      const key = assetKey(assetFromContext(row.intentContext));
      const rows = byAsset.get(key) || [];
      rows.push(row);
      byAsset.set(key, rows);
    }
    const known = [...byAsset.keys()].filter(key => !key.startsWith('unknown|'));
    const knownRows = known.flatMap(key => byAsset.get(key) || []);
    const multipleKnownAssets = known.length > 1;
    const knownSemanticConflict = known.some(key => {
      const rows = byAsset.get(key) || [];
      const sorted = [...rows].sort((left, right) => right.rank - left.rank || left.id.localeCompare(right.id));
      const chosen = sorted[0];
      return rows.filter(row => row.source === 'token_operation').length > 1
        || (rows.length > 1 && rows.some(row => !sameMovement(row, chosen)));
    });
    const unknownRows = [...byAsset.entries()]
      .filter(([key]) => key.startsWith('unknown|'))
      .flatMap(([, rows]) => rows);
    const unknownMirror = unknownRows.length > 0
      && knownRows.length > 0
      && unknownRows.every(row => knownRows.some(knownRow => sameMovement(row, knownRow)));
    const unknownAssetConflict = unknownRows.length > 0
      && knownRows.length > 0
      && (!unknownMirror || multipleKnownAssets || knownSemanticConflict);
    if (multipleKnownAssets) warnings.add(`transaction hash ${hash} has multiple known asset identities; movement is retained for review and excluded from confirmed totals`);
    for (const [key, rows] of byAsset.entries()) {
      const sorted = [...rows].sort((left, right) => right.rank - left.rank || left.id.localeCompare(right.id));
      const chosen = sorted[0];
      const authoritative = rows.filter(row => row.source === 'token_operation');
      const conflictingRows = rows.length > 1 && rows.some(row => !sameMovement(row, chosen));
      const authoritativeConflict = authoritative.length > 1;
      const groupConflict = multipleKnownAssets || conflictingRows || authoritativeConflict || unknownAssetConflict;
      if (groupConflict) {
        duplicateConflictCount += 1;
        warnings.add(authoritativeConflict
          ? `transaction hash ${hash} has multiple authoritative token-operation records; movement is retained for review and excluded from confirmed totals`
          : `transaction hash ${hash} has conflicting retained ownership, amount, movement, or asset evidence; movement is retained for review and excluded from confirmed totals`);
      }
      if (key.startsWith('unknown|') && known.length > 0) {
        if (unknownMirror && !unknownAssetConflict && !groupConflict) continue;
        warnings.add(`transaction hash ${hash} has unresolved unknown-asset evidence; movement is retained for review and excluded from confirmed totals`);
        selected.push(...rows.map(row => ({ ...row, intentContext: null, movementOutcome: 'review' as const })));
        continue;
      }
      if (chosen.movementOutcome === 'confirmed' && assetFromContext(chosen.intentContext).provenance !== 'stored_operation_context') unknownAssetCount += 1;
      if (groupConflict) {
        selected.push(...rows.map(row => ({ ...row, movementOutcome: 'review' as const })));
      } else {
        selected.push(chosen);
      }
    }
  }
  if (invalidHashCount) warnings.add('confirmed movement evidence without a canonical transaction hash is excluded from totals');
  if (unknownMovementCount) warnings.add('unconfirmed or unknown movement evidence is retained for review but excluded from confirmed totals');
  if (unknownAssetCount) warnings.add('confirmed movement asset provenance is unknown for one or more retained rows');
  return {
    rows: selected,
    invalidHashCount,
    unknownMovementCount,
    unknownAssetCount,
    duplicateConflictCount,
    warnings: [...warnings],
  };
}

function maskValue(value: string | null): string | null {
  if (!value) return null;
  if (value.length <= 8) return `…${value.slice(-4)}`;
  return `${value.slice(0, 3)}…${value.slice(-4)}`;
}

/**
 * Keep operational correlation possible without returning caller-controlled
 * session/provider/reservation labels.  The report exposes only this opaque
 * reference; the source value never crosses the admin API boundary.
 */
function opaqueReference(value: string | null, namespace: string): string | null {
  const text = safeString(value, 320);
  if (!text) return null;
  return `${namespace}_${crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 24)}`;
}

function mapEvidenceRow(row: RawEvidenceRow, annotationCount: number): AdminEvidenceRow {
  const amount = parseDecimal(row.amount);
  const asset = assetFromContext(row.intentContext);
  return {
    subjectType: row.source,
    subjectId: row.id,
    operationKey: opaqueReference(row.operationKey, 'op'),
    operationType: row.operationType,
    eMAID: maskValue(row.uid),
    walletAddress: maskValue(row.walletAddress),
    amountSparkz: amount === null ? '0.00' : formatDecimal(amount),
    status: row.status,
    movementOutcome: row.movementOutcome,
    transactionHash: row.txHash,
    asset,
    historicalPolicy: operationPolicy(row.intentContext, row.operationType),
    sessionId: opaqueReference(row.sessionId, 'session'),
    providerId: opaqueReference(row.providerId, 'provider'),
    reservationId: opaqueReference(row.reservationId, 'reservation'),
    timestamps: {
      createdAt: iso(row.createdAt),
      submittedAt: iso(row.submittedAt),
      confirmedAt: iso(row.confirmedAt),
      projectedAt: iso(row.projectedAt),
      activityAt: iso(row.activityAt),
      activityAtSource: row.activityAtSource,
    },
    exceptionCategory: safeExceptionCategory(row),
    annotationCount,
  };
}

function sourceAssetFor(row: RawEvidenceRow): AdminEvidenceAsset {
  return assetFromContext(row.intentContext);
}

function sourceTotals(rows: RawEvidenceRow[], from: Date, to: Date): {
  totals: AdminEvidenceTotalsByAsset[];
  issuedMovementCount: number;
  returnedMovementCount: number;
  confirmedMovementCount: number;
} {
  const totals = new Map<string, AdminEvidenceTotalsByAsset>();
  let issuedMovementCount = 0;
  let returnedMovementCount = 0;
  let confirmedMovementCount = 0;
  for (const row of rows) {
    const activityAt = parseDate(row.activityAt);
    if (!activityAt || activityAt < from || activityAt > to) continue;
    if (row.movementOutcome !== 'confirmed' || !row.txHash) continue;
    const amount = parseDecimal(row.amount);
    if (amount === null || amount < 0n) continue;
    confirmedMovementCount += 1;
    if (row.direction === 'issued') issuedMovementCount += 1;
    else returnedMovementCount += 1;
    const asset = sourceAssetFor(row);
    const key = assetKey(asset);
    const current = totals.get(key) || {
      ...asset,
      awardedSparkz: '0.00',
      spentSparkz: '0.00',
      netIssuedSparkz: '0.00',
    };
    const awarded = parseDecimal(current.awardedSparkz) || 0n;
    const spent = parseDecimal(current.spentSparkz) || 0n;
    if (row.direction === 'issued') current.awardedSparkz = formatDecimal(awarded + amount);
    else current.spentSparkz = formatDecimal(spent + amount);
    current.netIssuedSparkz = formatDecimal((parseDecimal(current.awardedSparkz) || 0n) - (parseDecimal(current.spentSparkz) || 0n));
    totals.set(key, current);
  }
  return { totals: [...totals.values()], issuedMovementCount, returnedMovementCount, confirmedMovementCount };
}

async function annotationCounts(db: Knex, rows: RawEvidenceRow[]): Promise<{ counts: Map<string, number>; warning?: string }> {
  if (!(await db.schema.hasTable(ADMIN_CORRECTION_ANNOTATIONS_TABLE))) {
    return { counts: new Map(), warning: 'admin correction annotation migration 025 is unavailable; annotation counts are incomplete' };
  }
  if (!rows.length) return { counts: new Map() };
  try {
    const pairs = rows.map(row => ({ subjectType: row.source, subjectId: row.id }));
    const counts = new Map<string, number>();
    const byType = new Map<SourceName, string[]>();
    for (const pair of pairs) {
      const ids = byType.get(pair.subjectType) || [];
      ids.push(pair.subjectId);
      byType.set(pair.subjectType, ids);
    }
    for (const [subjectType, ids] of byType.entries()) {
      const result = await db(ADMIN_CORRECTION_ANNOTATIONS_TABLE)
        .select('subject_id')
        .count({ count: '*' })
        .where({ subject_type: subjectType })
        .whereIn('subject_id', ids)
        .groupBy('subject_id') as unknown as Array<{ subject_id: string; count: string | number }>;
      for (const item of result) counts.set(`${subjectType}:${item.subject_id}`, Number(item.count) || 0);
    }
    return { counts };
  } catch {
    return { counts: new Map(), warning: 'admin correction annotation counts could not be read; report rows remain available' };
  }
}

function safeReconciliationAmount(value: unknown): string | null {
  const amount = parseDecimal(value, 8);
  return amount === null ? null : formatDecimal(amount, 8).replace(/0+$/, '').replace(/\.$/, '') || '0';
}

function maskReconciliationIdentity(value: unknown): string | null {
  return maskValue(safeString(value, 255));
}

async function loadReconciliation(db: Knex, generatedAt: Date): Promise<{ report: AdminEvidenceReportResponse['reconciliation']; warnings: string[] }> {
  const empty: AdminEvidenceReportResponse['reconciliation'] = {
    latestReportId: null,
    latestStatus: null,
    latestCreatedAt: null,
    ageSeconds: null,
    checkedCount: null,
    mismatchCount: null,
    discrepancies: [],
    coverageWarnings: [],
  };
  if (!(await db.schema.hasTable('reconciliation_reports'))) {
    empty.coverageWarnings.push('persisted reconciliation reports are unavailable');
    return { report: empty, warnings: [] };
  }
  try {
    const latest = await db('reconciliation_reports').orderBy('created_at', 'desc').first() as Record<string, unknown> | undefined;
    if (!latest) {
      empty.coverageWarnings.push('no persisted reconciliation report is available');
      return { report: empty, warnings: [] };
    }
    const createdAt = parseDate(latest.created_at);
    const list = arrayValue(latest.items) || [];
    const discrepancies = list.flatMap(item => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return [];
      const row = item as Record<string, unknown>;
      const rawStatus = safeString(row.status, 80);
      if (!rawStatus) return [];
      const status = SAFE_RECONCILIATION_STATUS_PATTERN.test(rawStatus) ? rawStatus : 'unknown';
      if (RECONCILIATION_MATCH_STATUSES.has(status.toLowerCase())) return [];
      return [{
        walletAddress: maskReconciliationIdentity(row.walletAddress ?? row.wallet_address),
        eMAID: maskReconciliationIdentity(row.uid ?? row.eMAID ?? row.emaid),
        status,
        expectedSparkz: safeReconciliationAmount(row.expectedSparkz ?? row.dbBalance ?? row.db_balance),
        recordedSparkz: safeReconciliationAmount(row.recordedSparkz ?? row.chainBalance ?? row.chain_balance),
        differenceSparkz: safeReconciliationAmount(row.differenceSparkz ?? row.difference),
      }];
    });
    empty.latestReportId = safeString(latest.id, 128);
    const latestStatus = safeString(latest.status, 40);
    empty.latestStatus = latestStatus && SAFE_RECONCILIATION_STATUS_PATTERN.test(latestStatus) ? latestStatus : 'unknown';
    empty.latestCreatedAt = iso(latest.created_at);
    empty.ageSeconds = createdAt ? Math.max(0, Math.floor((generatedAt.getTime() - createdAt.getTime()) / 1000)) : null;
    empty.checkedCount = Number.isSafeInteger(Number(latest.checked_count)) ? Number(latest.checked_count) : null;
    empty.mismatchCount = Number.isSafeInteger(Number(latest.mismatch_count)) ? Number(latest.mismatch_count) : null;
    empty.discrepancies = discrepancies.slice(0, 100);
    if (discrepancies.length > 100) empty.coverageWarnings.push('reconciliation discrepancy detail is capped at 100 rows');
    return { report: empty, warnings: [] };
  } catch {
    empty.coverageWarnings.push('persisted reconciliation reports could not be read');
    return { report: empty, warnings: [] };
  }
}

async function loadCurrentPolicy(db: Knex): Promise<{ revision: number | null; updatedAt: string | null; warning?: string }> {
  if (!(await db.schema.hasTable(REWARD_POLICY_TABLE))) return { revision: null, updatedAt: null, warning: 'reward policy table is unavailable; current policy revision is unknown' };
  try {
    const row = await db(REWARD_POLICY_TABLE).where({ id: REWARD_POLICY_ROW_ID }).select(['revision', 'updated_at']).first() as Record<string, unknown> | undefined;
    if (!row) return { revision: null, updatedAt: null, warning: 'current reward policy row is unavailable; current policy revision is unknown' };
    const revision = Number(row.revision);
    return {
      revision: Number.isSafeInteger(revision) && revision >= 0 ? revision : null,
      updatedAt: iso(row.updated_at),
    };
  } catch {
    return { revision: null, updatedAt: null, warning: 'current reward policy could not be read; current policy revision is unknown' };
  }
}

async function loadSource(source: SourceName, from: Date, to: Date): Promise<SourceRead> {
  try {
    return await readSourceRows(getDatabase(), source, from, to);
  } catch {
    return { rows: [], available: false, truncated: false };
  }
}

function sortRows(rows: RawEvidenceRow[]): RawEvidenceRow[] {
  return [...rows].sort((left, right) => {
    const leftTime = parseDate(left.activityAt)?.getTime() || 0;
    const rightTime = parseDate(right.activityAt)?.getTime() || 0;
    return rightTime - leftTime || right.rank - left.rank || left.id.localeCompare(right.id);
  });
}

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? '' : String(value);
  const safe = /^[=+\-@]/.test(text.trimStart()) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

const CSV_COLUMNS = [
  'generatedAt', 'periodFrom', 'periodTo', 'observationAt', 'basis',
  'subjectType', 'subjectId', 'operationKey', 'operationType', 'eMAID', 'walletAddress',
  'amountSparkz', 'status', 'movementOutcome', 'transactionHash', 'chainId', 'tokenContractAddress',
  'assetProvenance', 'policySource', 'policyRevision', 'rulesVersion', 'safePolicyFingerprint',
  'sessionId', 'providerId', 'reservationId', 'createdAt', 'submittedAt', 'confirmedAt', 'projectedAt',
  'activityAt', 'activityAtSource', 'exceptionCategory', 'annotationCount',
  'summaryIssuedMovementCount', 'summaryReturnedMovementCount', 'summaryConfirmedMovementCount',
  'summaryExceptionCount', 'summaryTotalsByAsset', 'coverageTotalIsLowerBound', 'coverageTruncated',
  'coverageUnknownMovementCount', 'coverageInvalidHashCount', 'coverageUnknownAssetCount',
  'coverageDuplicateConflictCount', 'coverageWarnings',
] as const;

type CsvColumn = typeof CSV_COLUMNS[number];
type CsvValues = Partial<Record<CsvColumn, unknown>>;

function csvRow(values: CsvValues): string {
  return CSV_COLUMNS.map(column => csvCell(values[column])).join(',');
}

export function renderAdminEvidenceCsv(report: AdminEvidenceReportResponse): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const row of report.rows) {
    lines.push(csvRow({
      generatedAt: report.generatedAt,
      periodFrom: report.period.from,
      periodTo: report.period.to,
      observationAt: report.period.observationAt,
      basis: report.summary.basis,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      operationKey: row.operationKey,
      operationType: row.operationType,
      eMAID: row.eMAID,
      walletAddress: row.walletAddress,
      amountSparkz: row.amountSparkz,
      status: row.status,
      movementOutcome: row.movementOutcome,
      transactionHash: row.transactionHash,
      chainId: row.asset.chainId,
      tokenContractAddress: row.asset.tokenContractAddress,
      assetProvenance: row.asset.provenance,
      policySource: row.historicalPolicy.source,
      policyRevision: row.historicalPolicy.revision,
      rulesVersion: row.historicalPolicy.rulesVersion,
      safePolicyFingerprint: row.historicalPolicy.safePolicyFingerprint,
      sessionId: row.sessionId,
      providerId: row.providerId,
      reservationId: row.reservationId,
      createdAt: row.timestamps.createdAt,
      submittedAt: row.timestamps.submittedAt,
      confirmedAt: row.timestamps.confirmedAt,
      projectedAt: row.timestamps.projectedAt,
      activityAt: row.timestamps.activityAt,
      activityAtSource: row.timestamps.activityAtSource,
      exceptionCategory: row.exceptionCategory,
      annotationCount: row.annotationCount,
      summaryIssuedMovementCount: report.summary.issuedMovementCount,
      summaryReturnedMovementCount: report.summary.returnedMovementCount,
      summaryConfirmedMovementCount: report.summary.confirmedMovementCount,
      summaryExceptionCount: report.summary.exceptionCount,
      summaryTotalsByAsset: JSON.stringify(report.summary.totalsByAsset),
      coverageTotalIsLowerBound: report.coverage.totalIsLowerBound,
      coverageTruncated: report.coverage.truncated,
      coverageUnknownMovementCount: report.coverage.unknownMovementCount,
      coverageInvalidHashCount: report.coverage.invalidHashCount,
      coverageUnknownAssetCount: report.coverage.unknownAssetCount,
      coverageDuplicateConflictCount: report.coverage.duplicateConflictCount,
      coverageWarnings: report.coverage.warnings.join(' | '),
    }));
  }
  if (!report.rows.length) {
    lines.push(csvRow({
      generatedAt: report.generatedAt,
      periodFrom: report.period.from,
      periodTo: report.period.to,
      observationAt: report.period.observationAt,
      basis: report.summary.basis,
      summaryIssuedMovementCount: report.summary.issuedMovementCount,
      summaryReturnedMovementCount: report.summary.returnedMovementCount,
      summaryConfirmedMovementCount: report.summary.confirmedMovementCount,
      summaryExceptionCount: report.summary.exceptionCount,
      summaryTotalsByAsset: JSON.stringify(report.summary.totalsByAsset),
      coverageTotalIsLowerBound: report.coverage.totalIsLowerBound,
      coverageTruncated: report.coverage.truncated,
      coverageUnknownMovementCount: report.coverage.unknownMovementCount,
      coverageInvalidHashCount: report.coverage.invalidHashCount,
      coverageUnknownAssetCount: report.coverage.unknownAssetCount,
      coverageDuplicateConflictCount: report.coverage.duplicateConflictCount,
      coverageWarnings: report.coverage.warnings.join(' | '),
    }));
  }
  return `${lines.join('\r\n')}\r\n`;
}

/** Read a bounded, database-only operational evidence report. */
export async function getAdminEvidenceReport(query: AdminEvidenceQuery): Promise<AdminEvidenceReportResponse> {
  const db = getDatabase();
  const from = new Date(query.from);
  const to = new Date(query.to);
  const generatedAt = new Date();
  const sourceNames: SourceName[] = ['token_operation', 'award', 'spend'];
  const reads = await Promise.all(sourceNames.map(source => loadSource(source, from, to)));
  const sourceWarnings: string[] = [];
  reads.forEach((read, index) => {
    if (!read.available) sourceWarnings.push(`${sourceNames[index]} evidence is unavailable; coverage is incomplete`);
    if (read.truncated) sourceWarnings.push(`${sourceNames[index]} evidence reached the bounded source cap`);
  });
  const rawRows = reads.flatMap(read => read.rows);
  const users = await loadUsers(db, rawRows);
  const hydratedRows = applyUserLookup(rawRows, users);
  // Classify every row in the bounded retained source set before applying
  // presentation filters.  Filtering first can hide the other side of a
  // conflicting same-hash pair and incorrectly turn the selected row into a
  // confirmed movement (including for eMAID/status and unresolved scopes).
  const deduped = dedupeRows(hydratedRows);
  const filteredRows = deduped.rows.filter(row => {
    const activityAt = parseDate(row.activityAt);
    if (!activityAt || activityAt < from || activityAt > to) return false;
    if (query.scope === 'unresolved' && !isUnresolved(row)) return false;
    if (query.emaid && row.uid !== query.emaid) return false;
    if (query.operationType && row.operationType !== query.operationType) return false;
    if (query.status && row.status !== query.status) return false;
    return true;
  });
  const sorted = sortRows(filteredRows);
  const page = sorted.slice(query.offset, query.offset + query.limit);
  const counts = await annotationCounts(db, page);
  const policy = await loadCurrentPolicy(db);
  const reconciliation = await loadReconciliation(db, generatedAt);
  const coverageWarnings = [...sourceWarnings, ...deduped.warnings, ...(counts.warning ? [counts.warning] : []), ...(policy.warning ? [policy.warning] : [])];
  if (query.offset > sorted.length && reads.some(read => read.truncated)) coverageWarnings.push('offset exceeds the retained source window; total is a lower bound');
  const totals = sourceTotals(sorted, from, to);
  const totalIsLowerBound = reads.some(read => read.truncated);
  const hasMore = query.offset + page.length < sorted.length;
  return {
    status: 'ok',
    generatedAt: generatedAt.toISOString(),
    period: { from: from.toISOString(), to: to.toISOString(), observationAt: generatedAt.toISOString() },
    policy: { currentRevision: policy.revision, currentUpdatedAt: policy.updatedAt },
    summary: {
      basis: 'selected retained data in requested window',
      issuedMovementCount: totals.issuedMovementCount,
      returnedMovementCount: totals.returnedMovementCount,
      confirmedMovementCount: totals.confirmedMovementCount,
      exceptionCount: sorted.filter(row => safeExceptionCategory(row) !== null).length,
      totalsByAsset: totals.totals,
    },
    coverage: {
      sourceCounts: { tokenOperations: reads[0].rows.length, awards: reads[1].rows.length, spends: reads[2].rows.length },
      sourceCaps: { tokenOperations: ADMIN_EVIDENCE_MAX_SOURCE_ROWS, awards: ADMIN_EVIDENCE_MAX_SOURCE_ROWS, spends: ADMIN_EVIDENCE_MAX_SOURCE_ROWS },
      returnedCount: page.length,
      totalIsLowerBound,
      truncated: totalIsLowerBound,
      unknownMovementCount: deduped.unknownMovementCount,
      invalidHashCount: deduped.invalidHashCount,
      unknownAssetCount: deduped.unknownAssetCount,
      duplicateConflictCount: deduped.duplicateConflictCount,
      warnings: [...new Set(coverageWarnings)],
    },
    reconciliation: {
      ...reconciliation.report,
      coverageWarnings: [...new Set(reconciliation.report.coverageWarnings)],
    },
    pagination: {
      limit: query.limit,
      offset: query.offset,
      hasMore,
      nextOffset: hasMore && query.offset + page.length > query.offset && query.offset + page.length <= ADMIN_EVIDENCE_MAX_OFFSET
        ? query.offset + page.length
        : null,
    },
    rows: page.map(row => mapEvidenceRow(row, counts.counts.get(`${row.source}:${row.id}`) || 0)),
  };
}

function ensureUuid(value: unknown, field: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value.trim())) {
    throw new AdminEvidenceError(400, 'INVALID_ANNOTATION_REQUEST', `${field} must be a UUID`);
  }
  return value.trim().toLowerCase();
}

function ensureAnnotationText(value: unknown, field: string, maxLength: number): string {
  if (typeof value !== 'string') throw new AdminEvidenceError(400, 'INVALID_ANNOTATION_REQUEST', `${field} must be a string`);
  const text = value.trim();
  if (!text || text.length > maxLength || SAFE_TEXT_CONTROL_PATTERN.test(text)) {
    throw new AdminEvidenceError(400, 'INVALID_ANNOTATION_REQUEST', `${field} is empty, too long, or contains unsupported control characters`);
  }
  return text;
}

export function parseAdminCorrectionAnnotationRequest(value: unknown): AdminCorrectionAnnotationRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AdminEvidenceError(400, 'INVALID_ANNOTATION_REQUEST', 'Body must be an object');
  }
  const body = value as Record<string, unknown>;
  const allowed = ['clientRequestId', 'subjectType', 'subjectId', 'referenceType', 'reference', 'reason'];
  if (Object.keys(body).some(key => !allowed.includes(key)) || allowed.some(key => !(key in body))) {
    throw new AdminEvidenceError(400, 'INVALID_ANNOTATION_REQUEST', 'Body must contain only clientRequestId, subjectType, subjectId, referenceType, reference, and reason');
  }
  const clientRequestId = ensureUuid(body.clientRequestId, 'clientRequestId');
  const subjectType = body.subjectType;
  if (subjectType !== 'token_operation' && subjectType !== 'award' && subjectType !== 'spend') {
    throw new AdminEvidenceError(400, 'INVALID_ANNOTATION_REQUEST', 'subjectType is not supported');
  }
  const referenceType = body.referenceType;
  if (referenceType !== 'transaction' && referenceType !== 'case') {
    throw new AdminEvidenceError(400, 'INVALID_ANNOTATION_REQUEST', 'referenceType must be transaction or case');
  }
  const reference = ensureAnnotationText(body.reference, 'reference', 320);
  if (referenceType === 'transaction' && !canonicalHash(reference)) {
    throw new AdminEvidenceError(400, 'INVALID_ANNOTATION_REQUEST', 'transaction reference must be a canonical 0x-prefixed 32-byte hash');
  }
  return {
    clientRequestId,
    subjectType: subjectType as AdminCorrectionAnnotationSubjectType,
    subjectId: ensureUuid(body.subjectId, 'subjectId'),
    referenceType: referenceType as AdminCorrectionAnnotationReferenceType,
    reference: referenceType === 'transaction' ? canonicalHash(reference)! : reference,
    reason: ensureAnnotationText(body.reason, 'reason', 2_000),
  };
}

function annotationFromRow(row: Record<string, unknown>): AdminCorrectionAnnotation {
  return {
    id: String(row.id),
    clientRequestId: String(row.client_request_id),
    subjectType: row.subject_type as AdminCorrectionAnnotationSubjectType,
    subjectId: String(row.subject_id),
    referenceType: row.reference_type as AdminCorrectionAnnotationReferenceType,
    reference: String(row.reference_value),
    reason: String(row.reason),
    actorType: 'admin_session',
    actorId: String(row.actor_id),
    createdAt: iso(row.created_at) || new Date(0).toISOString(),
    resolvedReference: {
      provenance: (row.reference_provenance || 'unknown') as AdminCorrectionAnnotation['resolvedReference']['provenance'],
      operationKey: opaqueReference(safeString(row.reference_operation_key, 240), 'op'),
      chainId: safeString(row.reference_chain_id, 80),
      tokenContractAddress: safeString(row.reference_token_contract_address, 42),
    },
  };
}

function tableForSubject(subjectType: AdminCorrectionAnnotationSubjectType): string {
  return subjectType === 'token_operation' ? 'token_operations' : subjectType === 'award' ? 'awards' : 'spends';
}

async function targetContext(trx: Knex.Transaction, request: AdminCorrectionAnnotationRequest): Promise<ResolvedReference> {
  const table = tableForSubject(request.subjectType);
  if (!(await trx.schema.hasTable(table))) {
    throw new AdminEvidenceError(503, 'ANNOTATION_SUBJECT_SCHEMA_UNAVAILABLE', 'The selected evidence subject is temporarily unavailable');
  }
  const columns = request.subjectType === 'token_operation'
    ? ['id', 'operation_key', 'uid', 'wallet_address', safeIntentContextColumn(trx)]
    : request.subjectType === 'spend'
      ? ['id', 'user_id', 'wallet_address']
      : ['id', 'user_id'];
  const row = await trx(table).select(columns).where({ id: request.subjectId }).first() as Record<string, unknown> | undefined;
  if (!row) throw new AdminEvidenceError(404, 'ANNOTATION_SUBJECT_NOT_FOUND', 'The selected evidence subject was not found');
  let uid = safeString(row.uid, 255);
  let walletAddress = safeString(row.wallet_address, 128);
  if (request.subjectType !== 'token_operation' && row.user_id && await trx.schema.hasTable('users')) {
    const user = await trx('users').select(['uid', 'wallet_address']).where({ id: row.user_id }).first() as Record<string, unknown> | undefined;
    uid = uid || safeString(user?.uid, 255);
    walletAddress = walletAddress || safeString(user?.wallet_address, 128);
  }
  const asset = request.subjectType === 'token_operation' ? assetFromContext(objectValue(row.intent_context)) : { chainId: null, tokenContractAddress: null, provenance: 'legacy_unknown' as const };
  return {
    provenance: request.subjectType === 'token_operation' ? 'retained_operation' : request.subjectType === 'award' ? 'retained_award' : 'retained_spend',
    operationKey: safeString(row.operation_key, 240),
    chainId: asset.chainId,
    tokenContractAddress: asset.tokenContractAddress,
    uid,
    walletAddress,
  };
}

interface TransactionReferenceCandidate extends ResolvedReference {
  uid: string | null;
  walletAddress: string | null;
}

async function transactionReference(trx: Knex.Transaction, hash: string): Promise<TransactionReferenceCandidate> {
  const candidates: TransactionReferenceCandidate[] = [];
  let candidateOverflow = false;
  if (await trx.schema.hasTable('token_operations')) {
    const rows = await trx('token_operations')
      .select(['operation_key', 'uid', 'wallet_address', safeIntentContextColumn(trx)])
      .whereRaw('lower(tx_hash) = lower(?)', [hash])
      .limit(ADMIN_REFERENCE_CANDIDATE_LIMIT + 1) as unknown as Array<Record<string, unknown>>;
    if (rows.length > ADMIN_REFERENCE_CANDIDATE_LIMIT) candidateOverflow = true;
    for (const row of rows.slice(0, ADMIN_REFERENCE_CANDIDATE_LIMIT)) {
      const asset = assetFromContext(objectValue(row.intent_context));
      candidates.push({ provenance: 'retained_operation', operationKey: safeString(row.operation_key, 240), chainId: asset.chainId, tokenContractAddress: asset.tokenContractAddress, uid: safeString(row.uid, 255), walletAddress: safeString(row.wallet_address, 128) });
    }
  }
  if (await trx.schema.hasTable('awards')) {
    const rows = await trx('awards')
      .select(['user_id'])
      .whereRaw('lower(tx_hash) = lower(?)', [hash])
      .limit(ADMIN_REFERENCE_CANDIDATE_LIMIT + 1) as unknown as Array<Record<string, unknown>>;
    if (rows.length > ADMIN_REFERENCE_CANDIDATE_LIMIT) candidateOverflow = true;
    for (const row of rows.slice(0, ADMIN_REFERENCE_CANDIDATE_LIMIT)) {
      let uid: string | null = null;
      let walletAddress: string | null = null;
      if (row.user_id && await trx.schema.hasTable('users')) {
        const user = await trx('users').select(['uid', 'wallet_address']).where({ id: row.user_id }).first() as Record<string, unknown> | undefined;
        uid = safeString(user?.uid, 255);
        walletAddress = safeString(user?.wallet_address, 128);
      }
      candidates.push({ provenance: 'retained_award', operationKey: null, chainId: null, tokenContractAddress: null, uid, walletAddress });
    }
  }
  if (await trx.schema.hasTable('spends')) {
    const rows = await trx('spends')
      .select(['user_id', 'wallet_address'])
      .whereRaw('lower(tx_hash) = lower(?)', [hash])
      .limit(ADMIN_REFERENCE_CANDIDATE_LIMIT + 1) as unknown as Array<Record<string, unknown>>;
    if (rows.length > ADMIN_REFERENCE_CANDIDATE_LIMIT) candidateOverflow = true;
    for (const row of rows.slice(0, ADMIN_REFERENCE_CANDIDATE_LIMIT)) {
      let uid: string | null = null;
      let walletAddress = safeString(row.wallet_address, 128);
      if (row.user_id && await trx.schema.hasTable('users')) {
        const user = await trx('users').select(['uid', 'wallet_address']).where({ id: row.user_id }).first() as Record<string, unknown> | undefined;
        uid = safeString(user?.uid, 255);
        walletAddress = walletAddress || safeString(user?.wallet_address, 128);
      }
      candidates.push({ provenance: 'retained_spend', operationKey: null, chainId: null, tokenContractAddress: null, uid, walletAddress });
    }
  }
  if (!candidates.length) throw new AdminEvidenceError(404, 'ANNOTATION_REFERENCE_NOT_FOUND', 'The original transaction reference was not found in retained evidence');
  if (candidateOverflow) {
    throw new AdminEvidenceError(409, 'ANNOTATION_REFERENCE_AMBIGUOUS', 'The original transaction reference has too many retained matches to resolve safely');
  }
  const selected = [...candidates].sort((left, right) => {
    const rank = (candidate: TransactionReferenceCandidate) => candidate.provenance === 'retained_operation' ? 3 : candidate.provenance === 'retained_award' ? 2 : 1;
    return rank(right) - rank(left);
  });
  const first = selected[0];
  const knownUids = [...new Set(selected.map(candidate => candidate.uid).filter((value): value is string => Boolean(value)))];
  const knownWallets = [...new Set(selected
    .map(candidate => candidate.walletAddress?.toLowerCase())
    .filter((value): value is string => Boolean(value)))];
  if (knownUids.length > 1 || knownWallets.length > 1) {
    throw new AdminEvidenceError(409, 'ANNOTATION_REFERENCE_CONTEXT_MISMATCH', 'The original transaction reference has conflicting retained ownership evidence');
  }
  const knownAssets = [...new Map(selected
    .filter(candidate => candidate.chainId && candidate.tokenContractAddress)
    .map(candidate => [`${candidate.chainId}|${candidate.tokenContractAddress!.toLowerCase()}`, candidate] as const)).values()];
  const assetConflict = knownAssets.length > 1;
  return {
    ...first,
    provenance: assetConflict ? 'conflict_unknown' : first.provenance,
    operationKey: assetConflict ? null : first.operationKey,
    uid: knownUids[0] || null,
    walletAddress: knownWallets[0] || null,
    chainId: assetConflict ? null : knownAssets[0]?.chainId || null,
    tokenContractAddress: assetConflict ? null : knownAssets[0]?.tokenContractAddress || null,
  };
}

function referenceMatchesTarget(target: ResolvedReference, reference: ResolvedReference): void {
  if (target.uid && reference.uid && target.uid !== reference.uid) {
    throw new AdminEvidenceError(409, 'ANNOTATION_REFERENCE_CONTEXT_MISMATCH', 'The original transaction reference does not match the selected evidence account');
  }
  if (target.walletAddress && reference.walletAddress && target.walletAddress.toLowerCase() !== reference.walletAddress.toLowerCase()) {
    throw new AdminEvidenceError(409, 'ANNOTATION_REFERENCE_CONTEXT_MISMATCH', 'The original transaction reference does not match the selected evidence wallet');
  }
  if (target.chainId && reference.chainId && (target.chainId !== reference.chainId || target.tokenContractAddress?.toLowerCase() !== reference.tokenContractAddress?.toLowerCase())) {
    throw new AdminEvidenceError(409, 'ANNOTATION_REFERENCE_CONTEXT_MISMATCH', 'The original transaction reference does not match the selected evidence asset');
  }
}

function sameAnnotationPayload(row: Record<string, unknown>, actorId: string, request: AdminCorrectionAnnotationRequest): boolean {
  return String(row.actor_id) === actorId
    && String(row.client_request_id).toLowerCase() === request.clientRequestId
    && String(row.subject_type) === request.subjectType
    && String(row.subject_id).toLowerCase() === request.subjectId
    && String(row.reference_type) === request.referenceType
    && String(row.reference_value) === request.reference
    && String(row.reason) === request.reason;
}

async function existingAnnotation(trx: Knex.Transaction, actorId: string, clientRequestId: string): Promise<Record<string, unknown> | undefined> {
  return trx(ADMIN_CORRECTION_ANNOTATIONS_TABLE)
    .where({ actor_id: actorId, client_request_id: clientRequestId })
    .first() as Promise<Record<string, unknown> | undefined>;
}

/** Create or replay one append-only annotation; no financial row is updated. */
export async function createAdminCorrectionAnnotation(
  request: AdminCorrectionAnnotationRequest,
  actorId: string,
): Promise<AdminCorrectionAnnotationResponse> {
  const safeActorId = ensureAnnotationText(actorId, 'actorId', 160);
  const db = getDatabase();
  if (!(await db.schema.hasTable(ADMIN_CORRECTION_ANNOTATIONS_TABLE))) {
    throw new AdminEvidenceError(503, 'ANNOTATION_SCHEMA_UNAVAILABLE', 'Correction annotations are temporarily unavailable; migration 025 is required');
  }
  const row = await db.transaction(async trx => {
    await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`admin-correction-annotation:${safeActorId}:${request.clientRequestId}`]);
    const prior = await existingAnnotation(trx, safeActorId, request.clientRequestId);
    if (prior) {
      if (!sameAnnotationPayload(prior, safeActorId, request)) {
        throw new AdminEvidenceError(409, 'ANNOTATION_REQUEST_CONFLICT', 'clientRequestId was already used for a different annotation payload');
      }
      return prior;
    }
    const target = await targetContext(trx, request);
    const resolved = request.referenceType === 'transaction'
      ? await transactionReference(trx, request.reference)
      : { provenance: 'external_case' as const, operationKey: null, chainId: null, tokenContractAddress: null, uid: null, walletAddress: null };
    if (request.referenceType === 'transaction') referenceMatchesTarget(target, resolved);
    const [created] = await trx(ADMIN_CORRECTION_ANNOTATIONS_TABLE).insert({
      client_request_id: request.clientRequestId,
      subject_type: request.subjectType,
      subject_id: request.subjectId,
      reference_type: request.referenceType,
      reference_value: request.reference,
      reason: request.reason,
      actor_type: 'admin_session',
      actor_id: safeActorId,
      reference_provenance: resolved.provenance,
      reference_operation_key: resolved.operationKey,
      reference_chain_id: resolved.chainId,
      reference_token_contract_address: resolved.tokenContractAddress,
    }).returning('*') as Array<Record<string, unknown>>;
    return created;
  });
  return { status: 'ok', sideEffects: { financial: false }, annotation: annotationFromRow(row) };
}

export async function listAdminCorrectionAnnotations(input: {
  subjectType: AdminCorrectionAnnotationSubjectType;
  subjectId: string;
  limit: number;
  offset: number;
}): Promise<AdminCorrectionAnnotationListResponse> {
  const db = getDatabase();
  if (!(await db.schema.hasTable(ADMIN_CORRECTION_ANNOTATIONS_TABLE))) {
    throw new AdminEvidenceError(503, 'ANNOTATION_SCHEMA_UNAVAILABLE', 'Correction annotations are temporarily unavailable; migration 025 is required');
  }
  const subjectTable = tableForSubject(input.subjectType);
  if (!(await db.schema.hasTable(subjectTable))) {
    throw new AdminEvidenceError(503, 'ANNOTATION_SUBJECT_SCHEMA_UNAVAILABLE', 'The selected evidence subject is temporarily unavailable');
  }
  const subject = await db(subjectTable).select('id').where({ id: input.subjectId }).first();
  if (!subject) {
    throw new AdminEvidenceError(404, 'ANNOTATION_SUBJECT_NOT_FOUND', 'The selected evidence subject was not found');
  }
  const rows = await db(ADMIN_CORRECTION_ANNOTATIONS_TABLE)
    .where({ subject_type: input.subjectType, subject_id: input.subjectId })
    .orderBy('created_at', 'desc').orderBy('id', 'desc')
    .limit(input.limit + 1).offset(input.offset) as unknown as Array<Record<string, unknown>>;
  const hasMore = rows.length > input.limit;
  const annotations = rows.slice(0, input.limit).map(annotationFromRow);
  return {
    status: 'ok',
    count: annotations.length,
    limit: input.limit,
    offset: input.offset,
    hasMore,
    nextOffset: hasMore ? input.offset + input.limit : null,
    annotations,
  };
}

export function parseAnnotationListQuery(query: unknown): { subjectType: AdminCorrectionAnnotationSubjectType; subjectId: string; limit: number; offset: number } {
  const rawType = queryString(query, 'subjectType');
  if (rawType !== 'token_operation' && rawType !== 'award' && rawType !== 'spend') {
    throw new AdminEvidenceError(400, 'INVALID_ANNOTATION_QUERY', 'subjectType must be token_operation, award, or spend');
  }
  const rawId = queryString(query, 'subjectId');
  const subjectId = ensureUuid(rawId, 'subjectId');
  return {
    subjectType: rawType as AdminCorrectionAnnotationSubjectType,
    subjectId,
    limit: parseBoundedInteger(queryString(query, 'limit'), 'limit', ADMIN_ANNOTATION_DEFAULT_LIMIT, 1, ADMIN_ANNOTATION_MAX_LIMIT),
    offset: parseBoundedInteger(queryString(query, 'offset'), 'offset', 0, 0, ADMIN_ANNOTATION_MAX_OFFSET),
  };
}
