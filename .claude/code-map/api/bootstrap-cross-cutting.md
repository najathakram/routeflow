# api — Bootstrap & cross-cutting

> Split from `.claude/code-map/api.md` (verbatim, lines 39-949) on 2026-09-13. See [`../INDEX.md`](../INDEX.md).

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
- **`scripts/backfill-subscription-reconciliation.mjs` (T11; REG-743-F2/F3/F4/F5/N3, T2, `bb14ac9a`)** — dry-run default, `--apply` writes. Scans `class: "PRODUCTION"` (DEMO dropped), `status: "ACTIVE"` vs the PUBLISHED `PlanVersion`. Fixes ONE shape: `planKey` set, null `basePriceSnapshot`; never creates a row or a `planKey`. 5 skip reasons for a human: no subscription; no `planKey`; no `stripeSubId` (B327 — never price a manual free pilot); no resolvable version; `planKey` absent from the catalog; plus "custom-priced (null)" (ENTERPRISE). Candidate `planVersionId`s batch into one `findMany` via a `Map` (was a plain object — F5 risk). `updateMany` re-asserts the exact scanned `planVersionId` (F4) and a nested `tenant:{status:ACTIVE,class:PRODUCTION,deletedAt:null}` (F3 — a churned tenant books no price); `count===1` emits `reconciliation.snapshot_backfilled` with the real `amountDelta` in one per-row `$transaction`; `count===0` → RACED. Unscoped `--apply` needs `--confirm-count <n>` matching the scan or refuses (F2). Same host-print/scrub shape as `backfill-tenant-class.mjs`. DB spec: `backfill-subscription-reconciliation.db.spec.ts`.
- **`scripts/ci-audit-critical.mjs` (2026-09-04)** — CI advisory gate: wraps `npm audit
--omit=dev --audit-level=<level> --json` in `spawnSync` (`shell:false`, up to 3 attempts,
  15s/45s backoff, 120s per-attempt timeout, 64 MiB `maxBuffer`) so an `npm` registry
  outage (the `/-/npm/v1/security/audits/quick` endpoint's ongoing 500s, "being retired")
  cannot wedge CI the way it twice blew the job's 20-min `timeout-minutes`. Decision table:
  parsed JSON with `metadata.vulnerabilities.critical>0` → prints each advisory + `::error::`
  - exit 1; parsed JSON with critical=0 → exit 0; a registry/transport error (500, `ECONNRESET`,
    `ETIMEDOUT`, `ENOTFOUND`, "being retired", "audit endpoint returned an error", or the spawn
    itself timing out) → retries, then `::warning::…SKIPPED…` + exit 0 (Dependabot is the standing
    net); any other non-zero exit fails closed (exit 1). `--level <lvl> --report-only` (the second
    ci.yml step) always exits 0. Test-only env: `CI_AUDIT_CMD` (JSON argv array, swaps in a fake
    driver — no network) and `CI_AUDIT_BACKOFF_MS` (collapses the backoff for fast specs). On
    win32 without a `CI_AUDIT_CMD` override, resolves and invokes `npm-cli.js` next to
    `process.execPath` via `node` instead of `npm.cmd` directly — `spawnSync` cannot launch a
    `.cmd` shim with `shell:false` since Node's CVE-2024-27980 hardening (EINVAL); the real CI
    codepath (ubuntu-latest, plain `npm`) is untouched. Called from `.github/workflows/ci.yml`'s
    `Fail on critical production advisories` / `Report high-severity advisories` steps. Contract
    spec: `src/common/ci-audit-script.spec.ts` (spawn-level, fake npm-audit driver written to an
    mkdtemp'd dir, `FAKE_MODE` critical/clean/outage/unknown, counter file proves retry count).
- **`security/audit-allowlist.json` (emptied 2026-09-10, `chore/next-15` #5b3b3c4e)** — carried
  two owner-acked, expiring (2026-09-30) entries for `GHSA-p293-qw3h-jr36` and
  `GHSA-2xp9-vwfh-vxw4` (both `next`), both fixed in Next 15.5.24+; the upgrade retires both
  entries, leaving `entries: []`. `src/common/ci-audit-script.spec.ts`'s "policy guard" describe
  no longer pins the allowlist to exactly those two ids (that pinned the CONTENTS, which would
  make the very next legitimate entry someone adds fail the spec) — it now accepts any valid
  entries array, empty included, and only asserts the per-entry expiry-window shape. Which
  advisories are RETIRED (must be absent, and must now fail the gate rather than be suppressed)
  is `audit-allowlist-retired.spec.ts`'s job (see below) — a policy-guard spec and a
  retirement-tripwire spec, not one spec doing both.
- **`scripts/ci-freshness-guard.mjs` (2026-09-04, REG-E2EGUARD-403)** — replaces the e2e job's
  old inline bash freshness guard (`gh api … --jq … 2>/dev/null || true`), which treated a 4xx/5xx
  error body as a non-empty "sha" and silently emitted `run=false` on every call once the run
  token lost `deployments:read` — every `deployment_status` E2E run reported green with zero
  test steps for days. `spawnSync("gh", ["api", "repos/<repo>/deployments?per_page=1"],
{shell:false})`, decision table: (A) exit 0 + JSON array with `[0].sha` → compare to
  `DEPLOY_SHA`, match=`run=true`/`::notice::`, mismatch=`run=false`/`::notice::` (genuinely
  superseded); (B) exit 0 + empty array → `run=true`; (C) anything else — non-zero exit,
  unparseable/non-array body, timeout, missing `DEPLOY_SHA`/`GITHUB_REPOSITORY` — **fails open**
  (`run=true`, `::warning::`, ≤200 chars of the body/stderr, never the token). Always exits 0 — a
  red guard step would hide the suite exactly like a wrongful skip does. Test-only
  `CI_FRESHNESS_GH_CMD` (JSON argv array, swaps in a fake `gh`) and `CI_FRESHNESS_GH_TIMEOUT_MS`
  (default 30000ms). Called from `.github/workflows/ci.yml`'s `e2e` job `freshness` step, which
  now also declares job-level `permissions: {contents: read, deployments: read}` (the job was
  previously on the restricted org default with no `deployments:read`). Contract spec:
  `src/common/ci-freshness-guard-script.spec.ts` (spawn-level fake `gh` on PATH, plus a T1 that
  runs the workflow's own step command via `js-yaml`).
- **`scripts/visibility-watchdog.mjs` (2026-09-04, killed-session incident)** — a detached
  safety net for the public-repo CI window in the canonical deploy flow (`CLAUDE.md`,
  `docs/runbooks/deploy-visibility-flip.md`): launched BEFORE `gh repo edit … public`, it
  `setTimeout`-sleeps `--minutes` (default 45, never a busy-wait, so signals still work),
  then retries the flip itself: **up to 6 attempts**, each one `gh repo edit … --visibility
private …` immediately followed by a `gh repo view --json visibility` read-back, stopping at
  the first `PRIVATE`. **Bounded end to end (close-out re-check, 2026-09-05, L-077):** every
  `gh` call carries `timeout: 60_000, killSignal: "SIGKILL"` (a hung call is otherwise an
  unbounded public window), and the backoff list is FIVE long — `[5s,15s,30s,60s,120s]`, since
  attempt 6 is never followed by a sleep — so the worst case is ≈3.8 min of sleeps plus
  6 × 2 × 60 s of call timeouts. Appends one `<ISO> start|attempt|verified|error <detail>`
  line per event to `local-assets/visibility-watchdog.log` (gitignored) and mirrors it to stdout;
  `start` reports `root=` and `delays=`, an `attempt` reports `edit_exit=` (`spawn-error` for a
  call that never returned) and `edit_stderr=` (prefixed with the spawn error's own `code`, e.g.
  `ETIMEDOUT`). Exits 0 once verified (clearing any stale marker), 1 after 6 unconfirmed
  attempts — then writing `local-assets/visibility-watchdog.FAILED`. ⚠️ **`local-assets/`
  resolves against the MAIN checkout**, via `git rev-parse --path-format=absolute
--git-common-dir` (10 s timeout, falling back to the `__dirname` repo root): a watchdog armed
  from `.claude/worktrees/*` must not hide its marker there, and
  `docs/runbooks/deploy-visibility-flip.md` names the path to check before and after every
  window. A flip landing mid-CI/mid-deploy is by design — a private-repo Action just fails on
  billing and gets rerun. **Four test-only env overrides, all routed through `testOverride()`
  and honoured ONLY inside a jest worker** (`JEST_WORKER_ID` set), with one
  `WARNING: test override <NAME> active` stderr line when honoured and one naming line when
  ignored — the `SCHEMA_DRIFT_PRISMA_CLI` pattern from `scripts/schema-drift.mjs`:
  `VISIBILITY_WATCHDOG_GH_CMD` (JSON argv, swaps in a fake `gh` — no network),
  `…_LOG_FILE` / `…_MARKER_FILE` (scratch paths), `…_ATTEMPT_DELAYS_MS` (JSON array; malformed
  input falls back to the default list). Contract spec:
  `src/common/visibility-watchdog-script.spec.ts` (spawn-level, fake `gh` driver, 12 cases:
  success, retry-then-success (40 ms delays, elapsed ≥ 80 ms for two real sleeps),
  malformed-delays fallback, override WARNING lines, source pin that every override is read
  through the `JEST_WORKER_ID` gate, jest-worker inheritance, `root=` line, never-verifies,
  edit-fails, stdout mirrors log (guarded non-empty), arg defaults, slow-boot repro,
  awaitStartLine cap-rejection + kill pin, awaitStartLine prompt-reject (exit code + stderr)
  when the child dies before the start line). The "arg
  defaults" and slow-boot cases share
  `awaitStartLine({ argv = [SCRIPT], env, logFile, capMs = 30_000, intervalMs = 50, onSpawn })`
  (`logFile` required — the poll reads it; `onSpawn` is a test-only hook handing back the child
  handle on the reject path) (2026-09-04,
  `watchdog-spec-host-speed` fix, L-061): spawns the child and polls `readLog(logFile)` every
  `intervalMs` for the script's own `" start "` log line instead of a fixed 500 ms wait —
  resolves `{ child, log }` on match, rejects with a cap-exceeded message at `capMs`, and
  always kills the child + awaits its exit in a `finally`. All four async tests carry an explicit
  `35_000` ms third-arg Jest timeout so the poll cap fires first. New fixture
  `src/common/testing/slow-boot.cjs` — a synchronous `Atomics.wait(..., 1500)` preload used via
  `NODE_OPTIONS=--require` to deterministically prove the poll survives a slow child boot
  (`REG-WATCHDOG-SLOWBOOT`), independent of host speed.
- **`scripts/lint-migrations.mjs` + `apps/api/.squawk.toml` (wave B′, 2026-09-03)** — destructive-
  migration lint gate. `lint-migrations.mjs` (node, no deps beyond `squawk-cli`): `--base <ref>`
  (default `origin/master`, diffs `apps/api/prisma/migrations` for changed `migration.sql`),
  `--files <paths…>`, `--all` (informational, always exit 0 unless `--strict`); before invoking
  `squawk --config apps/api/.squawk.toml --reporter gcc <files>` via `spawnSync`, scans each file
  for `-- squawk-ignore <rule>` lines lacking an immediately-preceding `-- reason:` line (fails
  loud if found); passes squawk's exit code through. **Fails closed**: all paths resolve against
  the repo root (and both `spawnSync` calls run with `cwd: REPO_ROOT`), and a failing `git diff`
  prints git's stderr + `could not resolve range <base>...HEAD` and exits **2** — only a
  successful diff that matched nothing prints `no migrations in range` / exit 0.
  `.squawk.toml` excludes every rule except the
  destructive gate set (`ban-drop-table`/`-column`/`-database`, `changing-column-type`,
  `adding-required-field`, `renaming-column`/`-table`, `ban-truncate-cascade`, `syntax-error`) —
  Prisma's own migration shapes trip the lock-hygiene rules by design, so those stay advisory.
  Root script `lint:migrations`; wired into `db-migrations.yml` as the
  "Destructive-migration lint (squawk)" step before the replay. Spec:
  `src/common/lint-migrations-script.spec.ts` (spawn-level, fixture files in a temp dir).
- **`scripts/skip-verify-audit.mjs` (wave B′, 2026-09-03)** — the `SKIP_VERIFY` audit gate called
  from `.husky/pre-push`. Reads `SKIP_VERIFY_REASON`/`RF_BRANCH`/`RF_HEAD`/`RF_CHANGED_FILES`/
  `RF_AUDIT_LOG`; classifies the push docs-only when every changed path matches
  `^(docs/|\.claude/|.*\.md$|CHANGELOG|README)`. Non-docs push with an empty reason → stderr +
  exit 1; otherwise appends one `ISO | branch | head | docs-only=yes/no | reason` line to
  `RF_AUDIT_LOG` (`.git/skip-verify.log`) and exits 0. Spec:
  `src/common/skip-verify-audit-script.spec.ts`. Root `verify` script gained
  `--continue=dependencies-successful` on the `turbo run check-types lint test` invocation (same
  token in `ci.yml`'s "Verify" step) so one failing task no longer hides the others.
- **`src/common/testing/db-spec.ts` + `db-lane.db.spec.ts`, `jest.db.config.js` (PR-1, `imp-03a`,
  2026-09-03)** — the new `*.db.spec.ts` lane for specs that need a real Postgres. `db-spec.ts`:
  `requireLocalDatabaseUrl(env)` throws unless `DATABASE_URL`'s host is local
  (`localhost`/`127.0.0.1`/`::1`/`postgres`/`db`); `describeDb` throws when `RUN_DB_SPECS` is
  unset (the lane is never silently green).
  `db-lane.db.spec.ts` builds a `PrismaClient` the same way `prisma.service.ts` does
  (`PrismaPg` adapter over a `pg` `Pool`) and pins `SELECT 1`. `jest.db.config.js` extends the
  `package.json` `"jest"` config with `testRegex: ".*\\.db\\.spec\\.ts$"`; API script `test:db`
  runs it; root script `local:test:db` sets `RUN_DB_SPECS=local` and runs it against the compose
  DB. The default `*.spec.ts` regex now excludes `.db.spec.ts` so `npm test` never touches Postgres.
- **`src/common/calendar-date.ts` (F25, 2026-09-04, B59/B90/B91/B118)** — the ONE api helper for
  date-only fields: `calendarDateFromIso`/`isoFromCalendarDate` (UTC-midnight string <-> ISO
  round-trip), `calendarDayBounds`/`startOfCalendarDay`/`endOfCalendarDay` (day boundaries in a
  given IANA `timeZone`, argument order `date, timeZone`, never local getters). There is
  deliberately NO tenant-timezone resolver here: every caller passes `cfg?.timezone ?? null` and
  relies on these functions' own UTC fallback, so an unconfigured tenant never silently acquires an
  `America/New_York` boundary. The B91 repair-day rule is NOT here either: `recoverCalendarDay` and
  `classifyRepairRow` (the repair's EXPIRING-NOW / FAR-EAST hold-back gates — pure, clock passed in)
  live once in `scripts/lib/recover-calendar-day.cjs` (no API caller), executed by both
  `scripts/repair-f25-licence-dates.mjs` and its pin `src/common/recover-calendar-day.spec.ts`.
  Mirrored verbatim
  (same exported names/signatures) in `apps/web/lib/calendar-date.ts`
  and `apps/mobile/lib/calendar-date.ts` — see L-047. `analytics.service.ts` on-time-% calls
  `endOfCalendarDay(run.scheduledDate, cfg?.timezone ?? null)` through its own
  `resolveCurrentTenantTimezone`, so an unconfigured tenant keeps the UTC day-end (T11 pin,
  `analytics.service.calendar.spec.ts`). Two host-local siblings in `analytics.service.ts` were
  swept with it: `getRevenueTrend`'s month key (now `toISOString().slice(0, 7)`) and `dateRange`'s
  default `fromDate` (now `Date.UTC(getUTCFullYear(), 0, 1)`); both are pinned in a describe block
  that pins `process.env.TZ` west of UTC, because a UTC runner cannot tell the two bodies apart.
  `src/analytics/demand-range.ts` carries only a retensed docblock naming that pair as the
  cautionary tale.
  `invoices.service.ts`'s only change: its private `startOfCalendarDay` moved here and its four
  `issueDate` call sites took the new argument order; the licence-expiry WRITER fix is
  `apps/mobile/app/(operator)/customers/[id]/licenses.logic.ts#buildExpiresAtIso` (see mobile.md).
  Specs: `analytics.service.calendar.spec.ts` (DST fixture), `calendar-date.pins.spec.ts` (pinned
  UTC-midnight/round-trip behaviour).
- **`src/common/db-locks.ts` (PR-2, `imp-02-order-merge-advisory-lock`, 2026-09-03; per-family
  pools PR-2b, 2026-09-04)** — exports
  `withAdvisoryLock<T>({family,key,mode:"wait"|"try",waitMs?}, fn): Promise<LockResult<T>>` where
  `LockResult<T> = {acquired:true,value:T}|{acquired:false}`, plus `LOCK_FAMILIES`
  (`["order-merge","cron","billing","tenant-mirror"] as const`) / `LockFamily`, `LockTimeoutError`/
  `LockUnavailableError` and a test-only `_resetLockPoolForTests()` (ends+clears ALL pools).
  Cross-process critical
  section on a Postgres advisory lock (`pg_advisory_lock(hashtext(family), hashtext(key))`), held
  on DEDICATED `pg.Pool`s it owns itself — **one pool per family, sized per family** (`cron`
  `max: 12`, `order-merge` `max: 8`, `billing` `max: 4` (B342, 2026-09-13), `tenant-mirror`
  `max: 4` (F3, review round, 2026-09-15 — TenantMirrorService#upsert, see feature-modules-1.md)):
  a cron winner pins a slot for
  its whole tick (≤ 7
  concurrently at the monthly peak, plus a straggling hourly sweep), which out of one shared
  `max: 8` pool left merges 1–3 slots and 503s. ALL FOUR pools set `keepAlive: true` /
  `keepAliveInitialDelayMillis: 30_000` (rationale: this file's own header comment — an idle-reap
  would end a session mid-hold and release the lock early).
  `withAdvisoryLock` throws `TypeError` for a family outside `LOCK_FAMILIES`
  BEFORE connecting, so a typo cannot stand up a fifth pool. **RETIRED (F5 round 2 / N1,
  independent review round 2, PR-2, 2026-09-15):** a fourth `"idempotency"` family briefly lived
  here (round 1, `max: 6`) backing `ReturnsService#create`'s check-then-create-then-save guard —
  the review judged a dedicated 6-connection pool an unjustified extra failure surface; it now
  takes a TRANSACTION-scoped `pg_advisory_xact_lock` on its own transaction's connection instead
  (`common/idempotency.service.ts#acquireLock` — see the Returns row below), needing no pool
  here at all. **`billing`'s two call sites
  (B342 admin path; F1 2026-09-13 tenant path):** `addon.service.ts enableAddon()` (admin grant)
  and `subscription-mutation.service.ts enableAddon()` (tenant self-serve, `POST
/billing/addons/:sku/enable`) each wrap their existing-check → row-write window in ONE lock,
  the SAME key shape `addon:<tenantId>:<sku>`, `mode:"wait"`, `waitMs:10_000` — so the two paths
  now serialise against EACH OTHER too, not just within themselves. Admin path closes a race
  where two concurrent enables both passed the sequential "already active" guard, both created a
  live Stripe item, and the final upsert kept only one `stripeItemId` (double billing); tenant
  path has no such refusal (delta-quantity model) — serialisation + a fresh re-read nets a
  genuine re-enable to a zero delta instead. Full writeup in `feature-modules-4.md`'s `billing/`
  section. Prisma's pool is private and offers no
  connection-pinning API, so this module never touches it and cannot deadlock against it. `wait`
  blocks up to `waitMs` (default 20s; SQLSTATE 55P03 on `lock_timeout` → `LockTimeoutError`); `try`
  returns `{acquired:false}` without calling `fn` or issuing UNLOCK when the lock is already held.
  `client.release(err)` on any failure destroys the connection (server drops the session lock with
  it) — the clean path releases plain. **Call sites:** orders.controller.ts:~147 (staff `create()`
  merge branch), orders.service.ts:~824 (`mergeAllPendingForCustomer`), orders.service.ts:~1169
  (`forceConsolidateCustomer`), buyer.controller.ts:~547 (buyer `createOrder`). The in-process Map
  is deleted. family `order-merge`, key `ctx.customerId`/`dto.customerId`, `mode:"wait"` for all
  four — **but `waitMs` is NOT a flat 20_000**: staff `create()` and buyer `createOrder` pass
  `waitMs:10_000` (the mobile client aborts at 15s, so a 20s wait can only ever surface as a
  client-side timeout, never the 409 that tells the caller to retry); `mergeAllPendingForCustomer`/
  `forceConsolidateCustomer` pass `waitMs:20_000` (no client attached, so the default stands).
  Request-path post-commit callers (the sibling sweep / post-create auto-consolidation) pass
  `{ lockMode: "try" }` instead — a contended lock is skipped with a warning, never blocks the
  request. `LockTimeoutError` → 409 `MERGE_IN_PROGRESS`, `LockUnavailableError` → 503.
- **`src/common/cron-lock.ts` (PR-2b, `imp-02b-cron-leader-lock`, 2026-09-04)** — exports
  `LeaderCron(cronTime, name, options?): MethodDecorator`, `CRON_LOCK_FAMILY = "cron"` and the
  `LeaderCronOptions` type (a DISTRIBUTIVE `Omit<CronOptions,"name">` — a plain `Omit` collapses
  the library's `timeZone` XOR `utcOffset` union into one object that no longer satisfies
  `CronOptions`). Replaces `descriptor.value` with a wrapper that runs the tick inside
  `withAdvisoryLock({family:"cron", key:name, mode:"try"}, …)` and THEN applies
  `Cron(cronTime,{...options,name})`. **Order matters:** `@nestjs/schedule`'s `Cron` is
  metadata-only (`SetMetadata` writes onto `descriptor.value`) and `schedule.explorer` registers
  `instance[method]` after reading that metadata off it — applying `Cron` first would register the
  UNWRAPPED original. `name` is also the `SchedulerRegistry` key (`addCron` falls back to a
  per-process random UUID without it) and the advisory-lock key, so it must be a literal,
  `<area>.<method>`, validated by `NAME_RE` at class-definition time. Skips are never errors:
  `acquired:false` → `logger.debug`, `LockUnavailableError` → `logger.warn`, both return
  `undefined`; anything the BODY throws propagates (the scheduler's own try/catch logs it).
  ⚠️ **Behaviour change:** an overlapping tick on the SAME process is skipped too — all 13 jobs
  are idempotent sweeps, so that is the safer default. ⚠️ **A skipped tick does NOT cost the same
  everywhere** (header, "WHAT A SKIPPED TICK ACTUALLY COSTS"): 11 jobs re-derive from state and
  self-repair, but `tobacco-report.generateMonthlyReports` (only `now − 1 month`) and
  `order-templates.generateDailyOrders` (only today's weekday) lose a whole month/day that needs a
  manual re-run — follow-on is a catch-up window in those two. Residual, deliberate: a body that
  never settles pins the lock forever (a hold cap is rejected — it cannot cancel the body, so it
  would license two concurrent money ticks). Specs: `src/common/cron-lock.spec.ts`
  (mocks `./db-locks`; case (f) registers a job in a `ScheduleModule.forRoot()` test module and
  then `fireOnTick()`s it, asserting the REGISTERED tick went through `withAdvisoryLock` with
  family `cron`/key/`mode:"try"`), `src/common/no-bare-cron.spec.ts` (static tripwire: 0 bare
  `@Cron(` in `src`, exactly 13 `@LeaderCron(` sites with 13 unique names, and — spec files
  included — no file but `common/cron-lock.ts` IMPORTS the `Cron` identifier from
  `@nestjs/schedule`), `src/common/cron-lock.db.spec.ts` (real Postgres — two concurrent ticks run
  the body once).
- **`src/orders/merge-contention.ts` (PR-2, `imp-02-order-merge-advisory-lock`, 2026-09-03)** —
  the ONE code-tagged mapping from a `db-locks` failure to its wire contract, plus the
  post-commit-swallow helper: exports `MERGE_IN_PROGRESS`/`LOCK_UNAVAILABLE` (response `code`
  constants), `mapLockError(e): never` (`LockTimeoutError`→409 `{code:MERGE_IN_PROGRESS}`,
  `LockUnavailableError`→503 `{code:LOCK_UNAVAILABLE}`, anything else rethrown), and
  `isMergeContention(e)` (recognises those two by `code`, never by exception type — a plain
  409/503 elsewhere in the merge path is NOT contention). Raised ONLY before any write.
  ⚠️ the sibling sweep and the response read stay OUTSIDE the lock —
  `mergeAllPendingForCustomer` takes the SAME (family, key) on a different pooled connection, so
  nesting it self-blocks until `lock_timeout`. Spec: `src/buyer/buyer.merge-lock.spec.ts`; the
  pre-existing `src/buyer/buyer.controller.merge.spec.ts` now mocks `../common/db-locks` with a
  pass-through. Specs: `src/common/db-locks.spec.ts` (`jest.mock("pg")`),
  `src/common/db-locks.db.spec.ts` (real Postgres, `*.db.spec.ts` lane).
- **`src/common/docs-truth.spec.ts` + `src/common/no-dead-deps.spec.ts` (wave D, item 11,
  2026-09-03)** — static tripwires living in the API project because the repo has no root test
  runner (CLAUDE.md "DO NOT introduce ... a root-level test runner"). `docs-truth.spec.ts` reads
  `README.md`/`CLAUDE.md` off disk and pins the specific stale claims item 11 fixed: README no
  longer names the dead `najathakram1` remote or the deleted `deploy-staging.yml`, doesn't claim a
  `develop` branch or "main is production-ready", and documents the `deployment_status`-triggered
  E2E flow; CLAUDE.md no longer lists Zustand in the web stack and states the lessons-register
  40,960-byte cap `validate-lessons.mjs` enforces. `no-dead-deps.spec.ts` proves four packages
  removed as verified zero-reference dead weight stay removed, on BOTH halves (manifest no longer
  declares it AND no source file under the app's tree imports it): `zustand` from `apps/web`
  (web state is TanStack Query + context — see [`web`](web.md) `app/providers.tsx`) and
  `@nestjs/axios`/`passport-google-oauth20`/`@types/passport-google-oauth20` from `apps/api`
  (outbound HTTP goes through vendor SDKs; Google OAuth is `google-auth-library`'s `OAuth2Client`
  in `auth/google-oauth.service.ts`, not a Passport `GoogleStrategy`); a reverse guard pins that
  mobile's own zustand (a real, used dependency) and its `react-test-renderer` pin were NOT
  collaterally touched.
- **`jest.repo-truth.config.js` + `src/common/turbo-inputs.spec.ts` (imp-04, PR-4 + wave B′ merge
  follow-up, 2026-09-04)** — cache-safety fix for the two specs above: both read files OUTSIDE
  apps/api (README.md, CLAUDE.md, apps/web's `app`/`components`/`hooks`/`lib` trees + its
  `package.json`, apps/mobile's `package.json`), but apps/api's own `test` task only hashes its
  own `$TURBO_DEFAULT$`, so an edit to any of those could bust no cache and `turbo run test`
  would replay a stale green. `jest.repo-truth.config.js` extends the `package.json` `"jest"`
  config the same way `jest.db.config.js` does (`reporters: ["default"]` — never the campaign
  reporter, which would clobber `.campaign/runs/api.json`) with `testRegex:
"(docs-truth|no-dead-deps|no-single-schema-path|client-page-params|no-react-skew-hacks|next-
version|audit-allowlist-retired)\\.spec\\.ts$"` (the third joined it
  with wave E's schema-folder split; the last four joined it with the Next 15 upgrade,
  2026-09-10, `chore/next-15` #5b3b3c4e — each reads outside apps/api: `apps/web/app` (T3),
  `apps/web/Dockerfile`/`jest.config.js` (T2), `apps/web/package.json` (T1), and
  `security/audit-allowlist.json` (T6)); the main config's `testPathIgnorePatterns` excludes all
  seven by name so `npm test` never double-runs them. New API script `test:repo-truth`; root
  `verify` gained the `test:repo-truth` token on the `turbo run check-types lint test` list. A
  `@routeflow/api#test` workspace-task override was tried first and reverted —
  `packages/pricing/src/package-shape.spec.ts` forbids that exact key — so `turbo.json` instead
  carries a GENERIC `test:repo-truth` task (`dependsOn: ["^build"]`, outside paths as explicit
  `$TURBO_ROOT$/…` `inputs`, `outputs: []`); only apps/api declares the script, so turbo only
  ever executes it there. `turbo-inputs.spec.ts` pins the task's inputs list, the verify/script
  wiring, and the jest-config split (Lesson L-062, tooling — see its chore/next-15 addendum:
  moving a spec IN must add it to the main lane's `testPathIgnorePatterns` in the SAME change).
  **Close-out re-check (2026-09-05):**
  the inputs also carry `scripts/**`, `.github/workflows/**`, `.claude/skills/**`,
  `apps/api/scripts/**`, `apps/api/Dockerfile`, `apps/api/prisma.config.ts`, `package.json` and
  `docker-compose.yml` (no-single-schema-path's reach), and the spec pins ALL sixteen explicit
  inputs plus the lane's exact three specs. **chore/next-15 (2026-09-10, #5b3b3c4e):** four more
  explicit `inputs` (`apps/web/Dockerfile`, `apps/web/jest.config.js`, `apps/web/next.config.mjs`,
  `security/**`) for the four new repo-truth specs' reach; `turbo-inputs.spec.ts` now pins the
  lane's SEVEN specs via a `REPO_TRUTH_SPECS` array and it.each-checks each new spec's exclusion
  from the main lane.
- **`src/common/{next-version,no-react-skew-hacks,client-page-params,audit-allowlist-retired}.spec.ts`
  (2026-09-10, `chore/next-15` #5b3b3c4e, S4 T1/T2/T3/T6)** — the Next 15 upgrade's repo-truth
  lane additions (see above); none import runtime code, all `fs.readFileSync` the tree directly
  (house convention, matches `no-dead-deps.spec.ts`). **`next-version.spec.ts` (T1)** pins
  `apps/web/package.json`'s exact `next`/`eslint-config-next`/`@next/swc-win32-x64-msvc` literals
  (`15.5.25`/`15.5.25`/`^15.5.25`) — clears the two CRITICAL advisories the
  `security/audit-allowlist.json` entries (now retired) were carrying. **`no-react-skew-hacks.spec.ts`
  (T2)** pins that `apps/web/Dockerfile`'s `npm install --force --no-save react@18…` line and
  `jest.config.js`'s single-react `moduleNameMapper` are BOTH gone — a half-reverted skew (one
  hack back, one still removed) breaks every RTL suite, so the pair is asserted together, not as
  two independent facts. **`client-page-params.spec.ts` (T3)** source-scans `apps/web/app` for the
  three old synchronous `params`/`searchParams` prop shapes (destructure / `props.params` / body
  destructure) on Client Components, and for an un-awaited `params:`/`searchParams:` type
  annotation on Server Components; counts by SITE not by file (`customers/[id]/page.tsx` has two).
  **`audit-allowlist-retired.spec.ts` (T6)** pins that `security/audit-allowlist.json` no longer
  carries either retired next.js GHSA id AND that the ci-audit gate now FAILS (not
  ALLOWLISTED-suppresses) a fixture audit reporting one of them — the allowlist itself stays
  available for a future, unrelated advisory (see the `security/audit-allowlist.json` bullet
  above and `ci-audit-script.spec.ts`'s "policy guard" describe update).
- **`src/common/campaign-check-freshness.spec.ts` (2026-09-06, campaign-check report freshness,
  L-083)** — contract spec for `scripts/campaign-check.mjs`'s freshness rule and its new
  `--freshness-only` pre-step (see [`INDEX`](INDEX.md)'s "Bug-register burn-down campaign" row).
  Harness mirrors `ci-freshness-guard-script.spec.ts`'s `runScriptDirect` (`spawnSync` the real
  `.mjs` directly) + `mkdtempSync` fixture pattern: a throwaway `git init` repo with two commits
  (a workspace test file, then a `.claude/campaign/status/F01.jsonl` ledger row) at explicit
  `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE`, `CAMPAIGN_CHECK_STATUS_DIR` + `--runs-dir` pointed at the
  fixture, env scrubbed of `GIT_DIR`/`GIT_WORK_TREE`/`GIT_INDEX_FILE`/`CAMPAIGN_CHECK_TURBO_DRY_RUN`.
  T1–T3/T5 pin the R1 staleness compare (report `generatedAt` vs. the newer of the test-file commit
  or the ledger commit) and R2's exact refusal block (stale-by-name, before any token scan,
  `cd <dir> && npx jest --maxWorkers=2`, the ritual line); T4 is the R3 positive control (no
  affirmative T1 claim ⇒ never checked, green before and after — excluded from the "0 passed on
  red" claim); T6–T9 drive `--freshness-only` (R4) through the `CAMPAIGN_CHECK_TURBO_DRY_RUN` seam
  (R6, `JEST_WORKER_ID`-gated) — HIT refuses, MISS/parse-failure fails OPEN, the seam is ignored
  outside a Jest worker; T10 runs the REAL `scripts/jest-campaign-reporter.cjs` in a child process
  and asserts the new `generatedAt`/`gitHead` stamp (R0) with the four original fields unchanged;
  T11 pins root `package.json`'s `verify` script starting with
  `node scripts/campaign-check.mjs --freshness-only && ` (R5). T12–T14 (R9) pin the reporter's
  `partial`/`partialPatterns` stamp (a scoped run — path/name pattern or `--onlyChanged` — sets
  it, a full run does not) and campaign-check's refusal of a `partial: true` report in both modes
  (full mode: `PARTIAL … regenerate with the full suite`; `--freshness-only`: HIT refuses, MISS
  continues), even when the report is otherwise fresh by time and its token is present — a time
  rule alone would let a scoped run "launder" a stale report as full-suite evidence.
  **Fix-round 1 (2026-09-06, F1/F3/F5):** T15 builds a REAL `git merge --no-ff` fixture (a side
  branch commits the ledger shard, `main` merges it) and pins BOTH campaign-check's refusal
  (naming the MERGE's own time, not the side branch's older one) AND the raw `git log`
  discrepancy itself — `git log -1 --format=%ct -- <path>` (no `--first-parent`) returns the side
  branch's commit because the merge is TREESAME to that (non-first) parent for the path, while
  `--first-parent` returns the merge; `newestCommit` now always passes `--first-parent`. T16 pins
  pathspec scoping (a later commit touching neither the workspace's tests nor the ledger must
  never mark a fresh report stale — bounding by HEAD instead would fail this). T17 pins the
  clock-skew clamp (F3): a commit dated ahead of `Date.now()` clamps to now with one `clock skew`
  note instead of hard-blocking every future report. **T0 is now `Date.now()/1000 - 86400`, not a
  fixed literal** — a hardcoded epoch chosen without regard to wall-clock time can drift into the
  calendar future and get clamped by F3's own guard; only the relative offsets between the 17
  cases matter.
- **`src/common/campaign-check-web-report.spec.ts` (2026-09-08, #686)** — pins that
  `scripts/campaign-check.mjs` treats `apps/web`'s Jest campaign report
  (`.campaign/runs/web.json`, wired via `apps/web/jest.config.js`'s `reporters` block —
  `["<rootDir>/../../scripts/jest-campaign-reporter.cjs", { artifact: "web" }]`) as a T1 proof
  source on par with api/mobile/pricing. Root cause it guards: REG-B### specs living in
  `apps/web` (e.g. a `lib/api/*.test.tsx` REG-B35 pin) were invisible to the gate — "no test
  titled with REG-B## found in the jest report" on every PR (#683) — because the checker only
  ever read api/mobile reports; `apps/web` never ran the campaign reporter at all. Harness
  mirrors `campaign-check-freshness.spec.ts`'s `runScriptDirect`/`mkdtempSync` fixture pattern.
  See [`INDEX`](INDEX.md)'s "Bug-register burn-down campaign" row and [`web`](web.md)'s Jest
  section for the reporter wiring.
- **`src/main.ts`** — ⚠️ NEVER `app.use(json())` here: it consumes the body before Nest captures `rawBody` and silently breaks EVERY Stripe webhook signature (#400 — the 2mb body limit goes through Nest's parser options). **Sentry (2026-08-26, DSN-optional):** `import "./instrument"` is the FIRST import (`src/instrument.ts` — `Sentry.init` with `enabled: !!process.env.SENTRY_DSN`, inert otherwise); global filters registered as `useGlobalFilters(new SentryExceptionFilter(httpAdapter), new ThrottlerExceptionFilter(), new MulterExceptionFilter())` — Nest reverses the array so the specific filters still win for their types; ⚠️ the catch-all Sentry filter MUST stay first or the narrow ones are never reached. `src/common/sentry-exception.filter.ts` captures ONLY ≥500s with `tenant`/user/path tags then defers to `super.catch`; `src/common/multer-exception.filter.ts` maps multer 2.3.0's newer codes (`LIMIT_FIELD_ARRAY_INDEX`, `INVALID_FIELD_NAME`, `STREAM_DESTROYED`) to 400 — @nestjs/platform-express's `transformException` switches on a frozen message list that predates them, so without it they arrive as raw `MulterError`s, score as 500, and capture one Sentry event per attacker probe. startup: `assertSecrets()` (JWT required in all envs; **`STORAGE_URL_SIGNING_SECRET` now FATAL in production too — F5-001 fail-closed**; `ENCRYPTION_KEY` still warn-only), **no boot-time DDL (PR-1, `imp-03a`, 2026-09-03)** — `runStartupMigration()` is deleted; schema drift is now caught read-only by `scripts/schema-drift.mjs`, not by a startup writer,
  helmet, trust proxy 2 (Railway CDN), CORS wildcard
  patterns, global `ValidationPipe` (whitelist/forbidNonWhitelisted/transform),
  **⚠️ the 2mb body limit MUST go through `app.useBodyParser("json", {limit})` on a
  `NestExpressApplication` — NEVER `app.use(json({limit}))`.** A manual express.json consumes
  the request stream ahead of Nest's own parser, so the `rawBody: true` passed to
  `NestFactory.create` never captures anything and `req.rawBody` is undefined — which breaks
  signature verification for EVERY Stripe webhook, platform and connect alike. Found live
  2026-08-21: every connect delivery 503'd with `rawBody=false` while the secret and key were
  correct, so card payments charged but never settled (fixed in #400),
  ThrottlerExceptionFilter (429 + Retry-After), Swagger dev-only, graceful shutdown.
- **`src/app.service.ts`** — `healthCheck()` (`GET /api/v1/health`) returns
  `{ status: "ok", timestamp, commit, branch }`; `commit`/`branch` read
  `process.env.RAILWAY_GIT_COMMIT_SHA`/`RAILWAY_GIT_BRANCH` at request time and are `null` (never
  `"unknown"`) when unset — mirrors `apps/web/app/api/health/route.ts`'s `sha` field. Railway
  injects the env vars into the running container; no Dockerfile change needed. Spec:
  `app.service.spec.ts` (wave B′). Consumed by `ci.yml`'s readiness gate (API-sha check,
  identical tolerance shape to the existing web check) and `scripts/post-deploy-check.mjs` (prints
  `commit`/`branch` after the health pass).
- **`src/auth/login-throttle.config.ts`** (wave B′, 2026-09-03) — `loginThrottleConfig(env)` (pure)
  reads `AUTH_LOGIN_THROTTLE_LIMIT`/`AUTH_LOGIN_THROTTLE_TTL_MS` (prod defaults unchanged:
  10 / 300000); `resolveLoginThrottle()` memoizes it on first use (+ `__resetLoginThrottleCache()`,
  test-only) and logs the effective limit/ttl exactly once when either env var is set — warning per
  var when the value was rejected as not a positive integer, so a silently-defaulted override is
  visible instead of quietly weakening brute-force protection.
  `auth/auth.controller.ts`'s login `@Throttle` passes `() => resolveLoginThrottle().*`
  resolvers instead of literals, so the read happens on the first login request — NOT at module
  init, which runs before `ConfigModule.forRoot()` and would ignore `apps/api/.env`.
  `docker-compose.yml`'s `api` service environment sets a generous local-only value (throwaway,
  localhost-only) so repeated local Playwright logins from `127.0.0.1` don't exhaust it. Spec:
  `auth/login-throttle-config.spec.ts`.
- **`src/app.module.ts`** — ConfigModule, PrismaModule, CommonModule, TenantModule, AuthModule,
  feature modules, BullModule (Redis queue), ScheduleModule (cron — every job is declared with
  `@LeaderCron`, never bare `@Cron`; see `src/common/cron-lock.ts`), ThrottlerModule (100/60s,
  Redis-backed). Global guards: `ThrottlerGuard`, `TenantStatusGuard`, `ImpersonationGuard`
  (as an APP_GUARD it runs before every route guard, incl. `JwtAuthGuard` — `req.user` is never
  set here; B165, F14 2026-09-02, see `audit/`). **This exact order is a load-bearing invariant
  (wave B′ comment) — pinned by `app.module.guards.spec.ts` (static extraction of the
  `APP_GUARD` list) and behaviorally by `auth/guards/guard-chain.security.spec.ts`
  (`TenantStatusGuard` fails closed on a forged-SUSPENDED-tenant token before `JwtAuthGuard` ever
  runs).**
  Middleware: tenant resolution (extract tenant from JWT → AsyncLocalStorage context).
- **`src/prisma/prisma.service.ts`** — extends PrismaClient (PrismaPg adapter + Pool). Key:
  `getTenantId()` (reads TenantContextService), `tenantTransaction(fn)` (sets session var
  `app.current_tenant_id` for RLS), `forTenant(tenantId)` proxy that auto-filters queries by
  tenant. **Bare `this.prisma.<model>` bypasses scoping — load-bearing convention.**
  ⚠️ **findUnique / findUniqueOrThrow are only POST-FILTERED** (tenantId can't be injected into a
  unique `where`; the guard checks the RETURNED row's `tenantId` — `findUnique` returns `null`,
  `findUniqueOrThrow` throws Prisma's own `P2025`, both in `_wrapTxWithTenant` and
  `_tenantExtension`), so an exclusive `select` that omits `tenantId`
  defeats it and returns cross-tenant rows. Rule (2026-08-24 sweep, 77 sites converted): a
  tenant-scoped `findUnique` with an exclusive `select` must include `tenantId: true`, or use
  `findFirst` (scoped via where-injection; identical semantics for an id lookup). BOTH fail-closed
  behaviors are pinned across `forTenant()` and `tenantTransaction()`, for
  `Customer`/`Product`/`Order`/`Invoice` (wave B′, compose-DB lane), but in two sibling files:
  `findUniqueOrThrow` → `P2025` by `src/prisma/tenant-findunique.db.spec.ts` (red-bar cases only),
  `findUnique` → `null` **and** the RLS `current_setting('app.current_tenant_id')` hand-off by
  `src/prisma/tenant-findunique-pins.db.spec.ts` (already-green regression pins);
  `findUniqueOrThrow` was unscoped in both layers until that spec caught it (wave B′ `fix:`, L-060).
- **`src/config/configuration.ts`** — env load: `DATABASE_URL`, `JWT_SECRET`,
  `JWT_REFRESH_SECRET` (required, crash on missing), `ENCRYPTION_KEY` (optional 64-hex),
  `STORAGE_URL_SIGNING_SECRET` (**required in prod — F5-001**; `resolveStorageSigningSecret` throws
  in production when unset, HKDF-SHA256-from-JWT fallback only in dev/test).
  **No `taxRate` key — `AppConfig.taxRate` / `env TAX_RATE` was REMOVED 2026-08-18**: its only
  reader was order-templates, where it silently shadowed the tenant's own setting. Tax rate now
  comes exclusively from SystemConfig `settings.taxRate` via `common/tax-rate.ts`.
- **`src/common/`** — `EncryptionService` (AES-256-GCM, refuses placeholder key writes in prod),
  `RedisThrottlerStorage` (cross-instance rate limit, fails closed), ThrottlerExceptionFilter,
  audit interceptor. **2026-09-14:** `IdempotencyService` (new) joins `providers`/`exports` — an
  `Idempotency-Key`-header replay guard, `@Optional()`-injected by callers predating it
  (`returns.service.ts`); detail in `api/where-to-find.md`'s Returns row.
  **`enum-parity.spec.ts` (2026-09-03, wave E / imp-10b)** — pins every `packages/types/api/enums.ts`
  const-array union set-equal to `Object.values()` of the matching `@prisma/client` generated enum
  (40 enums); the import is guarded (`require` in try/catch) so a missing/renamed export fails on
  its own value, not a suite-crashing "Cannot find module". A second `describe` block reads the raw
  source text of the specific web/mobile files that drifted (`VendorBillStatus`, `POStatus`→
  `PurchaseOrderStatus`, `BuyerPromotion.type`→`PromotionType`, `EstimateStatus` on both apps) and
  asserts they no longer hand-declare a conflicting literal union — the permanent regression guard
  for L-072. ⚠️ `ENUM_TABLE` is a deliberate **40-of-80 SUBSET** (only the enums a client actually
  mirrors), so an equality assertion against the generated set would be WRONG; the close-out review
  (2026-09-05) added a third `describe` that pins the COUNT instead —
  `Object.keys(PrismaEnums.$Enums).length === PINNED_PRISMA_ENUM_COUNT` (80) — as a triage
  tripwire: a new/removed generated enum must be triaged into `ENUM_TABLE` (or deliberately left
  unmirrored) BEFORE the constant is bumped. **`schema-folder.spec.ts` (2026-09-04, wave E / imp-10a, T1; cases (g)/(h) reworked
  wave E structure; case (h) RETIRED 2026-09-11)** — pins `prisma/schema/` to exactly the 7 domain
  files, 126 model + 80 enum
  blocks total, `_base.prisma` holding only datasource+generator, every model/enum name unique,
  `prisma.config.ts` pointing `schema` at the folder with an explicit `migrations.path`. Case (g)
  spawns `split-prisma-schema.mjs --check` with **no original given** — must exit 0, stdout
  contains `structural invariants hold`, never `block-identical`. **Case (h) is RETIRED** (a
  replacement comment in the spec says why): it spawned `--check --from-ref e39bf9db` expecting
  `block-identical (207 blocks)`, a one-time split-time proof that cannot pass again now the folder
  has legitimately gained models (208 vs 207), and it `it.skip`ped itself on a depth-1 CI clone so it
  only ever ran locally. The standing lossless guard is `apps/api/scripts/schema-drift.mjs`
  (`npm run local:drift` / the CI db-migrations replay). Every oracle degrades to an empty/zero result (not a thrown
  ENOENT) when the folder is absent, so each case fails on its own value pre-split.
  **`no-single-schema-path.spec.ts`** (T2, same date/item; stripper rewritten wave E structure) —
  walks `apps/api/{src,scripts}`, root `scripts/`, `.github/workflows/`,
  `.claude/skills/**/scripts/`, plus the `Dockerfile`/`prisma.config.ts`/both `package.json`s/
  `docker-compose.yml`, strips `//`/`#`/`/* */`/`<!-- -->` comment bodies via a **hand-rolled
  character scanner** (`stripCLikeComments`), not a single alternation regex — a flat regex has no
  notion of "already inside a comment", so an unescaped apostrophe inside a `//` comment ("it's")
  opens a `'…'` string and swallows everything to the next raw `'`. The scanner skips comment spans
  character-by-character without re-entering quote-detection inside them, and preserves real
  string literals verbatim (unit-tested directly). Asserts none of the ≥400 candidates (real walk
  ~817; floor raised from the original vacuous-guard value of 30) still names the retired
  `prisma/schema.prisma` path outside comments; allow-lists `split-prisma-schema.mjs` (names that
  path by design via `--from`/`--from-ref`) and this spec's own T1 sibling (its negative-existence
  check (b) must name the retired path literally) — `apps/api/prisma/migrations/**` never scanned.
  **`msrp.ts` (NEW 2026-08-22, PR-B — ⚠️ IN FLIGHT on `feat/msrp-on-invoices`, NOT on master)** —
  suggested-retail resolution. `resolveMsrp({customerMsrp, segmentMsrp, productMsrp})` =
  customer override → \*\*segment (a deliberate STUB: present in the signature and every call
  site from day one, nothing populates it in v1 — future per-state MSRP is then one new table
  - one lookup inside `loadMsrpMap`, with no data migration and no call-site churn)** → product
    default; 0/negative/NaN all normalize to **null, never $0.00**. Plus
    `wholesalePerPiece(pricePerUnit, unitsPerBox)` (pricePerUnit is per SELLING unit — a box when
    boxed — so it must be divided down before comparing with a per-PIECE MSRP),
    `isMsrpBelowWholesale` (advisory: the UI warns, never blocks), and batch
    `loadMsrpMap(db, customerId, productIds)` (takes any prisma-ish client so it runs inside a
    `tenantTransaction`). **MSRP is display-only and never enters money math** — it is not a price;
    contrast money math, which used to be a triple mirror and now lives in one compiled package
    (`packages/pricing`, `@routeflow/pricing` — see `packages.md`; `common/pricing.ts` and
    `utils/pricing.ts` are deleted, api imports the bare specifier).
    `msrp.ts` is **server-only, no mirror**, since the only resolution moment is the invoice-line
    write. Spec: `common/msrp.spec.ts`.
    **`@routeflow/pricing`** — `computeLineSubtotal` (boxed BOX-price proration; optional
    **`freeUnits`** subtracts whole SELLING units before pricing — default 0, so every pre-existing
    call site is byte-for-byte unaffected), `normalizeBoxesPieces` (integer boxes/pieces + rollover),
    `roundMoney` (cents),
    **`prorateLineSubtotal(storedSubtotal, deliveredQty, orderQty, freeUnits = 0, freeUnitSize = 1)`**
    (F04/REG-B50, 2026-08-31) — "what does `deliveredQty` of `orderQty` cost" asked OUTSIDE the invoice.
    This api copy is the **reference implementation** (no server caller — the only production caller today
    is mobile's driver at-door short-pick, through the mobile mirror). Money comes from the **STORED**
    subtotal, never a live re-price. Reference oracle = **`invoices.service.ts#buildInvoiceItemData`**
    (READ-ONLY from here), specialised to a single bill from scratch (`priorBilledQty` always 0): the
    **paid-basis floored cumulative telescope** — prorate over `orderQty − freeUnits × freeUnitSize` and
    floor the free units consumed by the delivered prefix — **NOT** the plain linear
    `stored × delivered / order`, which is exactly REG-B50's bug on a line that HAD free units. A full
    delivery copies the stored subtotal back verbatim. `freeUnits` is the line's BUY_N_GET_M snapshot in
    whole SELLING units (BOXES on a box-split line) while the qty args stay on the line's own axis
    (PIECES); `freeUnitSize` bridges them (`unitsPerBox` when the line was stored WITH a split, else 1) —
    a box-split caller that leaves it at the default under-bills a partial by up to one box. At
    `freeUnits = 0` it reduces to the linear formula, so 3-arg callers are byte-for-byte unaffected.
    One copy, imported by web/mobile from `@routeflow/pricing`; golden tests live at
    `packages/pricing/src/*.spec.ts` (`pricing-parity.spec.ts`/`.fixtures.ts` deleted — there is
    nothing left to compare against).
    **`applyBestPromotion`/`promotionMatchesProduct`** (P5-04 — best applicable promo → net selling-unit
    price + originalPrice; PERCENT/QTY_BREAK % off, FIXED $/selling-unit, QTY_BREAK gated on pieces).
    **Zero-price guard (2026-08-21):** `ruleCanZeroPrice`/`promotionZeroesProduct`/`scanPromotionZeroPrice`/
    `zeroPriceWarning` — how many in-scope products a rule would clamp to $0.00 (`{count,inScope,examples}`);
    already-$0 products excluded, QTY_BREAK judged at its own threshold. `ruleCanZeroPrice` switches on the
    mechanic (FIXED always / PERCENT+QTY_BREAK only at 100%) — **BUY_N_GET_M can never be flagged and is never
    scanned**: `promoBogoFreeUnits` requires N ≥ 1, so `floor(qtyUnits/(N+M))*M < qtyUnits` always — a free-unit
    rule discounts steeply but can never make a line free.
    **BUY_N_GET_M (2026-08-21, WP1):** `PromotionType` union += `"BUY_N_GET_M"`; `PromoContext` += **`qtyUnits`**
    (whole selling units on the line — boxes for a boxed line, qty for a piece line; loose PIECES NEVER COUNT and
    are never given free); `PromoResult` += **`freeUnits`** (0 for every other type). Private `promoBogoFreeUnits`
    = `floor(qtyUnits / (N + M)) * M`, reading **`minQty` = N** and **`value` = M** (no new Promotion columns); a
    non-integer or `< 1` N/M means the rule is IGNORED, never a crash. A BOGO win keeps `unitPrice = base` and
    `originalPrice = null` — the saving (`freeUnits × base`) is realised ONLY by feeding `freeUnits` into
    `computeLineSubtotal`, **never** a rounded net unit price (12 @ $35 with 2 free = exactly $350.00, not
    10 × $29.17). `applyBestPromotion` still picks one non-stacking winner, but **REG-B109 (F04, 2026-08-31)
    moved the comparison onto the BILL basis**: every candidate is priced through the SAME
    `computeLineSubtotal` on the FULL entered quantity and the one billing the LEAST wins — the old basis
    (price promos `(base − net) × qtyUnits` vs BOGO `freeUnits × base`) counted whole selling units only and
    silently dropped a mixed line's loose pieces. Ties fall back to the lowest net unit price, then promo id.
    `PromoContext` gained optional **`boxes`/`pieces`/`unitsPerBox`** (R7 signature compatibility) — they are
    **opt-in (`hasFullQty = boxes != null || pieces != null`); without them the comparison degrades to the old
    `qtyUnits` basis**, which is exact only on a line with no loose pieces, so every line-pricing call site
    must pass the same split it then bills with.
    **Every money write rounds; boxed lines never use `qty*unitPrice` (over-charges by unitsPerBox); a promo adjusts the
    selling-unit price then feeds computeLineSubtotal (never per-piece).** One copy in
    `@routeflow/pricing`, imported by web/mobile. `getTierPrice` lives there too (was
    `utils/pricing.ts`, now deleted). **`computeCategoryTax`** (Phase-4 W3) — regulated per-category levy: per-unit types (EXCISE/PER_VOLUME/DEPOSIT) = `rate × unitBasisQty` (**caller converts to basis**: pieces for excise/deposit, true volume for PER_VOLUME — a 16oz bottle taxed per-oz needs 16×pieces; orthogonal to box-proration, never the boxed subtotal); PERCENT_OF_SALE = `rate × subtotal` (embedded when priceIncludesTax = `subtotal×rate/(1+rate)`). Sign-preserving (reversals). Pure fn. **RF-4 (WIRED): folded into totals** — `orders.service` computes it per line at create/edit/merge (`unitBasisQty` = piece count) into `OrderItem.categoryTaxAmount` + the order total (`total = subtotal + regularTax + categoryTax − discount`; the `tax` column stays regular-only, category tax = Σ line snapshots); `invoices.service` copies/prorates it onto `InvoiceItem.categoryTaxAmount` (telescoping, like subtotal) and folds it into every invoice `taxAmount` via `foldCategoryTax` — **exemption covers everything\*\* (an `isTaxExempt` customer owes $0 of BOTH regular AND category tax; snapshots zeroed too so the ledger records $0). PER_VOLUME volume-per-piece source still deferred (uses pieces, approximate). Specs: `packages/pricing/src/pricing.spec.ts` (money math moved here, see `packages.md`), `orders.service.spec` (RF-4 per-category regulated tax), `invoices.service.spec` (RF-4 split invariant + exemption + manual).
- **`common/pagination.ts`** (F9-001/002/003) — `MAX_LIST_LIMIT` (1000) + `clampLimit(limit,fallback,max?)` (missing/NaN/<1 → fallback, else floored+capped). List DTOs enforce it via `@Max(MAX_LIST_LIMIT)` on `limit` (customers + invoices; products keeps its own `@Max(10000)` picker cap, suppliers `@Max(200)` **with `@Min(0)` — 0 = fetch-all sentinel (service `fetchAll = limitRaw===0`); the F9 `@Min(1)` silently 400'd the web Suppliers page's `limit:0` for weeks ("Failed to load data. Please try refreshing.") — fixed 2026-07-19, regression spec `suppliers/dto/list-suppliers.dto.spec.ts` mirroring the identical earlier products-DTO regression**); raw-query routes (`invoices.listAllPayments`) clamp in-service. Spec `common/pagination.spec.ts`. **`common/invoiced-sales.ts` (2026-07-31)** — shared invoiced-sales sourcing for analytics/forecasting/COGS readers (`StockMovement type:"SALE"` is DEAD — only writer removed in c5f579c2). Exports `REAL_INVOICE_STATUSES` (moved from analytics.service, now exported) + `roundQty` (3dp) + `fetchInvoicedSaleLines(db,{from,to,dateBasis:"issueDate"|"paidAt",status?})` (⚠️ queries THROUGH `invoice.findMany`, never `invoiceItem.findMany` — nested-created lines carry tenantId=null) + point-in-time COGS estimation: `buildCostIndex`/`costAt` (binary search over `avgCostAfter` snapshots ≤ date), `resolveUnitCost` (ladder: snapshot→STANDARD standardCost→averageCost→0), `estimateCogs` (Σ qty×cost at each line's issueDate; null-productId lines $0; optional excludeTobacco), fetchers `fetchCostIndex`/`fetchProductCostFacts` (skip query on empty id set), `soldProductIds`. Consumers: analytics (top-products/turnover/gross-margin/dead-stock), inventory `getForecasting`, bookkeeping `getProfitAndLoss`. Known limitation: returns/credit notes not netted (parity with `getProductDemand`). Spec `common/invoiced-sales.spec.ts` (stub db has no invoiceItem — through-Invoice pinned structurally).
- **`common/upload-limits.ts` (2026-09-01) — the ONE multipart `limits` factory; all 16 FileInterceptor/FilesInterceptor sites across 9 controllers call `uploadLimits(MB(n))`.** Carries the per-route `fileSize` plus **`fieldArrayIndexLimit: 100`** and **`fieldNestingDepth: 5`**. ⚠️ **`fieldArrayIndexLimit` is multer 2.3.0's fix for CVE-2026-82333 (event-loop DoS: `a[999999999]` materialises a sparse array) and it is OPT-IN — gated on `hasOwnProperty`, default `Infinity` — so upgrading multer alone mitigates NOTHING.** ⚠️ **Do not inline these as an object literal**: `MulterOptions.limits` is declared by @nestjs/platform-express itself (NOT @types/multer) as a closed 7-key literal with neither key, and `@types/multer@2.2.0` is the newest published — a fresh literal is a TS2353 excess-property error. Returning a pre-built object with an INFERRED return type is what compiles, with no cast and no `any`; annotating the return type re-breaks it. Runtime is safe: `FileInterceptor` does `multer({...options, ...localOptions})` with no key filtering. ⚠️ Values bound attackers, not callers — every RouteFlow client sends repeated plain field names (`focalX`), never bracket-indexed. Spec `uploads/multer-field-limits.security.spec.ts`. **The hoisted multer is forced to ^2.3.0 by a root `overrides` entry** — `@nestjs/platform-express@11.2.3` pins `multer` at an EXACT `2.2.0`, so without it the copy every interceptor resolves stays vulnerable while the lockfile shows 2.3.0 nested where nothing imports it (this is [[L-028]]; the override is the documented [[L-012]] exception).
- **`common/tax-rate.ts` (2026-08-18) — money-critical unit contract.** `taxRateFractionFrom(stored: string|null): number` is the ONE parser of SystemConfig `settings.taxRate`. **The stored value is a PERCENT (0–100, string); the helper returns a FRACTION.** Every client (web + mobile) already divided by 100; `orders.service.getTaxRate()` alone treated the same string as an already-divided fraction, so a tenant storing `"5"` would have been taxed 500% the moment a save routed through `orders.create` (latent only because no taxed line existed in prod). Null/`""`/non-finite → 0; the value is **clamped to 0–100 before dividing**, which makes an already-stored out-of-range value (a QA tenant holds `"150"`) inert without any backfill. Readers: `orders.service.getTaxRate`, `order-templates.service.generateOrder` — nothing else may parse that key. Spec `common/tax-rate.spec.ts` pins `"10"→0.10`, `"0"/""/null/"abc"→0`, `"150"→1`, `"-5"→0`, `"0.5"→0.005`. Write side is validated in `settings.controller` (see `system-config/`).
- **`common/transforms/strip-html.transform.ts`** — `StripHtml()` class-transformer decorator (RF-110) on ~14 free-text DTO fields (customer businessName, buyer profile businessName/displayName/notes, buyer-account name, order/invoice notes, order-item custom name, shipment carrier/tracking, variant name, stock-count name/notes, bill-payment/statement notes). Strips tags via sanitize-html then **entity-decodes the output** (`&lt; &gt; &quot; &#39;` then `&amp;` LAST — order prevents double-decode): sanitize-html re-encodes text nodes, which until 2026-08-23 stored "Smith & Sons" as "Smith &amp; Sons". Input is parsed as HTML, so pre-escaped input decodes once ("a &amp; b" → "a & b"). Spec `strip-html.transform.spec.ts`. **sanitize-html PINNED at exact 2.17.5 (+ dependabot ignore, 2026-08-28/#463): ≥2.17.6 swaps in ESM-only htmlparser2 12 (Jest's CJS loader can't import it — 9 API suites died at load) and requires Node ≥22.12 vs the node:20 prod containers; the sanitization behavior itself still round-trips every spec case (verified empirically on 2.17.7). Unpin only with a platform Node-22 bump. Skipped 2.17.6/2.17.7 CVEs need allowed svg/math/animation tags — moot under `allowedTags: []`.** Damage census: **`scripts/report-escaped-entities.mjs`** — READ-ONLY (deliberately no `--execute`; repair is a separate owner-approved task), counts rows containing each of the 5 entities per tenant per affected column (15 table.column targets; OrderItem tenancy via Order join; BuyerAccount global; skips tables absent from older DBs); `DATABASE_URL` or the railway proxy env, `REPORT_TENANT_SLUG` scopes. Repair sibling **`scripts/repair-escaped-entities.mjs`** (#427) — per-tenant in-place decode of the same 15 targets, dry-run default (`--execute --confirm-tenant=<slug>`, live tenants add `--live-tenant-override`); buyerAccount rows tenant-scope via `customerLinks: { some: { tenantId } }` (BuyerAccount has no tenantId — fixed 2026-08-24, was a nonexistent `customers` relation whose skip log printed Prisma's blank first error line; unqueryable targets now log the first non-empty trimmed line).
- **Prisma schema — a FOLDER, `prisma/schema/*.prisma` (item 10a, 2026-09-04)**, not a single file. Prisma 7 multi-file: every `*.prisma` under the folder is one datamodel, concatenated in filename order. Seven files, 207 top-level blocks / 125 models / 80 enums total — `_base.prisma` (datasource + generator only), `tenancy.prisma` (15 models: Tenant/TenantConfig/TenantGoogleOAuth, User/UserPreference, RefreshToken/PasswordResetToken/DeviceToken, PlatformConfig, BuyerAccount and its 3 auth tokens, CustomerLink, BuyerMergeRequest), `catalog.prisma` (11: Product, Supplier, StockLot/StockMovement, PurchaseOrder(+Item), ProductMapping/ProductAlias, StockAlert, StockCountSession/Line), `sales.prisma` (39: Customer and its tag/address/document/comment/price satellites, ContactPerson, Driver(+Location), Route/RouteStop/RouteCustomer/RouteRun(+Stop), Order/OrderItem/OrderRevision/ChangeRequest, DeliveryMutation/DeliveryBatch, OrderTemplate(+Item), Return(+Item), Promotion(+Product), BuyerFavorite, ReplenishmentSnooze, SaleDraft, SalesAgent and the whole Commission* cluster), `finance.prisma` (28: Transaction(+Item)/Payment, Invoice(+Item)/InvoicePayment/PaymentCounter, Expense*/MileageRate, CreditNote(+Item)/OrderCreditNote, Estimate(+Item), VendorBill(+Item)/BillPayment, InvoiceScan/SupplierStatementScan, AdvancePayment/SupplierCredit, RecurringInvoice(+Item), TenantStripeConnect/StripeConnectEvent/BuyerPaymentRequest), `platform.prisma` (25: the SaaS-side billing — TenantSubscription/TenantAddon/PlanVersion/PlanDefinition/AddonSku/MeterUsage/BillingEvent/RfInvoice — plus SystemConfig, the Message*/Notification* cluster, AuditLog, NumberingSequence, Import*/Migration*, AiUsageEvent, IdempotencyKey), `compliance.prisma` (7: TobaccoReport, TrackedCategory(+Sub), CustomerAuthorization/AuthorizationOverride, RegulatedSalesLedger, RegulatedFiling). **Each enum sits beside the FIRST model that uses it** (derived from first use, not hand-placed); relations cross files freely, but every model/enum name must stay unique repo-wide. ⚠️ **Adding a model means TWO edits**: the domain file AND the `MODEL_DOMAIN` map in `scripts/split-prisma-schema.mjs` — an unmapped model hard-fails `--check` (there is no "misc" bucket). Consumers that read the datamodel as TEXT must read the FOLDER: `scripts/schema-drift.mjs` (`--to-schema prisma/schema`), `src/scripts/repair-f17.spec.ts`, `.claude/skills/bug-hunt/scripts/scan-signatures.mjs`. `prisma.config.ts` carries `schema: prisma/schema` plus an explicit `migrations.path: prisma/migrations`. ⚠️ The generated client `index.d.ts` is NOT byte-identical across the split — folder order changes declaration order ([[L-073]]); pin semantics (`split-prisma-schema --check`, the drift gate), never the generated bytes. Models incl. Tenant, User, Customer, Driver, Product,
  Route, RouteStop, RouteRun, RouteRunStop, Order, OrderItem, Invoice, InvoiceItem,
  InvoicePayment, Payment, CreditNote, Estimate, VendorBill(+Item), Return(+Item),
  AdvancePayment, Supplier, StockLot, StockMovement, OrderTemplate, OrderRevision (P5-08 append-only order edit history), PurchaseOrder,
  DeliveryMutation, Transaction(+Item), Expense, ExpenseCategory, MileageRate, ContactPerson,
  Customer{Tag,Address,Document,Comment,Price}, Message, RecurringInvoice, BuyerAccount,
  CustomerLink, BuyerMergeRequest, SystemConfig, PlatformConfig, AuditLog,
  **TrackedCategory, CustomerAuthorization, AuthorizationOverride, RegulatedSalesLedger**
  (Phase-4 regulated items — migration `20260706120000_regulated_items_foundation`),
  **ChangeRequest** (P5-09 post-dispatch change request; enums `ChangeRequestType`
  {ADD_ITEM,CHANGE_QTY,REMOVE_ITEM,NOTE} / `ChangeRequestStatus` {PENDING,APPROVED,DECLINED} —
  migration `20260721000000_add_change_requests`). All tenant-scoped.
  **`OrderCreditNote`** (migration `20260729000000_add_order_credit_notes`) — order↔credit-note
  INTENT rows (`orderId`+`creditNoteId` unique, `amount Decimal?` = requested dollars, null = up
  to remaining). Pure selection state: money only ever moves as `InvoicePayment{method:CREDIT_NOTE}`
  via `applyCreditInTx`; `settleOrderCreditsInTx` re-applies intents idempotently on every invoice
  change. Back-relations `Order.orderCreditNotes` / `CreditNote.orderLinks` / `Tenant.orderCreditNotes`.
  **`Order.shippingFee`** Decimal(10,2) default 0 (migration `20260728000000_add_order_shipping_fee`) —
  optional per-order shipping fee, never taxed (added after tax like `Invoice.shippingFee`);
  invariant `Order.shippingFee == Σ shippingFee of the order's non-VOID invoices`
  (back-synced by `recomputeOrderFromInvoices`; from-order invoice creation seeds the whole
  fee onto the largest-subtotal sibling, never prorated).
- **`prisma/seed.ts`** (2026-09-03, multi-tenant aware) — local dev seed for the approved `test`
  tenant only: upserts tenant + 7 users (`Test@1234`), the `order_delivery`+`recurring_routes`
  TenantAddons (so its own seeded drivers/routes aren't `AddonGuard`-403'd; mirrors demo-seed's
  `update: {}` preserve-on-reseed), drivers, customers(+addresses), 15 products, routes/stops,
  10 orders; every row carries `tenantId`. Two guards run before any
  write: `assertTestTenant(TENANT_SLUG)` (scripts/lib/test-tenants.cjs, slug allow-list) and
  `assertSafeTarget()` (DATABASE_URL host must be localhost/127.0.0.1/::1/postgres and
  NODE_ENV≠production, else throws unless `SEED_ALLOW_REMOTE=1` — reaching a remote DB is
  always a deliberate act).
- **`prisma/publish-plan-catalog-v8.ts`** (2026-08-21, `npm run db:publish:catalog`) — publishes
  the Starter $99 / Growth $249 / Scale $499 / Enterprise-custom ladder (+ `customersIncluded`
  100/250/500/null and the 8th SKU `CUSTOMER_PACK_100`) as a NEW catalog version through the
  DRAFT→PUBLISHED lifecycle. Mirrors `seed.ts`'s connection setup (raw PrismaClient over the pg
  adapter, `DATABASE_URL`) and line-for-line mirrors `PlanCatalogService.createDraft()`/`publish()`
  rather than booting a Nest context — keep the two in lock-step. Idempotent (a PUBLISHED version
  already carrying GROWTH @ $249 ⇒ exits 0 writing nothing), deletes nothing, and **never re-pins
  existing tenants** — grandfathering is the point. `annualPrice()` computes annual; no price is
  hardcoded twice. Migration `20260823000000_plan_catalog_customers_axis` (additive: `MeterKey`
  gains `CUSTOMERS` outside a transaction, `PlanDefinition.customersIncluded` nullable) must be
  applied first.
- **`scripts/e2e-seed.js`** — idempotent seed for the `e2e-routeflow` tenant. Seeds **four fixed
  users** (both the fresh-tenant and existing-tenant branches): operator `admin`/`Admin@123`,
  customer `harbor_cafe`/`Customer1!`, tenant admin `e2e_admin`/`TenantAdmin1!` (B138 —
  `platform-admin.service.ts impersonate()` requires an ACTIVE `TENANT_ADMIN` to resolve, and
  spec 31 `impersonation-signout` impersonates this same user), and — wave D, L-050, #598/#607 —
  one more dedicated identity so spec 32 stops mutating the shared operator session every
  `storageState: operator.json` project also loads: `e2e_sessions_op`/`Sessions1!` (OPERATOR,
  spec 32 `active-sessions` logs in fresh as this user and only ever revokes its own
  `/auth/sessions` rows). Spec 31 needed no dedicated identity — it only ever mutates its own
  fresh impersonation session, and a wave-D attempt to give it a separate
  `e2e_impersonated_admin` identity was reverted (it would have left `e2e-routeflow` with two
  ACTIVE `TENANT_ADMIN`s, which makes `impersonate()`'s unordered `findFirst` ambiguous).
  `helpers/constants.ts CREDENTIALS.sessionsOp` on the web side carries the pair. On an existing
  tenant it also SWEEPS stale
  parked SaleDrafts from the operator's dock (kind ORDER + device "Desktop web" + title
  `Order…` — residue web e2e 08-create-order-escape parked before it cleaned up after itself,
  2026-08-19). **2026-08-20, generalized 2026-08-28:** `ensureAddon(tenantId, addonKey)` (was
  `ensureDeveloperMode`) upserts an ACTIVE TenantAddon in BOTH the existing-tenant and
  fresh-create paths, called for `developer_mode` + `recurring_routes` + `order_delivery` —
  the web suite exercises `/routes` and `/deliveries`, which since 2026-08-28 need the REAL
  feature addons (`developer_mode` no longer unlocks them client-side, and `/routes` now 403s
  without one server-side); web e2e OP-03b is the canary. Keeps `update: { active: true }`
  (unlike demo-seed's `update: {}`) — the e2e canary must be deterministic.
  **2026-08-26:** the catch prints the WHOLE error (Prisma wraps connection failures in an
  "Invalid invocation" whose `.message` is empty — CI logged a blank cause for a week). In CI
  the seed only runs when the `E2E_SEED_DATABASE_URL` secret is set (see
  `apps/web/e2e/setup/global.setup.ts` for the full seeding contract). **2026-09-05 (tooling
  lesson L-074):** the module-level `DATABASE_URL ?? <localhost>` fallback is gone — a
  `resolveTargetDbUrl()`/`bootstrap()` pair now reuses `scripts/lib/railway-db-url.mjs`'s
  `resolveDatabaseUrl` (see that entry above) so a `railway run --service postgres` invocation
  (which exposes only `POSTGRES_*`/`RAILWAY_TCP_PROXY_*`, never `DATABASE_URL`) resolves the real
  target instead of silently reseeding localhost; always prints `e2e-seed: target host = <host>:<port>/<db>` (never the password) before connecting, and a "nothing set" run prints a
  loud fallback warning first. **2026-09-05:** `--print-target` (parsed from `process.argv`,
  checked in `bootstrap()` right after that target-host line is printed) exits 0 before any
  `new Pool`/`new PrismaClient` — a dry check that resolves and prints the target without ever
  connecting; `railway run --service postgres node apps/api/scripts/e2e-seed.js --print-target`
  is the safe way to confirm where a real reseed would land. Also seeds one `TrackedCategory`
  (`ensureLicensedTrackedCategory`, `requiresLicense: true`, upserted on the
  `@@unique([tenantId, name])` key, both branches) so REG-B91 (`34-calendar-dates.spec.ts`) stops
  self-skipping for lack of a licensed category. Contract: `src/common/e2e-seed-script.spec.ts`
  (spawn-level, three DATABASE_URL-resolution cases, all driven with `--print-target` so none
  ever reaches a database).
- **`scripts/demo-seed.js` + `demo-seed-images.js` + `demo-verify.js` + `lib/demo-ids.js`**
  (2026-08-20) — the standing sales-demo tenant `routeflow-demo` (on the test-tenant allow-list;
  operator `routeflow_demo`/`routeflow_demo`). `demo-seed.js` copies a catalog from the tenant
  named by **`DEMO_SOURCE_TENANT`** (env, never hardcoded — CLAUDE.md forbids a live slug in
  code) READ-ONLY, driven by `DEMO_ASSETS_DIR/manifest.json` (`uploaded:true` entries only) +
  `descriptions.json`, then generates 5 customers, 3 suppliers, 2 routes (8 RouteRuns: 2 done +
  2 scheduled each), opening PURCHASE stock, ~64 orders over 60 days and their
  invoices/payments/credit notes. Dry-run by default,
  `--live` to write. Every row id is `stableId(ns, key)` (SHA-1 → UUIDv5 shape, `lib/demo-ids.js`)
  so a re-run addresses the same rows: foundation rows are upserted, transactional rows are
  deleted and rebuilt, and because product ids are stable **already-uploaded images survive a
  refresh**. Mirrors production money math exactly — `computeLineSubtotal`/`computeCategoryTax`
  (and `roundMoney`, `normalizeBoxesPieces`, `getTierPrice`) imported from `@routeflow/pricing`
  (compiled CJS — no ts-node hook needed for it; the hook remains for the two `.ts` requires) —
  never re-implemented, `Order.tax` = REGULAR tax only with category tax folded into the total, and invoices split by
  `invoiceTreatment: SEPARATE_INVOICE` into `-R1` siblings sharing an `invoiceGroupId` with the
  tax remainder + whole shipping fee on the largest group. A `scoped()` helper stamps and asserts
  the demo `tenantId` on **every** row (parent and nested child) so a nested create can never
  leave a NULL tenantId. **Invoice status is derived, not hardcoded** (`storedInvoiceStatus`):
  the dashboard's overdue tile queries the STORED `OVERDUE` status (`useInvoices({status:"OVERDUE"})`
  — the derived past-due path only fires on `isOverdue`), and `recomputeStatus` checks "any
  payment at all" BEFORE the due date, so a part-paid late invoice stays `PARTIAL` and only an
  untouched past-due one becomes `OVERDUE`; seed the two the same way or the tile reads 0 while AR
  aging shows money. Same class of trap for the other landing tiles: the newest days need some
  DELIVERED orders (else revenue-today is $0, guaranteed by a post-pass), unpaid invoices must be
  older than `PAYMENT_TERMS_DAYS` to age at all, and a slice of products is bought to demand with
  zero headroom — sized at PURCHASE, never docked afterwards, so `currentStock` still equals
  (opening − sold) — or nothing is ever low stock. The owner's customer gets a VERIFIED
  `CustomerAuthorization` for every `requiresLicense` section (`licenseOwnerForRegulated`) — the
  demo tenant's Tobacco section HAS `requiresLicense: true`, so without it every tobacco line is
  refused by `authorization-guard.service.ts`; the other four customers stay unlicensed on purpose
  so the block can be shown. **The refresh sweep matches children on their own `tenantId` OR their
  parent's** — filtering on `tenantId` alone let four app-edited `OrderItem` rows with a NULL
  tenantId survive and break the order delete with an FK error (the nested-create trap, live).
  `demo-seed-images.js` uploads the staged photos through the audited
  `POST /products/:id/images` route (one `GET /products?limit=0` up front to skip products that
  already have an image, so a resumed run never double-uploads). `demo-verify.js` is READ-ONLY:
  money identities, NULL-tenantId children **reached via their parent** (a database-wide count
  would just surface unrelated legacy rows), stock, and source-tenant isolation.
  **2026-08-21:** `demo-seed.js` also upserts the demo tenant's ACTIVE `developer_mode`
  TenantAddon (same shape as e2e-seed's `ensureAddon`) — it unlocks the mobile driver-app
  walkthrough the demo needs; this one KEEPS `update: { active: true }` (owner decision
  2026-08-28: forced back on every reseed, and after the client narrowing it no longer leaks
  into the web UI).
  **2026-08-25:** also upserts `recurring_routes` and `order_delivery` TenantAddons (same
  shape) now that those are separate addons from `developer_mode`, so the demo shows the full
  Dispatch + Deliveries surface. **2026-08-28:** those three FEATURE addons (`driver_payments`,
  `recurring_routes`, `order_delivery`) switched to **`update: {}`** — a reseed creates the row
  when missing but PRESERVES a platform-admin toggle that turned it off; only `developer_mode`
  is still forced active.
  **2026-08-26 (audit P0 batch, PR #457):** `demo-seed.js`'s `OWNER_EMAIL` is now the FICTIONAL
  `najath@najathstrading.example.com` (was the owner's real gmail — policy: demo carries
  `*.example.com` contacts only), with a fail-fast guard over `CUSTOMERS` rejecting any
  non-example.com email at module load; `linkOwnerBuyerAccount()` consequently no-ops (harmless —
  verified: `licenseOwnerForRegulated` still resolves the owner customer via the same constant).
  Sibling **`scripts/scrub-demo-contacts.mjs`** (NEW) sweeps rows created OUTSIDE the seed:
  guard-first (`assertTestTenant("routeflow-demo")` at module top, before the Prisma client
  exists), dry-run default / `--execute`, offenders matched by SHAPE (email not `*.example.com`
  and not the deliberate `@placeholder.local` no-email sentinel; phone digits without `555`) —
  never by literal value, so no real PII lives in the file; also sweeps demo-tenant `User.email`
  (reusing the matched customer's replacement) and REPORTS — never modifies — linked global
  `BuyerAccount`s. Executed against prod 2026-08-26: 2 customers + 1 user scrubbed, verify pass
  clean, 1 buyer account left for the owner to unlink.
  **2026-08-24:** `demo-seed.js` gained `demoAddressCoords(index)` — deterministic, idempotent
  Austin-area `lat`/`lng` per demo customer, written on both the `CustomerAddress` `create` and
  the `update` branch of the upsert (so re-running the seed repairs existing null rows).
  Root cause this fixes: demo customer addresses were seeded with `lat = null` (this script
  bypasses the app's geocode-on-create path), so the ad-hoc trip builder's optimize step 400'd
  on the demo tenant. See `docs/phase0-adhoc-trips-findings.md`.
  **2026-08-25 (PR #437):** the teardown in `clearTransactions()` now walks the **commission
  chain before invoices** — payouts → statement lines → statements → adjustments → accruals —
  because `CommissionAccrual.invoiceId` FKs `Invoice` and blocked `invoice.deleteMany` (the
  refresh died half-cleared; sales agents + assignments stay FOUNDATION, never swept). It also
  clears `DeliveryMutation`/`DeliveryBatch` before orders and run stops, matching mutations via
  EITHER parent (`routeRunStopId` and `orderItemId` are both nullable, so a nested-created row
  can carry a NULL `tenantId` and a NULL link to one side). Demo-readiness for the trip builder
  with NO Maps key: `DEMO_DEPOT` coords land on both `Route` **and** `RouteRun`
  (`resolveDepot()` tier 1 needs `depotLat/depotLng` — an address string alone is why optimize
  400'd), `SystemConfig route.defaultDepotLat/Lng` is seeded (tier 2 + the trip builder's
  tenant-depot origin), `driverHomeBase(key)` gives both demo drivers `homeLat/homeLng/
homeAddress` (the driver-home origin), and orders inherit `fulfillPath` from their customer —
  mirroring `OrdersService.create`, which the Prisma-direct write bypassed, leaving the SHIP
  demo customer's orders all ROUTE. Also upserts the ACTIVE `driver_payments` TenantAddon.
- **`prisma/migrations/`** (2026-08-15, baselined) — two migrations only. `0_init` is
  generated to equal PRODUCTION exactly, replacing 75 partial migrations that could not build
  a database from scratch (40 of 106 models were never created; deploy died at
  `add_vendor_bill_items`). `20260815000000_add_product_tenant_name_index` then adds the one
  index production was missing. Existing environments must run
  `prisma migrate resolve --applied 0_init` ONCE before any further `migrate deploy`, or
  deploys block with P3009. `AiUsageEvent` + `IdempotencyKey` are modelled in the prisma/schema folder
  purely so Prisma stops treating the app's runtime-created tables as drift and DROPping them.
- **`prisma/migrations/20260909000000_rls/migration.sql`** — Postgres row-level-security
  policies (defense-in-depth under the `forTenant` client-side scoping), applied by
  `migrate deploy`, never by hand: per-table `ENABLE`/`FORCE ROW LEVEL SECURITY` +
  `tenant_isolation` policy, then a post-apply `DO` block that RAISES on any listed table
  missing enable/force/policy (the policy loop swallows its own errors, so a 0 exit proves
  nothing). **Sole copy of the policied-table list** — `scripts/rls-preflight.mjs` parses
  `tables := ARRAY[...]` out of this file to count NULL-`tenantId` rows before arming.
- **`prisma/rls.sql`** — superseded pointer stub (comments only). The policy DDL lived here
  until it moved into the migration above; a second copy of the table list is how a table
  gets armed without the pre-flight ever checking it. Do not re-add DDL here.
