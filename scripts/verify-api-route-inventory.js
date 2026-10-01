/*
 * Exhaustive source inventory for the Express API.
 *
 * This is deliberately a source-level guard: importing api.ts starts a large
 * dependency graph and can hide route omissions behind environment failures.
 * The HTTP matrix exercises these routes against a disposable fixture; this
 * script makes the finite route set itself reviewable and fails when a route
 * is added, removed, or loses its expected authentication/config branch.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const ts = require('typescript');

const APP_ROOT = path.resolve(__dirname, '..');
const API_SOURCE_PATH = path.join(APP_ROOT, 'src', 'api.ts');
const ADMIN_OPERATIONS_SOURCE_PATH = path.join(APP_ROOT, 'src', 'adminOperations.ts');

const route = (method, routePath, auth, notes = '') => ({ method, path: routePath, auth, notes });

// Every concrete method/path in src/api.ts, with the /docs alias expanded.
// Legacy/manual paths and feature/configuration branches are intentionally
// labelled rather than silently omitted from the matrix.
const EXPECTED_ROUTES = [
  route('GET', '/openapi.json', 'public'),
  route('GET', '/api-docs', 'public', 'docs-alias'),
  route('GET', '/docs', 'public', 'docs-alias'),
  route('GET', '/ingest/health', 'public'),
  route('POST', '/spend-receipts/verify', 'api'),
  route('POST', '/ingest/cdr/preview', 'ingest'),
  route('POST', '/ingest/cdr', 'ingest'),
  route('POST', '/spend/session', 'api'),
  route('POST', '/spend', 'api', 'legacy/manual'),
  route('POST', '/spend/reservation-approval-intent', 'api', 'custodial'),
  route('POST', '/spend/me', 'api', 'identity-context'),
  route('GET', '/spend/reservations/:reservationId', 'api', 'identity-context'),
  route('POST', '/wallet/:uid/mode', 'api', 'wallet-mode'),
  route('PATCH', '/wallet/:uid/profile', 'api'),
  route('POST', '/wallet/:uid/contract-ids', 'api'),
  route('POST', '/wallet/:uid/linked-wallets', 'api', 'linked-wallets'),
  route('PATCH', '/wallet/:uid/linked-wallets/:walletAddress/profile', 'api', 'linked-wallets'),
  route('DELETE', '/wallet/:uid/linked-wallets/:walletAddress', 'api', 'linked-wallets'),
  route('POST', '/wallet/:uid/move-funds', 'api', 'financial'),
  route('POST', '/spend/custodial-intent', 'api', 'custodial'),
  route('POST', '/spend/custodial-failure', 'api', 'custodial'),
  route('POST', '/spend/custodial-record', 'api', 'custodial'),
  route('GET', '/wallet/me', 'api', 'identity-context'),
  route('GET', '/wallet/:uid', 'api', 'legacy/manual; ENABLE_TEST_UID_LOOKUP'),
  route('GET', '/transactions', 'api'),
  route('POST', '/admin/login', 'public'),
  route('POST', '/admin/logout', 'admin'),
  route('GET', '/admin/rules', 'admin'),
  route('PUT', '/admin/rules', 'admin'),
  route('GET', '/admin/off-peak', 'admin'),
  route('GET', '/admin/audit', 'admin'),
  route('GET', '/admin/pilot-metrics', 'admin'),
  route('GET', '/admin/readiness', 'admin'),
  route('POST', '/admin/alerts/test', 'admin'),
  route('GET', '/admin/evidence-pack', 'admin'),
  route('POST', '/admin/reconciliation/run', 'admin'),
  route('GET', '/admin/reconciliation', 'admin'),
  route('PUT', '/admin/off-peak', 'admin'),
  route('DELETE', '/admin/off-peak/:countryCode', 'admin'),
  route('GET', '/admin/operations', 'admin', 'mounted-router'),
  route('POST', '/admin/operations/recover', 'admin', 'mounted-router'),
  route('GET', '*', 'public', 'frontend-build-present'),
];

function sourceRouteLines(source, receiver) {
  const result = [];
  const sourceFile = ts.createSourceFile(`${receiver}.ts`, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const routeCalls = [];
  function collectLiteralPaths(node, output) {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      output.push(node.text);
      return;
    }
    if (ts.isArrayLiteralExpression(node)) {
      node.elements.forEach(element => collectLiteralPaths(element, output));
    }
  }
  function visit(node) {
    if (ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && (node.expression.expression.text === 'app' || node.expression.expression.text === 'router')) {
      const method = node.expression.name.text.toLowerCase();
      if (/^(get|post|put|patch|delete)$/.test(method)) {
        routeCalls.push(node);
      } else if (method === 'use') {
        // Middleware without a path is not a route. A path-bearing mount is a
        // route surface and must be accounted for explicitly; the operations
        // router is the one deliberate mount in this application.
        const first = node.arguments[0];
        const mountPaths = [];
        if (first) collectLiteralPaths(first, mountPaths);
        if (mountPaths.length && !(mountPaths.length === 1 && mountPaths[0] === '/admin/operations')) {
          throw new Error(`Unsupported Express path mount at line ${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
        }
      } else if (method === 'head' || method === 'options' || method === 'all' || method === 'route') {
        throw new Error(`Unsupported Express route method ${node.expression.name.text} at line ${sourceFile.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  for (const call of routeCalls) {
    const method = call.expression.name.text.toUpperCase();
    const pathArgument = call.arguments[0];
    const literals = [];
    if (pathArgument) collectLiteralPaths(pathArgument, literals);
    if (!literals.length) {
      throw new Error(`Unsupported non-literal ${method} route definition at line ${sourceFile.getLineAndCharacterOfPosition(call.getStart()).line + 1}`);
    }
    const line = sourceFile.getLineAndCharacterOfPosition(call.getStart()).line + 1;
    const lineStart = sourceFile.getPositionOfLineAndCharacter(line - 1, 0);
    const sourceLine = source.slice(lineStart, source.indexOf('\n', lineStart) === -1 ? source.length : source.indexOf('\n', lineStart)).trim();
    for (const routePath of literals) {
      if (!routePath.startsWith('/') && routePath !== '*') {
        throw new Error(`Unsupported route path ${JSON.stringify(routePath)} at line ${line}`);
      }
      result.push({ receiver, method, path: routePath, line, source: sourceLine });
    }
  }
  return result;
}

function assertUnsupportedRouteDetection() {
  assert.throws(
    () => sourceRouteLines("app.head(\n  '/future',\n  handler\n);", 'fixture'),
    /Unsupported Express route method head/i,
  );
  assert.throws(
    () => sourceRouteLines("router.route(\n  '/future'\n).get(handler);", 'fixture'),
    /Unsupported Express route method route/i,
  );
  assert.throws(
    () => sourceRouteLines("app.get(\n  futurePath,\n  handler\n);", 'fixture'),
    /Unsupported non-literal GET route definition/i,
  );
  assert.throws(
    () => sourceRouteLines("router.use(\n  '/future',\n  handler\n);", 'fixture'),
    /Unsupported Express path mount/i,
  );
}

function key(item) {
  return `${item.method} ${item.path}`;
}

function assertEqualSets(actual, expected, label) {
  const actualKeys = new Set(actual.map(key));
  const expectedKeys = new Set(expected.map(key));
  const missing = [...expectedKeys].filter(item => !actualKeys.has(item));
  const extra = [...actualKeys].filter(item => !expectedKeys.has(item));
  if (missing.length || extra.length) {
    throw new Error(`${label} mismatch; missing=${JSON.stringify(missing)} extra=${JSON.stringify(extra)}`);
  }
  if (actual.length !== expected.length) {
    throw new Error(`${label} count mismatch; expected ${expected.length}, got ${actual.length}`);
  }
}

function assertAuth(sourceLine, expectedAuth, item) {
  if (expectedAuth === 'public') {
    if (/validate(?:ApiKey|IngestApiKey|Admin)/.test(sourceLine)) {
      throw new Error(`${key(item)} unexpectedly has authentication middleware`);
    }
    return;
  }
  const expectedMiddleware = expectedAuth === 'api'
    ? 'validateApiKey'
    : expectedAuth === 'ingest'
      ? 'validateIngestApiKey'
      : 'validateAdmin';
  if (!sourceLine.includes(expectedMiddleware)) {
    throw new Error(`${key(item)} is missing ${expectedMiddleware}: ${sourceLine}`);
  }
}

function main() {
  assertUnsupportedRouteDetection();
  const apiSource = fs.readFileSync(API_SOURCE_PATH, 'utf8');
  const operationsSource = fs.readFileSync(ADMIN_OPERATIONS_SOURCE_PATH, 'utf8');
  const direct = sourceRouteLines(apiSource, 'api');
  const operationRoutes = sourceRouteLines(operationsSource, 'router')
    .map(item => ({
      ...item,
      path: item.path === '/' ? '/admin/operations' : `/admin/operations${item.path}`,
      source: item.source,
    }));
  const actual = [...direct.filter(item => !item.path.startsWith('/admin/operations')), ...operationRoutes];

  assertEqualSets(actual, EXPECTED_ROUTES, 'API route inventory');

  const directByKey = new Map(direct.map(item => [key(item), item]));
  for (const expected of EXPECTED_ROUTES) {
    if (expected.notes.includes('mounted-router')) continue;
    const item = directByKey.get(key(expected));
    if (!item) throw new Error(`route source line missing for ${key(expected)}`);
    assertAuth(item.source, expected.auth, item);
  }

  if (!apiSource.includes("app.use('/admin/operations', validateAdmin, createAdminOperationsRouter")) {
    throw new Error('admin operations router is not mounted behind validateAdmin');
  }
  if (!apiSource.includes('ENABLE_TEST_UID_LOOKUP') || !apiSource.includes('ensureTestUidLookupEnabled')) {
    throw new Error('legacy GET /wallet/:uid feature branch is not explicit');
  }
  if (!apiSource.includes("app.get(['/api-docs', '/docs']")) {
    throw new Error('documentation route alias is not explicit');
  }
  if (!apiSource.includes('if (fs.existsSync(frontendBuild))')) {
    throw new Error('frontend static/wildcard configuration branch is not explicit');
  }
  if (!apiSource.includes('X-Ingest-API-Key') || !apiSource.includes('BEIA_API_KEY')) {
    throw new Error('ingest/BEIA authentication compatibility branch is not explicit');
  }

  const summary = {
    status: 'passed',
    routeCount: EXPECTED_ROUTES.length,
    explicitRoutes: EXPECTED_ROUTES.filter(item => item.path !== '*').length,
    conditionalRoutes: EXPECTED_ROUTES.filter(item => item.path === '*').length,
    generated: {
      head: 'Express exposes HEAD for GET routes',
      options: 'cors middleware handles OPTIONS preflight; no custom OPTIONS route is declared',
    },
    routes: EXPECTED_ROUTES,
    branches: [
      'ENABLE_TEST_UID_LOOKUP gates legacy GET /wallet/:uid',
      'GET /api-docs and GET /docs are aliases',
      'frontend static assets and GET * fallback are conditional on frontend/dist existing',
      'ingest auth accepts configured ingest/API/BEIA compatibility headers and admin bearer sessions',
    ],
  };
  console.log(JSON.stringify(summary, null, 2));
}

if (require.main === module) main();

module.exports = { EXPECTED_ROUTES, sourceRouteLines, assertUnsupportedRouteDetection, main };
