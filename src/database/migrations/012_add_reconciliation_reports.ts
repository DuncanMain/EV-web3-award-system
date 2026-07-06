import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable('reconciliation_reports');
  if (hasTable) return;

  await knex.schema.createTable('reconciliation_reports', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('status', 30).notNullable().index();
    table.integer('checked_count').notNullable().defaultTo(0);
    table.integer('matched_count').notNullable().defaultTo(0);
    table.integer('mismatch_count').notNullable().defaultTo(0);
    table.jsonb('items').notNullable().defaultTo('[]');
    table.jsonb('metadata').notNullable().defaultTo('{}');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('reconciliation_reports');
}
