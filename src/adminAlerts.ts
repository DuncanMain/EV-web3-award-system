import type { Knex } from 'knex';
import { getDatabase } from './database/connection';

/**
 * Alert delivery is deliberately configured as data plus environment-only
 * provider credentials.  The admin API can change the recipient and channel,
 * but it can never read or write a provider secret.
 */
export const ADMIN_ALERT_SETTINGS_TABLE = 'admin_alert_settings';
export const ADMIN_ALERT_SETTINGS_ROW_ID = 1;
/** Used only when an operator has not supplied a recipient during migration. */
export const DEFAULT_ADMIN_ALERT_RECIPIENT = 'admin@example.com';
export const DEFAULT_ADMIN_ALERT_CHANNEL: AdminAlertChannel = 'email';
const SENDGRID_MAIL_SEND_URL = 'https://api.sendgrid.com/v3/mail/send';
const MAX_METADATA_LENGTH = 8_000;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type AdminAlertChannel = 'email' | 'webhook' | 'both' | 'disabled';

/**
 * Migration defaults are configuration driven. A pre-existing webhook keeps
 * working after the additive table is introduced; a fresh deployment starts
 * with email selected and waits for a verified SendGrid sender/key.
 */
export function getDefaultAdminAlertRecipient(): string {
  for (const configured of [
    process.env.ADMIN_ALERT_RECIPIENT,
    process.env.ADMIN_EMAIL,
    process.env.BEIA_ADMIN_EMAIL,
  ]) {
    const normalized = configured?.trim().toLowerCase();
    if (normalized && isEmailAddress(normalized)) return normalized;
  }
  return DEFAULT_ADMIN_ALERT_RECIPIENT;
}

export function getDefaultAdminAlertChannel(): AdminAlertChannel {
  const configured = process.env.ADMIN_ALERT_CHANNEL?.trim();
  if (configured === 'email' || configured === 'webhook' || configured === 'both' || configured === 'disabled') {
    return configured;
  }
  // Existing webhook-only deployments keep their established delivery mode.
  // Email becomes the default only when no legacy webhook is configured.
  return process.env.ADMIN_ALERT_WEBHOOK_URL?.trim() ? 'webhook' : DEFAULT_ADMIN_ALERT_CHANNEL;
}

export interface AdminAlertSettings {
  recipientEmail: string;
  channel: AdminAlertChannel;
  updatedAt: string;
}

export interface AdminAlertSettingsRow {
  id: number | string;
  recipient_email: string;
  channel: string;
  updated_at: Date | string;
}

export interface AdminAlertSettingsPatch {
  recipientEmail?: unknown;
  channel?: unknown;
}

export interface AdminAlertSettingsRepository {
  get(): Promise<AdminAlertSettingsRow | undefined>;
  update(patch: { recipientEmail?: string; channel?: AdminAlertChannel }): Promise<AdminAlertSettingsRow | undefined>;
}

export interface AdminAlertProviderStatus {
  configured: boolean;
  provider: 'sendgrid';
  apiKeyConfigured: boolean;
  fromConfigured: boolean;
  acceptedStatus: 202;
  acceptanceMeaning: 'provider_accepted';
}

export interface AdminAlertConfiguration {
  settings: AdminAlertSettings;
  email: AdminAlertProviderStatus;
  webhook: {
    configured: boolean;
  };
  canDeliver: boolean;
  configurationIssue?: 'selected_channel_provider_incomplete' | null;
  deliveryNote: 'provider_acceptance_is_not_inbox_delivery';
}

export interface AdminAlertEvent {
  eventType: string;
  actorType: string;
  actorId?: string | null;
  targetType?: string | null;
  targetId?: string | null;
  status: string;
  metadata?: Record<string, unknown>;
}

/** Decide which audit events should enqueue an alert without recursing. */
export function shouldAlertAdminEvent(data: Pick<AdminAlertEvent, 'eventType' | 'status'>): boolean {
  if (data.eventType.startsWith('admin_alert.')) return false;
  if (data.status === 'warning' || data.status === 'retry_required' || data.status === 'requires_review') return true;
  return data.status === 'error' && (
    data.eventType.includes('failed')
    || data.eventType.includes('unhandled_error')
    || data.eventType === 'reconciliation.balance_run'
  );
}

export type AdminAlertDeliveryReason =
  | 'alert_channel_disabled'
  | 'email_provider_not_configured'
  | 'webhook_not_configured'
  | 'request_failed'
  | 'redirect_blocked'
  | 'non_success_response'
  | 'settings_unavailable';

export interface AdminAlertChannelDelivery {
  channel: 'email' | 'webhook';
  status: 'accepted' | 'skipped' | 'failed';
  provider?: 'sendgrid' | 'webhook';
  httpStatus?: number;
  reason?: AdminAlertDeliveryReason;
  acceptanceMeaning?: 'provider_accepted';
}

export interface AdminAlertDeliveryResult {
  status: 'sent' | 'delivery_skipped' | 'delivery_failed';
  providerAccepted: boolean;
  partialFailure: boolean;
  channels: AdminAlertChannelDelivery[];
}

export class AdminAlertSettingsError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'AdminAlertSettingsError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isEmailAddress(value: unknown): value is string {
  return typeof value === 'string'
    && value.length <= 320
    && EMAIL_PATTERN.test(value);
}

export function normalizeAdminAlertEmail(value: unknown): string {
  if (typeof value !== 'string') {
    throw new AdminAlertSettingsError('INVALID_ADMIN_ALERT_RECIPIENT', 'recipientEmail must be a valid email address');
  }
  const normalized = value.trim().toLowerCase();
  if (!isEmailAddress(normalized)) {
    throw new AdminAlertSettingsError('INVALID_ADMIN_ALERT_RECIPIENT', 'recipientEmail must be a valid email address');
  }
  return normalized;
}

export function parseAdminAlertChannel(value: unknown): AdminAlertChannel {
  if (value === 'email' || value === 'webhook' || value === 'both' || value === 'disabled') {
    return value;
  }
  throw new AdminAlertSettingsError(
    'INVALID_ADMIN_ALERT_CHANNEL',
    'channel must be email, webhook, both, or disabled',
  );
}

export function validateAdminAlertSettingsPatch(body: unknown): { recipientEmail?: string; channel?: AdminAlertChannel } {
  if (!isRecord(body)) {
    throw new AdminAlertSettingsError('INVALID_ADMIN_ALERT_SETTINGS_BODY', 'Alert settings must be an object');
  }
  const keys = Object.keys(body);
  const allowed = new Set(['recipientEmail', 'channel']);
  const unknown = keys.filter(key => !allowed.has(key));
  if (unknown.length > 0) {
    throw new AdminAlertSettingsError('INVALID_ADMIN_ALERT_SETTINGS_FIELD', `Unsupported alert setting field(s): ${unknown.join(', ')}`);
  }
  if (keys.length === 0) {
    throw new AdminAlertSettingsError('INVALID_ADMIN_ALERT_SETTINGS_BODY', 'Provide recipientEmail or channel');
  }
  return {
    ...(Object.prototype.hasOwnProperty.call(body, 'recipientEmail')
      ? { recipientEmail: normalizeAdminAlertEmail(body.recipientEmail) }
      : {}),
    ...(Object.prototype.hasOwnProperty.call(body, 'channel')
      ? { channel: parseAdminAlertChannel(body.channel) }
      : {}),
  };
}

function isoUpdatedAt(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) {
    throw new AdminAlertSettingsError('INVALID_ADMIN_ALERT_SETTINGS', 'Persisted alert settings have an invalid timestamp');
  }
  return date.toISOString();
}

function settingsFromRow(row: AdminAlertSettingsRow | undefined): AdminAlertSettings | undefined {
  if (!row) return undefined;
  return {
    recipientEmail: normalizeAdminAlertEmail(row.recipient_email),
    channel: parseAdminAlertChannel(row.channel),
    updatedAt: isoUpdatedAt(row.updated_at),
  };
}

function createKnexRepository(database: Knex): AdminAlertSettingsRepository {
  return {
    async get(): Promise<AdminAlertSettingsRow | undefined> {
      return database(ADMIN_ALERT_SETTINGS_TABLE)
        .where({ id: ADMIN_ALERT_SETTINGS_ROW_ID })
        .first() as Promise<AdminAlertSettingsRow | undefined>;
    },
    async update(patch): Promise<AdminAlertSettingsRow | undefined> {
      return database.transaction(async trx => {
        const current = await trx(ADMIN_ALERT_SETTINGS_TABLE)
          .where({ id: ADMIN_ALERT_SETTINGS_ROW_ID })
          .forUpdate()
          .first() as AdminAlertSettingsRow | undefined;
        if (!current) {
          throw new AdminAlertSettingsError(
            'ADMIN_ALERT_SETTINGS_NOT_INITIALIZED',
            'Admin alert settings are not initialized; run the additive database migration',
          );
        }
        const currentSettings = settingsFromRow(current);
        if (!currentSettings) {
          throw new AdminAlertSettingsError('INVALID_ADMIN_ALERT_SETTINGS', 'Admin alert settings are missing');
        }
        const [updated] = await trx(ADMIN_ALERT_SETTINGS_TABLE)
          .where({ id: ADMIN_ALERT_SETTINGS_ROW_ID })
          .update({
            recipient_email: patch.recipientEmail || currentSettings.recipientEmail,
            channel: patch.channel || currentSettings.channel,
            updated_at: trx.fn.now(),
          })
          .returning('*') as AdminAlertSettingsRow[];
        return updated;
      });
    },
  };
}

function asRepository(source: Knex | AdminAlertSettingsRepository): AdminAlertSettingsRepository {
  return typeof source === 'function' ? createKnexRepository(source) : source;
}

/** Build a repository around a supplied database or a small test double. */
export function createAdminAlertSettingsRepository(source: Knex | AdminAlertSettingsRepository): AdminAlertSettingsRepository {
  return asRepository(source);
}

export async function loadAdminAlertSettings(
  source: Knex | AdminAlertSettingsRepository = getDatabase(),
): Promise<AdminAlertSettings> {
  const settings = settingsFromRow(await asRepository(source).get());
  if (!settings) {
    throw new AdminAlertSettingsError(
      'ADMIN_ALERT_SETTINGS_NOT_INITIALIZED',
      'Admin alert settings are not initialized; run the additive database migration',
    );
  }
  return settings;
}

export async function updateAdminAlertSettings(
  body: unknown,
  source: Knex | AdminAlertSettingsRepository = getDatabase(),
): Promise<AdminAlertSettings> {
  const patch = validateAdminAlertSettingsPatch(body);
  const updated = await asRepository(source).update(patch);
  const settings = settingsFromRow(updated);
  if (!settings) {
    throw new AdminAlertSettingsError('ADMIN_ALERT_SETTINGS_WRITE_FAILED', 'Admin alert settings could not be saved');
  }
  return settings;
}

function providerStatus(): AdminAlertProviderStatus {
  const apiKeyConfigured = Boolean(process.env.SENDGRID_API_KEY?.trim());
  const fromConfigured = Boolean(process.env.ADMIN_ALERT_EMAIL_FROM && isEmailAddress(process.env.ADMIN_ALERT_EMAIL_FROM.trim().toLowerCase()));
  return {
    configured: apiKeyConfigured && fromConfigured,
    provider: 'sendgrid',
    apiKeyConfigured,
    fromConfigured,
    acceptedStatus: 202,
    acceptanceMeaning: 'provider_accepted',
  };
}

export async function getAdminAlertConfiguration(
  source: Knex | AdminAlertSettingsRepository = getDatabase(),
): Promise<AdminAlertConfiguration> {
  const settings = await loadAdminAlertSettings(source);
  const email = providerStatus();
  const webhook = { configured: Boolean(process.env.ADMIN_ALERT_WEBHOOK_URL?.trim()) };
  const configurationIssue = settings.channel === 'both'
    && !(email.configured && webhook.configured)
    ? 'selected_channel_provider_incomplete' as const
    : null;
  const canDeliver = settings.channel === 'disabled'
    ? false
    : settings.channel === 'email'
      ? email.configured
      : settings.channel === 'webhook'
        ? webhook.configured
        : email.configured && webhook.configured;
  return {
    settings,
    email,
    webhook,
    canDeliver,
    configurationIssue,
    deliveryNote: 'provider_acceptance_is_not_inbox_delivery',
  };
}

const SAFE_METADATA_KEYS = new Set([
  'amount',
  'requestedAmount',
  'eMAID',
  'emaid',
  'contractId',
  'contract_id',
  'sessionId',
  'providerId',
  'operationKey',
  'reservationId',
  'txHash',
  'transactionHash',
  'awardTxHash',
  'reservationTxHash',
  'fundingTxHash',
  'funding_tx_hash',
  'receiptId',
  'stage',
  'failureStage',
  'failure_stage',
  'movementOutcome',
  'movement_outcome',
  'errorCode',
  'error_code',
  'protocol',
  'sourceField',
  'energyDirection',
  'requestedAt',
]);

const SAFE_DIAGNOSTIC_KEYS = new Set([
  'stage',
  'rpcMethod',
  'rpcCode',
  'providerCode',
  'httpStatus',
  'traceId',
  'requestId',
  'rpcEndpoint',
  'endpointLabel',
  'savedHash',
  'nonce',
  'retryable',
  'errorCode',
]);

function safeScalar(value: unknown): string | number | boolean | null {
  if (typeof value === 'string') {
    return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 180);
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value === null) return value;
  return null;
}

function safeDiagnostic(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!SAFE_DIAGNOSTIC_KEYS.has(key)) continue;
    const safe = safeScalar(item);
    if (safe !== null || item === null) result[key] = safe;
  }
  return Object.keys(result).length ? result : null;
}

function safeMetadata(metadata: Record<string, unknown> | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata || {})) {
    if (key === 'diagnostic' || key === 'diagnostics' || key === 'diagnostic_context') {
      const diagnostic = safeDiagnostic(value);
      if (diagnostic) result.diagnostic = diagnostic;
      continue;
    }
    if (!SAFE_METADATA_KEYS.has(key)) continue;
    const safe = safeScalar(value);
    if (safe !== null || value === null) result[key] = safe;
  }
  const encoded = JSON.stringify(result);
  if (encoded.length <= MAX_METADATA_LENGTH) return result;
  return { notice: 'Alert metadata truncated for privacy' };
}

function alertPayload(data: AdminAlertEvent, recipient: string): Record<string, unknown> {
  return {
    to: recipient,
    subject: `NEVERFLAT ${data.status}: ${data.eventType}`,
    eventType: data.eventType,
    status: data.status,
    actorType: data.actorType,
    actorId: data.actorId || null,
    targetType: data.targetType || null,
    targetId: data.targetId || null,
    metadata: safeMetadata(data.metadata),
    createdAt: new Date().toISOString(),
  };
}

function textBody(payload: Record<string, unknown>): string {
  return [
    'NEVERFLAT admin alert',
    `Event: ${String(payload.eventType)}`,
    `Status: ${String(payload.status)}`,
    `Target: ${String(payload.targetType || 'none')} ${String(payload.targetId || '')}`.trim(),
    `Created: ${String(payload.createdAt)}`,
    `Metadata: ${JSON.stringify(payload.metadata)}`,
  ].join('\n');
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Provider response content is intentionally discarded and never affects
    // the delivery classification.
  }
}

async function sendSendGridEmail(data: AdminAlertEvent, recipient: string): Promise<AdminAlertChannelDelivery> {
  const email = providerStatus();
  if (!email.configured) {
    return { channel: 'email', status: 'skipped', provider: 'sendgrid', reason: 'email_provider_not_configured' };
  }
  const from = process.env.ADMIN_ALERT_EMAIL_FROM!.trim().toLowerCase();
  const payload = alertPayload(data, recipient);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(SENDGRID_MAIL_SEND_URL, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Authorization: `Bearer ${process.env.SENDGRID_API_KEY!.trim()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        personalizations: [{ to: [{ email: recipient }] }],
        from: { email: from },
        subject: String(payload.subject),
        content: [{ type: 'text/plain', value: textBody(payload) }],
      }),
      signal: controller.signal,
    });
    await discardResponseBody(response);
    if (response.status >= 300 && response.status < 400) {
      return { channel: 'email', status: 'failed', provider: 'sendgrid', httpStatus: response.status, reason: 'redirect_blocked' };
    }
    if (response.status === 202) {
      return {
        channel: 'email',
        status: 'accepted',
        provider: 'sendgrid',
        httpStatus: response.status,
        acceptanceMeaning: 'provider_accepted',
      };
    }
    return { channel: 'email', status: 'failed', provider: 'sendgrid', httpStatus: response.status, reason: 'non_success_response' };
  } catch {
    return { channel: 'email', status: 'failed', provider: 'sendgrid', reason: 'request_failed' };
  } finally {
    clearTimeout(timeout);
  }
}

async function sendWebhook(data: AdminAlertEvent, recipient: string): Promise<AdminAlertChannelDelivery> {
  const rawUrl = process.env.ADMIN_ALERT_WEBHOOK_URL?.trim();
  if (!rawUrl) {
    return { channel: 'webhook', status: 'skipped', provider: 'webhook', reason: 'webhook_not_configured' };
  }
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { channel: 'webhook', status: 'failed', provider: 'webhook', reason: 'request_failed' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { channel: 'webhook', status: 'failed', provider: 'webhook', reason: 'request_failed' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5_000);
  try {
    const response = await fetch(parsed, {
      method: 'POST',
      redirect: 'manual',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(alertPayload(data, recipient)),
      signal: controller.signal,
    });
    await discardResponseBody(response);
    if (response.status >= 300 && response.status < 400) {
      return { channel: 'webhook', status: 'failed', provider: 'webhook', httpStatus: response.status, reason: 'redirect_blocked' };
    }
    return response.ok
      ? { channel: 'webhook', status: 'accepted', provider: 'webhook', httpStatus: response.status }
      : { channel: 'webhook', status: 'failed', provider: 'webhook', httpStatus: response.status, reason: 'non_success_response' };
  } catch {
    return { channel: 'webhook', status: 'failed', provider: 'webhook', reason: 'request_failed' };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Dispatch one safe alert through the configured channel(s). A SendGrid 202
 * means the provider accepted the message; it does not prove inbox delivery.
 */
export async function dispatchAdminAlert(
  data: AdminAlertEvent,
  source: Knex | AdminAlertSettingsRepository = getDatabase(),
): Promise<AdminAlertDeliveryResult> {
  let configuration: AdminAlertConfiguration;
  try {
    configuration = await getAdminAlertConfiguration(source);
  } catch {
    return {
      status: 'delivery_skipped',
      providerAccepted: false,
      partialFailure: false,
      channels: [{ channel: 'email', status: 'skipped', reason: 'settings_unavailable' }],
    };
  }
  if (configuration.settings.channel === 'disabled') {
    return {
      status: 'delivery_skipped',
      providerAccepted: false,
      partialFailure: false,
      channels: [{ channel: 'email', status: 'skipped', reason: 'alert_channel_disabled' }],
    };
  }
  const channels: AdminAlertChannelDelivery[] = [];
  if (configuration.settings.channel === 'email' || configuration.settings.channel === 'both') {
    channels.push(await sendSendGridEmail(data, configuration.settings.recipientEmail));
  }
  if (configuration.settings.channel === 'webhook' || configuration.settings.channel === 'both') {
    channels.push(await sendWebhook(data, configuration.settings.recipientEmail));
  }
  const accepted = channels.filter(channel => channel.status === 'accepted');
  const failed = channels.filter(channel => channel.status === 'failed');
  const skipped = channels.filter(channel => channel.status === 'skipped');
  return {
    status: failed.length > 0 ? 'delivery_failed' : accepted.length > 0 ? 'sent' : 'delivery_skipped',
    providerAccepted: accepted.length > 0,
    partialFailure: (failed.length > 0 || skipped.length > 0) && accepted.length > 0,
    channels,
  };
}
