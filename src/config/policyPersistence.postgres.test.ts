import 'dotenv/config';

import crypto from 'crypto';
import knex, { Knex } from 'knex';
import { createRewardPolicyRepository } from './policyPersistence';
import { getDefaultAwardRules, getDefaultOffPeakWindows } from './policyDefaults';
import {
  down as rollbackRewardPolicy,
  up as migrateRewardPolicy,
} from '../database/migrations/016_add_reward_policy';

const runLocalPolicyTests = process.env.RUN_LOCAL_POLICY_TESTS === '1';
const describeLocal = runLocalPolicyTests ? describe : describe.skip;

function requireDisposablePolicyDatabaseUrl(): string {
  const databaseUrl = process.env.POLICY_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error('RUN_LOCAL_POLICY_TESTS requires POLICY_DATABASE_URL for a disposable database');
  }

  let target: URL;
  try {
    target = new URL(databaseUrl);
  } catch {
    throw new Error('POLICY_DATABASE_URL must be a valid PostgreSQL URL');
  }
  const databaseName = decodeURIComponent(target.pathname.replace(/^\//, ''));
  if (target.protocol !== 'postgres:'
    || !['localhost', '127.0.0.1'].includes(target.hostname)
    || !target.port
    || !/^nvf_award_(?:check|test)_[a-z0-9_-]+$/i.test(databaseName)) {
    throw new Error('POLICY_DATABASE_URL must target a loopback disposable nvf_award_check_* or nvf_award_test_* database');
  }
  return databaseUrl;
}

describeLocal('durable reward policy persistence (local PostgreSQL)', () => {
  let database: Knex;
  let concurrentDatabase: Knex;
  let isolatedSchema: string;

  const setSearchPath = async (connection: Knex): Promise<void> => {
    await connection.raw(`set search_path to "${isolatedSchema}", public`);
  };

  beforeAll(async () => {
    const databaseUrl = requireDisposablePolicyDatabaseUrl();

    isolatedSchema = `nvf_policy_test_${crypto.randomUUID().replace(/-/g, '')}`;
    database = knex({
      client: 'pg',
      connection: { connectionString: databaseUrl },
      pool: { min: 1, max: 1 },
    });
    concurrentDatabase = knex({
      client: 'pg',
      connection: { connectionString: databaseUrl },
      pool: { min: 1, max: 1 },
    });

    await database.raw(`create schema "${isolatedSchema}"`);
    await setSearchPath(database);
    await setSearchPath(concurrentDatabase);
    await migrateRewardPolicy(database);
  });

  afterAll(async () => {
    try {
      if (database && isolatedSchema) {
        await database.raw(`drop schema if exists "${isolatedSchema}" cascade`);
      }
    } finally {
      await Promise.allSettled([
        database?.destroy(),
        concurrentDatabase?.destroy(),
      ]);
    }
  });

  beforeEach(async () => {
    await database('reward_policy').update({
      revision: 1,
      rules: getDefaultAwardRules(1),
      off_peak_windows: getDefaultOffPeakWindows(),
      updated_at: database.fn.now(),
    });
  });

  it('seeds once, preserves an edited row on rerun, and reloads it', async () => {
    const repository = createRewardPolicyRepository(database);
    const seeded = await repository.load();
    expect(seeded).toMatchObject({ revision: 1, rules: { version: '1' } });

    const changed = await repository.update(current => ({
      rules: {
        ...current.rules,
        rules: {
          ...current.rules.rules,
          v2gDischarge: { ...current.rules.rules.v2gDischarge, tokensPerKWh: 2 },
        },
      },
    }));
    expect(changed.revision).toBe(2);
    await migrateRewardPolicy(database);

    const reloaded = await repository.load();
    expect(reloaded.revision).toBe(2);
    expect(reloaded.rules.version).toBe('2');
    expect(reloaded.rules.rules.v2gDischarge.tokensPerKWh).toBe(2);
  });

  it('serializes callback updates from separate PostgreSQL connections', async () => {
    const first = createRewardPolicyRepository(database);
    const second = createRewardPolicyRepository(concurrentDatabase);

    const updates = await Promise.all([
      first.update(current => ({
        rules: {
          ...current.rules,
          rules: {
            ...current.rules.rules,
            offPeakCharging: { ...current.rules.rules.offPeakCharging, tokensPerKWh: 0.5 },
          },
        },
      })),
      second.update(current => ({
        rules: {
          ...current.rules,
          rules: {
            ...current.rules.rules,
            v2gDischarge: { ...current.rules.rules.v2gDischarge, tokensPerKWh: 2 },
          },
        },
      })),
    ]);

    expect(updates.map(result => result.revision).sort()).toEqual([2, 3]);
    const final = await first.load();
    expect(final.revision).toBe(3);
    expect(final.rules.version).toBe('3');
    expect(final.rules.rules.offPeakCharging.tokensPerKWh).toBe(0.5);
    expect(final.rules.rules.v2gDischarge.tokensPerKWh).toBe(2);
  });

  it('keeps unrelated country changes when deletion callbacks race', async () => {
    await database('reward_policy').update({
      off_peak_windows: {
        DE: [{ start: '22:00', end: '06:00' }],
        GB: [{ start: '23:00', end: '05:00' }],
        FR: [{ start: '21:00', end: '04:00' }],
      },
    });
    const first = createRewardPolicyRepository(database);
    const second = createRewardPolicyRepository(concurrentDatabase);

    await Promise.all([
      first.update(current => {
        const { GB: _removed, ...remaining } = current.offPeakWindows;
        return { offPeakWindows: remaining };
      }),
      second.update(current => ({
        offPeakWindows: {
          ...current.offPeakWindows,
          FR: [{ start: '20:00', end: '03:00' }],
        },
      })),
    ]);

    const final = await first.load();
    expect(final.offPeakWindows).toEqual({
      DE: [{ start: '22:00', end: '06:00' }],
      FR: [{ start: '20:00', end: '03:00' }],
    });
  });

  it('rolls back a failed transaction without changing the isolated policy row', async () => {
    const before = await database('reward_policy').first();
    await expect(database.transaction(async transaction => {
      await transaction('reward_policy').update({ revision: 99 });
      throw new Error('intentional policy transaction rollback');
    })).rejects.toThrow('intentional policy transaction rollback');
    const after = await database('reward_policy').first();
    expect(after).toMatchObject({ revision: before.revision });
  });

  it('can roll the migration back and seed the disposable schema again', async () => {
    await rollbackRewardPolicy(database);
    expect(await database.schema.hasTable('reward_policy')).toBe(false);
    await migrateRewardPolicy(database);
    const reloaded = await createRewardPolicyRepository(database).load();
    expect(reloaded).toMatchObject({ revision: 1, rules: { version: '1' } });
  });
});
