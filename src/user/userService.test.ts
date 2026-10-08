jest.mock('../database/service', () => ({
  Users: { findByUid: jest.fn() },
}));

import {
  clearUserRegistry,
  getManagedWalletAddress,
  getUserAddress,
  isUserRegistered,
  resolveActiveUidAddress,
  resolveUidToAddress,
} from './userService';
import { userRegistry } from './userRegistry';

describe('User Service', () => {
  beforeEach(() => {
    clearUserRegistry();
  });

  describe('resolveUidToAddress', () => {
    it('should generate a deterministic address for a UID', () => {
      const uid = 'test-user-123';
      const address1 = resolveUidToAddress(uid);

      expect(address1).toMatch(/^0x[a-fA-F0-9]{40}$/); // Valid Ethereum address
    });

    it('should return the same address for the same UID', () => {
      const uid = 'test-user-456';
      const address1 = resolveUidToAddress(uid);
      const address2 = resolveUidToAddress(uid);

      expect(address1).toBe(address2);
    });

    it('should generate different addresses for different UIDs', () => {
      const uid1 = 'user-alpha';
      const uid2 = 'user-beta';

      const address1 = resolveUidToAddress(uid1);
      const address2 = resolveUidToAddress(uid2);

      expect(address1).not.toBe(address2);
    });

    it('should auto-register user on first resolution', () => {
      const uid = 'new-user-789';

      expect(isUserRegistered(uid)).toBe(false);

      const address = resolveUidToAddress(uid);

      expect(isUserRegistered(uid)).toBe(true);
      expect(getUserAddress(uid)).toBe(address);
    });
  });

  describe('isUserRegistered', () => {
    it('should return false for unregistered users', () => {
      expect(isUserRegistered('unknown-user')).toBe(false);
    });

    it('should return true for registered users', () => {
      const uid = 'registered-user';
      resolveUidToAddress(uid);

      expect(isUserRegistered(uid)).toBe(true);
    });
  });

  describe('getUserAddress', () => {
    it('should return undefined for unregistered users', () => {
      expect(getUserAddress('unknown-user')).toBeUndefined();
    });

    it('should return address for registered users', () => {
      const uid = 'registered-user';
      const registered = resolveUidToAddress(uid);

      expect(getUserAddress(uid)).toBe(registered);
    });
  });

  describe('clearUserRegistry', () => {
    it('should clear all registered users', () => {
      const uid1 = 'user-1';
      const uid2 = 'user-2';

      resolveUidToAddress(uid1);
      resolveUidToAddress(uid2);

      expect(isUserRegistered(uid1)).toBe(true);
      expect(isUserRegistered(uid2)).toBe(true);

      clearUserRegistry();

      expect(isUserRegistered(uid1)).toBe(false);
      expect(isUserRegistered(uid2)).toBe(false);
    });
  });

  it('replaces a stale cached external wallet with managed when no active DB row exists', async () => {
    const uid = 'stale-external-cache';
    const staleExternalWallet = '0x1111111111111111111111111111111111111111';
    const managedWallet = getManagedWalletAddress(uid);
    userRegistry.setAddress(uid, staleExternalWallet);

    const mockedUsers = (jest.requireMock('../database/service') as { Users: { findByUid: jest.Mock } }).Users;
    mockedUsers.findByUid.mockResolvedValueOnce(undefined);

    await expect(resolveActiveUidAddress(uid)).resolves.toBe(managedWallet);
    expect(getUserAddress(uid)).toBe(managedWallet);
    expect(getUserAddress(uid)).not.toBe(staleExternalWallet);
  });
});
