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

type AuditEvent = {
  id?: string;
  event_type: string;
  actor_type: string;
  actor_id?: string | null;
  target_type?: string | null;
  target_id?: string | null;
  status: string;
  metadata?: Record<string, unknown>;
  created_at: string;
};

type ReconciliationReport = {
  id?: string;
  status: string;
  checked_count: number;
  matched_count: number;
  mismatch_count: number;
  created_at: string;
};

type ReadinessCheck = {
  key: string;
  label: string;
  status: 'pass' | 'fail' | 'warn';
  message: string;
};

type ReadinessResponse = {
  status: 'ready' | 'ready_with_warnings' | 'not_ready';
  failedCount: number;
  warningCount: number;
  checks: ReadinessCheck[];
};

type PilotMetrics = {
  windowHours: number;
  totalEvents: number;
  lastEventAt: string | null;
  awards: {
    completed: number;
    notEligible: number;
    duplicates: number;
    failures: number;
  };
  spends: {
    completed: number;
    custodialRecorded: number;
    custodialIntentsCreated: number;
    retryRequired: number;
    failures: number;
  };
  operations: {
    warnings: number;
    errors: number;
    retryRequired: number;
    deliveredAlerts: number;
    skippedAlerts: number;
    reconciliationRuns: number;
  };
};

interface AdminDashboardProps {
  baseUrl: string;
  externalToken?: string;
  section: 'rules' | 'monitoring';
}

export default function AdminDashboard({ baseUrl, externalToken, section }: AdminDashboardProps) {
  const [token, setToken] = useState<string | null>(externalToken ?? null);
  const [username, setUsername] = useState('');
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
  const [auditStatus, setAuditStatus] = useState('retry_required');
  const [auditEvents, setAuditEvents] = useState<AuditEvent[]>([]);
  const [auditFeedback, setAuditFeedback] = useState('');
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [reconciliationReports, setReconciliationReports] = useState<ReconciliationReport[]>([]);
  const [reconciliationFeedback, setReconciliationFeedback] = useState('');
  const [runningReconciliation, setRunningReconciliation] = useState(false);
  const [readiness, setReadiness] = useState<ReadinessResponse | null>(null);
  const [readinessFeedback, setReadinessFeedback] = useState('');
  const [testingAlert, setTestingAlert] = useState(false);
  const [alertTestFeedback, setAlertTestFeedback] = useState('');
  const [exportingEvidence, setExportingEvidence] = useState(false);
  const [pilotMetrics, setPilotMetrics] = useState<PilotMetrics | null>(null);
  const [pilotMetricsFeedback, setPilotMetricsFeedback] = useState('');
  const [healthStatus, setHealthStatus] = useState('Unknown');

  async function adminRequest(path: string, options?: RequestInit) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
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
        body: JSON.stringify({ email: username, password }),
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
      const nextRules = data.rules.rules;
      setRules(nextRules);
      setOffPeakRate(String(nextRules.offPeakCharging.tokensPerKWh));
      setV2gRate(String(nextRules.v2gDischarge.tokensPerKWh));
      setOffPeakEnabled(nextRules.offPeakCharging.enabled);
      setV2gEnabled(nextRules.v2gDischarge.enabled);
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
      const nextWindows = data.windows ?? {};
      setOffPeakWindowsState(nextWindows);
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

  async function loadAuditEvents(status = auditStatus) {
    setLoadingAudit(true);
    setAuditFeedback('');
    try {
      const params = new URLSearchParams({ limit: '25' });
      if (status) params.set('status', status);
      const res = await adminRequest(`/admin/audit?${params.toString()}`);
      const data = await res.json();
      if (!res.ok) {
        setAuditFeedback(data?.message || data?.error || 'Failed to load audit events');
        return;
      }
      setAuditEvents(data.events ?? []);
    } catch (err) {
      setAuditFeedback(err instanceof Error ? err.message : String(err));
    } finally {
      setLoadingAudit(false);
    }
  }

  async function loadReconciliationReports() {
    setReconciliationFeedback('');
    try {
      const res = await adminRequest('/admin/reconciliation?limit=5');
      const data = await res.json();
      if (!res.ok) {
        setReconciliationFeedback(data?.message || data?.error || 'Failed to load reconciliation reports');
        return;
      }
      setReconciliationReports(data.reports ?? []);
    } catch (err) {
      setReconciliationFeedback(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadReadiness() {
    setReadinessFeedback('');
    try {
      const res = await adminRequest('/admin/readiness');
      const data = await res.json();
      if (!res.ok && !data?.checks) {
        setReadinessFeedback(data?.message || data?.error || 'Failed to load readiness checks');
        return;
      }
      setReadiness(data);
    } catch (err) {
      setReadinessFeedback(err instanceof Error ? err.message : String(err));
    }
  }

  async function loadPilotMetrics() {
    setPilotMetricsFeedback('');
    try {
      const res = await adminRequest('/admin/pilot-metrics?hours=24');
      const data = await res.json();
      if (!res.ok) {
        setPilotMetricsFeedback(data?.message || data?.error || 'Failed to load pilot metrics');
        return;
      }
      setPilotMetrics(data.metrics ?? null);
    } catch (err) {
      setPilotMetricsFeedback(err instanceof Error ? err.message : String(err));
    }
  }

  async function checkHealth() {
    setHealthStatus('Checking...');
    try {
      const res = await adminRequest('/ingest/health', { method: 'GET' });
      if (!res.ok) {
        setHealthStatus(`Unhealthy (${res.status})`);
        return;
      }
      const data = await res.json();
      setHealthStatus(`Online (${data.status})`);
    } catch (err) {
      setHealthStatus(`Offline (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  async function sendTestAlert() {
    setTestingAlert(true);
    setAlertTestFeedback('');
    try {
      const res = await adminRequest('/admin/alerts/test', { method: 'POST' });
      const data = await res.json();
      if (!res.ok) {
        setAlertTestFeedback(data?.message || data?.error || 'Failed to send test alert');
        return;
      }
      setAlertTestFeedback(data?.message || 'Test alert request recorded.');
      await loadAuditEvents();
      await loadReadiness();
      await loadPilotMetrics();
    } catch (err) {
      setAlertTestFeedback(err instanceof Error ? err.message : String(err));
    } finally {
      setTestingAlert(false);
    }
  }

  async function downloadEvidencePack() {
    setExportingEvidence(true);
    setReadinessFeedback('');
    try {
      const res = await adminRequest('/admin/evidence-pack');
      const data = await res.json();
      if (!res.ok) {
        setReadinessFeedback(data?.message || data?.error || 'Failed to export evidence pack');
        return;
      }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `neverflat-trl7-evidence-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      setReadinessFeedback(err instanceof Error ? err.message : String(err));
    } finally {
      setExportingEvidence(false);
    }
  }

  async function runReconciliation() {
    setRunningReconciliation(true);
    setReconciliationFeedback('');
    try {
      const res = await adminRequest('/admin/reconciliation/run', {
        method: 'POST',
        body: JSON.stringify({ limit: 500 }),
      });
      const data = await res.json();
      if (!res.ok) {
        setReconciliationFeedback(data?.message || data?.error || 'Failed to run reconciliation');
        return;
      }
      setReconciliationFeedback(`Reconciliation complete: ${data.report?.status || 'unknown'}`);
      await loadReconciliationReports();
      await loadAuditEvents();
      await loadReadiness();
      await loadPilotMetrics();
    } catch (err) {
      setReconciliationFeedback(err instanceof Error ? err.message : String(err));
    } finally {
      setRunningReconciliation(false);
    }
  }

  function updateCountrySlots(code: string, getNextSlots: (slots: TimeRange[]) => TimeRange[]) {
    setOffPeakWindowsState(prev => ({
      ...prev,
      [code]: getNextSlots(prev[code] ?? []),
    }));
  }

  function addSlot(code: string) {
    updateCountrySlots(code, slots => {
      if (slots.length >= MAX_SLOTS) return slots;
      return [...slots, { start: '00:00', end: '06:00' }];
    });
  }

  function removeSlot(code: string, idx: number) {
    updateCountrySlots(code, slots => slots.filter((_, i) => i !== idx));
  }

  function updateSlot(code: string, idx: number, field: 'start' | 'end', value: string) {
    updateCountrySlots(code, slots => slots.map((slot, i) => i === idx ? { ...slot, [field]: value } : slot));
  }

  useEffect(() => {
    if (token) {
      loadRules();
      loadOffPeakWindows();
      loadAuditEvents();
      loadReconciliationReports();
      loadReadiness();
      loadPilotMetrics();
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
      const nextRules = data.rules.rules;
      setRules(nextRules);
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
            Admin email
            <input type="email" value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" required />
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

  const offPeakRateValue = parseFloat(offPeakRate);
  const v2gRateValue = parseFloat(v2gRate);
  const showOffPeakPreview = offPeakEnabled && offPeakRate && !Number.isNaN(offPeakRateValue) && offPeakRateValue > 0;
  const showV2gPreview = v2gEnabled && v2gRate && !Number.isNaN(v2gRateValue) && v2gRateValue > 0;
  const offPeakCountryEntries = Object.entries(offPeakWindows).sort(([a], [b]) => a.localeCompare(b));
  const hasOffPeakCountries = offPeakCountryEntries.length > 0;
  const newCountryPreviewCode = newCountryCode.trim();
  const showNewCountryPreview = newCountryPreviewCode.length === 2;
  const latestReport = reconciliationReports[0];
  const readinessStatus = readiness?.status || 'not_ready';
  const isRulesTab = section === 'rules';

  return (
    <div className="admin-wrap">
      <div className="admin-header">
        <div>
          <h2>{isRulesTab ? 'Reward Rules' : 'Operational Monitoring'}</h2>
          <p className="subtle">
            {isRulesTab
              ? 'Changes apply immediately to all new CDRs. No restart required.'
              : 'Track readiness, alerts, audit events, and reconciliation checks.'}
          </p>
        </div>
        <button className="btn-ghost" onClick={logout}>Sign Out</button>
      </div>

      {section === 'rules' && rules && (
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
            {showOffPeakPreview && (
              <p className="subtle rule-preview">
                Preview: 10 kWh session → <strong>{Math.floor(10 * offPeakRateValue)} SPARKZ</strong>
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
            {showV2gPreview && (
              <p className="subtle rule-preview">
                Preview: 20 kWh session → <strong>{Math.floor(20 * v2gRateValue)} SPARKZ</strong>
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

      {section === 'rules' && (
        <>

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

        {!hasOffPeakCountries && (
          <p className="subtle" style={{ fontStyle: 'italic' }}>No countries configured yet.</p>
        )}

        {offPeakCountryEntries.map(([code, slots]) => (
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
          {showNewCountryPreview && (
            <p className="subtle" style={{ margin: 0 }}>Will add: {getCountryLabel(newCountryPreviewCode)}</p>
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
        </>
      )}

      {section === 'monitoring' && (
        <>
      <div className="admin-section-spacer" />

      <div className="action-card admin-rules-card">
        <div className="admin-rule-header">
          <h4>Operational Monitoring</h4>
          <button type="button" className="btn-ghost" onClick={() => { loadAuditEvents(); loadReconciliationReports(); loadReadiness(); loadPilotMetrics(); }}>
            Refresh
          </button>
        </div>

        <div className="admin-monitor-panel admin-api-health-panel">
          <div className="admin-rule-header">
            <h5 className="country-code-label">API Status</h5>
            <button type="button" className="btn-ghost" onClick={checkHealth}>
              Check Backend
            </button>
          </div>
          <label>
            API URL
            <input value={baseUrl} readOnly />
          </label>
          <p className="health">{healthStatus}</p>
        </div>

        <div className="admin-monitor-panel admin-readiness-panel">
          <div className="admin-rule-header">
            <h5 className="country-code-label">Pilot Readiness</h5>
            <div className="admin-inline-actions">
              <span className={`admin-status-pill admin-status-pill--${readinessStatus}`}>{readinessStatus.replace(/_/g, ' ')}</span>
              <button type="button" className="btn-ghost" onClick={sendTestAlert} disabled={testingAlert}>
                {testingAlert ? 'Sending...' : 'Test Alert'}
              </button>
              <button type="button" className="btn-ghost" onClick={downloadEvidencePack} disabled={exportingEvidence}>
                {exportingEvidence ? 'Exporting...' : 'Export Evidence'}
              </button>
            </div>
          </div>
          {readiness ? (
            <>
              <div className="admin-metric-grid admin-metric-grid--readiness">
                <div>
                  <strong>{readiness.checks.length}</strong>
                  <p className="subtle">Checks</p>
                </div>
                <div>
                  <strong>{readiness.failedCount}</strong>
                  <p className="subtle">Failures</p>
                </div>
                <div>
                  <strong>{readiness.warningCount}</strong>
                  <p className="subtle">Warnings</p>
                </div>
              </div>
              <div className="admin-readiness-list">
                {readiness.checks.map(check => (
                  <div className="admin-readiness-row" key={check.key}>
                    <span className={`admin-status-dot admin-status-dot--${check.status}`} aria-hidden="true" />
                    <div>
                      <strong>{check.label}</strong>
                      <p className="subtle">{check.message}</p>
                    </div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <p className="subtle">Readiness checks have not loaded yet.</p>
          )}
          {readinessFeedback && <p className="admin-error">{readinessFeedback}</p>}
          {alertTestFeedback && (
            <p className={alertTestFeedback.toLowerCase().includes('failed') ? 'admin-error' : 'admin-success'}>
              {alertTestFeedback}
            </p>
          )}
        </div>

        <div className="admin-monitor-panel admin-pilot-metrics-panel">
          <div className="admin-rule-header">
            <h5 className="country-code-label">Pilot Activity</h5>
            <span className="admin-status-pill">Last {pilotMetrics?.windowHours || 24}h</span>
          </div>
          {pilotMetrics ? (
            <>
              <div className="admin-metric-grid admin-metric-grid--pilot">
                <div>
                  <strong>{pilotMetrics.totalEvents}</strong>
                  <p className="subtle">Audit events</p>
                </div>
                <div>
                  <strong>{pilotMetrics.awards.completed}</strong>
                  <p className="subtle">Awards</p>
                </div>
                <div>
                  <strong>{pilotMetrics.spends.completed + pilotMetrics.spends.custodialRecorded}</strong>
                  <p className="subtle">Spends</p>
                </div>
                <div>
                  <strong>{pilotMetrics.operations.retryRequired}</strong>
                  <p className="subtle">Retries</p>
                </div>
              </div>
              <div className="admin-metric-grid admin-metric-grid--pilot-detail">
                <div>
                  <strong>{pilotMetrics.operations.errors}</strong>
                  <p className="subtle">Errors</p>
                </div>
                <div>
                  <strong>{pilotMetrics.operations.warnings}</strong>
                  <p className="subtle">Warnings</p>
                </div>
                <div>
                  <strong>{pilotMetrics.operations.deliveredAlerts}</strong>
                  <p className="subtle">Alerts sent</p>
                </div>
                <div>
                  <strong>{pilotMetrics.operations.reconciliationRuns}</strong>
                  <p className="subtle">Reconciliations</p>
                </div>
              </div>
              <p className="subtle">
                Last event: {pilotMetrics.lastEventAt ? new Date(pilotMetrics.lastEventAt).toLocaleString() : 'None recorded'}
              </p>
            </>
          ) : (
            <p className="subtle">Pilot metrics have not loaded yet.</p>
          )}
          {pilotMetricsFeedback && <p className="admin-error">{pilotMetricsFeedback}</p>}
        </div>

        <div className="admin-monitor-grid">
          <div className="admin-monitor-panel">
            <div className="admin-rule-header">
              <h5 className="country-code-label">Reconciliation</h5>
              <button type="button" className="btn-ghost" onClick={runReconciliation} disabled={runningReconciliation}>
                {runningReconciliation ? 'Running...' : 'Run Check'}
              </button>
            </div>
            {latestReport ? (
              <div className="admin-metric-grid">
                <div>
                  <span className={`admin-status-pill admin-status-pill--${latestReport.status}`}>{latestReport.status}</span>
                  <p className="subtle">{new Date(latestReport.created_at).toLocaleString()}</p>
                </div>
                <div>
                  <strong>{latestReport.checked_count}</strong>
                  <p className="subtle">Checked</p>
                </div>
                <div>
                  <strong>{latestReport.mismatch_count}</strong>
                  <p className="subtle">Mismatches</p>
                </div>
              </div>
            ) : (
              <p className="subtle">No reconciliation report has been stored yet.</p>
            )}
            {reconciliationFeedback && (
              <p className={reconciliationFeedback.toLowerCase().includes('failed') ? 'admin-error' : 'admin-success'}>
                {reconciliationFeedback}
              </p>
            )}
          </div>

          <div className="admin-monitor-panel">
            <div className="admin-rule-header">
              <h5 className="country-code-label">Audit Feed</h5>
              <select
                value={auditStatus}
                onChange={e => {
                  setAuditStatus(e.target.value);
                  loadAuditEvents(e.target.value);
                }}
              >
                <option value="retry_required">Retry required</option>
                <option value="warning">Warnings</option>
                <option value="error">Errors</option>
                <option value="">All statuses</option>
              </select>
            </div>
            {loadingAudit && <p className="subtle">Loading events...</p>}
            {auditFeedback && <p className="admin-error">{auditFeedback}</p>}
            {!loadingAudit && !auditEvents.length && !auditFeedback && (
              <p className="subtle">No matching audit events.</p>
            )}
            <div className="admin-audit-list">
              {auditEvents.slice(0, 8).map((event, idx) => (
                <div className="admin-audit-row" key={event.id || `${event.event_type}-${event.created_at}-${idx}`}>
                  <div>
                    <strong>{event.event_type}</strong>
                    <p className="subtle">
                      {new Date(event.created_at).toLocaleString()} | {event.actor_type}{event.actor_id ? `:${event.actor_id}` : ''}
                    </p>
                  </div>
                  <span className={`admin-status-pill admin-status-pill--${event.status}`}>{event.status}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
        </>
      )}
    </div>
  );
}
