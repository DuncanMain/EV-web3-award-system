import awardRulesConfig from './awardRules.json';
import { NormalisedSession } from '../types';
import { getCountryFromEVSEID } from '../normaliser';
import { getOffPeakWindows } from './offPeakWindows';

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

// Runtime override — starts as null (falls back to JSON file)
let runtimeRules: AwardRuleConfig | null = null;

export function getRules(): AwardRuleConfig {
  return runtimeRules ?? (awardRulesConfig as AwardRuleConfig);
}

export function setRules(rules: AwardRuleConfig): void {
  runtimeRules = rules;
}

/**
 * Checks if timestamp is within off-peak hours for the given country
 */
function isOffPeak(country: string, timestamp: Date): boolean {
  const ranges = getOffPeakWindows()[country];
  if (!ranges || ranges.length === 0) return false;

  const minutes = timestamp.getHours() * 60 + timestamp.getMinutes();

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

/**
 * Parses HH:MM string to minutes since midnight
 */
function parseTimeToMinutes(time: string): number {
  const [hours, minutes] = time.split(':').map(Number);
  return hours * 60 + minutes;
}

/**
 * Determines the award type for a session
 */
export function getAwardType(session: NormalisedSession, rules: AwardRuleConfig = getRules()): 'OFF_PEAK_CHARGING' | 'V2G_DISCHARGE' | null {
  const country = getCountryFromEVSEID(session.evseId);

  // Check for off-peak charging first
  if (rules.rules.offPeakCharging.enabled && session.energyDirection === 'CHARGE') {
    if (isOffPeak(country, session.startTime)) {
      return 'OFF_PEAK_CHARGING';
    }
  }

  // Check for V2G discharge
  if (rules.rules.v2gDischarge.enabled && session.energyDirection === 'DISCHARGE') {
    return 'V2G_DISCHARGE';
  }

  return null;
}

/**
 * Calculates reward tokens based on rule configuration and session data
 */
export function calculateAwardTokens(session: NormalisedSession, rules: AwardRuleConfig = getRules()): number {
  let totalTokens = 0;

  // Derive country from EVSEID
  const country = getCountryFromEVSEID(session.evseId);

  // Off-peak charging reward
  if (rules.rules.offPeakCharging.enabled && session.energyDirection === 'CHARGE') {
    if (isOffPeak(country, session.startTime)) {
      const offPeakTokens = Math.floor(session.energyKWh * rules.rules.offPeakCharging.tokensPerKWh);
      totalTokens += offPeakTokens;
    }
  }

  // V2G discharge reward
  if (rules.rules.v2gDischarge.enabled && session.energyDirection === 'DISCHARGE') {
    const dischargeTokens = Math.floor(session.energyKWh * rules.rules.v2gDischarge.tokensPerKWh);
    totalTokens += dischargeTokens;
  }

  return totalTokens;
}

/**
 * Gets the deduplication key for idempotency checking
 */
export function getDeduplicationKey(session: NormalisedSession, rules: AwardRuleConfig = getRules()): string {
  const keyParts = rules.idempotency.deduplicationKey.map(key => {
    if (key === 'sessionId') return session.sessionId;
    if (key === 'providerId') return session.providerId;
    throw new Error(`Unknown deduplication key: ${key}`);
  });
  return keyParts.join('-');
}

/**
 * Gets current award rules configuration
 */
export function getAwardRules(): AwardRuleConfig {
  return awardRulesConfig as AwardRuleConfig;
}

/**
 * Checks if a timestamp falls during off-peak hours for a given country
 * @param country - Country code (e.g., 'DE', 'US', 'GB', 'FR')
 * @param timestamp - Date to check
 * @returns true if off-peak, false if peak
 */
export function isOffPeakForCountry(country: string, timestamp: Date): boolean {
  return isOffPeak(country, timestamp);
}

/**
 * Formats a Date object to HH:MM local time string
 * @param date - Date to format
 * @returns Time string in HH:MM format
 */
export function formatLocalTime(date: Date): string {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  return `${hours}:${minutes}`;
}