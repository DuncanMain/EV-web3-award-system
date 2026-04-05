import { IngestCdrDto } from './dto/ingest-cdr.dto';

export interface NormalizedCdr {
  sessionId: string;
  providerId: string;
  uid: string;
  evseId: string;
  startTime: string;
  endTime: string;
  energyKWh: number;
  energyDirection: 'CHARGE' | 'DISCHARGE';
}

export function normalizeCdr(raw: IngestCdrDto): NormalizedCdr {
  const consumedStr = raw['Consumed Energy'].replace(/[.,]/g, (_match, offset, str) => {
    // Treat the last separator as the decimal point
    const lastDot = str.lastIndexOf('.');
    const lastComma = str.lastIndexOf(',');
    const lastSep = Math.max(lastDot, lastComma);
    return offset === lastSep ? '.' : '';
  });

  const energyKWh = parseFloat(consumedStr);

  return {
    sessionId: raw.SessionID,
    providerId: raw.ProviderID,
    uid: raw.UID,
    evseId: raw.EVSEID,
    startTime: new Date(raw['Charging Start']).toISOString(),
    endTime: new Date(raw['Charging End']).toISOString(),
    energyKWh: isNaN(energyKWh) ? 0 : energyKWh,
    energyDirection: energyKWh >= 0 ? 'CHARGE' : 'DISCHARGE',
  };
}
