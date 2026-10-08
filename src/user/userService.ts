import { ethers } from 'ethers';
import { createRpcProvider } from '../rpcProvider';
import { userRegistry } from './userRegistry';
import { Users } from '../database/service';
import {
  DEFAULT_USER_ADDRESS_DERIVATION_SALT,
  deriveManagedWalletAddress,
  generateDeterministicWallet,
} from './walletDerivation';

export type WalletMode = 'managed' | 'custodial';

/**
 * User service for managing UID → Polygon address mappings.
 * 
 * Generates deterministic Polygon addresses from UIDs using a derivation salt.
 * First time a UID is seen, an address is created, registered, and approved for treasury spending.
 */

/**
 * Generate a deterministic Polygon wallet from a UID.
 * Uses ethers Wallet.fromSeed to derive a consistent wallet.
 * 
 * @param uid - Unique user identifier
 * @param derivationSalt - Salt for deterministic generation (environment-based)
 * @returns A deterministic Polygon wallet (with private key)
 */
/** Preserve the existing export used by database integration and tests. */
export { generateDeterministicWallet };

/**
 * Generate a deterministic Polygon address from a UID.
 * Uses ethers Wallet.fromMnemonic to derive a consistent address.
 * 
 * @param uid - Unique user identifier
 * @param derivationSalt - Salt for deterministic generation (environment-based)
 * @returns A deterministic Polygon wallet address (0x...)
 */
function generateDeterministicAddress(uid: string, derivationSalt: string): string {
  return deriveManagedWalletAddress(uid, derivationSalt);
}

export function getManagedWalletAddress(uid: string): string {
  const derivationSalt = process.env.USER_ADDRESS_DERIVATION_SALT || DEFAULT_USER_ADDRESS_DERIVATION_SALT;
  return generateDeterministicAddress(uid, derivationSalt);
}

/**
 * Resolve a UID to a Polygon address.
 * If the UID hasn't been registered yet, automatically create and register an address.
 * 
 * @param uid - Unique user identifier
 * @returns The user's Polygon wallet address
 */
export function resolveUidToAddress(uid: string): string {
  // Check if already registered
  const existing = userRegistry.getAddress(uid);
  if (existing) {
    return existing;
  }

  // Generate new deterministic address
  const walletAddress = getManagedWalletAddress(uid);

  // Register the user
  userRegistry.register(uid, walletAddress);

  return walletAddress;
}

/**
 * Get a user's registered address without auto-creating.
 * @param uid - Unique user identifier
 * @returns The user's address or undefined if not registered
 */
export function getUserAddress(uid: string): string | undefined {
  return userRegistry.getAddress(uid);
}

export async function resolveActiveUidAddress(uid: string): Promise<string> {
  const existingUser = await Users.findByUid(uid);
  if (existingUser) {
    userRegistry.setAddress(uid, existingUser.wallet_address);
    return existingUser.wallet_address;
  }

  // A stale in-memory address must never revive a wallet removed from the
  // database. When no active row exists, the only safe fallback is managed.
  const managedWalletAddress = getManagedWalletAddress(uid);
  userRegistry.setAddress(uid, managedWalletAddress);
  return managedWalletAddress;
}

export async function getUserWalletConfig(uid: string): Promise<{
  walletAddress: string;
  managedWalletAddress: string;
  walletMode: WalletMode;
  isRegistered: boolean;
}> {
  const managedWalletAddress = getManagedWalletAddress(uid);
  const existingUser = await Users.findByUid(uid);

  if (!existingUser) {
    userRegistry.setAddress(uid, managedWalletAddress);
    return {
      walletAddress: managedWalletAddress,
      managedWalletAddress,
      walletMode: 'managed',
      isRegistered: false,
    };
  }

  userRegistry.setAddress(uid, existingUser.wallet_address);
  return {
    walletAddress: existingUser.wallet_address,
    managedWalletAddress,
    walletMode: existingUser.wallet_address.toLowerCase() === managedWalletAddress.toLowerCase() ? 'managed' : 'custodial',
    isRegistered: true,
  };
}

export async function setUserWalletMode(uid: string, mode: WalletMode, walletAddress?: string): Promise<{
  uid: string;
  walletAddress: string;
  managedWalletAddress: string;
  walletMode: WalletMode;
}> {
  const managedWalletAddress = getManagedWalletAddress(uid);
  const nextWalletAddress = mode === 'managed' ? managedWalletAddress : walletAddress;

  if (!nextWalletAddress) {
    throw new Error('walletAddress is required for custodial mode');
  }

  if (!ethers.isAddress(nextWalletAddress)) {
    throw new Error('Invalid wallet address');
  }

  const checksumWalletAddress = ethers.getAddress(nextWalletAddress);
  const activeUser = await Users.activateWallet(uid, checksumWalletAddress);

  userRegistry.setAddress(uid, checksumWalletAddress);

  return {
    uid,
    walletAddress: activeUser.wallet_address,
    managedWalletAddress,
    walletMode: mode,
  };
}

/**
 * Check if a user is registered.
 * @param uid - Unique user identifier
 * @returns True if the user has been registered
 */
export function isUserRegistered(uid: string): boolean {
  return userRegistry.isRegistered(uid);
}

/**
 * Get all registered users (for admin/debugging).
 */
export function getAllRegisteredUsers() {
  return userRegistry.getAllUsers();
}

/**
 * Clear all users from registry (for testing only).
 */
export function clearUserRegistry(): void {
  userRegistry.clear();
}

/**
 * Approve the treasury contract to spend tokens on behalf of a user.
 * This must be called once per user before they can spend tokens.
 * Uses the user's deterministic wallet to sign the approval transaction.
 * 
 * @param uid - Unique user identifier
 * @param treasuryAddress - Treasury wallet address that will be approved to spend
 * @param provider - Ethereum provider for contract interaction
 * @returns Transaction hash of the approval
 */
export async function approveUserForSpending(
  uid: string,
  treasuryAddress: string,
  provider: ethers.Provider = createRpcProvider()
): Promise<string> {
  const derivationSalt = process.env.USER_ADDRESS_DERIVATION_SALT || 'nvf-award-core-v1';
  const userWallet = generateDeterministicWallet(uid, derivationSalt);
  const userSigner = userWallet.connect(provider);

  const contractAddress = process.env.TOKEN_CONTRACT_ADDRESS || '0x605871D30DC278a036F09e2ace771df8a224624B'; // Token contract address

  // Create contract interface for approval
  const tokenInterface = new ethers.Interface([
    'function approve(address spender, uint256 amount) public returns (bool)',
  ]);

  // Approve with unlimited amount (max uint256)
  const maxApproval = ethers.MaxUint256;
  const tx = await userSigner.sendTransaction({
    to: contractAddress,
    data: tokenInterface.encodeFunctionData('approve', [treasuryAddress, maxApproval]),
  });

  const receipt = await tx.wait();
  if (!receipt) {
    throw new Error('Approval transaction failed');
  }

  return tx.hash;
}
