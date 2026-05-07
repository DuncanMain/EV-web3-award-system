import { ethers } from 'ethers';
import { getContract } from '../contract';
import { Users, Awards, Balances } from './service';

/**
 * Listens to contract events and syncs them to the database
 * Keeps the database mirror in sync with blockchain state
 */

/**
 * Start listening to contract events
 * Should be called when the application starts
 * 
 * @param provider - ethers Provider for listening to events
 */
export async function startEventListener(provider: ethers.Provider) {
  const contract = getContract(provider);

  // Listen to Award events
  contract.on('Award', async (to: string, amount: string, event: ethers.EventLog) => {
    try {
      console.log(`[Award Event] ${event.transactionHash}: ${to} awarded ${amount}`);
      await syncAwardEvent(to, amount, event.transactionHash);
    } catch (err) {
      console.error('[Award Event Error]', err);
    }
  });

  // Listen to Spend events
  contract.on('Spend', async (from: string, amount: string, event: ethers.EventLog) => {
    try {
      console.log(`[Spend Event] ${event.transactionHash}: ${from} spent ${amount}`);
      await syncSpendEvent(from, amount, event.transactionHash);
    } catch (err) {
      console.error('[Spend Event Error]', err);
    }
  });

  console.log('[Event Listener] Started listening to contract events');
}

/**
 * Stop listening to contract events
 */
export async function stopEventListener(provider: ethers.Provider) {
  const contract = getContract(provider);
  contract.removeAllListeners();
  console.log('[Event Listener] Stopped listening to contract events');
}

/**
 * Sync Award event to database
 * Called when tokens are transferred to a user (treasury → user)
 */
async function syncAwardEvent(userWallet: string, amountWei: string, txHash: string) {
  // Find or create user by wallet
  let user = await Users.findByWallet(userWallet);
  if (!user) {
    // Create placeholder user record if not found
    // In production, this would be linked to the UID later
    user = await Users.create(`wallet-${userWallet}`, userWallet);
  }

  // Update balance
  const amountTokens = ethers.formatEther(amountWei);
  const balance = await Balances.findByUser(user.id);

  if (balance) {
    const newAwarded = (BigInt(balance.total_awarded) + BigInt(amountWei)).toString();
    const newBalance = (BigInt(balance.balance) + BigInt(amountWei)).toString();

    await Balances.upsert({
      userId: user.id,
      walletAddress: userWallet,
      balance: ethers.formatEther(newBalance),
      totalAwarded: ethers.formatEther(newAwarded),
      totalSpent: balance.total_spent,
    });
  } else {
    await Balances.upsert({
      userId: user.id,
      walletAddress: userWallet,
      balance: amountTokens,
      totalAwarded: amountTokens,
      totalSpent: '0',
    });
  }
}

/**
 * Sync Spend event to database
 * Called when tokens are transferred from a user (user → treasury)
 */
async function syncSpendEvent(userWallet: string, amountWei: string, txHash: string) {
  // Find user by wallet
  const user = await Users.findByWallet(userWallet);
  if (!user) {
    console.warn(`[Spend Event] User not found for wallet: ${userWallet}`);
    return;
  }

  // Update balance
  const amountTokens = ethers.formatEther(amountWei);
  const balance = await Balances.findByUser(user.id);

  if (balance) {
    const newSpent = (BigInt(balance.total_spent) + BigInt(amountWei)).toString();
    const newBalance = (BigInt(balance.balance) - BigInt(amountWei)).toString();

    await Balances.upsert({
      userId: user.id,
      walletAddress: userWallet,
      balance: ethers.formatEther(newBalance),
      totalAwarded: balance.total_awarded,
      totalSpent: ethers.formatEther(newSpent),
    });
  }
}
