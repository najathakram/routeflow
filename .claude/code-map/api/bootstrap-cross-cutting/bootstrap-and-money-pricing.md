# api — Bootstrap & cross-cutting — app bootstrap, common providers & money/pricing

> Split from [`../bootstrap-cross-cutting.md`](../bootstrap-cross-cutting.md) (verbatim, lines 568-745 of the pre-split file) on 2026-09-15. See [`../../INDEX.md`](../../INDEX.md).

## Bootstrap & cross-cutting

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
  (41 enums, incl. `RETURN_KIND_VALUES`→`ReturnKind` and `CHECK_RETURN_REASON_VALUES`→
  `CheckReturnReason`, both new rows landed 2026-09-15); the import is guarded (`require` in
  try/catch) so a missing/renamed export fails on
  its own value, not a suite-crashing "Cannot find module". A second `describe` block reads the raw
  source text of the specific web/mobile files that drifted (`VendorBillStatus`, `POStatus`→
  `PurchaseOrderStatus`, `BuyerPromotion.type`→`PromotionType`, `EstimateStatus` on both apps) and
  asserts they no longer hand-declare a conflicting literal union — the permanent regression guard
  for L-072. ⚠️ `ENUM_TABLE` is a deliberate SUBSET (only the enums a client actually
  mirrors), so an equality assertion against the generated set would be WRONG; the close-out review
  (2026-09-05) added a third `describe` that pins the COUNT instead —
  `Object.keys(PrismaEnums.$Enums).length === PINNED_PRISMA_ENUM_COUNT` (86, was 84 — 2026-09-15
  triage: `CheckReturnReason` + `ReturnKind`, both new enums mirrored the same PR, unlike
  `PaymentStatus`/`NotificationEvent` gaining a value on an already-tracked enum, which never
  moves this count) — as a triage
  tripwire: a new/removed generated enum must be triaged into `ENUM_TABLE` (or deliberately left
  unmirrored) BEFORE the constant is bumped. **2026-09-15 (WP1 T2/T3, lite-L2):** two more
  `describe` blocks — LITE `PLAN_KEYS`(5)/`FLAG_KEYS`(21) parity between
  `billing/plan-catalog.constants.ts` and `@routeflow/types`, and `Prisma.TenantPlan` containing
  `LITE`; plus a migration-shape check that exactly one `*_tenant_plan_lite` migration dir exists
  and its SQL is the exact additive `ALTER TYPE "TenantPlan" ADD VALUE 'LITE';` (no DROP/RENAME/
  ALTER COLUMN). Also pins the mobile `@routeflow/types` stub's hand-copied `CHECK_TRANSITIONS`
  (unswept by the `*_VALUES` sweep — no `_VALUES` suffix) deep-equal to the canonical
  `packages/types/api/checks.ts` export.
- **`src/common/check-transitions.ts`** (post-dated check payments PR-1, 2026-09-15) — API-local
  mirror of the check-lifecycle forward-transition table (`CHECK_TRANSITIONS: Record<CheckStatus,
readonly CheckStatus[]>` — RECORDED→[DEPOSITED,BOUNCED], DEPOSITED→[CLEARED,BOUNCED],
  CLEARED→[BOUNCED], BOUNCED→[]). Canonical copy is `packages/types/api/checks.ts`
  (`@routeflow/types`, value-imported directly by web/mobile — both transpile workspace TS at
  build time); the API can't value-import that raw-TS package at runtime (see
  `no-runtime-workspace-imports.spec.ts`) so it keeps this hand-copy instead, same convention as
  `common/trip-grouping.ts`/`shipping.ts`. V1 ONLY — no `CHECK_TRANSITIONS_V2` here. Spec:
  `check-transitions-parity.spec.ts` — pins this mirror deep-equal to the canonical export, and
  reads each of the three historical hand-duplicated call sites' CURRENT source
  (`invoices.service.ts`, web's invoice detail page, mobile's `payments-logic.ts`) to assert none
  still hand-declares a local `CHECK_TRANSITIONS`/`CheckStatus` (L-072-class regression guard).
- **`src/common/plan-flag-guard-module-import.spec.ts`** (WP5a/5b/5c, 2026-09-15) — pure-metadata
  check (no Nest app boot): every module whose controller applies `@UseGuards(PlanFlagGuard)`
  (`EstimatesModule`/`RecurringInvoicesModule`/`CreditNotesModule`/`SuppliersModule`/
  `MessagesModule`/`CustomersModule`) must list `EntitlementsModule` in its own `imports` —
  `PlanFlagGuard` is only provided/exported there, so a missing import is a DI-resolution boot
  crash that this catches at unit-test time instead of `nest build`/boot. **`tsconfig.plan-gate-
specs.json`** (`apps/api/`, sibling build config) — extends `tsconfig.json`, `include`-only the
  six `*.plan-gate.spec.ts` files across billing/customers/credit-notes/messages/
  recurring-invoices/suppliers/estimates (no `exclude`) — a dedicated tsc project for that one
  spec-file family; see each module's own spec for its individual plan-gate behavior.
- **`schema-folder.spec.ts`** (2026-09-04, wave E / imp-10a, T1; cases (g)/(h) reworked
  wave E structure; case (h) RETIRED 2026-09-11)** — pins `prisma/schema/` to exactly the 7 domain
  files, 128 model + 86 enum blocks (215 total; pinned literals, bumped in the same PR as a real
  model/enum add — 2026-09-15 +2 enums: `CheckReturnReason` (post-dated check payments PR-1),
  `ReturnKind` (Returns Inside Order Creation PR-1a)),
  `_base.prisma` holding only datasource+generator, every model/enum name unique,
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
