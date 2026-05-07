export interface RawSession {
  // Flexible raw charging session/CDR input
  [key: string]: any;
}

export interface OCPICDRFormat {
  // Legacy flat CDR format
  ProcessID?: string;
  SessionID?: string;
  ProviderID?: string;
  EVSEID?: string;
  UID?: string;
  "Charging Start"?: string;
  "Session Start"?: string;
  "Charging End"?: string;
  "Session End"?: string;
  "Consumed Energy"?: string;
  "Meter Value Start"?: string;
  "Meter Value End"?: string;
  "Operation Status"?: string;

  // OCPI 2.2 CDR format
  id?: string;
  country_code?: string;
  party_id?: string;
  start_date_time?: string;
  end_date_time?: string;
  session_id?: string;
  cdr_token?: {
    uid?: string;
    type?: string;
    contract_id: string;
    country_code?: string;
    party_id?: string;
  };
  cdr_location?: {
    id?: string;
    evse_uid?: string;
    evse_id?: string;
    connector_id?: string;
    [key: string]: any;
  };
  total_energy?: number;
  total_cost?: { excl_vat?: number; incl_vat?: number };
  custom_data?: {
    provider_id?: string;
    [key: string]: any;
  };
  [key: string]: any;
}

export type EnergyDirection = 'CHARGE' | 'DISCHARGE';

export interface NormalisedSession {
  sessionId: string;
  providerId: string;
  uid: string;
  evseId: string;
  startTime: Date;
  endTime: Date;
  energyKWh: number;
  energyDirection: EnergyDirection;
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