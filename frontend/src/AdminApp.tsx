import React, { FormEvent, useMemo, useState } from 'react';
import { ethers } from 'ethers';
import AdminDashboard from './AdminDashboard';

type WalletHistoryItem = {
  type: 'award' | 'spend';
  amount: string;
  txHash?: string;
  timestamp?: string;
  awardType?: string;
};

type WalletResponse = {
  status: string;
  uid: string;
  walletAddress: string;
  managedWalletAddress: string;
  walletMode: 'managed' | 'custodial';
  treasuryAddress: string | null;
  tokenContractAddress: string;
  balance: string;
  totalAwarded: string;
  totalSpent: string;
  history: WalletHistoryItem[];
};

type ApiFeedback = {
  kind: 'success' | 'error' | 'idle';
  message: string;
};

interface AdminAppProps {
  onBack: () => void;
}

export default function AdminApp({ onBack }: AdminAppProps) {
  // ── Admin login gate ──────────────────────────────
  const [adminToken, setAdminToken] = useState<string | null>(null);
  const [loginUsername, setLoginUsername] = useState('admin');
  const [loginPassword, setLoginPassword] = useState('');
  const [loginError, setLoginError] = useState('');
  const [baseUrl, setBaseUrl] = useState('http://localhost:3000');

  async function login(e: FormEvent) {
    e.preventDefault();
    setLoginError('');
    try {
      const res = await fetch(`${baseUrl}/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: loginUsername, password: loginPassword }),
      });
      const data = await res.json();
      if (!res.ok) {
        setLoginError(data?.message || 'Invalid credentials');
        return;
      }
      setAdminToken(data.token);
      setLoginPassword('');
    } catch (err) {
      setLoginError(err instanceof Error ? err.message : String(err));
    }
  }

  async function logout() {
    if (adminToken) {
      await fetch(`${baseUrl}/admin/logout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${adminToken}` },
      }).catch(() => {});
    }
    setAdminToken(null);
  }

  if (!adminToken) {
    return (
      <div className="wallet-shell login-shell">
        <div className="login-panel">
          <button className="back-btn" onClick={onBack}>← Back</button>
          <div className="brand-lockup" style={{ marginBottom: '1.5rem' }}>
            <div className="brand-glyph">N</div>
            <div>
              <h1>Admin Dashboard</h1>
              <p>Authorised access only</p>
            </div>
          </div>
          <form className="action-card" onSubmit={login} style={{ maxWidth: 360 }}>
            <label>
              API URL
              <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} />
            </label>
            <label>
              Username
              <input value={loginUsername} onChange={e => setLoginUsername(e.target.value)} autoComplete="username" required />
            </label>
            <label>
              Password
              <input type="password" value={loginPassword} onChange={e => setLoginPassword(e.target.value)} autoComplete="current-password" required />
            </label>
            {loginError && <p className="admin-error">{loginError}</p>}
            <button type="submit">Sign In</button>
          </form>
        </div>
      </div>
    );
  }

  // ── Authenticated admin shell ─────────────────────
  return <AdminShell baseUrl={baseUrl} adminToken={adminToken} onLogout={logout} onBack={onBack} />;
}

// ── Inner shell (rendered once authenticated) ────────────────────────────────
interface AdminShellProps {
  baseUrl: string;
  adminToken: string;
  onLogout: () => void;
  onBack: () => void;
}

function AdminShell({ baseUrl, adminToken, onLogout, onBack }: AdminShellProps) {
  const [apiKey, setApiKey] = useState('');
  const [uid, setUid] = useState('demo-user-001');
  const [walletData, setWalletData] = useState<WalletResponse | null>(null);
  const [healthStatus, setHealthStatus] = useState('Unknown');
  const [loadingWallet, setLoadingWallet] = useState(false);
  const [feedback, setFeedback] = useState<ApiFeedback>({ kind: 'idle', message: 'Ready' });

  const [awardSessionId, setAwardSessionId] = useState(`session-${Date.now()}`);
  const [awardProviderId, setAwardProviderId] = useState('nvf-demo');
  const [awardEvseId, setAwardEvseId] = useState('DE*ABC*E*001');
  const [awardEnergyKwh, setAwardEnergyKwh] = useState(12);
  const [awardDirection, setAwardDirection] = useState<'CHARGE' | 'DISCHARGE'>('DISCHARGE');

  const [spendAmount, setSpendAmount] = useState(5);
  const [spendSessionId, setSpendSessionId] = useState(`spend-${Date.now()}`);
  const [spendProviderId, setSpendProviderId] = useState('nvf-demo');

  const [walletMode, setWalletMode] = useState<'managed' | 'custodial'>('managed');
  const [connectedWallet, setConnectedWallet] = useState('');
  const [modeSwitchWarning, setModeSwitchWarning] = useState<{
    nextMode: 'managed' | 'custodial';
    message: string;
    sourceWalletAddress?: string;
    sourceBalance?: string;
    targetWalletAddress?: string;
  } | null>(null);
  const [movingFunds, setMovingFunds] = useState(false);
  const [switchingMode, setSwitchingMode] = useState(false);
  const [processingWalletTx, setProcessingWalletTx] = useState(false);

  const [activeTab, setActiveTab] = useState<'transactions' | 'rewardlogic'>('transactions');

  const maskedWallet = useMemo(() => {
    if (!walletData?.walletAddress) return 'No wallet loaded';
    const v = walletData.walletAddress;
    return `${v.slice(0, 6)}...${v.slice(-4)}`;
  }, [walletData]);

  async function apiRequest(path: string, options?: RequestInit) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (apiKey.trim()) headers['X-API-Key'] = apiKey.trim();
    return fetch(`${baseUrl}${path}`, {
      ...options,
      headers: { ...headers, ...(options?.headers || {}) },
    });
  }

  async function checkHealth() {
    try {
      const res = await apiRequest('/ingest/health', { method: 'GET' });
      if (!res.ok) { setHealthStatus(`Unhealthy (${res.status})`); return; }
      const data = await res.json();
      setHealthStatus(`Online (${data.status})`);
    } catch (err) {
      setHealthStatus(`Offline (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  async function loadWallet(options?: { suppressFeedback?: boolean }) {
    setLoadingWallet(true);
    if (!options?.suppressFeedback) setFeedback({ kind: 'idle', message: 'Loading wallet...' });
    try {
      const res = await apiRequest(`/wallet/${encodeURIComponent(uid)}`, { method: 'GET' });
      const data = await res.json();
      if (!res.ok) {
        setWalletData(null);
        setFeedback({ kind: 'error', message: data?.message || data?.error || 'Failed to load wallet' });
        return;
      }
      setWalletData(data as WalletResponse);
      setWalletMode((data as WalletResponse).walletMode ?? 'managed');
      if (!options?.suppressFeedback) setFeedback({ kind: 'success', message: 'Wallet loaded successfully.' });
    } catch (err) {
      setWalletData(null);
      setFeedback({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setLoadingWallet(false);
    }
  }

  async function connectWallet() {
    const win = window as Window & { ethereum?: ethers.Eip1193Provider };
    if (!win.ethereum) {
      setFeedback({ kind: 'error', message: 'No EVM wallet detected. Install MetaMask, Rabby, or Phantom.' });
      return;
    }
    try {
      const provider = new ethers.BrowserProvider(win.ethereum);
      const accounts = await provider.send('eth_requestAccounts', []);
      const addr = accounts?.[0];
      if (!addr) { setFeedback({ kind: 'error', message: 'No account returned.' }); return; }
      setConnectedWallet(ethers.getAddress(addr));
      setFeedback({ kind: 'success', message: 'Wallet connected.' });
    } catch (err) {
      setFeedback({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  function disconnectWallet() {
    setConnectedWallet('');
    setFeedback({ kind: 'idle', message: 'External wallet disconnected.' });
  }

  async function moveFundsAndSwitch() {
    if (!modeSwitchWarning || !uid.trim()) return;
    setMovingFunds(true);
    setFeedback({ kind: 'idle', message: 'Moving funds on-chain...' });
    try {
      const { nextMode, sourceBalance, targetWalletAddress } = modeSwitchWarning;

      if (nextMode === 'custodial') {
        // Source = managed wallet → treasury transfers to the linked custodial wallet
        const moveRes = await apiRequest(`/wallet/${encodeURIComponent(uid)}/move-funds`, {
          method: 'POST',
          body: JSON.stringify({ targetAddress: connectedWallet }),
        });
        const moveData = await moveRes.json();
        if (!moveRes.ok) {
          setFeedback({ kind: 'error', message: moveData?.error || moveData?.message || 'Failed to move funds' });
          return;
        }
        setFeedback({ kind: 'idle', message: `Moved ${moveData.amount} SPARKZ. Switching mode...` });
      } else {
        // Source = external custodial wallet → connected wallet signs transfer to managed wallet
        const managedTarget = targetWalletAddress || walletData?.managedWalletAddress;
        if (!managedTarget) { setFeedback({ kind: 'error', message: 'Managed wallet address not available.' }); return; }
        const win = window as Window & { ethereum?: unknown };
        if (!win.ethereum) { setFeedback({ kind: 'error', message: 'No wallet extension found.' }); return; }
        try {
          await (win.ethereum as { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> })
            .request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x13882' }] });
        } catch { /* ignore */ }
        const provider = new ethers.BrowserProvider(win.ethereum as ethers.Eip1193Provider);
        const signer = await provider.getSigner();
        const amountWei = sourceBalance ? ethers.parseEther(sourceBalance) : 0n;
        if (amountWei === 0n) { setFeedback({ kind: 'error', message: 'No balance to move.' }); return; }
        const tx = await signer.sendTransaction({
          to: walletData!.tokenContractAddress,
          data: new ethers.Interface(['function transfer(address to, uint256 amount) returns (bool)'])
            .encodeFunctionData('transfer', [managedTarget, amountWei]),
        });
        setFeedback({ kind: 'idle', message: 'Transfer submitted. Waiting for confirmation...' });
        await tx.wait();
        setFeedback({ kind: 'idle', message: `Moved ${sourceBalance} SPARKZ. Switching mode...` });
      }

      const switchRes = await apiRequest(`/wallet/${encodeURIComponent(uid)}/mode`, {
        method: 'POST',
        body: JSON.stringify({
          mode: nextMode,
          walletAddress: nextMode === 'custodial' ? connectedWallet : undefined,
          allowSplit: true,
        }),
      });
      const switchData = await switchRes.json();
      if (!switchRes.ok) {
        setFeedback({ kind: 'error', message: switchData?.message || switchData?.error || 'Failed to switch mode after moving funds' });
        return;
      }
      setWalletMode(nextMode);
      setModeSwitchWarning(null);
      setFeedback({ kind: 'success', message: nextMode === 'custodial' ? 'Funds moved & external wallet linked.' : 'Funds moved & managed wallet restored.' });
      await loadWallet({ suppressFeedback: true });
    } catch (err) {
      setFeedback({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setMovingFunds(false);
    }
  }

  async function confirmModeSwitchWithSplit() {
    if (!modeSwitchWarning || !uid.trim()) return;

    setSwitchingMode(true);
    setFeedback({ kind: 'idle', message: 'Switching wallet mode...' });
    try {
      const res = await apiRequest(`/wallet/${encodeURIComponent(uid)}/mode`, {
        method: 'POST',
        body: JSON.stringify({
          mode: modeSwitchWarning.nextMode,
          walletAddress: modeSwitchWarning.nextMode === 'custodial' ? connectedWallet : undefined,
          allowSplit: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFeedback({ kind: 'error', message: data?.message || data?.error || 'Failed to switch mode' });
        return;
      }

      setWalletMode(modeSwitchWarning.nextMode);
      setModeSwitchWarning(null);
      setFeedback({ kind: 'success', message: modeSwitchWarning.nextMode === 'custodial' ? 'External wallet linked.' : 'Managed wallet restored.' });
      await loadWallet({ suppressFeedback: true });
    } catch (err) {
      setFeedback({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setSwitchingMode(false);
    }
  }

  async function switchWalletMode(nextMode: 'managed' | 'custodial') {
    if (!uid.trim()) { setFeedback({ kind: 'error', message: 'Load a wallet first.' }); return; }
    if (nextMode === 'custodial' && !connectedWallet) {
      setFeedback({ kind: 'error', message: 'Connect your external wallet first.' });
      return;
    }
    setSwitchingMode(true);
    setFeedback({ kind: 'idle', message: nextMode === 'custodial' ? 'Linking external wallet...' : 'Restoring managed wallet...' });
    try {
      let res = await apiRequest(`/wallet/${encodeURIComponent(uid)}/mode`, {
        method: 'POST',
        body: JSON.stringify({ mode: nextMode, walletAddress: nextMode === 'custodial' ? connectedWallet : undefined }),
      });
      let data = await res.json();

      if (!res.ok && data?.code === 'SOURCE_WALLET_HAS_BALANCE') {
        setModeSwitchWarning({
          nextMode,
          message: data?.message || 'Switching now will keep funds in both wallets until you consolidate them.',
          sourceWalletAddress: data?.sourceWalletAddress,
          sourceBalance: data?.sourceBalance,
          targetWalletAddress: data?.targetWalletAddress,
        });
        setFeedback({ kind: 'error', message: 'Review the wallet switch warning below.' });
        return;
      }

      if (!res.ok) { setFeedback({ kind: 'error', message: data?.message || data?.error || 'Failed to switch mode' }); return; }
      setModeSwitchWarning(null);
      setWalletMode(nextMode);
      setFeedback({ kind: 'success', message: nextMode === 'custodial' ? 'External wallet linked.' : 'Managed wallet restored.' });
      await loadWallet({ suppressFeedback: true });
    } catch (err) {
      setFeedback({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setSwitchingMode(false);
    }
  }

  async function submitCustodialSpend() {
    if (!walletData?.treasuryAddress) throw new Error('Treasury address not configured on the API.');
    const win = window as Window & { ethereum?: ethers.Eip1193Provider };
    if (!win.ethereum) throw new Error('No EVM wallet detected.');

    let provider = new ethers.BrowserProvider(win.ethereum);
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== 80002) {
      await provider.send('wallet_switchEthereumChain', [{ chainId: '0x13882' }]).catch((err: unknown) => {
        throw new Error(`Switch to Polygon Amoy first. ${err instanceof Error ? err.message : String(err)}`);
      });
      // Re-create provider after network switch — ethers v6 throws NETWORK_ERROR on the old instance
      provider = new ethers.BrowserProvider(win.ethereum);
    }

    const signer = await provider.getSigner();
    const signerAddress = ethers.getAddress(await signer.getAddress());
    const linkedAddress = ethers.getAddress(walletData.walletAddress);
    if (signerAddress !== linkedAddress) {
      throw new Error(`Connected wallet (${signerAddress}) does not match linked wallet (${linkedAddress}).`);
    }

    const token = new ethers.Contract(
      walletData.tokenContractAddress,
      ['function transfer(address to, uint256 amount) returns (bool)'],
      signer
    );

    setProcessingWalletTx(true);
    setFeedback({ kind: 'idle', message: 'Confirm spend in your wallet...' });
    const tx = await token.transfer(walletData.treasuryAddress, ethers.parseEther(spendAmount.toString()));
    setFeedback({ kind: 'idle', message: `Submitted — waiting for confirmation...` });
    await tx.wait();

    const recordRes = await apiRequest('/spend/custodial-record', {
      method: 'POST',
      body: JSON.stringify({ uid, walletAddress: signerAddress, amount: spendAmount, txHash: tx.hash, sessionId: spendSessionId }),
    });
    const recordData = await recordRes.json();
    if (!recordRes.ok) throw new Error(recordData?.message || recordData?.error || `On-chain confirmed but sync failed: ${tx.hash}`);

    setFeedback({ kind: 'success', message: `Custodial spend confirmed. Tx: ${tx.hash}` });
    setSpendSessionId(`spend-${Date.now()}`);
    await loadWallet({ suppressFeedback: true });
  }

  async function submitAward(event: FormEvent) {
    event.preventDefault();
    setFeedback({ kind: 'idle', message: 'Submitting award...' });
    try {
      const startTime = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const endTime = new Date().toISOString();
      const res = await apiRequest('/ingest/cdr', {
        method: 'POST',
        body: JSON.stringify({
          SessionID: awardSessionId,
          ProviderID: awardProviderId,
          cdr_token: { contract_id: uid },
          EVSEID: awardEvseId,
          StartTime: startTime,
          EndTime: endTime,
          Energy: awardEnergyKwh.toString(),
          EnergyDirection: awardDirection,
        }),
      });
      const data = await res.json();
      if (!res.ok) { setFeedback({ kind: 'error', message: data?.message || data?.error || 'Award failed' }); return; }
      const eligible = Boolean(data?.eligible);
      const txHash = data?.txHash;
      if (!eligible) { setFeedback({ kind: 'error', message: data?.message || 'CDR accepted but not eligible for reward.' }); return; }
      if (!txHash) { setFeedback({ kind: 'error', message: 'Award eligible but tx hash missing. Check backend logs.' }); return; }
      setFeedback({ kind: 'success', message: `Award processed. Tx: ${txHash}` });
      setAwardSessionId(`session-${Date.now()}`);
      await loadWallet({ suppressFeedback: true });
    } catch (err) {
      setFeedback({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    }
  }

  async function submitSpend(event: FormEvent) {
    event.preventDefault();
    const currentBalance = Number(walletData?.balance || 0);
    if (currentBalance <= 0) { setFeedback({ kind: 'error', message: 'No balance to spend. Award tokens first.' }); return; }
    setFeedback({ kind: 'idle', message: 'Submitting spend...' });
    try {
      if (walletMode === 'custodial') {
        await submitCustodialSpend();
      } else {
        const res = await apiRequest('/spend', {
          method: 'POST',
          body: JSON.stringify({ uid, amount: spendAmount, sessionId: spendSessionId, providerId: spendProviderId, label: 'Admin test spend' }),
        });
        const data = await res.json();
        if (!res.ok) { setFeedback({ kind: 'error', message: data?.message || data?.error || 'Spend failed' }); return; }
        setFeedback({ kind: 'success', message: `Spend processed. Tx: ${data.txHash || 'pending'}` });
        setSpendSessionId(`spend-${Date.now()}`);
        await loadWallet({ suppressFeedback: true });
      }
    } catch (err) {
      setFeedback({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
    } finally {
      setProcessingWalletTx(false);
    }
  }

  return (
    <div className="wallet-shell">
      <aside className="left-rail">
        <div className="brand-lockup">
          <button className="back-btn" onClick={onBack}>←</button>
          <div className="brand-glyph">N</div>
          <div>
            <h1>Admin</h1>
            <p>NEVERFLAT Platform</p>
          </div>
        </div>

        <div className="rail-card">
          <span className="label">User UID</span>
          <input value={uid} onChange={(e) => setUid(e.target.value)} />
          <button onClick={() => loadWallet()} disabled={loadingWallet}>
            {loadingWallet ? 'Loading...' : 'Load Wallet'}
          </button>
        </div>

        {/* Wallet mode — for partner demos */}
        <div className="rail-card">
          <span className="label">Wallet Mode</span>
          <div className="mode-toggle">
            <button
              type="button"
              className={`mode-chip${walletMode === 'managed' ? ' mode-chip--active' : ''}`}
              onClick={() => switchWalletMode('managed')}
              disabled={switchingMode || walletMode === 'managed' || !walletData}
            >
              Managed
            </button>
            <button
              type="button"
              className={`mode-chip${walletMode === 'custodial' ? ' mode-chip--active' : ''}`}
              onClick={() => switchWalletMode('custodial')}
              disabled={switchingMode || walletMode === 'custodial' || !walletData}
            >
              External Wallet
            </button>
          </div>
          <button type="button" className="btn-ghost" onClick={connectWallet} style={{ marginTop: '0.5rem' }}>
            {connectedWallet ? 'Reconnect Wallet' : 'Connect MetaMask / Rabby / Phantom'}
          </button>
          <button
            type="button"
            className="btn-ghost"
            onClick={disconnectWallet}
            style={{ marginTop: '0.5rem' }}
            disabled={!connectedWallet}
          >
            Disconnect External Wallet
          </button>
          {modeSwitchWarning && (
            <div className="wallet-summary" style={{ marginTop: '0.75rem' }}>
              <div>
                <span className="label">Switch Warning</span>
                <p className="subtle" style={{ margin: '0.35rem 0 0.75rem' }}>{modeSwitchWarning.message}</p>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <button type="button" onClick={moveFundsAndSwitch} disabled={switchingMode || movingFunds}>
                    {movingFunds ? 'Moving…' : 'Move Funds & Switch'}
                  </button>
                  <button type="button" className="btn-ghost" onClick={confirmModeSwitchWithSplit} disabled={switchingMode || movingFunds}>
                    Continue Anyway
                  </button>
                  <button type="button" className="btn-ghost" onClick={() => setModeSwitchWarning(null)} disabled={switchingMode || movingFunds}>
                    Cancel
                  </button>
                </div>
              </div>
            </div>
          )}
          {connectedWallet && (
            <div className="wallet-connection">
              <span className="label">Connected</span>
              <strong>{connectedWallet.slice(0, 8)}...{connectedWallet.slice(-6)}</strong>
            </div>
          )}
        </div>

        <div className="rail-card">
          <span className="label">API URL</span>
          <input value={baseUrl} readOnly style={{ opacity: 0.6 }} />
          <span className="label">API Key</span>
          <input value={apiKey} onChange={(e) => setApiKey(e.target.value)} type="password" placeholder="X-API-Key" />
          <button onClick={checkHealth}>Check Backend</button>
          <p className="health">{healthStatus}</p>
        </div>

        <div className="status-strip status-strip--neutral">{feedback.message}</div>

        <nav className="rail-tab-nav">
          <button className={`rail-tab${activeTab === 'transactions' ? ' rail-tab--active' : ''}`} onClick={() => setActiveTab('transactions')}>
            Test Transactions
          </button>
          <button className={`rail-tab${activeTab === 'rewardlogic' ? ' rail-tab--active' : ''}`} onClick={() => setActiveTab('rewardlogic')}>
            Reward Logic
          </button>
        </nav>

        <button className="btn-ghost" style={{ marginTop: '0.75rem' }} onClick={onLogout}>Sign Out</button>
      </aside>

      <main className="main-view">
        {activeTab === 'rewardlogic' ? (
          <AdminDashboard baseUrl={baseUrl} apiKey={apiKey} externalToken={adminToken} />
        ) : (
          <>
            <section className="hero-card">
              <div>
                <p className="label">Wallet Address</p>
                <h2>{maskedWallet}</h2>
                <p className="subtle">UID: {uid}</p>
                <p className="subtle">Mode: {walletMode === 'custodial' ? 'External wallet' : 'Managed wallet'}</p>
              </div>
              <div className="totals-grid">
                <div><p className="label">Current Balance</p><p className="value">{walletData?.balance || '0.00'} SPARKZ</p></div>
                <div><p className="label">Total Awarded</p><p className="value">{walletData?.totalAwarded || '0.00'} SPARKZ</p></div>
                <div><p className="label">Total Spent</p><p className="value">{walletData?.totalSpent || '0.00'} SPARKZ</p></div>
              </div>
            </section>

            <section className="actions-grid">
              <form className="action-card" onSubmit={submitAward}>
                <h3>Simulate Award</h3>
                <p className="subtle">DISCHARGE is pre-selected and usually eligible.</p>
                <label>Session ID<input value={awardSessionId} onChange={(e) => setAwardSessionId(e.target.value)} required /></label>
                <label>Provider ID<input value={awardProviderId} onChange={(e) => setAwardProviderId(e.target.value)} required /></label>
                <label>EVSEID<input value={awardEvseId} onChange={(e) => setAwardEvseId(e.target.value)} required /></label>
                <label>
                  Energy kWh
                  <input type="number" min="0.1" step="0.1" value={awardEnergyKwh} onChange={(e) => setAwardEnergyKwh(Number(e.target.value))} required />
                </label>
                <label>
                  Direction
                  <select value={awardDirection} onChange={(e) => setAwardDirection(e.target.value as 'CHARGE' | 'DISCHARGE')}>
                    <option value="CHARGE">CHARGE</option>
                    <option value="DISCHARGE">DISCHARGE</option>
                  </select>
                </label>
                <button type="submit">Submit Award</button>
              </form>

              <form className="action-card" onSubmit={submitSpend}>
                <h3>Simulate Spend</h3>
                <p className="subtle">
                  {walletMode === 'custodial'
                    ? 'Your connected wallet will sign and pay gas on Polygon Amoy.'
                    : 'Deducts from wallet balance via managed flow.'}
                </p>
                {walletMode === 'custodial' && (
                  <div className="wallet-summary">
                    <div><span className="label">Spending from</span><strong>{walletData?.walletAddress || '—'}</strong></div>
                  </div>
                )}
                <label>Session ID<input value={spendSessionId} onChange={(e) => setSpendSessionId(e.target.value)} required /></label>
                <label>Provider ID<input value={spendProviderId} onChange={(e) => setSpendProviderId(e.target.value)} required /></label>
                <label>
                  Amount (SPARKZ)
                  <input type="number" min="0.1" step="0.1" value={spendAmount} onChange={(e) => setSpendAmount(Number(e.target.value))} required />
                </label>
                <button
                  type="submit"
                  disabled={processingWalletTx || switchingMode || (walletMode === 'custodial' && !connectedWallet)}
                >
                  {processingWalletTx ? 'Waiting for wallet...' : walletMode === 'custodial' ? 'Spend From External Wallet' : 'Submit Spend'}
                </button>
              </form>
            </section>

            <ActivityList history={walletData?.history || []} />
          </>
        )}
      </main>
    </div>
  );
}

// Shared activity list component
export function ActivityList({ history }: { history: WalletHistoryItem[] }) {
  return (
    <section className="activity-card">
      <h3>Recent Activity</h3>
      {!history.length && <p className="subtle">No activity yet.</p>}
      {!!history.length && (
        <ul>
          {history.slice(0, 10).map((item, index) => {
            const rowContent = (
              <>
                <div>
                  <strong>{item.type.toUpperCase()}</strong>
                  <p>{item.amount} SPARKZ{item.awardType ? ` • ${item.awardType}` : ''}</p>
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
