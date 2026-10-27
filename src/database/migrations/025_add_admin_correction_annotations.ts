import type { Knex } from 'knex';

export const ADMIN_CORRECTION_ANNOTATIONS_TABLE = 'admin_correction_annotations';
export const ADMIN_CORRECTION_ANNOTATIONS_ACTOR_REQUEST_INDEX = 'admin_correction_annotations_actor_request_unique';
export const ADMIN_CORRECTION_ANNOTATIONS_SUBJECT_INDEX = 'admin_correction_annotations_subject_created_at_idx';

const SUBJECT_CHECK = 'admin_correction_annotations_subject_type_check';
const REFERENCE_CHECK = 'admin_correction_annotations_reference_type_check';
const ACTOR_CHECK = 'admin_correction_annotations_actor_type_check';
const PROVENANCE_CHECK = 'admin_correction_annotations_reference_provenance_check';

async function ensureCheckConstraint(
  knex: Knex,
  constraintName: string,
  expression: string,
): Promise<void> {
  const existing = await knex.raw(
    `select 1
       from pg_constraint
      where conname = ?
        and conrelid = to_regclass(?)::oid
      limit 1`,
    [constraintName, ADMIN_CORRECTION_ANNOTATIONS_TABLE],
  );
  if (existing.rows?.length) return;
  await knex.raw(
    `alter table "${ADMIN_CORRECTION_ANNOTATIONS_TABLE}" add constraint "${constraintName}" check (${expression})`,
  );
}

/**
 * Add only append-only correction metadata.  Subject rows remain in their
 * existing financial tables and are checked by the API at insert time; this
 * table deliberately has no polymorphic foreign key.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable(ADMIN_CORRECTION_ANNOTATIONS_TABLE))) {
    await knex.schema.createTable(ADMIN_CORRECTION_ANNOTATIONS_TABLE, table => {
      table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      table.uuid('client_request_id').notNullable();
      table.string('subject_type', 32).notNullable();
      table.uuid('subject_id').notNullable();
      table.string('reference_type', 16).notNullable();
      table.string('reference_value', 320).notNullable();
      table.text('reason').notNullable();
      table.string('actor_type', 32).notNullable().defaultTo('admin_session');
      table.string('actor_id', 160).notNullable();
      table.string('reference_provenance', 32).notNullable().defaultTo('unknown');
      table.string('reference_operation_key', 240).nullable();
      table.string('reference_chain_id', 80).nullable();
      table.string('reference_token_contract_address', 42).nullable();
      table.timestamp('created_at').notNullable().defaultTo(knex.fn.now());
    });
  } else {
    // A partially applied local migration can be completed without touching
    // or backfilling any financial table.
    const additions: Array<[string, (table: Knex.AlterTableBuilder) => void]> = [
      ['client_request_id', table => table.uuid('client_request_id').nullable()],
      ['subject_type', table => table.string('subject_type', 32).nullable()],
      ['subject_id', table => table.uuid('subject_id').nullable()],
      ['reference_type', table => table.string('reference_type', 16).nullable()],
      ['reference_value', table => table.string('reference_value', 320).nullable()],
      ['reason', table => table.text('reason').nullable()],
      ['actor_type', table => table.string('actor_type', 32).nullable()],
      ['actor_id', table => table.string('actor_id', 160).nullable()],
      ['reference_provenance', table => table.string('reference_provenance', 32).nullable()],
      ['reference_operation_key', table => table.string('reference_operation_key', 240).nullable()],
      ['reference_chain_id', table => table.string('reference_chain_id', 80).nullable()],
      ['reference_token_contract_address', table => table.string('reference_token_contract_address', 42).nullable()],
      ['created_at', table => table.timestamp('created_at').nullable()],
    ];
    for (const [name, add] of additions) {
      if (!(await knex.schema.hasColumn(ADMIN_CORRECTION_ANNOTATIONS_TABLE, name))) {
        await knex.schema.alterTable(ADMIN_CORRECTION_ANNOTATIONS_TABLE, add);
      }
    }
  }

  await ensureCheckConstraint(
    knex,
    SUBJECT_CHECK,
    `subject_type in ('token_operation', 'award', 'spend')`,
  );
  await ensureCheckConstraint(
    knex,
    REFERENCE_CHECK,
    `reference_type in ('transaction', 'case')`,
  );
  await ensureCheckConstraint(
    knex,
    ACTOR_CHECK,
    `actor_type = 'admin_session'`,
  );
  await ensureCheckConstraint(
    knex,
    PROVENANCE_CHECK,
    `reference_provenance in ('retained_operation', 'retained_award', 'retained_spend', 'external_case', 'unknown', 'conflict_unknown')`,
  );
  await knex.raw(
    `create unique index if not exists "${ADMIN_CORRECTION_ANNOTATIONS_ACTOR_REQUEST_INDEX}" `
      + `on "${ADMIN_CORRECTION_ANNOTATIONS_TABLE}" (actor_id, client_request_id)`,
  );
  await knex.raw(
    `create index if not exists "${ADMIN_CORRECTION_ANNOTATIONS_SUBJECT_INDEX}" `
      + `on "${ADMIN_CORRECTION_ANNOTATIONS_TABLE}" (subject_type, subject_id, created_at desc)`,
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists(ADMIN_CORRECTION_ANNOTATIONS_TABLE);
}
