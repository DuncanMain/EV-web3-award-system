# Deployment handoff

This handoff describes the automatic Neverflat test-environment deployment
that runs after a push to main. It keeps the existing build, image tags,
Compose file, secret resolver, and Dockerfile migration entrypoint. A manual
release dispatch and a repository approval record are not part of this flow.

## Automation boundary

The single build-and-deploy job builds the existing Dockerfile and pushes
ghcr.io/zentrixlab/neverflat:latest plus the commit tag. It then performs a
read-only SSH target check, copies compose.production.yaml, and runs the
target-side backup, registry login, pull, app-only start, and loopback health
check.

Before SCP, /root/neverflat must resolve to the canonical Neverflat directory.
The existing .env must be inside that directory, the Compose destination must
not be a symlink or escaped path, neverflat-db must carry Compose labels
neverflat|postgres, and any existing neverflat-app must carry neverflat|app.
The check reads shared-proxy and verifies Compose without creating a network or
touching a service.

The deploy step validates the forwarded full source SHA, rechecks the
canonical .env, compose file, database, app labels, and shared-proxy before
removing legacy compose names or changing the target. It then writes a private
mode-600 pg_dump for database nvf_award as role postgres, and verifies the dump
with pg_restore --list before app launch. GHCR login uses a temporary DOCKER_CONFIG
below /root/neverflat; the workflow carries forward any existing root Docker
CLI plugin directory and removes only its owned temporary directory. It then
runs:

~~~bash
docker compose -p neverflat -f compose.production.yaml pull app
docker compose -p neverflat -f compose.production.yaml up -d --no-deps app
~~~

The bounded /ingest/health poll must succeed after app launch. The workflow
does not create shared-proxy, use --remove-orphans, start PostgreSQL,
recreate the database, or print secrets or dump contents. The existing target
secret resolver remains scoped to the Neverflat process.

## Local evidence

The focused offline checks are:

~~~powershell
python scripts/test_production_deployment.py
python scripts/test_production_workflow.py
~~~

They exercise the helper and workflow behavior with disposable local fixtures
and fake Docker/PostgreSQL commands. They do not provide live target
acceptance, provider health, partner delivery, or financial-chain evidence.

## Data and runtime boundary

The Dockerfile entrypoint runs the checked-in migration chain before the API
listens, including active-wallet migration 022 and transaction-reliability
migration 023. The target backup is taken before the new app is launched; it is
not a license to restore over the target or edit financial rows. Preserve the
existing eMAID, wallet, balance, award, spend, receipt, reservation, operation,
signer, chain, and token identities.

The RPC fallback documented in API.md is same-chain and bounded. Raw-send
failover may retry only identical already-signed bytes and retains the original
operation identity. It never re-signs, allocates a new nonce, or creates a
replacement.

## Open target facts

Before treating a run as accepted, the operator still records the target host,
proxy route, PostgreSQL backup and restore result, image/build revision, chain
identity, signer source, configured credentials, health/readiness response, and
any pending transaction or migration evidence. A local or CI success does not
verify those target-specific facts.
