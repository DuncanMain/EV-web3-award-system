import { FormEvent, useEffect, useMemo, useRef, useState } from 'react';
import { ethers } from 'ethers';
import type {
  SparkzActiveSessionStatus,
  SparkzActivityItem,
  SparkzChargingCardProps,
  SparkzRewardRate,
  SparkzReservation,
  SparkzReservationSettlement,
  SparkzSessionResponse,
  SparkzSpendReceipt,
  SparkzWalletResponse,
} from './types';
import {
  apiUrl,
  isTerminalReservationSettlement,
  matchesReservationContext,
  normalizeApiBaseUrl,
  sessionScopeKey,
  type SparkzReservationTrackingContext,
} from './chargingCardContract';
import sparkzLogo from './sparkz-logo.svg';

type SpendResponse = {
  status: 'success';
  reservation: SparkzReservation;
};

type ReservationApprovalIntent = {
  status: 'requires_signature';
  walletAddress: string;
  requiredAllowance: string;
  transaction: { from: string; to: string; value: string; data: string };
};

type BrowserEthereumProvider = {
  request: (args: { method: string; params?: unknown[] }) => Promise<unknown>;
};

type SpendOperationContext = {
  token: number;
  ownerGeneration: number;
  contractId: string;
  apiBaseUrl: string;
  sessionGeneration: number;
  sessionScopeKey: string;
  sessionId: string;
  providerId: string;
};

class StaleSpendOperationError extends Error {
  constructor() {
    super('The charging session changed before the reservation could be completed.');
    this.name = 'StaleSpendOperationError';
  }
}

function invokeHostCallback(callback: (() => unknown) | undefined, onError: (error: unknown) => void): void {
  try {
    const result = callback?.();
    if (result && typeof (result as { then?: unknown }).then === 'function') {
      void Promise.resolve(result).catch(onError);
    }
  } catch (error) {
    onError(error);
  }
}

const activeSessionStatuses: SparkzActiveSessionStatus[] = ['CHARGER_OPENED', 'PLUGGED_IN', 'SESSION_STARTED'];

async function readJson<T>(res: Response): Promise<T> {
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw data || { status: 'error', message: `Request failed with ${res.status}` };
  }
  return data as T;
}

function getErrorMessage(err: unknown): string {
  if (err && typeof err === 'object') {
    const response = err as { message?: unknown; error?: unknown; code?: unknown };
    const detail = response.message ?? response.error;
    if (detail !== undefined && detail !== null && String(detail).trim()) return String(detail);
    if (response.code !== undefined && response.code !== null) return String(response.code);
  }
  return err instanceof Error ? err.message : String(err);
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
  reservationId,
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
  onReservationSettlement,
  reservationPollIntervalMs = 10000,
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
  const [settlement, setSettlement] = useState<SparkzReservationSettlement | null>(null);
  const [reservationTracking, setReservationTracking] = useState<SparkzReservationTrackingContext | null>(null);
  const [walletOwnerContractId, setWalletOwnerContractId] = useState<string | null>(null);
  const [walletOwnerApiBaseUrl, setWalletOwnerApiBaseUrl] = useState<string | null>(null);
  const [sessionContextKey, setSessionContextKey] = useState<string | null>(null);
  const notifiedSettlementId = useRef<string | null>(null);
  const onReservationSettlementRef = useRef(onReservationSettlement);
  const activeSessionScopeRef = useRef<string | null>(null);
  const ownerGenerationRef = useRef(0);
  const ownerScopeRef = useRef({ contractId, apiBaseUrl: normalizeApiBaseUrl(apiBaseUrl) });
  const sessionGenerationRef = useRef(0);
  const sessionScopeRef = useRef(sessionScopeKey(contractId, sessionId, providerId));
  const currentSessionContextRef = useRef({
    scopeKey: sessionScopeKey(contractId, sessionId, providerId),
    hasSessionContext: Boolean(contractId && sessionId && providerId && isActiveSessionStatus(sessionStatus)),
    sessionId,
    providerId,
  });
  const activeOperationTokenRef = useRef(0);
  const activeWalletOperationTokenRef = useRef(0);
  const mountedRef = useRef(true);
  const [dismissed, setDismissed] = useState(false);
  const [activeTab, setActiveTab] = useState<'activity' | 'account' | 'about'>('activity');

  const hasActiveSessionStatus = isActiveSessionStatus(sessionStatus);
  const hasSessionContext = Boolean(contractId && sessionId && providerId && hasActiveSessionStatus);
  const normalizedApiBaseUrl = normalizeApiBaseUrl(apiBaseUrl);
  const currentSessionScopeKey = sessionScopeKey(contractId, sessionId, providerId);
  const currentSessionContextKey = `${normalizedApiBaseUrl}\u0001${currentSessionScopeKey}`;

  currentSessionContextRef.current = {
    scopeKey: currentSessionScopeKey,
    hasSessionContext,
    sessionId,
    providerId,
  };

  // Update these guards during render so a response resolving between a prop
  // change and the cleanup of the previous effect cannot mutate the new owner.
  if (ownerScopeRef.current.contractId !== contractId
    || ownerScopeRef.current.apiBaseUrl !== normalizedApiBaseUrl) {
    ownerScopeRef.current = { contractId, apiBaseUrl: normalizedApiBaseUrl };
    ownerGenerationRef.current += 1;
    activeOperationTokenRef.current += 1;
    activeWalletOperationTokenRef.current += 1;
  }
  if (sessionScopeRef.current !== currentSessionScopeKey) {
    sessionScopeRef.current = currentSessionScopeKey;
    sessionGenerationRef.current += 1;
  }

  const isOwnerGenerationCurrent = (
    generation: number,
    expectedContractId: string,
    expectedApiBaseUrl: string,
  ): boolean => ownerGenerationRef.current === generation
    && mountedRef.current
    && ownerScopeRef.current.contractId === expectedContractId
    && ownerScopeRef.current.apiBaseUrl === expectedApiBaseUrl;
  const isSessionGenerationCurrent = (generation: number, expectedScope: string): boolean =>
    sessionGenerationRef.current === generation && sessionScopeRef.current === expectedScope;
  const visibleWallet = walletOwnerContractId === contractId && walletOwnerApiBaseUrl === normalizedApiBaseUrl ? wallet : null;
  const visibleSession = sessionContextKey === currentSessionContextKey ? session : null;
  const reservationOwnedByCurrentEndpoint = reservationTracking?.contractId === contractId
    && reservationTracking.apiBaseUrl === normalizedApiBaseUrl;
  const reservationMatchesCurrentSession = reservationOwnedByCurrentEndpoint
    && (!hasSessionContext
      || (reservationTracking.sessionId === sessionId && reservationTracking.providerId === providerId));
  const visibleReservation = reservationMatchesCurrentSession ? reservation : null;
  const visibleSettlement = reservationMatchesCurrentSession
    && settlement?.reservationId === reservationTracking?.reservationId ? settlement : null;
  const visibleReceipt = reservationMatchesCurrentSession
    && settlement?.reservationId === reservationTracking?.reservationId ? receipt : null;
  const visibleSettlementIsTerminal = Boolean(visibleSettlement && isTerminalReservationSettlement(visibleSettlement));
  const reservationPending = Boolean(
    reservationOwnedByCurrentEndpoint
    && (!settlement
      || settlement.reservationId !== reservationTracking?.reservationId
      || !isTerminalReservationSettlement(settlement)),
  );
  const displayStatus = visibleSession ? visibleSession.sessionStatus.replace(/_/g, ' ') : 'UNPLUGGED';
  const activityItems = visibleSession?.recentActivity || visibleWallet?.history || [];
  const walletBalance = visibleSession?.wallet.availableBalance ?? visibleWallet?.balance ?? 0;
  const walletEarned = visibleWallet?.totalAwarded || visibleSession?.wallet.totalEarned || 0;
  const walletSpent = visibleWallet?.totalSpent || visibleSession?.wallet.totalSpent || 0;

  const isSpendOwnerOperationCurrent = (operation: SpendOperationContext): boolean => {
    if (!mountedRef.current) return false;
    if (!isOwnerGenerationCurrent(operation.ownerGeneration, operation.contractId, operation.apiBaseUrl)) {
      return false;
    }
    return activeOperationTokenRef.current === operation.token;
  };
  const isSpendRequestCurrent = (operation: SpendOperationContext): boolean => {
    if (!isSpendOwnerOperationCurrent(operation)) return false;
    // A new request must remain tied to the session that authorized it. Once
    // /spend/me has been sent, the separate retention guard preserves the
    // server-created reservation across a close or a new active session.
    const current = currentSessionContextRef.current;
    return current.hasSessionContext
      && current.scopeKey === operation.sessionScopeKey
      && current.sessionId === operation.sessionId
      && current.providerId === operation.providerId
      && isSessionGenerationCurrent(operation.sessionGeneration, operation.sessionScopeKey);
  };
  const isReservationRetentionCurrent = (operation: SpendOperationContext): boolean =>
    isSpendOwnerOperationCurrent(operation);
  const shouldDismissAfterReservation = (operation: SpendOperationContext): boolean => {
    if (isSessionGenerationCurrent(operation.sessionGeneration, operation.sessionScopeKey)) return true;
    const current = currentSessionContextRef.current;
    if (current.hasSessionContext) return false;
    return (!current.sessionId || current.sessionId === operation.sessionId)
      && (!current.providerId || current.providerId === operation.providerId);
  };

  useEffect(() => {
    onReservationSettlementRef.current = onReservationSettlement;
  }, [onReservationSettlement]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // A contract/eMAID change is an ownership boundary. Clear all data that was
  // loaded under the previous owner before the next request can render it.
  // Session close is deliberately excluded: the reservation poll must keep
  // using its captured owner until the final receipt or release is observed.
  useEffect(() => {
    setWallet(null);
    setWalletOwnerContractId(null);
    setWalletOwnerApiBaseUrl(null);
    setConnectedWallet('');
    setSession(null);
    setSessionContextKey(null);
    setReservation(null);
    setReservationTracking(null);
    setSettlement(null);
    setReceipt(null);
    setLoading(false);
    setLoadingWallet(false);
    setSpending(false);
    setSwitchingMode(false);
    setSigningWallet(false);
    setError('');
    setWalletError('');
    notifiedSettlementId.current = null;
    setDismissed(false);
  }, [contractId, normalizedApiBaseUrl]);

  // Resume an existing reservation after a remount. This only starts the
  // read-only status poll; it cannot create a new reservation.
  useEffect(() => {
    const requestedReservationId = reservationId?.trim();
    if (!requestedReservationId || !contractId) return;
    if (!sessionId || !providerId) {
      setError('A resumed reservation requires its original session ID and provider ID.');
      return;
    }
    if (reservationTracking?.reservationId === requestedReservationId
      && reservationTracking.contractId === contractId
      && reservationTracking.apiBaseUrl === normalizedApiBaseUrl) return;
    if (reservationTracking && (!settlement || !isTerminalReservationSettlement(settlement))) {
      setError('A previous reservation is still settling. Keep polling it before selecting another reservation.');
      return;
    }
    setReservation({
      id: requestedReservationId,
      status: 'reserved',
      amount: '0.00',
      kWhEntitlement: '0.00',
      availableBalance: 0,
    });
    setReservationTracking({
      reservationId: requestedReservationId,
      contractId,
      apiBaseUrl: normalizedApiBaseUrl,
      sessionId,
      providerId,
    });
    setSettlement(null);
    setReceipt(null);
    notifiedSettlementId.current = null;
  }, [contractId, normalizedApiBaseUrl, providerId, reservationId, sessionId, reservationTracking, settlement]);

  useEffect(() => {
    const tracking = reservationTracking;
    if (!tracking) return;
    const trackingContext: SparkzReservationTrackingContext = tracking;
    const trackingOwnerGeneration = ownerGenerationRef.current;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const isPollingCurrent = () => !cancelled
      && mountedRef.current
      && isOwnerGenerationCurrent(
        trackingOwnerGeneration,
        trackingContext.contractId,
        trackingContext.apiBaseUrl,
      );
    const isPollingUiCurrent = () => {
      if (!isPollingCurrent()) return false;
      const current = currentSessionContextRef.current;
      return !current.hasSessionContext
        || (current.sessionId === trackingContext.sessionId && current.providerId === trackingContext.providerId);
    };

    const reportCallbackError = (label: string, err: unknown) => {
      if (isPollingUiCurrent()) setError(`${label} callback failed: ${getErrorMessage(err)}`);
    };

    async function pollReservation() {
      if (!isPollingCurrent()) return;
      try {
        const res = await fetch(apiUrl(trackingContext.apiBaseUrl, `/spend/reservations/${encodeURIComponent(trackingContext.reservationId)}`), {
          method: 'GET',
          headers: contractHeaders(trackingContext.contractId),
        });
        const data = await readJson<SparkzReservationSettlement>(res);
        if (!isPollingCurrent()) return;
        if (!matchesReservationContext(data, trackingContext)) {
          if (isPollingUiCurrent()) {
            setError('Reservation status did not match the saved charging session; polling stopped for safety.');
          }
          return;
        }
        setSettlement(data);
        if (isTerminalReservationSettlement(data)) {
          setReceipt(data.spendReceipt || null);
          if (notifiedSettlementId.current !== data.reservationId) {
            // Mark before invoking application callbacks so a callback error or
            // rerender cannot cause a second settlement notification.
            notifiedSettlementId.current = data.reservationId;
            invokeHostCallback(
              () => onReservationSettlementRef.current?.(data),
              err => reportCallbackError('Reservation settlement', err),
            );
          }
          return;
        }
      } catch (err) {
        if (isPollingUiCurrent()) setError(getErrorMessage(err));
      }
      if (isPollingCurrent()) timer = setTimeout(pollReservation, Math.max(1000, reservationPollIntervalMs));
    }

    void pollReservation();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [normalizedApiBaseUrl, reservationPollIntervalMs, reservationTracking]);

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
    const walletOwnerGeneration = ownerGenerationRef.current;
    const isWalletCurrent = () => !cancelled
      && mountedRef.current
      && isOwnerGenerationCurrent(walletOwnerGeneration, contractId, normalizedApiBaseUrl);

    async function loadWallet() {
      if (!isWalletCurrent()) return;
      setLoadingWallet(true);
      setWalletError('');
      try {
        const res = await fetch(apiUrl(normalizedApiBaseUrl, '/wallet/me'), {
          method: 'GET',
          headers: contractHeaders(contractId),
        });
        const data = await readJson<SparkzWalletResponse>(res);
        if (!isWalletCurrent()) return;
        setWallet(data);
        setWalletOwnerContractId(contractId);
        setWalletOwnerApiBaseUrl(normalizedApiBaseUrl);
        setConnectedWallet(data.walletMode === 'custodial' ? data.walletAddress : '');
        invokeHostCallback(() => onWalletLoaded?.(data), (callbackError) => {
          if (isWalletCurrent()) setWalletError(`Wallet loaded, but the host callback failed: ${getErrorMessage(callbackError)}`);
        });
      } catch (err) {
        if (!isWalletCurrent()) return;
        setWallet(null);
        setWalletOwnerContractId(null);
        setWalletOwnerApiBaseUrl(null);
        setWalletError(getErrorMessage(err));
      } finally {
        if (isWalletCurrent()) setLoadingWallet(false);
      }
    }

    if (contractId) {
      void loadWallet();
    } else {
      setWallet(null);
      setWalletOwnerContractId(null);
      setWalletOwnerApiBaseUrl(null);
      setWalletError('');
      setLoadingWallet(false);
    }

    return () => {
      cancelled = true;
    };
  }, [contractId, normalizedApiBaseUrl, onWalletLoaded]);

  useEffect(() => {
    let cancelled = false;
    const sessionOwnerGeneration = ownerGenerationRef.current;
    const sessionGeneration = sessionGenerationRef.current;
    const sessionScope = currentSessionScopeKey;
    const isSessionLoadCurrent = () => !cancelled
      && mountedRef.current
      && isOwnerGenerationCurrent(sessionOwnerGeneration, contractId, normalizedApiBaseUrl)
      && isSessionGenerationCurrent(sessionGeneration, sessionScope);

    async function loadSession() {
      if (!isSessionLoadCurrent()) return;
      setLoading(true);
      setError('');
      try {
        const res = await fetch(apiUrl(normalizedApiBaseUrl, '/spend/session'), {
          method: 'POST',
          headers: contractHeaders(contractId),
          body: JSON.stringify(sessionRequest),
        });
        const data = await readJson<SparkzSessionResponse>(res);
        if (!isSessionLoadCurrent()) return;
        setSession(data);
        setSessionContextKey(currentSessionContextKey);
        setSelectedAmount(data.spend.suggestedAmount > 0 ? data.spend.suggestedAmount.toString() : '');
      } catch (err) {
        if (!isSessionLoadCurrent()) return;
        setSession(null);
        setSessionContextKey(null);
        setError(getErrorMessage(err));
      } finally {
        if (isSessionLoadCurrent()) setLoading(false);
      }
    }

    if (hasSessionContext) {
      void loadSession();
    } else if (isSessionLoadCurrent()) {
      setSession(null);
      setSessionContextKey(null);
      setError('');
      setLoading(false);
    }

    return () => {
      cancelled = true;
    };
  }, [contractId, currentSessionContextKey, currentSessionScopeKey, hasSessionContext, normalizedApiBaseUrl, providerId, sessionId, sessionRequest, sessionStatus]);

  useEffect(() => {
    if (!hasSessionContext) {
      activeSessionScopeRef.current = null;
      return;
    }
    if (activeSessionScopeRef.current !== currentSessionScopeKey) {
      activeSessionScopeRef.current = currentSessionScopeKey;
      setDismissed(false);
      setReceipt(null);
    }
  }, [currentSessionScopeKey, hasSessionContext]);

  async function applyDiscount(e: FormEvent) {
    e.preventDefault();
    if (!visibleSession || !sessionId || !providerId) return;
    if (reservationPending) {
      setError('A previous reservation is still settling. Wait for its signed receipt or release before creating another reservation.');
      return;
    }

    const amount = Number(selectedAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      setError('Enter an amount greater than 0.');
      return;
    }
    if (amount > visibleSession.spend.maxSpendable) {
      setError(`Amount cannot exceed ${money(visibleSession.spend.maxSpendable)} SPARKZ.`);
      return;
    }

    const operation: SpendOperationContext = {
      token: activeOperationTokenRef.current + 1,
      ownerGeneration: ownerGenerationRef.current,
      contractId,
      apiBaseUrl: normalizedApiBaseUrl,
      sessionGeneration: sessionGenerationRef.current,
      sessionScopeKey: currentSessionScopeKey,
      sessionId,
      providerId,
    };
    activeOperationTokenRef.current = operation.token;
    setSpending(true);
    setError('');
    setReceipt(null);
    let spendRequestStarted = false;
    try {
      const assertCurrent = () => {
        if (!isSpendRequestCurrent(operation)) throw new StaleSpendOperationError();
      };
      assertCurrent();
      let authorizationTxHash: string | undefined;
      let reservationWalletAddress: string | undefined;
      if (visibleWallet?.walletMode === 'custodial') {
        const ethereum = (window as Window & { ethereum?: BrowserEthereumProvider }).ethereum;
        if (!ethereum) throw new Error('Open the linked wallet to authorize this reservation.');
        reservationWalletAddress = visibleWallet.walletAddress;
        assertCurrent();
        const intentRes = await fetch(apiUrl(normalizedApiBaseUrl, '/spend/reservation-approval-intent'), {
          method: 'POST',
          headers: contractHeaders(contractId),
          body: JSON.stringify({ walletAddress: reservationWalletAddress, amount, sessionId, providerId }),
        });
        const intent = await readJson<ReservationApprovalIntent>(intentRes);
        assertCurrent();
        authorizationTxHash = await ethereum.request({
          method: 'eth_sendTransaction', params: [intent.transaction],
        }) as string;
        assertCurrent();
        if (!authorizationTxHash) throw new Error('The wallet did not return an approval transaction hash.');
        const browserProvider = new ethers.BrowserProvider(ethereum);
        const approvalReceipt = await browserProvider.waitForTransaction(authorizationTxHash);
        assertCurrent();
        if (!approvalReceipt || approvalReceipt.status !== 1) throw new Error('The wallet authorization transaction failed.');
      }
      assertCurrent();
      spendRequestStarted = true;
      const res = await fetch(apiUrl(normalizedApiBaseUrl, '/spend/me'), {
        method: 'POST',
        headers: contractHeaders(contractId),
        body: JSON.stringify({
          amount,
          sessionId,
          providerId,
          label: 'Charging discount',
          walletAddress: reservationWalletAddress,
          authorizationTxHash,
        }),
      });
      const data = await readJson<SpendResponse>(res);
      if (!isReservationRetentionCurrent(operation)) throw new StaleSpendOperationError();
      setReservation(data.reservation);
      setReservationTracking({
        reservationId: data.reservation.id,
        contractId,
        apiBaseUrl: normalizedApiBaseUrl,
        sessionId,
        providerId,
      });
      setSettlement(null);
      notifiedSettlementId.current = null;
      invokeHostCallback(() => onReservationSuccess?.(data.reservation), (callbackError) => {
        if (isReservationRetentionCurrent(operation)) {
          setError(`Reservation created, but the host callback failed: ${getErrorMessage(callbackError)}`);
        }
      });
      if (!isReservationRetentionCurrent(operation)) return;
      if (hideAfterSpend && shouldDismissAfterReservation(operation)) {
        setDismissed(true);
        invokeHostCallback(() => onDismiss?.('spent'), (callbackError) => {
          if (isReservationRetentionCurrent(operation)) {
            setError(`Reservation created, but the host dismiss callback failed: ${getErrorMessage(callbackError)}`);
          }
        });
      }
    } catch (err) {
      if (err instanceof StaleSpendOperationError && !spendRequestStarted) return;
      if (!isSpendOwnerOperationCurrent(operation)) return;
      if (isSpendRequestCurrent(operation)) setError(getErrorMessage(err));
      invokeHostCallback(() => onSpendError?.(err), (callbackError) => {
        if (isSpendOwnerOperationCurrent(operation)) {
          setError(`Spend failed, but the host error callback failed: ${getErrorMessage(callbackError)}`);
        }
      });
    } finally {
      if (isSpendOwnerOperationCurrent(operation)) setSpending(false);
    }
  }

  function skipSession() {
    if (!visibleSession || !sessionId || !providerId) return;
    onSkipSession?.({ contractId, sessionId, providerId, chargerId, sessionStatus: visibleSession.sessionStatus });
    if (hideAfterSkip) {
      setDismissed(true);
      onDismiss?.('skipped');
    }
  }

  async function loadWalletProfile(
    expectedOwnerGeneration = ownerGenerationRef.current,
    expectedOperationToken = activeWalletOperationTokenRef.current,
  ) {
    const isCurrent = () => isOwnerGenerationCurrent(expectedOwnerGeneration, contractId, normalizedApiBaseUrl)
      && activeWalletOperationTokenRef.current === expectedOperationToken;
    if (!isCurrent()) throw new StaleSpendOperationError();
    const walletRes = await fetch(apiUrl(normalizedApiBaseUrl, '/wallet/me'), {
      method: 'GET',
      headers: contractHeaders(contractId),
    });
    const walletData = await readJson<SparkzWalletResponse>(walletRes);
    if (!isCurrent()) throw new StaleSpendOperationError();
    setWallet(walletData);
    setWalletOwnerContractId(contractId);
    setWalletOwnerApiBaseUrl(normalizedApiBaseUrl);
    setConnectedWallet(walletData.walletMode === 'custodial' ? walletData.walletAddress : '');
    return walletData;
  }

  async function connectAndSignCustodialWallet(
    expectedOwnerGeneration: number,
    expectedOperationToken: number,
  ): Promise<string> {
    const isCurrent = () => isOwnerGenerationCurrent(expectedOwnerGeneration, contractId, normalizedApiBaseUrl)
      && activeWalletOperationTokenRef.current === expectedOperationToken;
    if (!isCurrent()) throw new StaleSpendOperationError();
    const ethereum = (window as Window & { ethereum?: BrowserEthereumProvider }).ethereum;
    if (!ethereum) {
      throw new Error('No wallet app found. Install or open MetaMask, Rabby, or another EVM wallet.');
    }

    const accounts = await ethereum.request({ method: 'eth_requestAccounts' }) as string[];
    if (!isCurrent()) throw new StaleSpendOperationError();
    const rawWalletAddress = accounts?.[0];
    if (!rawWalletAddress) {
      throw new Error('No wallet account was selected.');
    }
    const walletAddress = ethers.getAddress(rawWalletAddress);

    const message = getLinkedWalletSignatureMessage(contractId, walletAddress);
    let signature: unknown;
    try {
      if (!isCurrent()) throw new StaleSpendOperationError();
      signature = await ethereum.request({ method: 'personal_sign', params: [message, walletAddress] });
    } catch {
      if (!isCurrent()) throw new StaleSpendOperationError();
      signature = await ethereum.request({ method: 'personal_sign', params: [walletAddress, message] });
    }

    if (!isCurrent()) throw new StaleSpendOperationError();
    if (typeof signature !== 'string' || !signature) {
      throw new Error('Wallet signature was not returned.');
    }

    const linkRes = await fetch(apiUrl(normalizedApiBaseUrl, `/wallet/${encodeURIComponent(contractId)}/linked-wallets`), {
      method: 'POST',
      headers: contractHeaders(contractId),
      body: JSON.stringify({ walletAddress, signature }),
    });
    await readJson<SparkzWalletResponse>(linkRes);
    if (!isCurrent()) throw new StaleSpendOperationError();
    setConnectedWallet(walletAddress);
    return walletAddress;
  }

  async function switchWalletMode(mode: 'managed' | 'custodial') {
    if (!contractId) return;

    const operationOwnerGeneration = ownerGenerationRef.current;
    const operationToken = activeWalletOperationTokenRef.current + 1;
    activeWalletOperationTokenRef.current = operationToken;
    const isCurrent = () => isOwnerGenerationCurrent(operationOwnerGeneration, contractId, normalizedApiBaseUrl)
      && activeWalletOperationTokenRef.current === operationToken;
    setSwitchingMode(true);
    setWalletError('');
    try {
      if (!isCurrent()) throw new StaleSpendOperationError();
      let walletAddress: string | undefined;
      if (mode === 'custodial') {
        setSigningWallet(true);
        walletAddress = await connectAndSignCustodialWallet(operationOwnerGeneration, operationToken);
        if (!isCurrent()) throw new StaleSpendOperationError();
      }

      const res = await fetch(apiUrl(normalizedApiBaseUrl, `/wallet/${encodeURIComponent(contractId)}/mode`), {
        method: 'POST',
        headers: contractHeaders(contractId),
        body: JSON.stringify({
          mode,
          walletAddress,
          allowSplit: true,
        }),
      });
      await readJson<{ status: 'success' }>(res);
      if (!isCurrent()) throw new StaleSpendOperationError();
      const walletData = await loadWalletProfile(operationOwnerGeneration, operationToken);
      invokeHostCallback(() => onWalletModeChange?.(walletData), (callbackError) => {
        if (isCurrent()) setWalletError(`Wallet mode changed, but the host callback failed: ${getErrorMessage(callbackError)}`);
      });
    } catch (err) {
      if (err instanceof StaleSpendOperationError || !isCurrent()) return;
      setWalletError(getErrorMessage(err));
    } finally {
      if (isCurrent()) {
        setSwitchingMode(false);
        setSigningWallet(false);
      }
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
            <dd>{visibleWallet?.uid || contractId}</dd>
          </div>
          <div>
            <dt>Blockchain address</dt>
            <dd>
              {visibleWallet?.walletAddress ? (
                <a href={`${polygonExplorerBaseUrl.replace(/\/$/, '')}/address/${visibleWallet.walletAddress}`} target="_blank" rel="noopener noreferrer">
                  {shortAddress(visibleWallet.walletAddress)}
                </a>
              ) : 'Loading...'}
            </dd>
          </div>
          <div>
            <dt>Wallet mode</dt>
            <dd>{visibleWallet?.walletMode || 'managed'}</dd>
          </div>
          <div>
            <dt>Managed wallet</dt>
            <dd>{shortAddress(visibleWallet?.managedWalletAddress)}</dd>
          </div>
        </dl>

        {visibleWallet?.contractIds && visibleWallet.contractIds.length > 1 && (
          <div className="sparkz-card__account-list">
            <strong>Linked contract IDs</strong>
            <span>{visibleWallet.contractIds.join(', ')}</span>
          </div>
        )}

        {visibleWallet?.linkedWallets && visibleWallet.linkedWallets.length > 0 && (
          <div className="sparkz-card__account-list">
            <strong>Linked wallets</strong>
            {visibleWallet.linkedWallets.map(item => (
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

        {visibleWallet?.walletMode === 'custodial' && (
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
        {visibleSession && (
          <div className="sparkz-card__headline">
            <h2>{visibleSession.spend.message}</h2>
          </div>
        )}
      </div>

      {loading && <p className="sparkz-card__muted">Loading session rewards...</p>}
      {loadingWallet && !visibleWallet && <p className="sparkz-card__muted">Loading SPARKZ account...</p>}

      {!visibleSession && !loading && (
        <div className="sparkz-card__idle">
          <p>No active charging session.</p>
        </div>
      )}

      <div className={`sparkz-card__stats${visibleSession ? ' sparkz-card__stats--session' : ''}`}>
        <div>
          <span>Available</span>
          <strong>{money(walletBalance)}</strong>
        </div>
        {!visibleSession && (
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

      {visibleSession && (
        <>
          {renderRewardRates(visibleSession.rewardRates)}

          {reservationPending && (
            <p className="sparkz-card__notice" role="status">
              A previous reservation is still settling. Wait for its signed receipt or release before creating another reservation.
            </p>
          )}

          {visibleSession.spend.eligible ? (
            <form className="sparkz-card__form" onSubmit={applyDiscount}>
              <label>
                Use SPARKZ for this charging session?
                <input
                  type="number"
                  min="0.01"
                  max={visibleSession.spend.maxSpendable}
                  step="0.01"
                  value={selectedAmount}
                  onChange={(event) => setSelectedAmount(event.target.value)}
                  disabled={reservationPending}
                />
              </label>
              <button type="submit" disabled={spending || reservationPending}>
                {spending ? 'Applying...' : reservationPending ? 'Waiting for reservation' : 'Apply discount'}
              </button>
              <button className="sparkz-card__secondary-button" type="button" onClick={skipSession} disabled={spending}>
                Do not spend tokens for this session
              </button>
            </form>
          ) : (
            <div className="sparkz-card__notice">
              <p>{visibleSession.spend.message}</p>
              <button className="sparkz-card__secondary-button" type="button" onClick={skipSession}>
                Continue without SPARKZ
              </button>
            </div>
          )}
        </>
      )}

      {!visibleSession && showWalletDetails && (
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

      {visibleReceipt && (
        <div className="sparkz-card__receipt" role="status">
          <strong>Discount applied</strong>
          <span>Receipt {visibleReceipt.payload.receiptId}</span>
        </div>
      )}
      {visibleReservation && (
        <div className="sparkz-card__receipt" role="status">
          <strong>{visibleSettlementIsTerminal && visibleSettlement?.status === 'settled'
            ? `${visibleSettlement.settledSparkz} SPARKZ settled`
            : visibleSettlementIsTerminal && visibleSettlement?.status === 'released'
              ? 'SPARKZ reservation released'
              : visibleSettlement?.requiresReview
                ? 'SPARKZ settlement requires review'
              : visibleSettlement?.status === 'settled'
                ? 'SPARKZ settlement confirmed; receipt pending'
              : `${visibleReservation.amount === '0.00' ? 'Existing' : visibleReservation.amount} SPARKZ reserved`}</strong>
          <span>{visibleSettlementIsTerminal
            ? `${visibleSettlement?.freeKwh || '0.00'} kWh free; ${visibleSettlement?.releasedSparkz || '0.00'} SPARKZ released.`
            : visibleSettlement?.requiresReview
              ? 'The saved settlement needs review before the card can confirm it.'
            : visibleSettlement?.status === 'settled'
              ? 'The token movement is known. The signed receipt is pending.'
            : visibleSettlement?.status === 'released'
              ? 'The release response needs validation before it can be confirmed.'
            : visibleReservation.amount === '0.00'
              ? 'Resumed reservation status is loading.'
              : `Up to ${visibleReservation.kWhEntitlement} kWh will be free. Unused SPARKZ are released after the final CDR.`}</span>
        </div>
      )}

      {error && <p className="sparkz-card__error" role="alert">{error}</p>}
    </section>
  );
}
