export type SparkzActiveSessionStatus = 'CHARGER_OPENED' | 'PLUGGED_IN' | 'SESSION_STARTED';
export type SparkzSessionStatus = SparkzActiveSessionStatus | 'UNPLUGGED' | 'CDR_RECEIVED';

export type SparkzActivityItem = {
  type: 'award' | 'spend';
  uid?: string | null;
  amount: string;
  timestamp?: string;
  txHash?: string;
  walletAddress?: string | null;
  walletName?: string | null;
  awardType?: string;
  label?: string;
  status?: string;
};

export type SparkzWalletMode = 'managed' | 'custodial' | 'unknown';

export type SparkzRewardRate = {
  key: 'offPeakCharging' | 'v2gDischarge' | string;
  label: string;
  enabled: boolean;
  tokensPerKWh: number;
  kWhPerSparkz: number | null;
  description: string;
};

export type SparkzWalletResponse = {
  status: 'success';
  uid: string;
  contractIds?: string[];
  linkedWalletAddresses?: string[];
  linkedWallets?: Array<{
    walletAddress: string;
    walletName?: string | null;
  }>;
  walletName?: string | null;
  walletAddress: string;
  managedWalletAddress: string;
  walletMode: SparkzWalletMode;
  isRegistered: boolean;
  balance: string;
  totalAwarded: string;
  totalSpent: string;
  treasuryAddress?: string | null;
  tokenContractAddress?: string;
  history: SparkzActivityItem[];
};

export type SparkzSpendReceipt = {
  payload: {
    receiptId: string;
    status: string;
    contractId: string;
    walletAddress: string;
    amount: string;
    sessionId?: string | null;
    providerId?: string | null;
    tokenTxHash: string;
    tokenContractAddress: string;
    chainId: number;
    issuedAt: string;
  };
  signature: string;
  signerAddress: string;
  canonicalPayload: string;
  dbStored?: boolean;
};

export type SparkzReservation = {
  id: string;
  status: 'reserved';
  amount: string;
  kWhEntitlement: string;
  availableBalance: number;
};

export type SparkzSessionResponse = {
  status: 'success';
  contractId: string;
  sessionId: string;
  providerId: string;
  chargerId: string;
  sessionStatus: SparkzActiveSessionStatus;
  countryCode?: string | null;
  estimatedKwh?: number;
  estimatedCost?: number;
  wallet: {
    availableBalance: number;
    reservedBalance?: number;
    totalEarned: number;
    totalSpent: number;
    mode: SparkzWalletMode;
  };
  spend: {
    eligible: boolean;
    maxSpendable: number;
    suggestedAmount: number;
    label: string;
    message: string;
  };
  recentActivity: SparkzActivityItem[];
  rewardRates?: SparkzRewardRate[];
};

export type SparkzChargingCardProps = {
  apiBaseUrl?: string;
  contractId: string;
  sessionId?: string;
  providerId?: string;
  chargerId?: string;
  sessionStatus?: SparkzSessionStatus;
  countryCode?: string;
  estimatedKwh?: number;
  estimatedCost?: number;
  logoSrc?: string;
  showWalletDetails?: boolean;
  hideAfterSpend?: boolean;
  hideAfterSkip?: boolean;
  polygonExplorerBaseUrl?: string;
  onSpendSuccess?: (receipt: SparkzSpendReceipt) => void;
  onReservationSuccess?: (reservation: SparkzReservation) => void;
  onSpendError?: (error: unknown) => void;
  onWalletLoaded?: (wallet: SparkzWalletResponse) => void;
  onWalletModeChange?: (wallet: SparkzWalletResponse) => void;
  onSkipSession?: (context: {
    contractId: string;
    sessionId: string;
    providerId: string;
    chargerId?: string;
    sessionStatus: SparkzActiveSessionStatus;
  }) => void;
  onDismiss?: (reason: 'spent' | 'skipped') => void;
};
