# NVF Award Core - Deployment Guide

This guide covers deploying the NVF Award Core service on your company's server (e.g., Zentrix).

Identifier terminology: this project uses contract ID as the primary external user identifier. Some API fields and route names still use UID or uid for backward compatibility. In this project, those values represent contract ID.

## Prerequisites

- Node.js 16+ and npm
- PostgreSQL 12+
- Polygon testnet wallet with MATIC for gas
- SPARKZ tokens for awards (ERC20)

## Configuration

### 1. Environment Variables

Create a `.env` file with the following required settings:

```bash
# API Security - Set a strong API key for production
API_KEY=your_production_secret_api_key_here

# Treasury Wallet
TREASURY_ADDRESS=0x3c67B7754EEAe43BAEc8ab82E8Dfc793B8A90C41
# Use a secure secret for production, not a plain .env value
# TREASURY_SIGNER_KEY=your_treasury_private_key_here
# Or mount a secret file instead:
# TREASURY_SIGNER_KEY_FILE=/run/secrets/treasury_signer_key

# User Address Derivation
USER_ADDRESS_DERIVATION_SALT=nvf-award-core-v1

# Database Connection
DATABASE_URL=postgres://user:password@localhost:5432/nvf_award

# Optional: Port (defaults to 3000)
PORT=3000

# Identity header forwarded by EMP gateway/app
USER_IDENTITY_HEADER=x-contract-id

# Allow manual /wallet/:uid lookups for testing only
ENABLE_TEST_UID_LOOKUP=true
```

### 1a. Secret file support

This service supports loading the treasury private key from a mounted secret file using `TREASURY_SIGNER_KEY_FILE`.
This is the recommended production pattern when using Docker secrets or a secrets manager that writes a file into the container.

Example in Docker Compose:

```yaml
services:
  app:
    secrets:
      - treasury_signer_key
    environment:
      - TREASURY_SIGNER_KEY_FILE=/run/secrets/treasury_signer_key
secrets:
  treasury_signer_key:
    external: true
```

If `TREASURY_SIGNER_KEY` is set directly, that value will be used instead.

**Security Notes:**
- Never commit `.env` file to version control
- Use strong, random API keys in production (e.g., `openssl rand -base64 32`)
- Treasury private key should be stored securely (e.g., environment variable in deployment platform, not in files)

### 2. Database Setup

The service uses PostgreSQL for state mirroring:

```bash
# Create database
createdb -U postgres nvf_award

# Run migrations (automatic on first startup or manual)
npm run db:migrate
```

**Database Tables:**
- `users` - User accounts with wallet addresses
- `awards` - Token awards from charging sessions
- `spends` - Token spending transactions
- `balances` - Current balances and totals per user

## Running the Service

### Development

```bash
npm install
npm run build
npm run api
```

Server will start on `http://localhost:3000` (or configured PORT)

### Production

```bash
npm install --production
npm run build
node dist/api.js
```

For production deployment via PM2 or similar:

```bash
PM2_INSTANCES=4 pm2 start dist/api.js --name "nvf-award-core"
```

## API Authentication

All protected endpoints require the `X-API-Key` header:

```bash
curl -X GET http://localhost:3000/wallet/user123 \
  -H "X-API-Key: your_api_key_here"
```

**Public Endpoints** (no authentication):
- `GET /ingest/health` - Health check

**Protected Endpoints** (require X-API-Key):
- `POST /ingest/cdr` - Award tokens from charging session
- `POST /spend` - Request token spending
- `POST /spend/me` - Spend for authenticated identity context (EMP integration)
- `GET /wallet/:uid` - Get wallet balance and history (`:uid` is legacy naming for contract ID)
- `GET /wallet/me` - Get wallet for authenticated identity context (EMP integration)
- `GET /transactions` - Get recent transactions

### Disabling Authentication (Development Only)

Leave `API_KEY` empty in .env to disable authentication (useful for development):

```bash
# .env
# API_KEY=     # Empty = no authentication required
```

## API Endpoints

### 1. Award Tokens

```bash
POST /ingest/cdr
Content-Type: application/json
X-API-Key: your_api_key

{
  "SessionID": "session-123",
  "ProviderID": "provider-456",
  "UID": "contract-123",
  "EVSEID": "DE*ABC*E*001",
  "StartTime": "2026-04-20T10:00:00Z",
  "EndTime": "2026-04-20T11:00:00Z",
  "EnergyKWh": 10,
  "EnergyDirection": "CHARGE"
}
```

Note: UID is a legacy request field name. Pass contract ID in this field.

**Response:**
```json
{
  "status": "success",
  "uid": "contract-123",
  "dedupKey": "session-123:provider-456",
  "awarded": true,
  "amount": 2.5,
  "txHash": "0x...",
  "timestamp": "2026-04-20T11:05:00Z"
}
```

Note: uid in responses is a legacy field name and contains contract ID.

### 2. Spend Tokens

```bash
POST /spend
Content-Type: application/json
X-API-Key: your_api_key

{
  "uid": "contract-123",
  "amount": 10,
  "sessionId": "spend-session-789",
  "providerId": "provider-456",
  "label": "Vehicle charging"
}
```

**Response:**
```json
{
  "status": "success",
  "uid": "contract-123",
  "tokensSpent": 10,
  "txHash": "0x...",
  "timestamp": "2026-04-20T11:10:00Z"
}
```

### 3. Get Wallet Info

```bash
GET /wallet/contract-123
X-API-Key: your_api_key
```

**Response:**
```json
{
  "status": "success",
  "uid": "contract-123",
  "walletAddress": "0x...",
  "balance": "50.25",
  "totalAwarded": "100.00",
  "totalSpent": "49.75",
  "history": [
    {
      "type": "award",
      "amount": "10.00",
      "awardType": "OFF_PEAK_CHARGING",
      "timestamp": "2026-04-20T11:05:00Z",
      "txHash": "0x..."
    },
    {
      "type": "spend",
      "amount": "10.00",
      "timestamp": "2026-04-20T11:10:00Z",
      "txHash": "0x..."
    }
  ]
}
```

### 4. Get Recent Transactions

```bash
GET /transactions?limit=50
X-API-Key: your_api_key
```

**Response:**
```json
{
  "status": "success",
  "total": 150,
  "count": 50,
  "awards": [
    {
      "uid": "contract-001",
      "amount": "10.00",
      "awardType": "OFF_PEAK_CHARGING",
      "timestamp": "2026-04-20T11:05:00Z"
    }
  ],
  "spends": [
    {
      "uid": "contract-001",
      "amount": "10.00",
      "timestamp": "2026-04-20T11:10:00Z"
    }
  ]
}
```

## Monitoring

### Health Check

```bash
curl http://localhost:3000/ingest/health
# Response: { "status": "ok", "timestamp": "..." }
```

### Database Queries

Check awards and spends via PostgreSQL:

```bash
# Recent awards
psql -U postgres -d nvf_award -c \
  "SELECT users.uid, awards.amount, awards.award_type, awards.created_at \
   FROM awards JOIN users ON awards.user_id = users.id \
   ORDER BY awards.created_at DESC LIMIT 10;"

# User balance
psql -U postgres -d nvf_award -c \
  "SELECT uid, balance, total_awarded, total_spent \
   FROM users JOIN balances ON users.id = balances.user_id;"

# Note: users.uid column stores contract ID (legacy column name)
```

## Troubleshooting

### API Key Errors

```
Missing API key: X-API-Key header required
```
→ Add `X-API-Key` header to request

```
Invalid API key
```
→ Check API_KEY in .env matches header value

### Database Connection Errors

```
Error: connect ECONNREFUSED
```
→ Verify PostgreSQL is running and DATABASE_URL is correct

```
Error: password authentication failed
```
→ Check DATABASE_URL credentials

### Out of Gas

```
Error: insufficient funds for gas
```
→ Fund treasury wallet with MATIC for gas fees

## Security Checklist

- [ ] API_KEY set to strong random value in production
- [ ] TREASURY_SIGNER_KEY stored securely (not in code)
- [ ] DATABASE_URL uses strong password
- [ ] SSL/HTTPS enabled for API endpoints
- [ ] Firewall restricts access to PostgreSQL (not public)
- [ ] Logs do not expose sensitive data
- [ ] Regular backups of PostgreSQL database
- [ ] Monitor gas spend on treasury wallet

## Scaling

For high-volume deployments:

1. **Load Balancing**: Use nginx/HAproxy to distribute requests
2. **Database**: Use read replicas for queries, primary for writes
3. **Caching**: Add Redis for frequent wallet queries
4. **Rate Limiting**: Implement API rate limiting per key
5. **Async Processing**: Move approval transactions to background queue
