/*
 * Full local acceptance flow for the award/reservation/spend recovery path.
 *
 * This harness owns only the child processes it starts: one disposable
 * PostgreSQL container, one local Hardhat node, and one compiled API process.
 * It refuses non-local database targets and never reads the contract project's
 * Amoy configuration.  Run only against synthetic identities and the local
 * NVF artifact described in docs/local-evm-verification.md.
 */
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');
const { ethers } = require('ethers');

const APP_ROOT = path.resolve(__dirname, '..');
const CONTRACT_ROOT = path.resolve(APP_ROOT, '..', 'NVF-award-contract');
const CONTRACT_ARTIFACT = path.join(CONTRACT_ROOT, 'artifacts', 'contracts', 'NVF.sol', 'NVF.json');
const HARNESS_ID = `${process.pid}_${Date.now().toString(36)}`;
const DB_CONTAINER = `nvf-award-api-check-${HARNESS_ID}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
const DB_NAME = `nvf_award_check_api_${process.pid}`.toLowerCase();
const DB_USER = 'postgres';
const DB_PASSWORD = 'postgres';
const API_KEY = 'local-api-key';
const INGEST_API_KEY = 'local-ingest-key';
const ADMIN_EMAIL = 'local-acceptance@example.invalid';
const ADMIN_PASSWORD = 'local-acceptance-password';
const UID = 'local-api-emaid-001';
const PROVIDER_ID = 'local-provider';
const EVSE_ID = 'DE*LOCAL*1';
const LINKED_UID = 'local-linked-emaid-001';
const LINKED_PROVIDER_ID = 'local-linked-provider';
const LINKED_EVSE_ID = 'DE*LINKED*1';
// Replacement protection uses a separate synthetic eMAID so its additional
// awards do not change the original flow's fixed financial assertions.
const REPLACEMENT_UID = 'local-replacement-emaid-001';
const REPLACEMENT_UID_ALT = 'local-replacement-emaid-002';
const REPLACEMENT_PROVIDER_ID = 'local-replacement-provider';
const REPLACEMENT_PROVIDER_ALT_ID = 'local-replacement-provider-alt';
const REPLACEMENT_EVSE_ID = 'DE*REPLACE*1';
const DERIVATION_SALT = `nvf-local-acceptance-${HARNESS_ID}`;

function requiredPrivateKey(name) {
  const value = process.env[name];
  if (!/^0x[0-9a-fA-F]{64}$/.test(value || '')) {
    throw new Error(`${name} must be supplied as a 32-byte local test key; no key is embedded in this harness`);
  }
  return value;
}

const TREASURY_PRIVATE_KEY = requiredPrivateKey('NVF_LOCAL_TREASURY_PRIVATE_KEY');
const HARDHAT_ACCOUNT_ONE_PRIVATE_KEY = requiredPrivateKey('NVF_LOCAL_HARDHAT_ACCOUNT_ONE_PRIVATE_KEY');

const children = new Set();
const resources = {
  dbPort: undefined,
  hardhatPort: undefined,
  apiPort: undefined,
  databaseUrl: undefined,
  tokenAddress: undefined,
  apiBaseUrl: undefined,
  hardhatConfigPath: undefined,
  hardhatProjectDir: undefined,
  schemaActivation: undefined,
  backupRestore: undefined,
  receiptTrigger: undefined,
  projectionTriggers: [],
  rpcProxy: undefined,
  rpcProxyPort: undefined,
  alertWebhook: undefined,
};

function sleep(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function getFreePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : undefined;
  await new Promise(resolve => server.close(resolve));
  if (!port) throw new Error('could not allocate a local TCP port');
  return port;
}

function tail(value, limit = 12000) {
  const text = String(value || '');
  return text.length > limit ? text.slice(-limit) : text;
}

function spawnSpec(command, args) {
  // Windows cannot spawn a .cmd shim with shell:false.  Node's shell wrapper
  // is used only for repository-local shims; quote the generated executable
  // and any path-like argument that contains spaces.
  if (process.platform === 'win32' && /\.cmd$/i.test(command)) {
    const quote = value => {
      const text = String(value);
      return /[\s&()]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
    };
    return {
      command: quote(command),
      args: args.map(quote),
      shell: true,
    };
  }
  return { command, args, shell: false };
}

function startProcess(command, args, options = {}) {
  const spec = spawnSpec(command, args);
  const child = spawn(spec.command, spec.args, {
    cwd: options.cwd || APP_ROOT,
    env: options.env || process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: spec.shell,
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk.toString(); });
  child.stderr.on('data', chunk => { stderr += chunk.toString(); });
  child.__output = () => ({ stdout: tail(stdout), stderr: tail(stderr) });
  child.__command = `${spec.command} ${spec.args.join(' ')}`;
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = startProcess(command, args, options);
    let settled = false;
    const timeoutMs = options.timeoutMs || 120000;
    const timeout = setTimeout(() => {
      hardStopProcess(child)
        .catch(() => undefined)
        .finally(() => {
          if (!settled) {
            settled = true;
            reject(new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms`));
          }
        });
    }, timeoutMs);
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      const output = child.__output();
      if (code === 0) {
        resolve({ code, signal, ...output });
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited ${code ?? signal}\n${output.stderr}\n${output.stdout}`));
      }
    });
  });
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    sleep(3000),
  ]);
  if (child.exitCode === null && process.platform === 'win32' && child.pid) {
    await runCommand('taskkill', ['/PID', String(child.pid), '/T', '/F']).catch(() => undefined);
  }
}

/** Force a child boundary for the crash-window scenarios. */
async function hardStopProcess(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    await runCommand('taskkill', ['/PID', String(child.pid), '/T', '/F']).catch(error => {
      throw new Error(`failed to terminate child process ${child.pid}: ${error.message}`);
    });
  } else {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  const exited = await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    sleep(5000).then(() => false),
  ]);
  if (exited === false && child.exitCode === null) {
    throw new Error(`child process ${child.pid || '<unknown>'} did not exit after hard stop`);
  }
}

async function waitFor(label, check, timeout = 60000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(300);
  }
  throw new Error(`${label} did not become ready within ${timeout}ms${lastError ? `: ${lastError.message || lastError}` : ''}`);
}

async function startDatabase() {
  resources.dbPort = await getFreePort();
  resources.databaseUrl = `postgres://${DB_USER}:${DB_PASSWORD}@127.0.0.1:${resources.dbPort}/${DB_NAME}`;
  await runCommand('docker', [
    'run', '--rm', '--name', DB_CONTAINER, '-d',
    '-e', `POSTGRES_USER=${DB_USER}`,
    '-e', `POSTGRES_PASSWORD=${DB_PASSWORD}`,
    '-e', `POSTGRES_DB=${DB_NAME}`,
    '-p', `127.0.0.1:${resources.dbPort}:5432`,
    'postgres:16-alpine',
  ], { timeoutMs: 60000 });
  await waitFor('disposable PostgreSQL', async () => {
    const pool = new Pool({ connectionString: resources.databaseUrl, max: 1, connectionTimeoutMillis: 2000 });
    try {
      await pool.query('select 1');
      return true;
    } finally {
      await pool.end();
    }
  }, 90000);

  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  await runCommand(npmCommand, ['run', 'db:migrate'], {
    cwd: APP_ROOT,
    env: { ...process.env, DATABASE_URL: resources.databaseUrl },
    timeoutMs: 120000,
  });

  const schemaPool = new Pool({ connectionString: resources.databaseUrl, max: 1, connectionTimeoutMillis: 3000 });
  try {
    resources.schemaActivation = await verifyFreshSchemaActivation(schemaPool);
  } finally {
    await schemaPool.end();
  }
}

async function verifyFreshSchemaActivation(pool) {
  const column = await pool.query(`
    select 1
    from information_schema.columns
    where table_schema = current_schema()
      and table_name = 'token_operations'
      and column_name = 'charging_session_id'
  `);
  assert.equal(column.rows.length, 1, 'fresh migrations create token_operations.charging_session_id');
  const index = await pool.query(`
    select ix.indisunique, ix.indisvalid, ix.indisready,
           pg_get_indexdef(ix.indexrelid) as definition,
           pg_get_expr(ix.indpred, ix.indrelid) as predicate
    from pg_class idx
    join pg_index ix on ix.indexrelid = idx.oid
    where ix.indrelid = to_regclass('token_operations')::oid
      and idx.relname = 'token_operations_award_provider_charging_session_unique'
  `);
  assert.equal(index.rows.length, 1, 'fresh migrations create the charging-session guard index');
  const row = index.rows[0];
  assert.equal(row.indisunique, true, 'fresh charging-session guard is unique');
  assert.equal(row.indisvalid, true, 'fresh charging-session guard is valid');
  assert.equal(row.indisready, true, 'fresh charging-session guard is ready');
  const definition = String(row.definition || '').toLowerCase();
  const predicate = String(row.predicate || '').toLowerCase();
  const normalizedPredicate = predicate.replace(/::[a-z_][a-z0-9_ ]*/g, '').replace(/[()\s]/g, '');
  assert.ok(definition.includes('(provider_id, charging_session_id)'), `fresh guard columns: ${definition}`);
  assert.ok(normalizedPredicate.includes("operation_type='award'"), `fresh guard predicate: ${predicate}`);
  assert.ok(normalizedPredicate.includes('provider_idisnotnull'), `fresh guard provider predicate: ${predicate}`);
  assert.ok(normalizedPredicate.includes('charging_session_idisnotnull'), `fresh guard session predicate: ${predicate}`);
  return {
    status: 'passed',
    migration: '017',
    column: 'token_operations.charging_session_id',
    index: 'token_operations_award_provider_charging_session_unique',
    enforcing: true,
  };
}

async function startHardhat() {
  if (!fs.existsSync(CONTRACT_ARTIFACT)) {
    throw new Error(`local NVF artifact is missing: ${CONTRACT_ARTIFACT}`);
  }
  const hardhatShim = path.join(
    CONTRACT_ROOT,
    'node_modules', '.bin',
    process.platform === 'win32' ? 'hardhat.cmd' : 'hardhat',
  );
  const hardhatCli = path.join(CONTRACT_ROOT, 'node_modules', 'hardhat', 'dist', 'src', 'cli.js');
  if (!fs.existsSync(hardhatShim) && !fs.existsSync(hardhatCli)) {
    throw new Error(`local Hardhat executable is missing: ${hardhatShim}`);
  }

  resources.hardhatPort = await getFreePort();
  // Keep all generated files inside this checkout.  The sibling contract
  // checkout is read-only input for this harness, including its artifact and
  // node_modules.  The config resolves Hardhat's ESM plugins from that
  // checkout without writing anything beside it.
  resources.hardhatProjectDir = path.join(APP_ROOT, `.codex-hardhat-${HARNESS_ID}`);
  fs.mkdirSync(resources.hardhatProjectDir, { recursive: true });
  resources.hardhatConfigPath = path.join(resources.hardhatProjectDir, 'hardhat.config.ts');
  fs.writeFileSync(path.join(resources.hardhatProjectDir, 'package.json'), JSON.stringify({
    private: true,
    type: 'module',
  }), 'utf8');
  // Deliberately omit dotenv and all HTTP networks. The default Hardhat
  // network serves only the local node started below.
  const contractPackagePath = path.join(CONTRACT_ROOT, 'package.json');
  fs.writeFileSync(resources.hardhatConfigPath, [
    'import { createRequire } from "node:module";',
    `const require = createRequire(${JSON.stringify(contractPackagePath)});`,
    'const { defineConfig } = require("hardhat/config");',
    'const hardhatEthersModule = require("@nomicfoundation/hardhat-ethers");',
    'const hardhatEthers = hardhatEthersModule.default || hardhatEthersModule;',
    'export default defineConfig({ plugins: [hardhatEthers] });',
    '',
  ].join('\n'), 'utf8');

  // Use the sibling checkout's local shim.  Running Hardhat's CLI file
  // directly makes Hardhat classify the process as a non-local installation;
  // the shim supplies the package-manager NODE_PATH while the cwd remains the
  // read-only contract checkout.
  const hardhatCommand = hardhatShim;
  const hardhatArgs = [];
  hardhatArgs.push(
    'node', '--hostname', '127.0.0.1', '--port', String(resources.hardhatPort),
    '--config', resources.hardhatConfigPath,
  );
  const hardhat = startProcess(hardhatCommand, hardhatArgs, {
    cwd: CONTRACT_ROOT,
    env: {
      ...process.env,
      AMOY_RPC_URL: '',
      AMOY_PRIVATE_KEY: '',
      ETHERSCAN_API_KEY: '',
      DOTENV_CONFIG_PATH: '',
    },
  });
  resources.hardhat = hardhat;
  const provider = new ethers.JsonRpcProvider(`http://127.0.0.1:${resources.hardhatPort}`);
  await waitFor('local Hardhat JSON-RPC', async () => {
    const network = await provider.getNetwork();
    return network.chainId === 31337n;
  }, 60000);
  return { provider, hardhat };
}

async function deployToken(provider) {
  const artifact = JSON.parse(fs.readFileSync(CONTRACT_ARTIFACT, 'utf8'));
  const treasurySigner = new ethers.Wallet(TREASURY_PRIVATE_KEY, provider);
  const treasuryAddress = await treasurySigner.getAddress();
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, treasurySigner);
  const token = await factory.deploy(
    'SPARKZ Local Acceptance',
    'SPARKZ',
    treasuryAddress,
    ethers.parseUnits('1000', 18),
  );
  await token.waitForDeployment();
  resources.tokenAddress = await token.getAddress();
  return { artifact, provider, token, treasurySigner, treasuryAddress };
}

function apiEnvironment(apiPort, treasuryAddress, options = {}) {
  return {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(apiPort),
    DATABASE_URL: resources.databaseUrl,
    POLYGON_RPC_URL: options.rpcUrl || `http://127.0.0.1:${resources.hardhatPort}`,
    CHAIN_ID: '31337',
    TOKEN_CONTRACT_ADDRESS: resources.tokenAddress,
    TREASURY_ADDRESS: treasuryAddress,
    TREASURY_SIGNER_KEY: TREASURY_PRIVATE_KEY,
    TREASURY_SIGNER_KEY_FILE: '',
    API_KEY,
    INGEST_API_KEY,
    BEIA_API_KEY: options.beiaApiKey || '',
    USER_IDENTITY_HEADER: 'x-contract-id',
    USER_ADDRESS_DERIVATION_SALT: DERIVATION_SALT,
    ENABLE_TEST_UID_LOOKUP: options.enableTestUidLookup === undefined
      ? 'false'
      : String(Boolean(options.enableTestUidLookup)),
    ADMIN_EMAIL,
    ADMIN_PASSWORD,
    BEIA_ADMIN_EMAIL: '',
    BEIA_ADMIN_PASSWORD: '',
    ADMIN_ALERT_WEBHOOK_URL: options.adminAlertWebhookUrl || '',
    CORS_ORIGIN: 'http://127.0.0.1',
    TREASURY_GAS_WARNING_THRESHOLD_MATIC: '0.0001',
  };
}

async function startAlertWebhook() {
  const state = { deliveries: [] };
  const server = http.createServer((request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { 'content-type': 'text/plain' });
      response.end('POST required');
      return;
    }
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body;
      try { body = JSON.parse(raw); } catch { body = { raw }; }
      state.deliveries.push({ method: request.method, body });
      response.writeHead(204);
      response.end();
    });
    request.on('error', () => response.destroy());
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : undefined;
  if (!port) throw new Error('local admin alert webhook did not expose a port');
  const webhook = {
    server,
    state,
    port,
    url: `http://127.0.0.1:${port}/admin-alert`,
    async close() {
      server.closeAllConnections?.();
      server.closeIdleConnections?.();
      await Promise.race([
        new Promise(resolve => server.close(() => resolve())),
        sleep(3000),
      ]);
      if (resources.alertWebhook === webhook) resources.alertWebhook = undefined;
    },
  };
  resources.alertWebhook = webhook;
  return webhook;
}

async function startApi(treasuryAddress, options = {}) {
  resources.apiPort = await getFreePort();
  resources.apiBaseUrl = `http://127.0.0.1:${resources.apiPort}`;
  const api = startProcess(process.execPath, ['dist/api.js'], {
    cwd: APP_ROOT,
    env: apiEnvironment(resources.apiPort, treasuryAddress, options),
  });
  resources.api = api;
  resources.apiRpcUrl = options.rpcUrl || `http://127.0.0.1:${resources.hardhatPort}`;
  await waitFor('local API health', async () => {
    if (api.exitCode !== null) {
      const output = api.__output();
      throw new Error(`API exited ${api.exitCode}: ${output.stderr || output.stdout}`);
    }
    const response = await fetch(`${resources.apiBaseUrl}/ingest/health`);
    return response.ok;
  }, 60000);
}

async function stopApi(force = false) {
  if (!resources.api) return;
  if (force) await hardStopProcess(resources.api);
  else await stopProcess(resources.api);
  resources.api = undefined;
  resources.apiBaseUrl = undefined;
  resources.apiPort = undefined;
}

async function restartApi(treasuryAddress, options = {}) {
  await stopApi();
  await startApi(treasuryAddress, options);
}

/**
 * Local-only JSON-RPC fault proxy.  It forwards to the disposable Hardhat
 * node and can fail idempotent receipt reads or drop one broadcast response
 * after forwarding the raw transaction.  It is deliberately outside the API
 * process so production code has no fault-injection branch or test flag.
 */
async function startRpcProxy(options = {}) {
  const upstream = options.upstream || `http://127.0.0.1:${resources.hardhatPort}`;
  const state = {
    receiptFailuresRemaining: Number(options.receiptFailuresRemaining || 0),
    dropBroadcastResponsesRemaining: Number(options.dropBroadcastResponsesRemaining || 0),
    holdBroadcastResponsesRemaining: Number(options.holdBroadcastResponsesRemaining || 0),
    heldBroadcastResponse: undefined,
    forwardedBroadcastCount: 0,
    acceptedBroadcastHashes: [],
    forwardedReceiptCount: 0,
    injectedReceiptFailures: 0,
  };

  const server = http.createServer((request, response) => {
    if (request.method !== 'POST') {
      response.writeHead(405, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'POST required' }));
      return;
    }
    const chunks = [];
    request.on('data', chunk => chunks.push(chunk));
    request.on('error', () => response.destroy());
    request.on('end', async () => {
      let payload;
      try {
        payload = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'invalid JSON-RPC body' }));
        return;
      }
      const requests = Array.isArray(payload) ? payload : [payload];
      const methods = requests.map(item => item && item.method).filter(Boolean);
      const isReceiptRead = methods.includes('eth_getTransactionReceipt');
      if (isReceiptRead && state.receiptFailuresRemaining > 0) {
        state.receiptFailuresRemaining -= 1;
        state.injectedReceiptFailures += 1;
        const failed = requests.map(item => ({
          jsonrpc: '2.0',
          id: item && item.id,
          error: { code: 30, message: 'request timeout (local failure-drill receipt read)' },
        }));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(Array.isArray(payload) ? failed : failed[0]));
        return;
      }

      try {
        const upstreamResponse = await fetch(upstream, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const text = await upstreamResponse.text();
        let forwarded;
        try { forwarded = JSON.parse(text); } catch { forwarded = undefined; }
        for (const item of (Array.isArray(forwarded) ? forwarded : [forwarded])) {
          if (item && typeof item.result === 'string' && methods.includes('eth_sendRawTransaction')) {
            state.acceptedBroadcastHashes.push(item.result);
          }
        }
        if (methods.includes('eth_sendRawTransaction')) {
          state.forwardedBroadcastCount += methods.filter(method => method === 'eth_sendRawTransaction').length;
          if (state.holdBroadcastResponsesRemaining > 0) {
            state.holdBroadcastResponsesRemaining -= 1;
            await new Promise(resolve => {
              state.heldBroadcastResponse = {
                release: () => {
                  state.heldBroadcastResponse = undefined;
                  resolve();
                },
              };
            });
          }
          if (state.dropBroadcastResponsesRemaining > 0) {
            state.dropBroadcastResponsesRemaining -= 1;
            const dropped = requests.map(item => ({
              jsonrpc: '2.0',
              id: item && item.id,
              error: { code: -32099, message: 'local failure-drill dropped broadcast response after acceptance' },
            }));
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(JSON.stringify(Array.isArray(payload) ? dropped : dropped[0]));
            return;
          }
        }
        if (isReceiptRead) state.forwardedReceiptCount += 1;
        response.writeHead(upstreamResponse.status, {
          'content-type': upstreamResponse.headers.get('content-type') || 'application/json',
        });
        response.end(text);
      } catch (error) {
        response.destroy(error instanceof Error ? error : undefined);
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : undefined;
  if (!port) throw new Error('local RPC proxy did not expose a port');
  const proxy = {
    server,
    state,
    port,
    url: `http://127.0.0.1:${port}`,
    setReceiptFailures(count) { state.receiptFailuresRemaining = count; },
    disableBroadcastDrop() { state.dropBroadcastResponsesRemaining = 0; },
    releaseHeldBroadcast() {
      state.heldBroadcastResponse?.release();
    },
    async close() {
      state.heldBroadcastResponse?.release();
      server.closeAllConnections?.();
      server.closeIdleConnections?.();
      await Promise.race([
        new Promise(resolve => server.close(() => resolve())),
        sleep(3000),
      ]);
      if (resources.rpcProxy === proxy) resources.rpcProxy = undefined;
      resources.rpcProxyPort = undefined;
    },
  };
  resources.rpcProxy = proxy;
  resources.rpcProxyPort = port;
  return proxy;
}

async function requestJson(route, options = {}) {
  const { apiKey, ingestApiKey, ...requestOptions } = options;
  const headers = {
    'content-type': 'application/json',
    'x-api-key': API_KEY,
    ...(requestOptions.headers || {}),
  };
  if (Object.prototype.hasOwnProperty.call(options, 'apiKey')) {
    if (apiKey === null || apiKey === undefined) delete headers['x-api-key'];
    else headers['x-api-key'] = apiKey;
  }
  if (Object.prototype.hasOwnProperty.call(options, 'ingestApiKey')) {
    if (ingestApiKey === null || ingestApiKey === undefined) delete headers['x-ingest-api-key'];
    else headers['x-ingest-api-key'] = ingestApiKey;
  }
  const response = await fetch(`${resources.apiBaseUrl}${route}`, {
    ...requestOptions,
    headers,
    body: requestOptions.body === undefined ? undefined : JSON.stringify(requestOptions.body),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body };
}

async function requestAdminJson(route, token, options = {}) {
  const headers = {
    'content-type': 'application/json',
    Authorization: `Bearer ${token}`,
    ...(options.headers || {}),
  };
  const response = await fetch(`${resources.apiBaseUrl}${route}`, {
    ...options,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text };
  }
  return { status: response.status, body };
}

async function loginAdmin() {
  const response = await requestJson('/admin/login', {
    method: 'POST',
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  assert.equal(response.status, 200, `local admin login: ${JSON.stringify(response.body)}`);
  assert.equal(response.body?.status, 'ok', `local admin login status: ${JSON.stringify(response.body)}`);
  assert.ok(typeof response.body?.token === 'string' && response.body.token.length > 0, 'local admin login returned a session token');
  return response.body.token;
}

async function recoverSavedOperation(operationKey, token) {
  return requestAdminJson('/admin/operations/recover', token, {
    method: 'POST',
    body: { operationKey },
  });
}

async function postIngestFor(cdr, ingestApiKey = INGEST_API_KEY) {
  return requestJson('/ingest/cdr', {
    method: 'POST',
    headers: { 'x-ingest-api-key': ingestApiKey },
    body: cdr,
  });
}

async function postIngest(cdr) {
  return postIngestFor(cdr);
}

async function postIdentitySpendFor(uid, body) {
  return requestJson('/spend/me', {
    method: 'POST',
    headers: { 'x-contract-id': uid },
    body,
  });
}

async function postIdentitySpend(body) {
  return postIdentitySpendFor(UID, body);
}

async function getIdentityWalletFor(uid) {
  return requestJson('/wallet/me', {
    method: 'GET',
    headers: { 'x-contract-id': uid },
  });
}

async function getIdentityWallet() {
  return getIdentityWalletFor(UID);
}

async function getReservationStatusFor(uid, reservationId) {
  return requestJson(`/spend/reservations/${encodeURIComponent(reservationId)}`, {
    method: 'GET',
    headers: { 'x-contract-id': uid },
  });
}

async function runAuthAndIdentityChecks() {
  const previewCdr = failureDrillCdr('auth-preview-only');
  const missingApiKey = await requestJson(`/wallet/${encodeURIComponent(UID)}`, {
    method: 'GET',
    apiKey: null,
  });
  assert.equal(missingApiKey.status, 401, `wallet lookup without API key: ${JSON.stringify(missingApiKey.body)}`);

  const invalidApiKey = await requestJson(`/wallet/${encodeURIComponent(UID)}`, {
    method: 'GET',
    apiKey: 'invalid-local-api-key',
  });
  assert.equal(invalidApiKey.status, 403, `wallet lookup with invalid API key: ${JSON.stringify(invalidApiKey.body)}`);

  const missingIdentity = await requestJson('/wallet/me', { method: 'GET' });
  assert.equal(missingIdentity.status, 401, `wallet identity header is required: ${JSON.stringify(missingIdentity.body)}`);
  const primaryWallet = assertHttp(await getIdentityWallet(), 200, 'primary identity wallet lookup');
  const alternateWallet = assertHttp(await getIdentityWalletFor(REPLACEMENT_UID), 200, 'alternate identity wallet lookup');
  assert.ok(primaryWallet.walletAddress && alternateWallet.walletAddress);
  assert.notEqual(primaryWallet.walletAddress.toLowerCase(), alternateWallet.walletAddress.toLowerCase(), 'identity context scopes wallets by eMAID');

  const missingIngestKey = await requestJson('/ingest/cdr/preview', {
    method: 'POST',
    apiKey: null,
    ingestApiKey: null,
    body: previewCdr,
  });
  assert.equal(missingIngestKey.status, 401, `preview without ingest key: ${JSON.stringify(missingIngestKey.body)}`);
  const invalidIngestKey = await requestJson('/ingest/cdr/preview', {
    method: 'POST',
    apiKey: null,
    ingestApiKey: 'invalid-local-ingest-key',
    body: previewCdr,
  });
  assert.equal(invalidIngestKey.status, 403, `preview with invalid ingest key: ${JSON.stringify(invalidIngestKey.body)}`);
  const preview = assertHttp(await requestJson('/ingest/cdr/preview', {
    method: 'POST',
    apiKey: null,
    ingestApiKey: INGEST_API_KEY,
    body: previewCdr,
  }), 200, 'authenticated side-effect-free preview');
  assert.equal(preview.sideEffects, false);

  const login = assertHttp(await requestJson('/admin/login', {
    method: 'POST',
    apiKey: null,
    body: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  }), 200, 'admin login without general API key');
  assert.ok(login.token);
  const apiKeyOnlyAdmin = await requestJson('/admin/readiness', { method: 'GET' });
  assert.equal(apiKeyOnlyAdmin.status, 401, `general API key is not an admin bearer session: ${JSON.stringify(apiKeyOnlyAdmin.body)}`);
  const adminRead = assertHttp(await requestAdminJson('/admin/readiness', login.token), 200, 'authenticated admin readiness');
  assert.ok(adminRead.status === 'ready' || adminRead.status === 'ready_with_warnings' || adminRead.status === 'ok' || adminRead.readiness);
  assertHttp(await requestAdminJson('/admin/logout', login.token, { method: 'POST' }), 200, 'admin logout');
  const afterLogout = await requestAdminJson('/admin/readiness', login.token);
  assert.equal(afterLogout.status, 401, `logged-out admin token is rejected: ${JSON.stringify(afterLogout.body)}`);

  return {
    status: 'passed',
    apiKey: { missing: 401, invalid: 403, authenticated: 200 },
    ingestApiKey: { missing: 401, invalid: 403, preview: 200, sideEffects: false },
    identity: { primary: UID, alternate: REPLACEMENT_UID, walletAddressesDiffer: true },
    admin: { login: 200, apiKeyOnly: 401, readiness: 200, logout: 200, afterLogout: 401 },
  };
}

function assertPreviewIdentity(body, expected, label) {
  assert.equal(body.status, 'preview', `${label} status`);
  assert.equal(body.sideEffects, false, `${label} has no settlement side effects`);
  assert.equal(body.normalisation?.eMAID, expected.eMAID, `${label} eMAID`);
  assert.equal(body.normalisation?.emaid, expected.eMAID, `${label} canonical emaid alias`);
  assert.equal(body.normalisation?.protocol, expected.protocol, `${label} detected protocol`);
  assert.equal(body.normalisation?.sourceField, expected.sourceField, `${label} source field`);
  assert.equal(body.normalised?.eMAID, expected.eMAID, `${label} normalised eMAID`);
  if (expected.uid) assert.equal(body.normalisation?.tokenMetadata?.uid, expected.uid, `${label} non-owning UID metadata`);
}

async function runProtocolIdentityMatrix() {
  const eMAID = 'DE*EMP*E123456';
  const commonOicp = {
    ProviderID: 'local-protocol-provider',
    EvseID: 'DE*NVF*IDENTITY01',
    ChargingStart: '2026-07-05T23:00:00.000Z',
    ChargingEnd: '2026-07-06T00:00:00.000Z',
    ConsumedEnergy: '1',
  };
  const accepted = [
    {
      name: 'ocpi_contract_id',
      cdr: {
        id: 'identity-ocpi-1',
        party_id: 'NF',
        cdr_token: { contract_id: eMAID, uid: 'ocpi-token-uid', type: 'RFID' },
        cdr_location: { evse_id: 'DE*NVF*IDENTITY01' },
        start_date_time: commonOicp.ChargingStart,
        end_date_time: commonOicp.ChargingEnd,
        total_energy: 1,
      },
      expected: { eMAID, protocol: 'OCPI', sourceField: 'cdr_token.contract_id', uid: 'ocpi-token-uid' },
    },
    ...[
      ['RemoteIdentification', 'oicp-remote'],
      ['QRCodeIdentification', 'oicp-qr'],
      ['PlugAndChargeIdentification', 'oicp-pnc'],
      ['RFIDIdentification', 'oicp-rfid'],
    ].map(([variant, id]) => ({
      name: `oicp_${variant}`,
      cdr: {
        ...commonOicp,
        SessionID: id,
        Identification: {
          [variant]: {
            EvcoID: eMAID,
            ...(variant === 'RFIDIdentification' ? { UID: 'rfid-wire-uid' } : {}),
          },
        },
      },
      expected: {
        eMAID,
        protocol: 'OICP',
        sourceField: `Identification.${variant}.EvcoID`,
        ...(variant === 'RFIDIdentification' ? { uid: 'rfid-wire-uid' } : {}),
      },
    })),
  ];

  const results = [];
  for (const item of accepted) {
    const response = await requestJson('/ingest/cdr/preview', {
      method: 'POST',
      apiKey: null,
      ingestApiKey: INGEST_API_KEY,
      body: item.cdr,
    });
    const body = assertHttp(response, 200, `${item.name} preview`);
    assertPreviewIdentity(body, item.expected, item.name);
    results.push({
      name: item.name,
      protocol: body.normalisation.protocol,
      sourceField: body.normalisation.sourceField,
      eMAID: body.normalisation.eMAID,
      uidMetadataPresent: Boolean(body.normalisation.tokenMetadata?.uid),
    });
  }

  const uidOnly = await requestJson('/ingest/cdr/preview', {
    method: 'POST',
    apiKey: null,
    ingestApiKey: INGEST_API_KEY,
    body: {
      ...commonOicp,
      SessionID: 'identity-uid-only',
      UID: 'uid-only-wire-value',
    },
  });
  assert.equal(uidOnly.status, 400, `UID-only preview is rejected: ${JSON.stringify(uidOnly.body)}`);
  assert.equal(uidOnly.body?.normalisationError?.code, 'UID_ONLY');
  assert.deepEqual(uidOnly.body?.normalisationError?.sourceFields, ['UID']);
  assert.equal(uidOnly.body?.normalisationError?.protocol, 'OICP');

  const missing = await requestJson('/ingest/cdr/preview', {
    method: 'POST',
    apiKey: null,
    ingestApiKey: INGEST_API_KEY,
    body: { ...commonOicp, SessionID: 'identity-missing' },
  });
  assert.equal(missing.status, 400, `missing eMAID preview is rejected: ${JSON.stringify(missing.body)}`);
  assert.equal(missing.body?.normalisationError?.code, 'MISSING_EMAID');
  assert.equal(missing.body?.normalisationError?.protocol, 'OICP');

  const conflict = await requestJson('/ingest/cdr/preview', {
    method: 'POST',
    apiKey: null,
    ingestApiKey: INGEST_API_KEY,
    body: {
      id: 'identity-conflict',
      party_id: 'NF',
      cdr_token: { contract_id: 'DE*EMP*E111111' },
      cdr_location: { evse_id: 'DE*NVF*IDENTITY01' },
      start_date_time: commonOicp.ChargingStart,
      end_date_time: commonOicp.ChargingEnd,
      total_energy: 1,
      Identification: { RemoteIdentification: { EvcoID: 'DE*EMP*E222222' } },
    },
  });
  assert.equal(conflict.status, 400, `conflicting preview is rejected: ${JSON.stringify(conflict.body)}`);
  assert.equal(conflict.body?.normalisationError?.code, 'CONFLICTING_IDENTIFIERS');
  assert.equal(conflict.body?.normalisationError?.protocol, 'MIXED');
  assert.deepEqual(conflict.body?.normalisationError?.sourceFields, [
    'cdr_token.contract_id',
    'Identification.RemoteIdentification.EvcoID',
  ]);

  const malformed = await requestJson('/ingest/cdr/preview', {
    method: 'POST',
    apiKey: null,
    ingestApiKey: INGEST_API_KEY,
    body: {
      id: 'identity-malformed',
      party_id: 'NF',
      cdr_token: { contract_id: 123456 },
      cdr_location: { evse_id: 'DE*NVF*IDENTITY01' },
      start_date_time: commonOicp.ChargingStart,
      end_date_time: commonOicp.ChargingEnd,
      total_energy: 1,
    },
  });
  assert.equal(malformed.status, 400, `malformed eMAID preview is rejected: ${JSON.stringify(malformed.body)}`);
  assert.equal(malformed.body?.normalisationError?.code, 'INVALID_EMAID');
  assert.equal(malformed.body?.normalisationError?.protocol, 'OCPI');

  return {
    status: 'passed',
    accepted,
    rejected: {
      uidOnly: { code: uidOnly.body?.normalisationError?.code, protocol: uidOnly.body?.normalisationError?.protocol },
      missing: { code: missing.body?.normalisationError?.code, protocol: missing.body?.normalisationError?.protocol },
      conflict: { code: conflict.body?.normalisationError?.code, protocol: conflict.body?.normalisationError?.protocol },
      malformed: { code: malformed.body?.normalisationError?.code, protocol: malformed.body?.normalisationError?.protocol },
    },
    results,
  };
}

async function runPolicyPersistenceCheck(treasuryAddress, apiOptions) {
  const beforeToken = await loginAdmin();
  const beforeRules = assertHttp(await requestAdminJson('/admin/rules', beforeToken), 200, 'durable rules read before restart');
  const beforeWindows = assertHttp(await requestAdminJson('/admin/off-peak', beforeToken), 200, 'durable off-peak read before restart');
  assert.ok(Number.isInteger(beforeRules.revision) && beforeRules.revision >= 1);
  assert.equal(beforeRules.policy.revision, beforeRules.revision);
  assert.equal(beforeWindows.policy.revision, beforeWindows.revision);
  assertHttp(await requestAdminJson('/admin/logout', beforeToken, { method: 'POST' }), 200, 'policy check admin logout');

  await restartApi(treasuryAddress, apiOptions);

  const afterToken = await loginAdmin();
  const afterRules = assertHttp(await requestAdminJson('/admin/rules', afterToken), 200, 'durable rules read after restart');
  const afterWindows = assertHttp(await requestAdminJson('/admin/off-peak', afterToken), 200, 'durable off-peak read after restart');
  assert.deepEqual(afterRules.rules, beforeRules.rules, 'reward rules survive API restart');
  assert.deepEqual(afterWindows.windows, beforeWindows.windows, 'off-peak windows survive API restart');
  assert.equal(afterRules.revision, beforeRules.revision, 'reward policy revision survives API restart');
  assert.equal(afterWindows.revision, beforeWindows.revision, 'off-peak revision survives API restart');
  assertHttp(await requestAdminJson('/admin/logout', afterToken, { method: 'POST' }), 200, 'policy check post-restart logout');

  return {
    status: 'passed',
    revision: beforeRules.revision,
    updatedAt: beforeRules.updatedAt,
    rulesSurvivedRestart: true,
    windowsSurvivedRestart: true,
  };
}

async function runAdminOperationalChecks() {
  const token = await loginAdmin();
  const readiness = assertHttp(await requestAdminJson('/admin/readiness', token), 200, 'admin readiness');
  assert.ok(['ready', 'ready_with_warnings'].includes(readiness.status), `local readiness is usable: ${JSON.stringify(readiness)}`);

  const reconciliation = assertHttp(await requestAdminJson('/admin/reconciliation/run', token, {
    method: 'POST',
    // The primary eMAID is the first fixture user and is the only wallet
    // whose financial projection is asserted in this flow.  Other users are
    // intentionally created by identity-scope checks without a token balance.
    body: { limit: 1 },
  }), 200, 'admin reconciliation run');
  assert.equal(reconciliation.status, 'ok');
  assert.equal(reconciliation.report.status, 'matched', `disposable chain/DB reconciliation: ${JSON.stringify(reconciliation.report)}`);
  assert.equal(reconciliation.report.mismatch_count, 0);
  assert.equal(reconciliation.report.checked_count, 1);

  const alert = assertHttp(await requestAdminJson('/admin/alerts/test', token, { method: 'POST' }), 202, 'local alert delivery');
  assert.equal(alert.status, 'sent_or_queued');
  assert.equal(alert.webhookConfigured, true);
  assert.equal(alert.webhookStatus, 204);
  const delivery = await waitFor('local admin alert webhook delivery', async () => {
    const item = resources.alertWebhook?.state.deliveries.find(entry => entry.body?.eventType === 'admin_alert.test');
    return item || false;
  }, 10000);
  assert.equal(delivery.body?.eventType, 'admin_alert.test');

  const reports = assertHttp(await requestAdminJson('/admin/reconciliation?limit=5', token), 200, 'admin reconciliation history');
  assert.ok(reports.count >= 1);
  assert.equal(reports.latest.status, 'matched');

  const evidence = assertHttp(await requestAdminJson('/admin/evidence-pack', token), 200, 'admin evidence pack');
  assert.equal(evidence.status, 'ok');
  assert.equal(evidence.configuration.adminAlertWebhookConfigured, true);
  assert.ok(Array.isArray(evidence.readiness.checks));
  assert.ok(evidence.reconciliation.latest);
  assert.equal(evidence.reconciliation.latest.status, 'matched');

  const audit = assertHttp(await requestAdminJson('/admin/audit?limit=10', token), 200, 'safe admin audit projection');
  assert.ok(Array.isArray(audit.events));
  assert.ok(audit.events.some(event => (
    event.event_type === 'admin_alert.test_requested'
    || event.event_type === 'admin_alert.delivered'
  )));
  assertHttp(await requestAdminJson('/admin/logout', token, { method: 'POST' }), 200, 'admin operational checks logout');

  return {
    status: 'passed',
    readiness: readiness.status,
    reconciliation: {
      status: reconciliation.report.status,
      checked: reconciliation.report.checked_count,
      matched: reconciliation.report.matched_count,
      mismatched: reconciliation.report.mismatch_count,
    },
    alert: { status: alert.status, webhookStatus: alert.webhookStatus, deliveries: resources.alertWebhook.state.deliveries.length },
    evidencePack: { status: evidence.status, latestReconciliation: evidence.reconciliation.latest.status },
    auditEvents: audit.events.length,
  };
}

function assertHttp(response, expectedStatus, label) {
  assert.equal(response.status, expectedStatus, `${label}: ${JSON.stringify(response.body)}`);
  return response.body;
}

function assertRecoverySuccess(response, label) {
  assert.ok(response.status >= 200 && response.status < 300,
    `${label} must be a successful recovery response: ${JSON.stringify(response.body)}`);
  assert.notEqual(response.body?.recovered, false,
    `${label} must not claim that a successful response was blocked: ${JSON.stringify(response.body)}`);
  assert.ok(response.body?.operationKey,
    `${label} returns the recovered operation key: ${JSON.stringify(response.body)}`);
  assert.equal(response.body?.recoveryStatus, 'completed',
    `${label} completes the saved operation: ${JSON.stringify(response.body)}`);
  assert.equal(response.body?.projectionStatus, 'projected',
    `${label} reports the durable projection: ${JSON.stringify(response.body)}`);
  return response.body;
}

function assertRecoveryBlocked(response, label) {
  assert.ok(response.status >= 400 && response.status < 500,
    `${label} must be a client-visible blocked response: ${JSON.stringify(response.body)}`);
  assert.notEqual(response.body?.recovered, true,
    `${label} must not report recovery: ${JSON.stringify(response.body)}`);
  assert.ok(response.body?.code || response.body?.reason || response.body?.message || response.body?.error,
    `${label} returns a safe blocked reason: ${JSON.stringify(response.body)}`);
  return response.body;
}

async function waitForRecoveryAudit(pool, operationKey) {
  return waitFor(`recovery audit for ${operationKey}`, async () => {
    const result = await pool.query(`
      select event_type, status, target_id, metadata
      from audit_logs
      where (target_id = $1 or metadata->>'operationKey' = $1)
        and (event_type ilike '%recover%' or event_type ilike '%operation%')
      order by created_at desc
      limit 1
    `, [operationKey]);
    return result.rows[0] || false;
  }, 15000);
}

async function waitForAllowance(token, walletAddress, treasuryAddress) {
  const required = ethers.parseUnits('1', 18);
  return waitFor('managed-wallet token allowance', async () => {
    const allowance = await token.allowance(walletAddress, treasuryAddress);
    return allowance >= required ? allowance : false;
  }, 60000);
}

async function installReceiptFailure(pool) {
  const suffix = String(process.pid).replace(/[^0-9]/g, '');
  const functionName = `local_acceptance_fail_receipt_${suffix}`;
  const triggerName = `local_acceptance_fail_receipt_trigger_${suffix}`;
  await pool.query(`
    create or replace function ${functionName}() returns trigger
    language plpgsql as $$
    begin
      raise exception 'local acceptance injected receipt write failure';
      return new;
    end;
    $$;
  `);
  await pool.query(`
    drop trigger if exists ${triggerName} on spend_receipts;
    create trigger ${triggerName}
      before insert on spend_receipts
      for each row execute function ${functionName}();
  `);
  resources.receiptTrigger = { functionName, triggerName };
}

async function removeReceiptFailure(pool) {
  if (!resources.receiptTrigger) return;
  const { functionName, triggerName } = resources.receiptTrigger;
  await pool.query(`drop trigger if exists ${triggerName} on spend_receipts;`);
  await pool.query(`drop function if exists ${functionName}();`);
  resources.receiptTrigger = undefined;
}

async function assertReceiptFailureRemoved(pool) {
  const result = await pool.query(`
    select 1
    from pg_trigger
    where tgrelid = 'spend_receipts'::regclass
      and tgname like 'local_acceptance_fail_receipt_trigger_%'
      and not tgisinternal
  `);
  assert.equal(result.rows.length, 0, 'receipt failure trigger is removed before later spend/admin checks');
}

function sqlLiteral(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function triggerIdentifier(prefix, label) {
  return `${prefix}_${process.pid}_${Date.now().toString(36)}_${String(label).replace(/[^a-zA-Z0-9_]/g, '_')}`;
}

async function installProjectionFailure(pool, relation, sessionId, label) {
  assert.ok(['awards', 'spends'].includes(relation), `unsupported projection relation ${relation}`);
  const functionName = triggerIdentifier(`local_failure_${relation}`, label);
  const triggerName = triggerIdentifier(`local_failure_${relation}_trigger`, label);
  await pool.query(`
    create function ${functionName}() returns trigger
    language plpgsql as $$
    begin
      raise exception 'local failure-drill ${relation} projection failure';
      return new;
    end;
    $$;
  `);
  await pool.query(`
    create trigger ${triggerName}
      before insert on ${relation}
      for each row when (NEW.session_id = ${sqlLiteral(sessionId)})
      execute function ${functionName}();
  `);
  const trigger = { relation, functionName, triggerName };
  resources.projectionTriggers.push(trigger);
  return trigger;
}

async function installAwardProjectionGate(pool, sessionId, label) {
  const functionName = triggerIdentifier('local_failure_award_gate', label);
  const triggerName = triggerIdentifier('local_failure_award_gate_trigger', label);
  const advisoryKey = `failure-drill:${HARNESS_ID}:${label}`;
  await pool.query(`
    create function ${functionName}() returns trigger
    language plpgsql as $$
    begin
      perform pg_advisory_lock(hashtext(${sqlLiteral(advisoryKey)}));
      return new;
    end;
    $$;
  `);
  await pool.query(`
    create trigger ${triggerName}
      before insert on awards
      for each row when (NEW.session_id = ${sqlLiteral(sessionId)})
      execute function ${functionName}();
  `);
  // A session-level advisory lock is re-entrant for the session that owns it,
  // so the trigger must wait on a separate checked-out connection.  Holding
  // the lock here makes the projection boundary deterministic: the API can
  // reach confirmed/known-hash state, then the harness can hard-stop it while
  // the awards insert is blocked.
  const gateClient = await pool.connect();
  try {
    await gateClient.query('select pg_advisory_lock(hashtext($1))', [advisoryKey]);
  } catch (error) {
    gateClient.release();
    throw error;
  }
  const trigger = { relation: 'awards', functionName, triggerName, advisoryKey, gateClient };
  resources.projectionTriggers.push(trigger);
  return trigger;
}

async function removeProjectionTrigger(pool, trigger) {
  if (!trigger) return;
  if (trigger.gateClient) {
    await trigger.gateClient.query('select pg_advisory_unlock(hashtext($1))', [trigger.advisoryKey]).catch(() => undefined);
    trigger.gateClient.release();
    trigger.gateClient = undefined;
  }
  await pool.query(`drop trigger if exists ${trigger.triggerName} on ${trigger.relation};`);
  await pool.query(`drop function if exists ${trigger.functionName}();`);
  resources.projectionTriggers = resources.projectionTriggers.filter(item => item !== trigger);
}

async function removeAllProjectionTriggers(pool) {
  for (const trigger of [...resources.projectionTriggers]) {
    await removeProjectionTrigger(pool, trigger).catch(() => undefined);
  }
}

async function readOperation(pool, operationKey) {
  const result = await pool.query(`
    select operation_key, operation_type, session_id, provider_id, uid, amount,
           charging_session_id, status, tx_hash, movement_outcome, error_message, intent_context
    from token_operations where operation_key = $1
  `, [operationKey]);
  return result.rows[0];
}

async function readOperationForTuple(pool, operationType, sessionId, providerId) {
  const result = await pool.query(`
    select operation_key, operation_type, session_id, provider_id, uid, amount,
           charging_session_id, status, tx_hash, movement_outcome, error_message, intent_context
    from token_operations
    where operation_type = $1 and session_id = $2 and provider_id = $3
    order by created_at desc limit 1
  `, [operationType, sessionId, providerId]);
  return result.rows[0];
}

async function waitForOperation(pool, operationKey, predicate, label) {
  return waitFor(label, async () => {
    const row = await readOperation(pool, operationKey);
    return row && predicate(row) ? row : false;
  }, 60000);
}

async function transferLogs(provider, tokenAddress, from, to, amountUnits) {
  const transferTopic = ethers.id('Transfer(address,address,uint256)');
  const logs = await provider.getLogs({
    address: tokenAddress,
    topics: [
      transferTopic,
      from ? ethers.zeroPadValue(from, 32) : null,
      to ? ethers.zeroPadValue(to, 32) : null,
    ],
      fromBlock: 0,
      toBlock: 'latest',
  });
  const iface = new ethers.Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  return logs
    .map(log => {
      try {
        const parsed = iface.parseLog(log);
        return parsed ? {
          txHash: log.transactionHash,
          logIndex: log.index,
          from: parsed.args[0],
          to: parsed.args[1],
          amount: parsed.args[2].toString(),
        } : undefined;
      } catch {
        return undefined;
      }
    })
    .filter(log => log && (amountUnits === undefined || log.amount === String(amountUnits)));
}

async function runLocalRecoveryHelper(operationKey, treasuryAddress) {
  const helper = startProcess(process.execPath, ['scripts/recover-award-operation-local.js', operationKey], {
    cwd: APP_ROOT,
    env: apiEnvironment(0, treasuryAddress, { rpcUrl: `http://127.0.0.1:${resources.hardhatPort}` }),
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      hardStopProcess(helper)
        .catch(() => undefined)
        .finally(() => {
          if (!settled) {
            settled = true;
            reject(new Error('award recovery helper did not exit within 20s'));
          }
        });
    }, 20_000);
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      callback();
    };
    helper.once('error', error => finish(() => reject(error)));
    helper.once('exit', (code, signal) => finish(() => {
      const output = helper.__output();
      if (code !== 0) {
        reject(new Error(`award recovery helper exited ${code ?? signal}\n${output.stderr}\n${output.stdout}`));
        return;
      }
      try {
        resolve(JSON.parse(output.stdout));
      } catch (error) {
        reject(new Error(`award recovery helper returned invalid JSON: ${error.message}\n${output.stdout}`));
      }
    }));
  });
}

async function queryEvidence(pool, token, walletAddress, treasuryAddress, initialUser, initialTreasury) {
  const [userRow, balances, awards, spends, reservations, receipts, operations, approvalPreparations] = await Promise.all([
    pool.query('select uid, wallet_address from users where uid = $1', [UID]),
    pool.query(`
      select b.balance, b.total_awarded, b.total_spent
      from balances b join users u on u.id = b.user_id
      where u.uid = $1
    `, [UID]),
    pool.query('select session_id, provider_id, amount, tx_hash from awards where user_id = (select id from users where uid = $1) order by session_id', [UID]),
    pool.query('select session_id, amount, tx_hash from spends where user_id = (select id from users where uid = $1) order by session_id', [UID]),
    pool.query('select session_id, provider_id, reserved_amount, settled_amount, released_amount, status, tx_hash from spend_reservations where uid = $1 order by session_id', [UID]),
    pool.query('select receipt_id, amount, token_tx_hash from spend_receipts where uid = $1 order by receipt_id', [UID]),
    pool.query('select operation_key, operation_type, amount, status, tx_hash from token_operations where uid = $1 order by operation_key', [UID]),
    pool.query('select operation_key, status, funding_tx_hash, approval_tx_hash from approval_preparations where wallet_address = lower($1)', [walletAddress]),
  ]);

  assert.equal(userRow.rows.length, 1, 'one eMAID user row exists');
  assert.equal(balances.rows.length, 1, 'one balance mirror row exists');
  assert.equal(awards.rows.length, 3, 'three unique awards exist after CDR replays');
  assert.equal(spends.rows.length, 2, 'two unique spends exist after replay');
  assert.equal(reservations.rows.length, 2, 'charging and discharge reservations exist');
  assert.equal(receipts.rows.length, 2, 'charging and manual receipts exist');
  assert.equal(approvalPreparations.rows.length, 1, 'one durable approval preparation exists');
  assert.equal(approvalPreparations.rows[0].status, 'approved', 'managed wallet approval completed');

  const dbBalance = balances.rows[0];
  assert.equal(Number(dbBalance.balance), 20, 'database balance mirror matches net token movement');
  assert.equal(Number(dbBalance.total_awarded), 26, 'database award total is exact');
  assert.equal(Number(dbBalance.total_spent), 6, 'database spend total is exact');
  assert.equal(reservations.rows.filter(row => row.status === 'settled').length, 1);
  assert.equal(reservations.rows.filter(row => row.status === 'released').length, 1);

  const userBalance = await token.balanceOf(walletAddress);
  const treasuryBalance = await token.balanceOf(treasuryAddress);
  assert.equal(ethers.formatUnits(userBalance, 18), '20.0', 'user chain balance matches DB');
  assert.equal(ethers.formatUnits(treasuryBalance, 18), '980.0', 'treasury chain balance matches DB');
  assert.equal(ethers.formatUnits(userBalance - initialUser, 18), '20.0', 'user chain delta is exact');
  assert.equal(ethers.formatUnits(initialTreasury - treasuryBalance, 18), '20.0', 'treasury chain delta is exact');

  return {
    users: userRow.rows,
    balances: balances.rows,
    awards: awards.rows,
    spends: spends.rows,
    reservations: reservations.rows,
    receipts: receipts.rows,
    operations: operations.rows,
    approvalPreparations: approvalPreparations.rows,
    chain: {
      userBalance: ethers.formatUnits(userBalance, 18),
      treasuryBalance: ethers.formatUnits(treasuryBalance, 18),
    },
  };
}

const BACKUP_RESTORE_TABLES = [
  'users',
  'balances',
  'awards',
  'spends',
  'spend_receipts',
  'spend_reservations',
  'token_operations',
  'approval_preparations',
  'reward_policy',
  'audit_logs',
  'reconciliation_reports',
  'linked_wallet_links',
];

async function readBackupRestoreTableSnapshot(pool) {
  const snapshot = {};
  for (const table of BACKUP_RESTORE_TABLES) {
    const result = await pool.query(`
      select count(*)::int as row_count,
             md5(coalesce(string_agg(row_json, '|' order by row_json), '')) as digest
      from (
        select row_to_json(rows)::text as row_json
        from (select * from "${table}") rows
      ) ordered_rows
    `);
    snapshot[table] = {
      rowCount: result.rows[0].row_count,
      digest: result.rows[0].digest,
    };
  }
  return snapshot;
}

async function runDisposableBackupRestore(pool) {
  const restoreDatabaseName = `${DB_NAME}_restore`.slice(0, 63);
  const dumpPath = `/tmp/${restoreDatabaseName}.dump`;
  let restorePool;
  const before = await readBackupRestoreTableSnapshot(pool);
  try {
    await runCommand('docker', [
      'exec', DB_CONTAINER,
      'pg_dump', '-U', DB_USER, '-d', DB_NAME,
      '-Fc', '-f', dumpPath,
    ], { timeoutMs: 60000 });
    await runCommand('docker', [
      'exec', DB_CONTAINER,
      'createdb', '-U', DB_USER, restoreDatabaseName,
    ], { timeoutMs: 30000 });
    await runCommand('docker', [
      'exec', DB_CONTAINER,
      'pg_restore', '-U', DB_USER, '-d', restoreDatabaseName,
      '--no-owner', '--no-privileges', '--exit-on-error', dumpPath,
    ], { timeoutMs: 120000 });

    const restoredUrl = `postgres://${DB_USER}:${DB_PASSWORD}@127.0.0.1:${resources.dbPort}/${restoreDatabaseName}`;
    restorePool = new Pool({ connectionString: restoredUrl, max: 2, connectionTimeoutMillis: 3000 });
    await restorePool.query('select 1');
    const after = await readBackupRestoreTableSnapshot(restorePool);
    assert.deepEqual(after, before, 'current disposable schema/data survives pg_dump and pg_restore');
    const result = {
      status: 'passed',
      format: 'custom',
      sourceDatabase: DB_NAME,
      restoredDatabase: restoreDatabaseName,
      comparedTables: BACKUP_RESTORE_TABLES,
      source: before,
      restored: after,
    };
    resources.backupRestore = result;
    return result;
  } finally {
    if (restorePool) await restorePool.end().catch(() => undefined);
    await runCommand('docker', [
      'exec', DB_CONTAINER,
      'dropdb', '-U', DB_USER, '--if-exists', restoreDatabaseName,
    ], { timeoutMs: 30000 }).catch(() => undefined);
    await runCommand('docker', [
      'exec', DB_CONTAINER,
      'rm', '-f', dumpPath,
    ], { timeoutMs: 30000 }).catch(() => undefined);
  }
}

function failureDrillCdr(sessionId, energy = '40') {
  return {
    id: sessionId,
    session_id: sessionId,
    party_id: PROVIDER_ID,
    cdr_location: { evse_id: EVSE_ID },
    start_date_time: '2026-02-01T01:00:00Z',
    end_date_time: '2026-02-01T02:00:00Z',
    total_energy: energy,
    cdr_token: { contract_id: UID },
  };
}

async function countRows(pool, table, column, value) {
  assert.ok(['awards', 'spends', 'spend_receipts'].includes(table));
  assert.ok(['session_id', 'token_tx_hash'].includes(column));
  const result = await pool.query(`select count(*)::int as count from ${table} where ${column} = $1`, [value]);
  return result.rows[0].count;
}

async function readSpendKeySideEffectSnapshot(pool, provider, tokenAddress, token, walletAddress, treasuryAddress) {
  const [users, operations, spends, receipts, reservations, approvalPreparations, balanceRows, userBalance, treasuryBalance, transferRows] = await Promise.all([
    pool.query('select count(*)::int as count from users'),
    pool.query('select count(*)::int as count from token_operations'),
    pool.query('select count(*)::int as count from spends'),
    pool.query('select count(*)::int as count from spend_receipts'),
    pool.query('select count(*)::int as count from spend_reservations'),
    pool.query('select count(*)::int as count from approval_preparations'),
    pool.query(`
      select b.balance, b.total_awarded, b.total_spent
      from balances b join users u on u.id = b.user_id
      where u.uid = $1
    `, [UID]),
    token.balanceOf(walletAddress),
    token.balanceOf(treasuryAddress),
    transferLogs(provider, tokenAddress, walletAddress, treasuryAddress),
  ]);
  return {
    users: users.rows[0].count,
    tokenOperations: operations.rows[0].count,
    spends: spends.rows[0].count,
    spendReceipts: receipts.rows[0].count,
    reservations: reservations.rows[0].count,
    approvalPreparations: approvalPreparations.rows[0].count,
    balance: balanceRows.rows[0] || null,
    userChainBalance: userBalance.toString(),
    treasuryChainBalance: treasuryBalance.toString(),
    walletToTreasuryTransfers: transferRows.length,
  };
}

async function runSpendKeyValidation({ pool, provider, tokenAddress, token, walletAddress, treasuryAddress }) {
  const cases = [
    {
      name: 'missing_idempotency_key',
      expectedCode: 'IDEMPOTENCY_KEY_REQUIRED',
      body: {
        uid: 'local-key-validation-unseen-emaid',
        amount: 1,
        sessionId: 'spend-key-validation-missing',
        providerId: PROVIDER_ID,
        label: 'missing key validation',
      },
    },
    {
      name: 'empty_idempotency_key',
      expectedCode: 'INVALID_OPERATION_KEY',
      body: {
        uid: UID,
        amount: 1,
        idempotencyKey: '',
        sessionId: 'spend-key-validation-empty',
        providerId: PROVIDER_ID,
        label: 'empty key validation',
      },
    },
    {
      name: 'non_string_idempotency_key',
      expectedCode: 'INVALID_OPERATION_KEY',
      body: {
        uid: UID,
        amount: 1,
        idempotencyKey: 123,
        sessionId: 'spend-key-validation-non-string',
        providerId: PROVIDER_ID,
        label: 'non-string key validation',
      },
    },
  ];
  const results = [];
  for (const testCase of cases) {
    const before = await readSpendKeySideEffectSnapshot(
      pool,
      provider,
      tokenAddress,
      token,
      walletAddress,
      treasuryAddress,
    );
    const response = await requestJson('/spend', { method: 'POST', body: testCase.body });
    assert.equal(response.status, 400, `${testCase.name} must be rejected: ${JSON.stringify(response.body)}`);
    assert.equal(response.body?.code, testCase.expectedCode, `${testCase.name} returns the expected validation code`);
    const after = await readSpendKeySideEffectSnapshot(
      pool,
      provider,
      tokenAddress,
      token,
      walletAddress,
      treasuryAddress,
    );
    assert.deepEqual(after, before, `${testCase.name} created no operation, reservation, receipt, spend, wallet or transfer side effect`);
    results.push({
      name: testCase.name,
      status: response.status,
      code: response.body.code,
      sideEffects: 'none',
    });
  }
  return { status: 'passed', cases: results };
}

async function runLinkedCustodialChecks({ pool, provider, token, treasurySigner, treasuryAddress }) {
  const externalSigner = new ethers.Wallet(HARDHAT_ACCOUNT_ONE_PRIVATE_KEY, provider);
  const externalAddress = await externalSigner.getAddress();
  const linkedPath = `/wallet/${encodeURIComponent(LINKED_UID)}/linked-wallets`;
  const linkMessage = [
    'NEVERFLAT link wallet address',
    `EMP contract: ${LINKED_UID}`,
    `Wallet address: ${ethers.getAddress(externalAddress)}`,
  ].join('\n');

  const invalidLink = await requestJson(linkedPath, {
    method: 'POST',
    body: { walletAddress: externalAddress, signature: '0x' },
  });
  assert.equal(invalidLink.status, 400, 'linked wallet rejects an invalid signature');

  const linked = assertHttp(await requestJson(linkedPath, {
    method: 'POST',
    body: {
      walletAddress: externalAddress,
      signature: await externalSigner.signMessage(linkMessage),
    },
  }), 200, 'linked wallet signature');
  assert.equal(linked.message, 'Wallet address linked');
  assert.ok(linked.linkedWalletAddresses.some(address => address.toLowerCase() === externalAddress.toLowerCase()));

  // Exercise both mode transitions while the external wallet has no balance;
  // the endpoint must preserve the signed linked-wallet association.
  const managedMode = assertHttp(await requestJson(`/wallet/${encodeURIComponent(LINKED_UID)}/mode`, {
    method: 'POST',
    body: { mode: 'managed' },
  }), 200, 'linked wallet managed mode');
  assert.equal(managedMode.walletMode, 'managed');
  const custodialMode = assertHttp(await requestJson(`/wallet/${encodeURIComponent(LINKED_UID)}/mode`, {
    method: 'POST',
    body: { mode: 'custodial', walletAddress: externalAddress },
  }), 200, 'linked wallet custodial mode');
  assert.equal(custodialMode.walletMode, 'custodial');
  assert.equal(custodialMode.walletAddress.toLowerCase(), externalAddress.toLowerCase());

  const fundingTx = await token.connect(treasurySigner).transfer(externalAddress, ethers.parseUnits('10', 18));
  const fundingReceipt = await fundingTx.wait();
  assert.equal(Number(fundingReceipt?.status), 1, 'local treasury funded the linked Hardhat wallet');

  const walletView = assertHttp(await requestJson('/wallet/me', {
    method: 'GET',
    headers: { 'x-contract-id': LINKED_UID },
  }), 200, 'linked custodial wallet view');
  assert.equal(walletView.walletMode, 'custodial');
  assert.equal(walletView.walletAddress.toLowerCase(), externalAddress.toLowerCase());

  const reservationSessionId = 'linked-custodial-reservation';
  const approvalIntent = assertHttp(await requestJson('/spend/reservation-approval-intent', {
    method: 'POST',
    headers: { 'x-contract-id': LINKED_UID },
    body: {
      walletAddress: externalAddress,
      amount: 2,
      sessionId: reservationSessionId,
      providerId: LINKED_PROVIDER_ID,
    },
  }), 200, 'linked reservation approval intent');
  assert.equal(approvalIntent.status, 'requires_signature');
  assert.equal(approvalIntent.transaction.from.toLowerCase(), externalAddress.toLowerCase());
  assert.equal(approvalIntent.transaction.to.toLowerCase(), resources.tokenAddress.toLowerCase());
  const approvalTx = await externalSigner.sendTransaction(approvalIntent.transaction);
  const approvalReceipt = await approvalTx.wait();
  assert.equal(Number(approvalReceipt?.status), 1, 'linked wallet signed the reservation approval');
  const allowance = await token.allowance(externalAddress, treasuryAddress);
  assert.ok(allowance >= ethers.parseUnits('2', 18), 'reservation approval allowance covers the held amount');

  const reservation = assertHttp(await requestJson('/spend/me', {
    method: 'POST',
    headers: { 'x-contract-id': LINKED_UID },
    body: {
      sessionId: reservationSessionId,
      providerId: LINKED_PROVIDER_ID,
      amount: 2,
      walletAddress: externalAddress,
      authorizationTxHash: approvalTx.hash,
    },
  }), 200, 'linked custodial reservation');
  assert.equal(reservation.reservation.status, 'reserved');
  const reservationId = reservation.reservation.id;

  const settlementCdr = {
    id: 'cdr-linked-custodial-reservation',
    session_id: reservationSessionId,
    party_id: LINKED_PROVIDER_ID,
    cdr_location: { evse_id: LINKED_EVSE_ID },
    start_date_time: '2026-01-04T01:00:00Z',
    end_date_time: '2026-01-04T02:00:00Z',
    total_energy: '2',
    cdr_token: { contract_id: LINKED_UID },
  };
  const settlement = assertHttp(await postIngest(settlementCdr), 200, 'linked custodial reservation settlement');
  assert.equal(settlement.reservationSettlement.status, 'settled');
  assert.ok(settlement.reservationSettlement.spendReceipt);
  const linkedReservationStatus = assertHttp(await getReservationStatusFor(LINKED_UID, reservationId), 200, 'linked custodial reservation status');
  assert.equal(linkedReservationStatus.status, 'settled');
  assert.equal(linkedReservationStatus.receiptStatus, 'settled');

  const custodialSessionId = 'linked-custodial-direct';
  const custodialIntent = assertHttp(await requestJson('/spend/custodial-intent', {
    method: 'POST',
    body: {
      uid: LINKED_UID,
      walletAddress: externalAddress,
      amount: 1,
      sessionId: custodialSessionId,
      providerId: LINKED_PROVIDER_ID,
    },
  }), 200, 'custodial spend intent');
  assert.equal(custodialIntent.status, 'requires_signature');
  assert.equal(custodialIntent.spendIntent.transaction.from.toLowerCase(), externalAddress.toLowerCase());

  const directSpendTx = await token.connect(externalSigner).transfer(treasuryAddress, ethers.parseUnits('1', 18));
  const directSpendReceipt = await directSpendTx.wait();
  assert.equal(Number(directSpendReceipt?.status), 1, 'linked wallet direct custodial transfer mined');
  const custodialRecordBody = {
    uid: LINKED_UID,
    walletAddress: externalAddress,
    amount: 1,
    txHash: directSpendTx.hash,
    sessionId: custodialSessionId,
    providerId: LINKED_PROVIDER_ID,
  };
  const custodialRecord = assertHttp(await requestJson('/spend/custodial-record', {
    method: 'POST',
    body: custodialRecordBody,
  }), 200, 'custodial spend record');
  assert.equal(custodialRecord.status, 'success');
  assert.ok(custodialRecord.spendReceipt);
  const custodialReplay = assertHttp(await requestJson('/spend/custodial-record', {
    method: 'POST',
    body: custodialRecordBody,
  }), 200, 'custodial spend replay');
  assert.equal(custodialReplay.duplicate, true);
  assert.equal(custodialReplay.spendReceipt.payload.receiptId, custodialRecord.spendReceipt.payload.receiptId);

  const mismatchedEvidence = await requestJson('/spend/custodial-record', {
    method: 'POST',
    body: { ...custodialRecordBody, amount: 2 },
  });
  assert.equal(mismatchedEvidence.status, 400, `mismatched custodial evidence is rejected: ${JSON.stringify(mismatchedEvidence.body)}`);
  assert.equal(mismatchedEvidence.body?.code, 'SPEND_EVIDENCE_INVALID');
  const directRows = await pool.query(`
    select count(*)::int as count
    from spends s
    join users u on u.id = s.user_id
    where u.uid = $1 and s.session_id = $2
  `, [LINKED_UID, custodialSessionId]);
  assert.equal(directRows.rows[0].count, 1, 'custodial replay and mismatch created one spend projection');

  const linkedBalance = await token.balanceOf(externalAddress);
  assert.equal(linkedBalance.toString(), ethers.parseUnits('7', 18).toString(), 'linked wallet reflects the reservation and direct custodial spends');
  return {
    status: 'passed',
    linkedWallet: {
      eMAID: LINKED_UID,
      walletAddress: externalAddress,
      invalidSignatureStatus: invalidLink.status,
      modeTransitions: [managedMode.walletMode, custodialMode.walletMode],
    },
    reservationApproval: {
      status: approvalIntent.status,
      authorizationTxHash: approvalTx.hash,
      reservationId,
      settlementStatus: linkedReservationStatus.status,
      receiptStatus: linkedReservationStatus.receiptStatus,
    },
    custodial: {
      intentStatus: custodialIntent.status,
      txHash: directSpendTx.hash,
      recordStatus: custodialRecord.status,
      replayDuplicate: custodialReplay.duplicate,
      mismatchStatus: mismatchedEvidence.status,
      mismatchCode: mismatchedEvidence.body?.code,
      spendRows: directRows.rows[0].count,
    },
  };
}

async function runFailureDrill({ pool, provider, token, treasuryAddress, walletAddress }) {
  const scenarios = [];
  const drillStartUserBalance = await token.balanceOf(walletAddress);
  const drillStartTreasuryBalance = await token.balanceOf(treasuryAddress);
  const drillStartLedger = await pool.query(`
    select b.balance, b.total_awarded, b.total_spent
    from balances b join users u on u.id = b.user_id
    where u.uid = $1
  `, [UID]);
  assert.equal(drillStartLedger.rows.length, 1, 'failure drill has one starting balance mirror');

  // 1. Hold the award projection at the database boundary after the durable
  // hash/state transition. Killing the API releases the waiting DB session;
  // the next process must project the known hash without resubmitting it.
  const crashSession = 'failure-known-hash-crash';
  const crashCdr = failureDrillCdr(crashSession);
  const crashGate = await installAwardProjectionGate(pool, crashSession, 'known_hash_crash');
  const crashBeforeBalance = await token.balanceOf(walletAddress);
  let crashResponse;
  const crashRequest = postIngest(crashCdr)
    .then(response => { crashResponse = response; return response; })
    .catch(error => { crashResponse = { transportError: error.message }; return crashResponse; });
  let crashClaim;
  try {
    crashClaim = await waitFor('known-hash award claim', async () => {
      const row = await readOperationForTuple(pool, 'award', crashSession, PROVIDER_ID);
      // The hash is persisted before receipt verification and projection.  A
      // crash-window proof must wait until the durable state has reached
      // confirmed while the award insert is held by the projection gate;
      // observing submitted alone would race the API's evidence read.
      return row && row.tx_hash && row.status === 'confirmed' ? row : false;
    }, 15000);
  } catch (error) {
    throw new Error(`${error.message}; firstRequest=${JSON.stringify(crashResponse || null)}`);
  }
  assert.equal(crashClaim.status, 'confirmed', `known-hash projection gate did not stop after confirmation: ${JSON.stringify(crashClaim)}`);
  const crashReceipt = await provider.getTransactionReceipt(crashClaim.tx_hash);
  assert.ok(crashReceipt && Number(crashReceipt.status) === 1, 'known-hash crash transfer is mined before the API stop');
  await hardStopProcess(resources.api);
  resources.api = undefined;
  resources.apiBaseUrl = undefined;
  resources.apiPort = undefined;
  await crashRequest;
  await removeProjectionTrigger(pool, crashGate);
  await startApi(treasuryAddress);
  const crashRecovery = await postIngest(crashCdr);
  assert.equal(crashRecovery.status, 200, `known-hash recovery response: ${JSON.stringify(crashRecovery.body)}`);
  // Recovery projects the existing confirmed hash.  Depending on whether the
  // API sees a legacy projection row or completes the durable operation in
  // this request, the public idempotency label is duplicate or accepted; the
  // durable operation/hash and transfer count are the safety assertions.
  assert.ok(['accepted', 'duplicate'].includes(crashRecovery.body.status));
  assert.equal(crashRecovery.body.operationStatus, 'projected');
  assert.equal(crashRecovery.body.txHash.toLowerCase(), crashClaim.tx_hash.toLowerCase());
  const crashAfterBalance = await token.balanceOf(walletAddress);
  assert.equal((crashAfterBalance - crashBeforeBalance).toString(), ethers.parseUnits('10', 18).toString());
  assert.equal(await countRows(pool, 'awards', 'session_id', crashSession), 1);
  const crashAfterOperation = await readOperation(pool, crashClaim.operation_key);
  assert.equal(crashAfterOperation.status, 'projected');
  const crashTransfers = await transferLogs(provider, resources.tokenAddress, treasuryAddress, walletAddress, ethers.parseUnits('10', 18));
  assert.equal(crashTransfers.filter(item => item.txHash.toLowerCase() === crashClaim.tx_hash.toLowerCase()).length, 1);
  scenarios.push({
    name: 'known_hash_persisted_api_hard_stop_then_same_key_recovery',
    operationKey: crashClaim.operation_key,
    txHash: crashClaim.tx_hash,
    firstRequest: 'connection_terminated_after_confirmed_before_projection',
    retry: { status: crashRecovery.status, operationStatus: crashAfterOperation.status },
    transferCountForHash: 1,
    balanceDelta: '10.00',
  });

  // 2. Route API reads through a local proxy. First, a transient receipt
  // failure is retried and recovers. Then the bounded budget is exhausted;
  // the same known hash remains pending until a restarted API retries it.
  // Inject one provider-level receipt failure.  ethers may issue an internal
  // retry around a JSON-RPC error before the bounded evidence retry wrapper;
  // one injected failure therefore exercises the transient path without
  // depending on provider-internal retry details.
  const rpcProxy = await startRpcProxy({ receiptFailuresRemaining: 1 });
  await restartApi(treasuryAddress, { rpcUrl: rpcProxy.url });
  const transientSession = 'failure-rpc-transient-receipt';
  const transientBefore = await token.balanceOf(walletAddress);
  const transientInjectedBefore = rpcProxy.state.injectedReceiptFailures;
  const transientResponse = await postIngest(failureDrillCdr(transientSession));
  if (transientResponse.status !== 200) {
    const transientOperation = await readOperationForTuple(pool, 'award', transientSession, PROVIDER_ID);
    throw new Error(`transient receipt recovery did not complete: response=${JSON.stringify(transientResponse.body)} operation=${JSON.stringify(transientOperation)} proxy=${JSON.stringify(rpcProxy.state)}`);
  }
  assert.equal(transientResponse.status, 200, `transient receipt recovery: ${JSON.stringify(transientResponse.body)}`);
  assert.equal(transientResponse.body.status, 'accepted');
  const transientOperation = await waitFor('transient receipt projected', async () => {
    const row = await readOperationForTuple(pool, 'award', transientSession, PROVIDER_ID);
    return row && row.status === 'projected' ? row : false;
  });
  assert.ok(rpcProxy.state.injectedReceiptFailures >= 1, 'receipt fault proxy injected the transient read failure');
  const transientAfter = await token.balanceOf(walletAddress);
  const transientInjectedReceiptFailures = rpcProxy.state.injectedReceiptFailures - transientInjectedBefore;
  assert.equal((transientAfter - transientBefore).toString(), ethers.parseUnits('10', 18).toString());
  assert.equal((await transferLogs(provider, resources.tokenAddress, treasuryAddress, walletAddress, ethers.parseUnits('10', 18)))
    .filter(item => item.txHash.toLowerCase() === transientOperation.tx_hash.toLowerCase()).length, 1);

  rpcProxy.setReceiptFailures(3);
  const exhaustedSession = 'failure-rpc-bounded-exhaustion';
  const exhaustedBefore = await token.balanceOf(walletAddress);
  const exhaustedResponse = await postIngest(failureDrillCdr(exhaustedSession));
  assert.equal(exhaustedResponse.status, 202, `bounded receipt exhaustion: ${JSON.stringify(exhaustedResponse.body)}`);
  assert.equal(exhaustedResponse.body.pending, true);
  assert.equal(exhaustedResponse.body.requiresReview, false);
  assert.ok(exhaustedResponse.body.txHash);
  const exhaustedOperation = await waitFor('bounded receipt operation retained', async () => {
    const row = await readOperationForTuple(pool, 'award', exhaustedSession, PROVIDER_ID);
    return row && row.tx_hash ? row : false;
  });
  assert.equal(exhaustedOperation.status, 'submitted');
  assert.equal(exhaustedOperation.tx_hash.toLowerCase(), exhaustedResponse.body.txHash.toLowerCase());
  const exhaustedAfterFirst = await waitFor('bounded exhaustion chain transfer', async () => {
    const balance = await token.balanceOf(walletAddress);
    return balance === exhaustedBefore + ethers.parseUnits('10', 18) ? balance : false;
  });
  rpcProxy.setReceiptFailures(0);
  await restartApi(treasuryAddress, { rpcUrl: rpcProxy.url });
  const exhaustedRetry = await postIngest(failureDrillCdr(exhaustedSession));
  assert.equal(exhaustedRetry.status, 200, `bounded receipt retry: ${JSON.stringify(exhaustedRetry.body)}`);
  assert.ok(['accepted', 'duplicate'].includes(exhaustedRetry.body.status));
  assert.equal(exhaustedRetry.body.operationStatus, 'projected');
  const exhaustedAfter = await readOperation(pool, exhaustedOperation.operation_key);
  assert.equal(exhaustedAfter.status, 'projected');
  assert.equal(exhaustedRetry.body.txHash.toLowerCase(), exhaustedOperation.tx_hash.toLowerCase());
  assert.equal((await token.balanceOf(walletAddress)).toString(), exhaustedAfterFirst.toString());
  assert.equal((await transferLogs(provider, resources.tokenAddress, treasuryAddress, walletAddress, ethers.parseUnits('10', 18)))
    .filter(item => item.txHash.toLowerCase() === exhaustedOperation.tx_hash.toLowerCase()).length, 1);
  scenarios.push({
    name: 'rpc_receipt_transient_retry_and_bounded_exhaustion',
    recoveredOperationKey: transientOperation.operation_key,
    recoveredTxHash: transientOperation.tx_hash,
    transientInjectedReceiptFailures,
    transientBalanceDelta: '10.00',
    transientTransferCountForHash: 1,
    exhaustedOperationKey: exhaustedOperation.operation_key,
    exhaustedTxHash: exhaustedOperation.tx_hash,
    exhaustedFirstResponse: {
      status: exhaustedResponse.status,
      pending: exhaustedResponse.body.pending,
      requiresReview: exhaustedResponse.body.requiresReview,
    },
    exhaustedRetry: { status: exhaustedRetry.status, operationStatus: exhaustedAfter.status },
    exhaustedBalanceDelta: '10.00',
    exhaustedTransferCountForHash: 1,
  });

  // Return to a direct local RPC endpoint before the projection-failure and
  // concurrency checks. The proxy remains alive for the later ambiguity test.
  await restartApi(treasuryAddress);
  const adminToken = await loginAdmin();

  // An API key is not an admin session.  This refusal is checked before any
  // recovery lookup or financial side effect.
  const apiKeyRecovery = await requestJson('/admin/operations/recover', {
    method: 'POST',
    body: { operationKey: 'award:unknown-api-key-attempt' },
  });
  assert.equal(apiKeyRecovery.status, 401, `generic API key cannot recover an operation: ${JSON.stringify(apiKeyRecovery.body)}`);

  // 3. A confirmed award and a confirmed manual spend each survive a
  // projection write failure. The authenticated operator recovery route uses
  // only the durable hash/operation and creates one ledger row; repeated and
  // concurrent recovery requests remain idempotent.
  const projectionAwardSession = 'failure-db-award-projection';
  const projectionAwardCdr = failureDrillCdr(projectionAwardSession);
  const awardProjectionTrigger = await installProjectionFailure(pool, 'awards', projectionAwardSession, 'award');
  const projectionAwardBefore = await token.balanceOf(walletAddress);
  const projectionAwardFirst = await postIngest(projectionAwardCdr);
  assert.equal(projectionAwardFirst.status, 202, `award projection failure: ${JSON.stringify(projectionAwardFirst.body)}`);
  assert.equal(projectionAwardFirst.body.pending, true);
  assert.equal(projectionAwardFirst.body.requiresReview, false);
  assert.ok(projectionAwardFirst.body.txHash);
  const projectionAwardOperation = await readOperationForTuple(pool, 'award', projectionAwardSession, PROVIDER_ID);
  assert.ok(projectionAwardOperation && projectionAwardOperation.tx_hash);
  assert.equal(await countRows(pool, 'awards', 'session_id', projectionAwardSession), 0);
  await removeProjectionTrigger(pool, awardProjectionTrigger);
  const operationsView = await requestAdminJson('/admin/operations?scope=all&limit=100', adminToken);
  assert.equal(operationsView.status, 200, `admin operations view: ${JSON.stringify(operationsView.body)}`);
  assert.equal(operationsView.body?.status, 'ok', `admin operations view status: ${JSON.stringify(operationsView.body)}`);
  const operationsViewRow = operationsView.body?.operations?.find(row => row.operationKey === projectionAwardOperation.operation_key);
  assert.ok(operationsViewRow, 'admin operations view contains the projection-failure award');
  assert.equal(operationsViewRow.recovery?.eligible, true, 'admin operations view recognises a saved award recovery snapshot');
  assert.equal(operationsViewRow.recovery?.reasonCode, 'CHAIN_EVIDENCE_REQUIRED');
  assert.equal(typeof operationsViewRow.recovery?.reasonCode, 'string', 'admin operations view exposes a safe recovery reason code');
  assert.equal(typeof operationsViewRow.recovery?.reason, 'string', 'admin operations view exposes a safe recovery reason');
  assert.equal(Object.prototype.hasOwnProperty.call(operationsViewRow, 'intent_context'), false, 'admin operations view excludes raw intent context');
  assert.equal(Object.prototype.hasOwnProperty.call(operationsViewRow, 'request_fingerprint'), false, 'admin operations view excludes request fingerprints');
  assert.equal(JSON.stringify(operationsViewRow).includes('rawCDR'), false, 'admin operations view excludes raw CDR snapshot data');

  const missingSnapshotOperationKey = 'award:admin-list-missing-snapshot';
  const missingSnapshotHash = `0x${'b'.repeat(64)}`;
  await pool.query(`
    insert into token_operations (
      id, operation_key, operation_type, request_fingerprint, uid, wallet_address,
      amount, session_id, provider_id, reservation_id, intent_context, status,
      movement_outcome, tx_hash
    ) values (
      gen_random_uuid(), $1, 'award', $2, $3, $4, 1, $5, $6, null, null,
      'confirmed', 'confirmed', $7
    )
  `, [
    missingSnapshotOperationKey,
    'admin-list-missing-snapshot-fingerprint',
    UID,
    walletAddress,
    'admin-list-missing-snapshot-session',
    PROVIDER_ID,
    missingSnapshotHash,
  ]);
  try {
    const missingSnapshotView = await requestAdminJson('/admin/operations?scope=all&limit=100', adminToken);
    assert.equal(missingSnapshotView.status, 200, `admin operations missing-snapshot view: ${JSON.stringify(missingSnapshotView.body)}`);
    const missingSnapshotRow = missingSnapshotView.body?.operations?.find(row => row.operationKey === missingSnapshotOperationKey);
    assert.ok(missingSnapshotRow, 'admin operations view contains the missing-snapshot award');
    assert.equal(missingSnapshotRow.recovery?.eligible, false);
    assert.equal(missingSnapshotRow.recovery?.reasonCode, 'AWARD_CDR_SNAPSHOT_REQUIRED');
    assert.equal(Object.prototype.hasOwnProperty.call(missingSnapshotRow, 'intent_context'), false, 'missing-snapshot response excludes intent context');
    assert.equal(Object.prototype.hasOwnProperty.call(missingSnapshotRow, 'request_fingerprint'), false, 'missing-snapshot response excludes request fingerprints');
    assert.equal(JSON.stringify(missingSnapshotRow).includes(missingSnapshotHash), true, 'safe operations response retains the transaction hash for review');
    assert.equal(JSON.stringify(missingSnapshotRow).includes('admin-list-missing-snapshot-fingerprint'), false, 'safe operations response excludes the request fingerprint value');
  } finally {
    await pool.query('delete from token_operations where operation_key = $1', [missingSnapshotOperationKey]);
  }
  const awardRecoveryBefore = await token.balanceOf(walletAddress);
  const projectionAwardRecovery = await recoverSavedOperation(projectionAwardOperation.operation_key, adminToken);
  const projectionAwardRecoveryBody = assertRecoverySuccess(projectionAwardRecovery, 'admin award recovery');
  assert.equal(projectionAwardRecoveryBody.projectionStatus, 'projected');
  assert.equal(projectionAwardRecoveryBody.operationKey, projectionAwardOperation.operation_key);
  assert.equal(await countRows(pool, 'awards', 'session_id', projectionAwardSession), 1);
  assert.equal((await readOperation(pool, projectionAwardOperation.operation_key)).status, 'projected');
  assert.equal((await token.balanceOf(walletAddress) - projectionAwardBefore).toString(), ethers.parseUnits('10', 18).toString());
  assert.equal((await token.balanceOf(walletAddress) - awardRecoveryBefore).toString(), '0');
  assert.equal((await transferLogs(provider, resources.tokenAddress, treasuryAddress, walletAddress, ethers.parseUnits('10', 18)))
    .filter(item => item.txHash.toLowerCase() === projectionAwardOperation.tx_hash.toLowerCase()).length, 1);
  const awardRepeatResponses = await Promise.all([
    recoverSavedOperation(projectionAwardOperation.operation_key, adminToken),
    recoverSavedOperation(projectionAwardOperation.operation_key, adminToken),
  ]);
  assert.ok(awardRepeatResponses.every(response => response.status >= 200 && response.status < 300),
    `repeated admin award recovery is idempotent: ${JSON.stringify(awardRepeatResponses)}`);
  assert.equal((await token.balanceOf(walletAddress) - awardRecoveryBefore).toString(), '0', 'repeated admin award recovery made no transfer');
  const awardRecoveryAudit = await waitForRecoveryAudit(pool, projectionAwardOperation.operation_key);

  const projectionSpendSession = 'failure-db-spend-projection';
  const projectionSpendRequest = {
    uid: UID,
    amount: 1,
    idempotencyKey: 'failure-db-spend-projection-key',
    sessionId: projectionSpendSession,
    providerId: PROVIDER_ID,
    label: 'failure drill projection spend',
  };
  const spendProjectionTrigger = await installProjectionFailure(pool, 'spends', projectionSpendSession, 'spend');
  const projectionSpendBefore = await token.balanceOf(walletAddress);
  const projectionSpendFirst = await requestJson('/spend', { method: 'POST', body: projectionSpendRequest });
  assert.equal(projectionSpendFirst.status, 202, `spend projection failure: ${JSON.stringify(projectionSpendFirst.body)}`);
  assert.equal(projectionSpendFirst.body.pending, true);
  assert.equal(projectionSpendFirst.body.requiresReview, false);
  assert.ok(projectionSpendFirst.body.txHash);
  const projectionSpendOperation = await readOperationForTuple(pool, 'spend', projectionSpendSession, PROVIDER_ID);
  assert.ok(projectionSpendOperation && projectionSpendOperation.tx_hash);
  assert.equal(await countRows(pool, 'spends', 'session_id', projectionSpendSession), 0);
  await removeProjectionTrigger(pool, spendProjectionTrigger);
  const spendRecoveryBefore = await token.balanceOf(walletAddress);
  const projectionSpendRecovery = await recoverSavedOperation(projectionSpendOperation.operation_key, adminToken);
  const projectionSpendRecoveryBody = assertRecoverySuccess(projectionSpendRecovery, 'admin spend recovery');
  assert.equal(projectionSpendRecoveryBody.projectionStatus, 'projected');
  assert.equal(projectionSpendRecoveryBody.operationKey, projectionSpendOperation.operation_key);
  assert.equal(await countRows(pool, 'spends', 'session_id', projectionSpendSession), 1);
  assert.equal(await countRows(pool, 'spend_receipts', 'token_tx_hash', projectionSpendOperation.tx_hash), 1);
  assert.equal((await readOperation(pool, projectionSpendOperation.operation_key)).status, 'projected');
  assert.equal((projectionSpendBefore - await token.balanceOf(walletAddress)).toString(), ethers.parseUnits('1', 18).toString());
  assert.equal((spendRecoveryBefore - await token.balanceOf(walletAddress)).toString(), '0');
  assert.equal((await transferLogs(provider, resources.tokenAddress, walletAddress, treasuryAddress, ethers.parseUnits('1', 18)))
    .filter(item => item.txHash.toLowerCase() === projectionSpendOperation.tx_hash.toLowerCase()).length, 1);
  const spendRepeatResponses = await Promise.all([
    recoverSavedOperation(projectionSpendOperation.operation_key, adminToken),
    recoverSavedOperation(projectionSpendOperation.operation_key, adminToken),
  ]);
  assert.ok(spendRepeatResponses.every(response => response.status >= 200 && response.status < 300),
    `repeated admin spend recovery is idempotent: ${JSON.stringify(spendRepeatResponses)}`);
  assert.equal((spendRecoveryBefore - await token.balanceOf(walletAddress)).toString(), '0', 'repeated admin spend recovery made no transfer');
  const spendRecoveryAudit = await waitForRecoveryAudit(pool, projectionSpendOperation.operation_key);
  scenarios.push({
    name: 'award_and_spend_projection_failure_after_on_chain_success',
    award: {
      operationKey: projectionAwardOperation.operation_key,
      txHash: projectionAwardOperation.tx_hash,
      firstStatus: projectionAwardFirst.status,
      recoveryStatus: projectionAwardRecovery.status,
      repeatStatuses: awardRepeatResponses.map(response => response.status),
      ledgerRows: 1,
      transferCountForHash: 1,
      balanceDelta: '10.00',
      audit: { eventType: awardRecoveryAudit.event_type, status: awardRecoveryAudit.status },
    },
    spend: {
      operationKey: projectionSpendOperation.operation_key,
      txHash: projectionSpendOperation.tx_hash,
      firstStatus: projectionSpendFirst.status,
      recoveryStatus: projectionSpendRecovery.status,
      repeatStatuses: spendRepeatResponses.map(response => response.status),
      ledgerRows: 1,
      receiptRows: 1,
      transferCountForHash: 1,
      balanceDelta: '-1.00',
      audit: { eventType: spendRecoveryAudit.event_type, status: spendRecoveryAudit.status },
    },
  });

  // 4. Claim locks make concurrent duplicate CDR and manual-spend requests
  // share one operation and one on-chain transfer.
  const concurrentAwardSession = 'failure-concurrent-award';
  const concurrentAwardCdr = failureDrillCdr(concurrentAwardSession);
  const concurrentAwardBefore = await token.balanceOf(walletAddress);
  const concurrentAwardResponses = await Promise.all([
    postIngest(concurrentAwardCdr),
    postIngest(concurrentAwardCdr),
  ]);
  assert.ok(concurrentAwardResponses.every(response => response.status === 200 || response.status === 202), `concurrent award responses: ${JSON.stringify(concurrentAwardResponses)}`);
  for (const response of concurrentAwardResponses.filter(item => item.status === 202)) {
    assert.equal(response.body.pending, true, `concurrent award pending response must be pending: ${JSON.stringify(response.body)}`);
    if (!response.body.txHash) assert.equal(response.body.requiresReview, true, `hashless concurrent award response must require review: ${JSON.stringify(response.body)}`);
  }
  const concurrentAwardHashes = new Set(concurrentAwardResponses.map(response => response.body.txHash).filter(Boolean));
  assert.equal(concurrentAwardHashes.size, 1);
  const concurrentAwardOperation = await waitFor('concurrent award projection', async () => {
    const row = await readOperationForTuple(pool, 'award', concurrentAwardSession, PROVIDER_ID);
    return row && row.status === 'projected' ? row : false;
  });
  assert.equal(await countRows(pool, 'awards', 'session_id', concurrentAwardSession), 1);
  const concurrentAwardAfter = await token.balanceOf(walletAddress);
  assert.equal((concurrentAwardAfter - concurrentAwardBefore).toString(), ethers.parseUnits('10', 18).toString());
  const concurrentAwardHash = concurrentAwardOperation.tx_hash;
  assert.equal([...concurrentAwardHashes][0].toLowerCase(), concurrentAwardHash.toLowerCase());
  assert.equal((await transferLogs(provider, resources.tokenAddress, treasuryAddress, walletAddress, ethers.parseUnits('10', 18)))
    .filter(item => item.txHash.toLowerCase() === concurrentAwardHash.toLowerCase()).length, 1);

  const concurrentSpendSession = 'failure-concurrent-spend';
  const concurrentSpendRequest = {
    uid: UID,
    amount: 2,
    idempotencyKey: 'failure-concurrent-spend-key',
    sessionId: concurrentSpendSession,
    providerId: PROVIDER_ID,
    label: 'failure drill concurrent spend',
  };
  const concurrentSpendBefore = await token.balanceOf(walletAddress);
  const concurrentSpendResponses = await Promise.all([
    requestJson('/spend', { method: 'POST', body: concurrentSpendRequest }),
    requestJson('/spend', { method: 'POST', body: concurrentSpendRequest }),
  ]);
  assert.ok(concurrentSpendResponses.every(response => response.status === 200 || response.status === 202), `concurrent spend responses: ${JSON.stringify(concurrentSpendResponses)}`);
  for (const response of concurrentSpendResponses.filter(item => item.status === 202)) {
    assert.equal(response.body.pending, true, `concurrent spend pending response must be pending: ${JSON.stringify(response.body)}`);
    if (!response.body.txHash) assert.equal(response.body.requiresReview, true, `hashless concurrent spend response must require review: ${JSON.stringify(response.body)}`);
  }
  const concurrentSpendHashes = new Set(concurrentSpendResponses.map(response => response.body.txHash).filter(Boolean));
  assert.equal(concurrentSpendHashes.size, 1);
  const concurrentSpendOperation = await waitFor('concurrent spend projection', async () => {
    const row = await readOperationForTuple(pool, 'spend', concurrentSpendSession, PROVIDER_ID);
    return row && row.status === 'projected' ? row : false;
  });
  assert.equal([...concurrentSpendHashes][0].toLowerCase(), concurrentSpendOperation.tx_hash.toLowerCase());
  assert.equal(await countRows(pool, 'spends', 'session_id', concurrentSpendSession), 1);
  assert.equal(await countRows(pool, 'spend_receipts', 'token_tx_hash', [...concurrentSpendHashes][0]), 1);
  const concurrentSpendAfter = await token.balanceOf(walletAddress);
  assert.equal((concurrentSpendBefore - concurrentSpendAfter).toString(), ethers.parseUnits('2', 18).toString());
  assert.equal((await transferLogs(provider, resources.tokenAddress, walletAddress, treasuryAddress, ethers.parseUnits('2', 18)))
    .filter(item => item.txHash.toLowerCase() === [...concurrentSpendHashes][0].toLowerCase()).length, 1);
  scenarios.push({
    name: 'concurrent_identical_cdr_and_manual_spend_exactly_once',
    award: {
      operationKey: concurrentAwardOperation.operation_key,
      txHash: concurrentAwardHash,
      responseStatuses: concurrentAwardResponses.map(response => response.status),
      ledgerRows: 1,
      transferLogs: 1,
      balanceDelta: '10.00',
    },
    spend: {
      operationKey: concurrentSpendOperation.operation_key,
      txHash: [...concurrentSpendHashes][0],
      responseStatuses: concurrentSpendResponses.map(response => response.status),
      ledgerRows: 1,
      receiptRows: 1,
      transferLogs: 1,
      balanceDelta: '-2.00',
    },
  });

  // 5. Forward a spend broadcast to Hardhat, then hold the JSON-RPC response
  // before the API receives its hash. Hard-stop the API while its durable
  // claim is still submitting/no-hash; restart/retry must remain review-only
  // even though the harness knows the accepted chain hash.
  rpcProxy.setReceiptFailures(0);
  rpcProxy.state.dropBroadcastResponsesRemaining = 0;
  rpcProxy.state.holdBroadcastResponsesRemaining = 1;
  const ambiguityBefore = await token.balanceOf(walletAddress);
  const ambiguityRequest = {
    uid: UID,
    amount: 1,
    idempotencyKey: 'failure-accepted-unknown-spend-key',
    sessionId: 'failure-accepted-unknown-spend',
    providerId: PROVIDER_ID,
    label: 'failure drill accepted unknown spend',
  };
  const broadcastCountBefore = rpcProxy.state.forwardedBroadcastCount;
  const acceptedHashCountBefore = rpcProxy.state.acceptedBroadcastHashes.length;
  await restartApi(treasuryAddress, { rpcUrl: rpcProxy.url });
  let ambiguityFirst;
  const ambiguityRequestPromise = requestJson('/spend', { method: 'POST', body: ambiguityRequest })
    .then(response => { ambiguityFirst = response; return response; })
    .catch(error => { ambiguityFirst = { transportError: error.message }; return ambiguityFirst; });
  const acceptedBroadcast = await waitFor('accepted broadcast before response gate', async () => {
    return rpcProxy.state.acceptedBroadcastHashes.length > acceptedHashCountBefore && rpcProxy.state.heldBroadcastResponse
      ? rpcProxy.state.acceptedBroadcastHashes.at(-1)
      : false;
  }, 15000);
  const ambiguityOperation = await waitFor('ambiguous submitting operation before hard stop', async () => {
    const row = await readOperationForTuple(pool, 'spend', ambiguityRequest.sessionId, PROVIDER_ID);
    return row && row.status === 'submitting' && !row.tx_hash ? row : false;
  }, 15000);
  assert.equal(ambiguityOperation.movement_outcome, 'unknown');
  await hardStopProcess(resources.api);
  resources.api = undefined;
  resources.apiBaseUrl = undefined;
  resources.apiPort = undefined;
  rpcProxy.releaseHeldBroadcast();
  const firstAfterHardStop = await ambiguityRequestPromise;
  assert.ok(firstAfterHardStop.transportError || firstAfterHardStop.status === undefined,
    `accepted broadcast request unexpectedly completed after hard stop: ${JSON.stringify(firstAfterHardStop)}`);
  const acceptedHash = rpcProxy.state.acceptedBroadcastHashes.at(-1);
  assert.equal(acceptedHash, acceptedBroadcast);
  assert.ok(acceptedHash && /^0x[0-9a-f]{64}$/i.test(acceptedHash), 'proxy captured the accepted chain hash');
  assert.equal(rpcProxy.state.forwardedBroadcastCount - broadcastCountBefore, 1, 'ambiguous request broadcast exactly once');
  await waitFor('accepted-unknown chain movement', async () => {
    const balance = await token.balanceOf(walletAddress);
    return balance === ambiguityBefore - ethers.parseUnits('1', 18) ? balance : false;
  });
  const ambiguityAfterBroadcast = await token.balanceOf(walletAddress);
  await restartApi(treasuryAddress, { rpcUrl: rpcProxy.url });
  const ambiguityRetry = await requestJson('/spend', { method: 'POST', body: ambiguityRequest });
  assert.equal(ambiguityRetry.status, 202, `accepted-unknown retry: ${JSON.stringify(ambiguityRetry.body)}`);
  assert.equal(ambiguityRetry.body.requiresReview, true);
  assert.equal(ambiguityRetry.body.txHash, null);
  assert.equal(ambiguityRetry.body.operationStatus, 'submitting');
  assert.equal((await token.balanceOf(walletAddress)).toString(), ambiguityAfterBroadcast.toString());
  assert.equal(rpcProxy.state.forwardedBroadcastCount - broadcastCountBefore, 1, 'ambiguity retry did not broadcast a replacement transfer');
  const ambiguityAfterRetry = await readOperation(pool, ambiguityOperation.operation_key);
  assert.equal(ambiguityAfterRetry.status, 'submitting');
  assert.equal(ambiguityAfterRetry.tx_hash, null);
  assert.equal(await countRows(pool, 'spends', 'session_id', ambiguityRequest.sessionId), 0);
  const ambiguityAdminToken = await loginAdmin();
  const ambiguityRecoveryBefore = await token.balanceOf(walletAddress);
  const ambiguityRecovery = await recoverSavedOperation(ambiguityOperation.operation_key, ambiguityAdminToken);
  assertRecoveryBlocked(ambiguityRecovery, 'hashless accepted-broadcast admin recovery');
  assert.equal((await token.balanceOf(walletAddress)).toString(), ambiguityRecoveryBefore.toString(), 'blocked hashless recovery made no chain movement');
  assert.equal(rpcProxy.state.forwardedBroadcastCount - broadcastCountBefore, 1, 'blocked hashless recovery made no replacement broadcast');
  assert.equal(await countRows(pool, 'spends', 'session_id', ambiguityRequest.sessionId), 0, 'blocked hashless recovery created no spend projection');
  scenarios.push({
    name: 'accepted_broadcast_api_hard_stop_before_hash_persistence_requires_review',
    operationKey: ambiguityOperation.operation_key,
    acceptedChainHashKnownOnlyToHarness: acceptedHash,
    firstResponse: {
      transportError: Boolean(firstAfterHardStop.transportError),
      durableStatusBeforeStop: ambiguityOperation.status,
      durableTxHashBeforeStop: ambiguityOperation.tx_hash,
    },
    retryResponse: {
      status: ambiguityRetry.status,
      operationStatus: ambiguityRetry.body.operationStatus,
      requiresReview: ambiguityRetry.body.requiresReview,
      txHash: ambiguityRetry.body.txHash,
    },
    adminRecovery: {
      status: ambiguityRecovery.status,
      code: ambiguityRecovery.body?.code || null,
      blocked: true,
    },
    databaseSpendRows: 0,
    chainBalanceDelta: '-1.00',
    forwardedBroadcasts: rpcProxy.state.forwardedBroadcastCount - broadcastCountBefore,
  });

  // 6. A saved award snapshot is consumed by the existing direct recovery
  // primitive after the API process restarts. The admin route above is the
  // operator surface; this direct helper remains a primitive-level proof and
  // does not submit a new transfer.
  const snapshotSession = 'failure-saved-award-snapshot';
  const snapshotCdr = failureDrillCdr(snapshotSession);
  const snapshotTrigger = await installProjectionFailure(pool, 'awards', snapshotSession, 'snapshot');
  const snapshotBefore = await token.balanceOf(walletAddress);
  const snapshotFirst = await postIngest(snapshotCdr);
  assert.equal(snapshotFirst.status, 202, `saved snapshot initial response: ${JSON.stringify(snapshotFirst.body)}`);
  const snapshotOperation = await readOperationForTuple(pool, 'award', snapshotSession, PROVIDER_ID);
  assert.ok(snapshotOperation && snapshotOperation.tx_hash);
  assert.ok(snapshotOperation.intent_context
    && snapshotOperation.intent_context.recoverySnapshot
    && snapshotOperation.intent_context.recoverySnapshot.rawCDR,
  'durable award operation retained the raw CDR snapshot');
  await removeProjectionTrigger(pool, snapshotTrigger);
  await restartApi(treasuryAddress);
  const snapshotRecovery = await runLocalRecoveryHelper(snapshotOperation.operation_key, treasuryAddress);
  assert.equal(snapshotRecovery.result.success, true, JSON.stringify(snapshotRecovery));
  assert.equal(snapshotRecovery.result.operationStatus, 'projected');
  assert.equal(snapshotRecovery.result.txHash.toLowerCase(), snapshotOperation.tx_hash.toLowerCase());
  assert.equal(await countRows(pool, 'awards', 'session_id', snapshotSession), 1);
  assert.equal((await readOperation(pool, snapshotOperation.operation_key)).status, 'projected');
  const snapshotAfter = await token.balanceOf(walletAddress);
  assert.equal((snapshotAfter - snapshotBefore).toString(), ethers.parseUnits('10', 18).toString());
  assert.equal((await transferLogs(provider, resources.tokenAddress, treasuryAddress, walletAddress, ethers.parseUnits('10', 18)))
    .filter(item => item.txHash.toLowerCase() === snapshotOperation.tx_hash.toLowerCase()).length, 1);
  scenarios.push({
    name: 'saved_award_snapshot_restart_direct_recovery_primitive',
    operationKey: snapshotOperation.operation_key,
    txHash: snapshotOperation.tx_hash,
    rawSnapshotPersisted: true,
    recoveryHelper: 'scripts/recover-award-operation-local.js',
    recoveryStatus: snapshotRecovery.result.operationStatus,
    transferCountForHash: 1,
    balanceDelta: '10.00',
  });

  const finalLedger = await pool.query(`
    select b.balance, b.total_awarded, b.total_spent
    from balances b join users u on u.id = b.user_id
    where u.uid = $1
  `, [UID]);
  assert.equal(finalLedger.rows.length, 1, 'failure drill has one final balance mirror');
  const startBalanceUnits = ethers.parseUnits(String(drillStartLedger.rows[0].balance), 18);
  const finalBalanceUnits = ethers.parseUnits(String(finalLedger.rows[0].balance), 18);
  const startAwardedUnits = ethers.parseUnits(String(drillStartLedger.rows[0].total_awarded), 18);
  const finalAwardedUnits = ethers.parseUnits(String(finalLedger.rows[0].total_awarded), 18);
  const startSpentUnits = ethers.parseUnits(String(drillStartLedger.rows[0].total_spent), 18);
  const finalSpentUnits = ethers.parseUnits(String(finalLedger.rows[0].total_spent), 18);
  const dbBalanceDelta = finalBalanceUnits - startBalanceUnits;
  const dbProjectedNet = (finalAwardedUnits - startAwardedUnits) - (finalSpentUnits - startSpentUnits);
  const finalUserBalance = await token.balanceOf(walletAddress);
  const finalTreasuryBalance = await token.balanceOf(treasuryAddress);
  const chainUserDelta = finalUserBalance - drillStartUserBalance;
  const chainTreasuryDebit = drillStartTreasuryBalance - finalTreasuryBalance;
  const acceptedUnprojectedAmount = ethers.parseUnits('1', 18);
  assert.equal(dbProjectedNet.toString(), dbBalanceDelta.toString(), 'database balance delta equals projected award/spend net');
  assert.equal((dbBalanceDelta - acceptedUnprojectedAmount).toString(), chainUserDelta.toString(), 'chain balance is lower only by the accepted unprojected spend');
  assert.equal(chainTreasuryDebit.toString(), chainUserDelta.toString(), 'treasury debit equals chain user credit net');
  const ambiguityFinalOperation = await readOperation(pool, ambiguityOperation.operation_key);
  assert.equal(ambiguityFinalOperation.status, 'submitting');
  assert.equal(ambiguityFinalOperation.tx_hash, null);

  return {
    status: 'passed',
    proof: {
      chainId: '31337',
      tokenContractAddress: resources.tokenAddress,
      treasuryAddress,
      walletAddress,
      rpcProxyPort: rpcProxy.port,
    },
    scenarios,
    financialAccounting: {
      startingDatabaseBalance: String(drillStartLedger.rows[0].balance),
      finalDatabaseBalance: String(finalLedger.rows[0].balance),
      projectedDatabaseNetDelta: ethers.formatUnits(dbProjectedNet, 18),
      startingChainUserBalance: ethers.formatUnits(drillStartUserBalance, 18),
      finalChainUserBalance: ethers.formatUnits(finalUserBalance, 18),
      chainUserDelta: ethers.formatUnits(chainUserDelta, 18),
      chainTreasuryDebit: ethers.formatUnits(chainTreasuryDebit, 18),
      acceptedUnprojectedSpend: '1.00',
      databaseToChainGap: ethers.formatUnits(dbBalanceDelta - chainUserDelta, 18),
      ambiguousOperation: {
        operationKey: ambiguityOperation.operation_key,
        status: ambiguityFinalOperation.status,
        txHash: ambiguityFinalOperation.tx_hash,
        ledgerSpendRows: 0,
      },
    },
    limits: [
      'The drill proves local Hardhat/HTTP/DB crash and retry boundaries only; it does not prove Polygon Amoy provider or deployment behaviour.',
      'The accepted-unknown scenario deliberately leaves its durable operation in review with no local spend projection; the chain movement is recorded as harness evidence and is never auto-reconciled.',
    ],
  };
}

function replacementOcpiCdr({
  id,
  sessionId,
  providerId = REPLACEMENT_PROVIDER_ID,
  uid = REPLACEMENT_UID,
  energy = '40',
  evseId = REPLACEMENT_EVSE_ID,
}) {
  return {
    id,
    session_id: sessionId,
    party_id: providerId,
    cdr_location: { evse_id: evseId },
    start_date_time: '2026-02-10T01:00:00Z',
    end_date_time: '2026-02-10T02:00:00Z',
    total_energy: energy,
    cdr_token: { contract_id: uid },
  };
}

function replacementLegacyCdr({ sessionId, providerId = REPLACEMENT_PROVIDER_ID, uid = REPLACEMENT_UID, energy = '40' }) {
  return {
    SessionID: sessionId,
    ProviderID: providerId,
    EVSEID: REPLACEMENT_EVSE_ID,
    'Session Start': '2026-02-11T01:00:00Z',
    'Session End': '2026-02-11T02:00:00Z',
    'Consumed Energy': energy,
    cdr_token: { contract_id: uid },
  };
}

function assertChargingSessionReview(response, label) {
  assert.equal(response.status, 202, `${label}: ${JSON.stringify(response.body)}`);
  assert.equal(response.body.status, 'pending', `${label} status`);
  assert.equal(response.body.code, 'AWARD_CHARGING_SESSION_COLLISION_REVIEW', `${label} code`);
  assert.equal(response.body.pending, true, `${label} pending`);
  assert.equal(response.body.requiresReview, true, `${label} requires review`);
  assert.equal(response.body.retryable, false, `${label} is not retryable automatically`);
  assert.match(response.body.error, /already claimed|replacement award was submitted/i, `${label} user-facing reason`);
  return response.body;
}

async function readReservation(pool, reservationId) {
  const result = await pool.query(`
    select id, uid, session_id, provider_id, reserved_amount, settled_amount,
           released_amount, status, tx_hash
    from spend_reservations where id = $1
  `, [reservationId]);
  assert.equal(result.rows.length, 1, `reservation ${reservationId} exists`);
  return result.rows[0];
}

async function readChargingSessionRows(pool, providerId, chargingSessionId) {
  const result = await pool.query(`
    select operation_key, operation_type, session_id, provider_id, uid, amount,
           charging_session_id, status, tx_hash, movement_outcome
    from token_operations
    where operation_type = 'award' and provider_id = $1 and charging_session_id = $2
    order by created_at, operation_key
  `, [providerId, chargingSessionId]);
  return result.rows;
}

async function runReplacementProtection({ pool, provider, token, treasuryAddress }) {
  const scenarios = [];
  const adminToken = await loginAdmin();
  const walletView = assertHttp(await getIdentityWalletFor(REPLACEMENT_UID), 200, 'replacement wallet lookup');
  const walletAddress = walletView.walletAddress;
  assert.ok(ethers.isAddress(walletAddress), 'replacement managed wallet address is valid');

  // An explicit OCPI id + session_id binds the operation to the physical
  // charging session.  A later CDR id for that same tuple must stop before
  // reservation settlement or a second transfer.
  const physicalSessionId = 'replacement-physical-session-1';
  const firstCdr = replacementOcpiCdr({ id: 'replacement-cdr-a', sessionId: physicalSessionId });
  const firstAward = assertHttp(await postIngest(firstCdr), 200, 'replacement first physical-session award');
  assert.equal(firstAward.status, 'accepted');
  assert.equal(firstAward.tokensAwarded, 10);
  const firstOperation = await waitFor('replacement first physical-session operation', async () => {
    const row = await readOperationForTuple(pool, 'award', firstCdr.id, REPLACEMENT_PROVIDER_ID);
    if (!row) {
      const userRows = await pool.query(`
        select operation_key, operation_type, session_id, provider_id, uid,
               charging_session_id, amount, status, tx_hash
        from token_operations where uid = $1 order by created_at desc limit 5
      `, [REPLACEMENT_UID]);
      if (userRows.rows.length > 0) {
        throw new Error(`replacement tuple lookup missed operation; response=${JSON.stringify(firstAward)} rows=${JSON.stringify(userRows.rows)}`);
      }
    }
    return row || false;
  });
  assert.equal(firstOperation.status, 'projected', `replacement first physical-session operation: ${JSON.stringify(firstOperation)}`);
  assert.equal(firstOperation.charging_session_id, physicalSessionId);
  assert.equal(firstOperation.uid, REPLACEMENT_UID);
  await waitForAllowance(token, walletAddress, treasuryAddress);

  const reservationResponse = assertHttp(await postIdentitySpendFor(REPLACEMENT_UID, {
    sessionId: physicalSessionId,
    providerId: REPLACEMENT_PROVIDER_ID,
    amount: 1,
    label: 'replacement physical-session hold',
  }), 200, 'replacement physical-session reservation');
  assert.equal(reservationResponse.reservation.status, 'reserved');
  const reservationId = reservationResponse.reservation.id;
  const beforeCollisionWallet = await token.balanceOf(walletAddress);
  const beforeCollisionTreasury = await token.balanceOf(treasuryAddress);
  const replacementCdr = replacementOcpiCdr({ id: 'replacement-cdr-b', sessionId: physicalSessionId });
  const replacementResponse = await postIngest(replacementCdr);
  assertChargingSessionReview(replacementResponse, 'same provider/session replacement');
  assert.equal((await token.balanceOf(walletAddress)).toString(), beforeCollisionWallet.toString(), 'replacement did not move user tokens');
  assert.equal((await token.balanceOf(treasuryAddress)).toString(), beforeCollisionTreasury.toString(), 'replacement did not move treasury tokens');
  const heldReservation = await readReservation(pool, reservationId);
  assert.equal(heldReservation.status, 'reserved', 'replacement did not settle the existing reservation');
  const physicalRowsAfterCollision = await readChargingSessionRows(pool, REPLACEMENT_PROVIDER_ID, physicalSessionId);
  assert.equal(physicalRowsAfterCollision.length, 1, 'replacement did not create a second physical-session claim');

  // Retrying the original CDR remains the recovery path.  It can settle the
  // original reservation because the durable claim is an exact replay.
  const originalReplay = assertHttp(await postIngest(firstCdr), 200, 'original physical-session replay');
  assert.equal(originalReplay.status, 'duplicate');
  assert.equal(originalReplay.reservationSettlement.status, 'settled');
  const settledReservation = await readReservation(pool, reservationId);
  assert.equal(settledReservation.status, 'settled', 'original replay settled the original reservation');
  scenarios.push({
    name: 'same_provider_physical_session_replacement_requires_review',
    originalOperationKey: firstOperation.operation_key,
    chargingSessionId: physicalSessionId,
    replacement: {
      cdrId: replacementCdr.id,
      status: replacementResponse.status,
      code: replacementResponse.body.code,
      noAdditionalOperation: physicalRowsAfterCollision.length === 1,
      reservationStatusDuringReview: heldReservation.status,
    },
    originalReplay: {
      status: originalReplay.status,
      reservationStatus: settledReservation.status,
    },
  });

  // Neither changed energy nor changed eMAID can bypass the physical-session
  // claim.  These attempts occur after the original replay, so there is no
  // reservation state left to hide a replacement debit.
  const beforeMismatchWallet = await token.balanceOf(walletAddress);
  const beforeMismatchTreasury = await token.balanceOf(treasuryAddress);
  const energyMismatch = await postIngest(replacementOcpiCdr({
    id: 'replacement-cdr-energy-mismatch',
    sessionId: physicalSessionId,
    energy: '20',
  }));
  assertChargingSessionReview(energyMismatch, 'changed-energy replacement');
  const ownerMismatch = await postIngest(replacementOcpiCdr({
    id: 'replacement-cdr-owner-mismatch',
    sessionId: physicalSessionId,
    uid: REPLACEMENT_UID_ALT,
  }));
  assertChargingSessionReview(ownerMismatch, 'changed-eMAID replacement');
  const mixedIdentityReplacement = replacementOcpiCdr({
    id: 'replacement-cdr-mixed-identity',
    sessionId: physicalSessionId,
  });
  mixedIdentityReplacement.Identification = {
    RemoteIdentification: { EvcoID: REPLACEMENT_UID },
  };
  const mixedIdentityResponse = await postIngest(mixedIdentityReplacement);
  assertChargingSessionReview(mixedIdentityResponse, 'mixed OCPI/OICP replacement');
  assert.equal(mixedIdentityResponse.body.normalisation.protocol, 'MIXED', 'mixed replacement remains diagnosable as MIXED');
  assert.equal((await token.balanceOf(walletAddress)).toString(), beforeMismatchWallet.toString(), 'mismatch replacements did not move original wallet tokens');
  assert.equal((await token.balanceOf(treasuryAddress)).toString(), beforeMismatchTreasury.toString(), 'mismatch replacements did not move treasury tokens');
  assert.equal((await readChargingSessionRows(pool, REPLACEMENT_PROVIDER_ID, physicalSessionId)).length, 1, 'mismatch replacements did not create claims');
  scenarios.push({
    name: 'changed_energy_or_emaid_cannot_bypass_physical_session_guard',
    chargingSessionId: physicalSessionId,
    changedEnergy: { status: energyMismatch.status, code: energyMismatch.body.code },
    changedEmaid: { status: ownerMismatch.status, code: ownerMismatch.body.code },
    mixedIdentity: {
      status: mixedIdentityResponse.status,
      code: mixedIdentityResponse.body.code,
      protocol: mixedIdentityResponse.body.normalisation.protocol,
    },
    operationCount: 1,
  });

  // Provider identity is part of the guard tuple, and an explicit new
  // physical session is a new claim.  Both are allowed to award once.
  const differentProviderSession = replacementOcpiCdr({
    id: 'replacement-different-provider',
    sessionId: physicalSessionId,
    providerId: REPLACEMENT_PROVIDER_ALT_ID,
  });
  const differentProviderResponse = assertHttp(await postIngest(differentProviderSession), 200, 'different provider award');
  assert.equal(differentProviderResponse.status, 'accepted');
  const differentProviderOperation = await waitFor('different provider operation', async () => {
    const row = await readOperationForTuple(pool, 'award', differentProviderSession.id, REPLACEMENT_PROVIDER_ALT_ID);
    return row || false;
  });
  assert.equal(differentProviderOperation.status, 'projected', `different provider operation: ${JSON.stringify(differentProviderOperation)}`);
  assert.equal(differentProviderOperation.charging_session_id, physicalSessionId);

  const newPhysicalSessionId = 'replacement-physical-session-2';
  const differentSessionCdr = replacementOcpiCdr({
    id: 'replacement-different-session',
    sessionId: newPhysicalSessionId,
  });
  const differentSessionResponse = assertHttp(await postIngest(differentSessionCdr), 200, 'different physical session award');
  assert.equal(differentSessionResponse.status, 'accepted');
  const differentSessionOperation = await waitFor('different physical session operation', async () => {
    const row = await readOperationForTuple(pool, 'award', differentSessionCdr.id, REPLACEMENT_PROVIDER_ID);
    return row || false;
  });
  assert.equal(differentSessionOperation.status, 'projected', `different physical session operation: ${JSON.stringify(differentSessionOperation)}`);
  assert.equal(differentSessionOperation.charging_session_id, newPhysicalSessionId);
  scenarios.push({
    name: 'different_provider_or_real_physical_session_allowed',
    differentProvider: {
      providerId: REPLACEMENT_PROVIDER_ALT_ID,
      chargingSessionId: physicalSessionId,
      operationKey: differentProviderOperation.operation_key,
    },
    differentPhysicalSession: {
      providerId: REPLACEMENT_PROVIDER_ID,
      chargingSessionId: newPhysicalSessionId,
      operationKey: differentSessionOperation.operation_key,
    },
  });

  // The guard is intentionally forward-only.  Legacy/flat payloads without
  // explicit OCPI id + session_id remain unbound and retain their existing
  // SessionID/provider deduplication behaviour.
  const legacyA = assertHttp(await postIngest(replacementLegacyCdr({ sessionId: 'replacement-legacy-a' })), 200, 'legacy unbound award A');
  const legacyB = assertHttp(await postIngest(replacementLegacyCdr({ sessionId: 'replacement-legacy-b' })), 200, 'legacy unbound award B');
  assert.equal(legacyA.status, 'accepted');
  assert.equal(legacyB.status, 'accepted');
  const legacyOperationA = await readOperationForTuple(pool, 'award', 'replacement-legacy-a', REPLACEMENT_PROVIDER_ID);
  const legacyOperationB = await readOperationForTuple(pool, 'award', 'replacement-legacy-b', REPLACEMENT_PROVIDER_ID);
  assert.ok(legacyOperationA && legacyOperationB);
  assert.equal(legacyOperationA.charging_session_id, null, 'legacy A remains unbound');
  assert.equal(legacyOperationB.charging_session_id, null, 'legacy B remains unbound');
  scenarios.push({
    name: 'missing_physical_session_retains_legacy_behavior',
    operationKeys: [legacyOperationA.operation_key, legacyOperationB.operation_key],
    chargingSessionIds: [legacyOperationA.charging_session_id, legacyOperationB.charging_session_id],
    bothAccepted: true,
  });

  // Concurrent distinct CDR ids contend on the same PostgreSQL advisory lock
  // and partial unique index.  Exactly one request may reach the chain.
  const concurrentProviderId = 'local-replacement-provider-concurrent';
  const concurrentSessionId = 'replacement-concurrent-session';
  const concurrentBefore = await token.balanceOf(walletAddress);
  const concurrentCdrA = replacementOcpiCdr({ id: 'replacement-concurrent-a', sessionId: concurrentSessionId, providerId: concurrentProviderId });
  const concurrentCdrB = replacementOcpiCdr({ id: 'replacement-concurrent-b', sessionId: concurrentSessionId, providerId: concurrentProviderId });
  const [concurrentA, concurrentB] = await Promise.all([
    postIngest(concurrentCdrA),
    postIngest(concurrentCdrB),
  ]);
  const concurrentResponses = [concurrentA, concurrentB];
  const concurrentAccepted = concurrentResponses.filter(response => response.status === 200);
  const concurrentReview = concurrentResponses.filter(response => response.status === 202);
  assert.equal(concurrentAccepted.length, 1, `concurrent requests accepted exactly once: ${JSON.stringify(concurrentResponses)}`);
  assert.equal(concurrentReview.length, 1, `concurrent requests reviewed exactly once: ${JSON.stringify(concurrentResponses)}`);
  assert.equal(concurrentAccepted[0].body.status, 'accepted');
  assertChargingSessionReview(concurrentReview[0], 'concurrent replacement');
  const concurrentRows = await waitFor('concurrent physical-session projection', async () => {
    const rows = await readChargingSessionRows(pool, concurrentProviderId, concurrentSessionId);
    return rows.length === 1 && rows[0].status === 'projected' ? rows : false;
  });
  const concurrentOperation = concurrentRows[0];
  assert.equal(concurrentRows.length, 1, 'concurrent requests create one durable physical-session claim');
  const concurrentAwardRows = await pool.query(`
    select session_id, provider_id, tx_hash from awards
    where provider_id = $1 and session_id in ($2, $3)
  `, [concurrentProviderId, concurrentCdrA.id, concurrentCdrB.id]);
  assert.equal(concurrentAwardRows.rows.length, 1, 'concurrent requests create one award projection');
  const concurrentAfter = await token.balanceOf(walletAddress);
  assert.equal((concurrentAfter - concurrentBefore).toString(), ethers.parseUnits('10', 18).toString(), 'concurrent requests move one award');
  const concurrentTransfers = (await transferLogs(
    provider,
    resources.tokenAddress,
    treasuryAddress,
    walletAddress,
    ethers.parseUnits('10', 18),
  )).filter(item => item.txHash.toLowerCase() === concurrentOperation.tx_hash.toLowerCase());
  assert.equal(concurrentTransfers.length, 1, 'concurrent requests create one chain transfer');
  scenarios.push({
    name: 'concurrent_different_ids_one_physical_claim_and_transfer',
    providerId: concurrentProviderId,
    chargingSessionId: concurrentSessionId,
    responseStatuses: concurrentResponses.map(response => response.status).sort((a, b) => a - b),
    operationKey: concurrentOperation.operation_key,
    operationCount: concurrentRows.length,
    awardProjectionCount: 1,
    transferCountForHash: concurrentTransfers.length,
  });

  // A zero-award claim still owns the physical session.  A later eligible
  // replacement cannot turn that no-movement decision into a reward.
  const zeroProviderId = 'local-replacement-provider-zero';
  const zeroSessionId = 'replacement-zero-session';
  const zeroBefore = await token.balanceOf(walletAddress);
  const zeroFirstCdr = replacementOcpiCdr({
    id: 'replacement-zero-a',
    sessionId: zeroSessionId,
    providerId: zeroProviderId,
    energy: '0',
  });
  const zeroFirst = assertHttp(await postIngest(zeroFirstCdr), 200, 'zero-award first claim');
  assert.equal(zeroFirst.status, 'accepted');
  assert.equal(zeroFirst.tokensAwarded, 0);
  const zeroOperation = await waitFor('zero-award physical-session operation', async () => {
    const row = await readOperationForTuple(pool, 'award', zeroFirstCdr.id, zeroProviderId);
    return row || false;
  });
  assert.equal(zeroOperation.status, 'projected', `zero-award physical-session operation: ${JSON.stringify(zeroOperation)}`);
  assert.equal(zeroOperation.amount, '0.00');
  assert.equal(zeroOperation.charging_session_id, zeroSessionId);
  const zeroRecoveryBefore = await token.balanceOf(walletAddress);
  const zeroRecovery = await recoverSavedOperation(zeroOperation.operation_key, adminToken);
  assertRecoveryBlocked(zeroRecovery, 'zero-award admin recovery');
  assert.equal((await token.balanceOf(walletAddress)).toString(), zeroRecoveryBefore.toString(), 'zero-award recovery made no chain movement');
  const zeroReplacement = await postIngest(replacementOcpiCdr({
    id: 'replacement-zero-b',
    sessionId: zeroSessionId,
    providerId: zeroProviderId,
    energy: '40',
  }));
  assertChargingSessionReview(zeroReplacement, 'zero-award replacement');
  assert.equal((await token.balanceOf(walletAddress)).toString(), zeroBefore.toString(), 'zero-award replacement moved no tokens');
  assert.equal((await readChargingSessionRows(pool, zeroProviderId, zeroSessionId)).length, 1, 'zero-award replacement created no second claim');
  scenarios.push({
    name: 'zero_award_claim_blocks_later_replacement_reward',
    operationKey: zeroOperation.operation_key,
    firstAmount: zeroOperation.amount,
    adminRecovery: {
      status: zeroRecovery.status,
      code: zeroRecovery.body?.code || null,
      blocked: true,
    },
    replacementStatus: zeroReplacement.status,
    replacementCode: zeroReplacement.body.code,
    operationCount: 1,
  });

  return {
    status: 'passed',
    guard: {
      column: 'token_operations.charging_session_id',
      key: 'provider_id + charging_session_id',
      originalEmaid: REPLACEMENT_UID,
    },
    scenarios,
  };
}

async function runFlow() {
  await startDatabase();
  const { provider, hardhat } = await startHardhat();
  const deployment = await deployToken(provider);
  const { token, treasurySigner, treasuryAddress } = deployment;
  const initialUser = await token.balanceOf(ethers.ZeroAddress);
  const initialTreasury = await token.balanceOf(treasuryAddress);
  const alertWebhook = await startAlertWebhook();
  const apiOptions = { adminAlertWebhookUrl: alertWebhook.url };
  await startApi(treasuryAddress, apiOptions);

  const pool = new Pool({ connectionString: resources.databaseUrl, max: 4, connectionTimeoutMillis: 5000 });
  try {
    const authAndIdentity = await runAuthAndIdentityChecks();
    const protocolIdentityMatrix = await runProtocolIdentityMatrix();
    const policyPersistence = await runPolicyPersistenceCheck(treasuryAddress, apiOptions);
    const initialCdr = {
      SessionID: 'local-award-1',
      ProviderID: PROVIDER_ID,
      EVSEID: EVSE_ID,
      'Session Start': '2026-01-01T01:00:00Z',
      'Session End': '2026-01-01T02:00:00Z',
      'Consumed Energy': '40',
      cdr_token: { contract_id: UID },
    };
    const initialAward = assertHttp(await postIngest(initialCdr), 200, 'initial award');
    assert.equal(initialAward.tokensAwarded, 10);
    assert.equal(initialAward.status, 'accepted');
    assert.ok(initialAward.txHash);

    const walletView = assertHttp(await getIdentityWallet(), 200, 'wallet lookup');
    const walletAddress = walletView.walletAddress;
    assert.ok(ethers.isAddress(walletAddress), 'managed wallet address is valid');
    await waitForAllowance(token, walletAddress, treasuryAddress);

    const spendKeyValidation = await runSpendKeyValidation({
      pool,
      provider,
      tokenAddress: resources.tokenAddress,
      token,
      walletAddress,
      treasuryAddress,
    });

    const chargingReservation = assertHttp(await postIdentitySpend({
      sessionId: 'reservation-session-charge',
      providerId: PROVIDER_ID,
      amount: 6,
      label: 'local charging reservation',
    }), 200, 'charging reservation');
    assert.equal(chargingReservation.reservation.status, 'reserved');
    const chargingReservationId = chargingReservation.reservation.id;
    const chargingReservationStatus = assertHttp(await getReservationStatusFor(UID, chargingReservationId), 200, 'charging reservation status');
    assert.equal(chargingReservationStatus.status, 'reserved');
    assert.equal(chargingReservationStatus.reservationId, chargingReservationId);
    assert.equal(chargingReservationStatus.sessionId, 'reservation-session-charge');
    const chargingReservationWrongIdentity = await getReservationStatusFor(REPLACEMENT_UID, chargingReservationId);
    assert.equal(chargingReservationWrongIdentity.status, 404, 'reservation status is scoped to the owning eMAID');
    const chargingReservationReplay = assertHttp(await postIdentitySpend({
      sessionId: 'reservation-session-charge',
      providerId: PROVIDER_ID,
      amount: 6,
      label: 'local charging reservation replay',
    }), 200, 'charging reservation replay');
    assert.equal(chargingReservationReplay.reservation.id, chargingReservationId, 'reservation replay returns the original reservation');
    assert.equal(chargingReservationReplay.reservation.status, 'reserved');

    await installReceiptFailure(pool);
    const finalChargingCdr = {
      id: 'cdr-charge-1',
      session_id: 'reservation-session-charge',
      party_id: PROVIDER_ID,
      cdr_location: { evse_id: EVSE_ID },
      start_date_time: '2026-01-02T01:00:00Z',
      end_date_time: '2026-01-02T02:00:00Z',
      total_energy: '5',
      cdr_token: { contract_id: UID },
    };
    const firstSettlementResponse = await postIngest(finalChargingCdr);
    assert.equal(firstSettlementResponse.status, 202, `injected receipt failure response: ${JSON.stringify(firstSettlementResponse.body)}`);
    assert.equal(firstSettlementResponse.body.pending, true);
    assert.equal(firstSettlementResponse.body.requiresReview, false);
    assert.equal(firstSettlementResponse.body.financialStatus, 'confirmed');
    assert.equal(firstSettlementResponse.body.reservationId, chargingReservationId);
    assert.ok(firstSettlementResponse.body.reservationTxHash);
    await removeReceiptFailure(pool);
    await assertReceiptFailureRemoved(pool);

    const beforeChargingReplay = {
      user: await token.balanceOf(walletAddress),
      treasury: await token.balanceOf(treasuryAddress),
    };
    const chargingReplay = assertHttp(await postIngest(finalChargingCdr), 200, 'charging CDR recovery');
    assert.equal(chargingReplay.status, 'duplicate');
    assert.equal(chargingReplay.tokensAwarded, 1, 'whole-token award flooring is preserved');
    assert.equal(chargingReplay.reservationSettlement.status, 'settled');
    assert.ok(chargingReplay.reservationSettlement.spendReceipt);
    const chargingReceipt = chargingReplay.reservationSettlement.spendReceipt;
    const settledReservationStatus = assertHttp(await getReservationStatusFor(UID, chargingReservationId), 200, 'settled reservation status');
    assert.equal(settledReservationStatus.status, 'settled');
    assert.equal(settledReservationStatus.receiptStatus, 'settled');
    assert.equal(settledReservationStatus.spendReceipt.payload.receiptId, chargingReceipt.payload.receiptId);
    assert.equal((await token.balanceOf(walletAddress)).toString(), beforeChargingReplay.user.toString(), 'charging replay made no user transfer');
    assert.equal((await token.balanceOf(treasuryAddress)).toString(), beforeChargingReplay.treasury.toString(), 'charging replay made no treasury transfer');

    const chargingReceiptVerification = assertHttp(await requestJson('/spend-receipts/verify', {
      method: 'POST',
      body: {
        payload: chargingReceipt.payload,
        signature: chargingReceipt.signature,
        signerAddress: chargingReceipt.signerAddress,
      },
    }), 200, 'charging receipt verification');
    assert.equal(chargingReceiptVerification.valid, true);

    const beforeChargingPostRecoveryReplay = {
      user: await token.balanceOf(walletAddress),
      treasury: await token.balanceOf(treasuryAddress),
    };
    const chargingPostRecoveryReplay = assertHttp(await postIngest(finalChargingCdr), 200, 'charging CDR post-recovery replay');
    assert.equal(chargingPostRecoveryReplay.status, 'duplicate');
    assert.equal(chargingPostRecoveryReplay.reservationSettlement.spendReceipt.payload.receiptId, chargingReceipt.payload.receiptId);
    assert.equal(chargingPostRecoveryReplay.reservationSettlement.spendReceipt.payload.tokenTxHash, chargingReceipt.payload.tokenTxHash);
    assert.equal(chargingPostRecoveryReplay.reservationSettlement.reservation_tx_hash || chargingPostRecoveryReplay.reservationSettlement.tx_hash, chargingReplay.reservationSettlement.tx_hash);
    assert.equal((await token.balanceOf(walletAddress)).toString(), beforeChargingPostRecoveryReplay.user.toString(), 'post-recovery charging replay made no user transfer');
    assert.equal((await token.balanceOf(treasuryAddress)).toString(), beforeChargingPostRecoveryReplay.treasury.toString(), 'post-recovery charging replay made no treasury transfer');

    const manualSpendRequest = {
      uid: UID,
      amount: 1,
      idempotencyKey: 'local-manual-spend-1',
      sessionId: 'manual-session',
      providerId: PROVIDER_ID,
      label: 'local manual spend',
    };
    const manualSpend = assertHttp(await requestJson('/spend', { method: 'POST', body: manualSpendRequest }), 200, 'manual spend');
    assert.equal(manualSpend.tokensSpent, 1);
    assert.ok(manualSpend.operationKey);
    assert.ok(manualSpend.spendReceipt);
    const beforeManualReplay = {
      user: await token.balanceOf(walletAddress),
      treasury: await token.balanceOf(treasuryAddress),
    };
    const manualReplay = assertHttp(await requestJson('/spend', { method: 'POST', body: manualSpendRequest }), 200, 'manual spend replay');
    assert.equal(manualReplay.txHash, manualSpend.txHash);
    assert.equal(manualReplay.spendReceipt.payload.receiptId, manualSpend.spendReceipt.payload.receiptId);
    assert.equal((await token.balanceOf(walletAddress)).toString(), beforeManualReplay.user.toString(), 'manual replay made no user transfer');
    assert.equal((await token.balanceOf(treasuryAddress)).toString(), beforeManualReplay.treasury.toString(), 'manual replay made no treasury transfer');

    const dischargeReservation = assertHttp(await postIdentitySpend({
      sessionId: 'reservation-session-discharge',
      providerId: PROVIDER_ID,
      amount: 5,
      label: 'local discharge reservation',
    }), 200, 'discharge reservation');
    assert.equal(dischargeReservation.reservation.status, 'reserved');
    const beforeDischarge = await token.balanceOf(walletAddress);
    const dischargeCdr = {
      id: 'cdr-discharge-1',
      session_id: 'reservation-session-discharge',
      party_id: PROVIDER_ID,
      cdr_location: { evse_id: EVSE_ID },
      start_date_time: '2026-01-03T01:00:00Z',
      end_date_time: '2026-01-03T02:00:00Z',
      total_energy: '-15',
      cdr_token: { contract_id: UID },
    };
    const discharge = assertHttp(await postIngest(dischargeCdr), 200, 'negative-energy discharge');
    assert.equal(discharge.tokensAwarded, 15);
    assert.equal(discharge.reservationSettlement.status, 'released');
    assert.equal(Number(discharge.reservationSettlement.settled_amount || 0), 0);
    assert.equal((await token.balanceOf(walletAddress) - beforeDischarge).toString(), ethers.parseUnits('15', 18).toString(), 'discharge only awards; it does not debit the hold');
    const releasedReservationStatus = assertHttp(await getReservationStatusFor(UID, dischargeReservation.reservation.id), 200, 'released reservation status');
    assert.equal(releasedReservationStatus.status, 'released');
    assert.equal(releasedReservationStatus.receiptStatus, 'none');

    const beforeDischargeReplay = await token.balanceOf(walletAddress);
    const dischargeReplay = assertHttp(await postIngest(dischargeCdr), 200, 'discharge replay');
    assert.equal(dischargeReplay.status, 'duplicate');
    assert.equal((await token.balanceOf(walletAddress)).toString(), beforeDischargeReplay.toString(), 'discharge replay made no transfer');

    const adminOperational = await runAdminOperationalChecks();

    const evidence = await queryEvidence(pool, token, walletAddress, treasuryAddress, initialUser, initialTreasury);
    const linkedCustodial = await runLinkedCustodialChecks({
      pool,
      provider,
      token,
      treasurySigner,
      treasuryAddress,
    });
    const backupRestore = await runDisposableBackupRestore(pool);
    const failureDrill = await runFailureDrill({ pool, provider, token, treasuryAddress, walletAddress });
    const replacementProtection = await runReplacementProtection({ pool, provider, token, treasuryAddress });
    return {
      status: 'passed',
      command: 'node scripts/verify-local-award-flow.js',
      handles: {
        databaseContainer: DB_CONTAINER,
        databaseName: DB_NAME,
        hardhatPort: resources.hardhatPort,
        apiPort: resources.apiPort,
      },
      schemaActivation: resources.schemaActivation,
      deployment: {
        chainId: '31337',
        tokenContractAddress: resources.tokenAddress,
        treasuryAddress,
        awardTxHashes: [initialAward.txHash, chargingReplay.awardTxHash, discharge.txHash],
        spendTxHashes: [chargingReceipt.payload.tokenTxHash, manualSpend.txHash],
      },
      evidence,
      linkedCustodial,
      backupRestore,
      authAndIdentity,
      protocolIdentityMatrix,
      policyPersistence,
      reservationLifecycle: {
        charging: {
          initialStatus: chargingReservationStatus.status,
          wrongIdentityStatus: chargingReservationWrongIdentity.status,
          finalStatus: settledReservationStatus.status,
          finalReceiptStatus: settledReservationStatus.receiptStatus,
        },
        discharge: {
          finalStatus: releasedReservationStatus.status,
          finalReceiptStatus: releasedReservationStatus.receiptStatus,
        },
      },
      adminOperational,
      spendKeyValidation,
      failureDrill,
      replacementProtection,
    };
  } finally {
    await removeReceiptFailure(pool).catch(() => undefined);
    await removeAllProjectionTriggers(pool).catch(() => undefined);
    await pool.end();
  }
}

async function cleanup() {
  if (resources.rpcProxy) await resources.rpcProxy.close().catch(() => undefined);
  if (resources.alertWebhook) await resources.alertWebhook.close().catch(() => undefined);
  for (const child of [...children]) {
    await hardStopProcess(child);
  }
  if (resources.dbPort) {
    await runCommand('docker', ['rm', '-f', DB_CONTAINER]).catch(() => undefined);
  }
  const expectedHardhatDir = path.join(APP_ROOT, `.codex-hardhat-${HARNESS_ID}`);
  if (resources.hardhatConfigPath) {
    const resolvedConfig = path.resolve(resources.hardhatConfigPath);
    const expectedConfig = path.join(expectedHardhatDir, 'hardhat.config.ts');
    if (resolvedConfig !== expectedConfig) {
      throw new Error(`refusing to remove unexpected Hardhat config path: ${resolvedConfig}`);
    }
    try { fs.rmSync(resolvedConfig, { force: true }); } catch { /* cleanup only */ }
  }
  if (resources.hardhatProjectDir) {
    const resolvedDir = path.resolve(resources.hardhatProjectDir);
    if (resolvedDir !== expectedHardhatDir
      || !resolvedDir.startsWith(APP_ROOT + path.sep)
      || !path.basename(resolvedDir).startsWith('.codex-hardhat-')) {
      throw new Error(`refusing to recursively remove unexpected Hardhat temp directory: ${resolvedDir}`);
    }
    try { fs.rmSync(resolvedDir, { recursive: true, force: true }); } catch { /* cleanup only */ }
  }
}

async function main() {
  try {
    const result = await runFlow();
    const evidenceDir = path.join(APP_ROOT, 'outputs', 'failure-drill');
    fs.mkdirSync(evidenceDir, { recursive: true });
    const evidencePath = path.join(evidenceDir, `failure-drill-${HARNESS_ID}.json`);
    result.evidencePath = evidencePath;
    fs.writeFileSync(evidencePath, JSON.stringify(result, null, 2), 'utf8');
    if (result.replacementProtection) {
      const replacementEvidenceDir = path.join(APP_ROOT, 'outputs', 'replacement-cdr');
      fs.mkdirSync(replacementEvidenceDir, { recursive: true });
      const replacementEvidencePath = path.join(replacementEvidenceDir, `replacement-cdr-${HARNESS_ID}.json`);
      result.replacementProtection.evidencePath = replacementEvidencePath;
      fs.writeFileSync(replacementEvidencePath, JSON.stringify(result.replacementProtection, null, 2), 'utf8');
      // Rewrite the combined evidence after adding the focused report path.
      fs.writeFileSync(evidencePath, JSON.stringify(result, null, 2), 'utf8');
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await cleanup();
  }
}

module.exports = {
  startDatabase,
  startHardhat,
  deployToken,
  startApi,
  stopApi,
  startAlertWebhook,
  cleanup,
  runFlow,
  resources,
  postIngest,
  requestJson,
  requestAdminJson,
  loginAdmin,
  getIdentityWallet,
  getIdentityWalletFor,
  postIdentitySpendFor,
  getReservationStatusFor,
  assertHttp,
  API_KEY,
  ADMIN_EMAIL,
  ADMIN_PASSWORD,
  INGEST_API_KEY,
  UID,
  PROVIDER_ID,
  EVSE_ID,
};

if (require.main === module) {
  main().catch(error => {
    const diagnostics = {
      status: 'failed',
      error: error && error.message ? error.message : String(error),
      resources: {
        database: resources.databaseUrl ? { host: '127.0.0.1', port: resources.dbPort, name: DB_NAME } : undefined,
        hardhatPort: resources.hardhatPort,
        apiPort: resources.apiPort,
        rpcProxyPort: resources.rpcProxyPort,
        tokenAddress: resources.tokenAddress,
        hardhat: resources.hardhat ? resources.hardhat.__output() : undefined,
        api: resources.api ? resources.api.__output() : undefined,
      },
    };
    console.error(JSON.stringify(diagnostics, null, 2));
    process.exitCode = 1;
  });
}
