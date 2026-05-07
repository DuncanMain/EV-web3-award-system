import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Users table: maps UID to Polygon wallet address
  await knex.schema.createTable('users', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('uid').notNullable().unique().index(); // User identifier
    table.string('wallet_address', 42).notNullable().index(); // Polygon address 0x...
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
  });

  // Awards table: track all issued tokens
  await knex.schema.createTable('awards', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.string('session_id').notNullable(); // From CDR
    table.string('provider_id').notNullable(); // From CDR
    table.string('dedup_key', 100).notNullable().unique().index(); // sessionId-providerId
    table.decimal('amount', 10, 2).notNullable(); // SPARKZ tokens awarded
    table.text('cdr_data').nullable(); // Normalized CDR JSON
    table.string('tx_hash', 66).notNullable().index(); // On-chain transaction hash 0x...
    table.timestamp('awarded_at').notNullable(); // When award was issued
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.unique(['session_id', 'provider_id']);
  });

  // Balances table: current balance per user
  await knex.schema.createTable('balances', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE').unique();
    table.string('wallet_address', 42).notNullable().index(); // Polygon address
    table.decimal('balance', 20, 2).notNullable().defaultTo(0); // Current SPARKZ balance (token units)
    table.decimal('total_awarded', 20, 2).notNullable().defaultTo(0); // Cumulative awarded
    table.decimal('total_spent', 20, 2).notNullable().defaultTo(0); // Cumulative spent
    table.timestamp('last_synced').notNullable().defaultTo(knex.fn.now());
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('spends', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.string('wallet_address', 42).notNullable().index();
    table.decimal('amount', 20, 2).notNullable();
    table.string('tx_hash', 66).notNullable().index();
    table.string('session_id').nullable();
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('balances');
  await knex.schema.dropTableIfExists('awards');
  await knex.schema.dropTableIfExists('users');
}
