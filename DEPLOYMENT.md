# NVF Award Core deployment and operations

This document is the operator runbook for the checked-in NVF Award Core
container and its PostgreSQL state. It describes the current repository
workflow and the gates that remain before a production rollout.

## Candidate status

The 30 September 2026 candidate is a **local, reviewable, undeployed** working
tree. No immutable backend commit, container digest, or deployment record has
been assigned by this document. Do not treat the local evidence as approval to
push, publish, or deploy.

The local verification used disposable PostgreSQL, Hardhat 31337, and API
processes. It did not use the live server, Polygon Amoy, external providers,
the active dashboard database, or production credentials. It also did not
modify `STATE.md`.

See the [predeployment release notes](docs/RELEASE_NOTES_2026-09-30.md) and the
[local release verification record](docs/RELEASE_VERIFICATION_2026-10-01.md)
for the safe result summary. Those documents do not fill in the
target-specific facts listed below.

## What the checked-in deployment actually does

The checked-in `Dockerfile` builds the backend with Node 20, builds the
frontend, installs production dependencies in a runtime image, and starts the
container with:

```text
node dist/database/migrate.js && node dist/api.js
```

That entrypoint runs the complete migration chain before the API listens. It
is not a separate, reviewed production migration phase. The chain is
idempotent for a compatible database, but migration 005 stops on duplicate
legacy contract IDs and migration 015 stops on historical duplicate
transaction hashes rather than choosing a row automatically. A target with
existing data must therefore have a reviewed migration plan before this image
is started. Do not assume that a container restart is a safe schema upgrade.

`compose.production.yaml` currently:

- pulls `ghcr.io/zentrixlab/neverflat:latest`;
- runs PostgreSQL 17 as `neverflat-db` with database `nvf_award`;
- binds the app container's port 3000 to `127.0.0.1:3005`;
- joins the external `shared-proxy` network; and
- supplies `DATABASE_URL=postgres://postgres:postgres@postgres:5432/nvf_award`
  inside the app container.

The last value is the literal checked-in compose value. A target must not be
deployed with a default database password. The target database credentials,
secret source, proxy route, and whether the production compose definition will
be changed to use them are unresolved release facts. Resolve and review them
before rollout; this documentation task does not change the compose file.

The [production GitHub Actions workflow](.github/workflows/production.yaml) runs
on every push to `main`. It builds and pushes both `:latest` and a commit tag,
copies `compose.production.yaml` to the server, writes selected GitHub secrets
to `.env`, then runs `docker compose
-f compose.production.yaml pull app` and `docker compose -f
compose.production.yaml up -d --remove-orphans`. A push to `main` can therefore
start a deployment. Do not push, merge, or manually invoke that workflow as
part of local verification. Production needs an explicit release gate and an
approved immutable image digest; `:latest` alone is not a release record.

## Target facts that must be resolved before deployment

Record these values in the deployment record without putting secrets in the
repository or logs:

- approved backend commit and image digest;
- target host, SSH/secret-manager owner, `shared-proxy` route, and maintenance
  window;
- PostgreSQL host, port, database, role, server version, TLS policy, and the
  backup/restore owner;
- target `POLYGON_RPC_URL`, `CHAIN_ID` (Polygon Amoy is 80002 for the normal
  test deployment), `TOKEN_CONTRACT_ADDRESS`, and `TREASURY_ADDRESS`;
- the provisioned `TREASURY_SIGNER_KEY` or `TREASURY_SIGNER_KEY_FILE` source;
- separate `API_KEY` and `INGEST_API_KEY` values, admin credentials,
  `USER_IDENTITY_HEADER`, CORS/proxy settings, and alert webhook ownership;
- the provisioned test eMAID and partner smoke-test payloads; and
- the reviewed target migration procedure and its rollback/recovery decision.

Do not invent a target value from the local defaults. In particular, preserve
the existing eMAID-to-wallet derivation salt, treasury identity, token
contract, chain, and signer unless a separately approved migration covers the
impact.

## Identity, wallet, signer, and token invariants

The ownership value is the charging-contract **eMAID**. Wire compatibility
names such as `contract_id`, `EvcoID`, `contractId`, `x-contract-id`, and
`uid` remain in routes or database columns, but they carry the eMAID value.
An RFID/token UID is not an ownership value. Do not rename or remap existing
users during deployment.

Keep these values identical to the existing target unless a separate migration
has been approved:

- `USER_ADDRESS_DERIVATION_SALT` — changing it changes deterministic wallet
  addresses;
- `TREASURY_ADDRESS` and the corresponding signer secret or secret file;
- `TOKEN_CONTRACT_ADDRESS` and `CHAIN_ID`;
- `POLYGON_RPC_URL`; and
- existing eMAID, wallet, balance, award, spend, receipt, reservation, and
  operation rows.

For a pilot or production target, explicitly set `NODE_ENV=production`, keep
`ENABLE_TEST_UID_LOOKUP=false`, require `API_KEY`, `INGEST_API_KEY`,
`ADMIN_EMAIL`, and `ADMIN_PASSWORD`, and keep the treasury signer out of the
image and source tree. The service does not support an empty production API
key as a safe mode. Rotate keys only through the target's planned secret and
partner-change process; this runbook does not authorize an uncoordinated key
rotation.

## Preflight checks

Use the recorded 30 September results when source, dependencies, and
configuration are unchanged. Rerun only the affected checks after a later
change. If the candidate or dependency tree changes, the source-supported
full sequence is:

```powershell
git rev-parse HEAD
git status --short
npm.cmd ci --ignore-scripts --no-audit
npm.cmd run build
npm.cmd test -- --runInBand
```

Also run the repository's relevant frontend and package checks when those
artifacts are part of the release:

```powershell
Push-Location frontend
npm.cmd run build
npx.cmd tsc --noEmit --target es2020 --lib dom,dom.iterable,esnext --allowJs false --esModuleInterop --allowSyntheticDefaultImports --strict --forceConsistentCasingInFileNames --noFallthroughCasesInSwitch --module esnext --moduleResolution node --resolveJsonModule --isolatedModules --jsx react-jsx src/AdminApp.tsx src/AdminDashboard.tsx src/App.tsx src/AuthGate.tsx src/index.tsx src/apiConfig.ts
Pop-Location

Push-Location packages/sparkz-charging-card
npm.cmd test
npm.cmd pack --dry-run
Pop-Location
```

The final local evidence recorded 321 backend tests passed with 6 opt-in tests
skipped, 15 isolated PostgreSQL tests passed, 178 shared HTTP contract cases
passed, and 199 admin HTTP cases passed. Frontend and charging-card results
are summarised in the [local release verification record](docs/RELEASE_VERIFICATION_2026-10-01.md).
The package remains local and unpublished. If source, dependencies, or
configuration change after that evidence, rerun the affected checks before
assigning a release record.

## Backup, restore, and preservation gate

Use a target-approved maintenance window and stop or quiesce every writer
before taking the release baseline. This includes API ingestion, manual spends,
reservation settlement, admin policy writes, scheduled jobs, and any partner
replay. Record the time and the writer-quiescence evidence.

Before any schema or image change:

1. Take a fresh physical PostgreSQL backup using the target-approved backup
   mechanism. Where the target permits the PostgreSQL tools, the evidence must
   include the backup manifest and a successful `pg_verifybackup` result.
2. Copy or retain the verified backup in the approved protected location and
   record its path, manifest checksum, database identity, server version, and
   timestamp. Do not print credentials in the release record.
3. Restore the backup into an isolated disposable database or volume and run
   the restore checks there. Never restore over the live database as a test.
4. Capture a deterministic before snapshot for the financial and identity
   tables. At minimum include `users`, `balances`, `awards`, `spends`,
   `spend_receipts`, `token_operations`, `approval_preparations`,
   `spend_reservations`, `reward_policy`, `reconciliation_reports`, and the
   linked-wallet tables where present. Record row counts and content digests;
   do not publish raw user rows or secrets.
5. Repeat the same snapshot after the migration and smoke checks. Explain
   every expected additive row or audit event. Any unexpected financial,
   wallet, eMAID, hash, or policy change is a release blocker.

The local backup/restore evidence proves this procedure against disposable
resources only. It is not a production restore rehearsal. Do not run
`docker compose down -v`, `npm run db:reset`, `DROP DATABASE`, table drops, or
catalog edits on a target database.

## Migration gate

The normal `npm run db:migrate` command compiles the source and runs
`dist/database/migrate.js`, which attempts migrations 001 through 017. The
container entrypoint does the same automatically. A target with historical
rows must not be placed behind that startup command until the target-specific
plan has been reviewed and tested against a restored copy.

The repository contains three scoped runners used for local evidence:

- `npm run db:stage-token-operations` stages the additive token-operation
  schema and checks a caller-provided verified backup marker;
- `npm run db:apply-reward-policy` applies reward-policy migration 016; and
- after `npm.cmd run build`,
  `node dist/database/applyChargingSessionGuardMigration.js` applies the
  charging-session guard migration 017.

These runners deliberately accept only the existing loopback local database
`nvf_award` on port `55432`, and require `NVF_TOKEN_SCHEMA_BACKUP_PATH` plus
`NVF_TOKEN_SCHEMA_BACKUP_VERIFIED=pg_verifybackup`. They are local review
tools. **Do not copy them, their loopback checks, or their local backup marker
into production.** Production needs a separately reviewed target migration
procedure that handles migration 005 duplicate contract IDs, migration 015
duplicate transaction hashes, policy 016, and guard 017 according to the
actual target schema and data. That procedure is still pending.

The safe release boundary is therefore:

1. freeze the candidate commit and immutable image digest;
2. quiesce writers, take and verify the target backup, restore-test a copy, and
   capture the financial/eMAID baseline;
3. apply only the reviewed target migration steps while the API is stopped;
4. verify schema/index readiness and compare the database preservation
   snapshot;
5. start the approved image, knowing that its current entrypoint will run the
   full migration command before the API; and
6. perform health, readiness, identity, and reconciliation checks before
   reopening writes. `GET` reconciliation reads are read-only. A new
   `POST /admin/reconciliation/run` writes a reconciliation report and audit
   event, but does not transfer tokens; run it only as an explicitly approved
   controlled operational check after the read-only checks.

If step 3 is not available, stop. Do not deploy the current image and hope that
the automatic startup migration resolves historical data.

## Source-supported container rollout

After the backup and migration gates pass, the checked-in production workflow
uses the following shape. Run it only with an approved target, immutable image
selection, and change record; the commands were not run by this documentation
task:

```bash
docker compose -f compose.production.yaml pull app
docker compose -f compose.production.yaml up -d --remove-orphans
docker compose -f compose.production.yaml ps
docker compose -f compose.production.yaml logs --tail=200 app
```

The checked-in compose file references `:latest`; the release record must
capture the exact image digest pulled, or a reviewed compose change must pin
that digest before rollout. Do not use PM2, an untracked process manager, or
speculative queues as part of this release. Durable operation claims and
database locking are part of the application contract and were exercised in
single-instance local evidence. Multi-replica deployment, in-memory admin
session behavior across replicas, rate limiting, and cross-replica operational
coordination have not been validated here; do not introduce them as an
unreviewed scaling change.

The app has no Compose healthcheck. Confirm the service manually through the
proxy or the local binding after startup:

```bash
curl --fail http://127.0.0.1:3005/ingest/health
curl --fail http://127.0.0.1:3005/openapi.json
```

Do not expose PostgreSQL publicly. Keep the app bound behind the approved
proxy, use HTTPS at the proxy, and check that the proxy forwards the intended
identity header without allowing a caller to choose another eMAID.

## Post-start acceptance

Run these checks with target credentials held outside shell history and logs:

- health and OpenAPI return the expected status and schema;
- admin login works with the configured email and password, logout invalidates
  the bearer session, and `/admin/readiness` reports every failure or warning
  explicitly;
- read-only `/admin/rules`, `/admin/off-peak`, `/admin/audit`,
  `/admin/operations`, `/admin/reconciliation`, and `/admin/evidence-pack`
  calls return safe, allowlisted data;
- a provisioned test eMAID resolves to the same existing wallet address and
  balance as the preflight snapshot;
- `POST /ingest/cdr/preview` accepts representative OCPI and OICP payloads,
  reports protocol/source/eMAID provenance, and rejects UID-only or conflicting
  identity records;
- `GET /admin/reconciliation` matches the approved baseline. A controlled
  `POST /admin/reconciliation/run` may be run only when explicitly approved;
  it writes a reconciliation report and audit event but does not transfer
  tokens; and
- the proxy, alert target, RPC chain ID, token contract, signer address, and
  treasury gas status match the release record.

Do not use a real `POST /ingest/cdr` or spend request as a generic smoke test.
Those endpoints can create wallets, reservations, database rows, or blockchain
transactions. Use a separately approved provisioned test eMAID and fixture if
financial movement is part of acceptance, and record every hash. A balance
comparison alone does not prove ownership of an unrecorded transfer.

## Rollback and incident handling

If the container fails before writes resume, stop the new app, retain its logs,
and use the previously approved image digest only if it is compatible with the
schema already applied. If schema compatibility is uncertain, keep writers
quiescent and use the target recovery plan against an isolated restore.

Do not roll back by reversing financial rows, deleting audit history, changing
the eMAID derivation salt, replaying awards/spends, or submitting a compensating
blockchain transaction. Do not restore a backup over the target until the
incident owner has reconciled database state, on-chain hashes, reservations,
receipts, and balances. A deployment rollback is an application-version
decision; it is not permission to rewind financial history.

Preserve the failed image digest, migration output, backup manifest, before and
after digests, API logs, readiness response, and chain/provider evidence. Open
the target-specific recovery decision before reopening writers.

## Security and operational checklist

- [ ] Candidate commit, immutable image digest, package manifest, and approver
      recorded; no value is fabricated while these are pending.
- [ ] Target host, proxy route, PostgreSQL role/database/TLS, and maintenance
      window recorded.
- [ ] `API_KEY`, `INGEST_API_KEY`, `ADMIN_EMAIL`, and `ADMIN_PASSWORD` are
      present and separate where their roles differ; no default or empty
      production key is used.
- [ ] `ADMIN_ALERT_WEBHOOK_URL` is owned and reachable through the approved
      network path; alert delivery is checked without exposing webhook data.
- [ ] `TREASURY_SIGNER_KEY` is supplied through the approved secret mechanism;
      it is absent from images, source, logs, and shell history.
- [ ] `USER_ADDRESS_DERIVATION_SALT`, treasury address, token contract, chain,
      RPC, and existing eMAID/wallet mapping are preserved.
- [ ] `ENABLE_TEST_UID_LOOKUP=false` is explicit for pilot/production.
- [ ] HTTPS, proxy identity forwarding, PostgreSQL firewalling, and log
      redaction are checked.
- [ ] Fresh physical backup, `pg_verifybackup`, isolated restore, and before
      digests are recorded.
- [ ] Target migration procedure for 005/015/016/017 is approved and tested.
- [ ] Writers are quiesced during schema work; no clean/reset/drop operation
      is used.
- [ ] Post-start health, readiness, read-only admin, preview, reconciliation,
      and preservation checks are recorded.
- [ ] No push or automatic GitHub deployment was used without an explicit
      release approval.

## Deployment record template

Complete this record at deployment time; leave fields blank or marked pending
until verified:

```text
Candidate commit:
Image reference and immutable digest:
BEIA package version/checksum (if shipped):
Target host/proxy:
Database/server/version/TLS:
Backup path and manifest checksum:
Restore rehearsal result:
Writer-quiescence window:
Migration procedure/version and verification:
Pre-deploy table counts/digests:
Post-deploy table counts/digests:
RPC URL owner / chain ID / token contract:
Treasury address / signer secret reference:
Health/readiness result:
Preview and partner smoke result:
Rollback decision and previous image digest:
Approver and UTC timestamp:
Unresolved risks:
```

The release notes and local evidence deliberately leave these target fields
pending. Completing them requires target access and an explicit deployment
decision; it is outside this local documentation update.
