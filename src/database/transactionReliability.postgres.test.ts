import 'dotenv/config';

import crypto from 'crypto';
import { ethers } from 'ethers';
import knex, { Knex } from 'knex';
import {
  ApprovalPreparations,
  SpendReservations,
  TokenOperations,
  TreasuryTransactions,
} from './service';
import { closeDatabase } from './connection';
import {
  ensureSettlementContextColumn,
  ensureTokenOperationTables,
  ensureTreasuryTransactionTables,
} from './tokenOperationSchema';
import { up as runReliabilityMigration, down as rollbackReliabilityMigration } from './migrations/023_add_transaction_reliability';
import type { PreparedTransactionContext, TransactionDiagnostic } from '../types';
import { prepareAndBroadcastTransaction } from '../transactionReliability';

function requireDisposableDatabaseUrl(): string {
  const value = process.env.TRANSACTION_RELIABILITY_DATABASE_URL;
  if (!value) throw new Error('RUN_LOCAL_TRANSACTION_RELIABILITY_TESTS requires TRANSACTION_RELIABILITY_DATABASE_URL');
  const target = new URL(value);
  const databaseName = decodeURIComponent(target.pathname.replace(/^\//, ''));
  if (target.protocol !== 'postgres:'
    || !['localhost', '127.0.0.1'].includes(target.hostname)
    || !target.port
    || !/^nvf_award_(?:check|test)_[a-z0-9_-]+$/i.test(databaseName)) {
    throw new Error('TRANSACTION_RELIABILITY_DATABASE_URL must target a loopback disposable nvf_award_check_* or nvf_award_test_* database');
  }
  return value;
}

const describeIfEnabled = process.env.RUN_LOCAL_TRANSACTION_RELIABILITY_TESTS === '1' ? describe : describe.skip;

describeIfEnabled('transaction reliability (local PostgreSQL)', () => {
  jest.setTimeout(60_000);

  let database: Knex;
  const chainId = '80002';
  const signerAddress = '0x9999999999999999999999999999999999999999';
  const destination = '0x2222222222222222222222222222222222222222';
  const walletAddress = '0x1111111111111111111111111111111111111111';
  const createdKeys: string[] = [];
  const createdApprovalKeys: string[] = [];
  const createdReservationIds: string[] = [];
  let hashCounter = 1;

  function hashFor(key: string): string {
    return `0x${crypto.createHash('sha256').update(`${key}:${hashCounter++}`).digest('hex')}`;
  }

  function contextFor(nonce: number, key: string, overrides: Partial<PreparedTransactionContext> = {}): PreparedTransactionContext {
    return {
      chainId,
      signerAddress,
      nonce,
      to: destination,
      data: '0x1234',
      value: '0',
      gasLimit: '21000',
      gasPrice: '1000000000',
      type: 2,
      accessList: [],
      ...overrides,
    };
  }

  async function insertOperation(operationKey: string, amount = '1.00'): Promise<void> {
    createdKeys.push(operationKey);
    await database('token_operations').insert({
      operation_key: operationKey,
      operation_type: 'spend',
      request_fingerprint: `fingerprint-${operationKey}`,
      uid: `uid-${operationKey}`,
      wallet_address: walletAddress,
      amount,
      status: 'submitting',
      movement_outcome: 'unknown',
      tx_hash: null,
      tx_nonce: null,
      tx_context: null,
      diagnostic_context: null,
    });
  }

  async function prepareOperation(
    operationKey: string,
    getPendingNonce: () => Promise<number>,
    options: {
      targetType?: 'token_operation' | 'standalone';
      targetOperationKey?: string;
      to?: string;
      data?: string;
      value?: string;
      prepare?: (nonce: number) => Promise<{ txHash: string; rawTransaction: string; context: PreparedTransactionContext }>;
    } = {},
  ) {
    const targetType = options.targetType || 'token_operation';
    const to = options.to || destination;
    const data = options.data || '0x1234';
    const value = options.value || '0';
    return TreasuryTransactions.prepare({
      operationKey,
      targetOperationKey: options.targetOperationKey || operationKey,
      targetType,
      chainId,
      signerAddress,
      to,
      data,
      value,
      accessList: [],
      getPendingNonce,
      prepare: options.prepare || (async nonce => ({
        txHash: hashFor(operationKey),
        rawTransaction: '0x1234',
        context: contextFor(nonce, operationKey, { to, data, value }),
      })),
    });
  }

  beforeAll(async () => {
    const databaseUrl = requireDisposableDatabaseUrl();
    process.env.DATABASE_URL = databaseUrl;
    database = knex({ client: 'pg', connection: { connectionString: databaseUrl }, pool: { min: 1, max: 10 } });
    await ensureTokenOperationTables(database);
    await ensureTreasuryTransactionTables(database);
    await ensureSettlementContextColumn(database);
    if (!(await database.schema.hasTable('spend_reservations'))) {
      throw new Error('disposable migration did not create spend_reservations');
    }
  });

  afterEach(async () => {
    if (!database) return;
    await database('treasury_transaction_leases').whereIn('operation_key', createdKeys).delete();
    await database('token_operations').whereIn('operation_key', createdKeys).delete();
    await database('approval_preparations').whereIn('operation_key', createdApprovalKeys).delete();
    if (createdReservationIds.length > 0) {
      await database('spend_reservations').whereIn('id', createdReservationIds).delete();
      createdReservationIds.splice(0, createdReservationIds.length);
    }
    createdKeys.splice(0, createdKeys.length);
    createdApprovalKeys.splice(0, createdApprovalKeys.length);
  });

  afterAll(async () => {
    await closeDatabase();
    await database?.destroy();
  });

  it('keeps active concurrent submissions retryable while blocking an abandoned nonce gap', async () => {
    const firstKey = `pg-concurrent-a-${crypto.randomUUID()}`;
    const secondKey = `pg-concurrent-b-${crypto.randomUUID()}`;
    await insertOperation(firstKey);
    await insertOperation(secondKey);

    let releaseFirstBroadcast!: () => void;
    const firstBroadcastDelay = new Promise<void>(resolve => { releaseFirstBroadcast = resolve; });
    let firstBroadcastStarted!: () => void;
    const firstBroadcastStartedSignal = new Promise<void>(resolve => { firstBroadcastStarted = resolve; });
    let broadcastCount = 0;
    const provider = {
      getTransactionCount: jest.fn().mockResolvedValue(10),
      getFeeData: jest.fn().mockResolvedValue({
        maxFeePerGas: 1_000_000_000n,
        maxPriorityFeePerGas: 100_000_000n,
        gasPrice: null,
      }),
      estimateGas: jest.fn().mockResolvedValue(21_000n),
      broadcastTransaction: jest.fn(async (raw: string) => {
        broadcastCount += 1;
        if (broadcastCount === 1) {
          firstBroadcastStarted();
          await firstBroadcastDelay;
        }
        return { hash: ethers.keccak256(raw) };
      }),
    } as unknown as ethers.Provider;
    const signer = {
      provider,
      getAddress: jest.fn().mockResolvedValue(signerAddress),
      signTransaction: jest.fn(async (request: { nonce?: number }) => request.nonce === 10 ? '0x1234' : '0xabcd'),
    } as unknown as ethers.Signer;
    const requestFor = (operationKey: string) => ({
      operationKey,
      targetOperationKey: operationKey,
      targetType: 'token_operation' as const,
      signer,
      chainId,
      to: destination,
      data: '0x1234',
      value: 0n,
    });

    const firstSubmission = prepareAndBroadcastTransaction(requestFor(firstKey));
    await firstBroadcastStartedSignal;
    const secondSubmission = prepareAndBroadcastTransaction(requestFor(secondKey));
    await expect(secondSubmission).rejects.toMatchObject({
      diagnostic: {
        errorCode: 'TREASURY_NONCE_BUSY_RETRYABLE',
        retryable: true,
        stage: 'prepare',
      },
    });
    releaseFirstBroadcast();
    const firstResult = await firstSubmission;
    expect(firstResult.context.nonce).toBe(10);
    expect(broadcastCount).toBe(1);

    const secondResult = await prepareAndBroadcastTransaction(requestFor(secondKey));
    expect(secondResult.context.nonce).toBe(11);
    expect(broadcastCount).toBe(2);

    const gapKey = `pg-gap-${crypto.randomUUID()}`;
    await insertOperation(gapKey);
    const abandonedKey = `pg-abandoned-${crypto.randomUUID()}`;
    await insertOperation(abandonedKey);
    const abandoned = await prepareOperation(abandonedKey, async () => 12);
    await database('treasury_transaction_leases').where({ operation_key: abandonedKey }).update({
      created_at: new Date(Date.now() - 60_000),
      updated_at: new Date(Date.now() - 60_000),
    });
    const gapResult = await prepareOperation(gapKey, async () => 12).catch(error => error as Error);
    expect(gapResult).toBeInstanceOf(Error);
    const gapMessage = gapResult instanceof Error ? gapResult.message : '';
    expect(gapMessage).toContain('TREASURY_NONCE_GAP_REQUIRES_REVIEW');
    const current = await database('token_operations').where({ operation_key: gapKey }).first();
    expect(current.tx_hash).toBeNull();
    expect(gapMessage).not.toContain(firstResult.txHash);
    expect(Number(abandoned.lease.nonce)).toBe(12);
  });

  it('rolls back a signer preparation failure without leaving a nonce lease', async () => {
    const failedKey = `pg-prepare-failure-${crypto.randomUUID()}`;
    await insertOperation(failedKey);
    await expect(prepareOperation(failedKey, async () => 20, {
      prepare: async () => { throw new Error('SIGN_TRANSACTION_FAILED'); },
    })).rejects.toThrow('SIGN_TRANSACTION_FAILED');
    expect(await database('treasury_transaction_leases').where({ operation_key: failedKey })).toHaveLength(0);
    expect((await database('token_operations').where({ operation_key: failedKey }).first()).tx_hash).toBeNull();

    const retryKey = `pg-prepare-retry-${crypto.randomUUID()}`;
    await insertOperation(retryKey);
    const retry = await prepareOperation(retryKey, async () => 20);
    expect(Number(retry.lease.nonce)).toBe(20);
  });

  it('binds a reusable standalone lease to full intent and permits a distinct action key', async () => {
    const retryKey = `standalone-retry-${crypto.randomUUID()}`;
    const nextActionKey = `standalone-next-${crypto.randomUUID()}`;
    createdKeys.push(retryKey, nextActionKey);
    const first = await prepareOperation(retryKey, async () => 21, { targetType: 'standalone' });
    const sameIntent = await prepareOperation(retryKey, async () => 99, { targetType: 'standalone' });
    expect(sameIntent.alreadyPrepared).toBe(true);
    expect(sameIntent.lease.tx_hash).toBe(first.lease.tx_hash);

    await expect(prepareOperation(retryKey, async () => 99, {
      targetType: 'standalone',
      data: '0xabcd',
    })).rejects.toThrow('TREASURY_TRANSACTION_INTENT_MISMATCH');

    const next = await prepareOperation(nextActionKey, async () => 22, {
      targetType: 'standalone',
      data: '0xabcd',
    });
    expect(next.alreadyPrepared).toBe(false);
    expect(Number(next.lease.nonce)).toBe(22);
    expect(next.lease.tx_hash).not.toBe(first.lease.tx_hash);
  });

  it('journals approval top-up attempts separately from prior confirmed funding', async () => {
    const approvalKey = `pg-approval-topup-${crypto.randomUUID()}`;
    const priorFundingKey = `${approvalKey}:funding:prior`;
    const topUpKey = `${approvalKey}:funding:150`;
    const priorHash = hashFor(priorFundingKey);
    const topUpHash = hashFor(topUpKey);
    createdApprovalKeys.push(approvalKey);
    await database('approval_preparations').insert({
      operation_key: approvalKey,
      wallet_address: walletAddress,
      token_contract_address: destination,
      chain_id: chainId,
      treasury_address: signerAddress,
      status: 'funded',
      funding_tx_hash: priorHash,
      funding_tx_nonce: 50,
      funding_tx_context: contextFor(50, priorFundingKey, { to: walletAddress, value: '100' }),
      funding_attempt_key: null,
      funding_attempt_value: null,
      approval_tx_hash: null,
      diagnostic_context: null,
    });
    await database('treasury_transaction_leases').insert({
      operation_key: priorFundingKey,
      target_operation_key: approvalKey,
      target_type: 'approval_funding',
      chain_id: chainId,
      signer_address: signerAddress,
      nonce: 50,
      tx_hash: priorHash,
      tx_context: contextFor(50, priorFundingKey, { to: walletAddress, value: '100' }),
      status: 'confirmed',
      diagnostic_context: null,
      error_message: null,
    });
    createdKeys.push(priorFundingKey, topUpKey);

    const claim = await ApprovalPreparations.claimFundingTopUp(approvalKey, topUpKey, '150');
    expect(claim.acquired).toBe(true);
    expect(claim.record.funding_tx_hash).toBe(priorHash);
    expect(claim.record.funding_attempt_key).toBe(topUpKey);
    expect(claim.record.funding_attempt_value).toBe('150');

    const request = {
      operationKey: topUpKey,
      targetOperationKey: approvalKey,
      targetType: 'approval_funding' as const,
      chainId,
      signerAddress,
      to: walletAddress,
      data: '0x',
      value: '150',
      accessList: [],
      getPendingNonce: async () => 51,
      prepare: async (nonce: number) => ({
        txHash: topUpHash,
        rawTransaction: '0x5678',
        context: contextFor(nonce, topUpKey, { to: walletAddress, data: '0x', value: '150' }),
      }),
    };
    const prepared = await TreasuryTransactions.prepare(request);
    expect(prepared.alreadyPrepared).toBe(false);
    const row = await database('approval_preparations').where({ operation_key: approvalKey }).first();
    expect(row.funding_tx_hash).toBe(topUpHash);
    expect(row.funding_attempt_key).toBe(topUpKey);
    expect(row.funding_attempt_value).toBe('150');
    expect(await database('treasury_transaction_leases').where({ operation_key: priorFundingKey })).toHaveLength(1);

    const duplicate = await TreasuryTransactions.prepare(request);
    expect(duplicate.alreadyPrepared).toBe(true);
    expect(duplicate.lease.tx_hash).toBe(topUpHash);

    await ApprovalPreparations.markFunded(approvalKey);
    const staleFundingDiagnostic: TransactionDiagnostic = {
      stage: 'receipt',
      category: 'confirmation_pending',
      errorCode: 'RECEIPT_READ_UNAVAILABLE',
      retryable: true,
      savedHash: priorHash,
    };
    // Exercise the treasury callback path while the old lease is nonterminal;
    // a proven funded parent must remain funded even if that callback arrives.
    await database('treasury_transaction_leases')
      .where({ operation_key: priorFundingKey })
      .update({ status: 'unknown' });
    await TreasuryTransactions.markUnknown(priorFundingKey, staleFundingDiagnostic, 'stale treasury callback after funding');
    const protectedAfterTreasuryCallback = await database('approval_preparations').where({ operation_key: approvalKey }).first();
    expect(protectedAfterTreasuryCallback.status).toBe('funded');
    expect(protectedAfterTreasuryCallback.funding_tx_hash).toBe(topUpHash);
    expect(protectedAfterTreasuryCallback.funding_attempt_key).toBeNull();

    await ApprovalPreparations.markUnknown(
      approvalKey,
      'stale callback from the completed top-up',
      { fundingTxHash: topUpHash, fundingAttemptKey: topUpKey },
    );
    const protectedFundedRow = await database('approval_preparations').where({ operation_key: approvalKey }).first();
    expect(protectedFundedRow.status).toBe('funded');
    const nextTopUpKey = `${approvalKey}:funding:150:next`;
    const nextClaim = await ApprovalPreparations.claimFundingTopUp(approvalKey, nextTopUpKey, '150');
    expect(nextClaim.acquired).toBe(true);
    expect(nextClaim.record.funding_tx_hash).toBe(topUpHash);
    await TreasuryTransactions.markUnknown(priorFundingKey, staleFundingDiagnostic, 'stale treasury callback after newer top-up');
    await TreasuryTransactions.markFailed(priorFundingKey, staleFundingDiagnostic, 'stale treasury failure after newer top-up');
    await ApprovalPreparations.markUnknown(
      approvalKey,
      'stale callback from the prior top-up',
      { fundingTxHash: topUpHash, fundingAttemptKey: topUpKey },
    );
    const protectedNextAttempt = await database('approval_preparations').where({ operation_key: approvalKey }).first();
    expect(protectedNextAttempt.status).toBe('funding');
    expect(protectedNextAttempt.funding_attempt_key).toBe(nextTopUpKey);
    expect(protectedNextAttempt.funding_tx_hash).toBe(topUpHash);
  });

  it('fails closed for a legacy funded row without a prior treasury evidence lease', async () => {
    const approvalKey = `pg-legacy-topup-no-journal-${crypto.randomUUID()}`;
    const priorHash = hashFor(approvalKey);
    createdApprovalKeys.push(approvalKey);
    await database('approval_preparations').insert({
      operation_key: approvalKey,
      wallet_address: walletAddress,
      token_contract_address: destination,
      chain_id: chainId,
      treasury_address: signerAddress,
      status: 'funded',
      funding_tx_hash: priorHash,
      funding_tx_nonce: 51,
      funding_tx_context: contextFor(51, approvalKey, { to: walletAddress, value: '100' }),
      funding_attempt_key: null,
      funding_attempt_value: null,
      approval_tx_hash: null,
      diagnostic_context: null,
    });

    await expect(ApprovalPreparations.claimFundingTopUp(approvalKey, `${approvalKey}:topup`, '150'))
      .rejects.toThrow('APPROVAL_FUNDING_PRIOR_EVIDENCE_REQUIRED');
    const row = await database('approval_preparations').where({ operation_key: approvalKey }).first();
    expect(row.status).toBe('funded');
    expect(row.funding_tx_hash).toBe(priorHash);
    expect(row.funding_attempt_key).toBeNull();
  });

  it('keeps terminal token and lease states monotonic against stale callbacks', async () => {
    const key = `pg-terminal-race-${crypto.randomUUID()}`;
    await insertOperation(key);
    const prepared = await prepareOperation(key, async () => 30);
    await TokenOperations.markConfirmed(key);
    const staleDiagnostic: TransactionDiagnostic = {
      stage: 'receipt',
      category: 'confirmation_pending',
      errorCode: 'RECEIPT_READ_UNAVAILABLE',
      retryable: true,
      savedHash: prepared.lease.tx_hash,
    };
    await TokenOperations.markUnknown(key, 'stale receipt callback', staleDiagnostic);
    await TokenOperations.markSubmitted(key, prepared.lease.tx_hash);
    await TokenOperations.markFailed(key, 'stale failure callback', 'review', staleDiagnostic);
    let current = await TokenOperations.findByKey(key);
    expect(current?.status).toBe('confirmed');

    await TokenOperations.markProjected(key);
    await TokenOperations.markUnknown(key, 'older callback', staleDiagnostic);
    await TokenOperations.markSubmitted(key, prepared.lease.tx_hash);
    await TokenOperations.markFailed(key, 'older failure callback', 'review', staleDiagnostic);
    current = await TokenOperations.findByKey(key);
    expect(current?.status).toBe('projected');

    await database('treasury_transaction_leases').where({ operation_key: key }).update({ status: 'confirmed' });
    await TreasuryTransactions.markUnknown(key, staleDiagnostic, 'older lease callback');
    await TreasuryTransactions.markSubmitted(key, prepared.lease.tx_hash);
    const lease = await database('treasury_transaction_leases').where({ operation_key: key }).first();
    expect(lease.status).toBe('confirmed');
    current = await TokenOperations.findByKey(key);
    expect(current?.status).toBe('projected');
  });

  it('preserves immutable high-precision settlement context and rejects a mismatch', async () => {
    const id = crypto.randomUUID();
    createdReservationIds.push(id);
    await database('spend_reservations').insert({
      id,
      uid: `pg-settlement-${id}`,
      wallet_address: walletAddress,
      session_id: `session-${id}`,
      provider_id: `provider-${id}`,
      reserved_amount: '2.00',
      status: 'settling',
    });
    const first = await SpendReservations.persistSettlementContext(id, 1.9999);
    expect(first.delivered_kwh).toBe('1.999');
    expect(first.settlement_context).toEqual({
      deliveredKwh: '1.9999',
      normalizedThreeDecimal: '1.999',
      sourcePrecision: 4,
    });
    await expect(SpendReservations.persistSettlementContext(id, 1.9998))
      .rejects.toThrow('RESERVATION_SETTLEMENT_CONTEXT_MISMATCH');
    const unchanged = await database('spend_reservations').where({ id }).first();
    expect(unchanged.delivered_kwh).toBe('1.999');
    expect(unchanged.settlement_context.deliveredKwh).toBe('1.9999');
  });

  it('is idempotent when reapplied and blocks rollback while reliability evidence exists', async () => {
    const key = `pg-migration-evidence-${crypto.randomUUID()}`;
    await insertOperation(key);
    const prepared = await prepareOperation(key, async () => 40);
    await runReliabilityMigration(database);
    const leaseAfterReapply = await database('treasury_transaction_leases').where({ operation_key: key }).first();
    expect(leaseAfterReapply.tx_hash).toBe(prepared.lease.tx_hash);
    await expect(rollbackReliabilityMigration(database)).rejects.toThrow('TRANSACTION_RELIABILITY_ROLLBACK_BLOCKED');

    await database('treasury_transaction_leases').where({ operation_key: key }).delete();
    await database('token_operations').where({ operation_key: key }).update({ tx_nonce: null, tx_context: null, diagnostic_context: null });

    const id = crypto.randomUUID();
    createdReservationIds.push(id);
    await database('spend_reservations').insert({
      id,
      uid: `pg-rollback-${id}`,
      wallet_address: walletAddress,
      session_id: `session-${id}`,
      provider_id: `provider-${id}`,
      reserved_amount: '2.00',
      status: 'settling',
    });
    await SpendReservations.persistSettlementContext(id, 1.913);
    await expect(rollbackReliabilityMigration(database)).rejects.toThrow('TRANSACTION_RELIABILITY_ROLLBACK_BLOCKED');
    await database('spend_reservations').where({ id }).update({ settlement_context: null, delivered_kwh: null });
    await rollbackReliabilityMigration(database);
    expect(await database.schema.hasTable('treasury_transaction_leases')).toBe(false);
    await runReliabilityMigration(database);
    expect(await database.schema.hasTable('treasury_transaction_leases')).toBe(true);
  });
});
