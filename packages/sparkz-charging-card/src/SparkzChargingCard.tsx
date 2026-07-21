import { FormEvent, useEffect, useMemo, useState } from 'react';
import { ethers } from 'ethers';
import type {
  SparkzActiveSessionStatus,
  SparkzActivityItem,
  SparkzChargingCardProps,
  SparkzRewardRate,
  SparkzReservation,
  SparkzSessionResponse,
  SparkzSpendReceipt,
  SparkzWalletResponse,
} from './types';
import sparkzLogo from './sparkz-logo.svg';

type SpendResponse = {
  status: 'success';
  reservation: SparkzReservation;
};

type BrowserEthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

const activeSessionStatuses: SparkzActiveSessionStatus[] = ['CHARGER_OPENED', 'PLUGGED_IN', 'SESSION_STARTED'];

async function readJson<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw data || { status: 'error', message: `Request failed with ${res.status}` };
  }
  return data as T;
}

function getErrorMessage(err: unknown): string {
  return err && typeof err === 'object' && 'message' in err
    ? String((err as { message?: unknown }).message)
    : String(err);
}

function contractHeaders(contractId: string): HeadersInit {
  return {
    'Content-Type': 'application/json',
    'x-contract-id': contractId,
  };
}

function money(value: number | string | undefined): string {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed.toFixed(2) : '0.00';
}

function compactNumber(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function shortAddress(value?: string | null): string {
  if (!value) return 'Not available';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function formatDate(value?: string): string {
  if (!value) return '';
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function formatRate(rate: SparkzRewardRate): string {
  if (!rate.enabled) return 'Not currently active';
  if (rate.kWhPerSparkz && Number.isFinite(rate.kWhPerSparkz)) {
    return `1 SPARKZ = ${compactNumber(rate.kWhPerSparkz)} kWh`;
  }
  return `${money(rate.tokensPerKWh)} SPARKZ per kWh`;
}

function isActiveSessionStatus(value: SparkzChargingCardProps['sessionStatus']): value is SparkzActiveSessionStatus {
  return Boolean(value && activeSessionStatuses.includes(value as SparkzActiveSessionStatus));
}

function getLinkedWalletSignatureMessage(contractId: string, walletAddress: string): string {
  return [
    'NEVERFLAT link wallet address',
    `EMP contract: ${contractId}`,
    `Wallet address: ${walletAddress}`,
  ].join('\n');
}

export default function SparkzChargingCard({
  apiBaseUrl = '',
  contractId,
  sessionId,
  providerId,
  chargerId = '',
  sessionStatus,
  countryCode,
  estimatedKwh,
  estimatedCost,
  logoSrc,
  showWalletDetails = true,
  hideAfterSpend = true,
  hideAfterSkip = true,
  polygonExplorerBaseUrl = 'https://amoy.polygonscan.com',
  onSpendSuccess,
  onReservationSuccess,
  onSpendError,
  onWalletLoaded,
  onWalletModeChange,
  onSkipSession,
  onDismiss,
}: SparkzChargingCardProps) {
  const [wallet, setWallet] = useState<SparkzWalletResponse | null>(null);
  const [session, setSession] = useState<SparkzSessionResponse | null>(null);
  const [selectedAmount, setSelectedAmount] = useState('');
  const [connectedWallet, setConnectedWallet] = useState('');
  const [loading, setLoading] = useState(false);
  const [loadingWallet, setLoadingWallet] = useState(false);
  const [spending, setSpending] = useState(false);
  const [switchingMode, setSwitchingMode] = useState(false);
  const [signingWallet, setSigningWallet] = useState(false);
  const [error, setError] = useState('');
  const [walletError, setWalletError] = useState('');
  const [receipt, setReceipt] = useState<SparkzSpendReceipt | null>(null);
  const [reservation, setReservation] = useState<SparkzReservation | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [activeTab, setActiveTab] = useState<'activity' | 'account' | 'about'>('activity');

  const hasActiveSessionStatus = isActiveSessionStatus(sessionStatus);
  const hasSessionContext = Boolean(contractId && sessionId && providerId && hasActiveSessionStatus);
  const displayStatus = session ? session.sessionStatus.replace(/_/g, ' ') : 'UNPLUGGED';
  const activityItems = session?.recentActivity || wallet?.history || [];
  const walletBalance = session?.wallet.availableBalance ?? wallet?.balance ?? 0;
  const walletEarned = wallet?.totalAwarded || session?.wallet.totalEarned || 0;
  const walletSpent = wallet?.totalSpent || session?.wallet.totalSpent || 0;

  const sessionRequest = useMemo(() => ({
    sessionId,
    providerId,
    chargerId,
    status: sessionStatus,
    countryCode,
    estimatedKwh,
    estimatedCost,
  }), [sessionId, providerId, chargerId, sessionStatus, countryCode, estimatedKwh, estimatedCost]);

  useEffect(() => {
    let cancelled = false;

    async function loadWallet() {
      setLoadingWallet(true);
      setWalletError('');
      try {
        const res = await fetch(`${apiBaseUrl}/wallet/me`, {
          method: 'GET',
          headers: contractHeaders(contractId),
        });
        const data = await readJson<SparkzWalletResponse>(res);
        if (cancelled) return;
        setWallet(data);
        setConnectedWallet(data.walletMode === 'custodial' ? data.walletAddress : '');
        onWalletLoaded?.(data);
      } catch (err) {
        if (cancelled) return;
        setWallet(null);
        setWalletError(getErrorMessage(err));
      } finally {
        if (!cancelled) setLoadingWallet(false);
      }
    }

    if (contractId) {
      void loadWallet();
    } else {
      setWallet(null);
      setWalletError('');
      setLoadingWallet(false);
    }

    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, contractId, onWalletLoaded]);

  useEffect(() => {
    let cancelled = false;

    async function loadSession() {
      setLoading(true);
      setError('');
      setReceipt(null);
      setDismissed(false);
      try {
        const res = await fetch(`${apiBaseUrl}/spend/session`, {
          method: 'POST',
          headers: contractHeaders(contractId),
          body: JSON.stringify(sessionRequest),
        });
        const data = await readJson<SparkzSessionResponse>(res);
        if (cancelled) return;
        setSession(data);
        setSelectedAmount(data.spend.suggestedAmount > 0 ? data.spend.suggestedAmount.toString() : '');
      } catch (err) {
        if (cancelled) return;
        setSession(null);
        setError(getErrorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    if (hasSessionContext) {
      void loadSession();
    } else {
      setSession(null);
      setError('');
      setLoading(false);
    }

    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, contractId, providerId, sessionId, sessionStatus, sessionRequest, hasSessionContext]);

  async function applyDiscount(e: FormEvent) {
    e.preventDefault();
    if (!session || !sessionId || !providerId) return;

    const amount = Number(selectedAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('Enter an amount greater than 0.');
      return;
    }
    if (amount > session.spend.maxSpendable) {
      setError(`Amount cannot exceed ${money(session.spend.maxSpendable)} SPARKZ.`);
      return;
    }

    setSpending(true);
    setError('');
    setReceipt(null);
    try {
      const res = await fetch(`${apiBaseUrl}/spend/me`, {
        method: 'POST',
        headers: contractHeaders(contractId),
        body: JSON.stringify({
          amount,
          sessionId,
          providerId,
          label: 'Charging discount',
        }),
      });
      const data = await readJson<SpendResponse>(res);
      setReservation(data.reservation);
      onReservationSuccess?.(data.reservation);
      if (hideAfterSpend) {
        setDismissed(true);
        onDismiss?.('spent');
      }
    } catch (err) {
      setError(getErrorMessage(err));
      onSpendError?.(err);
    } finally {
      setSpending(false);
    }
  }

  function skipSession() {
    if (!session || !sessionId || !providerId) return;
    onSkipSession?.({ contractId, sessionId, providerId, chargerId, sessionStatus: session.sessionStatus });
    if (hideAfterSkip) {
      setDismissed(true);
      onDismiss?.('skipped');
    }
  }

  async function loadWalletProfile() {
    const walletRes = await fetch(`${apiBaseUrl}/wallet/me`, {
      method: 'GET',
      headers: contractHeaders(contractId),
    });
    const walletData = await readJson<SparkzWalletResponse>(walletRes);
    setWallet(walletData);
    setConnectedWallet(walletData.walletMode === 'custodial' ? walletData.walletAddress : '');
    return walletData;
  }

  async function connectAndSignCustodialWallet(): Promise<string> {
    const ethereum = (window as Window & { ethereum?: BrowserEthereumProvider }).ethereum;
    if (!ethereum) {
      throw new Error('No wallet app found. Install or open MetaMask, Rabby, or another EVM wallet.');
    }

    const accounts = await ethereum.request({ method: 'eth_requestAccounts' }) as string[];
    const rawWalletAddress = accounts?.[0];
    if (!rawWalletAddress) {
      throw new Error('No wallet account was selected.');
    }
    const walletAddress = ethers.getAddress(rawWalletAddress);

    const message = getLinkedWalletSignatureMessage(contractId, walletAddress);
    let signature: unknown;
    try {
      signature = await ethereum.request({ method: 'personal_sign', params: [message, walletAddress] });
    } catch {
      signature = await ethereum.request({ method: 'personal_sign', params: [walletAddress, message] });
    }

    if (typeof signature !== 'string' || !signature) {
      throw new Error('Wallet signature was not returned.');
    }

    const linkRes = await fetch(`${apiBaseUrl}/wallet/${encodeURIComponent(contractId)}/linked-wallets`, {
      method: 'POST',
      headers: contractHeaders(contractId),
      body: JSON.stringify({ walletAddress, signature }),
    });
    await readJson<SparkzWalletResponse>(linkRes);
    setConnectedWallet(walletAddress);
    return walletAddress;
  }

  async function switchWalletMode(mode: 'managed' | 'custodial') {
    if (!contractId) return;

    setSwitchingMode(true);
    setWalletError('');
    try {
      let walletAddress: string | undefined;
      if (mode === 'custodial') {
        setSigningWallet(true);
        walletAddress = await connectAndSignCustodialWallet();
      }

      const res = await fetch(`${apiBaseUrl}/wallet/${encodeURIComponent(contractId)}/mode`, {
        method: 'POST',
        headers: contractHeaders(contractId),
        body: JSON.stringify({
          mode,
          walletAddress,
          allowSplit: true,
        }),
      });
      await readJson<{ status: 'success' }>(res);
      const walletData = await loadWalletProfile();
      onWalletModeChange?.(walletData);
    } catch (err) {
      setWalletError(getErrorMessage(err));
    } finally {
      setSwitchingMode(false);
      setSigningWallet(false);
    }
  }

  function renderActivity(items: SparkzActivityItem[]) {
    return (
      <div className="sparkz-card__activity" role="tabpanel">
        <div className="sparkz-card__section-header">
          <h3>Recent activity</h3>
        </div>
        {items.length ? (
          <div className="sparkz-card__activity-list">
            {items.map((item, index) => (
              <div className="sparkz-card__activity-row" key={`${item.txHash || item.timestamp || item.type}-${index}`}>
                <div>
                  <strong>{item.type === 'award' ? 'Earned' : 'Spent'}</strong>
                  <span>{formatDate(item.timestamp) || item.label || item.status || 'Session activity'}</span>
                  {item.txHash && (
                    <a href={`${polygonExplorerBaseUrl.replace(/\/$/, '')}/tx/${item.txHash}`} target="_blank" rel="noopener noreferrer">
                      View on Polygon
                    </a>
                  )}
                </div>
                <strong>{money(item.amount)} SPARKZ</strong>
              </div>
            ))}
          </div>
        ) : (
          <p className="sparkz-card__muted">No recent SPARKZ activity yet.</p>
        )}
      </div>
    );
  }

  function renderAccount() {
    return (
      <div className="sparkz-card__account" role="tabpanel">
        <div className="sparkz-card__section-header">
          <h3>SPARKZ account</h3>
        </div>
        <dl className="sparkz-card__metadata">
          <div>
            <dt>Contract ID</dt>
            <dd>{wallet?.uid || contractId}</dd>
          </div>
          <div>
            <dt>Blockchain address</dt>
            <dd>
              {wallet?.walletAddress ? (
                <a href={`${polygonExplorerBaseUrl.replace(/\/$/, '')}/address/${wallet.walletAddress}`} target="_blank" rel="noopener noreferrer">
                  {shortAddress(wallet.walletAddress)}
                </a>
              ) : 'Loading...'}
            </dd>
          </div>
          <div>
            <dt>Wallet mode</dt>
            <dd>{wallet?.walletMode || 'managed'}</dd>
          </div>
          <div>
            <dt>Managed wallet</dt>
            <dd>{shortAddress(wallet?.managedWalletAddress)}</dd>
          </div>
        </dl>

        {wallet?.contractIds && wallet.contractIds.length > 1 && (
          <div className="sparkz-card__account-list">
            <strong>Linked contract IDs</strong>
            <span>{wallet.contractIds.join(', ')}</span>
          </div>
        )}

        {wallet?.linkedWallets && wallet.linkedWallets.length > 0 && (
          <div className="sparkz-card__account-list">
            <strong>Linked wallets</strong>
            {wallet.linkedWallets.map(item => (
              <span key={item.walletAddress}>{item.walletName ? `${item.walletName}: ` : ''}{shortAddress(item.walletAddress)}</span>
            ))}
          </div>
        )}

        <div className="sparkz-card__wallet-form">
          <p className="sparkz-card__muted">
            To use a custodial wallet, connect your wallet app and sign a message proving you control the address.
          </p>
          {connectedWallet && (
            <p className="sparkz-card__muted">Selected wallet: <strong>{shortAddress(connectedWallet)}</strong></p>
          )}
          <button type="button" onClick={() => void switchWalletMode('custodial')} disabled={switchingMode || signingWallet}>
            {signingWallet ? 'Waiting for wallet signature...' : 'Connect wallet and switch to custodial'}
          </button>
        </div>

        {wallet?.walletMode === 'custodial' && (
          <button className="sparkz-card__secondary-button" type="button" onClick={() => void switchWalletMode('managed')} disabled={switchingMode}>
            Use managed wallet
          </button>
        )}

        {walletError && <p className="sparkz-card__error" role="alert">{walletError}</p>}
      </div>
    );
  }

  function renderRewardRates(rates: SparkzRewardRate[] = []) {
    if (!rates.length) return null;

    return (
      <div className="sparkz-card__rates" aria-label="Reward rates">
        <div className="sparkz-card__section-header">
          <h3>Reward rates</h3>
        </div>
        <div className="sparkz-card__rate-list">
          {rates.map((rate) => (
            <div className="sparkz-card__rate-row" key={rate.key}>
              <div>
                <strong>{rate.label}</strong>
                <span>{rate.description}</span>
              </div>
              <strong>{formatRate(rate)}</strong>
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (dismissed) {
    return null;
  }

  return (
    <section className="sparkz-card" aria-busy={loading || spending}>
      <div className="sparkz-card__header">
        <div className="sparkz-card__brand">
          <img className="sparkz-card__logo-image" src={logoSrc || sparkzLogo} alt="SPARKZ" />
        </div>
        <span className="sparkz-card__pill">{displayStatus}</span>
        {session && (
          <div className="sparkz-card__headline">
            <h2>{session.spend.message}</h2>
          </div>
        )}
      </div>

      {loading && <p className="sparkz-card__muted">Loading session rewards...</p>}
      {loadingWallet && !wallet && <p className="sparkz-card__muted">Loading SPARKZ account...</p>}

      {!session && !loading && (
        <div className="sparkz-card__idle">
          <p>No active charging session.</p>
        </div>
      )}

      <div className={`sparkz-card__stats${session ? ' sparkz-card__stats--session' : ''}`}>
        <div>
          <span>Available</span>
          <strong>{money(walletBalance)}</strong>
        </div>
        {!session && (
          <>
            <div>
              <span>Earned</span>
              <strong>{money(walletEarned)}</strong>
            </div>
            <div>
              <span>Spent</span>
              <strong>{money(walletSpent)}</strong>
            </div>
          </>
        )}
      </div>

      {session && (
        <>
          {renderRewardRates(session.rewardRates)}

          {session.spend.eligible ? (
            <form className="sparkz-card__form" onSubmit={applyDiscount}>
              <label>
                Use SPARKZ for this charging session?
                <input
                  type="number"
                  min="0.01"
                  max={session.spend.maxSpendable}
                  step="0.01"
                  value={selectedAmount}
                  onChange={(event) => setSelectedAmount(event.target.value)}
                />
              </label>
              <button type="submit" disabled={spending}>
                {spending ? 'Applying...' : 'Apply discount'}
              </button>
              <button className="sparkz-card__secondary-button" type="button" onClick={skipSession} disabled={spending}>
                Do not spend tokens for this session
              </button>
            </form>
          ) : (
            <div className="sparkz-card__notice">
              <p>{session.spend.message}</p>
              <button className="sparkz-card__secondary-button" type="button" onClick={skipSession}>
                Continue without SPARKZ
              </button>
            </div>
          )}
        </>
      )}

      {!session && showWalletDetails && (
        <div className="sparkz-card__details">
          <div className="sparkz-card__tabs" role="tablist" aria-label="SPARKZ details">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'activity'}
              onClick={() => setActiveTab('activity')}
            >
              Activity
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'account'}
              onClick={() => setActiveTab('account')}
            >
              Account
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === 'about'}
              onClick={() => setActiveTab('about')}
            >
              How it works
            </button>
          </div>

          {activeTab === 'activity' ? renderActivity(activityItems) : activeTab === 'account' ? renderAccount() : (
            <div className="sparkz-card__about" role="tabpanel">
              <h3>How SPARKZ works</h3>
              <p>SPARKZ are rewards earned from eligible charging activity. For a charging session, the driver can spend any available SPARKZ balance as a discount.</p>
              <p>When the vehicle is unplugged, SPARKZ remain available for the next eligible session.</p>
            </div>
          )}
        </div>
      )}

      {receipt && (
        <div className="sparkz-card__receipt" role="status">
          <strong>Discount applied</strong>
          <span>Receipt {receipt.payload.receiptId}</span>
        </div>
      )}
      {reservation && (
        <div className="sparkz-card__receipt" role="status">
          <strong>{reservation.amount} SPARKZ reserved</strong>
          <span>Up to {reservation.kWhEntitlement} kWh will be free. Unused SPARKZ are released after the final CDR.</span>
        </div>
      )}

      {error && <p className="sparkz-card__error" role="alert">{error}</p>}
    </section>
  );
}
