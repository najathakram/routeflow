# Route planning options — start/end points, tolls, time-vs-distance, variants, Google Maps export

Status: IMPLEMENTED — PR #472 (all 7 packages + 18 review fixes; suite green api 3090 / mobile 1236)
Date: 2026-08-27
Branch: `feat/route-planning-options` (single PR; base master). NO merge, NO prod migration — owner's merge window.
Scale: major

## Context (self-contained — subagents see only this file)

RouteFlow monorepo (npm+Turbo): NestJS API (`apps/api`), Next.js 14 web (`apps/web`), Expo mobile
(`apps/mobile`). Prisma 7 + PostgreSQL. Conventions: class-validator DTOs, Jest specs
(`*.spec.ts`) mocked at the module boundary via `Test.createTestingModule`; web has NO unit
tests (Playwright only — do NOT add Jest to web); mobile has Jest for pure logic
(`__tests__/*.test.ts`). Prettier: semicolons, double quotes, printWidth 100. NEVER introduce
Vitest/Biome. All tenant data access is tenant-scoped.

The owner wants delivery-route planning upgraded:

1. Start point choosable (warehouse/depot | driver home | custom address) — already partially
   exists — and **editable after creation** too.
2. End point: none (end at last stop) | return to start | driver home | custom address.
3. Avoid-tolls toggle.
4. Optimization objective: TIME or DISTANCE.
5. Route **variants** (Fastest / Shortest / No-tolls) with totals, shown on the map, user picks.
   (Google's `computeAlternativeRoutes` does NOT work with intermediate waypoints, so variants
   = same stops solved under different settings — this is the deliberate design.)
6. "Open in Google Maps" export — Maps URLs deep link with the ordered stops so a driver
   navigates in the Google Maps app. >9 waypoints chunk into sequential leg links. Google Maps
   recomputes roads on-device; stop ORDER is preserved, exact roads may differ. That is
   accepted and documented in UI copy ("Google Maps re-checks roads live").

### What already exists (build on it, don't reinvent)

- `Route` model (`apps/api/prisma/schema.prisma` ~line 1097): has `depotLat/depotLng/
depotAddress` (Float?/String?) = the resolved START point, `kind RouteKind @default(SCHEDULED)`
  (SCHEDULED|ADHOC), `driverId`, `tenantId`, relations `stops RouteStop[]`, `runs RouteRun[]`.
- `apps/api/src/trips/trips.service.ts` — ad-hoc trip builder. `resolveOrigin(tenantId, origin:
TripOriginDto)` ALREADY supports `TripOriginType.TENANT | DRIVER | ADDRESS` (ADDRESS geocodes
  via `common/geocode.util.ts` `geocodeAddress(addr, apiKey, logger)` and throws
  BadRequestException on geocode failure). Result is persisted onto the created Route's
  depotLat/depotLng/depotAddress. `POST /trips` body = `CreateTripDto` with `origin`, `orderIds`.
- `apps/api/src/route-optimization/route-optimization.service.ts` — `optimizeTemplate(routeId)`
  (route templates, `POST /routes/:id/optimize`) and `optimizeRoute(...)` (runs,
  `POST /route-runs/:id/optimize`). Primary optimizer = ORS (external); fallback =
  `nearestNeighborFallback(stops, depot)` (pure TS: NN from every start + 2-opt, haversine).
  `haversineKm(a, b)` helper exists.
- Google APIs: env `GOOGLE_MAPS_API_KEY` via `configService.get("googleMaps").apiKey` (config
  path `googleMaps.apiKey`). The key has Geocoding + Places(New) + Maps JS + **Routes API**
  enabled. Server calls Google with plain `fetch`.
- Web trip builder `apps/web/app/(dashboard)/deliveries/new/page.tsx`: PICKING → Build
  (`POST /trips`) → BUILT (renders `TemplateRouteMap`) → Send (creates run).
  `_components/TripOriginPicker.tsx` already offers `TripOriginKind = "TENANT"|"DRIVER"|
"ADDRESS"` with address fields. `_components/TripStopList.tsx`, `OrderPickerPanel.tsx` exist.
- Web scheduled-route builder `apps/web/app/(dashboard)/routes/create/page.tsx` (pick stops →
  optimize → assign). Web route detail `routes/[id]/page.tsx` + `routes/[id]/dispatch/page.tsx`.
- `apps/web/lib/api/routes.ts`: `useOptimizeRoute()` → `POST /route-runs/${id}/optimize`,
  `useOptimizeTemplate()` → `POST /routes/${id}/optimize`. `apiClient` from `@/lib/api-client`.
- `apps/web/components/DrivingPathLayer.tsx` (NEW tonight): draws the real road polyline for
  ordered waypoints via browser-side Routes API `computeRoutes` (TRAFFIC_UNAWARE), straight-line
  fallback, per-session cache. `apps/web/app/(dashboard)/routes/templates/[id]/
TemplateRouteMap.tsx` renders route maps (used by the trip builder) — `PolylineLayer` inside it
  builds depot→stops→depot waypoints and renders `DrivingPathLayer`; `MapsApiGate`/
  `MapErrorBoundary` from `@/components/GoogleMapsGate` wrap the map.
- Web address autocomplete: `apps/web/components/AddressAutocomplete.tsx` (server proxy).
- Mobile driver run screen: `apps/mobile/app/(driver)/route/index.tsx` (active run, stop list,
  settlement gate). Mobile run payloads carry stop coordinates (same API as web). Mobile uses
  `expo-linking` (`Linking.openURL`) elsewhere.

### Design decisions (bake these in)

- `Route.depotLat/depotLng/depotAddress` REMAIN the start point storage (no rename). New
  columns add end point + settings + a record of how the origin was chosen.
- Optimizer becomes **cost-matrix-based**: Google Routes API `computeRouteMatrix` builds
  duration+distance matrices (with avoidTolls modifier); the existing NN+2-opt solver is
  generalized to run over an arbitrary cost matrix with a fixed start and an optional fixed
  end. Google unavailable/no key/n>24 → haversine matrix (duration = km-derived synthetic,
  same solver). ORS code stays but is only reached when Google key is missing (demoted, do not
  delete).
- Variants are server-computed: solve under {TIME}, {DISTANCE}, {TIME+avoidTolls}; for each,
  ONE `computeRoutes` call returns polyline + totals + toll presence. Dedupe near-identical.
- Google Maps export is pure client URL building — no server involvement, no key.

## Global rules for every implementer

- Work in the given workdir (a git worktree). Absolute paths only. Do NOT run git commit/push.
- After ANY edit to `apps/api/prisma/schema.prisma`, run `npx prisma generate` inside
  `apps/api` before typechecking.
- Do NOT touch `.claude/code-map/**` (map updates happen outside the pipeline).
- Money/pricing files are out of scope — this batch never touches pricing.
- Match surrounding code style; no new dependencies.

---

## WP1 — Schema + migration (apps/api, blocking)

**Files:** `apps/api/prisma/schema.prisma`, new migration
`apps/api/prisma/migrations/20260907000000_route_planning_options/migration.sql`.

Add to the `Route` model (after `depotAddress`):

```prisma
  originKind   RouteOriginKind?     // how depot* was chosen; null = legacy rows
  endKind      RouteEndKind         @default(NONE)
  endLat       Float?
  endLng       Float?
  endAddress   String?
  avoidTolls   Boolean              @default(false)
  optimizeBy   RouteOptimizeMetric  @default(TIME)
  plannedPolyline String?           // encoded road polyline of the chosen route (scale: map
                                    // views render this instead of re-calling Google)
```

New enums (near `RouteKind`):

```prisma
enum RouteOriginKind {
  TENANT
  DRIVER
  ADDRESS
}

enum RouteEndKind {
  NONE
  RETURN_TO_START
  DRIVER_HOME
  ADDRESS
}

enum RouteOptimizeMetric {
  TIME
  DISTANCE
}
```

Write the migration SQL by hand (additive only — CREATE TYPEs + ALTER TABLE ADD COLUMN with
defaults; no backfill, no destructive ops), matching the existing migrations' style (look at
`20260904000000_adhoc_trips_and_fulfillment` as the reference). Then `npx prisma generate`.

**Acceptance:** `npx prisma validate` passes; generated client exposes the new fields; no other
model touched.

---

## WP2 — Planning resolve + persistence + PATCH endpoint (apps/api trips/routes)

**Files:** `apps/api/src/trips/dto/create-trip.dto.ts` (or wherever `TripOriginDto` lives —
extend in place), NEW `apps/api/src/trips/dto/route-planning.dto.ts`,
`apps/api/src/trips/trips.service.ts`, `apps/api/src/trips/trips.controller.ts`,
`apps/api/src/trips/trips.service.spec.ts` (extend existing spec file if present, else create).

1. NEW DTOs in `route-planning.dto.ts`:

```ts
export enum TripEndType {
  NONE = "NONE",
  RETURN_TO_START = "RETURN_TO_START",
  DRIVER_HOME = "DRIVER_HOME",
  ADDRESS = "ADDRESS",
}

export class TripEndDto {
  @IsEnum(TripEndType) type!: TripEndType;
  @IsOptional() @IsString() driverId?: string; // DRIVER_HOME; defaults to the route's driver
  @IsOptional() @IsString() line1?: string; // ADDRESS
  @IsOptional() @IsString() city?: string;
  @IsOptional() @IsString() state?: string;
  @IsOptional() @IsString() zip?: string;
}

export class RoutePlanningDto {
  @IsOptional() @ValidateNested() @Type(() => TripOriginDto) origin?: TripOriginDto;
  @IsOptional() @ValidateNested() @Type(() => TripEndDto) end?: TripEndDto;
  @IsOptional() @IsBoolean() avoidTolls?: boolean;
  @IsOptional() @IsIn(["TIME", "DISTANCE"]) optimizeBy?: "TIME" | "DISTANCE";
}
```

2. `trips.service.ts`: NEW `private async resolveEnd(tenantId, end: TripEndDto | undefined,
origin: {depotLat; depotLng; depotAddress}, routeDriverId: string | null)` returning
   `{ endKind, endLat, endLng, endAddress }`:
   - undefined or NONE → `{ endKind: "NONE", endLat: null, endLng: null, endAddress: null }`
   - RETURN_TO_START → copy the origin coords/address, endKind RETURN_TO_START (coords stored
     so the map/export never has to re-resolve).
   - DRIVER_HOME → load driver (`end.driverId ?? routeDriverId`; 400 if neither), reuse the
     exact validation/messages pattern of `resolveOrigin`'s DRIVER case.
   - ADDRESS → geocode like `resolveOrigin`'s ADDRESS case (hard 400 on failure).
3. `create()` (POST /trips): accept optional `planning` fields on the create DTO (embed
   `end?: TripEndDto`, `avoidTolls?: boolean`, `optimizeBy?` alongside the existing `origin`).
   Persist onto the created Route: `originKind` = the origin DTO's type, plus the new columns.
4. NEW endpoint on `trips.controller.ts` (it already owns `/trips`; add a route-scoped one):
   `PATCH /trips/routes/:routeId/planning` — `@Roles(OPERATOR)` guarded like siblings, body
   `RoutePlanningDto`. Service method `updatePlanning(tenantId, routeId, dto)`:
   - Load route (tenant-scoped, 404 else). Reject with 409 if ANY run of this route is
     `IN_PROGRESS` (message: "Finish or cancel the active run before changing route planning").
   - If `dto.origin` present → `resolveOrigin` and overwrite depot\* + originKind.
   - If `dto.end` present → `resolveEnd` (use the possibly-new origin) and overwrite end\*.
   - If origin present but end absent AND stored endKind is RETURN_TO_START → refresh stored
     end coords from the new origin (they mirror it).
   - Persist avoidTolls/optimizeBy when present. Return the updated route row.
   - Does NOT reorder stops — the client calls optimize afterwards (response includes
     `{ reoptimizeRecommended: true }` whenever origin/end/optimizeBy/avoidTolls changed).
5. Specs (`trips.service.spec.ts` additions): resolveEnd all four arms (mock prisma driver
   lookup + mock `geocodeAddress` at the module boundary the way the existing spec mocks it);
   updatePlanning: 409 on IN_PROGRESS run, RETURN_TO_START refresh-on-origin-change, persists
   settings.

**Acceptance:** existing trips specs still pass; new specs cover the 4 end arms + 409 +
RETURN_TO_START refresh; `PATCH /trips/routes/:routeId/planning` exists with OPERATOR roles.

---

## WP3 — Matrix-based optimizer + variants (apps/api route-optimization)

**Files:** `apps/api/src/route-optimization/route-optimization.service.ts`,
`route-optimization.controller.ts`, NEW `apps/api/src/route-optimization/cost-matrix.ts`,
NEW `apps/api/src/route-optimization/cost-matrix.spec.ts`, extend
`route-optimization.service.spec.ts` (create if absent). Depends on WP1 (new Route fields).

1. NEW `cost-matrix.ts` — self-contained module, no Nest injection (plain functions taking
   `apiKey: string | undefined` and a logger-like `{ warn(msg: string): void }`):

```ts
export interface LatLng {
  lat: number;
  lng: number;
}
export interface CostMatrices {
  durationSec: number[][]; // [from][to]
  distanceMeters: number[][];
  source: "google" | "haversine";
}

const MATRIX_URL = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";
const MAX_MATRIX_POINTS = 25; // origins*destinations must stay <= 625

export async function buildCostMatrices(
  points: LatLng[],
  opts: { avoidTolls: boolean; apiKey?: string; logger?: { warn(m: string): void } },
): Promise<CostMatrices> {
  const n = points.length;
  if (!opts.apiKey || n < 2 || n > MAX_MATRIX_POINTS) return haversineMatrices(points);
  try {
    const body = {
      origins: points.map((p) => ({
        waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } },
      })),
      destinations: points.map((p) => ({
        waypoint: { location: { latLng: { latitude: p.lat, longitude: p.lng } } },
      })),
      travelMode: "DRIVE",
      routingPreference: "TRAFFIC_UNAWARE",
      ...(opts.avoidTolls ? { routeModifiers: { avoidTolls: true } } : {}),
    };
    const res = await fetch(MATRIX_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": opts.apiKey,
        "X-Goog-FieldMask": "originIndex,destinationIndex,duration,distanceMeters,condition",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`computeRouteMatrix ${res.status}`);
    // Response is a JSON ARRAY of elements, not a matrix.
    const elements = (await res.json()) as Array<{
      originIndex: number;
      destinationIndex: number;
      duration?: string; // "123s"
      distanceMeters?: number;
      condition?: string; // "ROUTE_EXISTS" | "ROUTE_NOT_FOUND"
    }>;
    const dur = emptyMatrix(n);
    const dist = emptyMatrix(n);
    for (const el of elements) {
      if (el.condition && el.condition !== "ROUTE_EXISTS") throw new Error("matrix hole");
      dur[el.originIndex][el.destinationIndex] = parseFloat(
        (el.duration ?? "0s").replace(/s$/, ""),
      );
      dist[el.originIndex][el.destinationIndex] = el.distanceMeters ?? 0;
    }
    // Every off-diagonal cell must be filled; a sparse response falls back.
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++)
        if (i !== j && (dur[i][j] === undefined || dist[i][j] === undefined))
          throw new Error("sparse matrix");
    return { durationSec: dur, distanceMeters: dist, source: "google" };
  } catch (err) {
    opts.logger?.warn(`Route matrix via Google failed (${String(err)}) — haversine fallback`);
    return haversineMatrices(points);
  }
}
```

`haversineMatrices(points)`: distanceMeters from haversine; durationSec = distance / 11.1
(≈40 km/h urban average — synthetic but order-consistent); `source: "haversine"`.
`emptyMatrix(n)` = n×n filled with `undefined as unknown as number`, diagonal set to 0.

**COST CONTROL (required):** Google bills the matrix PER ELEMENT (n×n) — a 20-stop optimize is
~441 billable elements. Two mandatory additions inside `cost-matrix.ts`:

a. **Module-level LRU cache**: key = `points.map(p => p.lat.toFixed(5) + "," + p.lng.toFixed(5)).join("|") + "!" + avoidTolls`,
value = `{ matrices: CostMatrices; at: number }`. TTL 7 days; max 500 entries (evict oldest
insertion). Check BEFORE calling Google; store only `source: "google"` results (never cache
haversine fallbacks). A tenant's recurring daily route then pays for its matrix once, not
per optimize.
b. **Usage telemetry**: on every real Google call, log one structured line via the passed
logger (add an optional `log(m: string)` alongside `warn`):
`routes-billing matrix elements=<n*n> tenant=<tenantId>` (tenantId threaded through opts as
an optional string) — and equivalently `routes-billing computeRoutes calls=1 tenant=...`
wherever the service calls computeRoutes. This makes per-tenant Google spend observable in
Railway logs before the invoice arrives.

Spec additions for these: cache hit skips fetch (mock fetch called once across two identical
buildCostMatrices calls); haversine results are NOT cached; telemetry line emitted with the
element count.

2. `route-optimization.service.ts` — NEW generalized solver (private):

```ts
/**
 * Order stops by cost matrix. Index 0 = fixed start. `endIndex` (optional) = fixed end that
 * must be LAST (not reordered). Everything else is permutable. NN from the start + 2-opt.
 * Returns the permutation of the permutable indices (matrix indices, order to visit).
 */
private solveOrder(cost: number[][], permutable: number[], endIndex?: number): number[] {
  if (permutable.length <= 1) return [...permutable];
  const tail = endIndex === undefined ? [] : [endIndex];
  // Nearest-neighbour seed from the fixed start (index 0)
  const remaining = new Set(permutable);
  const order: number[] = [];
  let cur = 0;
  while (remaining.size) {
    let best = -1; let bestC = Infinity;
    for (const c of remaining) if (cost[cur][c] < bestC) { bestC = cost[cur][c]; best = c; }
    order.push(best); remaining.delete(best); cur = best;
  }
  // 2-opt over the open path 0 → order... → (endIndex?)
  const tourCost = (o: number[]) => {
    let t = cost[0][o[0]];
    for (let i = 0; i < o.length - 1; i++) t += cost[o[i]][o[i + 1]];
    if (tail.length) t += cost[o[o.length - 1]][tail[0]];
    return t;
  };
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < order.length - 1; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const cand = [...order.slice(0, i), ...order.slice(i, j + 1).reverse(), ...order.slice(j + 1)];
        if (tourCost(cand) + 1e-9 < tourCost(order)) { order.splice(0, order.length, ...cand); improved = true; }
      }
    }
  }
  return order;
}
```

3. Rewire `optimizeTemplate(routeId)` and `optimizeRoute(...)`: load the route's planning
   fields (`avoidTolls`, `optimizeBy`, end\*). Build `points = [origin, ...stops]` and, when
   `endKind !== "NONE"`, append the end point as the last matrix index. Call
   `buildCostMatrices(points, { avoidTolls, apiKey, logger })`; pick
   `cost = optimizeBy === "DISTANCE" ? distanceMeters : durationSec`; run `solveOrder(cost,
stopIndices, endIdx?)`; map back to stop ids and persist exactly the way the current code
   persists the ORS/fallback result. Only when `apiKey` is missing keep the previous ORS
   pathway as-is (existing code path untouched — put the new matrix branch FIRST).
4. Variants — NEW controller routes on the existing `RouteTemplateOptimizationController`
   (`/routes` prefix): `POST :id/variants` and `POST :id/variants/apply`, `@Roles(OPERATOR)`
   matching siblings.
   - `variants(tenantId, routeId)`: candidate configs
     `[{key:"FASTEST", optimizeBy:"TIME", avoidTolls:false}, {key:"SHORTEST", optimizeBy:
"DISTANCE", avoidTolls:false}, {key:"NO_TOLLS", optimizeBy:"TIME", avoidTolls:true}]`
     (when the route already has avoidTolls=true, ALL configs run with avoidTolls true and the
     NO_TOLLS config is skipped). For each: matrices → solveOrder → ONE `computeRoutes` call
     (`https://routes.googleapis.com/directions/v2:computeRoutes`, FieldMask
     `routes.polyline.encodedPolyline,routes.distanceMeters,routes.duration,routes.travelAdvisory.tollInfo`,
     origin=start, intermediates=ordered stops, destination=end point when set else last stop
     [when endKind NONE the last ORDERED stop is the destination and the remaining stops are
     intermediates], routeModifiers.avoidTolls per config). **Do NOT request toll
     computations** (`extraComputations`/`travelAdvisory.tollInfo` are OMITTED — toll
     calculation risks the Pro-tier double price; FieldMask is exactly
     `routes.polyline.encodedPolyline,routes.distanceMeters,routes.duration`). Build
     `{ key, stopIds, durationSec, distanceMeters, hasTolls, encodedPolyline }` where
     `hasTolls` is DERIVED BY CONTRAST after all variants are computed: if the NO_TOLLS
     variant's duration differs from a variant's by more than 2% OR their stop orders differ,
     that variant `hasTolls: true`; when NO_TOLLS is absent (route already avoidTolls) or the
     comparison is within 2% with identical order, `hasTolls: false` everywhere. Dedupe: drop a variant whose stopIds equal an earlier one
     AND whose duration and distance are both within 1%. Return `{ variants }` — on ANY Google
     failure return the single matrix/solver result with `encodedPolyline: null` (client then
     draws its own path) rather than 500ing.
   - `applyVariant(tenantId, routeId, dto: { key; stopIds: string[]; optimizeBy; avoidTolls;
encodedPolyline?: string | null })`: validate stopIds is a permutation of the route's stop
     ids (400 otherwise); persist stop order (same mechanism as optimize) + `optimizeBy`/
     `avoidTolls` + `plannedPolyline` (the variant's polyline; null clears). Any path that
     REORDERS stops outside apply (optimize endpoints, updatePlanning-triggered changes) must
     NULL `plannedPolyline` — a stale polyline is worse than none.
5. Specs: `cost-matrix.spec.ts` (google path parses the element-array shape, sparse → fallback,
   n>25 → haversine, avoidTolls forwarded into the request body — assert via mocked `fetch`);
   service spec for `solveOrder` (crossed-path 4-stop case improves under 2-opt; fixed end stays
   last; distance-vs-time matrices produce different orders on a crafted matrix) and variants
   dedupe.

**Acceptance:** all existing route-optimization specs pass; new specs green; no ORS code
deleted; variants endpoints exist and never 500 on Google failure.

---

## WP4 — Web shared: planning types/hooks, controls, variants UI, map overlay, gmaps export

**Files:** `apps/web/lib/api/routes.ts` (extend), NEW `apps/web/lib/gmaps-export.ts`,
NEW `apps/web/components/RoutePlanningControls.tsx`, NEW
`apps/web/components/RouteVariantsPanel.tsx`,
`apps/web/app/(dashboard)/routes/templates/[id]/TemplateRouteMap.tsx` (extend).

1. `lib/gmaps-export.ts` (pure, no React):

```ts
export interface GmapsPoint {
  lat: number;
  lng: number;
}
const MAX_WAYPOINTS_PER_LINK = 9; // Google Maps mobile app limit

/** Sequential Google Maps directions links covering origin → stops… → end. */
export function buildGoogleMapsLegs(points: GmapsPoint[]): { label: string; url: string }[] {
  if (points.length < 2) return [];
  const fmt = (p: GmapsPoint) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
  const legs: { label: string; url: string }[] = [];
  // Each link: origin + up to 9 waypoints + destination; the next link re-starts at the
  // previous destination so the driver hands off seamlessly.
  let i = 0;
  let leg = 1;
  while (i < points.length - 1) {
    const end = Math.min(i + MAX_WAYPOINTS_PER_LINK + 1, points.length - 1);
    const slice = points.slice(i, end + 1);
    const params = new URLSearchParams({
      api: "1",
      travelmode: "driving",
      origin: fmt(slice[0]),
      destination: fmt(slice[slice.length - 1]),
    });
    if (slice.length > 2) params.set("waypoints", slice.slice(1, -1).map(fmt).join("|"));
    legs.push({
      label: `Leg ${leg}`,
      url: `https://www.google.com/maps/dir/?${params.toString()}`,
    });
    i = end;
    leg++;
  }
  if (legs.length === 1) legs[0].label = "Open in Google Maps";
  return legs;
}
```

2. `lib/api/routes.ts`: extend the `Route`/detail types with the planning fields
   (`originKind`, `endKind`, `endLat`, `endLng`, `endAddress`, `avoidTolls`, `optimizeBy` —
   all optional for backward compat). New types `RouteVariant { key: "FASTEST"|"SHORTEST"|
"NO_TOLLS"; stopIds: string[]; durationSec: number; distanceMeters: number; hasTolls:
boolean; encodedPolyline: string | null }`. New hooks following the file's existing
   patterns exactly: `useUpdateRoutePlanning()` → `PATCH /trips/routes/${routeId}/planning`,
   `useRouteVariants()` → `POST /routes/${id}/variants`, `useApplyRouteVariant()` →
   `POST /routes/${id}/variants/apply`; invalidate the same query keys the optimize hooks
   invalidate, plus the route detail key.
3. `RoutePlanningControls.tsx` — presentational + controlled: props
   `{ value: { originKind, originSummary, end: TripEndDraft, avoidTolls, optimizeBy },
onChange, drivers?: {id, name, hasHome}[], disabled? }`. Sections: Start (radio Warehouse /
   Driver home / Custom address — reuse the copy/affordance style of
   `deliveries/_components/TripOriginPicker.tsx`, including AddressAutocomplete for custom),
   End (radio: End at last stop / Return to start / Driver home / Custom address + address
   input), toggles row (Avoid tolls switch; Optimize by: Fastest time / Shortest distance
   radio). Tailwind + existing app tokens (navy/brand classes as used in TripOriginPicker).
4. `RouteVariantsPanel.tsx`: props `{ variants: RouteVariant[]; selectedKey; onSelect(v);
loading }` — one card per variant: name ("Fastest" / "Shortest" / "Avoids tolls"),
   `Math.round(durationSec/60)` min, `(distanceMeters/1609.34).toFixed(1)` mi, a "Tolls" amber
   chip when hasTolls; selected card gets the brand ring. Skeleton state while loading.
5. `apps/web/components/DrivingPathLayer.tsx`: add optional prop
   `precomputedPolyline?: string | null` — when a non-empty encoded polyline is given, decode
   and render IT (geometry lib) and skip the Routes API fetch entirely (straight-line fallback
   stays for decode failure). Route/trip pages pass the route's `plannedPolyline` through so a
   stored route never re-bills Google per view.
6. `TemplateRouteMap.tsx`: add optional prop
   `variantOverlays?: { encodedPolyline: string; color: string; selected: boolean }[]`.
   When present, render them INSTEAD of the default `PolylineLayer` driving path: a new
   internal `EncodedPolylineLayer` decodes each via `useMapsLibrary("geometry")`
   (`geometry.encoding.decodePath`) and draws `google.maps.Polyline`s — selected: strokeWeight
   5 opacity 0.9; others: strokeWeight 3 opacity 0.35 (grey `#9ca3af`). Preserve everything
   else (markers, gate, placeholders) untouched.

**Acceptance:** typecheck green; no behavior change for existing callers of TemplateRouteMap
(new prop optional); gmaps legs: 2 points → 1 link no waypoints param; 12 points → 2 legs
with the handoff point shared.

---

## WP5 — Web builders wiring (deliveries/new + routes/create). Depends WP4.

**Files:** `apps/web/app/(dashboard)/deliveries/new/page.tsx`,
`apps/web/app/(dashboard)/deliveries/_components/TripOriginPicker.tsx` (only if a small prop
addition is needed), `apps/web/app/(dashboard)/routes/create/page.tsx`.

1. `deliveries/new` (ad-hoc builder): mount `RoutePlanningControls` in the pre-Build panel
   (origin section REPLACES the standalone TripOriginPicker usage — keep TripOriginPicker's
   depot/driver gating semantics: depot option disabled without depot, driver option disabled
   without driver home, same helper copy; either reuse the component inside
   RoutePlanningControls via composition or lift its option-building — implementer's choice,
   NO behavior regression). Build (`POST /trips`) now sends `end/avoidTolls/optimizeBy` too.
   After Build succeeds: call `useRouteVariants` on the built route; show
   `RouteVariantsPanel` above the map with `TemplateRouteMap variantOverlays` (colors:
   selected `#3b82f6`); default-select FASTEST (or the sole variant); "Use this route" =
   `useApplyRouteVariant` then refetch the built route so the stop list re-numbers. Variants
   failure (empty/null polylines) → keep today's single-route view, no error wall.
2. `routes/create` (scheduled): add `RoutePlanningControls` (collapsed "Route options" card
   above the save action); on save, pass the planning fields through the existing create
   payload (extend the create call the same way trips create was extended — the API accepts
   them via WP2's create-path changes; if the scheduled create endpoint is a different
   controller (`routes`), wire the SAME fields onto its DTO + service persist in this WP,
   keeping the change additive).
3. Both builders: when the user changes optimizeBy/avoidTolls AFTER an optimize/build, show
   the existing muted-hint pattern "Re-optimize to apply the new settings".

**Acceptance:** trip build round-trips all planning fields; variants render and apply;
scheduled create persists planning; no regression to the PICKING/BUILT state machine (the
draft-persistence and dead-end behaviors stay exactly as documented in the page).

---

## WP6 — Web route detail + dispatch: settings editing + export. Depends WP4.

**Files:** `apps/web/app/(dashboard)/routes/[id]/page.tsx`,
`apps/web/app/(dashboard)/routes/[id]/dispatch/page.tsx`.

1. Route detail: a "Route planning" card (collapsible, near the map): shows current start/end/
   tolls/objective; "Edit" opens `RoutePlanningControls` in a modal/sheet (existing modal
   idiom on the page); save → `useUpdateRoutePlanning`; when the response says
   `reoptimizeRecommended`, toast with an inline "Re-optimize now" action that fires the
   existing optimize hook for this surface. Show variants: a "Compare routes" button → fetch
   variants → `RouteVariantsPanel` + pass overlays into the map this page renders (RouteMap —
   if this page's map is `RouteMap` not TemplateRouteMap, add the SAME optional
   `variantOverlays` prop to `apps/web/app/(dashboard)/routes/[id]/RouteMap.tsx` re-using the
   `EncodedPolylineLayer` — export that layer from TemplateRouteMap or duplicate the ~20-line
   component locally, matching file conventions).
2. Both pages: "Open in Google Maps" button (secondary, MapPin/ExternalLink icon):
   points = [start(depot*), ...stops in stopNumber order with coords, ...(end when
   endKind !== "NONE")] → `buildGoogleMapsLegs`; one leg = plain `<a target="_blank">`;
   multiple → small dropdown listing Leg 1..N. Tooltip/caption: "Stop order is preserved —
   Google Maps re-checks roads live." Hide the button when fewer than 2 points have
   coordinates.

**Acceptance:** planning card round-trips; 409 (active run) surfaces the server message as a
toast; export link opens correct dir URL (spot-check by URL shape); pages typecheck.

---

## WP7 — Mobile: Google Maps export (driver) + logic test

**Files:** NEW `apps/mobile/lib/gmaps-export.ts` (byte-mirror of the web helper minus any
web-only types), NEW `apps/mobile/__tests__/gmaps-export.test.ts`,
`apps/mobile/app/(driver)/route/index.tsx`.

1. Mirror `buildGoogleMapsLegs` exactly (pure TS, no RN imports).
2. Test: 2-point single link (no waypoints param, label "Open in Google Maps"); 12-point →
   2 legs, leg 1 destination === leg 2 origin; coordinates formatted 6dp; url starts with
   `https://www.google.com/maps/dir/?api=1`.
3. Driver active-run screen: an "Open in Google Maps" row/button near the stop list header —
   build points from the active run's route depot + ordered stops with coords (+ end when the
   route payload carries it; if the run payload lacks end fields, omit gracefully) →
   single leg: `Linking.openURL(url)` (import from `expo-linking`, matching the file's
   existing imports); multiple legs: RN `ActionSheet`/simple modal listing legs (match the
   screen's existing sheet idiom). Hide when <2 coordinated points. Mobile builder parity for
   planning controls is EXPLICITLY DEFERRED (follow-up wave) — do not add it.

**Acceptance:** `npx jest __tests__/gmaps-export.test.ts` green in apps/mobile; screen
typechecks; no other mobile surface touched.

---

## Package graph

- WP1 → (WP2, WP3) [parallel, disjoint files]
- WP4 [parallel with WP1-3 — web-only files]
- WP4 → (WP5, WP6) [parallel, disjoint files]
- WP7 independent [mobile-only files]

## Verification

- perRound: `npx turbo run check-types`
- final: `npm run verify` (turbo check-types + lint + jest api/mobile)

## Risks / notes for reviewers

- Migration is additive-only; deploy order at the merge window: prod migration BEFORE app
  deploy (owner runbook, not this batch).
- Money paths untouched. The optimizer changes stop ORDER only — dispatch/delivery flows
  consume order as before.
- Google cost model (verified 2026-08-27): matrix bills PER ELEMENT (n² per optimize — 10
  stops ≈ $0.61, 20 stops ≈ $2.21 after the 10K-element monthly free tier); computeRoutes
  $5/1000 Essentials, but >10 intermediates OR traffic-aware OR toll computation classify Pro
  ($10/1000, 5K free). Hence: TRAFFIC_UNAWARE everywhere, NO toll extraComputations (contrast
  heuristic instead), matrix LRU cache (recurring routes re-optimize free), persisted
  plannedPolyline (map views cost zero), per-tenant billing telemetry in logs. Long-term lever
  when spend turns real: swap buildCostMatrices' Google branch for self-hosted OSRM — the
  interface is designed for that swap.
- `computeRouteMatrix` response is an ELEMENT ARRAY (not nested matrix) — parsing in WP3 is
  written above; do not "simplify" it into an assumed matrix shape.
- Variants NEVER 500 on Google failure (fall back to solver-only, polyline null).
- Web has no Jest — do NOT add web unit tests; mobile test only in WP7.
