/**
 * Treasury configuration.
 * Manages the treasury wallet address which holds and distributes SPARKZ tokens.
 */

/**
 * Get the treasury wallet address from environment.
 * This is the wallet that holds the token pool and signs award transactions.
 * 
 * @throws Error if TREASURY_ADDRESS is not configured
 * @returns The treasury wallet address (0x...)
 */
export function getTreasuryAddress(): string {
  const address = process.env.TREASURY_ADDRESS;
  if (!address) {
    throw new Error(
      'TREASURY_ADDRESS environment variable not configured. ' +
      'Set this to the Polygon address of the treasury wallet that holds SPARKZ tokens.'
    );
  }
  return address;
}

/**
 * Get the treasury signer.
 * This should be injected at runtime from a secure key management system.
 * The signer must have permission to call the contract's award() function.
 * 
 * @returns Treasury signer configuration status
 */
export function validateTreasuryConfiguration(): {
  address: string;
  signer: 'not-configured' | 'configured';
} {
  try {
    const address = getTreasuryAddress();
    // In production, the signer would be loaded from a key management system
    // For now, we just verify the address is configured
    return {
      address,
      signer: process.env.TREASURY_SIGNER_KEY ? 'configured' : 'not-configured',
    };
  } catch (err) {
    throw new Error(`Treasury configuration invalid: ${err instanceof Error ? err.message : String(err)}`);
  }
}
