import {
  createRewardPolicyRepository,
  getDefaultPolicySnapshot,
  RewardPolicyDatabase,
  RewardPolicyRow,
  RewardPolicyTransaction,
  validateAwardRules,
  validateOffPeakWindows,
} from './policyPersistence';
import {
  getPolicySnapshot,
  withPolicySnapshot,
} from './policyContext';
import { getAwardCalculationContext, getRules } from './awardRules';
import { getOffPeakWindows } from './offPeakWindows';
import type { NormalisedSession } from '../types';

function jsonClone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function rowFromSnapshot(snapshot = getDefaultPolicySnapshot('2026-09-23T00:00:00.000Z')): RewardPolicyRow {
  return {
    id: 1,
    revision: snapshot.revision,
    rules: jsonClone(snapshot.rules),
    off_peak_windows: jsonClone(snapshot.offPeakWindows),
    updated_at: snapshot.updatedAt,
  };
}

class MemoryPolicyDatabase implements RewardPolicyDatabase {
  row: RewardPolicyRow;
  failSave = false;
  private sequence = 0;
  private queue: Promise<void> = Promise.resolve();

  constructor(initial = rowFromSnapshot()) {
    this.row = initial;
  }

  async get(): Promise<RewardPolicyRow | undefined> {
    return jsonClone(this.row);
  }

  transaction<T>(callback: (transaction: RewardPolicyTransaction) => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => callback({
      getForUpdate: async () => jsonClone(this.row),
      save: async update => {
        if (this.failSave) throw new Error('simulated commit failure');
        this.sequence += 1;
        this.row = {
          id: 1,
          revision: update.revision,
          rules: jsonClone(update.rules),
          off_peak_windows: jsonClone(update.offPeakWindows),
          updated_at: new Date(Date.UTC(2026, 0, 1, 0, 0, this.sequence)).toISOString(),
        };
        return jsonClone(this.row);
      },
    }));
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }
}

describe('durable reward policy persistence and snapshots', () => {
  it('reloads persisted rules and country windows without silently reseeding them', async () => {
    const database = new MemoryPolicyDatabase();
    const repository = createRewardPolicyRepository(database);
    const initial = await repository.load();
    expect(initial.rules.version).toBe('1');
    database.row.rules = {
      ...jsonClone(initial.rules),
      rules: {
        ...jsonClone(initial.rules).rules,
        v2gDischarge: {
          ...jsonClone(initial.rules).rules.v2gDischarge,
          tokensPerKWh: 2,
        },
      },
    };
    database.row.off_peak_windows = {
      GB: [{ start: '23:00', end: '05:00' }],
    };

    const reloaded = await repository.load();
    expect(reloaded.rules.rules.v2gDischarge.tokensPerKWh).toBe(2);
    expect(reloaded.rules.version).toBe('1');
    expect(reloaded.offPeakWindows).toEqual({ GB: [{ start: '23:00', end: '05:00' }] });
    expect(getPolicySnapshot()).toBeNull();
  });

  it('serializes concurrent updates and merges each change against the latest row', async () => {
    const database = new MemoryPolicyDatabase();
    const repository = createRewardPolicyRepository(database);
    const current = await repository.load();
    const changedRules = {
      ...current.rules,
      rules: {
        ...current.rules.rules,
        offPeakCharging: {
          ...current.rules.rules.offPeakCharging,
          tokensPerKWh: 0.5,
        },
      },
    };

    const [rulesUpdate, windowsUpdate] = await Promise.all([
      repository.update({ rules: changedRules }),
      repository.update({ offPeakWindows: { DE: [{ start: '21:00', end: '05:00' }], GB: [{ start: '23:00', end: '06:00' }] } }),
    ]);
    const final = await repository.load();

    expect(rulesUpdate.revision).toBe(2);
    expect(windowsUpdate.revision).toBe(3);
    expect(final.revision).toBe(3);
    expect(final.rules.version).toBe('3');
    expect(final.rules.rules.offPeakCharging.tokensPerKWh).toBe(0.5);
    expect(final.offPeakWindows.GB).toEqual([{ start: '23:00', end: '06:00' }]);
  });

  it('does not publish a failed write or report it as saved', async () => {
    const database = new MemoryPolicyDatabase();
    const repository = createRewardPolicyRepository(database);
    const before = await repository.load();
    database.failSave = true;

    await expect(repository.update({ offPeakWindows: { DE: [{ start: '20:00', end: '06:00' }] } }))
      .rejects.toThrow('simulated commit failure');
    expect(await repository.load()).toEqual(before);
    expect(getPolicySnapshot()).toBeNull();
  });

  it('evaluates concurrent rule callbacks under the row lock so both fields survive', async () => {
    const database = new MemoryPolicyDatabase();
    const repository = createRewardPolicyRepository(database);
    await repository.load();

    await Promise.all([
      repository.update(current => ({
        rules: {
          ...current.rules,
          rules: {
            ...current.rules.rules,
            offPeakCharging: { ...current.rules.rules.offPeakCharging, tokensPerKWh: 0.5 },
          },
        },
      })),
      repository.update(current => ({
        rules: {
          ...current.rules,
          rules: {
            ...current.rules.rules,
            v2gDischarge: { ...current.rules.rules.v2gDischarge, tokensPerKWh: 2 },
          },
        },
      })),
    ]);

    const final = await repository.load();
    expect(final.revision).toBe(3);
    expect(final.rules.version).toBe('3');
    expect(final.rules.rules.offPeakCharging.tokensPerKWh).toBe(0.5);
    expect(final.rules.rules.v2gDischarge.tokensPerKWh).toBe(2);
  });

  it('evaluates country deletion against the latest windows so unrelated changes survive', async () => {
    const database = new MemoryPolicyDatabase();
    database.row.off_peak_windows = {
      DE: [{ start: '22:00', end: '06:00' }],
      GB: [{ start: '23:00', end: '05:00' }],
      FR: [{ start: '21:00', end: '04:00' }],
    };
    const repository = createRewardPolicyRepository(database);
    await repository.load();

    await Promise.all([
      repository.update(current => {
        const { GB: _removed, ...remaining } = current.offPeakWindows;
        return { offPeakWindows: remaining };
      }),
      repository.update(current => ({
        offPeakWindows: {
          ...current.offPeakWindows,
          FR: [{ start: '20:00', end: '03:00' }],
        },
      })),
    ]);

    const final = await repository.load();
    expect(final.offPeakWindows).toEqual({
      DE: [{ start: '22:00', end: '06:00' }],
      FR: [{ start: '20:00', end: '03:00' }],
    });
  });

  it('keeps separate async request snapshots isolated and immutable', async () => {
    const first = getDefaultPolicySnapshot('2026-09-23T01:00:00.000Z');
    const second = getDefaultPolicySnapshot('2026-09-23T02:00:00.000Z');
    const firstSnapshot = {
      ...first,
      rules: {
        ...first.rules,
        rules: {
          ...first.rules.rules,
          offPeakCharging: { ...first.rules.rules.offPeakCharging, tokensPerKWh: 0.5 },
        },
      },
    };
    const secondSnapshot = {
      ...second,
      rules: {
        ...second.rules,
        rules: {
          ...second.rules.rules,
          offPeakCharging: { ...second.rules.rules.offPeakCharging, tokensPerKWh: 0.75 },
        },
      },
    };
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });

    const firstRead = withPolicySnapshot(firstSnapshot, async () => {
      await gate;
      return { rate: getRules().rules.offPeakCharging.tokensPerKWh, windows: getOffPeakWindows() };
    });
    const secondRead = withPolicySnapshot(secondSnapshot, async () => {
      await gate;
      return { rate: getRules().rules.offPeakCharging.tokensPerKWh, windows: getOffPeakWindows() };
    });
    release();

    await expect(firstRead).resolves.toMatchObject({ rate: 0.5, windows: { DE: [{ start: '22:00', end: '06:00' }] } });
    await expect(secondRead).resolves.toMatchObject({ rate: 0.75, windows: { DE: [{ start: '22:00', end: '06:00' }] } });
    expect(Object.isFrozen((await firstRead).windows)).toBe(true);
  });

  it('records the durable policy revision and timestamp in calculation context', () => {
    const base = getDefaultPolicySnapshot('2026-09-23T03:00:00.000Z');
    const snapshot = {
      ...base,
      revision: 7,
      rules: { ...base.rules, version: '7' },
    };
    const session: NormalisedSession = {
      sessionId: 'policy-context-session',
      providerId: 'policy-context-provider',
      uid: 'policy-context-emaid',
      evseId: 'DE*ABC*E12345',
      startTime: new Date('2026-09-23T21:00:00.000Z'),
      endTime: new Date('2026-09-23T22:00:00.000Z'),
      energyKWh: 4,
      energyDirection: 'CHARGE',
    };

    const context = withPolicySnapshot(snapshot, () => getAwardCalculationContext(session));
    expect(context.configurationSnapshot).toContain('"policyRevision":7');
    expect(context.configurationSnapshot).toContain('"policyUpdatedAt":"2026-09-23T03:00:00.000Z"');
    expect(context.configurationSnapshot).toContain('"version":"7"');
  });

  it('rejects non-finite rates, non-boolean flags, and invalid or oversized windows', () => {
    const defaults = getDefaultPolicySnapshot().rules;
    expect(() => validateAwardRules({
      ...defaults,
      rules: {
        ...defaults.rules,
        offPeakCharging: { ...defaults.rules.offPeakCharging, enabled: 'true' },
      },
    })).toThrow('REWARD_POLICY_INVALID_OFF_PEAK_CHARGING_ENABLED');
    expect(() => validateAwardRules({
      ...defaults,
      rules: {
        ...defaults.rules,
        v2gDischarge: { ...defaults.rules.v2gDischarge, tokensPerKWh: Number.NaN },
      },
    })).toThrow('REWARD_POLICY_INVALID_V2G_DISCHARGE_RATE');
    expect(() => validateOffPeakWindows({ GB: [{ start: '25:00', end: '06:00' }] })).toThrow('REWARD_POLICY_INVALID_OFF_PEAK_TIME');
    expect(() => validateOffPeakWindows({ GB: Array.from({ length: 7 }, () => ({ start: '22:00', end: '06:00' })) }))
      .toThrow('REWARD_POLICY_INVALID_OFF_PEAK_WINDOWS');
  });
});
