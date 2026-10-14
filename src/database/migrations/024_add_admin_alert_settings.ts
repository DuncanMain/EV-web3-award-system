import type { Knex } from 'knex';
import {
  ADMIN_ALERT_SETTINGS_ROW_ID,
  ADMIN_ALERT_SETTINGS_TABLE,
  getDefaultAdminAlertChannel,
  getDefaultAdminAlertRecipient,
} from '../../adminAlerts';

/**
 * Persist the owner-controlled alert destination separately from provider
 * credentials. This follows the existing active-wallet 022 and
 * transaction-reliability 023 migrations in the release line.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(ADMIN_ALERT_SETTINGS_TABLE))) {
    await knex.schema.createTable(ADMIN_ALERT_SETTINGS_TABLE, table => {
      table.integer('id').primary();
      table.string('recipient_email', 320).notNullable();
      table.string('channel', 20).notNullable().defaultTo(getDefaultAdminAlertChannel());
      table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    });
  }

  await knex(ADMIN_ALERT_SETTINGS_TABLE)
    .insert({
      id: ADMIN_ALERT_SETTINGS_ROW_ID,
      recipient_email: getDefaultAdminAlertRecipient(),
      channel: getDefaultAdminAlertChannel(),
    })
    .onConflict('id')
    .ignore();
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(ADMIN_ALERT_SETTINGS_TABLE);
}
