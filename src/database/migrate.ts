/**
 * Database initialization and migration runner
 * Run this once to set up the database schema
 */

import 'dotenv/config';

import knex from 'knex';
import * as migration001 from './migrations/001_create_initial_schema';

async function runMigrations() {
  const database = process.env.DATABASE_URL;
  if (!database) {
    throw new Error('DATABASE_URL environment variable not set');
  }

  const db = knex({
    client: 'pg',
    connection: {
      connectionString: database,
    },
  });

  try {
    console.log('[Migration] Running migrations...');

    // Run migration 001
    await migration001.up(db);
    console.log('[Migration] ✓ Created initial schema');

    console.log('[Migration] All migrations completed successfully');
  } catch (err) {
    console.error('[Migration] Error:', err);
    throw err;
  } finally {
    await db.destroy();
  }
}

// Run migrations
runMigrations().catch((err) => {
  console.error(err);
  process.exit(1);
});
