# NVF Award Core deployment and operations

This runbook describes the checked-in Neverflat deployment flow and the
target facts that still belong to the operator. A push to main runs one
automatic build-and-deploy workflow. The workflow does not use a manual
release dispatch or a repository approval file.

## Deployment status

The current main baseline is merge commit
62dda34ecd17bc2001434dc90f259862a9d47d1f. GitHub's latest successful
automatic deployment is run 37936154795 on 9 October 2026. This review does not
claim that this candidate has been deployed. Local verification uses disposable
resources and never supplies live credentials or production data.

## Automatic main-push deployment

The production workflow is limited to a push on main and keeps a single serial
build-and-deploy job. It checks out the commit, builds the existing Dockerfile,
and pushes the existing latest and commit tags to GHCR. The Dockerfile
pins both its build and runtime stages to `node:24.22.1-alpine`, so local
container builds and production deployments use Node.js 24.22.1. The image
includes the backend and frontend built with that version. The Dockerfile
entrypoint remains:

~~~text
node dist/database/migrate.js && node dist/api.js
~~~

The image therefore applies the repository migration chain before the API
listens. The production Compose file keeps the existing database and app
definition; the app-only command below does not start or recreate PostgreSQL.

Before copying compose.production.yaml, the workflow makes a read-only SSH
check. /root/neverflat must resolve to the canonical directory, .env must
exist inside it, the existing neverflat-db labels must be neverflat|postgres,
and any existing neverflat-app must be labelled neverflat|app. The existing
Compose destination must be a regular path inside the canonical directory.
The check also verifies the Compose plugin and reads the existing shared-proxy
network; it never creates that network.

The deploy step validates the forwarded full source SHA, rechecks the
canonical .env, compose file, database, app labels, and shared-proxy before
removing legacy compose names or changing the target. It then creates a
mode-600 private dump of nvf_award from neverflat-db using the postgres role,
and runs pg_restore --list against that dump before pulling or launching the
new app. GHCR login uses a temporary DOCKER_CONFIG directory below
/root/neverflat. Any existing /root/.docker/cli-plugins directory is made
discoverable through that temporary config; the owned temporary directory is
removed on exit and shared Docker credentials are left alone. The current
secret resolver remains in the automatic workflow and its values are passed
only to the target-side process.

After the backup is verified, the service operations are explicitly scoped to
Neverflat:

~~~bash
docker compose -p neverflat -f compose.production.yaml pull app
docker compose -p neverflat -f compose.production.yaml up -d --no-deps app
~~~

The workflow then polls the loopback /ingest/health endpoint with bounded
timeouts. A failed health check fails the job without running a financial or
admin smoke test. The workflow does not use --remove-orphans, start or
recreate the database, mutate a different Compose project, or print the
database dump or secret values. The backup is retained below
/root/neverflat/backups for the target operator.

## Target facts and invariants

Record these values through the target owner without placing secrets in Git or
workflow logs:

- target host, proxy route, maintenance window, and secret owner;
- PostgreSQL server, database, role, volume, backup location, and restore owner;
- POLYGON_RPC_URL, optional same-chain fallback endpoints, CHAIN_ID, token
  contract, and treasury address;
- treasury signer source, API/admin credentials, identity header, and alert
  ownership; and
- the provisioned test eMAID and partner smoke-test payloads.

Keep the existing eMAID-to-wallet derivation salt, treasury identity, token
contract, chain, signer, balances, awards, spends, receipts, reservations,
operation rows, and linked-wallet mappings. Do not relink wallets, reset the
database, delete history, or replay a financial operation because an app
deployment was retried.

The checked-in Compose file uses the existing .env, PostgreSQL database
nvf_award, role postgres, named volume pgdata, app container neverflat-app,
database container neverflat-db, and external network shared-proxy. The app
binds to 127.0.0.1:3005; PostgreSQL is not published. The existing target
environment and secret resolver remain the source of truth.

## Migration and backup boundary

The automatic image entrypoint runs migrations before the API starts. The
workflow takes the target-local pg_dump backup and verifies its readable
manifest before compose up; it does not run a second database creation or a
loopback migration runner. A target owner must still confirm that the existing
data is compatible with migrations 001 through 017, active-wallet migration
022, and transaction-reliability migration 023 before accepting the new app.
Migration 023 covers durable prepared context, approval funding attempts,
immutable settlement context, the treasury lease table, and nonce uniqueness.

For any target migration decision, quiesce writers through the target's normal
maintenance process, retain the verified backup, and restore-test a disposable
copy. Do not use compose down -v, DROP DATABASE, table cleanup, or
financial-row edits as deployment steps. The workflow backup is evidence of
the target state; it does not authorize a restore over the live database.

## RPC and application runtime

The runtime accepts the configured RPC primary and same-chain fallback
described in API.md. The default Polygon Amoy fallback is the verified
PublicNode endpoint; a custom primary requires an explicit same-chain backup.
Reads and preparation calls use bounded retries. A raw transaction may fail
over only with the exact already-signed bytes; the service never re-signs,
allocates a new nonce, or creates a replacement during provider failover.
Operation diagnostics retain the original identity and distinguish dependency
failure, ambiguous broadcast, and confirmation pending states.

Use the API and admin evidence endpoints for diagnosis. Do not use a real CDR,
spend, or reconciliation write as a generic deployment smoke test; those calls
can create reservations or financial side effects.

## Local verification

The focused offline checks are:

~~~powershell
python scripts/test_production_deployment.py
python scripts/test_production_workflow.py
~~~

The first suite covers the existing deployment helpers. The second executes
the workflow's extracted SSH scripts against fake Docker/PostgreSQL commands
and verifies wrong project/service, symlink, backup ordering, temporary Docker
config cleanup, health polling, and app-only Compose operations. These checks
do not contact a server, registry, provider, or production database.

The full application, frontend, package, and disposable PostgreSQL evidence is
kept under the dated diagnostic output used for the corresponding review. A
successful local check does not prove target credentials, target data
preservation, partner delivery, or live chain state.

## Rollback and incident handling

If the new app fails health or readiness, retain the image, logs, backup
manifest, migration output, and RPC/transaction evidence. Stop the app through
the target's normal operator process and use a compatible image only after
checking schema and pending financial operations. Do not roll back the
database over chain activity, delete audit rows, rewrite wallet mappings,
submit a compensating transfer, or blindly replay an unknown operation.

An older image may not understand active-wallet selection or transaction
reliability state. A rollback therefore requires a reviewed schema/data
compatibility decision and reconciliation of any saved transaction hash,
nonce, reservation, or settlement context before writers reopen.
