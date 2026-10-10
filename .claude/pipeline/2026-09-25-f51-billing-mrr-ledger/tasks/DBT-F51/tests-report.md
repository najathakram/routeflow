# DBT-F51 — tests-report

## Status: NOT RUN (by design — NEED-DB lane)

`apps/api/src/common/override-activation-ledger.db.spec.ts` is a `NEED-DB` spec (header:
`NEED-DB: run by the F2 prover, not in engine gates`), collected only by
`apps/api/jest.db.config.js` (`testRegex: ".*\\.db\\.spec\\.ts$"`). Per this task's brief and the
harness instruction for this phase ("Do NOT run it"), it was authored but not executed in this
session.

Structural note on why a normal RED run isn't meaningful here: `describeDb()`
(`apps/api/src/common/testing/db-spec.ts`) throws synchronously at test-collection time —
_before_ any `it()` block runs — whenever `RUN_DB_SPECS` is unset:

```
DB-backed specs invoked without RUN_DB_SPECS — run them through npm run local:test:db (or the CI lane)
```

That guard fires unconditionally, independent of whether the behavior under test exists, so this
spec cannot be collected/run in this session without `RUN_DB_SPECS=1` + a live Postgres
(`DATABASE_URL`) + a published plan catalog (`npm run local:seed`), none of which this session has
or should stand up per the F51 pipeline split (NEED-DB lane owned by the F2 prover against the
compose stack).

## What was verified instead

- `npx tsc --noEmit -p apps/api/tsconfig.json` — ran successfully, exit code 0, zero `error TS`
  lines (including for the new file) — confirms the spec type-checks against the real
  `PlatformAdminService` (17-ctor-arg order), `SubscriptionMutationService` (10-ctor-arg order),
  `MrrService`, `PlanCatalogService`, and `BillingEventService` signatures, and against the real
  Prisma model shapes it writes/reads (`Tenant`, `TenantSubscription`, `TenantAddon`,
  `BillingEvent`).
- No implementation code was written or modified; only the test file above was created.

## Expected behavior once run by the F2 prover (from the task's DB1/DB2 test-plan rows)

- DB1: TRIAL/PRODUCTION tenant, `basePriceSnapshot: null` → `updateTenantPriceOverride(monthly:
1200)` books ledger Σ = 0, snapshot backfilled to 1200 → `activateManualSubscription(plan:
PROFESSIONAL, billingPeriodDays: 365, paymentMethod: BANK_TRANSFER)` books ledger Σ = 1200 in
  exactly one `plan.changed` row, `priceTenant()` = 1200, subscription `cycle === "ANNUAL"`.
- DB2: TRIAL tenant, `enableAddon("CUSTOMER_PACK_100", 2)` books ledger Σ = 0 (not yet paying),
  `TenantAddon.priceSnapshot` = catalog price; a price-override backfill (same mechanism as DB1)
  also books nothing; activation then books ledger Σ = base + snapshot×2 in exactly ONE row
  (base and add-on together, no double count); `disableAddon` then nets the ledger back to base
  alone.

Run command for the prover: `npm run local:test:db` (or, directly:
`RUN_DB_SPECS=1 npx jest --config apps/api/jest.db.config.js src/common/override-activation-ledger.db.spec.ts`
from `apps/api`, against the compose Postgres with a published catalog).
