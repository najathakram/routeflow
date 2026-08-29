# Narrow developer_mode + server-side enforcement for dispatch feature addons

Status: PLANNED
Branch: feat/dispatch-addon-enforcement (off origin/master @ 227c1267+)
Date: 2026-08-28

## Context

RouteFlow gates its two delivery products per tenant via legacy `TenantAddon.addonKey` rows:
`recurring_routes` (standing route templates, Dispatch → Routes) and `order_delivery` (ad-hoc
trips, Dispatch → Order delivery). A third key, `developer_mode`, was a master switch that
unlocked BOTH features client-side (`devMode || feature` in every gate), which made the
platform-admin feature toggles a no-op for any tenant with dev mode on (e.g. routeflow-demo).
There was also ZERO server-side enforcement: `/routes`, `/route-runs`, `/trips`, `/drivers`,
and route-optimization endpoints only check JWT + role.

Owner decisions (2026-08-28, this session):

1. `developer_mode` must STOP unlocking the two GA delivery features. It remains only for
   genuinely in-development surfaces (today: the mobile `(driver)` app section, the mobile
   role-picker driver option, the mobile `(tenant)` dispatch tab, mobile drive-mode switches).
2. The dispatch API surface gets server-side addon enforcement (403), mirroring the
   `driver_payments` precedent.
3. Seeds must stop force-re-enabling feature addons that a platform admin turned off.
4. The demo tenant keeps `developer_mode` ON (its mobile driver walkthrough needs it); after
   this change that no longer leaks into the web UI.

## Non-negotiable project rules

- API code NEVER imports `@routeflow/types` at runtime (pinned by
  `apps/api/src/common/no-runtime-workspace-imports.spec.ts`) — use string literals in API
  source, exactly like `driver-payments.guard.ts` does.
- Prettier: semicolons, double quotes, printWidth 100, trailing commas.
- Jest for api/mobile; NO new test frameworks. Web is Playwright-only (do NOT add web unit tests).
- Match surrounding comment style; these files carry dense "owner decision" comments — update
  stale ones you touch, do not delete history-bearing comments wholesale.

## Work packages

### WP1 — API: multi-key `@RequireAddon` (any-of semantics)

Files:

- `apps/api/src/billing/require-addon.decorator.ts`
- `apps/api/src/billing/addon.guard.ts`
- `apps/api/src/billing/addon.guard.spec.ts`

Change the decorator to variadic (existing single-key call sites in
`apps/api/src/regulated/regulated.controller.ts` and `apps/api/src/tobacco/tobacco.controller.ts`
stay source-compatible — do NOT edit them):

```ts
export const RequireAddon = (...addonKeys: string[]) => SetMetadata(REQUIRE_ADDON_KEY, addonKeys);
```

In `addon.guard.ts`, accept both legacy string metadata and the new array, and resolve
any-of with ONE DB round-trip via `AddonService.getActiveAddons(tenantId)` (check its exact
return shape in `apps/api/src/billing/addon.service.ts` L54-60 — it backs
`GET /tenants/me/addons` which returns `{ addons: string[] }`; map rows to keys if needed):

```ts
const raw = this.reflector.getAllAndOverride<string | string[] | undefined>(REQUIRE_ADDON_KEY, [
  context.getHandler(),
  context.getClass(),
]);
const keys = typeof raw === "string" ? [raw] : raw;
if (!keys || keys.length === 0) return true;

const request = context.switchToHttp().getRequest<{ user?: { tenantId?: string | null } }>();
const tenantId = request.user?.tenantId ?? null;
// SUPER_ADMIN operates without a tenant — never addon-gated
if (tenantId == null) return true;

const active = await this.addonService.getActiveAddons(tenantId); // one query for any-of
if (keys.some((k) => active.includes(k))) return true;
throw new ForbiddenException(
  keys.length === 1
    ? `This feature requires the "${keys[0]}" add-on.`
    : `This feature requires one of these add-ons: ${keys.map((k) => `"${k}"`).join(", ")}.`,
);
```

(If `getActiveAddons` returns row objects, adapt: `active.map((a) => a.addonKey)`. If it does
not exist with that exact name/signature, fall back to looping `hasAddon` per key — correctness
over micro-optimization.)

Extend `addon.guard.spec.ts` (keep the existing style — the guard is constructed directly):

- multi-key metadata, tenant has the second key → allows
- multi-key metadata, tenant has none → throws ForbiddenException
- legacy single-string metadata still works
- no metadata → allows; null tenantId → allows

Acceptance criteria:

- [ ] `RequireAddon("a")` and `RequireAddon("a", "b")` both compile and store metadata
- [ ] Guard passes when ANY listed addon is active; 403 when none
- [ ] regulated/tobacco controllers untouched and still typecheck
- [ ] addon.guard.spec.ts covers the four cases above and passes

### WP2 — API: gate the dispatch controllers (dependsOn: WP1)

Files:

- `apps/api/src/routes/routes.controller.ts` (RoutesController + RouteRunsController)
- `apps/api/src/trips/trips.controller.ts`
- `apps/api/src/trips/trips.module.ts`
- `apps/api/src/drivers/drivers.controller.ts`
- `apps/api/src/drivers/drivers.module.ts`
- `apps/api/src/route-optimization/route-optimization.controller.ts` (two controller classes)
- `apps/api/src/route-optimization/route-optimization.module.ts`
- NEW `apps/api/src/routes/dispatch-addon-gate.spec.ts`

Gating map (class-level, string literals — never `@routeflow/types`):

| Controller (prefix)                                      | Decorators to add                                                       |
| -------------------------------------------------------- | ----------------------------------------------------------------------- |
| RoutesController (`/routes`)                             | `@RequireAddon("recurring_routes", "order_delivery", "developer_mode")` |
| RouteRunsController (`/route-runs`)                      | same either-gate                                                        |
| DriversController (`/drivers`)                           | same either-gate                                                        |
| route-optimization `/route-runs` + `/routes` controllers | same either-gate                                                        |
| TripsController (`/trips`)                               | `@RequireAddon("order_delivery", "developer_mode")`                     |

Rationale (bake into a short comment at each class): `/routes`, `/route-runs`, `/drivers`, and
optimization are SHARED between the two features — an ad-hoc delivery materializes a route
template + run, so runs/detail/optimize/complete flows must work for a delivery-only tenant
(mirrors `RECURRING_ROUTES_PATHS` in `apps/web/app/(dashboard)/layout.tsx` L258-295, which
downgrades everything under `/routes` except the list/create pages to "either"). `/trips` is the
ad-hoc builder and is order_delivery-only. `developer_mode` stays accepted SERVER-side so a dev
tenant can exercise the still-in-development mobile driver app end-to-end; it no longer unlocks
any GA client UI (that's the web/mobile packages). Per-endpoint recurring-vs-either splitting is
deliberately NOT attempted server-side in this pass.

Mechanics:

- `AddonGuard` must be added to each class's `@UseGuards` AFTER `JwtAuthGuard` (it reads
  `request.user`; guards run before TenantInterceptor, so never `prisma.getTenantId()` — see
  header comment in `addon.guard.ts`). Precedent: `apps/api/src/tobacco/tobacco.controller.ts`
  L17-19 (`@UseGuards(JwtAuthGuard, RolesGuard, AddonGuard)` + class-level `@RequireAddon`).
- routes.controller.ts: class currently has `@UseGuards(JwtAuthGuard)` with method-level
  RolesGuard — change class to `@UseGuards(JwtAuthGuard, AddonGuard)` on BOTH controller
  classes. Method-level `@UseGuards(RolesGuard)` and the `DriverPaymentsGuard` on
  complete-with-payment stay as-is.
- trips.controller.ts: class has `@UseGuards(JwtAuthGuard, RolesGuard)` → append `AddonGuard`.
- drivers.controller.ts: class `@UseGuards(JwtAuthGuard)` → append `AddonGuard` (method
  RolesGuard decorators stay).
- route-optimization.controller.ts: both classes have `@UseGuards(JwtAuthGuard, RolesGuard)` →
  append `AddonGuard`.
- Module wiring: `apps/api/src/routes/routes.module.ts` already imports `BillingModule` (L19).
  Add `BillingModule` to the `imports` of trips.module.ts, drivers.module.ts, and
  route-optimization.module.ts IF not already present (`BillingModule` exports AddonGuard +
  AddonService — `apps/api/src/billing/billing.module.ts` L48).
- NEW spec `apps/api/src/routes/dispatch-addon-gate.spec.ts`: reflection test that reads
  `Reflect.getMetadata("requireAddon", Controller)` for the five controller classes and asserts
  the exact key arrays above (import the controllers; import REQUIRE_ADDON_KEY from
  `../billing/require-addon.decorator`). This pins the gate against accidental removal.

Acceptance criteria:

- [ ] All five controllers carry class-level AddonGuard + RequireAddon per the table
- [ ] Guard ordering: AddonGuard listed after JwtAuthGuard in every class @UseGuards
- [ ] trips/drivers/route-optimization modules import BillingModule; API builds (`tsc -p apps/api/tsconfig.build.json` clean)
- [ ] dispatch-addon-gate.spec.ts asserts the metadata for all five classes and passes
- [ ] No API file imports @routeflow/types

### WP3 — Web: developer_mode stops unlocking delivery surfaces

Files:

- `apps/web/lib/api/addons.ts`
- `apps/web/app/(dashboard)/layout.tsx`
- `apps/web/app/(dashboard)/dashboard/page.tsx`
- `apps/web/app/(dashboard)/dispatch/page.tsx`
- `apps/web/components/CommandPalette.tsx`

1. `lib/api/addons.ts`: narrow both composition helpers (KEEP the return shape so call sites
   don't change; keep `useDeveloperMode` exported — mobile-mirror parity and future in-dev
   surfaces):

```ts
/** Order-delivery surface visibility — the feature addon alone (owner decision 2026-08-28:
 *  developer_mode no longer unlocks GA delivery features; it remains only for genuinely
 *  in-development surfaces, none of which exist on web today). */
export function useDeliveryAccess(): { enabled: boolean; resolved: boolean } {
  const od = useOrderDelivery();
  return { enabled: od.enabled, resolved: od.resolved };
}

export function useRoutesAccess(): { enabled: boolean; resolved: boolean } {
  const rr = useRecurringRoutes();
  return { enabled: rr.enabled, resolved: rr.resolved };
}
```

Also update the two stale comment blocks (L25-31 "devMode is never missed" and L47-51
"`developer_mode` must keep unlocking both") to the 2026-08-28 decision.

2. `app/(dashboard)/layout.tsx` — remove every `devMode` read/use (after this file's edits,
   `useDeveloperMode` should no longer be imported here):
   - `getNavForRole` (L179-234): change the `access` param type to
     `{ routesAccess: boolean; deliveryAccess: boolean }`; L189 →
     `if (!(routesAccess || deliveryAccess))`; L196 →
     `const showDispatchGroup = routesAccess || deliveryAccess;`; L207 → `return routesAccess;`
     branch, L208 → `deliveryAccess`.
   - RouteGuard (L297-351): delete the `useDeveloperMode()` read (L301) and drop `devMode ||`
     from `allowedByGate` (L329-335); remove `devMode` from the effect dep array.
   - Topbar (L650, L685): delete the `useDeveloperMode()` read; L685 → `{routesAccess && driveMode && (`.
   - Avatar menu (L905-906): condition → `canActAsDriver && routesAccess`.
   - DashboardShell (L1007, L1013-1018): delete devMode read; pass only
     `{ routesAccess, deliveryAccess }` to getNavForRole; fix the memo dep array.
   - Keyboard shortcuts (L1153-1157, L1178, L1193-1197): `gr`/`gd` gate on `routesAccess`
     alone; SHORTCUTS filter on `routesAccess`; fix both dep arrays.
3. `dashboard/page.tsx` (L504, L521): delete the devMode read;
   `canActAsDriver = user?.canActAsDriver === true && baseIsOperator && routesAccess;`
   Update the L505-509 comment (it references the union with devMode). Remove the
   `useDeveloperMode` import if now unused.
4. `dispatch/page.tsx` (L294-298): delete devMode read; `const showRoutes = routesAccess;`
   `const showDelivery = deliveryAccess;` Remove unused import.
5. `CommandPalette.tsx` (L78 + every use of `devMode` below): delete the devMode read and drop
   `devMode ||` from the ROUTES_COMMAND_IDS / DELIVERY_COMMAND_IDS gating conditions (grep
   `devMode` within the file — update the L69-73 doc comment too). Remove unused import.

Acceptance criteria:

- [ ] `git grep -n "useDeveloperMode" apps/web` matches ONLY `lib/api/addons.ts` (the definition)
- [ ] No behavior change for a tenant with a feature addon and no dev mode (conditions reduce to the same booleans)
- [ ] Web typechecks + lints clean; no unused imports left
- [ ] Comments referencing "devMode still unlocks both" are updated, not contradicted

### WP4 — Mobile: same narrowing, in-dev surfaces untouched

Files:

- `apps/mobile/lib/api/addons.ts`
- `apps/mobile/app/(operator)/(tabs)/home.tsx` (comments only)
- `apps/mobile/app/(operator)/(tabs)/more.tsx` (comments only)

1. `lib/api/addons.ts`: narrow `useDeliveryAccess` (L132-136) and `useRoutesAccess` (L139-143)
   exactly as web WP3.1 (drop the `useDeveloperMode()` composition; keep return shape).
   Update the stale comment blocks (L80-87 owner-decision note and L125-129 composition note)
   to the 2026-08-28 decision. `useDeveloperMode` stays — it still legitimately gates the
   in-development driver app.
2. `home.tsx`: NO logic changes. Update the stale comment L58-62 ("Each helper folds in
   developer_mode, so a dev tenant regresses zero") — the helpers no longer fold in dev mode;
   operator dispatch surfaces follow the feature addons alone. The raw `devMode` reads at
   L66-73 (drive-mode/DriverInlineView) are CORRECT and must stay — the (driver) app is still
   dev-gated in `app/_layout.tsx`.
3. `more.tsx`: same — comment update only (L15-19); the raw devMode drive-mode row (L23-26) stays.

DO NOT touch: `app/_layout.tsx` (driver-branch devMode gate), `app/(auth)/role-picker.tsx`,
`app/(tenant)/_layout.tsx` (dispatch tab devMode gate) — these are the genuinely
in-development surfaces `developer_mode` continues to unlock.

Acceptance criteria:

- [ ] Helpers no longer reference useDeveloperMode; return shapes unchanged
- [ ] _layout.tsx / role-picker.tsx / (tenant)/_layout.tsx byte-identical
- [ ] `npm run test` mobile project passes; mobile typecheck clean
- [ ] Stale "folds in developer_mode" comments updated

### WP5 — Shared types + platform-admin copy

Files:

- `packages/types/index.ts` (L136-161, comments only — the exported const values MUST NOT change)
- `apps/web/app/(platform-admin)/admin/tenants/[id]/page.tsx` (L145-152 only)

1. `packages/types/index.ts`: rewrite the DEVELOPER_MODE_ADDON doc comment (L138-142) and the
   RECURRING/ORDER block comment (L154-159). New content to convey: as of 2026-08-28
   `developer_mode` unlocks ONLY genuinely in-development surfaces (currently the mobile
   (driver) app, mobile role-picker driver option, mobile (tenant) dispatch tab); it no longer
   unlocks the two GA delivery addons anywhere in client UI; the dispatch API accepts it as an
   any-of key purely so dev tenants can exercise in-dev surfaces end-to-end; client gates read
   the feature addon alone via useRoutesAccess/useDeliveryAccess.
2. Admin page `AVAILABLE_ADDONS` Developer Mode entry — replace the description with:

```ts
  {
    key: DEVELOPER_MODE_ADDON,
    name: "Developer Mode",
    description:
      "Unlock in-development surfaces for this tenant — currently the mobile driver-app " +
      "preview (and dispatch API access for end-to-end testing). No longer unlocks Recurring " +
      "routes or Order delivery: enable those add-ons individually.",
  },
```

Acceptance criteria:

- [ ] Exported const VALUES unchanged (`developer_mode`, `driver_payments`, `recurring_routes`, `order_delivery`)
- [ ] Admin toggle copy no longer claims dev mode unlocks the delivery features
- [ ] check-types/lint clean for packages/types and web

### WP6 — Seeds: reseeds preserve admin toggles

Files:

- `apps/api/scripts/demo-seed.js` (L414-477)
- `apps/api/scripts/e2e-seed.js`

1. `demo-seed.js`: for the THREE feature addons — `driver_payments` (L436-446),
   `recurring_routes` (L453-463), `order_delivery` (L466-476) — change `update: { active: true }`
   to `update: {}` so a reseed creates the row when missing but PRESERVES the platform-admin
   toggle when it exists. Update each comment + the `console.log` lines to say
   "(created active on first seed; admin toggle preserved on reseed)". The `developer_mode`
   upsert (L419-429) KEEPS `update: { active: true }` — owner decision 2026-08-28: the demo's
   mobile driver walkthrough depends on it, and after the client narrowing it no longer leaks
   into the web UI. Refresh its comment (L414-418) accordingly (the #380 note is stale).
2. `e2e-seed.js`: generalize `ensureDeveloperMode(tenantId)` (L44-56) to
   `ensureAddon(tenantId, addonKey)` (same row shape, `update: { active: true }` — the e2e
   canary must be deterministic, unlike the demo). At BOTH call sites (existing-tenant path
   ~L113 and the create path — find the second `ensureDeveloperMode` call further down), call
   it for `"developer_mode"`, `"recurring_routes"`, and `"order_delivery"`. Update the L35-38
   comment: the web e2e suite exercises /routes and /deliveries, which after 2026-08-28 need
   the real feature addons (developer_mode no longer unlocks them); developer_mode itself stays
   for the mobile driver-app surface.

Acceptance criteria:

- [ ] demo-seed: feature-addon upserts use `update: {}`; developer_mode still forced active; comments updated
- [ ] e2e-seed: e2e tenant gets developer_mode + recurring_routes + order_delivery active on both paths
- [ ] Both scripts still `node --check` clean (they are plain .js)

## Explicitly OUT of scope (do not do)

- No per-endpoint recurring-vs-delivery split server-side beyond the /trips distinction.
- No changes to PLAN_FLAG_ENFORCEMENT, flag.dispatch_live, the entitlements engine, or the
  ungated Finance/Analytics nav.
- No changes to regulated/tobacco controllers, DriverPaymentsGuard semantics, or mobile
  driver-app gating.
- No new npm dependencies; no schema/migration changes.

## Verification

- Per round: `npm run check-types` (turbo, per workspace)
- Final: `npm run verify` (= turbo run check-types lint test — Jest api + mobile)
- Post-merge ops (NOT part of the workflow — main session handles): prod live-tenant addon
  audit/backfill, e2e-routeflow addon enable, Railway deploy watch, post-deploy-check,
  browser verification of routeflow-demo /dispatch, code map + CHANGELOG + bug register + guide.
