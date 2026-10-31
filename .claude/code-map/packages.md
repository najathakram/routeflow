# Area: packages (`packages/*`)

Shared workspace packages (types, UI, configs) consumed by apps via npm workspaces.

## Where to find (this area)

| Need                                                                                                       | File → symbol                                                              |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Money math (line totals, tax, promos, tiers)                                                               | `packages/pricing/src/` → `pricing.ts`, `tier-pricing.ts`                  |
| Payment-confirmation predicate (B421 cash/credit/advance split)                                            | `packages/pricing/src/payment-confirmation.ts`                             |
| Held/capacity money (PR-1: PENDING, HELD_STATUSES, remainingCapacity)                                      | `packages/pricing/src/payment-confirmation.ts`                             |
| Check-lifecycle transition table (`CHECK_TRANSITIONS`, canonical; web/mobile import it directly)           | `packages/types/api/checks.ts`                                             |
| Check-lifecycle transition table, API-local copy (`setCheckStatus` imports THIS, never `@routeflow/types`) | `apps/api/src/common/check-transitions.ts`                                 |
| Enums (UserRole, OrderStatus, ...)                                                                         | `packages/types/index.ts` → `export enum X`                                |
| Type interfaces (User, Order, PaginatedResponse)                                                           | `packages/types/index.ts` → `export interface X`                           |
| Web components (Button, Table, Modal, ...)                                                                 | `packages/ui/src/web/` → `index.ts` barrel                                 |
| Mobile RN components                                                                                       | `packages/ui/src/mobile/index.ts`                                          |
| iOS-specific components                                                                                    | `packages/ui/src/mobile/ios/index.ts`                                      |
| Design tokens (colors, spacing, fonts)                                                                     | `packages/ui/src/tokens.ts`                                                |
| ESLint flat presets                                                                                        | `packages/eslint-config/` → base.js, next.js, react-internal.js            |
| TypeScript presets                                                                                         | `packages/typescript-config/` → base.json, nextjs.json, react-library.json |

## Packages

### `@routeflow/types` (`packages/types`)

Shared DTO/enum definitions. Entry: `index.ts` (no `src/`), re-exports `./api/*` (below) via
`export * from "./api/<domain>"`.

- **`api/enums.ts` (2026-09-03, wave E / imp-10b)** — one `export const X_VALUES = [...] as const` +
  `export type X = (typeof X_VALUES)[number]` per Prisma enum a web/mobile `lib/api/*` file mirrors
  as a hand-typed string union (40 enums; values copied from `apps/api/prisma/schema.prisma`).
  **`TENANT_CLASS_VALUES`/`TenantClass` added (2026-09-15, PR #743 fix round, T1 in progress)** —
  same pattern, pinned set-equal to `@prisma/client`'s `TenantClass` by
  `apps/api/src/common/enum-parity.spec.ts`. `PLAN_KEYS`/`PlanKey` (same file, same round) is
  NOT a Prisma-enum mirror — it's pinned to the four non-legacy `TenantPlan` members instead,
  re-exported by `apps/api/src/billing/plan-catalog.constants.ts` rather than hand-declared there.
  Pinned set-equal to `@prisma/client`'s generated enum by
  `apps/api/src/common/enum-parity.spec.ts` — this is the guard against the drift class that shipped
  three real bugs (see `L-072`): `VendorBillStatus` mirrors had invented `"FULL"`/omitted
  `OVERDUE`, `PurchaseOrderStatus` (mobile local name `POStatus`) had `"PARTIALLY_RECEIVED"` instead
  of `PARTIAL`, `PromotionType` (`BuyerPromotion.type`) omitted `"BUY_N_GET_M"`; plus a sibling-sweep
  find, a phantom `"EXPIRED"` on `EstimateStatus` in both apps.
- **F27 (2026-09-13, aa47ee9e)** — `api/misc.ts` `Estimate` gains `issueDate?: string | null` (operator-picked issue date; null on legacy rows — consumers fall back to `createdAt`). `EstimateItem`/`EstimateStatus` unchanged.
- **2026-09-19:** `api/products.ts` `RecomputeCostsResult` gains `gapsDetected: {productId,name,stockDrift}[]` (B562 — a sales-blind replay is refused, not corrected, for these products; see `feature-modules-4/inventory.md`). `api/features.ts` `FeatureRegistryRow` gains `requires?: {allOf?, anyOf?}` (B519 — feeds web's local unmet-requirement warning, mirrors `apps/api/src/billing/feature-registry.ts`'s server shape).
- **#936 schema-spine shared contracts (2026-09-19)** — `api/products.ts` gains `ProductUnitLevel`, `PutProductUnitsPayload`, `ProductLabelRef`/`ProductLabelsView` (`own`/`inherited`/`excluded`/`effective`), `PutProductLabelsPayload`, `ProductCategoryDto`. `api/orders.ts` gains `UNIT_LABEL_PIECE` + `UnitAwareLineInput`. New `api/restrictions.ts` (re-exported from `index.ts`) — `GoverningAddressSource`, `RestrictionsPolicy`, `RestrictionReason`, `BlockedLine`, `SellingRestrictedError`, `SellingRestrictionDto`, `RestrictedProductChip`. New `api/us-states.ts` (also re-exported) — `US_STATES` (50+DC+4 territories) + `normalizeUsState()`. `api/enums.ts` gains `LABEL_MODE_VALUES`/`RESTRICTION_JURISDICTION_VALUES`/`RESTRICTION_SURFACE_VALUES`, pinned set-equal to the new Prisma enums by `enum-parity.spec.ts`. Schema detail: `api/bootstrap-cross-cutting/prisma-schema-and-seeds.md`'s #936 entry.
- **`api/{orders,customers,products,finance,returns,regulated,routes,buyer,misc}.ts` (2026-09-03,
  wave E / imp-10b)** — the 95 identical/near-identical request/response DTOs the sweep
  (`.claude/pipeline/wave-E-structure/2026-09-03-imp-10b-shared-dtos/sweep.md`) found duplicated
  byte-for-byte or near-byte-for-byte across `apps/web/lib/api/*` and `apps/mobile/lib/api/*` (134
  cross-app duplicate names total: 49 identical, 46 near-identical, 39 genuinely divergent — the
  divergent 39 stay local, listed in the PR body). Near-identical resolution rule: union of optional
  fields (present-on-one-side ⇒ optional), nullable widening wins, named unions replace inline
  literals, comments kept from the richer side. Both apps' `lib/api/*.ts` import these instead of
  redeclaring, rewritten by `scripts/codemods/shared-dto-rewrite.mjs` (`--check`/`--write`, manifest-
  driven, idempotent). A few names collided or diverged **within** one app and were renamed apart
  rather than shared: web `OrderTemplate` (buyer.ts) → `BuyerOrderTemplate`; mobile
  `SalesByCustomerRow`/`SalesByItemRow` (reports.ts) → `ReportSalesByCustomerRow`/`ReportSalesByItemRow`;
  mobile `VariantAssignResultRow` → shared `VariantAssignResultItem`; mobile
  `SupplierAllocationRow` → aliased to shared `SupplierAllocationLine`. `BuyerPromotion` itself
  (previously sweep-classified divergent solely because of the `type` enum drift) is now shared once
  `type`/`scope` are typed from `enums.ts`. Intra-app dedup per R2: web `PriceType` (was declared
  identically in both `orders.ts` and `invoices.ts`); mobile `ChangeRequestType`/`ChangeRequestStatus`
  (collapsed into `change-requests.ts`, re-exported from `@routeflow/types`; `ChangeRequestResolution`
  and the richer buyer-facing `ChangeRequest` interface stay local — NOT deduped, a real divergence
  the sweep undercounted).
- **`api/returns.ts` — F08 (2026-09-06, #645):** `CreateReturnItemDto` gains optional `condition?:
string` (B20 — free-form intake note, e.g. "DAMAGED_BOX") and its `restock?` doc comment is
  corrected ("defaults from the reason" — B61 — not the old "default true"). No `deliveredQty` field
  was added — that composition (B53×B128) was ruled OUT of this wave; see api.md's returns/ F08 entry
  and registry row B220.
- **`api/routes.ts` — F12 (2026-09-06/07, #652):** `StopETA` gains optional `waitMinutes?: number`
  (minutes the vehicle waits when it arrives before a window opens — present only when there was a
  wait). The richer, optimize-response-only fields (`OptimizeResult.windowViolations`/`startTime`/
  `windowsChecked`, `RouteVariant.windowViolations`, the `WindowViolation` shape itself) are NOT
  here — they live only in web's own `lib/api/routes.ts` (not shared with mobile, which does not
  consume the window signal — see api.md's F12 bullet and registry row B226).
- **`api/invoices.ts` (NEW, F16 2026-09-07, #656)** — `InvoiceKpiSummary` (the invoices page's six
  KPI tiles: `totalOutstanding/overdue/dueToday/dueIn30/avgDays/awaitingConfirmationCount`), the
  response shape of the new `GET /invoices/kpi-summary?today=` endpoint (B12) — replaces the old
  `useInvoices({ limit: 999 })` fetch-all-then-reduce, which silently dropped any tenant with more
  than 999 invoices. Re-exported from `index.ts`.
- **`api/buyer.ts` — F16 (2026-09-07, #656):** `BuyerStatement` gains `lifetimeInvoiced`/
  `lifetimeReceived` (DB-side aggregates over the whole invoice/payment history, never a reduce
  over the capped `transactions` ledger) and `transactionsTruncated: boolean` (true when that
  ledger read hit its own `take` cap) — B110. Mirrored by `apps/mobile/lib/api/customers.ts`
  `CustomerStatement`/`AccountSummary` (not shared — mobile predates the shared-DTO sweep for this
  file) and `apps/web/lib/api/customers.ts` `CustomerStatement`.
- **`api/checks.ts` (NEW, post-dated check payments PR-1, 2026-09-15)** — the ONE canonical
  `CHECK_TRANSITIONS` (check-lifecycle forward-transition map) + re-exported `CheckStatus` type,
  replacing three byte-identical hand-written mirrors (api `invoices.service.ts`, web
  `invoices/[id]/page.tsx`, mobile `payments-logic.ts` — the last also dropped its own local
  `CheckStatus` type). V1 ONLY by design (independent Opus review, binding) — do not add
  `CHECK_TRANSITIONS_V2` here; that's a later PR's `CheckTransitionService`. Web and mobile
  value-import this file directly (both transpile workspace TS at build time). The API CANNOT —
  `no-runtime-workspace-imports.spec.ts` fails a value import of `@routeflow/types` from any
  compiled api source file (raw-TS package, no build step, crashes `node dist/main.js` at boot;
  this bit for real in the PR-1 fix round — see `apps/api/src/common/check-transitions.ts`'s own
  entry in `api.md`'s bootstrap/cross-cutting area). `invoices.service.ts` imports
  `CHECK_TRANSITIONS` from that API-local mirror instead, and
  `apps/api/src/common/check-transitions-parity.spec.ts` pins the mirror value-equal to THIS
  file's export (deep-equal, not an import-path check) so the two can't silently drift. Mobile's
  Jest `@routeflow/types` stub (`apps/mobile/__tests__/__mocks__/@routeflow/types.js`)
  hand-copies `CHECK_TRANSITIONS` too (a real runtime value, not just a type) — pinned deep-equal
  against this file's export by `apps/api/src/common/enum-parity.spec.ts`'s mobile-stub-parity
  block (X2).
- **`api/enums.ts` — post-dated check payments PR-1 (2026-09-15):** `PAYMENT_STATUS_VALUES`
  gains `"PENDING"`; new `CHECK_RETURN_REASON_VALUES`/`CheckReturnReason` (pinned by
  `enum-parity.spec.ts`'s `ENUM_TABLE`, which bumped `PINNED_PRISMA_ENUM_COUNT` 84→85 for the
  new `CheckReturnReason` Prisma enum — `apps/api/src/common/schema-folder.spec.ts`'s sibling
  `EXPECTED_ENUM_COUNT` tripwire bumped 84→85 too in the PR-1 fix round, initially missed).
  `NotificationEvent` gains `CHECK_RETURNED` (no shared
  mirror — server-only, consumed via `@prisma/client` directly in
  `apps/api/src/messaging/messaging-config.service.ts`'s `EVENT_CHANNELS`/`DEFAULT_TEMPLATES`
  (exhaustiveness entries only, `[INTERNAL]`) and `NO_TRIGGER_EVENTS` — no firing site yet, so it
  is deliberately NOT added to `DEFAULT_ON`).
- **Enums** (synced with Prisma): `UserRole`, `UserStatus`; `OrderStatus`, `ItemStatus`;
  `RouteRunStatus`, `RouteRunStopStatus`; `TxnStatus`, `PaymentMethod` (2026-08-21: backfilled
  from a stale 4 values to all 8 — `CASH,CHECK,ACH,OTHER,CREDIT_NOTE,ADVANCE,CREDIT_CARD,ZELLE`
  — matching Prisma; note the apps do NOT import it, they use their own
  `{web,mobile}/lib/payment-methods.ts` constants); `MutationType`,
  `FulfillPath`, `DriverStatus`, **`RouteKind`** (2026-08-24: `SCHEDULED | ADHOC`, string values,
  synced with the Prisma `Route.kind` enum added for ad-hoc order trips).
- **Interfaces**: `User`, `Order`, `PaginatedResponse<T>` (data + meta: total/page/limit/totalPages),
  `ApiResponse<T>`.
- **Constants**: `DEVELOPER_MODE_ADDON = "developer_mode"` (2026-08-20, **narrowed 2026-08-28**) —
  the legacy `TenantAddon.addonKey` for the hidden platform-admin flag. It now unlocks ONLY
  genuinely in-development surfaces (the mobile `(driver)` app, the mobile role-picker driver
  option, the mobile `(tenant)` dispatch tab) and **no longer unlocks the two GA delivery addons
  in any client UI**; the dispatch API accepts it as an any-of `@RequireAddon` key purely so dev
  tenants can drive those in-dev surfaces end-to-end. Lives here so web (`apps/web/lib/api/addons.ts`,
  the admin tenant page), mobile (`apps/mobile/lib/api/addons.ts`) and api
  (`plan-catalog.constants.ts`'s pending bridge note) share one string; the only inlined copies are
  in plain-node scripts that can't import TS (`scripts/enable-developer-mode.mjs`,
  `apps/api/scripts/e2e-seed.js`) and — deliberately, per the no-runtime-workspace-imports rule —
  in API source (`addon.guard.ts`'s `INTERNAL_ADDON_KEYS`, the five dispatch controllers).
  **`RECURRING_ROUTES_ADDON = "recurring_routes"` / `ORDER_DELIVERY_ADDON = "order_delivery"`**
  (2026-08-25, owner decision) — split the dispatch/route surface into two independent per-tenant
  addons (standing routes vs. ad-hoc order-delivery trips). Consumed by web/mobile
  `lib/api/addons.ts`'s `useRecurringRoutes()`/`useOrderDelivery()` + the
  `useRoutesAccess()`/`useDeliveryAccess()` composition hooks (**the feature addon alone since
  2026-08-28** — the `devMode || <feature>` OR was removed), and by `admin/tenants/[id]`
  `AVAILABLE_ADDONS`. **The exported VALUES are unchanged** — the 2026-08-28 edit to this file was
  doc comments only.
  **`OCR_ADDON = "ocr"`** doc comment updated 2026-09-04 (value unchanged) to point at
  `apps/api/src/billing/addon-gate-registry.ts` as the source of truth for the gate's rollout
  state (currently `dark` — allow + would-deny warn, no 403 — until the owner runs the blast-radius
  report and flips it).

- **`pack-size.ts` (2026-08-20) — the ONE shared pack-size name parser.** Exports `parsePackSizeDetailed(name)`, `suggestPackSize({name, unit, unitSku, unitsPerBox})` → `{packSize, counts, confidence, reason}`, and `formatCountList(counts)` (`"5 or 12"`, `"4, 8 or 16"` — shared so no surface hardcodes "two"; a name can state three counts) with `confidence: HIGH | MEDIUM | LOW | AMBIGUOUS | PIECE_UNIT | null`. Lives here — **NOT** mirrored into `apps/*/lib` — precisely because all three apps already consume `@routeflow/types`, and a parser whose value is its refusal rules is the worst possible thing to keep hand-synced copies of (contrast money math, which used to be a
  deliberate triple mirror and is now the single compiled `@routeflow/pricing` package, above).
  - ⚠️ **It must keep REFUSING to guess.** `packSize` is returned only when exactly ONE distinct count survives; two or more ⇒ `null` + `AMBIGUOUS` ("…5CT - 12Pack" is 12 packs of 5 — guessing mis-prices every loose sale of that product forever, which is far worse than asking). A `PIECE_UNIT` unit (`pcs`/`each`/`bottle`/`can`/`stick`…) NEVER gets a proposal: the count in such a name describes the case the row was broken out of, and setting a pack size there divides a piece price by the pack and undercharges by that factor.
  - Parse order is load-bearing: `N/<measure>` (e.g. "12/1.93OZ") is read FIRST, then measurements are stripped so "5 HOUR"/"65MG" cannot read as counts, then `N CT|PK|PACK|COUNT|PCS`. Counts kept only when `> 1` and `<= 1000`.
  - **`packages/types` has no Jest runner** (its test script is `tsc --noEmit`), so the specs live at `apps/api/src/common/pack-size.spec.ts`. Put new cases there or they silently never run.
  - `apps/api/scripts/propose-pack-sizes.mjs` holds a MIRROR of this logic (plain node can't import TS) and is labelled as such — canonical behaviour is here.

- **`trip-grouping.ts` (2026-08-24) — the ONE grouping algorithm for ad-hoc order trips.** Pure,
  no imports beyond its own file. Exports `TripGroupableOrder`/`TripStopGroup`/`TripSkippedOrder`/
  `TripGroupingResult` + `groupOrdersForTrip(orders)`: groups by `customerId` into one stop per
  distinct customer (orders with no `customerId` land in `skipped[]` with reason `NO_CUSTOMER`).
  Re-exported from `index.ts` (`export * from "./trip-grouping"`). **Mirrored byte-for-byte**
  (not imported) at `apps/api/src/common/trip-grouping.ts` — the API must never `require` this
  package at runtime, since `main: "./index.ts"` is raw TS with no build step and `nest build`
  emits the bare `require("@routeflow/types")` into `dist/`, crashing `node dist/main.js` at
  startup (guard spec: `apps/api/src/common/no-runtime-workspace-imports.spec.ts`) — and at
  `apps/mobile/lib/trip-grouping.ts` (RN apps don't consume this package's TS source at the same
  build boundary), with its own Jest test on the mobile side. Only web imports it directly, via
  `transpilePackages`. Change all three copies together.
- **Lite-L2 (WP1/WP4, 2026-09-15) — `PLAN_KEYS` gains `"LITE"`, leading the array** (`api/enums.ts`)
  — `PLAN_KEYS = ["LITE", "STARTER", "GROWTH", "SCALE", "ENTERPRISE"]`; an order pin, not
  hardcoded indices, since `apps/api/src/billing/plan-catalog.constants.ts`'s `planRank()` derives
  rank from `indexOf`. Kept set-equal to the API's own `PLAN_KEYS` (same file) by
  `apps/api/src/common/enum-parity.spec.ts` (REG-743-F4).
- **`api/billing.ts` (new file, WP1)** — `FLAG_KEYS` (21 flag/addon-key strings, mirrors
  `plan-catalog.constants.ts`'s `FLAG_KEYS` — the API can't value-import this package at
  runtime, see the trip-grouping note above, so it hand-mirrors the list; pinned set-equal by
  `enum-parity.spec.ts`'s WP1 T2) + `type FlagKey`, and `SubscriptionView<TDate = string>` — the
  shared shape for `GET /billing/subscription`'s response (14 fields incl. `flags?: string[]` —
  OPTIONAL as of Lite-L2 fix-round finding 5, 2026-09-15: an old API build can omit `flags`
  entirely during a deploy skew/rollback, and every reader must treat `undefined` as "unresolved,
  fail OPEN" (never gate/hide), distinct from `flags: []` ("resolved, no grants" — gate for
  real). Fixed in web (`app/(dashboard)/layout.tsx`'s RouteGuard + `filterPlanGatedNav`,
  `lib/api/plan-flags.ts`'s `usePlanFlag`) and mobile (`(operator)/_layout.tsx`,
  `lib/plan-flags.ts`'s `planLockedSection`, `lib/api/billing.ts`'s `usePlanFlag`) — and
  `paymentRequired: boolean`, both WP1 additions, generic over `TDate` so a caller that parses
  dates client-side can write `SubscriptionView<Date>` instead of redeclaring the interface.
  Consumed by `apps/web/lib/api/billing.ts` (`export type { SubscriptionView }`, no longer
  declared there) and `apps/mobile/lib/api/billing.ts`. Re-exported from `index.ts`
  (`export * from "./api/billing"`).
- **`api/features.ts` (new, feature grants v2 brief A, 2026-09-17, #825)** — `FeaturePreviewRequest`
  (`overrides[].kind` is the new `FeatureOverrideKind` enum) + the shadow-resolver's shared
  request/response shapes for the admin preview/diff/effective-features endpoints — see
  [`api/feature-modules-4/billing.md`](api/feature-modules-4/billing.md)'s "Feature grants v2"
  entry for the full story. Re-exported from `index.ts`.
- **`api/enums.ts` — feature grants v2 (2026-09-17, briefs A + B, #825/#838)** —
  `FEATURE_SOURCE_VALUES`/`FeatureSource` (brief A) and `FEATURE_OVERRIDE_KIND_VALUES = ["PILOT",
"SUPPORT", "COMP", "TRIAL", "GRANDFATHER"]`/`FeatureOverrideKind` (brief B) — pinned set-equal to
  the generated Prisma enums by `enum-parity.spec.ts` (L-072, never a hand mirror elsewhere).
  `FeatureOverrideKind` defaults to `COMP` on every existing `TenantFeatureOverride` row
  (migration `20260917000000_feature_grants_v2_shadow_resolver`, additive).

### `@routeflow/pricing` (`packages/pricing`)

> **2026-09-22 additions** — `build-line.ts` (`buildLine`, the strict two-axis line builder,
> PR-1 #1167), `legacy-line-pieces.ts` (`legacyLinePieces` classifier for a boxes-null line,
> #1202) and `po-line.ts` (`buildPOLine`/`derivedCaseCost`; **`resolvePOLineAmounts(...).totalCost`
> is the only PO total — re-deriving it over-charges**, #1199). Signatures in
> [`api/catchup-2026-09-22-units-money.md`](api/catchup-2026-09-22-units-money.md).

**Compiled** workspace package — the ONE copy of RouteFlow money math, replacing the four
`pricing.ts` copies (api `src/common` + `src/utils`, web `lib`, mobile `lib`). Entry `src/index.ts`
→ `pricing.ts` (`computeLineSubtotal`, `normalizeBoxesPieces`, `roundMoney`, `prorateLineSubtotal`,
`applyBestPromotion`/`promotionMatchesProduct`, the zero-price guard, BUY_N_GET_M helpers,
`computeCategoryTax`, `roundUnitCost`, `effectiveQty`, **`formatQtySplit` gains optional
`boxLabel?: string | null` (#936, 2026-09-19) — custom box-unit label, pluralises with a
trailing "s" unless already plural; default "box"/"boxes" unchanged, additive**) + new
**`unit-levels.ts` (#936)** — `resolveUnitPrice({packPrice, packFactor, tierPackPrice, level,
tier})`: an explicit `ProductUnit` tier price wins, else proportional off the pack's own tier-1
ratio, else a straight `factorToBase` ratio — one `roundMoney` at the end (schema for `level`
is `ProductUnit`, see `api/bootstrap-cross-cutting/prisma-schema-and-seeds.md`'s #936 entry;
no API consumes this yet — units API is a stacked follow-on) + `tier-pricing.ts` (`getTierPrice`) +
**`payment-confirmation.ts`** (B421, 2026-09-15 — moved here from an api-local
`invoices/payment-predicates.ts` after independent review flagged the money-discipline
violation of creating new payment-confirmation logic outside this package): `CONFIRMED_STATUS`/
`CREDIT_NOTE_METHOD`/`ADVANCE_METHOD`/`CASH_METHOD_FILTER` (plain string literals — no
`@prisma/client` import, pinned instead by `apps/api/src/invoices/payment-confirmation-parity.spec.ts`,
the one place Prisma is available), `sumConfirmed`/`splitConfirmed` (cash vs. CREDIT_NOTE vs.
ADVANCE), and `resolveConfirmedAmounts(precomputed, payments)` — all-or-nothing on
`precomputed.totalPaid` so a caller supplying some but not all of a precomputed split never gets
it mixed with a freshly re-derived one (lesson L-159). `apps/api/src/invoices/payment-predicates.ts`
is now a thin re-export facade (existing `from "./payment-predicates"` call sites unchanged);
`apps/web/app/(dashboard)/invoices/[id]/page.tsx` imports directly from `@routeflow/pricing`
(its own hand-rolled mirror deleted). Mobile not yet wired — due when that surface is fixed.
**`money-invariants.ts`** (B451, Strix gap 4) — `assertMoneyInvariants({subtotal, discount?, tax?,
shipping?, total})` throws `MoneyInvariantError` (`readonly code: "MONEY_INVARIANT"`) on any
component negative/non-finite, or `discount > subtotal`; own spec `money-invariants.spec.ts`. HTTP
callers wrap it via `apps/api/src/common/money-invariants.util.ts`'s `assertMoneyInvariantsOrThrow`
→ `BadRequestException({code:"MONEY_INVARIANT"})`, never a 500. Consumers: `orders.service.ts`
`create()`/`updateOrderItems`, `estimates.service.ts` `create()`, `vendor-bills.service.ts`
`create()`/`update()` — see `api/feature-modules-2.md`, `api/feature-modules-4/estimates.md`,
`api/feature-modules-4/vendor-bills.md`. `invoices.service.ts` has its own equivalent inline
checks, not yet migrated to this shared guard.
**Ships `dist/` (CJS + `.d.ts`), not source** — `main`/`types` point at `dist`, `package.json`
declares `"build": "tsc -p tsconfig.build.json"`. This is load-bearing, unlike `@routeflow/types`'
raw-TS `main`: the API consumes it at runtime through `nest build`'s emitted `require()`, and a
source-direct package there crashes `node dist/main.js` (`no-runtime-workspace-imports.spec.ts`
now asserts every `@routeflow/*` the API imports resolves to a built `main`). The root
`postinstall` runs `npm run build -w @routeflow/pricing` so every `npm ci` (CI, Docker, local dev)
produces `dist` before anything typechecks. api/web/mobile all import the bare specifier
`@routeflow/pricing` — no relative imports, no mirrors to keep in sync.

- **`payment-confirmation.ts` — post-dated check payments PR-1 (2026-09-15), additive-only:**
  gains `HELD_STATUSES = ["PAID","PENDING"]`/`HELD_PAYMENT`/`isHeldPayment`/`sumHeld` (money
  currently held: confirmed OR a post-dated check on file not yet cleared) and
  `collectedDateOf(p)` (`settledAt ?? paidAt`). **`remainingCapacity(total, payments)`** —
  a capacity GUARD, not a display figure — subtracts every payment with `status !== "VOID"`
  (DRAFT + PAID + PENDING), via an internal `sumNotVoid`, deliberately NEVER `sumHeld`/
  `sumConfirmed`: N4 (independent Opus review, binding, quoted in the function's own doc) ruled
  capacity must keep counting DRAFT (today's `recordPayment`/`updatePayment`/credit-note apply/
  advance apply/mobile edit-cap sites all gate on `status !== VOID`). Nothing in this PR wires
  these into a real call site — that's the design's §3.4 table, later PRs.
  `apps/api/src/invoices/payment-predicates.ts` re-exports all of the above too.
- **PR-2 (check-payments B1 hardening, 2026-09-17, #805) — wires PR-1's `remainingCapacity` into
  the real capacity-guard call sites** (PR-1 wired nothing in). Adds
  `BLOCKING_PAYMENT_STATUSES`/`BLOCKING_PAYMENT`/`isBlockingPayment` to `payment-confirmation.ts` —
  deliberately a THIRD predicate distinct from `isHeldPayment`/`sumConfirmed` (N4 owner ruling: an
  EXISTENCE/blocking check, e.g. "does an external payment still block this cancel", must keep
  counting DRAFT exactly as pre-PR code did; only a money-TOTAL figure may narrow to
  HELD/CONFIRMED). **The pattern in every wired site**: a capacity ceiling
  (`remainingCapacity(total, payments)`, DRAFT-inclusive) bounds how much can be newly applied,
  but the invoice's STATUS recompute afterward stays `sumConfirmed(payments) + applyAmount` (never
  `total − remainingCapacity`, which would be DRAFT-inclusive and could flip an invoice straight
  to PAID off unconfirmed money sitting alongside the new confirmed one). Sites:
  `credit-notes.service.ts` `applyCreditInTx`/`restoreCreditFromPaymentInTx` (both now call
  `remainingCapacity` for the ceiling, `sumConfirmed` for the status recompute — replaces two
  hand-rolled `status !== "VOID"` filters), `customers.service.ts`
  `applyAdvancePaymentToInvoiceLocked` (same pattern; **known gap, not fixed here**: its
  `newPaid` is NOT wrapped in `roundMoney`, unlike credit-notes' — filed as a follow-up),
  `orders.service.ts` cancel-blocker check (pure predicate swap: `p.status !== "VOID"` →
  `isBlockingPayment(p)`, same behavior, clearer name — no transaction threaded into
  `updateOrderItems`), web `apps/web/app/(dashboard)/invoices/[id]/page.tsx` `editPaymentMax` and
  mobile `apps/mobile/lib/payments-logic.ts` `editPaymentMaxAmount` (both now import
  `remainingCapacity` from `@routeflow/pricing` instead of a hand-rolled client-side
  total-minus-sum-of-PAID). **Explicitly NOT touched (independent review caught a scope-creep
  attempt and reverted it, 2026-09-16):** `orders.service.ts`'s credit-limit-exposure calc keeps
  its original `status !== "VOID"` basis — an earlier draft of this PR silently converted it to
  `sumConfirmed`, which would have started 409-ing a DRAFT bank-import payment as
  `CREDIT_LIMIT_EXCEEDED` with no owner sign-off; that is a real, separate policy decision (does
  credit-limit exposure / receivables count DRAFT payments), filed as an open owner ruling, not
  made silently inside a "hardening" PR. No migration, no registry change. Specs:
  `credit-notes.service.spec.ts`, `customers.service.spec.ts`, `orders.service.spec.ts`,
  `invoices.service.spec.ts`, `payment-predicates.spec.ts`, **`payment-status-filter.spec.ts`**
  (264 lines — the status-recompute-basis regression suite: asserts every wired site's status
  transition uses `sumConfirmed`, never the DRAFT-inclusive capacity figure, across
  DRAFT+PAID+PENDING(+VOID) payment combinations), `apps/mobile/__tests__/payments-helpers.test.ts`,
  `packages/pricing/src/payment-confirmation.spec.ts`.
- Golden tests live here: `src/pricing.spec.ts`, `src/tier-pricing.spec.ts`, `src/golden.spec.ts`
  (+ `src/golden.fixtures.ts`, the hand-worked money table, moved from api's old
  `pricing-parity.fixtures.ts`), `src/payment-confirmation.spec.ts` (the core REG-B421 cases —
  split math, the all-or-nothing `resolveConfirmedAmounts` guard). `src/no-mirrors.spec.ts` and
  `src/package-shape.spec.ts` guard the package shape itself. `apps/api/src/common/no-runtime-workspace-imports.spec.ts`
  is the API-side runtime-import guard.
- Function bodies are byte-identical to the four deleted mirrors — proven by
  `scripts/codemods/pricing-body-diff.mjs` (per-symbol `identical`/`DIFFERS` diff; only
  `prorateLineSubtotal`'s signature line differs, widened to `storedSubtotal: number | null |
undefined`). `scripts/codemods/pricing-import-rewrite.mjs` is the codemod that rewrote every
  importer to the bare specifier.
- Jest-mapped in api (`apps/api/package.json`) and mobile (`apps/mobile/jest.config.js` +
  `metro.config.js`) to `packages/pricing/src/index.ts` — source, on purpose, so tests do not
  depend on whether `dist/` has been built; runtime resolution (node, `nest build`, `next`) goes
  through `main` -> `dist`. Docker: `apps/api`, `apps/web` and `apps/mobile` Dockerfiles each COPY
  the whole `packages/pricing/` and `packages/typescript-config/` directories before `RUN npm ci`,
  because the root postinstall compiles the package during `npm ci` (a manifest-only copy would
  leave `tsc` with no inputs). `turbo.json`'s old `@routeflow/api#test` mirror-inputs block is
  replaced by a `@routeflow/pricing#test` entry whose inputs include the three apps the tripwire
  walks; `check-types`/`dev` `dependsOn` `^build` so the package builds first.

### `@routeflow/ui` (`packages/ui`)

Cross-platform components. Entry `index.tsx`; subpaths `./web`, `./mobile`, `./tokens`.

- **Web** (`src/web/`, Tailwind + Radix): `Button` (Ledger: 6px `rounded-ctl`, surface-aware
  `bg-accent-strong`), `Input`, `PasswordInput`, `Textarea`, `Select`, `Modal` (optional
  `onEscapeKeyDown` forwarded to `Dialog.Content` — the only place a consumer can `preventDefault` to
  scope Escape to an inner sub-flow), `Table`, `Avatar`,
  `Card`, `Badge` (uppercase 11px pill; BadgeStatus covers 30+ statuses), `PageHeader`, `EmptyState`
  (Instrument-Serif title), `Toast` (ToastProvider; `useToast()` → `{toast→id, dismiss(id)}`; white
  card + colored icon tile; optional `action` slot — drives web `useUndo()` 8s Undo),
  `StatCard` (accent icon tile, tabular value), `Skeleton` +`SkeletonRows` (`.skeleton` shimmer), `Tabs`; utils `cn()`, `mergeRefs()`, **`TAP_TARGET` (B535, #910, 2026-09-19)** — `"min-h-[44px] min-w-[44px] inline-flex items-center justify-center"`, the WCAG 2.5.5/iOS-HIG 44×44 CSS-px minimum hit area for icon-only controls; compose via `cn(TAP_TARGET, "h-5 w-5 ...")` so the icon's own size is unaffected, grown via padding instead. Applied across dashboard icon-only buttons (`orders/[id]`, `vendor-bills/[id]` `EditLineItems`, others) via mobile-sweep call sites, not exhaustively re-listed per file here; illustration set.
  **All web primitives consume the Ledger tokens (below), so re-pointing tokens reskins them.**
- **Mobile** (`src/mobile/index.ts`): `MobileButton`, `MobileInput`, `StatusBadge`,
  `ScreenHeader`, `SectionHeader`, `EmptyState`.
- **iOS** (`src/mobile/ios/`): `NavBar`, `NavBackButton`, `NavAction`, `IosTabBar`,
  `IosTabBarView`, `KpiCard`, `BrandGradientCard`, `StopCard`, `ExceptionCard`,
  `SegmentedControl`, `Pill`, `SearchBar`, `ListGroup`, `ListRow`, `InlineStats`,
  `FilterChipRow`, `ProgressTrack`, `GoogleButton`, `Blur`, `BrandGlyph`, `MessageBubble`,
  `IosEmptyState`.
  - **`TabBarView.tsx` `IosTabBarView({items})` (2026-08-11)** — the bar's LOOK, with no router
    knowledge (this package takes no navigator dependency). `TabBar.tsx` `IosTabBar` is now a thin
    React Navigation adapter over it, keeping `shouldRenderTab`. Two callers share it: the adapter
    (driver / customer / tenant `<Tabs tabBar=…>`) and `apps/mobile/components/OperatorTabBar.tsx`,
    which lives outside any navigator. Extracted rather than forked so they can't drift.
  - **`FilterChipRow` needs all three of `{height:44, flexGrow:0, flexShrink:0}`.** It's a
    horizontal `ScrollView`, whose BASE style is `{flexGrow:1, flexShrink:1}` in RN core _and_
    react-native-web. `flexShrink:0` (added 56f582c8) stops it collapsing; `flexGrow:0` (2026-08-11)
    stops it GROWING — `height` is not a cap, so beside a `flex:1` list the two split the free space
    50/50 and, because `contents` centres vertically, you get a ~290px band with the chips floating
    in it ("the top menu moves down" on New order). Fixes 18 screens at once. A hand-rolled copy in
    `(customer)/(tabs)/catalog.tsx` carries the same guard. Don't fix it with alignment — ScrollView
    throws a dev invariant on `alignItems`/`justifyContent` in `style`.
- **Tokens** (`src/tokens.ts`): `colors` (brand 50–900, canvas, navy, success/warning/danger,
  surface), `fontFamily` (Inter), `borderRadius`; typography in `src/typography.ts`.

### `@routeflow/config` (`packages/config`)

Shared build/format configs (no TS source). Exports via package.json: `./eslint`, `./prettier`,
`./tsconfig` (tsconfig.base.json), `./tailwind` (tailwind.config.ts).

- **`tailwind.config.ts` = the Unified "Ledger" token source of truth.** `brand` = teal scale
  (500 `#14A39F`), `navy`/`ink`= `#0F1B2D` ink-900, `surface.raised` = canvas `#F7F9FC`; var-backed
  `ink`/`accent`/`line`/`paper`/`sunken` resolve against CSS vars in `apps/web/app/globals.css`
  (per-surface `--accent`: operator teal / `.surface-buyer` emerald / `.surface-admin` indigo).
  Fonts: `sans`=Spline Sans, `mono`=Spline Sans Mono, `display`=Instrument Serif. Radii `ctl`6/`card`10;
  hairline shadows. Mirrors `docs/design-package/project/unified/rf.css`.

### `@routeflow/eslint-config` (`packages/eslint-config`)

Flat ESLint configs (ESM). Exports: `./base` (recommended + turbo + typescript-eslint),
`./next-js`, `./react-internal`. Imported as `@routeflow/eslint-config/base` into workspace configs.

### `@routeflow/typescript-config` (`packages/typescript-config`)

TS config presets (JSON inheritance): `base.json` (es2022, strict, nodeNext), `nextjs.json`
(ESNext, Bundler, noEmit, jsx preserve), `react-library.json` (jsx react-jsx). Used via
`extends` in app `tsconfig.json`.

## Catch-up 2026-09-21

> Drift `c19cb81` -> HEAD. New workspace `@routeflow/scanning`; new shared DTO files; modified types/pricing/ui. Scripts/schema: [`api/catchup-2026-09-21-scripts-schema.md`](api/catchup-2026-09-21-scripts-schema.md).

### `@routeflow/scanning` (`packages/scanning`) — NEW, extracted from apps/mobile (#948)

- `packages/scanning/package.json` — name `@routeflow/scanning` 0.0.1, private; `main`/`types` = `./src/index.ts` (no build step); scripts test/lint/check-types; consumed by apps/web (transpilePackages) and apps/mobile (metro + jest alias).
- `packages/scanning/src/index.ts` — barrel; `export *` from scan-loop, scan-pending-buffer, scan-engine, scan-feedback.
- `packages/scanning/src/scan-loop.ts` — dedupe gate (per-code cooldown, absence clock, LRU slots); exports `gateScan(code,state,now,cooldownMs?,candidatesOf?)`, `ScanGateState`, `ScanSlot`, `ScanCandidates`, `ScanOutcome`, `ScanFeedback`, `SCAN_COOLDOWN_MS=600`, `ABSENCE_GAP_MS`, `SCAN_SLOTS=4`.
- `packages/scanning/src/scan-pending-buffer.ts` — bounded FIFO so a mid-resolve detection is queued not dropped; exports `createPendingBuffer()`, `pushScan(state,code)`, `completeResolve(state)`, `PendingBufferState`, `PENDING_BUFFER_DEPTH=2`.
- `packages/scanning/src/scan-engine.ts` — sequencing seam gate -> buffer, pure (caller injects `now`); exports `createScanEngine()`, `frameScanned(state,code,now,candidatesOf?)`, `manualScanned(state,code)`, `scanSettled(state)` -> `ScanEngineStep`.
- `packages/scanning/src/scan-feedback.ts` — exports `cueForOutcome(outcome): ScanCue` (`"accepted"|"rejected"|"none"`); sound/vibration stay per-app (`scan-cue`).
- `packages/scanning/jest.config.js` — ts-jest, node env, `roots:["<rootDir>/src"]`, `*.spec.ts`. `packages/scanning/tsconfig.json` — extends typescript-config base, commonjs/node, noEmit, `noUncheckedIndexedAccess:false`.
- Callers: `apps/mobile/lib/scan-{engine,feedback,loop,pending-buffer}.ts` (thin re-export shims; engine injects `normalizeScanCode`); web `orders/_components/scan/{ScanOrderScreen.tsx,useContinuousScanCamera.ts}` (useScanV2, #977).

### `@routeflow/types` new files (`packages/types/api/`), all re-exported from `packages/types/index.ts`

- `packages/types/api/config-snapshots.ts` — platform-admin config-snapshot wire shapes (A2c #1023/#1109); exports `ConfigSnapshotListItem`, `ConfigSnapshotPreview`, `ConfigSnapshotRestoreReport`, `ConfigSnapshotRestoreResult`, `ConfigSnapshotEntryKind`, `ConfigSnapshotSkipReason`.
- `packages/types/api/product-labels.ts` — category-label manager + product label panel DTOs (Lane R step 4, #990); exports `LabelCategoryDto`, `ProductLabelDto`, `InheritedLabelDto`, `ProductLabelsDto`, `SetProductLabelRequest`; uses `LabelMode`.
- `packages/types/api/restrictions-admin.ts` — selling-restriction rules admin contract (#995/#1003); exports `RESTRICTION_STATUS_VALUES`, `RestrictionStatus`, `SellingRestrictionListItemDto`, `CreateSellingRestrictionRequest`, `LiftSellingRestrictionRequest`.
- `packages/types/api/restrictions-settings.ts` — `/settings/restrictions` contract (#1000/#1031); exports `RestrictionsSettingsDto{enabled,governingAddress}`, `RestrictionsEnableReadiness`, `UpdateRestrictionsSettingsRequest`.

### Modified

- **Modified `packages/types/api/enums.ts`:** +`RESTRICTION_ADDRESS_PRECEDENCE_VALUES`/`RestrictionAddressPrecedence`, +`SNAPSHOT_REASON_VALUES`/`SnapshotReasonValue` (#1000/#1002).
- **Modified `packages/types/api/restrictions.ts`:** +`RestrictionOutcome`, `RestrictionChannel`, `RestrictionsEvaluation`, `BuyerBlockedLine`, `BuyerSellingRestrictedError`; `addressPrecedence` replaces `governingAddress`; +`UNKNOWN_PRODUCT`; 409 message (#956/#1061/#1126).
- **Modified `packages/types/`:** `api/products.ts` (unit prices `string|null`; `PutProductUnitsPayload` -> `CreateProductUnitPayload`/`UpdateProductUnitPayload`, #947); `api/us-states.ts` (comment only: AA/AE/AP/FM/MH/PW/UM out of scope); `index.ts` (+4 re-exports).
- **Modified `packages/pricing/src/unit-levels.ts`:** `resolveUnitPrice` now delegates to new `resolveLevelPrice(input: ResolveLevelPriceInput)`; new `Numeric` type accepts Decimal/string; explicit price = positive number only; zero packPrice guard (#943/#947).
- **Modified `packages/ui/src/web/`:** `Badge.tsx` (`children` now rendered, #946); `Modal.tsx` (+`scroll` 92vh cap, `onOpenAutoFocus`, `onCloseAutoFocus`, #1062/#1115). ui + eslint-config `package.json`: dep bumps (#972).

## Landed 2026-10-01 to 2026-10-11 (w12-w27 through Release 4.1)

Moved to [packages/landed-2026-10-01-to-2026-10-11.md](packages/landed-2026-10-01-to-2026-10-11.md) (this file was at its size cap): scanning hold mode, pricing, types (counter-day-close, counter-sale), ui, and the W17 to Release 4.1 landing notes.

### 2026-10-16 landing (#3473, #3474)

- `packages/pricing/src/unit-chain.ts` (NEW) `MAX_FACTOR_TO_BASE`, `ChainLevel`, `ChainViolation` / `ChainViolationCode`, `deriveChainFactors(levels)`, `validateUnitChain(levels) -> ChainResult`; `unit-options.ts` (NEW) `buildLadderOptions`, `defaultLadderOptionValue`, `ladderOptionPriceText`, `ladderOptionLineTotal`, `LadderOption`, `DerivedBaseMarker`; `unit-levels.ts`, `tier-pricing.ts`, `golden.fixtures.ts`, `unit-parity.master.json` edited. Re-exported from `src/index.ts`.
- `packages/types`: `estimate-tax-basis.ts` (NEW) `EstimateTaxBasis`, `estimateTaxBasisNotice`; `stock-count-commit-copy.ts` (NEW) `STOCK_COUNT_*_COPY` strings; `api/product-labels.ts`, `api/products.ts`, `api/restrictions-admin.ts`, `api/error-codes.ts` extended.
- `packages/scanning` (#3474): `scan-engine.ts` opt-in `fastRepeat` (order builder only: a repeat of the code just accepted counts after a 0.3 s absence, 0.3 s cooldown; other screens keep the 09-24 rule); `scan-pending-buffer.ts` `PENDING_BUFFER_DEPTH` 2 -> 8, `pushScan` / `completeResolve` report `dropped` on overflow; `scan-loop.ts` forwards it.

### 2026-10-16 landing, second batch (#3497 units release 1, fixes-2)

- `packages/pricing/src/price-ladder.ts` (NEW, units core A) `PriceTier`, `PRICE_TIERS`, `UnitRef`, `TierRules`, `DEFAULT_TIER_RULES`, `normalizeTierRules`, `buildLadderView(product, units, opts)` -> `LadderView` (`LadderRow` per unit, `LadderViewOptions`), `refForLabel`, `priceSource(row, tier)` ("set" | "auto"), `rowOf`. `unit-levels.ts` gains `explicitPrice`, `packFactorOf`.
- `price-anchor.ts` (NEW) `CustomerPricing`, `customerAnchor(view, customer)`, `customerPriceExact` / `customerPrice`, `planOrderUnitSwitch(...) -> SwitchPlan`, `materializePack`, `CellRef` / `Pin` / `CellChange`. `price-change.ts` (NEW) `scalePrice(from, num, den)` (the one proportional rounding), `applyCellPatches`, `inversionOffers`, `planCellEdit -> PricePlan`, `PriceOffer`. `customer-unit-price.ts` (NEW) `customerTierFor`, `resolveCustomerUnitPrice(input)`.
- `unit-default.ts` (NEW, core C) `UnitScope` (customer > tier > product > business > fallback), `resolveUnitDefault(view, scopes) -> OrderUnitDefault`, `resolveInvoiceUnit(view, scopes) -> InvoiceUnitChoice`. `invoice-display.ts` (NEW) `invoiceLineDisplay(input)` (display only: never feeds totals), `legacyInvoiceCode`, `unitCodeOf`, `printedInvoiceCode`.
- `pack-write-path.ts` (NEW) `PACK_WRITE_PATH_COMPLETE` (false), `PRICING_RULES_NOT_READY_MESSAGE`, `tierRulesAboveZero`, `PricingRulesNotReadyError`: tier rules above 0% and order-unit switches stay off until every pack price writer uses one path. `units-prices-v2.ts` (NEW) `UNIT_REF_PACK` / `UNIT_REF_BASE`, `isUnitRefKeyword`, `PACK_AUTO_BITS`, `PACK_AUTO_ALL` (31), `TIER_RULES_SETTING_KEY`, `ORDER_UNIT_SETTING_KEY`, `INVOICE_UNIT_SETTING_KEY`, `DEFAULT_ORDER_UNIT`. All re-exported from `index.ts`.
- `packages/types`: `api/products.ts` `ProductPriceGridDto` / `Row` / `Cell`; `api/settings-registry.ts` dark rows `pricing.tierRules`, `units.orderUnit`, `units.invoiceUnit` ("pending units S18"); `api/error-codes.ts` `PRICING_RULES_NOT_READY`, `PAYMENT_NOT_DUE`, `PAYMENT_TERMS_CHANGED`, `COSTING_METHOD_RETIRED`; `api/billing.ts` `PaymentDueView` (due, pastDue, amountCents, periodLabel/Start, cardNeeded, chargeStartsOn, cardBy); `api/enums.ts` `RETIRED_COSTING_METHODS`, `SELECTABLE_COSTING_METHODS`; `api/misc.ts` tenant `costingMethod` is WEIGHTED_AVERAGE | LAST_COST.
- units-v2-2 (#3501): `packages/pricing/src/price-ladder.ts` `canonicalUnitRef(units, ref)` (the one ref-write canonicalizer: a factor-1 row id becomes "base"; refs name the level, SA-809); `price-change.ts` customer-move offers per SA-798a (`CustomerMoveOffer`, F20 opt-in on plain cell edits); `customer-unit-price.ts` and `invoice-display.ts` follow the level refs. `packages/types/api/product-prices-v2.ts` (NEW, exported from `index.ts`) the save/undo/customer-read contract: `PriceCellPatch`, `PriceCellKeep`, `CustomerPriceMove`, `SavePricesRequest/Response`, `SavePricesUndo`, `UndoPricesRequest`, `LadderRevisionStaleBody`, `CustomerPriceConflict`, `PriceEditInvalidBody`, `ProductCustomerPricingDto`, `ProductCustomerPricesResponse`, `CustomerUnitPriceSource`; `api/products.ts` grid DTO gains `revision`, `priceState`, `tierAnchors`, `tierRules`, row `editable`; `packages/ui` field border token.

- fixes-3 (2026-10-17, `5caf64725..486c8b896`): `packages/types/api/error-codes.ts` `API_ERROR_CODES` gains `VARIANT_NAME_PREFIX_ONLY` (400, B1 bare variant label) and `STOCK_DATE_IN_FILED_PERIOD` (409, B846 stock row dated into a filed period).

## units-v2-3 (2026-10-17, #3507)

- `packages/pricing/src/customer-line-price.ts` (NEW, S19b A0, SA-811a / SA-813) the ONE pure line price for a customer, shared by api, web and mobile: `customerLinePrice({product, tier, layer?, unitLabel?, tierPrice?}) -> CustomerLinePrice` (`price`, `listPrice | null`, `isSpecial`, `priceType` STANDARD | SPECIAL | MANUAL, `layered`); a layer row wins, no row = master's `getTierPrice` / `isSpecialTier` exactly.
- `packages/pricing/src/customer-line-price.ts` also: `layerRowForLabel(product, layer, unitLabel)` (blank/pack name -> pack row, base name or Piece -> "base" row, else named row exact then case-insensitive). `CustomerLayerUnit` (structural twin of the types DTO).
- `packages/pricing/src/customer-line-price.ts` also: `priceLayerStatus({enabled, isPending, isError, isFetching?, data?}) -> PriceLayerStatus` (`enabled`, `ready`, `pending`, `failed`, `complete`, `lineReady(productId)`; flag off = ready). Re-exported from `index.ts`.
- `customer-unit-price.ts` gains `CustomerLayerPrice`, `customerLayerPrice(input)` (resolver answer only for source `customer` / `customer-shape`, else null; carries `listPrice`, `aboveList`) and `isSpecialPrice(tier, listPrice, layerPrice)`; its doc now says dollars via `roundMoney`, not cents.
- `unit-levels.ts` NEW `unitNameKey(s)` (NFC, trim, case-fold; the one label-match key) and `namesPack` / `namesBase` are now exported. `unit-options.ts` `buildLadderOptions(...)` takes a trailing optional `layerPackPrice`: the flag-on layer pack price moves only the derived base (Piece = pack/n), never `packPrice`.
- `packages/types`: `piece-synonyms.ts` (NEW, exported from `index.ts`) `unitNameKey` (literal copy of pricing's, parity-pinned by the api's `units/piece-words-parity.spec.ts`), `PIECE_SYNONYMS` (piece, pieces, each, unit, pcs), `isPieceSynonym(name)`.
- `packages/types`: `api/product-prices-v2.ts` `CustomerPriceLayerUnitDto`, `CustomerPriceLayerResponse` (`customerId`, `complete`, `products: Record<productId, units[]>`; absent from an incomplete response is NOT ready).
- `packages/types`: `api/products.ts` `ProductPackAtOpen`, `ExpectedPackPayload` (`expectedUnit`, `expectedUnitsPerBox`, `expectedTenantUnitId?`; SA-797).
- `api/error-codes.ts` `API_ERROR_CODES` gains `UNIT_NAME_TAKEN`, `UNIT_RENAME_COLLISION` (body `reason`), `UNITS_RENAME_IN_PROGRESS`, `UNIT_ARCHIVED`, `TENANT_UNIT_LIMIT`, `UNIT_SIZE_IN_USE`, `PRODUCT_PACK_STALE`, `PRODUCT_PACK_PRECONDITION_REQUIRED` (all 409).
- `packages/ui/src/web/Modal.tsx`: new `anchor?: "center" | "top"` prop (default "center"; "top" pins the dialog 4vh from the top and fades in with no zoom or slide, for long forms whose rows change height); entry/exit animations are skipped under `prefers-reduced-motion`.

## fixes-4 (2026-10-18, #3511)

- `packages/types/api/error-codes.ts` `API_ERROR_CODES` gains `CUSTOMER_PRICES_UNAVAILABLE` (503: a typed-price customer's flag read failed; retryable, nothing written).

## product-k11 and money-1 (2026-10-18, #3513, #3480)

- `packages/ui/src/web/FloatingPanel.tsx` (NEW) `FloatingPanel` (`FloatingPanelProps`, `FloatingPanelTarget`: a ref or a getter for the anchor), `computeAnchoredPlacement({...})` / `AnchoredPlacementInput`: a small modal that hangs off its opener (anchored panel from `md` up, bottom sheet below; right edge on the anchor's, placed imperatively and measured); exported from `src/web/index.ts`.
- `packages/pricing/src/price-change.ts`: `scalePrice(from, num, den)` (the one proportional-move rounding), `CellPatch`, `applyCellPatches(view, patches)` (returns the undo patches), `inversionOffers(...)`, `FollowerRow`, `CustomerChange` (SA-798 `against` flag).
- `packages/pricing/src/legacy-box-axis.ts`: `B661_CUTOFF` and the REQUIRED `writtenAt` input (#2859); `packages/{pricing,returns,scanning}/package.json` gain a `source` export condition for the graph overlay.
- `packages/types/api/price-history.ts`: `PriceHistoryReferences`, `PriceHistoryAggregate`, `PRICE_SUMMARY_MAX_PRODUCTS = 50`, `PriceSummaryEntry` (rows carry their own `unitsPerBox`), `PriceSummaryResponse`. `api/error-codes.ts` gains `ORDER_DELIVERY_ADDRESS_MISSING`, `STRIPE_NOT_CONFIGURED`, `STRIPE_ACCOUNT_MISMATCH`, `STRIPE_SUBSCRIPTION_OWNER_MISMATCH`.

## R5 train (2026-10-20, #3552)

- `packages/types/api/enums.ts`: `TAX_RATE_SOURCE_VALUES`/`TaxRateSource`, `INVOICE_ORDER_BILLING_ROLE_VALUES`/`InvoiceOrderBillingRole` (set-equal to the Prisma enums in `enum-parity.spec.ts`).
- `packages/types/api/error-codes.ts`: `BILL_NEEDS_A_LINE`, `BILL_NOT_EDITABLE`, `BILL_PO_SUPPLIER_LOCKED`, `BILL_NEVER_RECEIVED`, `BILL_TAX_UNKNOWN`, `RECEIVE_EXCEEDS_OUTSTANDING`, `BILL_HAS_PAYMENTS`, `BILL_PAYMENT_NOT_CASH`, `BILL_PAYMENT_NO_SUPPLIER`; `INVOICE_TAX_STATE_STALE_PATH_VALUES`, `InvoiceTaxStateStalePath`, `INVOICE_TAX_STATE_STALE_COPY`.

## Window 1 (2026-10-21, #3555)

- `packages/types/draft-submit-key.ts`: `DRAFT_SUBMIT_KEY_FIELD` (`_submitKey`), `isDraftSubmitKey`, `readDraftSubmitKey`, `withDraftSubmitKey` (one submit key per draft, SA-817 A).
- `packages/types/api/misc.ts`: `expectedUpdatedAt` on the draft save request. `packages/types/api/error-codes.ts`: `DRAFT_CHANGED`.

## Window 2 and R5 part 2 (2026-10-21, #3557, #3550, #3558)

- `packages/pricing/src/tax-precision.ts`: `TAX_RATE_FRACTION_DECIMALS` (6), `TAX_PERCENT_DECIMALS` (4), `TAX_PERCENT_PRECISION_MESSAGE`, `sameRateAtLegacyPrecision(stored, configured)` (snaps the product before rounding), `taxPercentPrecisionError(percent, stored?)`. Exported from `index.ts`; used by api DTOs/settings, web and mobile.
- `packages/pricing/src/inferred-flat-rate.ts`: `inferredFlatRate(invoice, opts?: InferredFlatRateOptions)`; `preferredRate` (tenant) wins when the single totals builder reproduces the stored tax, else the first verified of 4 dp then 6 dp. `explained-tax-rate.ts`, `nsf-line.ts` follow the widen.
- `packages/types/api/config-snapshots.ts`: `ConfigSnapshotHeldFulfilment` / `ConfigSnapshotHeldOverride` (discriminated by `kind`), hold reasons `ADDON_NOT_PAID`, `REQUIRES_UNMET`. `regulated.ts`: unbooked-reversal warning field.

## Window 3 (2026-10-21, #3561, #3566)

- `packages/pricing/src/unit-levels.ts`: `derivedPiece(pack, n)` -> `{ price, derived: { n, packPrice, exact } }` (the one derived-Piece definition; web `unit-options.ts` imports it, K14 S2).
- `packages/pricing/src/counter-park.ts`: `ROW_ITEM_NAMES_MAX` (3), `ItemNameLine`, `foldItemNames(lines, cap)` -> `{ items?, itemCount? }` (the ONE fold of a row's item names for Today's sales and the parked list; a boxed or unit line carries `qtyText` from `invoiceLineQtyText`). `ParkedCartListItem` gains `items?`, `itemCount?`.
- `packages/types/api/counter-sale.ts`: `CounterItemName { name, qty, qtyText? }`; `TodaysSaleRow` gains `items?`, `itemCount?` (absent from an older server: no names line).

## Window 4 (2026-10-22, #3583, #3563, #3571, #3576, #3575, #3562, #3588)

Moved to [packages/landing-2026-10-22-w4.md](packages/landing-2026-10-22-w4.md) (this file is at its size cap): filed-month undo note, payment key types and rule, import Family types, counter return settlement in pricing, Modal `headerActions`, Toast inset.

## Window 5 (2026-10-24, 28 PRs, #3455 to #3713)

Moved to [packages/landing-2026-10-24-w5.md](packages/landing-2026-10-24-w5.md) (this file is at its size cap): error codes, one payment capacity predicate, cleared tender, pricing gate, counter copy, send state, Toast 44px.

Window 6 (2026-10-25): moved to [packages/landing-2026-10-25-w6.md](packages/landing-2026-10-25-w6.md) (this file is at its size cap): capacity policy helpers, no-longer-fits copy and error code, bugs close verb, skip-verify pushed refs, ops-monitor NUL guard.

Train 2 (2026-10-25): moved to [packages/landing-2026-10-25-train2.md](packages/landing-2026-10-25-train2.md) (this file is at its size cap): `PRODUCT_CHANGED_CONCURRENTLY` in `API_ERROR_CODES`.

Catch-up (2026-10-29, b1a2fc3d1..75f433f56): moved to [packages/landing-2026-10-29-w26-catchup.md](packages/landing-2026-10-29-w26-catchup.md) (this file is at its size cap): pricing, types, ui, plus apps/mobile and apps/control.
Catch-up (2026-10-30, 75f433f56..f732d6209): [packages/landing-2026-10-30-w26r-w28b.md](packages/landing-2026-10-30-w26r-w28b.md): factory R-series tooling, janitor, code-map validator, check-types heap.
Catch-up (2026-10-30, f732d6209..69f92c761, train W29c): [packages/landing-2026-10-30-w29c.md](packages/landing-2026-10-30-w29c.md): staffMay, held-level, dunning clock, promotions mode, money formatter, deps bump.
Catch-up (2026-10-30, train W28a): [packages/landing-2026-10-30-w28a.md](packages/landing-2026-10-30-w28a.md): drawer event types, buyer `revisionNumber`.
Catch-up (2026-10-30, train W30a): [packages/landing-2026-10-30-w30a.md](packages/landing-2026-10-30-w30a.md): `perBaseUnitPrice`, walk-in lock codes.
Catch-up (2026-10-31, train W30b): [packages/landing-2026-10-31-w30b.md](packages/landing-2026-10-31-w30b.md): `stock-level.ts` low-stock rule, `LOW_STOCK_TOO_MANY`, counter refusal copy.
Catch-up (2026-10-31, train W31): [packages/landing-2026-10-31-w31.md](packages/landing-2026-10-31-w31.md): `ready-for-pickup.ts`, `ORDER_NOT_READYABLE`.
Catch-up (2026-10-31, train W32): [packages/landing-2026-10-31-w32.md](packages/landing-2026-10-31-w32.md): money-rounding pin spec and `turbo.json` inputs, staff order email types and settings-registry rows.
Catch-up (2026-10-31, train W33): [packages/landing-2026-10-31-w33.md](packages/landing-2026-10-31-w33.md): `CreateReturnLineItemDto`.
Catch-up (2026-10-31, train U): [packages/landing-2026-10-31-u.md](packages/landing-2026-10-31-u.md): `MAX_UNIT_PRICE`, `createPausableClock` in `@routeflow/scanning`, toast viewport z-index.
