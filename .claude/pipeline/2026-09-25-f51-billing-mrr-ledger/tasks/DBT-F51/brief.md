### DBT-F51 — NEED-DB spec (authored here, run by the F2 prover, never in engine gates)

Create `apps/api/src/common/override-activation-ledger.db.spec.ts` per test-plan "NEED-DB lane" (DB1, DB2); header `NEED-DB: run by the F2 prover, not in engine gates`. Pattern: `apps/api/src/common/update-tenant-class-ledger.db.spec.ts` (17 ctor args, that order). `afterAll` deletes its tenants. Do NOT run it.
