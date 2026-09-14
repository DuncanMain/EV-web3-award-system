import { RawSession, NormalisedSession, OCPICDRFormat, EnergyDirection } from './types';

/**
 * Derives country code from EVSEID.
 * Example: 'DE*GUC*E*EZO*0877' → 'DE'
 */
export function getCountryFromEVSEID(evseId: string): string {
  const country = evseId.split('*')[0];
  if (!country) throw new Error('Could not derive country from evseId');
  return country;
}

/**
 * Parses energy value, handling European number formatting (dots as thousands separators).
 * Example: '11.040.483' → 11040.483
 */
function parseEnergyValue(valueStr: string): number {
  return parseFloat(
    valueStr.toString().replace(/\./g, (match: string, offset: number, str: string) => {
      // Replace all dots except the last one (for decimal point)
      return str.lastIndexOf('.') === offset ? '.' : '';
    })
  );
}

/**
 * Normalises raw charging session/CDR input into canonical internal structure.
 * Outputs a standardised format with energy direction and explicit start/end times.
 *
 * The raw CDR data is typically received from:
 * - OCPI (Open Charge Point Interface) API responses
 * - Webhook payloads from charging network providers
 * - Database queries for stored session data
 * - Direct API calls to EVSE management systems
 *
 * Output format:
 * {
 *   sessionId: string,
 *   providerId: string,
 *   uid: string,
 *   evseId: string,
 *   startTime: Date,
 *   endTime: Date,
 *   energyKWh: number,
 *   energyDirection: 'CHARGE' | 'DISCHARGE'
 * }
 */
export function normaliseSession(raw: RawSession | OCPICDRFormat): NormalisedSession {
  // Extract required fields with flexibility for different formats
  const sessionId = raw.SessionID || raw.sessionId || raw.id;
  if (!sessionId) throw new Error('sessionId is required');

  const providerId = raw.ProviderID || raw.providerId || raw.provider ||
    raw.custom_data?.provider_id || raw.party_id;
  if (!providerId) throw new Error('providerId is required');

  const uid = raw.cdr_token?.contract_id || raw.cdr_token_contract_id;
  if (!uid) throw new Error('cdr_token.contract_id is required');

  const evseId = raw.EVSEID || raw.evseId || raw.evse || raw.cdr_location?.evse_id || raw.evse_id;
  if (!evseId) throw new Error('evseId is required');

  // Parse start time (supports API payload StartTime as well)
  const startTimeStr = raw["Session Start"] || raw["Charging Start"] || raw.StartTime || raw.timestamp || raw.start_date_time;
  const startTime = startTimeStr ? new Date(startTimeStr) : new Date();
  if (isNaN(startTime.getTime())) throw new Error('Invalid startTime');

  // Parse end time (supports API payload EndTime as well)
  const endTimeStr = raw["Session End"] || raw["Charging End"] || raw.EndTime || raw.end_date_time;
  let endTime = new Date(startTime); // Default to startTime
  if (endTimeStr) {
    const parsedEndTime = new Date(endTimeStr);
    if (!isNaN(parsedEndTime.getTime())) {
      endTime = parsedEndTime;
    }
  }

  // Parse energy value (supports API payload Energy)
  const energyStr = raw["Consumed Energy"] || raw.Energy || raw.chargedEnergyKwh || raw.charged ||
    (raw.total_energy !== undefined ? raw.total_energy.toString() : '0');
  const rawEnergyValue = parseEnergyValue(energyStr.toString());

  // Determine energy direction.
  // Prefer explicit payload direction when present; fall back to sign-based inference.
  const explicitDirection = (raw.EnergyDirection || raw.energyDirection) as EnergyDirection | undefined;
  const energyDirection: EnergyDirection =
    explicitDirection === 'CHARGE' || explicitDirection === 'DISCHARGE'
      ? explicitDirection
      : rawEnergyValue >= 0
        ? 'CHARGE'
        : 'DISCHARGE';
  const energyKWh = Math.abs(rawEnergyValue);

  return {
    sessionId: sessionId.toString(),
    providerId: providerId.toString(),
    uid: uid.toString(),
    evseId,
    startTime,
    endTime,
    energyKWh,
    energyDirection,
  };
}

function hasCdrValue(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== '';
}

/**
 * Validates the fields required at the HTTP ingestion boundary before applying
 * the flexible legacy/OCPI normalisation rules. Keeping this separate from
 * normaliseSession preserves backwards compatibility for internal callers while
 * ensuring incomplete final CDRs receive a clear 400 response from the API.
 */
export function validateAndNormaliseCdr(raw: RawSession | OCPICDRFormat): NormalisedSession {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('CDR request body must be a JSON object');
  }

  const startTime = raw["Session Start"] || raw["Charging Start"] || raw.StartTime ||
    raw.timestamp || raw.start_date_time;
  if (!hasCdrValue(startTime)) {
    throw new Error('start time is required (StartTime or start_date_time)');
  }
  if (Number.isNaN(new Date(String(startTime)).getTime())) {
    throw new Error('Invalid startTime');
  }

  const endTime = raw["Session End"] || raw["Charging End"] || raw.EndTime || raw.end_date_time;
  if (!hasCdrValue(endTime)) {
    throw new Error('end time is required (EndTime or end_date_time)');
  }
  if (Number.isNaN(new Date(String(endTime)).getTime())) {
    throw new Error('Invalid endTime');
  }

  const energy = [
    raw["Consumed Energy"],
    raw.Energy,
    raw.chargedEnergyKwh,
    raw.charged,
    raw.total_energy,
  ].find(hasCdrValue);
  if (!hasCdrValue(energy)) {
    throw new Error('energy is required (Energy or total_energy)');
  }

  const explicitDirection = raw.EnergyDirection || raw.energyDirection;
  if (hasCdrValue(explicitDirection) && explicitDirection !== 'CHARGE' && explicitDirection !== 'DISCHARGE') {
    throw new Error('energy direction must be CHARGE or DISCHARGE');
  }

  const normalised = normaliseSession(raw);
  if (typeof normalised.evseId !== 'string') {
    throw new Error('EVSE identifier must be a string');
  }
  if (!Number.isFinite(normalised.energyKWh)) {
    throw new Error('energy must be a finite number');
  }
  if (normalised.endTime.getTime() < normalised.startTime.getTime()) {
    throw new Error('end time must not be before start time');
  }

  return normalised;
}
