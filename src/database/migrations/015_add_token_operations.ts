import type { Knex } from 'knex';
import {
  APPROVAL_PREPARATIONS_TABLE,
  ensureTokenOperationTables,
  TOKEN_OPERATIONS_TABLE,
} from '../tokenOperationSchema';

/**
 * Create the durable token movement ledger.  Existing transaction hashes are
 * checked before the unique constraints are introduced.  A duplicate hash
 * cannot be safely assigned to an operation automatically, so migrations
 * stop with the offending hashes for operator review instead of choosing a
 * row and hiding a possible double movement.
 */
export async function up(knex: Knex): Promise<void> {
  const duplicateAwards = await knex('awards')
    .select(knex.raw('lower(tx_hash) as tx_hash'))
    .count({ count: '*' })
    .whereNotNull('tx_hash')
    .groupByRaw('lower(tx_hash)')
    .havingRaw('count(*) > 1') as Array<{ tx_hash: string; count: string }>;
  const duplicateSpends = await knex('spends')
    .select(knex.raw('lower(tx_hash) as tx_hash'))
    .count({ count: '*' })
    .whereNotNull('tx_hash')
    .groupByRaw('lower(tx_hash)')
    .havingRaw('count(*) > 1') as Array<{ tx_hash: string; count: string }>;
  const duplicateReceipts = await knex('spend_receipts')
    .select(knex.raw('lower(token_tx_hash) as tx_hash'))
    .count({ count: '*' })
    .whereNotNull('token_tx_hash')
    .groupByRaw('lower(token_tx_hash)')
    .havingRaw('count(*) > 1') as Array<{ tx_hash: string; count: string }>;

  const duplicateOperations = await (await knex.schema.hasTable(TOKEN_OPERATIONS_TABLE)
    ? knex(TOKEN_OPERATIONS_TABLE)
      .select(knex.raw('lower(tx_hash) as tx_hash'))
      .count({ count: '*' })
      .whereNotNull('tx_hash')
      .groupByRaw('lower(tx_hash)')
      .havingRaw('count(*) > 1')
    : Promise.resolve([])) as Array<{ tx_hash: string; count: string }>;

  if (duplicateAwards.length || duplicateSpends.length || duplicateReceipts.length || duplicateOperations.length) {
    const awards = duplicateAwards.map(row => `award:${row.tx_hash} (${row.count})`);
    const spends = duplicateSpends.map(row => `spend:${row.tx_hash} (${row.count})`);
    const receipts = duplicateReceipts.map(row => `receipt:${row.tx_hash} (${row.count})`);
    const operations = duplicateOperations.map(row => `operation:${row.tx_hash} (${row.count})`);
    throw new Error(
      `Migration 015 stopped: historical duplicate transaction hashes require manual review: ${[...awards, ...spends, ...receipts, ...operations].join(', ')}`
    );
  }

  // Keep projections themselves idempotent when a recovery request races a
  // first projection.  PostgreSQL permits multiple NULL values, which is
  // required for historical in-flight rows.
  await knex.raw('drop index if exists awards_tx_hash_unique');
  await knex.raw('drop index if exists spends_tx_hash_unique');
  await knex.raw('alter table spend_receipts drop constraint if exists spend_receipts_token_tx_hash_unique');
  await knex.raw('drop index if exists spend_receipts_token_tx_hash_unique');
  await knex.raw('create unique index if not exists awards_tx_hash_lower_unique on awards (lower(tx_hash)) where tx_hash is not null');
  await knex.raw('create unique index if not exists spends_tx_hash_lower_unique on spends (lower(tx_hash)) where tx_hash is not null');
  await knex.raw('create unique index if not exists spend_receipts_token_tx_hash_lower_unique on spend_receipts (lower(token_tx_hash)) where token_tx_hash is not null');

  if (await knex.schema.hasTable(TOKEN_OPERATIONS_TABLE)) {
    // Make a partially applied local migration repairable without replacing
    // the operation rows that may already contain recovery state.
    // Older local runs created a case-sensitive unique constraint. Replace it
    // with a lower-case expression index so 0xABC and 0xabc cannot project a
    // second movement. Duplicate detection above deliberately stops first.
    await knex.raw('alter table token_operations drop constraint if exists token_operations_tx_hash_unique');
    await knex.raw('drop index if exists token_operations_tx_hash_unique');
    await ensureTokenOperationTables(knex);
    return;
  }
  await ensureTokenOperationTables(knex);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(TOKEN_OPERATIONS_TABLE);
  await knex.schema.dropTableIfExists(APPROVAL_PREPARATIONS_TABLE);
  await knex.raw('drop index if exists awards_tx_hash_lower_unique');
  await knex.raw('drop index if exists spends_tx_hash_lower_unique');
  await knex.raw('drop index if exists spend_receipts_token_tx_hash_lower_unique');
  await knex.raw('drop index if exists token_operations_tx_hash_lower_unique');
}
