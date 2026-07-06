import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable('spend_receipts');
  if (hasTable) return;

  await knex.schema.createTable('spend_receipts', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('receipt_id', 40).notNullable().unique().index();
    table.string('uid').notNullable().index();
    table.string('wallet_address', 42).notNullable().index();
    table.decimal('amount', 20, 2).notNullable();
    table.string('session_id').nullable().index();
    table.string('provider_id').nullable().index();
    table.string('status', 20).notNullable().index();
    table.string('token_tx_hash', 66).notNullable().unique().index();
    table.string('token_contract_address', 42).notNullable();
    table.integer('chain_id').notNullable();
    table.string('signer_address', 42).notNullable();
    table.text('canonical_payload').notNullable();
    table.text('signature').notNullable();
    table.timestamp('issued_at').notNullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('spend_receipts');
}
