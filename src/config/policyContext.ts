import { AsyncLocalStorage } from 'async_hooks';
import type { AwardRuleConfig } from './awardRules';
import type { OffPeakConfig } from '../types';

export interface PolicyMetadata {
  revision: number;
  updatedAt: string;
}
/**
 * Immutable rules and country windows used by one calculation/request.
 * `revision` and `updatedAt` travel with the calculation so a retry can be
 * explained against the policy that made the original decision.
 */
export interface PolicySnapshot extends PolicyMetadata {
  rules: AwardRuleConfig;
  offPeakWindows: OffPeakConfig;
}

const policyStorage = new AsyncLocalStorage<PolicySnapshot>();

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

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

/** Clone before freezing so callers cannot mutate the repository/cache input. */
export function freezePolicySnapshot(snapshot: PolicySnapshot): PolicySnapshot {
  return deepFreeze(clone(snapshot));
}

/** Return only the request-local snapshot. Library callers outside a request
 * continue using their existing runtime overrides or bundled defaults. */
export function getPolicySnapshot(): PolicySnapshot | null {
  return policyStorage.getStore() || null;
}

export function getPolicyMetadata(): PolicyMetadata | null {
  const snapshot = getPolicySnapshot();
  return snapshot ? { revision: snapshot.revision, updatedAt: snapshot.updatedAt } : null;
}

/** Run synchronous or asynchronous calculation code against one immutable policy. */
export function withPolicySnapshot<T>(snapshot: PolicySnapshot, callback: () => T): T;
export function withPolicySnapshot<T>(snapshot: PolicySnapshot, callback: () => Promise<T>): Promise<T>;
export function withPolicySnapshot<T>(snapshot: PolicySnapshot, callback: () => T | Promise<T>): T | Promise<T> {
  return policyStorage.run(freezePolicySnapshot(snapshot), callback);
}
