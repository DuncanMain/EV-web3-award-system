import type { Knex } from 'knex';

export const TOKEN_OPERATIONS_TABLE = 'token_operations';
export const APPROVAL_PREPARATIONS_TABLE = 'approval_preparations';
/**
 * Nullable physical charging-session provenance. It is deliberately separate
 * from session_id, which remains the historical CDR/idempotency key field.
 */
export const TOKEN_OPERATION_CHARGING_SESSION_COLUMN = 'charging_session_id';
export const TOKEN_OPERATION_CHARGING_SESSION_INDEX = 'token_operations_award_provider_charging_session_unique';
/** The guard must cover every award with a non-null provider/session binding. */
export const TOKEN_OPERATION_CHARGING_SESSION_PREDICATE =
  "operation_type = 'award' and provider_id is not null and charging_session_id is not null";

/** Keep this expression identical to the application-level hash validator. */
export const VALID_TRANSACTION_HASH_SQL = '^0x[0-9a-fA-F]{64}$';

export const TOKEN_OPERATION_HASH_INDEX = 'token_operations_tx_hash_lower_unique';
export const TOKEN_OPERATION_KEY_INDEX = 'token_operations_operation_key_unique';
export const APPROVAL_OPERATION_KEY_INDEX = 'approval_preparations_operation_key_unique';
export const PROJECTION_HASH_INDEXES = {
  awards: 'awards_tx_hash_valid_lower_unique',
  spends: 'spends_tx_hash_valid_lower_unique',
  receipts: 'spend_receipts_token_tx_hash_valid_lower_unique',
} as const;
export const FULL_PROJECTION_HASH_INDEXES = {
  awards: 'awards_tx_hash_lower_unique',
  spends: 'spends_tx_hash_lower_unique',
  receipts: 'spend_receipts_token_tx_hash_lower_unique',
} as const;

export const TOKEN_OPERATION_HASH_CHECK = 'token_operations_tx_hash_format_check';
export const APPROVAL_FUNDING_HASH_CHECK = 'approval_preparations_funding_tx_hash_format_check';
export const APPROVAL_APPROVAL_HASH_CHECK = 'approval_preparations_approval_tx_hash_format_check';

type QueryableKnex = Knex | Knex.Transaction;

async function ensureCheckConstraint(
  db: QueryableKnex,
  tableName: string,
  constraintName: string,
  expression: string,
): Promise<void> {
  const relation = await targetRelation(db, tableName);
  if (!relation) throw new Error(`TOKEN_OPERATION_SCHEMA_REQUIRED: ${tableName} table is missing`);
  const existing = await db('pg_constraint')
    .select('conname', 'contype', 'convalidated')
    .where({ conname: constraintName, conrelid: relation.oid })
    .first();
  if (existing) {
    if (existing.contype !== 'c' || existing.convalidated !== true) {
      throw new Error(
        `TOKEN_OPERATION_SCHEMA_REQUIRED: ${constraintName} exists on ${tableName} but is not a validated CHECK constraint`,
      );
    }
    return;
  }
  await db.raw(
    `alter table "${tableName}" add constraint "${constraintName}" check (${expression})`,
  );
}

interface TargetRelation {
  oid: number;
  schemaName: string;
}

/** Resolve a relation through the active search_path before inspecting it. */
async function targetRelation(db: QueryableKnex, tableName: string): Promise<TargetRelation | undefined> {
  const result = await db.raw(
    `select c.oid::int as oid, n.nspname as "schemaName"
       from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
      where c.oid = to_regclass(?)::oid`,
    [tableName],
  );
  const row = result.rows[0];
  return row ? { oid: Number(row.oid), schemaName: String(row.schemaName) } : undefined;
}

async function ensureApprovalPreparations(db: QueryableKnex): Promise<void> {
  if (!(await db.schema.hasTable(APPROVAL_PREPARATIONS_TABLE))) {
    await db.schema.createTable(APPROVAL_PREPARATIONS_TABLE, table => {
      table.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      table.string('operation_key', 240).notNullable().unique().index();
      table.string('wallet_address', 42).notNullable().index();
      table.string('token_contract_address', 42).notNullable();
      table.string('chain_id', 80).notNullable();
      table.string('treasury_address', 42).notNullable();
      table.string('status', 20).notNullable().index();
      table.string('funding_tx_hash', 66).nullable();
      table.string('approval_tx_hash', 66).nullable();
      table.text('error_message').nullable();
      table.timestamp('created_at').notNullable().defaultTo(db.fn.now());
      table.timestamp('updated_at').notNullable().defaultTo(db.fn.now());
    });
  }

  // These constraints are deliberately strict for new durable state.  A
  // malformed hash must never become an approval recovery identifier.
  await ensureCheckConstraint(
    db,
    APPROVAL_PREPARATIONS_TABLE,
    APPROVAL_FUNDING_HASH_CHECK,
    `funding_tx_hash is null or funding_tx_hash ~ '${VALID_TRANSACTION_HASH_SQL}'`,
  );
  await ensureCheckConstraint(
    db,
    APPROVAL_PREPARATIONS_TABLE,
    APPROVAL_APPROVAL_HASH_CHECK,
    `approval_tx_hash is null or approval_tx_hash ~ '${VALID_TRANSACTION_HASH_SQL}'`,
  );
  await db.raw(
    `create unique index if not exists "${APPROVAL_OPERATION_KEY_INDEX}" on "${APPROVAL_PREPARATIONS_TABLE}" (operation_key)`,
  );
}

/**
 * PostgreSQL adds type casts and parentheses when rendering an index
 * predicate. Remove only that presentation detail before comparing the full
 * expression; a narrower predicate must never be accepted as the guard.
 */
function normaliseChargingSessionPredicate(value: unknown): string {
  return String(value || '')
    .toLowerCase()
    .replace(/::[a-z_][a-z0-9_ ]*/g, '')
    .replace(/[\s()]/g, '');
}

/**
 * Idempotently create or repair only the durable movement tables.  This is
 * shared by strict migration 015 and the explicitly invoked local staging
 * command.  Projection uniqueness is intentionally handled separately so
 * staging can retain invalid historical rows while guarding valid hashes.
 */
export async function ensureTokenOperationTables(db: QueryableKnex): Promise<void> {
  if (await db.schema.hasTable(TOKEN_OPERATIONS_TABLE)) {
    if (!(await db.schema.hasColumn(TOKEN_OPERATIONS_TABLE, 'intent_context'))) {
      await db.schema.alterTable(TOKEN_OPERATIONS_TABLE, table => {
        table.jsonb('intent_context').nullable();
      });
    }
    if (!(await db.schema.hasColumn(TOKEN_OPERATIONS_TABLE, 'movement_outcome'))) {
      await db.schema.alterTable(TOKEN_OPERATIONS_TABLE, table => {
        table.string('movement_outcome', 20).notNullable().defaultTo('unknown').index();
      });
    } else {
      await db(TOKEN_OPERATIONS_TABLE).whereNull('movement_outcome').update({ movement_outcome: 'unknown' });
    }
  } else {
    await db.schema.createTable(TOKEN_OPERATIONS_TABLE, table => {
      table.uuid('id').primary().defaultTo(db.raw('gen_random_uuid()'));
      table.string('operation_key', 180).notNullable().unique().index();
      table.string('operation_type', 20).notNullable().index();
      table.string('legacy_key', 180).nullable().index();
      table.string('request_fingerprint', 128).notNullable();
      table.string('uid').notNullable().index();
      table.string('wallet_address', 42).notNullable().index();
      table.decimal('amount', 20, 2).notNullable();
      table.string('session_id').nullable().index();
      table.string('provider_id').nullable().index();
      table.uuid('reservation_id').nullable().index();
      table.jsonb('intent_context').nullable();
      table.string('status', 20).notNullable().index();
      table.string('movement_outcome', 20).notNullable().defaultTo('unknown').index();
      table.string('tx_hash', 66).nullable().index();
      table.text('error_message').nullable();
      table.timestamp('submitted_at').nullable();
      table.timestamp('confirmed_at').nullable();
      table.timestamp('projected_at').nullable();
      table.timestamp('created_at').notNullable().defaultTo(db.fn.now());
      table.timestamp('updated_at').notNullable().defaultTo(db.fn.now());
    });
  }

  await ensureCheckConstraint(
    db,
    TOKEN_OPERATIONS_TABLE,
    TOKEN_OPERATION_HASH_CHECK,
    `tx_hash is null or tx_hash ~ '${VALID_TRANSACTION_HASH_SQL}'`,
  );
  await db.raw(
    `create unique index if not exists "${TOKEN_OPERATION_HASH_INDEX}" on "${TOKEN_OPERATIONS_TABLE}" (lower(tx_hash)) where tx_hash is not null`,
  );
  await db.raw(
    `create unique index if not exists "${TOKEN_OPERATION_KEY_INDEX}" on "${TOKEN_OPERATIONS_TABLE}" (operation_key)`,
  );
  await ensureApprovalPreparations(db);
}

/**
 * Add the forward replacement guard without backfilling historical claims.
 * Rows created before this migration retain a NULL charging-session binding
 * and therefore retain their existing CDR-key coverage only.
 */
export async function ensureChargingSessionGuard(db: QueryableKnex): Promise<void> {
  if (!(await db.schema.hasTable(TOKEN_OPERATIONS_TABLE))) {
    throw new Error(`CHARGING_SESSION_SCHEMA_REQUIRED: ${TOKEN_OPERATIONS_TABLE} table is missing`);
  }
  if (!(await db.schema.hasColumn(TOKEN_OPERATIONS_TABLE, TOKEN_OPERATION_CHARGING_SESSION_COLUMN))) {
    await db.schema.alterTable(TOKEN_OPERATIONS_TABLE, table => {
      table.string(TOKEN_OPERATION_CHARGING_SESSION_COLUMN).nullable().index();
    });
  }
  const relation = await targetRelation(db, TOKEN_OPERATIONS_TABLE);
  if (!relation) throw new Error(`CHARGING_SESSION_SCHEMA_REQUIRED: ${TOKEN_OPERATIONS_TABLE} table is missing`);
  const existing = await db.raw(
    `select ix.indisunique, ix.indisvalid, ix.indisready,
            pg_get_indexdef(ix.indexrelid) as definition,
            pg_get_expr(ix.indpred, ix.indrelid) as predicate
       from pg_class idx
       join pg_index ix on ix.indexrelid = idx.oid
      where ix.indrelid = ?::oid and idx.relname = ?`,
    [relation.oid, TOKEN_OPERATION_CHARGING_SESSION_INDEX],
  );
  if (existing.rows.length > 0) {
    const row = existing.rows[0];
    const definition = String(row.definition || '');
    if (!row.indisunique || !row.indisvalid || !row.indisready
      || !definition.includes('(provider_id, charging_session_id)')
      || normaliseChargingSessionPredicate(row.predicate)
        !== normaliseChargingSessionPredicate(TOKEN_OPERATION_CHARGING_SESSION_PREDICATE)) {
      throw new Error(
        `CHARGING_SESSION_SCHEMA_REQUIRED: ${TOKEN_OPERATION_CHARGING_SESSION_INDEX} exists but is not a valid enforcing provider/session award guard`,
      );
    }
    return;
  }
  await db.raw(
    `create unique index if not exists "${TOKEN_OPERATION_CHARGING_SESSION_INDEX}" `
      + `on "${TOKEN_OPERATIONS_TABLE}" (provider_id, charging_session_id) `
      + `where ${TOKEN_OPERATION_CHARGING_SESSION_PREDICATE}`,
  );
}

/**
 * Additive guards for the existing projection tables.  The predicate leaves
 * legacy non-standard placeholders untouched while making every valid chain
 * transaction hash unique case-insensitively at the database boundary.
 */
export async function ensureValidProjectionHashIndexes(db: QueryableKnex): Promise<void> {
  const projections: Array<[string, string, string]> = [
    ['awards', 'tx_hash', PROJECTION_HASH_INDEXES.awards],
    ['spends', 'tx_hash', PROJECTION_HASH_INDEXES.spends],
    ['spend_receipts', 'token_tx_hash', PROJECTION_HASH_INDEXES.receipts],
  ];
  for (const [tableName, columnName, indexName] of projections) {
    if (!(await db.schema.hasTable(tableName))) {
      throw new Error(`TOKEN_OPERATION_SCHEMA_REQUIRED: ${tableName} table is missing`);
    }
  await db.raw(
    `create unique index if not exists "${indexName}" on "${tableName}" (lower("${columnName}")) where "${columnName}" ~ '${VALID_TRANSACTION_HASH_SQL}'`,
    );
  }
}

async function duplicateGroupCount(
  db: QueryableKnex,
  tableName: string,
  columnName: string,
  predicate: string,
): Promise<number> {
  if (!(await db.schema.hasTable(tableName))) return 0;
  const result = await db.raw(
    `select count(*)::int as count from (select lower("${columnName}") from "${tableName}" where ${predicate} group by lower("${columnName}") having count(*) > 1) duplicate_groups`,
  );
  return Number(result.rows[0]?.count || 0);
}

async function invalidRowCount(
  db: QueryableKnex,
  tableName: string,
  columnName: string,
): Promise<number> {
  if (!(await db.schema.hasTable(tableName))) return 0;
  const result = await db.raw(
    `select count(*)::int as count from "${tableName}" where "${columnName}" is not null and not ("${columnName}" ~ '${VALID_TRANSACTION_HASH_SQL}')`,
  );
  return Number(result.rows[0]?.count || 0);
}

async function hasScopedConstraint(
  db: QueryableKnex,
  tableName: string,
  constraintName: string,
): Promise<boolean> {
  const relation = await targetRelation(db, tableName);
  if (!relation) return false;
  const row = await db('pg_constraint')
    .select('conname', 'contype', 'convalidated')
    .where({ conname: constraintName, conrelid: relation.oid })
    .first();
  return Boolean(row && row.contype === 'c' && row.convalidated === true);
}

async function scopedIndexNames(
  db: QueryableKnex,
  tableName: string,
  names: string[],
): Promise<Set<string>> {
  const relation = await targetRelation(db, tableName);
  if (!relation) return new Set();
  const result = await db.raw(
    `select idx.relname as "indexName"
      from pg_class idx
      join pg_index ix on ix.indexrelid = idx.oid
      where ix.indrelid = ?::oid
        and ix.indisunique
        and ix.indisvalid
        and ix.indisready
        and idx.relname = any(?)`,
    [relation.oid, names],
  );
  return new Set(result.rows.map((row: { indexName: string }) => String(row.indexName)));
}

export interface TokenOperationSchemaStatus {
  tokenOperationsTable: boolean;
  approvalPreparationsTable: boolean;
  tokenOperationHashIndex: boolean;
  operationKeyUnique: boolean;
  approvalOperationKeyUnique: boolean;
  projectionHashIndexes: boolean;
  hashChecks: boolean;
  validDuplicateGroups: number;
  allDuplicateGroups: number;
  invalidLegacyRows: number;
  stagedReady: boolean;
  strictMigrationReady: boolean;
  missing: string[];
}

export async function getTokenOperationSchemaStatus(db: QueryableKnex): Promise<TokenOperationSchemaStatus> {
  const tokenOperationsTable = await db.schema.hasTable(TOKEN_OPERATIONS_TABLE);
  const approvalPreparationsTable = await db.schema.hasTable(APPROVAL_PREPARATIONS_TABLE);
  const tokenIndexes = await scopedIndexNames(db, TOKEN_OPERATIONS_TABLE, [
    TOKEN_OPERATION_HASH_INDEX,
    TOKEN_OPERATION_KEY_INDEX,
  ]);
  const approvalIndexes = await scopedIndexNames(db, APPROVAL_PREPARATIONS_TABLE, [APPROVAL_OPERATION_KEY_INDEX]);
  const awardIndexes = await scopedIndexNames(db, 'awards', [PROJECTION_HASH_INDEXES.awards, FULL_PROJECTION_HASH_INDEXES.awards]);
  const spendIndexes = await scopedIndexNames(db, 'spends', [PROJECTION_HASH_INDEXES.spends, FULL_PROJECTION_HASH_INDEXES.spends]);
  const receiptIndexes = await scopedIndexNames(db, 'spend_receipts', [PROJECTION_HASH_INDEXES.receipts, FULL_PROJECTION_HASH_INDEXES.receipts]);
  const hasTokenHashCheck = await hasScopedConstraint(db, TOKEN_OPERATIONS_TABLE, TOKEN_OPERATION_HASH_CHECK);
  const hasFundingHashCheck = await hasScopedConstraint(db, APPROVAL_PREPARATIONS_TABLE, APPROVAL_FUNDING_HASH_CHECK);
  const hasApprovalHashCheck = await hasScopedConstraint(db, APPROVAL_PREPARATIONS_TABLE, APPROVAL_APPROVAL_HASH_CHECK);
  const validDuplicateGroups = (
    await duplicateGroupCount(db, 'awards', 'tx_hash', `"tx_hash" ~ '${VALID_TRANSACTION_HASH_SQL}'`)
    + await duplicateGroupCount(db, 'spends', 'tx_hash', `"tx_hash" ~ '${VALID_TRANSACTION_HASH_SQL}'`)
    + await duplicateGroupCount(db, 'spend_receipts', 'token_tx_hash', `"token_tx_hash" ~ '${VALID_TRANSACTION_HASH_SQL}'`)
    + await duplicateGroupCount(db, TOKEN_OPERATIONS_TABLE, 'tx_hash', `"tx_hash" is not null and "tx_hash" ~ '${VALID_TRANSACTION_HASH_SQL}'`)
  );
  const allDuplicateGroups = (
    await duplicateGroupCount(db, 'awards', 'tx_hash', '"tx_hash" is not null')
    + await duplicateGroupCount(db, 'spends', 'tx_hash', '"tx_hash" is not null')
    + await duplicateGroupCount(db, 'spend_receipts', 'token_tx_hash', '"token_tx_hash" is not null')
    + await duplicateGroupCount(db, TOKEN_OPERATIONS_TABLE, 'tx_hash', '"tx_hash" is not null')
  );
  const invalidLegacyRows = (
    await invalidRowCount(db, 'awards', 'tx_hash')
    + await invalidRowCount(db, 'spends', 'tx_hash')
    + await invalidRowCount(db, 'spend_receipts', 'token_tx_hash')
  );

  const missing: string[] = [];
  if (!tokenOperationsTable) missing.push(TOKEN_OPERATIONS_TABLE);
  if (!approvalPreparationsTable) missing.push(APPROVAL_PREPARATIONS_TABLE);
  const tokenOperationHashIndex = tokenIndexes.has(TOKEN_OPERATION_HASH_INDEX);
  const operationKeyUnique = tokenIndexes.has(TOKEN_OPERATION_KEY_INDEX);
  const approvalOperationKeyUnique = approvalIndexes.has(APPROVAL_OPERATION_KEY_INDEX);
  const projectionHashIndexes = (
    (awardIndexes.has(PROJECTION_HASH_INDEXES.awards) || awardIndexes.has(FULL_PROJECTION_HASH_INDEXES.awards))
    && (spendIndexes.has(PROJECTION_HASH_INDEXES.spends) || spendIndexes.has(FULL_PROJECTION_HASH_INDEXES.spends))
    && (receiptIndexes.has(PROJECTION_HASH_INDEXES.receipts) || receiptIndexes.has(FULL_PROJECTION_HASH_INDEXES.receipts))
  );
  const hashChecks = hasTokenHashCheck && hasFundingHashCheck && hasApprovalHashCheck;
  if (!tokenOperationHashIndex) missing.push(TOKEN_OPERATION_HASH_INDEX);
  if (!operationKeyUnique) missing.push(TOKEN_OPERATION_KEY_INDEX);
  if (!approvalOperationKeyUnique) missing.push(APPROVAL_OPERATION_KEY_INDEX);
  if (!projectionHashIndexes) missing.push('projection transaction-hash uniqueness guards');
  if (!hasTokenHashCheck) missing.push(TOKEN_OPERATION_HASH_CHECK);
  if (!hasFundingHashCheck) missing.push(APPROVAL_FUNDING_HASH_CHECK);
  if (!hasApprovalHashCheck) missing.push(APPROVAL_APPROVAL_HASH_CHECK);
  return {
    tokenOperationsTable,
    approvalPreparationsTable,
    tokenOperationHashIndex,
    operationKeyUnique,
    approvalOperationKeyUnique,
    projectionHashIndexes,
    hashChecks,
    validDuplicateGroups,
    allDuplicateGroups,
    invalidLegacyRows,
    stagedReady: missing.length === 0 && validDuplicateGroups === 0,
    strictMigrationReady: allDuplicateGroups === 0,
    missing,
  };
}

/**
 * Explicit local staging path.  It runs atomically and never bypasses the
 * strict duplicate guard in migration 015.  Valid historical duplicates stop
 * the transaction; invalid legacy placeholders are retained and reported by
 * readiness after the valid-hash partial indexes are installed.
 */
export async function stageTokenOperationSchema(db: Knex): Promise<void> {
  await db.transaction(async trx => {
    const before = await getTokenOperationSchemaStatus(trx);
    if (before.validDuplicateGroups > 0) {
      throw new Error(
        `TOKEN_OPERATION_SCHEMA_STOPPED: ${before.validDuplicateGroups} valid transaction-hash duplicate group(s) require manual review`,
      );
    }
    await ensureTokenOperationTables(trx);
    await ensureValidProjectionHashIndexes(trx);
    const after = await getTokenOperationSchemaStatus(trx);
    if (!after.stagedReady) {
      throw new Error(`TOKEN_OPERATION_SCHEMA_INCOMPLETE: ${after.missing.join(', ') || 'valid duplicate groups remain'}`);
    }
  });
}
