import { up, down } from './024_add_admin_alert_settings';

function fakeKnex(hasTable: boolean) {
  const createTable = jest.fn(async (_name: string, callback: (table: Record<string, jest.Mock>) => void) => {
    const table = {
      integer: jest.fn(() => ({ primary: jest.fn() })),
      string: jest.fn(() => ({ notNullable: jest.fn(() => ({ defaultTo: jest.fn() })) })),
      timestamp: jest.fn(() => ({ notNullable: jest.fn(() => ({ defaultTo: jest.fn() })) })),
    };
    callback(table);
  });
  const dropTableIfExists = jest.fn();
  const ignore = jest.fn().mockResolvedValue(undefined);
  const onConflict = jest.fn(() => ({ ignore }));
  const insert = jest.fn(() => ({ onConflict }));
  const tableQuery = { insert };
  const knex = Object.assign(
    jest.fn(() => tableQuery),
    {
      schema: {
        hasTable: jest.fn().mockResolvedValue(hasTable),
        createTable,
        dropTableIfExists,
      },
      fn: { now: jest.fn(() => 'now()') },
    },
  );
  return { knex, createTable, dropTableIfExists, insert, onConflict, ignore };
}

describe('admin alert settings migration', () => {
  it('creates and seeds the additive settings table idempotently', async () => {
    const fake = fakeKnex(false);
    await up(fake.knex as any);
    expect(fake.createTable).toHaveBeenCalledTimes(1);
    expect(fake.insert).toHaveBeenCalledWith(expect.objectContaining({ id: 1, channel: 'email' }));
    expect(fake.onConflict).toHaveBeenCalledWith('id');
    expect(fake.ignore).toHaveBeenCalledTimes(1);
  });

  it('does not recreate an existing table and supports rollback', async () => {
    const fake = fakeKnex(true);
    await up(fake.knex as any);
    expect(fake.createTable).not.toHaveBeenCalled();
    expect(fake.insert).toHaveBeenCalledTimes(1);
    await down(fake.knex as any);
    expect(fake.dropTableIfExists).toHaveBeenCalledWith('admin_alert_settings');
  });
});
