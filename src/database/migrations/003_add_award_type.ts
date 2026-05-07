import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Add award type tracking to awards table
  await knex.schema.alterTable('awards', (table) => {
    table.string('award_type', 50).nullable(); // 'OFF_PEAK_CHARGING' or 'V2G_DISCHARGE'
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('awards', (table) => {
    table.dropColumn('award_type');
  });
}
