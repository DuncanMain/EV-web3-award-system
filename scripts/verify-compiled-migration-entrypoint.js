/*
 * Seed a valid multi-wallet selection, run the compiled migration entrypoint
 * repeatedly, and assert that the explicit non-oldest choice survives.
 * This script only accepts a disposable loopback PostgreSQL database.
 */
'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { Pool } = require('pg');
const { parseDisposableDatabaseUrl } = require('./disposableDatabaseUrl');

const APP_ROOT = require('node:path').resolve(__dirname, '..');

function requireDisposableDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');

  try {
    parseDisposableDatabaseUrl(databaseUrl);
  } catch (error) {
    throw new Error(`DATABASE_URL must target a loopback disposable database: ${error.message}`);
  }
  return databaseUrl;
}

function runCompiledMigration(databaseUrl) {
  return new Promise((resolve, reject) => {
    const command = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const child = spawn(command, ['run', 'db:migrate'], {
      cwd: APP_ROOT,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: process.platform === 'win32',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk.toString(); });
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.once('error', reject);
    child.once('exit', code => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`compiled migration exited ${code}\n${stderr.slice(-4000)}`));
      }
    });
  });
}

async function main() {
  const databaseUrl = requireDisposableDatabaseUrl();
  const fixtureUid = 'compiled-migration-fixture';
  const pool = new Pool({ connectionString: databaseUrl, max: 2 });
  try {
    await pool.query('delete from users where uid = $1', [fixtureUid]);
    await pool.query(`
      insert into users (uid, wallet_address, wallet_name, is_active, created_at, updated_at)
      values
        ($1, '0x1111111111111111111111111111111111111111', 'legacy', false, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
        ($1, '0x2222222222222222222222222222222222222222', 'selected', true, '2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z')
    `, [fixtureUid]);
  } finally {
    await pool.end();
  }

  await runCompiledMigration(databaseUrl);
  await runCompiledMigration(databaseUrl);

  const verificationPool = new Pool({ connectionString: databaseUrl, max: 1 });
  try {
    const rows = await verificationPool.query(
      'select wallet_address, is_active from users where uid = $1 order by created_at asc',
      [fixtureUid],
    );
    assert.equal(rows.rows.length, 2);
    assert.deepEqual(rows.rows, [
      { wallet_address: '0x1111111111111111111111111111111111111111', is_active: false },
      { wallet_address: '0x2222222222222222222222222222222222222222', is_active: true },
    ]);

    const globalConstraint = await verificationPool.query(
      `select 1 from pg_constraint where conname = 'users_uid_unique'`,
    );
    const scopedIndex = await verificationPool.query(
      `select 1 from pg_indexes where indexname = 'users_uid_wallet_lower_unique'`,
    );
    assert.equal(globalConstraint.rows.length, 0);
    assert.equal(scopedIndex.rows.length, 1);
  } finally {
    await verificationPool.end();
  }

  console.log('compiled migration entrypoint preserved the explicit non-oldest active wallet across repeated runs');
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
