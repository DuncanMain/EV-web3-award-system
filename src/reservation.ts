import { canonicalTokenAmount, truncateTokenAmount } from './database/tokenOperation';

/** 1 SPARKZ redeems one kWh. Values are limited to token precision. */
export function calculateReservationSettlement(reservedSparkz: number, deliveredKwh: number): {
  settledAmount: number;
  releasedAmount: number;
} {
  const reserved = canonicalTokenAmount(reservedSparkz);
  const delivered = truncateTokenAmount(deliveredKwh);
  if (!reserved || reserved.units < 0n) throw new Error('reservedSparkz must be non-negative and use at most 2 decimal places');
  if (!delivered || delivered.units < 0n) throw new Error('deliveredKwh must be non-negative');
  const settledUnits = reserved.units < delivered.units ? reserved.units : delivered.units;
  const releasedUnits = reserved.units - settledUnits;
  return {
    settledAmount: Number(settledUnits) / 100,
    releasedAmount: Number(releasedUnits) / 100,
  };
}
