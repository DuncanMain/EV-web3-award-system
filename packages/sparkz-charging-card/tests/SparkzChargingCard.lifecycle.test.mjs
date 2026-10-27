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

function wallet(uid, walletMode = 'managed') {
  return {
    status: 'success',
    uid,
    walletMode,
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

function approvalReceipt(hash, walletAddress) {
  return {
    transactionHash: hash,
    transactionIndex: '0x0',
    blockHash: `0x${'b'.repeat(64)}`,
    blockNumber: '0x10',
    from: walletAddress,
    to: '0x0000000000000000000000000000000000000002',
    cumulativeGasUsed: '0x1',
    gasUsed: '0x1',
    effectiveGasPrice: '0x1',
    logsBloom: `0x${'0'.repeat(512)}`,
    logs: [],
    status: '0x1',
    type: '0x2',
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

test('shows invalid wallet address as a caller error and clears it after an eMAID owner recovery', async () => {
  const requests = [];
  const loadedOwners = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    requests.push({ path, init });
    assert.match(path, /\/wallet\/me$/);
    if (requests.length === 1) {
      return response({ status: 'error', code: 'INVALID_WALLET_ADDRESS', message: 'raw server detail' }, 400);
    }
    return response(wallet('emaid-recovered'));
  };

  const renderer = await renderCard({
    apiBaseUrl: 'http://local.test/api',
    contractId: 'emaid-invalid',
    sessionStatus: 'UNPLUGGED',
    onWalletLoaded: value => loadedOwners.push(value.uid),
  });
  const failedText = text(renderer.toJSON());
  assert.match(failedText, /linked wallet address is invalid/i);
  assert.match(failedText, /Unavailable/);
  assert.doesNotMatch(failedText, /Retry account/);
  assert.doesNotMatch(failedText, /raw server detail/);
  assert.equal(requests[0].init.method, 'GET');
  assert.equal(requests[0].init.headers['x-contract-id'], 'emaid-invalid');
  assert.equal(requests.filter(request => /\/spend\//.test(request.path)).length, 0);

  await updateCard(renderer, {
    apiBaseUrl: 'http://local.test/api',
    contractId: 'emaid-recovered',
    sessionStatus: 'UNPLUGGED',
    onWalletLoaded: value => loadedOwners.push(value.uid),
  });
  const recoveredText = text(renderer.toJSON());
  assert.match(recoveredText, /10\.00/);
  assert.doesNotMatch(recoveredText, /linked wallet address is invalid/i);
  assert.deepEqual(loadedOwners, ['emaid-recovered']);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].init.headers['x-contract-id'], 'emaid-recovered');
  assert.equal(requests.filter(request => /\/spend\//.test(request.path)).length, 0);
});

test('shows an unlinked wallet as a linkage error and recovers without a financial action', async () => {
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    requests.push({ path, init });
    assert.match(path, /\/wallet\/me$/);
    return requests.length === 1
      ? response({ status: 'error', code: 'WALLET_NOT_LINKED', message: 'raw linkage detail' }, 403)
      : response(wallet('emaid-linked'));
  };

  const renderer = await renderCard({
    apiBaseUrl: 'http://local.test/api',
    contractId: 'emaid-unlinked',
    sessionStatus: 'UNPLUGGED',
  });
  const failedText = text(renderer.toJSON());
  assert.match(failedText, /not linked to this eMAID/i);
  assert.match(failedText, /Unavailable/);
  assert.doesNotMatch(failedText, /Retry account/);
  assert.doesNotMatch(failedText, /raw linkage detail/);
  assert.equal(requests[0].init.headers['x-contract-id'], 'emaid-unlinked');

  await updateCard(renderer, {
    apiBaseUrl: 'http://local.test/api',
    contractId: 'emaid-linked',
    sessionStatus: 'UNPLUGGED',
  });
  const recoveredText = text(renderer.toJSON());
  assert.match(recoveredText, /10\.00/);
  assert.doesNotMatch(recoveredText, /not linked to this eMAID/i);
  assert.equal(requests.length, 2);
  assert.equal(requests[1].init.headers['x-contract-id'], 'emaid-linked');
  assert.equal(requests.filter(request => /\/spend\//.test(request.path)).length, 0);
});

test('offers a bounded read-only wallet retry for unavailable balance and recovers without repeated financial actions', async () => {
  const requests = [];
  let loadedCount = 0;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    requests.push({ path, init });
    assert.match(path, /\/wallet\/me$/);
    return requests.length === 1
      ? response({ status: 'error', code: 'WALLET_QUERY_UNAVAILABLE', message: 'raw provider detail' }, 500)
      : response(wallet('emaid-retry'));
  };

  const renderer = await renderCard({
    apiBaseUrl: 'http://local.test/api',
    contractId: 'emaid-retry',
    sessionStatus: 'UNPLUGGED',
    onWalletLoaded: () => { loadedCount += 1; },
  });
  const failedText = text(renderer.toJSON());
  assert.match(failedText, /temporarily unavailable/i);
  assert.match(failedText, /Unavailable/);
  assert.match(failedText, /Retry account/);
  assert.doesNotMatch(failedText, /raw provider detail/);
  assert.equal(requests.length, 1);

  const retryButton = renderer.root.findAllByType('button').find(button => text(button) === 'Retry account');
  assert.ok(retryButton, 'retry action is present only for unavailable balance');
  await act(async () => {
    retryButton.props.onClick();
  });
  await flush();

  const recoveredText = text(renderer.toJSON());
  assert.match(recoveredText, /10\.00/);
  assert.doesNotMatch(recoveredText, /temporarily unavailable/i);
  assert.equal(requests.length, 2, 'retry performs exactly one additional wallet GET');
  assert.equal(requests[0].init.method, 'GET');
  assert.equal(requests[1].init.method, 'GET');
  assert.equal(requests[0].init.headers['x-contract-id'], 'emaid-retry');
  assert.equal(requests[1].init.headers['x-contract-id'], 'emaid-retry');
  assert.equal(loadedCount, 1);
  assert.equal(requests.filter(request => /\/spend\//.test(request.path)).length, 0);
});

test('rejects a 200 wallet response with an unavailable balance before owner state is committed', async () => {
  const requests = [];
  let loadedCount = 0;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    requests.push({ path, init });
    assert.match(path, /\/wallet\/me$/);
    return requests.length === 1
      ? response({
        status: 'success',
        uid: 'emaid-200-unavailable',
        balance: null,
        balanceStatus: 'unavailable',
      }, 200)
      : response(wallet('emaid-200-unavailable'));
  };

  const renderer = await renderCard({
    apiBaseUrl: 'http://local.test/api',
    contractId: 'emaid-200-unavailable',
    sessionStatus: 'UNPLUGGED',
    onWalletLoaded: () => { loadedCount += 1; },
  });
  const failedText = text(renderer.toJSON());
  assert.match(failedText, /temporarily unavailable/i);
  assert.match(failedText, /Unavailable/);
  assert.doesNotMatch(failedText, /0\.00/);
  assert.match(failedText, /Retry account/);
  assert.equal(loadedCount, 0, 'unavailable data does not reach the wallet callback');

  const retryButton = renderer.root.findAllByType('button').find(button => text(button) === 'Retry account');
  assert.ok(retryButton);
  await act(async () => {
    retryButton.props.onClick();
  });
  await flush();

  const recoveredText = text(renderer.toJSON());
  assert.match(recoveredText, /10\.00/);
  assert.doesNotMatch(recoveredText, /temporarily unavailable/i);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].init.method, 'GET');
  assert.equal(requests[1].init.method, 'GET');
  assert.equal(requests[0].init.headers['x-contract-id'], 'emaid-200-unavailable');
  assert.equal(requests[1].init.headers['x-contract-id'], 'emaid-200-unavailable');
  assert.equal(loadedCount, 1);
  assert.equal(requests.filter(request => /\/spend\//.test(request.path)).length, 0);
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

test('preserves pending 202 review fields and retries the same reservation request', async () => {
  const spendErrors = [];
  const reservations = [];
  const spendRequests = [];
  let spendCall = 0;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    if (path.endsWith('/wallet/me')) return response(wallet('emaid-1'));
    if (path.endsWith('/spend/session')) return response(session('emaid-1', 'session-1', 'provider-1'));
    if (path.endsWith('/spend/me')) {
      spendRequests.push(JSON.parse(init.body || '{}'));
      spendCall += 1;
      if (spendCall === 1) {
        return response({
          status: 'pending',
          pending: true,
          retryable: false,
          requiresReview: true,
          operationKey: 'reservation:pending-202',
          message: 'The reservation is awaiting chain confirmation.',
        }, 202);
      }
      return response({
        status: 'success',
        reservation: { id: 'reservation-retried', status: 'reserved', amount: '1.00', kWhEntitlement: '1.00', availableBalance: 9 },
      });
    }
    if (path.endsWith('/spend/reservations/reservation-retried')) return response(settlement({ reservationId: 'reservation-retried', status: 'settling', receiptStatus: 'pending', txHash: null, spendReceipt: null }));
    throw new Error(`Unexpected request ${path}`);
  };

  const renderer = await renderCard({
    apiBaseUrl: 'http://local.test/api',
    contractId: 'emaid-1',
    sessionId: 'session-1',
    providerId: 'provider-1',
    sessionStatus: 'PLUGGED_IN',
    hideAfterSpend: false,
    onReservationSuccess: value => reservations.push(value.id),
    onSpendError: error => spendErrors.push(error),
  });
  let form = renderer.root.findByType('form');
  await act(async () => {
    await form.props.onSubmit({ preventDefault() {} });
  });

  assert.equal(spendErrors.length, 1);
  assert.equal(spendErrors[0].pending, true);
  assert.equal(spendErrors[0].requiresReview, true);
  assert.equal(spendErrors[0].retryable, false);
  assert.equal(spendErrors[0].operationKey, 'reservation:pending-202');
  assert.match(text(renderer.toJSON()), /awaiting chain confirmation/);

  form = renderer.root.findByType('form');
  await act(async () => {
    await form.props.onSubmit({ preventDefault() {} });
  });

  assert.deepEqual(reservations, ['reservation-retried']);
  assert.equal(spendRequests.length, 2);
  assert.deepEqual(spendRequests[1], spendRequests[0], 'retry keeps the original session/provider/amount identity');
});

test('retries a lost mode response with the same optional key and changes key at an owner boundary', async () => {
  const modeRequests = [];
  let owner = 'emaid-1';
  let modeCall = 0;
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    if (path.endsWith('/wallet/me')) {
      return response(wallet(owner, owner === 'emaid-1' && modeCall > 1 ? 'managed' : 'custodial'));
    }
    if (path.endsWith('/wallet/emaid-1/mode') || path.endsWith('/wallet/emaid-2/mode')) {
      modeRequests.push(JSON.parse(init.body || '{}'));
      modeCall += 1;
      if (modeCall === 1) throw new Error('mode response lost');
      return response({ status: 'success', walletMode: 'managed' });
    }
    throw new Error(`Unexpected request ${path}`);
  };

  const renderer = await renderCard({
    apiBaseUrl: 'http://local.test/api',
    contractId: 'emaid-1',
    sessionStatus: 'UNPLUGGED',
  });
  await flush();
  const accountButton = renderer.root.findAllByType('button').find(button => text(button.props.children) === 'Account');
  assert.ok(accountButton);
  await act(async () => {
    accountButton.props.onClick();
    await flush();
  });
  let modeButton = renderer.root.findAllByType('button').find(button => text(button.props.children) === 'Use managed wallet');
  assert.ok(modeButton);
  await act(async () => {
    modeButton.props.onClick();
    await flush();
  });

  modeButton = renderer.root.findAllByType('button').find(button => text(button.props.children) === 'Use managed wallet');
  assert.ok(modeButton, 'the failed mode response leaves the retry action available');
  await act(async () => {
    modeButton.props.onClick();
    await flush();
  });

  assert.equal(modeRequests.length, 2);
  assert.equal(modeRequests[0].mode, 'managed');
  assert.equal(modeRequests[0].allowSplit, true);
  assert.equal(typeof modeRequests[0].idempotencyKey, 'string');
  assert.ok(modeRequests[0].idempotencyKey.length > 0);
  assert.equal(modeRequests[1].idempotencyKey, modeRequests[0].idempotencyKey, 'response-loss retry reuses the same optional key');

  owner = 'emaid-2';
  await updateCard(renderer, {
    apiBaseUrl: 'http://local.test/api',
    contractId: owner,
    sessionStatus: 'UNPLUGGED',
  });
  modeButton = renderer.root.findAllByType('button').find(button => text(button.props.children) === 'Use managed wallet');
  assert.ok(modeButton, 'the new owner gets its own mode action');
  await act(async () => {
    modeButton.props.onClick();
    await flush();
  });

  assert.equal(modeRequests.length, 3);
  assert.notEqual(modeRequests[2].idempotencyKey, modeRequests[0].idempotencyKey, 'owner change starts a new mode identity');
});

test('reuses a confirmed custodial approval after a pending reservation response', async () => {
  const approvalHash = `0x${'a'.repeat(64)}`;
  const walletAddress = '0x0000000000000000000000000000000000000001';
  const approvalIntents = [];
  const spendRequests = [];
  const spendErrors = [];
  const reservations = [];
  let approvalSendCalls = 0;
  let spendCall = 0;

  globalThis.window = {
    ethereum: {
      request: async ({ method, params = [] }) => {
        if (method === 'eth_sendTransaction') {
          approvalSendCalls += 1;
          return approvalHash;
        }
        if (method === 'eth_chainId') return '0x13882';
        if (method === 'eth_blockNumber') return '0x10';
        if (method === 'eth_getTransactionReceipt') return approvalReceipt(params[0], walletAddress);
        throw new Error(`Unexpected wallet RPC ${method}`);
      },
    },
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    if (path.endsWith('/wallet/me')) {
      return response({ ...wallet('emaid-1', 'custodial'), walletAddress, managedWalletAddress: walletAddress });
    }
    if (path.endsWith('/spend/session')) return response(session('emaid-1', 'session-1', 'provider-1'));
    if (path.endsWith('/spend/reservation-approval-intent')) {
      approvalIntents.push(JSON.parse(init.body || '{}'));
      return response({
        status: 'requires_signature',
        walletAddress,
        requiredAllowance: '1.00',
        transaction: {
          from: walletAddress,
          to: '0x0000000000000000000000000000000000000002',
          value: '0x0',
          data: '0x',
        },
      });
    }
    if (path.endsWith('/spend/me')) {
      spendRequests.push(JSON.parse(init.body || '{}'));
      spendCall += 1;
      if (spendCall === 1) {
        return response({
          status: 'pending',
          pending: true,
          retryable: false,
          requiresReview: true,
          operationKey: 'reservation:custodial-pending',
          message: 'The reservation is awaiting chain confirmation.',
        }, 202);
      }
      return response({
        status: 'success',
        reservation: { id: 'custodial-retried', status: 'reserved', amount: '1.00', kWhEntitlement: '1.00', availableBalance: 9 },
      });
    }
    if (path.endsWith('/spend/reservations/custodial-retried')) {
      return response(settlement({ reservationId: 'custodial-retried', status: 'settling', receiptStatus: 'pending', txHash: null, spendReceipt: null }));
    }
    throw new Error(`Unexpected request ${path}`);
  };

  const renderer = await renderCard({
    apiBaseUrl: 'http://local.test/api',
    contractId: 'emaid-1',
    sessionId: 'session-1',
    providerId: 'provider-1',
    sessionStatus: 'PLUGGED_IN',
    hideAfterSpend: false,
    onReservationSuccess: value => reservations.push(value.id),
    onSpendError: error => spendErrors.push(error),
  });
  let form = renderer.root.findByType('form');
  await act(async () => {
    await form.props.onSubmit({ preventDefault() {} });
  });

  assert.equal(approvalSendCalls, 1, 'the first reservation signs one approval');
  assert.equal(approvalIntents.length, 1);
  assert.equal(spendErrors.length, 1);
  assert.equal(spendErrors[0].pending, true);
  assert.equal(spendErrors[0].requiresReview, true);

  form = renderer.root.findByType('form');
  await act(async () => {
    await form.props.onSubmit({ preventDefault() {} });
  });

  assert.deepEqual(reservations, ['custodial-retried']);
  assert.equal(approvalSendCalls, 1, 'same-intent retry reuses the confirmed approval hash');
  assert.equal(approvalIntents.length, 1, 'same-intent retry does not request another approval intent');
  assert.equal(spendRequests.length, 2);
  assert.equal(spendRequests[0].authorizationTxHash, approvalHash);
  assert.deepEqual(spendRequests[1], spendRequests[0], 'same-intent retry preserves the original approval evidence');
});

test('claims one custodial approval before a deferred wallet response and preserves its hash across a stale owner', async () => {
  const approvalHash = `0x${'c'.repeat(64)}`;
  const walletAddress = '0x0000000000000000000000000000000000000001';
  const pendingWalletResponse = deferred();
  const approvalIntents = [];
  const reservations = [];
  let approvalSendCalls = 0;
  let spendCalls = 0;
  let current = {
    apiBaseUrl: 'http://local.test/api',
    contractId: 'emaid-1',
    sessionId: 'session-1',
    providerId: 'provider-1',
    walletAddress,
  };

  globalThis.window = {
    ethereum: {
      request: async ({ method, params = [] }) => {
        if (method === 'eth_sendTransaction') {
          approvalSendCalls += 1;
          return pendingWalletResponse.promise;
        }
        if (method === 'eth_chainId') return '0x13882';
        if (method === 'eth_blockNumber') return '0x10';
        if (method === 'eth_getTransactionReceipt') return approvalReceipt(params[0], walletAddress);
        throw new Error(`Unexpected wallet RPC ${method}`);
      },
    },
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    if (path.endsWith('/wallet/me')) {
      return response({ ...wallet(current.contractId, 'custodial'), walletAddress: current.walletAddress, managedWalletAddress: current.walletAddress });
    }
    if (path.endsWith('/spend/session')) return response(session(current.contractId, current.sessionId, current.providerId));
    if (path.endsWith('/spend/reservation-approval-intent')) {
      approvalIntents.push(JSON.parse(init.body || '{}'));
      return response({
        status: 'requires_signature',
        walletAddress: current.walletAddress,
        requiredAllowance: '1.00',
        transaction: {
          from: current.walletAddress,
          to: '0x0000000000000000000000000000000000000002',
          value: '0x0',
          data: '0x',
        },
      });
    }
    if (path.endsWith('/spend/me')) {
      spendCalls += 1;
      return response({
        status: 'success',
        reservation: { id: 'stale-boundary-reservation', status: 'reserved', amount: '1.00', kWhEntitlement: '1.00', availableBalance: 9 },
      });
    }
    if (path.endsWith('/spend/reservations/stale-boundary-reservation')) return response(settlement({ reservationId: 'stale-boundary-reservation', status: 'settling', txHash: null, spendReceipt: null, receiptStatus: 'pending' }));
    throw new Error(`Unexpected request ${path}`);
  };

  const renderer = await renderCard({
    ...current,
    sessionStatus: 'PLUGGED_IN',
    hideAfterSpend: false,
    onReservationSuccess: value => reservations.push(value.id),
  });
  const form = renderer.root.findByType('form');
  let firstSubmit;
  await act(async () => {
    firstSubmit = form.props.onSubmit({ preventDefault() {} });
    await flush();
  });
  assert.equal(approvalSendCalls, 1, 'the first submission reaches the wallet once');
  assert.equal(approvalIntents.length, 1);

  let concurrentSubmit;
  await act(async () => {
    concurrentSubmit = renderer.root.findByType('form').props.onSubmit({ preventDefault() {} });
    await Promise.resolve();
  });
  assert.equal(approvalSendCalls, 1, 'a concurrent same-intent submit awaits the claimed approval');
  assert.equal(approvalIntents.length, 1, 'a concurrent same-intent submit does not fetch a second approval intent');

  await updateCard(renderer, {
    apiBaseUrl: 'http://local.test/api',
    contractId: 'emaid-2',
    sessionId: undefined,
    providerId: undefined,
    sessionStatus: 'UNPLUGGED',
  });
  await act(async () => {
    pendingWalletResponse.resolve(approvalHash);
    await Promise.all([firstSubmit, concurrentSubmit]);
  });
  assert.equal(approvalSendCalls, 1, 'the accepted hash survives the stale owner transition');
  assert.equal(spendCalls, 0, 'stale submissions do not create a reservation under the new owner');

  current = {
    apiBaseUrl: 'http://local.test/api',
    contractId: 'emaid-1',
    sessionId: 'session-1',
    providerId: 'provider-1',
    walletAddress,
  };
  await updateCard(renderer, {
    ...current,
    sessionStatus: 'PLUGGED_IN',
    hideAfterSpend: false,
    onReservationSuccess: value => reservations.push(value.id),
  });
  await act(async () => {
    await renderer.root.findByType('form').props.onSubmit({ preventDefault() {} });
  });
  assert.equal(approvalSendCalls, 1, 'returning to the original intent reuses the saved hash');
  assert.equal(approvalIntents.length, 1);
  assert.equal(spendCalls, 1);
  assert.deepEqual(reservations, ['stale-boundary-reservation']);
});

test('fails closed after an unknown custodial approval response instead of signing again', async () => {
  const walletAddress = '0x0000000000000000000000000000000000000001';
  const approvalIntents = [];
  const spendRequests = [];
  const spendErrors = [];
  let approvalSendCalls = 0;

  globalThis.window = {
    ethereum: {
      request: async ({ method }) => {
        if (method === 'eth_sendTransaction') {
          approvalSendCalls += 1;
          throw new Error('wallet response lost after approval submission');
        }
        return '0x13882';
      },
    },
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    if (path.endsWith('/wallet/me')) {
      return response({ ...wallet('emaid-1', 'custodial'), walletAddress, managedWalletAddress: walletAddress });
    }
    if (path.endsWith('/spend/session')) return response(session('emaid-1', 'session-1', 'provider-1'));
    if (path.endsWith('/spend/reservation-approval-intent')) {
      approvalIntents.push(JSON.parse(init.body || '{}'));
      return response({
        status: 'requires_signature',
        walletAddress,
        requiredAllowance: '1.00',
        transaction: {
          from: walletAddress,
          to: '0x0000000000000000000000000000000000000002',
          value: '0x0',
          data: '0x',
        },
      });
    }
    if (path.endsWith('/spend/me')) {
      spendRequests.push(JSON.parse(init.body || '{}'));
      return response({ status: 'success', reservation: { id: 'unexpected', status: 'reserved', amount: '1.00', kWhEntitlement: '1.00', availableBalance: 9 } });
    }
    throw new Error(`Unexpected request ${path}`);
  };

  const renderer = await renderCard({
    apiBaseUrl: 'http://local.test/api',
    contractId: 'emaid-1',
    sessionId: 'session-1',
    providerId: 'provider-1',
    sessionStatus: 'PLUGGED_IN',
    hideAfterSpend: false,
    onSpendError: error => spendErrors.push(error),
  });
  let form = renderer.root.findByType('form');
  await act(async () => {
    await form.props.onSubmit({ preventDefault() {} });
  });
  form = renderer.root.findByType('form');
  await act(async () => {
    await form.props.onSubmit({ preventDefault() {} });
  });

  assert.equal(approvalIntents.length, 1, 'the unknown approval is not replaced with a second intent');
  assert.equal(approvalSendCalls, 1, 'the wallet is never asked to sign the ambiguous approval twice');
  assert.equal(spendRequests.length, 0, 'the spend is not submitted without confirmed approval evidence');
  assert.equal(spendErrors.length, 2);
  assert.equal(spendErrors[0].code, 'CUSTODIAL_APPROVAL_OUTCOME_UNKNOWN');
  assert.equal(spendErrors[0].requiresReview, true);
  assert.equal(spendErrors[1].code, 'CUSTODIAL_APPROVAL_OUTCOME_UNKNOWN');
});

test('keeps an explicit wallet rejection retryable without treating it as an unknown approval', async () => {
  const approvalHash = `0x${'d'.repeat(64)}`;
  const walletAddress = '0x0000000000000000000000000000000000000001';
  const approvalIntents = [];
  const spendRequests = [];
  const spendErrors = [];
  let approvalSendCalls = 0;
  globalThis.window = {
    ethereum: {
      request: async ({ method, params = [] }) => {
        if (method === 'eth_sendTransaction') {
          approvalSendCalls += 1;
          if (approvalSendCalls === 1) {
            throw Object.assign(new Error('User rejected the request.'), { code: 4001, name: 'UserRejectedRequestError' });
          }
          return approvalHash;
        }
        if (method === 'eth_chainId') return '0x13882';
        if (method === 'eth_blockNumber') return '0x10';
        if (method === 'eth_getTransactionReceipt') return approvalReceipt(params[0], walletAddress);
        throw new Error(`Unexpected wallet RPC ${method}`);
      },
    },
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    if (path.endsWith('/wallet/me')) return response({ ...wallet('emaid-1', 'custodial'), walletAddress, managedWalletAddress: walletAddress });
    if (path.endsWith('/spend/session')) return response(session('emaid-1', 'session-1', 'provider-1'));
    if (path.endsWith('/spend/reservation-approval-intent')) {
      approvalIntents.push(JSON.parse(init.body || '{}'));
      return response({
        status: 'requires_signature',
        walletAddress,
        requiredAllowance: '1.00',
        transaction: { from: walletAddress, to: '0x0000000000000000000000000000000000000002', value: '0x0', data: '0x' },
      });
    }
    if (path.endsWith('/spend/me')) {
      spendRequests.push(JSON.parse(init.body || '{}'));
      return response({ status: 'success', reservation: { id: 'rejected-then-retried', status: 'reserved', amount: '1.00', kWhEntitlement: '1.00', availableBalance: 9 } });
    }
    if (path.endsWith('/spend/reservations/rejected-then-retried')) return response(settlement({ reservationId: 'rejected-then-retried', status: 'settling', txHash: null, spendReceipt: null, receiptStatus: 'pending' }));
    throw new Error(`Unexpected request ${path}`);
  };

  const renderer = await renderCard({
    apiBaseUrl: 'http://local.test/api',
    contractId: 'emaid-1',
    sessionId: 'session-1',
    providerId: 'provider-1',
    sessionStatus: 'PLUGGED_IN',
    hideAfterSpend: false,
    onSpendError: error => spendErrors.push(error),
  });
  await act(async () => {
    await renderer.root.findByType('form').props.onSubmit({ preventDefault() {} });
  });
  await act(async () => {
    await renderer.root.findByType('form').props.onSubmit({ preventDefault() {} });
  });

  assert.equal(approvalSendCalls, 2);
  assert.equal(approvalIntents.length, 2);
  assert.equal(spendErrors.length, 1);
  assert.equal(spendErrors[0].code, 4001);
  assert.equal(spendRequests.length, 1);
  assert.equal(spendRequests[0].authorizationTxHash, approvalHash);
});

test('does not reuse custodial approval evidence across owner, endpoint, session, provider, wallet, or amount changes', async () => {
  const firstHash = `0x${'1'.repeat(64)}`;
  const secondHash = `0x${'2'.repeat(64)}`;
  const firstWallet = '0x0000000000000000000000000000000000000001';
  const secondWallet = '0x0000000000000000000000000000000000000002';
  const approvalIntents = [];
  const spendRequests = [];
  let approvalSendCalls = 0;
  let owner = { apiBaseUrl: 'http://local.test/api', contractId: 'emaid-1', sessionId: 'session-1', providerId: 'provider-1', walletAddress: firstWallet };
  let spendCall = 0;

  globalThis.window = {
    ethereum: {
      request: async ({ method, params = [] }) => {
        if (method === 'eth_sendTransaction') {
          approvalSendCalls += 1;
          return approvalSendCalls === 1 ? firstHash : secondHash;
        }
        if (method === 'eth_chainId') return '0x13882';
        if (method === 'eth_blockNumber') return '0x10';
        if (method === 'eth_getTransactionReceipt') {
          const hash = params[0] === firstHash ? firstHash : secondHash;
          return approvalReceipt(hash, hash === firstHash ? firstWallet : secondWallet);
        }
        throw new Error(`Unexpected wallet RPC ${method}`);
      },
    },
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    if (path.endsWith('/wallet/me')) {
      return response({ ...wallet(owner.contractId, 'custodial'), walletAddress: owner.walletAddress, managedWalletAddress: owner.walletAddress });
    }
    if (path.endsWith('/spend/session')) return response(session(owner.contractId, owner.sessionId, owner.providerId));
    if (path.endsWith('/spend/reservation-approval-intent')) {
      approvalIntents.push(JSON.parse(init.body || '{}'));
      return response({
        status: 'requires_signature',
        walletAddress: owner.walletAddress,
        requiredAllowance: '2.00',
        transaction: {
          from: owner.walletAddress,
          to: '0x0000000000000000000000000000000000000003',
          value: '0x0',
          data: '0x',
        },
      });
    }
    if (path.endsWith('/spend/me')) {
      spendRequests.push(JSON.parse(init.body || '{}'));
      spendCall += 1;
      if (spendCall === 1) return response({ status: 'pending', pending: true, message: 'pending' }, 202);
      return response({
        status: 'success',
        reservation: { id: 'boundary-reservation', status: 'reserved', amount: '2.00', kWhEntitlement: '2.00', availableBalance: 8 },
      });
    }
    if (path.endsWith('/spend/reservations/boundary-reservation')) return response(settlement({ reservationId: 'boundary-reservation', status: 'settling', txHash: null, spendReceipt: null, receiptStatus: 'pending' }));
    throw new Error(`Unexpected request ${path}`);
  };

  const initialProps = {
    ...owner,
    sessionStatus: 'PLUGGED_IN',
    hideAfterSpend: false,
  };
  const renderer = await renderCard(initialProps);
  let form = renderer.root.findByType('form');
  await act(async () => {
    await form.props.onSubmit({ preventDefault() {} });
  });
  assert.equal(approvalSendCalls, 1);

  owner = { apiBaseUrl: 'http://other.test/api', contractId: 'emaid-2', sessionId: 'session-2', providerId: 'provider-2', walletAddress: secondWallet };
  await updateCard(renderer, { ...owner, sessionStatus: 'PLUGGED_IN', hideAfterSpend: false });
  const amountInput = renderer.root.findByType('input');
  await act(async () => {
    amountInput.props.onChange({ target: { value: '2' } });
    await flush();
  });
  form = renderer.root.findByType('form');
  await act(async () => {
    await form.props.onSubmit({ preventDefault() {} });
  });

  assert.equal(approvalSendCalls, 2, 'changed intent signs a new approval');
  assert.equal(approvalIntents.length, 2);
  assert.equal(approvalIntents[0].walletAddress, firstWallet);
  assert.equal(approvalIntents[1].walletAddress, secondWallet);
  assert.equal(approvalIntents[0].amount, 1);
  assert.equal(approvalIntents[1].amount, 2);
  assert.equal(spendRequests.length, 2);
  assert.equal(spendRequests[0].authorizationTxHash, firstHash);
  assert.equal(spendRequests[1].authorizationTxHash, secondHash);
});

test('requests a new custodial approval when only the amount changes', async () => {
  const firstHash = `0x${'3'.repeat(64)}`;
  const secondHash = `0x${'4'.repeat(64)}`;
  const walletAddress = '0x0000000000000000000000000000000000000001';
  const approvalIntents = [];
  const spendRequests = [];
  let approvalSendCalls = 0;
  let spendCall = 0;
  globalThis.window = {
    ethereum: {
      request: async ({ method, params = [] }) => {
        if (method === 'eth_sendTransaction') {
          approvalSendCalls += 1;
          return approvalSendCalls === 1 ? firstHash : secondHash;
        }
        if (method === 'eth_chainId') return '0x13882';
        if (method === 'eth_blockNumber') return '0x10';
        if (method === 'eth_getTransactionReceipt') return approvalReceipt(params[0], walletAddress);
        throw new Error(`Unexpected wallet RPC ${method}`);
      },
    },
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    if (path.endsWith('/wallet/me')) return response({ ...wallet('emaid-1', 'custodial'), walletAddress, managedWalletAddress: walletAddress });
    if (path.endsWith('/spend/session')) return response(session('emaid-1', 'session-1', 'provider-1'));
    if (path.endsWith('/spend/reservation-approval-intent')) {
      approvalIntents.push(JSON.parse(init.body || '{}'));
      return response({
        status: 'requires_signature',
        walletAddress,
        requiredAllowance: '2.00',
        transaction: { from: walletAddress, to: '0x0000000000000000000000000000000000000002', value: '0x0', data: '0x' },
      });
    }
    if (path.endsWith('/spend/me')) {
      spendRequests.push(JSON.parse(init.body || '{}'));
      spendCall += 1;
      return spendCall === 1
        ? response({ status: 'pending', pending: true, message: 'pending amount' }, 202)
        : response({ status: 'success', reservation: { id: 'amount-boundary', status: 'reserved', amount: '2.00', kWhEntitlement: '2.00', availableBalance: 8 } });
    }
    if (path.endsWith('/spend/reservations/amount-boundary')) return response(settlement({ reservationId: 'amount-boundary', status: 'settling', txHash: null, spendReceipt: null, receiptStatus: 'pending' }));
    throw new Error(`Unexpected request ${path}`);
  };

  const renderer = await renderCard({
    apiBaseUrl: 'http://local.test/api',
    contractId: 'emaid-1',
    sessionId: 'session-1',
    providerId: 'provider-1',
    sessionStatus: 'PLUGGED_IN',
    hideAfterSpend: false,
  });
  await act(async () => {
    await renderer.root.findByType('form').props.onSubmit({ preventDefault() {} });
  });
  const amountInput = renderer.root.findByType('input');
  await act(async () => {
    amountInput.props.onChange({ target: { value: '2' } });
  });
  await act(async () => {
    await renderer.root.findByType('form').props.onSubmit({ preventDefault() {} });
  });

  assert.equal(approvalSendCalls, 2);
  assert.equal(approvalIntents.length, 2);
  assert.equal(approvalIntents[0].amount, 1);
  assert.equal(approvalIntents[1].amount, 2);
  assert.equal(spendRequests[0].authorizationTxHash, firstHash);
  assert.equal(spendRequests[1].authorizationTxHash, secondHash);
});

test('requests a new custodial approval when only the session and provider change', async () => {
  const firstHash = `0x${'5'.repeat(64)}`;
  const secondHash = `0x${'6'.repeat(64)}`;
  const walletAddress = '0x0000000000000000000000000000000000000001';
  const approvalIntents = [];
  const spendRequests = [];
  let approvalSendCalls = 0;
  let spendCall = 0;
  let activeSession = { sessionId: 'session-1', providerId: 'provider-1' };
  globalThis.window = {
    ethereum: {
      request: async ({ method, params = [] }) => {
        if (method === 'eth_sendTransaction') {
          approvalSendCalls += 1;
          return approvalSendCalls === 1 ? firstHash : secondHash;
        }
        if (method === 'eth_chainId') return '0x13882';
        if (method === 'eth_blockNumber') return '0x10';
        if (method === 'eth_getTransactionReceipt') return approvalReceipt(params[0], walletAddress);
        throw new Error(`Unexpected wallet RPC ${method}`);
      },
    },
  };
  globalThis.fetch = async (url, init = {}) => {
    const path = String(url);
    if (path.endsWith('/wallet/me')) return response({ ...wallet('emaid-1', 'custodial'), walletAddress, managedWalletAddress: walletAddress });
    if (path.endsWith('/spend/session')) return response(session('emaid-1', activeSession.sessionId, activeSession.providerId));
    if (path.endsWith('/spend/reservation-approval-intent')) {
      approvalIntents.push(JSON.parse(init.body || '{}'));
      return response({
        status: 'requires_signature',
        walletAddress,
        requiredAllowance: '1.00',
        transaction: { from: walletAddress, to: '0x0000000000000000000000000000000000000002', value: '0x0', data: '0x' },
      });
    }
    if (path.endsWith('/spend/me')) {
      spendRequests.push(JSON.parse(init.body || '{}'));
      spendCall += 1;
      return spendCall === 1
        ? response({ status: 'pending', pending: true, message: 'pending session' }, 202)
        : response({ status: 'success', reservation: { id: 'session-boundary', status: 'reserved', amount: '1.00', kWhEntitlement: '1.00', availableBalance: 9 } });
    }
    if (path.endsWith('/spend/reservations/session-boundary')) return response(settlement({ reservationId: 'session-boundary', status: 'settling', txHash: null, spendReceipt: null, receiptStatus: 'pending' }));
    throw new Error(`Unexpected request ${path}`);
  };

  const baseProps = {
    apiBaseUrl: 'http://local.test/api',
    contractId: 'emaid-1',
    sessionId: 'session-1',
    providerId: 'provider-1',
    sessionStatus: 'PLUGGED_IN',
    hideAfterSpend: false,
  };
  const renderer = await renderCard(baseProps);
  await act(async () => {
    await renderer.root.findByType('form').props.onSubmit({ preventDefault() {} });
  });
  activeSession = { sessionId: 'session-2', providerId: 'provider-2' };
  await updateCard(renderer, { ...baseProps, ...activeSession });
  await act(async () => {
    await renderer.root.findByType('form').props.onSubmit({ preventDefault() {} });
  });

  assert.equal(approvalSendCalls, 2);
  assert.equal(approvalIntents.length, 2);
  assert.equal(spendRequests[0].sessionId, 'session-1');
  assert.equal(spendRequests[0].providerId, 'provider-1');
  assert.equal(spendRequests[1].sessionId, 'session-2');
  assert.equal(spendRequests[1].providerId, 'provider-2');
  assert.equal(spendRequests[0].authorizationTxHash, firstHash);
  assert.equal(spendRequests[1].authorizationTxHash, secondHash);
});
