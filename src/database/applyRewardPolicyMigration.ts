import 'dotenv/config';

import fs from 'fs';
import path from 'path';
import knex from 'knex';
import { up as migrateRewardPolicy } from './migrations/016_add_reward_policy';
import { REWARD_POLICY_ROW_ID, REWARD_POLICY_TABLE } from '../config/policyPersistence';

function assertExistingLocalTarget(databaseUrl: string): void {
  const parsed = new URL(databaseUrl);
  const databaseName = parsed.pathname.replace(/^\//, '');
  const localHosts = new Set(['localhost', '127.0.0.1', '::1']);
  if (!localHosts.has(parsed.hostname) || parsed.port !== '55432' || databaseName !== 'nvf_award') {
    throw new Error(
      'REWARD_POLICY_MIGRATION_LOCAL_ONLY: apply only to the existing local nvf_award database at localhost:55432',
    );
  }
}

/**
 * This explicit local runner does not create or switch databases. It requires
 * caller-provided physical-backup evidence before applying the additive 016
 * table to the existing local dashboard database. The caller must run
 * pg_verifybackup externally; this script only checks the manifest and marker.
 */
function requireCallerVerifiedBackupManifest(): string {
  const backupPath = process.env.NVF_TOKEN_SCHEMA_BACKUP_PATH;
  if (!backupPath || process.env.NVF_TOKEN_SCHEMA_BACKUP_VERIFIED !== 'pg_verifybackup') {
    throw new Error(
      'REWARD_POLICY_MIGRATION_BACKUP_REQUIRED: run pg_verifybackup externally, then set NVF_TOKEN_SCHEMA_BACKUP_PATH and NVF_TOKEN_SCHEMA_BACKUP_VERIFIED=pg_verifybackup',
    );
  }
  const resolved = path.resolve(backupPath);
  if (!fs.existsSync(path.join(resolved, 'backup_manifest'))) {
    throw new Error(
      'REWARD_POLICY_MIGRATION_BACKUP_REQUIRED: backup_manifest is missing; verify the caller-provided backup before applying migration 016',
    );
  }
  return resolved;
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
      await migrateRewardPolicy(trx);
    });
    const row = await db(REWARD_POLICY_TABLE)
      .where({ id: REWARD_POLICY_ROW_ID })
      .first(['id', 'revision', 'updated_at']);
    if (!row) throw new Error('REWARD_POLICY_MIGRATION_FAILED: singleton policy row is missing after migration');
    console.log(JSON.stringify({
      applied: true,
      migration: '016',
      backupPath,
      policyTable: REWARD_POLICY_TABLE,
      policyRowId: row.id,
      revision: row.revision,
      updatedAt: row.updated_at,
    }));
  } finally {
    await db.destroy();
  }
}

run().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
