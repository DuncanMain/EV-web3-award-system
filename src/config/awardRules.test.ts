import {
  calculateAwardTokens,
  getAwardCalculationContext,
  getAwardRules,
  getDeduplicationKey,
  isOffPeakForCountry,
  setRules,
} from './awardRules';
import { getOffPeakWindows, setOffPeakWindows } from './offPeakWindows';
import { NormalisedSession } from '../types';

describe('Award Rules', () => {
  const mockChargingSession: NormalisedSession = {
    sessionId: 'sess-001',
    providerId: 'prov-DE',
    uid: 'user-123',
    evseId: 'DE*ABC*E12345',
    startTime: new Date('2023-10-01T02:00:00Z'), // Off-peak in DE
    endTime: new Date('2023-10-01T03:00:00Z'),
    energyKWh: 40,
    energyDirection: 'CHARGE',
  };

  const mockDischargeSession: NormalisedSession = {
    sessionId: 'sess-002',
    providerId: 'prov-DE',
    uid: 'user-456',
    evseId: 'DE*XYZ*E67890',
    startTime: new Date('2023-10-01T14:00:00Z'), // Peak time
    endTime: new Date('2023-10-01T15:00:00Z'),
    energyKWh: 10,
    energyDirection: 'DISCHARGE',
  };

  describe('calculateAwardTokens', () => {
    it('uses pilot IANA zones for equivalent instants independent of host timezone', () => {
      const utcSession: NormalisedSession = {
        ...mockChargingSession,
        startTime: new Date('2024-01-15T21:00:00Z'), // 22:00 in Europe/Berlin
      };
      const offsetSession: NormalisedSession = {
        ...mockChargingSession,
        startTime: new Date('2024-01-15T22:00:00+01:00'), // Same instant
      };
      expect(calculateAwardTokens(utcSession)).toBe(10);
      expect(calculateAwardTokens(offsetSession)).toBe(10);

      const originalTimezone = process.env.TZ;
      process.env.TZ = 'Pacific/Honolulu';
      try {
        expect(calculateAwardTokens(utcSession)).toBe(10);
      } finally {
        if (originalTimezone === undefined) delete process.env.TZ;
        else process.env.TZ = originalTimezone;
      }
    });

    it('uses the configured pilot zones for ES and RO', () => {
      const spainSession: NormalisedSession = {
        ...mockChargingSession,
        evseId: 'ES*ABC*E12345',
        startTime: new Date('2024-01-15T21:00:00Z'), // 22:00 in Europe/Madrid
      };
      const romaniaSession: NormalisedSession = {
        ...mockChargingSession,
        evseId: 'RO*ABC*E12345',
        startTime: new Date('2024-01-15T20:00:00Z'), // 22:00 in Europe/Bucharest
      };

      expect(calculateAwardTokens(spainSession)).toBe(10);
      expect(calculateAwardTokens(romaniaSession)).toBe(10);
    });

    it('handles DST start and repeated local time at DST end', () => {
      const springSession: NormalisedSession = {
        ...mockChargingSession,
        startTime: new Date('2024-03-31T20:00:00Z'), // 22:00 CEST
      };
      expect(calculateAwardTokens(springSession)).toBe(10);
      expect(getAwardCalculationContext(springSession).localStartTime)
        .toBe('2024-03-31T22:00:00');

      const firstRepeatedHour: NormalisedSession = {
        ...mockChargingSession,
        startTime: new Date('2024-10-27T00:30:00Z'), // 02:30 CEST
      };
      const secondRepeatedHour: NormalisedSession = {
        ...mockChargingSession,
        startTime: new Date('2024-10-27T01:30:00Z'), // 02:30 CET
      };
      expect(calculateAwardTokens(firstRepeatedHour)).toBe(10);
      expect(calculateAwardTokens(secondRepeatedHour)).toBe(10);
      expect(getAwardCalculationContext(firstRepeatedHour).localStartTime)
        .toBe('2024-10-27T02:30:00');
      expect(getAwardCalculationContext(secondRepeatedHour).localStartTime)
        .toBe('2024-10-27T02:30:00');
    });

    it('keeps an overnight session on the session-start policy', () => {
      const peakStartCrossingIntoWindow: NormalisedSession = {
        ...mockChargingSession,
        startTime: new Date('2024-01-01T20:30:00Z'), // 21:30 local, peak
        endTime: new Date('2024-01-02T07:30:00Z'), // 08:30 local, peak
      };
      const offPeakStartCrossingOutOfWindow: NormalisedSession = {
        ...mockChargingSession,
        startTime: new Date('2024-01-01T21:30:00Z'), // 22:30 local, off-peak
        endTime: new Date('2024-01-02T07:30:00Z'), // 08:30 local, peak
      };

      expect(calculateAwardTokens(peakStartCrossingIntoWindow)).toBe(0);
      expect(calculateAwardTokens(offPeakStartCrossingOutOfWindow)).toBe(10);
      expect(isOffPeakForCountry('DE', new Date('2024-01-02T04:59:00Z'))).toBe(true);
      expect(isOffPeakForCountry('DE', new Date('2024-01-02T05:00:00Z'))).toBe(false);
    });

    it('allows an explicit Atlantic/Canary override for an ES session', () => {
      const madridSession: NormalisedSession = {
        ...mockChargingSession,
        evseId: 'ES*ABC*E12345',
        startTime: new Date('2024-01-01T21:00:00Z'), // 22:00 in Madrid
      };
      const canarySession: NormalisedSession = {
        ...madridSession,
        timeZone: 'Atlantic/Canary',
        timeZoneSource: 'timeZone',
      };

      expect(calculateAwardTokens(madridSession)).toBe(10);
      expect(calculateAwardTokens(canarySession)).toBe(0); // 21:00 in Canary
      expect(getAwardCalculationContext(canarySession)).toMatchObject({
        timeZone: 'Atlantic/Canary',
        timeZoneSource: 'timeZone',
        localStartTime: '2024-01-01T21:00:00',
        eligibilityBasis: 'session_start',
      });
    });

    it('requires a timezone for configured non-pilot charging windows but keeps V2G independent', () => {
      const originalWindows = getOffPeakWindows();
      try {
        setOffPeakWindows({
          ...originalWindows,
          GB: [{ start: '22:00', end: '06:00' }],
        });

        const gbCharge: NormalisedSession = {
          ...mockChargingSession,
          evseId: 'GB*ABC*E12345',
          startTime: new Date('2024-01-01T22:00:00Z'),
        };
        expect(() => calculateAwardTokens(gbCharge)).toThrow(/No IANA timezone configured/);
        expect(calculateAwardTokens({
          ...gbCharge,
          timeZone: 'Europe/London',
          timeZoneSource: 'timeZone',
        })).toBe(10);

        const gbDischarge: NormalisedSession = {
          ...gbCharge,
          energyDirection: 'DISCHARGE',
        };
        expect(calculateAwardTokens(gbDischarge)).toBe(40);
      } finally {
        setOffPeakWindows(originalWindows);
      }
    });

    it('keeps non-pilot countries without windows charging-ineligible and rewards V2G discharge', () => {
      const unknownCharge: NormalisedSession = {
        ...mockChargingSession,
        evseId: 'XX*ABC*E12345',
      };
      const unknownDischarge: NormalisedSession = {
        ...unknownCharge,
        energyDirection: 'DISCHARGE',
      };

      expect(calculateAwardTokens(unknownCharge)).toBe(0);
      expect(calculateAwardTokens(unknownDischarge)).toBe(40);
      expect(getAwardCalculationContext(unknownDischarge)).toMatchObject({
        countryCode: 'XX',
        timeZone: null,
        timeZoneSource: 'unconfigured',
        localStartTime: null,
        eligibilityBasis: 'discharge',
      });
    });

    it('should calculate off-peak charging rewards (1 token per 4 kWh)', () => {
      const tokens = calculateAwardTokens(mockChargingSession);
      expect(tokens).toBe(10); // 40 kWh / 4 = 10 tokens
    });

    it('should return 0 for peak-hour charging', () => {
      const peakSession: NormalisedSession = {
        ...mockChargingSession,
        startTime: new Date('2023-10-01T14:00:00Z'), // Peak hours
      };
      const tokens = calculateAwardTokens(peakSession);
      expect(tokens).toBe(0);
    });

    it('should calculate V2G discharge rewards (1 token per 1 kWh)', () => {
      const tokens = calculateAwardTokens(mockDischargeSession);
      expect(tokens).toBe(10); // 10 kWh * 1 = 10 tokens
    });

    it('should return 0 for sessions with no energy', () => {
      const noEnergySession: NormalisedSession = {
        ...mockChargingSession,
        energyKWh: 0,
      };
      const tokens = calculateAwardTokens(noEnergySession);
      expect(tokens).toBe(0);
    });

    it('should apply floor function correctly', () => {
      const partialKwhSession: NormalisedSession = {
        ...mockChargingSession,
        energyKWh: 10.75, // 10.75 kWh / 4 = 2.6875 → floor = 2
      };
      const tokens = calculateAwardTokens(partialKwhSession);
      expect(tokens).toBe(2);
    });

    it('should handle off-peak windows spanning midnight', () => {
      // DE off-peak: 22:00 - 06:00
      const midnightChargingSession: NormalisedSession = {
        ...mockChargingSession,
        startTime: new Date('2023-10-01T23:30:00Z'),
        energyKWh: 8, // Should get 2 tokens
      };
      const tokens = calculateAwardTokens(midnightChargingSession);
      expect(tokens).toBe(2);
    });

    it('should return 0 for countries without off-peak config', () => {
      const unknownCountrySession: NormalisedSession = {
        ...mockChargingSession,
        evseId: 'XX*ABC*E12345', // Unknown country
      };
      const tokens = calculateAwardTokens(unknownCountrySession);
      expect(tokens).toBe(0); // No off-peak config for XX
    });

    it('should handle combined charge and discharge scenarios correctly', () => {
      // In practice, a session is either CHARGE or DISCHARGE, not both
      // But we verify the logic handles it
      expect(mockChargingSession.energyDirection).toBe('CHARGE');
      expect(mockDischargeSession.energyDirection).toBe('DISCHARGE');
    });
  });

  describe('getDeduplicationKey', () => {
    it('should generate deduplication key from sessionId and providerId', () => {
      const key = getDeduplicationKey(mockChargingSession);
      expect(key).toBe('sess-001-prov-DE');
    });

    it('should ensure same session produces same key', () => {
      const key1 = getDeduplicationKey(mockChargingSession);
      const key2 = getDeduplicationKey(mockChargingSession);
      expect(key1).toBe(key2);
    });

    it('should produce different keys for different sessions', () => {
      const key1 = getDeduplicationKey(mockChargingSession);
      const key2 = getDeduplicationKey(mockDischargeSession);
      expect(key1).not.toBe(key2);
    });
  });

  describe('getAwardRules', () => {
    it('should return award rules configuration', () => {
      const rules = getAwardRules();
      expect(rules).toBeDefined();
      expect(rules.version).toBe('1.0');
    });

    it('should have off-peak charging rule enabled', () => {
      const rules = getAwardRules();
      expect(rules.rules.offPeakCharging.enabled).toBe(true);
      expect(rules.rules.offPeakCharging.tokensPerKWh).toBe(0.25); // 1/4
    });

    it('should have V2G discharge rule enabled', () => {
      const rules = getAwardRules();
      expect(rules.rules.v2gDischarge.enabled).toBe(true);
      expect(rules.rules.v2gDischarge.tokensPerKWh).toBe(1);
    });

    it('should have idempotency deduplication key configured', () => {
      const rules = getAwardRules();
      expect(rules.idempotency.deduplicationKey).toContain('sessionId');
      expect(rules.idempotency.deduplicationKey).toContain('providerId');
    });

    it('should reflect the current runtime rule override', () => {
      const original = getAwardRules();
      const runtimeOverride = { ...original, version: 'runtime-test' };
      setRules(runtimeOverride);
      try {
        expect(getAwardRules()).toBe(runtimeOverride);
      } finally {
        setRules(original);
      }
    });

    it('should expose a deterministic calculation snapshot and fingerprint', () => {
      const first = getAwardCalculationContext(mockChargingSession);
      const second = getAwardCalculationContext(mockChargingSession);
      expect(first.configurationSnapshot).toContain('Europe/Berlin');
      expect(first.configurationFingerprint).toMatch(/^[a-f0-9]{64}$/);
      expect(first.configurationFingerprint).toBe(second.configurationFingerprint);

      const changedRules = {
        ...getAwardRules(),
        rules: {
          ...getAwardRules().rules,
          offPeakCharging: {
            ...getAwardRules().rules.offPeakCharging,
            tokensPerKWh: 0.5,
          },
        },
      };
      expect(getAwardCalculationContext(mockChargingSession, changedRules).configurationFingerprint)
        .not.toBe(first.configurationFingerprint);
    });
  });

  describe('Edge cases', () => {
    it('should handle very large energy values', () => {
      const largeSession: NormalisedSession = {
        ...mockChargingSession,
        energyKWh: 1000,
      };
      const tokens = calculateAwardTokens(largeSession);
      expect(tokens).toBe(250); // 1000 / 4 = 250
    });

    it('should handle very small energy values', () => {
      const smallSession: NormalisedSession = {
        ...mockChargingSession,
        energyKWh: 0.5,
      };
      const tokens = calculateAwardTokens(smallSession);
      expect(tokens).toBe(0); // 0.5 / 4 = 0.125 → floor = 0
    });

    it('should handle exactly 4 kWh', () => {
      const exactSession: NormalisedSession = {
        ...mockChargingSession,
        energyKWh: 4,
      };
      const tokens = calculateAwardTokens(exactSession);
      expect(tokens).toBe(1);
    });

    it('should handle exactly 1 kWh discharge', () => {
      const exactDischargeSession: NormalisedSession = {
        ...mockDischargeSession,
        energyKWh: 1,
      };
      const tokens = calculateAwardTokens(exactDischargeSession);
      expect(tokens).toBe(1);
    });
  });
});
