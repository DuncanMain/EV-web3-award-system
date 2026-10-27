import { FormEvent, useEffect, useState } from 'react';

type AlertChannel = 'email' | 'webhook' | 'both' | 'disabled';

type AlertSettings = {
  recipientEmail: string;
  channel: AlertChannel;
  updatedAt?: string;
};

type AlertDelivery = {
  email?: {
    configured?: boolean;
    provider?: string;
    apiKeyConfigured?: boolean;
    fromConfigured?: boolean;
    acceptedStatus?: number;
    acceptanceMeaning?: string;
  };
  webhook?: { configured?: boolean };
  canDeliver?: boolean;
  configurationIssue?: string | null;
  deliveryNote?: string;
};

type AdminAlertSettingsResponse = {
  status?: string;
  message?: string;
  settings?: AlertSettings;
  delivery?: AlertDelivery;
  error?: string;
};

type Feedback = { kind: 'success' | 'error' | 'idle'; message: string };

interface AdminAlertSettingsProps {
  baseUrl: string;
  adminToken: string;
}

function responseError(data: AdminAlertSettingsResponse): string {
  return data.message || data.error || 'Alert settings request failed';
}

function providerLabel(delivery?: AlertDelivery): string {
  if (!delivery?.email?.configured) return 'Email provider is not configured';
  return 'Email provider is configured';
}

export default function AdminAlertSettings({ baseUrl, adminToken }: AdminAlertSettingsProps) {
  const [settings, setSettings] = useState<AlertSettings | null>(null);
  const [delivery, setDelivery] = useState<AlertDelivery | null>(null);
  const [recipientEmail, setRecipientEmail] = useState('');
  const [channel, setChannel] = useState<AlertChannel>('email');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>({ kind: 'idle', message: '' });
  const isDirty = Boolean(settings)
    && (recipientEmail.trim().toLowerCase() !== settings?.recipientEmail
      || channel !== settings?.channel);

  async function request(path: string, options?: RequestInit): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${adminToken}`,
        ...(options?.headers || {}),
      },
    });
  }

  async function loadSettings(clearFeedback = true) {
    setLoading(true);
    if (clearFeedback) setFeedback({ kind: 'idle', message: '' });
    try {
      const response = await request('/admin/alerts/settings');
      const data = await response.json() as AdminAlertSettingsResponse;
      if (!response.ok || data.status !== 'ok' || !data.settings) throw new Error(responseError(data));
      setSettings(data.settings);
      setRecipientEmail(data.settings.recipientEmail);
      setChannel(data.settings.channel);
      setDelivery(data.delivery || null);
    } catch (error) {
      setFeedback({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadSettings();
  }, [baseUrl, adminToken]);

  async function saveSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSaving(true);
    setFeedback({ kind: 'idle', message: '' });
    try {
      const response = await request('/admin/alerts/settings', {
        method: 'PATCH',
        body: JSON.stringify({ recipientEmail, channel }),
      });
      const data = await response.json() as AdminAlertSettingsResponse;
      if (!response.ok || data.status !== 'ok' || !data.settings) throw new Error(responseError(data));
      setSettings(data.settings);
      setRecipientEmail(data.settings.recipientEmail);
      setChannel(data.settings.channel);
      setDelivery(data.delivery || null);
      setFeedback({ kind: 'success', message: 'Alert destination saved. Provider credentials remain server-side.' });
    } catch (error) {
      setFeedback({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setSaving(false);
    }
  }

  async function sendTest() {
    if (isDirty) {
      setFeedback({ kind: 'error', message: 'Save the alert destination before sending a test; tests use the saved settings.' });
      return;
    }
    setTesting(true);
    setFeedback({ kind: 'idle', message: '' });
    try {
      const response = await request('/admin/alerts/test', { method: 'POST', body: '{}' });
      const data = await response.json() as AdminAlertSettingsResponse & { deliveryStatus?: string; providerAccepted?: boolean };
      if (!response.ok) throw new Error(responseError(data));
      const accepted = data.providerAccepted === true || data.deliveryStatus === 'sent_or_queued';
      setFeedback({
        kind: accepted ? 'success' : 'error',
        message: accepted
          ? 'Alert provider accepted the test. Inbox delivery is not confirmed by this response.'
          : data.message || 'The alert test was recorded without provider acceptance.',
      });
      await loadSettings(false);
    } catch (error) {
      setFeedback({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setTesting(false);
    }
  }

  return (
    <section className="action-card admin-rules-card" aria-labelledby="admin-alert-settings-heading">
      <div className="section-heading-row">
        <div>
          <p className="label">Operations</p>
          <h2 id="admin-alert-settings-heading">Alert destination</h2>
          <p className="subtle">Choose the owner recipient and delivery channel. Provider credentials stay in the server environment.</p>
        </div>
        {delivery && (
          <span className={`admin-status-pill admin-status-pill--${delivery.canDeliver ? 'pass' : 'warn'}`}>
            {delivery.canDeliver ? 'Configured' : 'Needs provider setup'}
          </span>
        )}
      </div>

      {loading && <p className="subtle">Loading alert settings…</p>}
      {!loading && (
        <form onSubmit={saveSettings}>
          <label>
            Recipient email
            <input
              type="email"
              value={recipientEmail}
              onChange={event => setRecipientEmail(event.target.value)}
              autoComplete="email"
              required
            />
          </label>
          <label>
            Delivery channel
            <select value={channel} onChange={event => setChannel(event.target.value as AlertChannel)}>
              <option value="email">Email</option>
              <option value="both">Email and webhook</option>
              <option value="webhook">Webhook</option>
              <option value="disabled">Disabled</option>
            </select>
          </label>
          <div className="actions-row">
            <button type="submit" disabled={saving || testing}>{saving ? 'Saving…' : 'Save destination'}</button>
            <button type="button" className="btn-ghost" onClick={() => { void sendTest(); }} disabled={saving || testing || channel === 'disabled' || isDirty}>
              {testing ? 'Testing…' : 'Send test alert'}
            </button>
          </div>
          {isDirty && <p className="admin-error" role="status">Save the changed destination before testing; the test uses the saved recipient and channel.</p>}
        </form>
      )}

      {delivery && (
        <div className="subtle" role="status">
          <p><strong>{providerLabel(delivery)}</strong>{delivery.email?.provider ? ` · ${delivery.email.provider}` : ''}</p>
          <p>Webhook: {delivery.webhook?.configured ? 'configured' : 'not configured'} · Current channel: {settings?.channel || channel}</p>
          {delivery.configurationIssue === 'selected_channel_provider_incomplete' && (
            <p className="admin-error">Both channels are selected, but both providers must be configured before delivery is complete.</p>
          )}
          <p>{delivery.deliveryNote === 'provider_acceptance_is_not_inbox_delivery'
            ? 'A provider acceptance response does not confirm inbox delivery.'
            : 'Delivery status is reported by the configured provider.'}</p>
        </div>
      )}
      {feedback.message && <p className={feedback.kind === 'success' ? 'admin-success' : 'admin-error'} role="status">{feedback.message}</p>}
    </section>
  );
}
