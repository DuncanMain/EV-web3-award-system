import type { OffPeakConfig, TimeZoneOverrideSource, TimeZoneSource } from '../types';
import { getPolicySnapshot } from './policyContext';
import { getDefaultOffPeakWindows } from './policyDefaults';

// Default off-peak windows configuration (pilot countries)
// Country codes to array of time ranges in HH:MM format — up to 6 slots per country
const DEFAULT_OFF_PEAK_WINDOWS: OffPeakConfig = getDefaultOffPeakWindows();

// Pilot-country timezone defaults. These are IANA zones so DST transitions
// are resolved from the instant rather than from the server's local timezone.
const DEFAULT_TIME_ZONES: Record<string, string> = {
  DE: 'Europe/Berlin',
  ES: 'Europe/Madrid',
  RO: 'Europe/Bucharest',
};

// Runtime override — starts as null (falls back to defaults)
let runtimeOffPeakWindows: OffPeakConfig | null = null;

export function getOffPeakWindows(): OffPeakConfig {
  const policy = getPolicySnapshot();
  return policy?.offPeakWindows ?? runtimeOffPeakWindows ?? getDefaultOffPeakWindows();
}

export function setOffPeakWindows(config: OffPeakConfig): void {
  runtimeOffPeakWindows = config;
}

export interface ResolvedTimeZone {
  timeZone?: string;
  source: TimeZoneSource;
}

/**
 * Validates and canonicalises an IANA timezone. The caller must pass the
 * original string without surrounding whitespace; silently trimming a
 * financial calculation input would make the source ambiguous.
 */
export function canonicalizeIanaTimeZone(value: unknown, source = 'timeZone'): string {
  if (typeof value !== 'string' || !value || value.trim() !== value) {
    throw new Error(`${source} must be a valid IANA timezone identifier`);
  }

  try {
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: value });
    return formatter.resolvedOptions().timeZone || value;
  } catch {
    throw new Error(`${source} must be a valid IANA timezone identifier: ${value}`);
  }
}

/**
 * Resolves an explicit CDR timezone first, then the configured pilot-country
 * default. An unconfigured country is left without a timezone so it can stay
 * ineligible when it has no off-peak windows; callers adding windows for that
 * country must provide an explicit timezone.
 */
export function resolveTimeZone(
  country: string,
  explicitTimeZone?: string,
  explicitSource: TimeZoneOverrideSource = 'timeZone'
): ResolvedTimeZone {
  if (explicitTimeZone !== undefined) {
    return {
      timeZone: canonicalizeIanaTimeZone(explicitTimeZone, explicitSource),
      source: explicitSource,
    };
  }

  const countryCode = country.toUpperCase();
  const defaultTimeZone = DEFAULT_TIME_ZONES[countryCode];
  if (defaultTimeZone) {
    return { timeZone: defaultTimeZone, source: 'country_default' };
  }

  return { source: 'unconfigured' };
}

export function hasConfiguredOffPeakWindows(country: string): boolean {
  const ranges = getOffPeakWindows()[country.toUpperCase()];
  return Array.isArray(ranges) && ranges.length > 0;
}

// Legacy default export — returns a snapshot; use getOffPeakWindows() for live access
export default DEFAULT_OFF_PEAK_WINDOWS;
