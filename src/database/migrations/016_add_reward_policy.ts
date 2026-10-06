import type { Knex } from 'knex';
import { getDefaultAwardRules, getDefaultOffPeakWindows } from '../../config/policyDefaults';

export const REWARD_POLICY_TABLE = 'reward_policy';
export const REWARD_POLICY_ROW_ID = 1;

/**
 * Persist the rules and country windows as one singleton policy document.
 * `onConflict().ignore()` makes the seed additive: an existing operator
 * policy is never replaced when the migration is run again.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(REWARD_POLICY_TABLE))) {
    await knex.schema.createTable(REWARD_POLICY_TABLE, table => {
      table.integer('id').primary();
      table.integer('revision').notNullable();
      table.jsonb('rules').notNullable();
      table.jsonb('off_peak_windows').notNullable();
      table.timestamp('updated_at').notNullable().defaultTo(knex.fn.now());
    });
  }

  await knex(REWARD_POLICY_TABLE)
    .insert({
      id: REWARD_POLICY_ROW_ID,
      revision: 1,
      rules: getDefaultAwardRules(1),
      off_peak_windows: getDefaultOffPeakWindows(),
    })
    .onConflict('id')
    .ignore();
}
export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(REWARD_POLICY_TABLE);
}
