# NEVERFLAT local release verification

**Status:** local candidate evidence only. This record does not authorize a
push, publication, database migration, or deployment. The target release
commit, image digest, credentials, backup, and deployment record remain
unassigned.

The checks below were run against the local candidate with disposable or
loopback resources. No live server, target database, production RPC, external
provider, partner webhook, or production wallet was used.

## Recorded checks

| Area | Command or scope | Result |
| --- | --- | --- |
| Backend build | `npm.cmd run build` | Passed. |
| Backend tests | `npm.cmd test -- --runInBand` | 17 suites; 321 passed, 6 opt-in tests skipped. |
| Disposable PostgreSQL | `node scripts/run-disposable-postgres-tests.js` | 2 suites; 15 passed against a unique disposable database. |
| HTTP contract | `node scripts/verify-api-contract-matrix.js` | 178/178 finite disposable HTTP cases passed; route inventory and safe error checks included. |
| Admin HTTP contract | `node scripts/verify-local-admin-api-matrix.js` | 199/199 disposable-fixture cases passed with no findings. |
| Award/recovery flow | `node scripts/verify-local-award-flow.js` | Local disposable PostgreSQL, Hardhat 31337, and API flow passed identity, policy, receipt, recovery, failure, concurrency, and replacement-session checks. |
| Frontend | `npm.cmd --prefix frontend run build` and the focused strict TypeScript command in `DEPLOYMENT.md` | Passed. |
| BEIA package | `npm.cmd --prefix packages/sparkz-charging-card test` | 12 package lifecycle/artifact checks passed; package remains unpublished. |

The local candidate also recorded policy persistence/reload, migration 017,
financial/identity digest preservation, admin recovery, audit redaction,
reconciliation, alert feedback, and evidence-export checks. Those results are
summarised here rather than copied from local output logs or database dumps.

## Release boundary

The source candidate is intended for review on the Zentrix development branch.
The production source of truth remains Zentrix `main`; this candidate is not a
production release. Do not push this commit to `main`, trigger the production
workflow, or treat the local `:latest` compose reference as an immutable image.

Before a target rollout, assign an immutable commit and image digest, verify
the target API/ingest/admin/RPC/signer configuration, quiesce writers, take a
fresh physical backup, restore-test an isolated copy, and compare before/after
financial, wallet, eMAID, operation, receipt, reservation, and policy digests.
Inspect migrations 005 and 015 against target history before deciding how the
additive policy/session-guard changes are activated. Preserve existing eMAID,
wallet derivation, signer, token, chain, and historical rows.

The local scoped migration runners are loopback-only review tools. They are
not production deployment commands. A target migration and rollback plan must
be approved separately. Rollback must not restore a database over new chain
activity or replay a transfer to compensate for an application rollback.

## Known limits

- No target credentials, target database, target backup restore, external RPC,
  EMP/provider, partner webhook, or live wallet was verified.
- Mobile-width rendering and production multi-replica coordination remain
  outside this record.
- The BEIA candidate is `@neverflat/sparkz-charging-card@0.2.1-rc.1` and is
  unpublished. Align it with the matching backend/API version before use.
- Local evidence contains no authorization to rotate keys or alter production
  configuration.
