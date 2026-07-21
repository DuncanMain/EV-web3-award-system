import type { Knex } from 'knex';

const TABLE_NAME = 'spend_reservations';

export async function up(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable(TABLE_NAME)) return;

  await knex.schema.createTable(TABLE_NAME, (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('uid').notNullable().index();
    table.string('wallet_address', 42).notNullable().index();
    table.string('session_id').notNullable();
    table.string('provider_id').notNullable();
    table.decimal('reserved_amount', 20, 2).notNullable();
    table.decimal('settled_amount', 20, 2).nullable();
    table.decimal('released_amount', 20, 2).nullable();
    table.decimal('delivered_kwh', 20, 3).nullable();
    table.string('status', 20).notNullable().defaultTo('reserved').index();
    table.string('tx_hash', 66).nullable();
    table.text('error_message').nullable();
    table.timestamp('reserved_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('settled_at').nullable();
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    table.unique(['uid', 'session_id', 'provider_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(TABLE_NAME);
}
