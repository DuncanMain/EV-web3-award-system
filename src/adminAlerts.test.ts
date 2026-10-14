import {
  AdminAlertSettingsRepository,
  dispatchAdminAlert,
  getDefaultAdminAlertChannel,
  getDefaultAdminAlertRecipient,
  getAdminAlertConfiguration,
  loadAdminAlertSettings,
  shouldAlertAdminEvent,
  updateAdminAlertSettings,
  validateAdminAlertSettingsPatch,
} from './adminAlerts';

function row(recipientEmail = 'owner@example.com', channel = 'email') {
  return {
    id: 1,
    recipient_email: recipientEmail,
    channel,
    updated_at: '2026-10-14T00:00:00.000Z',
  };
}

class MemoryAlertSettings implements AdminAlertSettingsRepository {
  current = row();

  async get() {
    return { ...this.current };
  }

  async update(patch: { recipientEmail?: string; channel?: 'email' | 'webhook' | 'both' | 'disabled' }) {
    this.current = {
      ...this.current,
      ...(patch.recipientEmail ? { recipient_email: patch.recipientEmail } : {}),
      ...(patch.channel ? { channel: patch.channel } : {}),
      updated_at: '2026-10-14T00:01:00.000Z',
    };
    return { ...this.current };
  }
}

const event = {
  eventType: 'spend.failed',
  actorType: 'system',
  actorId: 'api',
  targetType: 'spend',
  targetId: 'operation-1',
  status: 'error',
  metadata: {
    amount: '1.00',
    password: 'must-not-be-sent',
    error: 'provider secret=must-not-be-sent',
    message: 'raw CDR must-not-be-sent',
    detail: 'secret diagnostic must-not-be-sent',
    cdr: { raw: 'must-not-be-sent' },
  },
};

describe('admin alert settings and provider transport', () => {
  const originalEnvironment = { ...process.env };

  beforeEach(() => {
    process.env = { ...originalEnvironment };
    delete process.env.SENDGRID_API_KEY;
    delete process.env.ADMIN_ALERT_EMAIL_FROM;
    delete process.env.ADMIN_ALERT_WEBHOOK_URL;
    jest.restoreAllMocks();
  });

  afterAll(() => {
    process.env = originalEnvironment;
  });

  it('validates only recipient and channel fields, normalizing the recipient', () => {
    expect(validateAdminAlertSettingsPatch({ recipientEmail: ' Owner@Example.com ', channel: 'email' }))
      .toEqual({ recipientEmail: 'owner@example.com', channel: 'email' });
    expect(() => validateAdminAlertSettingsPatch({ SENDGRID_API_KEY: 'secret' }))
      .toThrow('Unsupported alert setting field');
    expect(() => validateAdminAlertSettingsPatch({ recipientEmail: 'not-an-email' }))
      .toThrow('valid email address');
    expect(() => validateAdminAlertSettingsPatch({ channel: 'smtp' }))
      .toThrow('channel must be email');
  });

  it('starts fresh deployments on email while retaining a configured legacy webhook', () => {
    process.env.ADMIN_ALERT_RECIPIENT = 'Owner@Example.com';
    expect(getDefaultAdminAlertRecipient()).toBe('owner@example.com');
    expect(getDefaultAdminAlertChannel()).toBe('email');
    process.env.ADMIN_ALERT_WEBHOOK_URL = 'https://alerts.example.test/hook';
    expect(getDefaultAdminAlertChannel()).toBe('webhook');
    process.env.ADMIN_ALERT_CHANNEL = 'webhook';
    expect(getDefaultAdminAlertChannel()).toBe('webhook');
    delete process.env.ADMIN_ALERT_RECIPIENT;
    delete process.env.ADMIN_EMAIL;
    process.env.BEIA_ADMIN_EMAIL = 'BEIA.Owner@Example.com';
    expect(getDefaultAdminAlertRecipient()).toBe('beia.owner@example.com');
  });

  it('alerts on review-required financial events without recursively alerting alert audits', () => {
    expect(shouldAlertAdminEvent({ eventType: 'spend.recovery_review', status: 'requires_review' })).toBe(true);
    expect(shouldAlertAdminEvent({ eventType: 'reservation.recovery_review', status: 'warning' })).toBe(true);
    expect(shouldAlertAdminEvent({ eventType: 'admin_alert.delivery_failed', status: 'error' })).toBe(false);
    expect(shouldAlertAdminEvent({ eventType: 'audit.normal', status: 'requires_review' })).toBe(true);
    expect(shouldAlertAdminEvent({ eventType: 'award.completed', status: 'success' })).toBe(false);
  });

  it('does not recurse after a review-required alert delivery failure is audited', async () => {
    process.env.SENDGRID_API_KEY = 'provider-secret';
    process.env.ADMIN_ALERT_EMAIL_FROM = 'verified@example.com';
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(
      new Response('provider diagnostics', { status: 500 }),
    );
    const reviewEvent = {
      eventType: 'reservation.recovery_review',
      actorType: 'system',
      status: 'requires_review',
      targetType: 'reservation',
      targetId: 'reservation-1',
    } as const;

    expect(shouldAlertAdminEvent(reviewEvent)).toBe(true);
    const delivery = await dispatchAdminAlert(reviewEvent, new MemoryAlertSettings());
    expect(delivery.status).toBe('delivery_failed');
    expect(delivery.channels[0]).toMatchObject({ status: 'failed', httpStatus: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(shouldAlertAdminEvent({ eventType: 'admin_alert.delivery_failed', status: 'error' })).toBe(false);
  });

  it('persists the owner-controlled recipient and never exposes provider credentials', async () => {
    const store = new MemoryAlertSettings();
    const settings = await updateAdminAlertSettings({ recipientEmail: 'destination@example.com', channel: 'email' }, store);
    expect(settings).toMatchObject({ recipientEmail: 'destination@example.com', channel: 'email' });
    expect(await loadAdminAlertSettings(store)).toMatchObject({ recipientEmail: 'destination@example.com' });

    process.env.SENDGRID_API_KEY = 'provider-secret';
    process.env.ADMIN_ALERT_EMAIL_FROM = 'verified@example.com';
    const configuration = await getAdminAlertConfiguration(store);
    expect(configuration.email).toMatchObject({ configured: true, apiKeyConfigured: true, fromConfigured: true });
    expect(JSON.stringify(configuration)).not.toContain('provider-secret');
    expect(configuration.settings.recipientEmail).toBe('destination@example.com');
  });

  it('treats SendGrid HTTP 202 as provider acceptance and redacts sensitive metadata', async () => {
    process.env.SENDGRID_API_KEY = 'provider-secret';
    process.env.ADMIN_ALERT_EMAIL_FROM = 'verified@example.com';
    const discardBody = jest.fn().mockResolvedValue(undefined);
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      status: 202,
      ok: true,
      body: { cancel: discardBody },
    } as unknown as Response);
    const result = await dispatchAdminAlert(event, new MemoryAlertSettings());

    expect(result).toMatchObject({ status: 'sent', providerAccepted: true, partialFailure: false });
    expect(result.channels).toEqual([expect.objectContaining({
      channel: 'email',
      status: 'accepted',
      provider: 'sendgrid',
      httpStatus: 202,
      acceptanceMeaning: 'provider_accepted',
    })]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(discardBody).toHaveBeenCalledTimes(1);
    const [url, request] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.sendgrid.com/v3/mail/send');
    expect((request as RequestInit).redirect).toBe('manual');
    expect(new Headers((request as RequestInit).headers).get('authorization')).toBe('Bearer provider-secret');
    const body = JSON.parse(String((request as RequestInit).body));
    expect(body.personalizations[0].to[0].email).toBe('owner@example.com');
    expect(JSON.stringify(body)).not.toContain('must-not-be-sent');
    expect(JSON.stringify(body)).not.toContain('provider-secret');
  });

  it('marks both-channel settings incomplete until both providers are configured', async () => {
    const store = new MemoryAlertSettings();
    store.current = row('owner@example.com', 'both');
    process.env.ADMIN_ALERT_WEBHOOK_URL = 'https://alerts.example.test/hook';
    const configuration = await getAdminAlertConfiguration(store);
    expect(configuration).toMatchObject({
      canDeliver: false,
      configurationIssue: 'selected_channel_provider_incomplete',
      email: { configured: false },
      webhook: { configured: true },
    });
  });

  it('reports an unavailable provider without claiming delivery', async () => {
    const result = await dispatchAdminAlert(event, new MemoryAlertSettings());
    expect(result).toEqual({
      status: 'delivery_skipped',
      providerAccepted: false,
      partialFailure: false,
      channels: [{ channel: 'email', status: 'skipped', provider: 'sendgrid', reason: 'email_provider_not_configured' }],
    });
  });

  it('supports webhook compatibility while email is unconfigured', async () => {
    const store = new MemoryAlertSettings();
    store.current = row('owner@example.com', 'both');
    process.env.ADMIN_ALERT_WEBHOOK_URL = 'https://alerts.example.test/hook';
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    const result = await dispatchAdminAlert(event, store);

    expect(result.status).toBe('sent');
    expect(result.providerAccepted).toBe(true);
    expect(result.partialFailure).toBe(true);
    expect(result.channels).toEqual([
      expect.objectContaining({ channel: 'email', status: 'skipped', reason: 'email_provider_not_configured' }),
      expect.objectContaining({ channel: 'webhook', status: 'accepted', httpStatus: 204 }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports provider rejection or timeout as failed without leaking the response body', async () => {
    process.env.SENDGRID_API_KEY = 'provider-secret';
    process.env.ADMIN_ALERT_EMAIL_FROM = 'verified@example.com';
    jest.spyOn(global, 'fetch').mockResolvedValue(new Response('secret provider diagnostics', { status: 500 }));
    const failed = await dispatchAdminAlert(event, new MemoryAlertSettings());
    expect(failed).toMatchObject({ status: 'delivery_failed', providerAccepted: false });
    expect(failed.channels[0]).toMatchObject({ status: 'failed', httpStatus: 500, reason: 'non_success_response' });
    expect(JSON.stringify(failed)).not.toContain('secret provider diagnostics');

    jest.restoreAllMocks();
    jest.useFakeTimers();
    jest.spyOn(global, 'fetch').mockImplementation(async (_input, init) => await new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('provider request timed out')));
    }));
    const pending = dispatchAdminAlert(event, new MemoryAlertSettings());
    await jest.advanceTimersByTimeAsync(8_000);
    const timedOut = await pending;
    jest.useRealTimers();
    expect(timedOut.channels[0]).toMatchObject({ status: 'failed', reason: 'request_failed' });
    expect(JSON.stringify(timedOut)).not.toContain('provider request timed out');
  });
});
