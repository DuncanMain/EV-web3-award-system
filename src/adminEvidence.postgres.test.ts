import 'dotenv/config';

import crypto from 'crypto';
import knex, { Knex } from 'knex';
import {
  AdminEvidenceError,
  createAdminCorrectionAnnotation,
  getAdminEvidenceReport,
  listAdminCorrectionAnnotations,
  parseAdminCorrectionAnnotationRequest,
  parseAdminEvidenceQuery,
} from './adminEvidence';
import { closeDatabase, getDatabase } from './database/connection';
import { up as migrateAnnotations, down as rollbackAnnotations } from './database/migrations/025_add_admin_correction_annotations';

const describeLocal = process.env.RUN_LOCAL_ADMIN_EVIDENCE_TESTS === '1' ? describe : describe.skip;

function requireDisposableDatabaseUrl(): string {
  const databaseUrl = process.env.ADMIN_EVIDENCE_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('RUN_LOCAL_ADMIN_EVIDENCE_TESTS requires ADMIN_EVIDENCE_DATABASE_URL');
  }
  let target: URL;
  try {
    target = new URL(databaseUrl);
  } catch {
    throw new Error('ADMIN_EVIDENCE_DATABASE_URL must be a valid PostgreSQL URL');
  }
  const databaseName = decodeURIComponent(target.pathname.replace(/^\//, ''));
  if (target.protocol !== 'postgres:'
    || !['localhost', '127.0.0.1'].includes(target.hostname)
    || !target.port
    || !/^nvf_award_(?:check|test)_[a-z0-9_-]+$/i.test(databaseName)) {
    throw new Error('ADMIN_EVIDENCE_DATABASE_URL must target a loopback disposable nvf_award_check_* or nvf_award_test_* database');
  }
  return databaseUrl;
}

const TARGET_ID = '6f8f3c7a-5a3f-4f3e-9b7a-9b0d8e0a1c22';
const USER_ID = 'b9a4a2f9-8c5a-4c09-a868-34dcf2d90f95';
const OTHER_USER_ID = 'f8d1d86a-9dd3-44dd-9c1d-42bbd1a4c4fd';
const ANNOTATION_REQUEST_ID = '0b7f1b9d-cf11-4db1-bb9a-9cd8b6c3ce31';
const TX_TARGET = `0x${'1'.repeat(64)}`;
const TX_ORIGINAL = `0x${'2'.repeat(64)}`;
const TX_SPEND = `0x${'3'.repeat(64)}`;
const TX_REFERENCE_CONFLICT = `0x${'4'.repeat(64)}`;
const TX_REFERENCE_OVERFLOW = `0x${'5'.repeat(64)}`;
const TX_REFERENCE_TARGET_MISMATCH = `0x${'6'.repeat(64)}`;
const WALLET = '0x1111111111111111111111111111111111111111';
const OTHER_WALLET = '0x3333333333333333333333333333333333333333';
const CONTRACT = '0x2222222222222222222222222222222222222222';
const OTHER_CONTRACT = '0x4444444444444444444444444444444444444444';

describeLocal('admin evidence and correction metadata (local PostgreSQL)', () => {
  let adminDatabase: Knex;
  let schemaDatabase: Knex;
  let isolatedSchema: string;
  let previousDatabaseUrl: string | undefined;

  beforeAll(async () => {
    jest.setTimeout(30_000);
    const databaseUrl = requireDisposableDatabaseUrl();
    previousDatabaseUrl = process.env.DATABASE_URL;
    isolatedSchema = `nvf_admin_evidence_${crypto.randomUUID().replace(/-/g, '')}`;
    adminDatabase = knex({ client: 'pg', connection: { connectionString: databaseUrl }, pool: { min: 1, max: 1 } });
    await adminDatabase.raw(`create extension if not exists pgcrypto`);
    await adminDatabase.raw(`create schema "${isolatedSchema}"`);
    schemaDatabase = knex({ client: 'pg', connection: { connectionString: databaseUrl }, pool: { min: 1, max: 1 } });
    await schemaDatabase.raw(`set search_path to "${isolatedSchema}", public`);

    const runtimeUrl = new URL(databaseUrl);
    runtimeUrl.searchParams.set('options', `-c search_path="${isolatedSchema}",public`);
    process.env.DATABASE_URL = runtimeUrl.toString();

    await schemaDatabase.schema.createTable('users', table => {
      table.uuid('id').primary();
      table.string('uid').notNullable();
      table.string('wallet_address', 42).notNullable();
    });
    await schemaDatabase.schema.createTable('awards', table => {
      table.uuid('id').primary();
      table.uuid('user_id').notNullable();
      table.string('session_id').notNullable();
      table.string('provider_id').notNullable();
      table.decimal('amount', 20, 2).notNullable();
      table.string('tx_hash', 66).notNullable();
      table.timestamp('awarded_at').notNullable();
      table.timestamp('created_at').notNullable();
      table.string('status', 30).notNullable();
      table.timestamp('confirmed_at').nullable();
    });
    await schemaDatabase.schema.createTable('spends', table => {
      table.uuid('id').primary();
      table.uuid('user_id').notNullable();
      table.string('wallet_address', 42).notNullable();
      table.decimal('amount', 20, 2).notNullable();
      table.string('tx_hash', 66).notNullable();
      table.string('session_id').nullable();
      table.timestamp('created_at').notNullable();
      table.string('status', 30).notNullable();
      table.timestamp('confirmed_at').nullable();
    });
    await schemaDatabase.schema.createTable('token_operations', table => {
      table.uuid('id').primary();
      table.string('operation_key').notNullable();
      table.string('operation_type').notNullable();
      table.string('uid').notNullable();
      table.string('wallet_address', 42).notNullable();
      table.decimal('amount', 20, 2).notNullable();
      table.string('session_id').nullable();
      table.string('provider_id').nullable();
      table.uuid('reservation_id').nullable();
      table.jsonb('intent_context').nullable();
      table.string('status', 30).notNullable();
      table.string('movement_outcome', 30).notNullable();
      table.string('tx_hash', 66).nullable();
      table.timestamp('submitted_at').nullable();
      table.timestamp('confirmed_at').nullable();
      table.timestamp('projected_at').nullable();
      table.timestamp('created_at').notNullable();
      table.timestamp('updated_at').notNullable();
    });
    await schemaDatabase.schema.createTable('reward_policy', table => {
      table.integer('id').primary();
      table.integer('revision').notNullable();
      table.jsonb('rules').notNullable();
      table.jsonb('off_peak_windows').notNullable();
      table.timestamp('updated_at').notNullable();
    });
    await schemaDatabase.schema.createTable('reconciliation_reports', table => {
      table.uuid('id').primary();
      table.string('status').notNullable();
      table.integer('checked_count').notNullable();
      table.integer('matched_count').notNullable();
      table.integer('mismatch_count').notNullable();
      table.jsonb('items').notNullable();
      table.jsonb('metadata').notNullable();
      table.timestamp('created_at').notNullable();
    });
    await migrateAnnotations(schemaDatabase);
    await migrateAnnotations(schemaDatabase);

    const snapshot = JSON.stringify({ policyRevision: 8, version: '8' });
    const fingerprint = crypto.createHash('sha256').update(snapshot, 'utf8').digest('hex');
    await schemaDatabase('users').insert({ id: USER_ID, uid: 'E-MAID-ORIGINAL', wallet_address: WALLET });
    await schemaDatabase('users').insert({ id: OTHER_USER_ID, uid: 'E-MAID-OTHER', wallet_address: OTHER_WALLET });
    await schemaDatabase('token_operations').insert({
      id: TARGET_ID,
      operation_key: 'award:opaque-operation-key',
      operation_type: 'award',
      uid: 'E-MAID-ORIGINAL',
      wallet_address: WALLET,
      amount: '1.25',
      session_id: 'driver-session-E-MAID-ORIGINAL',
      provider_id: 'provider-E-MAID-ORIGINAL',
      reservation_id: null,
      intent_context: {
        assetContext: { chainId: '137', tokenContractAddress: CONTRACT },
        configurationSnapshot: snapshot,
        configurationFingerprint: fingerprint,
      },
      status: 'projected',
      movement_outcome: 'confirmed',
      tx_hash: TX_TARGET,
      submitted_at: '2026-10-21T10:00:00.000Z',
      confirmed_at: '2026-10-21T10:01:00.000Z',
      projected_at: '2026-10-21T10:02:00.000Z',
      created_at: '2026-10-21T09:59:00.000Z',
      updated_at: '2026-10-21T10:02:00.000Z',
    });
    await schemaDatabase('awards').insert({
      id: 'd8e3fa9e-522a-465f-ae37-d7e2fb72f10f',
      user_id: USER_ID,
      session_id: 'legacy-session',
      provider_id: 'legacy-provider',
      amount: '2.00',
      tx_hash: TX_ORIGINAL,
      awarded_at: '2026-10-21T10:03:00.000Z',
      created_at: '2026-10-21T10:03:00.000Z',
      status: 'confirmed',
      confirmed_at: '2026-10-21T10:03:00.000Z',
    });
    await schemaDatabase('spends').insert({
      id: 'a9f1d648-763b-4b55-bdf9-248da5c753d6',
      user_id: USER_ID,
      wallet_address: OTHER_WALLET,
      amount: '0.50',
      tx_hash: TX_SPEND,
      session_id: 'spend-session',
      created_at: '2026-10-21T10:04:00.000Z',
      status: 'confirmed',
      confirmed_at: '2026-10-21T10:04:00.000Z',
    });
    await schemaDatabase('reward_policy').insert({ id: 1, revision: 99, rules: {}, off_peak_windows: {}, updated_at: '2026-10-21T10:00:00.000Z' });
    await schemaDatabase('reconciliation_reports').insert({
      id: 'c8269e5a-15f1-4f17-a5fc-294ef4d88f72',
      status: 'mismatch',
      checked_count: 1,
      matched_count: 0,
      mismatch_count: 1,
      items: JSON.stringify([{ status: 'amount_mismatch', uid: 'E-MAID-ORIGINAL', walletAddress: WALLET, expectedSparkz: '1.25', recordedSparkz: '1.00', difference: '0.25' }]),
      metadata: JSON.stringify({}),
      created_at: '2026-10-21T10:05:00.000Z',
    });
  });

  afterAll(async () => {
    await closeDatabase();
    try {
      await adminDatabase?.raw(`drop schema if exists "${isolatedSchema}" cascade`);
    } finally {
      await Promise.allSettled([adminDatabase?.destroy(), schemaDatabase?.destroy()]);
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
    }
  });

  it('reads masked, asset-scoped retained evidence without historical-policy fallback', async () => {
    const query = parseAdminEvidenceQuery({
      from: '2026-10-20T00:00:00.000Z',
      to: '2026-10-22T00:00:00.000Z',
      limit: '10',
    });
    const report = await getAdminEvidenceReport(query);
    const operation = report.rows.find(row => row.subjectId === TARGET_ID);
    const legacyAward = report.rows.find(row => row.subjectType === 'award');
    const savedWalletSpend = report.rows.find(row => row.transactionHash === TX_SPEND);
    expect(operation).toMatchObject({
      eMAID: 'E-M…INAL',
      walletAddress: '0x1…1111',
      historicalPolicy: { source: 'operation_snapshot', revision: 8, rulesVersion: '8' },
      operationKey: expect.stringMatching(/^op_[0-9a-f]{24}$/),
      sessionId: expect.stringMatching(/^session_[0-9a-f]{24}$/),
    });
    expect(legacyAward?.historicalPolicy.source).toBe('unknown');
    expect(savedWalletSpend?.walletAddress).toBe('0x3…3333');
    expect(report.policy.currentRevision).toBe(99);
    expect(report.summary.totalsByAsset).toEqual(expect.arrayContaining([
      expect.objectContaining({ chainId: '137', tokenContractAddress: CONTRACT, awardedSparkz: '1.25' }),
      expect.objectContaining({ chainId: null, tokenContractAddress: null, provenance: 'legacy_unknown', awardedSparkz: '2.00' }),
    ]));
    expect(JSON.stringify(report)).not.toContain('outstandingSparkz');
    expect(JSON.stringify(report)).not.toContain('driver-session-E-MAID-ORIGINAL');
    expect(report.reconciliation.discrepancies[0]).toMatchObject({ eMAID: 'E-M…INAL', walletAddress: '0x1…1111' });
  });

  it('uses the selected activity timestamp for report membership', async () => {
    const insideCreatedOutsideConfirmed = '13cfb5db-37e0-46e6-8e36-1c4b3af14fd8';
    const outsideCreatedInsideConfirmed = 'f3dfda10-b5a7-486d-8d3c-c4fbb8b7f7c0';
    const ids = [insideCreatedOutsideConfirmed, outsideCreatedInsideConfirmed];
    const context = { assetContext: { chainId: '137', tokenContractAddress: CONTRACT } };
    await schemaDatabase('token_operations').insert([
      {
        id: insideCreatedOutsideConfirmed,
        operation_key: 'activity-created-in-window',
        operation_type: 'award',
        uid: 'E-MAID-ORIGINAL',
        wallet_address: WALLET,
        amount: '0.10',
        session_id: null,
        provider_id: null,
        reservation_id: null,
        intent_context: context,
        status: 'projected',
        movement_outcome: 'confirmed',
        tx_hash: `0x${'6'.repeat(64)}`,
        submitted_at: '2026-10-21T10:00:00.000Z',
        confirmed_at: '2026-10-23T10:00:00.000Z',
        projected_at: null,
        created_at: '2026-10-21T10:00:00.000Z',
        updated_at: '2026-10-21T10:00:00.000Z',
      },
      {
        id: outsideCreatedInsideConfirmed,
        operation_key: 'activity-created-outside',
        operation_type: 'award',
        uid: 'E-MAID-ORIGINAL',
        wallet_address: WALLET,
        amount: '0.20',
        session_id: null,
        provider_id: null,
        reservation_id: null,
        intent_context: context,
        status: 'projected',
        movement_outcome: 'confirmed',
        tx_hash: `0x${'7'.repeat(64)}`,
        submitted_at: '2026-10-19T10:00:00.000Z',
        confirmed_at: '2026-10-21T11:00:00.000Z',
        projected_at: null,
        created_at: '2026-10-19T10:00:00.000Z',
        updated_at: '2026-10-19T10:00:00.000Z',
      },
    ]);
    try {
      const report = await getAdminEvidenceReport(parseAdminEvidenceQuery({
        from: '2026-10-20T00:00:00.000Z',
        to: '2026-10-22T00:00:00.000Z',
        limit: '100',
      }));
      expect(report.rows.some(row => row.subjectId === insideCreatedOutsideConfirmed)).toBe(false);
      expect(report.rows.some(row => row.subjectId === outsideCreatedInsideConfirmed)).toBe(true);
    } finally {
      await schemaDatabase('token_operations').whereIn('id', ids).delete();
    }
  });

  it('marks chain-confirmed token operations awaiting projection as pending', async () => {
    const id = '2b2b2b2b-2b2b-4b2b-8b2b-2b2b2b2b2b2b';
    const hash = `0x${'b'.repeat(64)}`;
    await schemaDatabase('token_operations').insert({
      id,
      operation_key: 'projection-pending-operation',
      operation_type: 'award',
      uid: 'E-MAID-ORIGINAL',
      wallet_address: WALLET,
      amount: '0.10',
      session_id: null,
      provider_id: null,
      reservation_id: null,
      intent_context: { assetContext: { chainId: '137', tokenContractAddress: CONTRACT } },
      status: 'confirmed',
      movement_outcome: 'confirmed',
      tx_hash: hash,
      submitted_at: '2026-10-21T10:00:00.000Z',
      confirmed_at: '2026-10-21T10:01:00.000Z',
      projected_at: null,
      created_at: '2026-10-21T09:59:00.000Z',
      updated_at: '2026-10-21T10:01:00.000Z',
    });
    try {
      const report = await getAdminEvidenceReport(parseAdminEvidenceQuery({
        from: '2026-10-20T00:00:00.000Z',
        to: '2026-10-22T00:00:00.000Z',
        emaid: 'E-MAID-ORIGINAL',
        limit: '100',
      }));
      expect(report.rows.find(row => row.transactionHash === hash)).toMatchObject({
        status: 'confirmed',
        movementOutcome: 'confirmed',
        exceptionCategory: 'projection_pending',
      });
    } finally {
      await schemaDatabase('token_operations').where({ id }).delete();
    }
  });

  it('deduplicates mirrors but retains conflicting ownership, amounts, and assets for review', async () => {
    const ids = [
      '7342bb4f-1114-45ea-8be0-8c5f6fcf39ab',
      'f5d9d85f-cd40-4b5c-8af6-e37ad1db2fbf',
      'e1709d30-f10f-4acb-8189-41ba4c4649d4',
      'cb3d8be7-7c8b-4f5a-85a1-4c1f665d5108',
      'de8ad4b4-19cc-42df-a47c-dcf306dedf92',
    ];
    const hashes = ['6', '7', '8', '9', 'a'].map(value => `0x${value.repeat(64)}`);
    await schemaDatabase('token_operations').insert([
      {
        id: ids[0], operation_key: 'dedup-mirror-operation', operation_type: 'award', uid: 'E-MAID-ORIGINAL', wallet_address: WALLET,
        amount: '1.00', session_id: null, provider_id: null, reservation_id: null,
        intent_context: { assetContext: { chainId: '137', tokenContractAddress: CONTRACT } }, status: 'projected', movement_outcome: 'confirmed', tx_hash: hashes[0],
        submitted_at: null, confirmed_at: '2026-10-21T12:00:00.000Z', projected_at: null, created_at: '2026-10-21T12:00:00.000Z', updated_at: '2026-10-21T12:00:00.000Z',
      },
      {
        id: ids[1], operation_key: 'dedup-owner-operation', operation_type: 'award', uid: 'E-MAID-ORIGINAL', wallet_address: WALLET,
        amount: '1.00', session_id: null, provider_id: null, reservation_id: null,
        intent_context: { assetContext: { chainId: '137', tokenContractAddress: CONTRACT } }, status: 'projected', movement_outcome: 'confirmed', tx_hash: hashes[1],
        submitted_at: null, confirmed_at: '2026-10-21T12:01:00.000Z', projected_at: null, created_at: '2026-10-21T12:01:00.000Z', updated_at: '2026-10-21T12:01:00.000Z',
      },
      {
        id: ids[2], operation_key: 'dedup-amount-operation', operation_type: 'award', uid: 'E-MAID-ORIGINAL', wallet_address: WALLET,
        amount: '1.00', session_id: null, provider_id: null, reservation_id: null,
        intent_context: { assetContext: { chainId: '137', tokenContractAddress: CONTRACT } }, status: 'projected', movement_outcome: 'confirmed', tx_hash: hashes[2],
        submitted_at: null, confirmed_at: '2026-10-21T12:02:00.000Z', projected_at: null, created_at: '2026-10-21T12:02:00.000Z', updated_at: '2026-10-21T12:02:00.000Z',
      },
      {
        id: ids[3], operation_key: 'dedup-unknown-asset-operation', operation_type: 'award', uid: 'E-MAID-ORIGINAL', wallet_address: WALLET,
        amount: '1.00', session_id: null, provider_id: null, reservation_id: null,
        intent_context: { assetContext: { chainId: '137', tokenContractAddress: CONTRACT } }, status: 'projected', movement_outcome: 'confirmed', tx_hash: hashes[3],
        submitted_at: null, confirmed_at: '2026-10-21T12:03:00.000Z', projected_at: null, created_at: '2026-10-21T12:03:00.000Z', updated_at: '2026-10-21T12:03:00.000Z',
      },
      {
        id: ids[4], operation_key: 'dedup-multi-asset-operation', operation_type: 'award', uid: 'E-MAID-ORIGINAL', wallet_address: WALLET,
        amount: '1.00', session_id: null, provider_id: null, reservation_id: null,
        intent_context: { assetContext: { chainId: '137', tokenContractAddress: OTHER_CONTRACT } }, status: 'projected', movement_outcome: 'confirmed', tx_hash: hashes[4],
        submitted_at: null, confirmed_at: '2026-10-21T12:04:00.000Z', projected_at: null, created_at: '2026-10-21T12:04:00.000Z', updated_at: '2026-10-21T12:04:00.000Z',
      },
    ]);
    await schemaDatabase('token_operations').insert({
      id: 'a72b8ff1-e242-462a-960e-36d15c6674bc', operation_key: 'dedup-multi-asset-operation-known', operation_type: 'award', uid: 'E-MAID-ORIGINAL', wallet_address: WALLET,
      amount: '1.00', session_id: null, provider_id: null, reservation_id: null,
      intent_context: { assetContext: { chainId: '137', tokenContractAddress: CONTRACT } }, status: 'projected', movement_outcome: 'confirmed', tx_hash: hashes[4],
      submitted_at: null, confirmed_at: '2026-10-21T12:04:00.000Z', projected_at: null, created_at: '2026-10-21T12:04:00.000Z', updated_at: '2026-10-21T12:04:00.000Z',
    });
    await schemaDatabase('awards').insert([
      {
        id: '21ba5fc0-5691-4b7e-a8f7-79cd6c800f9f', user_id: USER_ID, session_id: 'mirror', provider_id: 'mirror', amount: '1.00', tx_hash: hashes[0], awarded_at: '2026-10-21T12:00:00.000Z', created_at: '2026-10-21T12:00:00.000Z', status: 'confirmed', confirmed_at: '2026-10-21T12:00:00.000Z',
      },
      {
        id: '6e47d23e-a7db-4e68-9611-b7abfc71760d', user_id: OTHER_USER_ID, session_id: 'owner-conflict', provider_id: 'owner-conflict', amount: '1.00', tx_hash: hashes[1], awarded_at: '2026-10-21T12:01:00.000Z', created_at: '2026-10-21T12:01:00.000Z', status: 'confirmed', confirmed_at: '2026-10-21T12:01:00.000Z',
      },
      {
        id: 'be40ef27-e56b-4ff9-9069-bca34e7d1ac8', user_id: USER_ID, session_id: 'amount-conflict', provider_id: 'amount-conflict', amount: '2.00', tx_hash: hashes[2], awarded_at: '2026-10-21T12:02:00.000Z', created_at: '2026-10-21T12:02:00.000Z', status: 'confirmed', confirmed_at: '2026-10-21T12:02:00.000Z',
      },
      {
        id: 'd64a76c6-5c17-470c-9fbe-12f83157ef87', user_id: USER_ID, session_id: 'unknown-asset-mirror', provider_id: 'unknown-asset-mirror', amount: '1.00', tx_hash: hashes[3], awarded_at: '2026-10-21T12:03:00.000Z', created_at: '2026-10-21T12:03:00.000Z', status: 'confirmed', confirmed_at: '2026-10-21T12:03:00.000Z',
      },
    ]);
    try {
      const report = await getAdminEvidenceReport(parseAdminEvidenceQuery({
        from: '2026-10-20T00:00:00.000Z',
        to: '2026-10-22T00:00:00.000Z',
        limit: '100',
      }));
      const rowsFor = (hash: string) => report.rows.filter(row => row.transactionHash === hash);
      expect(rowsFor(hashes[0])).toHaveLength(1);
      expect(rowsFor(hashes[0])[0].subjectType).toBe('token_operation');
      expect(rowsFor(hashes[1]).every(row => row.movementOutcome === 'review')).toBe(true);
      expect(rowsFor(hashes[2]).every(row => row.movementOutcome === 'review')).toBe(true);
      expect(rowsFor(hashes[3])).toHaveLength(1);
      expect(rowsFor(hashes[3])[0].subjectType).toBe('token_operation');
      expect(rowsFor(hashes[4]).length).toBe(2);
      expect(rowsFor(hashes[4]).every(row => row.movementOutcome === 'review')).toBe(true);
      expect(report.coverage.duplicateConflictCount).toBeGreaterThanOrEqual(3);
      expect(report.summary.totalsByAsset.find(asset => asset.tokenContractAddress === CONTRACT)?.awardedSparkz)
        .toBe('3.25');

      const ownerFiltered = await getAdminEvidenceReport(parseAdminEvidenceQuery({
        from: '2026-10-20T00:00:00.000Z',
        to: '2026-10-22T00:00:00.000Z',
        emaid: 'E-MAID-ORIGINAL',
        limit: '100',
      }));
      expect(ownerFiltered.rows.filter(row => row.transactionHash === hashes[1])).toHaveLength(1);
      expect(ownerFiltered.rows.find(row => row.transactionHash === hashes[1])?.movementOutcome).toBe('review');
      expect(ownerFiltered.summary.totalsByAsset.find(asset => asset.tokenContractAddress === CONTRACT)?.awardedSparkz)
        .toBe('3.25');

      const statusFiltered = await getAdminEvidenceReport(parseAdminEvidenceQuery({
        from: '2026-10-20T00:00:00.000Z',
        to: '2026-10-22T00:00:00.000Z',
        status: 'projected',
        limit: '100',
      }));
      expect(statusFiltered.rows.filter(row => row.transactionHash === hashes[1])).toHaveLength(1);
      expect(statusFiltered.rows.find(row => row.transactionHash === hashes[1])?.movementOutcome).toBe('review');
      expect(statusFiltered.summary.totalsByAsset.find(asset => asset.tokenContractAddress === CONTRACT)?.awardedSparkz)
        .toBe('3.25');

      const unresolved = await getAdminEvidenceReport(parseAdminEvidenceQuery({
        from: '2026-10-20T00:00:00.000Z',
        to: '2026-10-22T00:00:00.000Z',
        scope: 'unresolved',
        limit: '100',
      }));
      expect(unresolved.rows.filter(row => row.transactionHash === hashes[1])).toHaveLength(2);
      expect(unresolved.rows.filter(row => row.transactionHash === hashes[1]).every(row => row.movementOutcome === 'review')).toBe(true);
      expect(unresolved.summary.totalsByAsset.find(asset => asset.tokenContractAddress === CONTRACT)).toBeUndefined();
    } finally {
      await schemaDatabase('awards').whereIn('tx_hash', hashes).delete();
      await schemaDatabase('token_operations').whereIn('id', [...ids, 'a72b8ff1-e242-462a-960e-36d15c6674bc']).delete();
    }
  });

  it('keeps truncated-source pagination finite without manufacturing an empty next page', async () => {
    await schemaDatabase.raw(`
      insert into token_operations (
        id, operation_key, operation_type, uid, wallet_address, amount, session_id,
        provider_id, reservation_id, intent_context, status, movement_outcome,
        tx_hash, submitted_at, confirmed_at, projected_at, created_at, updated_at
      )
      select gen_random_uuid(), 'cap-page-' || series::text, 'award', 'E-MAID-CAP', ?, '0.01',
        null, null, null, null, 'submitted', 'unknown', null, null, null, null,
        '2026-10-21T13:00:00.000Z', '2026-10-21T13:00:00.000Z'
      from generate_series(1, 5001) as series
    `, [OTHER_WALLET]);
    try {
      const offsets: number[] = [];
      let query = parseAdminEvidenceQuery({
        from: '2026-10-20T00:00:00.000Z',
        to: '2026-10-22T00:00:00.000Z',
        limit: '500',
        offset: '0',
      });
      let report = await getAdminEvidenceReport(query);
      expect(report.coverage.truncated).toBe(true);
      for (let page = 0; page < 30 && report.pagination.hasMore; page += 1) {
        const nextOffset = report.pagination.nextOffset;
        expect(nextOffset).toBeGreaterThan(report.pagination.offset);
        offsets.push(report.pagination.offset);
        query = parseAdminEvidenceQuery({
          from: query.from,
          to: query.to,
          limit: String(query.limit),
          offset: String(nextOffset),
        });
        report = await getAdminEvidenceReport(query);
      }
      expect(offsets.length).toBeGreaterThan(5);
      expect(report.pagination.hasMore).toBe(false);
      expect(report.pagination.nextOffset).toBeNull();
      const emptyTail = await getAdminEvidenceReport(parseAdminEvidenceQuery({
        from: query.from,
        to: query.to,
        limit: '500',
        offset: String(report.pagination.offset + report.rows.length),
      }));
      expect(emptyTail.rows).toHaveLength(0);
      expect(emptyTail.pagination.hasMore).toBe(false);
      expect(emptyTail.pagination.nextOffset).toBeNull();
    } finally {
      await schemaDatabase('token_operations').where('operation_key', 'like', 'cap-page-%').delete();
    }
  });

  it('resolves all retained reference contexts and rejects ambiguity, mismatch, and overflow', async () => {
    await schemaDatabase('token_operations').insert([
      {
        id: '6e3c65e9-f911-4c8b-8e0f-c21df9e50af8', operation_key: 'reference-unknown-first', operation_type: 'award', uid: ' ', wallet_address: ' ', amount: '1.00',
        session_id: null, provider_id: null, reservation_id: null, intent_context: null, status: 'projected', movement_outcome: 'confirmed', tx_hash: TX_REFERENCE_CONFLICT,
        submitted_at: null, confirmed_at: '2026-10-21T14:00:00.000Z', projected_at: null, created_at: '2026-10-21T14:00:00.000Z', updated_at: '2026-10-21T14:00:00.000Z',
      },
      {
        id: 'a859a1e4-8fd5-44d8-abde-60c3a99b4f3a', operation_key: 'reference-target-unknown-first', operation_type: 'award', uid: ' ', wallet_address: ' ', amount: '1.00',
        session_id: null, provider_id: null, reservation_id: null, intent_context: null, status: 'projected', movement_outcome: 'confirmed', tx_hash: TX_REFERENCE_TARGET_MISMATCH,
        submitted_at: null, confirmed_at: '2026-10-21T14:01:00.000Z', projected_at: null, created_at: '2026-10-21T14:01:00.000Z', updated_at: '2026-10-21T14:01:00.000Z',
      },
    ]);
    await schemaDatabase('awards').insert([
      {
        id: 'f8c953eb-3437-43f3-b91b-d4f66dce369c', user_id: OTHER_USER_ID, session_id: 'reference-other', provider_id: 'reference-other', amount: '1.00', tx_hash: TX_REFERENCE_CONFLICT, awarded_at: '2026-10-21T14:00:00.000Z', created_at: '2026-10-21T14:00:00.000Z', status: 'confirmed', confirmed_at: '2026-10-21T14:00:00.000Z',
      },
      {
        id: '837cd553-b77d-4c4d-92df-88ac5a60552a', user_id: USER_ID, session_id: 'reference-original', provider_id: 'reference-original', amount: '1.00', tx_hash: TX_REFERENCE_CONFLICT, awarded_at: '2026-10-21T14:00:00.000Z', created_at: '2026-10-21T14:00:00.000Z', status: 'confirmed', confirmed_at: '2026-10-21T14:00:00.000Z',
      },
      {
        id: '9f9930f2-6e4b-4174-81e1-a6ce4ddf4c04', user_id: OTHER_USER_ID, session_id: 'reference-target-other', provider_id: 'reference-target-other', amount: '1.00', tx_hash: TX_REFERENCE_TARGET_MISMATCH, awarded_at: '2026-10-21T14:01:00.000Z', created_at: '2026-10-21T14:01:00.000Z', status: 'confirmed', confirmed_at: '2026-10-21T14:01:00.000Z',
      },
    ]);
    await schemaDatabase.raw(`
      insert into awards (id, user_id, session_id, provider_id, amount, tx_hash, awarded_at, created_at, status, confirmed_at)
      select gen_random_uuid(), ?, 'reference-overflow-' || series::text, 'reference-overflow', '1.00', ?,
        '2026-10-21T14:02:00.000Z', '2026-10-21T14:02:00.000Z', 'confirmed', '2026-10-21T14:02:00.000Z'
      from generate_series(1, 11) as series
    `, [USER_ID, TX_REFERENCE_OVERFLOW]);
    try {
      const conflictRequest = parseAdminCorrectionAnnotationRequest({
        clientRequestId: 'a1adf1a0-f1e8-40f6-83a4-b9acda0f1ef1', subjectType: 'token_operation', subjectId: TARGET_ID,
        referenceType: 'transaction', reference: TX_REFERENCE_CONFLICT, reason: 'Conflicting retained reference ownership',
      });
      await expect(createAdminCorrectionAnnotation(conflictRequest, 'admin@example.com'))
        .rejects.toMatchObject({ statusCode: 409, code: 'ANNOTATION_REFERENCE_CONTEXT_MISMATCH' });

      const mismatchRequest = parseAdminCorrectionAnnotationRequest({
        clientRequestId: '6c0cc7fd-f9ba-4e72-83f0-9f00a3a37d9a', subjectType: 'token_operation', subjectId: TARGET_ID,
        referenceType: 'transaction', reference: TX_REFERENCE_TARGET_MISMATCH, reason: 'Reference account differs from selected subject',
      });
      await expect(createAdminCorrectionAnnotation(mismatchRequest, 'admin@example.com'))
        .rejects.toMatchObject({ statusCode: 409, code: 'ANNOTATION_REFERENCE_CONTEXT_MISMATCH' });

      const overflowRequest = parseAdminCorrectionAnnotationRequest({
        clientRequestId: '2f9820c8-4c7f-45d5-9db8-c1914566f865', subjectType: 'token_operation', subjectId: TARGET_ID,
        referenceType: 'transaction', reference: TX_REFERENCE_OVERFLOW, reason: 'Reference match count must be bounded',
      });
      await expect(createAdminCorrectionAnnotation(overflowRequest, 'admin@example.com'))
        .rejects.toMatchObject({ statusCode: 409, code: 'ANNOTATION_REFERENCE_AMBIGUOUS' });
    } finally {
      await schemaDatabase('awards').whereIn('tx_hash', [TX_REFERENCE_CONFLICT, TX_REFERENCE_TARGET_MISMATCH, TX_REFERENCE_OVERFLOW]).delete();
      await schemaDatabase('token_operations').whereIn('tx_hash', [TX_REFERENCE_CONFLICT, TX_REFERENCE_TARGET_MISMATCH]).delete();
    }
  });

  it('persists idempotent annotations against an existing UUID while allowing a distinct original hash', async () => {
    const before = await getDatabase()('token_operations').count({ count: '*' }).first();
    const request = parseAdminCorrectionAnnotationRequest({
      clientRequestId: ANNOTATION_REQUEST_ID,
      subjectType: 'token_operation',
      subjectId: TARGET_ID,
      referenceType: 'transaction',
      reference: TX_ORIGINAL,
      reason: 'Original retained award evidence reviewed by support',
    });
    const first = await createAdminCorrectionAnnotation(request, 'admin@example.com');
    expect(first.sideEffects).toEqual({ financial: false });
    expect(first.annotation.resolvedReference.provenance).toBe('retained_award');
    const replay = await createAdminCorrectionAnnotation(request, 'admin@example.com');
    expect(replay.annotation.id).toBe(first.annotation.id);
    const concurrent = await Promise.all([
      createAdminCorrectionAnnotation(request, 'admin@example.com'),
      createAdminCorrectionAnnotation(request, 'admin@example.com'),
    ]);
    expect(concurrent.map(result => result.annotation.id)).toEqual([first.annotation.id, first.annotation.id]);
    await expect(createAdminCorrectionAnnotation({ ...request, reason: 'changed payload' }, 'admin@example.com')).rejects.toMatchObject({ statusCode: 409, code: 'ANNOTATION_REQUEST_CONFLICT' });
    await expect(createAdminCorrectionAnnotation({ ...request, subjectId: '9e8c6d8b-a9fb-42c8-b7d1-8a6f01b82e11', clientRequestId: 'da41e9aa-0f52-40a5-bc4e-b802e4c12c01' }, 'admin@example.com')).rejects.toMatchObject({ statusCode: 404, code: 'ANNOTATION_SUBJECT_NOT_FOUND' });
    const after = await getDatabase()('token_operations').count({ count: '*' }).first();
    expect(after?.count).toBe(before?.count);
    const listed = await listAdminCorrectionAnnotations({ subjectType: 'token_operation', subjectId: TARGET_ID, limit: 10, offset: 0 });
    expect(listed.count).toBe(1);
    expect(listed.annotations[0].resolvedReference.provenance).toBe('retained_award');
  });

  it('fails safely when annotation persistence is unavailable without touching financial subjects', async () => {
    const before = await schemaDatabase('token_operations').count({ count: '*' }).first();
    await rollbackAnnotations(schemaDatabase);
    expect(await schemaDatabase.schema.hasTable('admin_correction_annotations')).toBe(false);
    await expect(createAdminCorrectionAnnotation({
      clientRequestId: 'f5b0e65b-c603-4d6c-bc72-3bde7de6d2d8',
      subjectType: 'token_operation',
      subjectId: TARGET_ID,
      referenceType: 'transaction',
      reference: TX_ORIGINAL,
      reason: 'Persistence failure must not become a financial operation',
    }, 'admin@example.com')).rejects.toMatchObject({ statusCode: 503, code: 'ANNOTATION_SCHEMA_UNAVAILABLE' });
    const after = await schemaDatabase('token_operations').count({ count: '*' }).first();
    expect(after?.count).toBe(before?.count);
    expect(await schemaDatabase('token_operations').count({ count: '*' })).toHaveLength(1);
  });
});
