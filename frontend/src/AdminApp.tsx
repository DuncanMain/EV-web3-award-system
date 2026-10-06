import React, { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import AdminDashboard from './AdminDashboard';
import AuthGate from './AuthGate';
import { shouldReleaseSpendRequest } from '../../src/auditPresentation';

type WalletHistoryItem = {
  type: 'award' | 'spend';
  uid?: string | null;
  walletAddress?: string | null;
  walletName?: string | null;
  amount: string;
  txHash?: string;
  timestamp?: string;
  awardType?: string;
};

type WalletResponse = {
  status: string;
  uid: string;
  emaid?: string;
  walletAddress: string;
  treasuryAddress: string | null;
  tokenContractAddress: string;
  balance: string;
  balanceStatus?: 'confirmed' | 'unavailable';
  balanceSource?: 'chain' | 'database' | 'none';
  balanceWarning?: string;
  totalAwarded: string;
  totalSpent: string;
  history: WalletHistoryItem[];
};

type ApiFeedback = {
  kind: 'success' | 'error' | 'idle';
  message: string;
};

function spendPendingMessage(data: Record<string, any>): string {
  if (data?.preflightFailure) {
    return 'The token network could not be read, so no SPARKZ were spent. Wait for the network to recover, then retry this same spend.';
  }
  if (data?.requiresReview) {
    return 'The managed-wallet approval needs chain recovery. No spend transaction was recorded; retry this same spend after the network recovers.';
  }
  if (data?.txHash) {
    return 'A spend transaction is awaiting confirmation. Do not create a new spend; retry this same request to recover its result.';
  }
  return 'The spend has not been confirmed. No new request will be created; retry this same spend when the network is available.';
}

type AdminAwardRequest = {
  SessionID: string;
  ProviderID: string;
  cdr_token: { contract_id: string };
  EVSEID: string;
  StartTime: string;
  EndTime: string;
  Energy: string;
  EnergyDirection: 'CHARGE' | 'DISCHARGE';
};

type AdminSpendRequest = {
  uid: string;
  amount: number;
  sessionId: string;
  providerId: string;
  idempotencyKey: string;
};

type AdminOperation = {
  id: string;
  operationKey: string;
  operationType: 'award' | 'spend';
  eMAID: string;
  walletAddress: string;
  amount: string;
  sessionId: string | null;
  providerId: string | null;
  reservationId: string | null;
  status: string;
  movementOutcome: string;
  transactionHash: string | null;
  errorMessage: string | null;
  submittedAt: string | null;
  confirmedAt: string | null;
  projectedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
  nextAction: string;
  recovery?: {
    eligible: boolean;
    reason: string;
    reasonCode?: string;
    code?: string;
  };
};

type AdminOperationsResponse = {
  status?: string;
  code?: string;
  message?: string;
  count?: number;
  total?: number;
  limit?: number;
  offset?: number;
  hasMore?: boolean;
  nextOffset?: number | null;
  operations?: AdminOperation[];
};

type AdminEmaidFilter = 'current' | 'all';

type AdminRecoveryFeedback = {
  operationKey: string;
  kind: 'success' | 'error' | 'pending' | 'attention';
  message: string;
};

type AdminRecoveryResponse = {
  status?: string;
  code?: string;
  message?: string;
  error?: string;
  recoveryStatus?: string;
  projectionStatus?: string;
  receiptStatus?: string;
  recovered?: boolean;
  audit?: { status?: string; message?: string };
};

function recoveryFeedbackForResponse(
  response: Response,
  data: AdminRecoveryResponse,
  operation: AdminOperation,
): AdminRecoveryFeedback {
  const recoveryStatus = data.recoveryStatus || data.status;
  const projectionStatus = data.projectionStatus || 'unknown';
  const receiptStatus = data.receiptStatus || 'unknown';
  const detail = `Projection: ${projectionStatus}; receipt: ${receiptStatus}.`;

  if (recoveryStatus === 'completed_audit_pending') {
    return {
      operationKey: operation.operationKey,
      kind: 'attention',
      message: `${data.message || 'Recovery completed, but its outcome audit needs attention.'} ${detail}`,
    };
  }

  const receiptPending = ['pending', 'missing', 'not_attempted', 'not_created'].includes(receiptStatus);
  const recoveryPending = response.status === 202
    || recoveryStatus === 'pending'
    || recoveryStatus === 'audit_pending'
    || projectionStatus === 'pending'
    || receiptPending;
  if (recoveryPending && recoveryStatus !== 'blocked') {
    return {
      operationKey: operation.operationKey,
      kind: 'pending',
      message: `${data.message || 'Recovery is still pending confirmation. Keep the same operation key and do not create a new operation.'} ${detail}`,
    };
  }

  if (response.ok && data.status === 'ok' && recoveryStatus === 'completed' && projectionStatus === 'projected') {
    return {
      operationKey: operation.operationKey,
      kind: 'success',
      message: `${data.message || 'Saved operation completed; no replacement transfer was submitted.'} ${detail}`,
    };
  }

  return {
    operationKey: operation.operationKey,
    kind: 'error',
    message: data.message || data.error || 'Saved operation recovery was blocked.',
  };
}

type AdminTab = 'overview' | 'identities' | 'transactions' | 'rules' | 'audit' | 'health';

const adminNavItems: Array<{ id: AdminTab; label: string; description: string }> = [
  { id: 'overview', label: 'Overview', description: 'Pilot activity and readiness' },
  { id: 'identities', label: 'eMAIDs & balances', description: 'Look up ownership and balances' },
  { id: 'transactions', label: 'Transactions', description: 'Run controlled award and spend tests' },
  { id: 'rules', label: 'Token rules', description: 'Manage award rates and windows' },
  { id: 'audit', label: 'Audit log', description: 'Review operational events' },
  { id: 'health', label: 'System health', description: 'Check API, readiness, and reconciliation' },
];

function AdminNavIcon({ tab }: { tab: AdminTab }) {
  const paths: Record<AdminTab, React.ReactNode> = {
    overview: <><rect x="4" y="4" width="6" height="6" rx="1" /><rect x="14" y="4" width="6" height="6" rx="1" /><rect x="4" y="14" width="6" height="6" rx="1" /><rect x="14" y="14" width="6" height="6" rx="1" /></>,
    identities: <><circle cx="12" cy="8" r="3" /><path d="M5 20c.7-3 3.2-5 7-5s6.3 2 7 5" /></>,
    transactions: <><path d="M5 7h12" /><path d="m14 4 3 3-3 3" /><path d="M19 17H7" /><path d="m10 14-3 3 3 3" /></>,
    rules: <><path d="M5 6h14M5 12h14M5 18h14" /><circle cx="9" cy="6" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="11" cy="18" r="2" /></>,
    audit: <><circle cx="12" cy="12" r="8" /><path d="M12 7v5l3 2" /></>,
    health: <><path d="M4 12h3l2-5 4 10 2-5h5" /></>,
  };
  return <svg className="admin-nav-icon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">{paths[tab]}</svg>;
}

interface AdminAppProps {
  onBack?: () => void;
}

export default function AdminApp({ onBack }: AdminAppProps) {
  return (
    <AuthGate title="NEVERFLAT Admin Console" onBack={onBack}>
      {({ baseUrl, adminToken, onLogout }) => (
        <AdminShell baseUrl={baseUrl} adminToken={adminToken} onLogout={onLogout} onBack={onBack} />
      )}
    </AuthGate>
  );
}

// â”€â”€ Inner shell (rendered once authenticated) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
interface AdminShellProps {
  baseUrl: string;
  adminToken: string;
  onLogout: () => void;
  onBack?: () => void;
}

function AdminShell({ baseUrl, adminToken, onLogout, onBack }: AdminShellProps) {
  const [emaid, setEmaid] = useState('demo-user-001');
  const [walletData, setWalletData] = useState<WalletResponse | null>(null);
  const [loadingWallet, setLoadingWallet] = useState(false);
  const [feedback, setFeedback] = useState<ApiFeedback>({ kind: 'idle', message: '' });

  useEffect(() => {
    if (!feedback.message) return;
    const timer = window.setTimeout(() => setFeedback(current =>
      current.message === feedback.message ? { ...current, message: '' } : current
    ), 7000);
    return () => window.clearTimeout(timer);
  }, [feedback.message]);

  const [awardSessionId, setAwardSessionId] = useState(`session-${Date.now()}`);
  const [awardProviderId, setAwardProviderId] = useState('nvf-demo');
  const [awardEvseId, setAwardEvseId] = useState('DE*ABC*E*001');
  const [awardEnergyKwh, setAwardEnergyKwh] = useState(12);
  const [awardDirection, setAwardDirection] = useState<'CHARGE' | 'DISCHARGE'>('DISCHARGE');
  const awardRequestRef = useRef<AdminAwardRequest | null>(null);
  const [awardPendingRequest, setAwardPendingRequest] = useState<AdminAwardRequest | null>(null);
  const [awardSubmitting, setAwardSubmitting] = useState(false);
  const awardInFlightRef = useRef(false);

  const [spendAmount, setSpendAmount] = useState(5);
  const [spendSessionId, setSpendSessionId] = useState(`spend-${Date.now()}`);
  const [spendProviderId, setSpendProviderId] = useState('nvf-demo');
  const spendKeySequenceRef = useRef(0);
  const [spendIdempotencyKey, setSpendIdempotencyKey] = useState(() => `admin-test-spend-${Date.now()}-0`);
  const spendRequestRef = useRef<AdminSpendRequest | null>(null);
  const [spendPendingRequest, setSpendPendingRequest] = useState<AdminSpendRequest | null>(null);
  const [spendSubmitting, setSpendSubmitting] = useState(false);
  const spendInFlightRef = useRef(false);
  const spendPendingRef = useRef(false);

  const [activeTab, setActiveTab] = useState<AdminTab>('overview');

  const maskedWallet = useMemo(() => {
    if (!walletData?.walletAddress) return 'No wallet loaded';
    const v = walletData.walletAddress;
    return `${v.slice(0, 6)}...${v.slice(-4)}`;
  }, [walletData]);

  const identityLocked = Boolean(awardPendingRequest || spendPendingRequest || awardSubmitting || spendSubmitting);
  const awardFieldsLocked = Boolean(awardPendingRequest || awardSubmitting);
  const spendFieldsLocked = Boolean(spendPendingRequest || spendSubmitting);

  function rotateSpendIdempotencyKey() {
    spendKeySequenceRef.current += 1;
    setSpendIdempotencyKey(`admin-test-spend-${Date.now()}-${spendKeySequenceRef.current}`);
  }

  async function apiRequest(path: string, options?: RequestInit) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (adminToken) headers['Authorization'] = `Bearer ${adminToken}`;
    return fetch(`${baseUrl}${path}`, {
      ...options,
      headers: { ...headers, ...(options?.headers || {}) },
    });
  }

  async function loadWallet(options?: { suppressFeedback?: boolean }) {
    setLoadingWallet(true);
    if (!options?.suppressFeedback) setFeedback({ kind: 'idle', message: 'Loading wallet...' });
    try {
      // The identity endpoint is the supported ownership path. The legacy
      // /wallet/:uid lookup is disabled in pilot/production; keep the
      // operator's eMAID in the standard identity header instead.
      const res = await apiRequest('/wallet/me', {
        method: 'GET',
        headers: { 'x-contract-id': emaid.trim() },
      });
      const data = await res.json();
      if (!res.ok) {
        setWalletData(null);
        setFeedback({ kind: 'error', message: data?.message || data?.error || 'Failed to load wallet' });
        return;
      }
      setWalletData(data as WalletResponse);
      if (!options?.suppressFeedback) setFeedback({ kind: 'success', message: 'Wallet loaded successfully.' });
    } catch (err) {
      setWalletData(null);
      setFeedback({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoadingWallet(false);
    }
  }

  async function submitAward(event: FormEvent) {
    event.preventDefault();
    if (awardInFlightRef.current) return;
    awardInFlightRef.current = true;
    setAwardSubmitting(true);
    setFeedback({ kind: 'idle', message: 'Submitting award...' });
    try {
      const request = awardRequestRef.current || {
        SessionID: awardSessionId,
        ProviderID: awardProviderId,
        cdr_token: { contract_id: emaid },
        EVSEID: awardEvseId,
        StartTime: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
        EndTime: new Date().toISOString(),
        Energy: awardEnergyKwh.toString(),
        EnergyDirection: awardDirection,
      } satisfies AdminAwardRequest;
      awardRequestRef.current = request;
      setAwardPendingRequest(request);
      const res = await apiRequest('/ingest/cdr', {
        method: 'POST',
        body: JSON.stringify(request),
      });
      const data = await res.json();
      const pending = res.status === 202 || data?.pending || data?.requiresReview || data?.status === 'pending';
      if (pending) {
        setFeedback({
          kind: 'idle',
          message: data?.requiresReview
            ? 'Award outcome needs review. Keep the same CDR for recovery.'
            : 'Award is pending. Keep the same CDR and retry later.',
        });
        return;
      }
      if (!res.ok) {
        const retryable = res.status >= 500 || Boolean(data?.retryable || data?.pending || data?.requiresReview);
        if (!retryable) {
          awardRequestRef.current = null;
          setAwardPendingRequest(null);
        }
        setFeedback({ kind: 'error', message: data?.message || data?.error || 'Award failed' });
        return;
      }
      const eligible = Boolean(data?.eligible);
      const txHash = data?.txHash;
      if (!eligible) {
        awardRequestRef.current = null;
        setAwardPendingRequest(null);
        setAwardSessionId(`session-${Date.now()}`);
        setFeedback({ kind: 'error', message: data?.message || 'CDR accepted but not eligible for reward.' });
        return;
      }
      if (!txHash) { setFeedback({ kind: 'error', message: 'Award eligible but tx hash missing. Check backend logs.' }); return; }
      setFeedback({ kind: 'success', message: `Award processed. Tx: ${txHash}` });
      awardRequestRef.current = null;
      setAwardPendingRequest(null);
      setAwardSessionId(`session-${Date.now()}`);
      await loadWallet({ suppressFeedback: true });
    } catch (err) {
      setFeedback({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      awardInFlightRef.current = false;
      setAwardSubmitting(false);
    }
  }

  async function submitSpend(event: FormEvent) {
    event.preventDefault();
    if (spendInFlightRef.current) return;
    const currentBalance = Number(walletData?.balance || 0);
    if (!spendPendingRef.current && currentBalance <= 0) {
      setFeedback({ kind: 'error', message: 'No balance to spend. Award tokens first.' });
      return;
    }
    spendInFlightRef.current = true;
    setSpendSubmitting(true);
    setFeedback({ kind: 'idle', message: 'Submitting spend...' });
    try {
      const request = spendRequestRef.current || {
        uid: emaid,
        amount: spendAmount,
        sessionId: spendSessionId,
        providerId: spendProviderId,
        idempotencyKey: spendIdempotencyKey,
      };
      spendRequestRef.current = request;
      setSpendPendingRequest(request);
      spendPendingRef.current = true;
      const res = await apiRequest('/spend', {
        method: 'POST',
        body: JSON.stringify({
          ...request,
          label: 'Admin test spend',
        }),
      });
      const data = await res.json();
      const pending = res.status === 202 || data?.pending || data?.requiresReview || data?.status === 'pending';
      if (pending) {
        setFeedback({
          kind: 'idle',
          message: spendPendingMessage(data),
        });
        return;
      }
      if (!res.ok) {
        const retryable = res.status >= 500 || Boolean(data?.retryable || data?.pending || data?.requiresReview);
        // A user-submitted response may release the locked key only when the
        // backend explicitly proves that no token movement occurred. Failed,
        // unknown, review, and missing-hash outcomes retain the exact request.
        if (!retryable && shouldReleaseSpendRequest(data, true)) {
          spendRequestRef.current = null;
          setSpendPendingRequest(null);
          spendPendingRef.current = false;
          rotateSpendIdempotencyKey();
        }
        setFeedback({ kind: 'error', message: data?.message || data?.error || 'Spend failed' });
        return;
      }
      if (data?.status !== 'success' || !data?.spendReceipt) {
        setFeedback({
          kind: 'idle',
          message: 'The spend has a recorded outcome but its receipt is not ready. Do not create a new spend; retry this same request to recover it.',
        });
        return;
      }
      setFeedback({ kind: 'success', message: `Spend processed. Tx: ${data.txHash || 'pending'}` });
      spendRequestRef.current = null;
      setSpendPendingRequest(null);
      spendPendingRef.current = false;
      setSpendSessionId(`spend-${Date.now()}`);
      rotateSpendIdempotencyKey();
      await loadWallet({ suppressFeedback: true });
    } catch (err) {
      setFeedback({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      spendInFlightRef.current = false;
      setSpendSubmitting(false);
    }
  }

  return (
    <div className="wallet-shell">
      <aside className="left-rail admin-left-rail">
        <div className="admin-brand-header brand-lockup">
          <div className="brand-glyph"><img src="/logo-blue.svg" alt="NEVERFLAT logo" /></div>
          <div>
            <p className="admin-brand-name">NEVERFLAT</p>
            <h1>Admin console</h1>
            <p>Platform operations</p>
          </div>
        </div>

        <div className="rail-card admin-identity-picker">
          <label htmlFor="admin-emaid-input">
            <span className="label">eMAID</span>
            <span className="admin-field-help">Canonical charging-contract ownership</span>
          </label>
          <input
            id="admin-emaid-input"
            value={emaid}
            onChange={(e) => setEmaid(e.target.value)}
            disabled={identityLocked}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="button" onClick={() => loadWallet()} disabled={loadingWallet || identityLocked}>
            {loadingWallet ? 'Loading...' : 'Load balance'}
          </button>
        </div>

        <nav className="admin-nav" aria-label="Admin sections">
          <span className="admin-nav-heading">Workspace</span>
          {adminNavItems.map(item => (
            <button
              type="button"
              key={item.id}
              className={`admin-nav-item${activeTab === item.id ? ' admin-nav-item--active' : ''}`}
              onClick={() => setActiveTab(item.id)}
              aria-current={activeTab === item.id ? 'page' : undefined}
              title={item.description}
            >
              <AdminNavIcon tab={item.id} />
              <span>{item.label}</span>
            </button>
          ))}
        </nav>

        <div className="admin-rail-footer">
          {onBack && <button type="button" className="back-btn back-btn--admin-sidebar" onClick={onBack}>Back</button>}
          <button type="button" className="admin-signout" onClick={onLogout}>
            <span aria-hidden="true">↪</span>
            <span>Sign out</span>
          </button>
        </div>
      </aside>

      {feedback.message && (
        <div
          className={`status-strip status-toast ${feedback.kind === 'success' ? 'status-strip--success' : feedback.kind === 'error' ? 'status-strip--error' : 'status-strip--neutral'}`}
          role="status"
        >
          {feedback.message}
        </div>
      )}

      <main className="main-view" aria-live="polite">
        {activeTab === 'overview' || activeTab === 'rules' || activeTab === 'audit' || activeTab === 'health' ? (
          <AdminDashboard
            baseUrl={baseUrl}
            externalToken={adminToken}
            section={activeTab}
          />
        ) : activeTab === 'identities' ? (
          <>
            <WalletSummary emaid={emaid} walletData={walletData} maskedWallet={maskedWallet} />
            <ActivityList history={walletData?.history || []} />
          </>
        ) : (
          <>
            <WalletSummary emaid={emaid} walletData={walletData} maskedWallet={maskedWallet} />

            <section className="actions-grid">
              <form className="action-card" onSubmit={submitAward}>
                <h3>Simulate Award</h3>
                <p className="subtle">DISCHARGE is pre-selected and usually eligible.</p>
                {awardPendingRequest && (
                  <p className="subtle">Retrying the locked CDR {awardPendingRequest.SessionID} for {awardPendingRequest.cdr_token.contract_id}.</p>
                )}
                <label>Session ID<input value={awardSessionId} onChange={(e) => setAwardSessionId(e.target.value)} disabled={awardFieldsLocked} required /></label>
                <label>Provider ID<input value={awardProviderId} onChange={(e) => setAwardProviderId(e.target.value)} disabled={awardFieldsLocked} required /></label>
                <label>EVSEID<input value={awardEvseId} onChange={(e) => setAwardEvseId(e.target.value)} disabled={awardFieldsLocked} required /></label>
                <label>
                  Energy kWh
                  <input type="number" min="0.1" step="0.1" value={awardEnergyKwh} onChange={(e) => setAwardEnergyKwh(Number(e.target.value))} disabled={awardFieldsLocked} required />
                </label>
                <label>
                  Direction
                  <select value={awardDirection} onChange={(e) => setAwardDirection(e.target.value as 'CHARGE' | 'DISCHARGE')} disabled={awardFieldsLocked}>
                    <option value="CHARGE">CHARGE</option>
                    <option value="DISCHARGE">DISCHARGE</option>
                  </select>
                </label>
                <button type="submit" disabled={awardSubmitting}>{awardPendingRequest ? 'Retry Award' : 'Submit Award'}</button>
              </form>

              <form className="action-card" onSubmit={submitSpend}>
                <h3>Simulate Spend</h3>
                <p className="subtle">Deducts from wallet balance via managed flow.</p>
                {spendPendingRequest && (
                  <p className="subtle">Retrying the locked spend {spendPendingRequest.sessionId} with its original request key.</p>
                )}
                <label>Session ID<input value={spendSessionId} onChange={(e) => setSpendSessionId(e.target.value)} disabled={spendFieldsLocked} required /></label>
                <label>Provider ID<input value={spendProviderId} onChange={(e) => setSpendProviderId(e.target.value)} disabled={spendFieldsLocked} required /></label>
                <label>
                  Amount (SPARKZ)
                  <input type="number" min="0.1" step="0.1" value={spendAmount} onChange={(e) => setSpendAmount(Number(e.target.value))} disabled={spendFieldsLocked} required />
                </label>
                <button type="submit" disabled={spendSubmitting}>{spendPendingRequest ? 'Retry Spend' : 'Submit Spend'}</button>
              </form>
            </section>

            <AdminOperationsPanel baseUrl={baseUrl} adminToken={adminToken} emaid={emaid} />

            <ActivityList history={walletData?.history || []} />
          </>
        )}
      </main>
    </div>
  );
}

function maskOperationWallet(address: string | null | undefined): string {
  if (!address) return 'Not recorded';
  if (address.length <= 14) return address;
  return `${address.slice(0, 8)}…${address.slice(-6)}`;
}

function formatOperationTimestamp(value: string | null): string {
  if (!value) return 'Not recorded';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString();
}

function AdminOperationsPanel({
  baseUrl,
  adminToken,
  emaid,
}: {
  baseUrl: string;
  adminToken: string;
  emaid: string;
}) {
  const [scope, setScope] = useState<'unresolved' | 'all'>('unresolved');
  const [operations, setOperations] = useState<AdminOperation[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [nextOffset, setNextOffset] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [emaidFilter, setEmaidFilter] = useState<AdminEmaidFilter>('current');
  const [loadedFilter, setLoadedFilter] = useState<{ emaid: string } | null>(null);
  const [recoveringOperationKeys, setRecoveringOperationKeys] = useState<Record<string, boolean>>({});
  const [recoveryFeedback, setRecoveryFeedback] = useState<AdminRecoveryFeedback | null>(null);

  async function loadOperations(options: { append?: boolean } = {}) {
    const append = Boolean(options.append);
    const offset = append ? nextOffset : 0;
    const requestedEmaid = append
      ? loadedFilter?.emaid || ''
      : emaidFilter === 'all' ? '' : emaid.trim();
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({ scope, limit: '25', offset: String(offset) });
      if (requestedEmaid) params.set('emaid', requestedEmaid);
      const response = await fetch(`${baseUrl}/admin/operations?${params.toString()}`, {
        headers: { Authorization: `Bearer ${adminToken}` },
      });
      const data = await response.json() as AdminOperationsResponse;
      if (!response.ok || data.status !== 'ok') {
        const prefix = data.code === 'OPERATIONS_SCHEMA_UNAVAILABLE' ? 'Ledger schema unavailable' : 'Could not load operations';
        throw new Error(`${prefix}: ${data.message || 'The read-only operations view is unavailable.'}`);
      }
      const nextOperations = Array.isArray(data.operations) ? data.operations : [];
      setOperations(current => append ? [...current, ...nextOperations] : nextOperations);
      setTotal(typeof data.total === 'number' ? data.total : nextOperations.length);
      setHasMore(Boolean(data.hasMore));
      setNextOffset(typeof data.nextOffset === 'number' ? data.nextOffset : offset + nextOperations.length);
      if (!append) setLoadedFilter({ emaid: requestedEmaid });
    } catch (err) {
      if (!append) setOperations([]);
      setTotal(0);
      setHasMore(false);
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  async function recoverSavedOperation(operation: AdminOperation) {
    if (operation.recovery?.eligible !== true || recoveringOperationKeys[operation.operationKey]) return;
    setRecoveringOperationKeys(current => ({ ...current, [operation.operationKey]: true }));
    setRecoveryFeedback(null);
    try {
      const response = await fetch(`${baseUrl}/admin/operations/recover`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${adminToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ operationKey: operation.operationKey }),
      });
      const data = await response.json().catch(() => ({})) as {
        status?: string;
        code?: string;
        message?: string;
        error?: string;
        recoveryStatus?: string;
        projectionStatus?: string;
        receiptStatus?: string;
        recovered?: boolean;
        audit?: { status?: string; message?: string };
      };
      setRecoveryFeedback(recoveryFeedbackForResponse(response, data, operation));
    } catch (err) {
      setRecoveryFeedback({
        operationKey: operation.operationKey,
        kind: 'error',
        message: err instanceof Error ? err.message : 'Saved operation recovery failed.',
      });
    } finally {
      setRecoveringOperationKeys(current => {
        const next = { ...current };
        delete next[operation.operationKey];
        return next;
      });
      // Refresh after every attempt, including blocked, pending, and audit
      // persistence responses. Keep the feedback above so the result remains
      // visible while the durable row is reloaded.
      await loadOperations();
    }
  }

  useEffect(() => {
    void loadOperations();
    // The eMAID input is deliberately applied on refresh so typing an eMAID
    // does not issue a request for every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [baseUrl, adminToken, scope, emaidFilter]);

  return (
    <section className="activity-card admin-operations-card" aria-labelledby="admin-operations-title">
      <div className="admin-rule-header">
        <div>
          <h3 id="admin-operations-title">Token operations</h3>
          <p className="subtle activity-helper">
            Durable transaction operations and operator recovery. Ownership is shown as eMAID; protocol/source details remain in the Audit log.
          </p>
        </div>
        <button type="button" className="btn-ghost" onClick={() => { void loadOperations(); }} disabled={loading}>
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      <div className="admin-operation-toolbar">
        <label>
          Show
          <select value={scope} onChange={event => setScope(event.target.value as 'unresolved' | 'all')} disabled={loading}>
            <option value="unresolved">Needs attention</option>
            <option value="all">All operations</option>
          </select>
        </label>
        <label>
          Owner
          <select value={emaidFilter} onChange={event => setEmaidFilter(event.target.value as AdminEmaidFilter)} disabled={loading}>
            <option value="current">Current eMAID</option>
            <option value="all">All eMAIDs</option>
          </select>
        </label>
        <p className="subtle admin-operation-filter">
          eMAID filter: <strong>{loadedFilter ? loadedFilter.emaid || 'All eMAIDs' : 'Not loaded'}</strong>
        </p>
        <p className="subtle admin-operation-count" role="status">
          {total} {total === 1 ? 'operation' : 'operations'}
        </p>
      </div>

      {error && <p className="admin-error" role="alert">{error}</p>}
      {recoveryFeedback && (
          <p
          className={recoveryFeedback.kind === 'error'
            ? 'admin-error'
            : recoveryFeedback.kind === 'attention'
              ? 'admin-warning'
              : recoveryFeedback.kind === 'pending'
                ? 'admin-pending'
                : 'admin-success'}
          role={recoveryFeedback.kind === 'error' || recoveryFeedback.kind === 'attention' ? 'alert' : 'status'}
        >
          {recoveryFeedback.message}
        </p>
      )}
      {!error && loading && !operations.length && <p className="subtle">Loading operation ledger...</p>}
      {!error && !loading && !operations.length && (
        <p className="subtle">
          {scope === 'unresolved' ? 'No unresolved token operations for this filter.' : 'No token operations recorded for this filter.'}
        </p>
      )}

      {!!operations.length && (
        <ul className="admin-operation-list" aria-label="Token operations">
          {operations.map(operation => (
            <li
              className="admin-operation-row"
              key={operation.id || operation.operationKey}
              aria-busy={Boolean(recoveringOperationKeys[operation.operationKey])}
            >
              <div className="admin-operation-row__header">
                <div>
                  <strong>{operation.operationType.toUpperCase()} · {operation.amount} SPARKZ</strong>
                  <p className="subtle">eMAID: {operation.eMAID || 'Not recorded'} · Updated {formatOperationTimestamp(operation.updatedAt)}</p>
                </div>
                <span className={`admin-status-pill admin-status-pill--${operation.status}`}>{operation.status}</span>
              </div>
              <p className="subtle admin-operation-next-action"><strong>Next action:</strong> {operation.nextAction}</p>
              <div className={`admin-operation-recovery ${operation.recovery?.eligible === true ? 'admin-operation-recovery--eligible' : 'admin-operation-recovery--blocked'}`}>
                <div>
                  <strong>
                    {operation.status === 'projected'
                      ? 'Already projected'
                      : operation.recovery?.eligible === true
                        ? 'Can finish saved operation'
                        : 'Blocked for investigation'}
                  </strong>
                  <p className="subtle">
                    {operation.recovery?.reason || 'The server did not mark this operation eligible for recovery.'}
                    {(operation.recovery?.reasonCode || operation.recovery?.code)
                      ? ` (${operation.recovery.reasonCode || operation.recovery.code})`
                      : ''}
                  </p>
                </div>
                {operation.recovery?.eligible === true && (
                  <button
                    type="button"
                    className="btn-ghost admin-operation-recovery__button"
                    onClick={() => { void recoverSavedOperation(operation); }}
                    disabled={Boolean(recoveringOperationKeys[operation.operationKey])}
                    aria-label={`Finish saved ${operation.operationType} operation ${operation.operationKey}`}
                  >
                    {recoveringOperationKeys[operation.operationKey] ? 'Checking saved operation…' : 'Finish saved operation'}
                  </button>
                )}
              </div>
              <details>
                <summary>View operation details</summary>
                <dl className="admin-operation-details">
                  <dt>Operation key</dt><dd>{operation.operationKey || 'Not recorded'}</dd>
                  <dt>Movement outcome</dt><dd>{operation.movementOutcome}</dd>
                  <dt>Wallet</dt><dd>{maskOperationWallet(operation.walletAddress)}</dd>
                  <dt>Session</dt><dd>{operation.sessionId || 'Not recorded'}</dd>
                  <dt>Provider</dt><dd>{operation.providerId || 'Not recorded'}</dd>
                  <dt>Reservation</dt><dd>{operation.reservationId || 'Not recorded'}</dd>
                  <dt>Transaction hash</dt><dd>{operation.transactionHash || 'Not recorded'}</dd>
                  <dt>Updated</dt><dd>{formatOperationTimestamp(operation.updatedAt)}</dd>
                  <dt>Recovery</dt><dd>{operation.recovery?.reason || 'Eligibility unavailable; investigate before any follow-up.'}{(operation.recovery?.reasonCode || operation.recovery?.code) ? ` (${operation.recovery.reasonCode || operation.recovery.code})` : ''}</dd>
                  {operation.errorMessage && <><dt>Recorded reason</dt><dd>{operation.errorMessage}</dd></>}
                </dl>
              </details>
            </li>
          ))}
        </ul>
      )}

      {hasMore && !error && (
        <button type="button" className="btn-ghost admin-operation-load-more" onClick={() => { void loadOperations({ append: true }); }} disabled={loading}>
          {loading ? 'Loading...' : 'Load more operations'}
        </button>
      )}
    </section>
  );
}

function WalletSummary({
  emaid,
  walletData,
  maskedWallet,
}: {
  emaid: string;
  walletData: WalletResponse | null;
  maskedWallet: string;
}) {
  const displayedEmaid = walletData?.emaid || walletData?.uid || emaid;
  return (
    <section className="hero-card admin-wallet-summary">
      <div>
        <p className="label">Wallet address</p>
        <h2>{maskedWallet}</h2>
        <p className="subtle">eMAID: {displayedEmaid}</p>
      </div>
      <div className="totals-grid">
        <div><p className="label">Current balance</p><p className="value">{walletData?.balance || '0.00'} SPARKZ</p></div>
        <div><p className="label">Total awarded</p><p className="value">{walletData?.totalAwarded || '0.00'} SPARKZ</p></div>
        <div><p className="label">Total spent</p><p className="value">{walletData?.totalSpent || '0.00'} SPARKZ</p></div>
      </div>
      {walletData?.balanceStatus && (
        <p className="subtle admin-balance-status" role="status">
          Balance source: {walletData.balanceSource || 'unknown'} · {walletData.balanceStatus}
        </p>
      )}
      {walletData?.balanceWarning && (
        <p className="subtle" role="status">{walletData.balanceWarning}</p>
      )}
    </section>
  );
}

// Shared activity list component
export function ActivityList({ history }: { history: WalletHistoryItem[] }) {
  return (
    <section className="activity-card">
      <h3 className="heading-with-icon">
        <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 7v5l3 2" />
        </svg>
        Recent Activity
      </h3>
      <p className="subtle activity-helper">
        Your earned and spent SPARKZ will appear here after off-peak charging, V2G activity, or charging discounts.
      </p>
      {!history.length && <p className="subtle">No activity yet.</p>}
      {!!history.length && (
        <ul>
          {history.slice(0, 10).map((item, index) => {
            const rowContent = (
              <>
                <div>
                  <strong>{item.type.toUpperCase()}</strong>
                  {item.uid && <p className="activity-contract-id">eMAID: {item.uid}</p>}
                  {item.walletAddress && (
                    <p className="activity-contract-id">
                      {item.walletName ? `${item.walletName} - ` : ''}{item.walletAddress}
                    </p>
                  )}
                  <p>{item.amount} SPARKZ{item.awardType ? ` - ${item.awardType}` : ''}</p>
                </div>
                <div className="subtle">
                  <p>{item.timestamp ? new Date(item.timestamp).toLocaleString() : 'Pending'}</p>
                  {item.txHash && <p>{item.txHash.slice(0, 10)}...</p>}
                </div>
              </>
            );
            return item.txHash ? (
              <a key={`${item.txHash}-${index}`} className="activity-row activity-row--link"
                href={`https://amoy.polygonscan.com/tx/${item.txHash}`} target="_blank" rel="noopener noreferrer">
                {rowContent}
              </a>
            ) : (
              <li key={`${item.timestamp || 'history'}-${index}`} className="activity-row">{rowContent}</li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
