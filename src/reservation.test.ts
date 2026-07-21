import { calculateReservationSettlement } from './reservation';

describe('reservation settlement', () => {
  it('settles only the energy delivered and releases the remainder', () => {
    expect(calculateReservationSettlement(5, 3)).toEqual({ settledAmount: 3, releasedAmount: 2 });
  });

  it('never settles more than was reserved', () => {
    expect(calculateReservationSettlement(5, 12)).toEqual({ settledAmount: 5, releasedAmount: 0 });
  });

  it('supports fractional final energy at token precision', () => {
    expect(calculateReservationSettlement(5, 3.456)).toEqual({ settledAmount: 3.46, releasedAmount: 1.54 });
  });
});
