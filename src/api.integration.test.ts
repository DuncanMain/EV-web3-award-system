import http from 'http';
import { ethers } from 'ethers';
import { createSpendReceiptPayload, signSpendReceipt } from './receipt';
import { spendIntentFingerprint, spendOperationKey } from './database/tokenOperation';

let mockIndexModule: Record<string, jest.Mock> | undefined;

jest.mock('./index', () => {
  if (mockIndexModule) return mockIndexModule;
  mockIndexModule = {
    processAwardFromCDR: jest.fn().mockImplementation(async () => process.env.TEST_AWARD_RECOVERY === 'true'
      ? {
        success: true,
        dedupKey: 'cap-replay-session-cap-replay-provider',
        eligible: true,
        amount: 10,
        uid: 'contract-cap-replay',
        txHash: `0x${'9'.repeat(64)}`,
        operationStatus: 'projected',
        stage: 'complete',
      }
    : undefined),
    processSpend: jest.fn(),
  };
  return mockIndexModule;
});

let mockIntegrationModule: Record<string, jest.Mock> | undefined;

jest.mock('./database/integration', () => {
  if (mockIntegrationModule) return mockIntegrationModule;
  mockIntegrationModule = {
    approveUserForSpendingViaFunding: jest.fn(),
    moveFundsFromManagedWallet: jest.fn(),
    recordSpend: jest.fn().mockResolvedValue({ txHash: `0x${'1'.repeat(64)}` }),
    revokeAllowanceOnManagedWallet: jest.fn(),
  };
  return mockIntegrationModule;
});

const mockAuditLogs = {
  create: jest.fn().mockResolvedValue(undefined),
  getRecent: jest.fn().mockResolvedValue([
    {
      id: 'audit-1',
      event_type: 'spend.failed',
      actor_type: 'api_client',
      actor_id: 'contract-1',
      target_type: 'wallet',
      target_id: '0x0000000000000000000000000000000000000001',
      status: 'retry_required',
      metadata: { error: 'test' },
      created_at: new Date().toISOString(),
    },
  ]),
  getSince: jest.fn().mockResolvedValue([
    {
      id: 'audit-2',
      event_type: 'award.completed',
      actor_type: 'ingest_client',
      actor_id: 'provider-1',
      target_type: 'cdr',
      target_id: 'session-1',
      status: 'success',
      metadata: {},
      created_at: new Date().toISOString(),
    },
    {
      id: 'audit-3',
      event_type: 'spend.failed',
      actor_type: 'api_client',
      actor_id: 'contract-1',
      target_type: 'wallet',
      target_id: '0x0000000000000000000000000000000000000001',
      status: 'retry_required',
      metadata: {},
      created_at: new Date().toISOString(),
    },
    {
      id: 'audit-4',
      event_type: 'admin_alert.delivered',
      actor_type: 'system',
      actor_id: 'api',
      target_type: 'admin_email',
      target_id: 'admin@example.com',
      status: 'warning',
      metadata: {},
      created_at: new Date().toISOString(),
    },
  ]),
};

const linkedWallet = ethers.Wallet.createRandom();
const treasuryWallet = ethers.Wallet.createRandom();
const providerNetwork = { chainId: 80002n, name: 'matic-amoy' };
const mockProviderTransactions = new Map<string, ethers.TransactionResponse | null>();
const mockProviderReceipts = new Map<string, ethers.TransactionReceipt | null>();

function installTransferProof(
  txHash: string,
  amount: string,
  source = linkedWallet.address,
  recipient = treasuryWallet.address,
): void {
  const tokenContractAddress = ethers.getAddress(process.env.TOKEN_CONTRACT_ADDRESS!);
  const tokenInterface = new ethers.Interface(['function transfer(address to,uint256 amount)']);
  const transferInterface = new ethers.Interface(['event Transfer(address indexed from,address indexed to,uint256 value)']);
  const amountUnits = ethers.parseUnits(amount, 18);
  const data = tokenInterface.encodeFunctionData('transfer', [recipient, amountUnits]);
  const event = transferInterface.getEvent('Transfer');
  if (!event) throw new Error('Transfer event fragment missing');
  const encodedEvent = transferInterface.encodeEventLog(event, [source, recipient, amountUnits]);
  mockProviderTransactions.set(txHash.toLowerCase(), {
    hash: txHash,
    chainId: 80002n,
    from: source,
    to: tokenContractAddress,
    data,
    value: 0n,
  } as unknown as ethers.TransactionResponse);
  mockProviderReceipts.set(txHash.toLowerCase(), {
    hash: txHash,
    status: 1,
    from: source,
    to: tokenContractAddress,
    blockNumber: 123,
    logs: [{ address: tokenContractAddress, topics: encodedEvent.topics, data: encodedEvent.data, index: 0 }],
  } as unknown as ethers.TransactionReceipt);
}

jest.spyOn(ethers.JsonRpcProvider.prototype, 'getNetwork').mockResolvedValue(providerNetwork as ethers.Network);
jest.spyOn(ethers.JsonRpcProvider.prototype, 'getTransaction').mockImplementation(async (hash: string) => (
  mockProviderTransactions.get(hash.toLowerCase()) || null
));
jest.spyOn(ethers.JsonRpcProvider.prototype, 'getTransactionReceipt').mockImplementation(async (hash: string) => (
  mockProviderReceipts.get(hash.toLowerCase()) || null
));
jest.spyOn(ethers.JsonRpcProvider.prototype, 'call').mockResolvedValue(
  ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [0n]),
);

let mockServiceModule: Record<string, any> | undefined;

jest.mock('./database/service', () => {
  if (mockServiceModule) return mockServiceModule;
  mockServiceModule = {
    Awards: { exists: jest.fn(), findByUser: jest.fn().mockResolvedValue([]) },
    TokenOperations: {
      findByKey: jest.fn().mockImplementation(async () => process.env.TEST_AWARD_RECOVERY === 'true'
        ? {
          operation_key: 'award:stored-intent',
          status: 'confirmed',
          amount: '10.00',
          tx_hash: `0x${'9'.repeat(64)}`,
          wallet_address: '0x1111111111111111111111111111111111111111',
        }
        : undefined),
      claim: jest.fn(),
      markConfirmed: jest.fn(),
      markProjected: jest.fn(),
    },
    Spends: { findByTxHash: jest.fn(), findByUser: jest.fn().mockResolvedValue([]) },
    Users: {
      findByUid: jest.fn().mockResolvedValue(undefined),
      findByUidAndWallet: jest.fn().mockResolvedValue(undefined),
      findAllByWallet: jest.fn().mockResolvedValue([]),
      linkContractId: jest.fn(),
      linkLinkedWallet: jest.fn(),
      unlinkLinkedWallet: jest.fn(),
      updateWalletNameByAddress: jest.fn(),
      hasActivity: jest.fn().mockResolvedValue(false),
      deleteByUidAndWallet: jest.fn(),
    },
    Balances: {
      findByUser: jest.fn().mockResolvedValue(undefined),
    },
    LinkedWallets: {
      findByUid: jest.fn().mockResolvedValue([{ wallet_address: linkedWallet.address }]),
      add: jest.fn(),
      updateName: jest.fn(),
      remove: jest.fn(),
    },
    SpendReceipts: {
      create: jest.fn(),
      findByTxHash: jest.fn(),
    },
    SpendReservations: {
      findByIdForUid: jest.fn(),
      findBySession: jest.fn().mockResolvedValue(undefined),
      getActiveTotal: jest.fn().mockResolvedValue(0),
      reserve: jest.fn(),
      claimForSettlement: jest.fn().mockResolvedValue(undefined),
      complete: jest.fn(),
      retry: jest.fn(),
    },
    AuditLogs: mockAuditLogs,
    ReconciliationReports: {
      latest: jest.fn().mockResolvedValue(undefined),
      getRecent: jest.fn().mockResolvedValue([]),
    },
  };
  return mockServiceModule;
});

jest.mock('./database/connection', () => ({
  getDatabase: jest.fn(() => ({
    raw: jest.fn().mockResolvedValue([{ ok: 1 }]),
  })),
}));

jest.mock('./database/tokenOperationSchema', () => ({
  getTokenOperationSchemaStatus: jest.fn().mockResolvedValue({
    stagedReady: true,
    strictMigrationReady: true,
    validDuplicateGroups: 0,
    invalidLegacyRows: 0,
    missing: [],
  }),
}));

let mockPolicySnapshot: any;
let mockPolicyRepository: { load: jest.Mock; update: jest.Mock } | undefined;

jest.mock('./config/policyPersistence', () => {
  if (!mockPolicyRepository) {
    mockPolicyRepository = {
      load: jest.fn(),
      update: jest.fn(),
    };
  }
  return {
    createRewardPolicyRepository: jest.fn(() => mockPolicyRepository),
  };
});

function resetMockPolicy(): void {
  mockPolicySnapshot = {
    revision: 1,
    updatedAt: '2026-09-23T00:00:00.000Z',
    rules: {
      version: '1',
      rules: {
        offPeakCharging: {
          enabled: true,
          tokensPerKWh: 0.25,
          description: '1 SPARKZ per 4 kWh',
        },
        v2gDischarge: {
          enabled: true,
          tokensPerKWh: 1,
          description: '1 SPARKZ per 1 kWh',
        },
      },
      idempotency: {
        deduplicationKey: ['sessionId', 'providerId'],
        description: 'Prevent double-awarding using (sessionId, providerId) tuple',
      },
    },
    offPeakWindows: {
      DE: [{ start: '22:00', end: '06:00' }],
      ES: [{ start: '22:00', end: '06:00' }],
      RO: [{ start: '22:00', end: '06:00' }],
    },
  };
  mockPolicyRepository!.load.mockReset().mockImplementation(async () => mockPolicySnapshot);
  mockPolicyRepository!.update.mockReset().mockImplementation(async (update: unknown) => {
    const patch = typeof update === 'function' ? (update as (current: any) => any)(mockPolicySnapshot) : update as any;
    const nextRevision = mockPolicySnapshot.revision + 1;
    mockPolicySnapshot = {
      ...mockPolicySnapshot,
      revision: nextRevision,
      updatedAt: `2026-09-23T00:00:${String(nextRevision).padStart(2, '0')}.000Z`,
      rules: patch.rules ? { ...patch.rules, version: String(nextRevision) } : mockPolicySnapshot.rules,
      offPeakWindows: patch.offPeakWindows || mockPolicySnapshot.offPeakWindows,
    };
    return mockPolicySnapshot;
  });
}

describe('api integration contracts', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.API_KEY = 'test-api-key';
    process.env.BEIA_API_KEY = 'test-beia-api-key';
    process.env.INGEST_API_KEY = 'test-ingest-key';
    process.env.ADMIN_EMAIL = 'admin@example.com';
    process.env.ADMIN_PASSWORD = 'correct-password';
    process.env.BEIA_ADMIN_EMAIL = 'alex.dabija@redvector.ro';
    process.env.BEIA_ADMIN_PASSWORD = 'beia-password';
    process.env.ENABLE_TEST_UID_LOOKUP = 'false';
    process.env.TREASURY_SIGNER_KEY = treasuryWallet.privateKey;
    process.env.TREASURY_ADDRESS = treasuryWallet.address;
    process.env.TOKEN_CONTRACT_ADDRESS = ethers.Wallet.createRandom().address;
    process.env.CHAIN_ID = '80002';
    process.env.DATABASE_URL = 'postgres://test:test@localhost:5432/test';

    const api = await import('./api');
    server = api.app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Test server did not bind to a TCP port');
    }
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    });
  });

  beforeEach(() => {
    jest.clearAllMocks();
    resetMockPolicy();
    mockProviderTransactions.clear();
    mockProviderReceipts.clear();
    const mockedService = jest.requireMock('./database/service') as {
      Awards: { findByUser: jest.Mock };
      Users: { findByUid: jest.Mock; findByUidAndWallet: jest.Mock; findAllByWallet: jest.Mock };
      Balances: { findByUser: jest.Mock };
      LinkedWallets: { findByUid: jest.Mock };
      Spends: { findByTxHash: jest.Mock; findByUser: jest.Mock };
      SpendReceipts: { findByTxHash: jest.Mock; create: jest.Mock };
      TokenOperations: { findByKey: jest.Mock; claim: jest.Mock; markConfirmed: jest.Mock; markProjected: jest.Mock };
      SpendReservations: { findBySession: jest.Mock; claimForSettlement: jest.Mock; complete: jest.Mock };
    };
    mockedService.Awards.findByUser.mockReset().mockResolvedValue([]);
    mockedService.Spends.findByUser.mockReset().mockResolvedValue([]);
    mockedService.Users.findByUid.mockReset().mockResolvedValue(undefined);
    mockedService.Spends.findByTxHash.mockReset().mockResolvedValue(undefined);
    mockedService.Users.findByUidAndWallet.mockReset().mockResolvedValue(undefined);
    mockedService.Users.findAllByWallet.mockReset().mockResolvedValue([]);
    mockedService.Balances.findByUser.mockReset().mockResolvedValue(undefined);
    mockedService.LinkedWallets.findByUid.mockReset().mockResolvedValue([{ wallet_address: linkedWallet.address }]);
    mockedService.SpendReceipts.findByTxHash.mockReset().mockResolvedValue(undefined);
    mockedService.SpendReceipts.create.mockReset().mockResolvedValue(undefined);
    mockedService.SpendReservations.findBySession.mockReset().mockResolvedValue(undefined);
    mockedService.SpendReservations.claimForSettlement.mockReset().mockResolvedValue(undefined);
    mockedService.SpendReservations.complete.mockReset().mockResolvedValue(undefined);
    mockedService.TokenOperations.findByKey.mockReset().mockImplementation(async () => process.env.TEST_AWARD_RECOVERY === 'true'
      ? {
        operation_key: 'award:stored-intent',
        status: 'confirmed',
        amount: '10.00',
        tx_hash: `0x${'9'.repeat(64)}`,
        wallet_address: '0x1111111111111111111111111111111111111111',
      }
      : undefined);
    mockedService.TokenOperations.claim.mockReset();
    mockedService.TokenOperations.markConfirmed.mockReset().mockImplementation(async (key: string) => ({
      operation_key: key,
      status: 'confirmed',
      movement_outcome: 'confirmed',
    }));
    mockedService.TokenOperations.markProjected.mockReset();
    mockIndexModule!.processAwardFromCDR.mockReset().mockImplementation(async () => process.env.TEST_AWARD_RECOVERY === 'true'
      ? {
        success: true,
        dedupKey: 'cap-replay-session-cap-replay-provider',
        eligible: true,
        amount: 10,
        uid: 'contract-cap-replay',
        txHash: `0x${'9'.repeat(64)}`,
        operationStatus: 'projected',
        stage: 'complete',
      }
      : undefined);
    mockIndexModule!.processSpend.mockReset();
  });

  async function apiFetch(path: string, init: RequestInit = {}) {
    return fetch(`${baseUrl}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': 'test-api-key',
        ...(init.headers || {}),
      },
    });
  }

  it('returns safe errors for malformed JSON and unknown methods', async () => {
    const malformed = await apiFetch('/spend', {
      method: 'POST',
      body: '{"uid":',
    });
    expect(malformed.status).toBe(400);
    const malformedBody = await malformed.json();
    expect(malformedBody).toMatchObject({ status: 'error', code: 'INVALID_JSON' });
    expect(malformedBody.message).toBe('Request body must contain valid JSON');
    expect(JSON.stringify(malformedBody)).not.toMatch(/SyntaxError|Unexpected token|at\s+\w+\./i);

    const unknownMethod = await apiFetch('/ingest/health', { method: 'PUT' });
    expect(unknownMethod.status).toBe(404);
    const unknownBody = await unknownMethod.json();
    expect(unknownBody).toMatchObject({ status: 'error', code: 'ROUTE_NOT_FOUND' });
    expect(unknownBody.message).toBe('The requested API route was not found');
  });

  async function adminToken(): Promise<string> {
    const res = await apiFetch('/admin/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'admin@example.com', password: 'correct-password' }),
    });
    const body = await res.json();
    if (res.status !== 200) {
      throw new Error(JSON.stringify(body));
    }
    expect(res.status).toBe(200);
    return body.token;
  }

  it('documents the BEIA session spend flow in OpenAPI', async () => {
    const res = await fetch(`${baseUrl}/openapi.json`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.openapi).toBe('3.0.3');
    expect(body.info.version).toBe('1.1.0');
    expect(body.paths['/ingest/cdr']).toBeDefined();
    expect(body.paths['/ingest/cdr/preview']).toBeDefined();
    expect(body.paths['/spend/session']).toBeDefined();
    expect(body.paths['/spend/reservations/{reservationId}']).toBeDefined();
    expect(body.components.schemas.ReservationStatusResponse).toBeDefined();
    expect(body.components.schemas.SpendSessionRequest).toBeDefined();
    expect(body.components.schemas.SpendSessionResponse.properties.rewardRates).toBeDefined();
    const documentedError = body.paths['/spend/session'].post.responses['400'];
    expect(documentedError.description).toContain('specific cause');
    expect(documentedError.content['application/json'].examples.validationFailed.value.message)
      .toContain('amount');
    expect(documentedError.content['application/json'].examples.rewardNetworkUnavailable.value.error)
      .toContain('temporarily unavailable');
    expect(body.components.schemas.ErrorResponse.anyOf).toEqual([
      { required: ['message'] },
      { required: ['error'] },
    ]);
    expect(body.components.schemas.SpendMeRequest.required).toEqual(expect.arrayContaining([
      'amount',
      'sessionId',
      'providerId',
    ]));
    expect(body.components.schemas.SpendRequest.anyOf).toEqual([
      { required: ['idempotencyKey'] },
      { required: ['operationKey'] },
    ]);
    expect(body.components.schemas.SpendRequest.properties.idempotencyKey.minLength).toBe(1);
    expect(body.components.schemas.SpendRequest.properties.operationKey.minLength).toBe(1);
    expect(body.components.schemas.CdrRequest.oneOf).toEqual([
      { $ref: '#/components/schemas/NeverflatCdrRequest' },
      { $ref: '#/components/schemas/OcpiCdrRequest' },
    ]);
    expect(body.components.schemas.NeverflatCdrRequest.required).toEqual(expect.arrayContaining([
      'SessionID',
      'ProviderID',
      'cdr_token',
      'EVSEID',
      'StartTime',
      'EndTime',
      'Energy',
      'EnergyDirection',
    ]));
    expect(body.components.schemas.OcpiCdrRequest.required).toEqual(expect.arrayContaining([
      'id',
      'party_id',
      'cdr_token',
      'cdr_location',
      'start_date_time',
      'end_date_time',
      'total_energy',
    ]));
    expect(body.components.schemas.CdrNormalisationMetadata.required).toEqual([
      'eMAID', 'emaid', 'protocol', 'sourceField',
    ]);
    expect(body.components.securitySchemes.IngestApiKeyAuth.name).toBe('X-Ingest-API-Key');
    expect(body.paths['/ingest/cdr'].post.responses['400'].content['application/json']
      .examples.missingEvse.value).toMatchObject({
        code: 'INVALID_CDR',
        message: 'evseId is required',
      });
  });

  it('uses the forwarded HTTPS scheme in the published server URL', async () => {
    const res = await fetch(`${baseUrl}/openapi.json`, {
      headers: { 'x-forwarded-proto': 'https' },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.servers[0].url).toMatch(/^https:\/\//);
  });

  it('keeps every documented CDR example executable through the side-effect-free preview', async () => {
    const specRes = await fetch(`${baseUrl}/openapi.json`);
    const spec = await specRes.json();
    const examples = spec.paths['/ingest/cdr'].post.requestBody.content['application/json'].examples;

    expect(Object.keys(examples)).toEqual(['neverflat', 'ocpi']);
    for (const example of Object.values(examples) as Array<{ value: Record<string, unknown> }>) {
      const previewRes = await apiFetch('/ingest/cdr/preview', {
        method: 'POST',
        headers: { 'X-Ingest-API-Key': 'test-ingest-key' },
        body: JSON.stringify(example.value),
      });
      const preview = await previewRes.json();

      expect(previewRes.status).toBe(200);
      expect(preview.status).toBe('preview');
      expect(preview.sideEffects).toBe(false);
      expect(preview.normalised.evseId).toBe('DE*ABC*E*001');
    }
  });

  it('returns a specific 400 response when a CDR omits its EVSE identifier', async () => {
    const res = await apiFetch('/ingest/cdr', {
      method: 'POST',
      headers: { 'X-Ingest-API-Key': 'test-ingest-key' },
      body: JSON.stringify({
        SessionID: 'invalid-cdr-without-evse',
        ProviderID: 'nvf-demo',
        cdr_token: { contract_id: 'demo-user-001' },
        StartTime: '2026-09-14T05:00:00.000Z',
        EndTime: '2026-09-14T06:00:00.000Z',
        Energy: '12',
        EnergyDirection: 'CHARGE',
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toMatchObject({
      status: 'error',
      code: 'INVALID_CDR',
      message: 'evseId is required',
    });
  });

  it('accepts the dedicated BEIA API key', async () => {
    const res = await fetch(`${baseUrl}/wallet/me`, {
      headers: {
        'X-API-Key': 'test-beia-api-key',
        'x-contract-id': 'beia-user-1',
      },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).uid).toBe('beia-user-1');
  });

  it('accepts the dedicated BEIA API key for CDR ingestion', async () => {
    const res = await fetch(`${baseUrl}/ingest/cdr/preview`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Ingest-API-Key': 'test-beia-api-key',
      },
      body: JSON.stringify({
        SessionID: 'beia-test-session',
        ProviderID: 'BEIA',
        cdr_token: { contract_id: 'beia-test-user' },
        EVSEID: 'RO*BEIA*E*001',
        StartTime: '2026-08-10T10:00:00Z',
        EndTime: '2026-08-10T11:00:00Z',
        Energy: '10',
        EnergyDirection: 'CHARGE',
      }),
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      status: 'preview',
      sideEffects: false,
      uid: 'beia-test-user',
    });
  });

  it('accepts the dedicated BEIA admin login', async () => {
    const res = await fetch(`${baseUrl}/admin/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'alex.dabija@redvector.ro',
        password: 'beia-password',
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.adminEmail).toBe('alex.dabija@redvector.ro');
    expect(body.token).toBeTruthy();

    const previewRes = await fetch(`${baseUrl}/ingest/cdr/preview`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${body.token}`,
      },
      body: JSON.stringify({
        SessionID: 'admin-preview-session',
        ProviderID: 'nvf-admin',
        cdr_token: { contract_id: 'admin-preview-user' },
        EVSEID: 'DE*NVF*E*ADMIN01',
        StartTime: '2026-09-14T05:00:00.000Z',
        EndTime: '2026-09-14T06:00:00.000Z',
        Energy: '4',
        EnergyDirection: 'CHARGE',
      }),
    });

    expect(previewRes.status).toBe(200);
    expect(await previewRes.json()).toMatchObject({ status: 'preview', sideEffects: false });
  });

  it('returns a final reservation settlement only to its contract identity', async () => {
    const { SpendReservations, SpendReceipts } = await import('./database/service');
    const reservationId = '00000000-0000-4000-8000-000000000001';
    (SpendReservations.findByIdForUid as jest.Mock).mockResolvedValueOnce({
      id: reservationId,
      uid: 'contract-1',
      wallet_address: linkedWallet.address,
      session_id: 'session-1',
      provider_id: 'provider-1',
      reserved_amount: '5.00',
      settled_amount: '3.00',
      released_amount: '2.00',
      delivered_kwh: '3.000',
      status: 'settled',
      tx_hash: `0x${'2'.repeat(64)}`,
      updated_at: new Date('2026-07-21T12:00:00Z'),
    });
    (SpendReceipts.findByTxHash as jest.Mock).mockResolvedValueOnce(undefined);

    const res = await apiFetch(`/spend/reservations/${reservationId}`, {
      headers: { 'x-contract-id': 'contract-1' },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      status: 'settled',
      reservationId,
      reservedSparkz: '5.00',
      settledSparkz: '3.00',
      releasedSparkz: '2.00',
      freeKwh: '3.00',
    });
    expect(SpendReservations.findByIdForUid).toHaveBeenCalledWith(reservationId, 'contract-1');
  });

  it('routes /wallet/me through the contract identity endpoint', async () => {
    const identityRes = await apiFetch('/wallet/me', {
      headers: { 'x-contract-id': 'contract-123' },
    });
    const identityBody = await identityRes.json();

    expect(identityRes.status).toBe(200);
    expect(identityBody.uid).toBe('contract-123');

    const manualRes = await apiFetch('/wallet/contract-123');
    const manualBody = await manualRes.json();

    expect(manualRes.status).toBe(403);
    expect(manualBody.message).toContain('/wallet/me');
  });

  it('verifies the signed unlink route and delegates cleanup atomically', async () => {
    const { LinkedWallets, Users } = await import('./database/service');
    const uid = 'contract-signed-unlink';
    const checksumWalletAddress = ethers.getAddress(linkedWallet.address);
    const signature = await linkedWallet.signMessage([
      'NEVERFLAT unlink wallet address',
      `EMP contract: ${uid}`,
      `Wallet address: ${checksumWalletAddress}`,
    ].join('\n'));

    (Users.unlinkLinkedWallet as jest.Mock).mockResolvedValueOnce({
      removedLink: 1,
      deletedUser: 1,
    });
    (LinkedWallets.findByUid as jest.Mock).mockResolvedValueOnce([]);

    const res = await apiFetch(`/wallet/${uid}/linked-wallets/${checksumWalletAddress}`, {
      method: 'DELETE',
      body: JSON.stringify({ signature }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.message).toBe('Wallet address unlinked');
    expect(Users.unlinkLinkedWallet).toHaveBeenCalledWith(uid, checksumWalletAddress);
    expect(LinkedWallets.remove).not.toHaveBeenCalled();
    expect(Users.deleteByUidAndWallet).not.toHaveBeenCalled();
  });

  it('rejects an array wallet profile before writing wallet state', async () => {
    const { Users } = await import('./database/service');
    (Users.linkContractId as jest.Mock).mockClear();

    const res = await apiFetch('/wallet/contract-123/profile', {
      method: 'PATCH',
      body: JSON.stringify([]),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toMatchObject({
      status: 'error',
      code: 'INVALID_WALLET_PROFILE',
      message: 'Body must be an object with an optional walletName string',
    });
    expect(Users.linkContractId).not.toHaveBeenCalled();
  });

  it('keeps wallet read failures generic', async () => {
    const { Users } = await import('./database/service');
    (Users.findByUid as jest.Mock).mockRejectedValueOnce(
      new Error('select * from users failed: password=wallet-secret'),
    );

    const res = await apiFetch('/wallet/me', {
      headers: { 'x-contract-id': 'contract-wallet-read-failure' },
    });
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body).toMatchObject({
      status: 'error',
      code: 'WALLET_QUERY_UNAVAILABLE',
      message: 'The wallet could not be loaded right now. Please retry shortly.',
    });
    expect(JSON.stringify(body)).not.toContain('wallet-secret');
    expect(JSON.stringify(body)).not.toContain('users');
  });

  it('keeps wallet mutation failures generic', async () => {
    const { Users } = await import('./database/service');
    (Users.linkContractId as jest.Mock).mockRejectedValueOnce(
      new Error('insert into users failed: SQLSTATE 23505'),
    );

    const res = await apiFetch('/wallet/contract-wallet-write-failure/profile', {
      method: 'PATCH',
      body: JSON.stringify({ walletName: 'Matrix wallet' }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toMatchObject({
      status: 'error',
      message: 'The wallet request could not be completed. Please retry shortly.',
    });
    expect(JSON.stringify(body)).not.toContain('SQLSTATE');
    expect(JSON.stringify(body)).not.toContain('users');
  });

  it('shows the recorded balance when a live token read is unavailable', async () => {
    const { Awards, Balances, LinkedWallets, Spends, Users } = await import('./database/service');
    const registeredUser = {
      id: 'user-registered-balance',
      uid: 'registered-balance-user',
      wallet_address: linkedWallet.address,
      wallet_name: null,
    };
    (Users.findByUid as jest.Mock).mockResolvedValue(registeredUser);
    (Users.findAllByWallet as jest.Mock).mockResolvedValue([]);
    (LinkedWallets.findByUid as jest.Mock).mockResolvedValue([]);
    (Balances.findByUser as jest.Mock).mockResolvedValue({
      balance: '12.00',
      total_awarded: '12.00',
      total_spent: '0.00',
    });
    (Awards.findByUser as jest.Mock).mockResolvedValue([]);
    (Spends.findByUser as jest.Mock).mockResolvedValue([]);
    (ethers.JsonRpcProvider.prototype.call as unknown as jest.Mock)
      .mockRejectedValueOnce(new Error('missing revert data for balanceOf'));

    const res = await apiFetch('/wallet/me', {
      headers: { 'x-contract-id': 'registered-balance-user' },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      balance: '12.00',
      balanceStatus: 'unavailable',
      balanceSource: 'database',
      balanceWarning: expect.stringContaining('last recorded balance'),
      totalAwarded: '12.00',
      totalSpent: '0.00',
    });
  });

  it('verifies signed spend receipts over HTTP', async () => {
    const payload = createSpendReceiptPayload({
      contractId: 'contract-1',
      walletAddress: ethers.Wallet.createRandom().address,
      amount: 5,
      sessionId: 'session-1',
      providerId: 'provider-1',
      tokenTxHash: `0x${'1'.repeat(64)}`,
      tokenContractAddress: ethers.Wallet.createRandom().address,
      chainId: 80002,
    });
    const signed = await signSpendReceipt(payload, treasuryWallet);

    const res = await apiFetch('/spend-receipts/verify', {
      method: 'POST',
      body: JSON.stringify({
        payload: signed.payload,
        signature: signed.signature,
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      status: 'valid',
      valid: true,
      receiptId: payload.receiptId,
      signerAddress: treasuryWallet.address,
    });
  });

  it('rejects a self-signed receipt even when the attacker supplies its own signer address', async () => {
    const attacker = ethers.Wallet.createRandom();
    const payload = createSpendReceiptPayload({
      contractId: 'contract-1',
      walletAddress: linkedWallet.address,
      amount: 1,
      tokenTxHash: `0x${'3'.repeat(64)}`,
      tokenContractAddress: process.env.TOKEN_CONTRACT_ADDRESS!,
      chainId: 80002,
    });
    const signed = await signSpendReceipt(payload, attacker);

    const res = await apiFetch('/spend-receipts/verify', {
      method: 'POST',
      body: JSON.stringify({ payload: signed.payload, signature: signed.signature, signerAddress: attacker.address }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ status: 'invalid', valid: false, failure: { code: 'signer_mismatch' } });
  });

  it('exposes admin readiness checks', async () => {
    const token = await adminToken();
    const res = await apiFetch('/admin/readiness', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toMatch(/^ready/);
    expect(body.checks.some((check: { key: string }) => check.key === 'admin_email')).toBe(true);
    expect(body.checks.some((check: { key: string }) => check.key === 'database')).toBe(true);
    expect(body.checks.some((check: { key: string }) => check.key === 'reward_policy')).toBe(true);
  });

  it('protects the admin operations view and rejects legacy UID filters', async () => {
    const unauthenticated = await apiFetch('/admin/operations');
    expect(unauthenticated.status).toBe(401);

    const token = await adminToken();
    const invalid = await apiFetch('/admin/operations?uid=DE-TEST-EMAID', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await invalid.json();
    expect(invalid.status).toBe(400);
    expect(body).toMatchObject({ status: 'error', code: 'INVALID_OPERATIONS_QUERY' });
    expect(body.message).toContain('emaid');
  });

  it('keeps an admin operations database failure generic', async () => {
    const token = await adminToken();
    const res = await apiFetch('/admin/operations?scope=all', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json();
    expect(res.status).toBe(500);
    expect(body).toMatchObject({
      status: 'error',
      code: 'OPERATIONS_UNAVAILABLE',
      message: 'Transaction visibility is temporarily unavailable. Try again later.',
    });
    expect(body.message).not.toContain('token_operations');
  });

  it('requires admin bearer auth and accepts only the server-derived recovery key', async () => {
    const unauthenticated = await apiFetch('/admin/operations/recover', {
      method: 'POST',
      body: JSON.stringify({ operationKey: 'spend:example' }),
    });
    expect(unauthenticated.status).toBe(401);

    const token = await adminToken();
    const invalid = await apiFetch('/admin/operations/recover', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ operationKey: 'spend:example', amount: 1 }),
    });
    const body = await invalid.json();
    expect(invalid.status).toBe(400);
    expect(body).toMatchObject({ status: 'error', code: 'INVALID_RECOVERY_REQUEST' });
    expect(body.message).toContain('overrides are not accepted');
  });

  it('blocks hashless recovery before any chain or projection work and records the outcome', async () => {
    const { TokenOperations } = await import('./database/service');
    (TokenOperations.findByKey as jest.Mock).mockResolvedValueOnce({
      operation_key: 'spend:hashless',
      operation_type: 'spend',
      request_fingerprint: 'saved-fingerprint',
      uid: 'contract-1',
      wallet_address: linkedWallet.address,
      amount: '2.00',
      session_id: 'session-1',
      provider_id: 'provider-1',
      reservation_id: null,
      status: 'submitted',
      movement_outcome: 'unknown',
      tx_hash: null,
      intent_context: null,
    });
    const token = await adminToken();
    mockAuditLogs.create.mockClear();
    const res = await apiFetch('/admin/operations/recover', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ operationKey: 'spend:hashless' }),
    });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toMatchObject({
      status: 'blocked',
      code: 'CHAIN_HASH_REQUIRED',
      requiresReview: true,
      noReplacementTransfer: true,
    });
    expect(mockAuditLogs.create).toHaveBeenCalledTimes(2);
    expect(mockIntegrationModule!.recordSpend).not.toHaveBeenCalled();
  });

  it('fails closed when the request audit cannot be written', async () => {
    const { TokenOperations } = await import('./database/service');
    (TokenOperations.findByKey as jest.Mock).mockResolvedValueOnce({
      operation_key: 'spend:audit-failure',
      operation_type: 'spend',
      request_fingerprint: 'saved-fingerprint',
      uid: 'contract-1',
      wallet_address: linkedWallet.address,
      amount: '2.00',
      status: 'submitted',
      movement_outcome: 'unknown',
      tx_hash: null,
      intent_context: null,
    });
    const token = await adminToken();
    mockAuditLogs.create.mockRejectedValueOnce(new Error('audit database unavailable'));
    const res = await apiFetch('/admin/operations/recover', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ operationKey: 'spend:audit-failure' }),
    });
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body).toMatchObject({
      status: 'error',
      code: 'RECOVERY_AUDIT_UNAVAILABLE',
      noReplacementTransfer: true,
    });
    expect(body.message).not.toContain('audit database unavailable');
    expect(mockIntegrationModule!.recordSpend).not.toHaveBeenCalled();
  });

  it('reports a completed projection separately when the recovery outcome audit fails', async () => {
    const { TokenOperations } = await import('./database/service');
    const operation = {
      operation_key: 'award:already-projected',
      operation_type: 'award' as const,
      request_fingerprint: 'saved-fingerprint',
      uid: 'contract-1',
      wallet_address: linkedWallet.address,
      amount: '2.00',
      status: 'projected' as const,
      movement_outcome: 'confirmed' as const,
      tx_hash: `0x${'4'.repeat(64)}`,
      intent_context: null,
    };
    (TokenOperations.findByKey as jest.Mock).mockImplementation(async () => operation);
    const token = await adminToken();
    mockAuditLogs.create
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('outcome audit store unavailable'));

    const res = await apiFetch('/admin/operations/recover', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ operationKey: operation.operation_key }),
    });
    const body = await res.json();

    expect(res.status).toBe(503);
    expect(body).toMatchObject({
      status: 'error',
      code: 'RECOVERY_COMPLETED_AUDIT_UNAVAILABLE',
      recoveryStatus: 'completed_audit_pending',
      projectionStatus: 'projected',
      noReplacementTransfer: true,
    });
    expect(body.message).toContain('Recovery completed');
    expect(body.recoveryStatus).not.toBe('pending');
  });

  it('keeps a projected spend receipt retryable after projection while preserving the hash', async () => {
    const { SpendReceipts, TokenOperations } = await import('./database/service');
    const txHash = `0x${'5'.repeat(64)}`;
    const operation = {
      operation_key: 'spend:projected-receipt-missing',
      operation_type: 'spend' as const,
      request_fingerprint: spendIntentFingerprint({
        uid: 'contract-1',
        walletAddress: linkedWallet.address,
        amount: 2,
        sessionId: 'session-1',
        providerId: 'provider-1',
        reservationId: null,
      }),
      uid: 'contract-1',
      wallet_address: linkedWallet.address,
      amount: '2.00',
      session_id: 'session-1',
      provider_id: 'provider-1',
      reservation_id: null,
      status: 'projected' as const,
      movement_outcome: 'confirmed' as const,
      tx_hash: txHash,
      intent_context: {
        assetContext: {
          tokenContractAddress: process.env.TOKEN_CONTRACT_ADDRESS,
          chainId: '80002',
          treasuryAddress: treasuryWallet.address,
          signerAddress: treasuryWallet.address,
        },
      },
    };
    (TokenOperations.findByKey as jest.Mock).mockImplementation(async () => operation);
    installTransferProof(txHash, '2.00', linkedWallet.address, treasuryWallet.address);
    (SpendReceipts.create as jest.Mock).mockRejectedValueOnce(new Error('receipt store unavailable'));
    const token = await adminToken();

    const res = await apiFetch('/admin/operations/recover', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ operationKey: operation.operation_key }),
    });
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toMatchObject({
      status: 'pending',
      code: 'SPEND_RECEIPT_RECOVERY_PENDING',
      projectionStatus: 'projected',
      receiptStatus: 'pending',
      transactionHash: txHash,
      noReplacementTransfer: true,
    });
    expect(mockIntegrationModule!.recordSpend).not.toHaveBeenCalled();
  });

  it.each([
    ['cancelled reservation with delivered energy', { status: 'cancelled', delivered_kwh: '5.0', settled_amount: '2.00' }],
    ['settled reservation with a mismatched amount', { status: 'settled', delivered_kwh: '5.0', settled_amount: '1.00' }],
    ['settling reservation without delivered energy', { status: 'settling', delivered_kwh: null, settled_amount: null }],
    ['settling reservation whose hold is smaller than the saved spend', { status: 'settling', delivered_kwh: '5.0', settled_amount: null, reserved_amount: '1.00' }],
  ])('blocks unsafe reservation recovery: %s', async (_label, reservationState) => {
    const { SpendReservations, TokenOperations } = await import('./database/service');
    const txHash = `0x${'6'.repeat(64)}`;
    const operationKey = `spend:reservation-${String(_label).replace(/\W+/g, '-')}`;
    const operation = {
      operation_key: operationKey,
      operation_type: 'spend' as const,
      request_fingerprint: spendIntentFingerprint({
        uid: 'contract-1',
        walletAddress: linkedWallet.address,
        amount: 2,
        sessionId: 'session-1',
        providerId: 'provider-1',
        reservationId: 'reservation-1',
      }),
      uid: 'contract-1',
      wallet_address: linkedWallet.address,
      amount: '2.00',
      session_id: 'session-1',
      provider_id: 'provider-1',
      reservation_id: 'reservation-1',
      status: 'submitted' as const,
      movement_outcome: 'unknown' as const,
      tx_hash: txHash,
      intent_context: null,
    };
    (TokenOperations.findByKey as jest.Mock).mockImplementation(async () => operation);
    (SpendReservations.findByIdForUid as jest.Mock).mockResolvedValueOnce({
      id: 'reservation-1',
      uid: 'contract-1',
      wallet_address: linkedWallet.address,
      session_id: 'session-1',
      provider_id: 'provider-1',
      tx_hash: txHash,
      ...reservationState,
    });
    const token = await adminToken();

    const res = await apiFetch('/admin/operations/recover', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ operationKey }),
    });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toMatchObject({
      status: 'blocked',
      code: 'RESERVATION_RECOVERY_BLOCKED',
      requiresReview: true,
      noReplacementTransfer: true,
    });
    expect(SpendReservations.complete).not.toHaveBeenCalled();
  });

  it('does not accept a conflicting reservation row returned by completion', async () => {
    const { SpendReservations, TokenOperations } = await import('./database/service');
    const txHash = `0x${'7'.repeat(64)}`;
    const operationKey = 'spend:reservation-completion-conflict';
    const operation = {
      operation_key: operationKey,
      operation_type: 'spend' as const,
      request_fingerprint: spendIntentFingerprint({
        uid: 'contract-1',
        walletAddress: linkedWallet.address,
        amount: 2,
        sessionId: 'session-1',
        providerId: 'provider-1',
        reservationId: 'reservation-1',
      }),
      uid: 'contract-1',
      wallet_address: linkedWallet.address,
      amount: '2.00',
      session_id: 'session-1',
      provider_id: 'provider-1',
      reservation_id: 'reservation-1',
      status: 'submitted' as const,
      movement_outcome: 'unknown' as const,
      tx_hash: txHash,
      intent_context: {
        assetContext: {
          tokenContractAddress: process.env.TOKEN_CONTRACT_ADDRESS,
          chainId: '80002',
          treasuryAddress: treasuryWallet.address,
          signerAddress: treasuryWallet.address,
        },
      },
    };
    const reservation = {
      id: 'reservation-1',
      uid: 'contract-1',
      wallet_address: linkedWallet.address,
      session_id: 'session-1',
      provider_id: 'provider-1',
      reserved_amount: '3.00',
      settled_amount: null,
      delivered_kwh: '5.0',
      status: 'settling',
      tx_hash: txHash,
    };
    (TokenOperations.findByKey as jest.Mock).mockImplementation(async () => operation);
    (SpendReservations.findByIdForUid as jest.Mock).mockResolvedValueOnce(reservation);
    (SpendReservations.complete as jest.Mock).mockResolvedValueOnce({
      ...reservation,
      status: 'settled',
      settled_amount: '1.00',
      tx_hash: `0x${'8'.repeat(64)}`,
    });
    installTransferProof(txHash, '2.00', linkedWallet.address, treasuryWallet.address);
    const token = await adminToken();

    const res = await apiFetch('/admin/operations/recover', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify({ operationKey }),
    });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toMatchObject({
      status: 'blocked',
      code: 'RESERVATION_RECOVERY_BLOCKED',
      projectionStatus: 'projected',
      requiresReview: true,
      noReplacementTransfer: true,
    });
    expect(SpendReservations.complete).toHaveBeenCalledWith(
      reservation.id,
      5,
      2,
      txHash,
    );
  });

  it('does not treat legacy ADMIN_USERNAME as the registered admin email', async () => {
    const previousEmail = process.env.ADMIN_EMAIL;
    const previousUsername = process.env.ADMIN_USERNAME;
    const previousBeiaEmail = process.env.BEIA_ADMIN_EMAIL;
    const previousBeiaPassword = process.env.BEIA_ADMIN_PASSWORD;
    process.env.ADMIN_EMAIL = '';
    process.env.ADMIN_USERNAME = 'legacy-admin';
    process.env.BEIA_ADMIN_EMAIL = '';
    process.env.BEIA_ADMIN_PASSWORD = '';

    jest.resetModules();
    const isolated = await import('./api');
    const legacyServer = isolated.app.listen(0);
    await new Promise<void>((resolve) => legacyServer.once('listening', resolve));
    const address = legacyServer.address();
    if (!address || typeof address === 'string') {
      throw new Error('Legacy test server did not bind to a TCP port');
    }

    try {
      const res = await fetch(`http://127.0.0.1:${address.port}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': 'test-api-key' },
        body: JSON.stringify({ email: 'legacy-admin', password: 'correct-password' }),
      });
      const body = await res.json();
      expect(res.status).toBe(503);
      expect(body.message).toContain('ADMIN_EMAIL');
    } finally {
      await new Promise<void>((resolve, reject) => {
        legacyServer.close((err) => err ? reject(err) : resolve());
      });
      if (previousEmail === undefined) {
        delete process.env.ADMIN_EMAIL;
      } else {
        process.env.ADMIN_EMAIL = previousEmail;
      }
      if (previousUsername === undefined) {
        delete process.env.ADMIN_USERNAME;
      } else {
        process.env.ADMIN_USERNAME = previousUsername;
      }
      if (previousBeiaEmail === undefined) {
        delete process.env.BEIA_ADMIN_EMAIL;
      } else {
        process.env.BEIA_ADMIN_EMAIL = previousBeiaEmail;
      }
      if (previousBeiaPassword === undefined) {
        delete process.env.BEIA_ADMIN_PASSWORD;
      } else {
        process.env.BEIA_ADMIN_PASSWORD = previousBeiaPassword;
      }
      jest.resetModules();
    }
  });

  it('filters audit events for admin users', async () => {
    const token = await adminToken();
    mockAuditLogs.getRecent.mockResolvedValueOnce([{
      id: 'audit-secret',
      event_type: 'spend.failed',
      actor_type: 'api_client',
      actor_id: 'contract-1',
      target_type: 'wallet',
      target_id: linkedWallet.address,
      status: 'retry_required',
      metadata: {
        error: 'https://rpc.example.test/private?token=raw-secret-must-not-cross-api',
        txHash: `0x${'a'.repeat(64)}`,
      },
      created_at: new Date().toISOString(),
    }]);
    const res = await apiFetch('/admin/audit?status=retry_required&limit=10', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.count).toBe(1);
    expect(body.events[0].presentation).toMatchObject({ category: 'operational' });
    expect(body.events[0]).not.toHaveProperty('metadata');
    expect(JSON.stringify(body)).not.toContain('raw-secret-must-not-cross-api');
    expect(JSON.stringify(body)).not.toContain('rpc.example.test');
    expect(body.events[0]).toEqual(expect.objectContaining({
      id: 'audit-secret',
      event_type: 'spend.failed',
      actor_type: 'api_client',
      actor_id: 'contract-1',
      target_type: 'wallet',
      target_id: linkedWallet.address,
      status: 'retry_required',
      presentation: expect.any(Object),
    }));
    expect(mockAuditLogs.getRecent).toHaveBeenCalledWith(10, {
      status: 'retry_required',
      eventType: undefined,
    });
  });

  it('returns a safe audit-specific error when audit storage fails', async () => {
    const token = await adminToken();
    mockAuditLogs.getRecent.mockRejectedValueOnce(
      new Error('password authentication failed for user audit_reader; secret=do-not-return'),
    );
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const res = await apiFetch('/admin/audit?status=error&limit=10', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body).toMatchObject({
        status: 'error',
        code: 'AUDIT_LOG_UNAVAILABLE',
        retryable: true,
        message: 'The audit log could not be loaded. Please retry shortly.',
        error: 'The audit log could not be loaded. Please retry shortly.',
      });
      expect(JSON.stringify(body)).not.toContain('reward');
      expect(JSON.stringify(body)).not.toContain('do-not-return');
      expect(consoleError.mock.calls.flat().join(' ')).not.toContain('do-not-return');
    } finally {
      consoleError.mockRestore();
    }

    const unauthenticated = await apiFetch('/admin/audit', {
      headers: { Authorization: '' },
    });
    expect(unauthenticated.status).toBe(401);
    expect(mockAuditLogs.getRecent).toHaveBeenCalledTimes(1);
  });

  it('summarises pilot metrics for admin users', async () => {
    const token = await adminToken();
    const res = await apiFetch('/admin/pilot-metrics?hours=24', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.metrics).toMatchObject({
      windowHours: 24,
      totalEvents: 3,
      awards: {
        completed: 1,
      },
      spends: {
        retryRequired: 1,
      },
      operations: {
        warnings: 1,
        retryRequired: 1,
        deliveredAlerts: 1,
      },
    });
    expect(mockAuditLogs.getSince).toHaveBeenCalled();
  });

  it('returns session spend prompt state without spending tokens', async () => {
    const res = await apiFetch('/spend/session', {
      method: 'POST',
      headers: { 'x-contract-id': 'contract-session-1' },
      body: JSON.stringify({
        sessionId: 'session-1',
        providerId: 'NF',
        chargerId: 'charger-001',
        status: 'PLUGGED_IN',
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      status: 'success',
      contractId: 'contract-session-1',
      sessionId: 'session-1',
      providerId: 'NF',
      chargerId: 'charger-001',
      sessionStatus: 'PLUGGED_IN',
      wallet: {
        availableBalance: 0,
        totalEarned: 0,
        totalSpent: 0,
        mode: 'managed',
      },
      spend: {
        eligible: false,
        maxSpendable: 0,
        suggestedAmount: 0,
        label: 'Charging discount',
      },
    });
    expect(body.spend.message).toContain('No SPARKZ');
    expect(body.rewardRates).toEqual(expect.arrayContaining([
      expect.objectContaining({
        key: 'offPeakCharging',
        label: 'Off-peak charging',
        enabled: true,
        tokensPerKWh: 0.25,
        kWhPerSparkz: 4,
      }),
      expect.objectContaining({
        key: 'v2gDischarge',
        label: 'V2G discharge',
        enabled: true,
        tokensPerKWh: 1,
        kWhPerSparkz: 1,
      }),
    ]));
  });

  it('rejects a new manual spend without a stable idempotency key before wallet or ledger lookup', async () => {
    const mockedService = jest.requireMock('./database/service') as {
      TokenOperations: { findByKey: jest.Mock };
    };

    const res = await apiFetch('/spend', {
      method: 'POST',
      body: JSON.stringify({ uid: 'contract-1', amount: 1 }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toMatchObject({
      status: 'error',
      code: 'IDEMPOTENCY_KEY_REQUIRED',
    });
    expect(mockedService.TokenOperations.findByKey).not.toHaveBeenCalled();
    expect(mockIndexModule!.processSpend).not.toHaveBeenCalled();
  });

  it.each([
    { idempotencyKey: '   ' },
    { idempotencyKey: 42 },
    { operationKey: '   ' },
    { operationKey: 42 },
  ])('rejects malformed manual spend keys before wallet or ledger lookup: %j', async keyFields => {
    const mockedService = jest.requireMock('./database/service') as {
      TokenOperations: { findByKey: jest.Mock };
    };

    const res = await apiFetch('/spend', {
      method: 'POST',
      body: JSON.stringify({ uid: 'contract-1', amount: 1, ...keyFields }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toMatchObject({ status: 'error', code: 'INVALID_OPERATION_KEY' });
    expect(mockedService.TokenOperations.findByKey).not.toHaveBeenCalled();
    expect(mockIndexModule!.processSpend).not.toHaveBeenCalled();
  });

  it('accepts a stable idempotency key to recover its existing manual operation', async () => {
    const idempotencyKey = 'manual-retry-key';
    const operationKey = spendOperationKey('contract-1', idempotencyKey);
    const hash = `0x${'7'.repeat(64)}`;
    const mockedService = jest.requireMock('./database/service') as {
      TokenOperations: { findByKey: jest.Mock };
      SpendReceipts: { create: jest.Mock };
    };
    mockedService.TokenOperations.findByKey.mockResolvedValue({
      operation_key: operationKey,
      operation_type: 'spend',
      status: 'pending',
      uid: 'contract-1',
      amount: '2.50',
      wallet_address: linkedWallet.address,
      session_id: 'manual-idempotency-session',
      provider_id: 'manual-idempotency-provider',
    });
    mockIndexModule!.processSpend.mockResolvedValue({
      success: true,
      amount: 2.5,
      txHash: hash,
      operationKey,
      operationStatus: 'confirmed',
      movementOutcome: 'confirmed',
    });

    const res = await apiFetch('/spend', {
      method: 'POST',
      body: JSON.stringify({
        uid: 'contract-1',
        amount: 2.5,
        idempotencyKey,
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({ status: 'success', operationKey, movementOutcome: 'confirmed' });
    expect(mockIndexModule!.processSpend).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey, operationKey, amount: 2.5 }),
      expect.anything(),
    );
    expect(mockedService.SpendReceipts.create).toHaveBeenCalledTimes(1);
  });

  it('shows the durable reward rate in the session prompt after a policy update', async () => {
    mockPolicySnapshot.revision = 8;
    mockPolicySnapshot.updatedAt = '2026-09-23T08:00:00.000Z';
    mockPolicySnapshot.rules = {
      ...mockPolicySnapshot.rules,
      version: '8',
      rules: {
        ...mockPolicySnapshot.rules.rules,
        offPeakCharging: {
          ...mockPolicySnapshot.rules.rules.offPeakCharging,
          tokensPerKWh: 0.5,
        },
      },
    };

    const res = await apiFetch('/spend/session', {
      method: 'POST',
      headers: { 'x-contract-id': 'contract-session-policy' },
      body: JSON.stringify({
        sessionId: 'session-policy',
        providerId: 'NF',
        chargerId: 'charger-policy',
        status: 'PLUGGED_IN',
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.policy).toEqual({ revision: 8, updatedAt: '2026-09-23T08:00:00.000Z' });
    expect(body.rewardRates).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'offPeakCharging', tokensPerKWh: 0.5, kWhPerSparkz: 2 }),
    ]));
  });

  it('rejects invalid session spend prompt payloads', async () => {
    const res = await apiFetch('/spend/session', {
      method: 'POST',
      headers: { 'x-contract-id': 'contract-session-1' },
      body: JSON.stringify({
        sessionId: 'session-1',
        providerId: 'NF',
        chargerId: 'charger-001',
        status: 'ENDED',
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toMatchObject({
      status: 'error',
      code: 'INVALID_SESSION_STATUS',
    });
  });

  it('returns explicit validation codes for spend identity requests', async () => {
    const missingSession = await apiFetch('/spend/me', {
      method: 'POST',
      headers: { 'x-contract-id': 'contract-1' },
      body: JSON.stringify({
        providerId: 'NF',
        amount: 1,
      }),
    });
    expect(missingSession.status).toBe(400);
    await expect(missingSession.json()).resolves.toMatchObject({ code: 'MISSING_SESSION_ID' });

    const missingProvider = await apiFetch('/spend/me', {
      method: 'POST',
      headers: { 'x-contract-id': 'contract-1' },
      body: JSON.stringify({
        sessionId: 'session-1',
        amount: 1,
      }),
    });
    expect(missingProvider.status).toBe(400);
    await expect(missingProvider.json()).resolves.toMatchObject({ code: 'MISSING_PROVIDER_ID' });

    const invalidAmount = await apiFetch('/spend/me', {
      method: 'POST',
      headers: { 'x-contract-id': 'contract-1' },
      body: JSON.stringify({
        sessionId: 'session-1',
        providerId: 'NF',
        amount: 0,
      }),
    });
    expect(invalidAmount.status).toBe(400);
    await expect(invalidAmount.json()).resolves.toMatchObject({ code: 'INVALID_AMOUNT' });

    const overCap = await apiFetch('/spend/me', {
      method: 'POST',
      headers: { 'x-contract-id': 'contract-1' },
      body: JSON.stringify({
        sessionId: 'session-over-cap',
        providerId: 'NF',
        amount: 200.01,
      }),
    });
    expect(overCap.status).toBe(400);
    await expect(overCap.json()).resolves.toMatchObject({
      code: 'TOKEN_AMOUNT_CAP_EXCEEDED',
      operation: 'spend',
      requestedAmount: 200.01,
      maximumAmount: 200,
    });
  });

  it('builds a retryable custodial spend intent', async () => {
    const res = await apiFetch('/spend/custodial-intent', {
      method: 'POST',
      body: JSON.stringify({
        uid: 'contract-1',
        walletAddress: linkedWallet.address,
        amount: 2.5,
        sessionId: 'session-1',
        providerId: 'provider-1',
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe('requires_signature');
    expect(body.spendIntent).toMatchObject({
      contractId: 'contract-1',
      walletAddress: linkedWallet.address,
      amount: '2.50',
      retryable: true,
    });
    expect(body.spendIntent.transaction.to).toBe(process.env.TOKEN_CONTRACT_ADDRESS);
    expect(body.spendIntent.transaction.from).toBe(linkedWallet.address);
  });

  it('keeps custodial wallet lookup failures generic', async () => {
    const { LinkedWallets } = await import('./database/service');
    (LinkedWallets.findByUid as jest.Mock).mockRejectedValueOnce(
      new Error('relation linked_wallets does not exist; password=custodial-secret'),
    );

    const res = await apiFetch('/spend/custodial-intent', {
      method: 'POST',
      body: JSON.stringify({
        uid: 'contract-custodial-failure',
        walletAddress: linkedWallet.address,
        amount: 1,
        sessionId: 'custodial-db-failure-session',
        providerId: 'provider-proof',
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toMatchObject({
      status: 'error',
      message: 'The custodial spend request could not be completed. Please retry shortly.',
    });
    expect(JSON.stringify(body)).not.toContain('linked_wallets');
    expect(JSON.stringify(body)).not.toContain('custodial-secret');
  });

  it('keeps custodial failure reporting neutral about whether a transaction exists', async () => {
    const res = await apiFetch('/spend/custodial-failure', {
      method: 'POST',
      body: JSON.stringify({
        uid: 'contract-1',
        walletAddress: linkedWallet.address,
        amount: 2.5,
        sessionId: 'custodial-failure-session',
        providerId: 'provider-proof',
        reason: 'wallet response was interrupted',
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.status).toBe('retry_required');
    expect(body.message).toContain('outcome is not final');
    expect(body.message).toContain('transaction hash');
    expect(body.message).not.toContain('was not completed');
  });

  it('rejects pending or wrong custodial chain evidence before projecting a spend', async () => {
    const hash = `0x${'4'.repeat(64)}`;
    installTransferProof(hash, '2.50');
    mockProviderReceipts.set(hash, null);

    const pending = await apiFetch('/spend/custodial-record', {
      method: 'POST',
      body: JSON.stringify({
        uid: 'contract-1',
        walletAddress: linkedWallet.address,
        amount: 2.5,
        txHash: hash,
        sessionId: 'session-proof-pending',
        providerId: 'provider-proof',
      }),
    });
    const pendingBody = await pending.json();
    expect(pending.status).toBe(202);
    expect(pendingBody).toMatchObject({
      status: 'pending',
      code: 'SPEND_EVIDENCE_INVALID',
      proofFailure: 'RECEIPT_PENDING',
      retryable: true,
      financialStatus: 'unconfirmed',
    });

    const wrongHash = `0x${'5'.repeat(64)}`;
    installTransferProof(wrongHash, '2.50');
    const wrongToken = process.env.TOKEN_CONTRACT_ADDRESS!;
    const transaction = mockProviderTransactions.get(wrongHash) as unknown as Record<string, unknown>;
    transaction.to = ethers.Wallet.createRandom().address;
    mockProviderTransactions.set(wrongHash, transaction as unknown as ethers.TransactionResponse);
    const invalid = await apiFetch('/spend/custodial-record', {
      method: 'POST',
      body: JSON.stringify({
        uid: 'contract-1',
        walletAddress: linkedWallet.address,
        amount: 2.5,
        txHash: wrongHash,
        sessionId: 'session-proof-wrong-token',
        providerId: 'provider-proof',
      }),
    });
    const invalidBody = await invalid.json();
    expect(invalid.status).toBe(400);
    expect(invalidBody).toMatchObject({
      status: 'error',
      code: 'SPEND_EVIDENCE_INVALID',
      proofFailure: 'WRONG_TOKEN_CONTRACT',
      retryable: false,
    });
    expect(wrongToken).toBe(process.env.TOKEN_CONTRACT_ADDRESS);
  });

  it('retries an absent custodial receipt before projecting the confirmed transfer', async () => {
    const hash = `0x${'6'.repeat(64)}`;
    installTransferProof(hash, '2.50');
    const { Spends, SpendReceipts } = await import('./database/service');
    const integration = await import('./database/integration');
    (Spends.findByTxHash as jest.Mock).mockResolvedValue(undefined);
    (SpendReceipts.findByTxHash as jest.Mock).mockResolvedValue(undefined);
    (SpendReceipts.create as jest.Mock).mockRejectedValueOnce(new Error('temporary receipt database outage'));

    const request = {
      uid: 'contract-1',
      walletAddress: linkedWallet.address,
      amount: 2.5,
      txHash: hash,
      sessionId: 'session-proof-retry',
      providerId: 'provider-proof',
    };
    const first = await apiFetch('/spend/custodial-record', { method: 'POST', body: JSON.stringify(request) });
    const firstBody = await first.json();
    expect(first.status).toBe(202);
    expect(firstBody).toMatchObject({ status: 'pending', receiptStatus: 'pending', retryable: true });
    expect(integration.recordSpend).not.toHaveBeenCalled();

    const second = await apiFetch('/spend/custodial-record', { method: 'POST', body: JSON.stringify(request) });
    const secondBody = await second.json();

    expect(second.status).toBe(200);
    expect(secondBody).toMatchObject({ status: 'success', txHash: hash.toLowerCase() });
    expect(secondBody.spendReceipt.payload.amount).toBe('2.50');
    expect((integration.recordSpend as jest.Mock).mock.calls).toHaveLength(1);
    expect(SpendReceipts.create).toHaveBeenCalledTimes(2);
  });

  it('recovers a receipt-backed custodial projection without a second transfer', async () => {
    const hash = `0x${'a'.repeat(64)}`;
    installTransferProof(hash, '2.50');
    const { Spends, SpendReceipts } = await import('./database/service');
    const integration = await import('./database/integration');
    (Spends.findByTxHash as jest.Mock).mockResolvedValue(undefined);
    (SpendReceipts.findByTxHash as jest.Mock).mockResolvedValue(undefined);
    let persistedRecord: Record<string, unknown> | undefined;
    (SpendReceipts.create as jest.Mock).mockImplementationOnce(async (data: Record<string, unknown>) => {
      persistedRecord = {
        id: 'receipt-projection-retry',
        uid: data.uid,
        wallet_address: data.walletAddress,
        amount: data.amount,
        session_id: data.sessionId,
        provider_id: data.providerId,
        token_tx_hash: data.tokenTxHash,
        token_contract_address: data.tokenContractAddress,
        chain_id: data.chainId,
        signer_address: data.signerAddress,
        canonical_payload: data.canonicalPayload,
        signature: data.signature,
      };
    });
    let successfulProjectionCount = 0;
    (integration.recordSpend as jest.Mock).mockImplementationOnce(async () => {
      throw new Error('temporary projection database outage');
    }).mockImplementationOnce(async () => {
      successfulProjectionCount += 1;
      return { txHash: hash };
    });

    const request = {
      uid: 'contract-1',
      walletAddress: linkedWallet.address,
      amount: 2.5,
      txHash: hash,
      sessionId: 'session-projection-retry',
      providerId: 'provider-proof',
    };
    const first = await apiFetch('/spend/custodial-record', { method: 'POST', body: JSON.stringify(request) });
    const firstBody = await first.json();
    expect(first.status).toBe(202);
    expect(firstBody).toMatchObject({
      status: 'pending',
      projectionStatus: 'pending',
      receiptStatus: 'settled',
      retryable: true,
    });
    expect(firstBody.spendReceipt.payload.receiptId).toBeTruthy();
    expect(persistedRecord).toBeDefined();

    (SpendReceipts.findByTxHash as jest.Mock).mockResolvedValue(persistedRecord);
    const second = await apiFetch('/spend/custodial-record', { method: 'POST', body: JSON.stringify(request) });
    const secondBody = await second.json();

    expect(second.status).toBe(200);
    expect(secondBody).toMatchObject({
      status: 'success',
      duplicate: true,
      recoveredProjection: true,
      txHash: hash.toLowerCase(),
    });
    expect(secondBody.spendReceipt.payload.receiptId).toBe(firstBody.spendReceipt.payload.receiptId);
    expect(secondBody.spendReceipt.canonicalPayload).toBe(firstBody.spendReceipt.canonicalPayload);
    expect(successfulProjectionCount).toBe(1);
    expect(SpendReceipts.create).toHaveBeenCalledTimes(1);
  });

  it('rejects a custodial hash replay with a changed receipt owner context', async () => {
    const hash = `0x${'7'.repeat(64)}`;
    installTransferProof(hash, '2.50');
    const { Spends, SpendReceipts, Users } = await import('./database/service');
    const wrongPayload = createSpendReceiptPayload({
      contractId: 'different-contract',
      walletAddress: linkedWallet.address,
      amount: 2.5,
      sessionId: 'session-proof-mismatch',
      providerId: 'provider-proof',
      tokenTxHash: hash,
      tokenContractAddress: process.env.TOKEN_CONTRACT_ADDRESS!,
      chainId: 80002,
    });
    const wrongSigned = await signSpendReceipt(wrongPayload, treasuryWallet);
    (Spends.findByTxHash as jest.Mock).mockResolvedValue({
      user_id: 'user-contract-1',
      wallet_address: linkedWallet.address,
      amount: '2.50',
      session_id: 'session-proof-mismatch',
    });
    (Users.findByUidAndWallet as jest.Mock).mockResolvedValue({
      id: 'user-contract-1', uid: 'contract-1', wallet_address: linkedWallet.address,
    });
    (SpendReceipts.findByTxHash as jest.Mock).mockResolvedValue({
      id: 'receipt-mismatch',
      uid: wrongPayload.contractId,
      wallet_address: wrongPayload.walletAddress,
      amount: wrongPayload.amount,
      session_id: wrongPayload.sessionId,
      provider_id: wrongPayload.providerId,
      token_tx_hash: hash,
      token_contract_address: wrongPayload.tokenContractAddress,
      chain_id: 80002,
      signer_address: treasuryWallet.address,
      canonical_payload: wrongSigned.canonicalPayload,
      signature: wrongSigned.signature,
    });

    const res = await apiFetch('/spend/custodial-record', {
      method: 'POST',
      body: JSON.stringify({
        uid: 'contract-1',
        walletAddress: linkedWallet.address,
        amount: 2.5,
        txHash: hash,
        sessionId: 'session-proof-mismatch',
        providerId: 'provider-proof',
      }),
    });
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body).toMatchObject({
      status: 'error',
      code: 'CUSTODIAL_RECEIPT_CONTEXT_MISMATCH',
      requiresReview: true,
      retryable: false,
    });
  });

  it('rejects a custodial hash replay with a changed provider context', async () => {
    const hash = `0x${'b'.repeat(64)}`;
    installTransferProof(hash, '2.50');
    const { Spends, SpendReceipts, Users } = await import('./database/service');
    const mismatchedPayload = createSpendReceiptPayload({
      contractId: 'contract-1',
      walletAddress: linkedWallet.address,
      amount: 2.5,
      sessionId: 'session-provider-mismatch',
      providerId: 'different-provider',
      tokenTxHash: hash,
      tokenContractAddress: process.env.TOKEN_CONTRACT_ADDRESS!,
      chainId: 80002,
    });
    const signed = await signSpendReceipt(mismatchedPayload, treasuryWallet);
    (Spends.findByTxHash as jest.Mock).mockResolvedValue({
      user_id: 'user-contract-1',
      wallet_address: linkedWallet.address,
      amount: '2.50',
      session_id: 'session-provider-mismatch',
    });
    (Users.findByUidAndWallet as jest.Mock).mockResolvedValue({
      id: 'user-contract-1', uid: 'contract-1', wallet_address: linkedWallet.address,
    });
    (SpendReceipts.findByTxHash as jest.Mock).mockResolvedValue({
      id: 'receipt-provider-mismatch',
      uid: mismatchedPayload.contractId,
      wallet_address: mismatchedPayload.walletAddress,
      amount: mismatchedPayload.amount,
      session_id: mismatchedPayload.sessionId,
      provider_id: mismatchedPayload.providerId,
      token_tx_hash: hash,
      token_contract_address: mismatchedPayload.tokenContractAddress,
      chain_id: 80002,
      signer_address: treasuryWallet.address,
      canonical_payload: signed.canonicalPayload,
      signature: signed.signature,
    });

    const res = await apiFetch('/spend/custodial-record', {
      method: 'POST',
      body: JSON.stringify({
        uid: 'contract-1',
        walletAddress: linkedWallet.address,
        amount: 2.5,
        txHash: hash,
        sessionId: 'session-provider-mismatch',
        providerId: 'provider-proof',
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toMatchObject({
      status: 'error',
      code: 'CUSTODIAL_RECEIPT_CONTEXT_MISMATCH',
      requiresReview: true,
      retryable: false,
    });
  });

  it('rejects a valid receipt when the existing spend projection belongs to another eMAID', async () => {
    const hash = `0x${'c'.repeat(64)}`;
    installTransferProof(hash, '2.50');
    const { Spends, SpendReceipts, Users } = await import('./database/service');
    const payload = createSpendReceiptPayload({
      contractId: 'contract-1',
      walletAddress: linkedWallet.address,
      amount: 2.5,
      sessionId: 'session-owner-mismatch',
      providerId: 'provider-proof',
      tokenTxHash: hash,
      tokenContractAddress: process.env.TOKEN_CONTRACT_ADDRESS!,
      chainId: 80002,
    });
    const signed = await signSpendReceipt(payload, treasuryWallet);
    (Spends.findByTxHash as jest.Mock).mockResolvedValue({
      user_id: 'user-contract-other',
      wallet_address: linkedWallet.address,
      amount: '2.50',
      session_id: 'session-owner-mismatch',
    });
    (Users.findByUidAndWallet as jest.Mock).mockResolvedValue({
      id: 'user-contract-1', uid: 'contract-1', wallet_address: linkedWallet.address,
    });
    (SpendReceipts.findByTxHash as jest.Mock).mockResolvedValue({
      id: 'receipt-owner-mismatch',
      uid: payload.contractId,
      wallet_address: payload.walletAddress,
      amount: payload.amount,
      session_id: payload.sessionId,
      provider_id: payload.providerId,
      token_tx_hash: hash,
      token_contract_address: payload.tokenContractAddress,
      chain_id: 80002,
      signer_address: treasuryWallet.address,
      canonical_payload: signed.canonicalPayload,
      signature: signed.signature,
    });

    const res = await apiFetch('/spend/custodial-record', {
      method: 'POST',
      body: JSON.stringify({
        uid: 'contract-1',
        walletAddress: linkedWallet.address,
        amount: 2.5,
        txHash: hash,
        sessionId: 'session-owner-mismatch',
        providerId: 'provider-proof',
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(409);
    expect(body).toMatchObject({
      status: 'error',
      code: 'CUSTODIAL_TX_HASH_INTENT_MISMATCH',
      requiresReview: true,
      retryable: false,
    });
    expect(SpendReceipts.create).not.toHaveBeenCalled();
  });

  it('keeps custodial owner lookup outages retryable', async () => {
    const hash = `0x${'e'.repeat(64)}`;
    installTransferProof(hash, '2.50');
    const { Spends, Users } = await import('./database/service');
    (Spends.findByTxHash as jest.Mock).mockResolvedValue({
      user_id: 'user-contract-1',
      wallet_address: linkedWallet.address,
      amount: '2.50',
      session_id: 'session-owner-outage',
    });
    (Users.findByUidAndWallet as jest.Mock).mockRejectedValueOnce(new Error('owner lookup outage'));

    const res = await apiFetch('/spend/custodial-record', {
      method: 'POST',
      body: JSON.stringify({
        uid: 'contract-1',
        walletAddress: linkedWallet.address,
        amount: 2.5,
        txHash: hash,
        sessionId: 'session-owner-outage',
        providerId: 'provider-proof',
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toMatchObject({
      status: 'pending',
      code: 'CUSTODIAL_OWNER_LOOKUP_PENDING',
      pending: true,
      retryable: true,
      requiresReview: false,
    });
  });

  it('replays a manual spend from its returned operation key without a balance precheck', async () => {
    const operationKey = 'spend:contract-1:manual-recovery';
    const hash = `0x${'8'.repeat(64)}`;
    const mockedService = jest.requireMock('./database/service') as {
      TokenOperations: { findByKey: jest.Mock };
      SpendReceipts: { create: jest.Mock };
    };
    mockedService.TokenOperations.findByKey.mockResolvedValue({
      operation_key: operationKey,
      operation_type: 'spend',
      status: 'pending',
      uid: 'contract-1',
      amount: '2.50',
      wallet_address: linkedWallet.address,
      session_id: 'manual-recovery-session',
      provider_id: 'manual-recovery-provider',
    });
    mockIndexModule!.processSpend.mockResolvedValue({
      success: true,
      amount: 2.5,
      txHash: hash,
      operationKey,
      operationStatus: 'confirmed',
      movementOutcome: 'confirmed',
    });

    const invalid = await apiFetch('/spend', {
      method: 'POST',
      body: JSON.stringify({ uid: 'contract-1', operationKey, amount: -1 }),
    });
    const invalidBody = await invalid.json();
    expect(invalid.status).toBe(400);
    expect(invalidBody).toMatchObject({ status: 'error', code: 'INVALID_SPEND_REQUEST' });
    expect(mockIndexModule!.processSpend).not.toHaveBeenCalled();

    const res = await apiFetch('/spend', {
      method: 'POST',
      body: JSON.stringify({ uid: 'contract-1', operationKey }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      status: 'success',
      uid: 'contract-1',
      operationKey,
      sessionId: 'manual-recovery-session',
      providerId: 'manual-recovery-provider',
      tokensSpent: 2.5,
      movementOutcome: 'confirmed',
    });
    expect(body.spendReceipt.payload.amount).toBe('2.50');
    expect(mockIndexModule!.processSpend).toHaveBeenCalledWith(
      expect.objectContaining({
        operationKey,
        amount: 2.5,
        sessionId: 'manual-recovery-session',
        providerId: 'manual-recovery-provider',
      }),
      expect.anything(),
    );
    expect(mockedService.SpendReceipts.create).toHaveBeenCalledTimes(1);
  });

  it('keeps an uncertain approval preparation pending for the same spend key', async () => {
    const operationKey = 'spend:contract-1:approval-review';
    const mockedService = jest.requireMock('./database/service') as {
      TokenOperations: { findByKey: jest.Mock };
    };
    mockedService.TokenOperations.findByKey.mockResolvedValue({
      operation_key: operationKey,
      operation_type: 'spend',
      status: 'pending',
      uid: 'contract-1',
      amount: '2.50',
      wallet_address: linkedWallet.address,
      session_id: 'approval-review-session',
      provider_id: 'approval-review-provider',
    });
    mockIndexModule!.processSpend.mockResolvedValue({
      success: false,
      amount: 2.5,
      userAddress: linkedWallet.address,
      operationKey,
      operationStatus: 'failed',
      preflightFailure: true,
      error: 'Spend preflight failed: insufficient allowance',
    });
    mockIntegrationModule!.approveUserForSpendingViaFunding.mockRejectedValueOnce(
      new Error('APPROVAL_PREPARATION_REVIEW_REQUIRED: funding state is unknown'),
    );

    const res = await apiFetch('/spend', {
      method: 'POST',
      body: JSON.stringify({ uid: 'contract-1', operationKey }),
    });
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toMatchObject({
      status: 'pending',
      operationKey,
      pending: true,
      requiresReview: true,
      preflightFailure: false,
      retryable: false,
    });
    expect(mockIndexModule!.processSpend).toHaveBeenCalledTimes(1);
  });

  it('does not fund approval after an unavailable token preflight', async () => {
    const operationKey = 'spend:contract-1:preflight-provider-review';
    const mockedService = jest.requireMock('./database/service') as {
      TokenOperations: { findByKey: jest.Mock };
    };
    mockedService.TokenOperations.findByKey.mockResolvedValue({
      operation_key: operationKey,
      operation_type: 'spend',
      status: 'failed',
      movement_outcome: 'no_movement',
      uid: 'contract-1',
      amount: '2.50',
      wallet_address: linkedWallet.address,
      session_id: 'preflight-provider-session',
      provider_id: 'preflight-provider',
    });
    mockIndexModule!.processSpend.mockResolvedValue({
      success: false,
      amount: 2.5,
      userAddress: linkedWallet.address,
      operationKey,
      operationStatus: 'failed',
      pending: true,
      requiresReview: false,
      preflightFailure: true,
      preflightApprovalEligible: false,
      movementOutcome: 'no_movement',
      error: 'Spend preflight failed: SPEND_PREFLIGHT_UNAVAILABLE: provider unavailable',
    });

    const res = await apiFetch('/spend', {
      method: 'POST',
      body: JSON.stringify({ uid: 'contract-1', operationKey }),
    });
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toMatchObject({
      status: 'pending',
      operationKey,
      pending: true,
      retryable: true,
      requiresReview: false,
      preflightFailure: true,
      movementOutcome: 'no_movement',
    });
    expect(mockIntegrationModule!.approveUserForSpendingViaFunding).not.toHaveBeenCalled();
  });

  it('does not create a settled reservation receipt under a changed asset context', async () => {
    process.env.TEST_AWARD_RECOVERY = 'true';
    const reservationId = 'reservation-asset-mismatch';
    const txHash = `0x${'9'.repeat(64)}`;
    const oldTokenContract = ethers.Wallet.createRandom().address;
    const mockedService = jest.requireMock('./database/service') as {
      TokenOperations: { findByKey: jest.Mock };
      SpendReservations: { findBySession: jest.Mock };
      SpendReceipts: { create: jest.Mock };
    };
    mockedService.TokenOperations.findByKey.mockImplementation(async (key: string) => {
      if (key.startsWith('reservation:')) {
        return {
          operation_key: key,
          operation_type: 'spend',
          status: 'projected',
          uid: 'contract-cap-replay',
          wallet_address: linkedWallet.address,
          amount: '3.00',
          reservation_id: reservationId,
          session_id: 'cap-replay-session',
          provider_id: 'cap-replay-provider',
          tx_hash: txHash,
          intent_context: {
            assetContext: {
              tokenContractAddress: oldTokenContract,
              chainId: '80002',
              treasuryAddress: treasuryWallet.address,
              signerAddress: treasuryWallet.address,
            },
          },
        };
      }
      return {
        operation_key: key,
        operation_type: 'award',
        status: 'projected',
        uid: 'contract-cap-replay',
        amount: '10.00',
        wallet_address: linkedWallet.address,
      };
    });
    mockedService.SpendReservations.findBySession.mockResolvedValue({
      id: reservationId,
      uid: 'contract-cap-replay',
      wallet_address: linkedWallet.address,
      session_id: 'cap-replay-session',
      provider_id: 'cap-replay-provider',
      reserved_amount: '5.00',
      settled_amount: '3.00',
      released_amount: '2.00',
      status: 'settled',
      tx_hash: txHash,
      updated_at: new Date('2026-07-21T12:00:00Z'),
    });

    try {
      const res = await apiFetch('/ingest/cdr', {
        method: 'POST',
        headers: { 'X-Ingest-API-Key': 'test-ingest-key' },
        body: JSON.stringify({
          SessionID: 'cap-replay-session',
          ProviderID: 'cap-replay-provider',
          EVSEID: 'DE*NVF*ASSET01',
          cdr_token: { contract_id: 'contract-cap-replay' },
          StartTime: '2026-07-05T23:00:00.000Z',
          EndTime: '2026-07-06T00:00:00.000Z',
          Energy: '1',
          EnergyDirection: 'CHARGE',
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(202);
      expect(body).toMatchObject({
        status: 'pending',
        reservationId,
        financialStatus: 'confirmed',
        requiresReview: true,
        retryable: false,
      });
      expect(mockedService.SpendReceipts.create).not.toHaveBeenCalled();
    } finally {
      delete process.env.TEST_AWARD_RECOVERY;
    }
  });

  it('does not mark a settled receipt conflict as retryable recovery', async () => {
    process.env.TEST_AWARD_RECOVERY = 'true';
    const reservationId = 'reservation-receipt-conflict';
    const txHash = `0x${'f'.repeat(64)}`;
    const mockedService = jest.requireMock('./database/service') as {
      TokenOperations: { findByKey: jest.Mock };
      SpendReservations: { findBySession: jest.Mock };
      SpendReceipts: { findByTxHash: jest.Mock; create: jest.Mock };
    };
    mockedService.TokenOperations.findByKey.mockImplementation(async (key: string) => key.startsWith('reservation:')
      ? {
        operation_key: key,
        operation_type: 'spend',
        status: 'projected',
        uid: 'contract-cap-replay',
        wallet_address: linkedWallet.address,
        amount: '3.00',
        reservation_id: reservationId,
        session_id: 'cap-replay-session',
        provider_id: 'cap-replay-provider',
        tx_hash: txHash,
        intent_context: {
          assetContext: {
            tokenContractAddress: process.env.TOKEN_CONTRACT_ADDRESS,
            chainId: '80002',
            treasuryAddress: treasuryWallet.address,
            signerAddress: treasuryWallet.address,
          },
        },
      }
      : undefined);
    mockedService.SpendReservations.findBySession.mockResolvedValue({
      id: reservationId,
      uid: 'contract-cap-replay',
      wallet_address: linkedWallet.address,
      session_id: 'cap-replay-session',
      provider_id: 'cap-replay-provider',
      reserved_amount: '5.00',
      settled_amount: '3.00',
      released_amount: '2.00',
      status: 'settled',
      tx_hash: txHash,
      updated_at: new Date('2026-07-21T12:00:00Z'),
    });
    const conflictingPayload = createSpendReceiptPayload({
      contractId: 'different-contract',
      walletAddress: linkedWallet.address,
      amount: 3,
      sessionId: 'cap-replay-session',
      providerId: 'cap-replay-provider',
      tokenTxHash: txHash,
      tokenContractAddress: process.env.TOKEN_CONTRACT_ADDRESS!,
      chainId: 80002,
    });
    mockedService.SpendReceipts.findByTxHash.mockResolvedValue({
      id: 'receipt-conflict',
      uid: 'different-contract',
      wallet_address: linkedWallet.address,
      amount: '3.00',
      session_id: 'cap-replay-session',
      provider_id: 'cap-replay-provider',
      token_tx_hash: txHash,
      token_contract_address: process.env.TOKEN_CONTRACT_ADDRESS,
      chain_id: 80002,
      signer_address: treasuryWallet.address,
      canonical_payload: JSON.stringify(conflictingPayload),
      signature: '0xdead',
    });

    try {
      const res = await apiFetch('/ingest/cdr', {
        method: 'POST',
        headers: { 'X-Ingest-API-Key': 'test-ingest-key' },
        body: JSON.stringify({
          SessionID: 'cap-replay-session',
          ProviderID: 'cap-replay-provider',
          EVSEID: 'DE*NVF*RECEIPT01',
          cdr_token: { contract_id: 'contract-cap-replay' },
          StartTime: '2026-07-05T23:00:00.000Z',
          EndTime: '2026-07-06T00:00:00.000Z',
          Energy: '1',
          EnergyDirection: 'CHARGE',
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(202);
      expect(body).toMatchObject({
        status: 'pending',
        reservationId,
        requiresReview: true,
        retryable: false,
      });
      expect(mockedService.SpendReceipts.create).not.toHaveBeenCalled();
    } finally {
      delete process.env.TEST_AWARD_RECOVERY;
    }
  });

  it('rejects a changed CDR fingerprint before touching its reservation', async () => {
    const mockedService = jest.requireMock('./database/service') as {
      SpendReservations: { findBySession: jest.Mock; claimForSettlement: jest.Mock };
    };
    mockIndexModule!.processAwardFromCDR.mockResolvedValueOnce({
      success: false,
      dedupKey: 'changed-cdr-session-provider',
      eligible: true,
      amount: 10,
      uid: 'contract-changed-cdr',
      txHash: `0x${'c'.repeat(64)}`,
      operationStatus: 'confirmed',
      pending: true,
      requiresReview: true,
      error: 'Award recovery is blocked because the original CDR owner/fingerprint differs',
      stage: 'execution',
    });

    const res = await apiFetch('/ingest/cdr', {
      method: 'POST',
      headers: { 'X-Ingest-API-Key': 'test-ingest-key' },
      body: JSON.stringify({
        SessionID: 'changed-cdr-session',
        ProviderID: 'changed-cdr-provider',
        EVSEID: 'DE*NVF*CHANGED01',
        cdr_token: { contract_id: 'contract-changed-cdr' },
        StartTime: '2026-07-05T23:00:00.000Z',
        EndTime: '2026-07-06T00:00:00.000Z',
        Energy: '4',
        EnergyDirection: 'CHARGE',
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toMatchObject({
      status: 'pending',
      pending: true,
      requiresReview: true,
      retryable: false,
    });
    expect(mockedService.SpendReservations.findBySession).not.toHaveBeenCalled();
    expect(mockedService.SpendReservations.claimForSettlement).not.toHaveBeenCalled();
  });

  it('recovers a missing settled reservation receipt on a duplicate CDR', async () => {
    const reservationId = 'reservation-duplicate-receipt';
    const txHash = `0x${'d'.repeat(64)}`;
    const mockedService = jest.requireMock('./database/service') as {
      TokenOperations: { findByKey: jest.Mock };
      SpendReservations: { findBySession: jest.Mock };
      SpendReceipts: { findByTxHash: jest.Mock; create: jest.Mock };
    };
    mockedService.TokenOperations.findByKey.mockImplementation(async (key: string) => key.startsWith('reservation:')
      ? {
        operation_key: key,
        operation_type: 'spend',
        status: 'projected',
        uid: 'contract-duplicate',
        wallet_address: linkedWallet.address,
        amount: '3.00',
        reservation_id: reservationId,
        session_id: 'duplicate-session',
        provider_id: 'duplicate-provider',
        tx_hash: txHash,
        intent_context: {
          assetContext: {
            tokenContractAddress: process.env.TOKEN_CONTRACT_ADDRESS,
            chainId: '80002',
            treasuryAddress: treasuryWallet.address,
            signerAddress: treasuryWallet.address,
          },
        },
      }
      : undefined);
    mockedService.SpendReservations.findBySession.mockResolvedValue({
      id: reservationId,
      uid: 'contract-duplicate',
      wallet_address: linkedWallet.address,
      session_id: 'duplicate-session',
      provider_id: 'duplicate-provider',
      reserved_amount: '5.00',
      settled_amount: '3.00',
      released_amount: '2.00',
      status: 'settled',
      tx_hash: txHash,
      updated_at: new Date('2026-07-21T12:00:00Z'),
    });
    mockedService.SpendReceipts.findByTxHash.mockResolvedValue(undefined);
    mockIndexModule!.processAwardFromCDR.mockResolvedValueOnce({
      success: true,
      duplicate: true,
      dedupKey: 'duplicate-session-duplicate-provider',
      eligible: true,
      amount: 10,
      uid: 'contract-duplicate',
      txHash: `0x${'e'.repeat(64)}`,
      operationStatus: 'projected',
      stage: 'complete',
    });

    const res = await apiFetch('/ingest/cdr', {
      method: 'POST',
      headers: { 'X-Ingest-API-Key': 'test-ingest-key' },
      body: JSON.stringify({
        SessionID: 'duplicate-session',
        ProviderID: 'duplicate-provider',
        EVSEID: 'DE*NVF*DUPLICATE01',
        cdr_token: { contract_id: 'contract-duplicate' },
        StartTime: '2026-07-05T23:00:00.000Z',
        EndTime: '2026-07-06T00:00:00.000Z',
        Energy: '4',
        EnergyDirection: 'CHARGE',
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      status: 'duplicate',
      reservationSettlement: {
        id: reservationId,
        spendReceipt: { payload: { tokenTxHash: txHash } },
      },
    });
    expect(mockedService.SpendReceipts.create).toHaveBeenCalledTimes(1);
    expect(mockIndexModule!.processSpend).not.toHaveBeenCalled();
  });

  it('releases a charging hold for negative discharge energy without a debit', async () => {
    const mockedService = jest.requireMock('./database/service') as {
      TokenOperations: { claim: jest.Mock; markProjected: jest.Mock };
      SpendReservations: { findBySession: jest.Mock; claimForSettlement: jest.Mock; complete: jest.Mock };
      SpendReceipts: { create: jest.Mock };
    };
    const reservation = {
      id: 'reservation-discharge',
      uid: 'contract-discharge',
      wallet_address: linkedWallet.address,
      session_id: 'discharge-session',
      provider_id: 'discharge-provider',
      reserved_amount: '5.00',
      status: 'settling',
      tx_hash: null,
      updated_at: new Date('2026-07-21T12:00:00Z'),
    };
    const zeroOperation = {
      operation_key: 'reservation:reservation-discharge',
      operation_type: 'spend',
      status: 'submitting',
      movement_outcome: 'unknown',
      uid: 'contract-discharge',
      wallet_address: linkedWallet.address,
      amount: '0.00',
      session_id: 'discharge-session',
      provider_id: 'discharge-provider',
      reservation_id: 'reservation-discharge',
      intent_context: {
        assetContext: {
          tokenContractAddress: process.env.TOKEN_CONTRACT_ADDRESS!.toLowerCase(),
          chainId: '80002',
          treasuryAddress: treasuryWallet.address.toLowerCase(),
          signerAddress: treasuryWallet.address.toLowerCase(),
        },
      },
    };
    mockedService.TokenOperations.claim.mockResolvedValue({ operation: zeroOperation, acquired: true });
    mockedService.TokenOperations.markProjected.mockResolvedValue({
      ...zeroOperation,
      status: 'projected',
      movement_outcome: 'no_movement',
    });
    mockedService.SpendReservations.findBySession.mockResolvedValue(undefined);
    mockedService.SpendReservations.claimForSettlement.mockResolvedValue(reservation);
    mockedService.SpendReservations.complete.mockResolvedValue({
      ...reservation,
      status: 'released',
      settled_amount: '0.00',
      released_amount: '5.00',
      delivered_kwh: '0.000',
    });
    mockIndexModule!.processAwardFromCDR.mockResolvedValueOnce({
      success: true,
      duplicate: true,
      dedupKey: 'discharge-session-discharge-provider',
      eligible: false,
      amount: 0,
      uid: 'contract-discharge',
      operationStatus: 'projected',
      stage: 'complete',
    });

    const res = await apiFetch('/ingest/cdr', {
      method: 'POST',
      headers: { 'X-Ingest-API-Key': 'test-ingest-key' },
      body: JSON.stringify({
        SessionID: 'discharge-session',
        ProviderID: 'discharge-provider',
        EVSEID: 'DE*NVF*DISCHARGE01',
        cdr_token: { contract_id: 'contract-discharge' },
        StartTime: '2026-07-05T23:00:00.000Z',
        EndTime: '2026-07-06T00:00:00.000Z',
        Energy: '-15',
        EnergyDirection: 'DISCHARGE',
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      status: 'duplicate',
      eligible: false,
      tokensAwarded: 0,
      reservationSettlement: { status: 'released', released_amount: '5.00' },
    });
    expect(mockedService.SpendReservations.complete).toHaveBeenCalledWith('reservation-discharge', 0, 0);
    expect(mockIndexModule!.processSpend).not.toHaveBeenCalled();
    expect(mockIntegrationModule!.recordSpend).not.toHaveBeenCalled();
    expect(mockedService.SpendReceipts.create).not.toHaveBeenCalled();
  });

  it('recovers a zero-settlement release after completion failure without a debit', async () => {
    const mockedService = jest.requireMock('./database/service') as {
      TokenOperations: { findByKey: jest.Mock; claim: jest.Mock; markProjected: jest.Mock };
      SpendReservations: {
        findBySession: jest.Mock;
        claimForSettlement: jest.Mock;
        complete: jest.Mock;
        retry: jest.Mock;
      };
    };
    const reservation = {
      id: 'reservation-zero-retry',
      uid: 'contract-zero-retry',
      wallet_address: linkedWallet.address,
      session_id: 'zero-retry-session',
      provider_id: 'zero-retry-provider',
      reserved_amount: '5.00',
      status: 'settling',
      tx_hash: null,
      updated_at: new Date('2026-07-21T12:00:00Z'),
    };
    const zeroOperation = {
      operation_key: 'reservation:reservation-zero-retry',
      operation_type: 'spend',
      status: 'submitting',
      movement_outcome: 'unknown',
      uid: reservation.uid,
      wallet_address: reservation.wallet_address,
      amount: '0.00',
      session_id: reservation.session_id,
      provider_id: reservation.provider_id,
      reservation_id: reservation.id,
      intent_context: {
        assetContext: {
          tokenContractAddress: process.env.TOKEN_CONTRACT_ADDRESS!.toLowerCase(),
          chainId: '80002',
          treasuryAddress: treasuryWallet.address.toLowerCase(),
          signerAddress: treasuryWallet.address.toLowerCase(),
        },
      },
    };
    mockedService.SpendReservations.findBySession
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(reservation);
    mockedService.SpendReservations.claimForSettlement.mockResolvedValueOnce(reservation);
    mockedService.SpendReservations.complete
      .mockRejectedValueOnce(new Error('temporary release projection outage'))
      .mockResolvedValueOnce({
        ...reservation,
        status: 'released',
        settled_amount: '0.00',
        released_amount: '5.00',
        delivered_kwh: '0.000',
      });
    mockedService.TokenOperations.findByKey.mockImplementation(async (key: string) => (
      key.startsWith('reservation:') ? zeroOperation : undefined
    ));
    mockedService.TokenOperations.claim.mockResolvedValue({ operation: zeroOperation, acquired: false });
    mockedService.TokenOperations.markProjected.mockResolvedValue({
      ...zeroOperation,
      status: 'projected',
      movement_outcome: 'no_movement',
    });
    mockIndexModule!.processAwardFromCDR.mockResolvedValue({
      success: true,
      duplicate: true,
      dedupKey: 'zero-retry-session-zero-retry-provider',
      eligible: false,
      amount: 0,
      uid: reservation.uid,
      operationStatus: 'projected',
      stage: 'complete',
    });

    const request = {
      SessionID: reservation.session_id,
      ProviderID: reservation.provider_id,
      EVSEID: 'DE*NVF*ZERO01',
      cdr_token: { contract_id: reservation.uid },
      StartTime: '2026-07-05T23:00:00.000Z',
      EndTime: '2026-07-06T00:00:00.000Z',
      Energy: '-15',
      EnergyDirection: 'DISCHARGE',
    };
    const first = await apiFetch('/ingest/cdr', {
      method: 'POST',
      headers: { 'X-Ingest-API-Key': 'test-ingest-key' },
      body: JSON.stringify(request),
    });
    const firstBody = await first.json();
    expect(first.status).toBe(202);
    expect(firstBody).toMatchObject({
      status: 'pending',
      reservationId: reservation.id,
      retryable: true,
      requiresReview: false,
    });

    const second = await apiFetch('/ingest/cdr', {
      method: 'POST',
      headers: { 'X-Ingest-API-Key': 'test-ingest-key' },
      body: JSON.stringify(request),
    });
    const secondBody = await second.json();
    expect(second.status).toBe(200);
    expect(secondBody).toMatchObject({
      status: 'duplicate',
      reservationSettlement: { status: 'released', released_amount: '5.00' },
    });
    expect(mockedService.TokenOperations.claim).toHaveBeenCalledTimes(2);
    expect(mockedService.TokenOperations.markProjected).toHaveBeenCalledTimes(2);
    expect(mockedService.SpendReservations.complete).toHaveBeenCalledTimes(2);
    expect(mockedService.SpendReservations.retry).toHaveBeenCalledTimes(1);
    expect(mockIndexModule!.processSpend).not.toHaveBeenCalled();
    expect(mockIntegrationModule!.recordSpend).not.toHaveBeenCalled();
  });

  it('previews CDR reward calculation without settlement side effects', async () => {
    const res = await apiFetch('/ingest/cdr/preview', {
      method: 'POST',
      headers: { 'X-Ingest-API-Key': 'test-ingest-key' },
      body: JSON.stringify({
        SessionID: 'preview-session-1',
        ProviderID: 'preview-provider',
        EVSEID: 'DE*NVF*PREVIEW01',
        cdr_token: { contract_id: 'contract-preview' },
        StartTime: '2026-07-05T23:00:00.000Z',
        EndTime: '2026-07-05T23:30:00.000Z',
        Energy: '12.5',
        EnergyDirection: 'CHARGE',
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      status: 'preview',
      sideEffects: false,
      uid: 'contract-preview',
      dedupKey: 'preview-session-1-preview-provider',
    });
    expect(body.normalised.sessionId).toBe('preview-session-1');
  });

  it('returns automatic protocol and eMAID provenance for an OCPI preview', async () => {
    const res = await fetch(`${baseUrl}/ingest/cdr/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ingest-API-Key': 'test-ingest-key' },
      body: JSON.stringify({
        id: 'ocpi-preview-identity',
        party_id: 'NF',
        cdr_token: { contract_id: 'DE*EMP*E123456', uid: 'token-only-metadata', type: 'RFID' },
        cdr_location: { evse_id: 'DE*NVF*OCPI01' },
        start_date_time: '2026-07-05T23:00:00.000Z',
        end_date_time: '2026-07-06T00:00:00.000Z',
        total_energy: 1,
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.normalisation).toMatchObject({
      eMAID: 'DE*EMP*E123456',
      emaid: 'DE*EMP*E123456',
      protocol: 'OCPI',
      sourceField: 'cdr_token.contract_id',
      tokenMetadata: { uid: 'token-only-metadata', type: 'RFID' },
    });
    expect(body.normalised).toMatchObject(body.normalisation);
  });

  it('returns a review-required collision for a replacement OCPI CDR before reservation settlement', async () => {
    const mockedService = jest.requireMock('./database/service') as {
      TokenOperations: { findByKey: jest.Mock };
      SpendReservations: { findBySession: jest.Mock; claimForSettlement: jest.Mock; complete: jest.Mock };
    };
    mockedService.TokenOperations.findByKey.mockResolvedValue(undefined);
    mockIndexModule!.processAwardFromCDR.mockResolvedValueOnce({
      success: false,
      dedupKey: 'replacement-cdr-002-provider-ocpi',
      eligible: true,
      amount: 10,
      uid: 'DE*EMP*E123456',
      operationStatus: 'review',
      pending: true,
      requiresReview: true,
      error: 'AWARD_CHARGING_SESSION_COLLISION_REVIEW: another CDR key already owns this provider charging session; operator review is required and no replacement award was submitted',
      stage: 'validation',
    });

    const res = await apiFetch('/ingest/cdr', {
      method: 'POST',
      headers: { 'X-Ingest-API-Key': 'test-ingest-key' },
      body: JSON.stringify({
        id: 'replacement-cdr-002',
        session_id: 'physical-session-001',
        party_id: 'provider-ocpi',
        cdr_token: { contract_id: 'DE*EMP*E123456' },
        cdr_location: { evse_id: 'DE*NVF*OCPI01' },
        start_date_time: '2026-07-05T23:00:00.000Z',
        end_date_time: '2026-07-06T00:00:00.000Z',
        total_energy: 40,
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body).toMatchObject({
      status: 'pending',
      operationStatus: 'review',
      pending: true,
      retryable: false,
      requiresReview: true,
      code: 'AWARD_CHARGING_SESSION_COLLISION_REVIEW',
    });
    expect(body.error).toContain('already claimed under another CDR');
    expect(mockedService.SpendReservations.findBySession).not.toHaveBeenCalled();
    expect(mockedService.SpendReservations.claimForSettlement).not.toHaveBeenCalled();
    expect(mockedService.SpendReservations.complete).not.toHaveBeenCalled();
  });

  it('returns a structured UID-only identity error for preview without deriving ownership', async () => {
    const res = await fetch(`${baseUrl}/ingest/cdr/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Ingest-API-Key': 'test-ingest-key' },
      body: JSON.stringify({
        SessionID: 'uid-only-preview',
        ProviderID: 'preview-provider',
        UID: 'rfid-only',
        EVSEID: 'DE*NVF*UIDONLY',
        StartTime: '2026-07-05T23:00:00.000Z',
        EndTime: '2026-07-06T00:00:00.000Z',
        Energy: '1',
        EnergyDirection: 'CHARGE',
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toMatchObject({
      status: 'error',
      code: 'INVALID_CDR',
      normalisationError: {
        code: 'UID_ONLY',
        protocol: 'OICP',
        sourceFields: ['UID'],
      },
    });
  });

  it('rejects UID-only ingest and audits the structured identity reason', async () => {
    const res = await apiFetch('/ingest/cdr', {
      method: 'POST',
      headers: { 'X-Ingest-API-Key': 'test-ingest-key' },
      body: JSON.stringify({
        SessionID: 'uid-only-ingest',
        ProviderID: 'ingest-provider',
        uid: 'custom-uid-only',
        EVSEID: 'DE*NVF*UIDONLY',
        StartTime: '2026-07-05T23:00:00.000Z',
        EndTime: '2026-07-06T00:00:00.000Z',
        Energy: '1',
        EnergyDirection: 'CHARGE',
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.normalisationError).toMatchObject({
      code: 'UID_ONLY',
      protocol: 'OICP',
      sourceFields: ['uid'],
    });
    expect(mockAuditLogs.create).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'award.validation_failed',
      metadata: expect.objectContaining({
        normalisationError: expect.objectContaining({
          code: 'UID_ONLY',
          protocol: 'OICP',
          sourceFields: ['uid'],
        }),
      }),
    }));
    expect(mockIndexModule!.processAwardFromCDR).not.toHaveBeenCalled();
  });

  it('rejects conflicting OCPI/OICP ingest identity and audits both source fields', async () => {
    const res = await apiFetch('/ingest/cdr', {
      method: 'POST',
      headers: { 'X-Ingest-API-Key': 'test-ingest-key' },
      body: JSON.stringify({
        SessionID: 'conflicting-identity-ingest',
        ProviderID: 'ingest-provider',
        EVSEID: 'DE*NVF*CONFLICT',
        cdr_token: { contract_id: 'DE*EMP*E111111' },
        Identification: { RemoteIdentification: { EvcoID: 'DE*EMP*E222222' } },
        StartTime: '2026-07-05T23:00:00.000Z',
        EndTime: '2026-07-06T00:00:00.000Z',
        Energy: '1',
        EnergyDirection: 'CHARGE',
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.normalisationError).toMatchObject({
      code: 'CONFLICTING_IDENTIFIERS',
      protocol: 'MIXED',
      sourceFields: [
        'cdr_token.contract_id',
        'Identification.RemoteIdentification.EvcoID',
      ],
    });
    expect(mockAuditLogs.create).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'award.validation_failed',
      metadata: expect.objectContaining({
        normalisationError: expect.objectContaining({
          code: 'CONFLICTING_IDENTIFIERS',
          protocol: 'MIXED',
          sourceFields: [
            'cdr_token.contract_id',
            'Identification.RemoteIdentification.EvcoID',
          ],
        }),
      }),
    }));
    expect(mockIndexModule!.processAwardFromCDR).not.toHaveBeenCalled();
  });

  it('rejects CDR awards above the 200 SPARKZ operation cap', async () => {
    const res = await apiFetch('/ingest/cdr/preview', {
      method: 'POST',
      headers: { 'X-Ingest-API-Key': 'test-ingest-key' },
      body: JSON.stringify({
        SessionID: 'preview-over-cap',
        ProviderID: 'preview-provider',
        EVSEID: 'DE*NVF*PREVIEW02',
        cdr_token: { contract_id: 'contract-preview' },
        StartTime: '2026-07-05T23:00:00.000Z',
        EndTime: '2026-07-06T00:00:00.000Z',
        Energy: '1000',
        EnergyDirection: 'CHARGE',
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body).toMatchObject({
      status: 'error',
      code: 'TOKEN_AMOUNT_CAP_EXCEEDED',
      operation: 'award',
      maximumAmount: 200,
    });
    expect(body.requestedAmount).toBeGreaterThan(200);
  });

  it('lets the public CDR endpoint recover a claimed award after the cap changes', async () => {
    process.env.TEST_AWARD_RECOVERY = 'true';

    try {
      const res = await apiFetch('/ingest/cdr', {
        method: 'POST',
        headers: { 'X-Ingest-API-Key': 'test-ingest-key' },
        body: JSON.stringify({
          SessionID: 'cap-replay-session',
          ProviderID: 'cap-replay-provider',
          EVSEID: 'DE*NVF*CAPREPLAY01',
          cdr_token: { contract_id: 'contract-cap-replay' },
          StartTime: '2026-07-05T23:00:00.000Z',
          EndTime: '2026-07-06T00:00:00.000Z',
          Energy: '1000',
          EnergyDirection: 'CHARGE',
        }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body).toMatchObject({
        status: 'accepted',
        tokensAwarded: 10,
        operationStatus: 'projected',
      });
    } finally {
      delete process.env.TEST_AWARD_RECOVERY;
    }
  });

  it('audits skipped admin alert delivery when alert webhook is not configured', async () => {
    const res = await apiFetch('/spend/custodial-intent', {
      method: 'POST',
      body: JSON.stringify({
        uid: 'contract-1',
        walletAddress: 'not-a-wallet',
        amount: 2.5,
      }),
    });

    expect(res.status).toBe(400);
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(mockAuditLogs.create).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'spend.custodial_intent_failed',
      status: 'error',
    }));
    expect(mockAuditLogs.create).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'admin_alert.delivery_skipped',
      status: 'warning',
      metadata: expect.objectContaining({
        sourceEventType: 'spend.custodial_intent_failed',
      }),
    }));
  });

  it('allows admins to send a test alert', async () => {
    const token = await adminToken();
    const res = await apiFetch('/admin/alerts/test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json();

    expect(res.status).toBe(202);
    expect(body.status).toBe('delivery_skipped');
    expect(body.adminEmailConfigured).toBe(true);
    expect(mockAuditLogs.create).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'admin_alert.test_requested',
      status: 'success',
    }));
    expect(mockAuditLogs.create).toHaveBeenCalledWith(expect.objectContaining({
      eventType: 'admin_alert.delivery_skipped',
      status: 'warning',
      metadata: expect.objectContaining({
        sourceEventType: 'admin_alert.test',
      }),
    }));
  });

  it('reports a failed test-alert delivery instead of claiming it was sent', async () => {
    const token = await adminToken();
    const previousWebhook = process.env.ADMIN_ALERT_WEBHOOK_URL;
    const previousFetch = globalThis.fetch;
    const mockedFetch = jest.fn().mockRejectedValue(new Error('webhook unavailable in test'));
    process.env.ADMIN_ALERT_WEBHOOK_URL = 'https://alerts.example.test/webhook';
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => (
      typeof input === 'string' && input.startsWith(baseUrl)
        ? previousFetch(input, init)
        : mockedFetch(input, init)
    )) as typeof fetch;

    try {
      const res = await fetch(`${baseUrl}/admin/alerts/test`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'test-api-key',
          Authorization: `Bearer ${token}`,
        },
      });
      const body = await res.json();

      expect(res.status).toBe(502);
      expect(body).toMatchObject({
        status: 'delivery_failed',
        message: 'Test alert delivery failed; inspect the audit log and retry after the alert target is healthy.',
        adminEmailConfigured: true,
        webhookConfigured: true,
      });
      expect(body.message).not.toContain('webhook unavailable in test');
      expect(mockedFetch).toHaveBeenCalledTimes(1);
      expect(mockAuditLogs.create).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'admin_alert.delivery_failed',
        status: 'error',
      }));
    } finally {
      globalThis.fetch = previousFetch;
      if (previousWebhook === undefined) delete process.env.ADMIN_ALERT_WEBHOOK_URL;
      else process.env.ADMIN_ALERT_WEBHOOK_URL = previousWebhook;
    }
  });

  it('reports successful webhook delivery even when its audit write fails', async () => {
    const token = await adminToken();
    const previousWebhook = process.env.ADMIN_ALERT_WEBHOOK_URL;
    const previousFetch = globalThis.fetch;
    const previousAuditImplementation = mockAuditLogs.create.getMockImplementation();
    const mockedFetch = jest.fn().mockResolvedValue(new Response('ok', { status: 200 }));
    const consoleWarn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    process.env.ADMIN_ALERT_WEBHOOK_URL = 'https://alerts.example.test/webhook';
    mockAuditLogs.create.mockImplementation(async (event: { eventType?: string }) => {
      if (event.eventType === 'admin_alert.delivered') {
        throw new Error('audit database unavailable after delivery');
      }
      if (previousAuditImplementation) return previousAuditImplementation(event);
      return undefined;
    });
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => (
      typeof input === 'string' && input.startsWith(baseUrl)
        ? previousFetch(input, init)
        : mockedFetch(input, init)
    )) as typeof fetch;

    try {
      const res = await fetch(`${baseUrl}/admin/alerts/test`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': 'test-api-key',
          Authorization: `Bearer ${token}`,
        },
      });
      const body = await res.json();

      expect(res.status).toBe(202);
      expect(body).toMatchObject({
        status: 'sent_or_queued',
        adminEmailConfigured: true,
        webhookConfigured: true,
      });
      expect(mockedFetch).toHaveBeenCalledTimes(1);
      expect(mockAuditLogs.create).toHaveBeenCalledWith(expect.objectContaining({
        eventType: 'admin_alert.delivered',
        status: 'success',
      }));
      expect(consoleWarn).toHaveBeenCalledWith(
        'Admin alert delivery audit write failed:',
        expect.stringContaining('audit database unavailable after delivery'),
      );
    } finally {
      consoleWarn.mockRestore();
      globalThis.fetch = previousFetch;
      mockAuditLogs.create.mockReset().mockResolvedValue(undefined);
      if (previousWebhook === undefined) delete process.env.ADMIN_ALERT_WEBHOOK_URL;
      else process.env.ADMIN_ALERT_WEBHOOK_URL = previousWebhook;
    }
  });

  it('exports an admin evidence pack snapshot', async () => {
    const token = await adminToken();
    const res = await apiFetch('/admin/evidence-pack', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json();

    if (res.status !== 200) {
      throw new Error(JSON.stringify(body));
    }
    expect(res.status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.readiness.checks.some((check: { key: string }) => check.key === 'admin_email')).toBe(true);
    expect(body.configuration).toMatchObject({
      apiKeyConfigured: true,
      ingestApiKeyConfigured: true,
      adminEmailConfigured: true,
    });
    expect(body.audit).toHaveProperty('retryRequired');
    expect(body.audit).toHaveProperty('warnings');
    expect(body.audit).toHaveProperty('errors');
    expect(body.pilotMetrics).toMatchObject({
      totalEvents: 3,
      awards: { completed: 1 },
    });
  });

  it('returns a safe evidence-pack error when audit storage is unavailable', async () => {
    const token = await adminToken();
    mockAuditLogs.getRecent.mockRejectedValueOnce(
      new Error('select * from audit_logs failed: password=raw-secret'),
    );
    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);

    try {
      const res = await apiFetch('/admin/evidence-pack', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body).toMatchObject({
        status: 'error',
        code: 'EVIDENCE_PACK_UNAVAILABLE',
        retryable: true,
        message: 'The evidence pack could not be generated. Please retry shortly.',
        error: 'The evidence pack could not be generated. Please retry shortly.',
      });
      expect(JSON.stringify(body)).not.toContain('audit_logs');
      expect(JSON.stringify(body)).not.toContain('raw-secret');
    } finally {
      consoleError.mockRestore();
    }
  });

  it('reads and durably updates admin reward policy with revision metadata', async () => {
    const token = await adminToken();
    const headers = { Authorization: `Bearer ${token}` };

    const initialResponse = await apiFetch('/admin/rules', { headers });
    const initial = await initialResponse.json();
    expect(initialResponse.status).toBe(200);
    expect(initial).toMatchObject({
      status: 'ok',
      revision: 1,
      policy: { revision: 1, updatedAt: '2026-09-23T00:00:00.000Z' },
      rules: { version: '1' },
    });

    const updateResponse = await apiFetch('/admin/rules', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ offPeakChargingTokensPerKWh: 0.5 }),
    });
    const updated = await updateResponse.json();
    expect(updateResponse.status).toBe(200);
    expect(updated).toMatchObject({
      status: 'ok',
      revision: 2,
      policy: { revision: 2 },
      rules: {
        version: '2',
        rules: { offPeakCharging: { tokensPerKWh: 0.5 } },
      },
    });

    const reloadedResponse = await apiFetch('/admin/rules', { headers });
    const reloaded = await reloadedResponse.json();
    expect(reloadedResponse.status).toBe(200);
    expect(reloaded).toMatchObject({
      revision: 2,
      policy: { revision: 2 },
      rules: { rules: { offPeakCharging: { tokensPerKWh: 0.5 } } },
    });
    expect(mockPolicyRepository!.update).toHaveBeenCalledTimes(1);
  });

  it('rejects empty, array, and unknown reward rule bodies before durable update', async () => {
    const token = await adminToken();
    const headers = { Authorization: `Bearer ${token}` };
    const initialResponse = await apiFetch('/admin/rules', { headers });
    const initial = await initialResponse.json();
    expect(initialResponse.status).toBe(200);

    const invalidBodies = [
      {},
      [],
      { unknownRuleField: true },
    ];

    for (const invalidBody of invalidBodies) {
      const response = await apiFetch('/admin/rules', {
        method: 'PUT',
        headers,
        body: JSON.stringify(invalidBody),
      });
      const body = await response.json();

      expect(response.status).toBe(400);
      expect(body.status).toBe('error');
      expect(body.code).toMatch(/^INVALID_REWARD_RULES_/);
      expect(body.message).toMatch(/reward rule|supported|non-empty|unsupported/i);
    }

    expect(mockPolicyRepository!.update).not.toHaveBeenCalled();
    const reloadedResponse = await apiFetch('/admin/rules', { headers });
    const reloaded = await reloadedResponse.json();
    expect(reloadedResponse.status).toBe(200);
    expect(reloaded).toMatchObject({
      revision: initial.revision,
      updatedAt: initial.updatedAt,
      policy: initial.policy,
      rules: initial.rules,
    });
  });

  it('uses row-locked full-window updates and country deletion callbacks', async () => {
    const token = await adminToken();
    const headers = { Authorization: `Bearer ${token}` };
    const windows = {
      DE: [{ start: '21:00', end: '05:00' }],
      GB: [{ start: '23:00', end: '06:00' }],
    };

    const updateResponse = await apiFetch('/admin/off-peak', {
      method: 'PUT',
      headers,
      body: JSON.stringify({ windows }),
    });
    const updated = await updateResponse.json();
    expect(updateResponse.status).toBe(200);
    expect(updated).toMatchObject({ revision: 2, policy: { revision: 2 }, windows });

    const deleteResponse = await apiFetch('/admin/off-peak/GB', {
      method: 'DELETE',
      headers,
    });
    const deleted = await deleteResponse.json();
    expect(deleteResponse.status).toBe(200);
    expect(deleted).toMatchObject({ revision: 3, policy: { revision: 3 }, windows: { DE: windows.DE } });
    expect(mockPolicyRepository!.update).toHaveBeenCalledTimes(2);
  });

  it('uses the loaded persisted policy snapshot for preview calculations', async () => {
    mockPolicySnapshot.revision = 7;
    mockPolicySnapshot.updatedAt = '2026-09-23T07:00:00.000Z';
    mockPolicySnapshot.rules = {
      ...mockPolicySnapshot.rules,
      version: '7',
      rules: {
        ...mockPolicySnapshot.rules.rules,
        offPeakCharging: {
          ...mockPolicySnapshot.rules.rules.offPeakCharging,
          tokensPerKWh: 1,
        },
      },
    };

    const res = await apiFetch('/ingest/cdr/preview', {
      method: 'POST',
      headers: { 'X-Ingest-API-Key': 'test-ingest-key' },
      body: JSON.stringify({
        SessionID: 'policy-snapshot-preview',
        ProviderID: 'policy-provider',
        cdr_token: { contract_id: 'policy-emaid' },
        EVSEID: 'DE*NVF*POLICY02',
        StartTime: '2026-07-05T23:00:00.000Z',
        EndTime: '2026-07-06T00:00:00.000Z',
        Energy: '4',
        EnergyDirection: 'CHARGE',
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      status: 'preview',
      tokensAwarded: 4,
      policy: { revision: 7, updatedAt: '2026-09-23T07:00:00.000Z' },
    });
    expect(body.metadata.configurationSnapshot).toContain('"policyRevision":7');
  });

  it('rejects non-finite JSON reward rates before durable update', async () => {
    const token = await adminToken();
    const res = await apiFetch('/admin/rules', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}` },
      body: '{"offPeakChargingTokensPerKWh":1e400}',
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.message).toContain('non-negative number');
    expect(mockPolicyRepository!.update).not.toHaveBeenCalled();
  });

  it('keeps award and spend recovery lookup failures generic', async () => {
    const { TokenOperations } = await import('./database/service');
    (TokenOperations.findByKey as jest.Mock).mockRejectedValueOnce(new Error('password=should-not-leak'));
    const awardResponse = await apiFetch('/ingest/cdr', {
      method: 'POST',
      headers: { 'X-Ingest-API-Key': 'test-ingest-key' },
      body: JSON.stringify({
        SessionID: 'recovery-error-award',
        ProviderID: 'recovery-provider',
        cdr_token: { contract_id: 'recovery-emaid' },
        EVSEID: 'DE*NVF*RECOVERY01',
        StartTime: '2026-07-05T23:00:00.000Z',
        EndTime: '2026-07-06T00:00:00.000Z',
        Energy: '1',
        EnergyDirection: 'CHARGE',
      }),
    });
    const awardBody = await awardResponse.json();
    expect(awardResponse.status).toBe(503);
    expect(awardBody).toMatchObject({ code: 'TOKEN_OPERATION_RECOVERY_UNAVAILABLE', retryable: true });
    expect(JSON.stringify(awardBody)).not.toContain('should-not-leak');

    (TokenOperations.findByKey as jest.Mock).mockRejectedValueOnce(new Error('database password=should-not-leak'));
    const spendResponse = await apiFetch('/spend', {
      method: 'POST',
      body: JSON.stringify({ uid: 'recovery-emaid', amount: 1, operationKey: 'spend:recovery-key' }),
    });
    const spendBody = await spendResponse.json();
    expect(spendResponse.status).toBe(503);
    expect(spendBody).toMatchObject({ code: 'TOKEN_OPERATION_RECOVERY_UNAVAILABLE', retryable: true });
    expect(JSON.stringify(spendBody)).not.toContain('should-not-leak');
  });

  it('fails reward reads and previews visibly when the durable policy is unavailable', async () => {
    const token = await adminToken();
    mockPolicyRepository!.load.mockRejectedValueOnce(new Error('password=should-not-leak'));
    const rulesResponse = await apiFetch('/admin/rules', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const rulesBody = await rulesResponse.json();
    expect(rulesResponse.status).toBe(503);
    expect(rulesBody).toMatchObject({
      status: 'error',
      code: 'REWARD_POLICY_UNAVAILABLE',
      retryable: true,
    });
    expect(JSON.stringify(rulesBody)).not.toContain('should-not-leak');

    mockPolicyRepository!.load.mockRejectedValueOnce(new Error('reward policy table missing'));
    const previewResponse = await apiFetch('/ingest/cdr/preview', {
      method: 'POST',
      headers: { 'X-Ingest-API-Key': 'test-ingest-key' },
      body: JSON.stringify({
        SessionID: 'policy-unavailable-preview',
        ProviderID: 'policy-provider',
        cdr_token: { contract_id: 'policy-emaid' },
        EVSEID: 'DE*NVF*POLICY01',
        StartTime: '2026-07-05T23:00:00.000Z',
        EndTime: '2026-07-06T00:00:00.000Z',
        Energy: '4',
        EnergyDirection: 'CHARGE',
      }),
    });
    const previewBody = await previewResponse.json();
    expect(previewResponse.status).toBe(503);
    expect(previewBody.code).toBe('REWARD_POLICY_UNAVAILABLE');
  });
});
