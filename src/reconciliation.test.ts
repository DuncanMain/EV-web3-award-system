import { reconcileBalance, summarizeReconciliation } from './reconciliation';

describe('reconciliation', () => {
  it('marks matching balances as matched', () => {
    const item = reconcileBalance({
      uid: 'contract-1',
      walletAddress: '0x1111111111111111111111111111111111111111',
      dbBalance: '10.00',
      chainBalance: '10.000000',
    });

    expect(item.status).toBe('matched');
    expect(item.difference).toBe('0.000000');
  });

  it('marks mismatched balances', () => {
    const item = reconcileBalance({
      uid: 'contract-1',
      walletAddress: '0x1111111111111111111111111111111111111111',
      dbBalance: '10.00',
      chainBalance: '7.50',
    });

    expect(item.status).toBe('amount_mismatch');
    expect(item.difference).toBe('-2.500000');
  });

  it('marks failed chain reads', () => {
    const item = reconcileBalance({
      uid: 'contract-1',
      walletAddress: '0x1111111111111111111111111111111111111111',
      dbBalance: '10.00',
      chainError: 'RPC unavailable',
    });

    expect(item.status).toBe('chain_read_failed');
    expect(item.error).toBe('RPC unavailable');
  });

  it('summarizes report status', () => {
    const items = [
      reconcileBalance({
        uid: 'contract-1',
        walletAddress: '0x1111111111111111111111111111111111111111',
        dbBalance: '10',
        chainBalance: '10',
      }),
      reconcileBalance({
        uid: 'contract-2',
        walletAddress: '0x2222222222222222222222222222222222222222',
        dbBalance: '3',
        chainBalance: '2',
      }),
    ];

    expect(summarizeReconciliation(items)).toEqual({
      checkedCount: 2,
      matchedCount: 1,
      mismatchCount: 1,
      status: 'mismatch',
    });
  });
});
