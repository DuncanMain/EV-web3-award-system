# NEVERFLAT predeployment release notes — 2026-09-30

**Status:** local candidate and review draft for `NVF-award-core`. This note is
not a deployment approval or a live-server comparison. No backend release
version or commit is assigned here. Fresh local backend checks were rerun on
30 September; the remaining package/browser evidence is identified by its
individual report and scope below.

The operator rollout procedure is [`DEPLOYMENT.md`](../DEPLOYMENT.md). Target
commit, immutable image digest, database facts, backup/restore rehearsal,
migration procedure, and rollback decision remain pending and are intentionally
not fabricated in these notes.

## Included in this candidate

**Identity and CDR handling.** One normaliser detects OCPI or OICP from the
payload. Ownership is always the eMAID: OCPI uses
`cdr_token.contract_id`; OICP uses the supported
`Identification.*.EvcoID` fields (`RemoteIdentification`, `QRCodeIdentification`,
`PlugAndChargeIdentification`, and `RFIDIdentification` when present). Every
present supported identity must agree. UID-only, conflicting, or malformed
identity records fail closed or are quarantined; token/RFID/custom `uid` values
never derive a wallet or award owner. The result records normalized eMAID,
protocol, source field, non-owning metadata, and validation details. Existing
wire names remain for compatibility, but internal ownership and UI labels use
eMAID.

New OCPI claims with both CDR `id` and physical `session_id` bind the provider
and charging session before movement. A replacement CDR id for the same tuple
returns `AWARD_CHARGING_SESSION_COLLISION_REVIEW` without a second transfer or
reservation settlement. Claims without that explicit pair remain unbound, and
historical rows are not rewritten or backfilled.

**Financial reliability and recovery.** Read-only RPC evidence, including
receipt reads, has a bounded transient retry policy. State-changing recovery
uses guarded operation-specific paths and never issues a blind replacement
transfer. Known hashes are checked against network, contract, sender,
recipient, amount, and transfer evidence. Durable award snapshots retain the
normalized session, owner, asset, signer, reward context, and raw CDR when it
exists. The admin recovery request supplies only an existing `operationKey`;
the server resolves and validates the saved context. Unknown/hashless records,
missing snapshots, asset mismatches, and unsupported reservation states remain
blocked with a review reason. Receipts are persisted after movement evidence;
BEIA/EMP must independently verify the configured signer and settlement
context.

`POST /spend/me` retains the eMAID/session/provider reservation contract. A
resumed card flow requires its saved `reservationId`, `sessionId`, and
`providerId`; one non-terminal reservation is retained per card, including
across session close/reload. A pending receipt is not treated as settlement.
New direct `POST /spend` requests require a stable, non-empty string
`idempotencyKey` before wallet creation, gas funding, ledger writes, or
broadcast. The returned `operationKey` is recovery-only. This is a breaking
requirement for new manual-spend callers; reservation callers keep their
existing route contract.

**Reward policy and admin operations.** Reward rules and country off-peak
windows persist in the revisioned `reward_policy` row. Updates are serialized,
defaults seed once, and calculations use an immutable request-local snapshot.
Timezone-aware windows, session-start eligibility, whole-token flooring, and
the partner-defined negative-energy discharge/V2G rule remain explicit policy
boundaries. Discharge uses absolute kWh and does not consume a charging
reservation.

The admin panel now has a responsive branded sidebar with active and keyboard
accessible navigation, accessible icon labels, and bottom sign-out. Its real
operational tabs are **Overview**, **eMAIDs & Balances**, **Transactions**,
**Token Rules**, **Audit Log**, and **System Health**. Admin login uses the
configured `ADMIN_EMAIL` and `ADMIN_PASSWORD` with no fallback; the password
visibility toggle is available by mouse and keyboard. Admin bearer access is
used for dashboard calls, while general protected routes retain `API_KEY` and
ingestion can retain `INGEST_API_KEY`. If the target server keeps the existing
`API_KEY`, the integration can continue using it; this change requires no key
rotation. Local evidence does not validate target key values. Audit responses
allowlist operational fields and omit raw provider errors, payloads, CDRs, and
intent context.

**BEIA candidate.** The handoff is
`@neverflat/sparkz-charging-card@0.2.1-rc.1` using a same-origin
`/api/sparkz` proxy. It guards against delayed responses from a previous user
or API endpoint, handles session-close and reload/resume with the original
reservation/session/provider values, keeps one pending reservation per card,
and includes the corrected CSS export/packaging path.
Browser code receives no API, ingestion, treasury, or signing secret. The
trusted BEIA/EMP backend owns receipt verification and durable delivery
deduplication. React 19 package tests and an isolated React 18.3.1 consumer
mount/update/unmount lifecycle smoke both passed. React 18 application
integration remains unverified.

The disposable browser check also verified token-policy save/reload,
reconciliation, local alert feedback, evidence-export initiation, and saved
spend recovery. The final disposable admin matrix verified saved-snapshot award
recovery, an idempotent repeat, and safe blocking when the snapshot is absent;
the backend operations projection reads saved recovery context internally while
continuing to omit it from the admin response.

## Compatibility and rollout notes

`contract_id`, `EvcoID`, `contractId`, `x-contract-id`, and legacy `uid` wire
names remain where required, but their ownership value must be the provisioned
eMAID. No automatic wallet relinking is performed. Partners adding direct
manual spends must adopt stable idempotency keys; OCPI/OICP senders must supply
an agreeing eMAID-bearing identity. The package must be aligned with the
matching backend/API version. This candidate is local and undeployed.

The local schema work is additive. The strict historical migration path still
encounters legacy duplicate data. Local activation used reviewed scoped runners
for token-operation safeguards, reward policy migration 016, and charging-
session guard migration 017; those runners are local review tools, not
production deployment commands. Production needs a target-specific reviewed
migration procedure, fresh physical backup, verified backup evidence,
before/after financial and wallet/eMAID digests, and a tested rollback plan. No
schema or database change was made by this release-note task.

The checked-in container entrypoint runs the full migration chain before the
API starts, and the production compose file still references `:latest` and a
literal PostgreSQL connection value. That is repository behaviour, not a safe
production gate. Do not copy the local loopback-only 015/016/017 runners into a
target; use the reviewed target migration and preservation sequence in
[`DEPLOYMENT.md`](../DEPLOYMENT.md). The push-to-`main` workflow can build and
deploy automatically ([`.github/workflows/production.yaml`](../.github/workflows/production.yaml)),
but it was not invoked for this candidate.

The earlier local catalog-index issue was repaired and verified against local
resources: the repaired database retained counts/digests, passed logical dump
and `pg_amcheck`, and the disposable restore check succeeded. Production
restore behaviour remains unverified. Historical migration blockers, legacy
rows, and the bounded chain/mirror discrepancy belong to the local test
database and are not asserted as production blockers. This release-note task
made no historical financial adjustment; earlier bounded local recovery is
summarised in the [local release verification record](RELEASE_VERIFICATION_2026-10-01.md).

## Evidence and remaining sequence

Fresh backend verification on 30 September passed `npm.cmd run build`, the
full Jest suite (**321 tests passed, 6 skipped**), and the isolated PostgreSQL
runner (**2 suites, 15 tests passed** against a unique disposable database).
The final API contract matrix passed **178/178** disposable HTTP cases across
42 routes, and the admin-owned matrix passed **199/199** cases with no
findings. The disposable Hardhat/API flow passed migration 017 activation,
protocol identity, persisted-policy reload, backup/restore digest comparison,
receipt/recovery failure drills, linked/custodial paths, and replacement-session
protection. The safe result summary is in the [local release verification record](RELEASE_VERIFICATION_2026-10-01.md).
The final backend coverage report also records the active-dashboard read-only
preservation check. The BEIA package
build/typecheck and **12 tests passed with 0 skipped**, with checksum,
allowlist, import/require, CSS export, and secret scans passing; the isolated
React 18.3.1 lifecycle consumer passed as well. The authenticated browser
report records policy save/reload, reconciliation, alert feedback, evidence
export initiation, saved-spend recovery, and the completed saved-snapshot
award recovery/idempotent repeat; the award without a snapshot remains safely
blocked. These results are local candidate evidence, not a live release gate.
This release-note edit made no runtime, database, package, or deployment
change.

The frontend and charging-card checks are recorded against the same current
source lineage, with their individual run dates and scope retained in the
linked report. If either source area, dependency set, or package artifact
changes after its recorded check, rerun the affected check before assigning a
release record.

The final combined local backend, frontend, package, schema, and local EVM
checks are complete on the current working tree. Before deployment, assign and
freeze the backend version/commit; rerun affected checks if source,
dependencies, or configuration changes after this evidence, rather than
repeating the full suite solely to name the commit. Then validate
target admin, API, ingestion, RPC, signer, alert, and database configuration;
take and test a target backup/restore; then apply only the reviewed additive
schema steps with preservation checkpoints. Align the BEIA package to that
backend and confirm the trusted proxy and receipt/outbox responsibilities.
After the API exists in its target environment, run partner smoke tests for
real OCPI/OICP eMAIDs, identity rejection, replacement-session protection,
manual-spend keys, reservation resume, reconciliation, alerts, and rollback.
These are post-deployment acceptance checks, not a request to add speculative
features before the API is available.

The deployment record is still pending: candidate commit, immutable image
digest, target host/proxy, database and TLS facts, verified backup manifest,
restore result, writer-quiescence window, target migration result, before/after
financial and wallet/eMAID digests, RPC/token/signer identity, health/readiness
result, smoke evidence, rollback decision, approver, and UTC timestamp. See
the record template in [`DEPLOYMENT.md`](../DEPLOYMENT.md).

Known local review items remain operator-visible: historical missing-CDR or
hashless recovery, unbound session records, external provider/EMP behaviour,
live alert delivery, and the local chain/mirror discrepancy. They are not
silently replayed or adjusted.

Evidence: the [local release verification record](RELEASE_VERIFICATION_2026-10-01.md),
[BEIA integration guide](BEIA_INTEGRATION.md), [API contract](../API.md), the
[maintained system documentation](../NEVERFLAT_Award_System_Documentation.md),
and the [deployment handoff](DEPLOYMENT_HANDOFF.md). Raw logs, database
dumps, private local identifiers, and superseded package archives remain local
review artifacts and are not part of this release documentation.
