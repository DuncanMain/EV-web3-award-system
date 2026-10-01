/*
 * Destructive verification for an isolated local PostgreSQL database only.
 * Run after `npm run build` and `npm run db:migrate` with DATABASE_URL pointed
 * at a disposable localhost database. The script deliberately refuses remote
 * hosts so it cannot be used against production by accident.
 */
'use strict';

const assert = require('node:assert/strict');

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

function localOnlyDatabaseUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL is required');
  const parsed = new URL(raw);
  if (!['localhost', '127.0.0.1', '::1'].includes(parsed.hostname)) {
    throw new Error(`Refusing non-local DATABASE_URL host ${parsed.hostname}`);
  }
  if (process.env.NVF_ALLOW_DISPOSABLE_RESET !== '1') {
    throw new Error('Refusing destructive reset without NVF_ALLOW_DISPOSABLE_RESET=1');
  }
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  if (!/^nvf_award_check(?:[_-][a-z0-9]+)*$/i.test(databaseName)) {
    throw new Error(`Refusing destructive reset for database ${databaseName}; use a disposable nvf_award_check[_suffix] database`);
  }
  return raw;
}

function expectRejected(result, text) {
  assert.equal(result.status, 'rejected', `expected rejection containing ${text}`);
  assert.match(String(result.reason && result.reason.message), new RegExp(text));
}

async function main() {
  localOnlyDatabaseUrl();
  const { getDatabase, closeDatabase } = require('../dist/database/connection');
  const { Users, Balances, TokenOperations, SpendReservations, ApprovalPreparations } = require('../dist/database/service');
  const { recordAward, recordSpend } = require('../dist/database/integration');
  const db = getDatabase();
  try {
    const indexRows = await db.raw("select indexname from pg_indexes where schemaname = 'public' and indexname in ('awards_tx_hash_lower_unique', 'spends_tx_hash_lower_unique', 'spend_receipts_token_tx_hash_lower_unique', 'token_operations_tx_hash_lower_unique')");
    assert.equal(indexRows.rows.length, 4, 'migration 015 lower-case transaction indexes are present');
    assert.equal(await db.schema.hasTable('approval_preparations'), true, 'durable approval preparation table is present');
    assert.equal(await db.schema.hasColumn('token_operations', 'movement_outcome'), true, 'movement outcome classification is present');
    await db.raw('truncate table approval_preparations, token_operations, spend_reservations, spends, awards, balances, users restart identity cascade');

    // The funded -> approving transition is a durable cross-process claim.
    // Independent callers must yield exactly one permission to broadcast the
    // allowance transaction; the second caller is retained for review.
    const approvalKey = 'approval:atomic-submission-check';
    await ApprovalPreparations.claim({
      operationKey: approvalKey,
      walletAddress: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      tokenContractAddress: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      chainId: '31337',
      treasuryAddress: '0xcccccccccccccccccccccccccccccccccccccccc',
    });
    await ApprovalPreparations.markFunded(approvalKey);
    const approvalClaims = await Promise.all([
      ApprovalPreparations.claimApprovalSubmission(approvalKey),
      ApprovalPreparations.claimApprovalSubmission(approvalKey),
    ]);
    assert.equal(approvalClaims.filter(result => result.acquired).length, 1);
    assert.equal(approvalClaims.filter(result => !result.acquired).length, 1);
    assert.equal((await ApprovalPreparations.findByKey(approvalKey)).status, 'approving');

    const wallet = '0x1111111111111111111111111111111111111111';
    const otherWallet = '0x2222222222222222222222222222222222222222';
    const chainBalance = async () => 10;

    // The reservation and manual-spend paths share the same advisory lock and
    // count each other's unresolved holds. Exactly one 6-token claim may win.
    const sharedRace = await Promise.allSettled([
      TokenOperations.claim({
        operationKey: 'spend:manual-lock-check', operationType: 'spend',
        requestFingerprint: 'manual-lock-check', uid: 'manual-uid', walletAddress: wallet,
        amount: '6.00', getOnChainBalance: chainBalance,
      }),
      SpendReservations.reserve({
        uid: 'reservation-uid', walletAddress: wallet, sessionId: 'session-lock-check',
        providerId: 'provider-lock-check', amount: 6, getOnChainBalance: chainBalance,
      }),
    ]);
    assert.equal(sharedRace.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(sharedRace.filter(result => result.status === 'rejected').length, 1);
    expectRejected(sharedRace.find(result => result.status === 'rejected'), 'INSUFFICIENT_SPARKZ');

    // Holds are counted across eMAIDs that resolve to one actual wallet.
    const linkedRace = await Promise.allSettled([
      SpendReservations.reserve({ uid: 'linked-a', walletAddress: otherWallet, sessionId: 's-a', providerId: 'p', amount: 6, onChainBalance: 10 }),
      SpendReservations.reserve({ uid: 'linked-b', walletAddress: otherWallet, sessionId: 's-b', providerId: 'p', amount: 6, onChainBalance: 10 }),
    ]);
    assert.equal(linkedRace.filter(result => result.status === 'fulfilled').length, 1);
    assert.equal(linkedRace.filter(result => result.status === 'rejected').length, 1);

    const terminalReservation = await SpendReservations.reserve({
      uid: 'terminal-user', walletAddress: otherWallet, sessionId: 'terminal-session',
      providerId: 'p', amount: 1, onChainBalance: 10,
    });
    await SpendReservations.complete(terminalReservation.reservation.id, 0, 0);
    await SpendReservations.retry(terminalReservation.reservation.id, 'late concurrent error');
    const terminal = await SpendReservations.findByIdForUid(terminalReservation.reservation.id, 'terminal-user');
    assert.equal(terminal.status, 'released');

    const retryReservation = await SpendReservations.reserve({
      uid: 'retry-user', walletAddress: otherWallet, sessionId: 'retry-session',
      providerId: 'p', amount: 1, onChainBalance: 10,
    });
    const retryResult = await SpendReservations.reserve({
      uid: 'retry-user', walletAddress: otherWallet, sessionId: 'retry-session',
      providerId: 'p', amount: 1, getOnChainBalance: async () => { throw new Error('balance changed'); },
    });
    assert.equal(retryResult.existing, true);
    assert.equal(retryResult.reservation.id, retryReservation.reservation.id);

    // A capacity sample holds the wallet lock while it reads the chain. A
    // concurrent completion must wait for that sample, so the sample cannot
    // observe a released hold and then over-reserve the wallet.
    const barrierWallet = '0x3333333333333333333333333333333333333333';
    const barrierReservation = await SpendReservations.reserve({
      uid: 'barrier-held', walletAddress: barrierWallet, sessionId: 'barrier-held-session',
      providerId: 'p', amount: 5, onChainBalance: 10,
    });
    let sampledResolve;
    let releaseResolve;
    const sampled = new Promise(resolve => { sampledResolve = resolve; });
    const release = new Promise(resolve => { releaseResolve = resolve; });
    const blockedReservation = SpendReservations.reserve({
      uid: 'barrier-new', walletAddress: barrierWallet, sessionId: 'barrier-new-session',
      providerId: 'p', amount: 6,
      getOnChainBalance: async () => {
        sampledResolve();
        await release;
        return 10;
      },
    });
    await sampled;
    let completionFinished = false;
    const completion = SpendReservations.complete(barrierReservation.reservation.id, 0, 0)
      .then(value => { completionFinished = true; return value; });
    await sleep(50);
    assert.equal(completionFinished, false, 'reservation completion waits for the capacity sample lock');
    releaseResolve();
    const barrierResult = await Promise.allSettled([blockedReservation, completion]);
    assert.equal(barrierResult[0].status, 'rejected');
    assert.match(String(barrierResult[0].reason && barrierResult[0].reason.message), /INSUFFICIENT_SPARKZ/);
    assert.equal(barrierResult[1].status, 'fulfilled');

    const projectionWallet = '0x6666666666666666666666666666666666666666';
    const projectedHold = await TokenOperations.claim({
      operationKey: 'spend:projection-release-lock', operationType: 'spend',
      requestFingerprint: 'projection-release-lock', uid: 'projection-release-user', walletAddress: projectionWallet,
      amount: '5.00', getOnChainBalance: async () => 10,
    });
    await TokenOperations.markSubmitted(projectedHold.operation.operation_key, `0x${'6'.repeat(64)}`);
    await TokenOperations.markConfirmed(projectedHold.operation.operation_key);
    let projectionSampledResolve;
    let projectionReleaseResolve;
    const projectionSampled = new Promise(resolve => { projectionSampledResolve = resolve; });
    const projectionRelease = new Promise(resolve => { projectionReleaseResolve = resolve; });
    const projectionReservation = SpendReservations.reserve({
      uid: 'projection-release-new', walletAddress: projectionWallet, sessionId: 'projection-release-new',
      providerId: 'p', amount: 6,
      getOnChainBalance: async () => {
        projectionSampledResolve();
        await projectionRelease;
        return 10;
      },
    });
    await projectionSampled;
    let projectionFinished = false;
    const projection = TokenOperations.markProjected(projectedHold.operation.operation_key)
      .then(value => { projectionFinished = true; return value; });
    await sleep(50);
    assert.equal(projectionFinished, false, 'operation projection waits for the capacity sample lock');
    projectionReleaseResolve();
    const projectionResult = await Promise.allSettled([projectionReservation, projection]);
    assert.equal(projectionResult[0].status, 'rejected');
    assert.match(String(projectionResult[0].reason && projectionResult[0].reason.message), /INSUFFICIENT_SPARKZ/);
    assert.equal(projectionResult[1].status, 'fulfilled');

    // A mined/reverted transaction with explicit no_movement evidence releases
    // its manual hold; an evidence mismatch remains held for review.
    const releasedHoldWallet = '0x4444444444444444444444444444444444444444';
    const releasedHold = await TokenOperations.claim({
      operationKey: 'spend:no-movement-hold', operationType: 'spend',
      requestFingerprint: 'no-movement-hold', uid: 'no-movement-user', walletAddress: releasedHoldWallet,
      amount: '5.00', getOnChainBalance: async () => 10,
    });
    await TokenOperations.markSubmitted(releasedHold.operation.operation_key, `0x${'4'.repeat(64)}`);
    await TokenOperations.markFailed(releasedHold.operation.operation_key, 'reverted with no Transfer movement', 'no_movement');
    const afterNoMovement = await SpendReservations.reserve({
      uid: 'after-no-movement', walletAddress: releasedHoldWallet, sessionId: 'after-no-movement',
      providerId: 'p', amount: 10, onChainBalance: 10,
    });
    assert.equal(afterNoMovement.existing, false);
    await SpendReservations.complete(afterNoMovement.reservation.id, 0, 0);

    const reviewHoldWallet = '0x5555555555555555555555555555555555555555';
    const reviewHold = await TokenOperations.claim({
      operationKey: 'spend:review-hold', operationType: 'spend',
      requestFingerprint: 'review-hold', uid: 'review-user', walletAddress: reviewHoldWallet,
      amount: '5.00', getOnChainBalance: async () => 10,
    });
    await TokenOperations.markSubmitted(reviewHold.operation.operation_key, `0x${'5'.repeat(64)}`);
    await TokenOperations.markFailed(reviewHold.operation.operation_key, 'mismatched Transfer evidence', 'review');
    const heldReview = await Promise.allSettled([SpendReservations.reserve({
      uid: 'held-by-review', walletAddress: reviewHoldWallet, sessionId: 'held-by-review',
      providerId: 'p', amount: 6, onChainBalance: 10,
    })]);
    assert.equal(heldReview[0].status, 'rejected');
    assert.match(String(heldReview[0].reason && heldReview[0].reason.message), /INSUFFICIENT_SPARKZ/);

    const session = (id, uid) => ({
      sessionId: id, providerId: 'provider-award', uid, evseId: 'DE*TEST*1',
      startTime: new Date('2026-01-01T01:00:00Z'), endTime: new Date('2026-01-01T02:00:00Z'),
      energyKWh: 2, energyDirection: 'CHARGE',
    });
    // First balance creation and two different movements for one explicit
    // identity serialize on the user lock and apply both deltas.
    await Promise.all([
      recordAward(session('award-a', 'award-user'), 1.1, 'award-a-provider', `0x${'a'.repeat(64)}`, undefined, undefined, wallet),
      recordAward(session('award-b', 'award-user'), 2.2, 'award-b-provider', `0x${'b'.repeat(64)}`, undefined, undefined, wallet),
    ]);
    const awardUser = await Users.findByUidAndWallet('award-user', wallet);
    const awardBalance = await Balances.findByUser(awardUser.id);
    assert.equal(awardBalance.balance, '3.30');
    assert.equal(awardBalance.total_awarded, '3.30');

    // Same confirmed transfer can be projected concurrently exactly once.
    const onceSession = session('award-once', 'award-once-user');
    const onceArgs = [onceSession, 1.25, 'award-once-provider', `0x${'c'.repeat(64)}`, undefined, undefined, otherWallet];
    await Promise.all([recordAward(...onceArgs), recordAward(...onceArgs)]);
    assert.equal(await db('awards').where({ tx_hash: `0x${'c'.repeat(64)}` }).count('*').first().then(row => Number(row.count)), 1);
    const onceUser = await Users.findByUidAndWallet('award-once-user', otherWallet);
    const onceBalance = await Balances.findByUser(onceUser.id);
    assert.equal(onceBalance.balance, '1.25');

    // Award and spend projections also share the balance lock when the first
    // balance row is being created, so one cannot lose the other's insert.
    const mixedSession = session('mixed-first-row', 'mixed-user');
    await Promise.all([
      recordAward(mixedSession, 3, 'mixed-award-provider', `0x${'f'.repeat(64)}`, undefined, undefined, wallet),
      recordSpend(wallet, 1, `0x${'1'.repeat(64)}`, 'mixed-spend', 'mixed-user'),
    ]);
    const mixedUser = await Users.findByUidAndWallet('mixed-user', wallet);
    const mixedBalance = await Balances.findByUser(mixedUser.id);
    assert.equal(mixedBalance.balance, '2.00');
    assert.equal(mixedBalance.total_awarded, '3.00');
    assert.equal(mixedBalance.total_spent, '1.00');

    // Exercise the migration's historical review guard by temporarily
    // removing the expression index in this disposable database and inserting
    // a case-equivalent pair. The migration must stop before recreating it.
    await db.raw('drop index if exists awards_tx_hash_lower_unique');
    const migrationUser = await Users.findByUidAndWallet('mixed-user', wallet);
    const duplicateHash = `0x${'a'.repeat(64)}`;
    await db('awards').insert([
      { user_id: migrationUser.id, session_id: 'migration-duplicate-a', provider_id: 'migration-provider-a', dedup_key: 'migration-duplicate-a', amount: '1.00', tx_hash: duplicateHash, awarded_at: new Date() },
      { user_id: migrationUser.id, session_id: 'migration-duplicate-b', provider_id: 'migration-provider-b', dedup_key: 'migration-duplicate-b', amount: '1.00', tx_hash: duplicateHash.toUpperCase(), awarded_at: new Date() },
    ]);
    const { up: migrate015 } = require('../dist/database/migrations/015_add_token_operations');
    await assert.rejects(() => migrate015(db), /historical duplicate transaction hashes require manual review/);
    await db('awards').whereIn('session_id', ['migration-duplicate-a', 'migration-duplicate-b']).delete();
    await migrate015(db);

    // An explicit eMAID must create/use its own row even when another eMAID
    // already owns the same wallet.
    const explicit = await recordSpend(wallet, 0.5, `0x${'d'.repeat(64)}`, 'spend-owner', 'explicit-owner');
    assert.equal(explicit.user.uid, 'explicit-owner');
    assert.equal((await Users.findAllByWallet(wallet)).filter(user => user.uid === 'explicit-owner').length, 1);

    // Case-only hash changes are one movement and cannot double-debit.
    const caseHash = `0x${'e'.repeat(64)}`;
    await Promise.all([
      recordSpend(wallet, 0.25, caseHash.toUpperCase(), 'case-session', 'explicit-owner'),
      recordSpend(wallet, 0.25, caseHash, 'case-session', 'explicit-owner'),
    ]);
    assert.equal(await db('spends').whereRaw('lower(tx_hash) = lower(?)', [caseHash]).count('*').first().then(row => Number(row.count)), 1);

    // Legacy `${session}-${provider}` collisions are serialized before any
    // second durable claim can reach a chain caller.
    const legacyRace = await Promise.allSettled([
      TokenOperations.claim({ operationKey: 'award:legacy-a', operationType: 'award', requestFingerprint: 'fp-a', uid: 'legacy-a', walletAddress: wallet, amount: '1.00', sessionId: 'a-b', providerId: 'c', legacyKey: 'a-b-c' }),
      TokenOperations.claim({ operationKey: 'award:legacy-b', operationType: 'award', requestFingerprint: 'fp-b', uid: 'legacy-b', walletAddress: wallet, amount: '1.00', sessionId: 'a', providerId: 'b-c', legacyKey: 'a-b-c' }),
    ]);
    assert.equal(legacyRace.filter(result => result.status === 'fulfilled').length, 1);
    expectRejected(legacyRace.find(result => result.status === 'rejected'), 'LEGACY_DEDUP_KEY_COLLISION_REVIEW');

    console.log(JSON.stringify({
      status: 'passed',
      checks: [
        'shared wallet reservation/manual-spend advisory lock',
        'linked eMAID hold aggregation',
        'concurrent first balance creation and award projection',
        'concurrent first balance award/spend projection',
        'explicit eMAID spend identity',
        'case-insensitive transaction idempotency',
        'legacy award-key collision serialization',
        'cross-process funded approval submission claim',
        'terminal reservation monotonic retry',
        'existing reservation replay before balance sampling',
        'capacity sample and reservation completion wallet-lock ordering',
        'operation projection and reservation wallet-lock ordering',
        'no-movement failure releases manual hold while review failure retains it',
        'migration historical case-equivalent duplicate guard',
      ],
    }, null, 2));
  } finally {
    await closeDatabase();
  }
}

main().catch(error => {
  console.error(JSON.stringify({ status: 'failed', error: error && error.message ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});
