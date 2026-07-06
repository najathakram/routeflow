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
- Phase 2 (Operator core) — IN PROGRESS:
  - §1 negotiation-floor core: SHIPPED (#117/#118).
  - §2 minimize/resume drafts: SHIPPED + live-verified (#119).
  - §1 cost-history popover + shared-MarginHint dedup + analytics method label: SHIPPED (#120).
  - §1(b) **LAST_COST**: DONE + adversarial-review-clean on **PR #121** (branch
    `feat/last-cost-costing`), **NOT deployed** — its additive migration
    `20260706040000_add_costing_last_cost` is the ONLY pending prod migration.
  - **E2E CI selector fixes** (login reskin) — on `feat/last-cost-costing` (see §3).
- Phases 3–10: not started.

## 2. DO NEXT (in order)

1. **DEPLOY PR #121 (LAST_COST)** — money path. FIRST apply the migration to prod: from `apps/api`
   build `DATABASE_URL` from the Railway public proxy `gondola.proxy.rlwy.net:41006` (creds via
   `railway variables --service postgres --json`), then `npx prisma migrate deploy`; confirm
   `migrate status` = up to date. The auto-mode classifier BLOCKS the prod-write — the user runs it
   or grants a Bash allow-rule. THEN the **rebuild** routine (verify → public → merge → CI → private
   → post-deploy-check).
2. Finish/verify the **E2E CI fix** (§3), commit, land it (folded into #121 or its own PR).
3. **§1(a) invoices/new margin hint — BLOCKED**: `apps/web/app/(dashboard)/invoices/new/page.tsx`
   has an ambiguous boxed `unitPrice` (qty is total pieces and `lineTotal = qty×unitPrice`, yet the
   `/pc` display divides `unitPrice` by `unitsPerBox` — per-box vs per-piece disagree). A margin hint
   on that model would show a WRONG margin. Pin down / fix that box model first, then add the hint.
4. **Ledger-reskin the 10 operator-core screens** 1:1 vs `unified/*.html` (dashboard, orders
   list/detail, customers, customer-detail, products, product-detail, inventory-hub, dispatch,
   returns). Tokens already match from Phase 1; this is structural/column/copy deltas.
5. **§3** at-the-door actions; **§4** full drive-mode field layout. Then **phases 3 (Finance) → 10
   (Mobile)**.
6. **§1 deferred (QUESTIONS.md #10):** propagate the tenant `costing.method` to NEW products at
   creation (cross-module wiring). Existing products are never re-costed.

## 3. E2E CI status (worked on this session)

The CI **E2E (Playwright)** job has been red. Root cause: the **Phase-1 login reskin** changed the
login page but the e2e selectors weren't updated. `auth.setup` itself passes (it already used
`getByLabel`); individual tests broke. Fixed on `feat/last-cost-costing`:

- `getByPlaceholder("Enter your username")` → `getByLabel("Username or email")` in
  `apps/web/e2e/helpers/auth.ts` (`loginAsOperator`/`loginAsCustomer`) and `02-operator.spec.ts`
  OP-02. (Placeholder is now `you@company.com`; label is `Username or email`.)
- OP-01 asserted `locator("h1")` which resolves to the reskin's `lg:hidden` mobile `<h1>` (hidden on
  the desktop viewport → `toBeVisible … 'hidden'`); now asserts the visible **Sign in** button.

Also made OP-02 robust (assert "not on /dashboard" + login form still visible, instead of matching
exact error copy). **A local read-only run against prod after these fixes: 64 passed, 6 failed**
(was the whole auth-dependent suite failing). Verify anytime with:
`cd apps/web && SKIP_E2E_SEED=true PLAYWRIGHT_TENANT_SLUG=e2e-routeflow npx playwright test`.

The **6 remaining failures are NOT the reskin regression** — they are pre-existing data/behavior
issues to pick up next:

- **OP-07** + **BY-07** — DATA: both need a "harbor" customer in `e2e-routeflow` (`getByText(/harbor/i)`
  not found). The CI e2e job sets **no `DATABASE_URL`**, so its global seed (`apps/api/scripts/e2e-seed.js`)
  fails (non-fatal) and never refreshes the tenant. Fix by re-seeding the DEDICATED `e2e-routeflow`
  tenant (run `e2e-seed.js` against prod via the proxy — a controlled write to a test-only tenant),
  or make the tests robust to whatever customers exist. (BY-07 also hit a 30s login timeout once —
  possibly Railway latency; re-check after seeding.)
- **CP-04 / CP-05** — the invoices/orders API call returns `res.ok() === false` (NOT a float-artifact
  assertion — the request itself fails). Investigate the token/tenant the test sends
  (`apiBase(page.url())` + operator token + `x-tenant-slug: e2e-routeflow`) vs what the API expects;
  this predates the reskin.
- **CC-05** — impersonation POST expected `403`, got something else. Confirm the API's read-only
  impersonation guard status code vs the test's expectation.

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
