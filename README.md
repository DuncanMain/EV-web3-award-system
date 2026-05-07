# NVF Award Core

Backend core functions for the NEVERFLAT award system.

## Overview

This module provides internal functions for:

- CDR normalisation
- Rules-based reward logic calculation
- Award preparation and execution
- Spend validation and execution

Built for Polygon Amoy network integration with the NVF contract.

## Identifier Terminology

This project uses **contract ID** as the primary external identifier for a user.

For backward compatibility, parts of the codebase and schema still use the name `uid` (for example, helper names like `resolveUidToAddress` and the `users.uid` column). In this project, treat `uid` as the contract ID value.

If integrating with another platform, this identifier mapping can be reconfigured to match that system's canonical user key.

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
- ✅ **Event Listeners**: Real-time sync from contract to database
- ✅ **Comprehensive Tests**: 54 test cases across all modules, all passing
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

Build the container image and start the application with PostgreSQL:

```bash
docker compose up --build -d
```

This uses the included `docker-compose.yml` for both the API and PostgreSQL.

### Docker Secrets

The service supports a mounted secret file for the treasury private key via `TREASURY_SIGNER_KEY_FILE`.
In production, use your secret manager or Docker secrets to provide the key at runtime.

## Development Scripts

The `scripts/` directory contains development and testing utilities:

- `test-award-and-spend-debug.js` - End-to-end award and spend flow testing
- `test-approval-debug.js` - Manual approval testing
- `test-e2e-flow.js` - Complete end-to-end flow validation
- `test-full-flow.js` - Full system integration test

Run with: `node scripts/<script-name>.js`

## Demo UI

A Rabby-inspired demo frontend is available in `frontend/`.

Run API and UI in two terminals:

```bash
# Terminal 1 (API)
npm run api

# Terminal 2 (UI)
cd frontend
npm run dev
```

By default, the UI expects API at `http://localhost:3000` and supports `X-API-Key`.

## Identity And Test Modes

The user dashboard now supports two access modes:

- **Identity mode (EMP-ready)**: Uses API identity endpoints and resolves contract ID from request header (default `x-contract-id`)
- **Test mode (current integration fallback)**: Allows manual contract ID lookup for testing transactions and wallet flows before EMP is complete

### User Endpoints

- `GET /wallet/me` - Wallet for authenticated/forwarded identity context
- `POST /spend/me` - Spend for authenticated/forwarded identity context
- `GET /wallet/:uid` - Manual contract ID wallet lookup (legacy/test flow)
- `POST /spend` - Manual contract ID spend (legacy/test flow)

The UI attempts identity mode first. If no identity header is present, it automatically falls back to test mode.

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
# Treasury wallet address (holds SPARKZ tokens)
TREASURY_ADDRESS=0x605871D30DC278a036F09e2ace771df8a224624B

# Optional API key (recommended outside local development)
API_KEY=your_api_key_here

# Salt for deterministic contract ID->address mapping
USER_ADDRESS_DERIVATION_SALT=nvf-award-core-v1

# Identity header name used by /wallet/me and /spend/me
USER_IDENTITY_HEADER=x-contract-id

# Keep manual /wallet/:uid lookup enabled for testing
# Set to false when EMP identity integration is fully live
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
- `awarded_at` - Settlement timestamp

**balances** - Current user balances
- `id` - UUID primary key
- `user_id` - References users table
- `wallet_address` - Polygon address
- `balance` - Current SPARKZ balance
- `total_awarded` - Cumulative awarded
- `total_spent` - Cumulative spent
- `last_synced` - Last blockchain sync

### Real-time Sync

Event listeners automatically sync blockchain state to the database:

```typescript
import { startEventListener } from 'nvf-award-core';
import { ethers } from 'ethers';

const provider = new ethers.JsonRpcProvider(process.env.POLYGON_RPC_URL);
await startEventListener(provider);

// Now all Award and Spend events are synced to the database in real-time
```

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
const ocpiCDR = {
  SessionID: 'a1b09f5b-b75d-4c9e-aef2-4f0c74cc7623',
  ProviderID: 'DE-NWQ',
  EVSEID: 'DE*GUC*E*EZO*0877',
  "Session Start": '2026-02-16T02:00:00Z',  // Off-peak in DE
  "Session End": '2026-02-16T03:00:00Z',
  "Consumed Energy": '40',  // 40 kWh charged
  UID: '0475804AA47330',  // Contract ID from source payload - address auto-resolved from this
};

// Get treasury signer
const treasurySigner = await getTreasurySigner();

// Single function handles all stages:
// 1. Normalise CDR
// 2. Calculate tokens based on rules
// 3. Resolve contract ID (from UID field) -> Polygon address (creates if first time)
// 4. Execute on-chain token transfer
const result = await processAwardFromCDR(ocpiCDR, treasurySigner);

console.log(result);
// {
//   success: true,
//   eligible: true,
//   amount: 10,                  // 40 kWh / 4 = 10 SPARKZ
//   uid: '0475804AA47330',        // Contract ID (legacy field name)
//   dedupKey: 'a1b09f5b-...-DE-NWQ',
//   txHash: '0x123...',          // User received SPARKZ on-chain
//   stage: 'complete'
// }
```

### With Idempotency Checking

Prevent double-processing by checking if the session was already awarded:

```typescript
const treasurySigner = await getTreasurySigner();

const result = await processAwardFromCDR(
  ocpiCDR,
  treasurySigner,
  async (dedupKey) => {
    // Check your DB for existing award
    return await db.awards.exists(dedupKey);
  }
);

if (result.success && result.eligible) {
  // Mark as processed in your database
  await db.awards.create({ dedupKey: result.dedupKey, amount: result.amount });
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
  txHash: string;                // On-chain transaction hash (always present if settled)
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
   - Off-peak windows are country-specific and static
   - Example DE: 22:00 - 06:00
2. **V2G Discharge**: 1 SPARKZ per 1 kWh (always)

### Idempotency

Deduplication uses `(sessionId, providerId)` tuple to prevent double-awarding. The `getDeduplicationKey()` function generates this key for database lookups.

## Contract Details

- Network: Polygon Amoy
- Contract: NVF
- Token: SPARKZ
- Address: 0x605871D30DC278a036F09e2ace771df8a224624B
- Functions: `award(address to, uint256 amount)`, `spend(uint256 amount)`

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