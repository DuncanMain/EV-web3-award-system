# Deployment handoff for Dejan

**Review handoff only — not a deployment approval.** The reviewed source
candidate is not deployed. Do not send this document as evidence that a
production release exists.

## Branch and automation boundary

The reviewed candidate is prepared for the existing ZentrixLab/neverflat
`development` branch. Keep Zentrix `main` unchanged until the target release
has passed the backup, migration, preservation, and acceptance gates. The
production workflow is attached to pushes to `main`; do not merge or push to
`main`, invoke that workflow, or rely on a `:latest` image as a release
identifier during this handoff.

This handoff does not push, publish, start, restart, or reconfigure any
service.

## Verified local evidence

The exact command results are consolidated in
[RELEASE_VERIFICATION_2026-10-01.md](RELEASE_VERIFICATION_2026-10-01.md):

- backend build passed;
- 17 Jest suites passed with 321 tests passed and 6 opt-in tests skipped;
- disposable PostgreSQL checks passed 15 tests across 2 suites;
- HTTP contract matrix passed 178/178 cases;
- admin HTTP matrix passed 199/199 cases;
- frontend build and focused TypeScript checks passed; and
- the BEIA package checks passed 12 tests with no publication.

These are local/disposable results. They do not verify target credentials,
target data, target restore, live RPC/provider behavior, or partner webhook
delivery.

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
5. Inspect target history for migration 005 duplicate contract IDs and
   migration 015 duplicate transaction hashes. Approve a target-specific
   additive migration procedure for policy 016 and session guard 017.
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

If a rollout fails, stop writers and follow the approved application rollback
plan. Do not roll back the database over chain activity and do not replay or
compensate a token transfer merely because an application image was reverted.
Unknown movement remains review-only until its existing operation evidence is
resolved.

## Open release facts

The immutable release SHA, image digest, target database/backup record,
restore result, migration decision, maintenance window, target secret owners,
and final approval are still pending. No live deployment claim should be
made until those fields are filled from verified target evidence.
