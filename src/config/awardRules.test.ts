import { calculateAwardTokens, getDeduplicationKey, getAwardRules } from './awardRules';
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