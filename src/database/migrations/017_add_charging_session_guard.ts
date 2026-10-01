import type { Knex } from 'knex';
import { ensureChargingSessionGuard } from '../tokenOperationSchema';

/**
 * Add the provider/physical-charging-session claim guard. The column is
 * nullable by design: historical token-operation rows are not backfilled or
 * rewritten, and payloads without an explicit OCPI `session_id` retain the
 * existing CDR-key idempotency coverage.
 */
export async function up(knex: Knex): Promise<void> {
  await ensureChargingSessionGuard(knex);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('drop index if exists token_operations_award_provider_charging_session_unique');
  if (await knex.schema.hasColumn('token_operations', 'charging_session_id')) {
    await knex.schema.alterTable('token_operations', table => {
      table.dropColumn('charging_session_id');
    });
  }
}
