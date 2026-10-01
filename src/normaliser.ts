import {
  RawSession,
  NormalisedSession,
  CanonicalNormalisedSession,
  OCPICDRFormat,
  EnergyDirection,
  TimeZoneOverrideSource,
  CdrProtocol,
  NonOwningTokenMetadata,
  CdrNormalisationErrorCode,
  CdrNormalisationErrorInfo,
} from './types';
import { canonicalizeIanaTimeZone } from './config/offPeakWindows';

type CdrInput = RawSession | OCPICDRFormat;
type UnknownRecord = Record<string, unknown>;

interface NamedValue {
  name: string;
  value: unknown;
}

interface EmaidCandidate {
  source: string;
  value: string;
  protocol: CdrProtocol;
}

interface TimeZoneCandidate {
  source: TimeZoneOverrideSource;
  value: unknown;
}

const ISO8601_DATE_TIME_WITH_OFFSET = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/;

/**
 * Validation failure raised by the identity/protocol boundary. The error
 * remains an Error for existing callers while exposing structured data to the
 * HTTP and audit layers.
 */
export class CdrNormalisationError extends Error {
  readonly code: CdrNormalisationErrorCode;
  readonly protocol: CdrProtocol;
  readonly sourceFields: string[];

  constructor(
    code: CdrNormalisationErrorCode,
    message: string,
    protocol: CdrProtocol,
    sourceFields: string[] = [],
  ) {
    super(message);
    this.name = 'CdrNormalisationError';
    this.code = code;
    this.protocol = protocol;
    this.sourceFields = [...sourceFields];
  }

  toInfo(): CdrNormalisationErrorInfo {
    return {
      code: this.code,
      message: this.message,
      protocol: this.protocol,
      sourceFields: [...this.sourceFields],
    };
  }
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasCdrValue(value: unknown): boolean {
  return value !== undefined && value !== null &&
    (typeof value !== 'string' || value.trim() !== '');
}

function firstPresent(input: UnknownRecord, values: NamedValue[]): NamedValue | undefined {
  return values.find(({ value }) => hasCdrValue(value));
}

function stringValue(value: unknown, fieldName: string): string {
  if (
    value === null || value === undefined ||
    (typeof value !== 'string' && typeof value !== 'number')
  ) {
    throw new Error(`${fieldName} must be a scalar value`);
  }
  const result = String(value);
  if (!hasCdrValue(result)) throw new Error(`${fieldName} is required`);
  return result;
}

/**
 * Derives the ISO country code from a standard or compact EVSE ID.
 * Examples: `DE*GUC*E*EZO*0877` -> `DE`, `BEBECE041503003` -> `BE`.
 */
export function getCountryFromEVSEID(evseId: string): string {
  const compactEvseId = String(evseId).trim();
  const match = /^([A-Za-z]{2})/.exec(compactEvseId);
  if (!match) throw new Error('Could not derive country from evseId');
  return match[1].toUpperCase();
}

/**
 * Parses a decimal kWh value without accepting a parseFloat-style prefix.
 * The historical Hubject export contains values such as `11.040.483`; for
 * that documented convention every dot except the final one is treated as a
 * thousands separator. Decimal commas remain rejected because their meaning
 * is ambiguous at this boundary.
 */
function parseEnergyValue(value: unknown): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('energy must be a finite number');
    return value;
  }

  if (value === null || value === undefined || typeof value === 'object') {
    throw new Error('energy must be a finite number (strict numeric format)');
  }

  const text = String(value).trim();
  const match = /^([+-]?)(\d+(?:\.\d+)*)$/.exec(text);
  if (!match) {
    throw new Error('energy must be a finite number (strict numeric format)');
  }

  const sign = match[1];
  const parts = match[2].split('.');
  let numericText: string;

  if (parts.length === 1) {
    numericText = `${sign}${parts[0]}`;
  } else if (
    parts.length > 2 &&
    (parts[0].length < 1 || parts[0].length > 3 ||
      parts.slice(1, -1).some(part => part.length !== 3))
  ) {
    throw new Error('energy must be a finite number (strict numeric format)');
  } else {
    numericText = `${sign}${parts.slice(0, -1).join('')}.${parts[parts.length - 1]}`;
  }

  const result = Number(numericText);
  if (!Number.isFinite(result)) {
    throw new Error('energy must be a finite number (strict numeric format)');
  }
  return result;
}

function parseDateValue(value: unknown, fieldName: string): Date {
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) throw new Error(`Invalid ${fieldName}: invalid Date value`);
    return new Date(value.getTime());
  }

  if (typeof value === 'number') {
    throw new Error(
      `Invalid ${fieldName}: Excel serial and numeric timestamps are unsupported; ` +
      'use an ISO8601 date-time with an explicit timezone offset (Z or ±HH:MM)'
    );
  }
  if (value === null || value === undefined || typeof value === 'object') {
    throw new Error(`Invalid ${fieldName}: timestamp must be an ISO8601 date-time with an explicit timezone offset`);
  }

  const text = String(value).trim();
  if (!text) throw new Error(`Invalid ${fieldName}: timestamp is empty`);

  if (/^[+-]?\d+(?:\.\d+)?$/.test(text)) {
    throw new Error(
      `Invalid ${fieldName}: Excel serial and numeric timestamps are unsupported; ` +
      'use an ISO8601 date-time with an explicit timezone offset (Z or ±HH:MM)'
    );
  }

  const match = ISO8601_DATE_TIME_WITH_OFFSET.exec(text);
  if (!match) {
    throw new Error(
      `Invalid ${fieldName}: timestamp must be ISO8601 with an explicit timezone offset (Z or ±HH:MM)`
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const offset = match[8];
  const offsetHours = offset === 'Z' ? 0 : Number(offset.slice(1, 3));
  const offsetMinutes = offset === 'Z' ? 0 : Number(offset.slice(4, 6));
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

  if (
    month < 1 || month > 12 || day < 1 || day > daysInMonth[month - 1] ||
    hour > 23 || minute > 59 || second > 59 || offsetHours > 23 || offsetMinutes > 59
  ) {
    throw new Error(`Invalid ${fieldName}: invalid calendar date or timezone offset`);
  }

  const date = new Date(text);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ${fieldName}: invalid timestamp`);
  return date;
}

function hasOwnCdrValue(input: UnknownRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(input, key) && hasCdrValue(input[key]);
}

/**
 * Detects the wire protocol from structural fields. A caller cannot override
 * this decision with a protocol selector; mixed payloads remain visible in
 * diagnostics and are still checked for contradictory owner identities.
 */
export function detectCdrProtocol(raw: unknown): CdrProtocol {
  if (!isRecord(raw)) return 'UNKNOWN';

  const hasOcpiStructure = [
    'id',
    'country_code',
    'party_id',
    'session_id',
    'start_date_time',
    'end_date_time',
    'cdr_token',
    'cdr_token_contract_id',
    'cdr_location',
    'cdr_location_evse_id',
    'total_energy',
  ].some(key => hasOwnCdrValue(raw, key));

  const hasOicpStructure = [
    'Identification',
    'identification',
    'CPOPartnerSessionID',
    'EMPPartnerSessionID',
    'EvseID',
    'ChargingStart',
    'ChargingEnd',
    'ConsumedEnergy',
    'ContractID',
  ].some(key => hasOwnCdrValue(raw, key));

  if (hasOcpiStructure && hasOicpStructure) return 'MIXED';
  if (hasOcpiStructure) return 'OCPI';
  if (hasOicpStructure) return 'OICP';

  // The existing NEVERFLAT flat contract uses OICP/Hubject-style names. Keep
  // it diagnosable as OICP while allowing the general legacy aliases below.
  if (['SessionID', 'ProviderID', 'EVSEID', 'UID'].some(key => hasOwnCdrValue(raw, key))) {
    return 'OICP';
  }
  return 'UNKNOWN';
}

function addEmaidCandidate(
  candidates: EmaidCandidate[],
  source: string,
  value: unknown,
  protocol: CdrProtocol,
  errorProtocol: CdrProtocol = protocol,
): void {
  if (!hasCdrValue(value)) return;
  if (typeof value !== 'string') {
    throw new CdrNormalisationError(
      'INVALID_EMAID',
      `eMAID candidate ${source} must be a string; numeric owner identifiers are unsupported`,
      errorProtocol,
      [source],
    );
  }

  // Hubject workbook exports can contain the literal text "null" for an
  // empty ContractID cell. It is not an owner identifier.
  const text = String(value);
  if (text.trim() !== text) {
    throw new CdrNormalisationError(
      'INVALID_EMAID',
      `eMAID candidate ${source} must not have leading or trailing whitespace`,
      errorProtocol,
      [source],
    );
  }
  if (!text || text.toLowerCase() === 'null') return;
  candidates.push({ source, value: text, protocol });
}

function collectEmaidCandidates(input: UnknownRecord, detectedProtocol: CdrProtocol): EmaidCandidate[] {
  const candidates: EmaidCandidate[] = [];
  const token = input.cdr_token;

  if (isRecord(token)) {
    addEmaidCandidate(candidates, 'cdr_token.contract_id', token.contract_id, 'OCPI', detectedProtocol);
  }
  addEmaidCandidate(candidates, 'cdr_token_contract_id', input.cdr_token_contract_id, 'OCPI', detectedProtocol);
  addEmaidCandidate(candidates, 'ContractID', input.ContractID, 'OICP', detectedProtocol);

  const identificationValues: NamedValue[] = [
    { name: 'Identification', value: input.Identification },
    { name: 'identification', value: input.identification },
  ];
  const variants = [
    'RFIDIdentification',
    'QRCodeIdentification',
    'PlugAndChargeIdentification',
    'RemoteIdentification',
  ];

  for (const identificationValue of identificationValues) {
    if (!isRecord(identificationValue.value)) continue;
    const identification = identificationValue.value;
    addEmaidCandidate(candidates, `${identificationValue.name}.EvcoID`, identification.EvcoID, 'OICP', detectedProtocol);
    addEmaidCandidate(candidates, `${identificationValue.name}.eMAID`, identification.eMAID, 'OICP', detectedProtocol);
    addEmaidCandidate(candidates, `${identificationValue.name}.EMAID`, identification.EMAID, 'OICP', detectedProtocol);

    for (const variant of variants) {
      const details = identification[variant];
      if (!isRecord(details)) continue;
      addEmaidCandidate(candidates, `${identificationValue.name}.${variant}.EvcoID`, details.EvcoID, 'OICP', detectedProtocol);
      addEmaidCandidate(candidates, `${identificationValue.name}.${variant}.eMAID`, details.eMAID, 'OICP', detectedProtocol);
      addEmaidCandidate(candidates, `${identificationValue.name}.${variant}.EMAID`, details.EMAID, 'OICP', detectedProtocol);
    }
  }

  return candidates;
}

function firstString(values: unknown[]): string | undefined {
  const value = values.find(hasCdrValue);
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/**
 * Finds all raw UID spellings for diagnostics. Lowercase `uid` aliases are
 * deliberately reported here only; they are custom/non-owning fields and are
 * never copied into token metadata or used to derive the owner eMAID.
 */
function collectUidSourceFields(input: UnknownRecord): string[] {
  const sources: string[] = [];
  if (hasCdrValue(input.UID)) sources.push('UID');
  if (hasCdrValue(input.uid)) sources.push('uid');
  if (hasCdrValue(input.cdr_token_uid)) sources.push('cdr_token_uid');
  if (isRecord(input.cdr_token) && hasCdrValue(input.cdr_token.uid)) {
    sources.push('cdr_token.uid');
  }

  const variants = [
    'RFIDIdentification',
    'QRCodeIdentification',
    'PlugAndChargeIdentification',
    'RemoteIdentification',
    'RFIDMifareFamilyIdentification',
  ];
  for (const [name, value] of [
    ['Identification', input.Identification],
    ['identification', input.identification],
  ] as Array<[string, unknown]>) {
    if (!isRecord(value)) continue;
    if (hasCdrValue(value.UID)) sources.push(`${name}.UID`);
    if (hasCdrValue(value.uid)) sources.push(`${name}.uid`);
    for (const variant of variants) {
      const details = value[variant];
      if (!isRecord(details)) continue;
      if (hasCdrValue(details.UID)) sources.push(`${name}.${variant}.UID`);
      if (hasCdrValue(details.uid)) sources.push(`${name}.${variant}.uid`);
    }
  }
  return sources;
}

function collectTokenMetadata(input: UnknownRecord): NonOwningTokenMetadata | undefined {
  const token = isRecord(input.cdr_token) ? input.cdr_token : undefined;
  const identificationValues: Array<[string, UnknownRecord]> = [];
  for (const [name, value] of [
    ['Identification', input.Identification],
    ['identification', input.identification],
  ] as Array<[string, unknown]>) {
    if (isRecord(value)) identificationValues.push([name, value]);
  }

  const metadata: NonOwningTokenMetadata = {};
  const uid = firstString([
    token?.uid,
    input.cdr_token_uid,
    input.UID,
  ]);
  if (uid) metadata.uid = uid;

  const type = firstString([token?.type, input.cdr_token_type]);
  if (type) metadata.type = type;
  const countryCode = firstString([
    token?.country_code,
    input.cdr_token_country_code,
  ]);
  if (countryCode) metadata.countryCode = countryCode;
  const partyId = firstString([
    token?.party_id,
    input.cdr_token_party_id,
  ]);
  if (partyId) metadata.partyId = partyId;

  const variants = [
    'RFIDIdentification',
    'QRCodeIdentification',
    'PlugAndChargeIdentification',
    'RemoteIdentification',
    'RFIDMifareFamilyIdentification',
  ];
  for (const [name, identification] of identificationValues) {
    for (const variant of variants) {
      const details = identification[variant];
      if (!isRecord(details)) continue;
      // Uppercase UID is the OICP wire spelling. Lowercase `uid` may be a
      // custom legacy field and is retained only in UID-only diagnostics.
      const variantUid = firstString([details.UID]);
      if (variantUid && !metadata.uid) metadata.uid = variantUid;
      if (variantUid || details.EvcoID || details.eMAID || details.EMAID) {
        metadata.variant = `${name}.${variant}`;
        break;
      }
    }
    if (metadata.variant) break;
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

interface ResolvedEmaid {
  eMAID: string;
  sourceField: string;
  protocol: CdrProtocol;
  tokenMetadata?: NonOwningTokenMetadata;
}

function resolveEmaid(input: UnknownRecord): ResolvedEmaid {
  const protocol = detectCdrProtocol(input);
  const candidates = collectEmaidCandidates(input, protocol);
  if (candidates.length === 0) {
    const uidSources = collectUidSourceFields(input);
    const uidOnly = uidSources.length > 0;
    throw new CdrNormalisationError(
      uidOnly ? 'UID_ONLY' : 'MISSING_EMAID',
      uidOnly
        ? 'eMAID is required for ownership; UID-only CDRs are rejected and may only be quarantined as non-owning token metadata'
        : 'eMAID/contract identity is required; provide OCPI cdr_token.contract_id or an OICP Identification.*.EvcoID',
      protocol,
      uidOnly ? uidSources : [],
    );
  }

  const first = candidates[0];
  for (const candidate of candidates.slice(1)) {
    if (candidate.value !== first.value) {
      throw new CdrNormalisationError(
        'CONFLICTING_IDENTIFIERS',
        `contradictory eMAID ownership aliases: ${first.source} and ${candidate.source}`,
        protocol,
        candidates.map(candidateValue => candidateValue.source),
      );
    }
  }

  const candidateProtocols = new Set(candidates.map(candidate => candidate.protocol));
  const detectedProtocol = candidateProtocols.size > 1
    ? 'MIXED'
    : (protocol === 'UNKNOWN' ? first.protocol : protocol);

  return {
    eMAID: first.value,
    sourceField: first.source,
    protocol: detectedProtocol,
    tokenMetadata: collectTokenMetadata(input),
  };
}

function resolveCdrTimeZone(
  input: UnknownRecord
): Pick<NormalisedSession, 'timeZone' | 'timeZoneSource'> {
  const customData = isRecord(input.custom_data) ? input.custom_data : undefined;
  const location = isRecord(input.cdr_location) ? input.cdr_location : undefined;
  const candidates: TimeZoneCandidate[] = [
    { source: 'timeZone', value: input.timeZone },
    { source: 'custom_data.time_zone', value: customData?.time_zone },
    { source: 'cdr_location.time_zone', value: location?.time_zone },
  ];

  let selected: { source: TimeZoneOverrideSource; value: string } | undefined;
  for (const candidate of candidates) {
    if (!hasCdrValue(candidate.value)) continue;
    const value = canonicalizeIanaTimeZone(candidate.value, candidate.source);
    if (selected && selected.value !== value) {
      throw new Error(
        `contradictory timezone overrides: ${selected.source} and ${candidate.source}`
      );
    }
    if (!selected) selected = { source: candidate.source, value };
  }

  return selected
    ? { timeZone: selected.value, timeZoneSource: selected.source }
    : {};
}

function rejectUnsupportedCdrKind(input: UnknownRecord): void {
  const credit = input.credit;
  if (hasCdrValue(credit)) {
    const text = String(credit).trim().toLowerCase();
    if (credit === true || text === 'true') {
      throw new Error('credit/correction CDRs are unsupported by award logic');
    }
    if (credit !== false && text !== 'false') {
      throw new Error('credit flag must be boolean');
    }
  }

  if (hasCdrValue(input.credit_reference_id)) {
    throw new Error('credit/correction CDRs are unsupported by award logic');
  }

  const correctionReference = input.correction_reference_id ?? input.CorrectionReferenceID;
  if (hasCdrValue(correctionReference)) {
    throw new Error('credit/correction CDRs are unsupported by award logic');
  }

  const correction = input.correction ?? input.Correction ?? input.is_correction ?? input.isCorrection;
  if (hasCdrValue(correction) && (correction === true || String(correction).trim().toLowerCase() === 'true')) {
    throw new Error('credit/correction CDRs are unsupported by award logic');
  }

  const operationStatus = input['Operation Status'] ?? input.OperationStatus ?? input.operation_status;
  if (hasCdrValue(operationStatus) && /^(credit|correction)$/i.test(String(operationStatus).trim())) {
    throw new Error('credit/correction CDRs are unsupported by award logic');
  }
}

function getProviderValue(input: UnknownRecord): NamedValue | undefined {
  const customData = isRecord(input.custom_data) ? input.custom_data : undefined;
  return firstPresent(input, [
    { name: 'ProviderID', value: input.ProviderID },
    { name: 'providerId', value: input.providerId },
    { name: 'provider', value: input.provider },
    { name: 'HubProviderID', value: input.HubProviderID },
    { name: 'provider_id', value: input.provider_id },
    { name: 'custom_data.provider_id', value: customData?.provider_id },
    { name: 'party_id', value: input.party_id },
  ]);
}

function getStartTimeValue(input: UnknownRecord): NamedValue | undefined {
  return firstPresent(input, [
    { name: 'Session Start', value: input['Session Start'] },
    { name: 'SessionStart', value: input.SessionStart },
    { name: 'Charging Start', value: input['Charging Start'] },
    { name: 'ChargingStart', value: input.ChargingStart },
    { name: 'StartTime', value: input.StartTime },
    { name: 'timestamp', value: input.timestamp },
    { name: 'start_date_time', value: input.start_date_time },
  ]);
}

function getEndTimeValue(input: UnknownRecord): NamedValue | undefined {
  return firstPresent(input, [
    { name: 'Session End', value: input['Session End'] },
    { name: 'SessionEnd', value: input.SessionEnd },
    { name: 'Charging End', value: input['Charging End'] },
    { name: 'ChargingEnd', value: input.ChargingEnd },
    { name: 'EndTime', value: input.EndTime },
    { name: 'end_date_time', value: input.end_date_time },
  ]);
}

function getEnergyValue(input: UnknownRecord): NamedValue | undefined {
  return firstPresent(input, [
    { name: 'Consumed Energy', value: input['Consumed Energy'] },
    { name: 'ConsumedEnergy', value: input.ConsumedEnergy },
    { name: 'Energy', value: input.Energy },
    { name: 'chargedEnergyKwh', value: input.chargedEnergyKwh },
    { name: 'charged', value: input.charged },
    { name: 'total_energy', value: input.total_energy },
  ]);
}

function getDirectionValue(input: UnknownRecord): NamedValue | undefined {
  return firstPresent(input, [
    { name: 'EnergyDirection', value: input.EnergyDirection },
    { name: 'energyDirection', value: input.energyDirection },
    { name: 'energy_direction', value: input.energy_direction },
  ]);
}

/**
 * Normalises raw charging session/CDR input into the canonical structure
 * consumed by the award engine. `eMAID` is the owner identity; `uid` remains
 * an additive compatibility alias for existing award/wallet/database code.
 * RFID and OCPI token UIDs are deliberately never used for ownership.
 */
export function normaliseSession(raw: CdrInput): CanonicalNormalisedSession {
  if (!isRecord(raw)) throw new Error('CDR request body must be a JSON object');
  const input = raw as UnknownRecord;
  rejectUnsupportedCdrKind(input);
  const timeZoneMetadata = resolveCdrTimeZone(input);

  const sessionValue = firstPresent(input, [
    { name: 'SessionID', value: input.SessionID },
    { name: 'sessionId', value: input.sessionId },
    { name: 'id', value: input.id },
    { name: 'session_id', value: input.session_id },
  ]);
  if (!sessionValue) throw new Error('sessionId is required');
  const sessionId = stringValue(sessionValue.value, 'sessionId');

  const providerValue = getProviderValue(input);
  if (!providerValue) throw new Error('providerId is required');
  const providerId = stringValue(providerValue.value, 'providerId');

  const identity = resolveEmaid(input);

  const location = isRecord(input.cdr_location) ? input.cdr_location : undefined;
  const evseValue = firstPresent(input, [
    { name: 'EVSEID', value: input.EVSEID },
    { name: 'EvseID', value: input.EvseID },
    { name: 'evseId', value: input.evseId },
    { name: 'evse', value: input.evse },
    { name: 'cdr_location.evse_id', value: location?.evse_id },
    { name: 'cdr_location_evse_id', value: input.cdr_location_evse_id },
    { name: 'evse_id', value: input.evse_id },
  ]);
  if (!evseValue) throw new Error('evseId is required');
  const evseId = stringValue(evseValue.value, 'evseId');

  const startValue = getStartTimeValue(input);
  const startTime = startValue ? parseDateValue(startValue.value, 'startTime') : new Date();

  const endValue = getEndTimeValue(input);
  const endTime = endValue ? parseDateValue(endValue.value, 'endTime') : new Date(startTime);
  if (endTime.getTime() < startTime.getTime()) {
    throw new Error('end time must not be before start time');
  }

  const energyValue = getEnergyValue(input);
  const rawEnergyValue = parseEnergyValue(energyValue?.value ?? 0);

  const directionValue = getDirectionValue(input);
  let energyDirection: EnergyDirection;
  if (directionValue) {
    if (directionValue.value !== 'CHARGE' && directionValue.value !== 'DISCHARGE') {
      throw new Error('energy direction must be CHARGE or DISCHARGE');
    }
    if (directionValue.value === 'CHARGE' && rawEnergyValue < 0) {
      throw new Error('energy direction CHARGE conflicts with negative energy');
    }
    energyDirection = directionValue.value;
  } else {
    energyDirection = rawEnergyValue < 0 ? 'DISCHARGE' : 'CHARGE';
  }

  const reservationSessionIdValue = firstPresent(input, [
    { name: 'session_id', value: input.session_id },
  ]);
  const cdrIdValue = firstPresent(input, [
    { name: 'id', value: input.id },
  ]);
  const optionalIds: Pick<NormalisedSession, 'cdrId' | 'reservationSessionId' | 'chargingSessionId'> = {};
  // Preserve the historical reservation matching precedence: only an `id`
  // selected as the canonical session id may populate reservationSessionId.
  // The physical-session guard is derived separately from explicit OCPI
  // `id` + wire `session_id` provenance and never changes that alias.
  if (sessionValue.name === 'id' && reservationSessionIdValue) {
    optionalIds.reservationSessionId = stringValue(
      reservationSessionIdValue.value,
      'reservationSessionId'
    );
    if (cdrIdValue) optionalIds.cdrId = stringValue(cdrIdValue.value, 'cdrId');
  }
  if (
    (identity.protocol === 'OCPI' || identity.protocol === 'MIXED')
    && cdrIdValue
    && reservationSessionIdValue
  ) {
    optionalIds.chargingSessionId = stringValue(reservationSessionIdValue.value, 'chargingSessionId');
  }

  return {
    sessionId,
    providerId,
    eMAID: identity.eMAID,
    emaid: identity.eMAID,
    protocol: identity.protocol,
    sourceField: identity.sourceField,
    tokenMetadata: identity.tokenMetadata,
    uid: identity.eMAID,
    evseId,
    startTime,
    endTime,
    energyKWh: Math.abs(rawEnergyValue),
    energyDirection,
    ...optionalIds,
    ...timeZoneMetadata,
  };
}

/**
 * Validates the fields required at the HTTP ingestion boundary before
 * applying the flexible legacy/OCPI normalisation rules. Keeping this
 * separate preserves the historical permissiveness of direct normaliseSession
 * callers while ensuring incomplete final CDRs receive a clear 400 response.
 */
export function validateAndNormaliseCdr(raw: CdrInput): CanonicalNormalisedSession {
  if (!isRecord(raw)) {
    throw new Error('CDR request body must be a JSON object');
  }
  const input = raw as UnknownRecord;
  rejectUnsupportedCdrKind(input);

  const startTime = getStartTimeValue(input);
  if (!startTime) {
    throw new Error('start time is required (StartTime or start_date_time)');
  }
  parseDateValue(startTime.value, 'startTime');

  const endTime = getEndTimeValue(input);
  if (!endTime) {
    throw new Error('end time is required (EndTime or end_date_time)');
  }
  parseDateValue(endTime.value, 'endTime');

  const energy = getEnergyValue(input);
  if (!energy) {
    throw new Error('energy is required (Energy or total_energy)');
  }

  const explicitDirection = getDirectionValue(input)?.value;
  if (hasCdrValue(explicitDirection) && explicitDirection !== 'CHARGE' && explicitDirection !== 'DISCHARGE') {
    throw new Error('energy direction must be CHARGE or DISCHARGE');
  }

  const normalised = normaliseSession(raw);
  if (!Number.isFinite(normalised.energyKWh)) {
    throw new Error('energy must be a finite number');
  }
  if (normalised.endTime.getTime() < normalised.startTime.getTime()) {
    throw new Error('end time must not be before start time');
  }

  return normalised;
}

/** Canonical strict normaliser name for new OCPI/OICP integrations. */
export function normaliseCdr(raw: CdrInput): CanonicalNormalisedSession {
  return validateAndNormaliseCdr(raw);
}

/** US-spelling alias for integrations that use `normalize` terminology. */
export const normalizeCdr = normaliseCdr;

/**
 * Converts an identity-boundary failure into safe structured data for API
 * responses and audit metadata. Legacy validation errors remain plain text.
 */
export function getCdrNormalisationErrorInfo(error: unknown): CdrNormalisationErrorInfo | undefined {
  return error instanceof CdrNormalisationError ? error.toInfo() : undefined;
}

export type CdrNormalisationResult =
  | { ok: true; value: CanonicalNormalisedSession }
  | { ok: false; error: CdrNormalisationErrorInfo };

/** Non-throwing helper for quarantine/inspection tooling. */
export function tryNormaliseCdr(raw: CdrInput): CdrNormalisationResult {
  try {
    return { ok: true, value: validateAndNormaliseCdr(raw) };
  } catch (error) {
    const info = getCdrNormalisationErrorInfo(error);
    return {
      ok: false,
      error: info || {
        code: 'INVALID_PAYLOAD',
        message: error instanceof Error ? error.message : String(error),
        protocol: detectCdrProtocol(raw),
        sourceFields: [],
      },
    };
  }
}
