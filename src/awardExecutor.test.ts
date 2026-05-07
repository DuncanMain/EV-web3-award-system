import { prepareAward, processAwardFromCDR } from './awardExecutor';
import { NormalisedSession } from './types';
import { clearUserRegistry } from './user/userService';
import { ethers } from 'ethers';

// Mock the contract module
jest.mock('./contract');
jest.mock('./user/userService', () => ({
  clearUserRegistry: jest.fn(),
  getUserWalletConfig: jest.fn().mockResolvedValue({
    walletAddress: '0x1111111111111111111111111111111111111111',
    walletMode: 'custodial',
  }),
}));
jest.mock('./database/integration', () => ({
  recordAward: jest.fn().mockResolvedValue(undefined),
  approveUserForSpendingViaFunding: jest.fn().mockResolvedValue(undefined),
}));

describe('Award Executor', () => {
  const mockContract = {
    transfer: jest.fn().mockResolvedValue({
      hash: '0xmocktxhash123',
      wait: jest.fn().mockResolvedValue({}),
    }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    clearUserRegistry(); // Clear user registry before each test
    // Set up the contract mock for each test
    const contractMock = require('./contract');
    contractMock.getContract.mockReturnValue(mockContract);
  });

  describe('prepareAward', () => {
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

    it('should prepare award with eligibility and dedup key', () => {
      const result = prepareAward(mockChargingSession);

      expect(result.eligible).toBe(true);
      expect(result.amount).toBe(10);
      expect(result.uid).toBe('user-123');
      expect(result.dedupKey).toBe('sess-001-prov-DE');
    });

    it('should return ineligible for non-rewarded sessions', () => {
      const peakSession: NormalisedSession = {
        ...mockChargingSession,
        startTime: new Date('2023-10-01T14:00:00Z'), // Peak hours
      };

      const result = prepareAward(peakSession);

      expect(result.eligible).toBe(false);
      expect(result.amount).toBe(0);
    });
  });

  describe('processAwardFromCDR', () => {
    const mockRawCDR = {
      SessionID: 'sess-001',
      ProviderID: 'prov-DE',
      EVSEID: 'DE*ABC*E12345',
      "Session Start": '2023-10-01T02:00:00Z',
      "Session End": '2023-10-01T03:00:00Z',
      "Consumed Energy": '40',
      cdr_token: { contract_id: 'user-123' },
    };

    // Create mock signer (user address is resolved automatically from UID)
    const mockSigner = {} as ethers.Signer;

    it('should successfully process eligible CDR with on-chain execution', async () => {
      const result = await processAwardFromCDR(mockRawCDR, mockSigner);

      expect(result.success).toBe(true);
      expect(result.eligible).toBe(true);
      expect(result.amount).toBe(10);
      expect(result.uid).toBe('user-123');
      expect(result.dedupKey).toBe('sess-001-prov-DE');
      expect(result.txHash).toBe('0xmocktxhash123');
      expect(result.stage).toBe('complete');
    });

    it('should return success for ineligible CDR (no award)', async () => {
      const ineligibleCDR = {
        ...mockRawCDR,
        "Consumed Energy": '0', // Zero energy
      };

      const result = await processAwardFromCDR(ineligibleCDR, mockSigner);

      expect(result.success).toBe(true);
      expect(result.eligible).toBe(false);
      expect(result.amount).toBe(0);
      expect(result.stage).toBe('complete');
    });

    it('should fail on invalid CDR', async () => {
      const invalidCDR = {
        // Missing required fields
        SessionID: 'sess-001',
      };

      const result = await processAwardFromCDR(invalidCDR, mockSigner);

      expect(result.success).toBe(false);
      expect(result.eligible).toBe(false);
      expect(result.error).toContain('Normalisation failed');
      expect(result.stage).toBe('normalisation');
    });

    it('should check deduplication if checker provided', async () => {
      const mockChecker = jest.fn().mockResolvedValue(true); // Already processed

      const result = await processAwardFromCDR(
        mockRawCDR,
        mockSigner,
        mockChecker
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('already processed');
      expect(result.stage).toBe('validation');
      expect(mockChecker).toHaveBeenCalledWith('sess-001-prov-DE');
    });

    it('should pass deduplication check if not already processed', async () => {
      const mockChecker = jest.fn().mockResolvedValue(false); // Not processed

      const result = await processAwardFromCDR(
        mockRawCDR,
        mockSigner,
        mockChecker
      );

      expect(result.success).toBe(true);
      expect(result.eligible).toBe(true);
      expect(result.stage).toBe('complete');
    });

    it('should handle deduplication check failure gracefully', async () => {
      const mockChecker = jest.fn().mockRejectedValue(new Error('DB error'));

      const result = await processAwardFromCDR(
        mockRawCDR,
        mockSigner,
        mockChecker
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain('Deduplication check failed');
      expect(result.stage).toBe('validation');
    });

    it('should process V2G discharge CDR', async () => {
      const dischargeCDR = {
        SessionID: 'sess-v2g',
        ProviderID: 'prov-V2G',
        EVSEID: 'DE*V2G*E99999',
        "Session Start": '2023-10-01T14:00:00Z', // Peak time (irrelevant for discharge)
        "Session End": '2023-10-01T15:00:00Z',
        "Consumed Energy": '-20', // Negative = discharge
        cdr_token: { contract_id: 'user-v2g' },
      };

      const result = await processAwardFromCDR(dischargeCDR, mockSigner);

      expect(result.success).toBe(true);
      expect(result.eligible).toBe(true);
      expect(result.amount).toBe(20); // 20 kWh discharge @ 1 token/kWh
      expect(result.stage).toBe('complete');
    });

    it('should track stage through entire pipeline', async () => {
      const invalidSessionCDR = {
        SessionID: 'sess-001',
        // Missing ProviderID
        EVSEID: 'DE*ABC*E12345',
        "Consumed Energy": '40',
        cdr_token: { contract_id: 'user-123' },
      };

      const result = await processAwardFromCDR(invalidSessionCDR, mockSigner);

      expect(result.stage).toBe('normalisation');
      expect(result.error).toBeDefined();
    });

    it('should process CDR with alternative field names', async () => {
      const altFormatCDR = {
        id: 'sess-alt',
        provider: 'prov-alt',
        evse: 'US*ALT*E55555',
        timestamp: '2023-10-01T02:00:00Z',
        charged: '12',
        cdr_token: { contract_id: 'user-alt' },
      };

      const result = await processAwardFromCDR(altFormatCDR, mockSigner);

      expect(result.success).toBe(true);
      expect(result.uid).toBe('user-alt');
      expect(result.dedupKey).toBe('sess-alt-prov-alt');
    });
  });
});