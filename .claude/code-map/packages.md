# Area: packages (`packages/*`)

Shared workspace packages (types, UI, configs) consumed by apps via npm workspaces.

## Where to find (this area)

| Need                                             | File → symbol                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------- |
| Money math (line totals, tax, promos, tiers)     | `packages/pricing/src/` → `pricing.ts`, `tier-pricing.ts`                  |
| Enums (UserRole, OrderStatus, ...)               | `packages/types/index.ts` → `export enum X`                                |
| Type interfaces (User, Order, PaginatedResponse) | `packages/types/index.ts` → `export interface X`                           |
| Web components (Button, Table, Modal, ...)       | `packages/ui/src/web/` → `index.ts` barrel                                 |
| Mobile RN components                             | `packages/ui/src/mobile/index.ts`                                          |
| iOS-specific components                          | `packages/ui/src/mobile/ios/index.ts`                                      |
| Design tokens (colors, spacing, fonts)           | `packages/ui/src/tokens.ts`                                                |
| ESLint flat presets                              | `packages/eslint-config/` → base.js, next.js, react-internal.js            |
| TypeScript presets                               | `packages/typescript-config/` → base.json, nextjs.json, react-library.json |

## Packages

### `@routeflow/types` (`packages/types`)

Shared DTO/enum definitions. Entry: `index.ts` (no `src/`), re-exports `./api/*` (below) via
`export * from "./api/<domain>"`.

- **`api/enums.ts` (2026-09-03, wave E / imp-10b)** — one `export const X_VALUES = [...] as const` +
  `export type X = (typeof X_VALUES)[number]` per Prisma enum a web/mobile `lib/api/*` file mirrors
  as a hand-typed string union (40 enums; values copied from `apps/api/prisma/schema.prisma`).
  Pinned set-equal to `@prisma/client`'s generated enum by
  `apps/api/src/common/enum-parity.spec.ts` — this is the guard against the drift class that shipped
  three real bugs (see `L-072`): `VendorBillStatus` mirrors had invented `"FULL"`/omitted
  `OVERDUE`, `PurchaseOrderStatus` (mobile local name `POStatus`) had `"PARTIALLY_RECEIVED"` instead
  of `PARTIAL`, `PromotionType` (`BuyerPromotion.type`) omitted `"BUY_N_GET_M"`; plus a sibling-sweep
  find, a phantom `"EXPIRED"` on `EstimateStatus` in both apps.
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

### `@routeflow/pricing` (`packages/pricing`)

**Compiled** workspace package — the ONE copy of RouteFlow money math, replacing the four
`pricing.ts` copies (api `src/common` + `src/utils`, web `lib`, mobile `lib`). Entry `src/index.ts`
→ `pricing.ts` (`computeLineSubtotal`, `normalizeBoxesPieces`, `roundMoney`, `prorateLineSubtotal`,
`applyBestPromotion`/`promotionMatchesProduct`, the zero-price guard, BUY_N_GET_M helpers,
`computeCategoryTax`, `roundUnitCost`, `effectiveQty`) + `tier-pricing.ts` (`getTierPrice`).
**Ships `dist/` (CJS + `.d.ts`), not source** — `main`/`types` point at `dist`, `package.json`
declares `"build": "tsc -p tsconfig.build.json"`. This is load-bearing, unlike `@routeflow/types`'
raw-TS `main`: the API consumes it at runtime through `nest build`'s emitted `require()`, and a
source-direct package there crashes `node dist/main.js` (`no-runtime-workspace-imports.spec.ts`
now asserts every `@routeflow/*` the API imports resolves to a built `main`). The root
`postinstall` runs `npm run build -w @routeflow/pricing` so every `npm ci` (CI, Docker, local dev)
produces `dist` before anything typechecks. api/web/mobile all import the bare specifier
`@routeflow/pricing` — no relative imports, no mirrors to keep in sync.

- Golden tests live here: `src/pricing.spec.ts`, `src/tier-pricing.spec.ts`, `src/golden.spec.ts`
  (+ `src/golden.fixtures.ts`, the hand-worked money table, moved from api's old
  `pricing-parity.fixtures.ts`). `src/no-mirrors.spec.ts` and `src/package-shape.spec.ts` guard the
  package shape itself. `apps/api/src/common/no-runtime-workspace-imports.spec.ts` is the API-side
  runtime-import guard.
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
  `StatCard` (accent icon tile, tabular value), `Skeleton` +`SkeletonRows` (`.skeleton` shimmer), `Tabs`; utils `cn()`, `mergeRefs()`; illustration set.
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
