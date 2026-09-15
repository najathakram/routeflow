# api — Bootstrap & cross-cutting — schema-folder & tenant-data backfill scripts

> Split from [`../bootstrap-cross-cutting.md`](../bootstrap-cross-cutting.md) (verbatim, lines 7-206 of the pre-split file) on 2026-09-15. See [`../../INDEX.md`](../../INDEX.md).

## Bootstrap & cross-cutting

- **`eslint.config.mjs` (B126 selectors, 2026-08-30, #503)** — two `no-restricted-syntax`
  entries ban unscoped bulk writes: `deleteMany()`/`updateMany()` called with zero arguments, and
  either called with an empty-object argument (`deleteMany({})`) — both messages point at
  `{ where: { tenantId } }`. Landed as a standalone PR after #506 (`cc8c7d46`) fixed the ten
  real hits this would have tripped in `system-config/settings.controller.ts`, so it lands with
  zero eslint-disable lines. A third selector (bare `where` missing `tenantId`) and a money-math
  AST selector were evaluated and deliberately rejected as noisy — see #502.
- **`scripts/schema-drift.mjs` + `scripts/lib/railway-db-url.mjs` (PR-1, `imp-03a`, 2026-09-03)** —
  the read-only drift gate that replaces boot-time DDL (see F12-002). `railway-db-url.mjs`
  (`resolveDatabaseUrl`/`redactUrl`/`scrubSecrets`) is the shared Railway-proxy-vars-over-
  `DATABASE_URL` URL builder, copied verbatim from `prod-migrate.mjs:22-41` and now imported by
  both. `schema-drift.mjs` shells `prisma migrate status` then `migrate diff … --exit-code` via
  `spawnSync` (`shell:false`, resolved through `require.resolve("prisma/build/index.js")`); exit 0
  = no drift, 2 = drift (SQL printed), 1 = error; `--dry-run` short-circuits before any spawn,
  `--help` prints flags/env/exit-code docs. ⚠️ `SCHEMA_DRIFT_PRISMA_CLI` (stand-in prisma CLI) is
  honoured only inside a Jest worker (`JEST_WORKER_ID`) that also sets the override, and prints a
  WARNING when it is; `NODE_ENV` is deliberately not part of the guard (CI's db-migrations job
  sets `NODE_ENV: test`) — outside a test process it is ignored with a notice, so it can never
  fake a NO DRIFT verdict. `prod-migrate.mjs` runs it after `migrate deploy`
  succeeds and fails the script on nonzero; `db-migrations.yml` runs it in CI after the same step.
  Root scripts `local:drift` / API script `db:drift` run it locally. Never touches
  `apps/api/prisma/**`. ⚠️ Since item 10a the diff argv is `--to-schema prisma/schema` — the
  FOLDER. `prisma migrate diff --help` (7.10) documents the flag as "Path to a Prisma schema
  file" and offers no folder form and no `--to-config-datamodel`; the folder nonetheless resolves
  (verified: `--from-empty --to-schema prisma/schema --script` emits all 125 CREATE TABLEs).
  `src/common/schema-drift-script.spec.ts` pins the exact argv string, so the flag can't regress
  to the deleted single file silently.
- **`scripts/split-prisma-schema.mjs` (item 10a, 2026-09-04; verdict semantics reworked
  2026-09-04, wave E structure)** — the committed, repeatable operation behind the
  schema-folder split, and its standing guard. Three explicit modes, no implicit original:
  `--write --from <path> | --from-ref <git-ref>` splits a single-file schema into
  `prisma/schema/*.prisma` (while `prisma/schema.prisma` still exists on disk neither flag is
  required; once it's gone — the normal state — `--write` requires one and says so if
  omitted); `--check [--from <path> | --from-ref <git-ref>]` **ALWAYS** runs the structural
  invariants with **no original needed** — file set, no duplicate names, `_base` holds exactly
  one datasource+generator and no model, every other domain file holds ≥1 model, every model in
  the file `MODEL_DOMAIN` names (and no stale map entry), every enum sits in a domain file that
  itself holds a model referencing it (membership, not strict "first" — see below) — printing a
  distinct `structural invariants hold` line (never the word `block-identical`) and exiting 0.
  Only when `--from`/`--from-ref` is ALSO given does it additionally re-derive the concatenation
  and prove the folder **block-identical** to that original (multiset of whitespace-normalized
  top-level blocks), printing `block-identical (N blocks)`. The retired single file itself is
  NEVER read implicitly (no `git show HEAD:...` fallback) — the one-time lossless proof against
  it was recorded at split time (`e39bf9db`, 207 blocks) and is NOT re-derivable now that the folder
  has legitimately gained models (`--check --from-ref e39bf9db` fails on block count 208 vs 207; the
  standing lossless guard is `schema-drift.mjs` / `npm run local:drift`); `--print-map` dumps the map as
  TSV. ⚠️ **Enum-ownership invariant is membership, not "first referencing model"**: literal
  "first, in original file order" is NOT reconstructable from the folder alone — domains
  interleave in the pre-split single file in ways a domain split does not preserve (verified:
  `PaymentMethod`'s true first reference is `Payment`/finance at original line 1637, but a later
  `CommissionPayout`/sales reference at line 4420 would be picked "first" by any folder-only
  domain ordering, since sales precedes finance in every reconstructable order — a false failure
  on a provably-correct placement). The check instead asserts the enum's file holds _some_
  referencing model, which needs no ordering and still catches a genuinely misplaced enum; the
  strict order-accurate proof lives in the `--from`/`--from-ref` block comparison. A block is the
  text from the end of the previous block's `}` to its own, so preceding `///`/`//` comments and
  blank lines travel with it and nothing between blocks is lost. Output is deterministic —
  re-running `--write --from-ref <ref>` reproduces byte-identical output for a ref whose model set
  matches the folder's (verified at split time against `e39bf9db`; that no longer holds — the folder
  has since gained models). Line-based parser: it hard-fails on any top-level construct not matching
  `^(datasource|generator|model|enum|type|view) Name {` and on trailing text after the last block. ⚠️ `prod-migrate.mjs` keeps its own fail-closed `RAILWAY_PROXY_VARS`
  pre-check BEFORE calling `resolveDatabaseUrl` — the helper's `DATABASE_URL` fallback exists for
  `schema-drift.mjs` (read-only) and must never reach a script that writes schema; it also prints
  `Target host: ${redactUrl(url)}` so the announced target is the URL actually migrated. Contract
  specs: `src/common/schema-drift-script.spec.ts`, `src/common/prod-migrate-script.spec.ts`
  (spawn-level, stub `npx` on PATH, no database). **2026-09-05 (L-074):** `scripts/e2e-seed.js` is
  now a third consumer — imported via dynamic `import()` (it's CJS, and CI's Node 20 can't
  `require()` an `.mjs`), `requireProxy: false` like `schema-drift.mjs` (a read like this may fall
  back to `DATABASE_URL`, unlike the writer `prod-migrate.mjs`). Contract: `src/common/e2e-seed-script.spec.ts`.
- **`scripts/backfill-legacy-tenant-ids.mjs` + `scripts/lib/legacy-tenant-backfill.mjs` (close-out
  review, 2026-09-05, OWNER-RUN)** — dry-run-first **data** repair for legacy rows whose `tenantId`
  IS NULL (prod counts 2026-09-05: `RouteRunStop` 5, `PaymentCounter` 1, `CreditNote` 1). Such a row
  is invisible to every tenant-scoped read AND reads as "foreign" to the fail-closed tenancy
  post-filter, so it cannot be fixed through the product — a NULL `RouteRunStop` still renders on
  the run card through a nested include but can never be completed/skipped, and the run
  auto-completes with it stuck `PENDING`. Three modes: default **report** (read-only, one line per
  NULL row: table, id, createdAt, parent ids, proposed tenantId, verdict + per-table
  `ok=<n> refused=<n>`), `--dry-run` (report + the exact parameterized UPDATEs with bound values,
  still read-only), `--live` (requires BOTH `--backup-attested "<text>"` **and** a typed
  `BACKFILL <n> ROWS` on a TTY, then ONE transaction of id-pinned
  `UPDATE … SET "tenantId" = $1 WHERE "id" = $2 AND "tenantId" IS NULL RETURNING "id"` — never a
  blanket UPDATE). `--json` emits the report for the owner's records. URL resolution is
  `schema-drift.mjs`'s (`lib/railway-db-url.mjs`, Railway proxy vars over `DATABASE_URL`); `pg` is
  required lazily so argument validation always precedes the driver; `SET
default_transaction_read_only = on` is set at connect in EVERY mode and lifted only after the
  confirmation. Exit **0** ok · **1** error · **2** argument refusal _before connecting_ · **3**
  confirmation refused (non-TTY or mismatched text) · **4** rolled back (a guarded UPDATE returned
  no row). Pure decision layer `lib/legacy-tenant-backfill.mjs` (no I/O):
  `classifyRouteRun`/`classifyRouteRunStop`/`classifyPaymentCounter`/`classifyCreditNote(row) →
{verdict, tenantId, reason}` over verdicts `ok` | `refuse: parent missing` | `refuse: parents disagree` |
  `refuse: singleton` | `refuse: unique-pair collision`, plus `updateSql(table)` (table names come
  from the `BACKFILL_TABLES` whitelist, never from a row) and `buildUpdates(reports)` (also throws
  when two `ok` CreditNote rows would claim one `(tenantId, creditNoteNumber)` — the per-row
  `pairCollision` EXISTS cannot see that). ⚠️ Never a migration, never run from an implementation
  session, fresh backup first; output carries ids/tenant ids/`creditNoteNumber` and enum statuses
  only — never names, amounts, `PaymentCounter.next` or the connection URL. Spec:
  `src/common/backfill-legacy-tenant-ids-script.spec.ts` (B1–B4 every classifier branch +
  `buildUpdates`, evaluated in one `node --input-type=module` shim like `railway-db-url.spec.ts`;
  B5 CLI argument refusal + read-only source pins at spawn level, no database).
  **Close-out re-check (2026-09-05):** the CreditNote SELECT also reads `i."id" AS
"invoiceRowId"`, because `invoiceTenantId` alone cannot tell "no invoice linked" from "the
  linked Invoice is GONE" or "the linked Invoice is itself NULL-tenant" — all three read NULL
  after the LEFT JOIN, and the last two used to be ACCEPTED off the Customer alone; both are now
  `refuse: parent missing` (B3g/B3h). A `buildUpdates` throw no longer fails report **or**
  `--dry-run`: the refusal prints to stdout as well as stderr and `--json` carries it as
  `batchError` with `summary.blocked: true` (`summary.ok` unchanged); only `--live` throws.
  Test-only `BACKFILL_CONFIRM_TOKEN` supplies the typed confirmation as a value, honoured ONLY
  inside a jest worker (loud WARNING, same gate shape as the watchdog's four overrides) and never
  relaxing `--backup-attested`. DB-lane spec `src/common/backfill-legacy-tenant-ids.db.spec.ts`
  (`jest.db.config.js`, `npm run local:test:db`) executes the real paths against the compose
  Postgres — D1 report and D2 `--dry-run` leave the row NULL, D3 `--live` writes the RouteRun's
  tenant, D4 a second `--live` is "nothing to do", D5 a mismatched token exits 3, D6 a non-TTY
  with no token exits 3 — over a throwaway `e2e-backfill-*` tenant whose rows all carry an
  `e2e-backfill-` id prefix, with an ok-set assertion before every `--live` so a compose database
  holding someone else's NULL-tenant rows fails the spec instead of repairing them.
  **ONE CASCADE LEVEL (2026-09-05, after the prod report):** the read-only run refused all five
  `RouteRunStop`s for one reason — their parent `RouteRun` rows are THEMSELVES NULL-tenant (two
  runs, 1 stop and 4 stops), even though each stop's `RouteStop` and the run's `Route` agree. So
  `RouteRun` is now a fourth listed/writable table and the FIRST one: `classifyRouteRun({routeRowId,
routeTenantId, stopTenantIds, stopCount})` derives the run's tenant from its `Route` (`refuse:
parent missing` when the Route row or its tenant is absent) and treats the DISTINCT non-NULL
  `RouteStop.tenantId` values reached through the run's stops as a CHECK, never a source —
  any disagreement is `refuse: parents disagree`, an empty set (`array_agg` over zero rows is NULL)
  is fine. `classifyRouteRunStop` gains `effectiveRunTenantId`: when the stop's run is NULL-tenant
  the CLI passes the tenant THIS batch will write to it (only for runs whose own verdict is `ok` —
  `ctx.repairedRunTenants`, populated by the RouteRun listing, which is why it is first in
  `TABLES`), and the unchanged three-way rule then applies, so a stop under a refused run stays
  refused and a disagreeing `RouteStop` is still refused. Report lines for such a stop carry
  `(via run repaired in this batch)`. `BACKFILL_TABLES` is now
  `["RouteRun","RouteRunStop","PaymentCounter","CreditNote"]` and that array IS the write order:
  `buildUpdates` validates every `ok` report first, then emits grouped by the whitelist, so a
  caller cannot make the batch write a child before its parent by reordering the reports; `--live`
  runs both in the SAME single transaction. Coverage: B0a–B0e (`classifyRouteRun`), B1e–B1g (the
  effective tenant relaxes nothing), B4f (ordering), B5h (CLI source pins for the listing and the
  note), and DB-lane **D7** — a second NULL-tenant `RouteRun` with two NULL-tenant stops is
  reported `ok` + `ok (via run)`, `--dry-run` shows `[1]` as the `RouteRun` statement of 3, `--live`
  repairs all three in one transaction, and the re-run is "nothing to do".
  **SECOND, MUTUALLY EXCLUSIVE TASK — `--deactivate-orphan-users` (2026-09-05, owner decision):**
  a NULL-tenant `User` has no parent row to derive a tenant from, so it can never be backfilled;
  the prod census found six (3 `SUPER_ADMIN`, correct by design, + 3 April-2026 `TENANT_ADMIN`
  leftovers that would 401 at login), and the ruling is **DEACTIVATE, NEVER DELETE** — the row,
  its FKs and its audit trail all survive and the change is reversible by hand. The task reads and
  writes ONLY `WHERE "tenantId" IS NULL AND "role" <> 'SUPER_ADMIN'` and writes only
  `User.status`, never a `tenantId`. The default task is nameable as `--backfill-tenants` for
  exactly one reason: asking for both is **exit 2** ("mutually exclusive"), never a silent choice
  of one. Report line is `User <id> role=<role> status=<status> created=<t> updated=<t> ->
<verdict>` — id, role, enum status and timestamps only, and the listing does not even SELECT
  `email`/`username`, so nothing it prints can carry a person. Pure classifier
  `classifyOrphanUser({role, status, deletedAt}) → {verdict, status, reason}` over `ok` |
  `refuse: already inactive` | `refuse: super admin` (defensive — the WHERE already excludes it) |
  `refuse: deleted`, strongest-refusal-first; plus `orphanUserUpdateSql()` and
  `buildOrphanUserUpdates(reports)`. The statement is
  `UPDATE "User" SET "status" = $1, "updatedAt" = now() WHERE "id" = $2 AND "tenantId" IS NULL AND
"role" <> 'SUPER_ADMIN' AND "status" = $3 RETURNING "id"` with `$1 = INACTIVE`, `$3 = ACTIVE`
  (the `enum UserStatus` values from `prisma/schema/tenancy.prisma`, mirrored in
  `packages/types/index.ts`) — every clause re-states a precondition the report displayed, which
  is what makes a re-run a no-op and a row changed under us a rollback. `--live` takes the same
  `--backup-attested` + a typed `DEACTIVATE <n> USERS` (the jest-gated `BACKFILL_CONFIRM_TOKEN`
  applies), through the SHARED `confirmAndApply` both tasks now use — one transaction, RETURNING
  checked per row, rollback + exit 4 on any zero-row update. Coverage: B6a–B6f (every verdict
  branch + the precedence), B7a–B7d (`buildOrphanUserUpdates`, the exact statement, no `DELETE`,
  no `tenantId` write), B5i/B5j/B5k/B5l (spawn-level mutual-exclusion exit 2, `--live` without an
  attestation exit 2, the help text, and source pins on the WHERE and the SELECT list), and
  DB-lane **D8** — a NULL-tenant `TENANT_ADMIN`, a NULL-tenant `SUPER_ADMIN` and a tenanted user
  are seeded; only the first is listed (the other two never appear), `--live` with
  `DEACTIVATE 1 USERS` sets it `INACTIVE` while leaving `deletedAt`/`tenantId` and the other two
  rows untouched, and the re-run is "nothing to do".
  **UNATTENDED WRITES, APPROVED TEST TENANTS ONLY — `--only-test-tenants` + `--confirm "<phrase>"`
  (2026-09-05):** the tool's `--live` path needed a TTY, which made the whole repair unrunnable
  from a session even on a throwaway tenant. Two flags open exactly that door and no wider one.
  `--only-test-tenants` resolves the slug of the tenant every TARGET row would RECEIVE — one
  `SELECT "slug" FROM "Tenant" WHERE "id" = $1` per DISTINCT proposed tenant, cached in
  `slugById` — and hands the WRITE LIST plus those slugs to the new pure guard
  `assertTestTenantTargets(rows, slugById)`, which requires `isTestTenant(slug)` from
  `scripts/lib/test-tenants.cjs` (the sole source of the policy — never restated, never widened;
  a near-miss like `testing-co` or `e2eclient` is a client tenant). ONE non-matching **or
  unresolvable** row refuses the WHOLE batch: **exit 3**, zero writes, every offender listed as
  `<table> <id> -> tenantId=… tenantSlug=…` on stdout AND stderr, `testTenantError` +
  `summary.blocked` in `--json`. It is enforced in EVERY mode, so `--dry-run` is the exact
  preflight of the live gate. `--confirm "<phrase>"` supplies the typed confirmation as a value
  and is accepted ONLY alongside that guard (**exit 2** before any connection otherwise) — the
  phrase must equal `BACKFILL <n> ROWS` with `<n>` the applied count THIS invocation computed, so
  a stale count is exit 3 with zero writes; it takes precedence over the jest-only
  `BACKFILL_CONFIRM_TOKEN` (unchanged) and relaxes neither `--backup-attested` nor the phrase
  check. **The orphan-user task is REFUSED under the guard (exit 2)** — those rows are not
  tenant-scoped, so there is no slug to check and nothing the flag could promise. Every report
  line now also carries `tenantSlug=<slug>` whenever the proposed tenant resolves, in every mode,
  so the owner reads the gate's own input. `--json` gains `onlyTestTenants` and is emitted from
  one `emitJson` so the refusal path cannot drift from the normal one. Coverage: B8a–B8f (the
  pure guard: the approved set, one offender refusing the batch, unresolvable, empty list, and
  the near-misses that must stay refused), B5m–B5p (spawn-level `--confirm` without the guard →
  exit 2, the orphan refusal, the help text, and source pins on the slug query, the guard call
  and the `--confirm`-over-token precedence), and DB-lane **D9–D11** — D9 seeds a whole graph in
  a NON-approved tenant (`acme-*`, created and deleted by the case) and proves exit 3 with zero
  writes in `--live` AND `--dry-run`; D10 proves a wrong `<n>` is exit 3; D11 drives the D7
  production shape end to end with no TTY and no token, then re-runs to "nothing to do".
- **`common/tenant-class.util.ts`** — `classifyTenantSlug(slug): TenantClass` (pure). `routeflow-demo` → DEMO, `routeflow-hq` (house tenant) → INTERNAL, `scripts/lib/test-tenants.cjs`'s `TEST_TENANT_SLUGS`/`TEST_TENANT_PATTERN` → TEST, else PRODUCTION. Those two constants are **inlined here, not imported** — repo-root `scripts/` isn't copied into the API Docker image, so `nest build` passed under host tsc but failed TS2307 in the image build (F1, PR #718 fix round). Kept in lockstep by a spec assertion (`tenant-class.util.spec.ts`, `require`s the `.cjs` directly — specs are build-excluded so this is the one place allowed to reach outside `apps/api`).
- **`tenant/tenant-class.ts` (REG-743-F7, T4, 2026-09-15)** — a THIRD, independent `classifyTenantSlug` port, not imported from `common/tenant-class.util.ts` — a bug in any ONE of the three (this, the util, `backfill-tenant-class.mjs`'s `classify()`) can't become the only source of truth. Used by `createTenant()`. Also exports **`TENANT_CLASS_VALUES = Object.values(TenantClass)`** (boot-crash fix) — the real `@prisma/client` enum, safe to value-import unlike `@routeflow/types`'s equivalent (raw TS, crashes boot; see `no-runtime-workspace-imports.spec.ts`); `create-tenant.dto.ts` imports it from here. Spec: `tenant-class.spec.ts`.
- **`scripts/backfill-tenant-class.mjs`** — dark, idempotent whole-table `Tenant.class` backfill (dry-run default, `--apply` to write); exports `classify(slug)`, a duplicate of `classifyTenantSlug` kept in an ordinary `.mjs` (no Nest/Prisma-client-type deps) so the CLI has zero framework startup cost. DB URL resolved via `lib/railway-db-url.mjs resolveDatabaseUrl()`; the top-level `.catch` scrubs any connection string out of a thrown error via that module's `scrubSecrets` before printing. **REG-743-N2 (2026-09-15):** also prints `Resolved database host: <redactUrl(databaseUrl)>` as its first stdout line right after resolving, so a spec can assert what it actually connected to; its db spec now spawns it with a `childEnv` that strips every `RAILWAY_*`/`POSTGRES_*` key before setting `DATABASE_URL`, so a leftover Railway proxy export in the spec's own process can never leak into the child. Cross-checked against `tenant-class.util.ts`'s `classifyTenantSlug` for every `TenantClass` over a fixture slug list in `tenant-class.util.spec.ts` (spawns `node --input-type=module` to import the real `classify` by `file://` URL — same shim shape as `backfill-legacy-tenant-ids-script.spec.ts`) so the two can never silently drift; DB-mechanics coverage (dry-run/apply/idempotent) stays in `backfill-tenant-class.db.spec.ts`.
- **`scripts/backfill-subscription-reconciliation.mjs` (T11; REG-743-F2/F3/F4/F5/N3, T2, `bb14ac9a`)** — dry-run default, `--apply` writes. Scans `class: "PRODUCTION"` (DEMO dropped), `status: "ACTIVE"` vs the PUBLISHED `PlanVersion`. Fixes ONE shape: `planKey` set, null `basePriceSnapshot`; never creates a row or a `planKey`. 5 skip reasons for a human: no subscription; no `planKey`; no `stripeSubId` (B327 — never price a manual free pilot); no resolvable version; `planKey` absent from the catalog even after alias normalization (2026-09-15); plus "custom-priced (null)" (ENTERPRISE). Candidate `planVersionId`s batch into one `findMany` via a `Map` (was a plain object — F5 risk). `updateMany` re-asserts the exact scanned `planVersionId` (F4) and a nested `tenant:{status:ACTIVE,class:PRODUCTION,deletedAt:null}` (F3 — a churned tenant books no price); `count===1` emits `reconciliation.snapshot_backfilled` with the real `amountDelta` in one per-row `$transaction`; `count===0` → RACED. Unscoped `--apply` needs `--confirm-count <n>` matching the scan or refuses (F2). Same host-print/scrub shape as `backfill-tenant-class.mjs`. Catalog price lookup goes through `findCatalogPlanKey(defs, planKey)` — an exported, re-typed `LEGACY_PLAN_KEY_ALIASES`/`normalizeLegacyPlanKey` mirroring `billing/plan-catalog.constants.ts`'s `LEGACY_PLAN_KEY_ALIASES`/`findPlanDefinition` (the script can't value-import that TS source; same duplicate-by-hand pattern as `backfill-tenant-class.mjs`'s `classify()`), normalizing BOTH the stored `planKey` and each catalog definition's own key before comparing so a TEAM/BUSINESS/PROFESSIONAL-era stored key resolves against a GROWTH/SCALE-renamed catalog (or vice versa) — the write's `planKey` where-clause still uses the raw stored key, only the price lookup is normalized. DB spec: `backfill-subscription-reconciliation.db.spec.ts` (incl. a `LEGACY_ALIAS_SLUG` fixture: stored `BUSINESS` resolves against the catalog's `SCALE` definition). Parity spec: `backfill-subscription-reconciliation-plan-key-parity.spec.ts` pins the re-typed alias map/helpers to `plan-catalog.constants.ts` (L-072 sibling).
