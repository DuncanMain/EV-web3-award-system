/*
 * Disposable PostgreSQL verification for migration 017 and the durable
 * provider/charging-session claim guard. This script deliberately refuses
 * the active dashboard target (localhost:55432/nvf_award); callers must
 * provide a separate loopback test database through
 * CHARGING_SESSION_GUARD_DATABASE_URL.
 */
const crypto = require('crypto');
const knex = require('knex');

function quoteIdentifier(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

function assertDisposableTarget(databaseUrl) {
  const parsed = new URL(databaseUrl);
  const databaseName = parsed.pathname.replace(/^\//, '');
  if (!new Set(['localhost', '127.0.0.1', '::1']).has(parsed.hostname)) {
    throw new Error('CHARGING_SESSION_GUARD_TEST_LOCAL_ONLY: database host must be loopback');
  }
  if (parsed.port === '55432' || databaseName === 'nvf_award') {
    throw new Error('CHARGING_SESSION_GUARD_TEST_ACTIVE_DB_REFUSED: use a disposable database, never the dashboard target');
  }
}

async function main() {
  const databaseUrl = process.env.CHARGING_SESSION_GUARD_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('Set CHARGING_SESSION_GUARD_DATABASE_URL to a disposable loopback PostgreSQL database');
  }
  assertDisposableTarget(databaseUrl);

  const adminDb = knex({ client: 'pg', connection: { connectionString: databaseUrl } });
  const schema = `charging_guard_${crypto.randomUUID().replace(/-/g, '')}`;
  const schemaSql = quoteIdentifier(schema);
  let guardDb;
  let closeServiceDatabase;
  try {
    await adminDb.raw(`create schema ${schemaSql}`);
    guardDb = knex({
      client: 'pg',
      connection: { connectionString: databaseUrl },
      searchPath: [schema, 'public'],
      pool: { min: 1, max: 4 },
    });
    await guardDb.raw(`create table ${schemaSql}.token_operations (
      id uuid,
      operation_key text primary key,
      operation_type text not null,
      legacy_key text,
      request_fingerprint text not null,
      uid text not null,
      wallet_address text not null,
      amount numeric(20,2) not null,
      session_id text,
      provider_id text,
      charging_session_id text,
      reservation_id uuid,
      intent_context jsonb,
      status text not null,
      movement_outcome text not null,
      tx_hash text,
      error_message text,
      created_at timestamptz default now(),
      updated_at timestamptz default now()
    )`);
    await guardDb.raw(`create table ${schemaSql}.awards (
      id uuid,
      user_id uuid,
      session_id text,
      provider_id text,
      dedup_key text,
      amount numeric(20,2),
      tx_hash text
    )`);

    const { up: applyGuardMigration } = require('../dist/database/migrations/017_add_charging_session_guard');
    const { ensureChargingSessionGuard } = require('../dist/database/tokenOperationSchema');
    await applyGuardMigration(guardDb);
    await applyGuardMigration(guardDb);

    await guardDb.raw('drop index "token_operations_award_provider_charging_session_unique"');
    await guardDb.raw(
      `create unique index "token_operations_award_provider_charging_session_unique"
         on "token_operations" (provider_id, charging_session_id)
        where operation_type = 'award'
          and provider_id is not null
          and charging_session_id is not null
          and amount = 0`,
    );
    let rejectedNarrowPredicate = false;
    try {
      await ensureChargingSessionGuard(guardDb);
    } catch (error) {
      if (!String(error && error.message ? error.message : error).includes('not a valid enforcing provider/session award guard')) {
        throw error;
      }
      rejectedNarrowPredicate = true;
    }
    if (!rejectedNarrowPredicate) throw new Error('CHARGING_SESSION_GUARD_NARROW_PREDICATE_ACCEPTED');
    await guardDb.raw('drop index "token_operations_award_provider_charging_session_unique"');
    await ensureChargingSessionGuard(guardDb);

    const guardIndex = await guardDb.raw(
      `select 1 from pg_class idx
         join pg_index ix on ix.indexrelid = idx.oid
         join pg_class tbl on tbl.oid = ix.indrelid
        where tbl.oid = to_regclass('token_operations')::oid
          and idx.relname = 'token_operations_award_provider_charging_session_unique'
          and ix.indisunique and ix.indisvalid and ix.indisready`,
    );
    if (guardIndex.rows.length !== 1) throw new Error('CHARGING_SESSION_GUARD_INDEX_MISSING');

    const testUrl = new URL(databaseUrl);
    testUrl.searchParams.set('options', `-c search_path=${schema},public`);
    process.env.DATABASE_URL = testUrl.toString();
    ({ closeDatabase: closeServiceDatabase } = require('../dist/database/connection'));
    const { TokenOperations, isAwardChargingSessionCollisionError } = require('../dist/database/service');

    const common = {
      operationType: 'award',
      uid: 'test-emaid',
      walletAddress: '0x1111111111111111111111111111111111111111',
      amount: '1.00',
      providerId: 'test-provider',
      chargingSessionId: 'physical-session-001',
      legacyKey: null,
    };
    const [first, second] = await Promise.allSettled([
      TokenOperations.claim({ ...common, operationKey: 'award:test-cdr-a', requestFingerprint: 'fingerprint-a', sessionId: 'cdr-a' }),
      TokenOperations.claim({ ...common, operationKey: 'award:test-cdr-b', requestFingerprint: 'fingerprint-b', sessionId: 'cdr-b' }),
    ]);
    const fulfilled = [first, second].filter(result => result.status === 'fulfilled');
    const rejected = [first, second].filter(result => result.status === 'rejected');
    if (fulfilled.length !== 1 || rejected.length !== 1) {
      throw new Error(`CHARGING_SESSION_GUARD_RACE_FAILED: fulfilled=${fulfilled.length} rejected=${rejected.length}`);
    }
    const collision = rejected[0].reason;
    if (!isAwardChargingSessionCollisionError(collision)) {
      throw new Error('CHARGING_SESSION_GUARD_RACE_WRONG_ERROR');
    }

    const winningOperation = fulfilled[0].value.operation;
    const winningKey = winningOperation.operation_key;
    const winningSuffix = winningKey.endsWith('a') ? 'a' : 'b';
    const sameKey = await TokenOperations.claim({
      ...common,
      operationKey: winningKey,
      requestFingerprint: `fingerprint-${winningSuffix}`,
      sessionId: `cdr-${winningSuffix}`,
    });
    if (sameKey.acquired) throw new Error('CHARGING_SESSION_GUARD_REPLAY_NOT_IDEMPOTENT');

    const legacyFirst = await TokenOperations.claim({
      ...common,
      operationKey: 'award:legacy-cdr-a',
      requestFingerprint: 'legacy-fingerprint-a',
      sessionId: 'legacy-cdr-a',
      chargingSessionId: undefined,
    });
    const legacySecond = await TokenOperations.claim({
      ...common,
      operationKey: 'award:legacy-cdr-b',
      requestFingerprint: 'legacy-fingerprint-b',
      sessionId: 'legacy-cdr-b',
      chargingSessionId: undefined,
    });
    if (!legacyFirst.acquired || !legacySecond.acquired) {
      throw new Error('CHARGING_SESSION_GUARD_LEGACY_KEY_COVERAGE_CHANGED');
    }

    const rows = await guardDb('token_operations')
      .where({ provider_id: common.providerId, charging_session_id: common.chargingSessionId });
    if (rows.length !== 1) throw new Error(`CHARGING_SESSION_GUARD_ROW_COUNT_FAILED: ${rows.length}`);

    console.log(JSON.stringify({
      migration: '017',
      disposable: true,
      guardIndex: true,
      rejectedNarrowPredicate,
      concurrentClaims: { fulfilled: fulfilled.length, reviewRejected: rejected.length },
      sameCdrReplayAcquired: sameKey.acquired,
      protectedRows: rows.length,
      unboundLegacyRows: await guardDb('token_operations')
        .where({ provider_id: common.providerId })
        .whereNull('charging_session_id')
        .count('* as count')
        .first()
        .then(row => Number(row.count)),
      broadcastCalls: 0,
    }));
  } finally {
    await Promise.allSettled([
      closeServiceDatabase?.(),
      guardDb?.destroy(),
      adminDb.raw(`drop schema if exists ${schemaSql} cascade`),
    ]);
    await adminDb.destroy();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
