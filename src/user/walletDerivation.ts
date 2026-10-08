import { ethers } from 'ethers';

export const DEFAULT_USER_ADDRESS_DERIVATION_SALT = 'nvf-award-core-v1';

/**
 * Derive the managed wallet using the historical NEVERFLAT algorithm.
 * Keeping this helper independent from userService lets database cleanup
 * guarantee the same managed fallback without creating an import cycle.
 */
export function generateDeterministicWallet(uid: string, derivationSalt: string): ethers.HDNodeWallet {
  const seed = ethers.solidityPacked(['string', 'string'], [uid, derivationSalt]);
  const hdNode = ethers.HDNodeWallet.fromSeed(seed);
  return hdNode.derivePath("m/44'/60'/0'/0/0");
}

export function deriveManagedWalletAddress(
  uid: string,
  derivationSalt = DEFAULT_USER_ADDRESS_DERIVATION_SALT,
): string {
  return generateDeterministicWallet(uid, derivationSalt).address;
}
