/*
 * Seed two explicit operator-recovery states in the disposable local fixture:
 * one real confirmed award whose projection is held by a database trigger,
 * and one persisted hash-without-CDR-snapshot row that must remain blocked.
 * This script refuses the active database and never targets a live service.
 */
'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { Pool } = require('pg');

const apiOrigin = process.env.NVF_FIXTURE_API_ORIGIN;
const dbPort = process.env.NVF_FIXTURE_DB_PORT;
const dbName = process.env.NVF_FIXTURE_DB_NAME;
const apiKey = process.env.NVF_FIXTURE_INGEST_KEY;
const generalApiKey = process.env.NVF_FIXTURE_API_KEY;
const emaid = 'local-api-emaid-001';
const providerId = 'local-recovery-provider-2';
const eligibleSessionId = 'browser-recovery-eligible-2';
const eligibleTuple = `${providerId.length}:${providerId}${eligibleSessionId.length}:${eligibleSessionId}`;
const eligibleOperationKey = `award:${createHash('sha256').update(eligibleTuple).digest('hex')}`;
const blockedOperationKey = 'award:browser-recovery-blocked';
const spendSessionId = 'browser-recovery-spend';
const spendIdempotencyKey = 'browser-recovery-spend-key';
const spendTuple = `${emaid.length}:${emaid}${spendIdempotencyKey.length}:${spendIdempotencyKey}`;
const spendOperationKey = `spend:${createHash('sha256').update(spendTuple).digest('hex')}`;
const walletAddress = process.env.NVF_FIXTURE_WALLET;
const dbPassword = 'postgres';

function requireLoopbackUrl(value, name) {
  const parsed = new URL(value);
  assert.equal(parsed.protocol, 'http:', `${name} must use http`);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname), `${name} must target loopback`);
  assert.equal(parsed.username, '', `${name} must not contain credentials`);
  assert.equal(parsed.password, '', `${name} must not contain credentials`);
  return parsed.origin;
}

async function waitForOperation(pool, sessionId) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const result = await pool.query(
      'select operation_key, status, movement_outcome, tx_hash, intent_context from token_operations where session_id = $1',
      [sessionId],
    );
    if (result.rows[0]) return result.rows[0];
    await new Promise(resolve => setTimeout(resolve, 150));
  }
  throw new Error(`timed out waiting for operation ${sessionId}`);
}

async function main() {
  assert.ok(apiOrigin && dbPort && dbName && apiKey && generalApiKey && walletAddress, 'fixture origin, DB port/name, API keys, and wallet are required');
  const safeApiOrigin = requireLoopbackUrl(apiOrigin, 'NVF_FIXTURE_API_ORIGIN');
  const parsedPort = Number(dbPort);
  assert.ok(Number.isInteger(parsedPort) && parsedPort > 1024 && parsedPort < 65536 && parsedPort !== 55432, 'fixture DB port must be disposable and not 55432');
  const pool = new Pool({ connectionString: `postgres://postgres:${dbPassword}@127.0.0.1:${parsedPort}/${dbName}`, max: 2 });
  const triggerName = 'local_browser_recovery_projection_failure';
  const functionName = 'local_browser_recovery_projection_failure_fn';
  try {
    await pool.query(`
      create or replace function ${functionName}() returns trigger
      language plpgsql as $$
      begin
        raise exception 'local browser recovery projection failure';
      end;
      $$;
    `);
    await pool.query(`drop trigger if exists ${triggerName} on awards`);
    await pool.query(`create trigger ${triggerName} before insert on awards for each row execute function ${functionName}()`);

    const cdr = {
      SessionID: eligibleSessionId,
      ProviderID: providerId,
      EVSEID: 'DE*RECOVERY*1',
      'Session Start': '2026-01-01T01:00:00Z',
      'Session End': '2026-01-01T02:00:00Z',
      'Consumed Energy': '40',
      cdr_token: { contract_id: emaid },
    };
    const ingest = await fetch(`${safeApiOrigin}/ingest/cdr`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
      body: JSON.stringify(cdr),
    });
    const ingestBody = await ingest.json();
    assert.ok([200, 202].includes(ingest.status), `eligible fixture ingest failed: ${JSON.stringify(ingestBody)}`);
    await pool.query(`drop trigger if exists ${triggerName} on awards`);
    await pool.query(`drop function if exists ${functionName}()`);

    const eligible = await waitForOperation(pool, eligibleSessionId);
    assert.equal(eligible.operation_key, eligibleOperationKey);
    assert.ok(/^0x[0-9a-fA-F]{64}$/.test(eligible.tx_hash || ''), `eligible operation must retain a canonical hash: ${JSON.stringify(eligible)}`);

    await pool.query(`
      insert into token_operations (
        operation_key, operation_type, legacy_key, request_fingerprint, uid,
        wallet_address, amount, session_id, provider_id, status, movement_outcome,
        tx_hash, error_message, submitted_at, confirmed_at, created_at, updated_at
      ) values ($1, 'award', null, $2, $3, $4, '1.00', $5, $6, 'confirmed', 'unknown', $7,
        'local blocked recovery fixture', now(), now(), now(), now())
      on conflict (operation_key) do nothing
    `, [
      blockedOperationKey,
      'browser-recovery-blocked-fingerprint',
      emaid,
      walletAddress,
      'browser-recovery-blocked-session',
      'local-recovery-provider',
      `0x${'1'.repeat(64)}`,
    ]);

    const spendTriggerName = 'local_browser_recovery_spend_projection_failure';
    const spendFunctionName = 'local_browser_recovery_spend_projection_failure_fn';
    await pool.query(`
      create or replace function ${spendFunctionName}() returns trigger
      language plpgsql as $$
      begin
        raise exception 'local browser recovery spend projection failure';
      end;
      $$;
    `);
    await pool.query(`drop trigger if exists ${spendTriggerName} on spends`);
    await pool.query(`create trigger ${spendTriggerName} before insert on spends for each row execute function ${spendFunctionName}()`);
    const spendResponse = await fetch(`${safeApiOrigin}/spend`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': generalApiKey },
      body: JSON.stringify({
        uid: emaid,
        amount: 1,
        sessionId: spendSessionId,
        providerId: 'local-recovery-provider-spend',
        idempotencyKey: 'browser-recovery-spend-key',
        label: 'local browser recovery fixture',
      }),
    });
    const spendBody = await spendResponse.json();
    assert.ok([200, 202].includes(spendResponse.status), `eligible spend fixture failed: ${JSON.stringify(spendBody)}`);
    await pool.query(`drop trigger if exists ${spendTriggerName} on spends`);
    await pool.query(`drop function if exists ${spendFunctionName}()`);
    const spendResult = await waitForOperation(pool, spendSessionId);
    assert.equal(spendResult.operation_key, spendOperationKey);
    assert.ok(/^0x[0-9a-fA-F]{64}$/.test(spendResult.tx_hash || ''), `eligible spend must retain a canonical hash: ${JSON.stringify(spendResult)}`);

    console.log(JSON.stringify({
      status: 'seeded',
      eligibleOperationKey,
      eligibleStatus: eligible.status,
      eligibleHasHash: true,
      blockedOperationKey,
      blockedReason: 'AWARD_CDR_SNAPSHOT_REQUIRED',
      spendOperationKey,
      spendStatus: spendResult.status,
      spendHasHash: true,
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'failed', error: error?.message || String(error) }, null, 2));
  process.exitCode = 1;
});
