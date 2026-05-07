import React, { FormEvent, useEffect, useMemo, useState } from 'react';
import { ethers } from 'ethers';
import { ActivityList } from './AdminApp';

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

interface UserDashboardProps {
  onBack: () => void;
}

const DEFAULT_BASE_URL = 'http://localhost:3000';

function normalizeUid(value: string): string {
  const trimmed = value.trim();
  if (trimmed.toLowerCase().startsWith('uid=')) {
    return trimmed.slice(4).trim();
  }
  return trimmed;
}

export default function UserDashboard({ onBack }: UserDashboardProps) {
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URL);
  const [uid, setUid] = useState('');
  const [accessMode, setAccessMode] = useState<'identity' | 'test'>('identity');
  const [walletData, setWalletData] = useState<WalletResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [switchingMode, setSwitchingMode] = useState(false);
  const [processingWalletTx, setProcessingWalletTx] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [feedbackKind, setFeedbackKind] = useState<'success' | 'error' | 'idle'>('idle');
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
  const [showDevSettings, setShowDevSettings] = useState(false);

  const [spendAmount, setSpendAmount] = useState(1);
  const [spendSessionId, setSpendSessionId] = useState(`user-spend-${Date.now()}`);

  // ── Auto-load identity context, fallback to test mode ───────────────────
  useEffect(() => {
    (async () => {
      const params = new URLSearchParams(window.location.search);
      const forceTestMode = params.get('mode') === 'test' || params.get('testMode') === '1';
      const rawContractId =
        params.get('contractId') ||
        params.get('contract_id') ||
        params.get('uid') ||
        params.get('id');
      const contractId = rawContractId ? normalizeUid(rawContractId) : '';

      if (!forceTestMode) {
        const loadedByIdentity = await loadWalletForCurrentUser({ suppressFeedback: true });
        if (loadedByIdentity) {
          setAccessMode('identity');
          setFeedback('Wallet loaded from authenticated identity context.');
          setFeedbackKind('success');
          return;
        }
      }

      setAccessMode('test');
      if (contractId) {
        setUid(contractId);
        await loadWalletForId(contractId);
      } else {
        setLoading(false);
        setFeedback('EMP identity is not available yet. Using test mode: enter a contract ID to load a wallet.');
        setFeedbackKind('idle');
      }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const maskedWallet = useMemo(() => {
    if (!walletData?.walletAddress) return '—';
    const v = walletData.walletAddress;
    return `${v.slice(0, 6)}...${v.slice(-4)}`;
  }, [walletData]);

  function apiRequest(path: string, options?: RequestInit) {
    return fetch(`${baseUrl}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(options?.headers || {}) },
    });
  }

  async function loadWalletForId(id: string, opts?: { suppressFeedback?: boolean }) {
    const normalizedId = normalizeUid(id);
    if (!normalizedId) return;
    if (uid !== normalizedId) {
      setUid(normalizedId);
    }
    setLoading(true);
    if (!opts?.suppressFeedback) { setFeedback('Loading wallet...'); setFeedbackKind('idle'); }
    try {
      const res = await apiRequest(`/wallet/${encodeURIComponent(normalizedId)}`);
      const data = await res.json();
      if (!res.ok) {
        setWalletData(null);
        setFeedback(data?.message || data?.error || 'Failed to load wallet');
        setFeedbackKind('error');
        return;
      }
      setWalletData(data as WalletResponse);
      setWalletMode((data as WalletResponse).walletMode);
      if (!opts?.suppressFeedback) { setFeedback(''); setFeedbackKind('idle'); }
    } catch (err) {
      setWalletData(null);
      setFeedback(err instanceof Error ? err.message : String(err));
      setFeedbackKind('error');
    } finally {
      setLoading(false);
    }
  }

  async function loadWalletForCurrentUser(opts?: { suppressFeedback?: boolean }): Promise<boolean> {
    setLoading(true);
    if (!opts?.suppressFeedback) { setFeedback('Loading your wallet...'); setFeedbackKind('idle'); }
    try {
      const res = await apiRequest('/wallet/me');
      const data = await res.json();
      if (!res.ok) {
        if (!opts?.suppressFeedback) {
          setFeedback(data?.message || data?.error || 'Failed to load wallet from identity context');
          setFeedbackKind('error');
        }
        return false;
      }

      const wallet = data as WalletResponse;
      setWalletData(wallet);
      setWalletMode(wallet.walletMode);
      setUid(wallet.uid || '');
      if (!opts?.suppressFeedback) { setFeedback(''); setFeedbackKind('idle'); }
      return true;
    } catch (err) {
      if (!opts?.suppressFeedback) {
        setFeedback(err instanceof Error ? err.message : String(err));
        setFeedbackKind('error');
      }
      return false;
    } finally {
      setLoading(false);
    }
  }

  async function refreshWallet(opts?: { suppressFeedback?: boolean }) {
    if (accessMode === 'identity') {
      await loadWalletForCurrentUser(opts);
      return;
    }
    await loadWalletForId(uid, opts);
  }

  async function connectWallet() {
    const win = window as Window & { ethereum?: ethers.Eip1193Provider };
    if (!win.ethereum) {
      setFeedback('No EVM wallet detected. Install MetaMask, Rabby, or Phantom.');
      setFeedbackKind('error');
      return;
    }
    try {
      const provider = new ethers.BrowserProvider(win.ethereum);
      const accounts = await provider.send('eth_requestAccounts', []);
      const addr = accounts?.[0];
      if (!addr) { setFeedback('No account returned.'); setFeedbackKind('error'); return; }
      setConnectedWallet(ethers.getAddress(addr));
      setFeedback('Wallet connected.');
      setFeedbackKind('success');
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err));
      setFeedbackKind('error');
    }
  }

  function disconnectWallet() {
    setConnectedWallet('');
    setFeedback('External wallet disconnected.');
    setFeedbackKind('idle');
  }

  async function moveFundsAndSwitch() {
    const normalizedUid = normalizeUid(uid);
    if (!modeSwitchWarning || !normalizedUid) return;
    setMovingFunds(true);
    setFeedback('Moving funds on-chain...');
    setFeedbackKind('idle');
    try {
      const { nextMode, sourceBalance, targetWalletAddress } = modeSwitchWarning;

      if (nextMode === 'custodial') {
        // Source = managed wallet → treasury transfers to the linked custodial wallet
        const moveRes = await apiRequest(`/wallet/${encodeURIComponent(normalizedUid)}/move-funds`, {
          method: 'POST',
          body: JSON.stringify({ targetAddress: connectedWallet }),
        });
        const moveData = await moveRes.json();
        if (!moveRes.ok) {
          setFeedback(moveData?.error || moveData?.message || 'Failed to move funds');
          setFeedbackKind('error');
          return;
        }
        setFeedback(`Moved ${moveData.amount} SPARKZ. Switching mode...`);
      } else {
        // Source = external custodial wallet → user signs transfer to managed wallet
        const managedTarget = targetWalletAddress || walletData?.managedWalletAddress;
        if (!managedTarget) { setFeedback('Managed wallet address not available.'); setFeedbackKind('error'); return; }
        const win = window as Window & { ethereum?: unknown };
        if (!win.ethereum) { setFeedback('No wallet extension found.'); setFeedbackKind('error'); return; }
        try {
          await (win.ethereum as { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> })
            .request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x13882' }] });
        } catch { /* ignore — chain may already be correct */ }
        const provider = new ethers.BrowserProvider(win.ethereum as ethers.Eip1193Provider);
        const signer = await provider.getSigner();
        const amountWei = sourceBalance ? ethers.parseEther(sourceBalance) : 0n;
        if (amountWei === 0n) { setFeedback('No balance to move.'); setFeedbackKind('error'); return; }
        const tx = await signer.sendTransaction({
          to: walletData!.tokenContractAddress,
          data: new ethers.Interface(['function transfer(address to, uint256 amount) returns (bool)'])
            .encodeFunctionData('transfer', [managedTarget, amountWei]),
        });
        setFeedback('Transfer submitted. Waiting for confirmation...');
        await tx.wait();
        setFeedback(`Moved ${sourceBalance} SPARKZ. Switching mode...`);
      }

      // Now perform the mode switch (allowSplit=true as safety valve for dust)
      const switchRes = await apiRequest(`/wallet/${encodeURIComponent(normalizedUid)}/mode`, {
        method: 'POST',
        body: JSON.stringify({
          mode: nextMode,
          walletAddress: nextMode === 'custodial' ? connectedWallet : undefined,
          allowSplit: true,
        }),
      });
      const switchData = await switchRes.json();
      if (!switchRes.ok) {
        setFeedback(switchData?.message || switchData?.error || 'Failed to switch mode after moving funds');
        setFeedbackKind('error');
        return;
      }
      setWalletMode(nextMode);
      setModeSwitchWarning(null);
      setFeedback(nextMode === 'custodial' ? 'Funds moved & external wallet linked.' : 'Funds moved & managed wallet restored.');
      setFeedbackKind('success');
      await refreshWallet({ suppressFeedback: true });
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err));
      setFeedbackKind('error');
    } finally {
      setMovingFunds(false);
    }
  }

  async function confirmModeSwitchWithSplit() {
    const normalizedUid = normalizeUid(uid);
    if (!modeSwitchWarning || !normalizedUid) return;

    setSwitchingMode(true);
    setFeedback('Switching wallet mode...');
    setFeedbackKind('idle');
    try {
      const res = await apiRequest(`/wallet/${encodeURIComponent(normalizedUid)}/mode`, {
        method: 'POST',
        body: JSON.stringify({
          mode: modeSwitchWarning.nextMode,
          walletAddress: modeSwitchWarning.nextMode === 'custodial' ? connectedWallet : undefined,
          allowSplit: true,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setFeedback(data?.message || data?.error || 'Failed to switch mode');
        setFeedbackKind('error');
        return;
      }

      setWalletMode(modeSwitchWarning.nextMode);
      setModeSwitchWarning(null);
      setFeedback(modeSwitchWarning.nextMode === 'custodial' ? 'External wallet linked.' : 'Managed wallet restored.');
      setFeedbackKind('success');
      await refreshWallet({ suppressFeedback: true });
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err));
      setFeedbackKind('error');
    } finally {
      setSwitchingMode(false);
    }
  }

  async function switchWalletMode(nextMode: 'managed' | 'custodial') {
    const normalizedUid = normalizeUid(uid);
    if (!normalizedUid) { setFeedback('No Contract ID loaded.'); setFeedbackKind('error'); return; }
    if (nextMode === 'custodial' && !connectedWallet) {
      setFeedback('Connect your external wallet first.');
      setFeedbackKind('error');
      return;
    }
    setSwitchingMode(true);
    setFeedback(nextMode === 'custodial' ? 'Linking external wallet...' : 'Restoring managed wallet...');
    setFeedbackKind('idle');
    try {
      let res = await apiRequest(`/wallet/${encodeURIComponent(normalizedUid)}/mode`, {
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
        setFeedback('Review the wallet switch warning below.');
        setFeedbackKind('error');
        return;
      }

      if (!res.ok) { setFeedback(data?.message || data?.error || 'Failed to switch mode'); setFeedbackKind('error'); return; }
      setModeSwitchWarning(null);
      setWalletMode(nextMode);
      setFeedback(nextMode === 'custodial' ? 'External wallet linked.' : 'Managed wallet restored.');
      setFeedbackKind('success');
      await refreshWallet({ suppressFeedback: true });
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err));
      setFeedbackKind('error');
    } finally {
      setSwitchingMode(false);
    }
  }

  async function submitManagedSpend() {
    const normalizedUid = normalizeUid(uid);
    const endpoint = accessMode === 'identity' ? '/spend/me' : '/spend';
    const body = accessMode === 'identity'
      ? { amount: spendAmount, label: 'User spend', sessionId: spendSessionId }
      : { uid: normalizedUid, amount: spendAmount, label: 'User spend', sessionId: spendSessionId };

    const res = await apiRequest(endpoint, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (!res.ok) {
      throw new Error(data?.message || data?.error || 'Spend failed');
    }

    setFeedback(`Spend successful. ${spendAmount} SPARKZ spent.`);
    setFeedbackKind('success');
    setSpendSessionId(`user-spend-${Date.now()}`);
    await refreshWallet({ suppressFeedback: true });
  }

  async function submitCustodialSpend() {
    if (!walletData?.treasuryAddress) {
      throw new Error('Treasury address is not configured on the API.');
    }
    const win = window as Window & { ethereum?: ethers.Eip1193Provider };
    if (!win.ethereum) {
      throw new Error('No EVM wallet detected. Install MetaMask, Rabby, or Phantom.');
    }

    let provider = new ethers.BrowserProvider(win.ethereum);
    const network = await provider.getNetwork();
    if (Number(network.chainId) !== 80002) {
      try {
        await provider.send('wallet_switchEthereumChain', [{ chainId: '0x13882' }]);
      } catch (err) {
        throw new Error(`Switch your wallet to Polygon Amoy first. ${err instanceof Error ? err.message : String(err)}`);
      }
      // Re-create provider after network switch — ethers v6 throws NETWORK_ERROR on the old instance
      provider = new ethers.BrowserProvider(win.ethereum);
    }

    const signer = await provider.getSigner();
    const signerAddress = ethers.getAddress(await signer.getAddress());
    const linkedAddress = ethers.getAddress(walletData.walletAddress);
    if (signerAddress !== linkedAddress) {
      throw new Error(`Connected wallet ${signerAddress} does not match the linked external wallet ${linkedAddress}.`);
    }

    const token = new ethers.Contract(
      walletData.tokenContractAddress,
      ['function transfer(address to, uint256 amount) returns (bool)'],
      signer
    );

    setProcessingWalletTx(true);
    setFeedback('Confirm the spend in your wallet...');
    setFeedbackKind('idle');

    const tx = await token.transfer(walletData.treasuryAddress, ethers.parseEther(spendAmount.toString()));
    setFeedback(`Transaction submitted. Waiting for confirmation... ${tx.hash}`);

    await tx.wait();

    const normalizedUid = normalizeUid(uid);
    const recordRes = await apiRequest('/spend/custodial-record', {
      method: 'POST',
      body: JSON.stringify({
        uid: normalizedUid,
        walletAddress: signerAddress,
        amount: spendAmount,
        txHash: tx.hash,
        sessionId: spendSessionId,
      }),
    });
    const recordData = await recordRes.json();
    if (!recordRes.ok) {
      throw new Error(recordData?.message || recordData?.error || `On-chain spend confirmed but sync failed for ${tx.hash}`);
    }

    setFeedback(`External wallet spend confirmed. Tx: ${tx.hash}`);
    setFeedbackKind('success');
    setSpendSessionId(`user-spend-${Date.now()}`);
    await loadWalletForId(uid, { suppressFeedback: true });
  }

  async function submitSpend(e: FormEvent) {
    e.preventDefault();
    const balance = Number(walletData?.balance || 0);
    if (balance <= 0) { setFeedback('No balance available to spend.'); setFeedbackKind('error'); return; }
    if (spendAmount > balance) { setFeedback(`Insufficient balance. Available: ${balance} SPARKZ`); setFeedbackKind('error'); return; }
    setFeedback('Processing spend...'); setFeedbackKind('idle');
    try {
      if (walletMode === 'custodial') {
        await submitCustodialSpend();
      } else {
        await submitManagedSpend();
      }
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err));
      setFeedbackKind('error');
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
            <h1>My Wallet</h1>
            <p>NEVERFLAT SPARKZ</p>
          </div>
        </div>

        <div className="rail-card">
          <span className="label">Access Mode</span>
          <p className="subtle" style={{ marginBottom: '0.5rem' }}>
            {accessMode === 'identity'
              ? 'Authenticated identity context (EMP-ready).'
              : 'Test mode (manual contract ID lookup).'}
          </p>
          {accessMode === 'test' ? (
            <>
              <span className="label">Contract ID</span>
              <input
                value={uid}
                onChange={e => setUid(e.target.value)}
                placeholder="e.g. DE-ABC-C-000012345-X"
              />
              <button onClick={() => loadWalletForId(uid)} disabled={loading}>
                {loading ? 'Loading...' : 'Load Wallet'}
              </button>
            </>
          ) : (
            <>
              <span className="label">Resolved Contract ID</span>
              <input value={uid} readOnly placeholder="Provided by EMP identity" />
              <button onClick={() => loadWalletForCurrentUser()} disabled={loading}>
                {loading ? 'Loading...' : 'Refresh My Wallet'}
              </button>
            </>
          )}
        </div>

        <div className="rail-card">
          <span className="label">Wallet Mode</span>
          <div className="mode-toggle">
            <button
              type="button"
              className={`mode-chip${walletMode === 'managed' ? ' mode-chip--active' : ''}`}
              onClick={() => switchWalletMode('managed')}
              disabled={switchingMode || walletMode === 'managed'}
            >
              Managed
            </button>
            <button
              type="button"
              className={`mode-chip${walletMode === 'custodial' ? ' mode-chip--active' : ''}`}
              onClick={() => switchWalletMode('custodial')}
              disabled={switchingMode || walletMode === 'custodial'}
            >
              External Wallet
            </button>
          </div>
          <p className="subtle">
            {walletMode === 'custodial'
              ? 'Using your own wallet — you pay gas on Polygon Amoy.'
              : 'NEVERFLAT manages your on-chain wallet.'}
          </p>
          <button type="button" className="btn-ghost" onClick={connectWallet}>
            {connectedWallet ? 'Reconnect Wallet' : 'Connect MetaMask / Rabby / Phantom'}
          </button>
          <button type="button" className="btn-ghost" onClick={disconnectWallet} disabled={!connectedWallet}>
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
          <input value={baseUrl} onChange={e => setBaseUrl(e.target.value)} />
          <span className="label">API Key</span>
          <input value={''} readOnly type="password" placeholder="X-API-Key (if required)" />
        </div>

        {feedback && (
          <div className={`status-strip ${feedbackKind === 'success' ? 'status-strip--success' : feedbackKind === 'error' ? 'status-strip--error' : 'status-strip--neutral'}`}>
            {feedback}
          </div>
        )}
      </aside>

      <main className="main-view">
        <section className="hero-card">
          <div>
            <p className="label">Wallet Address</p>
            <h2>{maskedWallet}</h2>
            <p className="subtle">Contract ID: {uid || '—'}</p>
            <p className="subtle">Mode: {walletMode === 'custodial' ? 'External wallet' : 'Managed wallet'}</p>
          </div>
          <div className="totals-grid">
            <div><p className="label">Available Balance</p><p className="value">{walletData?.balance || '0.00'} SPARKZ</p></div>
            <div><p className="label">Total Earned</p><p className="value">{walletData?.totalAwarded || '0.00'} SPARKZ</p></div>
            <div><p className="label">Total Spent</p><p className="value">{walletData?.totalSpent || '0.00'} SPARKZ</p></div>
          </div>
        </section>

        <section className="actions-grid actions-grid--single">
          <form className="action-card" onSubmit={submitSpend}>
            <h3>Spend SPARKZ</h3>
            <p className="subtle">
              {walletMode === 'custodial'
                ? 'Your connected external wallet will ask you to confirm the spend and pay gas on Polygon Amoy.'
                : 'Redeem your tokens through the managed NEVERFLAT flow.'}
            </p>
            <p className="subtle">Balance: <strong>{walletData?.balance || '0'} SPARKZ</strong></p>
            <div className="wallet-summary">
              <div>
                <span className="label">Active wallet</span>
                <strong>{walletData?.walletAddress || '—'}</strong>
              </div>
              <div>
                <span className="label">Managed wallet</span>
                <strong>{walletData?.managedWalletAddress || '—'}</strong>
              </div>
            </div>
            <label>
              Amount (SPARKZ)
              <input
                type="number"
                min="0.1"
                step="0.1"
                max={Number(walletData?.balance || 0)}
                value={spendAmount}
                onChange={e => setSpendAmount(Number(e.target.value))}
                required
              />
            </label>
            <button
              type="submit"
              disabled={
                !walletData ||
                Number(walletData.balance) <= 0 ||
                switchingMode ||
                processingWalletTx ||
                (walletMode === 'custodial' && !connectedWallet)
              }
            >
              {processingWalletTx ? 'Waiting for wallet...' : walletMode === 'custodial' ? 'Spend From External Wallet' : 'Spend Tokens'}
            </button>
          </form>
        </section>

        <ActivityList history={walletData?.history || []} />
      </main>
    </div>
  );
}
