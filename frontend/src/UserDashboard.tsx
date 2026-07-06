import React, { FormEvent, useEffect, useMemo, useState } from 'react';
import { ethers } from 'ethers';
import { ActivityList } from './AdminApp';

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

type LinkedWallet = {
  walletAddress: string;
  walletName?: string | null;
};

type WalletResponse = {
  status: string;
  uid: string;
  linkedWalletAddresses?: string[];
  linkedWallets?: LinkedWallet[];
  walletName?: string | null;
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

type DisplayWalletTransferPrompt = {
  sourceWallet: string;
  sourceKind: 'managed' | 'external';
  sourceName?: string | null;
  sourceBalance: string;
  targetWallet: string;
  targetKind: 'managed' | 'external';
  targetName?: string | null;
};

interface UserDashboardProps {
  onBack: () => void;
}

function getDefaultBaseUrl(): string {
  if (typeof window === 'undefined') return 'http://localhost:3000';
  if (window.location.port === '3001') return `${window.location.protocol}//${window.location.hostname}:3000`;
  return window.location.origin;
}

const DEFAULT_BASE_URL = getDefaultBaseUrl();

function normalizeUid(value: string): string {
  const trimmed = value.trim();
  if (trimmed.toLowerCase().startsWith('uid=')) {
    return trimmed.slice(4).trim();
  }
  return trimmed;
}

async function readJsonResponse(res: Response): Promise<any> {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    const contentType = res.headers.get('content-type') || 'unknown content type';
    const looksLikeHtml = text.trim().toLowerCase().startsWith('<!doctype') || text.trim().toLowerCase().startsWith('<html');
    if (looksLikeHtml) {
      throw new Error(`API request returned HTML from ${res.url}. Refresh the app and make sure the backend API is running on port 3000.`);
    }
    throw new Error(`API returned invalid JSON from ${res.url} (${contentType}).`);
  }
}

export default function UserDashboard({ onBack }: UserDashboardProps) {
  const baseUrl = DEFAULT_BASE_URL;
  const [uid, setUid] = useState('');
  const [accessMode] = useState<'identity' | 'test'>('test');
  const [walletData, setWalletData] = useState<WalletResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [switchingMode, setSwitchingMode] = useState(false);
  const [processingWalletTx, setProcessingWalletTx] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [feedbackKind, setFeedbackKind] = useState<'success' | 'error' | 'idle'>('idle');
  const [walletMode, setWalletMode] = useState<'managed' | 'custodial'>('managed');
  const [walletName, setWalletName] = useState('');
  const [savingWalletName, setSavingWalletName] = useState(false);
  const [linkedWalletNames, setLinkedWalletNames] = useState<Record<string, string>>({});
  const [savingLinkedWalletName, setSavingLinkedWalletName] = useState<string | null>(null);
  const [connectedWallet, setConnectedWallet] = useState('');
  const [savingLinkedWallet, setSavingLinkedWallet] = useState(false);
  const [modeSwitchWarning, setModeSwitchWarning] = useState<{
    nextMode: 'managed' | 'custodial';
    message: string;
    sourceWalletAddress?: string;
    sourceBalance?: string;
    targetWalletAddress?: string;
  } | null>(null);
  const [movingFunds, setMovingFunds] = useState(false);

  const [spendAmount, setSpendAmount] = useState(1);
  const [spendSessionId, setSpendSessionId] = useState(`user-spend-${Date.now()}`);
  const [selectedDisplayWallet, setSelectedDisplayWallet] = useState('managed');
  const [managedWalletData, setManagedWalletData] = useState<WalletResponse | null>(null);
  const [displayWalletTransferPrompt, setDisplayWalletTransferPrompt] = useState<DisplayWalletTransferPrompt | null>(null);
  const [showDisplayWalletTransferModal, setShowDisplayWalletTransferModal] = useState(false);
  const [copiedAddress, setCopiedAddress] = useState('');

  useEffect(() => {
    if (!feedback) return;
    const timer = window.setTimeout(() => setFeedback(current =>
      current === feedback ? '' : current
    ), 7000);
    return () => window.clearTimeout(timer);
  }, [feedback]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const rawContractId =
      params.get('contractId') ||
      params.get('contract_id') ||
      params.get('uid') ||
      params.get('id');
    const contractId = rawContractId ? normalizeUid(rawContractId) : '';

    if (contractId) {
      setUid(contractId);
      void loadWalletForId(contractId);
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const maskedWallet = useMemo(() => {
    if (!walletData?.walletAddress) return 'Not loaded';
    const v = walletData.walletAddress;
    return `${v.slice(0, 6)}...${v.slice(-4)}`;
  }, [walletData]);
  const linkedWallets: LinkedWallet[] = walletData?.linkedWallets?.length
    ? walletData.linkedWallets
    : (walletData?.linkedWalletAddresses || []).map(address => ({ walletAddress: address, walletName: null }));
  const linkedWalletAddresses = linkedWallets.map(wallet => wallet.walletAddress);
  const mainWalletDisplayName = walletData?.walletName || null;
  const selectedDisplayWalletAddress = selectedDisplayWallet === 'managed'
    ? walletData?.managedWalletAddress
    : selectedDisplayWallet;
  const selectedDisplayWalletKind = selectedDisplayWallet === 'managed'
    ? 'NEVERFLAT managed wallet'
    : 'Self Custody wallet';
  const selectedDisplayWalletName = selectedDisplayWallet === 'managed'
    ? mainWalletDisplayName
    : linkedWallets.find(wallet => wallet.walletAddress.toLowerCase() === selectedDisplayWallet.toLowerCase())?.walletName || null;

  useEffect(() => {
    if (selectedDisplayWallet !== 'managed' && !linkedWalletAddresses.some(address => address.toLowerCase() === selectedDisplayWallet.toLowerCase())) {
      setSelectedDisplayWallet('managed');
      setDisplayWalletTransferPrompt(null);
      setShowDisplayWalletTransferModal(false);
    }
  }, [linkedWalletAddresses, selectedDisplayWallet]);

  useEffect(() => {
    setLinkedWalletNames(Object.fromEntries(
      linkedWallets.map(wallet => [wallet.walletAddress.toLowerCase(), wallet.walletName || ''])
    ));
  }, [walletData]);

  function apiRequest(path: string, options?: RequestInit) {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options?.headers as Record<string, string> | undefined),
    };

    if (accessMode === 'identity' && uid) {
      headers['x-contract-id'] = uid;
    }

    return fetch(`${baseUrl}${path}`, {
      ...options,
      headers,
    });
  }

  async function loadWalletForId(id: string, opts?: { suppressFeedback?: boolean; walletAddress?: string }) {
    const normalizedId = normalizeUid(id);
    if (!normalizedId) return;
    if (uid !== normalizedId) {
      setUid(normalizedId);
    }
    setLoading(true);
    if (!opts?.suppressFeedback) { setFeedback('Loading wallet...'); setFeedbackKind('idle'); }
    try {
      const walletQuery = opts?.walletAddress ? `?walletAddress=${encodeURIComponent(opts.walletAddress)}` : '';
      const res = await apiRequest(`/wallet/${encodeURIComponent(normalizedId)}${walletQuery}`);
      const data = await readJsonResponse(res);
      if (!res.ok) {
        setWalletData(null);
        setFeedback(data?.message || data?.error || 'Failed to load wallet');
        setFeedbackKind('error');
        return;
      }
      const wallet = data as WalletResponse;
      setWalletData(wallet);
      if (!opts?.walletAddress) {
        setManagedWalletData(wallet);
      }
      setWalletMode(wallet.walletMode);
      setWalletName(wallet.walletName || '');
      if (!opts?.suppressFeedback) { setFeedback(''); setFeedbackKind('idle'); }
    } catch (err) {
      setWalletData(null);
      setFeedback(err instanceof Error ? err.message : String(err));
      setFeedbackKind('error');
    } finally {
      setLoading(false);
    }
  }

  async function loadWalletForCurrentUser(opts?: { suppressFeedback?: boolean; walletAddress?: string }): Promise<boolean> {
    setLoading(true);
    if (!opts?.suppressFeedback) { setFeedback('Loading your wallet...'); setFeedbackKind('idle'); }
    try {
      const walletQuery = opts?.walletAddress ? `?walletAddress=${encodeURIComponent(opts.walletAddress)}` : '';
      const res = await apiRequest(`/wallet/me${walletQuery}`);
      const data = await readJsonResponse(res);
      if (!res.ok) {
        if (!opts?.suppressFeedback) {
          setFeedback(data?.message || data?.error || 'Failed to load wallet from identity context');
          setFeedbackKind('error');
        }
        return false;
      }

      const wallet = data as WalletResponse;
      setWalletData(wallet);
      if (!opts?.walletAddress) {
        setManagedWalletData(wallet);
      }
      setWalletMode(wallet.walletMode);
      setWalletName(wallet.walletName || '');
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
    const walletAddress = selectedDisplayWallet === 'managed' ? undefined : selectedDisplayWallet;
    if (accessMode === 'identity') {
      await loadWalletForCurrentUser({ ...opts, walletAddress });
      return;
    }
    await loadWalletForId(uid, { ...opts, walletAddress });
  }

  async function selectDisplayWallet(nextWallet: string) {
    const normalizedUid = normalizeUid(uid || walletData?.uid || '');
    if (!normalizedUid) {
      setFeedback('Load your wallet first.');
      setFeedbackKind('error');
      return;
    }

    const previousWallet = selectedDisplayWallet;
    const previousWalletAddress = previousWallet === 'managed'
      ? walletData?.managedWalletAddress
      : previousWallet;
    const nextWalletAddress = nextWallet === 'managed'
      ? walletData?.managedWalletAddress
      : nextWallet;
    const previousBalance = Number(walletData?.balance || 0);
    const previousWalletName = previousWallet === 'managed'
      ? managedWalletData?.walletName || walletData?.walletName || null
      : linkedWallets.find(wallet => wallet.walletAddress.toLowerCase() === previousWallet.toLowerCase())?.walletName || null;
    const nextWalletName = nextWallet === 'managed'
      ? managedWalletData?.walletName || walletData?.walletName || null
      : linkedWallets.find(wallet => wallet.walletAddress.toLowerCase() === nextWallet.toLowerCase())?.walletName || null;

    setSelectedDisplayWallet(nextWallet);
    const walletAddress = nextWallet === 'managed' ? undefined : nextWallet;
    await loadWalletForId(normalizedUid, { walletAddress, suppressFeedback: true });

    if (
      previousWallet !== nextWallet &&
      previousWalletAddress &&
      nextWalletAddress &&
      previousBalance > 0
    ) {
      setDisplayWalletTransferPrompt({
        sourceWallet: previousWalletAddress,
        sourceKind: previousWallet === 'managed' ? 'managed' : 'external',
        sourceName: previousWalletName,
        sourceBalance: walletData?.balance || '0',
        targetWallet: nextWalletAddress,
        targetKind: nextWallet === 'managed' ? 'managed' : 'external',
        targetName: nextWalletName,
      });
      setShowDisplayWalletTransferModal(true);
    } else {
      setDisplayWalletTransferPrompt(null);
      setShowDisplayWalletTransferModal(false);
    }
  }

  async function transferDisplayWalletFunds() {
    const normalizedUid = normalizeUid(uid || walletData?.uid || '');
    if (!normalizedUid || !displayWalletTransferPrompt) return;
    setMovingFunds(true);
    setFeedback('Moving wallet funds...');
    setFeedbackKind('idle');
    try {
      if (displayWalletTransferPrompt.sourceKind === 'managed') {
        const moveRes = await apiRequest(`/wallet/${encodeURIComponent(normalizedUid)}/move-funds`, {
          method: 'POST',
          body: JSON.stringify({ targetAddress: displayWalletTransferPrompt.targetWallet }),
        });
        const moveData = await readJsonResponse(moveRes);
        if (!moveRes.ok) {
          setFeedback(moveData?.error || moveData?.message || 'Failed to move managed wallet funds');
          setFeedbackKind('error');
          return;
        }
      } else {
        const win = window as Window & { ethereum?: ethers.Eip1193Provider };
        if (!win.ethereum) {
          setFeedback('No wallet extension found.');
          setFeedbackKind('error');
          return;
        }
        let provider = new ethers.BrowserProvider(win.ethereum);
        const network = await provider.getNetwork();
        if (Number(network.chainId) !== 80002) {
          await provider.send('wallet_switchEthereumChain', [{ chainId: '0x13882' }]);
          provider = new ethers.BrowserProvider(win.ethereum);
        }
        const signer = await provider.getSigner();
        const signerAddress = ethers.getAddress(await signer.getAddress());
        if (signerAddress.toLowerCase() !== displayWalletTransferPrompt.sourceWallet.toLowerCase()) {
          setFeedback(`Connected wallet ${signerAddress} does not match ${displayWalletTransferPrompt.sourceWallet}.`);
          setFeedbackKind('error');
          return;
        }
        const token = new ethers.Contract(
          walletData!.tokenContractAddress,
          ['function transfer(address to, uint256 amount) returns (bool)'],
          signer
        );
        setFeedback('Confirm the transfer in your wallet...');
        const tx = await token.transfer(
          displayWalletTransferPrompt.targetWallet,
          ethers.parseEther(displayWalletTransferPrompt.sourceBalance)
        );
        setFeedback(`Transfer submitted. Waiting for confirmation... ${tx.hash}`);
        await tx.wait();
      }

      const targetWallet = selectedDisplayWallet === 'managed' ? undefined : selectedDisplayWallet;
      setDisplayWalletTransferPrompt(null);
      setShowDisplayWalletTransferModal(false);
      setFeedback(`Moved ${displayWalletTransferPrompt.sourceBalance} SPARKZ to the selected wallet.`);
      setFeedbackKind('success');
      await loadWalletForId(normalizedUid, { suppressFeedback: true });
      await loadWalletForId(normalizedUid, { walletAddress: targetWallet, suppressFeedback: true });
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err));
      setFeedbackKind('error');
    } finally {
      setMovingFunds(false);
    }
  }

  async function saveWalletName() {
    const normalizedUid = normalizeUid(uid || walletData?.uid || '');
    if (!normalizedUid) { setFeedback('Load your wallet first.'); setFeedbackKind('error'); return; }
    setSavingWalletName(true);
    setFeedback('Saving wallet name...');
    setFeedbackKind('idle');
    try {
      const res = await apiRequest(`/wallet/${encodeURIComponent(normalizedUid)}/profile`, {
        method: 'PATCH',
        body: JSON.stringify({
          walletName: walletName.trim() || null,
          walletAddress: walletData?.walletAddress,
        }),
      });
      const data = await readJsonResponse(res);
      if (!res.ok) {
        setFeedback(data?.message || data?.error || 'Failed to save wallet name');
        setFeedbackKind('error');
        return;
      }
      const wallet = data as WalletResponse;
      setWalletData(wallet);
      setWalletMode(wallet.walletMode);
      setWalletName(wallet.walletName || '');
      setFeedback(wallet.walletName ? 'Wallet name saved.' : 'Wallet name cleared.');
      setFeedbackKind('success');
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err));
      setFeedbackKind('error');
    } finally {
      setSavingWalletName(false);
    }
  }

  async function saveLinkedWalletName(walletAddress: string) {
    const normalizedUid = normalizeUid(uid || walletData?.uid || '');
    if (!normalizedUid) { setFeedback('Load your wallet first.'); setFeedbackKind('error'); return; }

    const checksumAddress = ethers.getAddress(walletAddress);
    const walletName = linkedWalletNames[checksumAddress.toLowerCase()]?.trim() || null;
    setSavingLinkedWalletName(checksumAddress);
    setFeedback('Saving linked wallet name...');
    setFeedbackKind('idle');
    try {
      const res = await apiRequest(`/wallet/${encodeURIComponent(normalizedUid)}/linked-wallets/${encodeURIComponent(checksumAddress)}/profile`, {
        method: 'PATCH',
        body: JSON.stringify({ walletName }),
      });
      const data = await readJsonResponse(res);
      if (!res.ok) {
        setFeedback(data?.message || data?.error || 'Failed to save linked wallet name');
        setFeedbackKind('error');
        return;
      }
      const wallet = data as WalletResponse;
      if (selectedDisplayWallet.toLowerCase() === checksumAddress.toLowerCase()) {
        setWalletData(wallet);
      } else {
        await refreshWallet({ suppressFeedback: true });
      }
      setWalletMode(wallet.walletMode);
      setFeedback(walletName ? 'Linked wallet name saved.' : 'Linked wallet name cleared.');
      setFeedbackKind('success');
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err));
      setFeedbackKind('error');
    } finally {
      setSavingLinkedWalletName(null);
    }
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

  async function copyAddress(address?: string | null) {
    if (!address) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(address);
      } else {
        const textarea = document.createElement('textarea');
        textarea.value = address;
        textarea.setAttribute('readonly', 'true');
        textarea.style.position = 'fixed';
        textarea.style.opacity = '0';
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
      setCopiedAddress(address.toLowerCase());
      window.setTimeout(() => {
        setCopiedAddress(current => current === address.toLowerCase() ? '' : current);
      }, 1400);
      setFeedback('Address copied.');
      setFeedbackKind('success');
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Failed to copy address');
      setFeedbackKind('error');
    }
  }

  function UiIcon({ type }: { type: 'wallet' | 'link' | 'plug' | 'info' }) {
    const paths: Record<typeof type, React.ReactNode> = {
      wallet: (
        <>
          <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H18a2 2 0 0 1 2 2v10.5A2.5 2.5 0 0 1 17.5 20h-12A2.5 2.5 0 0 1 3 17.5v-10Z" />
          <path d="M16 12h4v4h-4a2 2 0 0 1 0-4Z" />
          <path d="M5.5 5A2.5 2.5 0 0 0 3 7.5V8h14" />
        </>
      ),
      link: (
        <>
          <path d="M10 13a5 5 0 0 0 7.07 0l2.12-2.12a5 5 0 0 0-7.07-7.07L11 4.93" />
          <path d="M14 11a5 5 0 0 0-7.07 0L4.81 13.1a5 5 0 1 0 7.07 7.07L13 19.07" />
        </>
      ),
      plug: (
        <>
          <path d="M8 2v6" />
          <path d="M16 2v6" />
          <path d="M6 8h12v3a6 6 0 0 1-12 0V8Z" />
          <path d="M12 17v5" />
        </>
      ),
      info: (
        <>
          <circle cx="12" cy="12" r="9" />
          <path d="M12 10v6" />
          <path d="M12 7h.01" />
        </>
      ),
    };
    return (
      <svg className="ui-icon" viewBox="0 0 24 24" aria-hidden="true">
        {paths[type]}
      </svg>
    );
  }

  function InfoTooltip({ text }: { text: string }) {
    return (
      <span className="info-tooltip">
        <button type="button" className="info-tooltip__trigger" aria-label={text}>
          <UiIcon type="info" />
        </button>
        <span className="info-tooltip__content" role="tooltip">{text}</span>
      </span>
    );
  }

  function CopyAddressButton({ address }: { address?: string | null }) {
    if (!address) return null;
    const isCopied = copiedAddress === address.toLowerCase();
    return (
      <span className="copy-address-wrap">
        <button
          type="button"
          className="copy-address-btn"
          onClick={() => copyAddress(address)}
          title="Copy address"
          aria-label="Copy address"
          aria-live="polite"
        >
          <svg viewBox="0 0 24 24" aria-hidden="true">
            <rect x="8" y="8" width="11" height="11" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v1" />
          </svg>
        </button>
        {isCopied && <span className="copy-confirmation">Copied</span>}
      </span>
    );
  }

  function NamedAddress({ address, name }: { address?: string | null; name?: string | null }) {
    return (
      <span className="named-address">
        {name && <span className="named-address__name">{name}</span>}
        <span className="address-copy-row">
          <strong>{address || 'No wallet loaded'}</strong>
          <CopyAddressButton address={address} />
        </span>
      </span>
    );
  }

  function SparkzValue({ value }: { value?: string }) {
    return (
      <span className="sparkz-value">
        <img src="/sparkz-token-icon.png" alt="SPARKZ token icon" />
        <span>{value || '0.00'} SPARKZ</span>
      </span>
    );
  }

  function getLinkedWalletSignatureMessage(contractId: string, walletAddress: string, action: 'link' | 'unlink'): string {
    return [
      `NEVERFLAT ${action} wallet address`,
      `EMP contract: ${contractId}`,
      `Wallet address: ${ethers.getAddress(walletAddress)}`,
    ].join('\n');
  }

  async function signLinkedWalletAction(contractId: string, walletAddress: string, action: 'link' | 'unlink') {
    const win = window as Window & { ethereum?: ethers.Eip1193Provider & { request?: (args: { method: string; params?: unknown[] }) => Promise<unknown> } };
    if (!win.ethereum) {
      throw new Error('No EVM wallet detected. Install MetaMask, Rabby, or Phantom.');
    }

    const checksumAddress = ethers.getAddress(walletAddress);
    const provider = new ethers.BrowserProvider(win.ethereum);
    try {
      await win.ethereum.request?.({
        method: 'wallet_requestPermissions',
        params: [{ eth_accounts: {} }],
      });
    } catch {
      // Some wallets do not support the permissions prompt, or the user may cancel it.
      // eth_requestAccounts below is the standard fallback.
    }
    await provider.send('eth_requestAccounts', []);
    const signer = await provider.getSigner();
    const signerAddress = ethers.getAddress(await signer.getAddress());

    if (signerAddress.toLowerCase() !== checksumAddress.toLowerCase()) {
      throw new Error(`To ${action} ${checksumAddress}, choose that exact account in your wallet extension and sign. A blockchain address cannot receive a signing request unless a wallet app controlling it is connected.`);
    }

    setConnectedWallet(signerAddress);
    return signer.signMessage(getLinkedWalletSignatureMessage(contractId, checksumAddress, action));
  }

  async function linkWalletAddress(walletAddress: string) {
    const normalizedUid = normalizeUid(uid || walletData?.uid || '');
    const rawAddress = walletAddress.trim();
    if (!normalizedUid) { setFeedback('Load your wallet first.'); setFeedbackKind('error'); return; }
    if (!rawAddress || !ethers.isAddress(rawAddress)) {
      setFeedback('Enter a valid blockchain wallet address.');
      setFeedbackKind('error');
      return;
    }
    const checksumAddress = ethers.getAddress(rawAddress);
    const linkedWallets = walletData?.linkedWalletAddresses || [];
    if (linkedWallets.some(address => address.toLowerCase() === checksumAddress.toLowerCase())) {
      setFeedback('That wallet address is already linked.');
      setFeedbackKind('idle');
      return;
    }
    if (linkedWallets.length >= 5) {
      setFeedback('You can link up to 5 wallet addresses.');
      setFeedbackKind('error');
      return;
    }

    setSavingLinkedWallet(true);
    setFeedback('Sign in your wallet to link this address...');
    setFeedbackKind('idle');
    try {
      const signature = await signLinkedWalletAction(normalizedUid, checksumAddress, 'link');
      setFeedback('Linking wallet address...');
      const res = await apiRequest(`/wallet/${encodeURIComponent(normalizedUid)}/linked-wallets`, {
        method: 'POST',
        body: JSON.stringify({ walletAddress: checksumAddress, signature }),
      });
      const data = await readJsonResponse(res);
      if (!res.ok) {
        setFeedback(data?.message || data?.error || 'Failed to link wallet address');
        setFeedbackKind('error');
        return;
      }
      const wallet = data as WalletResponse;
      setSelectedDisplayWallet(checksumAddress);
      setWalletData(wallet);
      setWalletMode(wallet.walletMode);
      if (managedWalletData && Number(managedWalletData.balance || 0) > 0) {
        setDisplayWalletTransferPrompt({
          sourceWallet: managedWalletData.managedWalletAddress,
          sourceKind: 'managed',
          sourceName: managedWalletData.walletName || null,
          sourceBalance: managedWalletData.balance,
          targetWallet: checksumAddress,
          targetKind: 'external',
          targetName: wallet.linkedWallets?.find(linkedWallet => linkedWallet.walletAddress.toLowerCase() === checksumAddress.toLowerCase())?.walletName || null,
        });
        setShowDisplayWalletTransferModal(true);
      }
      setFeedback('Wallet address linked.');
      setFeedbackKind('success');
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err));
      setFeedbackKind('error');
    } finally {
      setSavingLinkedWallet(false);
    }
  }

  async function linkSelectedBrowserWallet() {
    const win = window as Window & { ethereum?: ethers.Eip1193Provider };
    if (!win.ethereum) {
      setFeedback('No EVM wallet detected. Install MetaMask, Rabby, or Phantom.');
      setFeedbackKind('error');
      return;
    }

    try {
      const provider = new ethers.BrowserProvider(win.ethereum);
      const accounts = await provider.send('eth_requestAccounts', []);
      const address = accounts?.[0];
      if (!address) {
        setFeedback('No account returned.');
        setFeedbackKind('error');
        return;
      }
      const checksumAddress = ethers.getAddress(address);
      setConnectedWallet(checksumAddress);
      await linkWalletAddress(checksumAddress);
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err));
      setFeedbackKind('error');
    }
  }

  async function unlinkWalletAddress(walletAddress: string) {
    const normalizedUid = normalizeUid(uid || walletData?.uid || '');
    if (!normalizedUid) { setFeedback('Load your wallet first.'); setFeedbackKind('error'); return; }
    setSavingLinkedWallet(true);
    setFeedback('Sign in your wallet to unlink this address...');
    setFeedbackKind('idle');
    try {
      const checksumAddress = ethers.getAddress(walletAddress);
      const signature = await signLinkedWalletAction(normalizedUid, checksumAddress, 'unlink');
      setFeedback('Unlinking wallet address...');
      const res = await apiRequest(`/wallet/${encodeURIComponent(normalizedUid)}/linked-wallets/${encodeURIComponent(walletAddress)}`, {
        method: 'DELETE',
        body: JSON.stringify({ signature }),
      });
      const data = await readJsonResponse(res);
      if (!res.ok) {
        setFeedback(data?.message || data?.error || 'Failed to unlink wallet address');
        setFeedbackKind('error');
        return;
      }
      const wallet = data as WalletResponse;
      setWalletData(wallet);
      setWalletMode(wallet.walletMode);
      setFeedback('Wallet address unlinked.');
      setFeedbackKind('success');
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : String(err));
      setFeedbackKind('error');
    } finally {
      setSavingLinkedWallet(false);
    }
  }

  async function unlinkExternalWallet() {
    if (walletMode !== 'custodial') {
      setFeedback('No external wallet is linked.');
      setFeedbackKind('idle');
      return;
    }
    await switchWalletMode('managed');
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
        // Source = managed wallet to treasury transfers to the linked custodial wallet
        const moveRes = await apiRequest(`/wallet/${encodeURIComponent(normalizedUid)}/move-funds`, {
          method: 'POST',
          body: JSON.stringify({ targetAddress: connectedWallet }),
        });
        const moveData = await readJsonResponse(moveRes);
        if (!moveRes.ok) {
          setFeedback(moveData?.error || moveData?.message || 'Failed to move funds');
          setFeedbackKind('error');
          return;
        }
        setFeedback(`Moved ${moveData.amount} SPARKZ. Switching mode...`);
      } else {
        // Source = external custodial wallet to user signs transfer to managed wallet
        const managedTarget = targetWalletAddress || walletData?.managedWalletAddress;
        if (!managedTarget) { setFeedback('Managed wallet address not available.'); setFeedbackKind('error'); return; }
        const win = window as Window & { ethereum?: unknown };
        if (!win.ethereum) { setFeedback('No wallet extension found.'); setFeedbackKind('error'); return; }
        try {
          await (win.ethereum as { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> })
            .request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x13882' }] });
        } catch { /* ignore - chain may already be correct */ }
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
      const switchData = await readJsonResponse(switchRes);
      if (!switchRes.ok) {
        setFeedback(switchData?.message || switchData?.error || 'Failed to switch mode after moving funds');
        setFeedbackKind('error');
        return;
      }
      setWalletMode(nextMode);
      if (nextMode === 'managed') {
        setConnectedWallet('');
      }
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
      const data = await readJsonResponse(res);
      if (!res.ok) {
        setFeedback(data?.message || data?.error || 'Failed to switch mode');
        setFeedbackKind('error');
        return;
      }

      setWalletMode(modeSwitchWarning.nextMode);
      if (modeSwitchWarning.nextMode === 'managed') {
        setConnectedWallet('');
      }
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
      let data = await readJsonResponse(res);

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
      if (nextMode === 'managed') {
        setConnectedWallet('');
      }
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
    const data = await readJsonResponse(res);
    if (!res.ok) {
      throw new Error(data?.message || data?.error || 'Spend failed');
    }

    setFeedback(`Spend successful. ${spendAmount} SPARKZ spent.`);
    setFeedbackKind('success');
    setSpendSessionId(`user-spend-${Date.now()}`);
    await refreshWallet({ suppressFeedback: true });
  }

  async function submitCustodialSpend(walletAddress: string) {
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
      // Re-create provider after network switch - ethers v6 throws NETWORK_ERROR on the old instance
      provider = new ethers.BrowserProvider(win.ethereum);
    }

    const signer = await provider.getSigner();
    const signerAddress = ethers.getAddress(await signer.getAddress());
    const linkedAddress = ethers.getAddress(walletAddress);
    if (signerAddress !== linkedAddress) {
      throw new Error(`Connected wallet ${signerAddress} does not match the linked external wallet ${linkedAddress}.`);
    }

    setProcessingWalletTx(true);
    setFeedback('Preparing spend for your wallet...');
    setFeedbackKind('idle');

    const normalizedUid = normalizeUid(uid);
    const intentRes = await apiRequest('/spend/custodial-intent', {
      method: 'POST',
      body: JSON.stringify({
        uid: normalizedUid,
        walletAddress: signerAddress,
        amount: spendAmount,
        sessionId: spendSessionId,
      }),
    });
    const intentData = await readJsonResponse(intentRes);
    if (!intentRes.ok || !intentData?.spendIntent?.transaction) {
      throw new Error(intentData?.message || intentData?.error || 'Could not prepare wallet spend.');
    }

    let tx: ethers.TransactionResponse;
    try {
      setFeedback('Confirm the spend in your wallet...');
      tx = await signer.sendTransaction(intentData.spendIntent.transaction);
    } catch (err) {
      const failureRes = await apiRequest('/spend/custodial-failure', {
        method: 'POST',
        body: JSON.stringify({
          uid: normalizedUid,
          walletAddress: signerAddress,
          amount: spendAmount,
          sessionId: spendSessionId,
          intentId: intentData.spendIntent.intentId,
          reason: err instanceof Error ? err.message : String(err),
        }),
      });
      const failureData = await readJsonResponse(failureRes);
      throw new Error(failureData?.message || 'The wallet spend was not completed. Please retry and sign the same spend transaction.');
    }

    setFeedback(`Transaction submitted. Waiting for confirmation... ${tx.hash}`);

    await tx.wait();

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
    const recordData = await readJsonResponse(recordRes);
    if (!recordRes.ok) {
      throw new Error(recordData?.message || recordData?.error || `On-chain spend confirmed but sync failed for ${tx.hash}`);
    }

    setFeedback(`External wallet spend confirmed. Tx: ${tx.hash}`);
    setFeedbackKind('success');
    setSpendSessionId(`user-spend-${Date.now()}`);
    await refreshWallet({ suppressFeedback: true });
  }

  async function submitSpend(e: FormEvent) {
    e.preventDefault();
    const balance = Number(walletData?.balance || 0);
    if (balance <= 0) { setFeedback('No balance available to spend.'); setFeedbackKind('error'); return; }
    if (spendAmount > balance) { setFeedback(`Insufficient balance. Available: ${balance} SPARKZ`); setFeedbackKind('error'); return; }
    setFeedback('Processing spend...'); setFeedbackKind('idle');
    try {
      if (selectedDisplayWallet !== 'managed') {
        await submitCustodialSpend(selectedDisplayWallet);
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
        <div className="wallet-brand-header">
          <img className="sparkz-sidebar-logo" src="/sparkz-brand-logo.png" alt="SPARKZ logo" />
        </div>

        <div className="rail-card">
          <span className="label">Enter your EMP contract number</span>
          <input
            value={uid}
            onChange={e => setUid(e.target.value)}
            placeholder="EMP contract number"
          />
          <button
            className="btn-primary"
            onClick={() => {
              setSelectedDisplayWallet('managed');
              setDisplayWalletTransferPrompt(null);
              setShowDisplayWalletTransferModal(false);
              void loadWalletForId(uid);
            }}
            disabled={loading || !normalizeUid(uid)}
          >
            {loading ? 'Loading...' : 'Update Wallet'}
          </button>
        </div>

        <details className="rail-card sparkz-how-card">
          <summary>How SPARKZ works</summary>
          <p className="subtle">SPARKZ are reward tokens you can earn through the NEVERFLAT system.</p>
          <p className="subtle">
            You can earn SPARKZ by charging at off-peak times or by taking part in Vehicle-to-Grid activities, where your EV helps support the energy system.
          </p>
          <p className="subtle">
            When you charge at a NEVERFLAT charger, you can spend your available SPARKZ to receive a discount on your charging session.
          </p>
        </details>

        {walletData && (
          <details className="rail-card wallet-settings-card">
            <summary>Manage Wallet</summary>

          <div className="settings-group">
            <span className="label">Main Wallet Name</span>
            <input
              value={walletName}
              onChange={e => setWalletName(e.target.value)}
              placeholder="e.g. My car wallet"
              maxLength={120}
            />
            <button className="btn-primary" onClick={saveWalletName} disabled={savingWalletName}>
              {savingWalletName ? 'Saving...' : 'Save Main Wallet Name'}
            </button>
          </div>

        <div className="settings-group">
          <p className="subtle">
            {walletMode === 'custodial'
              ? 'Using your own wallet - you pay gas on Polygon Amoy.'
              : 'NEVERFLAT manages your on-chain wallet.'}
          </p>
          {modeSwitchWarning && (
            <div className="wallet-summary" style={{ marginTop: '0.75rem' }}>
              <div>
                <span className="label">Switch Warning</span>
                <p className="subtle" style={{ margin: '0.35rem 0 0.75rem' }}>{modeSwitchWarning.message}</p>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  <button type="button" onClick={moveFundsAndSwitch} disabled={switchingMode || movingFunds}>
                    {movingFunds ? 'Moving...' : 'Move Funds & Switch'}
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

            <div className="wallet-address-manager">
              <div className="wallet-address-manager__header">
              <span className="label label-with-icon"><UiIcon type="link" /> Linked Wallet Addresses</span>
              <span className="subtle">{linkedWalletAddresses.length}/5</span>
            </div>
            {linkedWalletAddresses.length > 0 ? (
              <ul className="wallet-address-list">
                {linkedWallets.map(linkedWallet => (
                  <li key={linkedWallet.walletAddress}>
                    <NamedAddress address={linkedWallet.walletAddress} name={linkedWallet.walletName} />
                    <label className="linked-wallet-name-field">
                      <span className="label">Name Linked Wallet</span>
                      <input
                        value={linkedWalletNames[linkedWallet.walletAddress.toLowerCase()] || ''}
                        onChange={e => setLinkedWalletNames(current => ({
                          ...current,
                          [linkedWallet.walletAddress.toLowerCase()]: e.target.value,
                        }))}
                        placeholder="e.g. My external wallet"
                        maxLength={120}
                      />
                    </label>
                    <button
                      type="button"
                      className="btn-ghost"
                      onClick={() => saveLinkedWalletName(linkedWallet.walletAddress)}
                      disabled={savingLinkedWalletName?.toLowerCase() === linkedWallet.walletAddress.toLowerCase()}
                    >
                      {savingLinkedWalletName?.toLowerCase() === linkedWallet.walletAddress.toLowerCase() ? 'Saving...' : 'Save Linked Wallet Name'}
                    </button>
                    <button
                      type="button"
                      className="btn-ghost btn-danger-ghost"
                      onClick={() => unlinkWalletAddress(linkedWallet.walletAddress)}
                      disabled={savingLinkedWallet}
                      title="Removes this linked wallet from the current account. It does not affect the wallet itself."
                    >
                      Unlink
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="subtle">
                {walletData ? 'No additional wallet addresses linked.' : 'Load your EMP contract wallet before linking addresses.'}
              </p>
            )}
            <button
              type="button"
              className="btn-ghost"
              onClick={linkSelectedBrowserWallet}
              disabled={savingLinkedWallet || linkedWalletAddresses.length >= 5}
            >
              {savingLinkedWallet ? 'Waiting for signature...' : 'Link Selected Browser Wallet'}
            </button>
          </div>
        </div>

          </details>
        )}

        <button className="back-btn back-btn--sidebar" onClick={onBack}>Back</button>
      </aside>

      {feedback && (
        <div
          className={`status-strip status-toast ${feedbackKind === 'success' ? 'status-strip--success' : feedbackKind === 'error' ? 'status-strip--error' : 'status-strip--neutral'}`}
          role="status"
        >
          {feedback}
        </div>
      )}

      <main className="main-view">
        <section className="sparkz-info-banner">
          <strong>Earn SPARKZ by charging off-peak or taking part in V2G.</strong>
          <span>Spend them at NEVERFLAT chargers to reduce your charging costs.</span>
        </section>

        <section className="hero-card">
          <div>
            {walletData?.walletName ? (
              <>
                <h2 className="heading-with-icon"><UiIcon type="wallet" /> {walletData.walletName}</h2>
                <div className="hero-wallet-address">
                  <span className="subtle">Address</span>
                  <span className="hero-address-row">
                    <strong>{maskedWallet}</strong>
                    <CopyAddressButton address={walletData.walletAddress} />
                  </span>
                </div>
              </>
            ) : (
              <h2 className="hero-address-row">
                <span>{maskedWallet}</span>
                <CopyAddressButton address={walletData?.walletAddress} />
              </h2>
            )}
            <p className="subtle emp-contract-line">
              <UiIcon type="plug" />
              <span>EMP contract number: {uid || 'Not loaded'}</span>
              <InfoTooltip text="The EMP contract number identifies the e-mobility provider contract linked to this wallet." />
            </p>
            {walletData && (
              <label className="display-wallet-picker">
                <span className="label display-wallet-picker__label">Active wallet</span>
                <select value={selectedDisplayWallet} onChange={e => void selectDisplayWallet(e.target.value)}>
                  <option value="managed">
                    NEVERFLAT managed wallet{managedWalletData?.walletName ? ` - ${managedWalletData.walletName}` : ''}
                  </option>
                  {linkedWallets.map(linkedWallet => (
                    <option key={linkedWallet.walletAddress} value={linkedWallet.walletAddress}>
                      Self Custody wallet{linkedWallet.walletName ? ` - ${linkedWallet.walletName}` : ''} {linkedWallet.walletAddress.slice(0, 6)}...{linkedWallet.walletAddress.slice(-4)}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          <div className="sparkz-balance-panel">
            <div className="totals-grid">
              <div>
                <p className="label label-with-tooltip">Available Balance <InfoTooltip text="SPARKZ currently available to spend." /></p>
                <p className="value"><SparkzValue value={walletData?.balance} /></p>
              </div>
              <div>
                <p className="label label-with-tooltip">Total Earned <InfoTooltip text="Total SPARKZ awarded to this wallet." /></p>
                <p className="value"><SparkzValue value={walletData?.totalAwarded} /></p>
              </div>
              <div>
                <p className="label label-with-tooltip">Total Spent <InfoTooltip text="Total SPARKZ spent from this wallet." /></p>
                <p className="value"><SparkzValue value={walletData?.totalSpent} /></p>
              </div>
            </div>
          </div>
        </section>

        {displayWalletTransferPrompt && showDisplayWalletTransferModal && (
          <div className="transfer-modal-backdrop" role="presentation">
            <section className="transfer-prompt transfer-prompt--modal" role="dialog" aria-modal="true" aria-labelledby="display-wallet-transfer-modal-title">
              <div>
                <h3 id="display-wallet-transfer-modal-title">
                  Wallet you are moving from has {displayWalletTransferPrompt.sourceBalance} SPARKZ tokens
                </h3>
                <p className="subtle">
                  Transfer them to the wallet you are moving from now?
                </p>
                <NamedAddress address={displayWalletTransferPrompt.targetWallet} name={displayWalletTransferPrompt.targetName} />
              </div>
              <div className="transfer-prompt__actions">
                <button type="button" onClick={transferDisplayWalletFunds} disabled={movingFunds}>
                  {movingFunds ? 'Transferring...' : 'Transfer Now'}
                </button>
                <button type="button" className="btn-ghost" onClick={() => setShowDisplayWalletTransferModal(false)} disabled={movingFunds}>
                  Not Now
                </button>
              </div>
            </section>
          </div>
        )}

        {displayWalletTransferPrompt && (
          <section className="transfer-prompt transfer-prompt--inline" aria-labelledby="display-wallet-transfer-inline-title">
            <div>
              <h3 id="display-wallet-transfer-inline-title">
                Wallet you are moving from has {displayWalletTransferPrompt.sourceBalance} SPARKZ tokens
              </h3>
              <p className="subtle">
                Transfer them to the wallet you are moving from now?
              </p>
              <NamedAddress address={displayWalletTransferPrompt.targetWallet} name={displayWalletTransferPrompt.targetName} />
            </div>
            <div className="transfer-prompt__actions">
              <button type="button" onClick={transferDisplayWalletFunds} disabled={movingFunds}>
                {movingFunds ? 'Transferring...' : 'Transfer Now'}
              </button>
              <button type="button" className="btn-ghost" onClick={() => setShowDisplayWalletTransferModal(true)} disabled={movingFunds}>
                Open Pop Up
              </button>
            </div>
          </section>
        )}

        {walletData && (
          <section className="actions-grid actions-grid--single">
            <form className="action-card" onSubmit={submitSpend}>
              <h3>Spend SPARKZ</h3>
              <p className="subtle">
                {selectedDisplayWallet === 'managed'
                  ? 'Spend from your NEVERFLAT managed wallet.'
                  : 'You will be asked to confirm this transaction in your connected wallet.'}
                {selectedDisplayWallet !== 'managed' && (
                  <InfoTooltip text="A wallet you control directly, such as Rabby or MetaMask. Spending requires confirmation in that wallet." />
                )}
              </p>
              <p className="subtle">Balance: <strong>{walletData.balance || '0'} SPARKZ</strong></p>
              <div className="wallet-summary">
                <div>
                  <span className="label label-with-tooltip">
                    {selectedDisplayWalletKind}
                    {selectedDisplayWallet !== 'managed' && (
                      <InfoTooltip text="A wallet you control directly, such as Rabby or MetaMask. Spending requires confirmation in that wallet." />
                    )}
                  </span>
                  <NamedAddress address={selectedDisplayWalletAddress} name={selectedDisplayWalletName} />
                </div>
              </div>
              <div className="wallet-summary wallet-summary--legacy-hidden">
                <div>
                  <span className="label label-with-tooltip">
                    {selectedDisplayWalletKind}
                    {selectedDisplayWallet !== 'managed' && (
                      <InfoTooltip text="A wallet you control directly, such as Rabby or MetaMask. Spending requires confirmation in that wallet." />
                    )}
                  </span>
                  <span className="address-copy-row">
                    <strong>{walletData.walletAddress || 'Not loaded'}</strong>
                    <CopyAddressButton address={selectedDisplayWalletAddress} />
                  </span>
                </div>
                <div>
                  <span className="label">Managed wallet</span>
                  <span className="address-copy-row">
                    <strong>{walletData.managedWalletAddress || 'Not loaded'}</strong>
                    <CopyAddressButton address={walletData.managedWalletAddress} />
                  </span>
                </div>
              </div>
              <label>
                Amount (SPARKZ)
                <input
                  type="number"
                  min="0.1"
                  step="0.1"
                  max={Number(walletData.balance || 0)}
                  value={spendAmount}
                  onChange={e => setSpendAmount(Number(e.target.value))}
                  required
                />
              </label>
              <button
                type="submit"
                disabled={
                  Number(walletData.balance) <= 0 ||
                  switchingMode ||
                  processingWalletTx
                }
              >
                {processingWalletTx ? 'Waiting for wallet...' : selectedDisplayWallet === 'managed' ? 'Spend Tokens' : 'Spend From Self Custody Wallet'}
              </button>
            </form>
          </section>
        )}

        <ActivityList history={walletData?.history || []} />
      </main>
    </div>
  );
}
