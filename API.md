# NEVERFLAT SPARKZ API

**Documentation status:** the deployed main baseline is merge commit
`87b35bdf4e0d9bde7b4d8c4cbb93ab459b0f321a` (PR #6, 6 October 2026). This
release-fixes branch contains follow-up deployment, package, migration, and
active-wallet changes prepared for Zentrix `development` and awaiting Dejan's
promotion to `main`; those changes are outside the verified baseline until a
separate deployment acceptance record. This file does not confirm target
credentials, database contents, RPC availability, or live post-start checks.

The machine-readable contract is served by the same build at `GET /openapi.json`
and by the `/docs` and `/api-docs` aliases. Keep this document and the embedded
OpenAPI document in `src/api.ts` together when an endpoint changes.

The local candidate was exercised with a disposable PostgreSQL database,
Hardhat chain 31337, and a child API process. The finite HTTP contract matrix
made 178 requests with 178 passing cases; the separate admin matrix passed
199/199. Full Jest finished with 321 passing tests and 6 opt-in tests skipped,
the disposable PostgreSQL checks passed 15 tests, and the local
award-flow/reliability harness passed. The [local release verification
record](docs/RELEASE_VERIFICATION_2026-10-01.md) consolidates the safe result
summary. These are dated historical local evidence for the earlier candidate,
not deployment approval or acceptance evidence for the development follow-up.

## 1. Identity and authentication

### eMAID is the owner identity

The canonical internal ownership identifier is **eMAID**. Existing wire,
database, and route names are retained for compatibility:

| Wire or route name | Meaning in this API |
| --- | --- |
| `contract_id` | OCPI token contract identity; becomes eMAID. |
| `EvcoID` | OICP contract identity; becomes eMAID. |
| `contractId`, `x-contract-id`, `uid` | Existing API compatibility names whose value must be the eMAID. |
| token `uid` or RFID `UID` | Non-owning protocol metadata only. It never derives a wallet or award owner. |

OCPI ownership is read from `cdr_token.contract_id`. OICP ownership is read
from every present supported identity field:

```text
Identification.RemoteIdentification.EvcoID
Identification.QRCodeIdentification.EvcoID
Identification.PlugAndChargeIdentification.EvcoID
Identification.RFIDIdentification.EvcoID
```

All present OICP identity fields must agree. A payload containing only a UID,
missing eMAID, or conflicting identity values is rejected or quarantined with
a structured error. Protocol detection is automatic from payload shape; there
is no request or admin switch between eMAID and ContractID.

The normaliser metadata returned by preview and ingestion is shaped like this:

```json
{
  "eMAID": "DE*EMP*E123456",
  "emaid": "DE*EMP*E123456",
  "protocol": "OCPI",
  "sourceField": "cdr_token.contract_id",
  "chargingSessionId": "physical-session-123",
  "tokenMetadata": { "uid": "rfid-or-token-value", "type": "RFID" }
}
```

`tokenMetadata` is optional and non-owning. `chargingSessionId` is present only
when an explicit OCPI `id` plus standard `session_id` pair supplies physical
session provenance. A later CDR with a different CDR id for the same provider
and physical session fails closed with a review-required collision; it cannot
create a replacement award. Legacy records without that explicit pair retain
their original CDR-key behaviour.

Validation failures expose a safe, useful shape:

```json
{
  "status": "error",
  "code": "INVALID_CDR",
  "message": "eMAID is required for ownership; UID-only CDRs are rejected and may only be quarantined as non-owning token metadata",
  "normalisationError": {
    "code": "UID_ONLY",
    "protocol": "OICP",
    "sourceFields": ["Identification.RFIDIdentification.UID"]
  }
}
```

The `sourceFields` and `protocol` values are diagnostic provenance. They do not
turn a UID into an owner. The other normalisation codes are
`INVALID_PAYLOAD`, `MISSING_EMAID`, `CONFLICTING_IDENTIFIERS`, and
`INVALID_EMAID`.

### Authentication boundaries

| Boundary | Header or credential | Applies to |
| --- | --- | --- |
| General API | `X-API-Key` matching `API_KEY` or `BEIA_API_KEY`, or a valid admin bearer session | Wallet, spend, receipt, and transaction routes. |
| CDR ingestion | `X-Ingest-API-Key` or `X-API-Key` matching `INGEST_API_KEY`; configured `BEIA_API_KEY` is also accepted. A valid admin bearer session is accepted. If no dedicated ingest key is configured, the configured `API_KEY`/`BEIA_API_KEY` is used. | CDR preview and ingestion. |
| Identity context | `x-contract-id` (or `USER_IDENTITY_HEADER`) | `/wallet/me`, `/spend/session`, `/spend/me`, reservation approval/status. The value is an eMAID, not a credential. |
| Admin | `Authorization: Bearer <token>` returned by `POST /admin/login` | `/admin/*`, including the mounted operations router. |
| Public | No credential | Health, OpenAPI, and documentation aliases; admin login itself is public. |

In a non-production local process with no API key configured, the source allows
the general API-key guard to be bypassed for local development. A deployed
environment must configure its keys. Admin login has no hardcoded password and
returns a configuration error if its registered email/password variables are
missing. Never put API keys, treasury keys, or receipt-signing material in a
browser bundle; a trusted BEIA server proxy should add the upstream key.

Every protected response must be checked for both HTTP status and the safe JSON
error shape. Raw SQL, stack traces, provider/RPC messages, URLs, keys, and
database credentials stay in server diagnostics, not responses.

## 2. Route inventory

The current source has 41 concrete method/path combinations. Express also
provides generated `HEAD` behaviour for GET routes and CORS `OPTIONS` handling;
the frontend build conditionally adds `GET *` as an HTML fallback. The table is
the contract inventory used by the local matrix.

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/openapi.json` | Public | Machine-readable OpenAPI contract. |
| GET | `/api-docs` | Public | Documentation alias. |
| GET | `/docs` | Public | Documentation alias. |
| GET | `/ingest/health` | Public | Liveness response. |
| POST | `/spend-receipts/verify` | API key | Verify a signed spend receipt under the configured signer. |
| POST | `/ingest/cdr/preview` | Ingest key | Validate, normalise, and calculate without writes or chain settlement. |
| POST | `/ingest/cdr` | Ingest key | Process a final CDR and award if eligible. |
| POST | `/spend/session` | API key + eMAID | Read-only session spend prompt and persisted policy rates. |
| POST | `/spend` | API key | Direct managed-wallet spend with a stable idempotency key or existing recovery key. |
| POST | `/spend/reservation-approval-intent` | API key + eMAID | Build an external-wallet approval intent for a reservation. |
| POST | `/spend/me` | API key + eMAID | Create or replay an eMAID-scoped charging reservation. |
| GET | `/spend/reservations/:reservationId` | API key + eMAID | Read reservation and final receipt/settlement state. |
| POST | `/wallet/:uid/mode` | API key | Switch managed/custodial wallet mode. |
| PATCH | `/wallet/:uid/profile` | API key | Save the active wallet display name/address association. |
| POST | `/wallet/:uid/contract-ids` | API key | Link another eMAID to the same wallet. |
| POST | `/wallet/:uid/linked-wallets` | API key | Link an external wallet after signature proof. |
| PATCH | `/wallet/:uid/linked-wallets/:walletAddress/profile` | API key | Name or clear a linked wallet. |
| DELETE | `/wallet/:uid/linked-wallets/:walletAddress` | API key | Unlink an external wallet after signature proof. |
| POST | `/wallet/:uid/move-funds` | API key | Move managed-wallet funds to a validated target address. |
| POST | `/spend/custodial-intent` | API key | Build a user-signed custodial spend intent. |
| POST | `/spend/custodial-failure` | API key | Record a user-wallet failure and preserve/rebuild intent context. |
| POST | `/spend/custodial-record` | API key | Record a confirmed custodial transfer after evidence validation. |
| GET | `/wallet/me` | API key + eMAID | Identity-context wallet response. |
| GET | `/wallet/:uid` | API key + local lookup gate | Legacy/manual wallet lookup; disable `ENABLE_TEST_UID_LOOKUP` in a locked-down deployment. |
| GET | `/transactions` | API key | Recent transaction history. |
| POST | `/admin/login` | Public | Create an admin bearer session. |
| POST | `/admin/logout` | Admin bearer | Record admin logout. |
| GET | `/admin/rules` | Admin bearer | Load durable reward policy and revision. |
| PUT | `/admin/rules` | Admin bearer | Update supported reward rates/enablement. |
| GET | `/admin/off-peak` | Admin bearer | Load durable country windows and revision. |
| GET | `/admin/audit` | Admin bearer | Safe allowlisted operational audit events. |
| GET | `/admin/pilot-metrics` | Admin bearer | Audit-derived pilot metrics. |
| GET | `/admin/readiness` | Admin bearer | Readiness checks and warnings. |
| POST | `/admin/alerts/test` | Admin bearer | Exercise configured alert delivery and record result. |
| GET | `/admin/evidence-pack` | Admin bearer | Export a point-in-time evidence snapshot. |
| POST | `/admin/reconciliation/run` | Admin bearer | Run DB-versus-chain reconciliation. |
| GET | `/admin/reconciliation` | Admin bearer | List stored reconciliation reports. |
| PUT | `/admin/off-peak` | Admin bearer | Replace country windows. |
| DELETE | `/admin/off-peak/:countryCode` | Admin bearer | Remove one country window. |
| GET | `/admin/operations` | Admin bearer | List durable operation recovery eligibility. |
| POST | `/admin/operations/recover` | Admin bearer | Recover/project one existing operation by server-resolved key. |

Unknown API methods and paths return a structured not-found/method error. When
the frontend build is present, an unknown **GET** can instead be served by the
conditional frontend `GET *` fallback as HTML; API clients should use the
documented JSON routes and inspect the response content type. Public
documentation routes do not establish API authentication.

## 3. CDR ingestion and normalisation

### `POST /ingest/cdr/preview`

The request accepts the canonical NEVERFLAT shape, standard OCPI CDR shape, or
supported native OICP shape. Preview runs the same validation, protocol
detection, identity normalisation, timezone/rule calculation, and reward
calculation as ingestion, but returns `sideEffects: false` on success and does
not create a financial row, reservation, or token transfer. A validation
failure may still create an allowlisted audit event. Preview does not claim an
ingestion deduplication claim; use `/ingest/cdr` for the full durable ingest
path.

Canonical example:

```json
{
  "SessionID": "session-001",
  "ProviderID": "provider-de",
  "cdr_token": { "contract_id": "DE*EMP*E123456", "uid": "non-owning-token" },
  "EVSEID": "DE*ABC*E001",
  "StartTime": "2026-09-30T05:00:00.000Z",
  "EndTime": "2026-09-30T06:00:00.000Z",
  "Energy": "12",
  "EnergyDirection": "CHARGE"
}
```

OCPI example:

```json
{
  "id": "cdr-001",
  "session_id": "physical-session-001",
  "country_code": "DE",
  "party_id": "NF",
  "cdr_token": { "contract_id": "DE*EMP*E123456", "uid": "token-only-metadata" },
  "cdr_location": { "evse_id": "DE*ABC*E001" },
  "start_date_time": "2026-09-30T05:00:00.000Z",
  "end_date_time": "2026-09-30T06:00:00.000Z",
  "total_energy": 12,
  "energyDirection": "CHARGE"
}
```

Native OICP identity is carried under `Identification`, for example:

```json
{
  "CPOPartnerSessionID": "oicp-session-001",
  "ProviderID": "provider-de",
  "Identification": {
    "RemoteIdentification": { "EvcoID": "DE*EMP*E123456" }
  },
  "EvseID": "DE*ABC*E001",
  "ChargingStart": "2026-09-30T05:00:00.000Z",
  "ChargingEnd": "2026-09-30T06:00:00.000Z",
  "ConsumedEnergy": "12"
}
```

The normalised success section contains `eMAID`/`emaid`, `protocol`,
`sourceField`, optional non-owning `tokenMetadata`, canonical session/provider
values, energy and direction. A preview success has this illustrative shape;
reward and policy values depend on the persisted policy and session-start
timezone:

```json
{
  "status": "preview",
  "sideEffects": false,
  "eligible": true,
  "tokensAwarded": 3,
  "uid": "DE*EMP*E123456",
  "dedupKey": "cdr-001-provider-de",
  "normalisation": {
    "eMAID": "DE*EMP*E123456",
    "emaid": "DE*EMP*E123456",
    "protocol": "OCPI",
    "sourceField": "cdr_token.contract_id"
  },
  "normalised": {
    "sessionId": "cdr-001",
    "providerId": "provider-de",
    "eMAID": "DE*EMP*E123456",
    "emaid": "DE*EMP*E123456",
    "protocol": "OCPI",
    "sourceField": "cdr_token.contract_id",
    "uid": "DE*EMP*E123456",
    "energyKWh": 12,
    "energyDirection": "CHARGE"
  },
  "policy": { "revision": 1, "updatedAt": "2026-09-30T00:00:00.000Z" }
}
```

### `POST /ingest/cdr`

The request and identity rules are the same as preview. A successful response
can be `accepted`, `duplicate`, or accepted but not eligible. It can be `202`
when an existing movement or receipt is pending and the identical CDR remains
the retry input. `requiresReview: true` stops automatic retry/replacement.
Responses include the normalisation metadata, `sessionId`, `providerId`,
legacy `uid` alias, eligibility, `tokensAwarded`, operation/status fields,
transaction hashes when known, policy revision, and safe `message` text. A
normalisation or validation failure is `400` with the structured error above;
authentication failures are `401`/`403`.

Reward rules are persisted by policy revision. Each calculation uses one
request-local snapshot. Charging eligibility uses the session start instant in
the configured country IANA timezone; a session that crosses a window is not
prorated. Eligible token amounts are whole tokens calculated with flooring.
V2G discharge is selected independently of off-peak windows; negative partner
energy means discharge. Countries without configured charging windows are not
charging-eligible. The preview route is the integration-safe way to test rules
without financial side effects.

## 4. Spending, reservations, and receipts

### Session spend prompt: `POST /spend/session`

Requires `x-contract-id` and body fields `sessionId`, `providerId`, `chargerId`,
and `status` (`CHARGER_OPENED`, `PLUGGED_IN`, or `SESSION_STARTED`). Optional
`countryCode`, `estimatedKwh`, and `estimatedCost` must have the documented
types. It loads the durable reward-policy snapshot and returns wallet balances,
`spend.eligible`, `maxSpendable`, `suggestedAmount`, reward rates, recent
activity, and `policy { revision, updatedAt }`. It never reserves or spends
tokens, although the wallet lookup may provision or refresh a durable wallet
identity record.

### Direct managed spend: `POST /spend`

New requests require a stable, non-empty string `idempotencyKey` and a positive
two-decimal-compatible `amount`. The existing wire `uid` field carries the
eMAID. Optional `sessionId`, `providerId`, and `label` are persisted with the
intent. The server derives an `operationKey` and keeps the original owner,
amount, wallet, session, provider, and fingerprint.

An `operationKey` may be supplied only to recover an existing manual operation;
the server resolves all intent from the durable row. It cannot create a new
spend, change its owner/amount/session/provider, or trigger a replacement
transfer. Missing, empty, or non-string keys are rejected before wallet
creation, funding, reservation work, or broadcast with
`IDEMPOTENCY_KEY_REQUIRED`/`INVALID_OPERATION_KEY`.

Success and pending responses include `status`, eMAID-compatible `uid`, amount,
`tokensSpent`, `txHash` when known, `operationKey`, `operationStatus`,
`movementOutcome`, `pending`, `retryable`, `requiresReview`, `financialStatus`,
`receiptStatus`, and (when available) `spendReceipt`. `movementOutcome` is
durable and must not be inferred from a generic failed operation:

| Outcome | Meaning |
| --- | --- |
| `confirmed` | The token movement is proven and may have a receipt/projection stage pending. |
| `no_movement` | Correctly identified chain evidence proves no transfer. |
| `unknown` | The result cannot prove movement or no movement; keep the original key/hash and review. |
| `review` | A conflict or validation issue requires an operator. |

A `202` keeps the original operation/key/hash for retry. A receipt persistence
failure after confirmed movement is not permission to transfer again.

### Reservation flow

`POST /spend/me` requires `x-contract-id`, `amount`, `sessionId`, and
`providerId`; `label`, `walletAddress`, and `authorizationTxHash` are optional
where the wallet mode requires them. It reserves SPARKZ and returns:

```json
{
  "status": "success",
  "uid": "DE*EMP*E123456",
  "sessionId": "session-001",
  "providerId": "provider-de",
  "reservation": {
    "id": "00000000-0000-4000-8000-000000000001",
    "status": "reserved",
    "amount": "5.00",
    "kWhEntitlement": "5.00",
    "availableBalance": 12
  }
}
```

The reservation identity is the eMAID plus exact session/provider pair. Repeating
the same request is idempotent; do not add a random manual idempotency key. One
non-terminal reservation is supported per card integration. `POST
/spend/reservation-approval-intent` builds a capped ERC-20 approval intent for
an external wallet; the user signs it, and the confirmed hash is passed to
`/spend/me`. It does not itself spend tokens.

`GET /spend/reservations/:reservationId` is read-only and owner-scoped. It
returns `reserved`, `settling`, `settled`, or `released`, the original
session/provider, reserved/settled/released amounts, delivered kWh, token hash,
`spendReceipt`, and `receiptStatus` (`not_created`, `pending`, `settled`, or
`none`). A confirmed movement can remain `pending` until receipt persistence;
polling does not create a new movement. Invalid UUIDs are `400`, another
eMAID's reservation is not disclosed, and a missing reservation is `404`.

### Signed receipt verification: `POST /spend-receipts/verify`

Requires an API key and body `{ payload: object, signature: string,
signerAddress?: string }`. The configured NEVERFLAT receipt signer is
authoritative. A supplied signer address is only a claim and must match the
configured signer; the receiver must still verify the signature and compare the
canonical payload with its expected eMAID, wallet, amount, provider/session,
transaction hash, token contract, and chain. The response is `valid` or
`invalid` with safe failure details.

### User-managed/custodial routes

These routes preserve the user-wallet integration boundary:

| Route | Request contract | Result |
| --- | --- | --- |
| `POST /spend/custodial-intent` | `uid`/eMAID, `walletAddress`, positive `amount`, optional session/provider | Returns a user-signable transfer intent and durable operation context. |
| `POST /spend/custodial-failure` | Original intent/operation context and failure details | Records a failed signature/submission without treating it as a confirmed movement. |
| `POST /spend/custodial-record` | `uid`, `walletAddress`, `amount`, `txHash`, optional session/provider and receipt context | Verifies chain evidence and records the confirmed external-wallet spend; pending receipt/projection remains retryable. |

If a user wallet request may already have been accepted, retain its original
hash and resolve it. Never submit a replacement solely because a response was
lost. Mismatched wallet, amount, owner, asset, chain, or transfer evidence is
rejected or requires review.

## 5. Wallet and transaction routes

`GET /wallet/me` requires the identity header and returns the eMAID-scoped
wallet payload: legacy `uid` alias, wallet/managed addresses, wallet mode,
linked wallets, contract IDs, balances and balance status/source, totals, recent
history, token/treasury addresses, and a safe message. A chain balance that is
temporarily unavailable is reported as unavailable; it is not silently shown as
zero. It performs no token movement, but a first lookup may provision or
refresh the durable wallet/user record.

`GET /wallet/:uid` is the legacy/manual lookup and is subject to
`ENABLE_TEST_UID_LOOKUP`. It uses the path value as an eMAID compatibility
value, not as an arbitrary user UID. A first lookup may provision or refresh a
durable wallet/user record but does not move tokens. Disable this branch for a
locked-down deployment and prefer `/wallet/me`.

The wallet mutation routes are:

- `POST /wallet/:uid/mode`: `{ mode: "managed" | "custodial", walletAddress?, allowSplit? }`.
  Switching with a non-zero source balance returns `409 SOURCE_WALLET_HAS_BALANCE`
  unless `allowSplit` is explicitly used.
- `PATCH /wallet/:uid/profile`: optional `{ walletName?: string | null,
  walletAddress?: string }`.
- `POST /wallet/:uid/contract-ids`: `{ contractId: eMAID }` (the legacy `uid`
  alias remains accepted) and optional wallet address.
- `POST /wallet/:uid/linked-wallets`: `{ walletAddress, signature }`; signature
  proves link ownership.
- `PATCH /wallet/:uid/linked-wallets/:walletAddress/profile`: `{ walletName? }`.
- `DELETE /wallet/:uid/linked-wallets/:walletAddress`: `{ signature }`; signature
  proves unlink ownership.
- `POST /wallet/:uid/move-funds`: `{ targetAddress }`; target must be a valid
  address and the response includes the confirmed transfer hash/amount.

These routes return a wallet payload on success and safe English validation
messages on failure. They do not accept a token UID as an ownership substitute.

`GET /transactions?limit=50` returns `{ status: "ok", transactionCount,
transactions }` for the recent award/spend history visible to the trusted API
client; the limit is capped at 500 by the current handler. This is a global
operational history, not a caller-scoped user feed; a BEIA proxy must not
expose it to an end user without its own authorization and filtering.

## 6. Admin and operational API

### Login and policy

`POST /admin/login` accepts `{ email, password }` or `{ username, password }`
and returns `{ status: "ok", token, adminEmail }`. Wrong credentials are `401`;
missing admin configuration is a visible `503`. `POST /admin/logout` requires
the bearer token, invalidates that admin session, and records the logout.

`GET /admin/rules` and `PUT /admin/rules` expose the durable reward policy.
The PUT body is a non-empty object containing only any of:
`offPeakChargingTokensPerKWh`, `v2gDischargeTokensPerKWh`,
`offPeakChargingEnabled`, and `v2gDischargeEnabled`. Rates are finite
non-negative numbers; enablement values are booleans. The response includes
`rules`, `policy: { revision, updatedAt }`, and compatibility top-level
`revision`/`updatedAt`. Empty, array, unknown, nonfinite, or invalid fields are
`400`; persistence errors do not claim success or replace the previous policy.

`GET /admin/off-peak` returns `windows` and policy metadata. `PUT /admin/off-peak`
accepts a complete `{ windows: { "DE": [{ "start": "22:00", "end": "06:00" }] } }`
document. Country keys are valid ISO alpha-2 values, each country has 1–6
`HH:MM` slots. `DELETE /admin/off-peak/:countryCode` removes one country or
returns `404` when it is absent. Writes are revisioned and durable.

### Audit, health, and evidence

- `GET /admin/audit?limit=100&status=error&eventType=spend.failed` returns an
  allowlisted safe projection of append-only events. Raw metadata, provider
  errors, intent snapshots, and CDR payloads are omitted.
- `GET /admin/pilot-metrics?hours=24` returns bounded audit-derived activity
  metrics for 1–168 hours.
- `GET /admin/readiness` returns `ready`, `ready_with_warnings`, or
  `not_ready`, counts, and checks. A `ready` response has zero failed and
  warning checks; `ready_with_warnings` has at least one matching warning and
  no failed checks. Missing `API_KEY` or alert webhook configuration can be
  warnings while the target is being reviewed; missing `INGEST_API_KEY`, admin
  credentials, token/signer configuration, or durable persistence checks is a
  failure.
- `POST /admin/alerts/test` returns `202` for sent/queued or audited skipped
  delivery, and `502` when an attempted alert delivery fails. The response
  reflects the delivery result, not merely configuration presence.
- `GET /admin/evidence-pack` returns a point-in-time readiness, configuration,
  reconciliation, metrics, retry/warning/error, and alert evidence snapshot.
  If a dependency is unavailable it returns `EVIDENCE_PACK_UNAVAILABLE` with a
  safe retry message.

### Reconciliation

`POST /admin/reconciliation/run` accepts an optional JSON object `{ "limit": N }`
where `N` is a number/integer from 1 through 1000. `GET /admin/reconciliation`
accepts a scalar `limit` query from 1 through 100. Arrays, booleans, malformed
values, and repeated query values are rejected. A successful report compares
database wallet state with chain `balanceOf` values and stores the report;
dependency failures return `RECONCILIATION_UNAVAILABLE` without raw SQL/RPC
details.

### Durable operation visibility and recovery

`GET /admin/operations` accepts bounded `scope`, `limit`, `offset`, and `emaid`
filters. It returns server-derived operation fields, movement outcome, and a
safe recovery decision/reason code; it never returns raw intent, CDR snapshots,
provider errors, or sensitive fingerprints. A `uid` filter is not an alternate
ownership selector.

`POST /admin/operations/recover` accepts exactly:

```json
{ "operationKey": "award:..." }
```

The server resolves owner, amount, asset, hash, receipt, and saved snapshot
from that existing operation. It may verify a known submitted hash and finish a
missing database projection/receipt, or report an already projected operation
idempotently. It never broadcasts, funds, approves, reclaims, creates a new
transfer, accepts caller amount/eMAID/hash/CDR overrides, or settles a
reservation without the saved context supported by the operation. Unknown or
hashless operations, missing/invalid award snapshots, mismatched assets,
fingerprints, owners, receipts, or unsupported reservation states remain
blocked with a review-required result.

Typical statuses are `200` for completed or already-completed projection, `202`
for pending evidence/receipt, `409` for a blocked review result, `400` for a
malformed body/key, and `401` for missing/invalid admin authentication. Every
request is audited before mutation; an audit persistence failure is reported as
an audit failure rather than falsely claiming an unaudited success.

## 7. Errors and safe retries

JSON parsing and request-size middleware return `INVALID_JSON` (`400`) and
`REQUEST_BODY_TOO_LARGE` (`413`). Other common stable codes include:

| Code | Typical meaning |
| --- | --- |
| `MISSING_EMAID`, `UID_ONLY`, `CONFLICTING_IDENTIFIERS`, `INVALID_EMAID` | CDR ownership cannot be safely normalised. |
| `INVALID_PAYLOAD` | CDR shape or required fields are invalid. |
| `IDEMPOTENCY_KEY_REQUIRED`, `INVALID_OPERATION_KEY` | Direct manual spend key contract is not satisfied. |
| `TOKEN_OPERATION_INTENT_MISMATCH`, `OPERATION_NOT_FOUND` | A recovery key does not match the saved operation. |
| `INVALID_RESERVATION_ID` | Reservation path is not a UUID. |
| `SOURCE_WALLET_HAS_BALANCE` | Mode change would strand funds without explicit split behaviour. |
| `AUDIT_LOG_UNAVAILABLE`, `EVIDENCE_PACK_UNAVAILABLE`, `RECONCILIATION_UNAVAILABLE` | Operational dependency failed; retry safely. |
| `TOKEN_OPERATION_RECOVERY_UNAVAILABLE` | Durable operation lookup cannot be completed; no new movement was attempted. |
| `AWARD_CHARGING_SESSION_COLLISION_REVIEW` | A distinct CDR claimed a protected provider/physical-session tuple. |
| `SPEND_RECEIPT_CONTEXT_MISMATCH` | Receipt evidence does not match the saved spend intent. |
| `SPEND_RECEIPT_RECOVERY_PENDING` / `SPEND_RECEIPT_RECOVERY_BLOCKED` | Movement/projection is known but receipt recovery is pending or requires review. |

For a timeout or connection loss, retry only the identical saved CDR, stable
manual idempotency key, operation key, custodial hash, or reservation poll. RPC
receipt reads use a bounded read-only retry budget; broadcasts and approvals
are never retried blindly. A response with `requiresReview`, `movementOutcome:
"unknown"`, or an identity/session conflict must stop automated retries.

## 8. Configuration and release boundary

The source reads configuration from `.env`; values must be supplied by the
target environment owner. Relevant names are:

```text
PORT=3000
API_KEY=...
BEIA_API_KEY=...
INGEST_API_KEY=...
USER_IDENTITY_HEADER=x-contract-id
ADMIN_EMAIL=...
ADMIN_PASSWORD=...
BEIA_ADMIN_EMAIL=...
BEIA_ADMIN_PASSWORD=...
DATABASE_URL=...
ENABLE_TEST_UID_LOOKUP=false
TREASURY_ADDRESS=0x...
TREASURY_SIGNER_KEY_FILE=...
ADMIN_ALERT_WEBHOOK_URL=https://...
```

Keep existing wallet derivation, database column names, and standards wire names
unchanged. The additive policy, charging-session, and active-wallet schema work
requires a target-specific reviewed migration/backup procedure. Local
activation used loopback disposable/controlled resources and does not authorize
a production migration. The successful production workflow recorded for the
deployed baseline is [Deploy Neverflat #45](https://github.com/ZentrixLab/neverflat/actions/runs/37457660589);
its image digest and post-start target acceptance response are not recorded
here.

For BEIA component integration, use the [BEIA guide](docs/BEIA_INTEGRATION.md).
For rationale and system architecture, see
[NEVERFLAT Award System Documentation](NEVERFLAT_Award_System_Documentation.md).
