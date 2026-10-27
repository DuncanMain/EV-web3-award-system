import {
  parseAdminCorrectionAnnotationRequest,
  parseAdminEvidenceQuery,
  parseAnnotationListQuery,
  renderAdminEvidenceCsv,
} from './adminEvidence';
import type { AdminEvidenceReportResponse } from './adminEvidence.types';

const UUID = '6f8f3c7a-5a3f-4f3e-9b7a-9b0d8e0a1c22';
const HASH = `0x${'a'.repeat(64)}`;

function parseCsvLine(line: string): string[] {
  const values: string[] = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"' && quoted && line[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (character === '"') {
      quoted = !quoted;
    } else if (character === ',' && !quoted) {
      values.push(value);
      value = '';
    } else {
      value += character;
    }
  }
  values.push(value);
  return values;
}

function reportWithRow(): AdminEvidenceReportResponse {
  return {
    status: 'ok',
    generatedAt: '2026-10-21T12:00:00.000Z',
    period: {
      from: '2026-10-01T12:00:00.000Z',
      to: '2026-10-21T12:00:00.000Z',
      observationAt: '2026-10-21T12:00:00.000Z',
    },
    policy: { currentRevision: 9, currentUpdatedAt: '2026-10-20T12:00:00.000Z' },
    summary: {
      basis: 'selected retained data in requested window',
      issuedMovementCount: 1,
      returnedMovementCount: 0,
      confirmedMovementCount: 1,
      exceptionCount: 0,
      totalsByAsset: [{
        chainId: '137',
        tokenContractAddress: `0x${'b'.repeat(40)}`,
        provenance: 'stored_operation_context',
        awardedSparkz: '1.25',
        spentSparkz: '0.00',
        netIssuedSparkz: '1.25',
      }],
    },
    coverage: {
      sourceCounts: { tokenOperations: 1, awards: 0, spends: 0 },
      sourceCaps: { tokenOperations: 5000, awards: 5000, spends: 5000 },
      returnedCount: 1,
      totalIsLowerBound: true,
      truncated: true,
      unknownMovementCount: 1,
      invalidHashCount: 0,
      unknownAssetCount: 0,
      duplicateConflictCount: 0,
      warnings: ['bounded source cap reached'],
    },
    reconciliation: {
      latestReportId: null,
      latestStatus: null,
      latestCreatedAt: null,
      ageSeconds: null,
      checkedCount: null,
      mismatchCount: null,
      discrepancies: [],
      coverageWarnings: [],
    },
    pagination: { limit: 100, offset: 0, hasMore: false, nextOffset: null },
    rows: [{
      subjectType: 'token_operation',
      subjectId: UUID,
      operationKey: '=SUM(A1:A2)',
      operationType: 'award',
      eMAID: 'E12…6789',
      walletAddress: '0x1…abcd',
      amountSparkz: '1.25',
      status: '+review',
      movementOutcome: 'confirmed',
      transactionHash: HASH,
      asset: {
        chainId: '137',
        tokenContractAddress: `0x${'b'.repeat(40)}`,
        provenance: 'stored_operation_context',
      },
      historicalPolicy: {
        source: 'unknown',
        revision: null,
        rulesVersion: null,
        safePolicyFingerprint: null,
      },
      sessionId: 'session',
      providerId: '@provider',
      reservationId: null,
      timestamps: {
        createdAt: '2026-10-21T11:00:00.000Z',
        submittedAt: null,
        confirmedAt: '2026-10-21T11:30:00.000Z',
        projectedAt: null,
        activityAt: '2026-10-21T11:30:00.000Z',
        activityAtSource: 'confirmed_at',
      },
      exceptionCategory: null,
      annotationCount: 0,
    }],
  };
}

describe('admin evidence query and annotation contracts', () => {
  it('defaults to a 30-day UTC window and bounded pagination', () => {
    const parsed = parseAdminEvidenceQuery({}, new Date('2026-10-21T12:00:00.000Z'));
    expect(parsed).toMatchObject({
      from: '2026-09-21T12:00:00.000Z',
      to: '2026-10-21T12:00:00.000Z',
      limit: 100,
      offset: 0,
      scope: 'all',
      format: 'json',
    });
    expect(() => parseAdminEvidenceQuery({ limit: '501' })).toThrow('between 1 and 500');
    expect(() => parseAdminEvidenceQuery({ offset: '100001' })).toThrow('between 0 and 100000');
    expect(() => parseAdminEvidenceQuery({
      from: '2025-10-19T12:00:00.000Z',
      to: '2026-10-21T12:00:00.000Z',
    })).toThrow('at most 366 days');
  });

  it('requires canonical transaction references and strict subject UUIDs', () => {
    const parsed = parseAdminCorrectionAnnotationRequest({
      clientRequestId: UUID,
      subjectType: 'award',
      subjectId: UUID,
      referenceType: 'transaction',
      reference: `0x${'A'.repeat(64)}`,
      reason: 'Support case correction review',
    });
    expect(parsed.reference).toBe(HASH);
    expect(() => parseAdminCorrectionAnnotationRequest({
      clientRequestId: UUID,
      subjectType: 'award',
      subjectId: UUID,
      referenceType: 'transaction',
      reference: 'not-a-hash',
      reason: 'reason',
    })).toThrow('canonical 0x-prefixed 32-byte hash');
    expect(() => parseAdminCorrectionAnnotationRequest({
      clientRequestId: UUID,
      subjectType: 'award',
      subjectId: UUID,
      referenceType: 'case',
      reference: 'case-1',
      reason: 'reason',
      unexpected: 'reject',
    })).toThrow('only clientRequestId');
  });

  it('bounds annotation listing and rejects API-key-shaped query values', () => {
    expect(parseAnnotationListQuery({ subjectType: 'spend', subjectId: UUID })).toEqual({
      subjectType: 'spend',
      subjectId: UUID,
      limit: 25,
      offset: 0,
    });
    expect(() => parseAnnotationListQuery({ subjectType: ['spend'], subjectId: UUID })).toThrow('subjectType must be');
  });
});

describe('admin evidence CSV safety', () => {
  it('escapes formula-leading cells, carries coverage metadata, and aligns empty rows', () => {
    const report = reportWithRow();
    const csv = renderAdminEvidenceCsv(report);
    expect(csv).toContain("'=SUM(A1:A2)");
    expect(csv).toContain("'+review");
    expect(csv).toContain('summaryTotalsByAsset');
    expect(csv).toContain('coverageTotalIsLowerBound');
    expect(csv).toContain('bounded source cap reached');

    const nonEmptyLines = csv.trimEnd().split('\r\n').map(parseCsvLine);
    expect(nonEmptyLines[1]).toHaveLength(nonEmptyLines[0].length);

    const emptyCsv = renderAdminEvidenceCsv({ ...report, rows: [] });
    const emptyLines = emptyCsv.trimEnd().split('\r\n').map(parseCsvLine);
    expect(emptyLines[1]).toHaveLength(emptyLines[0].length);
    const summaryColumn = emptyLines[0].indexOf('summaryIssuedMovementCount');
    const coverageColumn = emptyLines[0].indexOf('coverageTotalIsLowerBound');
    expect(emptyLines[1][summaryColumn]).toBe('1');
    expect(emptyLines[1][coverageColumn]).toBe('true');
  });
});
