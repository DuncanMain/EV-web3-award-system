---
source_document: NEVERFLAT_Award_System_Documentation.docx
status: system documentation
updated: 2026-10-06
---

# NEVERFLAT Award and Wallet System

This document describes the NEVERFLAT award and wallet system, its API
contracts, and its operational invariants. Deployment procedures and dated
release evidence are maintained in [DEPLOYMENT.md](DEPLOYMENT.md), the API
contract in [API.md](API.md), and the linked release records.

The complete HTTP contract is in [API.md](API.md). The BEIA component contract
is in [docs/BEIA_INTEGRATION.md](docs/BEIA_INTEGRATION.md). The safe local
verification summary is in [docs/RELEASE_VERIFICATION_2026-10-01.md](docs/RELEASE_VERIFICATION_2026-10-01.md).

## System position

| Area | System behavior and contract |
| --- | --- |
| Ownership | eMAID is the canonical internal owner. Existing `contract_id`, `EvcoID`, `contractId`, `x-contract-id`, `uid`, and database column names remain wire/compatibility names where required. |
| Award input | One normaliser detects OCPI or OICP from payload structure. OCPI uses `cdr_token.contract_id`; OICP uses all present supported `Identification.*.EvcoID` values, which must agree. |
| Token metadata | OCPI token UID and OICP RFID UID are non-owning audit metadata only. UID-only records fail closed. |
| Reward policy | Off-peak charging and V2G discharge rules/windows are durable, revisioned, and loaded into an immutable request snapshot. |
| Wallets | Deterministic managed wallets and user-managed/custodial intent/record routes are supported. Wallet derivation and historical mappings are preserved. |
| Settlement | SPARKZ movements use the configured token contract and treasury/user signing path. Target network and credentials remain deployment concerns. |
| Receipts | Backend-signed spend receipts carry canonical settlement context. A receiver must independently verify the signature and expected eMAID/wallet/amount/session/transaction context. |
| Operations | Durable token operations retain original intent, hashes, movement outcome, and recovery context. Read-only evidence retries are bounded; unknown movement remains review-only. |
| Admin | Six operational tabs: Overview, eMAIDs & balances, Transactions, Token rules, Audit log, and System health. |

## 1. Functional flows

### Awards and CDRs

The AU/provider system sends a final CDR to `POST /ingest/cdr`; preview is
available at `POST /ingest/cdr/preview`. A successful preview has no financial
database or blockchain side effects, although validation failures may append a
safe audit event. The normaliser returns canonical eMAID, detected protocol, source
field, optional non-owning token metadata, and validation provenance. It
rejects missing eMAID, UID-only ownership, invalid eMAID values, and conflicting
identities. There is no ContractID/eMAID administrator selector.

The reward engine applies country/timezone windows to off-peak charging and
energy direction to V2G discharge. Charging eligibility is based on the session
start instant in the configured country IANA timezone; a session that crosses a
window is not prorated. Award amounts use whole-token flooring after applying
the configured rate. Countries without charging windows are ineligible for
charging awards, while V2G discharge remains independent of off-peak windows.
The partner's negative energy convention is treated as discharge. A policy
revision and update timestamp are included in calculation responses where
applicable. Duplicate protection uses the existing provider/session operation
identity, and a new OCPI record with explicit CDR
`id` plus physical `session_id` also claims a durable provider-plus-physical-
session guard. A distinct CDR ID for that same protected session is blocked
before broadcast and requires review; eMAID, amount, or UID changes cannot
bypass it. Records without the explicit physical-session pair retain the
documented legacy coverage limit.

The award operation stores a recovery snapshot before a transfer is submitted
when the new operation path is used. It includes canonical normalisation and
the original CDR when available. Replays validate the saved fingerprint and
owner before projecting a known movement. Historical rows without a valid
snapshot remain unchanged and are blocked from unsafe standalone recovery.

### Reward policy

Migration 016 adds a singleton durable `reward_policy` row with increasing
revision and update timestamp. Policy writes are transactionally serialized;
partial rule changes merge under the row lock, while a windows document is a
complete replacement. A request reads one snapshot, so an admin update cannot
change an in-flight calculation. A persistence/read failure is visible and
does not report a false save or silently fall back to bundled defaults.

The supported policy controls are:

- off-peak charging enabled/rate per kWh;
- V2G discharge enabled/rate per kWh; and
- country-specific `HH:MM` off-peak windows.

### Wallet and identity

eMAID is the ownership boundary for wallet lookup, awards, balances, and
identity-context spend. `/wallet/me`, `/spend/session`, `/spend/me`, and
reservation status use the configured identity header, default `x-contract-id`.
The header identifies the eMAID but is not authentication; the trusted BEIA
server must bind its logged-in user to that eMAID before forwarding the request.

The legacy `/wallet/:uid` and direct `/spend` routes retain their standard wire
names for compatibility and local/manual use. Their `uid` value is an eMAID;
an app account ID, token UID, or RFID UID must not be substituted. Existing
wallet derivation and database mappings must not be renamed or regenerated as a
presentation change.

### Spending and receipts

`POST /spend` is the direct managed-wallet route. A new request must supply a
stable, non-empty string `idempotencyKey` before wallet creation, operation
claim, reservation work, or broadcast. The exact key bytes are reused for
transport failure, pending status, and receipt recovery. `operationKey` is a
server-issued recovery handle for an existing row and cannot create a new
spend or override the saved owner, amount, wallet, session, provider, or asset.

`POST /spend/me` is the separate eMAID/session/provider reservation flow. It is
idempotent on that saved reservation identity and returns a reservation ID; it
does not use the direct manual key contract. `GET
/spend/reservations/:reservationId` is read-only and reports reservation state,
delivered kWh, token hash, and receipt status. A confirmed movement with a
missing receipt stays pending; it is not replaced by another transfer.

The response `movementOutcome` distinguishes `confirmed`, `no_movement`,
`unknown`, and `review`. Operation status alone is not evidence of movement.
The bounded RPC helper retries receipt/transaction reads only. It never blindly
rebroadcasts a transfer or approval after a lost response.

The receipt verifier uses the configured NEVERFLAT signer. BEIA/EMP must verify
the signature over the canonical payload with an independently trusted signer,
then compare the signed eMAID, wallet, amount, provider/session, token hash,
token contract, and chain ID with the expected reservation. Receipt presence or
a caller-supplied signer address is not sufficient proof. The EMP owns the
discount and its durable outbox/deduplication; NEVERFLAT returns settlement
evidence and does not deliver the discount directly.

### User-managed/custodial path

`/spend/custodial-intent`, `/spend/custodial-failure`, and
`/spend/custodial-record` support a user-controlled wallet. The user signs the
intent; the record route verifies owner, asset, amount, wallet, chain, and
transaction evidence before recording a spend. If a submission response is
ambiguous, the original hash and operation context are retained for lookup.
Another signature or transfer is not requested merely because a response was
lost. Invalid or mismatched evidence remains pending or review-only.

## 2. Admin and operational model

The local admin interface has six real operational tabs:

| Tab | Existing capability |
| --- | --- |
| Overview | Pilot summary and current activity signals. |
| eMAIDs & balances | eMAID-scoped wallet, balance, totals, and linked activity lookup. |
| Transactions | Controlled award/spend activity and transaction history. |
| Token rules | Durable reward rates, enablement, and off-peak country windows. |
| Audit log | Safe allowlisted operational events, protocol/identity validation outcomes, and retry/review states. |
| System health | Readiness, pilot metrics, reconciliation, alert test, and evidence export. |

Admin login uses configured `ADMIN_EMAIL`/`ADMIN_PASSWORD` or the supported
BEIA admin variable names; there is no hardcoded password. An authenticated
admin bearer token authorizes admin routes. Logout invalidates the bearer
session as well as recording the event. The admin recovery action accepts
only an existing `operationKey`; the server resolves all sensitive operation
context. It can finish a verified projection/receipt or report an idempotent
already-completed result. Unknown/hashless operations, missing snapshots,
fingerprint/asset mismatches, and unsupported reservation states are blocked.
The recovery response and audit event distinguish completed, pending, blocked,
and audit-write failure outcomes.

Audit responses are allowlisted. They retain event type, actor/status, target
identifiers, timestamps, and safe presentation, while omitting raw provider
errors, SQL, secrets, fingerprints, intent context, and CDR payloads. Alerts
report actual delivery (`sent`, skipped, or failed) rather than configuration
presence alone. Reconciliation compares stored wallet state with chain
balances and stores a report; evidence export is a point-in-time snapshot and
returns a safe retry error when a dependency is unavailable.

## 3. Data, security, and schema boundaries

The database mirror stores users/wallet mappings, awards, spends, balances,
receipts, reservations, token operations, approval preparations, policies,
audit events, and reconciliation reports. Existing columns and historical
records are retained. Migration 016 adds durable policy state. Migration 017
adds `token_operations.charging_session_id` and the provider-plus-physical-
session uniqueness guard for new explicit OCPI sessions; it does not rewrite
old records. The standalone migration 022 adds an explicit active-wallet
selection while retaining historical wallet rows. A rollback to an older image
must review active-wallet selection and pending financial operations; it must
not drop those preferences or rewrite wallet mappings or financial rows.

The local activation path was backup-gated and used loopback disposable or
controlled resources. A target environment needs its own reviewed backup,
schema, credentials, and rollback procedure before any migration. This
document does not authorize a production migration or database switch.

General API routes use `API_KEY`/`BEIA_API_KEY`; CDR routes may use dedicated
`INGEST_API_KEY`; admin routes use bearer sessions. Treasury and receipt keys
remain server-side. A deployment should disable `ENABLE_TEST_UID_LOOKUP` and
configure a trusted same-origin BEIA proxy for browser integrations.

## 4. Verification and release boundary

The final local verification sequence recorded the following:

| Check | Result |
| --- | --- |
| Full Jest | 321 passed, 6 opt-in tests skipped. |
| Disposable PostgreSQL checks | 15 passed across 2 suites. |
| API contract matrix | 178/178 finite real HTTP cases passed across 41 concrete routes; generated HEAD/OPTIONS and the conditional frontend fallback were recorded separately. |
| Admin API matrix | 199/199 real disposable-fixture cases passed with no findings. |
| Local award/reliability harness | Passed protocol identity, policy reload, schema 017, backup/restore, wallet modes, reservations, receipt/recovery, crash/RPC/DB-failure, concurrency, and replacement-session scenarios. |
| Frontend/package verification | Summarised in [docs/RELEASE_VERIFICATION_2026-10-01.md](docs/RELEASE_VERIFICATION_2026-10-01.md); the package remains local and unpublished. |

The evidence is local and disposable. It does not establish production restore
rehearsal, live RPC/provider availability, target credentials, a real external
wallet, mobile-browser behaviour, or live webhook delivery. The prior active
dashboard preservation snapshot is evidence of that earlier read-only check,
not a new active financial test in this documentation task. A historical local
test-database discrepancy and blocked records were preserved and handled as
review evidence; they are not silently corrected or presented as production
facts.

### Current follow-up checks

The current source verification has separate focused evidence: Node 22 backend
verification passed 19 Jest suites with 327 tests and 12 opt-in tests skipped,
plus 21 real PostgreSQL integration checks; the offline deployment helper suite
passed 16 tests, the charging-card package passed 12 tests, the
frontend build and package/frontend audits passed, and a portable Node 22 probe
returned `v22.23.3`. The combined Node 22.23.3 root/frontend/Sparkz
`npm run ci:check` passed with all audits at zero vulnerabilities. These checks
are distinct from the historical local record above. Target post-start
acceptance remains a separate operational record; neither result is inferred
from the historical 321-test result.

## 5. Predeployment responsibilities

Before deployment, the environment owner must assign the release version and
commit, configure and independently verify API/ingest/admin/treasury/receipt
credentials, select the target database and backup procedure, review additive
migration activation, confirm token contract/network/RPC settings, and decide
whether custodial wallet flows are in scope. BEIA must use the candidate package
manifest and same-origin proxy contract, bind authenticated users to eMAIDs,
and provide a durable settlement outbox. The EMP must verify signed receipts
and deduplicate delivery.

After an API exists in the target environment, run the appropriate partner
smoke tests and capture health, preview, representative CDR, reservation,
receipt verification, reconciliation, alert, and evidence-pack results. See
[DEPLOYMENT.md](DEPLOYMENT.md) for the operational acceptance procedure and
record; post-start target acceptance is not recorded in this system overview.

## Appendix: source references

- [REST/API contract](API.md)
- [BEIA integration guide](docs/BEIA_INTEGRATION.md)
- [Local release verification](docs/RELEASE_VERIFICATION_2026-10-01.md)
- [Release notes draft](docs/RELEASE_NOTES_2026-09-30.md)
