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

### Spend Tokens

**POST** `/spend`

Spend tokens from user's wallet. Treasury pays gas fees.

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
  "label": "Charging discount"
}
```

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
      "timestamp": "2026-04-16T10:30:00.000Z"
    },
    {
      "type": "award",
      "label": "sess-12345-prov-DE",
      "amount": "10.00",
      "txHash": "0x...",
      "timestamp": "2026-04-16T05:30:00.000Z",
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
      "amount": "5.00",
      "txHash": "0x...",
      "timestamp": "2026-04-16T10:30:00.000Z"
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

---

### Spend Tokens (Identity Context)

**POST** `/spend/me`

Spends from the authenticated/forwarded user's wallet without passing `uid` in the body.

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
