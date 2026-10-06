import {
  detectCdrProtocol,
  getCountryFromEVSEID,
  normaliseSession,
  validateAndNormaliseCdr,
  CdrNormalisationError,
} from './normaliser';

const validCdrForStrictTests = {
  SessionID: 'session-20260914-001',
  ProviderID: 'nvf-demo',
  cdr_token: { contract_id: 'demo-user-001' },
  EVSEID: 'DE*ABC*E*001',
  StartTime: '2026-09-14T05:00:00.000Z',
  EndTime: '2026-09-14T06:00:00.000Z',
  Energy: '12',
  EnergyDirection: 'CHARGE',
};

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

  it('should normalise the user-confirmed 15 kWh workbook OCPI fixture', () => {
    const flattenedCdr = {
      country_code: 'BE',
      party_id: 'BEC',
      id: '12345',
      start_date_time: '2015-06-29T21:39:09Z',
      end_date_time: '2015-06-29T23:37:32Z',
      session_id: null,
      cdr_token_country_code: 'DE',
      cdr_token_party_id: 'TNM',
      cdr_token_uid: '12345678',
      cdr_token_type: 'RFID',
      cdr_token_contract_id: 'DE8ACC12E46L89',
      evse_id: 'BEBECE041503003',
      // The worksheet stores 15342; this corrected fixture supplies 15 kWh.
      total_energy: 15,
    };

    const result = normaliseSession(flattenedCdr);

    expect(result.sessionId).toBe('12345');
    expect(result.providerId).toBe('BEC');
    expect(result.uid).toBe('DE8ACC12E46L89');
    expect(result.evseId).toBe('BEBECE041503003');
    expect(result.startTime).toEqual(new Date('2015-06-29T21:39:09Z'));
    expect(result.endTime).toEqual(new Date('2015-06-29T23:37:32Z'));
    expect(result.energyKWh).toBe(15);
    expect(result.energyDirection).toBe('CHARGE');
  });

  it('keeps an explicit OCPI physical session separate from the replacement CDR id', () => {
    const result = validateAndNormaliseCdr({
      id: 'cdr-replacement-a',
      session_id: 'physical-session-001',
      party_id: 'BEC',
      cdr_token_contract_id: 'DE8ACC12E46L89',
      cdr_location_evse_id: 'BEBECE041503003',
      start_date_time: '2026-09-14T05:00:00Z',
      end_date_time: '2026-09-14T06:00:00Z',
      total_energy: 15,
    });

    expect(result.sessionId).toBe('cdr-replacement-a');
    expect(result.cdrId).toBe('cdr-replacement-a');
    expect(result.reservationSessionId).toBe('physical-session-001');
    expect(result.chargingSessionId).toBe('physical-session-001');
  });

  it('binds a matching mixed payload while preserving native reservation alias precedence', () => {
    const result = normaliseSession({
      id: 'mixed-cdr-id',
      SessionID: 'legacy-session-id',
      session_id: 'untrusted-mixed-alias',
      ProviderID: 'provider-1',
      ContractID: 'DE*EMP*E123456',
      cdr_token: { contract_id: 'DE*EMP*E123456' },
      EVSEID: 'DE*ABC*E*001',
      'Session Start': '2026-09-14T05:00:00Z',
      'Session End': '2026-09-14T06:00:00Z',
      'Consumed Energy': '1',
    });

    expect(result.sessionId).toBe('legacy-session-id');
    expect(result.chargingSessionId).toBe('untrusted-mixed-alias');
    expect(result.reservationSessionId).toBeUndefined();
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

    expect(() => normaliseSession(raw)).toThrow(/eMAID\/contract identity is required/);
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

  it('extracts the first two country letters from compact EVSE IDs', () => {
    expect(getCountryFromEVSEID('BEBECE041503003')).toBe('BE');
    expect(getCountryFromEVSEID('DE*GUC*E*EZO*0877')).toBe('DE');
  });

  it('normalises native Hubject OICP Identification and field spellings', () => {
    const nativeCdr = {
      SessionID: 'a1b09f5b-b75d-4c9e-aef2-4f0c74cc7623',
      ProviderID: 'DE-NWQ',
      EvseID: 'DE*GUC*E*EZO*0877',
      Identification: {
        RFIDIdentification: {
          UID: '0475804AA47330',
          EvcoID: 'DE*EMP*E123456',
          RFID: 'mifareclassic',
        },
      },
      ChargingStart: '2026-02-16T05:35:31Z',
      ChargingEnd: '2026-02-16T06:18:31Z',
      ConsumedEnergy: '46.593',
    };

    const result = validateAndNormaliseCdr(nativeCdr);

    expect(result).toMatchObject({
      sessionId: nativeCdr.SessionID,
      providerId: 'DE-NWQ',
      uid: 'DE*EMP*E123456',
      evseId: nativeCdr.EvseID,
      energyKWh: 46.593,
      energyDirection: 'CHARGE',
    });
  });

  it('normalises negative native OICP ConsumedEnergy as DISCHARGE', () => {
    const result = validateAndNormaliseCdr({
      SessionID: 'native-negative-energy',
      ProviderID: 'DE-NWQ',
      EvseID: 'DE*GUC*E*EZO*0877',
      Identification: {
        RFIDIdentification: {
          UID: '0475804AA47330',
          EvcoID: 'DE*EMP*E123456',
        },
      },
      ChargingStart: '2026-02-16T05:35:31Z',
      ChargingEnd: '2026-02-16T06:18:31Z',
      ConsumedEnergy: '-4.75',
    });

    expect(result.energyDirection).toBe('DISCHARGE');
    expect(result.energyKWh).toBe(4.75);
  });

  it('normalises negative flattened OCPI total_energy as DISCHARGE', () => {
    const result = validateAndNormaliseCdr({
      id: 'cdr-negative-energy',
      party_id: 'BEC',
      cdr_location_evse_id: 'BEBECE041503003',
      cdr_token_contract_id: 'DE8ACC12E46L89',
      // The workbook-derived discharge example is supplied as -15 kWh in JSON.
      total_energy: -15,
      start_date_time: '2015-06-29T21:39:09Z',
      end_date_time: '2015-06-29T23:37:32Z',
    });

    expect(result.energyDirection).toBe('DISCHARGE');
    expect(result.energyKWh).toBe(15);
  });

  it('keeps positive energy as CHARGE when billing cost is negative', () => {
    const result = validateAndNormaliseCdr({
      id: 'cdr-negative-cost',
      party_id: 'BEC',
      cdr_location_evse_id: 'BEBECE041503003',
      cdr_token_contract_id: 'DE8ACC12E46L89',
      total_energy: 15,
      total_cost: { excl_vat: -2, incl_vat: -2.2 },
      start_date_time: '2015-06-29T21:39:09Z',
      end_date_time: '2015-06-29T23:37:32Z',
    });

    expect(result.energyDirection).toBe('CHARGE');
    expect(result.energyKWh).toBe(15);
  });

  it('rejects Hubject Excel serial dates before using the RFID UID or literal null ContractID', () => {
    const workbookRow = {
      SessionID: 'a1b09f5b-b75d-4c9e-aef2-4f0c74cc7623',
      ProviderID: 'DE-NWQ',
      UID: '0475804AA47330',
      ContractID: 'null',
      EVSEID: 'DE*GUC*E*EZO*0877',
      'Charging Start': 46069.232997685183,
      'Charging End': 46069.262858796297,
      'Consumed Energy': '46.593',
    };

    expect(() => validateAndNormaliseCdr(workbookRow)).toThrow(/Excel serial.*ISO8601.*timezone offset/);
  });

  it('rejects invalid calendar dates instead of allowing date rollover', () => {
    expect(() => validateAndNormaliseCdr({
      SessionID: 'session-invalid-calendar',
      ProviderID: 'provider-1',
      ContractID: 'DE*EMP*E123456',
      EVSEID: 'DE*ABC*E*001',
      StartTime: '2026-02-31T05:00:00Z',
      EndTime: '2026-03-01T06:00:00Z',
      Energy: '1',
    })).toThrow(/invalid calendar date/);
  });

  it('rejects contradictory populated ownership aliases', () => {
    expect(() => normaliseSession({
      SessionID: 'session-1',
      ProviderID: 'provider-1',
      ContractID: 'DE*EMP*E111111',
      cdr_token: { contract_id: 'DE*EMP*E222222' },
      EVSEID: 'DE*ABC*E*001',
      'Session Start': '2026-09-14T05:00:00Z',
      'Session End': '2026-09-14T06:00:00Z',
      'Consumed Energy': '1',
    })).toThrow(/contradictory eMAID ownership aliases/);
  });

  it('rejects numeric and padded eMAID ownership candidates', () => {
    const base = {
      SessionID: 'session-invalid-owner',
      ProviderID: 'provider-1',
      EVSEID: 'DE*ABC*E*001',
      'Session Start': '2026-09-14T05:00:00Z',
      'Session End': '2026-09-14T06:00:00Z',
      'Consumed Energy': '1',
    };

    expect(() => normaliseSession({
      ...base,
      ContractID: 123456,
    })).toThrow(/eMAID candidate ContractID must be a string.*numeric owner identifiers are unsupported/);

    expect(() => normaliseSession({
      ...base,
      ContractID: ' DE*EMP*E123456 ',
    })).toThrow(/eMAID candidate ContractID must not have leading or trailing whitespace/);
  });

  it('uses the detected mixed payload protocol for invalid identity errors', () => {
    let caught: unknown;
    try {
      normaliseSession({
        SessionID: 'session-invalid-mixed-owner',
        ProviderID: 'provider-1',
        EVSEID: 'DE*ABC*E*001',
        cdr_token: { contract_id: 123456 as unknown as string },
        Identification: { RemoteIdentification: { EvcoID: 'DE*EMP*E123456' } },
        'Session Start': '2026-09-14T05:00:00Z',
        'Session End': '2026-09-14T06:00:00Z',
        'Consumed Energy': '1',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'INVALID_EMAID', protocol: 'MIXED' });
  });

  it.each([
    { UID: '0475804AA47330' },
    { uid: 'legacy-custom-uid' },
    { cdr_token: { uid: '12345678', type: 'RFID' } },
    { cdr_token_uid: '12345678', cdr_token_type: 'RFID' },
    { Identification: { RFIDMifareFamilyIdentification: { UID: '0475804AA47330' } } },
  ])('never infers owner eMAID from token/RFID UID fields', (identityFields) => {
    expect(() => normaliseSession({
      SessionID: 'session-uid-only',
      ProviderID: 'provider-1',
      EVSEID: 'DE*ABC*E*001',
      'Session Start': '2026-09-14T05:00:00Z',
      'Session End': '2026-09-14T06:00:00Z',
      'Consumed Energy': '1',
      ...identityFields,
    })).toThrow(/UID-only CDRs are rejected/);
  });

  it('reports every raw UID source without retaining a custom lowercase uid', () => {
    let caught: unknown;
    try {
      normaliseSession({
        SessionID: 'session-uid-sources',
        ProviderID: 'provider-1',
        EVSEID: 'DE*ABC*E*001',
        'Session Start': '2026-09-14T05:00:00Z',
        'Session End': '2026-09-14T06:00:00Z',
        'Consumed Energy': '1',
        uid: 'custom-uid',
        Identification: {
          RFIDIdentification: { uid: 'custom-rfid-uid' },
          RFIDMifareFamilyIdentification: { UID: 'wire-rfid-uid' },
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'UID_ONLY',
      sourceFields: [
        'uid',
        'Identification.RFIDIdentification.uid',
        'Identification.RFIDMifareFamilyIdentification.UID',
      ],
    });

    let customOnlyCaught: unknown;
    try {
      normaliseSession({
        SessionID: 'session-custom-uid',
        ProviderID: 'provider-1',
        EVSEID: 'DE*ABC*E*001',
        'Session Start': '2026-09-14T05:00:00Z',
        'Session End': '2026-09-14T06:00:00Z',
        'Consumed Energy': '1',
        uid: 'custom-uid',
      });
    } catch (error) {
      customOnlyCaught = error;
    }
    expect(customOnlyCaught).toMatchObject({ code: 'UID_ONLY', sourceFields: ['uid'] });

    const acceptedWithCustomUid = normaliseSession({
      SessionID: 'session-custom-uid-with-owner',
      ProviderID: 'provider-1',
      EVSEID: 'DE*ABC*E*001',
      ContractID: 'DE*EMP*E123456',
      uid: 'custom-uid',
      'Session Start': '2026-09-14T05:00:00Z',
      'Session End': '2026-09-14T06:00:00Z',
      'Consumed Energy': '1',
    });
    expect(acceptedWithCustomUid.eMAID).toBe('DE*EMP*E123456');
    expect(acceptedWithCustomUid.tokenMetadata?.uid).toBeUndefined();
  });

  it('reports the nested OICP UID source exactly', () => {
    let caught: unknown;
    try {
      normaliseSession({
        SessionID: 'session-nested-uid',
        ProviderID: 'provider-1',
        EVSEID: 'DE*ABC*E*001',
        Identification: {
          RFIDMifareFamilyIdentification: { UID: '0475804AA47330' },
        },
        'Session Start': '2026-09-14T05:00:00Z',
        'Session End': '2026-09-14T06:00:00Z',
        'Consumed Energy': '1',
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      code: 'UID_ONLY',
      protocol: 'OICP',
      sourceFields: ['Identification.RFIDMifareFamilyIdentification.UID'],
    });
  });

  it('retains OCPI CDR id and session_id separately for reservation matching', () => {
    const result = normaliseSession({
      id: 'cdr-12345',
      session_id: 'charging-session-12345',
      party_id: 'BEC',
      cdr_location_evse_id: 'BEBECE041503003',
      cdr_token_contract_id: 'DE8ACC12E46L89',
      // The worksheet stores 15342; the user-confirmed JSON test input is 15 kWh.
      total_energy: 15,
      start_date_time: '2015-06-29T21:39:09Z',
      end_date_time: '2015-06-29T23:37:32Z',
      charging_dimension_type: 'TIME',
      charging_dimension_volume: 1973,
    });

    expect(result.sessionId).toBe('cdr-12345');
    expect(result.cdrId).toBe('cdr-12345');
    expect(result.reservationSessionId).toBe('charging-session-12345');
    expect(result.energyKWh).toBe(15);
    expect(result.evseId).toBe('BEBECE041503003');
  });

  it('does not use an unrelated OCPI session_id when native SessionID wins', () => {
    const result = normaliseSession({
      SessionID: 'native-session-123',
      session_id: 'unrelated-ocpi-session',
      ProviderID: 'DE-NWQ',
      ContractID: 'DE*EMP*E123456',
      EVSEID: 'DE*GUC*E*EZO*0877',
      ChargingStart: '2026-02-16T05:35:31Z',
      ChargingEnd: '2026-02-16T06:18:31Z',
      ConsumedEnergy: '1',
    });

    expect(result.sessionId).toBe('native-session-123');
    expect(result.reservationSessionId).toBeUndefined();
    expect(result.cdrId).toBeUndefined();
  });

  it('retains a valid NEVERFLAT timezone enrichment and rejects invalid overrides', () => {
    const enriched = normaliseSession({
      SessionID: 'session-timezone-enrichment',
      ProviderID: 'provider-1',
      ContractID: 'DE*EMP*E123456',
      EVSEID: 'DE*ABC*E*001',
      'Session Start': '2026-09-14T05:00:00Z',
      'Session End': '2026-09-14T06:00:00Z',
      'Consumed Energy': '1',
      timeZone: 'Atlantic/Canary',
      custom_data: { time_zone: 'Atlantic/Canary' },
    });

    expect(enriched.timeZone).toBe('Atlantic/Canary');
    expect(enriched.timeZoneSource).toBe('timeZone');

    const locationFallback = normaliseSession({
      SessionID: 'session-location-timezone',
      ProviderID: 'provider-1',
      ContractID: 'DE*EMP*E123456',
      cdr_location: {
        evse_id: 'DE*ABC*E*001',
        time_zone: 'Atlantic/Canary',
      },
      'Session Start': '2026-09-14T05:00:00Z',
      'Session End': '2026-09-14T06:00:00Z',
      'Consumed Energy': '1',
    });
    expect(locationFallback.timeZone).toBe('Atlantic/Canary');
    expect(locationFallback.timeZoneSource).toBe('cdr_location.time_zone');

    expect(() => validateAndNormaliseCdr({
      SessionID: 'session-invalid-timezone',
      ProviderID: 'provider-1',
      ContractID: 'DE*EMP*E123456',
      EVSEID: 'DE*ABC*E*001',
      StartTime: '2026-09-14T05:00:00Z',
      EndTime: '2026-09-14T06:00:00Z',
      Energy: '1',
      custom_data: { time_zone: 'Mars/Phobos' },
    })).toThrow(/custom_data\.time_zone must be a valid IANA timezone identifier/);
  });

  it('rejects contradictory populated timezone enrichments', () => {
    expect(() => normaliseSession({
      SessionID: 'session-contradictory-timezone',
      ProviderID: 'provider-1',
      ContractID: 'DE*EMP*E123456',
      EVSEID: 'DE*ABC*E*001',
      'Session Start': '2026-09-14T05:00:00Z',
      'Session End': '2026-09-14T06:00:00Z',
      'Consumed Energy': '1',
      custom_data: { time_zone: 'Europe/Berlin' },
      cdr_location: { time_zone: 'Europe/Madrid' },
    })).toThrow(/contradictory timezone overrides/);
  });

  it('does not invent energy from a TIME charging dimension', () => {
    expect(() => validateAndNormaliseCdr({
      id: 'cdr-time-only',
      party_id: 'BEC',
      cdr_location_evse_id: 'BEBECE041503003',
      cdr_token_contract_id: 'DE8ACC12E46L89',
      charging_dimension_type: 'TIME',
      charging_dimension_volume: 1973,
      start_date_time: '2015-06-29T21:39:09Z',
      end_date_time: '2015-06-29T23:37:32Z',
    })).toThrow('energy is required');
  });

  it('rejects partial, ambiguous, and non-finite energy values', () => {
    for (const energy of ['12.5kWh', '12,5', 'Infinity', 'NaN']) {
      expect(() => validateAndNormaliseCdr({
        ...validCdrForStrictTests,
        Energy: energy,
      })).toThrow(/energy must be a finite number/);
    }

    expect(validateAndNormaliseCdr({
      ...validCdrForStrictTests,
      Energy: '11.040.483',
    }).energyKWh).toBe(11040.483);
    // Separate API numeric pass-through regression: 15342 remains face-value.
    expect(validateAndNormaliseCdr({
      ...validCdrForStrictTests,
      Energy: 15342,
    }).energyKWh).toBe(15342);
  });

  it('uses negative energy for DISCHARGE and rejects an explicit CHARGE conflict', () => {
    expect(validateAndNormaliseCdr({
      ...validCdrForStrictTests,
      Energy: '-5.25',
      EnergyDirection: undefined,
    }).energyDirection).toBe('DISCHARGE');

    expect(validateAndNormaliseCdr({
      ...validCdrForStrictTests,
      Energy: '5.25',
      EnergyDirection: 'DISCHARGE',
    }).energyDirection).toBe('DISCHARGE');

    expect(() => validateAndNormaliseCdr({
      ...validCdrForStrictTests,
      Energy: '-5.25',
      EnergyDirection: 'CHARGE',
    })).toThrow(/conflicts with negative energy/);
  });

  it('rejects unsupported credit and correction CDRs', () => {
    expect(() => validateAndNormaliseCdr({
      ...validCdrForStrictTests,
      credit: true,
      credit_reference_id: 'original-cdr',
    })).toThrow(/credit\/correction CDRs are unsupported/);

    expect(() => validateAndNormaliseCdr({
      ...validCdrForStrictTests,
      credit_reference_id: 'original-cdr',
    })).toThrow(/credit\/correction CDRs are unsupported/);
  });

  it('rejects malformed chronology for native and legacy inputs', () => {
    expect(() => normaliseSession({
      SessionID: 'session-chronology',
      ProviderID: 'provider-1',
      ContractID: 'DE*EMP*E123456',
      EVSEID: 'DE*ABC*E*001',
      ChargingStart: '2026-09-14T06:00:00Z',
      ChargingEnd: '2026-09-14T05:00:00Z',
      ConsumedEnergy: '1',
    })).toThrow('end time must not be before start time');

    expect(() => normaliseSession({
      SessionID: 'session-invalid-end',
      ProviderID: 'provider-1',
      ContractID: 'DE*EMP*E123456',
      EVSEID: 'DE*ABC*E*001',
      'Session Start': '2026-09-14T05:00:00Z',
      'Session End': 'not-a-date',
      'Consumed Energy': '1',
    })).toThrow('Invalid endTime');
  });
});

describe('validateAndNormaliseCdr', () => {
  const neverflatCdr = {
    SessionID: 'session-20260914-001',
    ProviderID: 'nvf-demo',
    cdr_token: { contract_id: 'demo-user-001' },
    EVSEID: 'DE*ABC*E*001',
    StartTime: '2026-09-14T05:00:00.000Z',
    EndTime: '2026-09-14T06:00:00.000Z',
    Energy: '12',
    EnergyDirection: 'CHARGE',
  };

  it('accepts the canonical NEVERFLAT CDR contract', () => {
    expect(validateAndNormaliseCdr(neverflatCdr)).toMatchObject({
      sessionId: 'session-20260914-001',
      providerId: 'nvf-demo',
      uid: 'demo-user-001',
      evseId: 'DE*ABC*E*001',
      energyKWh: 12,
      energyDirection: 'CHARGE',
    });
  });

  it('accepts the documented OCPI-style CDR contract', () => {
    expect(validateAndNormaliseCdr({
      id: 'cdr-session-20260914-001',
      country_code: 'DE',
      party_id: 'NF',
      cdr_token: { contract_id: 'demo-user-001' },
      cdr_location: { evse_id: 'DE*ABC*E*001' },
      start_date_time: '2026-09-14T05:00:00.000Z',
      end_date_time: '2026-09-14T06:00:00.000Z',
      total_energy: 12,
      energyDirection: 'CHARGE',
    })).toMatchObject({
      sessionId: 'cdr-session-20260914-001',
      providerId: 'NF',
      uid: 'demo-user-001',
      evseId: 'DE*ABC*E*001',
      energyKWh: 12,
      energyDirection: 'CHARGE',
    });
  });

  it.each([
    ['EVSE identifier', { EVSEID: undefined }, 'evseId is required'],
    ['start time', { StartTime: undefined }, 'start time is required'],
    ['end time', { EndTime: undefined }, 'end time is required'],
    ['energy', { Energy: undefined }, 'energy is required'],
  ])('rejects a CDR without its required %s', (_label, override, expectedError) => {
    expect(() => validateAndNormaliseCdr({ ...neverflatCdr, ...override }))
      .toThrow(expectedError);
  });

  it('rejects an invalid explicit energy direction', () => {
    expect(() => validateAndNormaliseCdr({
      ...neverflatCdr,
      EnergyDirection: 'EXPORT',
    })).toThrow('energy direction must be CHARGE or DISCHARGE');
  });

  it('rejects a non-numeric energy value', () => {
    expect(() => validateAndNormaliseCdr({
      ...neverflatCdr,
      Energy: 'not-a-number',
    })).toThrow('energy must be a finite number');
  });

  it('rejects an invalid or chronologically impossible end time', () => {
    expect(() => validateAndNormaliseCdr({
      ...neverflatCdr,
      EndTime: 'not-a-date',
    })).toThrow('Invalid endTime');

    expect(() => validateAndNormaliseCdr({
      ...neverflatCdr,
      EndTime: '2026-09-14T04:00:00.000Z',
    })).toThrow('end time must not be before start time');
  });
});

describe('canonical protocol and identity metadata', () => {
  const common = {
    SessionID: 'identity-session-1',
    ProviderID: 'provider-1',
    EVSEID: 'DE*ABC*E*001',
    ChargingStart: '2026-09-14T05:00:00Z',
    ChargingEnd: '2026-09-14T06:00:00Z',
    ConsumedEnergy: '1',
  };

  it('detects OCPI from the CDR structure and returns canonical eMAID provenance', () => {
    const result = validateAndNormaliseCdr({
      id: 'ocpi-cdr-1',
      party_id: 'NF',
      cdr_token: {
        contract_id: 'DE*EMP*E123456',
        uid: 'ocpi-token-uid',
        type: 'RFID',
        country_code: 'DE',
        party_id: 'NF',
      },
      cdr_location: { evse_id: 'DE*ABC*E*001' },
      start_date_time: '2026-09-14T05:00:00Z',
      end_date_time: '2026-09-14T06:00:00Z',
      total_energy: 1,
    });

    expect(result).toMatchObject({
      eMAID: 'DE*EMP*E123456',
      emaid: 'DE*EMP*E123456',
      uid: 'DE*EMP*E123456',
      protocol: 'OCPI',
      sourceField: 'cdr_token.contract_id',
      tokenMetadata: {
        uid: 'ocpi-token-uid',
        type: 'RFID',
        countryCode: 'DE',
        partyId: 'NF',
      },
    });
  });

  it.each([
    ['RemoteIdentification', { RemoteIdentification: { EvcoID: 'DE*EMP*E123456' } }],
    ['QRCodeIdentification', { QRCodeIdentification: { EvcoID: 'DE*EMP*E123456' } }],
    ['PlugAndChargeIdentification', { PlugAndChargeIdentification: { EvcoID: 'DE*EMP*E123456' } }],
    ['RFIDIdentification', { RFIDIdentification: { EvcoID: 'DE*EMP*E123456', UID: 'rfid-uid' } }],
  ])('detects OICP %s EvcoID as the owning eMAID', (_variant, identification) => {
    const result = validateAndNormaliseCdr({
      ...common,
      Identification: identification,
    });

    expect(result.eMAID).toBe('DE*EMP*E123456');
    expect(result.protocol).toBe('OICP');
    expect(result.sourceField).toBe(`Identification.${_variant}.EvcoID`);
    expect(result.tokenMetadata?.uid).toBe(_variant === 'RFIDIdentification' ? 'rfid-uid' : undefined);
  });

  it('returns structured identity errors for missing and UID-only ownership', () => {
    try {
      normaliseSession({ ...common, UID: 'rfid-only' });
      throw new Error('expected UID-only identity to fail');
    } catch (error) {
      expect(error).toBeInstanceOf(CdrNormalisationError);
      expect(error).toMatchObject({
        code: 'UID_ONLY',
        protocol: 'OICP',
        sourceFields: ['UID'],
      });
    }

    try {
      normaliseSession({ ...common });
      throw new Error('expected missing eMAID identity to fail');
    } catch (error) {
      expect(error).toMatchObject({ code: 'MISSING_EMAID', protocol: 'OICP' });
    }
  });

  it('rejects conflicting OCPI and OICP identity fields with provenance', () => {
    expect(() => normaliseSession({
      ...common,
      cdr_token: { contract_id: 'DE*EMP*E111111' },
      Identification: { RemoteIdentification: { EvcoID: 'DE*EMP*E222222' } },
    })).toThrow(/contradictory eMAID ownership aliases/);

    try {
      normaliseSession({
        ...common,
        cdr_token: { contract_id: 'DE*EMP*E111111' },
        Identification: { RemoteIdentification: { EvcoID: 'DE*EMP*E222222' } },
      });
      throw new Error('expected conflicting identity to fail');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'CONFLICTING_IDENTIFIERS',
        protocol: 'MIXED',
        sourceFields: [
          'cdr_token.contract_id',
          'Identification.RemoteIdentification.EvcoID',
        ],
      });
    }
  });

  it('detects mixed structure without allowing a protocol override', () => {
    expect(detectCdrProtocol({
      id: 'ocpi-cdr',
      cdr_token: { contract_id: 'DE*EMP*E123456' },
      Identification: { RemoteIdentification: { EvcoID: 'DE*EMP*E123456' } },
    })).toBe('MIXED');
  });
});
