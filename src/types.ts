export interface RawSession {
  // Flexible raw charging session/CDR input
  [key: string]: any;
}

export interface OCPICDRFormat {
  // Legacy flat CDR format
  ProcessID?: string;
  SessionID?: string;
  ProviderID?: string;
  HubProviderID?: string;
  HubOperatorID?: string;
  EVSEID?: string;
  UID?: string;
  ContractID?: string | null;
  "Charging Start"?: string;
  "Session Start"?: string;
  "Charging End"?: string;
  "Session End"?: string;
  "Consumed Energy"?: string;
  "Meter Value Start"?: string;
  "Meter Value End"?: string;
  "Operation Status"?: string;

  // Native OICP CDR field spellings
  CPOPartnerSessionID?: string;
  EMPPartnerSessionID?: string;
  EvseID?: string;
  ChargingStart?: string;
  ChargingEnd?: string;
  SessionStart?: string;
  SessionEnd?: string;
  ConsumedEnergy?: string | number;
  MeterValueStart?: string | number;
  MeterValueEnd?: string | number;
  Identification?: OICPIdentification;
  identification?: OICPIdentification;

  // OCPI 2.2 CDR format
  id?: string;
  country_code?: string;
  party_id?: string;
  start_date_time?: string;
  end_date_time?: string;
  session_id?: string;
  cdr_token_contract_id?: string | null;
  cdr_token_country_code?: string;
  cdr_token_party_id?: string;
  cdr_token_uid?: string;
  cdr_token_type?: string;
  cdr_token?: {
    uid?: string;
    type?: string;
    contract_id?: string | null;
    country_code?: string;
    party_id?: string;
  };
  cdr_location?: {
    id?: string;
    evse_uid?: string;
    evse_id?: string;
    connector_id?: string;
    time_zone?: string;
    [key: string]: any;
  };
  cdr_location_evse_id?: string;
  evse_id?: string;
  total_energy?: number | string | null;
  total_time?: number | string | null;
  charging_dimension_type?: string;
  charging_dimension_volume?: number | string | null;
  charging_periods?: Array<Record<string, any>>;
  credit?: boolean | string | null;
  credit_reference_id?: string | null;
  total_cost?: { excl_vat?: number; incl_vat?: number };
  /** NEVERFLAT timezone enrichment; not an OCPI standard field. */
  timeZone?: string;
  custom_data?: {
    provider_id?: string;
    time_zone?: string;
    [key: string]: any;
  };
  [key: string]: any;
}

export type EnergyDirection = 'CHARGE' | 'DISCHARGE';

/**
 * Protocol detected from the shape of an incoming CDR. `MIXED` is retained
 * for diagnostic results when a payload includes both native OCPI and OICP
 * structures; normalisation still rejects contradictory owner identities.
 */
export type CdrProtocol = 'OCPI' | 'OICP' | 'MIXED' | 'UNKNOWN';

/**
 * Token identifiers are useful for standards-compliant audit/debugging but
 * never establish ownership. The owner identity is always `eMAID`.
 */
export interface NonOwningTokenMetadata {
  uid?: string;
  type?: string;
  countryCode?: string;
  partyId?: string;
  variant?: string;
}

/** Canonical ownership/protocol metadata emitted by the CDR normaliser. */
export interface CdrNormalisationMetadata {
  eMAID: string;
  /** Lower-camel alias for integrations that avoid acronym casing. */
  emaid: string;
  protocol: CdrProtocol;
  sourceField: string;
  tokenMetadata?: NonOwningTokenMetadata;
  /** Present only when explicit OCPI id + session_id provenance was found. */
  chargingSessionId?: string;
}

export type CdrNormalisationErrorCode =
  | 'INVALID_PAYLOAD'
  | 'MISSING_EMAID'
  | 'UID_ONLY'
  | 'CONFLICTING_IDENTIFIERS'
  | 'INVALID_EMAID';

/** Structured information safe to return in a validation response/audit row. */
export interface CdrNormalisationErrorInfo {
  code: CdrNormalisationErrorCode;
  message: string;
  protocol: CdrProtocol;
  sourceFields: string[];
}

/** Supported NEVERFLAT CDR timezone enrichment sources. */
export type TimeZoneOverrideSource = 'timeZone' | 'custom_data.time_zone' | 'cdr_location.time_zone';

/** Timezone provenance used by deterministic award calculation context. */
export type TimeZoneSource = TimeZoneOverrideSource | 'country_default' | 'unconfigured';

export interface NormalisedSession {
  sessionId: string;
  providerId: string;
  /** Canonical ownership identifier. */
  eMAID?: string;
  /** Lower-camel canonical alias for new integrations. */
  emaid?: string;
  /** Protocol and identity provenance returned by the normaliser. */
  protocol?: CdrProtocol;
  sourceField?: string;
  tokenMetadata?: NonOwningTokenMetadata;
  /** Historical output name retained for API/database/wallet compatibility. */
  uid: string;
  evseId: string;
  startTime: Date;
  endTime: Date;
  energyKWh: number;
  energyDirection: EnergyDirection;
  /** OCPI CDR id, retained separately when session_id is also supplied. */
  cdrId?: string;
  /** OCPI session_id used by reservation matching; sessionId remains the CDR id for compatibility. */
  reservationSessionId?: string;
  /**
   * Explicit OCPI charging-session identity used for forward replacement
   * protection. This is populated only for the unambiguous OCPI `id` plus
   * wire `session_id` shape; a CDR id or legacy SessionID is never inferred
   * to be a physical charging session.
   */
  chargingSessionId?: string;
  /** Optional NEVERFLAT timezone enrichment, canonicalised as an IANA zone. */
  timeZone?: string;
  /** Source of the optional timezone enrichment. */
  timeZoneSource?: TimeZoneOverrideSource;
}

/** Normaliser output guarantees for callers processing an external CDR. */
export type CanonicalNormalisedSession = NormalisedSession & {
  eMAID: string;
  emaid: string;
  protocol: CdrProtocol;
  sourceField: string;
};

/** Native OICP IdentificationType variants used to carry the owner eMAID/EVCO ID. */
export interface OICPIdentification {
  RFIDMifareFamilyIdentification?: OICPIdentificationDetails;
  RFIDIdentification?: OICPIdentificationDetails;
  QRCodeIdentification?: OICPIdentificationDetails;
  PlugAndChargeIdentification?: OICPIdentificationDetails;
  RemoteIdentification?: OICPIdentificationDetails;
  EvcoID?: string | null;
  eMAID?: string | null;
  EMAID?: string | null;
  [key: string]: any;
}

export interface OICPIdentificationDetails {
  UID?: string;
  EvcoID?: string | null;
  eMAID?: string | null;
  EMAID?: string | null;
  [key: string]: any;
}

export type TimeRange = {
  start: string; // HH:MM format
  end: string; // HH:MM format
};

export type OffPeakConfig = Record<string, TimeRange[]>; // country code to array of off-peak ranges

export type AwardType = 'OFF_PEAK_CHARGING' | 'V2G_DISCHARGE';

export interface AwardMetadata {
  isOffPeak: boolean;
  countryCode: string;
  localTime: string; // HH:MM format
  energyDirection: EnergyDirection;
  awardType: AwardType; // Type of award: Off-peak charging or V2G discharge
}

export interface AwardResult {
  eligible: boolean;
  amount: number;
  uid: string;
  dedupKey: string; // for idempotency: `${sessionId}-${providerId}`
  metadata?: AwardMetadata;
}

export interface SpendRequest {
  userAddress: string;
  amount: number;
  // Optional sessionId for tracking
  sessionId?: string;
}

export interface SpendExecutionResult {
  success: boolean;
  amount: number;
  userAddress: string;
  txHash?: string;
  dbStored?: boolean;
  dbError?: string;
  error?: string;
}

export interface SpendResult {
  valid: boolean;
  // Additional validation details if needed
}
