/**
 * User registry for managing UID → Polygon address mappings.
 * This is an in-memory store; in production, should be replaced with database persistence.
 */

interface UserRecord {
  uid: string;
  walletAddress: string;
  createdAt: Date;
}

class UserRegistry {
  private registry: Map<string, UserRecord> = new Map();

  /**
   * Register a new user with a wallet address.
   * @param uid - Unique user identifier
   * @param walletAddress - Polygon wallet address
   * @returns The user record
   */
  register(uid: string, walletAddress: string): UserRecord {
    const existing = this.registry.get(uid);
    if (existing) {
      return existing;
    }

    const record: UserRecord = {
      uid,
      walletAddress,
      createdAt: new Date(),
    };

    this.registry.set(uid, record);
    return record;
  }

  setAddress(uid: string, walletAddress: string): UserRecord {
    const record: UserRecord = {
      uid,
      walletAddress,
      createdAt: this.registry.get(uid)?.createdAt || new Date(),
    };

    this.registry.set(uid, record);
    return record;
  }

  /**
   * Get a user's wallet address.
   * @param uid - Unique user identifier
   * @returns The wallet address or undefined if not registered
   */
  getAddress(uid: string): string | undefined {
    return this.registry.get(uid)?.walletAddress;
  }

  /**
   * Get all registered user records.
   * @returns Array of user records
   */
  getAllUsers(): UserRecord[] {
    return Array.from(this.registry.values());
  }

  /**
   * Check if a user is registered.
   * @param uid - Unique user identifier
   * @returns True if registered
   */
  isRegistered(uid: string): boolean {
    return this.registry.has(uid);
  }

  /**
   * Clear all users (for testing).
   */
  clear(): void {
    this.registry.clear();
  }
}

// Singleton instance
export const userRegistry = new UserRegistry();
export type { UserRecord };
