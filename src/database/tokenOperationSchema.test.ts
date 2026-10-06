import 'dotenv/config';

import crypto from 'crypto';
import knex, { Knex } from 'knex';
import {
  ensureChargingSessionGuard,
  getTokenOperationSchemaStatus,
  stageTokenOperationSchema,
} from './tokenOperationSchema';
import { up as runStrictMigration015 } from './migrations/015_add_token_operations';
import { up as runChargingSessionMigration017 } from './migrations/017_add_charging_session_guard';

function requireDisposableSchemaDatabaseUrl(): string {
  const databaseUrl = process.env.SCHEMA_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('RUN_LOCAL_SCHEMA_TESTS requires SCHEMA_DATABASE_URL for a disposable database');
  }

  let target: URL;
  try {
    target = new URL(databaseUrl);
  } catch {
    throw new Error('SCHEMA_DATABASE_URL must be a valid PostgreSQL URL');
  }
  const databaseName = decodeURIComponent(target.pathname.replace(/^\//, ''));
  if (target.protocol !== 'postgres:'
    || !['localhost', '127.0.0.1'].includes(target.hostname)
    || !target.port
    || !/^nvf_award_(?:check|test)_[a-z0-9_-]+$/i.test(databaseName)) {
    throw new Error('SCHEMA_DATABASE_URL must target a loopback disposable nvf_award_check_* or nvf_award_test_* database');
  }
  return databaseUrl;
}

if (process.env.RUN_LOCAL_SCHEMA_TESTS === '1') {
  jest.setTimeout(30_000);
  describe('staged token operation schema (local PostgreSQL)', () => {
    let database: Knex;
    let isolatedDb: Knex;
    let strictDb: Knex;
    let isolatedSchema: string;
    let strictSchema: string;

    const inSchema = async <T>(
      db: Knex,
      schema: string,
      callback: (trx: Knex.Transaction) => Promise<T>,
    ): Promise<T> => db.transaction(async trx => {
      // Keep public out of the test search path: strict migration 015 uses
      // unqualified DDL and must be unable to resolve active local tables.
      await trx.raw(`set local search_path to "${schema}"`);
      return callback(trx);
    });

    beforeAll(async () => {
      const databaseUrl = requireDisposableSchemaDatabaseUrl();

      database = knex({ client: 'pg', connection: { connectionString: databaseUrl } });
      isolatedSchema = `nvf_schema_test_${crypto.randomUUID().replace(/-/g, '')}`;
      strictSchema = `nvf_strict_test_${crypto.randomUUID().replace(/-/g, '')}`;
      await database.raw(`create schema "${isolatedSchema}"`);
      await database.raw(`create schema "${strictSchema}"`);
      isolatedDb = knex({
        client: 'pg',
        connection: { connectionString: databaseUrl },
        // The race test needs two PostgreSQL connections. `SET LOCAL` in
        // inSchema keeps each transaction scoped to its disposable schema.
        pool: { min: 1, max: 2 },
      });
      strictDb = knex({
        client: 'pg',
        connection: { connectionString: databaseUrl },
        pool: { min: 1, max: 1 },
      });
      await inSchema(isolatedDb, isolatedSchema, async trx => {
        await trx.raw('create table awards (id uuid default gen_random_uuid(), tx_hash text)');
        await trx.raw('create table spends (id uuid default gen_random_uuid(), tx_hash text)');
        await trx.raw('create table spend_receipts (id uuid default gen_random_uuid(), token_tx_hash text)');
        await stageTokenOperationSchema(trx as unknown as Knex);
        await runChargingSessionMigration017(trx as unknown as Knex);
      });

      await inSchema(strictDb, strictSchema, async trx => {
        await trx.raw('create table awards (id uuid default gen_random_uuid(), tx_hash text)');
        await trx.raw('create table spends (id uuid default gen_random_uuid(), tx_hash text)');
        await trx.raw('create table spend_receipts (id uuid default gen_random_uuid(), token_tx_hash text)');
        await runStrictMigration015(trx as unknown as Knex);
        await runChargingSessionMigration017(trx as unknown as Knex);
      });
    });

    afterAll(async () => {
      try {
        if (isolatedSchema) {
          await database?.raw(`drop schema if exists "${isolatedSchema}" cascade`);
        }
        if (strictSchema) {
          await database?.raw(`drop schema if exists "${strictSchema}" cascade`);
        }
      } finally {
        await Promise.allSettled([
          isolatedDb?.destroy(),
          strictDb?.destroy(),
          database?.destroy(),
        ]);
      }
    });

    it('reports the isolated safeguards read-only', async () => {
      const status = await inSchema(isolatedDb, isolatedSchema, trx => getTokenOperationSchemaStatus(trx));
      expect(status.stagedReady).toBe(true);
      expect(status.operationKeyUnique).toBe(true);
      expect(status.approvalOperationKeyUnique).toBe(true);
      expect(status.validDuplicateGroups).toBe(0);
      expect(status.invalidLegacyRows).toBe(0);
      expect(status.missing).toEqual([]);
    });

    it('stages isolated operation and projection tables with scoped guards', async () => {
      const status = await inSchema(isolatedDb, isolatedSchema, trx => getTokenOperationSchemaStatus(trx));
      expect(status).toMatchObject({
        stagedReady: true,
        operationKeyUnique: true,
        approvalOperationKeyUnique: true,
        tokenOperationHashIndex: true,
        projectionHashIndexes: true,
        hashChecks: true,
        validDuplicateGroups: 0,
        missing: [],
      });
    });

    it('adds a nullable provider/charging-session guard without backfilling legacy rows', async () => {
      const status = await inSchema(isolatedDb, isolatedSchema, async trx => {
        const column = await trx.raw(
          `select 1 from information_schema.columns
             where table_schema = current_schema()
               and table_name = 'token_operations'
               and column_name = 'charging_session_id'`,
        );
        const index = await trx.raw(
          `select idx.relname as name
             from pg_class idx
             join pg_index ix on ix.indexrelid = idx.oid
             join pg_class tbl on tbl.oid = ix.indrelid
            where tbl.oid = to_regclass('token_operations')::oid
              and idx.relname = 'token_operations_award_provider_charging_session_unique'
              and ix.indisunique and ix.indisvalid and ix.indisready`,
        );
        await trx('token_operations').insert({
          operation_key: `legacy-unbound-${crypto.randomUUID()}`,
          operation_type: 'award',
          request_fingerprint: 'legacy-unbound-fingerprint',
          uid: 'legacy-unbound-emaid',
          wallet_address: '0x3333333333333333333333333333333333333333',
          amount: '0.00',
          status: 'projected',
          movement_outcome: 'no_movement',
        });
        const legacyNulls = await trx('token_operations').whereNull('charging_session_id').count<{ count: string }>({ count: '*' });
        return { column: column.rows.length, index: index.rows.length, legacyNulls: Number(legacyNulls[0]?.count || 0) };
      });

      expect(status).toEqual({ column: 1, index: 1, legacyNulls: 1 });
    });

    it('rejects a same-named charging guard whose predicate covers only a subset of awards', async () => {
      await inSchema(isolatedDb, isolatedSchema, async trx => {
        await trx.raw('drop index "token_operations_award_provider_charging_session_unique"');
        await trx.raw(
          `create unique index "token_operations_award_provider_charging_session_unique"
             on "token_operations" (provider_id, charging_session_id)
            where operation_type = 'award'
              and provider_id is not null
              and charging_session_id is not null
              and amount = 0`,
        );
        await expect(ensureChargingSessionGuard(trx)).rejects.toThrow(
          /not a valid enforcing provider\/session award guard/,
        );
        await trx.raw('drop index "token_operations_award_provider_charging_session_unique"');
        await ensureChargingSessionGuard(trx);
      });
    });

    it('serializes distinct CDR claims for one provider and physical session at the SQL boundary', async () => {
      const providerId = `schema-provider-${crypto.randomUUID()}`;
      const chargingSessionId = `physical-${crypto.randomUUID()}`;
      const makeRow = (suffix: string) => ({
        operation_key: `award-session-${suffix}-${crypto.randomUUID()}`,
        operation_type: 'award',
        request_fingerprint: `fingerprint-${suffix}`,
        uid: `emaid-${suffix}`,
        wallet_address: `0x4444444444444444444444444444444444444444`,
        amount: '1.00',
        provider_id: providerId,
        charging_session_id: chargingSessionId,
        status: 'submitting',
        movement_outcome: 'unknown',
      });
      const results = await Promise.allSettled([
        inSchema(isolatedDb, isolatedSchema, trx => trx('token_operations').insert(makeRow('a'))),
        inSchema(isolatedDb, isolatedSchema, trx => trx('token_operations').insert(makeRow('b'))),
      ]);
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
      await inSchema(isolatedDb, isolatedSchema, trx => trx('token_operations')
        .where({ provider_id: providerId, charging_session_id: chargingSessionId }).delete());
    });

    it('accepts a fresh strict migration full-hash guard as ready', async () => {
      const status = await inSchema(strictDb, strictSchema, trx => getTokenOperationSchemaStatus(trx));
      expect(status.projectionHashIndexes).toBe(true);
      expect(status.stagedReady).toBe(true);
      expect(status.strictMigrationReady).toBe(true);
      expect(status.missing).toEqual([]);
      const indexes = await inSchema(strictDb, strictSchema, trx => trx.raw(
        `select idx.relname as name
           from pg_class idx
           join pg_index ix on ix.indexrelid = idx.oid
           join pg_class tbl on tbl.oid = ix.indrelid
          where tbl.relname in ('awards', 'spends', 'spend_receipts')
            and idx.relname in ('awards_tx_hash_lower_unique', 'spends_tx_hash_lower_unique', 'spend_receipts_token_tx_hash_lower_unique')`,
      ));
      expect(indexes.rows.map((row: { name: string }) => row.name)).toEqual(expect.arrayContaining([
        'awards_tx_hash_lower_unique',
        'spends_tx_hash_lower_unique',
        'spend_receipts_token_tx_hash_lower_unique',
      ]));
    });

    it('rejects mixed-case duplicate operation hashes and malformed hashes', async () => {
      const hash = `0x${'a'.repeat(64)}`;
      const base = {
        operation_key: `schema-test-${crypto.randomUUID()}`,
        operation_type: 'award',
        request_fingerprint: 'schema-test-fingerprint',
        uid: 'schema-test-emaid',
        wallet_address: '0x1111111111111111111111111111111111111111',
        amount: '1.00',
        status: 'submitting',
        movement_outcome: 'unknown',
        tx_hash: hash,
      };

      await inSchema(isolatedDb, isolatedSchema, async trx => {
        await trx('token_operations').insert(base);
        await expect(trx.transaction(async savepoint => {
          await savepoint('token_operations').insert({
            ...base,
            operation_key: `${base.operation_key}-case`,
            tx_hash: `0x${'A'.repeat(64)}`,
          });
        })).rejects.toThrow(/unique|duplicate/i);
        await trx('token_operations').where({ operation_key: base.operation_key }).delete();
      });

      await expect(inSchema(isolatedDb, isolatedSchema, async trx => {
        await trx('token_operations').insert({
          ...base,
          operation_key: `${base.operation_key}-invalid`,
          tx_hash: 'uid-only-contract',
        });
      })).rejects.toThrow(/token_operations_tx_hash_format_check|check constraint/i);
    });

    it('enforces the valid-hash guard on an isolated spend projection', async () => {
      const hash = `0x${'b'.repeat(64)}`;
      const base = { tx_hash: hash };
      await inSchema(isolatedDb, isolatedSchema, async trx => {
        await trx('spends').insert(base);
        await expect(trx.transaction(async savepoint => {
          await savepoint('spends').insert({ tx_hash: `0x${'B'.repeat(64)}` });
        })).rejects.toThrow(/unique|duplicate/i);
        await trx('spends').where({ tx_hash: base.tx_hash }).delete();
      });
    });

    it('keeps operation-key uniqueness under concurrent claims at the SQL boundary', async () => {
      const operationKey = `schema-concurrency-${crypto.randomUUID()}`;
      const row = {
        operation_key: operationKey,
        operation_type: 'award',
        request_fingerprint: 'schema-concurrency-fingerprint',
        uid: 'schema-concurrency-emaid',
        wallet_address: '0x2222222222222222222222222222222222222222',
        amount: '1.00',
        status: 'submitting',
        movement_outcome: 'unknown',
      };
      try {
        const results = await Promise.allSettled([
          inSchema(isolatedDb, isolatedSchema, trx => trx('token_operations').insert(row)),
          inSchema(isolatedDb, isolatedSchema, trx => trx('token_operations').insert(row)),
        ]);
        expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
        expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
      } finally {
        await inSchema(isolatedDb, isolatedSchema, trx => trx('token_operations').where({ operation_key: operationKey }).delete());
      }
    });

    it('does not report non-unique or unvalidated guards as ready', async () => {
      const status = await inSchema(isolatedDb, isolatedSchema, async trx => {
        await trx.raw(`drop index "awards_tx_hash_valid_lower_unique"`);
        await trx.raw(
          `create index "awards_tx_hash_valid_lower_unique" on "awards" (lower("tx_hash")) where "tx_hash" ~ '^0x[0-9a-fA-F]{64}$'`,
        );
        await trx.raw(`alter table "token_operations" drop constraint "token_operations_tx_hash_format_check"`);
        await trx.raw(
          `alter table "token_operations" add constraint "token_operations_tx_hash_format_check" check (tx_hash is null or tx_hash ~ '^0x[0-9a-fA-F]{64}$') not valid`,
        );
        return getTokenOperationSchemaStatus(trx);
      });

      expect(status.stagedReady).toBe(false);
      expect(status.missing).toEqual(expect.arrayContaining([
        'projection transaction-hash uniqueness guards',
        'token_operations_tx_hash_format_check',
      ]));
    });
  });
} else {
  describe.skip('staged token operation schema (local PostgreSQL)', () => {
    it.skip('requires RUN_LOCAL_SCHEMA_TESTS=1 and the isolated local database', () => undefined);
  });
}
