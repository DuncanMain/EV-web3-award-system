import 'dotenv/config';

import fs from 'fs';
import path from 'path';
import knex from 'knex';
import {
  getTokenOperationSchemaStatus,
  stageTokenOperationSchema,
} from './tokenOperationSchema';

function assertLocalTarget(databaseUrl: string): void {
  const parsed = new URL(databaseUrl);
  const databaseName = parsed.pathname.replace(/^\//, '');
  const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
  if (!localHosts.has(parsed.hostname) || parsed.port !== '55432' || databaseName !== 'nvf_award') {
    throw new Error(
      'TOKEN_OPERATION_SCHEMA_LOCAL_ONLY: staging requires the existing local nvf_award database at localhost:55432',
    );
  }
}

/**
 * The staging process does not run pg_verifybackup itself.  The caller must
 * verify the physical backup first and provide this explicit evidence marker;
 * the script only checks that the referenced manifest is present.
 */
function requireCallerVerifiedBackupManifest(): string {
  const backupPath = process.env.NVF_TOKEN_SCHEMA_BACKUP_PATH;
  if (!backupPath || process.env.NVF_TOKEN_SCHEMA_BACKUP_VERIFIED !== 'pg_verifybackup') {
    throw new Error(
      'TOKEN_OPERATION_SCHEMA_BACKUP_REQUIRED: run pg_verifybackup externally, then set NVF_TOKEN_SCHEMA_BACKUP_PATH and NVF_TOKEN_SCHEMA_BACKUP_VERIFIED=pg_verifybackup',
    );
  }
  const resolved = path.resolve(backupPath);
  if (!fs.existsSync(path.join(resolved, 'backup_manifest'))) {
    throw new Error(
      'TOKEN_OPERATION_SCHEMA_BACKUP_REQUIRED: backup_manifest is missing; verify the caller-provided backup before staging',
    );
  }
  return resolved;
}

async function run(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL environment variable not set');
  assertLocalTarget(databaseUrl);
  const backupPath = requireCallerVerifiedBackupManifest();
  const db = knex({
    client: 'pg',
    connection: { connectionString: databaseUrl },
  });
  try {
    await stageTokenOperationSchema(db);
    const status = await getTokenOperationSchemaStatus(db);
    console.log(JSON.stringify({
      staged: status.stagedReady,
      backupPath,
      invalidLegacyRowsRetained: status.invalidLegacyRows,
      strictMigrationReady: status.strictMigrationReady,
      validDuplicateGroups: status.validDuplicateGroups,
    }));
  } finally {
    await db.destroy();
  }
}

run().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
