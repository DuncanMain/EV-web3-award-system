import type { Knex } from 'knex';

async function addColumnIfMissing(
  knex: Knex,
  tableName: string,
  columnName: string,
  addColumn: (table: Knex.AlterTableBuilder) => void
): Promise<void> {
  const hasColumn = await knex.schema.hasColumn(tableName, columnName);
  if (hasColumn) return;

  await knex.schema.alterTable(tableName, addColumn);
}

export async function up(knex: Knex): Promise<void> {
  const hasAwards = await knex.schema.hasTable('awards');
  if (hasAwards) {
    await addColumnIfMissing(knex, 'awards', 'status', (table) => {
      table.string('status', 30).notNullable().defaultTo('confirmed').index();
    });
    await addColumnIfMissing(knex, 'awards', 'error_message', (table) => {
      table.text('error_message').nullable();
    });
    await addColumnIfMissing(knex, 'awards', 'confirmed_at', (table) => {
      table.timestamp('confirmed_at').nullable();
    });
    await knex('awards')
      .whereNull('confirmed_at')
      .update({ confirmed_at: knex.ref('awarded_at') });
  }

  const hasSpends = await knex.schema.hasTable('spends');
  if (hasSpends) {
    await addColumnIfMissing(knex, 'spends', 'status', (table) => {
      table.string('status', 30).notNullable().defaultTo('confirmed').index();
    });
    await addColumnIfMissing(knex, 'spends', 'error_message', (table) => {
      table.text('error_message').nullable();
    });
    await addColumnIfMissing(knex, 'spends', 'confirmed_at', (table) => {
      table.timestamp('confirmed_at').nullable();
    });
    await knex('spends')
      .whereNull('confirmed_at')
      .update({ confirmed_at: knex.ref('created_at') });
  }
}

export async function down(knex: Knex): Promise<void> {
  const hasAwards = await knex.schema.hasTable('awards');
  if (hasAwards) {
    await knex.schema.alterTable('awards', (table) => {
      table.dropColumn('confirmed_at');
      table.dropColumn('error_message');
      table.dropColumn('status');
    });
  }

  const hasSpends = await knex.schema.hasTable('spends');
  if (hasSpends) {
    await knex.schema.alterTable('spends', (table) => {
      table.dropColumn('confirmed_at');
      table.dropColumn('error_message');
      table.dropColumn('status');
    });
  }
}
