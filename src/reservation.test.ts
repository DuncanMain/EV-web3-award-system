import { calculateReservationSettlement } from './reservation';

describe('reservation settlement', () => {
  it('settles only the energy delivered and releases the remainder', () => {
    expect(calculateReservationSettlement(5, 3)).toEqual({ settledAmount: 3, releasedAmount: 2 });
  });

  it('never settles more than was reserved', () => {
    expect(calculateReservationSettlement(5, 12)).toEqual({ settledAmount: 5, releasedAmount: 0 });
  });

  it('supports fractional final energy at token precision', () => {
    expect(calculateReservationSettlement(5, 3.456)).toEqual({ settledAmount: 3.45, releasedAmount: 1.55 });
  });

  it('does not round a sub-cent entitlement up to a token debit', () => {
    expect(calculateReservationSettlement(1, 0.005)).toEqual({ settledAmount: 0, releasedAmount: 1 });
  });

  it('floors decimal energy without binary floating point under-debit', () => {
    expect(calculateReservationSettlement(2.3, 2.3)).toEqual({ settledAmount: 2.3, releasedAmount: 0 });
    expect(calculateReservationSettlement(19.99, 19.999)).toEqual({ settledAmount: 19.99, releasedAmount: 0 });
  });

  it('rejects a reservation amount that cannot be represented at token precision', () => {
    expect(() => calculateReservationSettlement(0.005, 1)).toThrow('at most 2 decimal places');
  });
});
