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


    // Migration 004: add wallet profile fields
    const hasWalletName = await db.schema.hasColumn('users', 'wallet_name');
    if (!hasWalletName) {
      const { up } = await import('./migrations/004_add_wallet_profiles');
      await up(db);
      console.log('[Migration] ✓ 004: Added wallet profile fields');
    } else {
      console.log('[Migration] ✓ 004: Wallet profile fields already exist');
    }

    // Migration 006: add address-based linked wallets.
    const hasLinkedWalletAddresses = await db.schema.hasTable('linked_wallet_links');
    if (!hasLinkedWalletAddresses) {
      const { up } = await import('./migrations/006_add_linked_wallet_addresses');
      await up(db);
      console.log('[Migration] 006: Added linked wallet addresses');
    } else {
      console.log('[Migration] 006: Linked wallet links already exist');
    }
    const hasLinkedWalletName = await db.schema.hasColumn('linked_wallet_links', 'wallet_name');
    if (!hasLinkedWalletName) {
      await db.schema.alterTable('linked_wallet_links', (table) => {
        table.string('wallet_name', 120).nullable();
      });
      console.log('[Migration] 006: Added linked wallet name column');
    }

    // Migration 007: each blockchain address can only be linked once.
    const hasUniqueLinkedWalletAddress = await db.raw(`
      select 1
      from pg_indexes
      where indexname = 'linked_wallet_links_wallet_lower_unique'
      limit 1
    `);
    if (!hasUniqueLinkedWalletAddress.rows.length) {
      const { up } = await import('./migrations/007_enforce_unique_linked_wallet_addresses');
      await up(db);
      console.log('[Migration] 007: Enforced unique linked wallet addresses');
    } else {
      console.log('[Migration] 007: Linked wallet addresses already unique');
    }

    // Migration 005's global UID rule was superseded by 008.  Run the
    // canonical migration on every startup so a restored global constraint
    // cannot silently disable multiple-wallet UIDs.
    const { up: migrateUidWalletUniqueness } = await import('./migrations/008_allow_uid_per_wallet');
    await migrateUidWalletUniqueness(db);
    console.log('[Migration] 008: Scoped EMP contract uniqueness to wallet address');

    // Migration 009: add durable signed spend receipts.
    const hasSpendReceipts = await db.schema.hasTable('spend_receipts');
    if (!hasSpendReceipts) {
      const { up } = await import('./migrations/009_add_spend_receipts');
      await up(db);
      console.log('[Migration] 009: Added spend receipts');
    } else {
      console.log('[Migration] 009: Spend receipts already exist');
    }

    // Migration 010: add append-only audit logs.
    const hasAuditLogs = await db.schema.hasTable('audit_logs');
    if (!hasAuditLogs) {
      const { up } = await import('./migrations/010_add_audit_logs');
      await up(db);
      console.log('[Migration] 010: Added audit logs');
    } else {
      console.log('[Migration] 010: Audit logs already exist');
    }

    // Migration 011: add transaction lifecycle status fields.
    const hasAwardStatus = await db.schema.hasColumn('awards', 'status');
    const hasSpendStatus = await db.schema.hasColumn('spends', 'status');
    if (!hasAwardStatus || !hasSpendStatus) {
      const { up } = await import('./migrations/011_add_transaction_statuses');
      await up(db);
      console.log('[Migration] 011: Added transaction status fields');
    } else {
      console.log('[Migration] 011: Transaction status fields already exist');
    }

    // Migration 012: add persisted reconciliation reports.
    const hasReconciliationReports = await db.schema.hasTable('reconciliation_reports');
    if (!hasReconciliationReports) {
      const { up } = await import('./migrations/012_add_reconciliation_reports');
      await up(db);
      console.log('[Migration] 012: Added reconciliation reports');
    } else {
      console.log('[Migration] 012: Reconciliation reports already exist');
    }

    // Migration 013: reserve SPARKZ at session time and settle from the final CDR.
    const hasSpendReservations = await db.schema.hasTable('spend_reservations');
    if (!hasSpendReservations) {
      const { up } = await import('./migrations/013_add_spend_reservations');
      await up(db);
      console.log('[Migration] 013: Added spend reservations');
    } else {
      console.log('[Migration] 013: Spend reservations already exist');
    }

    // Migration 014: retain external-wallet authorization evidence.
    const hasReservationAuthorization = await db.schema.hasColumn('spend_reservations', 'authorization_tx_hash');
    if (!hasReservationAuthorization) {
      const { up } = await import('./migrations/014_add_reservation_authorization');
      await up(db);
      console.log('[Migration] 014: Added reservation wallet authorization');
    } else {
      console.log('[Migration] 014: Reservation wallet authorization already exists');
    }

    // Migration 015: durable token movement claims and unique transaction
    // projection keys.  This migration intentionally fails on historical
    // duplicate hashes so they can be reviewed rather than auto-assigned.
    const hasTokenOperations = await db.schema.hasTable('token_operations');
    const { up: migrateTokenOperations } = await import('./migrations/015_add_token_operations');
    await migrateTokenOperations(db);
    if (!hasTokenOperations) {
      console.log('[Migration] 015: Added durable token operations');
    } else {
      console.log('[Migration] 015: Durable token operations already exist or were repaired');
    }

    // Migration 016: persist reward rules and off-peak windows together.
    // This is additive and seeds only an absent singleton row, so an existing
    // operator policy survives an idempotent migration run.
    const hasRewardPolicy = await db.schema.hasTable('reward_policy');
    const { up: migrateRewardPolicy } = await import('./migrations/016_add_reward_policy');
    await migrateRewardPolicy(db);
    if (!hasRewardPolicy) {
      console.log('[Migration] 016: Added durable reward policy');
    } else {
      console.log('[Migration] 016: Durable reward policy already exists');
    }

    // Migration 017: protect future OCPI replacement CDRs that carry the
    // same provider and explicit physical charging session. Historical
    // token-operation rows remain unbound and untouched.
    const { up: migrateChargingSessionGuard } = await import('./migrations/017_add_charging_session_guard');
    await migrateChargingSessionGuard(db);
    console.log('[Migration] 017: Charging-session replacement guard is present');

    // Migration 022: persist and repair the explicitly selected wallet for
    // each UID.  This is standalone and deliberately does not depend on the
    // reserved campaign migration range 018-021.
    const { up: migrateActiveWalletSelection } = await import('./migrations/022_add_active_wallet_selection');
    await migrateActiveWalletSelection(db);
    console.log('[Migration] 022: Active wallet selection is present');

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
