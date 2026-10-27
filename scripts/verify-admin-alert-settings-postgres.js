'use strict';

/*
 * Verify the additive admin-alert settings migration against a fresh local
 * PostgreSQL cluster. The runner owns every path and database name it creates
 * and refuses to touch a caller-supplied or existing database.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const createKnex = require('knex');
const { Pool } = require('pg');

const APP_ROOT = path.resolve(__dirname, '..');
const APP_OUTPUTS_DIR = path.resolve(APP_ROOT, 'outputs');
const BIN_DIR = path.resolve(
  process.env.EDB_PG_BIN_DIR
    || path.join(APP_ROOT, 'diagnostic-output', 'postgresql-17.11-edb-20261013', 'runtime', 'pgsql', 'bin'),
);
const OUTPUT_DIR = path.resolve(
  process.env.ADMIN_ALERT_EVIDENCE_DIR
    || path.join(APP_OUTPUTS_DIR, 'live-api-remediation-2026-10-14'),
);
const OUTPUT_FILE = path.join(OUTPUT_DIR, 'admin-alert-settings-postgres-verification-2026-10-14.json');
const RUN_ID = `${process.pid}_${Date.now().toString(36)}`.toLowerCase().replace(/[^a-z0-9_]/g, '_');
const DATABASE_NAME = `nvf_award_test_alert_${RUN_ID}`;
const DB_USER = 'postgres';
const PROBE_RECIPIENT = 'verification@example.com';
const PROBE_CHANNEL = 'both';
let clusterDirectory;
let clusterLog;
let port;
let clusterStarted = false;
let databaseCreated = false;
let applicationDatabase;

function comparablePath(value) {
  return path.normalize(value).replace(/[\\/]+$/, '').toLowerCase();
}

function executable(name) {
  const file = path.resolve(BIN_DIR, `${name}.exe`);
  if (!file.startsWith(`${BIN_DIR}${path.sep}`) || !fs.existsSync(file)) {
    throw new Error(`required PostgreSQL binary is unavailable: ${name}`);
  }
  return file;
}

async function postgresRuntimeVersion() {
  const result = await runProcess(executable('postgres'), ['--version'], { timeoutMs: 30_000 });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  const match = output.match(/PostgreSQL\)?\s+([0-9]+(?:\.[0-9]+)+)/i)
    || output.match(/\b([0-9]+\.[0-9]+(?:\.[0-9]+)?)\b/);
  if (!match) throw new Error('postgres --version output was not recognized');
  return match[1];
}

function removeOwnedClusterDirectory(target) {
  const lexicalTarget = path.resolve(target);
  const lexicalParent = path.dirname(lexicalTarget);
  const expectedParent = path.resolve(APP_OUTPUTS_DIR);
  const targetName = path.basename(lexicalTarget);
  if (comparablePath(lexicalParent) !== comparablePath(expectedParent)) {
    throw new Error('disposable cluster path is outside the checkout outputs directory');
  }
  if (!/^\.tmp-admin-alert-pg-[a-z0-9_-]+$/i.test(targetName)) {
    throw new Error('disposable cluster path does not have the owned temporary-directory name');
  }

  // Resolve both parent and target immediately before recursive deletion. A
  // symlink/junction escape changes the canonical path and is rejected.
  const resolvedParent = fs.realpathSync.native(expectedParent);
  const resolvedTarget = fs.realpathSync.native(lexicalTarget);
  if (comparablePath(resolvedParent) !== comparablePath(expectedParent)
    || comparablePath(resolvedTarget) !== comparablePath(lexicalTarget)
    || comparablePath(path.dirname(resolvedTarget)) !== comparablePath(resolvedParent)) {
    throw new Error('disposable cluster path failed the canonical ownership check');
  }
  fs.rmSync(resolvedTarget, { recursive: true, force: true });
  return !fs.existsSync(resolvedTarget);
}

function safeError(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text
    .replace(/postgres(?:ql)?:\/\/[^\s)]+/gi, 'postgres://[redacted]')
    .replace(/password\s*=\s*[^\s)]+/gi, 'password=[redacted]')
    .slice(0, 800);
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const selected = address && typeof address === 'object' ? address.port : undefined;
      server.close(error => error ? reject(error) : resolve(selected));
    });
  });
}

function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || APP_ROOT,
      env: options.env || process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32' && /\.cmd$/i.test(command),
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timeoutMs = options.timeoutMs || 120_000;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`${path.basename(command)} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
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
      if (code === 0) {
        resolve({ code, signal, stdout, stderr });
      } else {
        const error = new Error(`${path.basename(command)} exited ${code ?? signal}`);
        error.output = { stdout, stderr };
        reject(error);
      }
    });
  });
}

async function waitForDatabase(databaseUrl) {
  const deadline = Date.now() + 30_000;
  let lastError;
  while (Date.now() < deadline) {
    const pool = new Pool({ connectionString: databaseUrl, max: 1, connectionTimeoutMillis: 1_000 });
    try {
      await pool.query('select 1');
      return;
    } catch (error) {
      lastError = error;
    } finally {
      await pool.end().catch(() => undefined);
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error(`disposable PostgreSQL did not become ready: ${safeError(lastError)}`);
}

async function runMigration(databaseUrl) {
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  return runProcess(npmCommand, ['run', 'db:migrate'], {
    // Keep the disposable seed deterministic and synthetic. These values are
    // scoped to the child migration process and never touch the caller .env.
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      ADMIN_ALERT_CHANNEL: 'email',
      ADMIN_ALERT_RECIPIENT: PROBE_RECIPIENT,
    },
    timeoutMs: 180_000,
  });
}

async function queryDatabase(databaseUrl, text, values = []) {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    return await pool.query(text, values);
  } finally {
    await pool.end();
  }
}

async function dropDatabase() {
  if (!databaseCreated || !port || !/^nvf_award_test_alert_[a-z0-9_]+$/.test(DATABASE_NAME)) return false;
  const adminUrl = `postgres://${DB_USER}@127.0.0.1:${port}/postgres`;
  const pool = new Pool({ connectionString: adminUrl, max: 1 });
  try {
    await pool.query(`drop database if exists "${DATABASE_NAME}"`);
    databaseCreated = false;
    return true;
  } finally {
    await pool.end().catch(() => undefined);
  }
}

async function stopCluster() {
  if (!clusterStarted || !clusterDirectory) return false;
  await runProcess(executable('pg_ctl'), ['-D', clusterDirectory, '-m', 'fast', '-w', 'stop'], { timeoutMs: 30_000 });
  clusterStarted = false;
  return true;
}

async function main() {
  const evidence = {
    generatedAtUtc: new Date().toISOString(),
    status: 'failed',
    runtime: {
      provider: 'EDB PostgreSQL',
      version: null,
      versionSource: 'postgres --version',
      binariesPath: 'diagnostic-output/postgresql-17.11-edb-20261013/runtime/pgsql/bin',
    },
    database: { host: '127.0.0.1', port: null, name: DATABASE_NAME, disposable: true },
    migrationRuns: [],
    assertions: [],
    cleanup: { databaseDropped: false, clusterStopped: false, dataDirectoryRemoved: false },
  };
  const assertEvidence = (id, passed, detail = {}) => {
    evidence.assertions.push({ id, passed: Boolean(passed), ...detail });
    assert.ok(passed, `${id} failed`);
  };

  try {
    executable('initdb');
    executable('pg_ctl');
    executable('postgres');
    evidence.runtime.version = await postgresRuntimeVersion();
    port = await getFreePort();
    evidence.database.port = port;
    fs.mkdirSync(APP_OUTPUTS_DIR, { recursive: true });
    clusterDirectory = fs.mkdtempSync(path.join(APP_OUTPUTS_DIR, '.tmp-admin-alert-pg-'));
    clusterLog = path.join(clusterDirectory, 'postgres.log');

    await runProcess(executable('initdb'), [
      '-D', clusterDirectory,
      '-U', DB_USER,
      '--auth=trust',
      '--no-locale',
      '--encoding=UTF8',
    ], { timeoutMs: 60_000 });
    await runProcess(executable('pg_ctl'), [
      '-D', clusterDirectory,
      '-o', `-p ${port} -h 127.0.0.1`,
      '-l', clusterLog,
      '-w',
      'start',
    ], { timeoutMs: 60_000 });
    clusterStarted = true;

    const adminUrl = `postgres://${DB_USER}@127.0.0.1:${port}/postgres`;
    await waitForDatabase(adminUrl);
    await queryDatabase(adminUrl, `create database "${DATABASE_NAME}"`);
    databaseCreated = true;
    const databaseUrl = `postgres://${DB_USER}@127.0.0.1:${port}/${DATABASE_NAME}`;

    await runMigration(databaseUrl);
    evidence.migrationRuns.push({ run: 1, status: 'passed' });
    const first = await queryDatabase(databaseUrl, 'select id, recipient_email, channel from admin_alert_settings order by id');
    assertEvidence('migration_024_created_singleton', first.rows.length === 1 && first.rows[0].id === 1, {
      rowCount: first.rows.length,
      initialChannel: first.rows[0]?.channel || null,
    });

    // Exercise the same repository path used by the admin settings API. This
    // verifies the Knex transaction, row conversion, and persisted update
    // rather than proving only that direct SQL can write the row.
    const { createAdminAlertSettingsRepository, loadAdminAlertSettings, updateAdminAlertSettings } = require(path.join(APP_ROOT, 'dist', 'adminAlerts.js'));
    applicationDatabase = createKnex({ client: 'pg', connection: databaseUrl });
    const repository = createAdminAlertSettingsRepository(applicationDatabase);
    const loadedInitial = await loadAdminAlertSettings(repository);
    assertEvidence('repository_loads_migrated_settings', /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(loadedInitial.recipientEmail)
      && loadedInitial.channel === 'email', {
      channel: loadedInitial.channel,
    });
    const updatedByRepository = await updateAdminAlertSettings({
      recipientEmail: PROBE_RECIPIENT,
      channel: PROBE_CHANNEL,
    }, repository);
    assertEvidence('repository_update_commits_transaction', updatedByRepository.recipientEmail === PROBE_RECIPIENT
      && updatedByRepository.channel === PROBE_CHANNEL, {
      channel: updatedByRepository.channel,
    });
    const loadedUpdated = await loadAdminAlertSettings(repository);
    assertEvidence('repository_load_reads_updated_settings', loadedUpdated.recipientEmail === PROBE_RECIPIENT
      && loadedUpdated.channel === PROBE_CHANNEL, {
      channel: loadedUpdated.channel,
    });

    await runMigration(databaseUrl);
    evidence.migrationRuns.push({ run: 2, status: 'passed' });
    const second = await queryDatabase(databaseUrl, 'select id, recipient_email, channel from admin_alert_settings order by id');
    assertEvidence('migration_024_is_idempotent_and_preserves_settings', second.rows.length === 1
      && second.rows[0].id === 1
      && second.rows[0].recipient_email === PROBE_RECIPIENT
      && second.rows[0].channel === PROBE_CHANNEL, {
      rowCount: second.rows.length,
      recipient: second.rows[0]?.recipient_email || null,
      channel: second.rows[0]?.channel || null,
    });
    evidence.status = 'passed';
  } catch (error) {
    evidence.error = safeError(error);
    if (error && error.output) evidence.processFailure = { stdoutLength: error.output.stdout.length, stderrLength: error.output.stderr.length };
    process.exitCode = 1;
  } finally {
    if (applicationDatabase) {
      try {
        await applicationDatabase.destroy();
      } catch (error) {
        evidence.databaseClientCloseError = safeError(error);
        process.exitCode = 1;
      }
      applicationDatabase = undefined;
    }
    try {
      evidence.cleanup.databaseDropped = await dropDatabase();
    } catch (error) {
      evidence.cleanup.databaseDropError = safeError(error);
      process.exitCode = 1;
    }
    try {
      evidence.cleanup.clusterStopped = await stopCluster();
    } catch (error) {
      evidence.cleanup.clusterStopError = safeError(error);
      process.exitCode = 1;
    }
    if (clusterDirectory && evidence.cleanup.clusterStopped) {
      try {
        evidence.cleanup.dataDirectoryRemoved = removeOwnedClusterDirectory(clusterDirectory);
      } catch (error) {
        evidence.cleanup.dataDirectoryError = safeError(error);
        process.exitCode = 1;
      }
    } else if (clusterDirectory) {
      evidence.cleanup.dataDirectoryError = 'Cluster stop was not confirmed; disposable data was retained.';
      process.exitCode = 1;
    }
    evidence.assertionCounts = {
      total: evidence.assertions.length,
      passed: evidence.assertions.filter(item => item.passed).length,
      failed: evidence.assertions.filter(item => !item.passed).length,
    };
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    fs.writeFileSync(OUTPUT_FILE, JSON.stringify(evidence, null, 2), 'utf8');
    console.log(`Evidence written to ${OUTPUT_FILE}`);
    console.log(`Outcome: ${evidence.status}; assertions: ${evidence.assertionCounts.passed}/${evidence.assertionCounts.total}`);
    console.log(`Cleanup: database=${evidence.cleanup.databaseDropped}, cluster=${evidence.cleanup.clusterStopped}, data=${evidence.cleanup.dataDirectoryRemoved}`);
  }
}

main().catch(error => {
  console.error(safeError(error));
  process.exitCode = 1;
});
