/**
 * Safe, event-aware presentation for append-only admin audit events.
 *
 * This module deliberately accepts the loose shape returned by the audit API
 * and only projects allowlisted fields.  In particular, generic metadata.error
 * is never rendered: provider/RPC diagnostics belong in server-side logs and
 * must not become an operator-facing payload or secret leak.
 */

export type AuditPresentationEvent = {
  event_type?: unknown;
  status?: unknown;
  target_type?: unknown;
  target_id?: unknown;
  metadata?: unknown;
};

export type AuditPresentationDetail = {
  label: string;
  value: string;
};

export type AuditPresentationCategory =
  | 'identity'
  | 'validation'
  | 'alert'
  | 'operational'
  | 'authentication'
  | 'activity';

export type AuditPresentation = {
  category: AuditPresentationCategory;
  reasonLabel?: string;
  reason?: string;
  guidance?: string;
  details: AuditPresentationDetail[];
};

type MetadataRecord = Record<string, unknown>;

function asRecord(value: unknown): MetadataRecord | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? value as MetadataRecord
    : undefined;
}

function safeText(value: unknown, maxLength = 180): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;
  const text = String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text ? text.slice(0, maxLength) : null;
}

function safeNumericText(value: unknown): string | null {
  const text = safeText(value, 80);
  if (!text || !/^-?(?:\d+\.?\d*|\.\d+)$/.test(text)) return null;
  return text;
}

function safeList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(item => safeText(item, 100))
    .filter((item): item is string => Boolean(item));
}

function pushDetail(details: AuditPresentationDetail[], label: string, value: unknown): void {
  const text = safeText(value);
  if (!text || details.some(detail => detail.label === label && detail.value === text)) return;
  details.push({ label, value: text });
}

function eventType(event: AuditPresentationEvent): string {
  return safeText(event.event_type, 120) || 'unknown';
}

function metadata(event: AuditPresentationEvent): MetadataRecord {
  return asRecord(event.metadata) || {};
}

function reasonForValidation(value: unknown): string {
  switch (value) {
    case 'token_amount_cap_exceeded':
      return 'The requested token amount exceeds the configured operation cap.';
    case 'missing_or_invalid_uid_or_amount':
      return 'Required spend fields were missing or invalid.';
    case 'missing_or_invalid_required_fields':
      return 'Required custodial spend fields were missing or invalid.';
    case 'invalid_wallet_address':
      return 'The wallet address was invalid.';
    case 'wallet_not_linked':
      return 'The wallet is not linked to this eMAID.';
    case 'wallet_identity_mismatch':
      return 'The wallet does not match the requested eMAID.';
    case 'missing_identity':
      return 'The request did not contain the required eMAID identity.';
    default:
      return 'Request validation failed.';
  }
}

function identityDetails(
  details: AuditPresentationDetail[],
  normalisation: MetadataRecord | undefined,
  normalisationError: MetadataRecord | undefined,
): { structuredError: boolean; message: string | null } {
  const protocol = safeText(normalisation?.protocol) || safeText(normalisationError?.protocol);
  const sourceField = safeText(normalisation?.sourceField);
  const sourceFields = safeList(normalisationError?.sourceFields);
  const emaid = safeText(normalisation?.eMAID) || safeText(normalisation?.emaid);
  const code = safeText(normalisationError?.code, 80);
  const message = safeText(normalisationError?.message, 500);
  const structuredError = Boolean(normalisationError && (protocol || sourceFields.length || code || message));

  pushDetail(details, 'Protocol', protocol);
  pushDetail(details, 'Source field used', sourceField);
  if (sourceFields.length) pushDetail(details, 'Source fields inspected', sourceFields.join(', '));
  pushDetail(details, 'Normalized eMAID', emaid);
  pushDetail(details, 'Normalisation code', code);

  return { structuredError, message };
}

function addCorrelationDetails(details: AuditPresentationDetail[], event: AuditPresentationEvent, data: MetadataRecord): void {
  const targetType = safeText(event.target_type, 100);
  const targetId = safeText(event.target_id, 180);
  if (targetType && targetId) pushDetail(details, `Target (${targetType})`, targetId);

  // eMAID is the only owning identity displayed here.  Legacy uid values are
  // intentionally excluded because they are not an ownership identifier.
  pushDetail(details, 'eMAID', data.eMAID ?? data.emaid ?? data.contractId ?? data.contract_id);
  pushDetail(details, 'Amount', safeNumericText(data.amount ?? data.requestedAmount));
  pushDetail(details, 'Session', data.sessionId);
  pushDetail(details, 'Provider', data.providerId);
  pushDetail(details, 'Operation key', data.operationKey);
  pushDetail(details, 'Reservation', data.reservationId);
  pushDetail(details, 'Transaction hash', data.txHash ?? data.transactionHash ?? data.awardTxHash ?? data.reservationTxHash);
  pushDetail(details, 'Receipt', data.receiptId);
  pushDetail(details, 'Stage', data.stage);
  pushDetail(details, 'Movement outcome', data.movementOutcome ?? data.movement_outcome);
}

function isIdentityValidationEvent(structuredError: boolean): boolean {
  // A structured normalisationError is the authoritative identity signal;
  // generic event status/reason/error fields are deliberately insufficient.
  return structuredError;
}

/**
 * Return safe operator-facing labels, reasons, and correlation fields for one
 * immutable audit event.  This is also the projection contract available to
 * the API layer when it later wants to expose safe audit metadata directly.
 */
export function presentAuditEvent(event: AuditPresentationEvent): AuditPresentation {
  const type = eventType(event);
  const status = safeText(event.status, 60) || 'unknown';
  const data = metadata(event);
  const normalisation = asRecord(data.normalisation);
  const normalisationError = asRecord(data.normalisationError);
  const details: AuditPresentationDetail[] = [];
  const identity = identityDetails(details, normalisation, normalisationError);
  addCorrelationDetails(details, event, data);

  if (isIdentityValidationEvent(identity.structuredError)) {
    return {
      category: 'identity',
      reasonLabel: 'Validation / quarantine reason',
      reason: identity.message || 'The CDR identity could not be normalised safely.',
      guidance: 'Reject or quarantine this record until the eMAID identity is corrected.',
      details,
    };
  }

  if (type === 'admin_alert.delivery_skipped') {
    const reason = data.reason === 'admin_email_not_configured'
      ? 'The admin alert email is not configured; this event was audited but no external alert was sent.'
      : data.reason === 'admin_alert_webhook_not_configured'
        ? 'The admin alert webhook is not configured; this event was audited but no external alert was sent.'
        : 'Alert delivery was skipped; this event was audited but no external alert was sent.';
    return {
      category: 'alert',
      reasonLabel: 'Alert delivery',
      reason,
      guidance: 'Configure the admin alert email and webhook if external delivery is required.',
      details,
    };
  }

  if (type === 'admin_alert.delivery_failed') {
    return {
      category: 'alert',
      reasonLabel: 'Alert delivery error',
      reason: 'Alert delivery failed after the event was recorded. Check alert configuration and delivery service health.',
      details,
    };
  }

  if (type === 'admin_alert.delivered' || type === 'admin_alert.test_requested') {
    return {
      category: 'alert',
      reasonLabel: 'Alert delivery',
      reason: type === 'admin_alert.delivered'
        ? 'The alert was delivered to the configured alert endpoint.'
        : 'The alert test request was recorded; inspect the related delivery event for its result.',
      details,
    };
  }

  if (type === 'treasury.gas_check_failed') {
    return {
      category: 'operational',
      reasonLabel: 'Operational detail',
      reason: 'The treasury RPC/gas check failed. Check provider health and treasury funding.',
      guidance: 'Do not treat this as a CDR validation failure.',
      details,
    };
  }

  if (type === 'treasury.gas_low') {
    return {
      category: 'operational',
      reasonLabel: 'Operational detail',
      reason: 'The treasury gas balance is below the configured threshold.',
      details,
    };
  }

  if (type === 'spend_receipt.persistence_failed' || type.includes('receipt') && type.includes('failed')) {
    return {
      category: 'operational',
      reasonLabel: 'Receipt recovery status',
      reason: 'Receipt confirmation is pending. Check the existing transaction before retrying.',
      guidance: 'Preserve the original request and transaction hash while recovery is investigated.',
      details,
    };
  }

  if (type === 'spend.reservation_recovery_pending' || type.includes('recovery_pending')) {
    return {
      category: 'operational',
      reasonLabel: 'Recovery detail',
      reason: 'Settlement recovery is pending. Check the existing transaction before retrying.',
      details,
    };
  }

  if (type === 'operator.recovery_confirmed_unprojected') {
    return {
      category: 'operational',
      reasonLabel: 'Award recovery review',
      reason: 'The award movement is confirmed on chain, but the original CDR is unavailable. No award projection was written; do not resend.',
      guidance: 'Obtain the original CDR or an exact fingerprint-matching reconstruction before projecting the award.',
      details,
    };
  }

  if (type === 'operator.recovery_projected') {
    return {
      category: 'operational',
      reasonLabel: 'Recovery completed',
      reason: 'The verified token movement was projected into the ledger and receipt state.',
      guidance: 'Do not resend the transaction. Review any reported balance reconciliation mismatch separately.',
      details,
    };
  }

  if (type === 'award.failed' || type === 'spend.failed'
    || (type.includes('unhandled_error') && (type.startsWith('award.') || type.startsWith('spend.')))) {
    const movementOutcome = safeText(data.movementOutcome ?? data.movement_outcome, 60);
    if (movementOutcome === 'no_movement') {
      return {
        category: 'operational',
        reasonLabel: 'Movement outcome',
        reason: 'The backend recorded that no token movement occurred for this attempt.',
        guidance: 'A fresh action may use a new request key after this explicit no-movement result.',
        details,
      };
    }
    if (movementOutcome && movementOutcome !== 'unknown' && movementOutcome !== 'review') {
      return {
        category: 'operational',
        reasonLabel: 'Movement outcome',
        reason: `The backend recorded a ${movementOutcome} token movement outcome. Check the existing transaction and receipt before announcing completion.`,
        guidance: 'Preserve the original request and transaction hash while projection or receipt recovery is checked.',
        details,
      };
    }
    return {
      category: 'operational',
      reasonLabel: 'Transaction recovery status',
      reason: 'Transaction confirmation is pending or uncertain. Check the existing transaction before retrying.',
      guidance: 'Preserve the original request and transaction hash while recovery is investigated.',
      details,
    };
  }

  if (type === 'spend.custodial_failed') {
    return {
      category: 'operational',
      reasonLabel: 'Recovery detail',
      reason: 'The wallet spend outcome is not final. Check or recover an existing transaction before signing again.',
      details,
    };
  }

  if (type === 'admin.login_succeeded') {
    return {
      category: 'authentication',
      reasonLabel: 'Authentication detail',
      reason: 'Admin authentication succeeded.',
      details,
    };
  }

  if (type.includes('validation_failed') || type.endsWith('.identity_missing')) {
    return {
      category: type.endsWith('.identity_missing') ? 'identity' : 'validation',
      reasonLabel: type.endsWith('.identity_missing') ? 'Identity requirement' : 'Request validation reason',
      reason: type.endsWith('.identity_missing')
        ? 'The request did not contain the required eMAID identity.'
        : reasonForValidation(data.reason),
      details,
    };
  }

  if (type === 'auth.ingest_key_rejected' || type === 'admin.login_failed' || type === 'admin.login_unconfigured') {
    return {
      category: 'authentication',
      reasonLabel: 'Authentication detail',
      reason: type === 'admin.login_unconfigured'
        ? 'Admin authentication is not configured.'
        : 'An authentication attempt was rejected or failed.',
      details,
    };
  }

  if (type === 'reconciliation.balance_run' && (status === 'mismatch' || status === 'error')) {
    return {
      category: 'operational',
      reasonLabel: 'Reconciliation detail',
      reason: 'A reconciliation mismatch or error was recorded. Inspect the reconciliation report.',
      details,
    };
  }

  if (type.includes('.failed') || type.includes('unhandled_error')) {
    const movementOutcome = safeText(data.movementOutcome ?? data.movement_outcome, 60);
    if (movementOutcome === 'no_movement') {
      return {
        category: 'operational',
        reasonLabel: 'Movement outcome',
        reason: 'The backend recorded that no token movement occurred for this attempt.',
        guidance: 'A fresh action may use a new request key after this explicit no-movement result.',
        details,
      };
    }
    if (movementOutcome && movementOutcome !== 'unknown' && movementOutcome !== 'review') {
      return {
        category: 'operational',
        reasonLabel: 'Movement outcome',
        reason: `The backend recorded a ${movementOutcome} token movement outcome. Check the existing transaction and receipt before announcing completion.`,
        guidance: 'Preserve the original request and transaction hash while projection or receipt recovery is checked.',
        details,
      };
    }
    return {
      category: 'operational',
      reasonLabel: 'Recovery detail',
      reason: 'The operation failed or needs recovery. Preserve the original request while its outcome is checked.',
      details,
    };
  }

  return {
    category: 'activity',
    details,
  };
}

/**
 * Conservative spend release rule used by the admin simulator.  A failed
 * request keeps its original idempotency key unless the backend explicitly
 * proves that no token movement occurred.  The caller supplies true only from
 * a user-submitted retry/new action; this helper never schedules a retry.
 */
export function shouldReleaseSpendRequest(data: unknown, userInitiatedAction: boolean): boolean {
  const response = asRecord(data);
  return userInitiatedAction
    && response?.movementOutcome === 'no_movement'
    && response?.pending !== true
    && response?.requiresReview !== true;
}
