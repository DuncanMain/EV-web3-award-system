import { getDatabase } from './connection';
import {
  canonicalTokenAmount,
  requireCanonicalTransactionHash,
  requireUnambiguousTransactionMatch,
  truncateTokenAmount,
} from './tokenOperation';

/**
 * Database service for managing application data
 * Mirrors blockchain state for API queries
 */

export interface UserRecord {
  id: string;
  uid: string;
  wallet_address: string;
  wallet_name?: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface AwardRecord {
  id: string;
  user_id: string;
  session_id: string;
  provider_id: string;
  dedup_key: string;
  amount: string; // Decimal as string
  cdr_data: string | null;
  tx_hash: string;
  awarded_at: Date;
  award_type?: string; // 'OFF_PEAK_CHARGING' | 'V2G_DISCHARGE'
  is_off_peak?: boolean; // Whether awarded during off-peak hours
  country_code?: string; // Country code derived from EVSEID
  local_time?: string; // Local time in HH:MM format
  status?: string;
  error_message?: string | null;
  confirmed_at?: Date | null;
  created_at: Date;
}

export interface BalanceRecord {
  id: string;
  user_id: string;
  wallet_address: string;
  balance: string; // Decimal as string
  total_awarded: string;
  total_spent: string;
  last_synced: Date;
  created_at: Date;
  updated_at: Date;
}

export interface SpendRecord {
  id: string;
  user_id: string;
  wallet_address: string;
  amount: string;
  tx_hash: string;
  session_id?: string;
  status?: string;
  error_message?: string | null;
  confirmed_at?: Date | null;
  created_at: Date;
}

export interface SpendReceiptRecord {
  id: string;
  receipt_id: string;
  uid: string;
  wallet_address: string;
  amount: string;
  session_id?: string | null;
  provider_id?: string | null;
  status: string;
  token_tx_hash: string;
  token_contract_address: string;
  chain_id: number;
  signer_address: string;
  canonical_payload: string;
  signature: string;
  issued_at: Date;
  created_at: Date;
  updated_at: Date;
}

export interface SpendReservationRecord {
  id: string;
  uid: string;
  wallet_address: string;
  session_id: string;
  provider_id: string;
  reserved_amount: string;
  settled_amount?: string | null;
  released_amount?: string | null;
  delivered_kwh?: string | null;
  status: 'reserved' | 'settling' | 'settled' | 'released';
  tx_hash?: string | null;
  error_message?: string | null;
  authorization_tx_hash?: string | null;
  authorization_amount?: string | null;
  reserved_at: Date;
  settled_at?: Date | null;
  updated_at: Date;
}

export type TokenOperationType = 'award' | 'spend';
export type TokenOperationStatus =
  | 'submitting'
  | 'submitted'
  | 'confirmed'
  | 'projected'
  | 'unknown'
  | 'failed';

/** Evidence classification used when deciding whether a wallet hold can be released. */
export type TokenMovementOutcome = 'unknown' | 'confirmed' | 'no_movement' | 'review';

/**
 * A distinct CDR key attempted to claim an already-owned physical charging
 * session. This is a review condition, never an automatic duplicate success
 * or reversal: the original operation may already have moved tokens.
 */
export class AwardChargingSessionCollisionError extends Error {
  readonly code = 'AWARD_CHARGING_SESSION_COLLISION_REVIEW' as const;
  readonly existingOperationKey: string;

  constructor(existingOperationKey: string) {
    super(
      'AWARD_CHARGING_SESSION_COLLISION_REVIEW: another CDR key already owns this provider charging session; operator review is required and no replacement award was submitted',
    );
    this.name = 'AwardChargingSessionCollisionError';
    this.existingOperationKey = existingOperationKey;
  }
}

export function isAwardChargingSessionCollisionError(error: unknown): error is AwardChargingSessionCollisionError {
  return error instanceof AwardChargingSessionCollisionError
    || (Boolean(error) && typeof error === 'object' && (error as { code?: unknown }).code === 'AWARD_CHARGING_SESSION_COLLISION_REVIEW');
}

/**
 * Durable claim for a token movement.  The operation row is written before
 * the chain call and retains the chain hash once one is available.  This is
 * deliberately separate from awards/spends: those tables are projections and
 * may be rebuilt after a database or receipt failure without moving tokens a
 * second time.
 */
export interface TokenOperationRecord {
  id: string;
  operation_key: string;
  operation_type: TokenOperationType;
  legacy_key?: string | null;
  request_fingerprint: string;
  uid: string;
  wallet_address: string;
  amount: string;
  session_id?: string | null;
  provider_id?: string | null;
  /** Explicit physical session provenance; NULL for historical/unbound claims. */
  charging_session_id?: string | null;
  reservation_id?: string | null;
  intent_context?: Record<string, unknown> | null;
  status: TokenOperationStatus;
  movement_outcome?: TokenMovementOutcome;
  tx_hash?: string | null;
  error_message?: string | null;
  submitted_at?: Date | null;
  confirmed_at?: Date | null;
  projected_at?: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface TokenOperationClaim {
  operation: TokenOperationRecord;
  acquired: boolean;
  legacyRecord?: AwardRecord;
}

export interface AuditLogRecord {
  id: string;
  event_type: string;
  actor_type: string;
  actor_id?: string | null;
  target_type?: string | null;
  target_id?: string | null;
  status: string;
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface ReconciliationReportRecord {
  id: string;
  status: string;
  checked_count: number;
  matched_count: number;
  mismatch_count: number;
  items: Record<string, unknown>[];
  metadata: Record<string, unknown>;
  created_at: Date;
}

export interface LinkedWalletAddressRecord {
  id: string;
  uid: string;
  wallet_address: string;
  wallet_name?: string | null;
  created_at: Date;
  updated_at: Date;
}

function decimalUnits(value: unknown): bigint {
  const text = String(value ?? '0').trim();
  if (!/^\d+(?:\.\d+)?$/.test(text)) throw new Error('INVALID_DECIMAL_AMOUNT');
  const [whole, fraction = ''] = text.split('.');
  if (fraction.length > 2) throw new Error('UNSUPPORTED_TOKEN_PRECISION');
  return BigInt(whole) * 100n + BigInt((fraction + '00').slice(0, 2));
}

export type ApprovalPreparationStatus = 'funding' | 'funded' | 'approving' | 'approved' | 'unknown';

export interface ApprovalPreparationRecord {
  id: string;
  operation_key: string;
  wallet_address: string;
  token_contract_address: string;
  chain_id: string;
  treasury_address: string;
  status: ApprovalPreparationStatus;
  funding_tx_hash?: string | null;
  approval_tx_hash?: string | null;
  error_message?: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ApprovalSubmissionClaim {
  record: ApprovalPreparationRecord;
  acquired: boolean;
}

export interface ApprovalFundingClaim {
  record: ApprovalPreparationRecord;
  acquired: boolean;
}

/**
 * Durable state for managed-wallet gas/allowance preparation. A row is
 * committed before either transaction is submitted. `funding`, `approving`,
 * and `unknown` are deliberately non-retryable automatically because a
 * process can lose the response after the transaction was broadcast.
 */
export const ApprovalPreparations = {
  async findByKey(operationKey: string): Promise<ApprovalPreparationRecord | undefined> {
    const db = getDatabase();
    return db('approval_preparations').where({ operation_key: operationKey }).first();
  },

  async claim(data: {
    operationKey: string;
    walletAddress: string;
    tokenContractAddress: string;
    chainId: string;
    treasuryAddress: string;
  }): Promise<{ record: ApprovalPreparationRecord; acquired: boolean }> {
    const db = getDatabase();
    return db.transaction(async trx => {
      await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`approval:${data.operationKey}`]);
      const existing = await trx('approval_preparations').where({ operation_key: data.operationKey }).forUpdate().first() as ApprovalPreparationRecord | undefined;
      if (existing) {
        if (existing.wallet_address.toLowerCase() !== data.walletAddress.toLowerCase()
          || existing.token_contract_address.toLowerCase() !== data.tokenContractAddress.toLowerCase()
          || String(existing.chain_id) !== String(data.chainId)
          || existing.treasury_address.toLowerCase() !== data.treasuryAddress.toLowerCase()) {
          throw new Error('APPROVAL_PREPARATION_INTENT_MISMATCH: saved wallet, asset, chain, or treasury differs');
        }
        return { record: existing, acquired: false };
      }
      const [record] = await trx('approval_preparations').insert({
        operation_key: data.operationKey,
        wallet_address: data.walletAddress.toLowerCase(),
        token_contract_address: data.tokenContractAddress.toLowerCase(),
        chain_id: String(data.chainId),
        treasury_address: data.treasuryAddress.toLowerCase(),
        status: 'funding',
        funding_tx_hash: null,
        approval_tx_hash: null,
        error_message: null,
      }).returning('*') as ApprovalPreparationRecord[];
      return { record, acquired: true };
    });
  },

  async markFundingSubmitted(operationKey: string, txHash: string): Promise<ApprovalPreparationRecord | undefined> {
    const db = getDatabase();
    const normalizedHash = requireCanonicalTransactionHash(txHash, 'funding transaction hash');
    const [record] = await db('approval_preparations').where({ operation_key: operationKey }).update({
      funding_tx_hash: normalizedHash, status: 'funding', error_message: null, updated_at: db.fn.now(),
    }).returning('*') as ApprovalPreparationRecord[];
    return record || this.findByKey(operationKey);
  },

  async markFunded(operationKey: string): Promise<ApprovalPreparationRecord | undefined> {
    const db = getDatabase();
    const [record] = await db('approval_preparations').where({ operation_key: operationKey }).update({
      status: 'funded', error_message: null, updated_at: db.fn.now(),
    }).returning('*') as ApprovalPreparationRecord[];
    return record || this.findByKey(operationKey);
  },

  /**
   * Claim the single measured top-up permitted after confirmed funding was
   * found below the current gas target. The advisory lock and conditional
   * update mean a second API process receives `acquired: false` and cannot
   * broadcast its own funding transaction.
   */
  async claimFundingTopUp(operationKey: string): Promise<ApprovalFundingClaim> {
    const db = getDatabase();
    return db.transaction(async trx => {
      await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`approval:${operationKey}`]);
      const [record] = await trx('approval_preparations')
        .where({ operation_key: operationKey, status: 'funded' })
        .whereNull('approval_tx_hash')
        .update({ status: 'funding', error_message: null, updated_at: trx.fn.now() })
        .returning('*') as ApprovalPreparationRecord[];
      if (record) return { record, acquired: true };
      const existing = await trx('approval_preparations')
        .where({ operation_key: operationKey })
        .forUpdate()
        .first() as ApprovalPreparationRecord | undefined;
      if (!existing) throw new Error(`APPROVAL_PREPARATION_MISSING: ${operationKey}`);
      return { record: existing, acquired: false };
    });
  },

  /**
   * Adopt a previously ambiguous preparation only after the caller has made
   * an independent read-only chain proof that the funding transaction
   * succeeded and no approval transaction could have been accepted. The
   * conditional update keeps a concurrent reviewer/process from converting a
   * preparation that has since acquired an approval hash.
   */
  async recoverFundedAfterReadOnlyProof(operationKey: string): Promise<ApprovalPreparationRecord | undefined> {
    const db = getDatabase();
    const [record] = await db('approval_preparations')
      .where({ operation_key: operationKey, status: 'unknown' })
      .whereNotNull('funding_tx_hash')
      .whereNull('approval_tx_hash')
      .update({ status: 'funded', error_message: null, updated_at: db.fn.now() })
      .returning('*') as ApprovalPreparationRecord[];
    return record || this.findByKey(operationKey);
  },

  async markApproving(operationKey: string): Promise<ApprovalPreparationRecord | undefined> {
    const db = getDatabase();
    const [record] = await db('approval_preparations').where({ operation_key: operationKey }).update({
      status: 'approving', error_message: null, updated_at: db.fn.now(),
    }).returning('*') as ApprovalPreparationRecord[];
    return record || this.findByKey(operationKey);
  },

  /**
   * Atomically claim the right to submit the allowance transaction.
   *
   * `funded` is the only state from which a caller may broadcast approval.
   * The conditional update is protected by the same advisory lock used by
   * `claim`, so callers in separate API processes cannot both observe
   * `funded` and send an approval transaction.
   */
  async claimApprovalSubmission(operationKey: string): Promise<ApprovalSubmissionClaim> {
    const db = getDatabase();
    return db.transaction(async trx => {
      await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`approval:${operationKey}`]);
      const [record] = await trx('approval_preparations')
        .where({ operation_key: operationKey, status: 'funded' })
        .update({ status: 'approving', error_message: null, updated_at: trx.fn.now() })
        .returning('*') as ApprovalPreparationRecord[];
      if (record) return { record, acquired: true };

      const existing = await trx('approval_preparations')
        .where({ operation_key: operationKey })
        .forUpdate()
        .first() as ApprovalPreparationRecord | undefined;
      if (!existing) throw new Error(`APPROVAL_PREPARATION_MISSING: ${operationKey}`);
      return { record: existing, acquired: false };
    });
  },

  async markApprovalSubmitted(operationKey: string, txHash: string): Promise<ApprovalPreparationRecord | undefined> {
    const db = getDatabase();
    const normalizedHash = requireCanonicalTransactionHash(txHash, 'approval transaction hash');
    const [record] = await db('approval_preparations').where({ operation_key: operationKey }).update({
      approval_tx_hash: normalizedHash, status: 'approving', error_message: null, updated_at: db.fn.now(),
    }).returning('*') as ApprovalPreparationRecord[];
    return record || this.findByKey(operationKey);
  },

  async markApproved(operationKey: string): Promise<ApprovalPreparationRecord | undefined> {
    const db = getDatabase();
    const [record] = await db('approval_preparations').where({ operation_key: operationKey }).update({
      status: 'approved', error_message: null, updated_at: db.fn.now(),
    }).returning('*') as ApprovalPreparationRecord[];
    return record || this.findByKey(operationKey);
  },

  async markUnknown(
    operationKey: string,
    error: string,
    options: { fundingTxHash?: string; clearFundingHash?: boolean } = {},
  ): Promise<ApprovalPreparationRecord | undefined> {
    const db = getDatabase();
    const update: Record<string, unknown> = {
      status: 'unknown', error_message: error, updated_at: db.fn.now(),
    };
    if (options.fundingTxHash) {
      update.funding_tx_hash = requireCanonicalTransactionHash(options.fundingTxHash, 'funding transaction hash');
    }
    else if (options.clearFundingHash) update.funding_tx_hash = null;
    const [record] = await db('approval_preparations').where({ operation_key: operationKey }).update({
      ...update,
    }).returning('*') as ApprovalPreparationRecord[];
    return record || this.findByKey(operationKey);
  },
};

/**
 * User operations
 */
export const Users = {
  async create(uid: string, walletAddress: string, walletName?: string | null): Promise<UserRecord> {
    const db = getDatabase();
    const [record] = await db('users')
      .insert({ uid, wallet_address: walletAddress, wallet_name: walletName || null })
      .returning('*');
    return record;
  },

  async findByUid(uid: string): Promise<UserRecord | undefined> {
    const db = getDatabase();
    return db('users').where({ uid }).orderBy('created_at', 'asc').first();
  },

  async findByUidAndWallet(uid: string, walletAddress: string): Promise<UserRecord | undefined> {
    const db = getDatabase();
    return db('users')
      .where({ uid })
      .whereRaw('lower(wallet_address) = lower(?)', [walletAddress])
      .first();
  },

  async findByWallet(walletAddress: string): Promise<UserRecord | undefined> {
    const db = getDatabase();
    return db('users')
      .whereRaw('lower(wallet_address) = lower(?)', [walletAddress])
      .first();
  },

  async findAllByWallet(walletAddress: string): Promise<UserRecord[]> {
    const db = getDatabase();
    return db('users')
      .whereRaw('lower(wallet_address) = lower(?)', [walletAddress])
      .orderBy('created_at', 'asc');
  },

  async updateWalletAddress(uid: string, walletAddress: string): Promise<UserRecord> {
    const db = getDatabase();
    const existing = await this.findByUid(uid);
    if (!existing) {
      throw new Error(`EMP contract ID "${uid}" not found`);
    }
    const [record] = await db('users')
      .where({ id: existing.id })
      .update({
        wallet_address: walletAddress,
        updated_at: db.fn.now(),
      })
      .returning('*');
    return record;
  },

  async updateWalletAddressById(id: string, walletAddress: string): Promise<UserRecord> {
    const db = getDatabase();
    const [record] = await db('users')
      .where({ id })
      .update({
        wallet_address: walletAddress,
        updated_at: db.fn.now(),
      })
      .returning('*');
    return record;
  },

  async updateWalletNameByAddress(walletAddress: string, walletName: string | null): Promise<UserRecord[]> {
    const db = getDatabase();
    return db('users')
      .whereRaw('lower(wallet_address) = lower(?)', [walletAddress])
      .update({
        wallet_name: walletName,
        updated_at: db.fn.now(),
      })
      .returning('*');
  },

  async linkContractId(uid: string, walletAddress: string, walletName?: string | null): Promise<UserRecord> {
    const existing = await this.findByUidAndWallet(uid, walletAddress);
    if (existing) {
      return existing;
    }
    return this.create(uid, walletAddress, walletName || null);
  },

  async deleteByUidAndWallet(uid: string, walletAddress: string): Promise<number> {
    const db = getDatabase();
    return db('users')
      .where({ uid })
      .whereRaw('lower(wallet_address) = lower(?)', [walletAddress])
      .delete();
  },

  async hasActivity(userId: string): Promise<boolean> {
    const db = getDatabase();
    const [award, spend, balance] = await Promise.all([
      db('awards').where({ user_id: userId }).first(),
      db('spends').where({ user_id: userId }).first(),
      db('balances').where({ user_id: userId }).whereRaw('balance <> 0').first(),
    ]);
    return Boolean(award || spend || balance);
  },

  async getAll(): Promise<UserRecord[]> {
    const db = getDatabase();
    return db('users').orderBy('created_at', 'asc');
  },
};

/**
 * Address-based linked wallets.
 */
export const LinkedWallets = {
  tableName: 'linked_wallet_links',
  maxPerUid: 5,

  async findByUid(uid: string): Promise<LinkedWalletAddressRecord[]> {
    const db = getDatabase();
    return db(this.tableName)
      .where({ uid })
      .orderBy('created_at', 'asc');
  },

  async findByAddress(walletAddress: string): Promise<LinkedWalletAddressRecord | undefined> {
    const db = getDatabase();
    return db(this.tableName)
      .whereRaw('lower(wallet_address) = lower(?)', [walletAddress])
      .first();
  },

  async add(uid: string, walletAddress: string): Promise<LinkedWalletAddressRecord> {
    const db = getDatabase();
    const existingForUid = await db(this.tableName)
      .where({ uid })
      .whereRaw('lower(wallet_address) = lower(?)', [walletAddress])
      .first();

    if (existingForUid) return existingForUid;

    const existingForOtherUid = await this.findByAddress(walletAddress);
    if (existingForOtherUid) {
      throw new Error('This wallet address is already linked. Unlink it before linking it again.');
    }

    const count = await db(this.tableName)
      .where({ uid })
      .count<{ count: string }>({ count: '*' })
      .first();

    if (Number(count?.count || 0) >= this.maxPerUid) {
      throw new Error(`A maximum of ${this.maxPerUid} wallet addresses can be linked`);
    }

    const [record] = await db(this.tableName)
      .insert({ uid, wallet_address: walletAddress })
      .returning('*');
    return record;
  },

  async remove(uid: string, walletAddress: string): Promise<number> {
    const db = getDatabase();
    return db(this.tableName)
      .where({ uid })
      .whereRaw('lower(wallet_address) = lower(?)', [walletAddress])
      .delete();
  },

  async updateName(uid: string, walletAddress: string, walletName: string | null): Promise<LinkedWalletAddressRecord | undefined> {
    const db = getDatabase();
    const [record] = await db(this.tableName)
      .where({ uid })
      .whereRaw('lower(wallet_address) = lower(?)', [walletAddress])
      .update({
        wallet_name: walletName,
        updated_at: db.fn.now(),
      })
      .returning('*');
    return record;
  },
};

/**
 * Award operations
 */
export const Awards = {
  async create(data: {
    userId: string;
    sessionId: string;
    providerId: string;
    dedupKey: string;
    amount: string;
    cdrData?: string;
    txHash: string;
    awardedAt: Date;
    awardType?: string;
    isOffPeak?: boolean;
    countryCode?: string;
    localTime?: string;
    status?: string;
    errorMessage?: string | null;
    confirmedAt?: Date | null;
  }): Promise<AwardRecord> {
    const db = getDatabase();
    const normalizedHash = requireCanonicalTransactionHash(data.txHash);
    const [record] = await db('awards')
      .insert({
        user_id: data.userId,
        session_id: data.sessionId,
        provider_id: data.providerId,
        dedup_key: data.dedupKey,
        amount: data.amount,
        cdr_data: data.cdrData || null,
        tx_hash: normalizedHash,
        awarded_at: data.awardedAt,
        award_type: data.awardType || null,
        is_off_peak: data.isOffPeak ?? false,
        country_code: data.countryCode || null,
        local_time: data.localTime || null,
        status: data.status || 'confirmed',
        error_message: data.errorMessage || null,
        confirmed_at: data.confirmedAt || data.awardedAt,
      })
      .returning('*');
    return record;
  },

  async findByDedupKey(dedupKey: string): Promise<AwardRecord | undefined> {
    const db = getDatabase();
    return db('awards').where({ dedup_key: dedupKey }).first();
  },

  async findByUser(userId: string): Promise<AwardRecord[]> {
    const db = getDatabase();
    return db('awards').where({ user_id: userId }).orderBy('awarded_at', 'desc');
  },

  async exists(dedupKey: string): Promise<boolean> {
    const db = getDatabase();
    const result = await db('awards').where({ dedup_key: dedupKey }).first();
    return !!result;
  },

  async getAll(): Promise<AwardRecord[]> {
    const db = getDatabase();
    return db('awards').orderBy('awarded_at', 'desc');
  },
};

/**
 * Balance operations
 */
export const Balances = {
  async upsert(data: {
    userId: string;
    walletAddress: string;
    balance: string;
    totalAwarded: string;
    totalSpent: string;
  }): Promise<BalanceRecord> {
    const db = getDatabase();
    const existing = await db('balances').where({ user_id: data.userId }).first();

    if (existing) {
      const [record] = await db('balances')
        .where({ user_id: data.userId })
        .update({
          balance: data.balance,
          total_awarded: data.totalAwarded,
          total_spent: data.totalSpent,
          last_synced: db.fn.now(),
        })
        .returning('*');
      return record;
    } else {
      const [record] = await db('balances')
        .insert({
          user_id: data.userId,
          wallet_address: data.walletAddress,
          balance: data.balance,
          total_awarded: data.totalAwarded,
          total_spent: data.totalSpent,
        })
        .returning('*');
      return record;
    }
  },

  async findByUser(userId: string): Promise<BalanceRecord | undefined> {
    const db = getDatabase();
    return db('balances').where({ user_id: userId }).first();
  },

  async findByWallet(walletAddress: string): Promise<BalanceRecord | undefined> {
    const db = getDatabase();
    return db('balances').where({ wallet_address: walletAddress }).first();
  },

  async getAll(): Promise<BalanceRecord[]> {
    const db = getDatabase();
    return db('balances').orderBy('total_awarded', 'desc');
  },
};

/**
 * Spend operations
 */
export const Spends = {
  async create(data: {
    userId: string;
    walletAddress: string;
    amount: string;
    txHash: string;
    sessionId?: string;
    status?: string;
    errorMessage?: string | null;
    confirmedAt?: Date | null;
  }): Promise<SpendRecord> {
    const db = getDatabase();
    const normalizedHash = requireCanonicalTransactionHash(data.txHash);
    const [record] = await db('spends')
      .insert({
        user_id: data.userId,
        wallet_address: data.walletAddress,
        amount: data.amount,
        tx_hash: normalizedHash,
        session_id: data.sessionId || null,
        status: data.status || 'confirmed',
        error_message: data.errorMessage || null,
        confirmed_at: data.confirmedAt || new Date(),
      })
      .returning('*');
    return record;
  },

  async findByUser(userId: string): Promise<SpendRecord[]> {
    const db = getDatabase();
    return db('spends').where({ user_id: userId }).orderBy('created_at', 'desc');
  },

  async findByWallet(walletAddress: string): Promise<SpendRecord[]> {
    const db = getDatabase();
    return db('spends').whereRaw('lower(wallet_address) = lower(?)', [walletAddress]).orderBy('created_at', 'desc');
  },

  async findByTxHash(txHash: string): Promise<SpendRecord | undefined> {
    const db = getDatabase();
    const normalizedHash = requireCanonicalTransactionHash(txHash);
    const matches = await db('spends').whereRaw('lower(tx_hash) = lower(?)', [normalizedHash]).limit(2);
    return requireUnambiguousTransactionMatch(matches, 'spend');
  },

  async getAll(): Promise<SpendRecord[]> {
    const db = getDatabase();
    return db('spends').orderBy('created_at', 'desc');
  },
};

/**
 * Durable token movement claims and recovery state.
 *
 * `claim` serialises only the claim decision.  The transaction is committed
 * before the caller submits a blockchain transaction, so a second request
 * cannot observe an unclaimed operation and submit the same movement.  A
 * claim without a hash is never taken over automatically: it is returned as
 * an in-flight/unknown operation and requires operator review.
 */
export const TokenOperations = {
  async findByKey(operationKey: string): Promise<TokenOperationRecord | undefined> {
    const db = getDatabase();
    return db('token_operations').where({ operation_key: operationKey }).first();
  },

  async findByTxHash(txHash: string): Promise<TokenOperationRecord | undefined> {
    const db = getDatabase();
    const normalizedHash = requireCanonicalTransactionHash(txHash);
    const matches = await db('token_operations').whereRaw('lower(tx_hash) = lower(?)', [normalizedHash]).limit(2);
    return requireUnambiguousTransactionMatch(matches, 'operation');
  },

  async claim(data: {
    operationKey: string;
    operationType: TokenOperationType;
    requestFingerprint: string;
    uid: string;
    walletAddress: string;
    amount: string;
    sessionId?: string | null;
    providerId?: string | null;
    chargingSessionId?: string | null;
    reservationId?: string | null;
    intentContext?: Record<string, unknown> | null;
    legacyKey?: string | null;
    /** Optional chain balance sampler used while holding the wallet lock. */
    getOnChainBalance?: () => Promise<number>;
  }): Promise<TokenOperationClaim> {
    const canonicalAmount = canonicalTokenAmount(data.amount);
    if (!canonicalAmount) throw new Error('UNSUPPORTED_TOKEN_PRECISION');
    const db = getDatabase();
    return db.transaction(async trx => {
      const walletLockKey = `wallet:${data.walletAddress.toLowerCase()}`;
      // Manual spends and reservations use the same wallet advisory lock.
      // Reservation-backed spends already have a reservation hold and must
      // not count that hold twice.
      if (data.operationType === 'spend' && !data.reservationId) {
        await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [walletLockKey]);
      }
      // The advisory lock protects the read-then-insert claim on PostgreSQL.
      // operation_key remains uniquely constrained as the final guard.
      await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [data.operationKey]);

      const checkManualCapacity = async (): Promise<void> => {
        if (data.operationType !== 'spend' || data.reservationId || !data.getOnChainBalance) return;
        const amount = canonicalTokenAmount(data.amount);
        if (!amount) throw new Error('UNSUPPORTED_TOKEN_PRECISION');
        const sampledBalance = await data.getOnChainBalance();
        const balance = truncateTokenAmount(sampledBalance);
        if (!balance || balance.units < 0n) {
          throw new Error('SPEND_BALANCE_UNAVAILABLE: on-chain balance could not be read');
        }
        const holds = await trx('spend_reservations')
          .whereRaw('lower(wallet_address) = lower(?)', [data.walletAddress])
          .whereIn('status', ['reserved', 'settling'])
          .sum({ total: 'reserved_amount' })
          .first();
        const unresolvedManual = await trx('token_operations')
          .where({ operation_type: 'spend' })
          .whereNull('reservation_id')
          .whereRaw('lower(wallet_address) = lower(?)', [data.walletAddress])
          .whereNot({ operation_key: data.operationKey })
          .whereNot({ status: 'projected' })
          .where(query => query.whereNull('movement_outcome').orWhereNot('movement_outcome', 'no_movement'))
          .where(query => query.whereNotNull('tx_hash').orWhereIn('status', ['submitting', 'submitted', 'confirmed', 'unknown']))
          .sum({ total: 'amount' })
          .first();
        const heldUnits = decimalUnits(holds?.total || 0) + decimalUnits(unresolvedManual?.total || 0);
        const availableUnits = balance.units - heldUnits;
        if (amount.units > availableUnits) {
          throw new Error(`INSUFFICIENT_SPARKZ_AVAILABLE:${Number(availableUnits > 0n ? availableUnits : 0n) / 100}`);
        }
      };

      const existing = await trx('token_operations')
        .where({ operation_key: data.operationKey })
        .first() as TokenOperationRecord | undefined;

      if (existing) {
        assertOperationIntent(existing, { ...data, amount: canonicalAmount.decimal }, data.operationType !== 'award');
        if (existing.status === 'failed' && !existing.tx_hash && existing.error_message?.startsWith('PREFLIGHT:')) {
          await checkManualCapacity();
          const [reclaimed] = await trx('token_operations')
            .where({ operation_key: data.operationKey })
            .update({ status: 'submitting', movement_outcome: 'unknown', error_message: null, updated_at: trx.fn.now() })
            .returning('*') as TokenOperationRecord[];
          return { operation: reclaimed, acquired: true };
        }
        return { operation: existing, acquired: false };
      }

      // A standard OCPI CDR can be replaced with a new CDR id while retaining
      // the same provider and physical charging session. Serialize that
      // association before inserting the operation so concurrent replacement
      // requests cannot both proceed to a chain call. The nullable field is
      // intentionally absent for legacy/unqualified payloads.
      if (data.operationType === 'award' && data.providerId && data.chargingSessionId) {
        const chargingSessionLockKey = `award-charging-session:${data.providerId}:${data.chargingSessionId}`;
        await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [chargingSessionLockKey]);
        const physicalSessionClaim = await trx('token_operations')
          .where({
            operation_type: 'award',
            provider_id: data.providerId,
            charging_session_id: data.chargingSessionId,
          })
          .whereNot({ operation_key: data.operationKey })
          .first() as TokenOperationRecord | undefined;
        if (physicalSessionClaim) {
          throw new AwardChargingSessionCollisionError(physicalSessionClaim.operation_key);
        }
      }

      // A legacy dedup key is not collision-safe. Serialize all durable award
      // claims on it and reject a distinct provider/session tuple before any
      // chain call can occur.
      if (data.operationType === 'award' && data.legacyKey) {
        await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`award-legacy:${data.legacyKey}`]);
        const otherClaim = await trx('token_operations')
          .where({ operation_type: 'award', legacy_key: data.legacyKey })
          .whereNot({ operation_key: data.operationKey })
          .first() as TokenOperationRecord | undefined;
        if (otherClaim) {
          throw new Error(
            `LEGACY_DEDUP_KEY_COLLISION_REVIEW: existing durable claim ${otherClaim.operation_key} owns legacy key ${data.legacyKey}`,
          );
        }
      }

      // Keep legacy deduplication behaviour for awards created before this
      // ledger existed, but verify the tuple before treating it as a match.
      // The old `${sessionId}-${providerId}` key is ambiguous for values that
      // themselves contain dashes, so a mismatch is a review condition.
      if (data.operationType === 'award' && data.legacyKey) {
        const legacy = await trx('awards').where({ dedup_key: data.legacyKey }).first() as AwardRecord | undefined;
        if (legacy) {
          if (legacy.session_id !== data.sessionId || legacy.provider_id !== data.providerId) {
            throw new Error('LEGACY_DEDUP_KEY_COLLISION_REVIEW: existing award does not match provider/session tuple');
          }
          const legacyUser = await trx('users').where({ id: legacy.user_id }).first() as UserRecord | undefined;
          if (!legacyUser
            || legacyUser.uid !== data.uid
            || legacyUser.wallet_address.toLowerCase() !== data.walletAddress.toLowerCase()) {
            throw new Error('LEGACY_DEDUP_KEY_COLLISION_REVIEW: existing award owner is not an exact intent match');
          }
          return { operation: undefined as never, acquired: false, legacyRecord: legacy };
        }
      }

      await checkManualCapacity();

      const [operation] = await trx('token_operations')
        .insert({
          operation_key: data.operationKey,
          operation_type: data.operationType,
          legacy_key: data.legacyKey || null,
          request_fingerprint: data.requestFingerprint,
          uid: data.uid,
          wallet_address: data.walletAddress,
          amount: canonicalAmount.decimal,
          session_id: data.sessionId || null,
          provider_id: data.providerId || null,
          ...(data.chargingSessionId ? { charging_session_id: data.chargingSessionId } : {}),
          reservation_id: data.reservationId || null,
          intent_context: data.intentContext || null,
          status: 'submitting',
          movement_outcome: 'unknown',
          error_message: null,
        })
        .returning('*') as TokenOperationRecord[];
      return { operation, acquired: true };
    });
  },

  async markSubmitted(operationKey: string, txHash: string): Promise<TokenOperationRecord> {
    const db = getDatabase();
    const normalizedHash = requireCanonicalTransactionHash(txHash);
    const [record] = await db('token_operations')
      .where({ operation_key: operationKey })
      .whereNull('tx_hash')
      .update({
        tx_hash: normalizedHash,
        status: 'submitted',
        submitted_at: db.fn.now(),
        error_message: null,
        updated_at: db.fn.now(),
      })
      .returning('*') as TokenOperationRecord[];
    if (!record) {
      const current = await this.findByKey(operationKey);
      if (!current) throw new Error(`Token operation ${operationKey} was not found while saving transaction hash`);
      if (current.tx_hash && current.tx_hash.toLowerCase() !== normalizedHash) {
        throw new Error('TOKEN_OPERATION_TX_HASH_MISMATCH');
      }
      return current;
    }
    return record;
  },

  async markUnknown(operationKey: string, error: string): Promise<TokenOperationRecord | undefined> {
    const db = getDatabase();
    const [record] = await db('token_operations')
      .where({ operation_key: operationKey })
      .whereNull('tx_hash')
      .update({ status: 'unknown', error_message: error, updated_at: db.fn.now() })
      .returning('*') as TokenOperationRecord[];
    return record || this.findByKey(operationKey);
  },

  async markConfirmed(operationKey: string, errorMessage?: string | null): Promise<TokenOperationRecord | undefined> {
    const db = getDatabase();
    const [record] = await db('token_operations')
      .where({ operation_key: operationKey })
      .whereNotNull('tx_hash')
      .whereNot({ status: 'projected' })
      .update({
        status: 'confirmed',
        movement_outcome: 'confirmed',
        error_message: errorMessage || null,
        confirmed_at: db.fn.now(),
        updated_at: db.fn.now(),
      })
      .returning('*') as TokenOperationRecord[];
    return record || this.findByKey(operationKey);
  },

  async markProjectionError(operationKey: string, error: string): Promise<TokenOperationRecord | undefined> {
    const db = getDatabase();
    const [record] = await db('token_operations')
      .where({ operation_key: operationKey })
      .whereNotNull('tx_hash')
      .whereNot({ status: 'projected' })
      .update({ status: 'confirmed', error_message: error, updated_at: db.fn.now() })
      .returning('*') as TokenOperationRecord[];
    return record || this.findByKey(operationKey);
  },

  async markProjected(operationKey: string): Promise<TokenOperationRecord | undefined> {
    const db = getDatabase();
    return db.transaction(async trx => {
      // Hold release is serialized with reservation/manual-spend capacity
      // checks. The wallet lock is acquired before the operation lock, which
      // is the same order used by claim().
      const candidate = await trx('token_operations').where({ operation_key: operationKey }).first() as TokenOperationRecord | undefined;
      if (!candidate) return undefined;
      if (candidate.operation_type === 'spend') {
        await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`wallet:${candidate.wallet_address.toLowerCase()}`]);
      }
      await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [operationKey]);
      const current = await trx('token_operations').where({ operation_key: operationKey }).forUpdate().first() as TokenOperationRecord | undefined;
      if (!current) return undefined;
      if (current.status === 'failed') return current;
      if (!current.tx_hash && decimalUnits(current.amount) !== 0n) return current;
      const movementOutcome: TokenMovementOutcome = decimalUnits(current.amount) === 0n ? 'no_movement' : 'confirmed';
      const [record] = await trx('token_operations')
        .where({ operation_key: operationKey })
        .whereNot({ status: 'failed' })
        .where(query => query.whereNotNull('tx_hash').orWhere('amount', '0'))
        .update({ status: 'projected', movement_outcome: movementOutcome, error_message: null, projected_at: trx.fn.now(), updated_at: trx.fn.now() })
        .returning('*') as TokenOperationRecord[];
      return record || current;
    });
  },

  async markFailed(
    operationKey: string,
    error: string,
    movementOutcome: TokenMovementOutcome = 'review',
  ): Promise<TokenOperationRecord | undefined> {
    const db = getDatabase();
    return db.transaction(async trx => {
      const candidate = await trx('token_operations').where({ operation_key: operationKey }).first() as TokenOperationRecord | undefined;
      if (!candidate) return undefined;
      if (candidate.operation_type === 'spend') {
        // A no_movement result releases the manual hold. It must use the same
        // wallet lock as reserve/claim so a capacity read cannot race it.
        await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`wallet:${candidate.wallet_address.toLowerCase()}`]);
      }
      await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [operationKey]);
      const [record] = await trx('token_operations')
        .where({ operation_key: operationKey })
        .whereNotNull('tx_hash')
        .whereNot({ status: 'projected' })
        .update({ status: 'failed', movement_outcome: movementOutcome, error_message: error, updated_at: trx.fn.now() })
        .returning('*') as TokenOperationRecord[];
      return record || (await trx('token_operations').where({ operation_key: operationKey }).first() as TokenOperationRecord | undefined);
    });
  },

  async markPreflightFailed(operationKey: string, error: string): Promise<TokenOperationRecord | undefined> {
    const db = getDatabase();
    const [record] = await db('token_operations')
      .where({ operation_key: operationKey })
      .whereNull('tx_hash')
      .update({ status: 'failed', movement_outcome: 'no_movement', error_message: `PREFLIGHT:${error}`, updated_at: db.fn.now() })
      .returning('*') as TokenOperationRecord[];
    return record || this.findByKey(operationKey);
  },
};

function assertOperationIntent(
  existing: TokenOperationRecord,
  requested: {
    operationType: TokenOperationType;
    requestFingerprint: string;
    uid: string;
    walletAddress: string;
    amount: string;
    chargingSessionId?: string | null;
  },
  compareAmount: boolean,
): void {
  const sameWallet = existing.wallet_address.toLowerCase() === requested.walletAddress.toLowerCase();
  if (existing.operation_type === 'award' && existing.charging_session_id) {
    if (existing.charging_session_id !== requested.chargingSessionId) {
      throw new Error(
        'TOKEN_OPERATION_CHARGING_SESSION_MISMATCH: original CDR is bound to a different charging session identity; operator review is required',
      );
    }
  }
  if (
    existing.operation_type !== requested.operationType
    || existing.request_fingerprint !== requested.requestFingerprint
    || existing.uid !== requested.uid
    || !sameWallet
    || (compareAmount && existing.amount !== requested.amount)
  ) {
    throw new Error('TOKEN_OPERATION_INTENT_MISMATCH: retry financial intent differs from the original request');
  }
}

/**
 * Signed spend receipt operations.
 */
export const SpendReceipts = {
  async create(data: {
    receiptId: string;
    uid: string;
    walletAddress: string;
    amount: string;
    sessionId?: string | null;
    providerId?: string | null;
    status: string;
    tokenTxHash: string;
    tokenContractAddress: string;
    chainId: number;
    signerAddress: string;
    canonicalPayload: string;
    signature: string;
    issuedAt: Date;
  }): Promise<SpendReceiptRecord> {
    const db = getDatabase();
    const normalizedHash = requireCanonicalTransactionHash(data.tokenTxHash, 'token transaction hash');
    const [record] = await db('spend_receipts')
      .insert({
        receipt_id: data.receiptId,
        uid: data.uid,
        wallet_address: data.walletAddress,
        amount: data.amount,
        session_id: data.sessionId || null,
        provider_id: data.providerId || null,
        status: data.status,
        token_tx_hash: normalizedHash,
        token_contract_address: data.tokenContractAddress,
        chain_id: data.chainId,
        signer_address: data.signerAddress,
        canonical_payload: data.canonicalPayload,
        signature: data.signature,
        issued_at: data.issuedAt,
      })
      .returning('*');
    return record;
  },

  async findByReceiptId(receiptId: string): Promise<SpendReceiptRecord | undefined> {
    const db = getDatabase();
    return db('spend_receipts').where({ receipt_id: receiptId }).first();
  },

  async findByTxHash(tokenTxHash: string): Promise<SpendReceiptRecord | undefined> {
    const db = getDatabase();
    const normalizedHash = requireCanonicalTransactionHash(tokenTxHash, 'token transaction hash');
    const matches = await db('spend_receipts')
      .whereRaw('lower(token_tx_hash) = lower(?)', [normalizedHash])
      .limit(2);
    return requireUnambiguousTransactionMatch(matches, 'receipt');
  },

  async findByUid(uid: string): Promise<SpendReceiptRecord[]> {
    const db = getDatabase();
    return db('spend_receipts').where({ uid }).orderBy('issued_at', 'desc');
  },
};

/** Durable session reservations. Active reservations reduce API availability but
 * do not move on-chain tokens until a matching final CDR is received. */
export const SpendReservations = {
  async findByIdForUid(id: string, uid: string): Promise<SpendReservationRecord | undefined> {
    const db = getDatabase();
    return db('spend_reservations').where({ id, uid }).first();
  },

  async getActiveTotal(uid: string, walletAddress?: string): Promise<number> {
    const db = getDatabase();
    // When a wallet is supplied it is the accounting boundary: multiple
    // linked eMAIDs can share the same actual wallet, and their holds must
    // all reduce the same spendable balance. The uid-only form is retained
    // for callers that do not yet have a resolved wallet.
    const query = db('spend_reservations').whereIn('status', ['reserved', 'settling']);
    if (walletAddress) {
      query.whereRaw('lower(wallet_address) = lower(?)', [walletAddress]);
    } else {
      query.where({ uid });
    }
    const row = await query
      .sum({ total: 'reserved_amount' })
      .first();
    return Number(row?.total || 0);
  },

  async findBySession(uid: string, sessionId: string, providerId: string): Promise<SpendReservationRecord | undefined> {
    const db = getDatabase();
    return db('spend_reservations').where({ uid, session_id: sessionId, provider_id: providerId }).first();
  },

  async reserve(data: {
    uid: string;
    walletAddress: string;
    sessionId: string;
    providerId: string;
    amount: number;
    onChainBalance?: number;
    getOnChainBalance?: () => Promise<number>;
    authorizationTxHash?: string;
    authorizationAmount?: number;
  }): Promise<{ reservation: SpendReservationRecord; availableBalance: number; existing: boolean }> {
    const db = getDatabase();
    return db.transaction(async trx => {
      const requestedAmount = canonicalTokenAmount(data.amount);
      if (!requestedAmount) throw new Error('UNSUPPORTED_TOKEN_PRECISION: reservation amount must use at most 2 decimals');
      const authorizationAmount = data.authorizationAmount === undefined
        ? undefined
        : canonicalTokenAmount(data.authorizationAmount);
      if (data.authorizationAmount !== undefined && !authorizationAmount) {
        throw new Error('UNSUPPORTED_TOKEN_PRECISION: authorization amount must use at most 2 decimals');
      }
      // Reservations are backed by the actual wallet.  A contract may have
      // multiple linked eMAIDs, so serialise and total holds by wallet rather
      // than by uid alone.
      await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`wallet:${data.walletAddress.toLowerCase()}`]);
      const existing = await trx('spend_reservations').where({
        uid: data.uid,
        session_id: data.sessionId,
        provider_id: data.providerId,
      }).first();
      const totalRow = await trx('spend_reservations')
        .whereRaw('lower(wallet_address) = lower(?)', [data.walletAddress])
        .whereIn('status', ['reserved', 'settling'])
        .sum({ total: 'reserved_amount' })
        .first();
      if (existing) {
        if (existing.wallet_address.toLowerCase() !== data.walletAddress.toLowerCase()
          || decimalUnits(existing.reserved_amount) !== requestedAmount.units) {
          throw new Error('RESERVATION_INTENT_MISMATCH: retry does not match the original reservation amount or wallet');
        }
        // A retry returns the original reservation even if the current chain
        // balance has changed since the first request.
        return { reservation: existing, availableBalance: 0, existing: true };
      }
      const onChainBalance = data.getOnChainBalance
        ? await data.getOnChainBalance()
        : data.onChainBalance;
      const availableChainAmount = truncateTokenAmount(onChainBalance);
      if (!availableChainAmount || availableChainAmount.units < 0n) {
        throw new Error('SPEND_BALANCE_UNAVAILABLE: on-chain balance could not be read');
      }
      const unresolvedManual = await trx('token_operations')
        .where({ operation_type: 'spend' })
        .whereNull('reservation_id')
        .whereRaw('lower(wallet_address) = lower(?)', [data.walletAddress])
        .whereNot({ status: 'projected' })
        .where(query => query.whereNull('movement_outcome').orWhereNot('movement_outcome', 'no_movement'))
        .where(query => query.whereNotNull('tx_hash').orWhereIn('status', ['submitting', 'submitted', 'confirmed', 'unknown']))
        .sum({ total: 'amount' })
        .first();
      const availableUnits = availableChainAmount.units
        - decimalUnits(totalRow?.total || 0)
        - decimalUnits(unresolvedManual?.total || 0);
      const availableBalance = Number(availableUnits > 0n ? availableUnits : 0n) / 100;
      if (requestedAmount.units > availableUnits) throw new Error(`INSUFFICIENT_SPARKZ:${availableBalance}`);
      const [reservation] = await trx('spend_reservations').insert({
        uid: data.uid,
        wallet_address: data.walletAddress,
        session_id: data.sessionId,
        provider_id: data.providerId,
        reserved_amount: requestedAmount.decimal,
        authorization_tx_hash: data.authorizationTxHash
          ? requireCanonicalTransactionHash(data.authorizationTxHash, 'authorization transaction hash')
          : null,
        authorization_amount: authorizationAmount?.decimal || null,
        status: 'reserved',
      }).returning('*');
      return { reservation, availableBalance: availableBalance - requestedAmount.value, existing: false };
    });
  },

  async claimForSettlement(uid: string, sessionId: string, providerId: string): Promise<SpendReservationRecord | undefined> {
    const db = getDatabase();
    const [record] = await db('spend_reservations')
      .where({ uid, session_id: sessionId, provider_id: providerId, status: 'reserved' })
      .update({ status: 'settling', error_message: null, updated_at: db.fn.now() })
      .returning('*');
    return record;
  },

  async complete(id: string, deliveredKwh: number, settledAmount: number, txHash?: string): Promise<SpendReservationRecord> {
    const db = getDatabase();
    const normalizedHash = txHash
      ? requireCanonicalTransactionHash(txHash, 'reservation transaction hash')
      : undefined;
    return db.transaction(async trx => {
      // Completion releases part/all of the hold. Acquire the same wallet
      // advisory lock used by reserve/claim before locking the row so a
      // capacity sample cannot observe a stale hold and then race its release.
      const identity = await trx('spend_reservations').where({ id }).first() as Pick<SpendReservationRecord, 'wallet_address'> | undefined;
      if (!identity) throw new Error(`Reservation ${id} not found`);
      await trx.raw('select pg_advisory_xact_lock(hashtext(?))', [`wallet:${identity.wallet_address.toLowerCase()}`]);
      const current = await trx('spend_reservations').where({ id }).forUpdate().first() as SpendReservationRecord | undefined;
      if (!current) throw new Error(`Reservation ${id} not found`);
      if (current.status === 'settled' || current.status === 'released') {
        if (normalizedHash && current.tx_hash && current.tx_hash.toLowerCase() !== normalizedHash) {
          throw new Error('RESERVATION_TX_HASH_MISMATCH');
        }
        return current;
      }
      const reserved = canonicalTokenAmount(String(current.reserved_amount));
      const requestedSettled = canonicalTokenAmount(settledAmount);
      if (!reserved || !requestedSettled) throw new Error('UNSUPPORTED_TOKEN_PRECISION');
      const settledUnits = requestedSettled.units < reserved.units ? requestedSettled.units : reserved.units;
      const releasedUnits = reserved.units - settledUnits;
      const boundedSettled = Number(settledUnits) / 100;
      const releasedAmount = Number(releasedUnits) / 100;
      const [record] = await trx('spend_reservations').where({ id }).update({
        status: boundedSettled > 0 ? 'settled' : 'released',
        delivered_kwh: deliveredKwh.toFixed(3),
        settled_amount: boundedSettled.toFixed(2),
        released_amount: releasedAmount.toFixed(2),
        tx_hash: normalizedHash || current.tx_hash || null,
        settled_at: trx.fn.now(),
        updated_at: trx.fn.now(),
      }).returning('*');
      return record;
    });
  },

  async retry(id: string, error: string): Promise<void> {
    const db = getDatabase();
    await db.transaction(async trx => {
      const current = await trx('spend_reservations').where({ id }).forUpdate().first() as SpendReservationRecord | undefined;
      if (!current || current.status === 'settled' || current.status === 'released') return;
      // A failed settlement may already have submitted a token transfer.  A
      // reservation must remain claimed until an operator/recovery request
      // can inspect the durable token operation; resetting it to `reserved`
      // would permit a second transfer on replay.
      await trx('spend_reservations').where({ id }).whereNotIn('status', ['settled', 'released']).update({
        status: 'settling', error_message: error, updated_at: trx.fn.now(),
      });
    });
  },
};

/**
 * Append-only audit log operations.
 */
export const AuditLogs = {
  async create(data: {
    eventType: string;
    actorType: string;
    actorId?: string | null;
    targetType?: string | null;
    targetId?: string | null;
    status: string;
    metadata?: Record<string, unknown>;
  }): Promise<AuditLogRecord | undefined> {
    const db = getDatabase();
    const [record] = await db('audit_logs')
      .insert({
        event_type: data.eventType,
        actor_type: data.actorType,
        actor_id: data.actorId || null,
        target_type: data.targetType || null,
        target_id: data.targetId || null,
        status: data.status,
        metadata: data.metadata || {},
      })
      .returning('*');
    return record;
  },

  async findByTarget(targetType: string, targetId: string): Promise<AuditLogRecord[]> {
    const db = getDatabase();
    return db('audit_logs')
      .where({ target_type: targetType, target_id: targetId })
      .orderBy('created_at', 'desc');
  },

  async getRecent(limit = 100, filters?: {
    status?: string;
    eventType?: string;
  }): Promise<AuditLogRecord[]> {
    const db = getDatabase();
    let query = db('audit_logs').orderBy('created_at', 'desc').limit(limit);
    if (filters?.status) {
      query = query.where({ status: filters.status });
    }
    if (filters?.eventType) {
      query = query.where({ event_type: filters.eventType });
    }
    return query;
  },

  async getSince(since: Date, limit = 5000, filters?: {
    status?: string;
    eventType?: string;
  }): Promise<AuditLogRecord[]> {
    const db = getDatabase();
    let query = db('audit_logs')
      .where('created_at', '>=', since)
      .orderBy('created_at', 'desc')
      .limit(limit);
    if (filters?.status) {
      query = query.where({ status: filters.status });
    }
    if (filters?.eventType) {
      query = query.where({ event_type: filters.eventType });
    }
    return query;
  },
};

/**
 * Reconciliation report operations.
 */
export const ReconciliationReports = {
  async create(data: {
    status: string;
    checkedCount: number;
    matchedCount: number;
    mismatchCount: number;
    items: Record<string, unknown>[];
    metadata?: Record<string, unknown>;
  }): Promise<ReconciliationReportRecord> {
    const db = getDatabase();
    const [record] = await db('reconciliation_reports')
      .insert({
        status: data.status,
        checked_count: data.checkedCount,
        matched_count: data.matchedCount,
        mismatch_count: data.mismatchCount,
        // node-postgres treats a JavaScript array as a PostgreSQL array. The
        // column is JSON, so explicitly serialise the reconciliation items to
        // preserve the report shape on real PostgreSQL connections.
        items: JSON.stringify(data.items),
        metadata: data.metadata || {},
      })
      .returning('*');
    return record;
  },

  async latest(): Promise<ReconciliationReportRecord | undefined> {
    const db = getDatabase();
    return db('reconciliation_reports').orderBy('created_at', 'desc').first();
  },

  async getRecent(limit = 20): Promise<ReconciliationReportRecord[]> {
    const db = getDatabase();
    return db('reconciliation_reports')
      .orderBy('created_at', 'desc')
      .limit(limit);
  },
};
