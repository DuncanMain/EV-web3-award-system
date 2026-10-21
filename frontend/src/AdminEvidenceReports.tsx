import { FormEvent, useEffect, useRef, useState } from 'react';
import type {
  AdminCorrectionAnnotation,
  AdminEvidenceRow,
} from '../../src/adminEvidence.types';

type EvidenceSubjectType = 'token_operation' | 'award' | 'spend';
type EvidenceFormat = 'json' | 'csv';
type EvidenceScope = 'unresolved' | 'all';
type ReferenceType = 'transaction' | 'case';
type EvidenceFilterSnapshot = Readonly<{
  from: string;
  to: string;
  scope: EvidenceScope;
  emaid: string;
  operationType: string;
  status: string;
  limit: number;
}>;

type JsonRecord = Record<string, unknown>;

type EvidenceRow = AdminEvidenceRow & JsonRecord;

type Annotation = AdminCorrectionAnnotation & JsonRecord;

type EvidenceReport = {
  period: JsonRecord | null;
  currentPolicy: JsonRecord | null;
  summary: JsonRecord;
  totalsByAsset: unknown[];
  coverage: JsonRecord;
  storedReconciliation: JsonRecord | null;
  rows: EvidenceRow[];
};

type EvidenceResponse = EvidenceReport & {
  total?: number;
  hasMore?: boolean;
  nextOffset?: number | null;
  limit?: number;
  offset?: number;
};

type AnnotationResponse = {
  annotations: Annotation[];
  total?: number;
  hasMore?: boolean;
  nextOffset?: number | null;
};

type Props = {
  baseUrl: string;
  adminToken: string;
};

const REPORT_LIMIT = 50;
const ANNOTATION_LIMIT = 25;

function asRecord(value: unknown): JsonRecord | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as JsonRecord
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function scalar(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return null;
}

function valueAt(record: JsonRecord | null | undefined, ...keys: string[]): unknown {
  if (!record) return undefined;
  for (const key of keys) {
    if (record[key] !== undefined && record[key] !== null) return record[key];
  }
  return undefined;
}

function textAt(record: JsonRecord | null | undefined, ...keys: string[]): string | null {
  return scalar(valueAt(record, ...keys));
}

function displayText(value: unknown, fallback = 'Not recorded'): string {
  return scalar(value) || fallback;
}

function humanize(value: unknown): string {
  const text = scalar(value);
  if (!text) return 'Not recorded';
  return text
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/\b\w/g, character => character.toUpperCase());
}

function formatDate(value: unknown): string {
  const text = scalar(value);
  if (!text) return 'Not recorded';
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? text : date.toLocaleString();
}

function compactId(value: unknown): string {
  const text = scalar(value);
  if (!text) return 'Not recorded';
  return text.length > 20 ? `${text.slice(0, 8)}…${text.slice(-6)}` : text;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function localDateTime(value: Date): string {
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function toIso(value: string): string | null {
  if (!value.trim()) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function makeClientRequestId(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function subjectType(value: unknown): EvidenceSubjectType {
  return value === 'award' || value === 'spend' || value === 'token_operation'
    ? value
    : 'token_operation';
}

function normaliseRow(value: unknown): EvidenceRow | null {
  const record = asRecord(value);
  const id = textAt(record, 'subjectId', 'id');
  if (!record || !id) return null;
  return { ...record, subjectType: subjectType(valueAt(record, 'subjectType')), subjectId: id } as EvidenceRow;
}

function normaliseAnnotation(value: unknown, index: number): Annotation | null {
  const record = asRecord(value);
  if (!record) return null;
  const id = textAt(record, 'id', 'annotationId') || `annotation-${index}`;
  const reference = textAt(record, 'reference');
  const reason = textAt(record, 'reason');
  if (!reference || !reason) return null;
  return {
    ...record,
    id,
    referenceType: (textAt(record, 'referenceType') || 'transaction') as ReferenceType,
    reference,
    reason,
  } as Annotation;
}

function normaliseReport(payload: unknown): EvidenceResponse {
  const record = asRecord(payload) || {};
  const rows = asArray(valueAt(record, 'rows', 'items'))
    .map(normaliseRow)
    .filter((row): row is EvidenceRow => Boolean(row));
  const summary = asRecord(valueAt(record, 'summary')) || {};
  const pagination = asRecord(valueAt(record, 'pagination')) || {};
  return {
    period: asRecord(valueAt(record, 'period')),
    currentPolicy: asRecord(valueAt(record, 'policy', 'currentPolicy', 'current_policy')),
    summary,
    totalsByAsset: asArray(valueAt(summary, 'totalsByAsset', 'totals_by_asset'))
      .concat(asArray(valueAt(record, 'totalsByAsset', 'totals_by_asset'))),
    coverage: asRecord(valueAt(record, 'coverage')) || {},
    storedReconciliation: asRecord(valueAt(record, 'reconciliation', 'storedReconciliation', 'stored_reconciliation')),
    rows,
    total: typeof record.total === 'number' ? record.total : undefined,
    hasMore: typeof pagination.hasMore === 'boolean'
      ? pagination.hasMore
      : typeof record.hasMore === 'boolean' ? record.hasMore : undefined,
    nextOffset: typeof pagination.nextOffset === 'number'
      ? pagination.nextOffset
      : typeof record.nextOffset === 'number' ? record.nextOffset : null,
    limit: typeof pagination.limit === 'number'
      ? pagination.limit
      : typeof record.limit === 'number' ? record.limit : undefined,
    offset: typeof pagination.offset === 'number'
      ? pagination.offset
      : typeof record.offset === 'number' ? record.offset : undefined,
  };
}

function normaliseAnnotations(payload: unknown): AnnotationResponse {
  if (Array.isArray(payload)) {
    return { annotations: payload.map(normaliseAnnotation).filter((item): item is Annotation => Boolean(item)) };
  }
  const record = asRecord(payload) || {};
  const raw = asArray(valueAt(record, 'annotations', 'items'));
  return {
    annotations: raw.map(normaliseAnnotation).filter((item): item is Annotation => Boolean(item)),
    total: typeof record.total === 'number' ? record.total : undefined,
    hasMore: typeof record.hasMore === 'boolean' ? record.hasMore : undefined,
    nextOffset: typeof record.nextOffset === 'number' ? record.nextOffset : null,
  };
}

function payloadMessage(payload: unknown, fallback: string): string {
  const record = asRecord(payload);
  return textAt(record, 'message', 'error', 'code') || fallback;
}

async function readResponse(response: Response): Promise<unknown> {
  const body = await response.text();
  if (!body) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function reportEntries(record: JsonRecord | null | undefined): Array<[string, string]> {
  if (!record) return [];
  return Object.entries(record)
    .map(([key, value]) => [humanize(key), /(?:At|_at)$/.test(key) ? formatDate(value) : scalar(value)] as [string, string | null])
    .filter((entry): entry is [string, string] => Boolean(entry[1]));
}

function warningValues(record: JsonRecord | null | undefined): string[] {
  if (!record) return [];
  const values: string[] = [];
  for (const key of ['warnings', 'coverageWarnings', 'missingData', 'exclusions']) {
    const value = valueAt(record, key);
    if (Array.isArray(value)) {
      value.forEach(item => {
        const text = scalar(item);
        if (text) values.push(text);
      });
    } else {
      const text = scalar(value);
      if (text) values.push(`${humanize(key)}: ${text}`);
    }
  }
  return Array.from(new Set(values));
}

function assetLabel(value: unknown): string {
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  const asset = asRecord(value);
  if (!asset) return 'Not recorded';
  const chain = textAt(asset, 'chainId', 'chain') || '';
  const token = textAt(asset, 'tokenContractAddress', 'tokenContract', 'contract') || '';
  const symbol = textAt(asset, 'symbol', 'asset') || '';
  return [symbol, chain, token].filter(Boolean).join(' · ') || 'Not recorded';
}

function rowAmount(row: EvidenceRow): string {
  const amount = textAt(row, 'amount', 'amountSparkz', 'movementAmount', 'issuedAmount');
  return amount ? `${amount} SPARKZ` : 'Not recorded';
}

function rowTimestampEntries(row: EvidenceRow): Array<[string, unknown]> {
  const timestamps = asRecord(valueAt(row, 'timestamps')) || {};
  const candidates: Array<[string, unknown]> = [
    ['Created', valueAt(timestamps, 'createdAt', 'created_at') ?? valueAt(row, 'createdAt', 'created_at')],
    ['Claimed', valueAt(timestamps, 'claimedAt', 'claimed_at') ?? valueAt(row, 'claimedAt', 'claimed_at')],
    ['Submitted', valueAt(timestamps, 'submittedAt', 'submitted_at') ?? valueAt(row, 'submittedAt', 'submitted_at')],
    ['Confirmed', valueAt(timestamps, 'confirmedAt', 'confirmed_at') ?? valueAt(row, 'confirmedAt', 'confirmed_at')],
    ['Projected', valueAt(timestamps, 'projectedAt', 'projected_at') ?? valueAt(row, 'projectedAt', 'projected_at')],
  ];
  return candidates.filter(([, value]) => Boolean(scalar(value)));
}

function ReportMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="admin-evidence-metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function EvidenceTable({
  rows,
  selected,
  onSelect,
  selectionDisabled,
}: {
  rows: EvidenceRow[];
  selected: EvidenceRow | null;
  onSelect: (row: EvidenceRow) => void;
  selectionDisabled: boolean;
}) {
  if (!rows.length) return <p className="subtle">No retained evidence matches these filters.</p>;
  return (
    <div className="admin-evidence-table-wrap">
      <table className="admin-evidence-table">
        <caption className="sr-only">Retained evidence report rows</caption>
        <thead>
          <tr>
            <th scope="col">Record</th>
            <th scope="col">Owner</th>
            <th scope="col">Amount</th>
            <th scope="col">State</th>
            <th scope="col">Asset / movement</th>
            <th scope="col">Recorded at</th>
            <th scope="col">Annotations</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(row => {
            const isSelected = selected?.subjectId === row.subjectId && selected?.subjectType === row.subjectType;
            const operationType = textAt(row, 'operationType', 'operation_type') || row.subjectType;
            const movement = textAt(row, 'movementOutcome', 'movement', 'movementStatus');
            const hash = textAt(row, 'transactionHash', 'hash', 'txHash');
            const wallet = textAt(row, 'wallet', 'walletAddress', 'maskedWallet');
            const emaid = textAt(row, 'emaid', 'eMAID', 'maskedEmaid', 'maskedEmaid');
            const historicalPolicy = asRecord(valueAt(row, 'historicalPolicy', 'storedPolicyProvenance'));
            const policySource = textAt(historicalPolicy, 'source', 'provenance') || 'unknown';
            const policyRevision = textAt(historicalPolicy, 'revision');
            const exceptionCategory = textAt(row, 'exceptionCategory', 'exception_category');
            const annotationCount = textAt(row, 'annotationCount', 'annotation_count');
            return (
              <tr key={`${row.subjectType}-${row.subjectId}`} className={isSelected ? 'admin-evidence-row--selected' : undefined}>
                <th scope="row">
                  <strong>{humanize(operationType)}</strong>
                  <span className="admin-evidence-secondary">{compactId(row.subjectId)}</span>
                  {textAt(row, 'operationKey') && <span className="admin-evidence-secondary">Key {compactId(textAt(row, 'operationKey'))}</span>}
                </th>
                <td>
                  <span>{displayText(emaid)}</span>
                  <span className="admin-evidence-secondary">Wallet {displayText(wallet)}</span>
                </td>
                <td>{rowAmount(row)}</td>
                <td>
                  <span className="admin-status-pill">{humanize(textAt(row, 'status'))}</span>
                  <span className="admin-evidence-secondary">Movement {humanize(movement)}</span>
                  <span className="admin-evidence-secondary">Stored policy: {humanize(policySource)}{policyRevision ? ` · revision ${policyRevision}` : ''}</span>
                  {exceptionCategory && <span className="admin-evidence-secondary">Exception: {humanize(exceptionCategory)}</span>}
                </td>
                <td>
                  <span>{assetLabel(valueAt(row, 'asset'))}</span>
                  <span className="admin-evidence-secondary">Hash {compactId(hash)}</span>
                </td>
                <td>
                  {rowTimestampEntries(row).slice(0, 2).map(([label, value]) => (
                    <span className="admin-evidence-secondary" key={label}>{label}: {formatDate(value)}</span>
                  ))}
                  {!rowTimestampEntries(row).length && <span className="admin-evidence-secondary">Not recorded</span>}
                </td>
                <td>
                  <span className="admin-evidence-secondary">{annotationCount || '0'} saved</span>
                  <button type="button" className="btn-ghost admin-evidence-select" onClick={() => onSelect(row)} aria-pressed={isSelected} disabled={selectionDisabled}>
                    {isSelected ? 'Selected' : 'Review'}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function AdminEvidenceReports({ baseUrl, adminToken }: Props) {
  const now = new Date();
  const [from, setFrom] = useState(localDateTime(new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)));
  const [to, setTo] = useState(localDateTime(now));
  const [scope, setScope] = useState<EvidenceScope>('all');
  const [emaid, setEmaid] = useState('');
  const [operationType, setOperationType] = useState('');
  const [status, setStatus] = useState('');
  const [limit, setLimit] = useState(REPORT_LIMIT);
  const [report, setReport] = useState<EvidenceResponse | null>(null);
  const [appliedFilters, setAppliedFilters] = useState<EvidenceFilterSnapshot | null>(null);
  const [reportOffset, setReportOffset] = useState(0);
  const [reportTotal, setReportTotal] = useState<number | null>(null);
  const [reportHasMore, setReportHasMore] = useState(false);
  const [reportNextOffset, setReportNextOffset] = useState<number | null>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [reportError, setReportError] = useState('');
  const [download, setDownload] = useState<EvidenceFormat | null>(null);
  const [downloadError, setDownloadError] = useState('');
  const [selectedRow, setSelectedRow] = useState<EvidenceRow | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [annotationOffset, setAnnotationOffset] = useState(0);
  const [annotationHasMore, setAnnotationHasMore] = useState(false);
  const [annotationNextOffset, setAnnotationNextOffset] = useState<number | null>(null);
  const [annotationTotal, setAnnotationTotal] = useState<number | null>(null);
  const [annotationLoading, setAnnotationLoading] = useState(false);
  const [annotationError, setAnnotationError] = useState('');
  const [annotationSaving, setAnnotationSaving] = useState(false);
  const [annotationFeedback, setAnnotationFeedback] = useState('');
  const [referenceType, setReferenceType] = useState<ReferenceType>('transaction');
  const [reference, setReference] = useState('');
  const [reason, setReason] = useState('');
  const [clientRequestId, setClientRequestId] = useState(makeClientRequestId);
  const reportRequestRef = useRef(0);
  const reportAbortRef = useRef<AbortController | null>(null);
  const annotationRequestRef = useRef(0);
  const annotationAbortRef = useRef<AbortController | null>(null);
  const annotationInFlightRef = useRef(false);
  const selectedSubjectGenerationRef = useRef(0);
  const selectedSubjectRef = useRef<{ subjectType: EvidenceSubjectType; subjectId: string } | null>(null);
  const sessionKeyRef = useRef('');
  const mountedRef = useRef(false);
  const sessionKey = `${baseUrl}\u0000${adminToken}`;
  sessionKeyRef.current = sessionKey;
  const localTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'local time';

  function validatePeriod(fromValue: string, toValue: string): string | null {
    const fromIso = toIso(fromValue);
    const toIsoValue = toIso(toValue);
    if (!fromIso || !toIsoValue) return 'Choose valid report dates using your local timezone.';
    if (new Date(fromIso).getTime() >= new Date(toIsoValue).getTime()) return 'The report start must be before the report end.';
    return null;
  }

  function draftFilterSnapshot(): { filters: EvidenceFilterSnapshot | null; error: string | null } {
    const validationError = validatePeriod(from, to);
    if (validationError) return { filters: null, error: validationError };
    return {
      filters: Object.freeze({
        from: toIso(from) as string,
        to: toIso(to) as string,
        scope,
        emaid: emaid.trim(),
        operationType,
        status: status.trim(),
        limit: Math.min(100, Math.max(1, limit)),
      }),
      error: null,
    };
  }

  function requestQuery(filters: EvidenceFilterSnapshot, format: EvidenceFormat, offset: number): string {
    const params = new URLSearchParams({
      from: filters.from,
      to: filters.to,
      limit: String(filters.limit),
      offset: String(Math.max(0, offset)),
      scope: filters.scope,
      format,
    });
    if (filters.emaid) params.set('emaid', filters.emaid);
    if (filters.operationType) params.set('operationType', filters.operationType);
    if (filters.status) params.set('status', filters.status);
    return params.toString();
  }

  function isCurrentSession(requestSessionKey: string): boolean {
    return mountedRef.current && sessionKeyRef.current === requestSessionKey;
  }

  function isCurrentAnnotationContext(
    requestSessionKey: string,
    generation: number,
    row: EvidenceRow,
  ): boolean {
    const selected = selectedSubjectRef.current;
    return isCurrentSession(requestSessionKey)
      && selectedSubjectGenerationRef.current === generation
      && selected?.subjectType === row.subjectType
      && selected.subjectId === row.subjectId;
  }

  async function loadReport(
    filters: EvidenceFilterSnapshot,
    offset = 0,
    requestSessionKey = sessionKeyRef.current,
  ) {
    if (!isCurrentSession(requestSessionKey)) return;
    reportAbortRef.current?.abort();
    const controller = new AbortController();
    reportAbortRef.current = controller;
    const requestId = reportRequestRef.current + 1;
    reportRequestRef.current = requestId;
    setReportLoading(true);
    setReportError('');
    try {
      const response = await fetch(`${baseUrl}/admin/evidence-report?${requestQuery(filters, 'json', offset)}`, {
        headers: { Authorization: `Bearer ${adminToken}`, Accept: 'application/json' },
        signal: controller.signal,
      });
      const payload = await readResponse(response);
      if (!response.ok) throw new Error(payloadMessage(payload, 'The evidence report could not be loaded.'));
      const nextReport = normaliseReport(payload);
      if (requestId !== reportRequestRef.current || !isCurrentSession(requestSessionKey)) return;
      setReport(nextReport);
      setAppliedFilters(filters);
      setReportOffset(offset);
      setReportTotal(nextReport.total ?? null);
      setReportHasMore(nextReport.hasMore ?? nextReport.rows.length >= filters.limit);
      setReportNextOffset(nextReport.nextOffset ?? (nextReport.hasMore ? offset + nextReport.rows.length : null));
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (requestId === reportRequestRef.current && isCurrentSession(requestSessionKey)) {
        setReport(null);
        setAppliedFilters(null);
        setReportTotal(null);
        setReportHasMore(false);
        setReportNextOffset(null);
        setReportError(error instanceof Error ? error.message : 'The evidence report could not be loaded.');
      }
    } finally {
      if (requestId === reportRequestRef.current && isCurrentSession(requestSessionKey)) setReportLoading(false);
    }
  }

  function runDraftReport() {
    const { filters, error } = draftFilterSnapshot();
    if (!filters) {
      setReportError(error || 'Choose valid report dates using your local timezone.');
      return;
    }
    void loadReport(filters, 0, sessionKeyRef.current);
  }

  async function downloadReport(format: EvidenceFormat) {
    const filters = appliedFilters;
    if (!report || !filters) {
      setDownloadError('Run a report successfully before downloading an export.');
      return;
    }
    const requestSessionKey = sessionKeyRef.current;
    if (!isCurrentSession(requestSessionKey)) return;
    setDownload(format);
    setDownloadError('');
    try {
      const response = await fetch(`${baseUrl}/admin/evidence-report?${requestQuery(filters, format, reportOffset)}`, {
        headers: { Authorization: `Bearer ${adminToken}`, Accept: format === 'csv' ? 'text/csv' : 'application/json' },
      });
      if (!response.ok) {
        const payload = await readResponse(response);
        throw new Error(payloadMessage(payload, `The ${format.toUpperCase()} export could not be downloaded.`));
      }
      if (!isCurrentSession(requestSessionKey)) return;
      const blob = await response.blob();
      if (!isCurrentSession(requestSessionKey)) return;
      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = objectUrl;
      link.download = `neverflat-evidence-report-${new Date().toISOString().replace(/[:.]/g, '-')}.${format}`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (error) {
      if (isCurrentSession(requestSessionKey)) {
        setDownloadError(error instanceof Error ? error.message : `The ${format.toUpperCase()} export could not be downloaded.`);
      }
    } finally {
      if (isCurrentSession(requestSessionKey)) setDownload(null);
    }
  }

  async function loadAnnotations(
    row: EvidenceRow,
    offset = 0,
    append = false,
    generation = selectedSubjectGenerationRef.current,
    requestSessionKey = sessionKeyRef.current,
  ) {
    if (!isCurrentAnnotationContext(requestSessionKey, generation, row)) return;
    annotationAbortRef.current?.abort();
    const controller = new AbortController();
    annotationAbortRef.current = controller;
    const requestId = annotationRequestRef.current + 1;
    annotationRequestRef.current = requestId;
    setAnnotationLoading(true);
    setAnnotationError('');
    try {
      const params = new URLSearchParams({
        subjectType: row.subjectType,
        subjectId: row.subjectId,
        limit: String(ANNOTATION_LIMIT),
        offset: String(offset),
      });
      const response = await fetch(`${baseUrl}/admin/correction-annotations?${params.toString()}`, {
        headers: { Authorization: `Bearer ${adminToken}`, Accept: 'application/json' },
        signal: controller.signal,
      });
      const payload = await readResponse(response);
      if (!response.ok) throw new Error(payloadMessage(payload, 'Annotations could not be loaded.'));
      const next = normaliseAnnotations(payload);
      if (requestId !== annotationRequestRef.current || !isCurrentAnnotationContext(requestSessionKey, generation, row)) return;
      setAnnotations(current => append ? [...current, ...next.annotations] : next.annotations);
      setAnnotationOffset(offset);
      setAnnotationTotal(next.total ?? next.annotations.length);
      setAnnotationHasMore(next.hasMore ?? next.annotations.length >= ANNOTATION_LIMIT);
      setAnnotationNextOffset(next.nextOffset ?? (next.hasMore ? offset + next.annotations.length : null));
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      if (requestId === annotationRequestRef.current && isCurrentAnnotationContext(requestSessionKey, generation, row)) {
        setAnnotations([]);
        setAnnotationTotal(null);
        setAnnotationHasMore(false);
        setAnnotationNextOffset(null);
        setAnnotationError(error instanceof Error ? error.message : 'Annotations could not be loaded.');
      }
    } finally {
      if (requestId === annotationRequestRef.current && isCurrentAnnotationContext(requestSessionKey, generation, row)) setAnnotationLoading(false);
    }
  }

  function selectRow(row: EvidenceRow) {
    if (annotationSaving || annotationInFlightRef.current) return;
    annotationAbortRef.current?.abort();
    annotationRequestRef.current += 1;
    const generation = selectedSubjectGenerationRef.current + 1;
    selectedSubjectGenerationRef.current = generation;
    selectedSubjectRef.current = { subjectType: row.subjectType, subjectId: row.subjectId };
    setSelectedRow(row);
    setAnnotations([]);
    setAnnotationOffset(0);
    setAnnotationTotal(null);
    setAnnotationHasMore(false);
    setAnnotationNextOffset(null);
    setAnnotationError('');
    setAnnotationFeedback('');
    setReference('');
    setReason('');
    setReferenceType('transaction');
    setClientRequestId(makeClientRequestId());
    void loadAnnotations(row, 0, false, generation, sessionKeyRef.current);
  }

  function closeAnnotationPanel() {
    if (annotationSaving || annotationInFlightRef.current) return;
    annotationAbortRef.current?.abort();
    annotationRequestRef.current += 1;
    selectedSubjectGenerationRef.current += 1;
    selectedSubjectRef.current = null;
    setSelectedRow(null);
    setAnnotations([]);
    setAnnotationLoading(false);
    setAnnotationError('');
    setAnnotationFeedback('');
  }

  function updateDraft(setter: (value: string) => void, value: string) {
    setter(value);
    setClientRequestId(makeClientRequestId());
    setAnnotationFeedback('');
  }

  async function saveAnnotation(event: FormEvent) {
    event.preventDefault();
    if (!selectedRow || annotationInFlightRef.current) return;
    const rowAtStart = selectedRow;
    const generation = selectedSubjectGenerationRef.current;
    const requestSessionKey = sessionKeyRef.current;
    const requestClientId = clientRequestId;
    if (!isCurrentAnnotationContext(requestSessionKey, generation, rowAtStart)) return;
    const nextReference = reference.trim();
    const nextReason = reason.trim();
    if (!nextReference || !nextReason) {
      setAnnotationFeedback('Enter both the original transaction/case reference and the correction reason.');
      return;
    }
    annotationInFlightRef.current = true;
    setAnnotationSaving(true);
    setAnnotationFeedback('');
    try {
      const response = await fetch(`${baseUrl}/admin/correction-annotations`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          subjectType: rowAtStart.subjectType,
          subjectId: rowAtStart.subjectId,
          referenceType,
          reference: nextReference,
          reason: nextReason,
          clientRequestId: requestClientId,
        }),
      });
      const payload = await readResponse(response);
      if (!response.ok) {
        if (response.status === 409 && isCurrentAnnotationContext(requestSessionKey, generation, rowAtStart)) setClientRequestId(makeClientRequestId());
        throw new Error(payloadMessage(payload, response.status === 409
          ? 'This annotation request conflicted with an earlier request. Review the draft and retry.'
          : 'The correction annotation could not be saved.'));
      }
      if (!isCurrentAnnotationContext(requestSessionKey, generation, rowAtStart)) return;
      setAnnotationFeedback('Correction annotation saved with the server-assigned operator and timestamp.');
      setReference('');
      setReason('');
      setClientRequestId(makeClientRequestId());
      await loadAnnotations(rowAtStart, 0, false, generation, requestSessionKey);
      if (!isCurrentAnnotationContext(requestSessionKey, generation, rowAtStart)) return;
      if (appliedFilters) await loadReport(appliedFilters, reportOffset, requestSessionKey);
    } catch (error) {
      if (isCurrentAnnotationContext(requestSessionKey, generation, rowAtStart)) {
        setAnnotationFeedback(error instanceof Error ? error.message : 'The correction annotation could not be saved.');
      }
    } finally {
      annotationInFlightRef.current = false;
      if (isCurrentAnnotationContext(requestSessionKey, generation, rowAtStart)) setAnnotationSaving(false);
    }
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      reportAbortRef.current?.abort();
      annotationAbortRef.current?.abort();
      reportRequestRef.current += 1;
      annotationRequestRef.current += 1;
      selectedSubjectGenerationRef.current += 1;
      selectedSubjectRef.current = null;
    };
  }, []);

  useEffect(() => {
    const requestSessionKey = sessionKey;
    sessionKeyRef.current = requestSessionKey;
    reportAbortRef.current?.abort();
    annotationAbortRef.current?.abort();
    reportRequestRef.current += 1;
    annotationRequestRef.current += 1;
    selectedSubjectGenerationRef.current += 1;
    selectedSubjectRef.current = null;
    annotationInFlightRef.current = false;
    setReport(null);
    setAppliedFilters(null);
    setReportOffset(0);
    setReportTotal(null);
    setReportHasMore(false);
    setReportNextOffset(null);
    setReportError('');
    setDownload(null);
    setDownloadError('');
    setSelectedRow(null);
    setAnnotations([]);
    setAnnotationOffset(0);
    setAnnotationTotal(null);
    setAnnotationHasMore(false);
    setAnnotationNextOffset(null);
    setAnnotationLoading(false);
    setAnnotationError('');
    setAnnotationSaving(false);
    setAnnotationFeedback('');
    setReference('');
    setReason('');
    setReferenceType('transaction');
    setClientRequestId(makeClientRequestId());
    const { filters, error } = draftFilterSnapshot();
    if (filters) {
      void loadReport(filters, 0, requestSessionKey);
    } else {
      setReportLoading(false);
      setReportError(error || 'Choose valid report dates using your local timezone.');
    }
    return () => {
      reportAbortRef.current?.abort();
      annotationAbortRef.current?.abort();
      reportRequestRef.current += 1;
      annotationRequestRef.current += 1;
      selectedSubjectGenerationRef.current += 1;
      selectedSubjectRef.current = null;
    };
    // The authenticated base URL/token identify the report session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, adminToken]);

  const summaryCounts = asRecord(valueAt(report?.summary, 'counts')) || report?.summary || {};
  const summaryMetrics = reportEntries(summaryCounts).filter(([label]) => label !== 'Basis');
  const coverageWarnings = Array.from(new Set([
    ...warningValues(report?.coverage),
    ...warningValues(report?.storedReconciliation),
  ]));
  const coverageSources = reportEntries(asRecord(valueAt(report?.coverage, 'sourceCounts')));
  const coverageMetrics = reportEntries(report?.coverage).filter(([label]) => label !== 'Warnings');
  const policyEntries = reportEntries(report?.currentPolicy);
  const reconciliationEntries = reportEntries(report?.storedReconciliation);
  const reconciliationDiscrepancies = asArray(valueAt(report?.storedReconciliation, 'discrepancies'))
    .map(asRecord)
    .filter((item): item is JsonRecord => Boolean(item));

  return (
    <section className="action-card admin-evidence-card" aria-labelledby="admin-evidence-title">
      <div className="admin-rule-header admin-evidence-heading">
        <div>
          <h3 id="admin-evidence-title">Evidence reports</h3>
          <p className="subtle">Inspect bounded retained operation evidence and add append-only correction notes.</p>
        </div>
        <div className="admin-evidence-actions">
          <button type="button" className="btn-ghost" onClick={runDraftReport} disabled={reportLoading}>
            {reportLoading ? 'Loading…' : 'Refresh report'}
          </button>
          <button type="button" className="btn-ghost" onClick={() => { void downloadReport('json'); }} disabled={!report || !appliedFilters || download !== null}>
            {download === 'json' ? 'Preparing…' : 'Download JSON'}
          </button>
          <button type="button" className="btn-ghost" onClick={() => { void downloadReport('csv'); }} disabled={!report || !appliedFilters || download !== null}>
            {download === 'csv' ? 'Preparing…' : 'Download CSV'}
          </button>
        </div>
      </div>

      <form className="admin-evidence-filter-grid" onSubmit={event => { event.preventDefault(); runDraftReport(); }}>
        <label>From ({localTimeZone} local)<input type="datetime-local" value={from} onChange={event => setFrom(event.target.value)} /></label>
        <label>To ({localTimeZone} local)<input type="datetime-local" value={to} onChange={event => setTo(event.target.value)} /></label>
        <label>Scope<select value={scope} onChange={event => setScope(event.target.value as EvidenceScope)}><option value="unresolved">Needs attention</option><option value="all">All retained evidence</option></select></label>
        <label>eMAID (optional)<input value={emaid} onChange={event => setEmaid(event.target.value)} placeholder="Canonical eMAID filter" autoComplete="off" /></label>
        <label>Operation<select value={operationType} onChange={event => setOperationType(event.target.value)}><option value="">All operations</option><option value="award">Award</option><option value="spend">Spend</option></select></label>
        <label>Status<select value={status} onChange={event => setStatus(event.target.value)}><option value="">Any status</option><option value="submitting">Submitting</option><option value="submitted">Submitted</option><option value="confirmed">Confirmed</option><option value="projected">Projected</option><option value="unknown">Unknown</option><option value="failed">Failed</option></select></label>
        <label>Rows per page<select value={limit} onChange={event => setLimit(Math.min(100, Math.max(1, Number(event.target.value))))}><option value={25}>25</option><option value={50}>50</option><option value={100}>100</option></select></label>
        <button type="submit" disabled={reportLoading}>Run report</button>
      </form>

      {reportError && <p className="admin-error" role="alert">{reportError}</p>}
      {downloadError && <p className="admin-error" role="alert">{downloadError}</p>}
      {reportLoading && !report && <p className="subtle">Loading retained evidence…</p>}

      {report && (
        <>
          <div className="admin-evidence-context" role="status">
            <span>Window: {formatDate(valueAt(report.period, 'from'))} → {formatDate(valueAt(report.period, 'to'))}</span>
            <span>Rows returned: {report.rows.length.toLocaleString()}{reportTotal !== null && reportTotal !== report.rows.length ? ` · ${reportTotal.toLocaleString()} total` : ''}</span>
            <span>Observation: {formatDate(valueAt(report.period, 'observationAt', 'observation_at'))}</span>
          </div>

          {!!summaryMetrics.length && (
            <div className="admin-evidence-metrics" aria-label="Evidence report summary">
              {summaryMetrics.slice(0, 8).map(([label, value]) => <ReportMetric key={label} label={label} value={value} />)}
            </div>
          )}
          <p className="subtle admin-evidence-basis">Basis: {displayText(valueAt(report.summary, 'basis'), 'selected retained data in requested window')}.</p>

          <div className="admin-evidence-support-grid">
            <div className="admin-evidence-subpanel">
              <strong>Current policy observation</strong>
              {policyEntries.length ? <dl className="admin-evidence-details">{policyEntries.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl> : <p className="subtle">Current policy provenance is unavailable.</p>}
            </div>
            <div className="admin-evidence-subpanel">
              <strong>Stored reconciliation</strong>
              {reconciliationEntries.length ? <dl className="admin-evidence-details">{reconciliationEntries.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl> : <p className="subtle">No stored reconciliation evidence is available for this report.</p>}
              {!!reconciliationDiscrepancies.length && <div className="admin-evidence-table-wrap"><table className="admin-evidence-table admin-evidence-reconciliation-table"><caption className="sr-only">Stored reconciliation discrepancies</caption><thead><tr><th scope="col">Wallet</th><th scope="col">eMAID</th><th scope="col">Status</th><th scope="col">Difference</th></tr></thead><tbody>{reconciliationDiscrepancies.slice(0, 100).map((item, index) => <tr key={`reconciliation-${index}`}><th scope="row">{compactId(valueAt(item, 'walletAddress'))}</th><td>{compactId(valueAt(item, 'eMAID', 'emaid'))}</td><td>{humanize(valueAt(item, 'status'))}</td><td>{displayText(valueAt(item, 'differenceSparkz', 'difference'))} SPARKZ</td></tr>)}</tbody></table></div>}
            </div>
          </div>

          <div className="admin-evidence-support-grid">
            <div className="admin-evidence-subpanel">
              <strong>Coverage sources</strong>
              {coverageSources.length ? <dl className="admin-evidence-details">{coverageSources.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl> : <p className="subtle">Source counts are unavailable.</p>}
            </div>
            <div className="admin-evidence-subpanel">
              <strong>Coverage and bounds</strong>
              {coverageMetrics.length ? <dl className="admin-evidence-details">{coverageMetrics.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl> : <p className="subtle">Coverage details are unavailable.</p>}
            </div>
          </div>

          {report.totalsByAsset.length > 0 && (
            <div className="admin-evidence-subpanel">
              <div className="admin-rule-header"><strong>Selected retained movement totals by asset</strong><span className="admin-status-pill">Windowed flow</span></div>
              <p className="subtle">These totals describe the bounded report cohort. They are not an outstanding balance or liability.</p>
              <div className="admin-evidence-table-wrap">
                <table className="admin-evidence-table admin-evidence-asset-table">
                  <caption className="sr-only">Evidence movement totals by asset</caption>
                  <thead><tr><th scope="col">Asset</th><th scope="col">Awarded</th><th scope="col">Spent</th><th scope="col">Net issued</th><th scope="col">Provenance</th></tr></thead>
                  <tbody>{report.totalsByAsset.map((value, index) => {
                    const asset = asRecord(value);
                    const chain = textAt(asset, 'chainId');
                    const token = textAt(asset, 'tokenContractAddress');
                    return <tr key={`asset-${index}`}><th scope="row">{assetLabel(valueAt(asset, 'asset') ?? value)}<span className="admin-evidence-secondary">{chain || token ? `${chain || 'Unknown chain'} · ${compactId(token)}` : ''}</span></th><td>{displayText(valueAt(asset, 'awardedSparkz', 'awarded', 'amount'))} SPARKZ</td><td>{displayText(valueAt(asset, 'spentSparkz', 'spent'))} SPARKZ</td><td>{displayText(valueAt(asset, 'netIssuedSparkz', 'netIssued'))} SPARKZ</td><td>{humanize(valueAt(asset, 'provenance'))}</td></tr>;
                  })}</tbody>
                </table>
              </div>
            </div>
          )}

          {!!coverageWarnings.length && (
            <div className="admin-evidence-coverage" role="note">
              <strong>Coverage warnings</strong>
              <ul>{coverageWarnings.map((warning, index) => <li key={`${warning}-${index}`}>{warning}</li>)}</ul>
            </div>
          )}

          <EvidenceTable rows={report.rows} selected={selectedRow} onSelect={selectRow} selectionDisabled={annotationSaving} />
          <div className="admin-evidence-pagination">
            <button type="button" className="btn-ghost" onClick={() => { if (appliedFilters) void loadReport(appliedFilters, Math.max(0, reportOffset - appliedFilters.limit)); }} disabled={reportLoading || !appliedFilters || reportOffset === 0}>Previous</button>
            <span className="subtle">Page offset {reportOffset.toLocaleString()}{reportHasMore ? ' · more available' : ''}</span>
            <button type="button" className="btn-ghost" onClick={() => { if (appliedFilters && reportNextOffset !== null) void loadReport(appliedFilters, reportNextOffset); }} disabled={reportLoading || !appliedFilters || !reportHasMore || reportNextOffset === null}>Next</button>
          </div>
        </>
      )}

      {selectedRow && (
        <div className="admin-evidence-annotation-panel" aria-labelledby="admin-evidence-annotation-title">
          <div className="admin-rule-header">
            <div>
              <h4 id="admin-evidence-annotation-title">Correction annotations</h4>
              <p className="subtle">Attached to {humanize(selectedRow.subjectType)} {compactId(selectedRow.subjectId)}. Saving creates a server-attributed append-only note.</p>
            </div>
            <button type="button" className="btn-ghost" onClick={closeAnnotationPanel} disabled={annotationSaving}>Close</button>
          </div>

          {annotationLoading && !annotations.length && <p className="subtle">Loading saved annotations…</p>}
          {annotationError && <p className="admin-error" role="alert">{annotationError}</p>}
          {!annotationLoading && !annotationError && !annotations.length && <p className="subtle">No correction annotations have been saved for this retained record.</p>}
          {!!annotations.length && (
            <div className="admin-evidence-annotation-list">
              {annotations.map(annotation => (
                <article key={annotation.id} className="admin-evidence-annotation">
                  <div><strong>{humanize(annotation.referenceType)}</strong><span className="admin-evidence-secondary">{displayText(valueAt(annotation, 'reference'))}</span></div>
                  <p>{displayText(valueAt(annotation, 'reason'))}</p>
                  <span className="admin-evidence-secondary">{humanize(valueAt(annotation, 'actorType'))} · {displayText(valueAt(annotation, 'actorId'))} · {formatDate(valueAt(annotation, 'createdAt', 'created_at'))}</span>
                  <span className="admin-evidence-secondary">Reference resolution: {humanize(valueAt(asRecord(valueAt(annotation, 'resolvedReference')), 'provenance'))}</span>
                </article>
              ))}
            </div>
          )}
          {annotationHasMore && <button type="button" className="btn-ghost" onClick={() => { if (annotationNextOffset !== null) void loadAnnotations(selectedRow, annotationNextOffset, true); }} disabled={annotationLoading || annotationNextOffset === null}>{annotationLoading ? 'Loading…' : `Load more annotations${annotationTotal === null ? '' : ` (${annotationTotal})`}`}</button>}

          <form className="admin-evidence-annotation-form" onSubmit={saveAnnotation}>
            <label>Reference type<select value={referenceType} onChange={event => { setReferenceType(event.target.value as ReferenceType); setClientRequestId(makeClientRequestId()); }} disabled={annotationSaving}><option value="transaction">Original transaction</option><option value="case">Investigation case</option></select></label>
            <label>Original transaction/case reference<input value={reference} onChange={event => updateDraft(setReference, event.target.value)} disabled={annotationSaving} required maxLength={200} autoComplete="off" /></label>
            <label>Correction reason<textarea value={reason} onChange={event => updateDraft(setReason, event.target.value)} disabled={annotationSaving} required maxLength={1000} rows={4} /></label>
            <p className="subtle">The reference identifies the original retained transaction or case and may differ from this record’s own hash. The operator and assigned timestamp come from the server.</p>
            {annotationFeedback && <p className={annotationFeedback.includes('saved') ? 'admin-success' : 'admin-error'} role="status">{annotationFeedback}</p>}
            <button type="submit" disabled={annotationSaving || !reference.trim() || !reason.trim()}>{annotationSaving ? 'Saving…' : 'Save annotation'}</button>
          </form>
        </div>
      )}
    </section>
  );
}
