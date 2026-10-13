import {
  AdminOperationsQueryError,
  applyAdminOperationFilters,
  getAdminOperationRecoveryStatus,
  getAdminOperationNextAction,
  mapTokenOperationRecord,
  parseAdminOperationsQuery,
  safeOperationErrorCategory,
} from './adminOperations';
import type { TokenOperationRecord } from './database/service';
import knex from 'knex';

function operation(overrides: Partial<TokenOperationRecord> = {}): TokenOperationRecord {
  return {
    id: 'operation-id',
    operation_key: 'award:session-1:provider-1',
    operation_type: 'award',
    request_fingerprint: 'request-fingerprint-must-not-be-exposed',
    uid: 'DE-TEST-EMAID',
    wallet_address: '0x1111111111111111111111111111111111111111',
    amount: '2.50',
    session_id: 'session-1',
    provider_id: 'provider-1',
    reservation_id: null,
    intent_context: { cdr: { secret: 'must-not-be-exposed' } },
    status: 'unknown',
    movement_outcome: 'unknown',
    tx_hash: null,
    error_message: null,
    submitted_at: null,
    confirmed_at: null,
    projected_at: null,
    created_at: new Date('2026-01-01T00:00:00.000Z'),
    updated_at: new Date('2026-01-01T01:00:00.000Z'),
    ...overrides,
  };
}

describe('admin operations read-only query and mapping', () => {
  it('defaults to a bounded unresolved eMAID view and accepts the supported page sizes', () => {
    expect(parseAdminOperationsQuery({})).toEqual({ limit: 25, offset: 0, scope: 'unresolved' });
    expect(parseAdminOperationsQuery({ limit: '50', offset: '25', scope: 'all', emaid: ' DE-TEST-EMAID ' }))
      .toEqual({ limit: 50, offset: 25, scope: 'all', emaid: 'DE-TEST-EMAID' });
    expect(parseAdminOperationsQuery({ limit: '100' }).limit).toBe(100);
  });

  it('rejects oversized pages, invalid scopes, and legacy uid filtering', () => {
    expect(() => parseAdminOperationsQuery({ limit: '0' })).toThrow('limit must be at least 1');
    expect(() => parseAdminOperationsQuery({ limit: '101' })).toThrow(AdminOperationsQueryError);
    expect(() => parseAdminOperationsQuery({ scope: 'pending' })).toThrow('scope must be either unresolved or all');
    expect(() => parseAdminOperationsQuery({ uid: 'DE-TEST-EMAID' })).toThrow('uid is not supported');
    expect(() => parseAdminOperationsQuery({ emaid: '   ' })).toThrow('emaid must not be empty');
  });

  it('maps only allowlisted operational fields and retains eMAID as the ownership label', () => {
    const mapped = mapTokenOperationRecord(operation({
      status: 'failed',
      movement_outcome: 'no_movement',
      error_message: 'RPC https://node.example.invalid Authorization=super-secret balance unavailable',
      reservation_id: 'reservation-id',
      tx_hash: null,
    }));

    expect(mapped).toMatchObject({
      eMAID: 'DE-TEST-EMAID',
      sessionId: 'session-1',
      providerId: 'provider-1',
      reservationId: 'reservation-id',
      movementOutcome: 'no_movement',
      status: 'failed',
      errorMessage: 'Preflight check failed',
      nextAction: 'Review the failure; no chain movement was recorded.',
    });
    expect(mapped.errorMessage).not.toContain('https://');
    expect(mapped.errorMessage).not.toContain('super-secret');
    expect(mapped).not.toHaveProperty('uid');
    expect(mapped).not.toHaveProperty('intentContext');
    expect(mapped).not.toHaveProperty('requestFingerprint');
  });

  it('maps persisted transaction diagnostics without exposing raw provider details', () => {
    const mapped = mapTokenOperationRecord(operation({
      operation_type: 'spend',
      operation_key: 'spend:diagnostic',
      status: 'unknown',
      movement_outcome: 'unknown',
      diagnostic_context: {
        stage: 'broadcast',
        rpcMethod: 'eth_sendRawTransaction',
        rpcCode: -32000,
        httpStatus: 500,
        traceId: 'trace-1',
        rpcEndpoint: 'fallback-1',
        rpcFailover: [
          { label: 'primary', outcome: 'failed', httpStatus: 500, traceId: 'trace-primary' },
          { label: 'fallback-1', outcome: 'success' },
          { label: 'https://rpc.example.invalid?token=secret', outcome: 'success' },
        ],
        errorCode: 'CHAIN_OUTCOME_UNKNOWN',
        retryable: false,
        savedHash: `0x${'b'.repeat(64)}`,
        rawProviderBody: 'https://rpc.example.invalid?token=secret',
      } as any,
      error_message: 'raw provider body must not be returned',
    }));

    expect(mapped).toMatchObject({
      errorCode: 'CHAIN_OUTCOME_UNKNOWN',
      failureStage: 'broadcast',
      diagnostic: {
        stage: 'broadcast',
        rpcMethod: 'eth_sendRawTransaction',
        rpcCode: '-32000',
        httpStatus: 500,
        traceId: 'trace-1',
        errorCode: 'CHAIN_OUTCOME_UNKNOWN',
        retryable: false,
        savedHash: `0x${'b'.repeat(64)}`,
      },
    });
    expect(mapped.diagnostic).toMatchObject({
      rpcEndpoint: 'fallback-1',
      rpcFailover: [
        { label: 'primary', outcome: 'failed', httpStatus: 500, traceId: 'trace-primary' },
        { label: 'fallback-1', outcome: 'success' },
      ],
    });
    expect(JSON.stringify(mapped)).not.toContain('rawProviderBody');
    expect(JSON.stringify(mapped)).not.toContain('rpc.example.invalid');
    expect(JSON.stringify(mapped)).not.toContain('secret');
  });

  it('describes unknown and projected outcomes without presenting a mutation', () => {
    expect(getAdminOperationNextAction({ status: 'unknown', movement_outcome: 'unknown', tx_hash: '0xhash' }))
      .toBe('Reconcile the transaction hash before any follow-up.');
    expect(getAdminOperationNextAction({ status: 'projected', movement_outcome: 'confirmed', tx_hash: '0xhash' }))
      .toBe('Verify projection and receipt state; the operation is projected.');
  });

  it('distinguishes a retryable no-movement dependency failure from operator review', () => {
    const retryable = operation({
      operation_type: 'spend',
      operation_key: 'spend:retryable-preflight',
      status: 'failed',
      movement_outcome: 'no_movement',
      diagnostic_context: {
        stage: 'prepare',
        errorCode: 'RPC_READ_UNAVAILABLE',
        retryable: true,
      } as any,
    });
    const mapped = mapTokenOperationRecord(retryable);

    expect(mapped.nextAction).toBe('The chain dependency is temporarily unavailable; retry the same operation key after it recovers.');
    expect(mapped.recovery).toMatchObject({
      eligible: false,
      reasonCode: 'DEPENDENCY_RETRY_REQUIRED',
    });
    expect(mapped.recovery.reason).not.toContain('operator review');
  });

  it('does not label confirmed movement as an unresolved review failure', () => {
    const mapped = mapTokenOperationRecord(operation({
      status: 'failed',
      movement_outcome: 'confirmed',
      diagnostic_context: {
        stage: 'receipt',
        errorCode: 'TRANSACTION_CONFIRMATION_PENDING',
        retryable: false,
      } as any,
    }));

    expect(mapped.nextAction).toBe('Chain movement is recorded; verify projection and receipt state before any follow-up.');
    expect(mapped.recovery).toMatchObject({
      eligible: false,
      reasonCode: 'CHAIN_MOVEMENT_CONFIRMED',
    });
  });

  it('uses an exact eMAID-to-uid database predicate and deterministic id tie-breaker', () => {
    const db = knex({ client: 'pg' });
    const query = applyAdminOperationFilters(db('token_operations'), {
      scope: 'all',
      limit: 25,
      offset: 0,
      emaid: 'CaseSensitive-eMAID',
    }).orderBy('updated_at', 'desc').orderBy('created_at', 'desc').orderBy('id', 'desc');
    const sql = query.toSQL();
    expect(sql.sql).toContain('"uid" = ?');
    expect(sql.sql).not.toContain('lower(');
    expect(sql.bindings).toContain('CaseSensitive-eMAID');
    expect(sql.sql.endsWith('order by "updated_at" desc, "created_at" desc, "id" desc')).toBe(true);
    void db.destroy();
  });

  it('categorises errors without returning the original provider or credential text', () => {
    expect(safeOperationErrorCategory('provider responded with RPC https://rpc.example.invalid?token=secret')).toBe('Chain outcome requires review');
    expect(safeOperationErrorCategory('some unexpected internal error')).toBe('Operation failed; review the operation state');
  });

  it('categorises confirmed awards missing their original CDR separately from generic failures', () => {
    expect(safeOperationErrorCategory(
      'RECOVERY_AWARD_CDR_CONTEXT_UNAVAILABLE: original CDR recovery context unavailable; operator review required; do not resend',
    )).toBe('Award confirmed; original CDR unavailable for projection');
  });

  it('only advertises projected spend receipt recovery when a canonical hash is saved', () => {
    expect(getAdminOperationRecoveryStatus(operation({
      operation_type: 'spend',
      status: 'projected',
      tx_hash: `0x${'a'.repeat(64)}`,
    }))).toEqual({
      eligible: true,
      reasonCode: 'SPEND_RECEIPT_RECOVERY_REQUIRED',
      reason: 'The spend projection is complete; the saved transaction hash can be rechecked to finish a missing receipt without a new transfer.',
    });
    expect(getAdminOperationRecoveryStatus(operation({
      operation_type: 'spend',
      status: 'projected',
      tx_hash: null,
    }))).toMatchObject({
      eligible: false,
      reasonCode: 'CHAIN_HASH_REQUIRED',
    });
    expect(getAdminOperationRecoveryStatus(operation({
      operation_type: 'award',
      status: 'projected',
      tx_hash: `0x${'a'.repeat(64)}`,
    }))).toMatchObject({
      eligible: true,
      reasonCode: 'ALREADY_PROJECTED',
    });
    expect(getAdminOperationRecoveryStatus(operation({
      operation_type: 'award',
      status: 'projected',
      amount: '0.00',
      tx_hash: null,
    }))).toMatchObject({
      eligible: false,
      reasonCode: 'ALREADY_PROJECTED',
    });
  });
});
