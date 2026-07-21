/** 1 SPARKZ redeems one kWh. Values are limited to token precision. */
export function calculateReservationSettlement(reservedSparkz: number, deliveredKwh: number): {
  settledAmount: number;
  releasedAmount: number;
} {
  if (!Number.isFinite(reservedSparkz) || reservedSparkz < 0) throw new Error('reservedSparkz must be non-negative');
  if (!Number.isFinite(deliveredKwh) || deliveredKwh < 0) throw new Error('deliveredKwh must be non-negative');
  const settledAmount = Number(Math.min(reservedSparkz, deliveredKwh).toFixed(2));
  return { settledAmount, releasedAmount: Number((reservedSparkz - settledAmount).toFixed(2)) };
}
