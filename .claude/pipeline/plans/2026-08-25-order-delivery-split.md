# Plan: Split "Order delivery" from "Recurring routes" — separate addons + separate surfaces

> Authored by Fable 5 on 2026-08-25. Status: SHIPPED (owner directed 2026-08-25)
> This file is the ONLY context the implementation and review agents receive.
> It must stand alone: no references to any conversation.

## Objective

Owner direction: recurring routes and ad-hoc order delivery are DIFFERENT features and must not
be mixed in the UI. Tenants may buy either or both. Split them:

1. Two new per-tenant addons (platform-admin toggles): `recurring_routes` (standing route
   templates + scheduled dispatch) and `order_delivery` (ad-hoc trips planned from selected
   orders: optimize → dispatch → full delivery HISTORY; trips are one-shot, never reused).
2. `developer_mode` remains the master dev switch that unlocks BOTH (so currently-enabled
   tenants regress zero). Effective visibility everywhere = `devMode || <featureAddon>`.
3. Web gets a first-class **Deliveries** surface at `/deliveries` (history) + `/deliveries/new`
   (the existing trip builder, MOVED from `/routes/trips/new`). The `/routes` page loses its
   Trips section entirely. Old URLs redirect.
4. Mobile mirrors the split. Driver app untouched.

## Constraints & conventions

- Monorepo: npm+Turbo. Web `apps/web` Next.js 14 App Router (Radix+Tailwind, TanStack Query),
  mobile `apps/mobile` Expo (expo-router), api `apps/api` NestJS 11 + Prisma.
- Prettier: double quotes, semicolons, printWidth 100. Conventional commits. Jest only (api,
  mobile pure-logic), Playwright for web e2e. NO Vitest/snapshots.
- **Do NOT touch**: `completeStop`, `completeWithPayment`, `recordDeliveryPaymentInTx`, any
  `reconcile*` invoice function, `route-optimization` module, `DriverPaymentsGuard`, the driver
  app surfaces (`apps/mobile/app/(driver)/**` — zero changes), migrations/schema (NO schema
  change in this plan).
- **No server-side addon gates in this plan.** The routes/trips endpoints stay UI-gated only
  (the `developer_mode` precedent: surfaces degrade to hidden, never 403). TripsController
  keeps its existing `@Roles(OPERATOR)` only.
- Addon reads on web come from `useTenantAddons()` (`apps/web/lib/api/tobacco.ts`) via wrappers
  in `apps/web/lib/api/addons.ts`; on mobile from the query in `apps/mobile/lib/api/addons.ts`.
  One addons fetch serves all flags (same queryKey).
- Trips = `Route` rows with `kind: "ADHOC"`; list endpoint `GET /routes?kind=ADHOC` exists
  (`useRoutes({kind})`). Draft = a trip route with no runs. Existing pages to move:
  `apps/web/app/(dashboard)/routes/trips/page.tsx` (list),
  `apps/web/app/(dashboard)/routes/trips/new/page.tsx` (builder) and
  `apps/web/app/(dashboard)/routes/trips/_components/{TripOriginPicker,TripStopList,TripSkippedPanel}.tsx`.
- Web orders list bulkbar action "Plan delivery trip" lives in
  `apps/web/app/(dashboard)/orders/page.tsx` (currently gated `useDeveloperMode().enabled`,
  pushes `/routes/trips/new?n=`).
- Live client tenants are NEVER test targets. Testing only on approved tenants.

## Work packages

### WP1 — Shared addon constants + client hooks

- **files:** `packages/types/index.ts`, `apps/web/lib/api/addons.ts`, `apps/mobile/lib/api/addons.ts`
- **brief:** Add the two addon constants and per-platform hooks. Keep `useDeveloperMode`
  byte-identical. Mobile mirrors web's semantics but keeps its own auth-gated query shape
  (copy the existing `useDriverPayments` pattern in each file — it already exists in BOTH
  files; clone it twice per file with the new constants).
- **exact code (packages/types/index.ts, after DRIVER_PAYMENTS_ADDON):**

```ts
/**
 * Per-tenant feature addons for the two delivery products (owner decision
 * 2026-08-25): tenants may run standing routes, ad-hoc order delivery, or both.
 * `developer_mode` remains the master dev switch that unlocks both — every
 * client gate must read `devMode || <feature>`.
 */
export const RECURRING_ROUTES_ADDON = "recurring_routes";
export const ORDER_DELIVERY_ADDON = "order_delivery";
```

- Web `addons.ts`: export `useRecurringRoutes()` and `useOrderDelivery()` cloned from the
  existing hook pattern (`{ enabled, isLoading, resolved }`, same tenant-scoped queryKey).
  Also export two composition helpers used by every gate in WP3/WP4:

```ts
/** Order-delivery surface visibility: the feature addon OR the dev master switch. */
export function useDeliveryAccess(): { enabled: boolean; resolved: boolean } {
  const dev = useDeveloperMode();
  const od = useOrderDelivery();
  return { enabled: dev.enabled || od.enabled, resolved: dev.resolved || od.resolved };
}
/** Recurring-routes surface visibility: the feature addon OR the dev master switch. */
export function useRoutesAccess(): { enabled: boolean; resolved: boolean } {
  const dev = useDeveloperMode();
  const rr = useRecurringRoutes();
  return { enabled: dev.enabled || rr.enabled, resolved: dev.resolved || rr.resolved };
}
```

Mobile `addons.ts`: same four additions (hooks + the two access helpers), mobile query shape.

### WP2 — API: trip history needs run summaries on the list

- **files:** `apps/api/src/routes/routes.service.ts`, `apps/api/src/routes/routes.service.spec.ts`
- **brief:** `findAllRoutes` currently returns routes without run info, so the Deliveries
  history page cannot show driver/date/status. Add an `include` (or extend the existing one)
  so each route row carries `_count: { select: { runs: true, stops: true } }` and
  `runs: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, status: true,
scheduledDate: true, completedAt: true, driver: { select: { id: true, contactName: true } } } }`.
  Purely additive to the response shape — do NOT change filtering, pagination, or the
  `kind` default. If `_count`/`stops` are already included keep them; only ADD what is missing.
  Spec: extend the existing `findAllRoutes` describe with one test asserting the include shape
  is passed to prisma (mock-level, same style as the neighbouring tests).

### WP3 — Web: nav split, route guard, command palette

- **files:** `apps/web/app/(dashboard)/layout.tsx`, `apps/web/components/CommandPalette.tsx`
- **brief:** Split the single Dispatch group + DEV_MODE gating into per-feature gating.
  1. In `layout.tsx` add a "Deliveries" nav group BEFORE the "Dispatch" group in
     `OPERATOR_NAV`:

```ts
{
  kind: "group",
  label: "Deliveries",
  icon: Package /* or Truck — reuse an already-imported lucide icon */,
  children: [
    { kind: "leaf", label: "Plan delivery", href: "/deliveries/new", icon: MapPin },
    { kind: "leaf", label: "Delivery history", href: "/deliveries", icon: ScrollText /* any imported icon */ },
  ],
},
```

     NOTE the nav active-state check is `pathname.startsWith(child.href)` — with BOTH
     `/deliveries` and `/deliveries/new` as siblings, `/deliveries/new` would light both.
     Fix the active check for exact-vs-prefix: a child is active when
     `pathname === child.href || (pathname.startsWith(child.href + "/") && !siblingsHaveLongerMatch)`.
     Simplest correct implementation: compute the LONGEST matching child href per group and
     only highlight that one. Keep the change local to the nav child active computation.

2. `getNavForRole(role, canActAsDriver, devMode)` becomes
   `getNavForRole(role, canActAsDriver, { devMode, routesAccess, deliveryAccess })`:
   - Dispatch group shows when `devMode || routesAccess`.
   - Deliveries group shows when `devMode || deliveryAccess`.
   - Drivers leaf: keep inside Dispatch; when Dispatch is hidden but Deliveries shows,
     append `{ label: "Drivers", href: "/drivers" }` to the Deliveries group (drivers are
     needed by both features).
   - DRIVER role: `My Routes` shows when `devMode || routesAccess || deliveryAccess`
     (drivers run trips too).
   - `canActAsDriver` My-Routes splice: applies when the Dispatch group is visible (as now);
     if only Deliveries is visible, splice "My Routes" into Deliveries instead.
3. RouteGuard: replace `DEV_MODE_PREFIXES` with:

```ts
const GATED_PREFIXES: { prefix: string; need: "routes" | "delivery" | "either" }[] = [
  { prefix: "/dispatch", need: "routes" },
  { prefix: "/routes", need: "routes" },
  { prefix: "/deliveries", need: "delivery" },
  { prefix: "/drivers", need: "either" },
];
```

     with allowed(need) = `devMode || (need === "routes" ? routesAccess : need === "delivery"
     ? deliveryAccess : routesAccess || deliveryAccess)`. Redirect to `/dashboard` only when
     the relevant flags are RESOLVED and the path is not allowed (same resolved/fail-open
     discipline as today: use the `resolved` from the access hooks, never redirect while
     unresolved). Note: `/routes/trips*` redirect stubs (WP4) live under `/routes` — a
     delivery-only tenant deep-linking there must NOT bounce to /dashboard before the stub
     redirects; exempt exactly `/routes/trips` prefixed paths from the `/routes` gate (they
     immediately redirect to /deliveries which is then gated correctly).

4. Drive-mode + `g r`/`g d` chords + `SHORTCUTS` filter + the two `devMode` pushes at
   ~L1011/1014: gate on `routesAccess||devMode` (routes/drivers chords). Add nothing new.
5. CommandPalette: `act-plan-trip` action href becomes `/deliveries/new`; add
   `nav-deliveries` ("Go to Deliveries", href `/deliveries`). Replace the single
   `DEV_MODE_COMMAND_IDS` filter with per-feature sets:
   `ROUTES_COMMAND_IDS = ["nav-routes", "nav-drivers", "act-new-route"]` filtered by
   `routesAccess||devMode`; `DELIVERY_COMMAND_IDS = ["act-plan-trip", "nav-deliveries"]`
   filtered by `deliveryAccess||devMode`. Preserve the existing role allowlists untouched.

### WP4 — Web: /deliveries surface, page moves, /routes cleanup, orders gate

- **files:** `apps/web/app/(dashboard)/deliveries/page.tsx` (new),
  `apps/web/app/(dashboard)/deliveries/new/page.tsx` (new),
  `apps/web/app/(dashboard)/deliveries/_components/TripOriginPicker.tsx` (moved),
  `apps/web/app/(dashboard)/deliveries/_components/TripStopList.tsx` (moved),
  `apps/web/app/(dashboard)/deliveries/_components/TripSkippedPanel.tsx` (moved),
  `apps/web/app/(dashboard)/routes/trips/page.tsx` (becomes redirect stub),
  `apps/web/app/(dashboard)/routes/trips/new/page.tsx` (becomes redirect stub),
  `apps/web/app/(dashboard)/routes/page.tsx`, `apps/web/app/(dashboard)/orders/page.tsx`,
  `apps/web/lib/api/routes.ts`
- **brief:**
  1. `git mv` the builder (`routes/trips/new/page.tsx` → `deliveries/new/page.tsx`) and the
     three `_components` files; fix relative imports (TemplateRouteMap import path becomes
     `../../routes/templates/[id]/TemplateRouteMap`; `@/` imports unchanged). The builder's
     internal copy that referenced "trips" in user-facing text should say "delivery"
     (e.g. header "Plan a delivery"). Its discard/back navigation targets `/deliveries`.
  2. **`deliveries/page.tsx` = Delivery history.** Replace the old thin trips list with a
     history-first page (this is the owner's core ask: "all previous deliveries stored").
     Use `useRoutes({ kind: "ADHOC", page })` (now carrying `runs[0]` + `_count` from WP2).
     Table columns: Delivery (route name), Date (run.scheduledDate ?? createdAt), Driver
     (run.driver.contactName ?? "—"), Stops (`_count.stops`), Status, actions.
     Status derivation (write a tiny pure helper in the page file):
     `!runs[0]` → "Draft"; run.status SCHEDULED → "Dispatched"; IN_PROGRESS → "In progress";
     COMPLETED → "Delivered"; CANCELLED → "Cancelled". Pill styling mirrors the orders page
     status pills (navy/brand tokens). Row click → `/routes/${run.id ?? route.id}` behaviour:
     keep EXACTLY what the old trips list did for navigation (do not invent new detail pages).
     Draft rows keep the existing delete-with-inline-confirm affordance; dispatched/completed
     rows have NO delete and NO re-dispatch/reuse affordances of any kind (one-shot is the
     product rule). Header: title "Deliveries", primary Button "Plan delivery" →
     `/deliveries/new`. Empty state (Intent no-dead-ends): explains the feature in one
     sentence ("Plan one-shot delivery trips from selected orders — every past delivery stays
     here.") + two actions: "Plan delivery" and a ghost link "Pick orders" → `/orders`.
  3. **Redirect stubs** at the two old paths (keeps palette/bookmarks/e2e working):

```tsx
// apps/web/app/(dashboard)/routes/trips/new/page.tsx
import { redirect } from "next/navigation";
export default function LegacyTripBuilderRedirect() {
  redirect("/deliveries/new");
}
```

     (same shape for `routes/trips/page.tsx` → `/deliveries`). Delete the old
     `routes/trips/_components/` directory (moved).

4. `routes/page.tsx`: remove the whole "Trips (ad-hoc)" section (its `useRoutes({kind:
"ADHOC"...})` query, the `recentTrips` memo, and the JSX block) — this page is now purely
   recurring routes. Do not touch anything else on the page.
5. `orders/page.tsx`: the bulkbar "Plan delivery trip" gate changes from
   `useDeveloperMode().enabled` to `useDeliveryAccess().enabled`; its push target becomes
   `/deliveries/new?n=${ids.length}`. Nothing else changes.
6. `lib/api/routes.ts`: extend the `Route` type with the WP2 additions:
   `_count?: { runs: number; stops: number }` and
   `runs?: { id: string; status: string; scheduledDate?: string | null; completedAt?: string | null; driver?: { id: string; contactName?: string | null } | null }[]`.

### WP5 — Mobile: split gating, entries, labels

- **files:** `apps/mobile/app/(operator)/_layout.tsx`, `apps/mobile/lib/operator-tabs.ts`,
  `apps/mobile/app/(operator)/(tabs)/dispatch.tsx`, `apps/mobile/app/(operator)/(tabs)/orders/index.tsx`,
  `apps/mobile/app/(operator)/trips/index.tsx`, `apps/mobile/app/(operator)/trips/new.tsx`,
  `apps/mobile/__tests__/operator-tabs.test.ts`
- **brief:**
  1. `_layout.tsx`: replace the single `DEV_MODE_SECTIONS` redirect with per-feature sets:

```ts
const ROUTES_SECTIONS = new Set(["dispatch", "routes", "route-runs", "fleet"]);
const DELIVERY_SECTIONS = new Set(["trips"]);
const EITHER_SECTIONS = new Set(["drivers", "driver"]);
```

     Using the WP1 mobile access hooks: redirect to `/(operator)/home` when the section's
     access (devMode || featureAddon, using each hook's `enabled` once `resolved`/loading
     settles — keep the current `!devLoading && !devMode` fail-open style per hook) denies.

2. `operator-tabs.ts`: keep `trips: "dispatch"`. Find where the dispatch TAB itself is
   shown/hidden (grep `dispatch` in the tab bar component / operator-tabs). If the tab is
   gated on `useDeveloperMode`, widen to `devMode || routesAccess || deliveryAccess` so a
   delivery-only tenant still gets the tab (its hub will then show only delivery rows).
   If the tab is not gated at all, change nothing here.
3. `dispatch.tsx` (hub): the "Trips" section/row renames to "Order delivery" with row title
   "Plan & history" (still → `/(operator)/trips`). Gate the recurring rows
   (routes/route-runs/fleet) on `routesAccess||devMode` and the Order-delivery row on
   `deliveryAccess||devMode` so a single-feature tenant sees only their rows.
4. `orders/index.tsx`: the Select NavAction gate changes `useDeveloperMode` →
   `useDeliveryAccess` (WP1 mobile helper).
5. `trips/index.tsx`: screen title becomes "Deliveries"; ensure NO reuse/re-dispatch
   affordance exists (delete stays draft-only as-is); empty state copy: "Past deliveries
   will appear here. Plan one from the Orders tab." with a button to `/(operator)/(tabs)/orders`.
   `trips/new.tsx`: NavBar title "Plan delivery" (if it says trip).
6. `operator-tabs.test.ts`: keep the `trips → dispatch` assertions green (update only if
   the mapping changed — it should not).

### WP6 — Platform-admin toggles + demo seed

- **files:** `apps/web/app/(platform-admin)/admin/tenants/[id]/page.tsx`, `apps/api/scripts/demo-seed.js`
- **effort:** low
- **brief:** Add both addons to `AVAILABLE_ADDONS` (import the two constants from
  `@routeflow/types`), inserted before the Developer Mode entry:

```ts
{
  key: RECURRING_ROUTES_ADDON,
  name: "Recurring routes",
  description:
    "Standing route templates and scheduled dispatch — fixed customer rounds the tenant " +
    "re-runs (Dispatch → Routes). Independent of Order delivery; enable either or both.",
},
{
  key: ORDER_DELIVERY_ADDON,
  name: "Order delivery (ad-hoc trips)",
  description:
    "Plan one-shot delivery trips from selected orders: optimize the stop order, dispatch " +
    "to a driver, and keep the full delivery history. Trips are never reused. Independent " +
    "of Recurring routes; enable either or both.",
},
```

Update the Developer Mode description's parenthetical to "(master switch — unlocks every
in-development surface, including both delivery features, for this tenant; UI-only)".
demo-seed.js: add `recurring_routes` and `order_delivery` tenantAddon upserts next to the
existing `developer_mode`/`driver_payments` upserts (same shape, same idempotent update
branch) + one console log line each.

### WP7 — e2e spec 20 update

- **files:** `apps/web/e2e/20-trip-builder-gate.spec.ts`
- **brief:** Update the gate spec for the split: the flag union is now
  `addons.includes("developer_mode") || addons.includes("order_delivery")`; the deep link to
  assert is `/deliveries/new` (the legacy `/routes/trips/new` may be additionally asserted to
  land on `/deliveries/new` via the redirect stub in the enabled branch); the disabled branch
  asserts the bulkbar action is absent and `/deliveries/new` bounces to `/dashboard`. Keep it
  READ-ONLY (never click Build) and keep its playwright project name (`trip-builder-gate`)
  and file name unchanged.

### WP8 — Code map + CHANGELOG

- **files:** `.claude/code-map/web.md`, `.claude/code-map/mobile.md`, `.claude/code-map/api.md`,
  `.claude/code-map/packages.md`, `.claude/code-map/INDEX.md`, `.claude/code-map/CHANGELOG.md`,
  `.claude/code-map/_meta.json`
- **effort:** low
- **dependsOn:** WP1–WP7
- **brief:** Surgical updates: INDEX "Developer mode" row gains the two new addons + the
  split-gating story; web.md routes/deliveries entries reflect the moves + nav split; mobile.md
  the section-set split; packages.md the two constants; api.md findAllRoutes include note.
  Add ONE dated bullet at the TOP of CHANGELOG.md summarising the split; REPLACE `_meta.json`
  notes with that note's pointer + bump `generatedAt` (never accumulate).

## Acceptance criteria

1. `packages/types` exports `RECURRING_ROUTES_ADDON = "recurring_routes"` and
   `ORDER_DELIVERY_ADDON = "order_delivery"`; web + mobile each gain the two hooks + two
   access helpers; `useDeveloperMode` is byte-unchanged in both files.
2. A tenant with ONLY `order_delivery`: sees the Deliveries nav group (+ Drivers appended),
   `/deliveries` + `/deliveries/new` reachable, `/routes` + `/dispatch` redirect to
   /dashboard, orders bulkbar shows "Plan delivery trip". A tenant with ONLY
   `recurring_routes`: Dispatch group visible, `/deliveries` redirects, orders bulkbar action
   absent. A `developer_mode` tenant sees everything (regression-free).
3. `/routes` page contains NO trips section; `/routes/trips` and `/routes/trips/new` redirect
   to `/deliveries` and `/deliveries/new`.
4. `/deliveries` lists ADHOC routes with Date / Driver / Stops / Status (Draft, Dispatched,
   In progress, Delivered, Cancelled) derived from the latest run; drafts deletable with
   confirm; NO re-dispatch/reuse affordance on any row; empty state has copy + two entry
   actions.
5. `findAllRoutes` response additionally carries `_count` and latest-run summary; filtering,
   pagination and the SCHEDULED default are byte-unchanged (existing specs still green).
6. Mobile: section gating matches criterion 2 per platform; dispatch hub shows only the rows
   the tenant's addons allow; orders Select gated on delivery access; trips screens titled
   Deliveries/Plan delivery; driver app untouched (`git diff --stat` shows nothing under
   `apps/mobile/app/(driver)/`).
7. Platform-admin Addons tab lists both new addons with the copy above; demo-seed grants both.
8. e2e 20 asserts the union flag + new URLs, remains read-only, project name unchanged.
9. Full `npm run verify` green.

## Verification commands

- perRound: `npx tsc -p apps/api/tsconfig.build.json --noEmit`
- final: `npm run verify`
  (Playwright is NOT part of the gate — spec 20 is review-only here; it runs in CI.)

## Risks & rollback

- **Nav active-state regression** (WP3's longest-match fix) — verify `/routes` vs
  `/routes/my-runs` and `/deliveries` vs `/deliveries/new` in review; the fix must not change
  which single leaf lights for existing paths.
- **Stranding via unresolved flags** — every new redirect must respect `resolved` (fail-open
  while unknown), copying today's RouteGuard discipline; reviewer must check each gate.
- **The `/routes/trips` stub exemption** — without it a delivery-only tenant bounces to
  /dashboard instead of reaching the redirect; reviewer must verify the exemption exists and
  is narrow (`/routes/trips` prefix only).
- **Import breakage from the file moves** — builder imports `TemplateRouteMap` and `@/lib/*`;
  web tsc catches it; movers must run tsc before finishing.
- Rollback: single squash commit revert; no schema, no data writes.
