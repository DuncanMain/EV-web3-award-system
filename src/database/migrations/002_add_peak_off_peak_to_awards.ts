import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  // Add peak/off-peak tracking to awards table
  await knex.schema.alterTable('awards', (table) => {
    table.boolean('is_off_peak').defaultTo(false); // Whether charging occurred during off-peak hours
    table.string('country_code', 2).nullable(); // Country code derived from EVSEID (e.g., 'DE', 'US', 'GB', 'FR')
    table.string('local_time', 5).nullable(); // Local time in HH:MM format (e.g., '22:30')
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('awards', (table) => {
    table.dropColumn('is_off_peak');
    table.dropColumn('country_code');
    table.dropColumn('local_time');
  });
}
