/**
 * Safe DTOs for the authenticated NVF admin evidence report and correction
 * annotations.  This file has no runtime imports so the frontend can copy
 * the wire shapes without importing database or financial code.
 */

export type AdminEvidenceScope = 'all' | 'unresolved';
export type AdminEvidenceFormat = 'json' | 'csv';
export type AdminEvidenceOperationType = 'award' | 'spend';
export type AdminEvidenceMovementOutcome = 'confirmed' | 'no_movement' | 'unknown' | 'review';
export type AdminEvidenceAssetProvenance = 'stored_operation_context' | 'legacy_unknown' | 'conflict_unknown';
export type AdminEvidencePolicySource = 'operation_snapshot' | 'not_applicable' | 'unknown';
export type AdminEvidenceActivityAtSource = 'confirmed_at' | 'projection_or_created_at' | 'unknown';

export interface AdminEvidenceQuery {
  from: string;
  to: string;
  limit: number;
  offset: number;
  scope: AdminEvidenceScope;
  emaid?: string;
  operationType?: AdminEvidenceOperationType;
  status?: string;
  format: AdminEvidenceFormat;
}

export interface AdminEvidenceAsset {
  chainId: string | null;
  tokenContractAddress: string | null;
  provenance: AdminEvidenceAssetProvenance;
}

export interface AdminEvidenceHistoricalPolicy {
  source: AdminEvidencePolicySource;
  revision: number | null;
  rulesVersion: string | null;
  /** SHA-256 of the persisted policy snapshot; the snapshot body is never returned. */
  safePolicyFingerprint: string | null;
}

export interface AdminEvidenceTimestamps {
  createdAt: string | null;
  submittedAt: string | null;
  confirmedAt: string | null;
  projectedAt: string | null;
  activityAt: string | null;
  activityAtSource: AdminEvidenceActivityAtSource;
}

export interface AdminEvidenceRow {
  subjectType: 'token_operation' | 'award' | 'spend';
  subjectId: string;
  /** Opaque digest for operator correlation; raw source keys never leave the API. */
  operationKey: string | null;
  operationType: AdminEvidenceOperationType;
  eMAID: string | null;
  walletAddress: string | null;
  amountSparkz: string;
  status: string | null;
  movementOutcome: AdminEvidenceMovementOutcome | null;
  transactionHash: string | null;
  asset: AdminEvidenceAsset;
  historicalPolicy: AdminEvidenceHistoricalPolicy;
  /** Opaque digests; raw driver/session labels never leave the API. */
  sessionId: string | null;
  providerId: string | null;
  reservationId: string | null;
  timestamps: AdminEvidenceTimestamps;
  exceptionCategory: string | null;
  annotationCount: number;
}

export interface AdminEvidenceTotalsByAsset extends AdminEvidenceAsset {
  awardedSparkz: string;
  spentSparkz: string;
  netIssuedSparkz: string;
}

export interface AdminEvidenceReconciliationDiscrepancy {
  walletAddress: string | null;
  eMAID: string | null;
  status: string | null;
  expectedSparkz: string | null;
  recordedSparkz: string | null;
  differenceSparkz: string | null;
}

export interface AdminEvidenceReportResponse {
  status: 'ok';
  generatedAt: string;
  period: {
    from: string;
    to: string;
    observationAt: string;
  };
  policy: {
    currentRevision: number | null;
    currentUpdatedAt: string | null;
  };
  summary: {
    basis: 'selected retained data in requested window';
    issuedMovementCount: number;
    returnedMovementCount: number;
    confirmedMovementCount: number;
    exceptionCount: number;
    totalsByAsset: AdminEvidenceTotalsByAsset[];
  };
  coverage: {
    sourceCounts: {
      tokenOperations: number;
      awards: number;
      spends: number;
    };
    sourceCaps: {
      tokenOperations: number;
      awards: number;
      spends: number;
    };
    returnedCount: number;
    totalIsLowerBound: boolean;
    truncated: boolean;
    unknownMovementCount: number;
    invalidHashCount: number;
    unknownAssetCount: number;
    duplicateConflictCount: number;
    warnings: string[];
  };
  reconciliation: {
    latestReportId: string | null;
    latestStatus: string | null;
    latestCreatedAt: string | null;
    ageSeconds: number | null;
    checkedCount: number | null;
    mismatchCount: number | null;
    discrepancies: AdminEvidenceReconciliationDiscrepancy[];
    coverageWarnings: string[];
  };
  pagination: {
    limit: number;
    offset: number;
    hasMore: boolean;
    nextOffset: number | null;
  };
  rows: AdminEvidenceRow[];
}

export type AdminCorrectionAnnotationReferenceType = 'transaction' | 'case';
export type AdminCorrectionAnnotationSubjectType = 'token_operation' | 'award' | 'spend';

export interface AdminCorrectionAnnotationRequest {
  clientRequestId: string;
  subjectType: AdminCorrectionAnnotationSubjectType;
  subjectId: string;
  referenceType: AdminCorrectionAnnotationReferenceType;
  reference: string;
  reason: string;
}

export interface AdminCorrectionAnnotation {
  id: string;
  clientRequestId: string;
  subjectType: AdminCorrectionAnnotationSubjectType;
  subjectId: string;
  referenceType: AdminCorrectionAnnotationReferenceType;
  reference: string;
  reason: string;
  actorType: 'admin_session';
  actorId: string;
  createdAt: string;
  resolvedReference: {
    provenance: 'retained_operation' | 'retained_award' | 'retained_spend' | 'external_case' | 'unknown' | 'conflict_unknown';
    /** Opaque digest; the retained operation key is never returned verbatim. */
    operationKey: string | null;
    chainId: string | null;
    tokenContractAddress: string | null;
  };
}

export interface AdminCorrectionAnnotationResponse {
  status: 'ok';
  sideEffects: { financial: false };
  annotation: AdminCorrectionAnnotation;
}

export interface AdminCorrectionAnnotationListResponse {
  status: 'ok';
  count: number;
  limit: number;
  offset: number;
  hasMore: boolean;
  nextOffset: number | null;
  annotations: AdminCorrectionAnnotation[];
}
