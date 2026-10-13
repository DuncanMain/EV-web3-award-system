import { SpendReservations } from './service';
import { getDatabase } from './connection';

jest.mock('./connection', () => ({
  getDatabase: jest.fn(),
}));

const mockedGetDatabase = getDatabase as jest.MockedFunction<typeof getDatabase>;

describe('SpendReservations.persistSettlementContext', () => {
  it('writes the full three-decimal context once and rejects mismatches', async () => {
    const state: Record<string, unknown> = {
      id: 'reservation-1',
      delivered_kwh: null,
      status: 'settling',
    };
    const makeQuery = () => {
      const query: Record<string, (...args: any[]) => unknown> = {};
      query.where = () => query;
      query.forUpdate = () => query;
      query.first = async () => ({ ...state });
      query.update = (values: Record<string, unknown>) => ({
        returning: async () => {
          Object.assign(state, values);
          return [{ ...state }];
        },
      });
      return query;
    };
    let trx: any;
    trx = Object.assign(
      ((table: string) => {
        if (table !== 'spend_reservations') throw new Error(`unexpected table ${table}`);
        return makeQuery();
      }) as unknown as Record<string, unknown>,
      {
        transaction: async (callback: (inner: any) => Promise<unknown>) => callback(trx),
        fn: { now: () => new Date() },
      },
    ) as unknown as ReturnType<typeof getDatabase>;
    mockedGetDatabase.mockReturnValue(trx);

    const first = await SpendReservations.persistSettlementContext('reservation-1', 1.913);
    expect(first.delivered_kwh).toBe('1.913');

    const replay = await SpendReservations.persistSettlementContext('reservation-1', 1.913);
    expect(replay.delivered_kwh).toBe('1.913');

    await expect(SpendReservations.persistSettlementContext('reservation-1', 1.914))
      .rejects.toThrow('RESERVATION_SETTLEMENT_CONTEXT_MISMATCH');
    expect(state.delivered_kwh).toBe('1.913');
  });

  it('truncates storage at three decimals while retaining a boundary CDR value', async () => {
    const state: Record<string, unknown> = { id: 'reservation-2', delivered_kwh: null, settlement_context: null };
    const makeQuery = () => {
      const query: Record<string, (...args: any[]) => unknown> = {};
      query.where = () => query;
      query.forUpdate = () => query;
      query.first = async () => ({ ...state });
      query.update = (values: Record<string, unknown>) => ({
        returning: async () => {
          Object.assign(state, values);
          return [{ ...state }];
        },
      });
      return query;
    };
    let trx: any;
    trx = Object.assign(((table: string) => makeQuery()) as unknown as Record<string, unknown>, {
      transaction: async (callback: (inner: any) => Promise<unknown>) => callback(trx),
      fn: { now: () => new Date() },
    }) as unknown as ReturnType<typeof getDatabase>;
    mockedGetDatabase.mockReturnValue(trx);

    await SpendReservations.persistSettlementContext('reservation-2', 1.9999);
    expect(state.delivered_kwh).toBe('1.999');
    expect(state.settlement_context).toEqual({
      deliveredKwh: '1.9999',
      normalizedThreeDecimal: '1.999',
      sourcePrecision: 4,
    });
    await expect(SpendReservations.persistSettlementContext('reservation-2', 1.9998))
      .rejects.toThrow('RESERVATION_SETTLEMENT_CONTEXT_MISMATCH');
  });
});
