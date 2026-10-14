import assert from 'node:assert/strict';
import test from 'node:test';
import {
  apiUrl,
  classifyWalletQueryError,
  isTerminalReservationSettlement,
  matchesReservationContext,
  normalizeApiBaseUrl,
  sessionScopeKey,
} from '../dist/sparkz-charging-card.js';

const signedReceipt = {
  payload: { receiptId: 'receipt-1' },
  signature: 'signed',
  signerAddress: '0xsigner',
  canonicalPayload: '{}',
};

const baseSettlement = {
  status: 'settled',
  reservationId: 'reservation-1',
  sessionId: 'session-1',
  providerId: 'provider-1',
  reservedSparkz: '5.00',
  settledSparkz: '3.00',
  releasedSparkz: '2.00',
  deliveredKwh: '3.00',
  freeKwh: '3.00',
  txHash: '0xabc',
  spendReceipt: null,
  receiptStatus: 'pending',
  updatedAt: '2026-09-24T00:00:00.000Z',
};

test('normalizes endpoint and reservation terminal rules', () => {
  assert.equal(normalizeApiBaseUrl('https://example.test///'), 'https://example.test');
  assert.equal(apiUrl('https://example.test/', '/wallet/me'), 'https://example.test/wallet/me');
  assert.notEqual(sessionScopeKey('emaid-1', 'session-1', 'provider-1'), sessionScopeKey('emaid-2', 'session-1', 'provider-1'));
  assert.equal(isTerminalReservationSettlement(baseSettlement), false);
  assert.equal(isTerminalReservationSettlement({ ...baseSettlement, receiptStatus: 'settled', spendReceipt: signedReceipt }), true);
  assert.equal(isTerminalReservationSettlement({ ...baseSettlement, status: 'released', receiptStatus: 'none', txHash: null, spendReceipt: null }), true);
  assert.equal(isTerminalReservationSettlement({ ...baseSettlement, status: 'released', receiptStatus: 'none' }), false);
  assert.equal(isTerminalReservationSettlement({ ...baseSettlement, receiptStatus: 'settled', spendReceipt: { ...signedReceipt, signature: '' } }), false);
  assert.equal(isTerminalReservationSettlement({ ...baseSettlement, receiptStatus: 'settled', requiresReview: true, spendReceipt: signedReceipt }), false);
  assert.equal(isTerminalReservationSettlement({ ...baseSettlement, receiptStatus: 'orphaned', spendReceipt: signedReceipt }), false);
});

test('requires the expected reservation session and provider context', () => {
  const context = {
    reservationId: 'reservation-1',
    contractId: 'emaid-1',
    apiBaseUrl: 'https://api.example.test',
    sessionId: 'session-1',
    providerId: 'provider-1',
  };
  assert.equal(matchesReservationContext(baseSettlement, context), true);
  assert.equal(matchesReservationContext({ ...baseSettlement, providerId: 'provider-2' }, context), false);
  assert.equal(matchesReservationContext({ ...baseSettlement, reservationId: 'reservation-2' }, context), false);
  assert.equal(matchesReservationContext({ ...baseSettlement, sessionId: '' }, context), false);
  assert.equal(matchesReservationContext(baseSettlement, { ...context, sessionId: '' }), false);
});

test('classifies wallet validation and linkage failures without retry handles', () => {
  const invalid = classifyWalletQueryError({
    code: 'INVALID_WALLET_ADDRESS',
    httpStatus: 400,
    message: 'server detail must not be shown',
  });
  assert.equal(invalid.kind, 'invalid_address');
  assert.equal(invalid.statusCode, 400);
  assert.equal(invalid.retryable, false);
  assert.match(invalid.message, /invalid/i);
  assert.doesNotMatch(invalid.message, /server detail/);

  const notLinked = classifyWalletQueryError({ code: 'WALLET_NOT_LINKED', httpStatus: 403 });
  assert.equal(notLinked.kind, 'not_linked');
  assert.equal(notLinked.statusCode, 403);
  assert.equal(notLinked.retryable, false);
  assert.match(notLinked.message, /not linked/i);
});

test('classifies dependency and transport failures as read-only retryable balance errors', () => {
  const dependency = classifyWalletQueryError({ code: 'WALLET_QUERY_UNAVAILABLE', httpStatus: 500 });
  assert.equal(dependency.kind, 'unavailable');
  assert.equal(dependency.retryable, true);
  assert.match(dependency.message, /temporarily unavailable/i);

  const transport = classifyWalletQueryError(new TypeError('network failed'));
  assert.equal(transport.kind, 'unavailable');
  assert.equal(transport.retryable, true);
  assert.match(transport.message, /retry/i);
});
