import React, { FormEvent, useEffect, useState } from 'react';

type TimeRange = { start: string; end: string };
type OffPeakWindows = Record<string, TimeRange[]>;

const MAX_SLOTS = 6;
const regionNames = typeof Intl !== 'undefined' && typeof Intl.DisplayNames !== 'undefined'
  ? new Intl.DisplayNames(['en'], { type: 'region' })
  : null;

function getCountryName(code: string): string | null {
  const normalized = code.toUpperCase();
  const displayName = regionNames?.of(normalized);
  if (!displayName || displayName === normalized) {
    return null;
  }
  return displayName;
}

function getCountryLabel(code: string): string {
  const normalized = code.toUpperCase();
  const name = getCountryName(normalized);
  return name ? `${normalized} (${name})` : normalized;
}

function isValidCdrCountryCode(code: string): boolean {
  if (!/^[A-Z]{2}$/.test(code)) return false;
  if (!regionNames) return true;
  return getCountryName(code) !== null;
}

interface RuleConfig {
  offPeakCharging: { enabled: boolean; tokensPerKWh: number; description: string };
  v2gDischarge: { enabled: boolean; tokensPerKWh: number; description: string };
}

interface AdminDashboardProps {
  baseUrl: string;
  apiKey: string;
  externalToken?: string;
}

export default function AdminDashboard({ baseUrl, apiKey, externalToken }: AdminDashboardProps) {
  const [token, setToken] = useState<string | null>(externalToken ?? null);
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [rules, setRules] = useState<RuleConfig | null>(null);
  const [offPeakRate, setOffPeakRate] = useState('');
  const [v2gRate, setV2gRate] = useState('');
  const [offPeakEnabled, setOffPeakEnabled] = useState(true);
  const [v2gEnabled, setV2gEnabled] = useState(true);
  const [feedback, setFeedback] = useState('');
  const [feedbackKind, setFeedbackKind] = useState<'success' | 'error' | 'idle'>('idle');
  const [saving, setSaving] = useState(false);

  // Off-peak windows state
  const [offPeakWindows, setOffPeakWindowsState] = useState<OffPeakWindows>({});
  const [newCountryCode, setNewCountryCode] = useState('');
  const [windowsFeedback, setWindowsFeedback] = useState('');
  const [windowsFeedbackKind, setWindowsFeedbackKind] = useState<'success' | 'error' | 'idle'>('idle');
  const [savingWindows, setSavingWindows] = useState(false);

  async function adminRequest(path: string, options?: RequestInit) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (apiKey.trim()) headers['X-API-Key'] = apiKey.trim();
    if (token) headers['Authorization'] = `Bearer ${token}`;
    return fetch(`${baseUrl}${path}`, { ...options, headers: { ...headers, ...(options?.headers || {}) } });
  }

  async function login(e: FormEvent) {
    e.preventDefault();
    setLoginError('');
    try {
      const res = await fetch(`${baseUrl}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLoginError(data?.message || 'Invalid credentials');
        return;
      }
      setToken(data.token);
      setPassword('');
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : String(err));
    }
  }

  async function logout() {
    if (token && !externalToken) {
      await adminRequest('/admin/logout', { method: 'POST' }).catch(() => {});
    }
    if (!externalToken) setToken(null);
    setRules(null);
  }

  async function loadRules() {
    try {
      const res = await adminRequest('/admin/rules');
      const data = await res.json();
      if (!res.ok) return;
      setRules(data.rules.rules);
      setOffPeakRate(String(data.rules.rules.offPeakCharging.tokensPerKWh));
      setV2gRate(String(data.rules.rules.v2gDischarge.tokensPerKWh));
      setOffPeakEnabled(data.rules.rules.offPeakCharging.enabled);
      setV2gEnabled(data.rules.rules.v2gDischarge.enabled);
    } catch (err) {
      // silently ignore
    }
  }

  async function loadOffPeakWindows() {
    try {
      const res = await adminRequest('/admin/off-peak');
      const data = await res.json();
      if (!res.ok) return;
      setOffPeakWindowsState(data.windows ?? {});
    } catch {
      // silently ignore
    }
  }

  async function saveOffPeakWindows() {
    setSavingWindows(true);
    setWindowsFeedback('');
    try {
      const res = await adminRequest('/admin/off-peak', {
        method: 'PUT',
        body: JSON.stringify({ windows: offPeakWindows }),
      });
      const data = await res.json();
      if (!res.ok) {
        setWindowsFeedbackKind('error');
        setWindowsFeedback(data?.message || 'Failed to save off-peak config');
        return;
      }
      setOffPeakWindowsState(data.windows ?? {});
      setWindowsFeedbackKind('success');
      setWindowsFeedback('Off-peak config saved. New CDRs will use these windows immediately.');
    } catch (err) {
      setWindowsFeedbackKind('error');
      setWindowsFeedback(err instanceof Error ? err.message : String(err));
    } finally {
      setSavingWindows(false);
    }
  }

  function addCountry() {
    const code = newCountryCode.trim().toUpperCase();
    if (!isValidCdrCountryCode(code)) {
      setWindowsFeedbackKind('error');
      setWindowsFeedback('Country code must be a valid ISO alpha-2 CDR country code (e.g. DE, ES, RO).');
      return;
    }
    if (offPeakWindows[code]) {
      setWindowsFeedbackKind('error');
      setWindowsFeedback(`Country "${code}" already exists`);
      return;
    }
    setWindowsFeedbackKind('idle');
    setWindowsFeedback('');
    setOffPeakWindowsState(prev => ({ ...prev, [code]: [{ start: '22:00', end: '06:00' }] }));
    setNewCountryCode('');
  }

  function removeCountry(code: string) {
    setOffPeakWindowsState(prev => {
      const next = { ...prev };
      delete next[code];
      return next;
    });
    setWindowsFeedback('');
  }

  function addSlot(code: string) {
    setOffPeakWindowsState(prev => {
      const slots = prev[code] ?? [];
      if (slots.length >= MAX_SLOTS) return prev;
      return { ...prev, [code]: [...slots, { start: '00:00', end: '06:00' }] };
    });
  }

  function removeSlot(code: string, idx: number) {
    setOffPeakWindowsState(prev => {
      const slots = (prev[code] ?? []).filter((_, i) => i !== idx);
      return { ...prev, [code]: slots };
    });
  }

  function updateSlot(code: string, idx: number, field: 'start' | 'end', value: string) {
    setOffPeakWindowsState(prev => {
      const slots = (prev[code] ?? []).map((s, i) => i === idx ? { ...s, [field]: value } : s);
      return { ...prev, [code]: slots };
    });
  }

  useEffect(() => {
    if (token) {
      loadRules();
      loadOffPeakWindows();
    }
  }, [token]);

  async function saveRules(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setFeedback('');
    try {
      const res = await adminRequest('/admin/rules', {
        method: 'PUT',
        body: JSON.stringify({
          offPeakChargingTokensPerKWh: parseFloat(offPeakRate),
          v2gDischargeTokensPerKWh: parseFloat(v2gRate),
          offPeakChargingEnabled: offPeakEnabled,
          v2gDischargeEnabled: v2gEnabled,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFeedbackKind('error');
        setFeedback(data?.message || 'Failed to save rules');
        return;
      }
      setRules(data.rules.rules);
      setFeedbackKind('success');
      setFeedback('Rules updated successfully. New CDRs will use these rates immediately.');
    } catch (err) {
      setFeedbackKind('error');
      setFeedback(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  if (!token) {
    return (
      <div className="admin-login-wrap">
        <form className="action-card admin-login-card" onSubmit={login}>
          <h3>Admin Login</h3>
          <p className="subtle">Access is restricted to authorised users.</p>
          <label>
            Username
            <input value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" required />
          </label>
          <label>
            Password
            <input
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoComplete="current-password"
              required
            />
          </label>
          {loginError && <p className="admin-error">{loginError}</p>}
          <button type="submit">Sign In</button>
        </form>
      </div>
    );
  }

  return (
    <div className="admin-wrap">
      <div className="admin-header">
        <div>
          <h2>Reward Rules</h2>
          <p className="subtle">Changes apply immediately to all new CDRs. No restart required.</p>
        </div>
        <button className="btn-ghost" onClick={logout}>Sign Out</button>
      </div>

      {rules && (
        <form className="action-card admin-rules-card" onSubmit={saveRules}>
          <div className="admin-rule-group">
            <div className="admin-rule-header">
              <h4>Off-Peak Charging</h4>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={offPeakEnabled}
                  onChange={e => setOffPeakEnabled(e.target.checked)}
                />
                {offPeakEnabled ? 'Enabled' : 'Disabled'}
              </label>
            </div>
            <p className="subtle">Reward rate for charging sessions during off-peak hours.</p>
            <label>
              Tokens per kWh
              <div className="input-suffix-wrap">
                <input
                  type="number"
                  min="0"
                  step="0.001"
                  value={offPeakRate}
                  onChange={e => setOffPeakRate(e.target.value)}
                  disabled={!offPeakEnabled}
                  required
                />
                <span className="input-suffix">SPARKZ / kWh</span>
              </div>
            </label>
            {offPeakEnabled && offPeakRate && !isNaN(parseFloat(offPeakRate)) && parseFloat(offPeakRate) > 0 && (
              <p className="subtle rule-preview">
                Preview: 10 kWh session → <strong>{Math.floor(10 * parseFloat(offPeakRate))} SPARKZ</strong>
              </p>
            )}
          </div>

          <div className="admin-rule-divider" />

          <div className="admin-rule-group">
            <div className="admin-rule-header">
              <h4>V2G Discharge</h4>
              <label className="toggle-label">
                <input
                  type="checkbox"
                  checked={v2gEnabled}
                  onChange={e => setV2gEnabled(e.target.checked)}
                />
                {v2gEnabled ? 'Enabled' : 'Disabled'}
              </label>
            </div>
            <p className="subtle">Reward rate for vehicle-to-grid energy discharge sessions.</p>
            <label>
              Tokens per kWh
              <div className="input-suffix-wrap">
                <input
                  type="number"
                  min="0"
                  step="0.001"
                  value={v2gRate}
                  onChange={e => setV2gRate(e.target.value)}
                  disabled={!v2gEnabled}
                  required
                />
                <span className="input-suffix">SPARKZ / kWh</span>
              </div>
            </label>
            {v2gEnabled && v2gRate && !isNaN(parseFloat(v2gRate)) && parseFloat(v2gRate) > 0 && (
              <p className="subtle rule-preview">
                Preview: 20 kWh session → <strong>{Math.floor(20 * parseFloat(v2gRate))} SPARKZ</strong>
              </p>
            )}
          </div>

          {feedback && (
            <p className={feedbackKind === 'success' ? 'admin-success' : 'admin-error'}>{feedback}</p>
          )}

          <button type="submit" disabled={saving}>
            {saving ? 'Saving...' : 'Save Rules'}
          </button>
        </form>
      )}

      {/* ── Off-Peak Time Windows ─────────────────────────────────────────── */}
      <div className="admin-section-spacer" />

      <div className="action-card admin-rules-card">
        <div className="admin-rule-header">
          <h4>Off-Peak Time Windows</h4>
        </div>
        <p className="subtle">
          Define when off-peak hours apply per country. Up to {MAX_SLOTS} time slots per country.
          Overnight ranges (e.g. 22:00–06:00) are supported automatically.
        </p>
        <p className="subtle">Country codes must match CDR ISO alpha-2 country codes.</p>

        {Object.keys(offPeakWindows).length === 0 && (
          <p className="subtle" style={{ fontStyle: 'italic' }}>No countries configured yet.</p>
        )}

        {Object.entries(offPeakWindows).sort(([a], [b]) => a.localeCompare(b)).map(([code, slots]) => (
          <div key={code} className="admin-rule-group off-peak-country-group">
            <div className="admin-rule-header">
              <h5 className="country-code-label">{getCountryLabel(code)}</h5>
              <button
                type="button"
                className="btn-ghost btn-danger-ghost"
                onClick={() => removeCountry(code)}
              >
                Remove Country
              </button>
            </div>

            {slots.map((slot, idx) => (
              <div key={idx} className="off-peak-slot-row">
                <label className="slot-label">
                  Start
                  <input
                    type="time"
                    value={slot.start}
                    onChange={e => updateSlot(code, idx, 'start', e.target.value)}
                    required
                  />
                </label>
                <span className="slot-separator">→</span>
                <label className="slot-label">
                  End
                  <input
                    type="time"
                    value={slot.end}
                    onChange={e => updateSlot(code, idx, 'end', e.target.value)}
                    required
                  />
                </label>
                {slots.length > 1 && (
                  <button
                    type="button"
                    className="btn-ghost btn-danger-ghost slot-remove"
                    onClick={() => removeSlot(code, idx)}
                    aria-label={`Remove slot ${idx + 1} for ${code}`}
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}

            {slots.length < MAX_SLOTS && (
              <button
                type="button"
                className="btn-ghost"
                style={{ marginTop: '0.5rem' }}
                onClick={() => addSlot(code)}
              >
                + Add Slot
              </button>
            )}
            {slots.length >= MAX_SLOTS && (
              <p className="subtle" style={{ fontSize: '0.8rem' }}>Maximum of {MAX_SLOTS} slots reached.</p>
            )}

            <div className="admin-rule-divider" />
          </div>
        ))}

        {/* Add new country */}
        <div className="off-peak-add-country">
          <label className="slot-label" style={{ flexDirection: 'row', alignItems: 'center', gap: '0.5rem' }}>
            <span style={{ minWidth: '8rem' }}>Add Country</span>
            <input
              type="text"
              placeholder="e.g. FR"
              maxLength={2}
              value={newCountryCode}
              onChange={e => setNewCountryCode(e.target.value.toUpperCase())}
              style={{ width: '5rem', textTransform: 'uppercase' }}
            />
          </label>
          {newCountryCode.trim().length === 2 && (
            <p className="subtle" style={{ margin: 0 }}>Will add: {getCountryLabel(newCountryCode.trim())}</p>
          )}
          <button
            type="button"
            className="btn-ghost"
            onClick={addCountry}
          >
            Add Country
          </button>
        </div>

        {windowsFeedback && (
          <p className={windowsFeedbackKind === 'success' ? 'admin-success' : 'admin-error'}>{windowsFeedback}</p>
        )}

        <button
          type="button"
          onClick={saveOffPeakWindows}
          disabled={savingWindows}
          style={{ marginTop: '1rem' }}
        >
          {savingWindows ? 'Saving...' : 'Save Off-Peak Config'}
        </button>
      </div>
    </div>
  );
}
