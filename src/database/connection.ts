import knex from 'knex';

/**
 * Database connection pool
 * Connects to PostgreSQL specified in DATABASE_URL environment variable
 */

function getDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL environment variable not configured. ' +
      'Set this to your PostgreSQL connection string (e.g., postgres://user:pass@localhost/nvf_award)'
    );
  }
  return url;
}

let dbInstance: ReturnType<typeof knex> | null = null;

/**
 * Get or create the database connection pool
 */
export function getDatabase() {
  if (!dbInstance) {
    dbInstance = knex({
      client: 'pg',
      connection: {
        connectionString: getDatabaseUrl(),
      },
      pool: {
        min: 2,
        max: 10,
      },
    });
  }
  return dbInstance;
}

/**
 * Close the database connection pool
 */
export async function closeDatabase() {
  if (dbInstance) {
    await dbInstance.destroy();
    dbInstance = null;
  }
}

export type Database = ReturnType<typeof knex>;
