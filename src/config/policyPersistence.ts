import type { Knex } from 'knex';
import type { AwardRuleConfig } from './awardRules';
import { getDefaultAwardRules, getDefaultOffPeakWindows } from './policyDefaults';
import {
  freezePolicySnapshot,
  PolicySnapshot,
} from './policyContext';
import type { OffPeakConfig, TimeRange } from '../types';

export const REWARD_POLICY_TABLE = 'reward_policy';
export const REWARD_POLICY_ROW_ID = 1;
export const MAX_OFF_PEAK_SLOTS = 6;

export interface RewardPolicyRow {
  id: number | string;
  revision: number | string;
  rules: unknown;
  off_peak_windows: unknown;
  updated_at: Date | string;
}
export interface RewardPolicyPatch {
  rules?: AwardRuleConfig;
  offPeakWindows?: OffPeakConfig;
}

/**
 * A callback is evaluated while the singleton row is locked. Use it for
 * partial rule or country-window changes derived from the latest durable
 * snapshot; a plain patch intentionally remains a full replacement of any
 * supplied document.
 */
export type RewardPolicyUpdate =
  | RewardPolicyPatch
  | ((current: PolicySnapshot) => RewardPolicyPatch);

export interface RewardPolicyTransaction {
  getForUpdate(): Promise<RewardPolicyRow | undefined>;
  save(update: {
    revision: number;
    rules: AwardRuleConfig;
    offPeakWindows: OffPeakConfig;
  }): Promise<RewardPolicyRow | undefined>;
}

/** Small adapter keeps repository behaviour testable without requiring PostgreSQL in unit tests. */
export interface RewardPolicyDatabase {
  get(): Promise<RewardPolicyRow | undefined>;
  transaction<T>(callback: (transaction: RewardPolicyTransaction) => Promise<T>): Promise<T>;
}

export interface RewardPolicyRepository {
  /** Read the singleton. This never creates tables or seeds a missing row. */
  load(): Promise<PolicySnapshot>;
  /** Merge a patch under a row lock and increment revision. */
  update(update: RewardPolicyUpdate): Promise<PolicySnapshot>;
}

function clone<T>(value: T): T {
  if (Array.isArray(value)) return value.map(item => clone(item)) as T;
  if (value && typeof value === 'object') {
    const copy: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      copy[key] = clone(item);
    }
    return copy as T;
  }
  return value;
}

function parseJson(value: unknown, field: string): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`REWARD_POLICY_INVALID_${field.toUpperCase()}`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function requireRecord(value: unknown, field: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`REWARD_POLICY_INVALID_${field.toUpperCase()}`);
  return value;
}

function requireFiniteRate(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(`REWARD_POLICY_INVALID_${field.toUpperCase()}`);
  }
  return value;
}

function requireBoolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') throw new Error(`REWARD_POLICY_INVALID_${field.toUpperCase()}`);
  return value;
}

/** Validate a complete rules object without coercing strings or truthy values. */
export function validateAwardRules(value: unknown): AwardRuleConfig {
  const source = requireRecord(value, 'rules');
  if (typeof source.version !== 'string' || !source.version.trim()) {
    throw new Error('REWARD_POLICY_INVALID_VERSION');
  }
  const rules = requireRecord(source.rules, 'rules');
  const offPeak = requireRecord(rules.offPeakCharging, 'off_peak_charging');
  const v2g = requireRecord(rules.v2gDischarge, 'v2g_discharge');
  const idempotency = requireRecord(source.idempotency, 'idempotency');
  if (!Array.isArray(idempotency.deduplicationKey)
    || idempotency.deduplicationKey.length === 0
    || idempotency.deduplicationKey.some(key => typeof key !== 'string' || !key.trim())
    || typeof idempotency.description !== 'string') {
    throw new Error('REWARD_POLICY_INVALID_IDEMPOTENCY');
  }
  if (typeof offPeak.description !== 'string' || typeof v2g.description !== 'string') {
    throw new Error('REWARD_POLICY_INVALID_DESCRIPTION');
  }

  return {
    version: source.version,
    rules: {
      offPeakCharging: {
        enabled: requireBoolean(offPeak.enabled, 'off_peak_charging_enabled'),
        tokensPerKWh: requireFiniteRate(offPeak.tokensPerKWh, 'off_peak_charging_rate'),
        description: offPeak.description,
      },
      v2gDischarge: {
        enabled: requireBoolean(v2g.enabled, 'v2g_discharge_enabled'),
        tokensPerKWh: requireFiniteRate(v2g.tokensPerKWh, 'v2g_discharge_rate'),
        description: v2g.description,
      },
    },
    idempotency: {
      deduplicationKey: idempotency.deduplicationKey.map(key => String(key)),
      description: idempotency.description,
    },
  };
}

function validClock(value: unknown): value is string {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** Validate country windows and keep the persisted shape bounded and explicit. */
export function validateOffPeakWindows(value: unknown): OffPeakConfig {
  const source = requireRecord(value, 'off_peak_windows');
  const result: OffPeakConfig = {};
  for (const [country, ranges] of Object.entries(source)) {
    if (!/^[A-Z]{2}$/.test(country) || !Array.isArray(ranges) || ranges.length === 0 || ranges.length > MAX_OFF_PEAK_SLOTS) {
      throw new Error(`REWARD_POLICY_INVALID_OFF_PEAK_WINDOWS:${country}`);
    }
    result[country] = ranges.map((range, index): TimeRange => {
      const candidate = requireRecord(range, `off_peak_window_${country}_${index}`);
      if (!validClock(candidate.start) || !validClock(candidate.end)) {
        throw new Error(`REWARD_POLICY_INVALID_OFF_PEAK_TIME:${country}:${index}`);
      }
      return { start: candidate.start, end: candidate.end };
    });
  }
  return result;
}

function isoUpdatedAt(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error('REWARD_POLICY_INVALID_UPDATED_AT');
  return date.toISOString();
}

function policyFromRow(row: RewardPolicyRow): PolicySnapshot {
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error('REWARD_POLICY_INVALID_REVISION');
  const rules = validateAwardRules(parseJson(row.rules, 'rules'));
  return freezePolicySnapshot({
    revision,
    updatedAt: isoUpdatedAt(row.updated_at),
    rules: { ...rules, version: String(revision) },
    offPeakWindows: validateOffPeakWindows(parseJson(row.off_peak_windows, 'off_peak_windows')),
  });
}

function validatePatch(patch: RewardPolicyPatch): RewardPolicyPatch {
  if (!isRecord(patch)) throw new Error('REWARD_POLICY_INVALID_PATCH');
  const result: RewardPolicyPatch = {};
  if (patch.rules !== undefined) result.rules = validateAwardRules(patch.rules);
  if (patch.offPeakWindows !== undefined) result.offPeakWindows = validateOffPeakWindows(patch.offPeakWindows);
  if (!result.rules && !result.offPeakWindows) throw new Error('REWARD_POLICY_EMPTY_PATCH');
  return result;
}

function createKnexDatabase(database: Knex): RewardPolicyDatabase {
  return {
    async get(): Promise<RewardPolicyRow | undefined> {
      return database(REWARD_POLICY_TABLE).where({ id: REWARD_POLICY_ROW_ID }).first() as Promise<RewardPolicyRow | undefined>;
    },
    transaction<T>(callback: (transaction: RewardPolicyTransaction) => Promise<T>): Promise<T> {
      return database.transaction(async trx => callback({
        async getForUpdate(): Promise<RewardPolicyRow | undefined> {
          return trx(REWARD_POLICY_TABLE)
            .where({ id: REWARD_POLICY_ROW_ID })
            .forUpdate()
            .first() as Promise<RewardPolicyRow | undefined>;
        },
        async save(update): Promise<RewardPolicyRow | undefined> {
          const [row] = await trx(REWARD_POLICY_TABLE)
            .where({ id: REWARD_POLICY_ROW_ID })
            .update({
              revision: update.revision,
              rules: update.rules,
              off_peak_windows: update.offPeakWindows,
              updated_at: trx.fn.now(),
            })
            .returning('*') as RewardPolicyRow[];
          return row;
        },
      }));
    },
  };
}

function asDatabase(database: Knex | RewardPolicyDatabase): RewardPolicyDatabase {
  return typeof database === 'function' ? createKnexDatabase(database) : database;
}

/** Create the durable policy repository. Missing schema/row errors are surfaced to callers. */
export function createRewardPolicyRepository(database: Knex | RewardPolicyDatabase): RewardPolicyRepository {
  const store = asDatabase(database);
  return {
    async load(): Promise<PolicySnapshot> {
      const row = await store.get();
      if (!row) throw new Error('REWARD_POLICY_NOT_INITIALIZED');
      return policyFromRow(row);
    },

    async update(update: RewardPolicyUpdate): Promise<PolicySnapshot> {
      const committed = await store.transaction(async transaction => {
        const currentRow = await transaction.getForUpdate();
        if (!currentRow) throw new Error('REWARD_POLICY_NOT_INITIALIZED');
        const current = policyFromRow(currentRow);
        const patch = typeof update === 'function' ? update(current) : update;
        const validatedPatch = validatePatch(patch);
        const nextRevision = current.revision + 1;
        const nextRules = validatedPatch.rules ? clone(validatedPatch.rules) : clone(current.rules);
        nextRules.version = String(nextRevision);
        const nextWindows = validatedPatch.offPeakWindows
          ? clone(validatedPatch.offPeakWindows)
          : clone(current.offPeakWindows);
        const savedRow = await transaction.save({
          revision: nextRevision,
          rules: nextRules,
          offPeakWindows: nextWindows,
        });
        if (!savedRow) throw new Error('REWARD_POLICY_WRITE_FAILED');
        return policyFromRow(savedRow);
      });
      return committed;
    },
  };
}

/** Defaults used by migration/tests without making a GET silently create state. */
export function getDefaultPolicySnapshot(updatedAt = new Date(0).toISOString()): PolicySnapshot {
  return freezePolicySnapshot({
    revision: 1,
    updatedAt,
    rules: getDefaultAwardRules(1),
    offPeakWindows: getDefaultOffPeakWindows(),
  });
}
