import 'dotenv/config';

import fs from 'fs';
import path from 'path';
import knex from 'knex';
import { up as migrateChargingSessionGuard } from './migrations/017_add_charging_session_guard';
import {
  TOKEN_OPERATION_CHARGING_SESSION_COLUMN,
  TOKEN_OPERATION_CHARGING_SESSION_INDEX,
  TOKEN_OPERATIONS_TABLE,
} from './tokenOperationSchema';

function assertExistingLocalTarget(databaseUrl: string): void {
  const parsed = new URL(databaseUrl);
  const databaseName = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
  if (!localHosts.has(parsed.hostname) || parsed.port !== '55432' || databaseName !== 'nvf_award') {
    throw new Error(
      'CHARGING_SESSION_MIGRATION_LOCAL_ONLY: apply only to the existing local nvf_award database at localhost:55432',
    );
  }
}

/**
 * The caller must run pg_verifybackup against the physical backup first. This
 * scoped runner only checks the explicit marker and manifest before applying
 * migration 017; it never creates or switches databases.
 */
function requireCallerVerifiedBackupManifest(): string {
  const backupPath = process.env.NVF_TOKEN_SCHEMA_BACKUP_PATH;
  if (!backupPath || process.env.NVF_TOKEN_SCHEMA_BACKUP_VERIFIED !== 'pg_verifybackup') {
    throw new Error(
      'CHARGING_SESSION_MIGRATION_BACKUP_REQUIRED: run pg_verifybackup externally, then set NVF_TOKEN_SCHEMA_BACKUP_PATH and NVF_TOKEN_SCHEMA_BACKUP_VERIFIED=pg_verifybackup',
    );
  }
  const resolved = path.resolve(backupPath);
  if (!fs.existsSync(path.join(resolved, 'backup_manifest'))) {
    throw new Error(
      'CHARGING_SESSION_MIGRATION_BACKUP_REQUIRED: backup_manifest is missing; verify the caller-provided backup before applying migration 017',
    );
  }
  return resolved;
}

type ChargingSessionIndexStatus = {
  unique: boolean;
  valid: boolean;
  ready: boolean;
  definition: string;
};

async function readChargingSessionIndex(db: ReturnType<typeof knex>): Promise<ChargingSessionIndexStatus | undefined> {
  const result = await db.raw(
    `select ix.indisunique as is_unique, ix.indisvalid as is_valid, ix.indisready as is_ready,
            pg_get_indexdef(ix.indexrelid) as definition
       from pg_class idx
       join pg_index ix on ix.indexrelid = idx.oid
      where ix.indrelid = to_regclass(?)::oid and idx.relname = ?`,
    [TOKEN_OPERATIONS_TABLE, TOKEN_OPERATION_CHARGING_SESSION_INDEX],
  );
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    unique: Boolean(row.is_unique),
    valid: Boolean(row.is_valid),
    ready: Boolean(row.is_ready),
    definition: String(row.definition || ''),
  };
}

async function run(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL environment variable not set');
  assertExistingLocalTarget(databaseUrl);
  const backupPath = requireCallerVerifiedBackupManifest();
  const db = knex({
    client: 'pg',
    connection: { connectionString: databaseUrl },
  });

  try {
    await db.transaction(async trx => {
      await migrateChargingSessionGuard(trx);
    });

    const columnPresent = await db.schema.hasColumn(
      TOKEN_OPERATIONS_TABLE,
      TOKEN_OPERATION_CHARGING_SESSION_COLUMN,
    );
    const index = await readChargingSessionIndex(db);
    if (!columnPresent || !index || !index.unique || !index.valid || !index.ready
      || !index.definition.includes('provider_id')
      || !index.definition.includes('charging_session_id')
      || !index.definition.includes('operation_type')) {
      throw new Error('CHARGING_SESSION_MIGRATION_FAILED: provider/physical-session guard is not enforcing the expected schema');
    }

    console.log(JSON.stringify({
      applied: true,
      migration: '017',
      backupPath,
      table: TOKEN_OPERATIONS_TABLE,
      column: TOKEN_OPERATION_CHARGING_SESSION_COLUMN,
      index: {
        name: TOKEN_OPERATION_CHARGING_SESSION_INDEX,
        unique: index.unique,
        valid: index.valid,
        ready: index.ready,
      },
    }));
  } finally {
    await db.destroy();
  }
}

run().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
