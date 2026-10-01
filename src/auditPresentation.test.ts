import { presentAuditEvent, shouldReleaseSpendRequest } from './auditPresentation';

describe('presentAuditEvent', () => {
  it('keeps structured OCPI identity failures as validation/quarantine reasons', () => {
    const presentation = presentAuditEvent({
      event_type: 'award.validation_failed',
      status: 'error',
      target_type: 'cdr',
      target_id: 'session-1',
      metadata: {
        reason: 'invalid_cdr',
        error: 'raw error should not be rendered',
        normalisationError: {
          code: 'UID_ONLY',
          message: 'OCPI cdr_token.contract_id is required; UID-only input is not an eMAID.',
          protocol: 'OCPI',
          sourceFields: ['cdr_token.uid', 'cdr_token.contract_id'],
        },
        sessionId: 'session-1',
        providerId: 'provider-1',
      },
    });

    expect(presentation.category).toBe('identity');
    expect(presentation.reasonLabel).toBe('Validation / quarantine reason');
    expect(presentation.reason).toContain('UID-only');
    expect(presentation.details).toEqual(expect.arrayContaining([
      { label: 'Protocol', value: 'OCPI' },
      { label: 'Normalisation code', value: 'UID_ONLY' },
      { label: 'Session', value: 'session-1' },
    ]));
    expect(JSON.stringify(presentation)).not.toContain('raw error');
  });

  it('keeps OICP eMAID provenance and conflicting identity reason visible', () => {
    const presentation = presentAuditEvent({
      event_type: 'award.preview_failed',
      status: 'error',
      metadata: {
        normalisationError: {
          code: 'CONFLICTING_IDENTIFIERS',
          message: 'OICP EvcoID values disagree.',
          protocol: 'OICP',
          sourceFields: [
            'Identification.RemoteIdentification.EvcoID',
            'Identification.QRCodeIdentification.EvcoID',
          ],
        },
      },
    });

    expect(presentation.reasonLabel).toBe('Validation / quarantine reason');
    expect(presentation.details).toEqual(expect.arrayContaining([
      { label: 'Protocol', value: 'OICP' },
      { label: 'Normalisation code', value: 'CONFLICTING_IDENTIFIERS' },
    ]));
  });

  it('labels RPC failures as operational details and excludes raw provider errors', () => {
    const presentation = presentAuditEvent({
      event_type: 'treasury.gas_check_failed',
      status: 'warning',
      metadata: {
        error: 'https://rpc.example.test/private?token=secret-value',
      },
    });

    expect(presentation.reasonLabel).toBe('Operational detail');
    expect(presentation.reason).toContain('RPC/gas check failed');
    expect(presentation.reason).not.toContain('secret-value');
    expect(JSON.stringify(presentation)).not.toContain('rpc.example.test');
    expect(presentation.reasonLabel).not.toBe('Validation / quarantine reason');
  });

  it('labels skipped alert delivery as a configuration warning', () => {
    const presentation = presentAuditEvent({
      event_type: 'admin_alert.delivery_skipped',
      status: 'warning',
      metadata: {
        reason: 'admin_alert_webhook_not_configured',
        sourceEventType: 'treasury.gas_low',
      },
    });

    expect(presentation.category).toBe('alert');
    expect(presentation.reasonLabel).toBe('Alert delivery');
    expect(presentation.reason).toContain('webhook is not configured');
    expect(presentation.reason).toContain('no external alert was sent');
  });

  it('gives receipt uncertainty an explicit confirmation and existing-tx instruction', () => {
    const presentation = presentAuditEvent({
      event_type: 'spend_receipt.persistence_failed',
      status: 'error',
      metadata: {
        txHash: '0xabc123',
        error: 'database error with a secret URL',
      },
    });

    expect(presentation.reasonLabel).toBe('Receipt recovery status');
    expect(presentation.reason).toContain('confirmation is pending');
    expect(presentation.reason).toContain('existing transaction');
    expect(presentation.details).toContainEqual({ label: 'Transaction hash', value: '0xabc123' });
    expect(JSON.stringify(presentation)).not.toContain('secret URL');
  });

  it('does the same for award and spend execution failures with RPC details', () => {
    const presentation = presentAuditEvent({
      event_type: 'spend.failed',
      status: 'retry_required',
      metadata: {
        stage: 'execution',
        error: 'receipt lookup failed at https://rpc.example.test?secret=hidden',
      },
    });

    expect(presentation.reasonLabel).toBe('Transaction recovery status');
    expect(presentation.reason).toContain('confirmation is pending or uncertain');
    expect(presentation.reason).toContain('existing transaction');
    expect(JSON.stringify(presentation)).not.toContain('rpc.example.test');
    expect(JSON.stringify(presentation)).not.toContain('hidden');
  });

  it('does not call a proven no-movement failure transaction-pending', () => {
    const presentation = presentAuditEvent({
      event_type: 'spend.failed',
      status: 'error',
      metadata: {
        movementOutcome: 'no_movement',
        error: 'provider detail should not be rendered',
      },
    });

    expect(presentation.reasonLabel).toBe('Movement outcome');
    expect(presentation.reason).toContain('no token movement occurred');
    expect(presentation.reason).not.toContain('pending');
    expect(presentation.details).toContainEqual({ label: 'Movement outcome', value: 'no_movement' });
  });

  it('does not label a successful admin login as a failed authentication attempt', () => {
    const presentation = presentAuditEvent({
      event_type: 'admin.login_succeeded',
      status: 'success',
      metadata: {},
    });

    expect(presentation.reasonLabel).toBe('Authentication detail');
    expect(presentation.reason).toBe('Admin authentication succeeded.');
    expect(presentation.reason).not.toContain('rejected');
  });

  it('does not call generic request validation a normalisation quarantine reason', () => {
    const presentation = presentAuditEvent({
      event_type: 'spend.validation_failed',
      status: 'error',
      metadata: { reason: 'invalid_wallet_address', error: 'raw validation detail' },
    });

    expect(presentation.reasonLabel).toBe('Request validation reason');
    expect(presentation.reason).toBe('The wallet address was invalid.');
    expect(JSON.stringify(presentation)).not.toContain('raw validation detail');
  });

  it('labels a confirmed award without an original CDR as missing-CDR review', () => {
    const presentation = presentAuditEvent({
      event_type: 'operator.recovery_confirmed_unprojected',
      status: 'warning',
      target_type: 'token_operation',
      target_id: 'award:review',
      metadata: {
        txHash: '0xconfirmed',
        reason: 'server diagnostic should not replace the fixed operator message',
      },
    });

    expect(presentation.category).toBe('operational');
    expect(presentation.reasonLabel).toBe('Award recovery review');
    expect(presentation.reason).toContain('original CDR is unavailable');
    expect(presentation.reason).toContain('do not resend');
    expect(presentation.reason).not.toContain('server diagnostic');
    expect(JSON.stringify(presentation)).not.toContain('server diagnostic');
  });

  it('labels a recovery projection as completed ledger work', () => {
    const presentation = presentAuditEvent({
      event_type: 'operator.recovery_projected',
      status: 'success',
      target_type: 'token_operation',
      target_id: 'spend:projected',
      metadata: {
        txHash: '0xprojected',
      },
    });

    expect(presentation.category).toBe('operational');
    expect(presentation.reasonLabel).toBe('Recovery completed');
    expect(presentation.reason).toContain('projected into the ledger');
    expect(presentation.guidance).toContain('Do not resend');
  });
});

describe('shouldReleaseSpendRequest', () => {
  it('retains unknown, review, generic failed, and pending outcomes', () => {
    expect(shouldReleaseSpendRequest({ operationStatus: 'failed' }, true)).toBe(false);
    expect(shouldReleaseSpendRequest({ operationStatus: 'failed', movementOutcome: 'review' }, true)).toBe(false);
    expect(shouldReleaseSpendRequest({ operationStatus: 'failed', movementOutcome: 'unknown' }, true)).toBe(false);
    expect(shouldReleaseSpendRequest({ movementOutcome: 'no_movement', pending: true }, true)).toBe(false);
    expect(shouldReleaseSpendRequest({ movementOutcome: 'no_movement', requiresReview: true }, true)).toBe(false);
  });

  it('releases only an explicitly proven no-movement response from a user action', () => {
    expect(shouldReleaseSpendRequest({ operationStatus: 'failed', movementOutcome: 'no_movement' }, true)).toBe(true);
    expect(shouldReleaseSpendRequest({ operationStatus: 'failed', movementOutcome: 'no_movement' }, false)).toBe(false);
  });
});
