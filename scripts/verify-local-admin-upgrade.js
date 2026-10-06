/*
 * Read-only/reversible acceptance helper for the local admin upgrade.
 *
 * `node scripts/verify-local-admin-upgrade.js before` logs in, performs only
 * same-value policy saves, and records a safe baseline.  Run `after` against
 * the freshly restarted local API to verify restart persistence.  The script
 * refuses non-local API/database targets and never writes credentials or
 * bearer tokens to output.
 */
'use strict';

require('dotenv').config();

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const knexFactory = require('knex');

const BASE_URL = 'http://localhost:3005';
const EXPECTED_DATABASE_NAME = 'nvf_award';
const EXPECTED_DATABASE_PORT = '55432';
const BASELINE_PATH = path.resolve(__dirname, '..', 'outputs', 'local-admin-upgrade-baseline.json');
const FINANCIAL_TABLES = [
  'users',
  'balances',
  'awards',
  'spends',
  'spend_receipts',
  'spend_reservations',
  'token_operations',
  'approval_preparations',
  'reconciliation_reports',
];

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

function cloneJson(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function stableValue(value) {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).sort().map(key => [key, stableValue(value[key])]),
    );
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(stableValue(value));
}

function digestRows(rows) {
  return crypto.createHash('sha256').update(canonicalJson(rows), 'utf8').digest('hex');
}

function validateTargets() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) fail('configuration', 'DATABASE_URL is required');

  let parsed;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    fail('configuration', 'DATABASE_URL is invalid');
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  ensure(
    ['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)
      && parsed.port === EXPECTED_DATABASE_PORT
      && databaseName === EXPECTED_DATABASE_NAME,
    'configuration',
    'DATABASE_URL must target the local nvf_award database on port 55432',
  );

  ensure(BASE_URL === 'http://localhost:3005', 'configuration', 'base URL is not the permitted local API');
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
    fail('configuration', 'ADMIN_EMAIL and ADMIN_PASSWORD are required');
  }
  return databaseUrl;
}

function createDatabase(databaseUrl) {
  return knexFactory({
    client: 'pg',
    connection: { connectionString: databaseUrl },
    pool: { min: 1, max: 3 },
  });
}

async function request(label, method, route, token, body) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const response = await fetch(`${BASE_URL}${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    let parsed = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { label, status: response.status, body: parsed };
  } catch {
    fail(label, 'request failed');
  } finally {
    clearTimeout(timer);
  }
}

function assertStatus(result, expected) {
  ensure(result.status === expected, result.label, `expected HTTP ${expected}, received ${result.status}`);
}

function extractPolicyMetadata(result) {
  const body = result.body;
  ensure(body && body.status === 'ok', result.label, 'response status is not ok');
  const policy = body.policy;
  ensure(policy && typeof policy === 'object', result.label, 'nested policy metadata is missing');
  ensure(Number.isSafeInteger(policy.revision) && policy.revision > 0, result.label, 'nested policy revision is invalid');
  ensure(typeof policy.updatedAt === 'string' && !Number.isNaN(Date.parse(policy.updatedAt)), result.label, 'nested policy timestamp is invalid');
  ensure(body.revision === policy.revision, result.label, 'top-level and nested revisions differ');
  ensure(body.updatedAt === policy.updatedAt, result.label, 'top-level and nested timestamps differ');
  return { revision: policy.revision, updatedAt: policy.updatedAt };
}

function extractRules(result) {
  extractPolicyMetadata(result);
  const rules = result.body && result.body.rules;
  ensure(rules && typeof rules === 'object' && rules.rules, result.label, 'rules payload is missing');
  ensure(typeof rules.version === 'string', result.label, 'rules version is missing');
  return rules;
}

function extractWindows(result) {
  extractPolicyMetadata(result);
  const windows = result.body && result.body.windows;
  ensure(windows && typeof windows === 'object' && !Array.isArray(windows), result.label, 'windows payload is missing');
  return windows;
}

function readMetadata(result) {
  return extractPolicyMetadata(result);
}

function comparableRules(rules) {
  const copy = cloneJson(rules);
  delete copy.version;
  return copy;
}

function ensureEqual(actual, expected, label, message) {
  ensure(canonicalJson(actual) === canonicalJson(expected), label, message);
}

async function login() {
  const result = await request('admin login', 'POST', '/admin/login', null, {
    email: process.env.ADMIN_EMAIL,
    password: process.env.ADMIN_PASSWORD,
  });
  assertStatus(result, 200);
  ensure(result.body && result.body.status === 'ok' && typeof result.body.token === 'string' && result.body.token.length > 0, result.label, 'login token was not returned');
  return result.body.token;
}

async function logout(token) {
  const result = await request('admin logout', 'POST', '/admin/logout', token);
  assertStatus(result, 200);
  ensure(result.body && result.body.status === 'ok', result.label, 'logout was not acknowledged');
}

async function readPolicy(token, labelPrefix) {
  const rulesResponse = await request(`${labelPrefix} rules`, 'GET', '/admin/rules', token);
  assertStatus(rulesResponse, 200);
  const windowsResponse = await request(`${labelPrefix} windows`, 'GET', '/admin/off-peak', token);
  assertStatus(windowsResponse, 200);
  const rules = extractRules(rulesResponse);
  const windows = extractWindows(windowsResponse);
  const rulesPolicy = readMetadata(rulesResponse);
  const windowsPolicy = readMetadata(windowsResponse);
  ensureEqual(rulesPolicy, windowsPolicy, `${labelPrefix} policy`, 'rules and windows metadata differ');
  return { rules, windows, policy: rulesPolicy };
}

async function readFirstEmaid(db) {
  try {
    const row = await db('users').select('uid').orderBy('id', 'asc').first();
    ensure(row && typeof row.uid === 'string' && row.uid.length > 0, 'database', 'no eMAID is available for the exact filter check');
    return row.uid;
  } catch {
    fail('database', 'could not read an eMAID for the filter check');
  }
}

async function readFinancialSnapshot(db) {
  try {
    const tableCounts = {};
    for (const table of FINANCIAL_TABLES) {
      const row = await db(table).count({ count: '*' }).first();
      tableCounts[table] = Number(row && row.count);
      ensure(Number.isSafeInteger(tableCounts[table]) && tableCounts[table] >= 0, 'database', `invalid count for ${table}`);
    }

    const users = await db('users')
      .select(['id', 'uid', 'wallet_address', 'created_at', 'updated_at'])
      .orderBy('id', 'asc');
    const balances = await db('balances')
      .select(['id', 'user_id', 'wallet_address', 'balance', 'total_awarded', 'total_spent', 'last_synced', 'created_at', 'updated_at'])
      .orderBy('id', 'asc');

    return {
      tableCounts,
      identityBalanceDigest: {
        algorithm: 'sha256',
        usersCount: users.length,
        balancesCount: balances.length,
        usersDigest: digestRows(users),
        balancesDigest: digestRows(balances),
      },
    };
  } catch (error) {
    if (error instanceof VerificationFailure) throw error;
    fail('database', 'could not capture financial table counts and digest');
  }
}

function assertOperationsBody(result, expectedEmaid) {
  ensure(result.body && result.body.status === 'ok' && Array.isArray(result.body.operations), result.label, 'operations response is not usable');
  if (expectedEmaid) {
    for (const operation of result.body.operations) {
      ensure(operation.eMAID === expectedEmaid, result.label, 'eMAID filter returned an unexpected record');
    }
  }
}

async function verifyOperations(token, emaid, includeNegativeChecks) {
  const all = await request('operations all', 'GET', '/admin/operations?scope=all&limit=25', token);
  assertStatus(all, 200);
  assertOperationsBody(all);

  const filteredRoute = `/admin/operations?scope=all&emaid=${encodeURIComponent(emaid)}&limit=25`;
  const filtered = await request('operations exact eMAID filter', 'GET', filteredRoute, token);
  assertStatus(filtered, 200);
  assertOperationsBody(filtered, emaid);

  const checks = {
    all: all.status,
    exactEmaid: filtered.status,
  };
  if (includeNegativeChecks) {
    const invalidUid = await request('operations invalid uid query', 'GET', '/admin/operations?scope=all&uid=legacy-only', token);
    assertStatus(invalidUid, 400);
    const invalidLimit = await request('operations invalid zero limit', 'GET', '/admin/operations?scope=all&limit=0', token);
    assertStatus(invalidLimit, 400);
    checks.invalidUid = invalidUid.status;
    checks.invalidLimitZero = invalidLimit.status;
  }
  return checks;
}

async function verifyUnauthenticatedOperations() {
  const result = await request('unauthenticated operations', 'GET', '/admin/operations?scope=all&limit=25');
  assertStatus(result, 401);
  return result.status;
}

async function runBefore(databaseUrl) {
  const result = { mode: 'before', baseUrl: BASE_URL, databaseTarget: 'localhost:55432/nvf_award', checks: {} };
  const db = createDatabase(databaseUrl);
  let token = null;
  let failure = null;
  try {
    token = await login();
    result.checks.login = 200;
    result.checks.unauthenticatedOperations = await verifyUnauthenticatedOperations();
    const emaid = await readFirstEmaid(db);
    result.checks.operations = await verifyOperations(token, emaid, true);
    const financialBefore = await readFinancialSnapshot(db);

    const initial = await readPolicy(token, 'initial');
    const sameRules = {
      offPeakChargingTokensPerKWh: initial.rules.rules.offPeakCharging.tokensPerKWh,
      v2gDischargeTokensPerKWh: initial.rules.rules.v2gDischarge.tokensPerKWh,
      offPeakChargingEnabled: initial.rules.rules.offPeakCharging.enabled,
      v2gDischargeEnabled: initial.rules.rules.v2gDischarge.enabled,
    };
    const savedRulesResponse = await request('same-value rules save', 'PUT', '/admin/rules', token, sameRules);
    assertStatus(savedRulesResponse, 200);
    const savedRules = extractRules(savedRulesResponse);
    const savedRulesPolicy = readMetadata(savedRulesResponse);
    ensure(savedRulesPolicy.revision === initial.policy.revision + 1, 'same-value rules save', 'policy revision did not increment');
    ensureEqual(comparableRules(savedRules), comparableRules(initial.rules), 'same-value rules save', 'rule values changed');
    result.checks.sameValueRulesSave = savedRulesResponse.status;

    const savedWindowsResponse = await request('same-value windows save', 'PUT', '/admin/off-peak', token, { windows: cloneJson(initial.windows) });
    assertStatus(savedWindowsResponse, 200);
    const savedWindows = extractWindows(savedWindowsResponse);
    const savedWindowsPolicy = readMetadata(savedWindowsResponse);
    ensure(savedWindowsPolicy.revision === savedRulesPolicy.revision + 1, 'same-value windows save', 'policy revision did not increment');
    ensureEqual(savedWindows, initial.windows, 'same-value windows save', 'window values changed');
    result.checks.sameValueWindowsSave = savedWindowsResponse.status;

    const finalPolicy = await readPolicy(token, 'final before');
    ensure(finalPolicy.policy.revision === savedWindowsPolicy.revision, 'final before policy', 'final policy revision differs from save response');
    ensureEqual(comparableRules(finalPolicy.rules), comparableRules(initial.rules), 'final before policy', 'final rule values changed');
    ensureEqual(finalPolicy.windows, initial.windows, 'final before policy', 'final window values changed');
    const financialAfter = await readFinancialSnapshot(db);
    ensureEqual(financialAfter.tableCounts, financialBefore.tableCounts, 'before financial state', 'financial table counts changed during policy saves');
    ensureEqual(financialAfter.identityBalanceDigest, financialBefore.identityBalanceDigest, 'before financial state', 'users/balances changed during policy saves');
    result.checks.financialStateUnchanged = 200;

    fs.mkdirSync(path.dirname(BASELINE_PATH), { recursive: true });
    fs.writeFileSync(BASELINE_PATH, JSON.stringify({
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      policy: {
        rules: cloneJson(finalPolicy.rules),
        windows: cloneJson(finalPolicy.windows),
        revision: finalPolicy.policy.revision,
        updatedAt: finalPolicy.policy.updatedAt,
      },
      financialTableCounts: financialAfter.tableCounts,
      identityBalanceDigest: financialAfter.identityBalanceDigest,
    }, null, 2) + '\n', 'utf8');
    result.baselineFile = 'outputs/local-admin-upgrade-baseline.json';
    result.policyRevision = finalPolicy.policy.revision;
    result.policyUpdatedAt = finalPolicy.policy.updatedAt;
    result.financialTableCounts = financialAfter.tableCounts;
    result.identityBalanceDigestUnchanged = true;
  } catch (error) {
    failure = error;
  } finally {
    if (token) {
      try {
        await logout(token);
        result.checks.logout = 200;
      } catch {
        result.checks.logout = 'failed';
        if (!failure) failure = new VerificationFailure('admin logout', 'logout failed');
      }
    }
    await db.destroy();
  }
  if (failure) {
    result.ok = false;
    result.error = publicError(failure);
    return result;
  }
  result.ok = true;
  return result;
}

function loadBaseline() {
  try {
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
    ensure(baseline && baseline.schemaVersion === 1 && baseline.policy && baseline.financialTableCounts && baseline.identityBalanceDigest, 'baseline', 'baseline is incomplete');
    return baseline;
  } catch (error) {
    if (error instanceof VerificationFailure) throw error;
    fail('baseline', 'could not read baseline file');
  }
}

async function runAfter(databaseUrl) {
  const baseline = loadBaseline();
  const result = { mode: 'after', baseUrl: BASE_URL, databaseTarget: 'localhost:55432/nvf_award', checks: {} };
  const db = createDatabase(databaseUrl);
  let token = null;
  let failure = null;
  try {
    token = await login();
    result.checks.freshLogin = 200;
    const emaid = await readFirstEmaid(db);
    result.checks.operations = await verifyOperations(token, emaid, false);
    const currentPolicy = await readPolicy(token, 'after');
    ensureEqual(currentPolicy.rules, baseline.policy.rules, 'after policy', 'saved rule values/revision did not survive restart');
    ensureEqual(currentPolicy.windows, baseline.policy.windows, 'after policy', 'saved windows did not survive restart');
    ensure(currentPolicy.policy.revision === baseline.policy.revision, 'after policy', 'saved revision did not survive restart');
    ensure(currentPolicy.policy.updatedAt === baseline.policy.updatedAt, 'after policy', 'saved update timestamp did not survive restart');
    result.checks.policyPersistence = 200;

    const financial = await readFinancialSnapshot(db);
    ensureEqual(financial.tableCounts, baseline.financialTableCounts, 'after database', 'financial table counts changed');
    ensureEqual(financial.identityBalanceDigest, baseline.identityBalanceDigest, 'after database', 'users/balances digest changed');
    result.checks.financialState = 200;
    result.policyRevision = currentPolicy.policy.revision;
    result.policyUpdatedAt = currentPolicy.policy.updatedAt;
    result.financialTableCountsUnchanged = true;
    result.identityBalanceDigestUnchanged = true;
  } catch (error) {
    failure = error;
  } finally {
    if (token) {
      try {
        await logout(token);
        result.checks.logout = 200;
      } catch {
        result.checks.logout = 'failed';
        if (!failure) failure = new VerificationFailure('admin logout', 'logout failed');
      }
    }
    await db.destroy();
  }
  if (failure) {
    result.ok = false;
    result.error = publicError(failure);
    return result;
  }
  result.ok = true;
  return result;
}

function publicError(error) {
  if (error instanceof VerificationFailure) return error.message;
  return 'verification failed';
}

async function main() {
  const mode = process.argv[2];
  if (mode !== 'before' && mode !== 'after') {
    console.log(JSON.stringify({ mode: mode || null, ok: false, error: 'usage: node scripts/verify-local-admin-upgrade.js before|after' }));
    process.exitCode = 1;
    return;
  }

  try {
    const databaseUrl = validateTargets();
    const result = mode === 'before' ? await runBefore(databaseUrl) : await runAfter(databaseUrl);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
  } catch (error) {
    console.log(JSON.stringify({ mode, ok: false, error: publicError(error) }, null, 2));
    process.exitCode = 1;
  }
}

void main();
