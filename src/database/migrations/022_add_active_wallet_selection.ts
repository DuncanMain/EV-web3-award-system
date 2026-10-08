import type { Knex } from 'knex';

const ACTIVE_COLUMN = 'is_active';
const ACTIVE_INDEX = 'users_uid_active_unique';

async function migrateInTransaction(knex: Knex.Transaction): Promise<void> {
  const hasUsers = await knex.schema.hasTable('users');
  if (!hasUsers) return;

  // Take the table lock before reading or rewriting selection state.  A mode
  // switch uses the same users table and must wait until this backfill and its
  // unique-index DDL have committed.
  await knex.raw('lock table users in access exclusive mode');

  const hasActiveColumn = await knex.schema.hasColumn('users', ACTIVE_COLUMN);
  if (!hasActiveColumn) {
    await knex.raw('alter table users add column is_active boolean');
  }

  // Prefer an already explicit active row.  For legacy rows where the column
  // did not exist, choose the oldest row deterministically.  The id tie-break
  // keeps the result stable when timestamps collide.  On a rerun the one true
  // row remains selected, while any malformed multiple-true state is repaired
  // to its oldest explicit selection.
  await knex.raw(`
    with ranked as (
      select id,
             row_number() over (
               partition by uid
               order by case when is_active is true then 0 else 1 end,
                        created_at asc nulls first,
                        id asc
             ) as row_number
      from users
    )
    update users as target_user
    set is_active = (ranked.row_number = 1)
    from ranked
    where target_user.id = ranked.id
  `);

  await knex.raw('alter table users alter column is_active set default true');
  await knex.raw('alter table users alter column is_active set not null');
  await knex.raw(`
    create unique index if not exists ${ACTIVE_INDEX}
      on users (uid)
      where is_active = true
  `);
}

/**
 * Persist the selected wallet independently from historical wallet links.
 * The migration is transactional so a failed backfill or index build leaves
 * the users table in its prior state.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.transaction(async trx => migrateInTransaction(trx));
}

export async function down(knex: Knex): Promise<void> {
  await knex.transaction(async trx => {
    await trx.raw(`drop index if exists ${ACTIVE_INDEX}`);
    const hasActiveColumn = await trx.schema.hasColumn('users', ACTIVE_COLUMN);
    if (hasActiveColumn) {
      await trx.raw(`alter table users drop column ${ACTIVE_COLUMN}`);
    }
  });
}
