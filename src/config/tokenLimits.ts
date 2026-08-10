export const MAX_TOKENS_PER_OPERATION = 200;

export function exceedsTokenOperationCap(amount: number): boolean {
  return Number.isFinite(amount) && amount > MAX_TOKENS_PER_OPERATION;
}
