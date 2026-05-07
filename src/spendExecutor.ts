import { ethers } from 'ethers';
import { SpendRequest, SpendResult, SpendExecutionResult } from './types';
import { getContract } from './contract';
import { getTreasuryAddress } from './treasury/treasuryConfig';
import { recordSpend } from './database/integration';

/**
 * Note: For spend execution to work, users must have approved the treasury contract
 * to spend tokens on their behalf via ERC20 approve() function.
 * This is typically done once during user onboarding.
 */

/**
 * Validates requested spend and prepares spend execution.
 * Returns details for user → treasury transfer if valid.
 */
export function prepareSpend(request: SpendRequest): SpendResult {
  const valid = !!(request.amount > 0 && request.userAddress);

  // Additional validations can be added here (e.g., balance checks)

  return {
    valid,
  };
}

/**
 * Executes the spend by transferring tokens from user back to treasury.
 * Uses treasury signer to pay for gas and execute transferFrom.
 * @param treasurySigner - Treasury signer (pays for gas)
 * @param userAddress - User wallet address to transfer tokens from
 * @param treasuryAddress - Treasury wallet address to receive tokens
 * @param amount - Number of SPARKZ tokens to spend
 */
export async function executeSpend(
  treasurySigner: ethers.Signer,
  userAddress: string,
  treasuryAddress: string,
  amount: number
): Promise<string> {
  const contract = getContract(treasurySigner);
  // Use standard ERC20 transferFrom: treasury pays gas to transfer from user to treasury
  const tx = await contract.transferFrom(
    userAddress,
    treasuryAddress,
    ethers.parseEther(amount.toString())
  );
  await tx.wait();
  return tx.hash;
}



/**
 * Process a spend request and record the transaction in the database.
 * @param request - Spend request details including userAddress
 * @param treasurySigner - Treasury signer (pays for gas to execute transferFrom)
 */
export async function processSpend(
  request: SpendRequest,
  treasurySigner: ethers.Signer
): Promise<SpendExecutionResult> {
  const validation = prepareSpend(request);
  if (!validation.valid) {
    return {
      success: false,
      amount: request.amount,
      userAddress: request.userAddress,
      error: 'Invalid spend request',
    };
  }

  try {
    // Get treasury address for spend transfer
    const treasuryAddress = getTreasuryAddress();
    
    const txHash = await executeSpend(treasurySigner, request.userAddress, treasuryAddress, request.amount);
    let dbStored = false;
    let dbError: string | undefined;

    try {
      await recordSpend(request.userAddress, request.amount, txHash, request.sessionId);
      dbStored = true;
    } catch (err) {
      dbError = err instanceof Error ? err.message : String(err);
    }

    return {
      success: true,
      amount: request.amount,
      userAddress: request.userAddress,
      txHash,
      dbStored,
      dbError,
    };
  } catch (err) {
    return {
      success: false,
      amount: request.amount,
      userAddress: request.userAddress,
      error: `On-chain spend failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}
