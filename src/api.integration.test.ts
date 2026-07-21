import http from 'http';
import { ethers } from 'ethers';
import { createSpendReceiptPayload, signSpendReceipt } from './receipt';

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

jest.mock('./database/service', () => ({
  Awards: { exists: jest.fn() },
  Spends: { findByTxHash: jest.fn() },
  Users: {
    findByUid: jest.fn().mockResolvedValue(undefined),
    findByUidAndWallet: jest.fn().mockResolvedValue(undefined),
    findAllByWallet: jest.fn().mockResolvedValue([]),
    linkContractId: jest.fn(),
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
  },
  SpendReservations: {
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
}));

jest.mock('./database/connection', () => ({
  getDatabase: jest.fn(() => ({
    raw: jest.fn().mockResolvedValue([{ ok: 1 }]),
  })),
}));

describe('api integration contracts', () => {
  let server: http.Server;
  let baseUrl: string;

  beforeAll(async () => {
    process.env.API_KEY = 'test-api-key';
    process.env.INGEST_API_KEY = 'test-ingest-key';
    process.env.ADMIN_EMAIL = 'admin@example.com';
    process.env.ADMIN_PASSWORD = 'correct-password';
    process.env.ENABLE_TEST_UID_LOOKUP = 'false';
    process.env.TREASURY_SIGNER_KEY = treasuryWallet.privateKey;
    process.env.TREASURY_ADDRESS = treasuryWallet.address;
    process.env.TOKEN_CONTRACT_ADDRESS = ethers.Wallet.createRandom().address;
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
    expect(body.paths['/spend/session']).toBeDefined();
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

  it('verifies signed spend receipts over HTTP', async () => {
    const signer = ethers.Wallet.createRandom();
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
    const signed = await signSpendReceipt(payload, signer);

    const res = await apiFetch('/spend-receipts/verify', {
      method: 'POST',
      body: JSON.stringify({
        payload: signed.payload,
        signature: signed.signature,
        signerAddress: signed.signerAddress,
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toMatchObject({
      status: 'valid',
      valid: true,
      receiptId: payload.receiptId,
    });
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
  });

  it('does not treat legacy ADMIN_USERNAME as the registered admin email', async () => {
    const previousEmail = process.env.ADMIN_EMAIL;
    const previousUsername = process.env.ADMIN_USERNAME;
    process.env.ADMIN_EMAIL = '';
    process.env.ADMIN_USERNAME = 'legacy-admin';

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
      jest.resetModules();
    }
  });

  it('filters audit events for admin users', async () => {
    const token = await adminToken();
    const res = await apiFetch('/admin/audit?status=retry_required&limit=10', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.count).toBe(1);
    expect(mockAuditLogs.getRecent).toHaveBeenCalledWith(10, {
      status: 'retry_required',
      eventType: undefined,
    });
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
      amount: '2.5',
      retryable: true,
    });
    expect(body.spendIntent.transaction.to).toBe(process.env.TOKEN_CONTRACT_ADDRESS);
    expect(body.spendIntent.transaction.from).toBe(linkedWallet.address);
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
});
