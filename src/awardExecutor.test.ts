import { prepareAward, processAwardFromCDR, recoverAwardOperation } from './awardExecutor';
import { NormalisedSession } from './types';
import { clearUserRegistry } from './user/userService';
import { ethers } from 'ethers';
import { awardIntentFingerprint, awardOperationKey } from './database/tokenOperation';
import { validateAndNormaliseCdr } from './normaliser';

// Mock the contract module
jest.mock('./contract');
jest.mock('./spendEvidence', () => ({
  verifySpendEvidence: jest.fn().mockResolvedValue({
    valid: true,
    proof: {
      txHash: `0x${'a'.repeat(64)}`,
      chainId: '80002',
      tokenContractAddress: '0x605871D30DC278a036F09e2ace771df8a224624B',
      sourceWallet: '0x9999999999999999999999999999999999999999',
      treasuryRecipient: '0x1111111111111111111111111111111111111111',
      amountUnits: '10000000000000000000',
      transferMethod: 'transfer',
      transactionFrom: '0x9999999999999999999999999999999999999999',
      blockNumber: 1,
      logIndex: 0,
    },
  }),
}));
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
jest.mock('./database/service', () => ({
  TokenOperations: {
    findByKey: jest.fn().mockResolvedValue(undefined),
    claim: jest.fn().mockImplementation(async (input: { operationKey: string; amount: string }) => ({
      acquired: true,
      operation: {
        operation_key: input.operationKey,
        status: 'submitting',
        amount: input.amount,
        intent_context: {
          assetContext: {
            tokenContractAddress: '0x605871D30DC278a036F09e2ace771df8a224624B',
            chainId: '80002',
            treasuryAddress: '0x9999999999999999999999999999999999999999',
            signerAddress: '0x9999999999999999999999999999999999999999',
          },
        },
      },
    })),
    markSubmitted: jest.fn().mockResolvedValue(undefined),
    markConfirmed: jest.fn().mockResolvedValue(undefined),
    markProjected: jest.fn().mockResolvedValue(undefined),
    markProjectionError: jest.fn().mockResolvedValue(undefined),
    markUnknown: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
  },
}));

describe('Award Executor', () => {
  const mockContract = {
    transfer: jest.fn().mockResolvedValue({
      hash: `0x${'a'.repeat(64)}`,
      wait: jest.fn().mockResolvedValue({ status: 1 }),
    }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.TREASURY_ADDRESS = '0x9999999999999999999999999999999999999999';
    process.env.CHAIN_ID = '80002';
    process.env.TOKEN_CONTRACT_ADDRESS = '0x605871D30DC278a036F09e2ace771df8a224624B';
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
    const mockSigner = {
      getAddress: jest.fn().mockResolvedValue('0x9999999999999999999999999999999999999999'),
      provider: { getNetwork: jest.fn().mockResolvedValue({ chainId: 80002n }) },
    } as unknown as ethers.Signer;

    function installDurableOperationMock() {
      const serviceMock = require('./database/service');
      const operations = new Map<string, any>();
      serviceMock.TokenOperations.findByKey.mockImplementation(async (key: string) => operations.get(key));
      serviceMock.TokenOperations.claim.mockImplementation(async (input: any) => {
        const existing = operations.get(input.operationKey);
        if (existing) return { operation: existing, acquired: false };
        const operation = {
          operation_key: input.operationKey,
          operation_type: input.operationType,
          legacy_key: input.legacyKey,
          request_fingerprint: input.requestFingerprint,
          uid: input.uid,
          session_id: input.sessionId,
          provider_id: input.providerId,
          charging_session_id: input.chargingSessionId || null,
          status: 'submitting',
          amount: input.amount,
          tx_hash: null,
          wallet_address: '0x1111111111111111111111111111111111111111',
          intent_context: input.intentContext,
        };
        operations.set(input.operationKey, operation);
        return { operation, acquired: true };
      });
      serviceMock.TokenOperations.markSubmitted.mockImplementation(async (key: string, txHash: string) => {
        const operation = operations.get(key);
        operation.tx_hash = txHash;
        operation.status = 'submitted';
        return operation;
      });
      serviceMock.TokenOperations.markConfirmed.mockImplementation(async (key: string) => {
        const operation = operations.get(key);
        operation.status = 'confirmed';
        return operation;
      });
      serviceMock.TokenOperations.markProjected.mockImplementation(async (key: string) => {
        const operation = operations.get(key);
        operation.status = 'projected';
        return operation;
      });
      serviceMock.TokenOperations.markProjectionError.mockImplementation(async (key: string, message: string) => {
        const operation = operations.get(key);
        operation.status = 'confirmed';
        operation.error_message = message;
        return operation;
      });
      serviceMock.TokenOperations.markUnknown.mockImplementation(async (key: string, message: string) => {
        const operation = operations.get(key);
        operation.status = 'unknown';
        operation.error_message = message;
        return operation;
      });
      return operations;
    }

    it('replays pre-guard recovery snapshots with and without an OCPI physical-session field', async () => {
      const operations = installDurableOperationMock();
      const walletAddress = '0x1111111111111111111111111111111111111111';
      const assetContext = {
        tokenContractAddress: '0x605871D30DC278a036F09e2ace771df8a224624B',
        chainId: '80002',
        treasuryAddress: '0x9999999999999999999999999999999999999999',
        signerAddress: '0x9999999999999999999999999999999999999999',
      };
      // These fingerprints are literal fixtures from the pre-charging-session
      // snapshot serializer. Do not regenerate them with the current helper:
      // existing persisted v1 snapshots must remain recoverable after upgrade.
      const fixtures = [
        {
          rawCDR: {
            id: 'legacy-ocpi-cdr-001',
            session_id: 'physical-legacy-001',
            party_id: 'prov-DE',
            cdr_token: { contract_id: 'user-legacy-ocpi' },
            cdr_location: { evse_id: 'DE*ABC*E12345' },
            start_date_time: '2023-10-01T02:00:00Z',
            end_date_time: '2023-10-01T03:00:00Z',
            total_energy: 40,
          },
          fingerprint: '2c50ee82e1a30452158ea34d507e25036a64e76bc03b132ac1d9a5dfb61cc200',
          normalisedSession: {
            sessionId: 'legacy-ocpi-cdr-001',
            providerId: 'prov-DE',
            eMAID: 'user-legacy-ocpi',
            emaid: 'user-legacy-ocpi',
            protocol: 'OCPI' as const,
            sourceField: 'cdr_token.contract_id',
            uid: 'user-legacy-ocpi',
            evseId: 'DE*ABC*E12345',
            startTime: '2023-10-01T02:00:00.000Z',
            endTime: '2023-10-01T03:00:00.000Z',
            energyKWh: 40,
            energyDirection: 'CHARGE' as const,
            cdrId: 'legacy-ocpi-cdr-001',
            reservationSessionId: 'physical-legacy-001',
          },
        },
        {
          rawCDR: {
            SessionID: 'legacy-oicp-session-001',
            ProviderID: 'prov-oicp',
            ContractID: 'user-legacy-oicp',
            EVSEID: 'DE*ABC*E12345',
            'Session Start': '2023-10-01T02:00:00Z',
            'Session End': '2023-10-01T03:00:00Z',
            'Consumed Energy': '40',
          },
          fingerprint: 'c7387ae245d868082be9a172535368bb5d52d9526cd31fcdb53f40f6ccb5707b',
          normalisedSession: {
            sessionId: 'legacy-oicp-session-001',
            providerId: 'prov-oicp',
            eMAID: 'user-legacy-oicp',
            emaid: 'user-legacy-oicp',
            protocol: 'OICP' as const,
            sourceField: 'ContractID',
            uid: 'user-legacy-oicp',
            evseId: 'DE*ABC*E12345',
            startTime: '2023-10-01T02:00:00.000Z',
            endTime: '2023-10-01T03:00:00.000Z',
            energyKWh: 40,
            energyDirection: 'CHARGE' as const,
          },
        },
      ];

      for (const fixture of fixtures) {
        const operationKey = awardOperationKey(
          fixture.normalisedSession.providerId,
          fixture.normalisedSession.sessionId,
        );
        operations.set(operationKey, {
          operation_key: operationKey,
          operation_type: 'award',
          legacy_key: `${fixture.normalisedSession.sessionId}-${fixture.normalisedSession.providerId}`,
          request_fingerprint: fixture.fingerprint,
          uid: fixture.normalisedSession.uid,
          status: 'submitted',
          amount: '10.00',
          tx_hash: `0x${'b'.repeat(64)}`,
          wallet_address: walletAddress,
          intent_context: {
            assetContext,
            recoverySnapshot: {
              version: 1,
              fingerprint: fixture.fingerprint,
              normalisedSession: fixture.normalisedSession,
              rawCDR: fixture.rawCDR,
            },
          },
        });

        const replay = await processAwardFromCDR(fixture.rawCDR, mockSigner);
        expect(replay).toMatchObject({ success: true, operationStatus: 'projected' });

        const recovered = await recoverAwardOperation(operationKey, mockSigner);
        expect(recovered).toMatchObject({ success: true, duplicate: true, operationStatus: 'projected' });
      }

      expect(mockContract.transfer).not.toHaveBeenCalled();

      // The durable helper intentionally installs an in-memory operation
      // store. Restore the module mock before the next test so its stateful
      // implementations cannot leak into the legacy executor cases below.
      const serviceMock = require('./database/service');
      serviceMock.TokenOperations.findByKey.mockResolvedValue(undefined);
      serviceMock.TokenOperations.claim.mockImplementation(async (input: any) => ({
        acquired: true,
        operation: {
          operation_key: input.operationKey,
          status: 'submitting',
          amount: input.amount,
          intent_context: {
            assetContext,
          },
        },
      }));
      for (const method of ['markSubmitted', 'markConfirmed', 'markProjected', 'markProjectionError', 'markUnknown', 'markFailed']) {
        serviceMock.TokenOperations[method].mockResolvedValue(undefined);
      }
    });

    it('should successfully process eligible CDR with on-chain execution', async () => {
      const result = await processAwardFromCDR(mockRawCDR, mockSigner);

      expect(result.success).toBe(true);
      expect(result.eligible).toBe(true);
      expect(result.amount).toBe(10);
      expect(result.uid).toBe('user-123');
      expect(result.dedupKey).toBe('sess-001-prov-DE');
      expect(result.txHash).toBe(`0x${'a'.repeat(64)}`);
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
      end_date_time: '2023-10-01T03:00:00Z',
      charged: '12',
        cdr_token: { contract_id: 'user-alt' },
      };

      const result = await processAwardFromCDR(altFormatCDR, mockSigner);

      expect(result.success).toBe(true);
      expect(result.uid).toBe('user-alt');
      expect(result.dedupKey).toBe('sess-alt-prov-alt');
    });

    it('does not claim or submit an award for a missing final CDR field', async () => {
      const invalidFinalCdr = { ...mockRawCDR } as Record<string, unknown>;
      delete invalidFinalCdr['Session End'];
      const result = await processAwardFromCDR(invalidFinalCdr, mockSigner);

      expect(result.success).toBe(false);
      expect(result.stage).toBe('normalisation');
      expect(mockContract.transfer).not.toHaveBeenCalled();
    });

    it('submits only once when two requests claim the same award concurrently', async () => {
      installDurableOperationMock();
      const first = processAwardFromCDR(mockRawCDR, mockSigner);
      const second = processAwardFromCDR(mockRawCDR, mockSigner);
      const results = await Promise.all([first, second]);

      expect(mockContract.transfer).toHaveBeenCalledTimes(1);
      expect(results.some(result => result.success)).toBe(true);
      expect(results.some(result => result.pending)).toBe(true);
    });

    it('fails closed for a replacement CDR with the same provider and physical session', async () => {
      const serviceMock = require('./database/service');
      serviceMock.TokenOperations.claim.mockRejectedValueOnce({
        code: 'AWARD_CHARGING_SESSION_COLLISION_REVIEW',
        message: 'AWARD_CHARGING_SESSION_COLLISION_REVIEW: another CDR key already owns this provider charging session; operator review is required and no replacement award was submitted',
      });
      const replacementCdr = {
        id: 'replacement-cdr-002',
        session_id: 'physical-session-001',
        party_id: 'prov-DE',
        cdr_token: { contract_id: 'user-123' },
        Identification: { RemoteIdentification: { EvcoID: 'user-123' } },
        cdr_location: { evse_id: 'DE*ABC*E12345' },
        start_date_time: '2023-10-01T02:00:00Z',
        end_date_time: '2023-10-01T03:00:00Z',
        total_energy: 40,
      };

      const result = await processAwardFromCDR(replacementCdr, mockSigner);

      expect(result).toMatchObject({
        success: false,
        pending: true,
        requiresReview: true,
        operationStatus: 'review',
        stage: 'validation',
      });
      expect(result.error).toContain('AWARD_CHARGING_SESSION_COLLISION_REVIEW');
      expect(mockContract.transfer).not.toHaveBeenCalled();
      expect(serviceMock.TokenOperations.claim).toHaveBeenCalledWith(expect.objectContaining({
        operationKey: expect.any(String),
        chargingSessionId: 'physical-session-001',
      }));
    });

    it('does not let an original CDR replay strip its saved physical-session binding', async () => {
      installDurableOperationMock();
      const boundCdr = {
        id: 'bound-cdr-001',
        session_id: 'physical-session-002',
        party_id: 'prov-DE',
        cdr_token: { contract_id: 'user-123' },
        cdr_location: { evse_id: 'DE*ABC*E12345' },
        start_date_time: '2023-10-01T02:00:00Z',
        end_date_time: '2023-10-01T03:00:00Z',
        total_energy: 40,
      };
      const first = await processAwardFromCDR(boundCdr, mockSigner);
      expect(first.success).toBe(true);

      const stripped = { ...boundCdr } as Record<string, unknown>;
      delete stripped.session_id;
      const replay = await processAwardFromCDR(stripped, mockSigner);

      expect(replay).toMatchObject({ success: false, stage: 'validation', requiresReview: true });
      expect(replay.error).toContain('charging session identity');
      expect(mockContract.transfer).toHaveBeenCalledTimes(1);
    });

    it('replays a confirmed chain transfer after projection failure without rebroadcasting', async () => {
      const operations = installDurableOperationMock();
      const integrationMock = require('./database/integration');
      integrationMock.recordAward.mockRejectedValueOnce(new Error('database unavailable'));

      const first = await processAwardFromCDR(mockRawCDR, mockSigner);
      expect(first.success).toBe(false);
      expect(first.pending).toBe(true);
      expect(first.txHash).toBe(`0x${'a'.repeat(64)}`);

      const operation = operations.get(awardOperationKey('prov-DE', 'sess-001'));
      const storedSnapshot = operation.intent_context.recoverySnapshot;
      const storedSnapshotJson = JSON.stringify(storedSnapshot);
      expect(storedSnapshot).toMatchObject({
        version: 1,
        normalisedSession: {
          eMAID: 'user-123',
          emaid: 'user-123',
          uid: 'user-123',
          protocol: 'OCPI',
          sourceField: 'cdr_token.contract_id',
          startTime: '2023-10-01T02:00:00.000Z',
          endTime: '2023-10-01T03:00:00.000Z',
        },
        rawCDR: mockRawCDR,
      });

      // The durable claim keeps the original amount/session even when the
      // policy now produces a different answer for the same raw input.
      const rules = require('./config/awardRules');
      const calculationSpy = jest.spyOn(rules, 'calculateAwardTokens').mockReturnValue(999);

      try {
        integrationMock.recordAward.mockResolvedValueOnce(undefined);
        const replay = await processAwardFromCDR(mockRawCDR, mockSigner);
        expect(replay.success).toBe(true);
        expect(replay.amount).toBe(10);
        expect(replay.txHash).toBe(`0x${'a'.repeat(64)}`);
        expect(mockContract.transfer).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(operation.intent_context.recoverySnapshot)).toBe(storedSnapshotJson);
        expect(integrationMock.recordAward.mock.calls[1][4]).toBe(JSON.stringify(mockRawCDR));
      } finally {
        calculationSpy.mockRestore();
      }
    });

    it('recovers a future award from the durable snapshot when the caller has lost the CDR', async () => {
      installDurableOperationMock();
      const integrationMock = require('./database/integration');
      integrationMock.recordAward.mockRejectedValueOnce(new Error('database unavailable'));

      const first = await processAwardFromCDR(mockRawCDR, mockSigner);
      expect(first).toMatchObject({ success: false, pending: true, txHash: `0x${'a'.repeat(64)}` });

      const recovered = await recoverAwardOperation(
        awardOperationKey('prov-DE', 'sess-001'),
        mockSigner,
      );

      expect(recovered).toMatchObject({
        success: true,
        amount: 10,
        txHash: `0x${'a'.repeat(64)}`,
        operationStatus: 'projected',
      });
      expect(mockContract.transfer).toHaveBeenCalledTimes(1);
      expect(integrationMock.recordAward.mock.calls[1][4]).toBe(JSON.stringify(mockRawCDR));
    });

    it('returns a projected known-hash award idempotently without requiring the CDR snapshot', async () => {
      const operations = installDurableOperationMock();
      const operationKey = awardOperationKey('prov-DE', 'sess-complete');
      const txHash = `0x${'c'.repeat(64)}`;
      operations.set(operationKey, {
        operation_key: operationKey,
        operation_type: 'award',
        status: 'projected',
        amount: '10.00',
        uid: 'user-123',
        wallet_address: '0x1111111111111111111111111111111111111111',
        tx_hash: txHash,
        intent_context: null,
      });

      const recovered = await recoverAwardOperation(operationKey, mockSigner, { requireFreshEvidence: true });

      expect(recovered).toMatchObject({
        success: true,
        duplicate: true,
        operationStatus: 'projected',
        txHash,
      });
      expect(mockContract.transfer).not.toHaveBeenCalled();
      expect(require('./database/integration').recordAward).not.toHaveBeenCalled();
    });

    it('fails closed when a stored recovery snapshot is malformed or fingerprint-mismatched', async () => {
      const operations = installDurableOperationMock();
      const integrationMock = require('./database/integration');
      integrationMock.recordAward.mockRejectedValueOnce(new Error('database unavailable'));

      await processAwardFromCDR(mockRawCDR, mockSigner);
      const operation = operations.get(awardOperationKey('prov-DE', 'sess-001'));
      operation.intent_context.recoverySnapshot.normalisedSession.startTime = 'not-a-date';

      const malformed = await recoverAwardOperation(
        awardOperationKey('prov-DE', 'sess-001'),
        mockSigner,
      );
      expect(malformed).toMatchObject({ success: false, stage: 'validation', requiresReview: true });
      expect(malformed.error).toContain('TOKEN_OPERATION_RECOVERY_SNAPSHOT_INVALID');
      expect(mockContract.transfer).toHaveBeenCalledTimes(1);

      operation.intent_context.recoverySnapshot.normalisedSession.startTime = '2023-10-01T02:00:00.000Z';
      operation.intent_context.recoverySnapshot.fingerprint = 'f'.repeat(64);
      const mismatched = await processAwardFromCDR(mockRawCDR, mockSigner);
      expect(mismatched).toMatchObject({ success: false, stage: 'validation', requiresReview: true });
      expect(mismatched.error).toContain('TOKEN_OPERATION_RECOVERY_SNAPSHOT_INVALID');
      expect(mockContract.transfer).toHaveBeenCalledTimes(1);
    });

    it('retains an ambiguous submission claim and never rebroadcasts automatically', async () => {
      installDurableOperationMock();
      mockContract.transfer.mockRejectedValueOnce(new Error('RPC connection dropped after submission'));

      const first = await processAwardFromCDR(mockRawCDR, mockSigner);
      expect(first.success).toBe(false);
      expect(first.pending).toBe(true);
      expect(first.requiresReview).toBe(true);

      const replay = await processAwardFromCDR(mockRawCDR, mockSigner);
      expect(replay.success).toBe(false);
      expect(replay.requiresReview).toBe(true);
      expect(mockContract.transfer).toHaveBeenCalledTimes(1);
    });

    it('recovers the stored award when current policy would exceed the cap', async () => {
      const operations = installDurableOperationMock();
      const operationKey = awardOperationKey('prov-DE', 'sess-cap-replay');
      operations.set(operationKey, {
        operation_key: operationKey,
        status: 'confirmed',
        amount: '10.00',
        tx_hash: `0x${'f'.repeat(64)}`,
        wallet_address: '0x1111111111111111111111111111111111111111',
        intent_context: {
          assetContext: {
            tokenContractAddress: '0x605871D30DC278a036F09e2ace771df8a224624B',
            chainId: '80002',
            treasuryAddress: '0x9999999999999999999999999999999999999999',
            signerAddress: '0x9999999999999999999999999999999999999999',
          },
        },
      });

      const replay = await processAwardFromCDR({
        ...mockRawCDR,
        SessionID: 'sess-cap-replay',
        'Consumed Energy': '1000',
      }, mockSigner);

      expect(replay.success).toBe(true);
      expect(replay.amount).toBe(10);
      expect(replay.txHash).toBe(`0x${'f'.repeat(64)}`);
      expect(mockContract.transfer).not.toHaveBeenCalled();
    });

    it('marks an already projected replay as a duplicate without reprojecting or rebroadcasting', async () => {
      const operations = installDurableOperationMock();
      const operationKey = awardOperationKey('prov-DE', 'sess-projected');
      operations.set(operationKey, {
        operation_key: operationKey,
        status: 'projected',
        amount: '10.00',
        tx_hash: `0x${'c'.repeat(64)}`,
        wallet_address: '0x1111111111111111111111111111111111111111',
        intent_context: {
          assetContext: {
            tokenContractAddress: '0x605871D30DC278a036F09e2ace771df8a224624B',
            chainId: '80002',
            treasuryAddress: '0x9999999999999999999999999999999999999999',
            signerAddress: '0x9999999999999999999999999999999999999999',
          },
        },
      });

      const replay = await processAwardFromCDR({ ...mockRawCDR, SessionID: 'sess-projected' }, mockSigner);

      expect(replay).toMatchObject({ success: true, duplicate: true, operationStatus: 'projected' });
      expect(mockContract.transfer).not.toHaveBeenCalled();
    });

    it('finalises a zero-award claim after the first markProjected write failed', async () => {
      const operations = installDurableOperationMock();
      const serviceMock = require('./database/service');
      serviceMock.TokenOperations.markProjected.mockRejectedValueOnce(new Error('database unavailable'));
      const ineligibleCDR = { ...mockRawCDR, SessionID: 'sess-zero-recovery', 'Consumed Energy': '0' };

      const first = await processAwardFromCDR(ineligibleCDR, mockSigner);
      expect(first).toMatchObject({ success: false, pending: true, requiresReview: false });
      const replay = await processAwardFromCDR(ineligibleCDR, mockSigner);

      expect(replay).toMatchObject({ success: true, eligible: false, operationStatus: 'projected' });
      expect(mockContract.transfer).not.toHaveBeenCalled();
      expect(operations.get(awardOperationKey('prov-DE', 'sess-zero-recovery')).status).toBe('projected');
    });

    it('recovers with the stored amount when current calculation throws', async () => {
      const operations = installDurableOperationMock();
      const operationKey = awardOperationKey('prov-DE', 'sess-calc-recovery');
      operations.set(operationKey, {
        operation_key: operationKey,
        status: 'confirmed',
        amount: '10.00',
        tx_hash: `0x${'d'.repeat(64)}`,
        wallet_address: '0x1111111111111111111111111111111111111111',
        intent_context: {
          assetContext: {
            tokenContractAddress: '0x605871D30DC278a036F09e2ace771df8a224624B',
            chainId: '80002',
            treasuryAddress: '0x9999999999999999999999999999999999999999',
            signerAddress: '0x9999999999999999999999999999999999999999',
          },
        },
      });
      const rules = require('./config/awardRules');
      const calculationSpy = jest.spyOn(rules, 'calculateAwardTokens').mockImplementation(() => {
        throw new Error('current rules unavailable');
      });

      const replay = await processAwardFromCDR({ ...mockRawCDR, SessionID: 'sess-calc-recovery' }, mockSigner);

      expect(replay).toMatchObject({ success: true, amount: 10, txHash: `0x${'d'.repeat(64)}` });
      expect(mockContract.transfer).not.toHaveBeenCalled();
      calculationSpy.mockRestore();
    });

    it('rejects a mined award with missing Transfer evidence without projecting it', async () => {
      installDurableOperationMock();
      const evidenceMock = require('./spendEvidence').verifySpendEvidence as jest.Mock;
      evidenceMock.mockResolvedValueOnce({
        valid: false,
        failure: { code: 'MISSING_TRANSFER_EVENT', message: 'missing Transfer log', pending: false },
      });

      const result = await processAwardFromCDR({ ...mockRawCDR, SessionID: 'sess-bad-evidence' }, mockSigner);

      expect(result).toMatchObject({ success: false, operationStatus: 'failed', requiresReview: true });
      expect(require('./database/service').TokenOperations.markFailed).toHaveBeenCalledTimes(1);
      expect(require('./database/integration').recordAward).not.toHaveBeenCalled();
    });

    it('retains the known award operation when saving a failed evidence state fails', async () => {
      installDurableOperationMock();
      const evidenceMock = require('./spendEvidence').verifySpendEvidence as jest.Mock;
      evidenceMock.mockResolvedValueOnce({
        valid: false,
        failure: { code: 'MISSING_TRANSFER_EVENT', message: 'missing Transfer log', pending: false },
      });
      const serviceMock = require('./database/service');
      serviceMock.TokenOperations.markFailed.mockRejectedValueOnce(new Error('database unavailable'));

      const result = await processAwardFromCDR({ ...mockRawCDR, SessionID: 'sess-mark-failed-outage' }, mockSigner);

      expect(result).toMatchObject({ success: false, pending: true, requiresReview: true, txHash: `0x${'a'.repeat(64)}` });
      expect(result.error).toContain('durable failure state could not be saved');
      expect(require('./database/integration').recordAward).not.toHaveBeenCalled();
    });

    it('returns saved award recovery state when the provider context is unavailable', async () => {
      const operations = installDurableOperationMock();
      const operationKey = awardOperationKey('prov-DE', 'sess-context-recovery');
      operations.set(operationKey, {
        operation_key: operationKey,
        status: 'submitted',
        amount: '10.00',
        tx_hash: `0x${'e'.repeat(64)}`,
        wallet_address: '0x1111111111111111111111111111111111111111',
        intent_context: {
          assetContext: {
            tokenContractAddress: '0x605871D30DC278a036F09e2ace771df8a224624B',
            chainId: '80002',
            treasuryAddress: '0x9999999999999999999999999999999999999999',
            signerAddress: '0x9999999999999999999999999999999999999999',
          },
        },
      });
      (mockSigner.provider as any).getNetwork.mockRejectedValueOnce(new Error('RPC unavailable'));

      const result = await processAwardFromCDR({ ...mockRawCDR, SessionID: 'sess-context-recovery' }, mockSigner);

      expect(result).toMatchObject({ success: false, pending: true, requiresReview: true, txHash: `0x${'e'.repeat(64)}` });
      expect(result.operationStatus).toBe('submitted');
      expect(mockContract.transfer).not.toHaveBeenCalled();
    });

    function savedIntentOperation(raw: Record<string, unknown>, amount: string, status: string, txHash: string | null) {
      const normalised = validateAndNormaliseCdr(raw);
      const walletAddress = '0x1111111111111111111111111111111111111111';
      return {
        operation_key: awardOperationKey(normalised.providerId, normalised.sessionId),
        operation_type: 'award',
        request_fingerprint: awardIntentFingerprint(normalised, Number(amount), walletAddress),
        uid: normalised.uid,
        status,
        amount,
        tx_hash: txHash,
        wallet_address: walletAddress,
        intent_context: {
          assetContext: {
            tokenContractAddress: '0x605871D30DC278a036F09e2ace771df8a224624B',
            chainId: '80002',
            treasuryAddress: '0x9999999999999999999999999999999999999999',
            signerAddress: '0x9999999999999999999999999999999999999999',
          },
        },
      };
    }

    it('rejects a changed eMAID before recovering a saved zero-award decision', async () => {
      const operations = installDurableOperationMock();
      const original = savedIntentOperation(mockRawCDR, '0.00', 'submitting', null);
      operations.set(original.operation_key, original);

      const result = await processAwardFromCDR({
        ...mockRawCDR,
        cdr_token: { contract_id: 'different-emaid' },
      }, mockSigner);

      expect(result).toMatchObject({ success: false, stage: 'validation' });
      expect(result.error).toContain('TOKEN_OPERATION_INTENT_MISMATCH');
      expect(mockContract.transfer).not.toHaveBeenCalled();
      expect(require('./database/service').TokenOperations.markProjected).not.toHaveBeenCalled();
    });

    it('rejects changed energy before recovering a saved zero-award decision', async () => {
      const operations = installDurableOperationMock();
      const original = savedIntentOperation(mockRawCDR, '0.00', 'submitting', null);
      operations.set(original.operation_key, original);

      const result = await processAwardFromCDR({
        ...mockRawCDR,
        'Consumed Energy': '41',
      }, mockSigner);

      expect(result).toMatchObject({ success: false, stage: 'validation' });
      expect(result.error).toContain('TOKEN_OPERATION_INTENT_MISMATCH');
      expect(mockContract.transfer).not.toHaveBeenCalled();
      expect(require('./database/service').TokenOperations.markProjected).not.toHaveBeenCalled();
    });

    it('does not report a projected award as success when asset context is unavailable', async () => {
      const operations = installDurableOperationMock();
      const original = savedIntentOperation(mockRawCDR, '10.00', 'projected', `0x${'9'.repeat(64)}`);
      operations.set(original.operation_key, original);
      (mockSigner.provider as any).getNetwork.mockRejectedValueOnce(new Error('RPC unavailable'));

      const result = await processAwardFromCDR(mockRawCDR, mockSigner);

      expect(result).toMatchObject({
        success: false,
        pending: true,
        requiresReview: true,
        txHash: `0x${'9'.repeat(64)}`,
      });
      expect(mockContract.transfer).not.toHaveBeenCalled();
    });

    it('rejects changed energy before unavailable-context recovery of a projected award', async () => {
      const operations = installDurableOperationMock();
      const original = savedIntentOperation(mockRawCDR, '10.00', 'projected', `0x${'8'.repeat(64)}`);
      operations.set(original.operation_key, original);
      (mockSigner.provider as any).getNetwork.mockRejectedValueOnce(new Error('RPC unavailable'));

      const result = await processAwardFromCDR({
        ...mockRawCDR,
        'Consumed Energy': '41',
      }, mockSigner);

      expect(result).toMatchObject({ success: false, stage: 'validation' });
      expect(result.error).toContain('TOKEN_OPERATION_INTENT_MISMATCH');
      expect(result.pending).not.toBe(true);
      expect(mockContract.transfer).not.toHaveBeenCalled();
    });
  });
});
