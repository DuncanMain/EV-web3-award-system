/**
 * Database initialization and migration runner
 * Idempotent: safe to run multiple times
 */

import 'dotenv/config';

import knex from 'knex';

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

    // Migration 001: initial schema
    const hasUsers = await db.schema.hasTable('users');
    if (!hasUsers) {
      const { up } = await import('./migrations/001_create_initial_schema');
      await up(db);
      console.log('[Migration] ✓ 001: Created initial schema');
    } else {
      console.log('[Migration] ✓ 001: Initial schema already exists');
    }

    // Migration 002: add peak/off-peak columns to awards
    const hasIsOffPeak = await db.schema.hasColumn('awards', 'is_off_peak');
    if (!hasIsOffPeak) {
      const { up } = await import('./migrations/002_add_peak_off_peak_to_awards');
      await up(db);
      console.log('[Migration] ✓ 002: Added peak/off-peak columns');
    } else {
      console.log('[Migration] ✓ 002: Peak/off-peak columns already exist');
    }

    // Migration 003: add award_type column to awards
    const hasAwardType = await db.schema.hasColumn('awards', 'award_type');
    if (!hasAwardType) {
      const { up } = await import('./migrations/003_add_award_type');
      await up(db);
      console.log('[Migration] ✓ 003: Added award_type column');
    } else {
      console.log('[Migration] ✓ 003: award_type column already exists');
    }

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
