import { OffPeakConfig } from '../types';

// Default off-peak windows configuration (pilot countries)
// Country codes to array of time ranges in HH:MM format — up to 6 slots per country
const DEFAULT_OFF_PEAK_WINDOWS: OffPeakConfig = {
  'DE': [{ start: '22:00', end: '06:00' }], // Germany
  'ES': [{ start: '22:00', end: '06:00' }], // Spain
  'RO': [{ start: '22:00', end: '06:00' }], // Romania
};

// Runtime override — starts as null (falls back to defaults)
let runtimeOffPeakWindows: OffPeakConfig | null = null;

export function getOffPeakWindows(): OffPeakConfig {
  return runtimeOffPeakWindows ?? { ...DEFAULT_OFF_PEAK_WINDOWS };
}

export function setOffPeakWindows(config: OffPeakConfig): void {
  runtimeOffPeakWindows = config;
}

// Legacy default export — returns a snapshot; use getOffPeakWindows() for live access
export default DEFAULT_OFF_PEAK_WINDOWS;