import { normaliseSession } from './normaliser';

describe('normaliseSession', () => {
  it('should normalise a valid raw session with positive energy (CHARGE)', () => {
    const raw = {
      SessionID: 'sess123',
      ProviderID: 'prov456',
      "Session Start": '2023-10-01T12:00:00Z',
      "Session End": '2023-10-01T13:00:00Z',
      "Consumed Energy": '10.5',
      EVSEID: 'DE*ABC*E12345',
      cdr_token: { contract_id: 'uid123' },
    };

    const result = normaliseSession(raw);

    expect(result.sessionId).toBe('sess123');
    expect(result.providerId).toBe('prov456');
    expect(result.uid).toBe('uid123');
    expect(result.startTime).toEqual(new Date('2023-10-01T12:00:00Z'));
    expect(result.endTime).toEqual(new Date('2023-10-01T13:00:00Z'));
    expect(result.energyKWh).toBe(10.5);
    expect(result.energyDirection).toBe('CHARGE');
    expect(result.evseId).toBe('DE*ABC*E12345');
  });

  it('should normalise session with negative energy (DISCHARGE)', () => {
    const raw = {
      SessionID: 'sess456',
      ProviderID: 'prov789',
      "Session Start": '2023-10-01T14:00:00Z',
      "Session End": '2023-10-01T15:00:00Z',
      "Consumed Energy": '-5.25',
      EVSEID: 'DE*ABC*E12345',
      cdr_token: { contract_id: 'uid456' },
    };

    const result = normaliseSession(raw);

    expect(result.energyKWh).toBe(5.25);
    expect(result.energyDirection).toBe('DISCHARGE');
  });

  it('should normalise OCPI CDR format', () => {
    const ocpiCdr = {
      SessionID: 'a1b09f5b-b75d-4c9e-aef2-4f0c74cc7623',
      ProviderID: 'DE-NWQ',
      EVSEID: 'DE*GUC*E*EZO*0877',
      "Charging Start": '2026-02-16T05:35:31Z',
      "Consumed Energy": '46.593',
      cdr_token: { contract_id: '0475804AA47330' },
    };

    const result = normaliseSession(ocpiCdr);

    expect(result.sessionId).toBe('a1b09f5b-b75d-4c9e-aef2-4f0c74cc7623');
    expect(result.providerId).toBe('DE-NWQ');
    expect(result.evseId).toBe('DE*GUC*E*EZO*0877');
    expect(result.uid).toBe('0475804AA47330');
    expect(result.energyKWh).toBe(46.593);
    expect(result.energyDirection).toBe('CHARGE');
  });

  it('should prefer Session Start over Charging Start for timestamp', () => {
    const ocpiCdr = {
      SessionID: 'sess123',
      ProviderID: 'DE-NWQ',
      EVSEID: 'DE*GUC*E*EZO*0877',
      "Session Start": '2026-02-16T05:35:16.75512Z',
      "Charging Start": '2026-02-16T05:35:31Z',
      "Consumed Energy": '46.593',
      cdr_token: { contract_id: 'uid123' },
    };

    const result = normaliseSession(ocpiCdr);

    expect(result.startTime).toEqual(new Date('2026-02-16T05:35:16.75512Z'));
  });

  it('should handle alternative field names', () => {
    const raw = {
      id: 'sess123',
      provider: 'prov456',
      timestamp: '2023-10-01T12:00:00Z',
      charged: '10.5',
      evse: 'US*XYZ*E67890',
      cdr_token: { contract_id: 'uid123' },
    };

    const result = normaliseSession(raw);

    expect(result.sessionId).toBe('sess123');
    expect(result.providerId).toBe('prov456');
    expect(result.energyKWh).toBe(10.5);
    expect(result.energyDirection).toBe('CHARGE');
    expect(result.evseId).toBe('US*XYZ*E67890');
  });

  it('should handle zero energy', () => {
    const raw = {
      SessionID: 'sess123',
      ProviderID: 'prov456',
      EVSEID: 'DE*ABC*E12345',
      "Consumed Energy": '0',
      cdr_token: { contract_id: 'uid123' },
    };

    const result = normaliseSession(raw);

    expect(result.energyKWh).toBe(0);
    expect(result.energyDirection).toBe('CHARGE');
  });

  it('should throw error for missing sessionId', () => {
    const raw = {
      ProviderID: 'prov456',
      EVSEID: 'DE*ABC*E12345',
      UID: 'uid123',
    };

    expect(() => normaliseSession(raw)).toThrow('sessionId is required');
  });

  it('should throw error for missing providerId', () => {
    const raw = {
      SessionID: 'sess123',
      EVSEID: 'DE*ABC*E12345',
      UID: 'uid123',
    };

    expect(() => normaliseSession(raw)).toThrow('providerId is required');
  });

  it('should throw error for missing uid', () => {
    const raw = {
      SessionID: 'sess123',
      ProviderID: 'prov456',
      EVSEID: 'DE*ABC*E12345',
    };

    expect(() => normaliseSession(raw)).toThrow('cdr_token.contract_id is required');
  });

  it('should throw error for missing evseId', () => {
    const raw = {
      SessionID: 'sess123',
      ProviderID: 'prov456',
      cdr_token: { contract_id: 'uid123' },
    };

    expect(() => normaliseSession(raw)).toThrow('evseId is required');
  });

  it('should throw error for invalid startTime', () => {
    const raw = {
      SessionID: 'sess123',
      ProviderID: 'prov456',
      "Session Start": 'invalid-date',
      EVSEID: 'DE*ABC*E12345',
      cdr_token: { contract_id: 'uid123' },
    };

    expect(() => normaliseSession(raw)).toThrow('Invalid startTime');
  });

  it('should handle missing energy fields with default 0', () => {
    const raw = {
      SessionID: 'sess123',
      ProviderID: 'prov456',
      EVSEID: 'DE*ABC*E12345',
      cdr_token: { contract_id: 'uid123' },
    };

    const result = normaliseSession(raw);

    expect(result.energyKWh).toBe(0);
    expect(result.energyDirection).toBe('CHARGE');
  });

  it('should handle end time falling back to start time if missing', () => {
    const raw = {
      SessionID: 'sess123',
      ProviderID: 'prov456',
      "Session Start": '2023-10-01T12:00:00Z',
      "Consumed Energy": '10',
      EVSEID: 'DE*ABC*E12345',
      cdr_token: { contract_id: 'uid123' },
    };

    const result = normaliseSession(raw);

    expect(result.endTime).toEqual(result.startTime);
  });

  it('should handle large negative energy values', () => {
    const raw = {
      SessionID: 'sess123',
      ProviderID: 'prov456',
      EVSEID: 'DE*ABC*E12345',
      "Consumed Energy": '-250.75',
      cdr_token: { contract_id: 'uid123' },
    };

    const result = normaliseSession(raw);

    expect(result.energyKWh).toBe(250.75);
    expect(result.energyDirection).toBe('DISCHARGE');
  });

  it('should handle European number formatting with negative values', () => {
    const raw = {
      SessionID: 'sess123',
      ProviderID: 'prov456',
      EVSEID: 'DE*ABC*E12345',
      "Consumed Energy": '-11.040.483',
      cdr_token: { contract_id: 'uid123' },
    };

    const result = normaliseSession(raw);

    expect(result.energyKWh).toBe(11040.483);
    expect(result.energyDirection).toBe('DISCHARGE');
  });
});