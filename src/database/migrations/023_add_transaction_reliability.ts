import type { Knex } from 'knex';
import {
  ensureTokenOperationTables,
  ensureSettlementContextColumn,
  ensureTreasuryTransactionTables,
} from '../tokenOperationSchema';

/**
 * Add durable prepared transaction context and the shared treasury nonce
 * lease table.  The helper is idempotent so a partially applied local
 * migration can be resumed without replacing operation rows.
 */
export async function up(knex: Knex): Promise<void> {
  await ensureTokenOperationTables(knex);
  await ensureTreasuryTransactionTables(knex);
  await ensureSettlementContextColumn(knex);
}

export async function down(knex: Knex): Promise<void> {
  // Reliability evidence is part of the financial history.  Refuse to remove
  // the migration once a prepared, submitted, failed, or otherwise recorded
  // context exists; an operator must reconcile/export that evidence before a
  // rollback can be considered.  Empty disposable schemas remain reversible.
  if (await knex.schema.hasTable('treasury_transaction_leases')) {
    const leaseCount = await knex('treasury_transaction_leases').count<{ count: string }>({ count: '*' }).first();
    if (Number(leaseCount?.count || 0) > 0) {
      throw new Error('TRANSACTION_RELIABILITY_ROLLBACK_BLOCKED: treasury transaction lease evidence exists');
    }
  }
  if (await knex.schema.hasTable('token_operations')) {
    const columns = ['tx_nonce', 'tx_context', 'diagnostic_context'];
    const available = [] as string[];
    for (const column of columns) {
      if (await knex.schema.hasColumn('token_operations', column)) available.push(column);
    }
    if (available.length > 0) {
      const evidence = await knex('token_operations')
        .where(query => available.forEach(column => query.orWhereNotNull(column)))
        .count<{ count: string }>({ count: '*' })
        .first();
      if (Number(evidence?.count || 0) > 0) {
        throw new Error('TRANSACTION_RELIABILITY_ROLLBACK_BLOCKED: token operation reliability evidence exists');
      }
    }
  }
  if (await knex.schema.hasTable('approval_preparations')) {
    const columns = [
      'funding_tx_nonce',
      'funding_tx_context',
      'funding_attempt_key',
      'funding_attempt_value',
      'diagnostic_context',
    ];
    const available = [] as string[];
    for (const column of columns) {
      if (await knex.schema.hasColumn('approval_preparations', column)) available.push(column);
    }
    if (available.length > 0) {
      const evidence = await knex('approval_preparations')
        .where(query => available.forEach(column => query.orWhereNotNull(column)))
        .count<{ count: string }>({ count: '*' })
        .first();
      if (Number(evidence?.count || 0) > 0) {
        throw new Error('TRANSACTION_RELIABILITY_ROLLBACK_BLOCKED: approval preparation reliability evidence exists');
      }
    }
  }
  if (await knex.schema.hasTable('spend_reservations')
    && await knex.schema.hasColumn('spend_reservations', 'settlement_context')) {
    const evidence = await knex('spend_reservations')
      .whereNotNull('settlement_context')
      .count<{ count: string }>({ count: '*' })
      .first();
    if (Number(evidence?.count || 0) > 0) {
      throw new Error('TRANSACTION_RELIABILITY_ROLLBACK_BLOCKED: settlement context evidence exists');
    }
  }
  await knex.schema.dropTableIfExists('treasury_transaction_leases');
  if (await knex.schema.hasTable('spend_reservations')
    && await knex.schema.hasColumn('spend_reservations', 'settlement_context')) {
    await knex.schema.alterTable('spend_reservations', table => table.dropColumn('settlement_context'));
  }
  for (const [table, columns] of [
    ['token_operations', ['tx_nonce', 'tx_context', 'diagnostic_context']],
    ['approval_preparations', [
      'funding_tx_nonce',
      'funding_tx_context',
      'funding_attempt_key',
      'funding_attempt_value',
      'diagnostic_context',
    ]],
  ] as const) {
    if (await knex.schema.hasTable(table)) {
      for (const column of columns) {
        if (await knex.schema.hasColumn(table, column)) {
          await knex.schema.alterTable(table, builder => builder.dropColumn(column));
        }
      }
    }
  }
}
