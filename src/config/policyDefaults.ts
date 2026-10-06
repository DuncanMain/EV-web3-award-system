import awardRulesConfig from './awardRules.json';
import type { AwardRuleConfig } from './awardRules';
import type { OffPeakConfig } from '../types';

/**
 * Defaults used by the first policy migration and by library callers before
 * the persisted policy has been loaded.  The migration inserts these values
 * only when the singleton policy row does not already exist.
 */
export function getDefaultAwardRules(revision?: number): AwardRuleConfig {
  const rules = clone(awardRulesConfig as AwardRuleConfig);
  if (revision !== undefined) rules.version = String(revision);
  return rules;
}
export function getDefaultOffPeakWindows(): OffPeakConfig {
  return {
    DE: [{ start: '22:00', end: '06:00' }],
    ES: [{ start: '22:00', end: '06:00' }],
    RO: [{ start: '22:00', end: '06:00' }],
  };
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
