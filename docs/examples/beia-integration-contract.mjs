/**
 * Secret-free BEIA integration contract examples.
 *
 * This file does not call NEVERFLAT, accept an API key, or verify a blockchain
 * signature. It exercises the boundaries that belong in the BEIA backend
 * proxy: same-origin routing, server-bound eMAID identity, route allowlisting,
 * and safe settlement classification.
 */

const ROUTES = Object.freeze([
  { method: 'GET', pattern: /^\/wallet\/me$/ },
  { method: 'POST', pattern: /^\/spend\/session$/ },
  { method: 'POST', pattern: /^\/spend\/me$/ },
  { method: 'GET', pattern: /^\/spend\/reservations\/[^/]+$/ },
  { method: 'POST', pattern: /^\/spend\/reservation-approval-intent$/ },
  { method: 'POST', pattern: /^\/wallet\/[^/]+\/linked-wallets$/ },
  { method: 'POST', pattern: /^\/wallet\/[^/]+\/mode$/ },
]);

const SECRET_HEADERS = new Set([
  'authorization',
  'x-api-key',
  'x-ingest-api-key',
]);

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Browser examples must use a same-origin proxy path. Absolute URLs and
 * protocol-relative URLs are rejected so a package integration cannot quietly
 * bypass the BEIA backend's identity and secret boundary.
 */
export function assertSameOriginApiBaseUrl(value) {
  const baseUrl = value === undefined ? '/api/sparkz' : value;
  requireNonEmptyString(baseUrl, 'apiBaseUrl');
  if (!baseUrl.startsWith('/')
    || baseUrl.startsWith('//')
    || /^[a-z][a-z\d+.-]*:/i.test(baseUrl)
    || /[\\?#\u0000-\u001f\u007f]/.test(baseUrl)) {
    throw new TypeError('apiBaseUrl must be a same-origin path such as /api/sparkz');
  }
  return baseUrl.replace(/\/+$/, '') || '/';
}

function normalisePath(path) {
  const value = requireNonEmptyString(path, 'path');
  if (!value.startsWith('/') || value.includes('?') || value.includes('#') || value.includes('..') || value.includes('\\')) {
    throw new TypeError('path must be an absolute API path without query, fragment, or traversal');
  }
  return value;
}

function matchingRoute(method, path) {
  const upperMethod = requireNonEmptyString(method, 'method').toUpperCase();
  const route = ROUTES.find((candidate) => candidate.method === upperMethod && candidate.pattern.test(path));
  if (!route) {
    throw new Error(`BEIA proxy route is not allowlisted: ${upperMethod} ${path}`);
  }
  return route;
}

/**
 * Construct the safe part of a proxy request. `authenticatedEmaid` must come
 * from the BEIA server session or a trusted account lookup. A browser value is
 * only checked for consistency; it is never used as the owner by itself.
 */
export function buildProxyRequest({
  method,
  path,
  authenticatedEmaid,
  requestedContractId,
  headers = {},
}) {
  const routePath = normalisePath(path);
  matchingRoute(method, routePath);
  const emaid = requireNonEmptyString(authenticatedEmaid, 'authenticatedEmaid');
  const walletOwnerMatch = routePath.match(/^\/wallet\/([^/]+)\/(?:linked-wallets|mode)$/);
  if (walletOwnerMatch) {
    let walletOwner;
    try {
      walletOwner = decodeURIComponent(walletOwnerMatch[1]);
    } catch {
      throw new TypeError('wallet route owner must be valid encoded text');
    }
    if (!walletOwner || walletOwner.includes('/') || walletOwner.includes('\\') || walletOwner.includes('..') || walletOwner !== emaid) {
      throw new Error('wallet route owner does not match the authenticated eMAID');
    }
  }
  const reservationMatch = routePath.match(/^\/spend\/reservations\/([^/]+)$/);
  if (reservationMatch) {
    let reservationId;
    try {
      reservationId = decodeURIComponent(reservationMatch[1]);
    } catch {
      throw new TypeError('reservation ID must be valid encoded text');
    }
    if (!reservationId || reservationId.includes('/') || reservationId.includes('\\') || reservationId.includes('..')) {
      throw new TypeError('reservation ID must be one safe path segment');
    }
  }
  if (requestedContractId !== undefined && requestedContractId !== emaid) {
    throw new Error('requested contract identity does not match the authenticated eMAID');
  }

  for (const name of Object.keys(headers)) {
    if (SECRET_HEADERS.has(name.toLowerCase())) {
      throw new Error(`browser secret header is not accepted: ${name}`);
    }
  }

  return {
    method: method.toUpperCase(),
    path: routePath,
    headers: { 'x-contract-id': emaid },
    // The proxy adds its private upstream API key outside this returned shape.
  };
}

/**
 * Classify a reservation response before it is handed to an EMP outbox.
 * Pending and review outcomes stay inside BEIA until a later poll or operator
 * decision; only terminal outcomes are delivery candidates.
 */
export function classifySettlement(settlement) {
  if (!settlement || typeof settlement !== 'object') {
    throw new TypeError('settlement must be an object');
  }
  if (settlement.requiresReview === true || settlement.status === 'requires_review' || settlement.status === 'blocked' || settlement.receiptStatus === 'orphaned') {
    return { outcome: 'review_required', deliveryCandidate: false, verificationRequired: false, retryable: false };
  }
  if (settlement.status === 'released') {
    if (settlement.receiptStatus !== 'none' || settlement.spendReceipt != null) {
      return { outcome: 'review_required', deliveryCandidate: false, verificationRequired: false, retryable: false };
    }
    return { outcome: 'released_candidate', deliveryCandidate: true, verificationRequired: false, retryable: false };
  }
  if (settlement.status === 'settled') {
    if (settlement.receiptStatus === 'settled' && settlement.spendReceipt && settlement.txHash) {
      return { outcome: 'settled_receipt_candidate', deliveryCandidate: true, verificationRequired: true, retryable: false };
    }
    return { outcome: 'pending_receipt', deliveryCandidate: false, verificationRequired: false, retryable: true };
  }
  if (settlement.status === 'reserved' || settlement.status === 'settling') {
    return { outcome: 'pending', deliveryCandidate: false, verificationRequired: false, retryable: true };
  }
  return { outcome: 'review_required', deliveryCandidate: false, verificationRequired: false, retryable: false };
}

function runContractChecks() {
  if (assertSameOriginApiBaseUrl() !== '/api/sparkz') throw new Error('default proxy path changed');
  if (assertSameOriginApiBaseUrl('/api/sparkz/') !== '/api/sparkz') throw new Error('proxy path normalisation changed');
  for (const url of ['https://neverflat.zentrix.io', '//neverflat.zentrix.io']) {
    try {
      assertSameOriginApiBaseUrl(url);
      throw new Error(`absolute URL was accepted: ${url}`);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
  }
  for (const url of ['/\\evil.example', '/api/sparkz?target=live', '/api/sparkz#fragment']) {
    try {
      assertSameOriginApiBaseUrl(url);
      throw new Error(`unsafe proxy path was accepted: ${url}`);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
  }

  const request = buildProxyRequest({
    method: 'GET',
    path: '/wallet/me',
    authenticatedEmaid: 'DE-NVF-EMP-001',
    requestedContractId: 'DE-NVF-EMP-001',
  });
  if (request.headers['x-contract-id'] !== 'DE-NVF-EMP-001') throw new Error('server-bound eMAID missing');
  const walletRequest = buildProxyRequest({
    method: 'POST',
    path: '/wallet/DE-NVF-EMP-001/mode',
    authenticatedEmaid: 'DE-NVF-EMP-001',
  });
  if (walletRequest.headers['x-contract-id'] !== 'DE-NVF-EMP-001') throw new Error('wallet route identity was not bound');
  try {
    buildProxyRequest({ method: 'GET', path: '/wallet/me', authenticatedEmaid: 'DE-NVF-EMP-001', requestedContractId: 'uid-001' });
    throw new Error('mismatched caller identity was accepted');
  } catch (error) {
    if (!String(error.message).includes('authenticated eMAID')) throw error;
  }
  try {
    buildProxyRequest({ method: 'GET', path: '/wallet/me', authenticatedEmaid: 'DE-NVF-EMP-001', headers: { 'x-api-key': 'secret' } });
    throw new Error('browser secret was accepted');
  } catch (error) {
    if (!String(error.message).includes('secret header')) throw error;
  }
  try {
    buildProxyRequest({ method: 'POST', path: '/wallet/DE-NVF-OTHER/mode', authenticatedEmaid: 'DE-NVF-EMP-001' });
    throw new Error('wallet route owner was not bound');
  } catch (error) {
    if (!String(error.message).includes('wallet route owner')) throw error;
  }
  try {
    buildProxyRequest({ method: 'POST', path: '/wallet/DE%2FNVF/mode', authenticatedEmaid: 'DE-NVF-EMP-001' });
    throw new Error('encoded wallet route owner was not rejected');
  } catch (error) {
    if (!String(error.message).includes('wallet route owner')) throw error;
  }
  for (const path of ['/spend/reservations/a%2Fb', '/spend/reservations/%2e%2e']) {
    try {
      buildProxyRequest({ method: 'GET', path, authenticatedEmaid: 'DE-NVF-EMP-001' });
      throw new Error(`unsafe reservation path was accepted: ${path}`);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
    }
  }

  const settled = {
    status: 'settled',
    receiptStatus: 'settled',
    txHash: '0x' + '1'.repeat(64),
    sessionId: 'session-123',
    providerId: 'provider-001',
    spendReceipt: {
      signerAddress: '0xSigner',
      signature: '0xSignature',
      canonicalPayload: '{"contractId":"DE-NVF-EMP-001"}',
      payload: {
        version: '1.0',
        receiptId: 'spr_example',
        status: 'settled',
        contractId: 'DE-NVF-EMP-001',
        walletAddress: '0xWallet',
        amount: '3.00',
        sessionId: 'session-123',
        providerId: 'provider-001',
        tokenTxHash: '0x' + '1'.repeat(64),
        tokenContractAddress: '0xToken',
        chainId: 80002,
        issuedAt: '2026-09-24T00:00:00.000Z',
      },
    },
  };
  const settledClassification = classifySettlement(settled);
  if (!settledClassification.deliveryCandidate || !settledClassification.verificationRequired
    || settledClassification.outcome !== 'settled_receipt_candidate') {
    throw new Error('settled receipt was not classified as a verification candidate');
  }
  if (classifySettlement({ status: 'settled', receiptStatus: 'pending', txHash: settled.txHash }).outcome !== 'pending_receipt') {
    throw new Error('pending receipt was not retained for retry');
  }
  if (classifySettlement({ status: 'released', receiptStatus: 'none', spendReceipt: null }).outcome !== 'released_candidate') {
    throw new Error('released reservation was not classified');
  }
  if (classifySettlement({ status: 'settled', requiresReview: true }).outcome !== 'review_required') {
    throw new Error('review-required settlement was not blocked');
  }
  if (classifySettlement({ status: 'settled', receiptStatus: 'orphaned' }).outcome !== 'review_required') {
    throw new Error('orphaned receipt was not blocked');
  }
  console.log('BEIA integration contract checks passed');
}

if (process.argv[1] && decodeURIComponent(new URL(import.meta.url).pathname).endsWith(process.argv[1].replaceAll('\\', '/'))) {
  runContractChecks();
}
