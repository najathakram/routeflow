# Plan: Hide dispatch/driver/route features behind a per-tenant `developer_mode` addon

> Authored by Fable 5 on 2026-08-20. Status: SHIPPED
> This file is the ONLY context the implementation and review agents receive.
> It must stand alone: no references to "the conversation", no "as discussed".

## Objective

The dispatch/driver/route feature set (web Dispatch nav group + `/dispatch` `/routes` `/drivers` pages; mobile driver role, operator Dispatch tab, driver/route/fleet screens) is not ready for customers. Hide it in the UI for every tenant EXCEPT tenants that have a new hidden platform-admin-toggled `TenantAddon` with key `developer_mode`. The owner's live tenant `acme` actively uses driver delivery flows in production and will have the addon enabled BEFORE this build deploys, so nothing may break for dev-mode tenants — including their pure-DRIVER-role users. Hiding is UI-only (no API endpoint gating) and must be cleanly reversible: every gate goes through one hook (`useDeveloperMode`) so a grep enumerates all of them at launch time.

## Constraints & conventions

- npm + Turbo monorepo. API: NestJS 11 (`apps/api`). Web: Next.js 14 App Router (`apps/web`). Mobile: Expo 55 / expo-router with role groups `(auth)/(customer)/(driver)/(operator)/(tenant)` (`apps/mobile`). Shared types: `packages/types` (`@routeflow/types`).
- Prettier: semicolons, double quotes, printWidth 100, trailing commas. Match surrounding code style; sparse comments only for non-obvious constraints.
- Tests: Jest for api and mobile (`*.spec.ts` / `__tests__/*.test.ts`, pure-logic only on mobile — no react-native rendering in tests). NO Vitest, NO snapshot tests.
- Mobile mirrors web patterns: `apps/mobile/lib/api/tobacco.ts` is a deliberate mirror of `apps/web/lib/api/tobacco.ts` (both expose `useTenantAddons()` / `useHasAddon(key)` hitting `GET /tenants/me/addons` with TanStack Query, query key `["tenant", "addons"]`, 5-min staleTime). Read those two files first and mirror their access patterns exactly — do not invent a new fetch shape.
- The addon mechanism is the LEGACY free-text `TenantAddon.addonKey` system (`apps/api/src/billing/addon.service.ts`, `AddonGuard`), NOT the newer plan-catalog/entitlements system. Do not touch `EntitlementsService`, `PlanFlagGuard`, or seed any catalog.
- Do NOT add `@RequireAddon("developer_mode")` to any drivers/routes/route-optimization controller. UI-only hiding is deliberate: ungated APIs mean un-gated leftover surfaces degrade to empty states instead of 403 error toasts.
- Do NOT edit `apps/web/lib/drive-mode.tsx` (its localStorage state stays; only its UI entry points get gated).
- Do NOT edit anything under `apps/web/app/(dashboard)/dispatch/`, `.../routes/`, `.../drivers/` or `apps/mobile/app/(driver)/` — route guards/layout chokepoints cover them.
- Never reference live client tenant names in code, tests, fixtures, or script defaults — the rollout script takes slugs as CLI arguments and hardcodes none.

## Work packages

### WP1 — Shared constant, hooks, API role widening

- **files:** `packages/types/index.ts`, `apps/web/lib/api/addons.ts` (new), `apps/mobile/lib/api/addons.ts` (new), `apps/api/src/billing/plan-catalog.constants.ts`, `apps/api/src/tenants/tenants.controller.ts`, `apps/api/src/tenants/tenants.controller.spec.ts` (new or extend if exists)
- **brief:**
  1. `packages/types/index.ts` — append the exported constant (exact code below).
  2. `apps/web/lib/api/addons.ts` — NEW file exporting `useDeveloperMode(): { enabled: boolean; isLoading: boolean }`. Import and compose the existing `useTenantAddons()` from `apps/web/lib/api/tobacco.ts` (same query cache). Determine `enabled` using the exact same data-access pattern `useHasAddon` uses in that file (read it; the addon list item shape must match). Docblock must state: "To un-hide everything at launch: grep useDeveloperMode and delete the gate conditions (or make this return { enabled: true, isLoading: false })."
  3. `apps/mobile/lib/api/addons.ts` — NEW file, same exported shape, but mirroring `apps/mobile/lib/api/tobacco.ts`'s own fetch pattern with TWO differences: pass `enabled: isAuthenticated` to the query (get auth state the same way other mobile hooks do — check `apps/mobile/lib/` stores; there is a `useAuthStore`), and compute `isLoading` as `isAuthenticated && query.isPending` (with `enabled: false`, TanStack v5 `isPending` stays true forever — never report that as loading). Use the SAME query key as mobile's `useTenantAddons` so the cache is shared.
  4. `apps/api/src/billing/plan-catalog.constants.ts` — next to `LEGACY_ADDON_KEY_TO_SKU`, add a comment noting the pending bridge: `developer_mode` → future DEV_MODE AddonSku granting `flag.dispatch_live` (do not add the mapping itself yet — no DEV_MODE SKU exists).
  5. `apps/api/src/tenants/tenants.controller.ts` line ~45: the `GET me/addons` route (`getMyAddons`) currently has `@Roles(UserRole.OPERATOR)`. Widen to `@Roles(UserRole.OPERATOR, UserRole.DRIVER)`. This is load-bearing: pure DRIVER-role users currently 403 on this endpoint, and dev-mode tenants' drivers must be able to read the flag.
  6. Spec: assert via reflection that the roles metadata on `getMyAddons` includes both OPERATOR and DRIVER (pattern: read `ROLES_KEY` metadata with `Reflector`/`Reflect.getMetadata`, as other guard specs in the repo do — see e.g. `apps/api/src/**/test-tenants.guard.spec.ts` style if present, else any spec reading route metadata).
- **exact code** (packages/types/index.ts append):

```ts
/**
 * Legacy TenantAddon.addonKey for the hidden platform-admin "developer mode" flag.
 * Unlocks in-development dispatch/driver/route surfaces on web + mobile.
 * Bridge-to-catalog (later): LEGACY_ADDON_KEY_TO_SKU -> DEV_MODE sku granting flag.dispatch_live.
 */
export const DEVELOPER_MODE_ADDON = "developer_mode";
```

### WP2 — Web gating

- **files:** `apps/web/app/(dashboard)/layout.tsx`, `apps/web/app/(dashboard)/dashboard/page.tsx`, `apps/web/components/CommandPalette.tsx`
- **brief:** Import `useDeveloperMode` from `@/lib/api/addons` (WP1 defines it; code against the contract `{ enabled, isLoading }` even though the file is authored in a parallel package).
  1. **`layout.tsx` — nav**: `getNavForRole(role, canActAsDriver)` (~line 159) gains a third param `devMode: boolean`. When `!devMode`: (a) filter the group labeled "Dispatch" out of the OPERATOR nav array; (b) return the DRIVER nav array WITHOUT its "My Routes" (`/routes`) leaf — a non-dev DRIVER sees Dashboard + Settings only; (c) skip the `canActAsDriver` "My Routes" (`/routes/my-runs`) splice. Sole caller is `DashboardShell` (~line 832): call `const { enabled: devMode } = useDeveloperMode()` there, pass it through, and add it to the `navStructure` useMemo dependency array (this memo already conditionally splices Tobacco/Regulated groups — same pattern).
  2. **`layout.tsx` — RouteGuard** (~line 195): alongside the existing `CUSTOMER_ALLOWED`/`DRIVER_ALLOWED` prefix lists add `const DEV_MODE_PREFIXES = ["/dispatch", "/routes", "/drivers"];`. In the guard effect, AFTER the existing role checks: if `!devLoading && !devMode` and the pathname matches one of those prefixes (reuse the file's existing prefix-match helper if one exists, else `pathname === p || pathname.startsWith(p + "/")`), `router.replace("/dashboard")`. The `!devLoading` guard is mandatory — without it a dev-mode tenant deep-linking to `/routes` gets bounced while the addons query is in flight. Add `devMode`, `devLoading` to the effect deps.
  3. **`layout.tsx` — keyboard shortcuts** (~lines 946–987): the `g r` (routes) / `g d` (drivers) chord handlers only fire when `devMode`; the SHORTCUTS help list drops "Go to Routes"/"Go to Drivers" entries when `!devMode` (make the list a useMemo over `devMode` if it is currently a static constant).
  4. **`layout.tsx` — Header**: inside the `Header` component call `useDeveloperMode()`; gate the topbar drive-mode pill (~524–534) with `devMode &&` and the avatar-menu "Drive mode" item (~744–757) with `canActAsDriver && devMode`.
  5. **`dashboard/page.tsx`**: call `useDeveloperMode()` once at the top. (a) ~line 509: fold into the existing capability line so it reads `const canActAsDriver = user?.canActAsDriver === true && baseIsOperator && devMode;` (adapt to the actual expression; the intent is: devMode false ⇒ canActAsDriver false, which hides the ModeSwitcher at ~618 and the driver viewMode branch). (b) Wrap the "New Route" quick-create button (~644–647) in `{devMode && ...}`. (c) "Scheduled Routes" StatCard (~712–724): AND its render condition with `devMode`. (d) "Active Drivers" StatCard (~726–736): same. (e) "Scheduled Route Runs" card (~885–919): gate the whole Card behind `devMode` (this subsumes its Driver column). (f) "Driver Status" Card (~925–966): gate ONLY that Card — the LowStockPanel that follows (~969) must stay.
  6. **`CommandPalette.tsx`**: `useStaticCommands` (~line 67) is a hook — call `useDeveloperMode()` inside it and filter out the commands with ids `nav-routes` (~94), `nav-drivers` (~100), `act-new-route` (~222) when `!enabled`; add `enabled` to its memo deps.
  - Line numbers are approximate anchors from a recent read — locate by the named symbols/labels, not by counting lines.

### WP3 — Mobile gating

- **files:** `apps/mobile/app/_layout.tsx`, `apps/mobile/app/(auth)/role-picker.tsx`, `apps/mobile/lib/operator-tabs.ts`, `apps/mobile/components/OperatorTabBar.tsx`, `apps/mobile/app/(operator)/_layout.tsx`, `apps/mobile/app/(operator)/(tabs)/home.tsx`, `apps/mobile/app/(operator)/(tabs)/more.tsx`, `apps/mobile/app/(tenant)/_layout.tsx`, `apps/mobile/__tests__/operator-tabs.test.ts`
- **brief:** Import `useDeveloperMode` from `../lib/api/addons` (WP1 authors it in parallel; contract `{ enabled, isLoading }`).
  1. **`app/_layout.tsx` `RootLayoutNav`**: call the hook (component is inside QueryClientProvider; hook self-disables pre-auth). In the role-routing effect's `activeRole === "driver"` branch (~lines 167–172), before the existing replace to `/(driver)/route`:

```ts
if (activeRole === "driver") {
  if (devLoading) return; // bootstrapping spinner covers this
  if (!devMode) {
    if (user.role === "DRIVER") {
      // pure driver of a non-dev tenant: no driver UI exists for them
      router.replace("/(auth)/operator-blocked");
      return;
    }
    setActiveRole("operator"); // dual-role user snaps back; effect re-runs into the operator branch
    return;
  }
  // ...existing driver routing unchanged...
}
```

Adapt names to the file (`setActiveRole` comes from the same auth store the file already uses). Extend the `bootstrapping` condition (~line 189) with `|| (!!user && activeRole === "driver" && devLoading)` so the existing spinner covers the in-flight addons query (no driver UI flash). Add `devMode`/`devLoading` to the effect deps. 2. **`(auth)/role-picker.tsx`**: gate the Driver hero card (and its `useScheduledRouteRuns` fetch, if trivially gateable via its `enabled` option) behind `useDeveloperMode().enabled`; when disabled, auto-select operator: `setActiveRole("operator"); router.replace("/(operator)/home")`. (Screen appears orphaned — defense in depth.) 3. **`lib/operator-tabs.ts`**: add a pure helper next to the existing tab constants (adapt to the actual exported names/types in the file):

```ts
export function visibleOperatorTabs(devMode: boolean): OperatorTabKey[] {
  return devMode ? [...OPERATOR_TABS] : OPERATOR_TABS.filter((t) => t !== "dispatch");
}
```

4. **`components/OperatorTabBar.tsx`**: build the tab items from `visibleOperatorTabs(enabled && !isLoading)` — **default-hidden while loading** so non-dev tenants never see the Dispatch tab flash-then-vanish (dev tenants get a sub-second late appearance on cold start only; cached afterwards).
5. **`(operator)/_layout.tsx`**: single deep-link chokepoint instead of guarding ~15 screens. Using `useSegments()`, derive the first meaningful segment after `(operator)` (mirror how `activeOperatorTab`/existing code derives it; note the tabs live under a `(tabs)` group, so when `segments[1] === "(tabs)"` inspect `segments[2]`). If it is one of `dispatch, routes, route-runs, drivers, driver, fleet` while `!devLoading && !devMode`, `return <Redirect href="/(operator)/home" />;` (import `Redirect` from expo-router). ALL hooks must stay above this conditional return.
6. **`(operator)/(tabs)/home.tsx`**: gate behind `devMode`: the operator/driver mode bar (~140–171; when `!devMode` also force the local `viewMode` to `"operator"` so `DriverInlineView` can never render), the "DISPATCH READINESS" hero section (~178+), and the "Routes today" section (~278).
7. **`(operator)/(tabs)/more.tsx`**: gate the Routes (~156), Fleet (~164), Drivers (~172) list rows and the "Drive mode" row (~269–281, AND with its existing `canActAsDriver` condition) behind `devMode`.
8. **`(tenant)/_layout.tsx`**: the dispatch `Tabs.Screen` gets `options={{ href: devMode ? undefined : null, ...existing }}` (expo-router `href: null` removes a tab).
9. **`__tests__/operator-tabs.test.ts`**: extend (or create beside existing mobile tests) with pure-logic cases: `visibleOperatorTabs(true)` returns all tabs including `"dispatch"`; `visibleOperatorTabs(false)` returns the same list minus `"dispatch"` with order preserved. Pure node Jest — no react-native imports.

### WP4 — Platform-admin toggle, rollout script, e2e seed + canary

- **files:** `apps/web/app/(platform-admin)/admin/tenants/[id]/page.tsx`, `scripts/enable-developer-mode.mjs` (new), `apps/api/scripts/e2e-seed.js`, `apps/web/e2e/02-operator.spec.ts`
- **brief:**
  1. **Admin toggle**: in `admin/tenants/[id]/page.tsx` (~line 94) append to the `AVAILABLE_ADDONS` array: `{ key: DEVELOPER_MODE_ADDON, name: "Developer Mode", description: "Unlock in-development features (dispatch, routes, drivers) for this tenant" }` — import the constant from `@routeflow/types`. No API change needed: the enable/disable endpoints accept free-text addon keys, and leaving `stripePriceId` unset means no Stripe item is created.
  2. **Rollout script** `scripts/enable-developer-mode.mjs` (new, repo root `scripts/`): a one-off Node ESM script that upserts an ACTIVE `TenantAddon` row with `addonKey: "developer_mode"` for tenant slugs passed as CLI args (e.g. `node scripts/enable-developer-mode.mjs test e2e-routeflow acme`). Model the Prisma bootstrapping on `apps/api/scripts/e2e-seed.js` (same client import/instantiation pattern; reads `DATABASE_URL` from env — NEVER hardcode a connection string). Read `apps/api/src/billing/addon.service.ts` FIRST to learn what an "active" TenantAddon row looks like (which columns `hasAddon`/`getActiveAddons` filter on) and write exactly that shape. Safety — follow the house live-tenant pattern from `apps/api/scripts/wipe-tenant-fresh-start.js` exactly: import `isTestTenant` from `scripts/lib/test-tenants.cjs`, default to a DRY RUN, require `--execute` to write, require `--live-tenant-override` on top of that for any non-test slug, and require a type-back confirmation of the slug(s) before applying. Do NOT invent a weaker guard and do NOT assert any authorization in comments. Note in the header that the platform-admin UI (Tenant → Addons & Features → Developer Mode) is the preferred route for live tenants and that the write is additive/reversible. Idempotent (upsert / update-if-exists). Print one line per tenant: slug, create|reactivate|already-active|missing.
  3. **e2e seed**: `apps/api/scripts/e2e-seed.js` — add an idempotent `tenantAddon` upsert (`addonKey: "developer_mode"`, active shape as above) in BOTH the existing-tenant path (~line 42+) and the fresh-create path (~line 122+), so CI re-seeds keep dev mode ON for `e2e-routeflow` (the Playwright suite exercises `/routes`).
  4. **Playwright canary**: in `apps/web/e2e/02-operator.spec.ts`, add one cheap spec near the top of the operator suite asserting the sidebar shows the "Dispatch" nav group (e2e tenant has the addon ⇒ visible). This catches a broken seed row with a clear failure before the existing OP-10 `/routes` spec fails vaguely. Follow the file's existing selector/fixture conventions.

## Acceptance criteria

1. `packages/types/index.ts` exports `DEVELOPER_MODE_ADDON = "developer_mode"`; web hook, mobile hook, and admin page all import it (zero string literals of `"developer_mode"` outside `packages/types`, the rollout script, and `e2e-seed.js` — scripts may inline it since they don't build against the workspace).
2. `GET /tenants/me/addons` roles metadata includes OPERATOR and DRIVER; a spec asserts it.
3. Web, non-dev tenant: no "Dispatch" nav group; `/dispatch`, `/routes`, `/drivers` (and subpaths) redirect to `/dashboard`; `g r`/`g d` shortcuts inert and absent from the shortcuts list; command palette has no routes/drivers/new-route commands; dashboard shows no New Route button, no Scheduled Routes / Active Drivers StatCards, no Scheduled Route Runs card, no Driver Status card (LowStockPanel still present); no drive-mode pill or menu item.
4. Web, dev tenant: all of the above visible exactly as before this change; deep link to `/routes` does NOT bounce during the addons fetch (the `!devLoading` guard).
5. Mobile, non-dev tenant: DRIVER-role login lands on `operator-blocked`, never `(driver)/*`; dual-role user with stale driver activeRole snaps to operator; operator tab bar never shows Dispatch (not even a flash on cold start); deep links to dispatch/routes/route-runs/drivers/driver/fleet redirect to operator home; home screen shows no mode bar / DISPATCH READINESS / Routes-today; More shows no Routes/Fleet/Drivers/Drive-mode rows; tenant group shows no Dispatch tab.
6. Mobile, dev tenant: driver login reaches `(driver)/route` (spinner during the addons fetch, no operator-blocked flash); operator sees the Dispatch tab (late appearance on first cold load acceptable).
7. `(driver)/**`, dispatch/routes/drivers page directories, and `lib/drive-mode.tsx` have zero diff. No `@RequireAddon` added to any drivers/routes/route-optimization controller.
8. `visibleOperatorTabs` is pure, tested for both branches, and `OperatorTabBar` consumes `enabled && !isLoading`.
9. Admin tenants page lists "Developer Mode" in AVAILABLE_ADDONS wired to the existing enable/disable actions.
10. `scripts/enable-developer-mode.mjs` refuses non-test slugs without `ALLOW_LIVE_TENANT=<slug>`, is idempotent, and writes the exact row shape `AddonService.hasAddon` matches on; `e2e-seed.js` upserts the addon in both paths.
11. New Playwright canary asserts the Dispatch nav group for the e2e tenant; no existing spec is modified except that file's addition.

## Verification commands

- `npm run verify` (turbo: check-types + lint + test across workspaces — the Jest additions in WP1/WP3 run here)

(Playwright e2e is NOT part of the gate — it needs a running stack; the canary lands in the diff and runs in CI/nightly.)

## Risks & rollback

- **Biggest risk:** acme's drivers locked out. Mitigations baked in: roles widening (WP1.5), the rollout script running against the deployed API BEFORE this build ships, and the `!devLoading` spinner/guard patterns. Reviewers: treat any code path where a dev-mode tenant could see hidden UI or a blocked driver as a blocker.
- **Flash of hidden UI:** tab bar defaults hidden while loading; web nav renders without Dispatch until the query resolves (acceptable — matches the existing Tobacco-leaf late-splice precedent).
- **CI breakage:** OP-10 exercises `/routes`; the e2e-seed change MUST land in this same PR.
- **Rollback:** revert the PR (UI-only); the TenantAddon rows are inert without the gating code. Launch reversal later = grep `useDeveloperMode`, delete conditions.
