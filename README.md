# NVF Award Core

Backend core functions for the NEVERFLAT award system.

## Overview

This module provides internal functions for:

- CDR normalisation
- Rules-based reward logic calculation
- Award preparation and execution
- Spend validation and execution

Built for Polygon Amoy network integration with the NVF contract.

## Deployment status

The deployed main baseline is merge commit
`87b35bdf4e0d9bde7b4d8c4cbb93ab459b0f321a` (PR #6, 6 October 2026). GitHub
independently recorded successful production run [Deploy Neverflat #45](https://github.com/ZentrixLab/neverflat/actions/runs/37457660589)
and mirror run [Mirror Repositories #33](https://github.com/ZentrixLab/neverflat/actions/runs/37457660702).
The immutable candidate commit `5a3b4386d71d97d568942dc5d705f4f438c6133d`
had the same released tree `d5382d1eff4dadb8b189ae1869095418637e6e0d` as
that merge. This branch adds the follow-up fixes and will be identified by its
own review commit.
The built image digest and post-start target health, readiness, backup, and
migration acceptance evidence are not captured in this record. This
release-fixes branch is prepared for review on Zentrix `development`; Dejan
promotes it to `main` after review, so its follow-up changes are outside the
verified `87b35bd` deployment until that promotion and a separate acceptance
record.

See [`DEPLOYMENT.md`](DEPLOYMENT.md) for immutable-image preflight,
backup/restore, migration, rollout, and rollback gates.

## Identifier Terminology

This project uses the charging contract's **eMAID** as the primary external identifier for ownership.

For backward compatibility, API fields and headers retain `contractId`, `x-contract-id` and `uid` (including helper names like `resolveUidToAddress` and the `users.uid` column). These carry the same eMAID value as the final CDR. An app account ID or RFID UID is not a substitute.

Preserve the eMAID spelling used by the existing integration. Changing identity values or wallet-derivation configuration can change wallet addresses and requires an explicit migration.

## Implementation Status

- ✅ **Reward Orchestrator**: Complete pipeline from raw CDR to on-chain settlement (`processAwardFromCDR`)
- ✅ **Core Normaliser**: OCPI CDR parsing with energy direction detection
- ✅ **Reward Calculation**: JSON-configured rules (off-peak 0.25 tokens/kWh, V2G 1 token/kWh)
- ✅ **Executor Functions**: `prepareAward()`, `executeAward()`, `prepareSpend()`, `executeSpend()`
- ✅ **Award Rules**: Externalized configuration, deduplication key generation
- ✅ **Off-Peak Windows**: Configurable by country (DE, ES, RO: 22:00-06:00)
- ✅ **Contract Integration**: ethers.js setup with token calls
- ✅ **User Accounts**: Deterministic contract ID → Polygon address mapping with auto-enrollment
- ✅ **PostgreSQL Database**: Mirrors blockchain state for API queries
- **Event listener scaffolding**: Not started by the current API; ordinary ERC20 transfers are tracked through the request processing paths.
- ✅ **Comprehensive Tests**: Automated unit and API-integration coverage across core modules
- ✅ **REST API**: Identity-context and test-mode endpoints for CDR ingestion, spend processing, and wallet queries

## Installation

```bash
npm install
```

## Build

```bash
npm run build
```

## Docker

For local development only, build the container image and start PostgreSQL and
the API with:

```bash
docker compose up --build -d
```

This uses `compose.yaml`, the single local-development Compose configuration,
for both the API and PostgreSQL. The image entrypoint runs the complete
`dist/database/migrate.js` chain before `dist/api.js`; use a fresh or known
compatible local database and expect the process to stop if historical
migration checks find duplicate data. Do not use this command as a production
rollout procedure. Production uses the separate `compose.production.yaml`
definition and the review gates in [`DEPLOYMENT.md`](DEPLOYMENT.md).

### Docker Secrets

The service supports a mounted secret file for the treasury private key via `TREASURY_SIGNER_KEY_FILE`.
In production, use your secret manager or Docker secrets to provide the key at runtime.

## Development Scripts

The `scripts/` directory contains development and testing utilities:

- `capture-pilot-evidence.js` - Captures a timestamped TRL7 pilot evidence JSON file from health, wallet, audit, and reconciliation endpoints
- `load-test-ingest-preview.js` - Captures safe CDR preview throughput evidence without token settlement
- `test-award-and-spend-debug.js` - End-to-end award and spend flow testing
- `test-approval-debug.js` - Manual approval testing
- `test-e2e-flow.js` - Complete end-to-end flow validation
- `test-full-flow.js` - Full system integration test

Run with: `node scripts/<script-name>.js`

For TRL7 evidence capture:

```bash
npm run evidence:pilot
```

By default this is non-destructive and writes `evidence/pilot-evidence-*.json`.
Set `EVIDENCE_RUN_CDR=true` to submit a sample CDR, and
`EVIDENCE_RUN_RECONCILIATION=true` to trigger a reconciliation run during the
capture.

For safe ingestion/rule throughput evidence:

```bash
npm run evidence:load-preview
```

Defaults to 10 preview requests per second for 10 seconds and writes
`evidence/load-test-ingest-preview-*.json`. Override with `LOAD_TEST_RPS`,
`LOAD_TEST_DURATION_SECONDS`, and `LOAD_TEST_CONCURRENCY`.

## Admin UI

The NEVERFLAT admin console is available in `frontend/`.

Run API and UI in two terminals:

```bash
# Terminal 1 (API)
npm run api

# Terminal 2 (admin UI)
cd frontend
npm run dev
```

For local development, the admin UI remembers the API URL used at login. When served by Vite on port `3001`, it defaults to `http://localhost:3005`.

## API Identity And Test Modes

The backend supports two access modes:

- **Identity mode (EMP-ready)**: Uses API identity endpoints and resolves contract ID from request header (default `x-contract-id`)
- **Test mode (local integration fallback)**: Allows manual contract ID lookup for disposable testing before EMP is complete. Keep `ENABLE_TEST_UID_LOOKUP=false` for a pilot or production target and use `/wallet/me` and `/spend/me` with the forwarded eMAID.

### User Endpoints

- `GET /wallet/me` - Wallet for authenticated/forwarded identity context
- `POST /spend/session` - Non-spending BEIA charging-session SPARKZ prompt
- `POST /spend/me` - Spend for authenticated/forwarded identity context
- `GET /wallet/:uid` - Manual contract ID wallet lookup (legacy/test flow)
- `POST /spend` - Manual contract ID spend (legacy/test flow; every new request requires a stable non-empty `idempotencyKey`)

The BEIA charging flow first calls `POST /spend/session` with `x-contract-id`,
then calls `POST /spend/me` only after the user confirms an amount. This creates
a reservation rather than an immediate spend. The EMP's final CDR reaches
NEVERFLAT through the Aarhus database. NEVERFLAT has no direct outbound EMP
connection, so BEIA must retrieve the completed reservation settlement and
forward it to the EMP. The BEIA-facing reservation-status endpoint is
`GET /spend/reservations/:reservationId` and returns the saved reservation
state for settlement polling.

The reusable BEIA React component package lives in
`packages/sparkz-charging-card/`. It is separate from the `frontend/` admin
console bundle.

### BEIA React Package Integration

The BEIA package exports `SparkzChargingCard`.

- BEIA passes the logged-in user's charging-contract eMAID as `contractId`
- `UNPLUGGED` mode shows the user's SPARKZ account view via `GET /wallet/me`
- Active session modes call `POST /spend/session` and show the spend prompt
- `POST /spend/me` reserves SPARKZ only after the user confirms an amount
- Manual `POST /spend` callers must create one stable `idempotencyKey` per intended spend and reuse it for pending or network-failure recovery. A new key represents a genuinely new spend; `/spend/me` reservations are unchanged.
- BEIA must use the same contract, session, and provider identifiers that
  appear in the final Aarhus CDR
- BEIA will retrieve the final settlement from NEVERFLAT and forward it to the EMP
- Custodial wallet mode requires an installed EVM wallet signature before mode switch
- External-wallet reservations request a capped ERC-20 approval at reservation
  time, allowing delayed CDR settlement without a second signature
- BEIA should set the component back to `UNPLUGGED` when the CDR/session close event is received

See `packages/sparkz-charging-card/README.md` for install instructions, props,
state model, and callback examples.

## Award Rules

Award logic is defined in a JSON configuration file (`src/config/awardRules.json`) for easy maintenance and updates:

```json
{
  "version": "1.0",
  "rules": {
    "offPeakCharging": {
      "enabled": true,
      "tokensPerKWh": 0.25,
      "description": "1 SPARKZ per 4 kWh"
    },
    "v2gDischarge": {
      "enabled": true,
      "tokensPerKWh": 1,
      "description": "1 SPARKZ per 1 kWh"
    }
  },
  "idempotency": {
    "deduplicationKey": ["sessionId", "providerId"]
  }
}
```

Charging and discharge calculations floor the resulting award to whole SPARKZ
tokens. A 10 kWh off-peak charge at 0.25 tokens/kWh therefore awards 2 SPARKZ;
the remaining fractional token is not carried into a later event.

## User Account System

Each contract ID automatically maps to a Polygon wallet address on first use.

### Address Generation

- **Deterministic**: The same contract ID always generates the same address
- **Automatic**: First time a contract ID appears in a CDR, an address is created and registered
- **Configurable**: Address generation uses a salt from the `USER_ADDRESS_DERIVATION_SALT` environment variable

```typescript
import { resolveUidToAddress, isUserRegistered } from 'nvf-award-core';

// Auto-creates address on first call (contract ID value)
const address = resolveUidToAddress('contract-123');

// Subsequent calls return the same address
const sameAddress = resolveUidToAddress('contract-123');
assert(address === sameAddress);

// Check if user has been seen before
const isKnown = isUserRegistered('contract-456');
```

## Configuration

Create a `.env` file based on `.env.example`:

```bash
# Existing treasury wallet address (preserve the target value)
TREASURY_ADDRESS=your_existing_treasury_address
TREASURY_GAS_WARNING_THRESHOLD_MATIC=0.05

# Required for a pilot or production target; may be omitted only for local development
API_KEY=your_api_key_here

# Dedicated CDR ingestion key for AU/provider systems (required for a target)
INGEST_API_KEY=your_ingest_only_secret_here

# Admin login credentials and alert target
ADMIN_EMAIL=admin@example.com
ADMIN_PASSWORD=your_admin_password
ADMIN_ALERT_WEBHOOK_URL=https://alerts.example.com/neverflat

# Salt for deterministic contract ID->address mapping
USER_ADDRESS_DERIVATION_SALT=nvf-award-core-v1

# Identity header name used by /wallet/me and /spend/me
USER_IDENTITY_HEADER=x-contract-id

# Local-only manual /wallet/:uid lookup for testing
# Set explicitly to false in a pilot or production target
ENABLE_TEST_UID_LOOKUP=true

# PostgreSQL connection (database that mirrors blockchain)
DATABASE_URL=postgres://user:password@localhost:5432/nvf_award
```

## Database

The system uses PostgreSQL to mirror blockchain state for efficient API queries.

### Setup

1. **Start Docker database:**
   ```bash
   docker compose up -d postgres
   ```

2. **Run migrations:**
   ```bash
   npm run db:migrate
   ```

   This runs the full migration chain locally. It is suitable for a fresh or
   known-compatible disposable database only. Migration 008 permits multiple
   wallets for one UID, rejects duplicate `(uid, lower(wallet_address))` pairs,
   and removes the obsolete global UID constraint; migration 015 rejects
   duplicate transaction hashes for review. The container entrypoint invokes
   the same chain. Use the target-specific backup and migration gate in
   [`DEPLOYMENT.md`](DEPLOYMENT.md) before any production database change. The
   scoped 015/016/017 runners are loopback-only local review tools and must not
   be copied to production.

3. **Stop Docker database when finished:**
   ```bash
   docker compose down
   ```

### Schema

**users** - Maps contract ID to Polygon wallet address
- `id` - UUID primary key
- `uid` - Contract identifier (legacy column name)
- `wallet_address` - Ethereum/Polygon address
- `created_at` - Registration timestamp

**awards** - Records all token distributions
- `id` - UUID primary key
- `user_id` - References users table
- `session_id`, `provider_id` - From CDR
- `dedup_key` - (sessionId, providerId) for idempotency
- `amount` - SPARKZ tokens awarded
- `tx_hash` - On-chain transaction hash
- `status` - Transaction lifecycle state, currently `confirmed` for successful awards
- `confirmed_at` - Confirmation timestamp
- `error_message` - Failure detail for future retry/reconciliation states
- `awarded_at` - Settlement timestamp

**balances** - Current user balances
- `id` - UUID primary key
- `user_id` - References users table
- `wallet_address` - Polygon address
- `balance` - Current SPARKZ balance
- `total_awarded` - Cumulative awarded
- `total_spent` - Cumulative spent
- `last_synced` - Last blockchain sync

**spend_receipts** - Signed settlement receipts for external verification
- `receipt_id` - Public receipt identifier
- `uid` - Contract identifier
- `wallet_address` - Wallet that spent tokens
- `amount` - SPARKZ tokens spent
- `session_id`, `provider_id` - Optional external settlement references
- `token_tx_hash` - On-chain spend transaction hash
- `canonical_payload`, `signature`, `signer_address` - Receipt verification material
- `status` - Receipt lifecycle state, initially `settled`

**spends** - Token spend transactions
- `id` - UUID primary key
- `user_id` - References users table
- `wallet_address` - Wallet that spent tokens
- `amount` - SPARKZ tokens spent
- `tx_hash` - On-chain spend transaction hash
- `session_id` - Optional external settlement reference
- `status` - Transaction lifecycle state, currently `confirmed` for successful spends
- `confirmed_at` - Confirmation timestamp
- `error_message` - Failure detail for future retry/reconciliation states

**audit_logs** - Append-only operational and settlement audit trail
- `event_type` - Event name such as `spend.completed`, `admin.rules_updated`, or `treasury.gas_low`
- `actor_type`, `actor_id` - System, API client, admin session, or user identity
- `target_type`, `target_id` - Receipt, token transaction, wallet, rule set, or other target
- `status` - Event result such as `success`, `error`, `retry_required`, `warning`, or `duplicate`
- `metadata` - JSON evidence for the event
- `created_at` - Event timestamp

**reconciliation_reports** - Stored DB-vs-chain balance checks
- `status` - Overall report status: `matched` or `mismatch`
- `checked_count`, `matched_count`, `mismatch_count` - Summary counts
- `items` - Per-wallet comparison records
- `metadata` - Token contract, run limit, and run source
- `created_at` - Report timestamp

### Database Synchronisation

The API records token transfers through its request-processing paths. The event
listener scaffolding is not started by API startup, and its custom `Award` and
`Spend` events are not part of the configured ERC20 interface. Do not rely on it
to repair missed database writes or to import arbitrary wallet transactions.

Use operation recovery and the existing reconciliation checks to investigate
differences between recorded and on-chain balances. A balance comparison alone
does not establish which session or eMAID owns an unrecorded transfer.

### Database Queries

```typescript
import { Users, Awards, Balances } from 'nvf-award-core';

// Get user by contract ID
const user = await Users.findByUid('contract-123');

// Get all awards for a user
const awards = await Awards.findByUser(user.id);

// Get current balance
const balance = await Balances.findByUser(user.id);

// Get leaderboard (ordered by total awarded)
const leaders = await Balances.getAll();
```

## Usage

### Complete End-to-End: The Reward Executor

Use `processAwardFromCDR()` for end-to-end orchestration from raw CDR to on-chain settlement:

```typescript
import { processAwardFromCDR } from 'nvf-award-core';

// Raw CDR from charging provider
const neverflatCDR = {
  SessionID: 'a1b09f5b-b75d-4c9e-aef2-4f0c74cc7623',
  ProviderID: 'DE-NWQ',
  cdr_token: { contract_id: 'DE8ACC12E46L89' }, // eMAID, not RFID UID
  EVSEID: 'DE*GUC*E*EZO*0877',
  StartTime: '2026-02-16T02:00:00Z',  // Off-peak in DE
  EndTime: '2026-02-16T03:00:00Z',
  Energy: '40',  // 40 kWh charged
  EnergyDirection: 'CHARGE',
};

// Get treasury signer
const treasurySigner = await getTreasurySigner();

// Single function handles all stages:
// 1. Normalise CDR
// 2. Calculate tokens based on rules
// 3. Resolve contract ID (from cdr_token.contract_id) -> Polygon address (creates if first time)
// 4. Execute on-chain token transfer
const result = await processAwardFromCDR(neverflatCDR, treasurySigner);

console.log(result);
// {
//   success: true,
//   eligible: true,
//   amount: 10,                  // 40 kWh / 4 = 10 SPARKZ
//   uid: 'DE8ACC12E46L89',        // eMAID in the legacy field name
//   dedupKey: 'a1b09f5b-...-DE-NWQ',
//   txHash: '0x123...',          // User received SPARKZ on-chain
//   stage: 'complete'
// }
```

### With Idempotency Checking

The durable token-operation claim protects concurrent processing and retries.
Apply migration 015 before using this local implementation. The optional legacy
callback remains available as an additional check; it does not replace the
database claim or the executor's award projection.

```typescript
const treasurySigner = await getTreasurySigner();

const result = await processAwardFromCDR(
  neverflatCDR,
  treasurySigner,
  async (dedupKey) => {
    // Check your DB for existing award
    return await db.awards.exists(dedupKey);
  }
);

if (result.requiresReview) {
  // Retain the original CDR and recovery details for operator review.
} else if (result.pending) {
  // Retry the identical CDR to resume confirmation or database projection.
}
```

### ExecutionResult Structure

```typescript
{
  success: boolean;              // Operation succeeded
  eligible: boolean;             // Deserves a reward
  amount: number;                // SPARKZ tokens
  uid: string;                   // Contract ID (legacy field name)
  dedupKey: string;              // For database lookup
  txHash?: string;               // Absent for a zero-award decision or unknown submission
  operationStatus?: string;
  pending?: boolean;            // Processing is incomplete; not financial success
  requiresReview?: boolean;     // Do not automatically replace the transfer
  duplicate?: boolean;
  error?: string;                // Error message if failed
  stage: 'normalisation' | 'calculation' | 'validation' | 'execution' | 'complete'
}
```

### Individual Functions (Custom Pipelines)

For more control, use the functions separately:

```typescript
import { 
  normaliseSession, 
  calculateAwardTokens, 
  getDeduplicationKey,
  prepareAward, 
  executeAward 
} from 'nvf-award-core';

const normalised = normaliseSession(rawCDR);
const tokens = calculateAwardTokens(normalised);
const dedupKey = getDeduplicationKey(normalised);
const award = prepareAward(normalised);

if (award.eligible) {
  const txHash = await executeAward(signer, userAddress, award.amount);
}
```

### Normaliser Output Format

```typescript
{
  sessionId: string,
  providerId: string,
  uid: string,                   // Contract ID (legacy field name)
  evseId: string,
  startTime: Date,
  endTime: Date,
  energyKWh: number,        // Always positive (absolute value)
  energyDirection: 'CHARGE' | 'DISCHARGE'
}
```

### Energy Direction

Energy direction is automatically detected from the sign:
- **Positive value** (e.g., `46.593`) → `CHARGE` direction
- **Negative value** (e.g., `-5.25`) → `DISCHARGE` direction

### Reward Calculation Rules

1. **Off-peak Charging**: 1 SPARKZ per 4 kWh (only during off-peak hours)
   - Off-peak windows are country-specific and configurable through the durable
     admin policy
   - Example DE: 22:00 - 06:00
2. **V2G Discharge**: 1 SPARKZ per 1 kWh (always)

### Idempotency

Deduplication uses `(sessionId, providerId)` tuple to prevent double-awarding. The `getDeduplicationKey()` function generates this key for database lookups.

Manual `POST /spend` requests require a non-empty string `idempotencyKey` for
new spends. Keep that key unchanged across retries, including a lost HTTP
response or a pending token operation; the returned `operationKey` can be used
to recover an existing operation. Missing, empty, or non-string keys fail with
HTTP 400 before any wallet lookup or token movement. Generate a new key only
when the user intentionally starts a new spend. This is a breaking
compatibility requirement for manual callers. The identity-context reservation route
`POST /spend/me` retains its existing session/provider-based behaviour.

## Contract Details

- Network: Polygon Amoy
- Contract: NVF
- Token: SPARKZ
- Address: 0x605871D30DC278a036F09e2ace771df8a224624B
- Functions: ERC-20 `transfer(address to, uint256 amount)` for treasury awards
  and `transferFrom(address from, address to, uint256 amount)` for approved
  spends. The treasury signer submits a spend only after the user's approval.

## Testing

```bash
npm test
```

Test suites:
- Normaliser tests: CDR format handling, field mapping, timestamp parsing
- Award rules tests: Token calculation, off-peak detection, deduplication, edge cases

## Execution

- `prepareAward` and `prepareSpend` handle business logic validation
- `executeAward` and `executeSpend` perform on-chain transactions
- Requires appropriate signers (treasury for awards, user for spends)
