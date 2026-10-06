'use strict';

/*
 * Exhaustive local HTTP matrix. It starts only disposable PostgreSQL,
 * Hardhat, API, and alert-webhook resources and writes safe summaries.
 */
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('pg');
const routeInventory = require('./verify-api-route-inventory.js');
const harness = require('./verify-local-award-flow.js');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'outputs');
const RUN = new Date().toISOString().replace(/[:.]/g, '-');
const JSON_FILE = path.join(OUT, 'admin-api-matrix-' + RUN + '.json');
const MD_FILE = path.join(OUT, 'admin-api-matrix-' + RUN + '.md');
const JSON_LATEST = path.join(OUT, 'admin-api-matrix-latest.json');
const MD_LATEST = path.join(OUT, 'admin-api-matrix-latest.md');

const API_KEY = harness.API_KEY;
const INGEST_KEY = harness.INGEST_API_KEY;
const UID = harness.UID;
const PROVIDER = harness.PROVIDER_ID;
const EVSE = harness.EVSE_ID;
const ADMIN_EMAIL = harness.ADMIN_EMAIL;
const ADMIN_PASSWORD = harness.ADMIN_PASSWORD;

const ADMIN_ROUTES = [
  ['POST', '/admin/logout'], ['GET', '/admin/rules'], ['PUT', '/admin/rules'],
  ['GET', '/admin/off-peak'], ['PUT', '/admin/off-peak'],
  ['DELETE', '/admin/off-peak/FR'], ['GET', '/admin/audit'],
  ['GET', '/admin/pilot-metrics'], ['GET', '/admin/readiness'],
  ['POST', '/admin/alerts/test'], ['GET', '/admin/evidence-pack'],
  ['POST', '/admin/reconciliation/run'], ['GET', '/admin/reconciliation'],
  ['GET', '/admin/operations'], ['POST', '/admin/operations/recover'],
];
const ADMIN_ROUTE_KEYS = [
  ['POST', '/admin/login'],
  ...ADMIN_ROUTES.map(([method, pathName]) => [method, pathName.replace('/admin/off-peak/FR', '/admin/off-peak/:countryCode')]),
];

let baseUrl;
let pool;
let adminToken;
let tokenContract;
let alertWebhook;
let wallet;
let seed;
const cases = [];
const findings = [];

function isObj(value) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}
function message(body) {
  if (!isObj(body)) return null;
  if (typeof body.message === 'string') return body.message;
  if (typeof body.error === 'string') return body.error;
  if (isObj(body.error) && typeof body.error.message === 'string') return body.error.message;
  return null;
}
function code(body) {
  return isObj(body) && typeof body.code === 'string' ? body.code : null;
}
function leakReason(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value || '');
  const diagnosticText = typeof value === 'object' && value !== null
    ? [value.message, value.error].filter(item => typeof item === 'string').join(' ')
    : text;
  if ([ADMIN_PASSWORD, API_KEY, INGEST_KEY, 'postgres://', 'node_modules\\'].some(item => item && text.includes(item))) return 'credential or internal path literal';
  // Match SQL-shaped diagnostics inside an error string without letting the
  // broad `.+` span unrelated words in a successful OpenAPI document.
  if (/\bselect\s+(?:[\w*,'"().-]+\s+)*from\s+[\w".-]+\b/i.test(text)
    || /\binsert\s+into\s+[\w".-]+\b/i.test(text)
    || /\bupdate\s+[\w".-]+\s+set\b/i.test(text)
    || /\bdelete\s+from\s+[\w".-]+\b/i.test(text)) return 'SQL diagnostic';
  if (/\b(?:relation|column) "[^"]+" does not exist\b/i.test(text)) return 'database catalog diagnostic';
  if (/\b(?:stack trace|stacktrace|json-rpc|rpc error|jsonrpc|internal server error)\b/i.test(text)) return 'RPC or stack diagnostic';
  if (/\bat\s+[A-Za-z0-9_.<>/$-]+\s+\(/i.test(text)) return 'stack frame';
  if (/https?:\/\//i.test(diagnosticText)) return 'diagnostic URL';
  return null;
}
function leak(value) {
  return Boolean(leakReason(value));
}
function safeBody(body) {
  if (body === null || body === undefined) return { type: 'empty' };
  if (typeof body !== 'object') return { type: typeof body };
  const out = { keys: Object.keys(body).slice(0, 30) };
  if (typeof body.status === 'string') out.status = body.status;
  if (typeof body.count === 'number') out.count = body.count;
  if (typeof body.total === 'number') out.total = body.total;
  if (typeof body.valid === 'boolean') out.valid = body.valid;
  if (typeof body.pending === 'boolean') out.pending = body.pending;
  if (typeof body.requiresReview === 'boolean') out.requiresReview = body.requiresReview;
  if (typeof body.failedCount === 'number') out.failedCount = body.failedCount;
  if (typeof body.warningCount === 'number') out.warningCount = body.warningCount;
  if (typeof body.webhookStatus === 'number' || typeof body.webhookStatus === 'string') out.webhookStatus = body.webhookStatus;
  if (typeof body.webhookConfigured === 'boolean') out.webhookConfigured = body.webhookConfigured;
  if (typeof body.adminEmailConfigured === 'boolean') out.adminEmailConfigured = body.adminEmailConfigured;
  if (typeof body.recoveryStatus === 'string') out.recoveryStatus = body.recoveryStatus;
  if (typeof body.projectionStatus === 'string') out.projectionStatus = body.projectionStatus;
  if (typeof body.noReplacementTransfer === 'boolean') out.noReplacementTransfer = body.noReplacementTransfer;
  if (Array.isArray(body.checks)) {
    out.checks = body.checks.slice(0, 40).map(item => isObj(item) ? {
      key: typeof item.key === 'string' ? item.key : undefined,
      status: typeof item.status === 'string' ? item.status : undefined,
      message: typeof item.message === 'string' && !leak(item.message) ? item.message.slice(0, 240) : '[diagnostic detail redacted]',
    } : { status: '[invalid check]' });
  }
  if (Array.isArray(body.operations)) {
    out.operationRecovery = body.operations.slice(0, 100).map(item => isObj(item) && isObj(item.recovery) ? {
      status: typeof item.status === 'string' ? item.status : undefined,
      eligible: typeof item.recovery.eligible === 'boolean' ? item.recovery.eligible : undefined,
      reasonCode: typeof item.recovery.reasonCode === 'string' ? item.recovery.reasonCode : undefined,
      reason: typeof item.recovery.reason === 'string' && !leak(item.recovery.reason)
        ? item.recovery.reason.slice(0, 240)
        : undefined,
    } : { status: '[missing recovery projection]' });
  }
  const text = message(body);
  const bodyCode = code(body);
  if (text) out.message = leak(text) ? '[diagnostic detail redacted]' : text.slice(0, 240);
  if (bodyCode) out.code = bodyCode;
  return out;
}
function safeError(body) {
  const text = message(body);
  return Boolean(text
    && text.trim().length >= 8
    && /\b(?:required|invalid|failed|failure|unavailable|not found|forbidden|unauthori[sz]ed|missing|must|cannot|could not|blocked|temporarily|error|rejected|unsupported|not\s+supported|disabled|do\s+not\s+require|contradictory|conflict)\b/i.test(text)
    && !leak(body));
}
function statusMatches(actual, expected) {
  return Array.isArray(expected) ? expected.includes(actual) : actual === expected;
}
function addCase(name, request, result, expected, predicate, note) {
  const statusOk = result && statusMatches(result.status, expected);
  const predOk = result && (predicate ? predicate(result.body, result) : true);
  const errorOk = result && result.status >= 400 ? safeError(result.body) : true;
  const bodyLeakOk = result && !leak(result.body);
  const pass = Boolean(result && !result.transportError && statusOk && predOk && errorOk && bodyLeakOk);
  const entry = {
    name,
    method: request.method || 'GET',
    path: request.path,
    expectedStatus: expected,
    actualStatus: result ? result.status : null,
    passed: pass,
    predicateOk: Boolean(predOk),
    errorContractOk: Boolean(errorOk),
    bodyLeakFree: Boolean(bodyLeakOk),
    response: result ? safeBody(result.body) : null,
  };
  if (result && result.transportError) entry.transportError = result.transportError;
  if (note) entry.note = note;
  cases.push(entry);
  if (!pass) {
    findings.push({
      name,
      path: request.path,
      method: request.method || 'GET',
      expectedStatus: expected,
      actualStatus: entry.actualStatus,
      reason: result && result.transportError ? 'transport error: ' + result.transportError
        : !statusOk ? 'unexpected status'
        : !predOk ? 'response predicate failed'
        : !bodyLeakOk ? 'response contains raw diagnostic/provider detail (' + (leakReason(result.body) || 'unknown') + ')'
        : 'unsafe or missing English error message',
      response: entry.response,
    });
  }
  return result;
}
async function request(input) {
  const headers = Object.assign({ accept: 'application/json' }, input.headers || {});
  if (input.body !== undefined && input.rawBody === undefined && !headers['content-type']) headers['content-type'] = 'application/json';
  let body;
  if (input.rawBody !== undefined) body = input.rawBody;
  else if (input.body !== undefined) body = JSON.stringify(input.body);
  try {
    const response = await fetch(baseUrl + input.path, { method: input.method || 'GET', headers, body });
    const raw = await response.text();
    let parsed;
    try { parsed = raw ? JSON.parse(raw) : null; } catch { parsed = { raw: raw.slice(0, 500) }; }
    return { status: response.status, body: parsed };
  } catch (error) {
    return { transportError: error instanceof Error ? error.message : String(error) };
  }
}
async function check(name, method, pathName, options, expected, predicate, note) {
  const input = Object.assign({ method, path: pathName }, options || {});
  return addCase(name, input, await request(input), expected, predicate, note);
}
function admin(method, body, token) {
  const out = { headers: { authorization: 'Bearer ' + (token || adminToken) } };
  if (method !== 'GET' && method !== 'DELETE') out.body = body === undefined ? {} : body;
  return out;
}
function api(method, body, headers) {
  const out = { headers: Object.assign({ 'x-api-key': API_KEY }, headers || {}) };
  if (method !== 'GET' && method !== 'DELETE') out.body = body === undefined ? {} : body;
  return out;
}
function ingest(body, headers) {
  return { headers: Object.assign({ 'x-ingest-api-key': INGEST_KEY }, headers || {}), body };
}
function clone(value) { return JSON.parse(JSON.stringify(value)); }

function sqlIdentifier(prefix, label) {
  return (prefix + '_' + process.pid + '_' + Date.now().toString(36) + '_' + String(label).replace(/[^A-Za-z0-9_]/g, '_')).slice(0, 60);
}

async function installAwardProjectionFailure(sessionId) {
  const functionName = sqlIdentifier('matrix_fail_award', sessionId);
  const triggerName = sqlIdentifier('matrix_fail_award_trigger', sessionId);
  const literalSession = "'" + String(sessionId).replace(/'/g, "''") + "'";
  await pool.query(
    'create function ' + functionName + '() returns trigger language plpgsql as $$ begin raise exception ' +
      "'matrix award projection failure'; return new; end; $$;",
  );
  await pool.query(
    'create trigger ' + triggerName + ' before insert on awards for each row when (NEW.session_id = ' + literalSession + ') execute function ' + functionName + '()',
  );
  return { functionName, triggerName };
}

async function removeAwardProjectionFailure(trigger) {
  if (!trigger) return;
  await pool.query('drop trigger if exists ' + trigger.triggerName + ' on awards');
  await pool.query('drop function if exists ' + trigger.functionName + '()');
}

async function assertPolicyUnchanged(label, baseline) {
  await check(label + ' rules unchanged', 'GET', '/admin/rules', admin('GET'), 200, body => isObj(body)
    && body.policy && body.policy.revision === baseline.revision
    && body.policy.updatedAt === baseline.updatedAt
    && JSON.stringify(body.rules) === JSON.stringify(baseline.rules));
  await check(label + ' off-peak unchanged', 'GET', '/admin/off-peak', admin('GET'), 200, body => isObj(body)
    && body.policy && body.policy.revision === baseline.revision
    && body.policy.updatedAt === baseline.updatedAt
    && JSON.stringify(body.windows) === JSON.stringify(baseline.windows));
}

async function setup() {
  await harness.startDatabase();
  const local = await harness.startHardhat();
  const deployment = await harness.deployToken(local.provider);
  tokenContract = deployment.token;
  const webhook = await harness.startAlertWebhook();
  alertWebhook = webhook;
  await harness.startApi(deployment.treasuryAddress, { adminAlertWebhookUrl: webhook.url });
  baseUrl = harness.resources.apiBaseUrl;
  pool = new Pool({ connectionString: harness.resources.databaseUrl, max: 2 });
  seed = await harness.postIngest({
    SessionID: 'admin-api-matrix-award',
    ProviderID: PROVIDER,
    EVSEID: EVSE,
    'Session Start': '2026-01-01T01:00:00Z',
    'Session End': '2026-01-01T02:00:00Z',
    'Consumed Energy': '40',
    cdr_token: { contract_id: UID },
  });
  if (seed.status !== 200) throw new Error('seed award failed HTTP ' + seed.status);
  const walletResponse = await harness.getIdentityWallet();
  if (walletResponse.status !== 200 || !walletResponse.body.walletAddress) throw new Error('wallet lookup seed failed');
  wallet = walletResponse.body;
}

async function matrix() {
  const sourceAdminKeys = new Set(routeInventory.EXPECTED_ROUTES
    .filter(item => item.path.startsWith('/admin/'))
    .map(item => item.method + ' ' + item.path));
  const matrixAdminKeys = new Set(ADMIN_ROUTE_KEYS.map(item => item[0] + ' ' + item[1]));
  const missingAdminRoutes = [...sourceAdminKeys].filter(key => !matrixAdminKeys.has(key));
  const extraAdminRoutes = [...matrixAdminKeys].filter(key => !sourceAdminKeys.has(key));
  if (missingAdminRoutes.length || extraAdminRoutes.length) {
    findings.push({
      name: 'admin route inventory equivalence',
      reason: 'missing=' + JSON.stringify(missingAdminRoutes) + ' extra=' + JSON.stringify(extraAdminRoutes),
    });
  }
  await check('public health', 'GET', '/ingest/health', {}, 200, body => isObj(body));
  await check('public OpenAPI', 'GET', '/openapi.json', {}, 200, body => isObj(body) && isObj(body.paths));
  await check('public docs alias', 'GET', '/docs', {}, 200, body => body && (body.raw || isObj(body)));
  await check('public API docs alias', 'GET', '/api-docs', {}, 200, body => body && (body.raw || isObj(body)));

  const login = await check('admin login email', 'POST', '/admin/login', { body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD } }, 200, body => isObj(body) && body.status === 'ok' && typeof body.token === 'string');
  adminToken = login && login.body && login.body.token;
  if (!adminToken) throw new Error('admin login did not return a token');
  await check('admin login username alias', 'POST', '/admin/login', { body: { username: ADMIN_EMAIL, password: ADMIN_PASSWORD } }, 200, body => isObj(body) && typeof body.token === 'string');
  await check('admin login wrong credentials', 'POST', '/admin/login', { body: { email: ADMIN_EMAIL, password: 'wrong-password' } }, 401, body => message(body) === 'Invalid credentials');
  await check('admin login missing fields', 'POST', '/admin/login', { body: {} }, 401, body => message(body) === 'Invalid credentials');
  await check('admin login wrong types', 'POST', '/admin/login', { body: { email: 7, password: true } }, 401, body => message(body) === 'Invalid credentials');
  await check('admin login malformed JSON', 'POST', '/admin/login', { rawBody: '{"email":', headers: { 'content-type': 'application/json' } }, 400, body => /json|malformed|unexpected/i.test(message(body) || ''));

  for (const route of ADMIN_ROUTES) {
    const method = route[0];
    const pathName = route[1];
    const body = method === 'POST' && pathName.endsWith('/recover') ? { operationKey: 'missing' } : {};
    const missingAuth = { headers: { 'content-type': 'application/json' } };
    const invalidAuth = { headers: { authorization: 'Bearer invalid-admin-token', 'content-type': 'application/json' } };
    if (method !== 'GET' && method !== 'DELETE') {
      missingAuth.body = body;
      invalidAuth.body = body;
    }
    await check('admin missing bearer ' + method + ' ' + pathName, method, pathName, missingAuth, 401, bodyValue => message(bodyValue) === 'Admin authentication required');
    await check('admin invalid bearer ' + method + ' ' + pathName, method, pathName, invalidAuth, 401, bodyValue => message(bodyValue) === 'Admin authentication required');
    const apiRole = { headers: { 'x-api-key': API_KEY, 'content-type': 'application/json' } };
    const ingestRole = { headers: { 'x-ingest-api-key': INGEST_KEY, 'content-type': 'application/json' } };
    if (method !== 'GET' && method !== 'DELETE') {
      apiRole.body = body;
      ingestRole.body = body;
    }
    await check('admin API-key wrong role ' + method + ' ' + pathName, method, pathName, apiRole, 401, bodyValue => message(bodyValue) === 'Admin authentication required');
    await check('admin ingest-key wrong role ' + method + ' ' + pathName, method, pathName, ingestRole, 401, bodyValue => message(bodyValue) === 'Admin authentication required');
  }

  const rules = await check('admin rules read', 'GET', '/admin/rules', admin('GET'), 200, body => isObj(body) && isObj(body.rules) && isObj(body.policy) && Number.isInteger(body.policy.revision));
  const windows = await check('admin off-peak read', 'GET', '/admin/off-peak', admin('GET'), 200, body => isObj(body) && isObj(body.windows) && isObj(body.policy) && Number.isInteger(body.policy.revision));
  const originalRules = clone(rules.body.rules);
  const originalWindows = clone(windows.body.windows);
  const ruleValues = {
    offPeakChargingTokensPerKWh: originalRules.rules.offPeakCharging.tokensPerKWh,
    v2gDischargeTokensPerKWh: originalRules.rules.v2gDischarge.tokensPerKWh,
    offPeakChargingEnabled: originalRules.rules.offPeakCharging.enabled,
    v2gDischargeEnabled: originalRules.rules.v2gDischarge.enabled,
  };
  const sameRules = await check('admin rules same-value update', 'PUT', '/admin/rules', admin('PUT', ruleValues), 200, body => isObj(body) && isObj(body.policy));
  const sameWindows = await check('admin off-peak same-value update', 'PUT', '/admin/off-peak', admin('PUT', { windows: originalWindows }), 200, body => isObj(body) && isObj(body.windows) && isObj(body.policy));
  const baselineRulesRead = await check('admin rules baseline after valid writes', 'GET', '/admin/rules', admin('GET'), 200, body => isObj(body) && isObj(body.rules) && isObj(body.policy));
  const policyBaseline = {
    rules: baselineRulesRead && baselineRulesRead.body ? clone(baselineRulesRead.body.rules) : (sameRules && sameRules.body ? clone(sameRules.body.rules) : originalRules),
    windows: sameWindows && sameWindows.body ? clone(sameWindows.body.windows) : originalWindows,
    revision: baselineRulesRead && baselineRulesRead.body ? baselineRulesRead.body.policy.revision : (sameWindows && sameWindows.body ? sameWindows.body.policy.revision : rules.body.policy.revision),
    updatedAt: baselineRulesRead && baselineRulesRead.body ? baselineRulesRead.body.policy.updatedAt : (sameWindows && sameWindows.body ? sameWindows.body.policy.updatedAt : rules.body.policy.updatedAt),
  };
  await check('admin rules negative rate', 'PUT', '/admin/rules', admin('PUT', { offPeakChargingTokensPerKWh: -1 }), 400, body => /non-negative number/i.test(message(body) || ''));
  await assertPolicyUnchanged('after negative rate', policyBaseline);
  await check('admin rules string rate', 'PUT', '/admin/rules', admin('PUT', { v2gDischargeTokensPerKWh: '1' }), 400, body => /non-negative number/i.test(message(body) || ''));
  await assertPolicyUnchanged('after string rate', policyBaseline);
  await check('admin rules nonboolean', 'PUT', '/admin/rules', admin('PUT', { v2gDischargeEnabled: 'yes' }), 400, body => /boolean/i.test(message(body) || ''));
  await assertPolicyUnchanged('after nonboolean rate', policyBaseline);
  await check('admin rules empty body rejected', 'PUT', '/admin/rules', admin('PUT', {}), 400, body => /rule|field|body|invalid/i.test(message(body) || ''));
  await assertPolicyUnchanged('after empty rules body', policyBaseline);
  await check('admin rules null body rejected', 'PUT', '/admin/rules', { headers: { authorization: 'Bearer ' + adminToken, 'content-type': 'application/json' }, rawBody: 'null' }, 400, body => /rule|field|body|invalid/i.test(message(body) || ''));
  await assertPolicyUnchanged('after null rules body', policyBaseline);
  await check('admin rules array body rejected', 'PUT', '/admin/rules', admin('PUT', []), 400, body => /rule|field|body|invalid/i.test(message(body) || ''));
  await assertPolicyUnchanged('after array rules body', policyBaseline);
  await check('admin rules unknown field rejected', 'PUT', '/admin/rules', admin('PUT', { unknownRuleField: true }), 400, body => /rule|field|body|invalid/i.test(message(body) || ''));
  await assertPolicyUnchanged('after unknown rules field', policyBaseline);
  await check('admin off-peak body shape', 'PUT', '/admin/off-peak', admin('PUT', { windows: [] }), 400, body => /windows.*object/i.test(message(body) || ''));
  await assertPolicyUnchanged('after array off-peak windows', policyBaseline);
  await check('admin off-peak null body', 'PUT', '/admin/off-peak', { headers: { authorization: 'Bearer ' + adminToken, 'content-type': 'application/json' }, rawBody: 'null' }, 400, body => /windows.*object|valid JSON/i.test(message(body) || ''));
  await assertPolicyUnchanged('after null off-peak body', policyBaseline);
  await check('admin off-peak empty body', 'PUT', '/admin/off-peak', admin('PUT', {}), 400, body => /windows.*object/i.test(message(body) || ''));
  await assertPolicyUnchanged('after empty off-peak body', policyBaseline);
  await check('admin off-peak country validation', 'PUT', '/admin/off-peak', admin('PUT', { windows: { ZZZ: [{ start: '01:00', end: '02:00' }] } }), 400, body => /country code/i.test(message(body) || ''));
  await assertPolicyUnchanged('after invalid off-peak country', policyBaseline);
  await check('admin off-peak time validation', 'PUT', '/admin/off-peak', admin('PUT', { windows: { DE: [{ start: '25:00', end: '02:00' }] } }), 400, body => /time slot/i.test(message(body) || ''));
  await assertPolicyUnchanged('after invalid off-peak time', policyBaseline);
  await check('admin off-peak unknown country', 'DELETE', '/admin/off-peak/FR', admin('DELETE'), 404, body => /not found/i.test(message(body) || ''));
  await assertPolicyUnchanged('after unknown off-peak country delete', policyBaseline);
  await check('admin off-peak invalid country', 'DELETE', '/admin/off-peak/ZZZ', admin('DELETE'), 400, body => /country code/i.test(message(body) || ''));
  await assertPolicyUnchanged('after invalid off-peak country delete', policyBaseline);
  const removableCountry = Object.keys(originalWindows)[0];
  await check('admin off-peak valid country deletion', 'DELETE', '/admin/off-peak/' + encodeURIComponent(removableCountry), admin('DELETE'), 200, body => isObj(body) && isObj(body.windows) && !Object.prototype.hasOwnProperty.call(body.windows, removableCountry));
  await check('admin off-peak restore deleted country', 'PUT', '/admin/off-peak', admin('PUT', { windows: originalWindows }), 200, body => isObj(body) && isObj(body.windows) && Object.prototype.hasOwnProperty.call(body.windows, removableCountry));

  await check('admin audit read', 'GET', '/admin/audit?limit=10', admin('GET'), 200, body => isObj(body) && Array.isArray(body.events));
  await check('admin audit zero bounded default', 'GET', '/admin/audit?limit=0', admin('GET'), 200, body => isObj(body) && Array.isArray(body.events), 'Observed compatibility: zero falls back to the route default.');
  await check('admin audit malformed bounded default', 'GET', '/admin/audit?limit=bad', admin('GET'), 200, body => isObj(body) && Array.isArray(body.events), 'Observed compatibility: malformed limit falls back to the route default.');
  await check('admin metrics lower bound', 'GET', '/admin/pilot-metrics?hours=1', admin('GET'), 200, body => isObj(body) && isObj(body.metrics));
  await check('admin metrics upper bound', 'GET', '/admin/pilot-metrics?hours=168', admin('GET'), 200, body => isObj(body) && isObj(body.metrics));
  await check('admin metrics malformed default', 'GET', '/admin/pilot-metrics?hours=bad', admin('GET'), 200, body => isObj(body) && isObj(body.metrics), 'Observed compatibility: malformed hours defaults to 24.');
  await check('admin readiness read', 'GET', '/admin/readiness', admin('GET'), 200, body => isObj(body)
    && body.status === 'ready'
    && body.failedCount === 0
    && body.warningCount === 0
    && Number.isInteger(body.failedCount)
    && Number.isInteger(body.warningCount)
    && Array.isArray(body.checks)
    && body.checks.length > 0
    && body.checks.every(item => isObj(item)
      && typeof item.key === 'string'
      && typeof item.label === 'string'
      && ['pass', 'warn', 'fail'].includes(item.status)
      && typeof item.message === 'string'
      && item.message.trim().length >= 8),
    'The disposable fixture must report the exact configured readiness state with a structured message for every check.');
  const alertDeliveryCount = alertWebhook.state.deliveries.length;
  await check('admin alert local delivery', 'POST', '/admin/alerts/test', admin('POST', {}), 202, body => isObj(body)
    && body.webhookConfigured === true
    && body.status === 'sent_or_queued'
    && typeof body.webhookStatus === 'number'
    && body.webhookStatus >= 200
    && body.webhookStatus < 300
    && alertWebhook.state.deliveries.length > alertDeliveryCount,
    'The local webhook must observe the delivered request; the response status alone is insufficient.');
  await check('admin evidence pack', 'GET', '/admin/evidence-pack', admin('GET'), 200, body => isObj(body) && body.status === 'ok' && isObj(body.audit));
  await check('admin reconciliation run', 'POST', '/admin/reconciliation/run', admin('POST', { limit: 100 }), 200, body => isObj(body) && body.status === 'ok');
  await check('admin reconciliation invalid limit', 'POST', '/admin/reconciliation/run', admin('POST', { limit: 'bad' }), 400, body => /limit|number|invalid/i.test(message(body) || ''));
  await check('admin reconciliation list', 'GET', '/admin/reconciliation?limit=5', admin('GET'), 200, body => isObj(body) && Array.isArray(body.reports));

  const operations = await check('admin operations all', 'GET', '/admin/operations?scope=all&limit=100', admin('GET'), 200, body => isObj(body) && Array.isArray(body.operations));
  await check('admin operations unresolved', 'GET', '/admin/operations', admin('GET'), 200, body => isObj(body) && Array.isArray(body.operations));
  await check('admin operations eMAID filter', 'GET', '/admin/operations?scope=all&emaid=' + encodeURIComponent(UID), admin('GET'), 200, body => isObj(body) && body.operations.every(row => row.eMAID === UID));
  await check('admin operations rejects uid filter', 'GET', '/admin/operations?uid=' + encodeURIComponent(UID), admin('GET'), 400, body => /uid.*not supported|emaid/i.test(message(body) || ''));
  await check('admin operations limit zero', 'GET', '/admin/operations?limit=0', admin('GET'), 400, body => /limit.*at least 1/i.test(message(body) || ''));
  await check('admin operations bad scope', 'GET', '/admin/operations?scope=bad', admin('GET'), 400, body => /scope/i.test(message(body) || ''));

  const rows = operations.body && Array.isArray(operations.body.operations) ? operations.body.operations : [];
  const operationKey = (seed.body && (seed.body.operationKey || seed.body.operation_key))
    || (rows[0] && rows[0].operationKey)
    || (await pool.query("select operation_key from token_operations where operation_type = 'award' order by created_at desc limit 1")).rows[0]?.operation_key;
  if (!operationKey) throw new Error('seed operation key not found');
  const recoverySession = 'admin-api-matrix-recovery';
  const recoveryCdr = {
    SessionID: recoverySession,
    ProviderID: PROVIDER,
    EVSEID: EVSE,
    'Session Start': '2026-01-02T01:00:00Z',
    'Session End': '2026-01-02T02:00:00Z',
    'Consumed Energy': '40',
    cdr_token: { contract_id: UID },
  };
  const recoveryTrigger = await installAwardProjectionFailure(recoverySession);
  const balanceBeforeProjection = await tokenContract.balanceOf(wallet.walletAddress);
  const projectionFailure = await harness.postIngest(recoveryCdr);
  addCase('award projection failure retains recoverable operation', { method: 'POST', path: '/ingest/cdr' }, projectionFailure, 202, body => isObj(body) && body.pending === true && body.requiresReview === false && typeof body.txHash === 'string');
  await removeAwardProjectionFailure(recoveryTrigger);
  const balanceAfterProjection = await tokenContract.balanceOf(wallet.walletAddress);
  if (balanceAfterProjection <= balanceBeforeProjection) findings.push({ name: 'recovery fixture chain movement', reason: 'projection-failure award did not produce the expected original chain movement' });
  const recoveryOperation = (await pool.query('select * from token_operations where operation_type = $1 and session_id = $2', ['award', recoverySession])).rows[0];
  if (!recoveryOperation || !recoveryOperation.operation_key || !recoveryOperation.tx_hash) throw new Error('recoverable projection-failure operation was not persisted with a hash');
  const eligibleView = await check('admin operations marks confirmed snapshot eligible', 'GET', '/admin/operations?scope=all&limit=100', admin('GET'), 200, body => isObj(body) && body.operations.some(row => row.operationKey === recoveryOperation.operation_key && row.recovery && row.recovery.eligible === true && row.recovery.reasonCode === 'CHAIN_EVIDENCE_REQUIRED'));
  const recoveryBalanceBefore = await tokenContract.balanceOf(wallet.walletAddress);
  const recoveryFirst = await check('admin recovery eligible saved snapshot completes', 'POST', '/admin/operations/recover', admin('POST', { operationKey: recoveryOperation.operation_key }), 200, body => isObj(body) && body.status === 'ok' && body.recoveryStatus === 'completed' && body.projectionStatus === 'projected' && body.transactionHash === recoveryOperation.tx_hash && body.noReplacementTransfer === true);
  const projectedAwardCount = Number((await pool.query('select count(*)::int as count from awards where session_id = $1', [recoverySession])).rows[0].count);
  if (projectedAwardCount !== 1) findings.push({ name: 'recovery projection row count', reason: 'expected exactly one award projection, found ' + projectedAwardCount });
  const recoveryBalanceAfter = await tokenContract.balanceOf(wallet.walletAddress);
  if (recoveryBalanceAfter.toString() !== recoveryBalanceBefore.toString()) findings.push({ name: 'eligible recovery duplicate movement', reason: 'eligible recovery changed the already-settled chain balance' });
  const recoveryRowAfterFirst = (await pool.query('select status from token_operations where operation_key = $1', [recoveryOperation.operation_key])).rows[0];
  if (!recoveryRowAfterFirst || recoveryRowAfterFirst.status !== 'projected') findings.push({ name: 'eligible recovery projection status', reason: 'saved operation was not marked projected after recovery' });
  await check('admin recovery exact repeat is already projected', 'POST', '/admin/operations/recover', admin('POST', { operationKey: recoveryOperation.operation_key }), 200, body => isObj(body) && body.status === 'ok' && body.recoveryStatus === 'completed' && body.projectionStatus === 'projected' && body.noReplacementTransfer === true);
  await check('admin operations exact repeat reports already projected', 'GET', '/admin/operations?scope=all&limit=100', admin('GET'), 200, body => isObj(body) && body.operations.some(row => row.operationKey === recoveryOperation.operation_key
    && row.recovery
    && row.recovery.reasonCode === 'ALREADY_PROJECTED'
    && row.recovery.eligible === true
    && row.recovery.reason === 'The award projection is already complete; repeating the operation key is idempotent and will not submit a new transfer.'));
  const blockedOperationKey = 'award:admin-api-matrix-blocked';
  await pool.query(
    "insert into token_operations (operation_key, operation_type, request_fingerprint, uid, wallet_address, amount, status, movement_outcome, error_message) values ($1, 'award', $2, $3, $4, '1.00', 'unknown', 'unknown', $5)",
    [blockedOperationKey, 'matrix-blocked-fingerprint', UID, wallet.walletAddress, 'chain outcome requires review'],
  );
  await check('admin recovery blocked hashless operation', 'POST', '/admin/operations/recover', admin('POST', { operationKey: blockedOperationKey }), 409, body => isObj(body) && body.status === 'blocked' && body.requiresReview === true && body.noReplacementTransfer === true);
  const before = await tokenContract.balanceOf(wallet.walletAddress);
  await check('admin recovery existing operation', 'POST', '/admin/operations/recover', admin('POST', { operationKey }), [200, 202], body => isObj(body) && typeof body.status === 'string');
  await check('admin recovery repeated operation', 'POST', '/admin/operations/recover', admin('POST', { operationKey }), [200, 202], body => isObj(body) && typeof body.status === 'string');
  const after = await tokenContract.balanceOf(wallet.walletAddress);
  if (before.toString() !== after.toString()) findings.push({ name: 'recovery duplicate movement', reason: 'wallet balance changed after repeated recovery' });
  await check('admin recovery missing key', 'POST', '/admin/operations/recover', admin('POST', {}), 400, body => /operationKey/i.test(message(body) || ''));
  await check('admin recovery malformed JSON', 'POST', '/admin/operations/recover', { headers: { authorization: 'Bearer ' + adminToken, 'content-type': 'application/json' }, rawBody: '{"operationKey":' }, 400, body => /json|malformed|unexpected/i.test(message(body) || ''));
  await check('admin recovery override rejected', 'POST', '/admin/operations/recover', admin('POST', { operationKey, amount: 1 }), 400, body => /only.*operationKey|overrides/i.test(message(body) || ''));
  await check('admin recovery unknown operation', 'POST', '/admin/operations/recover', admin('POST', { operationKey: 'award:does-not-exist' }), 404, body => /not found|unknown/i.test(message(body) || ''));

  await check('wallet identity read', 'GET', '/wallet/me', api('GET', undefined, { 'x-contract-id': UID }), 200, body => isObj(body) && body.uid === UID && typeof body.walletAddress === 'string');
  await check('wallet identity missing header', 'GET', '/wallet/me', api('GET'), 401, body => /identity header/i.test(message(body) || ''));
  await check('wallet identity missing API key', 'GET', '/wallet/me', { headers: { 'x-contract-id': UID } }, 401, body => /missing api key/i.test(message(body) || ''));
  await check('wallet identity invalid API key', 'GET', '/wallet/me', { headers: { 'x-api-key': 'invalid', 'x-contract-id': UID } }, 403, body => /invalid api key/i.test(message(body) || ''));
  await check('wallet manual lookup disabled', 'GET', '/wallet/' + encodeURIComponent(UID), api('GET'), 403, body => /disabled|identity endpoint/i.test(message(body) || ''));
  await check('wallet manual missing API key', 'GET', '/wallet/' + encodeURIComponent(UID), { headers: {} }, 401, body => /missing api key/i.test(message(body) || ''));
  await check('transactions read', 'GET', '/transactions', api('GET'), 200, body => isObj(body) && Array.isArray(body.transactions));
  await check('transactions missing API key', 'GET', '/transactions', { headers: {} }, 401, body => /missing api key/i.test(message(body) || ''));
  await check('wallet mode same managed', 'POST', '/wallet/' + encodeURIComponent(UID) + '/mode', api('POST', { mode: 'managed' }), 200, body => isObj(body) && body.walletMode === 'managed');
  await check('wallet profile valid', 'PATCH', '/wallet/' + encodeURIComponent(UID) + '/profile', api('PATCH', { walletName: null }), 200, body => /updated/i.test(body.message || ''));
  await check('wallet contract ID valid', 'POST', '/wallet/' + encodeURIComponent(UID) + '/contract-ids', api('POST', { contractId: 'local-api-matrix-alias' }), 200, body => /linked/i.test(body.message || ''));
  await check('wallet linked invalid address', 'POST', '/wallet/' + encodeURIComponent(UID) + '/linked-wallets', api('POST', { walletAddress: 'bad', signature: '' }), 400, body => /wallet address/i.test(message(body) || ''));
  await check('wallet linked profile invalid address', 'PATCH', '/wallet/' + encodeURIComponent(UID) + '/linked-wallets/bad/profile', api('PATCH', { walletName: 'x' }), 400, body => /wallet address/i.test(message(body) || ''));
  await check('wallet unlink invalid address', 'DELETE', '/wallet/' + encodeURIComponent(UID) + '/linked-wallets/bad', api('DELETE', {}), 400, body => /wallet address/i.test(message(body) || ''));
  await check('wallet move funds invalid target', 'POST', '/wallet/' + encodeURIComponent(UID) + '/move-funds', api('POST', {}), 400, body => /targetAddress/i.test(message(body) || ''));

  const session = { sessionId: 'admin-api-matrix-session', providerId: PROVIDER, chargerId: EVSE, status: 'SESSION_STARTED', countryCode: 'DE', estimatedKwh: 5, estimatedCost: 2 };
  await check('spend session valid', 'POST', '/spend/session', api('POST', session, { 'x-contract-id': UID }), 200, body => isObj(body) && body.status === 'success' && isObj(body.wallet));
  await check('spend session missing identity', 'POST', '/spend/session', api('POST', session), 401, body => /identity header/i.test(message(body) || ''));
  await check('spend session invalid status', 'POST', '/spend/session', api('POST', Object.assign({}, session, { status: 'BAD' }), { 'x-contract-id': UID }), 400, body => /invalid status/i.test(message(body) || ''));
  await check('manual spend missing key', 'POST', '/spend', api('POST', { uid: UID, amount: 1 }), 400, body => code(body) === 'IDEMPOTENCY_KEY_REQUIRED');
  await check('manual spend blank key', 'POST', '/spend', api('POST', { uid: UID, amount: 1, idempotencyKey: ' ' }), 400, body => code(body) === 'INVALID_OPERATION_KEY');

  const spend = await check('manual spend valid', 'POST', '/spend', api('POST', { uid: UID, amount: 1, idempotencyKey: 'admin-api-matrix-spend', sessionId: 'admin-api-matrix-spend-session', providerId: PROVIDER, label: 'matrix' }), 200, body => isObj(body) && body.status === 'success' && body.spendReceipt);
  if (spend && spend.body && spend.body.spendReceipt) {
    await check('receipt verify valid', 'POST', '/spend-receipts/verify', api('POST', {
      payload: spend.body.spendReceipt.payload,
      signature: spend.body.spendReceipt.signature,
      signerAddress: spend.body.spendReceipt.signerAddress,
    }), 200, body => isObj(body) && body.valid === true);
  }
  await check('receipt verify invalid body', 'POST', '/spend-receipts/verify', api('POST', {}), 400, body => /receipt|payload|signature|required/i.test(message(body) || ''));
  await check('receipt verify missing API key', 'POST', '/spend-receipts/verify', { body: {} }, 401, body => /missing api key/i.test(message(body) || ''));

  await check('spend identity invalid amount', 'POST', '/spend/me', api('POST', { sessionId: 'bad', providerId: PROVIDER, amount: 0 }, { 'x-contract-id': UID }), 400, body => /amount/i.test(message(body) || ''));
  await check('spend identity missing identity', 'POST', '/spend/me', api('POST', { sessionId: 'bad', providerId: PROVIDER, amount: 1 }), 401, body => /identity header/i.test(message(body) || ''));
  const reservation = await check('spend identity reservation valid', 'POST', '/spend/me', api('POST', { sessionId: 'admin-api-matrix-reservation', providerId: PROVIDER, amount: 1 }, { 'x-contract-id': UID }), 200, body => isObj(body) && body.status === 'success' && body.reservation);
  const reservationId = reservation && reservation.body && reservation.body.reservation && reservation.body.reservation.id;
  if (reservationId) await check('reservation read valid', 'GET', '/spend/reservations/' + encodeURIComponent(reservationId), api('GET', undefined, { 'x-contract-id': UID }), 200, body => isObj(body) && body.reservationId === reservationId);
  const unknownReservationId = '00000000-0000-4000-8000-000000000001';
  await check('reservation read unknown', 'GET', '/spend/reservations/' + unknownReservationId, api('GET', undefined, { 'x-contract-id': UID }), 404, body => /reservation not found/i.test(message(body) || ''));
  await check('reservation read missing identity', 'GET', '/spend/reservations/' + unknownReservationId, api('GET'), 401, body => /identity header/i.test(message(body) || ''));
  await check('reservation approval managed rejection', 'POST', '/spend/reservation-approval-intent', api('POST', { walletAddress: wallet.walletAddress, amount: 1, sessionId: 'approval', providerId: PROVIDER }, { 'x-contract-id': UID }), 400, body => /managed wallets/i.test(message(body) || ''));
  await check('custodial intent invalid body', 'POST', '/spend/custodial-intent', api('POST', {}), 400, body => /uid|wallet|amount/i.test(message(body) || ''));
  await check('custodial failure invalid body', 'POST', '/spend/custodial-failure', api('POST', {}), 400, body => /uid|wallet|amount/i.test(message(body) || ''));
  await check('custodial record invalid body', 'POST', '/spend/custodial-record', api('POST', {}), 400, body => code(body) === 'INVALID_CUSTODIAL_SPEND');

  const cdr = {
    id: 'admin-api-matrix-preview',
    session_id: 'admin-api-matrix-preview-session',
    party_id: PROVIDER,
    cdr_location: { evse_id: EVSE },
    start_date_time: '2026-01-01T01:00:00Z',
    end_date_time: '2026-01-01T02:00:00Z',
    total_energy: '2',
    cdr_token: { contract_id: UID },
  };
  await check('preview valid OCPI', 'POST', '/ingest/cdr/preview', ingest(cdr), 200, body => isObj(body) && body.normalisation && body.normalisation.protocol === 'OCPI' && body.normalisation.eMAID === UID);
  await check('preview missing ingest key', 'POST', '/ingest/cdr/preview', { body: cdr }, 401, body => /missing ingest api key/i.test(message(body) || ''));
  await check('preview invalid ingest key', 'POST', '/ingest/cdr/preview', { body: cdr, headers: { 'x-ingest-api-key': 'wrong' } }, 403, body => /invalid ingest api key/i.test(message(body) || ''));
  await check('preview UID-only', 'POST', '/ingest/cdr/preview', ingest(Object.assign({}, cdr, { cdr_token: { uid: 'legacy-only' } })), 400, body => /emaid|contract|identity/i.test(message(body) || ''));
  await check('preview conflicting identity', 'POST', '/ingest/cdr/preview', ingest(Object.assign({}, cdr, { Identification: { RemoteIdentification: { EvcoID: 'different-emaid' } } })), 400, body => /conflict|contradictory|identity/i.test(message(body) || ''));
  await check('preview malformed JSON', 'POST', '/ingest/cdr/preview', { rawBody: '{"SessionID":', headers: { 'x-ingest-api-key': INGEST_KEY, 'content-type': 'application/json' } }, 400, body => /json|malformed|unexpected/i.test(message(body) || ''));
  await check('ingest valid duplicate replay', 'POST', '/ingest/cdr', ingest({
    SessionID: 'admin-api-matrix-award',
    ProviderID: PROVIDER,
    EVSEID: EVSE,
    'Session Start': '2026-01-01T01:00:00Z',
    'Session End': '2026-01-01T02:00:00Z',
    'Consumed Energy': '40',
    cdr_token: { contract_id: UID },
  }), 200, body => isObj(body) && (body.status === 'duplicate' || body.status === 'accepted'));
  await check('ingest invalid CDR', 'POST', '/ingest/cdr', ingest({ SessionID: 'invalid', ProviderID: PROVIDER, EVSEID: EVSE }), 400, body => /cdr|identity|required|energy|session/i.test(message(body) || ''));
  await check('ingest malformed JSON', 'POST', '/ingest/cdr', { rawBody: '{"SessionID":', headers: { 'x-ingest-api-key': INGEST_KEY, 'content-type': 'application/json' } }, 400, body => /json|malformed|unexpected/i.test(message(body) || ''));

  await alertWebhook.close();
  await check('alert webhook failure', 'POST', '/admin/alerts/test', admin('POST', {}), 502, body => /delivery failed|alert target/i.test(message(body) || ''));

  await pool.query('drop table reward_policy');
  await check('rules missing policy table', 'GET', '/admin/rules', admin('GET'), 503, body => code(body) === 'REWARD_POLICY_UNAVAILABLE' && /policy|temporarily|unavailable/i.test(message(body) || ''));
  await check('off-peak missing policy table', 'GET', '/admin/off-peak', admin('GET'), 503, body => code(body) === 'REWARD_POLICY_UNAVAILABLE' && /policy|temporarily|unavailable/i.test(message(body) || ''));
  await pool.query('drop table audit_logs');
  await check('audit missing audit table', 'GET', '/admin/audit', admin('GET'), 500, body => code(body) === 'AUDIT_LOG_UNAVAILABLE' && /audit|temporarily|unavailable/i.test(message(body) || ''));
  await check('evidence missing dependency', 'GET', '/admin/evidence-pack', admin('GET'), 500, body => /evidence|temporarily|unavailable/i.test(message(body) || ''));

  await check('admin logout valid', 'POST', '/admin/logout', admin('POST', {}), 200, body => isObj(body) && body.status === 'ok');
  await check('admin token invalid after logout', 'GET', '/admin/readiness', { headers: { authorization: 'Bearer ' + adminToken } }, 401, body => message(body) === 'Admin authentication required');
}

function writeEvidence(errorMessage) {
  fs.mkdirSync(OUT, { recursive: true });
  const result = {
    status: findings.length || errorMessage ? 'failed' : 'passed',
    generatedAt: new Date().toISOString(),
    fixture: { host: '127.0.0.1', dbPort: harness.resources.dbPort, hardhatPort: harness.resources.hardhatPort, apiPort: harness.resources.apiPort, apiBaseUrl: baseUrl },
    sourceRouteInventory: {
      count: routeInventory.EXPECTED_ROUTES.length,
      routes: routeInventory.EXPECTED_ROUTES.map(item => ({ method: item.method, path: item.path, auth: item.auth, notes: item.notes })),
    },
    summary: { total: cases.length, passed: cases.filter(item => item.passed).length, failed: cases.filter(item => !item.passed).length, findings: findings.length },
    cases,
    findings: errorMessage ? findings.concat([{ name: 'matrix fatal error', reason: errorMessage }]) : findings,
    notes: [
      'All resources are disposable local fixtures; no active database or live provider was used.',
      'Evidence excludes credentials, bearer tokens, raw CDRs, raw intent contexts, SQL/provider diagnostics, and raw response bodies.',
      'Audit limit zero/malformed and pilot-metrics hours malformed are recorded as existing bounded-default compatibility behaviour.',
    ],
  };
  fs.writeFileSync(JSON_FILE, JSON.stringify(result, null, 2), 'utf8');
  fs.writeFileSync(JSON_LATEST, JSON.stringify(result, null, 2), 'utf8');
  const lines = [
    '# Local API HTTP matrix',
    '',
    'Status: **' + result.status.toUpperCase() + '**',
    'Generated: ' + result.generatedAt,
    'Fixture: disposable PostgreSQL 127.0.0.1:' + harness.resources.dbPort + ', Hardhat 127.0.0.1:' + harness.resources.hardhatPort + ', API ' + baseUrl,
    'Cases: ' + result.summary.passed + ' passed, ' + result.summary.failed + ' failed, ' + result.summary.total + ' total',
    'Source inventory: ' + result.sourceRouteInventory.count + ' expected routes.',
    '',
    '## Findings',
    '',
  ];
  if (!result.findings.length) lines.push('No findings.');
  else result.findings.forEach(item => lines.push('- ' + item.name + ': ' + item.reason));
  lines.push('', 'Exact command: node scripts/verify-local-admin-api-matrix.js', '');
  fs.writeFileSync(MD_FILE, lines.join('\n'), 'utf8');
  fs.writeFileSync(MD_LATEST, lines.join('\n'), 'utf8');
  return result;
}

async function main() {
  let fatal = null;
  try {
    await setup();
    await matrix();
  } catch (error) {
    fatal = error instanceof Error ? error.message : String(error);
  } finally {
    if (pool) await pool.end().catch(() => undefined);
    await harness.cleanup().catch(error => findings.push({ name: 'fixture cleanup', reason: error.message || String(error) }));
  }
  const result = writeEvidence(fatal);
  console.log(JSON.stringify({ status: result.status, evidence: JSON_FILE, report: MD_FILE, summary: result.summary, findings: result.findings.slice(0, 20) }, null, 2));
  if (result.status !== 'passed') process.exitCode = 1;
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
