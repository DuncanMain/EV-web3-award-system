import type { Knex } from 'knex';

const GLOBAL_UID_CONSTRAINT = 'users_uid_unique';
const LEGACY_UID_WALLET_INDEX = 'users_wallet_address_uid_unique';
const UID_WALLET_INDEX = 'users_uid_wallet_lower_unique';

async function migrateInTransaction(knex: Knex.Transaction): Promise<void> {
  const hasUsers = await knex.schema.hasTable('users');
  if (!hasUsers) return;

  // Serialize the validation/backfill boundary with wallet links and mode
  // switches.  ACCESS EXCLUSIVE also blocks concurrent DDL while this
  // transaction decides which uniqueness rules to install.
  await knex.raw('lock table users in access exclusive mode');

  // Validate all historical rows before dropping a constraint or index.  A
  // valid UID may have multiple wallets, but the same UID/wallet pair must
  // remain unique (case-insensitively).
  const duplicates = await knex('users')
    .select('uid')
    .select(knex.raw('lower(wallet_address) as wallet_address'))
    .count({ count: '*' })
    .groupBy('uid')
    .groupByRaw('lower(wallet_address)')
    .havingRaw('count(*) > 1') as Array<{ uid: string; wallet_address: string; count: string }>;

  if (duplicates.length) {
    const duplicatePairs = duplicates.map(row => `${row.uid}:${row.wallet_address}`).join(', ');
    throw new Error(`Cannot enforce EMP contract plus wallet uniqueness. Duplicates exist: ${duplicatePairs}`);
  }

  // Migration 005 was superseded by this scoped rule.  Remove both forms it
  // may have left behind: the named table constraint and its legacy index.
  await knex.raw(`alter table users drop constraint if exists ${GLOBAL_UID_CONSTRAINT}`);
  await knex.raw(`drop index if exists ${GLOBAL_UID_CONSTRAINT}`);
  await knex.raw(`drop index if exists ${LEGACY_UID_WALLET_INDEX}`);
  await knex.raw(`create unique index if not exists ${UID_WALLET_INDEX} on users (uid, lower(wallet_address))`);
}

/**
 * Make the UID/wallet uniqueness rule the canonical, restart-safe migration.
 * The transaction covers duplicate validation and every destructive/additive
 * DDL statement so a failed validation leaves the prior schema untouched.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.transaction(async trx => migrateInTransaction(trx));
}

export async function down(knex: Knex): Promise<void> {
  await knex.transaction(async trx => {
    const duplicates = await trx('users')
      .select('uid')
      .count({ count: '*' })
      .groupBy('uid')
      .havingRaw('count(*) > 1') as Array<{ uid: string; count: string }>;

    if (duplicates.length) {
      const duplicateIds = duplicates.map(row => row.uid).join(', ');
      throw new Error(`Cannot restore global EMP contract ID uniqueness. Duplicate contract IDs exist: ${duplicateIds}`);
    }

    await trx.raw(`drop index if exists ${UID_WALLET_INDEX}`);
    const hasGlobalUidConstraint = await trx('pg_constraint')
      .where({ conname: GLOBAL_UID_CONSTRAINT })
      .first();

    if (!hasGlobalUidConstraint) {
      await trx.schema.alterTable('users', (table) => {
        table.unique(['uid'], GLOBAL_UID_CONSTRAINT);
      });
    }
  });
}
