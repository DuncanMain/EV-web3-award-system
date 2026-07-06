export type ReconciliationStatus = 'matched' | 'amount_mismatch' | 'missing_db_balance' | 'chain_read_failed';

export interface ReconciliationInput {
  uid: string;
  walletAddress: string;
  dbBalance?: string | null;
  chainBalance?: string | null;
  chainError?: string | null;
}

export interface ReconciliationItem {
  uid: string;
  walletAddress: string;
  dbBalance: string | null;
  chainBalance: string | null;
  difference: string | null;
  status: ReconciliationStatus;
  error?: string | null;
}

function toNumber(value?: string | null): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function reconcileBalance(input: ReconciliationInput, tolerance = 0.000001): ReconciliationItem {
  if (input.chainError) {
    return {
      uid: input.uid,
      walletAddress: input.walletAddress,
      dbBalance: input.dbBalance ?? null,
      chainBalance: input.chainBalance ?? null,
      difference: null,
      status: 'chain_read_failed',
      error: input.chainError,
    };
  }

  const dbBalance = toNumber(input.dbBalance);
  const chainBalance = toNumber(input.chainBalance);

  if (dbBalance === null) {
    return {
      uid: input.uid,
      walletAddress: input.walletAddress,
      dbBalance: input.dbBalance ?? null,
      chainBalance: input.chainBalance ?? null,
      difference: null,
      status: 'missing_db_balance',
    };
  }

  const difference = chainBalance === null ? null : chainBalance - dbBalance;
  const status = difference !== null && Math.abs(difference) <= tolerance ? 'matched' : 'amount_mismatch';

  return {
    uid: input.uid,
    walletAddress: input.walletAddress,
    dbBalance: input.dbBalance ?? null,
    chainBalance: input.chainBalance ?? null,
    difference: difference === null ? null : difference.toFixed(6),
    status,
  };
}

export function summarizeReconciliation(items: ReconciliationItem[]) {
  const mismatchStatuses: ReconciliationStatus[] = ['amount_mismatch', 'missing_db_balance', 'chain_read_failed'];
  const mismatchCount = items.filter(item => mismatchStatuses.includes(item.status)).length;

  return {
    checkedCount: items.length,
    matchedCount: items.filter(item => item.status === 'matched').length,
    mismatchCount,
    status: mismatchCount === 0 ? 'matched' : 'mismatch',
  };
}
