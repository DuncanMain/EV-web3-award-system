#!/usr/bin/env node

/**
 * Bounded, read-only production contract smoke checks for NEVERFLAT.
 *
 * Credentials are read only from the process environment. This script does
 * not load .env files, print credentials, follow redirects, submit financial
 * operations, or store request bodies. It is suitable for a post-deployment
 * GitHub Actions gate when BEIA_API_KEY is supplied as a secret.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const DEFAULT_BASE_URL = 'https://neverflat.zentrix.io';
const AUTHORIZED_HOST = 'neverflat.zentrix.io';
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CONTRACT_ID = '3';
const DEFAULT_UNLINKED_WALLET_ADDRESS = '0x281cdB9F9407Ad029a6d7d5d9989a8362CDb7A59';

// The current release has at least 38 core concrete operations. The check
// derives the full expected set from source so additive routes, including
// admin alert settings, become part of the gate without another hard-coded
// list.
const MINIMUM_OPERATION_COUNT = 38;

function boundedTimeout(value) {
  const parsed = Number(value || DEFAULT_TIMEOUT_MS);
  return Number.isSafeInteger(parsed) && parsed >= 1_000 && parsed <= 30_000
    ? parsed
    : DEFAULT_TIMEOUT_MS;
}

function safeBaseUrl(value) {
  const parsed = new URL(value || DEFAULT_BASE_URL);
  if (parsed.protocol !== 'https:' || parsed.hostname !== AUTHORIZED_HOST || parsed.port) {
    throw new Error(`LIVE_API_BASE_URL must be https://${AUTHORIZED_HOST}`);
  }
  return parsed.origin;
}

function normalizeRoute(route) {
  return route.replace(/:([A-Za-z0-9_]+)/g, '{$1}');
}

function joinMountedRoute(mount, child) {
  const normalizedMount = mount.replace(/\/$/, '') || '/';
  const normalizedChild = child === '/' ? '' : child;
  return normalizeRoute(`${normalizedMount}${normalizedChild}` || '/');
}

function routeOperations(source, receiver) {
  return [
    ...source.matchAll(new RegExp(`${receiver}\\.(get|post|put|patch|delete)\\((['"])([^'"]+)\\2`, 'g')),
  ].map(match => `${match[1].toUpperCase()} ${normalizeRoute(match[3])}`);
}

function mountedRouterOperations(apiSource, apiSourcePath) {
  const operations = [];
  const mountPattern = /app\.use\(\s*(['"])(\/[^'"]+)\1[\s\S]{0,2000}?([A-Za-z_$][A-Za-z0-9_$]*Router)\s*\(/g;
  for (const match of apiSource.matchAll(mountPattern)) {
    const mountPath = match[2];
    const routerFactory = match[3];
    const importPattern = new RegExp(`import\\s+\\{[^}]*\\b${routerFactory}\\b[^}]*\\}\\s+from\\s+['"]([^'"]+)['"]`);
    const importMatch = apiSource.match(importPattern);
    if (!importMatch) continue;
    const importedPath = importMatch[1];
    const modulePath = path.resolve(path.dirname(apiSourcePath), importedPath.endsWith('.ts') ? importedPath : `${importedPath}.ts`);
    if (!fs.existsSync(modulePath)) continue;
    const routerSource = fs.readFileSync(modulePath, 'utf8');
    for (const operation of routeOperations(routerSource, 'router')) {
      const [method, child] = operation.split(' ');
      operations.push(`${method} ${joinMountedRoute(mountPath, child)}`);
    }
  }
  return operations;
}

function sourceOperations() {
  const sourcePath = path.join(__dirname, '..', 'src', 'api.ts');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const direct = routeOperations(source, 'app')
    .filter(operation => !operation.startsWith('GET /openapi.json') && operation !== 'GET *');
  direct.push(...mountedRouterOperations(source, sourcePath));
  return [...new Set(direct)].sort();
}

function setEquals(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function responseSummary(body) {
  if (body === null || body === undefined) return { kind: 'empty' };
  if (Array.isArray(body)) return { kind: 'array', length: body.length };
  if (typeof body !== 'object') return { kind: typeof body };

  const summary = {
    kind: 'json',
    keys: Object.keys(body)
      .filter(key => !/token|password|signature|secret|api.?key/i.test(key))
      .slice(0, 40),
  };
  for (const key of [
    'status',
    'code',
    'errorCode',
    'message',
    'valid',
    'eligible',
    'tokensAwarded',
    'sideEffects',
    'eligible',
    'transactionCount',
    'providerAccepted',
    'partialFailure',
    'canDeliver',
  ]) {
    if (Object.prototype.hasOwnProperty.call(body, key)
      && (typeof body[key] === 'string' || typeof body[key] === 'boolean' || typeof body[key] === 'number' || body[key] === null)) {
      summary[key] = body[key];
    }
  }
  if (body.normalised && typeof body.normalised === 'object') {
    summary.normalised = {};
    for (const key of ['protocol', 'sourceField', 'energyDirection']) {
      if (typeof body.normalised[key] === 'string') summary.normalised[key] = body.normalised[key];
    }
  }
  if (body.normalisationError && typeof body.normalisationError === 'object') {
    summary.normalisationError = {};
    for (const key of ['code', 'protocol']) {
      if (typeof body.normalisationError[key] === 'string') summary.normalisationError[key] = body.normalisationError[key];
    }
    if (Array.isArray(body.normalisationError.sourceFields)) {
      summary.normalisationError.sourceFields = body.normalisationError.sourceFields
        .filter(value => typeof value === 'string')
        .slice(0, 8);
    }
  }
  if (body.metadata && typeof body.metadata === 'object') {
    summary.metadata = {};
    for (const key of ['isOffPeak', 'localStartTime', 'timeZone', 'timeZoneSource', 'eligibilityBasis', 'awardType']) {
      const value = body.metadata[key];
      if (typeof value === 'string' || typeof value === 'boolean' || value === null) summary.metadata[key] = value;
    }
  }
  if (body.policy && typeof body.policy === 'object' && Number.isInteger(body.policy.revision)) {
    summary.policyRevision = body.policy.revision;
  }
  if (body.delivery && typeof body.delivery === 'object') {
    summary.delivery = {
      canDeliver: typeof body.delivery.canDeliver === 'boolean' ? body.delivery.canDeliver : null,
      configurationIssue: typeof body.delivery.configurationIssue === 'string' || body.delivery.configurationIssue === null
        ? body.delivery.configurationIssue
        : null,
      emailConfigured: typeof body.delivery.email?.configured === 'boolean' ? body.delivery.email.configured : null,
      webhookConfigured: typeof body.delivery.webhook?.configured === 'boolean' ? body.delivery.webhook.configured : null,
    };
  }
  if (Array.isArray(body.transactions)) summary.transactionCount = body.transactions.length;
  if (Array.isArray(body.paths)) summary.pathCount = body.paths.length;
  return summary;
}

function readJson(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { _nonJsonLength: text.length };
  }
}

async function request(baseUrl, method, route, options = {}) {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const url = new URL(route, `${baseUrl}/`);
  if (url.origin !== baseUrl) throw new Error('Request URL escaped the authorized host');

  const headers = { ...(options.headers || {}) };
  if (options.apiKey) headers['X-API-Key'] = options.apiKey;
  if (options.ingestKey) headers['X-Ingest-API-Key'] = options.ingestKey;
  if (options.adminToken) headers.Authorization = `Bearer ${options.adminToken}`;
  if (options.identity) headers['x-contract-id'] = options.identity;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method,
      headers,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      redirect: 'manual',
      signal: controller.signal,
    });
    const text = await response.text();
    const body = readJson(text);
    const redirectBlocked = response.status >= 300 && response.status < 400;
    return {
      method,
      route,
      status: response.status,
      ok: response.ok && !redirectBlocked,
      redirectBlocked,
      body,
      startedAt,
      completedAt: new Date().toISOString(),
      latencyMs: Number((performance.now() - started).toFixed(2)),
    };
  } catch (error) {
    return {
      method,
      route,
      status: null,
      ok: false,
      redirectBlocked: false,
      body: null,
      startedAt,
      completedAt: new Date().toISOString(),
      latencyMs: Number((performance.now() - started).toFixed(2)),
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function hasUsableChainBalance(body) {
  const rawBalance = body?.balance;
  const hasNumericValue = (typeof rawBalance === 'number' && Number.isFinite(rawBalance))
    || (typeof rawBalance === 'string' && rawBalance.trim() !== '' && Number.isFinite(Number(rawBalance)));
  if (!hasNumericValue) return false;
  const balance = Number(rawBalance);
  return body?.balanceStatus === 'confirmed'
    && body?.balanceSource === 'chain'
    && Number.isFinite(balance)
    && balance >= 0;
}

function safeError(result) {
  if (result.error) return result.error.slice(0, 240);
  if (isObject(result.body)) {
    const message = result.body.message || result.body.error || result.body.code;
    if (typeof message === 'string') return message.slice(0, 240);
  }
  return null;
}

function buildOicpPreview(contractId) {
  return buildOicpPreviewWithOptions(contractId);
}

function buildOicpPreviewWithOptions(contractId, options = {}) {
  const start = options.startIso || '2026-10-13T23:00:00.000Z';
  const end = options.endIso || new Date(new Date(start).getTime() + 30 * 60 * 1000).toISOString();
  return {
    SessionID: options.sessionId || `live-smoke-${Date.now()}`,
    ProviderID: 'neverflat-live-smoke',
    EVSEID: 'DE*NVF*SMOKE01',
    Identification: { RemoteIdentification: { EvcoID: contractId } },
    ChargingStart: start,
    ChargingEnd: end,
    ConsumedEnergy: String(options.energyKWh === undefined ? 2.5 : options.energyKWh),
    EnergyDirection: options.energyDirection || 'CHARGE',
  };
}

function buildUidOnlyPreview() {
  return {
    SessionID: `live-smoke-uid-only-${Date.now()}`,
    ProviderID: 'neverflat-live-smoke',
    UID: 'live-smoke-rfid-only',
    EVSEID: 'DE*NVF*SMOKEUID',
    StartTime: '2026-10-13T23:00:00.000Z',
    EndTime: '2026-10-13T23:30:00.000Z',
    Energy: '1',
    EnergyDirection: 'CHARGE',
  };
}

function buildConflictingIdentityPreview() {
  return {
    SessionID: `live-smoke-conflict-${Date.now()}`,
    ProviderID: 'neverflat-live-smoke',
    EVSEID: 'DE*NVF*SMOKECONFLICT',
    cdr_token: { contract_id: 'DE*LIVE*CONFLICT1' },
    Identification: { RemoteIdentification: { EvcoID: 'DE*LIVE*CONFLICT2' } },
    StartTime: '2026-10-13T23:00:00.000Z',
    EndTime: '2026-10-13T23:30:00.000Z',
    Energy: '1',
    EnergyDirection: 'CHARGE',
  };
}

function localDateParts(timestamp, timeZone) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(timestamp);
  const values = {};
  for (const part of parts) values[part.type] = part.value;
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function timeZoneOffsetMs(timestamp, timeZone) {
  const local = localDateParts(timestamp, timeZone);
  return Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second)
    - timestamp.getTime();
}

function zonedDateTimeToUtc(local, timeZone) {
  const target = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second);
  let guess = target;
  for (let index = 0; index < 4; index += 1) {
    guess = target - timeZoneOffsetMs(new Date(guess), timeZone);
  }
  return new Date(guess);
}

function localDateWithOffset(local, days) {
  const date = new Date(Date.UTC(local.year, local.month - 1, local.day) + days * 24 * 60 * 60 * 1000);
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1, day: date.getUTCDate() };
}

function localMinutes(value) {
  return value.hour * 60 + value.minute;
}

function timeToMinutes(value) {
  const [hours, minutes] = String(value).split(':').map(Number);
  return hours * 60 + minutes;
}

function isWithinLocalWindows(timestamp, timeZone, ranges) {
  const minutes = localMinutes(localDateParts(timestamp, timeZone));
  return ranges.some(range => {
    const start = timeToMinutes(range.start);
    const end = timeToMinutes(range.end);
    return end > start ? minutes >= start && minutes < end : minutes >= start || minutes < end;
  });
}

function findOffPeakStartBoundary(windows, countryCode, timeZone) {
  const ranges = Array.isArray(windows?.[countryCode]) ? windows[countryCode] : [];
  const range = ranges.find(candidate => typeof candidate?.start === 'string' && typeof candidate?.end === 'string');
  if (!range) return null;
  const now = localDateParts(new Date(), timeZone);
  for (let dayOffset = 1; dayOffset <= 30; dayOffset += 1) {
    const date = localDateWithOffset(now, dayOffset);
    const inside = zonedDateTimeToUtc({ ...date, hour: Number(range.start.split(':')[0]), minute: Number(range.start.split(':')[1]), second: 0 }, timeZone);
    const outside = new Date(inside.getTime() - 60 * 1000);
    if (isWithinLocalWindows(inside, timeZone, ranges) && !isWithinLocalWindows(outside, timeZone, ranges)) {
      return { inside, outside, range, timeZone, countryCode };
    }
  }
  return null;
}

function expectedChargeAward(rules, windows, timestamp, energyKWh, countryCode, timeZone) {
  const offPeak = isWithinLocalWindows(timestamp, timeZone, windows?.[countryCode] || []);
  const rate = Number(rules?.rules?.offPeakCharging?.tokensPerKWh);
  const enabled = rules?.rules?.offPeakCharging?.enabled === true;
  return {
    offPeak,
    rate,
    enabled,
    tokensAwarded: enabled && offPeak && Number.isFinite(rate) ? Math.floor(energyKWh * rate) : 0,
  };
}

function expectedDischargeAward(rules, energyKWh) {
  const rule = rules?.rules?.v2gDischarge;
  const rate = Number(rule?.tokensPerKWh);
  const enabled = rule?.enabled === true;
  return {
    rate,
    enabled,
    tokensAwarded: enabled && Number.isFinite(rate) ? Math.floor(energyKWh * rate) : 0,
  };
}

function operationsFromSpec(spec) {
  if (!isObject(spec) || !isObject(spec.paths)) return [];
  return Object.entries(spec.paths)
    .flatMap(([route, operations]) => isObject(operations)
      ? Object.keys(operations)
        .filter(method => ['get', 'post', 'put', 'patch', 'delete'].includes(method))
        .map(method => `${method.toUpperCase()} ${route}`)
      : [])
    .sort();
}

function exitCodeFor(failureCount, skippedCount, allowAuthSkips) {
  if (failureCount > 0) return 1;
  if (skippedCount > 0 && !allowAuthSkips) return 2;
  return 0;
}

function runSelfCheck() {
  const syntheticFailureCount = 1;
  const syntheticSkippedCount = 0;
  const exitCode = exitCodeFor(syntheticFailureCount, syntheticSkippedCount, false);
  if (exitCode !== 1) throw new Error(`Synthetic failed assertion mapped to exit code ${exitCode}, expected 1`);
  const balanceCases = [
    { balance: '0.00', expected: true },
    { balance: 0, expected: true },
    { balance: null, expected: false },
    { balance: '', expected: false },
    { balance: false, expected: false },
    { balance: 'NaN', expected: false },
  ];
  for (const testCase of balanceCases) {
    const actual = hasUsableChainBalance({
      balance: testCase.balance,
      balanceStatus: 'confirmed',
      balanceSource: 'chain',
    });
    if (actual !== testCase.expected) {
      throw new Error(`Synthetic wallet balance case for ${String(testCase.balance)} returned ${actual}, expected ${testCase.expected}`);
    }
  }
  console.log('Self-check passed: a failed assertion maps to process exit code 1 without making live requests.');
}

function runOfflineCheck() {
  const operations = sourceOperations();
  if (operations.length < MINIMUM_OPERATION_COUNT) {
    throw new Error(`Offline source inventory found ${operations.length} operations; expected at least ${MINIMUM_OPERATION_COUNT}`);
  }
  console.log(`Offline check passed: source inventory contains ${operations.length} operations; no live requests made.`);
}

async function main() {
  const args = new Set(process.argv.slice(2));
  if (args.has('--self-check')) {
    runSelfCheck();
    return;
  }
  if (args.has('--offline-check')) {
    runOfflineCheck();
    return;
  }
  const publicOnly = args.has('--public-only') || process.env.LIVE_PUBLIC_ONLY === 'true';
  const allowAuthSkips = publicOnly || process.env.LIVE_ALLOW_AUTH_SKIPS === 'true';
  const baseUrl = safeBaseUrl(process.env.LIVE_API_BASE_URL || DEFAULT_BASE_URL);
  const timeoutMs = boundedTimeout(process.env.LIVE_API_TIMEOUT_MS);
  const contractId = process.env.LIVE_API_CONTRACT_ID || DEFAULT_CONTRACT_ID;
  const unlinkedWalletAddress = process.env.LIVE_API_UNLINKED_WALLET_ADDRESS || DEFAULT_UNLINKED_WALLET_ADDRESS;
  const beiaApiKey = process.env.BEIA_API_KEY || '';
  const adminEmail = process.env.ADMIN_EMAIL || '';
  const adminPassword = process.env.ADMIN_PASSWORD || '';
  const evidence = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    source: {
      file: 'src/api.ts',
      sha256: crypto.createHash('sha256').update(fs.readFileSync(path.join(__dirname, '..', 'src', 'api.ts'))).digest('hex'),
      deployedRevision: process.env.GITHUB_SHA || null,
    },
    credentialCoverage: {
      generalApiKeyConfigured: Boolean(beiaApiKey),
      generalApiKeySource: beiaApiKey ? 'BEIA_API_KEY' : null,
      adminCredentialsConfigured: Boolean(adminEmail && adminPassword),
      adminCredentialsPartial: Boolean(adminEmail) !== Boolean(adminPassword),
      localEnvFallback: false,
    },
    timeoutMs,
    requests: [],
    assertions: [],
    skipped: [],
  };

  const assert = (id, passed, detail = {}) => {
    evidence.assertions.push({ id, passed: Boolean(passed), ...detail });
  };
  const skip = (id, reason) => evidence.skipped.push({ id, reason });
  const call = async (label, method, route, options = {}) => {
    const result = await request(baseUrl, method, route, { ...options, timeoutMs });
    evidence.requests.push({
      label,
      method: result.method,
      route: options.evidenceRoute || result.route,
      status: result.status,
      ok: result.ok,
      redirectBlocked: result.redirectBlocked,
      latencyMs: result.latencyMs,
      startedAt: result.startedAt,
      completedAt: result.completedAt,
      response: responseSummary(result.body),
      ...(result.error ? { error: result.error.slice(0, 240) } : {}),
    });
    return result;
  };

  let sourceOps;
  try {
    sourceOps = sourceOperations();
    assert('source_operation_inventory', sourceOps.length >= MINIMUM_OPERATION_COUNT, {
      minimumCount: MINIMUM_OPERATION_COUNT,
      actualCount: sourceOps.length,
    });
  } catch (error) {
    sourceOps = [];
    assert('source_operation_inventory', false, { error: String(error).slice(0, 240) });
  }

  const health = await call('health', 'GET', '/ingest/health');
  assert('health_status', health.status === 200 && health.body?.status === 'ok', {
    expectedStatus: 200,
    actualStatus: health.status,
    error: safeError(health),
  });

  const docs = await call('docs_html', 'GET', '/docs');
  assert('docs_html', docs.status === 200
    && typeof docs.body?._nonJsonLength === 'number'
    && docs.body._nonJsonLength > 200, {
    expectedStatus: 200,
    actualStatus: docs.status,
    expectedContent: 'HTML documentation page',
    actualContent: docs.body?._nonJsonLength ? `non-json-${docs.body._nonJsonLength}-bytes` : responseSummary(docs.body),
    error: safeError(docs),
  });

  const openapi = await call('openapi_inventory', 'GET', '/openapi.json');
  const liveOps = operationsFromSpec(openapi.body);
  assert('live_openapi_operation_inventory', openapi.status === 200 && setEquals(liveOps, sourceOps || []), {
    expectedCount: sourceOps?.length || 0,
    actualCount: liveOps.length,
    missing: (sourceOps || []).filter(operation => !liveOps.includes(operation)),
    extra: liveOps.filter(operation => !(sourceOps || []).includes(operation)),
    error: safeError(openapi),
  });
  assert('openapi_wallet_query_not_prefilled', openapi.status === 200
    && openapi.body?.components?.parameters?.WalletAddressQuery?.schema?.example === undefined, {
    expected: 'WalletAddressQuery has no example value',
    actual: openapi.body?.components?.parameters?.WalletAddressQuery?.schema?.example === undefined ? 'absent' : 'present',
  });

  if (!beiaApiKey || publicOnly) {
    const reason = publicOnly ? 'public-only mode requested' : 'BEIA_API_KEY was not supplied';
    for (const id of [
      'missing_api_key',
      'invalid_api_key',
      'wallet_no_query',
      'wallet_malformed_address',
      'wallet_unlinked_address',
      'transactions_history',
      'partner_cdr_preview',
      'receipt_missing_fields',
      'receipt_forged_signature',
      'oicp_uid_only_reject',
      'mixed_identity_reject',
      'partner_cdr_preview_ingest_header',
      'admin_policy_reads',
      'admin_readiness',
      'admin_alert_settings_read',
      'preview_policy_reward_exact',
      'preview_off_peak_start_boundary',
      'preview_v2g_discharge_reward_exact',
    ]) skip(id, reason);
  } else {
    const missingKey = await call('missing_api_key', 'GET', '/transactions');
    assert('missing_api_key', missingKey.status === 401, {
      expectedStatus: 401,
      actualStatus: missingKey.status,
      error: safeError(missingKey),
    });

    const invalidKey = await call('invalid_api_key', 'GET', '/transactions', { headers: { 'X-API-Key': 'invalid-live-smoke-key' } });
    assert('invalid_api_key', invalidKey.status === 403, {
      expectedStatus: 403,
      actualStatus: invalidKey.status,
      error: safeError(invalidKey),
    });

    const wallet = await call('wallet_no_query', 'GET', '/wallet/me', { apiKey: beiaApiKey, identity: contractId });
    assert('wallet_no_query', wallet.status === 200 && isObject(wallet.body) && wallet.body.status === 'success'
      && hasUsableChainBalance(wallet.body), {
      expectedStatus: 200,
      actualStatus: wallet.status,
      expectedBodyStatus: 'success',
      actualBodyStatus: wallet.body?.status || null,
      expectedBalance: { balanceStatus: 'confirmed', balanceSource: 'chain', nonNegativeNumeric: true },
      actualBalance: {
        balanceStatus: wallet.body?.balanceStatus || null,
        balanceSource: wallet.body?.balanceSource || null,
        usable: hasUsableChainBalance(wallet.body),
      },
      error: safeError(wallet),
    });

    const malformed = await call('wallet_malformed_address', 'GET', '/wallet/me?walletAddress=not-an-address', {
      apiKey: beiaApiKey,
      identity: contractId,
      evidenceRoute: '/wallet/me?walletAddress=<malformed>',
    });
    assert('wallet_malformed_address', malformed.status === 400 && malformed.body?.code === 'INVALID_WALLET_ADDRESS', {
      expectedStatus: 400,
      actualStatus: malformed.status,
      expectedCode: 'INVALID_WALLET_ADDRESS',
      actualCode: malformed.body?.code || null,
      error: safeError(malformed),
    });

    const unlinked = await call('wallet_unlinked_address', `GET`, `/wallet/me?walletAddress=${encodeURIComponent(unlinkedWalletAddress)}`, {
      apiKey: beiaApiKey,
      identity: contractId,
      evidenceRoute: '/wallet/me?walletAddress=<valid-unlinked>',
    });
    assert('wallet_unlinked_address', unlinked.status === 403 && unlinked.body?.code === 'WALLET_NOT_LINKED', {
      expectedStatus: 403,
      actualStatus: unlinked.status,
      expectedCode: 'WALLET_NOT_LINKED',
      actualCode: unlinked.body?.code || null,
      error: safeError(unlinked),
    });

    const history = await call('transactions_history', 'GET', '/transactions?limit=1', { apiKey: beiaApiKey });
    assert('transactions_history', history.status === 200 && history.body?.status === 'ok' && Array.isArray(history.body?.transactions), {
      expectedStatus: 200,
      actualStatus: history.status,
      expectedBodyStatus: 'ok',
      actualBodyStatus: history.body?.status || null,
      error: safeError(history),
    });

    const preview = await call('partner_cdr_preview', 'POST', '/ingest/cdr/preview', {
      apiKey: beiaApiKey,
      body: buildOicpPreview(process.env.LIVE_API_PREVIEW_EMAID || 'DE*LIVE*E123456'),
    });
    const previewProtocol = preview.body?.normalised?.protocol;
    const previewSource = preview.body?.normalised?.sourceField;
    const previewRevision = preview.body?.policy?.revision;
    assert('partner_cdr_preview', preview.status === 200
      && preview.body?.status === 'preview'
      && preview.body?.sideEffects === false
      && previewProtocol === 'OICP'
      && previewSource === 'Identification.RemoteIdentification.EvcoID'
      && Number.isInteger(previewRevision), {
      expectedStatus: 200,
      actualStatus: preview.status,
      expected: { status: 'preview', sideEffects: false, protocol: 'OICP', sourceField: 'Identification.RemoteIdentification.EvcoID', policyRevision: 'integer' },
      actual: { status: preview.body?.status || null, sideEffects: preview.body?.sideEffects ?? null, protocol: previewProtocol || null, sourceField: previewSource || null, policyRevision: Number.isInteger(previewRevision) ? previewRevision : null },
      error: safeError(preview),
    });

    const ingestHeaderPreview = await call('partner_cdr_preview_ingest_header', 'POST', '/ingest/cdr/preview', {
      ingestKey: beiaApiKey,
      body: buildOicpPreviewWithOptions(process.env.LIVE_API_PREVIEW_EMAID || 'DE*LIVE*E123456', {
        sessionId: `live-smoke-ingest-header-${Date.now()}`,
      }),
    });
    assert('partner_cdr_preview_ingest_header', ingestHeaderPreview.status === 200
      && ingestHeaderPreview.body?.status === 'preview'
      && ingestHeaderPreview.body?.sideEffects === false
      && ingestHeaderPreview.body?.normalised?.protocol === 'OICP', {
      expectedStatus: 200,
      actualStatus: ingestHeaderPreview.status,
      expectedBodyStatus: 'preview',
      actualBodyStatus: ingestHeaderPreview.body?.status || null,
      expectedProtocol: 'OICP',
      actualProtocol: ingestHeaderPreview.body?.normalised?.protocol || null,
      error: safeError(ingestHeaderPreview),
    });

    const uidOnly = await call('oicp_uid_only_reject', 'POST', '/ingest/cdr/preview', {
      apiKey: beiaApiKey,
      body: buildUidOnlyPreview(),
    });
    assert('oicp_uid_only_reject', uidOnly.status === 400
      && uidOnly.body?.code === 'INVALID_CDR'
      && uidOnly.body?.normalisationError?.code === 'UID_ONLY'
      && uidOnly.body?.normalisationError?.protocol === 'OICP', {
      expectedStatus: 400,
      actualStatus: uidOnly.status,
      expected: { code: 'INVALID_CDR', normalisationCode: 'UID_ONLY', protocol: 'OICP' },
      actual: {
        code: uidOnly.body?.code || null,
        normalisationCode: uidOnly.body?.normalisationError?.code || null,
        protocol: uidOnly.body?.normalisationError?.protocol || null,
      },
      error: safeError(uidOnly),
    });

    const mixedIdentity = await call('mixed_identity_reject', 'POST', '/ingest/cdr/preview', {
      apiKey: beiaApiKey,
      body: buildConflictingIdentityPreview(),
    });
    assert('mixed_identity_reject', mixedIdentity.status === 400
      && mixedIdentity.body?.code === 'INVALID_CDR'
      && mixedIdentity.body?.normalisationError?.code === 'CONFLICTING_IDENTIFIERS'
      && mixedIdentity.body?.normalisationError?.protocol === 'MIXED', {
      expectedStatus: 400,
      actualStatus: mixedIdentity.status,
      expected: { code: 'INVALID_CDR', normalisationCode: 'CONFLICTING_IDENTIFIERS', protocol: 'MIXED' },
      actual: {
        code: mixedIdentity.body?.code || null,
        normalisationCode: mixedIdentity.body?.normalisationError?.code || null,
        protocol: mixedIdentity.body?.normalisationError?.protocol || null,
      },
      error: safeError(mixedIdentity),
    });

    const missingReceipt = await call('receipt_missing_fields', 'POST', '/spend-receipts/verify', {
      apiKey: beiaApiKey,
      body: {},
    });
    assert('receipt_missing_fields', missingReceipt.status === 400 && missingReceipt.body?.status === 'error', {
      expectedStatus: 400,
      actualStatus: missingReceipt.status,
      error: safeError(missingReceipt),
    });

    const forgedReceipt = await call('receipt_forged_signature', 'POST', '/spend-receipts/verify', {
      apiKey: beiaApiKey,
      body: {
        payload: {
          version: '1.0',
          receiptId: 'live-smoke-receipt',
          contractId: 'DE*LIVE*E123456',
          walletAddress: '0x1111111111111111111111111111111111111111',
          amount: '1.00',
          tokenTxHash: `0x${'1'.repeat(64)}`,
          tokenContractAddress: '0x2222222222222222222222222222222222222222',
          chainId: 80002,
          status: 'settled',
        },
        signature: '0xdeadbeef',
      },
    });
    assert('receipt_forged_signature', forgedReceipt.status === 200
      && forgedReceipt.body?.status === 'invalid'
      && forgedReceipt.body?.valid === false, {
      expectedStatus: 200,
      actualStatus: forgedReceipt.status,
      expectedBodyStatus: 'invalid',
      actualBodyStatus: forgedReceipt.body?.status || null,
      error: safeError(forgedReceipt),
    });

    let adminToken = null;
    try {
      if (adminEmail && adminPassword) {
      const login = await call('admin_login', 'POST', '/admin/login', {
        body: { email: adminEmail, password: adminPassword },
      });
      assert('admin_login', login.status === 200 && typeof login.body?.token === 'string', {
        expectedStatus: 200,
        actualStatus: login.status,
        error: safeError(login),
      });
      adminToken = typeof login.body?.token === 'string' ? login.body.token : null;
      } else {
        const reason = adminEmail || adminPassword
          ? 'ADMIN_EMAIL and ADMIN_PASSWORD must be supplied together'
          : 'admin credentials were not supplied';
        for (const id of ['admin_policy_reads', 'admin_readiness', 'admin_alert_settings_read', 'preview_policy_reward_exact', 'preview_off_peak_start_boundary', 'preview_v2g_discharge_reward_exact']) {
          skip(id, reason);
        }
      }

      if (adminToken) {
      const rules = await call('admin_rules_read', 'GET', '/admin/rules', { adminToken });
      const offPeak = await call('admin_off_peak_read', 'GET', '/admin/off-peak', { adminToken });
      const readiness = await call('admin_readiness', 'GET', '/admin/readiness', { adminToken });
      const alertSettings = await call('admin_alert_settings_read', 'GET', '/admin/alerts/settings', { adminToken });
      const adminRevision = rules.body?.policy?.revision ?? rules.body?.revision;
      assert('admin_rules_read', rules.status === 200 && Number.isInteger(adminRevision), {
        expectedStatus: 200,
        actualStatus: rules.status,
        expectedPolicyRevision: 'integer',
        actualPolicyRevision: Number.isInteger(adminRevision) ? adminRevision : null,
        error: safeError(rules),
      });
      assert('admin_off_peak_read', offPeak.status === 200 && isObject(offPeak.body?.windows), {
        expectedStatus: 200,
        actualStatus: offPeak.status,
        error: safeError(offPeak),
      });
      const readinessChecks = Array.isArray(readiness.body?.checks) ? readiness.body.checks : [];
      const readinessFailedCount = readinessChecks.filter(check => check?.status === 'fail').length;
      const readinessWarningCount = readinessChecks.filter(check => check?.status === 'warn').length;
      const expectedReadinessStatus = readinessWarningCount > 0 ? 'ready_with_warnings' : 'ready';
      assert('admin_readiness', readiness.status === 200
        && readiness.body?.status === expectedReadinessStatus
        && readiness.body?.failedCount === 0
        && readiness.body?.warningCount === readinessWarningCount
        && readinessFailedCount === 0
        && readinessChecks.every(check => check?.status === 'pass' || check?.status === 'warn'), {
        expectedStatus: 200,
        expectedReadinessStatus,
        expectedFailedCount: 0,
        expectedWarningCount: readinessWarningCount,
        actualStatus: readiness.status,
        actualReadinessStatus: readiness.body?.status || null,
        actualFailedCount: readiness.body?.failedCount ?? null,
        actualWarningCount: readiness.body?.warningCount ?? null,
        actualCheckCounts: { failed: readinessFailedCount, warnings: readinessWarningCount },
        error: safeError(readiness),
      });
      const alertConfig = alertSettings.body?.settings;
      const alertDelivery = alertSettings.body?.delivery;
      assert('admin_alert_settings_read', alertSettings.status === 200
        && alertSettings.body?.status === 'ok'
        && isObject(alertConfig)
        && typeof alertConfig.recipientEmail === 'string'
        && alertConfig.recipientEmail.includes('@')
        && typeof alertConfig.channel === 'string'
        && isObject(alertDelivery)
        && isObject(alertDelivery.email)
        && typeof alertDelivery.email.configured === 'boolean'
        && isObject(alertDelivery.webhook)
        && typeof alertDelivery.webhook.configured === 'boolean'
        && typeof alertDelivery.canDeliver === 'boolean'
        && (typeof alertDelivery.configurationIssue === 'string' || alertDelivery.configurationIssue === null), {
        expectedStatus: 200,
        actualStatus: alertSettings.status,
        expected: 'safe settings and delivery metadata; recipient value omitted',
        actual: {
          status: alertSettings.body?.status || null,
          recipientEmailPresent: typeof alertConfig?.recipientEmail === 'string',
          recipientEmailShapeValid: typeof alertConfig?.recipientEmail === 'string' && alertConfig.recipientEmail.includes('@'),
          channelPresent: typeof alertConfig?.channel === 'string',
          emailConfigured: typeof alertDelivery?.email?.configured === 'boolean' ? alertDelivery.email.configured : null,
          webhookConfigured: typeof alertDelivery?.webhook?.configured === 'boolean' ? alertDelivery.webhook.configured : null,
          canDeliver: typeof alertDelivery?.canDeliver === 'boolean' ? alertDelivery.canDeliver : null,
          configurationIssue: typeof alertDelivery?.configurationIssue === 'string' || alertDelivery?.configurationIssue === null
            ? alertDelivery.configurationIssue
            : null,
        },
        error: safeError(alertSettings),
      });
      const preview = evidence.assertions.find(assertion => assertion.id === 'partner_cdr_preview');
      if (preview && preview.actual && Number.isInteger(adminRevision)) {
        assert('preview_policy_revision_matches_admin', preview.actual.policyRevision === adminRevision, {
          expectedPolicyRevision: adminRevision,
          actualPolicyRevision: preview.actual.policyRevision,
        });
      }

      const policyRules = rules.body?.rules;
      const policyWindows = offPeak.body?.windows;
      const boundary = Number.isInteger(adminRevision) && isObject(policyRules) && isObject(policyWindows)
        ? findOffPeakStartBoundary(policyWindows, 'DE', process.env.LIVE_API_TIMEZONE || 'Europe/Berlin')
        : null;
      if (!boundary) {
        skip('preview_policy_reward_exact', 'admin policy/windows did not expose a usable DE off-peak configuration');
        skip('preview_off_peak_start_boundary', 'no DE off-peak start boundary was derivable from the current IANA policy window');
      } else {
        const boundaryEnergy = 5.25;
        const outsidePreview = await call('preview_off_peak_start_outside', 'POST', '/ingest/cdr/preview', {
          apiKey: beiaApiKey,
          body: buildOicpPreviewWithOptions(process.env.LIVE_API_PREVIEW_EMAID || 'DE*LIVE*E123456', {
            sessionId: `live-smoke-boundary-outside-${Date.now()}`,
            startIso: boundary.outside.toISOString(),
            energyKWh: boundaryEnergy,
          }),
        });
        const insidePreview = await call('preview_off_peak_start_inside', 'POST', '/ingest/cdr/preview', {
          apiKey: beiaApiKey,
          body: buildOicpPreviewWithOptions(process.env.LIVE_API_PREVIEW_EMAID || 'DE*LIVE*E123456', {
            sessionId: `live-smoke-boundary-inside-${Date.now()}`,
            startIso: boundary.inside.toISOString(),
            energyKWh: boundaryEnergy,
          }),
        });
        const outsideExpected = expectedChargeAward(policyRules, policyWindows, boundary.outside, boundaryEnergy, boundary.countryCode, boundary.timeZone);
        const insideExpected = expectedChargeAward(policyRules, policyWindows, boundary.inside, boundaryEnergy, boundary.countryCode, boundary.timeZone);
        const revisions = [outsidePreview, insidePreview]
          .map(result => result.body?.policy?.revision)
          .filter(value => Number.isInteger(value));
        assert('preview_policy_reward_exact', outsidePreview.status === 200
          && insidePreview.status === 200
          && outsidePreview.body?.status === 'preview'
          && insidePreview.body?.status === 'preview'
          && outsidePreview.body?.sideEffects === false
          && insidePreview.body?.sideEffects === false
          && outsidePreview.body?.tokensAwarded === outsideExpected.tokensAwarded
          && insidePreview.body?.tokensAwarded === insideExpected.tokensAwarded
          && outsidePreview.body?.eligible === (outsideExpected.tokensAwarded > 0)
          && insidePreview.body?.eligible === (insideExpected.tokensAwarded > 0)
          && revisions.length === 2
          && revisions.every(revision => revision === adminRevision), {
          expected: {
            outsideTokensAwarded: outsideExpected.tokensAwarded,
            insideTokensAwarded: insideExpected.tokensAwarded,
            rate: outsideExpected.rate,
            policyRevision: adminRevision,
            floor: 'Math.floor(energyKWh * tokensPerKWh)',
          },
          actual: {
            outsideStatus: outsidePreview.status,
            insideStatus: insidePreview.status,
            outsideTokensAwarded: outsidePreview.body?.tokensAwarded ?? null,
            insideTokensAwarded: insidePreview.body?.tokensAwarded ?? null,
            outsideEligible: outsidePreview.body?.eligible ?? null,
            insideEligible: insidePreview.body?.eligible ?? null,
            outsidePolicyRevision: outsidePreview.body?.policy?.revision ?? null,
            insidePolicyRevision: insidePreview.body?.policy?.revision ?? null,
          },
          error: safeError(insidePreview) || safeError(outsidePreview),
        });
        assert('preview_off_peak_start_boundary', outsidePreview.body?.metadata?.isOffPeak === false
          && insidePreview.body?.metadata?.isOffPeak === true
          && outsideExpected.offPeak === false
          && insideExpected.offPeak === true
          && revisions.every(revision => revision === adminRevision), {
          expected: {
            countryCode: boundary.countryCode,
            timeZone: boundary.timeZone,
            range: boundary.range,
            outsideStart: boundary.outside.toISOString(),
            insideStart: boundary.inside.toISOString(),
            outsideOffPeak: false,
            insideOffPeak: true,
            policyRevision: adminRevision,
          },
          actual: {
            outsideOffPeak: outsidePreview.body?.metadata?.isOffPeak ?? null,
            insideOffPeak: insidePreview.body?.metadata?.isOffPeak ?? null,
            outsidePolicyRevision: outsidePreview.body?.policy?.revision ?? null,
            insidePolicyRevision: insidePreview.body?.policy?.revision ?? null,
          },
          error: safeError(insidePreview) || safeError(outsidePreview),
        });
      }

      const v2gExpected = expectedDischargeAward(policyRules, 1.5);
      const v2gConfigured = Number.isInteger(adminRevision)
        && v2gExpected.enabled
        && Number.isFinite(v2gExpected.rate)
        && v2gExpected.rate >= 0;
      if (!v2gConfigured) {
        skip('preview_v2g_discharge_reward_exact', 'admin rules did not expose an enabled finite V2G discharge rate');
      } else {
        const v2gPreview = await call('preview_v2g_discharge_1_5kwh', 'POST', '/ingest/cdr/preview', {
          apiKey: beiaApiKey,
          body: buildOicpPreviewWithOptions(process.env.LIVE_API_PREVIEW_EMAID || 'DE*LIVE*E123456', {
            sessionId: `live-smoke-v2g-discharge-${Date.now()}`,
            energyKWh: 1.5,
            energyDirection: 'DISCHARGE',
          }),
        });
        const actualRevision = v2gPreview.body?.policy?.revision;
        assert('preview_v2g_discharge_reward_exact', v2gPreview.status === 200
          && v2gPreview.body?.status === 'preview'
          && v2gPreview.body?.sideEffects === false
          && v2gPreview.body?.normalised?.energyDirection === 'DISCHARGE'
          && Number(v2gPreview.body?.normalised?.energyKWh) === 1.5
          && v2gPreview.body?.tokensAwarded === v2gExpected.tokensAwarded
          && v2gPreview.body?.eligible === (v2gExpected.tokensAwarded > 0)
          && v2gPreview.body?.metadata?.eligibilityBasis === 'discharge'
          && v2gPreview.body?.metadata?.isOffPeak === false
          && actualRevision === adminRevision, {
          expected: {
            status: 200,
            sideEffects: false,
            energyDirection: 'DISCHARGE',
            energyKWh: 1.5,
            tokensAwarded: v2gExpected.tokensAwarded,
            eligible: v2gExpected.tokensAwarded > 0,
            eligibilityBasis: 'discharge',
            isOffPeak: false,
            rate: v2gExpected.rate,
            policyRevision: adminRevision,
            floor: 'Math.floor(energyKWh * v2gDischarge.tokensPerKWh)',
          },
          actual: {
            status: v2gPreview.status,
            bodyStatus: v2gPreview.body?.status || null,
            sideEffects: v2gPreview.body?.sideEffects ?? null,
            energyDirection: v2gPreview.body?.normalised?.energyDirection || null,
            energyKWh: v2gPreview.body?.normalised?.energyKWh ?? null,
            tokensAwarded: v2gPreview.body?.tokensAwarded ?? null,
            eligible: v2gPreview.body?.eligible ?? null,
            eligibilityBasis: v2gPreview.body?.metadata?.eligibilityBasis || null,
            isOffPeak: v2gPreview.body?.metadata?.isOffPeak ?? null,
            policyRevision: Number.isInteger(actualRevision) ? actualRevision : null,
          },
          error: safeError(v2gPreview),
        });
      }
      }
    } finally {
      if (adminToken) {
        const logout = await call('admin_logout', 'POST', '/admin/logout', { adminToken });
        assert('admin_logout', logout.status === 200 && logout.body?.status === 'ok', {
          expectedStatus: 200,
          actualStatus: logout.status,
          error: safeError(logout),
        });
      }
    }
  }

  const failures = evidence.assertions.filter(assertion => !assertion.passed);
  const incomplete = evidence.skipped.length > 0;
  const outcome = failures.length ? 'FINDINGS' : incomplete ? 'INCOMPLETE_AUTHENTICATED_COVERAGE' : 'PASS';
  const outputDirectory = path.resolve(process.env.LIVE_API_EVIDENCE_DIR || path.join(__dirname, '..', 'outputs', 'live-api-remediation-2026-10-14'));
  fs.mkdirSync(outputDirectory, { recursive: true });
  const outputFile = path.join(outputDirectory, process.env.LIVE_API_EVIDENCE_FILE || 'live-api-smoke.json');
  const output = {
    ...evidence,
    outcome,
    counts: {
      liveRequests: evidence.requests.length,
      assertions: evidence.assertions.length,
      passedAssertions: evidence.assertions.filter(assertion => assertion.passed).length,
      failedAssertions: failures.length,
      skippedChecks: evidence.skipped.length,
    },
    readyForReview: failures.length === 0 && (!incomplete || allowAuthSkips),
  };
  fs.writeFileSync(outputFile, JSON.stringify(output, null, 2));

  console.log(`Evidence written to ${outputFile}`);
  console.log(`Outcome: ${outcome}`);
  console.log(`Live requests: ${output.counts.liveRequests}; assertions: ${output.counts.passedAssertions}/${output.counts.assertions}; skipped: ${output.counts.skippedChecks}`);
  if (failures.length) {
    for (const failure of failures) console.log(`FAILED ${failure.id}: ${failure.error || failure.actualStatus || 'assertion failed'}`);
  }

  process.exitCode = exitCodeFor(failures.length, evidence.skipped.length, allowAuthSkips);
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
