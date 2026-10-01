/*
 * Run the opt-in PostgreSQL Jest suites against a disposable local container.
 * This runner refuses to use the dashboard database by construction: it creates
 * a unique nvf_award_test_* database name and passes that URL only through the
 * explicit test-only environment variables.
 */
'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');

const APP_ROOT = path.resolve(__dirname, '..');
const OUTPUT_DIR = path.join(APP_ROOT, 'outputs');
const RUN_ID = `${process.pid}_${Date.now().toString(36)}`.replace(/[^a-zA-Z0-9_-]/g, '_');
const DB_NAME = `nvf_award_test_${RUN_ID}`.toLowerCase();
const DB_CONTAINER = `nvf-award-postgres-test-${RUN_ID}`.replace(/[^a-zA-Z0-9_.-]/g, '_');
const DB_USER = 'postgres';
const DB_PASSWORD = 'postgres';
const children = new Set();
let dbPort;

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = address && typeof address === 'object' ? address.port : undefined;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function spawnSpec(command, args) {
  if (process.platform === 'win32' && /\.cmd$/i.test(command)) {
    const quote = value => {
      const text = String(value);
      return /[\s&()]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
    };
    return { command: quote(command), args: args.map(quote), shell: true };
  }
  return { command, args, shell: false };
}

function stopChild(child) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        resolve();
      }
    };
    child.once('exit', finish);
    if (process.platform === 'win32' && child.pid) {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.once('exit', () => undefined);
    } else {
      child.kill('SIGTERM');
    }
    setTimeout(finish, 5000).unref();
  });
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const spec = spawnSpec(command, args);
    const child = spawn(spec.command, spec.args, {
      cwd: options.cwd || APP_ROOT,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: spec.shell,
    });
    children.add(child);
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    const timeoutMs = options.timeoutMs || 120_000;
    const timeout = setTimeout(async () => {
      await stopChild(child);
      if (!settled) {
        settled = true;
        reject(new Error(`${command} timed out after ${timeoutMs}ms\n${stderr.slice(-8000)}`));
      }
    }, timeoutMs);
    child.once('error', error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      children.delete(child);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      children.delete(child);
      const output = { code, signal, stdout: stdout.slice(-20000), stderr: stderr.slice(-20000) };
      if (code === 0) resolve(output);
      else reject(Object.assign(new Error(`${command} exited ${code ?? signal}`), { output }));
    });
  });
}

async function waitForDatabase(databaseUrl) {
  const deadline = Date.now() + 90_000;
  let lastError;
  while (Date.now() < deadline) {
    const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 2000 });
    try {
      await pool.query('select 1');
      return;
    } catch (error) {
      lastError = error;
    } finally {
      await pool.end().catch(() => undefined);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`disposable PostgreSQL did not become ready: ${lastError?.message || 'timeout'}`);
}

async function removeContainer() {
  await runCommand('docker', ['rm', '-f', DB_CONTAINER], { timeoutMs: 30_000 }).catch(() => undefined);
}

async function main() {
  const evidence = {
    status: 'failed',
    command: 'node scripts/run-disposable-postgres-tests.js',
    database: { host: '127.0.0.1', name: DB_NAME, container: DB_CONTAINER },
    suites: [
      'src/database/tokenOperationSchema.test.ts',
      'src/config/policyPersistence.postgres.test.ts',
    ],
  };
  try {
    dbPort = await getFreePort();
    const databaseUrl = `postgres://${DB_USER}:${DB_PASSWORD}@127.0.0.1:${dbPort}/${DB_NAME}`;
    if (!/^postgres:\/\/[^@]+@127\.0\.0\.1:\d+\/nvf_award_test_[a-z0-9_-]+$/i.test(databaseUrl)) {
      throw new Error('refusing to start a non-disposable database target');
    }

    await runCommand('docker', [
      'run', '--rm', '--name', DB_CONTAINER, '-d',
      '-e', `POSTGRES_USER=${DB_USER}`,
      '-e', `POSTGRES_PASSWORD=${DB_PASSWORD}`,
      '-e', `POSTGRES_DB=${DB_NAME}`,
      '-p', `127.0.0.1:${dbPort}:5432`,
      'postgres:16-alpine',
    ], { timeoutMs: 60_000 });
    await waitForDatabase(databaseUrl);
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const test = await runCommand(npmCommand, [
      'test', '--', '--runInBand',
      'src/database/tokenOperationSchema.test.ts',
      'src/config/policyPersistence.postgres.test.ts',
    ], {
      env: {
        ...process.env,
        RUN_LOCAL_SCHEMA_TESTS: '1',
        RUN_LOCAL_POLICY_TESTS: '1',
        SCHEMA_DATABASE_URL: databaseUrl,
        POLICY_DATABASE_URL: databaseUrl,
        // Keep these suites explicit about their target; the normal .env
        // DATABASE_URL is not used by either disposable suite.
        DATABASE_URL: '',
      },
      timeoutMs: 120_000,
    });
    evidence.status = 'passed';
    evidence.test = {
      stdout: test.stdout,
      stderr: test.stderr,
      exitCode: test.code,
    };
    console.log(JSON.stringify(evidence, null, 2));
  } catch (error) {
    evidence.error = error?.message || String(error);
    if (error?.output) evidence.test = error.output;
    console.error(JSON.stringify(evidence, null, 2));
    process.exitCode = 1;
  } finally {
    // Keep cleanup outside the startup/test try block so a failed or timed-out
    // docker run cannot leave a partially-created disposable container behind.
    await removeContainer();
    for (const child of [...children]) await stopChild(child);
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(
      path.join(OUTPUT_DIR, `local-disposable-db-verification-${new Date().toISOString().slice(0, 10).replace(/-/g, '')}.json`),
      JSON.stringify(evidence, null, 2),
      'utf8',
    );
  }
}

main();
