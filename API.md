# NVF Award System - REST API Documentation

## Overview

The REST API exposes the core award and spend functionality through HTTP endpoints. All on-chain transactions are executed on Polygon Amoy testnet.

Identifier terminology: this project treats contract ID as the primary external user identifier. Some request/response fields and routes still use `UID` or `uid` naming for backward compatibility. In this API, those values represent contract ID.

User identity integration: EMP-ready endpoints are available via `GET /wallet/me` and `POST /spend/me`, which resolve contract ID from request header `x-contract-id` (configurable via `USER_IDENTITY_HEADER`).

**Status**: ✅ Core endpoints working | ⏳ Database logging (requires PostgreSQL)

## Getting Started

### Prerequisites
- Node.js 18+
- TREASURY_SIGNER_KEY configured in .env
- Optional: API_KEY configured in .env for authentication
- Optional: PostgreSQL for transaction history logging

### Start API Server

```bash
npm run api
```

Server starts on `http://localhost:3000`

### Authentication

All protected endpoints require the `X-API-Key` header (if API_KEY is configured in .env):

```bash
curl -H "X-API-Key: your_api_key_here" http://localhost:3000/wallet/user123
```

**Public endpoints** (no authentication required):
- `GET /ingest/health`

Leave `API_KEY` empty in .env for development (authentication disabled).

For pilot deployments, set a dedicated `INGEST_API_KEY` for AU/provider CDR
submission. When `INGEST_API_KEY` is configured, `POST /ingest/cdr` requires
`X-Ingest-API-Key` or `X-API-Key` to match that dedicated value. Other protected
endpoints continue to use `API_KEY`.

Admin login requires `ADMIN_EMAIL` and `ADMIN_PASSWORD`. There is no
hardcoded fallback password; if these variables are not set, `/admin/login`
returns a configuration error.

---

## API Endpoints

### Health Check

**GET** `/ingest/health`

Check if the service is operational.

**Response:**
```json
{
  "status": "ok",
  "timestamp": "2026-04-16T10:30:00.000Z"
}
```

---

### Preview CDR

**POST** `/ingest/cdr/preview`

Validate a CDR payload, normalise it, and apply reward rules without database
writes or on-chain token settlement. Use this for AU payload checks and safe
ingestion/rule performance evidence.

Requires the same ingest authentication as `/ingest/cdr`.

**Response:**
```json
{
  "status": "preview",
  "sideEffects": false,
  "eligible": true,
  "tokensAwarded": 3,
  "uid": "user-123",
  "dedupKey": "sess-12345-prov-DE",
  "normalised": {
    "sessionId": "sess-12345",
    "providerId": "prov-DE",
    "uid": "user-123",
    "evseId": "DE*ABC*E12345",
    "energyKWh": 40,
    "energyDirection": "CHARGE"
  }
}
```

---

### Ingest CDR

**POST** `/ingest/cdr`

Accept raw CDR data from charging network and process award if eligible.

Note: the CDR payload uses `UID` as a legacy key name. Provide your contract ID in this field.

**Request:**
```json
{
  "SessionID": "sess-12345",
  "ProviderID": "prov-DE",
  "EVSEID": "DE*ABC*E12345",
  "UID": "user-123",
  "Session Start": "2026-04-16T05:00:00Z",
  "Session End": "2026-04-16T05:30:00Z",
  "Consumed Energy": "40"
}
```

**Response (Accepted & Eligible):**
```json
{
  "status": "accepted",
  "SessionID": "sess-12345",
  "ProviderID": "prov-DE",
  "uid": "user-123",
  "eligible": true,
  "tokensAwarded": 10,
  "txHash": "0x...",
  "message": "10 SPARKZ awarded"
}
```

**Response (Duplicate):**
```json
{
  "status": "duplicate",
  "SessionID": "sess-12345",
  "ProviderID": "prov-DE",
  "message": "CDR already processed"
}
```

**Response (Not Eligible):**
```json
{
  "status": "accepted",
  "SessionID": "sess-12345",
  "ProviderID": "prov-DE",
  "eligible": false,
  "message": "CDR accepted but not eligible for reward"
}
```

---

### Session Spend Prompt

**POST** `/spend/session`

Returns SPARKZ wallet/session spend eligibility for a charging-session prompt.
This endpoint **does not spend tokens** and does not create a spend receipt.

Required header:
- `x-contract-id: <contract-id>` (or the header name configured in `USER_IDENTITY_HEADER`)

**Request:**
```json
{
  "sessionId": "spend-001",
  "providerId": "NF",
  "chargerId": "charger-001",
  "status": "PLUGGED_IN",
  "countryCode": "GB",
  "estimatedKwh": 12.5,
  "estimatedCost": 8.4
}
```

`status` must be one of:
- `CHARGER_OPENED`
- `PLUGGED_IN`
- `SESSION_STARTED`

**Response:**
```json
{
  "status": "success",
  "contractId": "000",
  "sessionId": "spend-001",
  "providerId": "NF",
  "chargerId": "charger-001",
  "sessionStatus": "PLUGGED_IN",
  "countryCode": "GB",
  "estimatedKwh": 12.5,
  "estimatedCost": 8.4,
  "wallet": {
    "availableBalance": 12.4,
    "totalEarned": 20,
    "totalSpent": 7.6,
    "mode": "managed"
  },
  "spend": {
    "eligible": true,
    "maxSpendable": 12.4,
    "suggestedAmount": 8.4,
    "label": "Charging discount",
    "message": "You have 12.40 SPARKZ available"
  },
  "recentActivity": [],
  "rewardRates": [
    {
      "key": "offPeakCharging",
      "label": "Off-peak charging",
      "enabled": true,
      "tokensPerKWh": 0.25,
      "kWhPerSparkz": 4,
      "description": "1 SPARKZ per 4 kWh"
    },
    {
      "key": "v2gDischarge",
      "label": "V2G discharge",
      "enabled": true,
      "tokensPerKWh": 1,
      "kWhPerSparkz": 1,
      "description": "1 SPARKZ per 1 kWh"
    }
  ]
}
```

Validation errors include `MISSING_REQUIRED_FIELDS`, `INVALID_SESSION_STATUS`,
`INVALID_ESTIMATED_KWH`, and `INVALID_ESTIMATED_COST`.

---

### Spend Tokens

**POST** `/spend`

Spend tokens from user's wallet. Treasury pays gas fees.
If settlement fails, the response uses a user-safe `error` message. Technical
chain/provider details are retained in admin audit metadata rather than being
shown to the user.

Note: request field `uid` is a legacy key name and should contain contract ID.

**Request:**
```json
{
  "uid": "user-123",
  "amount": 5,
  "sessionId": "spend-001",
  "providerId": "prov-DE",
  "label": "Charging discount"
}
```

**Response:**
```json
{
  "status": "success",
  "uid": "user-123",
  "sessionId": "spend-001",
  "providerId": "prov-DE",
  "tokensSpent": 5,
  "txHash": "0x...",
  "timestamp": "2026-04-16T10:30:00.000Z",
  "label": "Charging discount",
  "spendReceipt": {
    "payload": {
      "version": "1.0",
      "receiptId": "spr_...",
      "status": "settled",
      "contractId": "user-123",
      "walletAddress": "0x...",
      "amount": "5",
      "sessionId": "spend-001",
      "providerId": "prov-DE",
      "tokenTxHash": "0x...",
      "tokenContractAddress": "0x...",
      "chainId": 80002,
      "issuedAt": "2026-04-16T10:30:00.000Z"
    },
    "signature": "0x...",
    "signerAddress": "0x...",
    "canonicalPayload": "{\"amount\":\"5\",...}",
    "dbStored": true
  }
}
```

The `spendReceipt` is a backend-signed settlement proof for the frontend,
EMP, or settlement receiver. Receivers should verify `signature` over
`canonicalPayload` using `signerAddress`, then check that the receipt fields
match the expected charging session, token transaction, contract ID, amount,
token contract, and chain ID. The receipt is persisted in the
`spend_receipts` table when PostgreSQL is available.

Frontend integration note:
- The frontend does not create the NEVERFLAT signature.
- The frontend must keep the `spendReceipt` unchanged when forwarding it to the EMP/front-end owner system.
- If the frontend verifies the receipt, it must verify `signature` against `canonicalPayload` and `signerAddress`.
- If verification is handled by the receiver backend, the frontend should forward the full `spendReceipt` object exactly as returned.

---

### Verify Spend Receipt

**POST** `/spend-receipts/verify`

Verifies a backend-signed spend receipt. Requires `X-API-Key` when API key
authentication is enabled.

Request:
```json
{
  "payload": { "receiptId": "spr_...", "status": "settled" },
  "signature": "0x...",
  "signerAddress": "0x..."
}
```

Response:
```json
{
  "status": "valid",
  "valid": true,
  "signerAddress": "0x...",
  "receiptId": "spr_..."
}
```

---

### Custodial/User-Managed Wallet Spend Intent

**POST** `/spend/custodial-intent`

Builds the token transfer transaction that a user-managed wallet must sign. The
frontend should send `spendIntent.transaction` to the connected wallet. If the
wallet signing or submission fails, call `/spend/custodial-failure` with the
same amount/session details so the API records the failed attempt and returns
the same retryable intent.

Request:
```json
{
  "uid": "user-123",
  "walletAddress": "0x...",
  "amount": 5,
  "sessionId": "spend-001",
  "providerId": "prov-DE"
}
```

Response:
```json
{
  "status": "requires_signature",
  "uid": "user-123",
  "message": "Confirm this SPARKZ spend in your wallet.",
  "spendIntent": {
    "intentId": "csi_...",
    "contractId": "user-123",
    "walletAddress": "0x...",
    "amount": "5",
    "sessionId": "spend-001",
    "providerId": "prov-DE",
    "chainId": 80002,
    "tokenContractAddress": "0x...",
    "treasuryAddress": "0x...",
    "retryable": true,
    "transaction": {
      "from": "0x...",
      "to": "0x...",
      "value": "0",
      "data": "0x..."
    }
  }
}
```

**POST** `/spend/custodial-failure`

Records a failed custodial wallet signing/submission attempt and returns the
same deterministic `spendIntent` so the frontend can prompt the user to retry.
The user only needs to sign again; the frontend should not change amount,
session ID, provider ID, treasury address, token address, chain ID, or calldata.

---

### Get Wallet

**GET** `/wallet/:uid`

Query wallet balance and transaction history (last 10 transactions).

Note: route parameter `:uid` is a legacy name and should be populated with contract ID.

**Response:**
```json
{
  "uid": "user-123",
  "address": "0x1234567890123456789012345678901234567890",
  "balance": "50.00",
  "totalAwarded": "100.00",
  "totalSpent": "50.00",
  "history": [
    {
      "type": "spend",
      "label": "spend-001",
      "amount": "5.00",
      "txHash": "0x...",
      "timestamp": "2026-04-16T10:30:00.000Z",
      "status": "confirmed"
    },
    {
      "type": "award",
      "label": "sess-12345-prov-DE",
      "amount": "10.00",
      "txHash": "0x...",
      "timestamp": "2026-04-16T05:30:00.000Z",
      "status": "confirmed",
      "isOffPeak": true,
      "countryCode": "DE"
    }
  ]
}
```

---

### Get Recent Transactions

**GET** `/transactions?limit=10`

Get recent transactions across all users (default: 50, max: 500).

**Response:**
```json
{
  "status": "ok",
  "transactionCount": 10,
  "transactions": [
    {
      "type": "spend",
      "uid": "user-123",
      "walletAddress": "0x1234567890123456789012345678901234567890",
      "amount": "5.00",
      "txHash": "0x...",
      "sessionId": "spend-001",
      "timestamp": "2026-04-16T10:30:00.000Z",
      "status": "confirmed"
    }
  ]
}
```

---

### Get My Wallet (Identity Context)

**GET** `/wallet/me`

Returns wallet details for the authenticated/forwarded user identity.

Required header:
- `x-contract-id: <contract-id>` (or the header name configured in `USER_IDENTITY_HEADER`)

Response:
```json
{
  "status": "success",
  "uid": "user-123",
  "contractIds": ["user-123"],
  "linkedWalletAddresses": [],
  "linkedWallets": [],
  "walletName": null,
  "walletAddress": "0x...",
  "managedWalletAddress": "0x...",
  "walletMode": "managed",
  "isRegistered": true,
  "balance": "12.40",
  "totalAwarded": "20.00",
  "totalSpent": "7.60",
  "treasuryAddress": "0x...",
  "tokenContractAddress": "0x...",
  "history": []
}
```

BEIA should call this with the logged-in app user's UID as `x-contract-id`.
The SPARKZ React package uses this endpoint for the unplugged/account view.

---

### Spend Tokens (Identity Context)

**POST** `/spend/me`

Reserves SPARKZ for the authenticated user's charging session without passing
`uid` in the body. This does not transfer tokens. When the matching final CDR is
ingested, NEVERFLAT settles `min(reserved SPARKZ, delivered kWh)` at `1 SPARKZ =
1 kWh` and releases the remainder.

The EMP supplies CDR data through the Aarhus database, while settlement data
must travel from NEVERFLAT through BEIA to the EMP. The CDR-processing response
is therefore not the delivery channel. A BEIA-facing reservation-status API is
required so BEIA can retrieve and forward the final settlement. That read API
is not yet implemented.

Required header:
- `x-contract-id: <contract-id>` (or the header name configured in `USER_IDENTITY_HEADER`)

Request example:
```json
{
  "amount": 5,
  "sessionId": "spend-001",
  "providerId": "prov-DE",
  "label": "Charging discount"
}
```

---

### Link Browser Wallet For Custodial Mode

**POST** `/wallet/:uid/linked-wallets`

Links an external blockchain wallet to the contract ID after the user signs a
message in an installed wallet such as MetaMask or Rabby.

Route parameter:
- `:uid` is the contract ID value.

Request:
```json
{
  "walletAddress": "0x...",
  "signature": "0x..."
}
```

The signature must recover to `walletAddress` over this exact message:

```text
NEVERFLAT link wallet address
EMP contract: <contractId>
Wallet address: <checksumWalletAddress>
```

Response is the wallet payload from `/wallet/me`, focused on the linked wallet.

---

### Switch Wallet Mode

**POST** `/wallet/:uid/mode`

Switches the active wallet mode between the deterministic NEVERFLAT managed
wallet and a signed/linked custodial wallet.

Route parameter:
- `:uid` is the contract ID value.

Request for managed mode:
```json
{
  "mode": "managed"
}
```

Request for custodial mode:
```json
{
  "mode": "custodial",
  "walletAddress": "0x...",
  "allowSplit": true
}
```

Important: BEIA/frontends must not switch to custodial mode based on a typed
address alone. First request a wallet signature and link the address using
`POST /wallet/:uid/linked-wallets`, then call this endpoint.

If `allowSplit` is omitted and the source wallet has a balance, the endpoint can
return `409 SOURCE_WALLET_HAS_BALANCE` so the UI can ask whether to move funds
or continue with balances split across wallets.

---

## Database Logging

### Current Status
- ✅ On-chain transactions work
- ⏳ Database logging requires PostgreSQL setup

### Enable Database Logging

1. **Start PostgreSQL** (via Docker or local installation):
   ```bash
   docker-compose up -d postgres
   ```

2. **Run migrations**:
   ```bash
   npm run db:migrate
   ```

3. **Verify connection**:
   ```bash
   psql $DATABASE_URL -c "SELECT version();"
   ```

### Verify Logging

After processing awards/spends with a working database:

```bash
# Query awards
psql $DATABASE_URL -c "SELECT * FROM awards ORDER BY created_at DESC LIMIT 10;"

# Query spends
psql $DATABASE_URL -c "SELECT * FROM spends ORDER BY created_at DESC LIMIT 10;"

# Query user balances
psql $DATABASE_URL -c "SELECT uid, balance, total_awarded, total_spent FROM users JOIN balances ON users.id = balances.user_id;"
# `uid` column is the contract ID value (legacy column name)
```

---

## Award Rules

Tokens are awarded based on:

1. **Off-Peak Charging** (22:00-06:00)
   - 0.25 tokens per kWh (= 1 token per 4 kWh)
   - Only awarded during off-peak hours in the charging location's country

2. **V2G Discharge** (Vehicle-to-Grid)
   - 1 token per kWh
   - No time restriction

### Supported Countries
- **DE** (Germany): 22:00-06:00
- **ES** (Spain): 22:00-06:00
- **RO** (Romania): 22:00-06:00

To add more countries, edit [src/config/offPeakWindows.ts](./src/config/offPeakWindows.ts)

---

## Error Handling

All endpoints return structured error responses:

```json
{
  "status": "error",
  "error": "Error message describing what went wrong"
}
```

### Common Errors

| Error | Cause | Solution |
|-------|-------|----------|
| `Missing required fields` | CDR missing SessionID, ProviderID, or contract ID (field `UID`) | Verify CDR format |
| `invalid signature` | Treasury key doesn't match address | Check TREASURY_SIGNER_KEY config |
| `insufficient allowance` | User hasn't approved treasury for spend | Requires on-chain approval first |
| `Database not available` | PostgreSQL not running | Start DB: `docker-compose up -d postgres` |

---

## Example Flow: Award & Spend

### 1. Award tokens (via CDR ingestion)
```bash
curl -X POST http://localhost:3000/ingest/cdr \
  -H "Content-Type: application/json" \
  -d '{
    "SessionID": "sess-001",
    "ProviderID": "prov-DE",
    "EVSEID": "DE*ABC*E12345",
    "UID": "user-flow-test",
    "Session Start": "2026-04-15T23:00:00Z",
    "Session End": "2026-04-15T23:30:00Z",
    "Consumed Energy": "40"
  }'
```

Response:
```json
{
  "status": "accepted",
  "tokensAwarded": 10,
  "txHash": "0x..."
}
```

### 2. Check wallet balance
```bash
curl http://localhost:3000/wallet/user-flow-test
```

Response shows 10 tokens awarded.

### 3. Spend tokens
```bash
curl -X POST http://localhost:3000/spend \
  -H "Content-Type: application/json" \
  -d '{
    "uid": "user-flow-test",
    "amount": 5,
    "label": "Discount"
  }'
```

Response:
```json
{
  "status": "success",
  "tokensSpent": 5,
  "txHash": "0x..."
}
```

### 4. Verify final balance
```bash
curl http://localhost:3000/wallet/user-flow-test
```

Response shows balance: 5 SPARKZ (10 awarded - 5 spent).

The spend response also includes a signed `spendReceipt` that can be forwarded
to the EMP/front-end owner system as proof of settlement.

---

## Admin Audit Events

**GET** `/admin/audit?limit=100&status=error&eventType=spend.failed`

Returns recent append-only audit events. Requires an admin bearer token from
`POST /admin/login`.

Audit events are written for spend completion, signed spend receipt creation
or persistence failure, custodial spend recording, wallet mode changes, admin
login/logout attempts, admin reward-rule/off-peak-window changes, and treasury
gas warnings.

Optional filters:
- `status` - for example `success`, `error`, `retry_required`, or `duplicate`.
- `eventType` - for example `award.failed`, `spend.failed`, or `spend_receipt.created`.

Operational failure events include:
- `award.validation_failed`
- `award.failed`
- `award.unhandled_error`
- `spend.validation_failed`
- `spend.auto_approval_failed`
- `spend.failed`
- `spend.unhandled_error`
- `spend.custodial_validation_failed`
- `spend.custodial_unhandled_error`
- `treasury.gas_low`
- `treasury.gas_check_failed`

Treasury MATIC warnings are admin/operator issues. Configure
`TREASURY_GAS_WARNING_THRESHOLD_MATIC` to set the warning threshold, then query
`GET /admin/audit?eventType=treasury.gas_low` to see low-gas warnings. All
other award/spend failures should be surfaced to users with the API response's
user-safe `error` or `message` text.

Admin alert delivery:
- Set `ADMIN_EMAIL` as the registered admin login and alert recipient.
- Set `ADMIN_ALERT_WEBHOOK_URL` to an email/notification service endpoint.
- The API sends alert JSON for `warning`, `retry_required`, and selected `error`
  audit events, and writes `admin_alert.delivered`, `admin_alert.delivery_failed`,
  or `admin_alert.delivery_skipped` audit events as delivery evidence.
- Use `POST /admin/alerts/test` to send a manual test alert and create audit
  evidence that the alert path was delivered or skipped.

**Response:**
```json
{
  "status": "ok",
  "count": 1,
  "events": [
    {
      "event_type": "spend_receipt.created",
      "actor_type": "system",
      "actor_id": "api",
      "target_type": "spend_receipt",
      "target_id": "spr_...",
      "status": "success",
      "metadata": {
        "uid": "user-123",
        "amount": "5",
        "sessionId": "spend-001",
        "providerId": "prov-DE",
        "tokenTxHash": "0x..."
      },
      "created_at": "2026-04-16T10:30:00.000Z"
    }
  ]
}
```

Validation errors include:
- `MISSING_SESSION_ID`
- `MISSING_PROVIDER_ID`
- `INVALID_AMOUNT`
- `INSUFFICIENT_SPARKZ`

Successful response:
```json
{
  "status": "success",
  "uid": "user-123",
  "sessionId": "spend-001",
  "providerId": "prov-DE",
  "tokensSpent": 5,
  "txHash": "0x...",
  "timestamp": "2026-04-16T10:30:00.000Z",
  "label": "Charging discount",
  "spendReceipt": {
    "payload": {
      "receiptId": "spr_...",
      "status": "settled",
      "contractId": "user-123",
      "amount": "5",
      "tokenTxHash": "0x..."
    },
    "signature": "0x...",
    "signerAddress": "0x...",
    "canonicalPayload": "{\"amount\":\"5\",...}",
    "dbStored": true
  }
}
```

OpenAPI/Swagger note: the live Swagger spec is embedded in `src/api.ts` and is
served by the API at `/openapi.json`, `/api-docs`, and `/docs`. Keep this
document and the embedded spec in sync when endpoints change.

---

## Admin Reconciliation

**GET** `/admin/pilot-metrics?hours=24`

Returns audit-derived pilot activity metrics for the requested rolling window
between 1 and 168 hours. Requires an admin bearer token from `POST
/admin/login`. The admin dashboard displays the default 24-hour view.

Response:
```json
{
  "status": "ok",
  "metrics": {
    "windowHours": 24,
    "totalEvents": 42,
    "awards": {
      "completed": 18,
      "notEligible": 3,
      "duplicates": 1,
      "failures": 0
    },
    "spends": {
      "completed": 6,
      "custodialRecorded": 2,
      "custodialIntentsCreated": 2,
      "retryRequired": 1,
      "failures": 0
    },
    "operations": {
      "warnings": 1,
      "errors": 0,
      "retryRequired": 1,
      "deliveredAlerts": 1,
      "skippedAlerts": 0,
      "reconciliationRuns": 1
    }
  }
}
```

**GET** `/admin/readiness`

Returns pilot readiness checks for deployment evidence. Requires an admin bearer
token from `POST /admin/login`.

Response:
```json
{
  "status": "ready_with_warnings",
  "failedCount": 0,
  "warningCount": 1,
  "checks": [
    {
      "key": "admin_alerts",
      "label": "Admin alert delivery",
      "status": "warn",
      "message": "ADMIN_ALERT_WEBHOOK_URL is not configured; alerts will be audited but not sent"
    }
  ]
}
```

**POST** `/admin/alerts/test`

Sends a manual test alert through the configured admin alert path. Requires an
admin bearer token from `POST /admin/login`.

Response:
```json
{
  "status": "sent_or_queued",
  "message": "Test alert sent to configured admin alert webhook.",
  "adminEmailConfigured": true,
  "webhookConfigured": true
}
```

**GET** `/admin/evidence-pack`

Exports a point-in-time TRL7 evidence snapshot as JSON. Requires an admin bearer
token from `POST /admin/login`. The admin dashboard also exposes this as
**Export Evidence**.

The export includes readiness checks, pilot configuration flags, token/treasury
identifiers, latest reconciliation report, 24-hour pilot metrics,
retry-required audit events, warnings, errors, and delivered-alert audit events.

**POST** `/admin/reconciliation/run`

Runs a DB-vs-chain wallet balance reconciliation. Requires an admin bearer
token from `POST /admin/login`. The endpoint reads registered users, compares
the database balance with `balanceOf(walletAddress)` on the configured token
contract, stores a report, and writes an audit event.

Request:
```json
{
  "limit": 500
}
```

Response:
```json
{
  "status": "ok",
  "report": {
    "status": "matched",
    "checked_count": 25,
    "matched_count": 25,
    "mismatch_count": 0,
    "items": [
      {
        "uid": "user-123",
        "walletAddress": "0x...",
        "dbBalance": "5.00",
        "chainBalance": "5.000000",
        "difference": "0.000000",
        "status": "matched"
      }
    ]
  }
}
```

**GET** `/admin/reconciliation?limit=20`

Returns recent reconciliation reports, including the latest report.

---

## Transaction Lifecycle States

Award and spend history records include a `status` field. Existing successful
records are treated as `confirmed`.

Current states:
- `confirmed` - on-chain transaction succeeded and the database mirror was written.

Reserved future states for retry/recovery work:
- `accepted` - request accepted before chain submission.
- `submitted` - transaction submitted but not yet confirmed.
- `failed` - transaction or persistence failed.
- `retry_required` - operator or worker should retry settlement/reconciliation.

The database also stores `confirmed_at` and `error_message` on award and spend
records so later retry/reconciliation workers can use the same schema.

---

## On-Chain Details

All transactions execute on **Polygon Amoy Testnet**:

- **Network**: Polygon Amoy
- **RPC**: https://rpc-amoy.polygon.technology/
- **SPARKZ Token**: 0x605871D30DC278a036F09e2ace771df8a224624B
- **Explorer**: https://amoy.polygonscan.com/

View transactions:
```
https://amoy.polygonscan.com/tx/{txHash}
```

---

## Configuration

All settings in `.env`:

```env
# Treasury wallet for signing transactions
TREASURY_ADDRESS=0x...
TREASURY_SIGNER_KEY=...
TREASURY_GAS_WARNING_THRESHOLD_MATIC=0.05
ADMIN_EMAIL=admin@example.com
ADMIN_ALERT_WEBHOOK_URL=https://alerts.example.com/neverflat

# Database (optional, for transaction history)
DATABASE_URL=postgres://...

# API server port
PORT=3000

# Identity header name used by /wallet/me and /spend/me
USER_IDENTITY_HEADER=x-contract-id

# Keep manual /wallet/:uid lookup for testing (set false in locked-down prod)
ENABLE_TEST_UID_LOOKUP=true
```

See [.env.example](./.env.example) for full reference.

---

## Support

- **Issues**: Check [GitHub](./README.md) for open issues
- **Logs**: Enable debug mode: `DEBUG=* npm run api`
- **Tests**: `npm test`
