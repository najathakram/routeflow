# api — Catch-up 2026-09-21: scripts, prisma schema/migrations, jest lanes, root tooling

> Drift baseline `c19cb81` -> HEAD. Scope: `apps/api/{scripts,prisma,jest.*}`, app-root configs, root `scripts/`. Signatures only; trust the code over this file. Packages live in [`../packages.md`](../packages.md) `## Catch-up 2026-09-21`.

## Prisma schema folder (`apps/api/prisma/schema/*.prisma`)

- `apps/api/prisma/schema/catalog.prisma` — Product, ProductUnit, ProductCategory, ProductCategoryLabel, StockLot/Movement, PurchaseOrder, Supplier; NEW `ProductCategoryLabel.parentProductIdAtWrite String?` (EXCLUDE opt-out parent pin, null = inert; #1093/#990).
- `apps/api/prisma/schema/compliance.prisma` — TrackedCategory/Subcategory, CustomerAuthorization, RegulatedSalesLedger/Filing, TobaccoReport, SellingRestriction; only a COMMENT changed: lift sets liftedAt/By/Name/Reason, effectiveTo untouched (#1093).
- `apps/api/prisma/schema/finance.prisma` — Invoice, Payment, CreditNote, Estimate, VendorBill, Expense, RecurringInvoice, BuyerPaymentRequest, TenantStripeConnect; UNCHANGED since c19cb81 (listed because the stop-gate flagged it unmapped).
- `apps/api/prisma/schema/platform.prisma` — billing/entitlement + messaging + audit + import + CRM/mailbox models; NEW enum `SnapshotReason(DOWNGRADE,MANUAL)` and model `TenantFeatureConfigSnapshot` (tenantId, planKey, takenAt, reason, payload Json, restoredAt, createdBy*) (#1002).
- `apps/api/prisma/schema/sales.prisma` — Customer/CustomerAddress, Order/OrderItem, Route*, Driver, Promotion, Return, SaleDraft, Commission* and SalesAgent models; UNCHANGED since c19cb81 (flagged unmapped).
- `apps/api/prisma/schema/tenancy.prisma` — Tenant, TenantConfig, User, BuyerAccount, CustomerLink, tokens; Tenant gains back-relation `featureConfigSnapshots TenantFeatureConfigSnapshot[]` (#1002).

## Migrations (`apps/api/prisma/migrations/`)

- `20260919120000_tenant_feature_config_snapshot/migration.sql` — additive DDL: CREATE TYPE "SnapshotReason"; CREATE TABLE "TenantFeatureConfigSnapshot" + index (tenantId,takenAt) + FK -> Tenant ON DELETE CASCADE; no backfill (#1002).
- `20260920010000_product_category_label_parent_pin/migration.sql` — `ALTER TABLE "ProductCategoryLabel" ADD COLUMN "parentProductIdAtWrite" TEXT` (nullable, no default/index; legacy rows stay null by design; Squawk-clean) (#990).

## Jest lanes (`apps/api/jest.*.config.js`; all spread `package.json#jest`, `reporters:["default"]`)

- `apps/api/jest.db.config.js` — DB-backed lane: testRegex `*.db.spec.ts`, timeout 30 s, `maxWorkers:1` (shared DB; whole-table specs raced, B592); run by `npm run test:db -w apps/api` / root `local:test:db`.
- `apps/api/jest.repo-truth.config.js` — repo-invariant specs only (docs-truth, no-dead-deps, no-single-schema-path, size-ratchet, bugs-self-test-script, denied-identifiers ...); `npm run test:repo-truth` (always run by scoped verify).
- `apps/api/jest.smtp.config.js` — NEW: `*.smtp.spec.ts` lane vs local mailpit (STARTTLS+AUTH), timeout 60 s; `npm run test:smtp -w apps/api`, root `local:test:smtp` (#991).

## apps/api/scripts

- `apps/api/scripts/backup-production.mjs` — NEW prod pg_dump CLI under `railway run --service postgres`; writes gitignored `backups/production_<ts>_<label>.sql`, rejects thin/truncated dumps to `*.INVALID`; exit 0/1/2; calls `runBackup`, `findPgDump`.
- `apps/api/scripts/lib/backup-dump.mjs` — pure helpers; exports `scanDump(lines)`, `dumpProblems(stats)`, `buildPgDumpInvocation(env,file)`, `findPgDump()`, `runBackup()`, `MIN_TABLES=100`, `REQUIRED_DATA_TABLES` (Tenant,User row floors, B578).
- `apps/api/scripts/normalize-address-states.mjs` — NEW dry-run-first backfill of `CustomerAddress.stateCode` from free-text `state`; `--live` needs typed phrase, test-tenant guard, `--google` opt-in; unresolved rows only get `stateNeedsReview=true`.
- `apps/api/scripts/lib/address-state-normalize.mjs` — pure decision layer; exports `classifyLocal(raw)`, `classifyBatch(rows,opts)`, `foldState`, `validateWithGoogle`, `checkZipAgreement`, `buildUpdates`, `planRun`, `applyUpdates`, `assertMaxRows`, `STATE_ALIASES`, `REASONS`.
- `apps/api/scripts/lib/us-states.mjs` — verbatim JS mirror of `packages/types/api/us-states.ts`; exports `US_STATES`, `normalizeUsState(input)`; parity pinned by `us-states-script-mirror.parity.spec.ts`.
- `apps/api/scripts/lib/us-zip3.mjs` — USPS ZIP3 -> state(s) table; exports `ZIP3_RANGES`, `zip3States(zip)` (null = no reliable state), `zip3Prefix(zip)`; false CONFLICT ok, false AGREEMENT not.
- `apps/api/scripts/publish-and-repin.mjs` — NEW PR-0b zero-loss CLI: `--report` (default, read-only diff old-vs-new entitlement path per PRODUCTION tenant) and `--apply` (per-tenant GRANT overrides, typed confirm); helpers `computeDiff`, `runReport`, `applyGrants`.
- `apps/api/scripts/lib/feature-registry-mirror.cjs` — plain-JS MIRROR of feature-registry/plan-flag-policy/plan-catalog; exports `FEATURE_REGISTRY_MIRROR`, `computeOldPathEffective`, `computeNewPathEffective`, `lossMechanism`, `normalizePlanKey`, `addonSkuCode`; edit the TS source first.
- **Modified:** `apps/api/scripts/e2e-seed.js` (numeric-max next ORD-<n> B587 #980; node 24 #971; seeded customers/products/invoice, fixture-missing fails B566 #959/#963); `split-prisma-schema.mjs` (MODEL_DOMAIN gains TenantFeatureConfigSnapshot #1002).

## App-root configs (modified)

- **Modified:** `apps/api/package.json` (`test:smtp`, repo-truth regex + size-ratchet, dep bumps #972/#991/#957); `apps/api/tsconfig.build.json` (excludes `**/testing/**` #1053).
- **Modified:** `apps/mobile/{jest.config.js,metro.config.js,package.json}` (alias `@routeflow/scanning` to packages/scanning/src/index.ts #948); `apps/mobile/eas.json` (node 20.19.4 -> 24.14.0 #974).
- **Modified:** `apps/web/next.config.mjs` (transpilePackages += `@routeflow/scanning` #948); `apps/web/package.json` (dep `@routeflow/scanning`, dep bumps #972/#977).

## Root `scripts/`

- `scripts/verify-turbo.mjs` — NEW turbo step of `npm run verify` (check-types + lint + Jest + api repo-truth); affected-scope by default off-master via `decideScope`, FULL_VERIFY=1 forces all; adds stale workspaces (#957/#1040). Proof: `verify-turbo.self-test.mjs`.
- `scripts/lib/verify-scope.mjs` — NEW scope selector; exports `loadWorkspaces(root)`, `computeScope(changedFiles,ws)`, `changedFilesSince`, `decideScope(root,env,probe)`, `staleWorkspaces`, `withStale`, `cleanGitEnv`, `shortName`; FULL on manifests/lockfile/CI/hooks.
- `scripts/release-health.mjs` — NEW read-only Sentry release comparator, `npm run release-health -- <new> <prev>`; exports `issuesAtOrAboveSeverity`, `topOffenders`, `totalEventsFromStats`, `eventsPerHour`, `buildComparison`, `formatReport`; exit non-zero on new severe groups.
- **Modified (root):** `scripts/campaign-check.mjs` (`--print-stale` lists workspaces whose T1 report is stale, #1040; scan-engine extraction #948); `scripts/local-env.mjs` (`--smtp-specs` flag, #991); `scripts/validate-code-map.stamp.self-test.mjs` (macOS realpath/zombie, B573/B574 #955).
- **Modified (`scripts/campaign/`):** `bugs.mjs` (lock races B588 #993; macOS realpath B573/B574 #955); `plane-doctor.mjs` (B591 #1074); `plane-*.self-test.mjs` x6 (apply/doctor/intake/learning/sync/triage: retry runner #993, #1074, #955).
- **Modified (`scripts/campaign/` self-tests, #993 #1074):** `plane-apply.self-test.mjs`, `plane-doctor.self-test.mjs`, `plane-intake.self-test.mjs`, `plane-learning.self-test.mjs`, `plane-sync.self-test.mjs`, `plane-triage.self-test.mjs` — event-driven lock-race + load-tolerant timing fixes; no signature change
- **Modified (billing):** `apps/api/src/billing/billing-notification.templates.ts` — checkout-hook alarm/notification copy touched by B593 (#1081); template signatures unchanged

## Update b8765689 → HEAD: T6 tenantId forensics, data-questions report, e2e-seed buyer fixture

### Prisma schema folder (additive, A0 #1131)
- `prisma/schema/finance.prisma` — `EstimateItem` gains `unitLabel String?`, `unitsPerBox Int?` (InvoiceItem's twins, null = pack); `RecurringInvoiceItem` gains `unitLabel String?`.
- `prisma/schema/sales.prisma` — `OrderTemplateItem` gains `unitLabel String?` (OrderItem's twin, null = pack).

### `scripts/lib/` (new shared helpers)
- `local-db-target.cjs` — **NEW**, allowlist (never denylist) local-DB classifier; `isLocalDbTarget(dbUrl)`, `LOCAL_DB_HOSTS` (localhost/127.0.0.1/::1/postgres). Same host set as `assertSafeTarget` in `prisma/seed.ts`. No override flag. Caller: `e2e-seed.js` (keeps the global approved-buyer fixture off every non-local target).
- `data-questions.cjs` — **NEW**, CommonJS question set + runner behind `data-questions-report.mjs`; `QUESTIONS` (16 read-only findings, each its own SAVEPOINT+timeout+row-cap), `assertReadOnly(sql)` (rejects anything not `select|with`), `parseOnly(arg)`, `runReport(...)`. CommonJS so the Jest spec can load it and drive the runner with a fake client.

### `scripts/` (T6 — NULL-tenantId forensics, all read-only except the drop/stamp tools)
- `t6-null-census.mjs` — **NEW**, read-only pre-check counting NULL `"tenantId"` rows across the 56 tables the T6 guard migration CHECKs; table list parsed from the migration itself so it can't disagree; exports `guardedTables(sql)`; `--guards` mode instead verifies the 56 constraints exist/are validated; exit 1 = NULL rows found (do not migrate).
- `t6-backfill-census.mjs` — **NEW**, read-only census (counts only) of the 19 models left OUT of the guard migration because their writers were unproven; exports `BACKFILL_TABLES`.
- `t6-null-rows-report.mjs` — **NEW**, identifies WHICH rows the census found (id + createdAt per guarded table); for StockLot/CreditNote (the two the prod census flagged) also prints the FK-derived tenant and whether it's UNAMBIGUOUS (exactly one distinct non-null tenant).
- `t6-stamp-null-rows.mjs` — **NEW**, id-pinned remediation: stamps `tenantId` only on named, still-NULL, unambiguous-FK rows of StockLot/CreditNote; dry-run is the default and the only thing an `--ids`-less run does; `--live-tenant-override` + typed confirmation gates a live (non-test) tenant; never a table-wide UPDATE.
- `t6-drop-guards.mjs` — **NEW**, rollback: drops all 56 `<table>_tenantId_nn` CHECK constraints in ONE transaction (all-or-nothing); refuses to run without `--yes-drop-t6-guards`. The only prod-writing T6 tool besides the migrations themselves.
- `data-questions-report.mjs` — **NEW**, ONE read-only report turning the units/regulated-tax findings into per-tenant counts + dollar/stock deltas; 16 questions (`--only N,M`, `--list`), each its own READ ONLY SAVEPOINT with a timeout/row-cap so one bad question doesn't sink the rest; contains tenant ids — operator's terminal only, never a PR/issue/commit. Delegates the question set/runner to `lib/data-questions.cjs`.
- **Modified:** `e2e-seed.js` (+107) — new approved-buyer fixture: `BUYER_EMAIL`/`BUYER_PASSWORD`/`BUYER_CUSTOMER` consts, a GLOBAL BuyerAccount (committed throwaway password) ACTIVE-linked to its OWN dedicated customer (`CustomerLink.customerId` is `@unique` — never reuses `harbor_cafe` or the picker fixtures); guarded by the new `isLocalDbTarget` (this script also runs against production via `railway run`, so the buyer is created only on a local target). Header now notes `npm run local:seed` runs `prisma/seed.ts`, NOT this script.
