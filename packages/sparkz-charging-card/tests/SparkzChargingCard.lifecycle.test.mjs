import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { SparkzChargingCard } from '../dist/sparkz-charging-card.js';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;
const activeRenderers = new Set();

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

function response(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

function wallet(uid) {
  return {
    status: 'success',
    uid,
    walletMode: 'managed',
    walletAddress: `0x${uid.slice(-8).padStart(8, '0')}`,
    managedWalletAddress: `0x${uid.slice(-8).padStart(8, '0')}`,
    isRegistered: true,
    balance: '10.00',
    totalAwarded: '10.00',
    totalSpent: '0.00',
    history: [],
  };
}

function session(contractId, sessionId, providerId) {
  return {
    status: 'success',
    contractId,
    sessionId,
    providerId,
    chargerId: 'charger-1',
    sessionStatus: 'PLUGGED_IN',
    wallet: { availableBalance: 10, totalEarned: 10, totalSpent: 0, mode: 'managed' },
    spend: {
      eligible: true,
      maxSpendable: 5,
      suggestedAmount: 1,
      label: 'Charging discount',
      message: 'Apply a charging discount',
    },
    recentActivity: [],
    rewardRates: [],
  };
}

function signedReceipt() {
  return {
    payload: {
      receiptId: 'receipt-1',
      status: 'settled',
      contractId: 'emaid-1',
      walletAddress: '0x0000000000000000000000000000000000000001',
      amount: '1.00',
      tokenTxHash: '0xabc',
      tokenContractAddress: '0x0000000000000000000000000000000000000002',
      chainId: 80002,
      issuedAt: '2026-09-24T00:00:00.000Z',
    },
    signature: 'signed',
    signerAddress: '0x0000000000000000000000000000000000000003',
    canonicalPayload: '{}',
  };
}

function settlement(overrides = {}) {
  return {
    status: 'settled',
    reservationId: 'reservation-1',
    sessionId: 'session-1',
    providerId: 'provider-1',
    reservedSparkz: '1.00',
    settledSparkz: '1.00',
    releasedSparkz: '0.00',
    deliveredKwh: '1.00',
    freeKwh: '1.00',
    txHash: '0xabc',
    spendReceipt: signedReceipt(),
    receiptStatus: 'settled',
    updatedAt: '2026-09-24T00:00:00.000Z',
    ...overrides,
  };
}

function text(node) {
  if (node === null || node === undefined) return '';
  if (Array.isArray(node)) return node.map(text).join('');
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  return text(node.children);
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await new Promise(resolve => setTimeout(resolve, 0));
  });
}

async function renderCard(props) {
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(SparkzChargingCard, props));
  });
  activeRenderers.add(renderer);
  await flush();
  return renderer;
}

async function updateCard(renderer, props) {
  await act(async () => {
    renderer.update(React.createElement(SparkzChargingCard, props));
  });
  await flush();
}

afterEach(async () => {
  for (const renderer of activeRenderers) {
    await act(async () => renderer.unmount());
  }
  activeRenderers.clear();
  globalThis.fetch = originalFetch;
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
});

test('ignores delayed wallet and reservation responses from a previous owner', async () => {
  const oldWallet = deferred();
  const newWallet = deferred();
  const oldSpend = deferred();
  const loadedOwners = [];
  const reservations = [];
  let walletCall = 0;

  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.endsWith('/wallet/me')) {
      walletCall += 1;
      return walletCall === 1 ? oldWallet.promise : newWallet.promise;
    }
    if (path.endsWith('/spend/session')) return response(session('old-emaid', 'session-1', 'provider-1'));
    if (path.endsWith('/spend/me')) return oldSpend.promise;
    throw new Error(`Unexpected request ${path}`);
  };

  const initialProps = {
    apiBaseUrl: 'http://local.test/api',
    contractId: 'old-emaid',
    sessionId: 'session-1',
    providerId: 'provider-1',
    sessionStatus: 'PLUGGED_IN',
    onWalletLoaded: value => loadedOwners.push(value.uid),
    onReservationSuccess: value => reservations.push(value.id),
  };
  const renderer = await renderCard(initialProps);
  await updateCard(renderer, { ...initialProps, apiBaseUrl: 'http://new.test/api', contractId: 'new-emaid', sessionStatus: 'UNPLUGGED' });

  await act(async () => {
    oldWallet.resolve(response(wallet('old-emaid')));
    await oldWallet.promise;
  });
  assert.deepEqual(loadedOwners, [], 'old owner wallet callback is suppressed');

  await act(async () => {
    newWallet.resolve(response(wallet('new-emaid')));
    await newWallet.promise;
  });
  assert.deepEqual(loadedOwners, ['new-emaid'], 'new owner wallet remains loadable');

  // Start an old-owner reservation and change owners while /spend/me is in flight.
  const activeProps = { ...initialProps, contractId: 'old-emaid' };
  await updateCard(renderer, activeProps);
  await flush();
  const form = renderer.root.findByType('form');
  let pendingSubmit;
  await act(async () => {
    pendingSubmit = form.props.onSubmit({ preventDefault() {} });
    await Promise.resolve();
  });
  await updateCard(renderer, { ...activeProps, contractId: 'new-emaid', sessionStatus: 'UNPLUGGED' });
  await act(async () => {
    oldSpend.resolve(response({
      status: 'success',
      reservation: { id: 'old-reservation', status: 'reserved', amount: '1.00', kWhEntitlement: '1.00', availableBalance: 9 },
    }));
    await pendingSubmit;
  });
  assert.deepEqual(reservations, [], 'old owner reservation callback is suppressed');
});

test('keeps polling the original reservation when the owning session closes', async () => {
  const pendingStatus = deferred();
  const settlements = [];
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    requests.push({ path, init });
    if (path.endsWith('/wallet/me')) return response(wallet('emaid-1'));
    if (path.endsWith('/spend/session')) return response(session('emaid-1', 'session-1', 'provider-1'));
    if (path.endsWith('/spend/reservations/reservation-1')) return pendingStatus.promise;
    throw new Error(`Unexpected request ${path}`);
  };

  const activeProps = {
    apiBaseUrl: 'http://local.test/api',
    contractId: 'emaid-1',
    sessionId: 'session-1',
    providerId: 'provider-1',
    reservationId: 'reservation-1',
    sessionStatus: 'PLUGGED_IN',
    onReservationSettlement: value => settlements.push(value.reservationId),
  };
  const renderer = await renderCard(activeProps);
  await updateCard(renderer, { ...activeProps, sessionStatus: 'UNPLUGGED' });
  await act(async () => {
    pendingStatus.resolve(response(settlement()));
    await pendingStatus.promise;
  });
  await flush();
  assert.deepEqual(settlements, ['reservation-1'], 'original reservation settles after session close');
  const reservationRequest = requests.find(request => request.path.endsWith('/spend/reservations/reservation-1'));
  assert.equal(reservationRequest.init.headers['x-contract-id'], 'emaid-1');
});

test('resumes a terminal reservation after remount and reports callback errors once', async () => {
  let reservationRequests = 0;
  let callbackCount = 0;
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.endsWith('/wallet/me')) return response(wallet('emaid-1'));
    if (path.endsWith('/spend/reservations/reservation-1')) {
      reservationRequests += 1;
      return response(settlement());
    }
    throw new Error(`Unexpected request ${path}`);
  };

  const renderer = await renderCard({
    apiBaseUrl: 'http://local.test/api',
    contractId: 'emaid-1',
    sessionId: 'session-1',
    providerId: 'provider-1',
    reservationId: 'reservation-1',
    sessionStatus: 'UNPLUGGED',
    onReservationSettlement: () => {
      callbackCount += 1;
      return Promise.reject(new Error('host callback failed'));
    },
  });
  await flush();
  assert.equal(callbackCount, 1, 'callback is delivered once');
  assert.equal(reservationRequests, 1, 'terminal status stops polling');
  assert.match(text(renderer.toJSON()), /host callback failed/);
});

test('retains a reservation created before the same-owner session closes', async () => {
  const pendingSpend = deferred();
  const reservations = [];
  const settlements = [];
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.endsWith('/wallet/me')) return response(wallet('emaid-1'));
    if (path.endsWith('/spend/session')) return response(session('emaid-1', 'session-1', 'provider-1'));
    if (path.endsWith('/spend/me')) return pendingSpend.promise;
    if (path.endsWith('/spend/reservations/created-after-close')) return response(settlement({ reservationId: 'created-after-close' }));
    throw new Error(`Unexpected request ${path}`);
  };

  const activeProps = {
    apiBaseUrl: 'http://local.test/api',
    contractId: 'emaid-1',
    sessionId: 'session-1',
    providerId: 'provider-1',
    sessionStatus: 'PLUGGED_IN',
    hideAfterSpend: false,
    onReservationSuccess: value => reservations.push(value.id),
    onReservationSettlement: value => settlements.push(value.reservationId),
  };
  const renderer = await renderCard(activeProps);
  const form = renderer.root.findByType('form');
  let pendingSubmit;
  await act(async () => {
    pendingSubmit = form.props.onSubmit({ preventDefault() {} });
    await Promise.resolve();
  });
  await updateCard(renderer, { ...activeProps, sessionId: undefined, providerId: undefined, sessionStatus: 'UNPLUGGED' });
  await act(async () => {
    pendingSpend.resolve(response({
      status: 'success',
      reservation: { id: 'created-after-close', status: 'reserved', amount: '1.00', kWhEntitlement: '1.00', availableBalance: 9 },
    }));
    await pendingSubmit;
  });
  await flush();
  assert.deepEqual(reservations, ['created-after-close']);
  assert.deepEqual(settlements, ['created-after-close']);
});

test('retains an old reservation for polling without dismissing a new active session', async () => {
  const pendingSpend = deferred();
  const reservations = [];
  const dismissals = [];
  let spendCalls = 0;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    if (path.endsWith('/wallet/me')) return response(wallet('emaid-1'));
    if (path.endsWith('/spend/session')) {
      const body = JSON.parse(init.body || '{}');
      return response(body.sessionId === 'session-2'
        ? session('emaid-1', 'session-2', 'provider-2')
        : session('emaid-1', 'session-1', 'provider-1'));
    }
    if (path.endsWith('/spend/me')) {
      spendCalls += 1;
      return pendingSpend.promise;
    }
    if (path.endsWith('/spend/reservations/old-reservation')) return response(settlement({ reservationId: 'old-reservation' }));
    throw new Error(`Unexpected request ${path}`);
  };

  const oldProps = {
    apiBaseUrl: 'http://local.test/api',
    contractId: 'emaid-1',
    sessionId: 'session-1',
    providerId: 'provider-1',
    sessionStatus: 'PLUGGED_IN',
    onReservationSuccess: value => reservations.push(value.id),
    onDismiss: value => dismissals.push(value),
  };
  const renderer = await renderCard(oldProps);
  const form = renderer.root.findByType('form');
  let pendingSubmit;
  await act(async () => {
    pendingSubmit = form.props.onSubmit({ preventDefault() {} });
    await Promise.resolve();
  });
  await updateCard(renderer, {
    ...oldProps,
    sessionId: 'session-2',
    providerId: 'provider-2',
  });
  await act(async () => {
    pendingSpend.resolve(response({
      status: 'success',
      reservation: { id: 'old-reservation', status: 'reserved', amount: '1.00', kWhEntitlement: '1.00', availableBalance: 9 },
    }));
    await pendingSubmit;
  });
  await flush();
  assert.deepEqual(reservations, ['old-reservation']);
  assert.deepEqual(dismissals, [], 'new active session is not dismissed by the old reservation');
  assert.match(text(renderer.toJSON()), /Apply a charging discount/);
  assert.equal(spendCalls, 1, 'session transition does not issue a second old-session spend');
});

test('suppresses reservation callbacks after unmount', async () => {
  const pendingStatus = deferred();
  let callbackCount = 0;
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.endsWith('/wallet/me')) return response(wallet('emaid-1'));
    if (path.endsWith('/spend/reservations/reservation-1')) return pendingStatus.promise;
    throw new Error(`Unexpected request ${path}`);
  };

  const renderer = await renderCard({
    apiBaseUrl: 'http://local.test/api',
    contractId: 'emaid-1',
    sessionId: 'session-1',
    providerId: 'provider-1',
    reservationId: 'reservation-1',
    sessionStatus: 'UNPLUGGED',
    onReservationSettlement: () => { callbackCount += 1; },
  });
  await act(async () => renderer.unmount());
  activeRenderers.delete(renderer);
  await act(async () => {
    pendingStatus.resolve(response(settlement()));
    await pendingStatus.promise;
  });
  assert.equal(callbackCount, 0);
});

test('suppresses a delayed spend response after unmount', async () => {
  const pendingSpend = deferred();
  let reservationCallbackCount = 0;
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.endsWith('/wallet/me')) return response(wallet('emaid-1'));
    if (path.endsWith('/spend/session')) return response(session('emaid-1', 'session-1', 'provider-1'));
    if (path.endsWith('/spend/me')) return pendingSpend.promise;
    throw new Error(`Unexpected request ${path}`);
  };

  const props = {
    apiBaseUrl: 'http://local.test/api',
    contractId: 'emaid-1',
    sessionId: 'session-1',
    providerId: 'provider-1',
    sessionStatus: 'PLUGGED_IN',
    hideAfterSpend: false,
    onReservationSuccess: () => { reservationCallbackCount += 1; },
  };
  const renderer = await renderCard(props);
  const form = renderer.root.findByType('form');
  let pendingSubmit;
  await act(async () => {
    pendingSubmit = form.props.onSubmit({ preventDefault() {} });
    await Promise.resolve();
  });
  await act(async () => renderer.unmount());
  activeRenderers.delete(renderer);
  await act(async () => {
    pendingSpend.resolve(response({
      status: 'success',
      reservation: { id: 'unmounted-reservation', status: 'reserved', amount: '1.00', kWhEntitlement: '1.00', availableBalance: 9 },
    }));
    await pendingSubmit;
  });
  assert.equal(reservationCallbackCount, 0);
});

test('does not sign or spend after the active session closes during approval', async () => {
  const pendingIntent = deferred();
  let sendTransactionCalls = 0;
  let spendCalls = 0;
  globalThis.window = {
    ethereum: {
      request: async ({ method }) => {
        if (method === 'eth_sendTransaction') sendTransactionCalls += 1;
        return '0xapproval';
      },
    },
  };
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.endsWith('/wallet/me')) return response({ ...wallet('emaid-1'), walletMode: 'custodial' });
    if (path.endsWith('/spend/session')) return response(session('emaid-1', 'session-1', 'provider-1'));
    if (path.endsWith('/spend/reservation-approval-intent')) return pendingIntent.promise;
    if (path.endsWith('/spend/me')) {
      spendCalls += 1;
      return response({
        status: 'success',
        reservation: { id: 'unexpected-reservation', status: 'reserved', amount: '1.00', kWhEntitlement: '1.00', availableBalance: 9 },
      });
    }
    throw new Error(`Unexpected request ${path}`);
  };

  const activeProps = {
    apiBaseUrl: 'http://local.test/api',
    contractId: 'emaid-1',
    sessionId: 'session-1',
    providerId: 'provider-1',
    sessionStatus: 'PLUGGED_IN',
    hideAfterSpend: false,
  };
  const renderer = await renderCard(activeProps);
  const form = renderer.root.findByType('form');
  let pendingSubmit;
  await act(async () => {
    pendingSubmit = form.props.onSubmit({ preventDefault() {} });
    await Promise.resolve();
  });
  await updateCard(renderer, { ...activeProps, sessionStatus: 'UNPLUGGED' });
  await act(async () => {
    pendingIntent.resolve(response({
      status: 'requires_signature',
      walletAddress: '0x0000000000000000000000000000000000000001',
      requiredAllowance: '1.00',
      transaction: {
        from: '0x0000000000000000000000000000000000000001',
        to: '0x0000000000000000000000000000000000000002',
        value: '0x0',
        data: '0x',
      },
    }));
    await pendingSubmit;
  });
  assert.equal(sendTransactionCalls, 0, 'approval signing is suppressed after session close');
  assert.equal(spendCalls, 0, 'old session cannot create a spend after close');
});

test('blocks a new spend while a saved reservation is still pending', async () => {
  globalThis.fetch = async (url) => {
    const path = String(url);
    if (path.endsWith('/wallet/me')) return response(wallet('emaid-1'));
    if (path.endsWith('/spend/session')) return response(session('emaid-1', 'session-1', 'provider-1'));
    if (path.endsWith('/spend/reservations/reservation-1')) {
      return response(settlement({
        status: 'settling',
        settledSparkz: null,
        releasedSparkz: null,
        txHash: null,
        spendReceipt: null,
        receiptStatus: 'pending',
      }));
    }
    throw new Error(`Unexpected request ${path}`);
  };

  const renderer = await renderCard({
    apiBaseUrl: 'http://local.test/api',
    contractId: 'emaid-1',
    sessionId: 'session-1',
    providerId: 'provider-1',
    reservationId: 'reservation-1',
    sessionStatus: 'PLUGGED_IN',
  });
  await flush();
  const waitingButton = renderer.root.findAllByType('button').find(button => text(button.props.children) === 'Waiting for reservation');
  assert.ok(waitingButton, 'pending reservation explains why the action is unavailable');
  assert.equal(waitingButton.props.disabled, true);
});
