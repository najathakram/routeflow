# RouteFlow "Unified Ledger" — session handoff prompt

> Paste the block below to start the next session. It is **self-contained** — a different Claude
> profile will NOT have the previous session's auto-loaded memory, so everything needed is inline
> or in committed repo files. Keep this file updated at the end of each session.

---

Continue the RouteFlow "Unified Ledger" design-wiring program. This prompt is self-contained (a
different Claude profile won't have prior-session memory — rely on this + the in-repo docs).

## 0. Setup & skills (do first)

- Working dir `C:\ClaudeCode\routeflow` — npm + Turbo monorepo: `apps/api` (NestJS 11, Prisma 7 +
  Postgres), `apps/web` (Next.js 14, the golden reference), `apps/mobile` (Expo). Deploy: Railway.
- Read the committed docs before coding: project `CLAUDE.md`, `CLAUDE_SESSION_PREAMBLE.md`
  (prod-safety), `docs/design-package/IMPLEMENTATION-PLAN.md` + `PHASE-2-PLAN.md`, `/QUESTIONS.md`,
  `.claude/code-map/INDEX.md` → the relevant area file. Design source of truth:
  `docs/design-package/project/` (`unified/*.html` = visual, `specs/*.md` = rules). Master
  domain→endpoint map: `project/specs/backend-wiring-index.md`.
- **Skills are project-local in `.claude/skills/` (auto-discovered, no install needed) — see
  `.claude/skills/README.md`.** Use: **rebuild** (deploy routine), **db-migration**, **smoke-check**,
  **regression**, **debug-deploy**, **new-feature**, **test-gen**, **code-map**. Confirm `/rebuild`
  and `/code-map` resolve. Memory does NOT carry across profiles; MCP servers/plugins may need
  re-auth (none are required for core dev — adversarial review uses the built-in **Workflow** tool;
  live authed-UI checks use the optional `claude-in-chrome` MCP).

## 1. Program state

- Phase 1 (Foundation): SHIPPED (#116).
- Phase 2 (Operator core) — **SHIPPED & DEPLOYED** (PR #121 squash-merged to master 2026-07-06).
  Prod migration `20260706040000_add_costing_last_cost` applied via the public proxy (`migrate status`
  = up to date); all 4 CI jobs green on master INCLUDING **E2E (Playwright)**; repo back to private;
  authenticated post-deploy smoke passed (health/auth/orders/invoices/customers/products/drivers money
  fields + invoice math all OK). Full-branch `npm run verify` was green (18/18 tasks). Included:
  - §1 negotiation-floor core: SHIPPED (#117/#118). §2 minimize/resume drafts: SHIPPED + live-verified
    (#119). §1 cost-history popover + shared-MarginHint dedup + analytics method label: SHIPPED (#120).
  - **§1 COMPLETE** on #121: **LAST_COST** costing (enum + `recordSale`; 2 HIGH review bugs fixed) ·
    **tenant-default costing** for new products (`products.service.create`) · **invoices/new** boxed
    line-total money-display fix + shared `<MarginHint>` (§1a) · **E2E CI regression fixed** (login-reskin
    selectors + 6 data/API/expectation bugs; see §3) · project **skills** made repo-local + this doc.
  - **§4 drive mode — DONE** (`lib/drive-mode.tsx` + avatar toggle + topbar exit + my-runs field layout).
  - **§3 at-the-door — DONE on BOTH surfaces**: dispatch packing-list page AND the live-run driver view
    `routes/[id]/page.tsx` (StopItem gained an `onAtDoorActions` prop + "At-door actions" button on the
    IN_PROGRESS stop → shared `components/ArrivedStopSheet.tsx`).
  - **All 10 operator Ledger reskins — DONE** (returns, dashboard, customers, customer-detail, inventory,
    orders-list, order-detail, products, product-detail, dispatch) — done in batches via a reskin+review
    Workflow, each `preservedOk=true` (every hook/handler/route preserved; presentation-only), types+lint
    green. **Still need post-deploy VISUAL verification on the `test` tenant** (functionally reviewed only).
- **Money-discipline remediation (boxed-line over-charge) — ALL SHIPPED & DEPLOYED (2026-07-06):**
  a boxed product prices by the BOX, so any `qty*unitPrice` over-charged by ~`unitsPerBox`. Fixed +
  deployed everywhere, each adversarially money-reviewed with regression specs:
  - **#122** invoice/estimate DETAIL display (stored `item.subtotal`) + invoice EDIT save (send boxes/pieces).
  - **#123** operator + buyer order edit + the buyer/CUSTOMER server branch, with a **denomination gate**
    (re-split as pieces ONLY when the stored line was box-aware; selling-unit/mobile lines keep `qty*unitPrice`).
    The review caught a HIGH under-charge regression → fixed by the gate.
  - **#124** order merge/consolidate (`mergeBoxedContributions` — normalize to pieces, re-split, prorate).
  - **#125** mobile customer cart made box-aware (whole-box model). NOTE: mobile UI NOT runtime-verified
    (Expo Go won't run this dev-client app; desktop can't reach the mobile cart with a Google-only buyer —
    see the mobile-web-testing-constraints memory). Logic proven by Jest.
- Phase 3 (Finance) — **RESKINS DONE & DEPLOYED**: F1 (finance dashboard, invoice detail, credit-notes; #121)
  + F2 (invoices-list KPIs, payment receipt, bills-hub + new **Purchase Orders** tab, vendor-bill detail;
  **#128**). Each reskin+review Workflow → `preservedOk`+`fidelityOk`. **SKIPPED** (current app > mockup):
  Financial Reports (22-report explorer), Recurring invoices. **Post-deploy VISUAL verification still
  pending** (operator session was replaced by a buyer login; needs operator Google login on `test`).
- Phase 4 (Regulated items) — **IN PROGRESS**. XL / HIGH money+compliance risk / **multi-session**.
  Full W1–W7 plan in **`PHASE-4-PLAN.md`**. Generalize `isTobacco` → a `TrackedCategory` model.
  - **chunk-1 (W1 schema + W2 CRUD + B1 hub) — SHIPPED & DEPLOYED** (PR #130, master `98df3e8`).
    Migration `20260706120000_regulated_items_foundation` applied to prod (4 models + 6 enums + FK/snapshot
    columns + tobacco backfill; `isTobacco` kept as shadow column). Adversarially reviewed → GO. Tobacco seed
    `requiresLicense=false`. Post-deploy smoke green.
  - **chunk-2 (B2 manager + W3 tax calc) — SHIPPED & DEPLOYED** (PR #131, master `9e9bd1e`). B2 = category
    manager UI (create/edit/toggle/assign) on the W2 API. W3 = `computeCategoryTax` pure fn in all 3
    pricing.ts mirrors (per-unit = rate×unitBasisQty; caller converts basis; PER_VOLUME needs true volume;
    sign-preserving). Money review GO (fixed a PER_VOLUME 16× undercharge). 30 pricing specs. Smoke green.
    NOTE: chunk-2 deployed on the **local-verify gate** (no CI) — the private repo has no branch protection,
    and rapid visibility-toggling was disabling the repo (see the prod-migration/rebuild memory).
  - **W4 (invoice split-by-category) — CORE SHIPPED** (branch `feat/regulated-w4-invoice-split`).
    `createInvoiceFromOrder`/`WithTenant` now return `Invoice[]`; a mixed order splits into a standard
    invoice + one per `SEPARATE_INVOICE` category (siblings share `invoiceGroupId`, numbered base/-R1/-R2);
    single-group orders are byte-identical to pre-W4. Proportional regular tax with the LARGEST group
    absorbing the rounding remainder (Σ sibling tax == single-invoice tax exactly; money review GO after
    fixing a `/invoices/undefined` blocker + a 3-group negative-tax bug). **Interim guard throws if a
    category has `rate>0`** (category tax not yet in the order total; tobacco is rate=0). OrderItem
    category snapshot at `create()`. 25 invoice specs + snapshot; verify 18/18.
  - **W4 DEFERRED follow-ups (do before/with W5–W7):** `completeStop` route-delivery split (delivered-via-route
    orders still single-invoice), multi-draft `reconcileOrderDraftInvoice`, **order-total category-tax
    inclusion (lifts the rate>0 guard — needed before any non-zero category rate)**, PER_VOLUME volume-per-piece
    source, products create/update DTO `trackedCategoryId` wiring (today only tobacco backfill + W2 bulk-assign
    set it), credit-note/return sibling-aware reversal. Then W5 (ledger+filings), W6 (license guard), W7.
  - **Also deferred:** product-form category picker + scope selector.
  - **W2 shadow-decoupling (deliberate):** `products.service` still writes only `isTobacco`; the new
    `tracked-categories` assign endpoint sets only `trackedCategoryId`. They are intentionally NOT synced
    this release, so tobacco reports (read `isTobacco`) are untouched. Consequence: a tobacco product
    created after the W1 backfill has `isTobacco=true` but `trackedCategoryId=null`, so it shows in tobacco
    reports but NOT in the Regulated Items hub's "Regulated Products" count (which sums assigned categories).
    The hub count reflects **backfilled + B2-assigned** products only — B2 makes product↔category assignment
    first-class and closes the gap. Do NOT treat the two counts as authoritative for each other until then.
- Phases 5–10: not started (several are major feature builds, not reskins — buyer portal, messaging,
  plans/billing, migration/import).

## 2. DO NEXT (in order)

Everything through **Phase 3 + the boxed-line money remediation is SHIPPED & DEPLOYED** (#121–#125, #128).
Next up:

1. **(Optional) Phase-3 visual pass** on the `test` tenant — the reskinned finance screens (invoices list,
   payment receipt, bills-hub + PO tab, vendor-bill detail) were reviewed + CI-green but not eyeballed post
   deploy (the operator session had been replaced by a buyer login). Log into the operator app (`test` →
   Continue with Google) and spot-check vs `unified/*.html`; fix any drift.
2. **Phase 4 (Regulated items) — the big one.** Follow **`PHASE-4-PLAN.md`**. **W1 (schema) is BUILT on
   `feat/regulated-items-w1-schema` — pending your approval to apply migration `20260706120000_regulated_items_foundation`
   to prod, then merge/deploy.** After that: **W2** (CRUD)
   + **B1** reskins. **W3** (category tax calc) and **W4** (invoice-split-by-category) are the widest money
   change in the codebase — do them in **separate, pair-programmed sessions with adversarial money review**
   and don't release until `06-critical-paths.spec.ts` money invariants pass. W5 (ledger+filings), W6 (auth
   guard, atomic, own session), W7 (expiry/POD/buyer-gate) after. Every migration needs user approval
   (auto-mode classifier blocks the prod write) + the **db-migration** + **rebuild** skills.
3. **Phases 5–10** — several are major feature builds (buyer portal, messaging, plans/billing,
   migration/import), not reskins. Scope each with a gap-analysis Workflow first (as done for Phases 3/4).

**Cadence (confirmed with user):** build + verify + adversarially review every batch; **deploy per phase**
(group a phase's verified batches, check in before each deploy); money/compliance paths get the full
adversarial money-review + E2E money-invariant gate before deploy. **Skip screens where the current app
already beats the mockup** (don't 1:1-match at the cost of UX). Plan: `IMPLEMENTATION-PLAN.md` + `PHASE-4-PLAN.md`;
design `project/unified/*.html` + `project/specs/*.md`; endpoints `project/specs/backend-wiring-index.md`.

## 3. E2E CI status — RESOLVED & CONFIRMED GREEN ON MASTER

**As of #121's merge (2026-07-06) the CI `E2E (Playwright)` job runs GREEN on master** alongside
Lint / Type Check / Test. History below for reference.

The CI **E2E (Playwright)** job had been red. Root cause: the **Phase-1 login reskin** changed the
login page but the e2e selectors weren't updated. `auth.setup` itself passes (it already used
`getByLabel`); individual tests broke. Fixed on `feat/last-cost-costing`:

- `getByPlaceholder("Enter your username")` → `getByLabel("Username or email")` in
  `apps/web/e2e/helpers/auth.ts` (`loginAsOperator`/`loginAsCustomer`) and `02-operator.spec.ts`
  OP-02. (Placeholder is now `you@company.com`; label is `Username or email`.)
- OP-01 asserted `locator("h1")` which resolves to the reskin's `lg:hidden` mobile `<h1>` (hidden on
  the desktop viewport → `toBeVisible … 'hidden'`); now asserts the visible **Sign in** button.

**RESOLVED — the E2E suite is now 70/0** (local read-only run vs prod). After the login-selector
fixes it was 64/6; the 6 (none of them the reskin) were then all fixed:

- **OP-07 / BY-07** (DATA): made data-agnostic — OP-07 asserts a no-match search shrinks the loaded
  list; BY-07 opens the first available customer (no dependency on a seeded "harbor" customer). So the
  CI e2e job's missing `DATABASE_URL` / failing seed no longer matters.
- **CP-04 / CP-05**: `apiBase(page.url())` kept the page PATH → the call hit `.../invoices/api/v1/...`
  (404). Fixed to use `new URL().origin`.
- **CC-05**: the controller doc claimed "read-only" but impersonation has FULL WRITE access by design
  (writes are audit-logged — `platform-admin.service`). The test asserted a non-existent 403; now it
  verifies the token grants tenant-scoped access via a non-mutating read. Also fixed the stale doc string.
- **CP-03**: a skeleton-row race (invoice rows navigate via onClick; loading skeleton `<tr>`s don't) —
  now targets a row carrying a `$` amount.

Re-verify anytime: `cd apps/web && SKIP_E2E_SEED=true PLAYWRIGHT_TENANT_SLUG=e2e-routeflow npx playwright test`.

## 4. Verify / DB safety / cadence

- Verify authed screens on the LIVE app: `www.routeflow.info/login` → Workspace **`test`** →
  Continue with Google (`najathakram1@gmail.com`; NEVER type a password). Verify new UI post-deploy
  on the `test` tenant. Local Docker DB is partial (missing Tenant) → authed local runtime not
  viable. Prod DB read-only via the Railway public proxy + local docker psql.
- **DB SAFETY (hard rule):** never damage prod data. Migrations additive only (new table / nullable
  column / enum `ADD VALUE`; never drop/rename/truncate). Apply prod migrations only via the public
  proxy / `railway run`, and only with the user's approval; the auto-mode classifier blocks the
  prod-write command (user runs it or adds a Bash allow-rule).
- **CADENCE:** one branch per batch; verify each (typecheck + lint + unit + compile); PR per batch;
  deploy via the **rebuild** skill when the user approves. **Adversarially review before each deploy
  with the Workflow tool** (the money-path review on #121 caught 2 HIGH cost bugs — always do this
  for money paths). Don't break anything that works.
- CI: the **code gates (Lint / Type Check / Test)** are the merge signal; the E2E job is being fixed
  (§3). Repo is private ($0 Actions budget) → the rebuild skill makes it public → merge → CI →
  private. Railway auto-deploys the CHANGED service from master.

## 5. Key facts

- Prod: web `www.routeflow.info`; API `routeflowapi-production.up.railway.app`; web service
  `routeflowweb-production.up.railway.app`. Tenants: `test` (Google `najathakram1@gmail.com`), owner
  `affa`/`affa_admin`, e2e `e2e-routeflow` (operator `admin`/`Admin@123`, super-admin
  `najathakram`/`Najath123!`).
- Railway CLI is authed + linked to `@routeflow/api`. Public PG proxy `gondola.proxy.rlwy.net:41006`
  (creds from `railway variables --service postgres --json`; build
  `postgresql://<POSTGRES_USER>:<enc(POSTGRES_PASSWORD)>@<RAILWAY_TCP_PROXY_DOMAIN>:<RAILWAY_TCP_PROXY_PORT>/<POSTGRES_DB>`).
- Money math mirrors: `apps/{api/src/common,web/lib,mobile/lib}/pricing.ts` — keep all three in sync.
- Post-deploy API smoke: `SMOKE_BASE_URL=https://routeflowapi-production.up.railway.app
  SMOKE_TENANT_SLUG=e2e-routeflow npm run post-deploy-check`.

---
