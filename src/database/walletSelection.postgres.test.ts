import 'dotenv/config';

import crypto from 'crypto';
import knex, { Knex } from 'knex';
import { up as migrateUidWalletUniqueness } from './migrations/008_allow_uid_per_wallet';
import { up as migrateActiveWalletSelection } from './migrations/022_add_active_wallet_selection';
import { closeDatabase } from './connection';
import { Users } from './service';
import { recordAward, recordSpend } from './integration';
import { getUserWalletConfig, setUserWalletMode } from '../user/userService';

const { parseDisposableDatabaseUrl } = require('../../scripts/disposableDatabaseUrl') as {
  parseDisposableDatabaseUrl: (databaseUrl: string) => { databaseName: string; port: number };
};

const describeLocal = process.env.RUN_LOCAL_WALLET_TESTS === '1' ? describe : describe.skip;

function requireDisposableDatabaseUrl(): string {
  const databaseUrl = process.env.WALLET_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('RUN_LOCAL_WALLET_TESTS requires WALLET_DATABASE_URL for a disposable database');
  }

  try {
    parseDisposableDatabaseUrl(databaseUrl);
  } catch (error) {
    throw new Error(`WALLET_DATABASE_URL must target a loopback disposable database: ${error instanceof Error ? error.message : String(error)}`);
  }
  return databaseUrl;
}

describeLocal('active wallet selection and UID wallet migration (local PostgreSQL)', () => {
  let database: Knex;
  let administrativeDatabase: Knex;
  let databaseUrl: string;
  let isolatedSchema: string;

  async function createUsersTable(
    globalUidConstraint = false,
    activeColumn = false,
    projectionTables = false,
  ): Promise<void> {
    await database.schema.dropTableIfExists('spends');
    await database.schema.dropTableIfExists('awards');
    await database.schema.dropTableIfExists('balances');
    await database.schema.dropTableIfExists('users');
    await database.schema.createTable('users', table => {
      table.uuid('id').primary().defaultTo(database.raw('gen_random_uuid()'));
      table.string('uid').notNullable();
      table.string('wallet_address', 42).notNullable();
      table.string('wallet_name', 120).nullable();
      if (activeColumn) table.boolean('is_active').notNullable().defaultTo(true);
      table.timestamp('created_at').notNullable().defaultTo(database.fn.now());
      table.timestamp('updated_at').notNullable().defaultTo(database.fn.now());
    });
    if (globalUidConstraint) {
      await database.raw('alter table users add constraint users_uid_unique unique (uid)');
    }

    if (projectionTables) {
      await database.schema.createTable('awards', table => {
        table.uuid('id').primary().defaultTo(database.raw('gen_random_uuid()'));
        table.uuid('user_id').notNullable().references('id').inTable('users');
        table.string('session_id').notNullable();
        table.string('provider_id').notNullable();
        table.string('dedup_key').notNullable();
        table.decimal('amount', 20, 2).notNullable();
        table.text('cdr_data').nullable();
        table.string('tx_hash', 66).notNullable();
        table.timestamp('awarded_at').notNullable();
        table.string('award_type').nullable();
        table.boolean('is_off_peak').nullable();
        table.string('country_code').nullable();
        table.string('local_time').nullable();
        table.string('status').nullable();
        table.text('error_message').nullable();
        table.timestamp('confirmed_at').nullable();
        table.timestamp('created_at').notNullable().defaultTo(database.fn.now());
      });
      await database.schema.createTable('balances', table => {
        table.uuid('id').primary().defaultTo(database.raw('gen_random_uuid()'));
        table.uuid('user_id').notNullable().references('id').inTable('users').unique();
        table.string('wallet_address', 42).notNullable();
        table.decimal('balance', 20, 2).notNullable().defaultTo(0);
        table.decimal('total_awarded', 20, 2).notNullable().defaultTo(0);
        table.decimal('total_spent', 20, 2).notNullable().defaultTo(0);
        table.timestamp('last_synced').notNullable().defaultTo(database.fn.now());
        table.timestamp('created_at').notNullable().defaultTo(database.fn.now());
        table.timestamp('updated_at').notNullable().defaultTo(database.fn.now());
      });
      await database.schema.createTable('spends', table => {
        table.uuid('id').primary().defaultTo(database.raw('gen_random_uuid()'));
        table.uuid('user_id').notNullable().references('id').inTable('users');
        table.string('wallet_address', 42).notNullable();
        table.decimal('amount', 20, 2).notNullable();
        table.string('tx_hash', 66).notNullable();
        table.string('session_id').nullable();
        table.string('status').nullable();
        table.text('error_message').nullable();
        table.timestamp('confirmed_at').nullable();
        table.timestamp('created_at').notNullable().defaultTo(database.fn.now());
      });
    }
  }

  async function insertUser(uid: string, walletAddress: string, createdAt: string, isActive?: boolean): Promise<void> {
    await database('users').insert({
      uid,
      wallet_address: walletAddress,
      ...(isActive === undefined ? {} : { is_active: isActive }),
      created_at: createdAt,
      updated_at: createdAt,
    });
  }

  beforeAll(async () => {
    databaseUrl = requireDisposableDatabaseUrl();
    isolatedSchema = `nvf_wallet_test_${crypto.randomUUID().replace(/-/g, '')}`;
    administrativeDatabase = knex({
      client: 'pg',
      connection: { connectionString: databaseUrl },
      pool: { min: 1, max: 2 },
    });
    await administrativeDatabase.raw(`create schema "${isolatedSchema}"`);
    database = knex({
      client: 'pg',
      connection: {
        connectionString: databaseUrl,
        options: `-c search_path="${isolatedSchema}",public`,
      },
      pool: { min: 1, max: 10 },
    });
    await database.raw('create extension if not exists pgcrypto');
    process.env.DATABASE_URL = `${databaseUrl}?options=${encodeURIComponent(`-c search_path="${isolatedSchema}",public`)}`;
    process.env.USER_ADDRESS_DERIVATION_SALT = 'wallet-selection-test';
  });

  afterAll(async () => {
    try {
      if (isolatedSchema) {
        await administrativeDatabase?.raw(`drop schema if exists "${isolatedSchema}" cascade`);
      }
    } finally {
      await Promise.allSettled([
        closeDatabase(),
        database?.destroy(),
        administrativeDatabase?.destroy(),
      ]);
    }
  });

  it('removes restored global UID uniqueness and remains safe to rerun', async () => {
    await createUsersTable(true);
    await insertUser('legacy-uid', '0x1111111111111111111111111111111111111111', '2026-01-01T00:00:00.000Z');

    await migrateUidWalletUniqueness(database);
    await database.raw('drop index users_uid_wallet_lower_unique');
    await database.raw('alter table users add constraint users_uid_unique unique (uid)');
    await migrateUidWalletUniqueness(database);
    await insertUser('legacy-uid', '0x2222222222222222222222222222222222222222', '2026-01-02T00:00:00.000Z');
    await migrateUidWalletUniqueness(database);
    await insertUser('legacy-uid', '0x3333333333333333333333333333333333333333', '2026-01-03T00:00:00.000Z');

    const globalConstraint = await database.raw(`
      select 1 from pg_constraint where conname = 'users_uid_unique'
    `);
    const scopedIndex = await database.raw(`
      select 1 from pg_indexes where indexname = 'users_uid_wallet_lower_unique'
    `);
    expect(globalConstraint.rows).toHaveLength(0);
    expect(scopedIndex.rows).toHaveLength(1);
    expect(await database('users').where({ uid: 'legacy-uid' })).toHaveLength(3);
  });

  it('checks duplicate UID and wallet pairs before destructive migration work', async () => {
    await createUsersTable();
    await insertUser('duplicate-uid', '0x4444444444444444444444444444444444444444', '2026-01-01T00:00:00.000Z');
    await insertUser('duplicate-uid', '0X4444444444444444444444444444444444444444', '2026-01-02T00:00:00.000Z');
    await database.raw('create unique index users_wallet_address_uid_unique on users (uid, wallet_address)');

    await expect(migrateUidWalletUniqueness(database)).rejects.toThrow('Duplicates exist');
    const globalConstraint = await database.raw(`
      select 1 from pg_constraint where conname = 'users_uid_unique'
    `);
    const scopedIndex = await database.raw(`
      select 1 from pg_indexes where indexname = 'users_uid_wallet_lower_unique'
    `);
    const legacyIndex = await database.raw(`
      select 1 from pg_indexes where indexname = 'users_wallet_address_uid_unique'
    `);
    expect(globalConstraint.rows).toHaveLength(0);
    expect(scopedIndex.rows).toHaveLength(0);
    expect(legacyIndex.rows).toHaveLength(1);
    expect(await database('users').where({ uid: 'duplicate-uid' })).toHaveLength(2);
  });

  it('backfills one deterministic active row and preserves an explicit selection on rerun', async () => {
    await createUsersTable();
    await insertUser('active-uid', '0x5555555555555555555555555555555555555555', '2026-01-01T00:00:00.000Z');
    await insertUser('active-uid', '0x6666666666666666666666666666666666666666', '2026-01-02T00:00:00.000Z');

    await migrateActiveWalletSelection(database);
    let rows = await database('users').where({ uid: 'active-uid' }).orderBy('created_at', 'asc');
    expect(rows.filter(row => row.is_active)).toHaveLength(1);
    expect(rows[0].is_active).toBe(true);

    await database('users').where({ uid: 'active-uid', wallet_address: '0x5555555555555555555555555555555555555555' }).update({ is_active: false });
    await database('users').where({ uid: 'active-uid', wallet_address: '0x6666666666666666666666666666666666666666' }).update({ is_active: true });
    await migrateActiveWalletSelection(database);
    rows = await database('users').where({ uid: 'active-uid' }).orderBy('created_at', 'asc');
    expect(rows.find(row => row.is_active)?.wallet_address).toBe('0x6666666666666666666666666666666666666666');
  });

  it('keeps migration and wallet switching serialized by the users table lock', async () => {
    await createUsersTable(false, true);
    await insertUser('lock-uid', '0x9999999999999999999999999999999999999999', '2026-01-01T00:00:00.000Z', true);
    await insertUser('lock-uid', '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', '2026-01-02T00:00:00.000Z', false);

    let migrationPromise!: Promise<void>;
    let switchPromise!: Promise<unknown>;
    let migrationSettled = false;
    let switchSettled = false;
    await database.transaction(async trx => {
      await trx.raw('lock table users in access exclusive mode');
      migrationPromise = migrateActiveWalletSelection(database).then(() => {
        migrationSettled = true;
      });
      switchPromise = Users.activateWallet('lock-uid', '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA').then(() => {
        switchSettled = true;
      });
      await trx.raw('select pg_sleep(0.2)');
      expect(migrationSettled).toBe(false);
      expect(switchSettled).toBe(false);
    });

    await Promise.all([migrationPromise, switchPromise]);
    const rows = await database('users').where({ uid: 'lock-uid' });
    expect(rows.filter(row => row.is_active)).toHaveLength(1);
  });

  it('switches the active wallet in both directions, preserves links, and serializes concurrent switches', async () => {
    await createUsersTable(false, true);
    await database.raw('create unique index users_uid_active_unique on users (uid) where is_active = true');

    const uid = 'selection-1';
    const externalWallet = '0x7777777777777777777777777777777777777777';
    const secondHistoricalWallet = '0x8888888888888888888888888888888888888888';

    await setUserWalletMode(uid, 'managed');
    const managedConfig = await getUserWalletConfig(uid);
    expect(managedConfig.walletMode).toBe('managed');

    await setUserWalletMode(uid, 'custodial', externalWallet);
    let config = await getUserWalletConfig(uid);
    expect(config).toMatchObject({ walletMode: 'custodial', walletAddress: externalWallet });

    await Users.linkContractId(uid, secondHistoricalWallet);
    await Users.updateWalletNameByAddress(secondHistoricalWallet, 'historical wallet');
    config = await getUserWalletConfig(uid);
    expect(config).toMatchObject({ walletMode: 'custodial', walletAddress: externalWallet });

    await setUserWalletMode(uid, 'managed');
    config = await getUserWalletConfig(uid);
    expect(config.walletMode).toBe('managed');

    await setUserWalletMode(uid, 'custodial', externalWallet);
    config = await getUserWalletConfig(uid);
    expect(config).toMatchObject({ walletMode: 'custodial', walletAddress: externalWallet });

    await closeDatabase();
    config = await getUserWalletConfig(uid);
    expect(config).toMatchObject({ walletMode: 'custodial', walletAddress: externalWallet });

    await Promise.all([
      Users.activateWallet(uid, managedConfig.managedWalletAddress),
      Users.activateWallet(uid, externalWallet),
    ]);
    const rows = await database('users').where({ uid });
    expect(rows.filter(row => row.is_active)).toHaveLength(1);
    expect(await Users.findByUid(uid)).toMatchObject({ is_active: true });
  });

  it('projects awards and spends to inactive historical wallets without changing the active choice', async () => {
    await createUsersTable(false, true, true);
    await database.raw('create unique index users_uid_active_unique on users (uid) where is_active = true');

    const uid = 'projection-uid';
    const activeWallet = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
    const historicalWallet = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
    await Users.activateWallet(uid, activeWallet);
    const historical = await Users.linkContractId(uid, historicalWallet);
    const session = {
      uid,
      sessionId: 'projection-session',
      providerId: 'projection-provider',
      evseId: 'projection-evse',
      startTime: new Date('2026-01-01T00:00:00.000Z'),
      endTime: new Date('2026-01-01T01:00:00.000Z'),
      energyKWh: 10,
      energyDirection: 'CHARGE' as const,
    } as Parameters<typeof recordAward>[0];

    await recordAward(
      session,
      1.25,
      'projection-award-key',
      `0x${'1'.repeat(64)}`,
      '{}',
      undefined,
      historicalWallet,
    );
    await recordSpend(
      historicalWallet,
      0.5,
      `0x${'2'.repeat(64)}`,
      'projection-spend-session',
      uid,
    );

    const config = await getUserWalletConfig(uid);
    expect(config).toMatchObject({ walletAddress: activeWallet, walletMode: 'custodial' });
    const users = await database('users').where({ uid });
    expect(users).toHaveLength(2);
    expect(users.find(row => row.wallet_address === activeWallet)?.is_active).toBe(true);
    expect(users.find(row => row.wallet_address === historicalWallet)?.is_active).toBe(false);

    const award = await database('awards').where({ dedup_key: 'projection-award-key' }).first();
    const spend = await database('spends').where({ tx_hash: `0x${'2'.repeat(64)}` }).first();
    const balance = await database('balances').where({ user_id: historical.id }).first();
    expect(award).toMatchObject({ user_id: historical.id, amount: '1.25' });
    expect(spend).toMatchObject({ user_id: historical.id, amount: '0.50' });
    expect(balance).toMatchObject({ user_id: historical.id, balance: '0.75', total_awarded: '1.25', total_spent: '0.50' });

    const firstUid = 'projection-first';
    const firstWallet = '0xDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';
    const firstSession = { ...session, uid: firstUid, sessionId: 'projection-first-session' } as Parameters<typeof recordAward>[0];
    await recordAward(firstSession, 0.75, 'projection-first-key', `0x${'3'.repeat(64)}`, '{}', undefined, firstWallet);
    const firstRows = await database('users').where({ uid: firstUid });
    expect(firstRows).toHaveLength(1);
    expect(firstRows[0]).toMatchObject({ wallet_address: firstWallet, is_active: true });
  });
});
