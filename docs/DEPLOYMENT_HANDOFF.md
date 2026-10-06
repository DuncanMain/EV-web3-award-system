# Deployment handoff

The deployed main baseline is merge commit `87b35bdf4e0d9bde7b4d8c4cbb93ab459b0f321a`
(PR #6, 6 October 2026). This handoff records the operational procedures,
current verification evidence, and target facts required before a production
rollout.

## Branch and automation boundary

The existing ZentrixLab/neverflat `development` branch is used for integration.
Keep the deployed baseline and `main` unchanged until the target release has
passed the backup, migration, preservation, and acceptance gates. The
production workflow is attached to pushes to `main` and uses an immutable
Docker digest, not a `:latest` release identifier.

## Verified local evidence

The exact command results are consolidated in
[RELEASE_VERIFICATION_2026-10-01.md](RELEASE_VERIFICATION_2026-10-01.md):

These results are the dated historical local candidate record; they are not
target acceptance evidence for the current source.

- backend build passed;
- 17 Jest suites passed with 321 tests passed and 6 opt-in tests skipped;
- disposable PostgreSQL checks passed 15 tests across 2 suites;
- HTTP contract matrix passed 178/178 cases;
- admin HTTP matrix passed 199/199 cases;
- frontend build and focused TypeScript checks passed; and
- the BEIA package checks passed 12 tests with no publication.

These are local/disposable results. They do not verify target credentials,
target data, target restore, live RPC/provider behavior, post-start health or
readiness, or partner webhook delivery. Package publication and partner
handoff remain unclaimed.

The current package artifact was repacked after the reproducible build
instructions were changed to `npm ci`. Its SHA-256 is
`1E7B4666445AC129FA00299F1F5BA9A784DD61DDD3565527AC962784B3AD4AFE`.
Node 22 backend verification passed 19 Jest suites with 327 tests and 12
opt-in tests skipped, plus 21 real PostgreSQL integration checks. The current
deployment helper suite passed 16 focused tests and the charging-card package
passed 12 tests; the frontend build and package/frontend audits passed, and a
portable Node 22 probe returned `v22.23.3`. The combined Node 22.23.3
root/frontend/Sparkz `npm run ci:check` passed with all audits at zero
vulnerabilities. The target acceptance record remains pending.

## Required target gate before deployment

1. Freeze and record the reviewed source commit and immutable image digest.
2. Confirm the target host, proxy, secret owner, database identity, chain,
   token contract, treasury address, signer source, API/ingest/admin keys,
   alert ownership, and maintenance window without placing secrets in Git.
3. Quiesce API ingestion, manual spend, reservation settlement, policy writes,
   scheduled jobs, and partner replay.
4. Take a fresh physical PostgreSQL backup, verify its manifest, restore it to
   an isolated copy, and capture before row counts and content digests for
   users, balances, awards, spends, receipts, operations, approvals,
   reservations, policy, reconciliation, and linked-wallet tables.
5. Inspect target history for duplicate `(uid, lower(wallet_address))` pairs,
   confirm migration 008's scoped uniqueness and removal of the obsolete global
   UID constraint, and review migration 015 duplicate transaction hashes.
   Approve a target-specific additive migration procedure for policy 016,
   session guard 017, and standalone active-wallet migration 022. Campaign
   migrations 018–021 remain outside this release.
6. Apply the reviewed migration with the API stopped, verify schema/index
   readiness, and compare the preservation snapshot. Do not use local
   loopback migration runners against a target.
7. Start the approved immutable image and run health, readiness, identity,
   preview, reservation/receipt, reconciliation, alert, and evidence checks.
   `GET` reconciliation is read-only; the reconciliation `POST` writes an
   audit/report record and must be an explicitly approved operational check.
8. Record the approver, UTC time, backup/restore result, migration result,
   digest comparison, smoke evidence, and rollback decision.

## Invariants and rollback

Preserve eMAID ownership and all existing wallet derivation, wallet mappings,
balances, awards, spends, receipts, reservations, operation rows, signer,
token contract, and chain identity. Do not relink wallets, rotate keys, reset
the database, or clean historical duplicate rows as part of this handoff.

Migration 022 retains historical wallet rows while persisting the explicitly
active wallet. A rollback to an older image must review active-wallet selection
and pending financial operations; it must not automatically drop the selection
or rewrite mappings or financial rows.

The deployed baseline's startup chain can restore migration 005's global UID
uniqueness rule. With multiple wallets for one UID, an older rollback image may
fail on duplicate data or ignore `is_active` and select the oldest row. Use an
image with reviewed schema/data compatibility; never delete or deduplicate
wallet/history rows to make an older image start. Any data restore remains an
explicit operator decision with pending token-operation reconciliation.

If a rollout fails, stop writers and follow the approved application rollback
plan. Do not roll back the database over chain activity and do not replay or
compensate a token transfer merely because an application image was reverted.
Unknown movement remains review-only until its existing operation evidence is
resolved.

## Open release facts

The production workflow and mirror results for the deployed baseline are
recorded in the root deployment documentation. The built image digest and
target post-start acceptance response for that run are not captured here. The
source revision, image digest, target database/backup record, restore result,
migration decision, maintenance window, target secret owners, and final
approval remain target-specific handoff fields.
