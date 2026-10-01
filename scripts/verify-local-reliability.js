/*
 * Read-only local reliability verification for the NEVERFLAT API.
 *
 * Run this only after the coordinator has restarted the local API on port
 * 3005. It reads credentials from the ignored repository .env file, never
 * prints them, and deliberately sends no financial or external-alert request.
 * The only POSTs are admin login/logout and side-effect-free CDR previews.
 */
'use strict';

const path = require('node:path');

require('dotenv').config({
  path: path.resolve(__dirname, '..', '.env'),
  quiet: true,
});

const BASE_URL = 'http://localhost:3005';
const MAX_AUDIT_LIMIT = 500;
const MAX_OPERATION_LIMIT = 100;

class VerificationFailure extends Error {
  constructor(label, message) {
    super(`${label}: ${message}`);
    this.name = 'VerificationFailure';
    this.label = label;
  }
}

function fail(label, message) {
  throw new VerificationFailure(label, message);
}

function ensure(condition, label, message) {
  if (!condition) fail(label, message);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parseCsv(value) {
  if (typeof value !== 'string' || !value.trim()) return [];
  return value
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

function sameMembers(actual, expected, label, description) {
  const actualSet = new Set(actual);
  const expectedSet = new Set(expected);
  ensure(actualSet.size === expectedSet.size, label, description);
  for (const value of expectedSet) {
    ensure(actualSet.has(value), label, description);
  }
}

function validateConfiguration() {
  ensure(BASE_URL === 'http://localhost:3005', 'configuration', 'base URL is not the permitted local API');
  ensure(typeof process.env.ADMIN_EMAIL === 'string' && process.env.ADMIN_EMAIL.trim(), 'configuration', 'ADMIN_EMAIL is required in the ignored .env file');
  ensure(typeof process.env.ADMIN_PASSWORD === 'string' && process.env.ADMIN_PASSWORD, 'configuration', 'ADMIN_PASSWORD is required in the ignored .env file');
  ensure(typeof process.env.API_KEY === 'string' && process.env.API_KEY, 'configuration', 'API_KEY is required in the ignored .env file');
  ensure(typeof process.env.INGEST_API_KEY === 'string' && process.env.INGEST_API_KEY, 'configuration', 'INGEST_API_KEY is required in the ignored .env file');
}

async function request(label, method, route, options = {}) {
  const headers = { Accept: 'application/json' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.apiKey) headers['X-API-Key'] = options.apiKey;
  if (options.ingestKey) headers['X-Ingest-API-Key'] = options.ingestKey;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${BASE_URL}${route}`, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      signal: controller.signal,
    });
    const text = await response.text();
    let body = null;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }
    return { label, method, route, status: response.status, body };
  } catch {
    fail(label, 'local API request failed');
  } finally {
    clearTimeout(timeout);
  }
}

function assertStatus(result, expected) {
  ensure(result.status === expected, result.label, `expected HTTP ${expected}, received HTTP ${result.status}`);
}

function safeCheckResult(result) {
  const body = isRecord(result.body) ? result.body : {};
  return {
    status: result.status,
    ...(typeof body.code === 'string' ? { code: body.code } : {}),
  };
}

async function login() {
  const result = await request('admin login', 'POST', '/admin/login', {
    body: {
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
    },
  });
  assertStatus(result, 200);
  ensure(isRecord(result.body) && result.body.status === 'ok', result.label, 'login did not return status ok');
  ensure(typeof result.body.token === 'string' && result.body.token.length > 0, result.label, 'login token was not returned');
  return result.body.token;
}

async function logout(token) {
  const result = await request('admin logout', 'POST', '/admin/logout', { token });
  assertStatus(result, 200);
  ensure(isRecord(result.body) && result.body.status === 'ok', result.label, 'logout was not acknowledged');
}

async function verifyUnauthenticatedAdminRoutes() {
  const routes = [
    ['unauthenticated audit', '/admin/audit?limit=1'],
    ['unauthenticated operations', '/admin/operations?scope=all&limit=1'],
    ['unauthenticated readiness', '/admin/readiness'],
    ['unauthenticated pilot metrics', '/admin/pilot-metrics?hours=24'],
    ['unauthenticated rules', '/admin/rules'],
  ];
  const checks = {};
  for (const [label, route] of routes) {
    const result = await request(label, 'GET', route);
    assertStatus(result, 401);
    checks[label] = safeCheckResult(result);
  }
  return checks;
}

function checkReadinessBody(result) {
  ensure(isRecord(result.body), result.label, 'readiness response is not an object');
  ensure(['ready', 'ready_with_warnings', 'not_ready'].includes(result.body.status), result.label, 'readiness status is invalid');
  ensure(Number.isInteger(result.body.failedCount) && result.body.failedCount >= 0, result.label, 'readiness failedCount is invalid');
  ensure(Number.isInteger(result.body.warningCount) && result.body.warningCount >= 0, result.label, 'readiness warningCount is invalid');
  ensure(Array.isArray(result.body.checks), result.label, 'readiness checks are missing');

  const seenKeys = new Set();
  for (const check of result.body.checks) {
    ensure(isRecord(check), result.label, 'readiness check is not an object');
    ensure(typeof check.key === 'string' && check.key.length > 0, result.label, 'readiness check key is missing');
    ensure(!seenKeys.has(check.key), result.label, 'readiness check keys are not unique');
    seenKeys.add(check.key);
    ensure(typeof check.label === 'string' && check.label.length > 0, result.label, `readiness label is missing for ${check.key}`);
    ensure(['pass', 'warn', 'fail'].includes(check.status), result.label, `readiness status is invalid for ${check.key}`);
    ensure(typeof check.message === 'string' && check.message.length > 0, result.label, `readiness message is missing for ${check.key}`);
  }

  const failed = result.body.checks.filter(check => check.status === 'fail');
  const warnings = result.body.checks.filter(check => check.status === 'warn');
  ensure(failed.length === result.body.failedCount, result.label, 'readiness failedCount does not match checks');
  ensure(warnings.length === result.body.warningCount, result.label, 'readiness warningCount does not match checks');

  const expectedFailures = parseCsv(process.env.LOCAL_RELIABILITY_EXPECTED_READINESS_FAILURE_KEYS);
  if (expectedFailures.length) {
    sameMembers(failed.map(check => check.key), expectedFailures, result.label, 'readiness failure keys differ from LOCAL_RELIABILITY_EXPECTED_READINESS_FAILURE_KEYS');
  } else {
    ensure(failed.length === 0, result.label, 'readiness has an unexpected failure; set LOCAL_RELIABILITY_EXPECTED_READINESS_FAILURE_KEYS only for an explicitly accepted local condition');
  }

  const expectedWarnings = parseCsv(process.env.LOCAL_RELIABILITY_EXPECTED_READINESS_WARNING_KEYS);
  if (expectedWarnings.length) {
    sameMembers(warnings.map(check => check.key), expectedWarnings, result.label, 'readiness warning keys differ from LOCAL_RELIABILITY_EXPECTED_READINESS_WARNING_KEYS');
  }

  return {
    httpStatus: result.status,
    status: result.body.status,
    failed: failed.map(check => ({ key: check.key, label: check.label, message: check.message })),
    warnings: warnings.map(check => ({ key: check.key, label: check.label, message: check.message })),
    passedCount: result.body.checks.filter(check => check.status === 'pass').length,
  };
}

async function verifyReadiness(token) {
  const result = await request('authenticated readiness', 'GET', '/admin/readiness', { token });
  ensure(result.status === 200 || result.status === 503, result.label, `expected HTTP 200 or 503, received HTTP ${result.status}`);
  return checkReadinessBody(result);
}

async function verifyHealth() {
  const result = await request('public health', 'GET', '/ingest/health');
  assertStatus(result, 200);
  ensure(isRecord(result.body) && result.body.status === 'ok', result.label, 'health status is not ok');
  ensure(typeof result.body.timestamp === 'string' && !Number.isNaN(Date.parse(result.body.timestamp)), result.label, 'health timestamp is invalid');
  return safeCheckResult(result);
}

async function verifyApiKeyBoundaries() {
  const payload = previewPayloads().ocpi;
  const noKeyWallet = await request('wallet without API key', 'GET', '/wallet/7');
  assertStatus(noKeyWallet, 401);
  const invalidKeyWallet = await request('wallet with invalid API key', 'GET', '/wallet/7', {
    apiKey: 'invalid-local-api-key',
  });
  assertStatus(invalidKeyWallet, 403);

  const noKeyPreview = await request('preview without ingest API key', 'POST', '/ingest/cdr/preview', {
    body: payload,
  });
  assertStatus(noKeyPreview, 401);
  const invalidKeyPreview = await request('preview with invalid ingest API key', 'POST', '/ingest/cdr/preview', {
    ingestKey: 'invalid-local-ingest-key',
    body: payload,
  });
  assertStatus(invalidKeyPreview, 403);

  return {
    walletWithoutKey: safeCheckResult(noKeyWallet),
    walletWithInvalidKey: safeCheckResult(invalidKeyWallet),
    previewWithoutKey: safeCheckResult(noKeyPreview),
    previewWithInvalidKey: safeCheckResult(invalidKeyPreview),
  };
}

async function verifyAdminBearerWallet(token) {
  const result = await request('admin bearer wallet lookup', 'GET', '/wallet/7', { token });
  assertStatus(result, 200);
  ensure(isRecord(result.body), result.label, 'admin bearer wallet response is not an object');
  ensure(result.body.status === 'success', result.label, 'admin bearer wallet response is not successful');
  ensure(typeof result.body.uid === 'string', result.label, 'admin bearer wallet eMAID field is missing');
  ensure(Array.isArray(result.body.contractIds), result.label, 'admin bearer wallet contractIds field is missing');
  ensure(Array.isArray(result.body.linkedWalletAddresses), result.label, 'admin bearer wallet linked-wallet field is missing');
  ensure(Array.isArray(result.body.history), result.label, 'admin bearer wallet history field is missing');
  ensure(typeof result.body.isRegistered === 'boolean', result.label, 'admin bearer wallet registration field is missing');
  ensure(typeof result.body.balance === 'string', result.label, 'admin bearer wallet balance field is missing');
  return { status: result.status, shapeValid: true };
}

async function verifyPilotMetrics(token) {
  const result = await request('authenticated pilot metrics', 'GET', '/admin/pilot-metrics?hours=24', { token });
  assertStatus(result, 200);
  ensure(isRecord(result.body) && result.body.status === 'ok' && isRecord(result.body.metrics), result.label, 'metrics response is not usable');
  const metrics = result.body.metrics;
  ensure(metrics.windowHours === 24, result.label, 'metrics window is not 24 hours');
  ensure(Number.isInteger(metrics.totalEvents) && metrics.totalEvents >= 0, result.label, 'metrics totalEvents is invalid');
  ensure(typeof metrics.generatedAt === 'string' && !Number.isNaN(Date.parse(metrics.generatedAt)), result.label, 'metrics generatedAt is invalid');
  ensure(isRecord(metrics.eventTypes), result.label, 'metrics eventTypes are missing');
  for (const key of ['awards', 'spends', 'operations']) {
    ensure(isRecord(metrics[key]), result.label, `metrics ${key} summary is missing`);
  }
  return {
    status: result.status,
    windowHours: metrics.windowHours,
    totalEvents: metrics.totalEvents,
    lastEventAt: metrics.lastEventAt || null,
  };
}

const SAFE_AUDIT_EVENT_KEYS = new Set([
  'id',
  'event_type',
  'actor_type',
  'actor_id',
  'target_type',
  'target_id',
  'status',
  'created_at',
  'presentation',
]);
const SAFE_PRESENTATION_KEYS = new Set(['category', 'reasonLabel', 'reason', 'guidance', 'details']);
const SAFE_DETAIL_KEYS = new Set(['label', 'value']);
const RAW_AUDIT_KEYS = new Set(['metadata', 'error', 'rawError', 'raw_error', 'payload', 'cdr', 'intentContext', 'intent_context']);

function assertAllowedKeys(value, allowed, label) {
  for (const key of Object.keys(value)) {
    ensure(allowed.has(key), label, `unexpected response field ${key}`);
  }
}

function assertNoRawAuditKeys(value, label, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoRawAuditKeys(item, `${label}[${index}]`, seen));
    return;
  }
  for (const [key, nested] of Object.entries(value)) {
    ensure(!RAW_AUDIT_KEYS.has(key), label, `raw audit field ${key} is exposed`);
    assertNoRawAuditKeys(nested, `${label}.${key}`, seen);
  }
}

function checkSafeAuditBody(result) {
  assertStatus(result, 200);
  ensure(isRecord(result.body) && result.body.status === 'ok', result.label, 'audit response is not ok');
  ensure(Number.isInteger(result.body.count) && result.body.count >= 0, result.label, 'audit count is invalid');
  ensure(Array.isArray(result.body.events), result.label, 'audit events are missing');
  ensure(result.body.count === result.body.events.length, result.label, 'audit count does not match events');

  const statusCounts = {};
  for (const event of result.body.events) {
    ensure(isRecord(event), result.label, 'audit event is not an object');
    assertAllowedKeys(event, SAFE_AUDIT_EVENT_KEYS, result.label);
    ensure(typeof event.event_type === 'string' && event.event_type.length > 0, result.label, 'audit event type is missing');
    ensure(typeof event.status === 'string' && event.status.length > 0, result.label, 'audit event status is missing');
    statusCounts[event.status] = (statusCounts[event.status] || 0) + 1;
    if (event.presentation !== undefined) {
      ensure(isRecord(event.presentation), result.label, 'audit presentation is not an object');
      assertAllowedKeys(event.presentation, SAFE_PRESENTATION_KEYS, result.label);
      if (event.presentation.details !== undefined) {
        ensure(Array.isArray(event.presentation.details), result.label, 'audit presentation details are not an array');
        for (const detail of event.presentation.details) {
          ensure(isRecord(detail), result.label, 'audit presentation detail is not an object');
          assertAllowedKeys(detail, SAFE_DETAIL_KEYS, result.label);
        }
      }
    }
  }
  assertNoRawAuditKeys(result.body, result.label);
  return { status: result.status, count: result.body.count, statusCounts };
}

async function verifyAudit(token) {
  const result = await request('authenticated full audit', 'GET', `/admin/audit?limit=${MAX_AUDIT_LIMIT}`, { token });
  return checkSafeAuditBody(result);
}

const SAFE_OPERATION_KEYS = new Set([
  'id',
  'operationKey',
  'operationType',
  'eMAID',
  'walletAddress',
  'amount',
  'sessionId',
  'providerId',
  'reservationId',
  'status',
  'movementOutcome',
  'transactionHash',
  'errorMessage',
  'submittedAt',
  'confirmedAt',
  'projectedAt',
  'createdAt',
  'updatedAt',
  'nextAction',
]);
const SAFE_OPERATION_ERROR_CATEGORIES = new Set([
  'Preflight check failed',
  'Reservation operation failed',
  'Approval preparation requires review',
  'Legacy operation requires review',
  'Chain outcome requires review',
  'Award confirmed; original CDR unavailable for projection',
  'Operation failed; review the operation state',
]);

async function verifyOperations(token) {
  const result = await request('authenticated operations state', 'GET', `/admin/operations?scope=all&limit=${MAX_OPERATION_LIMIT}`, { token });
  assertStatus(result, 200);
  ensure(isRecord(result.body) && result.body.status === 'ok', result.label, 'operations response is not ok');
  ensure(Number.isInteger(result.body.count) && result.body.count >= 0, result.label, 'operations count is invalid');
  ensure(Number.isInteger(result.body.total) && result.body.total >= 0, result.label, 'operations total is invalid');
  ensure(Array.isArray(result.body.operations), result.label, 'operations list is missing');
  ensure(result.body.operations.length === result.body.count, result.label, 'operations count does not match list');
  ensure(result.body.limit === MAX_OPERATION_LIMIT, result.label, 'operations limit was not applied');

  const statuses = {};
  const movementOutcomes = {};
  for (const operation of result.body.operations) {
    ensure(isRecord(operation), result.label, 'operation row is not an object');
    assertAllowedKeys(operation, SAFE_OPERATION_KEYS, result.label);
    ensure(typeof operation.eMAID === 'string', result.label, 'operation eMAID is missing');
    ensure(typeof operation.nextAction === 'string' && operation.nextAction.length > 0, result.label, 'operation next action is missing');
    ensure(typeof operation.status === 'string', result.label, 'operation status is missing');
    ensure(typeof operation.movementOutcome === 'string', result.label, 'operation movement outcome is missing');
    if (operation.errorMessage !== null) {
      ensure(SAFE_OPERATION_ERROR_CATEGORIES.has(operation.errorMessage), result.label, 'operation error category is not allowlisted');
    }
    statuses[operation.status] = (statuses[operation.status] || 0) + 1;
    movementOutcomes[operation.movementOutcome] = (movementOutcomes[operation.movementOutcome] || 0) + 1;
  }

  return {
    status: result.status,
    count: result.body.count,
    total: result.body.total,
    hasMore: result.body.hasMore,
    statuses,
    movementOutcomes,
  };
}

function basePreviewFields(sessionId) {
  return {
    SessionID: sessionId,
    ProviderID: 'reliability-verifier',
    EVSEID: 'DE*NVF*RELIABILITY01',
    StartTime: '2026-09-22T23:00:00.000Z',
    EndTime: '2026-09-23T00:00:00.000Z',
    Energy: '2.5',
    EnergyDirection: 'CHARGE',
  };
}

function previewPayloads() {
  return {
    ocpi: {
      id: 'reliability-ocpi-preview',
      country_code: 'DE',
      party_id: 'NVF',
      start_date_time: '2026-09-22T23:00:00.000Z',
      end_date_time: '2026-09-23T00:00:00.000Z',
      cdr_token: {
        country_code: 'DE',
        party_id: 'NVF',
        uid: 'RFID-RELIABILITY-OCPI',
        type: 'RFID',
        contract_id: 'DE*NVF*RELIABILITY-OCPI',
      },
      cdr_location: { evse_id: 'DE*NVF*RELIABILITY-OCPI' },
      total_energy: '2.5',
    },
    oicp: {
      ...basePreviewFields('reliability-oicp-preview'),
      ChargingStart: '2026-09-22T23:00:00.000Z',
      ChargingEnd: '2026-09-23T00:00:00.000Z',
      ConsumedEnergy: '2.5',
      Identification: {
        RemoteIdentification: { EvcoID: 'DE*NVF*RELIABILITY-OICP' },
      },
    },
    uidOnly: {
      ...basePreviewFields('reliability-uid-only-preview'),
      UID: 'RFID-RELIABILITY-ONLY',
    },
    conflicting: {
      ...basePreviewFields('reliability-conflicting-preview'),
      cdr_token: { contract_id: 'DE*NVF*RELIABILITY-OCPI-CONFLICT' },
      Identification: {
        RemoteIdentification: { EvcoID: 'DE*NVF*RELIABILITY-OICP-CONFLICT' },
      },
    },
  };
}

async function verifyValidPreview(label, payload, expected) {
  const result = await request(label, 'POST', '/ingest/cdr/preview', {
    ingestKey: process.env.INGEST_API_KEY,
    body: payload,
  });
  assertStatus(result, 200);
  ensure(isRecord(result.body) && result.body.status === 'preview', result.label, 'preview status is invalid');
  ensure(result.body.sideEffects === false, result.label, 'preview did not declare sideEffects=false');
  ensure(isRecord(result.body.normalisation), result.label, 'preview normalisation is missing');
  ensure(result.body.normalisation.protocol === expected.protocol, result.label, 'preview protocol detection is incorrect');
  ensure(result.body.normalisation.sourceField === expected.sourceField, result.label, 'preview source identity field is incorrect');
  ensure(result.body.normalisation.eMAID === expected.eMAID, result.label, 'preview eMAID is incorrect');
  ensure(isRecord(result.body.normalised), result.label, 'preview normalised payload is missing');
  ensure(result.body.normalised.eMAID === expected.eMAID, result.label, 'preview normalised eMAID is incorrect');
  return {
    status: result.status,
    protocol: result.body.normalisation.protocol,
    sourceField: result.body.normalisation.sourceField,
    eMAID: result.body.normalisation.eMAID,
    sideEffects: result.body.sideEffects,
  };
}

async function verifyRejectedPreview(label, payload, expected) {
  const result = await request(label, 'POST', '/ingest/cdr/preview', {
    ingestKey: process.env.INGEST_API_KEY,
    body: payload,
  });
  assertStatus(result, 400);
  ensure(isRecord(result.body) && result.body.status === 'error' && result.body.code === 'INVALID_CDR', result.label, 'preview rejection envelope is invalid');
  const normalisationError = result.body.normalisationError;
  ensure(isRecord(normalisationError), result.label, 'structured normalisation error is missing');
  ensure(normalisationError.code === expected.code, result.label, 'normalisation error code is incorrect');
  ensure(normalisationError.protocol === expected.protocol, result.label, 'normalisation error protocol is incorrect');
  ensure(Array.isArray(normalisationError.sourceFields), result.label, 'normalisation error source fields are missing');
  for (const sourceField of expected.sourceFields) {
    ensure(normalisationError.sourceFields.includes(sourceField), result.label, `normalisation error omitted ${sourceField}`);
  }
  return {
    status: result.status,
    code: normalisationError.code,
    protocol: normalisationError.protocol,
    sourceFields: normalisationError.sourceFields,
  };
}

async function verifyPreviewNormalisation() {
  const payloads = previewPayloads();
  return {
    ocpi: await verifyValidPreview('valid OCPI preview', payloads.ocpi, {
      protocol: 'OCPI',
      sourceField: 'cdr_token.contract_id',
      eMAID: 'DE*NVF*RELIABILITY-OCPI',
    }),
    oicp: await verifyValidPreview('valid OICP preview', payloads.oicp, {
      protocol: 'OICP',
      sourceField: 'Identification.RemoteIdentification.EvcoID',
      eMAID: 'DE*NVF*RELIABILITY-OICP',
    }),
    uidOnly: await verifyRejectedPreview('UID-only preview rejection', payloads.uidOnly, {
      code: 'UID_ONLY',
      protocol: 'OICP',
      sourceFields: ['UID'],
    }),
    conflicting: await verifyRejectedPreview('conflicting identity preview rejection', payloads.conflicting, {
      code: 'CONFLICTING_IDENTIFIERS',
      protocol: 'MIXED',
      sourceFields: ['cdr_token.contract_id', 'Identification.RemoteIdentification.EvcoID'],
    }),
  };
}

async function run() {
  validateConfiguration();
  const result = {
    script: 'verify-local-reliability.js',
    baseUrl: BASE_URL,
    configuration: {
      adminCredentialsConfigured: true,
      apiKeyConfigured: true,
      ingestApiKeyConfigured: true,
    },
    scope: {
      financialRequestsSent: false,
      externalAlertRequestsSent: false,
      previewRequestsAreSideEffectFree: true,
    },
    checks: {},
  };

  result.checks.health = await verifyHealth();
  result.checks.apiKeyBoundaries = await verifyApiKeyBoundaries();
  result.checks.unauthenticatedAdminRoutes = await verifyUnauthenticatedAdminRoutes();

  let token = null;
  let failure = null;
  try {
    token = await login();
    result.checks.login = { status: 200 };
    result.checks.adminBearerWallet = await verifyAdminBearerWallet(token);
    result.checks.readiness = await verifyReadiness(token);
    result.checks.metrics = await verifyPilotMetrics(token);
    result.checks.audit = await verifyAudit(token);
    result.checks.operations = await verifyOperations(token);
    result.checks.previewNormalisation = await verifyPreviewNormalisation();
  } catch (error) {
    failure = error;
  } finally {
    if (token) {
      try {
        await logout(token);
        result.checks.logout = { status: 200 };
      } catch (error) {
        result.checks.logout = { status: 'failed' };
        if (!failure) failure = new VerificationFailure('admin logout', 'logout failed');
      }
    }
  }

  if (failure) {
    result.ok = false;
    result.error = failure instanceof VerificationFailure ? failure.message : 'verification failed';
    return result;
  }
  result.ok = true;
  return result;
}

async function main() {
  try {
    const result = await run();
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({
      script: 'verify-local-reliability.js',
      baseUrl: BASE_URL,
      ok: false,
      error: error instanceof VerificationFailure ? error.message : 'verification failed',
    }, null, 2));
    process.exitCode = 1;
  }
}

void main();
