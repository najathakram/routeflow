# Area: packages (`packages/*`)

Shared workspace packages (types, UI, configs) consumed by apps via npm workspaces.

## Where to find (this area)

| Need                                             | File → symbol                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------- |
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

Shared DTO/enum definitions. Entry: `index.ts` (no `src/`).

- **Enums** (synced with Prisma): `UserRole`, `UserStatus`; `OrderStatus`, `ItemStatus`;
  `RouteRunStatus`, `RouteRunStopStatus`; `TxnStatus`, `PaymentMethod`; `MutationType`,
  `FulfillPath`, `DriverStatus`.
- **Interfaces**: `User`, `Order`, `PaginatedResponse<T>` (data + meta: total/page/limit/totalPages),
  `ApiResponse<T>`.
- **Constants**: `DEVELOPER_MODE_ADDON = "developer_mode"` (2026-08-20) — the legacy
  `TenantAddon.addonKey` for the hidden platform-admin flag that unhides the in-development
  dispatch/driver/route UI. Lives here so web (`apps/web/lib/api/addons.ts`, the admin tenant
  page), mobile (`apps/mobile/lib/api/addons.ts`) and api (`plan-catalog.constants.ts`'s pending
  bridge note) share one string; the only inlined copies are in plain-node scripts that can't
  import TS (`scripts/enable-developer-mode.mjs`, `apps/api/scripts/e2e-seed.js`).

- **`pack-size.ts` (2026-08-20) — the ONE shared pack-size name parser.** Exports `parsePackSizeDetailed(name)`, `suggestPackSize({name, unit, unitSku, unitsPerBox})` → `{packSize, counts, confidence, reason}`, and `formatCountList(counts)` (`"5 or 12"`, `"4, 8 or 16"` — shared so no surface hardcodes "two"; a name can state three counts) with `confidence: HIGH | MEDIUM | LOW | AMBIGUOUS | PIECE_UNIT | null`. Lives here — **NOT** mirrored into `apps/*/lib` — precisely because all three apps already consume `@routeflow/types`, and a parser whose value is its refusal rules is the worst possible thing to keep hand-synced copies of (contrast `pricing.ts`, which IS a deliberate triple mirror).
  - ⚠️ **It must keep REFUSING to guess.** `packSize` is returned only when exactly ONE distinct count survives; two or more ⇒ `null` + `AMBIGUOUS` ("…5CT - 12Pack" is 12 packs of 5 — guessing mis-prices every loose sale of that product forever, which is far worse than asking). A `PIECE_UNIT` unit (`pcs`/`each`/`bottle`/`can`/`stick`…) NEVER gets a proposal: the count in such a name describes the case the row was broken out of, and setting a pack size there divides a piece price by the pack and undercharges by that factor.
  - Parse order is load-bearing: `N/<measure>` (e.g. "12/1.93OZ") is read FIRST, then measurements are stripped so "5 HOUR"/"65MG" cannot read as counts, then `N CT|PK|PACK|COUNT|PCS`. Counts kept only when `> 1` and `<= 1000`.
  - **`packages/types` has no Jest runner** (its test script is `tsc --noEmit`), so the specs live at `apps/api/src/common/pack-size.spec.ts`. Put new cases there or they silently never run.
  - `apps/api/scripts/propose-pack-sizes.mjs` holds a MIRROR of this logic (plain node can't import TS) and is labelled as such — canonical behaviour is here.

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
