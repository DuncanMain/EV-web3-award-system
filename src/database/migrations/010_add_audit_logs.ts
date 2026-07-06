import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  const hasTable = await knex.schema.hasTable('audit_logs');
  if (hasTable) return;

  await knex.schema.createTable('audit_logs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('event_type', 80).notNullable().index();
    table.string('actor_type', 40).notNullable().index();
    table.string('actor_id', 160).nullable().index();
    table.string('target_type', 60).nullable().index();
    table.string('target_id', 160).nullable().index();
    table.string('status', 30).notNullable().index();
    table.jsonb('metadata').notNullable().defaultTo('{}');
    table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('audit_logs');
}
