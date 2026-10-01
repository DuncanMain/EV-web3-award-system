/*
 * Verifies the local Sparkz demo's server-side proxy boundary.
 *
 * The upstream is an in-memory local fixture. It records only the two headers
 * needed to prove that the browser cannot choose the API key or owning eMAID.
 * No real API, database, chain, or external provider is contacted.
 */
'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { spawn } = require('node:child_process');

const APP_ROOT = path.resolve(__dirname, '..');
const PACKAGE_ROOT = path.join(APP_ROOT, 'packages', 'sparkz-charging-card');
const TEST_API_KEY = 'local-demo-proxy-test-key';
const TEST_EMAID = 'local-demo-proxy-emaid';
const DEMO_SESSION_ID = 'spend-001';
const DEMO_PROVIDER_ID = 'NF';

async function freePort() {
  const server = netServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : undefined;
  await new Promise(resolve => server.close(resolve));
  if (!port) throw new Error('could not allocate a local test port');
  return port;
}

function netServer() {
  return http.createServer();
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('error', reject);
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
}

async function startUpstream() {
  const headersSeen = [];
  let reservationPollCount = 0;
  const server = http.createServer(async (request, response) => {
    await readBody(request);
    headersSeen.push({
      apiKey: request.headers['x-api-key'] || null,
      contractId: request.headers['x-contract-id'] || null,
      authorization: request.headers.authorization || null,
      ingestApiKey: request.headers['x-ingest-api-key'] || null,
      cookie: request.headers.cookie || null,
      path: request.url,
    });
    response.writeHead(200, { 'content-type': 'application/json' });
    if (request.url === '/wallet/me') {
      response.end(JSON.stringify({
        status: 'success',
        uid: TEST_EMAID,
        walletMode: 'managed',
        walletAddress: '0x0000000000000000000000000000000000000001',
        isRegistered: true,
        balance: '10.00',
        totalAwarded: '10.00',
        totalSpent: '0.00',
        history: [],
      }));
      return;
    }
    if (request.url === '/spend/session') {
      response.end(JSON.stringify({
        status: 'success',
        contractId: TEST_EMAID,
        sessionId: DEMO_SESSION_ID,
        providerId: DEMO_PROVIDER_ID,
        chargerId: 'demo-charger',
        sessionStatus: 'PLUGGED_IN',
        wallet: { availableBalance: 10, totalEarned: 10, totalSpent: 0, mode: 'managed' },
        spend: { eligible: true, maxSpendable: 5, suggestedAmount: 1, label: 'Charging discount', message: 'Apply a charging discount' },
        recentActivity: [],
        rewardRates: [],
      }));
      return;
    }
    if (request.url === '/spend/me') {
      response.end(JSON.stringify({
        status: 'reserved',
        reservation: {
          id: 'demo-reservation-1',
          status: 'reserved',
          contractId: TEST_EMAID,
          sessionId: DEMO_SESSION_ID,
          providerId: DEMO_PROVIDER_ID,
          reservedSparkz: '1.00',
          settledSparkz: '0.00',
          releasedSparkz: '0.00',
          receiptStatus: 'not_created',
        },
      }));
      return;
    }
    if (request.url === '/spend/reservations/demo-reservation-1') {
      reservationPollCount += 1;
      const pendingReceipt = reservationPollCount < 2;
      response.end(JSON.stringify({
        status: 'settled',
        reservationId: 'demo-reservation-1',
        contractId: TEST_EMAID,
        sessionId: DEMO_SESSION_ID,
        providerId: DEMO_PROVIDER_ID,
        reservedSparkz: '1.00',
        settledSparkz: '1.00',
        releasedSparkz: '0.00',
        deliveredKwh: '1.00',
        freeKwh: '1.00',
        txHash: '0x' + 'a'.repeat(64),
        receiptStatus: pendingReceipt ? 'pending' : 'settled',
        spendReceipt: pendingReceipt ? null : {
          payload: {
            receiptId: 'demo-receipt-1',
            status: 'settled',
            contractId: TEST_EMAID,
            walletAddress: '0x0000000000000000000000000000000000000001',
            amount: '1.00',
            tokenTxHash: '0x' + 'a'.repeat(64),
            tokenContractAddress: '0x0000000000000000000000000000000000000002',
            chainId: 31337,
            issuedAt: '2026-09-30T00:00:00.000Z',
          },
          signature: 'demo-signature',
          signerAddress: '0x0000000000000000000000000000000000000003',
          canonicalPayload: '{}',
        },
      }));
      return;
    }
    response.end(JSON.stringify({ status: 'ok' }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : undefined;
  if (!port) throw new Error('upstream fixture did not expose a port');
  return { server, port, headersSeen };
}

function startVite(port, apiOrigin, options = {}) {
  const vite = spawn(process.execPath, [
    path.join(PACKAGE_ROOT, 'node_modules', 'vite', 'bin', 'vite.js'),
    '--host', '127.0.0.1', '--port', String(port),
  ], {
    cwd: PACKAGE_ROOT,
    env: {
      ...process.env,
      NVF_DEMO_API_ORIGIN: apiOrigin,
      NVF_DEMO_API_KEY: options.apiKey ?? TEST_API_KEY,
      NVF_DEMO_EMAID: options.emaid ?? TEST_EMAID,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let output = '';
  vite.stdout.on('data', chunk => { output += chunk.toString(); });
  vite.stderr.on('data', chunk => { output += chunk.toString(); });
  vite.__output = () => output.slice(-12000);
  return vite;
}

async function waitFor(url, process) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) throw new Error(`Vite exited ${process.exitCode}: ${process.__output()}`);
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch { /* Vite is still starting. */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${url}: ${process.__output()}`);
}

async function stopProcess(process) {
  if (!process || process.exitCode !== null) return;
  process.kill();
  await new Promise(resolve => {
    process.once('exit', resolve);
    setTimeout(resolve, 3000);
  });
}

async function waitForExit(process, timeoutMs = 10000) {
  if (process.exitCode !== null) return process.exitCode;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for process exit: ${process.__output()}`)), timeoutMs);
    process.once('exit', code => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

async function main() {
  const upstream = await startUpstream();
  const vitePort = await freePort();
  const vite = startVite(vitePort, `http://127.0.0.1:${upstream.port}`);
  try {
    const root = await waitFor(`http://127.0.0.1:${vitePort}/`, vite);
    assert.match(await root.text(), /sparkz|root/i, 'demo HTML served');

    // This request represents the browser component. It deliberately sends a
    // different contract header and no secret; the proxy must replace it.
    const wallet = await fetch(`http://127.0.0.1:${vitePort}/api/sparkz/wallet/me`, {
      headers: {
        'x-contract-id': 'browser-selected-identity',
        'x-api-key': 'browser-selected-api-key',
        'x-ingest-api-key': 'browser-selected-ingest-key',
        authorization: 'Bearer browser-selected-token',
        cookie: 'browser-selected-cookie',
      },
    });
    assert.equal(wallet.status, 200);
    const walletData = await wallet.json();
    assert.equal(walletData.uid, TEST_EMAID);
    assert.deepEqual(upstream.headersSeen.at(-1), {
      apiKey: TEST_API_KEY,
      contractId: TEST_EMAID,
      authorization: null,
      ingestApiKey: null,
      cookie: null,
      path: '/wallet/me',
    });

    const session = await fetch(`http://127.0.0.1:${vitePort}/api/sparkz/spend/session`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-contract-id': 'another-browser-identity',
        'x-api-key': 'another-browser-key',
        authorization: 'Bearer another-browser-token',
      },
      body: JSON.stringify({ sessionId: DEMO_SESSION_ID, providerId: DEMO_PROVIDER_ID, status: 'PLUGGED_IN' }),
    });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).contractId, TEST_EMAID);
    assert.deepEqual(upstream.headersSeen.at(-1), {
      apiKey: TEST_API_KEY,
      contractId: TEST_EMAID,
      authorization: null,
      ingestApiKey: null,
      cookie: null,
      path: '/spend/session',
    });

    for (const route of [
      `/api/sparkz/wallet/${encodeURIComponent(TEST_EMAID)}/mode`,
      `/api/sparkz/wallet/${encodeURIComponent(TEST_EMAID)}/linked-wallets`,
    ]) {
      const ownWalletMutation = await fetch(`http://127.0.0.1:${vitePort}${route}`, {
        method: 'POST',
        headers: {
          'x-contract-id': 'browser-selected-identity',
          'x-api-key': 'browser-selected-api-key',
          authorization: 'Bearer browser-selected-token',
          'content-type': 'application/json',
        },
        body: '{}',
      });
      assert.equal(ownWalletMutation.status, 200, `configured owner route is allowed: ${route}`);
      assert.deepEqual(upstream.headersSeen.at(-1), {
        apiKey: TEST_API_KEY,
        contractId: TEST_EMAID,
        authorization: null,
        ingestApiKey: null,
        cookie: null,
        path: new URL(route, 'http://127.0.0.1').pathname.replace('/api/sparkz', ''),
      });
    }

    const upstreamRequestCount = upstream.headersSeen.length;
    for (const route of [
      '/api/sparkz/admin/readiness',
      '/api/sparkz/ingest/cdr',
      '/api/sparkz/wallet/me/mode',
      '/api/sparkz/wallet/other-emaid/mode',
      '/api/sparkz/wallet/other-emaid/linked-wallets',
    ]) {
      const denied = await fetch(`http://127.0.0.1:${vitePort}${route}`, {
        method: route.endsWith('/readiness') ? 'GET' : 'POST',
        headers: {
          'x-api-key': 'browser-selected-api-key',
          'x-ingest-api-key': 'browser-selected-ingest-key',
          authorization: 'Bearer browser-selected-token',
          'content-type': 'application/json',
        },
        body: route.endsWith('/readiness') ? undefined : '{}',
      });
      assert.equal(denied.status, 404, `route is denied by the demo allowlist: ${route}`);
    }
    assert.equal(upstream.headersSeen.length, upstreamRequestCount, 'denied routes never reach the upstream');

    const demoConfig = await fetch(`http://127.0.0.1:${vitePort}/api/sparkz/demo-config`, {
      headers: { 'x-api-key': 'browser-selected-api-key', 'x-contract-id': 'browser-selected-identity' },
    });
    assert.equal(demoConfig.status, 200);
    assert.deepEqual(await demoConfig.json(), { emaid: TEST_EMAID });
    assert.equal(upstream.headersSeen.length, upstreamRequestCount, 'demo identity config never reaches the upstream');

    const source = await fetch(`http://127.0.0.1:${vitePort}/src/demo.tsx`);
    const sourceText = await source.text();
    assert.equal(source.status, 200);
    assert.equal(sourceText.includes(TEST_API_KEY), false, 'proxy key is absent from browser source');
    assert.equal(sourceText.includes('/api/sparkz/demo-config'), true, 'demo loads public eMAID from the safe config endpoint');

    await stopProcess(vite);
    const missingConfigPort = await freePort();
    const missingConfigVite = startVite(missingConfigPort, `http://127.0.0.1:${upstream.port}`, { apiKey: '', emaid: '' });
    try {
      await waitFor(`http://127.0.0.1:${missingConfigPort}/`, missingConfigVite);
      const missingConfig = await fetch(`http://127.0.0.1:${missingConfigPort}/api/sparkz/wallet/me`, {
        headers: { 'x-api-key': 'caller-key', 'x-contract-id': 'caller-emaid' },
      });
      assert.equal(missingConfig.status, 503, 'missing proxy configuration is rejected');
      const missingConfigIdentity = await fetch(`http://127.0.0.1:${missingConfigPort}/api/sparkz/demo-config`, {
        headers: { 'x-api-key': 'caller-key', 'x-contract-id': 'caller-emaid' },
      });
      assert.equal(missingConfigIdentity.status, 503, 'missing demo identity configuration is rejected');
      assert.equal(upstream.headersSeen.length, upstreamRequestCount, 'missing configuration never forwards caller credentials');
    } finally {
      await stopProcess(missingConfigVite);
    }

    const unsafePort = await freePort();
    const unsafeVite = startVite(unsafePort, 'https://example.invalid');
    try {
      const unsafeExitCode = await waitForExit(unsafeVite);
      assert.notEqual(unsafeExitCode, 0, 'non-loopback proxy targets are rejected');
    } finally {
      await stopProcess(unsafeVite);
    }

    console.log(JSON.stringify({
      status: 'passed',
      demoOrigin: `http://127.0.0.1:${vitePort}`,
      upstreamPath: '/api/sparkz',
      serverBoundEmaid: TEST_EMAID,
      browserSourceContainsApiKey: false,
      demoIdentityEndpointVerified: true,
      requestsVerified: 2,
      deniedRoutesVerified: 5,
      missingConfigurationRejected: true,
      nonLoopbackOriginRejected: true,
    }, null, 2));
    if (process.argv.includes('--keep')) {
      console.log('fixture_ready=true; press Ctrl+C after browser verification');
      await new Promise(resolve => process.once('SIGINT', resolve));
    }
  } finally {
    await stopProcess(vite);
    await new Promise(resolve => upstream.server.close(resolve));
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'failed', error: error.message || String(error) }, null, 2));
  process.exitCode = 1;
});
