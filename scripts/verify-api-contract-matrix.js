/*
 * Real HTTP contract matrix for every finite NVF API route.
 *
 * This runner uses only the disposable PostgreSQL/Hardhat/API fixture from
 * verify-local-award-flow.js.  It records status/schema/error-language checks
 * without writing secrets, private keys, database URLs, or complete payloads
 * to the evidence file.  The source-level route inventory is run first and
 * remains a separate assertion so aliases, legacy branches, and mounted
 * routes cannot disappear from the matrix silently.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ethers } = require('ethers');
const { Pool } = require('pg');
const { EXPECTED_ROUTES, main: verifyRouteInventory } = require('./verify-api-route-inventory');
const harness = require('./verify-local-award-flow');

const APP_ROOT = path.resolve(__dirname, '..');
const EVIDENCE_PATH = path.join(APP_ROOT, 'outputs', 'api-contract-matrix-20260930.json');
function requiredPrivateKey(name) {
  const value = process.env[name];
  if (!/^0x[0-9a-fA-F]{64}$/.test(value || '')) {
    throw new Error(`${name} must be supplied as a 32-byte local test key; no key is embedded in this harness`);
  }
  return value;
}
const TREASURY_PRIVATE_KEY = requiredPrivateKey('NVF_LOCAL_TREASURY_PRIVATE_KEY');
const HARDHAT_ACCOUNT_ONE_PRIVATE_KEY = requiredPrivateKey('NVF_LOCAL_HARDHAT_ACCOUNT_ONE_PRIVATE_KEY');
const MATRIX_UID = 'local-matrix-emaid-001';
const MATRIX_CUSTODIAL_UID = 'local-matrix-custodial-001';
const MATRIX_PROVIDER = 'local-matrix-provider';
const MATRIX_TOKEN_HASH = `0x${'a'.repeat(64)}`;
const MATRIX_BEIA_API_KEY = 'matrix-beia-compatibility-key';
const forbiddenResponseFragments = [
  harness.API_KEY,
  harness.INGEST_API_KEY,
  MATRIX_BEIA_API_KEY,
  TREASURY_PRIVATE_KEY,
  HARDHAT_ACCOUNT_ONE_PRIVATE_KEY,
  'postgres://',
  'DATABASE_URL',
  'TREASURY_SIGNER_KEY',
];

const results = [];
const failures = [];
let pool;
let deployed;
let externalSigner;
let adminToken;
let manualOperationKey;
let primaryWalletAddress;
let acceptedAwardTxHash;

function routeKey(method, route) {
  return `${method.toUpperCase()} ${route}`;
}

function routePathMatches(actualRoute, expectedPath) {
  const actualPath = actualRoute.split('?')[0];
  if (expectedPath === '*') return true;
  const expression = expectedPath
    .split('/')
    .map(segment => segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('/');
  return new RegExp(`^${expression}$`).test(actualPath);
}

function buildRouteCoverage() {
  const literalRoutes = new Set(EXPECTED_ROUTES
    .filter(item => item.path !== '*' && !item.path.includes(':'))
    .map(item => routeKey(item.method, item.path)));
  const rows = EXPECTED_ROUTES.map(route => {
    const matchingCases = results.filter(result => (
      result.method.toUpperCase() === route.method
      && (route.path === '*'
        ? result.id === 'conditional-frontend-fallback'
        : routePathMatches(result.route, route.path)
          && !(route.path.includes(':') && literalRoutes.has(routeKey(result.method, result.route.split('?')[0]))))
    ));
    const categories = {
      authentication: matchingCases.filter(result => result.categories?.includes('authentication')).map(result => result.id),
      valid: matchingCases.filter(result => result.categories?.includes('valid')).map(result => result.id),
      invalid: matchingCases.filter(result => result.categories?.includes('invalid')).map(result => result.id),
      semantic: matchingCases.filter(result => result.categories?.includes('semantic')).map(result => result.id),
    };
    return {
      method: route.method,
      path: route.path,
      auth: route.auth,
      notes: route.notes || '',
      caseIds: matchingCases.map(result => result.id),
      statuses: matchingCases.map(result => result.actualStatus),
      categories,
      covered: matchingCases.length > 0,
    };
  });
  const missingCoverage = rows.filter(row => {
    if (!row.covered) return true;
    if (row.path === '*') return row.categories.valid.length === 0;
    if (row.auth === 'public') return row.categories.valid.length === 0;
    if (row.method === 'GET') return row.categories.authentication.length === 0 || row.categories.valid.length === 0;
    return row.categories.authentication.length === 0
      || row.categories.valid.length === 0
      || row.categories.invalid.length === 0;
  });
  return {
    rows,
    uncovered: missingCoverage.map(row => `${row.method} ${row.path}`),
    generated: [
      { method: 'HEAD', path: '/ingest/health', caseIds: results.filter(item => item.method === 'HEAD').map(item => item.id) },
      { method: 'OPTIONS', path: '/ingest/health', caseIds: results.filter(item => item.method === 'OPTIONS').map(item => item.id) },
    ],
  };
}

function headerSet(kind = 'api', extra = {}) {
  const headers = { ...extra };
  if (kind === 'api') headers['x-api-key'] = harness.API_KEY;
  if (kind === 'ingest') headers['x-ingest-api-key'] = harness.INGEST_API_KEY;
  if (kind === 'beia') headers['x-api-key'] = MATRIX_BEIA_API_KEY;
  if (kind === 'both') {
    headers['x-api-key'] = harness.API_KEY;
    headers['x-ingest-api-key'] = harness.INGEST_API_KEY;
  }
  return headers;
}

async function request(method, route, options = {}) {
  const headers = { ...(options.headers || {}) };
  const init = { method, headers };
  if (options.rawBody !== undefined) {
    init.body = options.rawBody;
    if (options.contentType) headers['content-type'] = options.contentType;
  } else if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(`${harness.resources.apiBaseUrl}${route}`, init);
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body,
    text,
  };
}

function serializedBody(response) {
  return JSON.stringify(response.body ?? response.text ?? '');
}

function assertNoSecrets(response, label) {
  const serialized = serializedBody(response);
  for (const fragment of forbiddenResponseFragments) {
    assert.ok(!serialized.includes(fragment), `${label} response leaked a forbidden secret/config fragment`);
  }
}

function assertNoTechnicalLeak(response, label) {
  const serialized = serializedBody(response);
  const technicalLeak = /(?:SyntaxError|TypeError|ReferenceError|Error:\s|at\s+[A-Za-z_$][\w$]*\.|SQLSTATE|\b(?:SELECT|INSERT|UPDATE|DELETE)\b|relation\s+\S+\s+does not exist|postgres(?:ql)?|knex|pg_|json[- ]?rpc|ethers|execution reverted|missing revert data|CALL_EXCEPTION|ECONNREFUSED|ENOTFOUND|stack trace)/i;
  assert.ok(!technicalLeak.test(serialized), `${label} response leaked a technical diagnostic: ${serialized}`);
}

function findMessage(body) {
  if (!body || typeof body !== 'object') return '';
  const candidates = [body.message, body.error, body.reason, body.failure?.message, body.detail];
  return candidates.find(value => typeof value === 'string' && value.trim()) || '';
}

const EXPECTED_ERROR_CONTRACTS = [
  { match: /^auth-missing-/, message: /required|authentication/i },
  { match: /^auth-invalid-/, message: /invalid|authentication/i },
  { match: /^auth-wrong-role-/, message: /invalid|required|authentication/i },
  { match: /^admin-login-invalid$/, message: /invalid credentials/i },
  { match: /^invalid-receipt-(?:empty|array-body)$/, message: /payload and signature/i },
  { match: /^invalid-receipt-null-body$/, code: 'INVALID_JSON', message: /valid JSON/i },
  { match: /^invalid-preview-(?:array-body|null-body|wrong-type)$/, message: /JSON|CDR|body/i },
  { match: /^invalid-preview-uid-only$|^ingest-preview-invalid-uid-only$/, code: 'INVALID_CDR', message: /eMAID|identity/i },
  { match: /^invalid-ingest-conflict$/, code: 'INVALID_CDR', message: /contradictory|eMAID|identity/i },
  { match: /^invalid-ingest-array-body$/, message: /JSON|CDR|body/i },
  { match: /^invalid-session-(?:missing-fields|array-body)$/, code: 'MISSING_REQUIRED_FIELDS', message: /sessionId|providerId|chargerId|status/i },
  { match: /^invalid-manual-spend-keyless$|^invalid-manual-spend-array-body$/, code: 'IDEMPOTENCY_KEY_REQUIRED', message: /idempotencyKey|operationKey/i },
  { match: /^invalid-manual-spend-null-body$/, code: 'INVALID_JSON', message: /valid JSON/i },
  { match: /^invalid-reservation-approval(?:-array-body)?$/, code: 'INVALID_RESERVATION_APPROVAL', message: /walletAddress|sessionId|providerId/i },
  { match: /^invalid-identity-spend(?:-array-body)?$/, code: 'MISSING_SESSION_ID', message: /sessionId/i },
  { match: /^invalid-reservation-not-found-malformed$/, code: 'INVALID_RESERVATION_ID', message: /valid UUID/i },
  { match: /^invalid-reservation-not-found-uuid$/, message: /not found/i },
  { match: /^invalid-wallet-mode(?:-array-body)?$/, message: /mode|managed|custodial/i },
  { match: /^invalid-wallet-profile-owner$/, message: /wallet ID/i },
  { match: /^invalid-wallet-profile-array-body$/, code: 'INVALID_WALLET_PROFILE', message: /body|walletName/i },
  { match: /^invalid-contract-id(?:-array-body)?$/, message: /wallet ID|contract ID/i },
  { match: /^invalid-linked-wallet(?:-array-body)?$/, message: /wallet address/i },
  { match: /^invalid-linked-profile-address$|^invalid-unlink-address$/, message: /wallet address/i },
  { match: /^invalid-move-funds-target$/, message: /targetAddress/i },
  { match: /^invalid-custodial-intent$|^invalid-custodial-failure$/, message: /uid|walletAddress|amount/i },
  { match: /^invalid-custodial-record(?:-array-body)?$/, message: /uid|walletAddress|txHash|amount/i },
  { match: /^invalid-json-raw-body$/, code: 'INVALID_JSON', message: /valid JSON/i },
  { match: /^invalid-json-array-raw-body$/, message: /idempotencyKey|operationKey|body/i },
  { match: /^invalid-body-oversized$/, code: 'REQUEST_BODY_TOO_LARGE', message: /too large/i },
  { match: /^invalid-route-method$/, code: 'ROUTE_NOT_FOUND', message: /route was not found/i },
  { match: /^receipt-verify-invalid-signature$/, message: /signature|receipt/i },
  { match: /^admin-reconciliation-run-invalid-limit$|^admin-reconciliation-run-invalid-(?:boolean|array)-limit$/, code: 'INVALID_RECONCILIATION_LIMIT', message: /integer between 1 and 1000/i },
  { match: /^admin-reconciliation-run-invalid-body$/, code: 'INVALID_RECONCILIATION_BODY', message: /body must be an object/i },
  { match: /^admin-reconciliation-get-invalid-(?:limit|repeated-limit)$/, code: 'INVALID_RECONCILIATION_LIMIT', message: /integer between 1 and 100/i },
  { match: /^admin-offpeak-delete-missing-country$/, message: /not found/i },
  { match: /^admin-operations-recover-invalid-body$/, code: 'INVALID_RECOVERY_REQUEST', message: /operationKey|overrides/i },
  { match: /^legacy-wallet-lookup-disabled$/, message: /disabled|wallet\/me/i },
];

function assertExpectedErrorContract(id, response) {
  const contract = EXPECTED_ERROR_CONTRACTS.find(item => item.match.test(id));
  if (!contract) return false;
  if (contract.code) assert.equal(response.body?.code, contract.code, `${id} returned an unexpected error code`);
  assert.match(findMessage(response.body), contract.message, `${id} returned an unexpected error message`);
  return true;
}

function safeSchema(body) {
  if (body === null || typeof body !== 'object') return { kind: typeof body };
  if (Array.isArray(body)) return { kind: 'array', length: body.length };
  return { kind: 'object', keys: Object.keys(body).sort() };
}

function assertEnglishError(response, label) {
  const message = findMessage(response.body);
  assert.ok(message.length >= 8, `${label} must return a clear English message/error field: ${serializedBody(response)}`);
  assert.match(message, /[A-Za-z]{3,}/, `${label} error must contain readable English text`);
  assertNoTechnicalLeak(response, label);
}

function assertJsonObject(response, label) {
  assert.ok(response.body && typeof response.body === 'object' && !Array.isArray(response.body), `${label} must return a JSON object`);
}

function redactRequest(options = {}) {
  const headers = Object.keys(options.headers || {}).sort();
  let body;
  if (options.rawBody !== undefined) {
    body = { rawType: typeof options.rawBody, byteLength: Buffer.byteLength(String(options.rawBody)), contentType: options.contentType || null };
  } else if (options.body === undefined) {
    body = undefined;
  } else if (options.body === null || typeof options.body !== 'object') {
    body = { type: typeof options.body };
  } else if (Array.isArray(options.body)) {
    body = { type: 'array', length: options.body.length };
  } else {
    body = Object.fromEntries(Object.entries(options.body).map(([key, value]) => [
      key,
      value === null ? 'null' : Array.isArray(value) ? `array(${value.length})` : typeof value,
    ]));
  }
  return { headerNames: headers, bodyShape: body };
}

async function caseRequest(id, method, route, options, expectation, validate) {
  const loweredId = id.toLowerCase();
  const categories = [];
  if (loweredId.startsWith('auth-') || loweredId.includes('wrong-role') || loweredId.includes('login-invalid')) categories.push('authentication');
  // Replays are successful idempotency/semantic cases, so keep them out of
  // the rejected-input category even though they exercise non-default state.
  if (/(invalid|missing|wrong|not-found|notfound|disabled|conflict|uid-only|malformed|keyless|oversized|unknown|delete-missing|raw-|array|wrong-type)/.test(loweredId)) categories.push('invalid');
  if (/(invalid-signature|uid-only|conflict|not-found|notfound|wrong-owner|wrong-identity|replay|disabled|wrong-role|malformed|keyless|oversized|unknown|raw-|array|wrong-type)/.test(loweredId)) categories.push('semantic');
  if (!categories.includes('invalid') && !categories.includes('authentication')) categories.push('valid');
  const result = {
    id,
    method,
    route,
    expectedStatus: expectation,
    actualStatus: null,
    passed: false,
    categories,
    request: redactRequest(options),
    assertions: ['expected-status', 'safe-response-no-secrets'],
    schema: null,
    message: null,
    sideEffect: null,
  };
  try {
    const response = await request(method, route, options);
    result.actualStatus = response.status;
    result.schema = safeSchema(response.body);
    result.message = findMessage(response.body) || null;
    assert.ok((Array.isArray(expectation) ? expectation : [expectation]).includes(response.status),
      `${id} expected ${expectation}, got ${response.status}: ${serializedBody(response)}`);
    assertNoSecrets(response, id);
    if (response.status >= 400) {
      assertEnglishError(response, id);
      result.assertions.push('english-error');
    }
    if (assertExpectedErrorContract(id, response)) {
      result.assertions.push('reviewed-error-contract');
    }
    if (validate) {
      await validate(response);
      result.assertions.push('route-specific-schema');
    }
    result.passed = true;
    return response;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
    failures.push({ id, error: result.error });
    return null;
  } finally {
    results.push(result);
  }
}

async function requiredCase(id, method, route, options, expectation, validate) {
  const response = await caseRequest(id, method, route, options, expectation, validate);
  if (!response) throw new Error(`${id} failed; see matrix result`);
  return response;
}

function makeCdr(sessionId, providerId, uid = MATRIX_UID, energy = '4') {
  return {
    SessionID: sessionId,
    ProviderID: providerId,
    EVSEID: 'DE*MATRIX*1',
    'Session Start': '2026-01-01T01:00:00Z',
    'Session End': '2026-01-01T02:00:00Z',
    'Consumed Energy': energy,
    cdr_token: { contract_id: uid },
  };
}

function signedWalletLinkMessage(uid, walletAddress, action) {
  return [
    `NEVERFLAT ${action} wallet address`,
    `EMP contract: ${uid}`,
    `Wallet address: ${ethers.getAddress(walletAddress)}`,
  ].join('\n');
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function createSignedReceipt() {
  const signer = new ethers.Wallet(TREASURY_PRIVATE_KEY);
  const walletResponse = await harness.getIdentityWallet();
  assert.equal(walletResponse.status, 200, `matrix receipt wallet lookup: ${JSON.stringify(walletResponse.body)}`);
  const payload = {
    version: '1.0',
    receiptId: 'spr_matrix_receipt',
    status: 'settled',
    contractId: MATRIX_UID,
    walletAddress: ethers.getAddress(walletResponse.body.walletAddress),
    amount: '1',
    sessionId: 'matrix-receipt-session',
    providerId: MATRIX_PROVIDER,
    tokenTxHash: MATRIX_TOKEN_HASH,
    tokenContractAddress: harness.resources.tokenAddress,
    chainId: 31337,
    issuedAt: '2026-01-01T00:00:00.000Z',
  };
  const canonicalPayload = canonicalJson(payload);
  const signature = await signer.signMessage(canonicalPayload);
  return { payload, signature, signerAddress: await signer.getAddress() };
}

async function financialSnapshot() {
  const tables = [
    'approval_preparations',
    'awards',
    'balances',
    'linked_wallet_links',
    'reward_policy',
    'spend_receipts',
    'spend_reservations',
    'spends',
    'token_operations',
    'users',
  ];
  const output = {};
  await Promise.all(tables.map(async table => {
    const result = await pool.query(`
      select count(*)::int as count,
        md5(coalesce(string_agg(row_to_json(t)::text, '|' order by row_to_json(t)::text), '')) as digest
      from ${table} t
    `);
    output[table] = { count: result.rows[0].count, digest: result.rows[0].digest };
  }));
  const chainAddresses = [primaryWalletAddress, deployed?.treasuryAddress, externalSigner ? await externalSigner.getAddress() : null]
    .filter(Boolean)
    .map(address => String(address).toLowerCase());
  const chain = {};
  for (const address of chainAddresses) {
    chain[address] = {
      balance: (await deployed.token.balanceOf(address)).toString(),
      nonce: await deployed.provider.getTransactionCount(address),
    };
  }
  return { tables: output, chain };
}

function assertNoSideEffect(before, after, label) {
  assert.deepEqual(after, before, `${label} changed financial rows: before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
}

async function runPublicCases() {
  await requiredCase('public-health-valid', 'GET', '/ingest/health', {}, 200, response => {
    assertJsonObject(response, 'public-health-valid');
    assert.equal(response.body.status, 'ok');
    assert.equal(typeof response.body.timestamp, 'string');
  });
  await requiredCase('public-openapi-valid', 'GET', '/openapi.json', {}, 200, response => {
    assertJsonObject(response, 'public-openapi-valid');
    assert.equal(typeof response.body.openapi, 'string');
    assert.ok(response.body.paths && response.body.paths['/ingest/cdr']);
  });
  for (const route of ['/docs', '/api-docs']) {
    await requiredCase(`public-docs-${route.slice(1).replace('-', '-')}`, 'GET', route, {}, 200, response => {
      assert.match(response.headers['content-type'] || '', /text\/html/i);
      assert.match(response.text, /swagger|<!doctype html/i);
    });
  }
  await requiredCase('generated-head-health', 'HEAD', '/ingest/health', {}, 200, response => {
    assert.equal(response.text, '');
  });
  await requiredCase('generated-options-health', 'OPTIONS', '/ingest/health', {
    headers: { origin: 'http://127.0.0.1', 'access-control-request-method': 'GET' },
  }, [200, 204], response => {
    assert.ok(response.headers['access-control-allow-origin']);
  });
  const frontendBuild = fs.existsSync(path.join(APP_ROOT, 'frontend', 'dist'));
  await requiredCase('conditional-frontend-fallback', 'GET', '/__api_contract_matrix_frontend_fallback__', {}, frontendBuild ? 200 : 404, response => {
    if (frontendBuild) {
      assert.match(response.headers['content-type'] || '', /text\/html/i);
      assert.match(response.text, /<!doctype html|<html/i);
    }
  });
}

async function runAuthenticationCases() {
  const inventory = EXPECTED_ROUTES.filter(item => item.auth !== 'public' && item.path !== '*');
  const replacements = {
    '/spend/reservations/:reservationId': '/spend/reservations/matrix-missing-reservation',
    '/wallet/:uid': `/wallet/${encodeURIComponent(MATRIX_UID)}`,
    '/wallet/:uid/mode': `/wallet/${encodeURIComponent(MATRIX_UID)}/mode`,
    '/wallet/:uid/profile': `/wallet/${encodeURIComponent(MATRIX_UID)}/profile`,
    '/wallet/:uid/contract-ids': `/wallet/${encodeURIComponent(MATRIX_UID)}/contract-ids`,
    '/wallet/:uid/linked-wallets': `/wallet/${encodeURIComponent(MATRIX_UID)}/linked-wallets`,
    '/wallet/:uid/linked-wallets/:walletAddress/profile': `/wallet/${encodeURIComponent(MATRIX_UID)}/linked-wallets/0x0000000000000000000000000000000000000001/profile`,
    '/wallet/:uid/linked-wallets/:walletAddress': `/wallet/${encodeURIComponent(MATRIX_UID)}/linked-wallets/0x0000000000000000000000000000000000000001`,
    '/wallet/:uid/move-funds': `/wallet/${encodeURIComponent(MATRIX_UID)}/move-funds`,
  };
  for (const item of inventory) {
    const route = replacements[item.path] || item.path;
    const method = item.method;
    const options = { body: method === 'GET' || method === 'DELETE' ? undefined : {} };
    await caseRequest(`auth-missing-${item.method}-${item.path}`, method, route, options, 401);
    const invalidHeaders = item.auth === 'admin'
      ? { 'x-api-key': 'invalid-matrix-api-key' }
      : item.auth === 'ingest'
        ? { 'x-ingest-api-key': 'invalid-matrix-ingest-key' }
        : { 'x-api-key': 'invalid-matrix-api-key' };
    await caseRequest(`auth-invalid-${item.method}-${item.path}`, method, route, {
      headers: invalidHeaders,
      body: method === 'GET' || method === 'DELETE' ? undefined : {},
    }, item.auth === 'admin' ? 401 : 403);
  }
  await requiredCase('admin-login-invalid', 'POST', '/admin/login', {
    body: { email: harness.ADMIN_EMAIL, password: 'wrong-local-password' },
  }, 401);
  await requiredCase('admin-login-valid', 'POST', '/admin/login', {
    body: { email: harness.ADMIN_EMAIL, password: harness.ADMIN_PASSWORD },
  }, 200, response => {
    assert.equal(response.body.status, 'ok');
    assert.ok(typeof response.body.token === 'string' && response.body.token.length > 10);
    adminToken = response.body.token;
  });
  await caseRequest('auth-wrong-role-api-key-on-admin', 'GET', '/admin/rules', {
    headers: headerSet('api'),
  }, 401);
  await caseRequest('auth-wrong-role-ingest-key-on-api', 'GET', '/transactions?limit=1', {
    headers: headerSet('ingest'),
  }, [401, 403]);
  await caseRequest('auth-wrong-role-api-key-on-ingest', 'POST', '/ingest/cdr/preview', {
    headers: headerSet('api'),
    body: makeCdr('matrix-wrong-role', MATRIX_PROVIDER),
  }, [401, 403]);
}

async function runInvalidAuthenticatedCases() {
  const cases = [
    ['invalid-receipt-empty', 'POST', '/spend-receipts/verify', { headers: headerSet('api'), body: {} }, 400],
    ['invalid-receipt-array-body', 'POST', '/spend-receipts/verify', { headers: headerSet('api'), body: [] }, 400],
    ['invalid-receipt-null-body', 'POST', '/spend-receipts/verify', { headers: headerSet('api'), body: null }, 400],
    ['invalid-preview-uid-only', 'POST', '/ingest/cdr/preview', {
      headers: headerSet('ingest'),
      body: { ...makeCdr('matrix-preview-invalid', MATRIX_PROVIDER), cdr_token: { uid: 'raw-only-token' } },
    }, 400],
    ['invalid-preview-array-body', 'POST', '/ingest/cdr/preview', { headers: headerSet('ingest'), body: [] }, 400],
    ['invalid-preview-null-body', 'POST', '/ingest/cdr/preview', { headers: headerSet('ingest'), body: null }, 400],
    ['invalid-preview-wrong-type', 'POST', '/ingest/cdr/preview', { headers: headerSet('ingest'), body: 'not-an-object' }, 400],
    ['invalid-ingest-conflict', 'POST', '/ingest/cdr', { headers: headerSet('ingest'), body: { ...makeCdr('matrix-invalid-conflict', MATRIX_PROVIDER), cdr_token: { contract_id: MATRIX_UID }, Identification: { RemoteIdentification: { EvcoID: 'other-emaid' } } } }, 400],
    ['invalid-ingest-array-body', 'POST', '/ingest/cdr', { headers: headerSet('ingest'), body: [] }, 400],
    ['invalid-session-missing-fields', 'POST', '/spend/session', { headers: { ...headerSet('api'), 'x-contract-id': MATRIX_UID }, body: {} }, 400],
    ['invalid-session-array-body', 'POST', '/spend/session', { headers: { ...headerSet('api'), 'x-contract-id': MATRIX_UID }, body: [] }, 400],
    ['invalid-manual-spend-keyless', 'POST', '/spend', { headers: headerSet('api'), body: { uid: MATRIX_UID, amount: 1 } }, 400],
    ['invalid-manual-spend-array-body', 'POST', '/spend', { headers: headerSet('api'), body: [] }, 400],
    ['invalid-manual-spend-null-body', 'POST', '/spend', { headers: headerSet('api'), body: null }, 400],
    ['invalid-reservation-approval', 'POST', '/spend/reservation-approval-intent', { headers: { ...headerSet('api'), 'x-contract-id': MATRIX_UID }, body: {} }, 400],
    ['invalid-reservation-approval-array-body', 'POST', '/spend/reservation-approval-intent', { headers: { ...headerSet('api'), 'x-contract-id': MATRIX_UID }, body: [] }, 400],
    ['invalid-identity-spend', 'POST', '/spend/me', { headers: { ...headerSet('api'), 'x-contract-id': MATRIX_UID }, body: {} }, 400],
    ['invalid-identity-spend-array-body', 'POST', '/spend/me', { headers: { ...headerSet('api'), 'x-contract-id': MATRIX_UID }, body: [] }, 400],
    ['invalid-reservation-not-found-malformed', 'GET', '/spend/reservations/matrix-not-found', { headers: { ...headerSet('api'), 'x-contract-id': MATRIX_UID } }, 400],
    ['invalid-reservation-not-found-uuid', 'GET', '/spend/reservations/00000000-0000-4000-8000-000000000099', { headers: { ...headerSet('api'), 'x-contract-id': MATRIX_UID } }, 404],
    ['invalid-wallet-mode', 'POST', `/wallet/${encodeURIComponent(MATRIX_UID)}/mode`, { headers: headerSet('api'), body: { mode: 'other' } }, 400],
    ['invalid-wallet-mode-array-body', 'POST', `/wallet/${encodeURIComponent(MATRIX_UID)}/mode`, { headers: headerSet('api'), body: [] }, 400],
    ['invalid-wallet-profile-owner', 'PATCH', '/wallet/%20/profile', { headers: headerSet('api'), body: { walletName: 'invalid owner' } }, 400],
    ['invalid-wallet-profile-array-body', 'PATCH', `/wallet/${encodeURIComponent(MATRIX_UID)}/profile`, { headers: headerSet('api'), body: [] }, 400],
    ['invalid-contract-id', 'POST', `/wallet/${encodeURIComponent(MATRIX_UID)}/contract-ids`, { headers: headerSet('api'), body: {} }, 400],
    ['invalid-contract-id-array-body', 'POST', `/wallet/${encodeURIComponent(MATRIX_UID)}/contract-ids`, { headers: headerSet('api'), body: [] }, 400],
    ['invalid-linked-wallet', 'POST', `/wallet/${encodeURIComponent(MATRIX_UID)}/linked-wallets`, { headers: headerSet('api'), body: { walletAddress: 'invalid', signature: 'invalid' } }, 400],
    ['invalid-linked-wallet-array-body', 'POST', `/wallet/${encodeURIComponent(MATRIX_UID)}/linked-wallets`, { headers: headerSet('api'), body: [] }, 400],
    ['invalid-linked-profile-address', 'PATCH', `/wallet/${encodeURIComponent(MATRIX_UID)}/linked-wallets/not-an-address/profile`, { headers: headerSet('api'), body: { walletName: 'invalid' } }, 400],
    ['invalid-unlink-address', 'DELETE', `/wallet/${encodeURIComponent(MATRIX_UID)}/linked-wallets/not-an-address`, { headers: headerSet('api'), body: {} }, 400],
    ['invalid-move-funds-target', 'POST', `/wallet/${encodeURIComponent(MATRIX_UID)}/move-funds`, { headers: headerSet('api'), body: { targetAddress: 'invalid' } }, 400],
    ['invalid-custodial-intent', 'POST', '/spend/custodial-intent', { headers: headerSet('api'), body: {} }, 400],
    ['invalid-custodial-failure', 'POST', '/spend/custodial-failure', { headers: headerSet('api'), body: {} }, 400],
    ['invalid-custodial-record', 'POST', '/spend/custodial-record', { headers: headerSet('api'), body: {} }, 400],
    ['invalid-custodial-record-array-body', 'POST', '/spend/custodial-record', { headers: headerSet('api'), body: [] }, 400],
    ['invalid-json-raw-body', 'POST', '/spend', { headers: headerSet('api'), rawBody: '{"uid":', contentType: 'application/json' }, 400],
    ['invalid-json-array-raw-body', 'POST', '/spend', { headers: headerSet('api'), rawBody: '[1,2,3]', contentType: 'application/json' }, 400],
    ['invalid-body-oversized', 'POST', '/spend', { headers: headerSet('api'), rawBody: JSON.stringify({ padding: 'x'.repeat(110 * 1024) }), contentType: 'application/json' }, 413],
    ['invalid-route-method', 'PUT', '/ingest/health', { headers: headerSet('api') }, 404],
    ['invalid-route-unknown', 'GET', '/__api_contract_matrix_unknown__', { headers: headerSet('api') }, 200],
    ['transactions-valid-empty-safe', 'GET', '/transactions?limit=1', { headers: headerSet('api') }, 200],
  ];
  for (const [id, method, route, options, expected] of cases) {
    const before = await financialSnapshot();
    const response = await caseRequest(id, method, route, options, expected);
    const after = await financialSnapshot();
    const result = results[results.length - 1];
    result.sideEffect = { unchanged: JSON.stringify(before) === JSON.stringify(after) };
    assertNoSideEffect(before, after, `${id} financial/wallet state`);
    if (response && id === 'invalid-route-unknown') {
      assert.equal(response.status, 200, 'frontend fallback is the documented conditional GET branch');
    }
  }
}

async function runValidWalletAndIdentityCases() {
  const wallet = await requiredCase('wallet-me-valid', 'GET', '/wallet/me', {
    headers: { ...headerSet('api'), 'x-contract-id': MATRIX_UID },
  }, 200, response => {
    assert.equal(typeof response.body.walletAddress, 'string');
    assert.ok(Array.isArray(response.body.history));
  });
  await requiredCase('wallet-legacy-valid', 'GET', `/wallet/${encodeURIComponent(MATRIX_UID)}`, {
    headers: headerSet('api'),
  }, 200, response => {
    assert.equal(response.body.walletAddress.toLowerCase(), wallet.body.walletAddress.toLowerCase());
  });
  await requiredCase('wallet-profile-valid', 'PATCH', `/wallet/${encodeURIComponent(MATRIX_UID)}/profile`, {
    headers: headerSet('api'),
    body: { walletName: 'Matrix wallet' },
  }, 200, response => assert.equal(response.body.message, 'Wallet name updated'));
  await requiredCase('wallet-contract-id-valid', 'POST', `/wallet/${encodeURIComponent(MATRIX_UID)}/contract-ids`, {
    headers: headerSet('api'),
    body: { contractId: 'local-matrix-linked-emaid' },
  }, 200, response => assert.equal(response.body.message, 'Contract ID linked to wallet'));
  const session = await requiredCase('spend-session-valid', 'POST', '/spend/session', {
    headers: { ...headerSet('api'), 'x-contract-id': MATRIX_UID },
    body: {
      sessionId: 'matrix-session-prompt',
      providerId: MATRIX_PROVIDER,
      chargerId: 'matrix-charger',
      status: 'SESSION_STARTED',
      estimatedKwh: 2,
      estimatedCost: 1,
    },
  }, 200, response => {
    assert.equal(response.body.status, 'success');
    assert.ok(response.body.spend && typeof response.body.spend.eligible === 'boolean');
  });
  return { wallet, session };
}

async function runValidReceiptAndIngestCases() {
  const signedReceipt = await createSignedReceipt();
  await requiredCase('receipt-verify-valid', 'POST', '/spend-receipts/verify', {
    headers: headerSet('api'),
    body: signedReceipt,
  }, 200, response => {
    assert.equal(response.body.status, 'valid');
    assert.equal(response.body.valid, true);
  });
  await requiredCase('receipt-verify-invalid-signature', 'POST', '/spend-receipts/verify', {
    headers: headerSet('api'),
    body: { ...signedReceipt, signature: `0x${'1'.repeat(130)}` },
  }, 200, response => assert.equal(response.body.valid, false));

  const preview = await requiredCase('ingest-preview-valid', 'POST', '/ingest/cdr/preview', {
    headers: headerSet('ingest'),
    body: makeCdr('matrix-preview', MATRIX_PROVIDER),
  }, 200, response => {
    assert.equal(response.body.sideEffects, false);
    assert.equal(response.body.normalised.eMAID, MATRIX_UID);
    assert.ok(response.body.normalisation.protocol);
  });
  assert.equal(preview.body.normalised.sourceField, 'cdr_token.contract_id');
  await requiredCase('ingest-preview-invalid-uid-only', 'POST', '/ingest/cdr/preview', {
    headers: headerSet('ingest'),
    body: { ...makeCdr('matrix-preview-invalid', MATRIX_PROVIDER), cdr_token: { uid: 'raw-only-token' } },
  }, 400, response => {
    assert.equal(response.body.code, 'INVALID_CDR');
    assert.ok(response.body.normalisationError);
  });
  await requiredCase('beia-compatibility-ingest-preview-valid', 'POST', '/ingest/cdr/preview', {
    headers: headerSet('beia'),
    body: makeCdr('matrix-beia-compat', MATRIX_PROVIDER),
  }, 200, response => {
    assert.equal(response.body.sideEffects, false);
    assert.equal(response.body.normalised.eMAID, MATRIX_UID);
  });

  const cdr = makeCdr('matrix-award', MATRIX_PROVIDER);
  const accepted = await requiredCase('ingest-valid', 'POST', '/ingest/cdr', {
    headers: headerSet('ingest'),
    body: cdr,
  }, 200, response => {
    assert.equal(response.body.status, 'accepted');
    assert.equal(response.body.normalisation.eMAID, MATRIX_UID);
    assert.ok(response.body.txHash);
    acceptedAwardTxHash = response.body.txHash;
  });
  await requiredCase('ingest-replay-idempotent', 'POST', '/ingest/cdr', {
    headers: headerSet('ingest'),
    body: cdr,
  }, 200, response => {
    assert.equal(response.body.status, 'duplicate');
    assert.equal(response.body.txHash, acceptedAwardTxHash);
  });
  return accepted;
}

async function runValidReservationAndSpendCases() {
  const reservation = await requiredCase('spend-me-reservation-valid', 'POST', '/spend/me', {
    headers: { ...headerSet('api'), 'x-contract-id': MATRIX_UID },
    body: {
      sessionId: 'matrix-reservation-session',
      providerId: 'matrix-reservation-provider',
      amount: 1,
      label: 'matrix reservation',
    },
  }, 200, response => {
    assert.equal(response.body.status, 'success');
    assert.ok(response.body.reservation?.id);
  });
  const reservationId = reservation.body.reservation.id;
  await requiredCase('spend-me-reservation-replay-valid', 'POST', '/spend/me', {
    headers: { ...headerSet('api'), 'x-contract-id': MATRIX_UID },
    body: {
      sessionId: 'matrix-reservation-session',
      providerId: 'matrix-reservation-provider',
      amount: 1,
      label: 'matrix reservation replay',
    },
  }, 200, response => {
    assert.equal(response.body.reservation.id, reservationId);
    assert.equal(response.body.reservation.status, 'reserved');
  });
  await requiredCase('reservation-status-valid', 'GET', `/spend/reservations/${encodeURIComponent(reservationId)}`, {
    headers: { ...headerSet('api'), 'x-contract-id': MATRIX_UID },
  }, 200, response => {
    assert.equal(response.body.reservationId, reservationId);
  });

  const settlement = await requiredCase('reservation-settlement-valid', 'POST', '/ingest/cdr', {
    headers: headerSet('ingest'),
    body: makeCdr('matrix-reservation-session', 'matrix-reservation-provider', MATRIX_UID, '4'),
  }, 200, response => {
    assert.equal(response.body.status, 'accepted');
    assert.equal(response.body.reservationSettlement.status, 'settled');
    assert.ok(response.body.reservationSettlement.spendReceipt);
  });
  await requiredCase('reservation-status-settled', 'GET', `/spend/reservations/${encodeURIComponent(reservationId)}`, {
    headers: { ...headerSet('api'), 'x-contract-id': MATRIX_UID },
  }, 200, response => {
    assert.equal(response.body.status, 'settled');
    assert.equal(response.body.receiptStatus, 'settled');
    assert.ok(response.body.spendReceipt);
  });

  const beforeManualSpend = await financialSnapshot();
  const spend = await requiredCase('manual-spend-valid', 'POST', '/spend', {
    headers: headerSet('api'),
    body: {
      uid: MATRIX_UID,
      amount: 1,
      sessionId: 'matrix-manual-session',
      providerId: 'matrix-manual-provider',
      idempotencyKey: 'matrix-manual-key',
      label: 'matrix manual spend',
    },
  }, 200, response => {
    assert.equal(response.body.status, 'success');
    assert.equal(response.body.movementOutcome, 'confirmed');
    assert.equal(response.body.tokensSpent, 1);
    assert.ok(response.body.operationKey);
    assert.ok(response.body.spendReceipt);
    if (typeof response.body.operationKey === 'string' && response.body.operationKey) {
      manualOperationKey = response.body.operationKey;
    }
  });
  const afterManualSpend = await financialSnapshot();
  assert.notDeepEqual(afterManualSpend, beforeManualSpend, 'manual spend must change disposable financial state');
  const beforeManualReplay = await financialSnapshot();
  await requiredCase('manual-spend-replay-valid', 'POST', '/spend', {
    headers: headerSet('api'),
    body: {
      uid: MATRIX_UID,
      amount: 1,
      sessionId: 'matrix-manual-session',
      providerId: 'matrix-manual-provider',
      idempotencyKey: 'matrix-manual-key',
      label: 'matrix manual spend replay',
    },
  }, 200, response => {
    assert.equal(response.body.status, 'success');
    assert.equal(response.body.movementOutcome, 'confirmed');
    assert.equal(response.body.operationKey, manualOperationKey);
    assert.ok(response.body.spendReceipt);
  });
  const afterManualReplay = await financialSnapshot();
  assertNoSideEffect(beforeManualReplay, afterManualReplay, 'manual spend replay');
  return { reservation, settlement, spend };
}

async function runValidCustodialAndLinkedCases() {
  externalSigner = new ethers.Wallet(HARDHAT_ACCOUNT_ONE_PRIVATE_KEY, deployed.provider);
  const externalAddress = await externalSigner.getAddress();
  const linkSignature = await externalSigner.signMessage(signedWalletLinkMessage(MATRIX_CUSTODIAL_UID, externalAddress, 'link'));
  await requiredCase('linked-wallet-valid', 'POST', `/wallet/${encodeURIComponent(MATRIX_CUSTODIAL_UID)}/linked-wallets`, {
    headers: headerSet('api'),
    body: { walletAddress: externalAddress, signature: linkSignature },
  }, 200, response => assert.equal(response.body.message, 'Wallet address linked'));
  await requiredCase('linked-wallet-profile-valid', 'PATCH', `/wallet/${encodeURIComponent(MATRIX_CUSTODIAL_UID)}/linked-wallets/${encodeURIComponent(externalAddress)}/profile`, {
    headers: headerSet('api'),
    body: { walletName: 'Matrix external wallet' },
  }, 200, response => assert.equal(response.body.message, 'Linked wallet name saved'));
  await requiredCase('wallet-mode-custodial-valid', 'POST', `/wallet/${encodeURIComponent(MATRIX_CUSTODIAL_UID)}/mode`, {
    headers: headerSet('api'),
    body: { mode: 'custodial', walletAddress: externalAddress, allowSplit: true },
  }, 200, response => assert.equal(response.body.walletMode, 'custodial'));

  await (await deployed.token.transfer(externalAddress, ethers.parseUnits('4', 18))).wait();
  const approvalTx = await deployed.token.connect(externalSigner).approve(deployed.treasuryAddress, ethers.parseUnits('4', 18));
  await approvalTx.wait();
  await requiredCase('reservation-approval-intent-valid', 'POST', '/spend/reservation-approval-intent', {
    headers: { ...headerSet('api'), 'x-contract-id': MATRIX_CUSTODIAL_UID },
    body: {
      walletAddress: externalAddress,
      amount: 1,
      sessionId: 'matrix-custodial-reservation',
      providerId: 'matrix-custodial-provider',
    },
  }, 200, response => assert.equal(response.body.status, 'requires_signature'));
  await requiredCase('custodial-intent-valid', 'POST', '/spend/custodial-intent', {
    headers: headerSet('api'),
    body: {
      uid: MATRIX_CUSTODIAL_UID,
      walletAddress: externalAddress,
      amount: 0.5,
      sessionId: 'matrix-custodial-intent',
      providerId: 'matrix-custodial-provider',
    },
  }, 200, response => assert.equal(response.body.status, 'requires_signature'));
  await requiredCase('custodial-failure-valid', 'POST', '/spend/custodial-failure', {
    headers: headerSet('api'),
    body: {
      uid: MATRIX_CUSTODIAL_UID,
      walletAddress: externalAddress,
      amount: 0.5,
      sessionId: 'matrix-custodial-failure',
      providerId: 'matrix-custodial-provider',
      intentId: 'matrix-custodial-intent',
      reason: 'matrix test signing was cancelled',
    },
  }, 200, response => assert.equal(response.body.status, 'retry_required'));

  await requiredCase('custodial-spend-reservation-valid', 'POST', '/spend/me', {
    headers: { ...headerSet('api'), 'x-contract-id': MATRIX_CUSTODIAL_UID },
    body: {
      walletAddress: externalAddress,
      amount: 1,
      sessionId: 'matrix-custodial-reservation',
      providerId: 'matrix-custodial-provider',
      authorizationTxHash: approvalTx.hash,
    },
  }, 200, response => assert.equal(response.body.status, 'success'));

  const custodialTransfer = await deployed.token.connect(externalSigner).transfer(deployed.treasuryAddress, ethers.parseUnits('0.5', 18));
  await custodialTransfer.wait();
  await requiredCase('custodial-record-valid', 'POST', '/spend/custodial-record', {
    headers: headerSet('api'),
    body: {
      uid: MATRIX_CUSTODIAL_UID,
      walletAddress: externalAddress,
      amount: 0.5,
      txHash: custodialTransfer.hash,
      sessionId: 'matrix-custodial-record',
      providerId: 'matrix-custodial-provider',
    },
  }, 200, response => {
    assert.equal(response.body.status, 'success');
    assert.ok(response.body.spendReceipt);
  });

  const unlinkSignature = await externalSigner.signMessage(signedWalletLinkMessage(MATRIX_CUSTODIAL_UID, externalAddress, 'unlink'));
  await requiredCase('linked-wallet-delete-valid', 'DELETE', `/wallet/${encodeURIComponent(MATRIX_CUSTODIAL_UID)}/linked-wallets/${encodeURIComponent(externalAddress)}`, {
    headers: headerSet('api'),
    body: { signature: unlinkSignature },
  }, 200, response => assert.equal(response.body.message, 'Wallet address unlinked'));
  return { externalAddress };
}

async function runMoveFundsAndAdminCases() {
  assert.ok(adminToken, 'admin login must precede admin route matrix');
  const adminHeaders = { Authorization: `Bearer ${adminToken}` };
  const adminCases = [
    ['admin-rules-get-valid', 'GET', '/admin/rules', undefined, 200],
    ['admin-rules-put-valid', 'PUT', '/admin/rules', { offPeakChargingTokensPerKWh: 0.25, v2gDischargeTokensPerKWh: 1, offPeakChargingEnabled: true, v2gDischargeEnabled: true }, 200],
    ['admin-offpeak-get-valid', 'GET', '/admin/off-peak', undefined, 200],
    ['admin-audit-get-valid', 'GET', '/admin/audit?limit=5', undefined, 200],
    ['admin-metrics-get-valid', 'GET', '/admin/pilot-metrics?hours=24', undefined, 200],
    ['admin-readiness-get-valid', 'GET', '/admin/readiness', undefined, 200],
    ['admin-alert-test-valid', 'POST', '/admin/alerts/test', {}, 202],
    ['admin-evidence-pack-valid', 'GET', '/admin/evidence-pack', undefined, 200],
    ['admin-reconciliation-run-invalid-limit', 'POST', '/admin/reconciliation/run', { limit: 'bad' }, 400],
    ['admin-reconciliation-run-invalid-boolean-limit', 'POST', '/admin/reconciliation/run', { limit: true }, 400],
    ['admin-reconciliation-run-invalid-array-limit', 'POST', '/admin/reconciliation/run', { limit: [1] }, 400],
    ['admin-reconciliation-run-invalid-body', 'POST', '/admin/reconciliation/run', [], 400],
    ['admin-reconciliation-get-valid', 'GET', '/admin/reconciliation?limit=5', undefined, 200],
    ['admin-reconciliation-get-invalid-limit', 'GET', '/admin/reconciliation?limit=bad', undefined, 400],
    ['admin-reconciliation-get-invalid-repeated-limit', 'GET', '/admin/reconciliation?limit=1&limit=2', undefined, 400],
    ['admin-offpeak-put-valid', 'PUT', '/admin/off-peak', { windows: { DE: [{ start: '22:00', end: '06:00' }] } }, 200],
    ['admin-offpeak-delete-valid', 'DELETE', '/admin/off-peak/DE', undefined, 200],
    ['admin-offpeak-delete-missing-country', 'DELETE', '/admin/off-peak/ZZ', undefined, 404],
    ['admin-operations-get-valid', 'GET', '/admin/operations?scope=all&limit=50', undefined, 200],
    ['admin-operations-recover-invalid-body', 'POST', '/admin/operations/recover', {}, 400],
  ];
  for (const [id, method, route, body, expected] of adminCases) {
    const response = await caseRequest(id, method, route, { headers: adminHeaders, ...(body === undefined ? {} : { body }) }, expected);
    if (id === 'admin-alert-test-valid' && response) {
      assert.equal(response.body.status, 'sent_or_queued');
      assert.equal(response.body.webhookConfigured, true);
      assert.equal(response.body.webhookStatus, 204);
      await new Promise(resolve => setTimeout(resolve, 30));
      assert.ok(harness.resources.alertWebhook?.state.deliveries.some(item => item.body?.eventType === 'admin_alert.test'));
    }
    if (id === 'admin-reconciliation-run-valid' && response) {
      assert.equal(response.body.status, 'ok');
      assert.equal(response.body.report.status, 'matched', JSON.stringify(response.body.report));
      assert.equal(response.body.report.mismatch_count, 0, JSON.stringify(response.body.report));
    }
    if (id === 'admin-reconciliation-run-invalid-body' && response) {
      assert.equal(response.body.code, 'INVALID_RECONCILIATION_BODY');
      assert.match(response.body.message, /body must be an object/i);
    }
    if (id.startsWith('admin-reconciliation-run-invalid-') && id !== 'admin-reconciliation-run-invalid-body' && response) {
      assert.equal(response.body.code, 'INVALID_RECONCILIATION_LIMIT');
      assert.match(response.body.message, /integer between 1 and 1000/);
    }
    if (id.startsWith('admin-reconciliation-get-invalid-') && response) {
      assert.equal(response.body.code, 'INVALID_RECONCILIATION_LIMIT');
      assert.match(response.body.message, /integer between 1 and 100/);
    }
  }
  if (manualOperationKey) {
    await requiredCase('admin-operations-recover-existing-valid', 'POST', '/admin/operations/recover', {
      headers: adminHeaders,
      body: { operationKey: manualOperationKey },
    }, 200, response => {
      assertJsonObject(response, 'admin-operations-recover-existing-valid');
      assert.ok(response.body.status || response.body.code || response.body.message);
    });
  }
  await requiredCase('admin-logout-valid', 'POST', '/admin/logout', { headers: adminHeaders }, 200, response => assert.equal(response.body.status, 'ok'));

  // Run this after reconciliation: moving managed-wallet funds is an intentional
  // chain-only operation and should therefore be reported as a mismatch by any
  // later reconciliation run. Keeping it last preserves a strict matched proof.
  const target = externalSigner ? await externalSigner.getAddress() : '0x0000000000000000000000000000000000000001';
  const sourceBefore = await deployed.token.balanceOf(primaryWalletAddress);
  const targetBefore = await deployed.token.balanceOf(target);
  let moveAmountUnits = 0n;
  await requiredCase('move-funds-valid', 'POST', `/wallet/${encodeURIComponent(MATRIX_UID)}/move-funds`, {
    headers: headerSet('api'),
    body: { targetAddress: target },
  }, 200, response => {
    assert.equal(response.body.status, 'success');
    assert.ok(response.body.txHash);
    assert.ok(Number(response.body.amount) > 0);
    moveAmountUnits = ethers.parseUnits(String(response.body.amount), 18);
  });
  const sourceAfter = await deployed.token.balanceOf(primaryWalletAddress);
  const targetAfter = await deployed.token.balanceOf(target);
  assert.ok(sourceAfter < sourceBefore, 'move-funds reduced the managed wallet balance');
  assert.ok(targetAfter > targetBefore, 'move-funds increased the target wallet balance');
  assert.equal(sourceBefore - sourceAfter, moveAmountUnits, 'move-funds source delta matches response amount');
  assert.equal(targetAfter - targetBefore, moveAmountUnits, 'move-funds target delta matches response amount');
}

async function runInitialAdminReconciliationCase() {
  assert.ok(adminToken, 'admin login must precede initial reconciliation');
  const response = await requiredCase('admin-reconciliation-run-valid', 'POST', '/admin/reconciliation/run', {
    headers: { Authorization: `Bearer ${adminToken}` },
    body: { limit: 50 },
  }, 200, result => {
    assert.equal(result.body.status, 'ok');
    assert.equal(result.body.report.status, 'matched', JSON.stringify(result.body.report));
    assert.equal(result.body.report.mismatch_count, 0, JSON.stringify(result.body.report));
  });
  assert.ok(response.body.report);
}

async function runLegacyFlagCase() {
  await harness.stopApi();
  await harness.startApi(deployed.treasuryAddress, { enableTestUidLookup: false });
  await requiredCase('legacy-wallet-lookup-disabled', 'GET', `/wallet/${encodeURIComponent(MATRIX_UID)}`, {
    headers: headerSet('api'),
  }, 403, response => {
    assert.equal(response.body.message, 'Manual contract ID lookup is disabled. Use authenticated identity endpoint /wallet/me.');
  });
}

async function main() {
  const evidence = {
    status: 'failed',
    generatedAt: new Date().toISOString(),
    routeInventory: {
      expectedConcreteRoutes: EXPECTED_ROUTES.filter(item => item.path !== '*').length,
      expectedConditionalRoutes: EXPECTED_ROUTES.filter(item => item.path === '*').length,
      generatedHeadAndOptions: true,
    },
    scope: 'all finite source routes; real HTTP requests against disposable PostgreSQL + Hardhat 31337 API',
    cases: results,
    failures,
  };
  try {
    verifyRouteInventory();
    await harness.startDatabase();
    const { provider } = await harness.startHardhat();
    deployed = await harness.deployToken(provider);
    const alertWebhook = await harness.startAlertWebhook();
    await harness.startApi(deployed.treasuryAddress, {
      enableTestUidLookup: true,
      beiaApiKey: MATRIX_BEIA_API_KEY,
      adminAlertWebhookUrl: alertWebhook.url,
    });
    pool = new Pool({ connectionString: harness.resources.databaseUrl, max: 3, connectionTimeoutMillis: 3000 });

    const primaryWalletResponse = await harness.getIdentityWalletFor(MATRIX_UID);
    assert.equal(primaryWalletResponse.status, 200, `matrix primary wallet lookup: ${JSON.stringify(primaryWalletResponse.body)}`);
    primaryWalletAddress = primaryWalletResponse.body.walletAddress;

    await runPublicCases();
    await runAuthenticationCases();
    await runInitialAdminReconciliationCase();
    await (await deployed.token.transfer(primaryWalletResponse.body.walletAddress, ethers.parseUnits('20', 18))).wait();
    await runInvalidAuthenticatedCases();
    await runValidWalletAndIdentityCases();
    await runValidReceiptAndIngestCases();
    await runValidReservationAndSpendCases();
    await runValidCustodialAndLinkedCases();
    await runMoveFundsAndAdminCases();
    await runLegacyFlagCase();

    evidence.status = failures.length === 0 ? 'passed' : 'failed';
    evidence.caseCount = results.length;
    evidence.passedCases = results.filter(item => item.passed).length;
    evidence.failedCases = failures.length;
    evidence.resources = {
      chainId: 31337,
      dbPort: harness.resources.dbPort,
      apiPort: harness.resources.apiPort,
      hardhatPort: harness.resources.hardhatPort,
    };
  } catch (error) {
    evidence.status = 'failed';
    evidence.error = error instanceof Error ? error.message : String(error);
  } finally {
    if (pool) await pool.end().catch(() => undefined);
    const routeCoverage = buildRouteCoverage();
    if (routeCoverage.uncovered.length) {
      failures.push({ id: 'route-coverage', error: `Missing required route categories: ${routeCoverage.uncovered.join(', ')}` });
      evidence.status = 'failed';
      evidence.error = evidence.error
        ? `${evidence.error}; ${`Missing required route categories: ${routeCoverage.uncovered.join(', ')}`}`
        : `Missing required route categories: ${routeCoverage.uncovered.join(', ')}`;
    }
    evidence.cases = results;
    evidence.failures = failures;
    evidence.caseCount = results.length;
    evidence.passedCases = results.filter(item => item.passed).length;
    evidence.failedCases = failures.length;
    evidence.routeCoverage = routeCoverage;
    fs.mkdirSync(path.dirname(EVIDENCE_PATH), { recursive: true });
    fs.writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2), 'utf8');
    await harness.cleanup();
  }
  console.log(JSON.stringify({
    status: evidence.status,
    evidencePath: EVIDENCE_PATH,
    caseCount: evidence.caseCount,
    passedCases: evidence.passedCases,
    failedCases: evidence.failedCases,
    error: evidence.error,
  }, null, 2));
  if (evidence.status !== 'passed') process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    console.error(JSON.stringify({ status: 'failed', error: error?.message || String(error) }, null, 2));
    process.exitCode = 1;
  });
}

module.exports = { main, request, caseRequest };
