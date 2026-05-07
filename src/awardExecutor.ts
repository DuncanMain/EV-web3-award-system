import { ethers } from 'ethers';
import { NormalisedSession, AwardResult, RawSession, OCPICDRFormat } from './types';
import { calculateAwardTokens, getDeduplicationKey, isOffPeakForCountry, formatLocalTime, getAwardType } from './config/awardRules';
import { normaliseSession, getCountryFromEVSEID } from './normaliser';
import { getContract } from './contract';
import { getUserWalletConfig } from './user/userService';
import { recordAward, approveUserForSpendingViaFunding } from './database/integration';
import { getTreasuryAddress } from './treasury/treasuryConfig';

/**
 * Result of executing an award (from raw CDR through to on-chain execution)
 */
export interface ExecutionResult {
  success: boolean;
  dedupKey: string;
  eligible: boolean;
  amount: number;
  uid: string;
  txHash?: string;
  dbStored?: boolean;
  dbError?: string;
  error?: string;
  stage: 'normalisation' | 'calculation' | 'validation' | 'execution' | 'complete';
}

/**
 * Evaluates reward eligibility and prepares award execution based on rules configuration.
 * Returns details for treasury → user transfer if eligible.
 * Note: uid will need to be resolved to a wallet address at the API layer.
 */
export function prepareAward(session: NormalisedSession): AwardResult {
  const amount = calculateAwardTokens(session);
  const eligible = amount > 0;
  const dedupKey = getDeduplicationKey(session);

  // Calculate peak/off-peak metadata
  const countryCode = getCountryFromEVSEID(session.evseId);
  const isOffPeak = isOffPeakForCountry(countryCode, session.startTime);
  const localTime = formatLocalTime(session.startTime);
  const awardType = getAwardType(session);

  return {
    eligible,
    amount,
    uid: session.uid,
    dedupKey,
    metadata: {
      isOffPeak,
      countryCode,
      localTime,
      energyDirection: session.energyDirection,
      awardType: awardType || 'OFF_PEAK_CHARGING', // Default if no type determined
    },
  };
}

/**
 * Executes the award by transferring tokens from treasury to user.
 * Uses standard ERC20 transfer function.
 * @param signer - Treasury signer with token transfer permission
 * @param to - Recipient wallet address (resolved from uid)
 * @param amount - Number of SPARKZ tokens to award
 */
export async function executeAward(signer: ethers.Signer, to: string, amount: number): Promise<string> {
  const contract = getContract(signer);
  // Use standard ERC20 transfer function: transfer(to, amount)
  const tx = await contract.transfer(to, ethers.parseEther(amount.toString()));
  await tx.wait();
  return tx.hash;
}

/**
 * Complete reward execution pipeline orchestrator.
 * 
 * Orchestrates the full flow from raw CDR to on-chain execution:
 * 1. Normalise raw CDR data
 * 2. Calculate tokens based on rules
 * 3. Validate against business rules
 * 4. Resolve user UID to Polygon address (auto-creates if first time)
 * 5. Execute on-chain transfer (required)
 * 
 * @param rawCDR - Raw CDR data (OCPI format or custom)
 * @param treasurySigner - ethers.Signer for treasury (required for on-chain execution)
 * @param deduplicationCheck - Optional function to check if (dedupKey) has been processed
 * @returns ExecutionResult with status, amounts, and transaction hash
 */
export async function processAwardFromCDR(
  rawCDR: RawSession | OCPICDRFormat,
  treasurySigner: ethers.Signer,
  deduplicationCheck?: (dedupKey: string) => Promise<boolean>
): Promise<ExecutionResult> {
  try {
    // Stage 1: Normalise
    let normalised: NormalisedSession;
    try {
      normalised = normaliseSession(rawCDR);
    } catch (err) {
      return {
        success: false,
        dedupKey: '',
        eligible: false,
        amount: 0,
        uid: '',
        error: `Normalisation failed: ${err instanceof Error ? err.message : String(err)}`,
        stage: 'normalisation',
      };
    }

    // Stage 2: Calculate and prepare
    let awardResult: AwardResult;
    try {
      awardResult = prepareAward(normalised);
    } catch (err) {
      return {
        success: false,
        dedupKey: normalised.uid ? `${normalised.sessionId}-${normalised.providerId}` : '',
        eligible: false,
        amount: 0,
        uid: normalised.uid,
        error: `Calculation failed: ${err instanceof Error ? err.message : String(err)}`,
        stage: 'calculation',
      };
    }

    // Stage 3: Validate (check idempotency if checker provided)
    if (deduplicationCheck) {
      try {
        const alreadyProcessed = await deduplicationCheck(awardResult.dedupKey);
        if (alreadyProcessed) {
          return {
            success: false,
            dedupKey: awardResult.dedupKey,
            eligible: awardResult.eligible,
            amount: awardResult.amount,
            uid: awardResult.uid,
            error: 'Session already processed (deduplication)',
            stage: 'validation',
          };
        }
      } catch (err) {
        return {
          success: false,
          dedupKey: awardResult.dedupKey,
          eligible: awardResult.eligible,
          amount: awardResult.amount,
          uid: awardResult.uid,
          error: `Deduplication check failed: ${err instanceof Error ? err.message : String(err)}`,
          stage: 'validation',
        };
      }
    }

    // If not eligible, return early without execution
    if (!awardResult.eligible) {
      return {
        success: true,
        dedupKey: awardResult.dedupKey,
        eligible: false,
        amount: 0,
        uid: awardResult.uid,
        stage: 'complete',
      };
    }

    // Stage 4: Resolve user UID to Polygon address (auto-creates if first time)
    let userWalletAddress: string;
    let walletMode: 'managed' | 'custodial';
    try {
      const walletConfig = await getUserWalletConfig(awardResult.uid);
      userWalletAddress = walletConfig.walletAddress;
      walletMode = walletConfig.walletMode;
    } catch (err) {
      return {
        success: false,
        dedupKey: awardResult.dedupKey,
        eligible: true,
        amount: awardResult.amount,
        uid: awardResult.uid,
        error: `Address resolution failed: ${err instanceof Error ? err.message : String(err)}`,
        stage: 'validation',
      };
    }

    // Stage 5: Execute on-chain (required)
    try {
      const txHash = await executeAward(treasurySigner, userWalletAddress, awardResult.amount);
      let dbStored = false;
      let dbError: string | undefined;

      try {
        await recordAward(
          normalised,
          awardResult.amount,
          awardResult.dedupKey,
          txHash,
          JSON.stringify(rawCDR),
          awardResult.metadata
        );
        dbStored = true;

        // Approve user for spending (asynchrnonous - returns quickly, completes in background)
        // Sends MATIC to user wallet and calls approve() on token contract
        if (walletMode === 'managed') {
          (async () => {
            try {
              const treasuryAddress = getTreasuryAddress();
              await approveUserForSpendingViaFunding(awardResult.uid, treasurySigner, treasuryAddress);
              console.log(`✓ Approval completed for user ${awardResult.uid}`);
            } catch (approvalErr) {
              console.error(`✗ Approval failed for user ${awardResult.uid}:`, approvalErr instanceof Error ? approvalErr.message : String(approvalErr));
            }
          })();
        }
      } catch (err) {
        dbError = err instanceof Error ? err.message : String(err);
      }

      return {
        success: true,
        dedupKey: awardResult.dedupKey,
        eligible: true,
        amount: awardResult.amount,
        uid: awardResult.uid,
        txHash,
        dbStored,
        dbError,
        stage: 'complete',
      };
    } catch (err) {
      return {
        success: false,
        dedupKey: awardResult.dedupKey,
        eligible: awardResult.eligible,
        amount: awardResult.amount,
        uid: awardResult.uid,
        error: `On-chain execution failed: ${err instanceof Error ? err.message : String(err)}`,
        stage: 'execution',
      };
    }
  } catch (err) {
    return {
      success: false,
      dedupKey: '',
      eligible: false,
      amount: 0,
      uid: '',
      error: `Unexpected error: ${err instanceof Error ? err.message : String(err)}`,
      stage: 'normalisation',
    };
  }
}