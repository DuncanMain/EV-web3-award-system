import { createHash } from 'crypto';
import awardRulesConfig from './awardRules.json';
import { AwardType, NormalisedSession, TimeZoneSource } from '../types';
import { getCountryFromEVSEID } from '../normaliser';
import { canonicalizeIanaTimeZone, getOffPeakWindows, resolveTimeZone } from './offPeakWindows';
import { getPolicySnapshot } from './policyContext';

export interface AwardRuleConfig {
  version: string;
  rules: {
    offPeakCharging: {
      enabled: boolean;
      tokensPerKWh: number;
      description: string;
    };
    v2gDischarge: {
      enabled: boolean;
      tokensPerKWh: number;
      description: string;
    };
  };
  idempotency: {
    deduplicationKey: string[];
    description: string;
  };
}

export interface AwardCalculationContext {
  countryCode: string;
  timeZone: string | null;
  timeZoneSource: TimeZoneSource;
  localStartTime: string | null;
  eligibilityBasis: 'session_start' | 'discharge';
  isOffPeak: boolean;
  awardType: AwardType | null;
  configurationSnapshot: string;
  configurationFingerprint: string;
}

// Runtime override — starts as null (falls back to JSON file)
let runtimeRules: AwardRuleConfig | null = null;

export function getRules(): AwardRuleConfig {
  const policy = getPolicySnapshot();
  return policy?.rules ?? runtimeRules ?? (awardRulesConfig as AwardRuleConfig);
}

export function setRules(rules: AwardRuleConfig): void {
  runtimeRules = rules;
}

interface ZonedDateTimeParts {
  year: string;
  month: string;
  day: string;
  hour: string;
  minute: string;
  second: string;
}

function getZonedDateTimeParts(timestamp: Date, timeZone: string): ZonedDateTimeParts {
  if (Number.isNaN(timestamp.getTime())) throw new Error('Cannot calculate award from an invalid timestamp');

  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(timestamp);
  const values: Record<string, string> = {};
  for (const part of parts) values[part.type] = part.value;

  return {
    year: values.year,
    month: values.month,
    day: values.day,
    hour: values.hour,
    minute: values.minute,
    second: values.second,
  };
}

/** Checks whether a timestamp is within off-peak hours for the country zone. */
function isOffPeak(country: string, timestamp: Date, explicitTimeZone?: string): boolean {
  const countryCode = country.toUpperCase();
  const ranges = getOffPeakWindows()[countryCode];
  const resolvedTimeZone = resolveTimeZone(countryCode, explicitTimeZone);
  if (!ranges || ranges.length === 0) return false;
  if (!resolvedTimeZone.timeZone) {
    throw new Error(
      `No IANA timezone configured for country ${countryCode}; provide an explicit timeZone override`
    );
  }

  const localParts = getZonedDateTimeParts(timestamp, resolvedTimeZone.timeZone);
  const minutes = Number(localParts.hour) * 60 + Number(localParts.minute);

  for (const range of ranges) {
    const startMin = parseTimeToMinutes(range.start);
    const endMin = parseTimeToMinutes(range.end);

    if (endMin > startMin) {
      // Same day range
      if (minutes >= startMin && minutes < endMin) return true;
    } else {
      // Overnight range
      if (minutes >= startMin || minutes < endMin) return true;
    }
  }

  return false;
}

/** Parses HH:MM string to minutes since midnight. */
function parseTimeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

function formatLocalDateTime(timestamp: Date, timeZone: string): string {
  const localParts = getZonedDateTimeParts(timestamp, timeZone);
  return `${localParts.year}-${localParts.month}-${localParts.day}T` +
    `${localParts.hour}:${localParts.minute}:${localParts.second}`;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    return serialized === undefined ? 'null' : serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => stableSerialize(item)).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map(key =>
    `${JSON.stringify(key)}:${stableSerialize(record[key])}`
  ).join(',')}}`;
}

function getSessionTimeZone(session: NormalisedSession, countryCode: string) {
  return resolveTimeZone(countryCode, session.timeZone, session.timeZoneSource);
}

/**
 * Returns the reproducible calculation inputs used by award eligibility.
 * The executor can persist this context with a new operation without changing
 * the amount or metadata of an already-saved operation.
 */
export function getAwardCalculationContext(
  session: NormalisedSession,
  rules: AwardRuleConfig = getRules()
): AwardCalculationContext {
  const policy = getPolicySnapshot();
  const countryCode = getCountryFromEVSEID(session.evseId);
  const resolvedTimeZone = getSessionTimeZone(session, countryCode);
  const ranges = getOffPeakWindows()[countryCode] ?? [];
  const needsOffPeakEvaluation =
    session.energyDirection === 'CHARGE' &&
    rules.rules.offPeakCharging.enabled &&
    ranges.length > 0;
  const offPeak = needsOffPeakEvaluation
    ? isOffPeak(countryCode, session.startTime, resolvedTimeZone.timeZone)
    : false;
  const localStartTime = resolvedTimeZone.timeZone
    ? formatLocalDateTime(session.startTime, resolvedTimeZone.timeZone)
    : null;
  const eligibilityBasis = session.energyDirection === 'DISCHARGE'
    ? 'discharge'
    : 'session_start';
  const awardType: AwardType | null =
    session.energyDirection === 'CHARGE' && rules.rules.offPeakCharging.enabled && offPeak
      ? 'OFF_PEAK_CHARGING'
      : session.energyDirection === 'DISCHARGE' && rules.rules.v2gDischarge.enabled
        ? 'V2G_DISCHARGE'
        : null;

  const snapshotValue = {
    version: rules.version,
    policyRevision: policy?.revision ?? null,
    policyUpdatedAt: policy?.updatedAt ?? null,
    countryCode,
    timeZone: resolvedTimeZone.timeZone ?? null,
    timeZoneSource: resolvedTimeZone.source,
    offPeakWindows: ranges,
    offPeakCharging: {
      enabled: rules.rules.offPeakCharging.enabled,
      tokensPerKWh: rules.rules.offPeakCharging.tokensPerKWh,
    },
    v2gDischarge: {
      enabled: rules.rules.v2gDischarge.enabled,
      tokensPerKWh: rules.rules.v2gDischarge.tokensPerKWh,
    },
  };
  const configurationSnapshot = stableSerialize(snapshotValue);
  const configurationFingerprint = createHash('sha256')
    .update(configurationSnapshot, 'utf8')
    .digest('hex');

  return {
    countryCode,
    timeZone: resolvedTimeZone.timeZone ?? null,
    timeZoneSource: resolvedTimeZone.source,
    localStartTime,
    eligibilityBasis,
    isOffPeak: offPeak,
    awardType,
    configurationSnapshot,
    configurationFingerprint,
  };
}

/** Determines the award type for a session. */
export function getAwardType(
  session: NormalisedSession,
  rules: AwardRuleConfig = getRules()
): 'OFF_PEAK_CHARGING' | 'V2G_DISCHARGE' | null {
  const context = getAwardCalculationContext(session, rules);
  const { offPeakCharging, v2gDischarge } = rules.rules;

  // Check for off-peak charging first
  if (offPeakCharging.enabled && session.energyDirection === 'CHARGE') {
    if (context.isOffPeak) return 'OFF_PEAK_CHARGING';
  }

  // Check for V2G discharge
  if (v2gDischarge.enabled && session.energyDirection === 'DISCHARGE') {
    return 'V2G_DISCHARGE';
  }

  return null;
}

/** Calculates reward tokens based on rule configuration and session data. */
export function calculateAwardTokens(
  session: NormalisedSession,
  rules: AwardRuleConfig = getRules()
): number {
  let totalTokens = 0;
  const { offPeakCharging, v2gDischarge } = rules.rules;
  const context = getAwardCalculationContext(session, rules);

  // Off-peak charging reward
  if (offPeakCharging.enabled && session.energyDirection === 'CHARGE') {
    if (context.isOffPeak) {
      const offPeakTokens = Math.floor(session.energyKWh * offPeakCharging.tokensPerKWh);
      totalTokens += offPeakTokens;
    }
  }

  // V2G discharge reward
  if (v2gDischarge.enabled && session.energyDirection === 'DISCHARGE') {
    const dischargeTokens = Math.floor(session.energyKWh * v2gDischarge.tokensPerKWh);
    totalTokens += dischargeTokens;
  }

  return totalTokens;
}

/** Gets the deduplication key for idempotency checking. */
export function getDeduplicationKey(
  session: NormalisedSession,
  rules: AwardRuleConfig = getRules()
): string {
  const valuesByKey: Record<string, string> = {
    sessionId: session.sessionId,
    providerId: session.providerId,
  };
  const keyParts = rules.idempotency.deduplicationKey.map(key => {
    if (key in valuesByKey) return valuesByKey[key];
    throw new Error(`Unknown deduplication key: ${key}`);
  });
  return keyParts.join('-');
}

/** Gets the current runtime award rules configuration. */
export function getAwardRules(): AwardRuleConfig {
  return getRules();
}

/**
 * Checks if a timestamp falls during off-peak hours for a given country.
 * The optional timezone is an additive NEVERFLAT override; when omitted the
 * configured pilot-country IANA timezone is used.
 */
export function isOffPeakForCountry(country: string, timestamp: Date, timeZone?: string): boolean {
  return isOffPeak(country, timestamp, timeZone);
}

/** Formats a Date object to HH:MM, optionally in an explicit IANA timezone. */
export function formatLocalTime(date: Date, timeZone?: string): string {
  if (timeZone !== undefined) {
    const canonicalTimeZone = canonicalizeIanaTimeZone(timeZone);
    const localParts = getZonedDateTimeParts(date, canonicalTimeZone);
    return `${localParts.hour}:${localParts.minute}`;
  }
  const padTimePart = (value: number) => String(value).padStart(2, '0');
  return `${padTimePart(date.getHours())}:${padTimePart(date.getMinutes())}`;
}
