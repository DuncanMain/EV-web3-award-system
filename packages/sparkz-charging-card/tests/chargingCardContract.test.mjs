import assert from 'node:assert/strict';
import test from 'node:test';
import {
  apiUrl,
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
