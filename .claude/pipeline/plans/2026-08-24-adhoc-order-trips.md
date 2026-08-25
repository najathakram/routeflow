# Plan: Ad-hoc Order Trips + Fulfillment Mode (developer_mode-gated)

> Authored by Fable 5 on 2026-08-24. Status: IMPLEMENTED (pipeline wf_16ed7448-321; final gate `npm run verify` green 2026-08-24 — 166 API + 86 mobile suites passing)
> This file is the ONLY context the implementation and review agents receive.
> It must stand alone: no references to "the conversation", no "as discussed".

## Objective

Two client-driven features for RouteFlow (NestJS API + Next.js web + Expo mobile monorepo, Prisma 7 / PostgreSQL):

1. **Ad-hoc trips** — operators multi-select orders from the orders list, pick a start point (tenant depot, driver's home base, or a typed address), get an optimized one-shot delivery route, and dispatch it to a driver. Implemented as `Route.kind = ADHOC` reusing the existing Route/RouteRun machinery end-to-end (my-runs, completeStop, payments, POD all inherited, untouched).
2. **Fulfillment mode** — orders gain `fulfillPath ROUTE|SHIP`. SHIP orders (supplier-direct / carrier-shipped) are excluded from all trip/route dispatch with visible reasons, and their order-detail actions relabel to "Mark shipped"/"Mark delivered" (same `changeStatus` transitions — OUT_FOR_DELIVERY/DELIVERED — no new statuses, no new invoicing paths).

All new trip UI is gated behind the existing client-side `developer_mode` addon. Fulfillment UI is NOT dev-gated (shipping columns/pages already ship to every tenant). Driver-facing surfaces get NOTHING new.

## Constraints & conventions

- **Untouchables — do NOT modify:** `completeStop`, `completeWithPayment`, `recordDeliveryPaymentInTx`, any `reconcile*` invoice function, the delivery-payment specs, `apps/api/src/routes/route-optimization.service.ts` (whole module), the optimize endpoints and their throttles. `POST /routes/:id/optimize` already honors persisted `Route.depotLat/depotLng/depotAddress` (its `resolveDepot` tier-1 is `route.depotLat != null && route.depotLng != null`, L78-140) and geocodes un-geocoded stops inline — it needs zero changes.
- **Do NOT add** `/orders` to web `DEV_MODE_PREFIXES` (in `apps/web/app/(dashboard)/layout.tsx`; currently `["/dispatch","/routes","/drivers"]`) or `orders` to mobile `DEV_MODE_SECTIONS`. Trip UI lives under already-gated prefixes/sections; the orders-list select affordances are individually gated instead.
- **`kind` stays OUT of `CreateRouteDto`/`UpdateRouteDto`.** `main.ts` runs ValidationPipe with `whitelist + forbidNonWhitelisted`, so DTO fields are the entire write surface — omitting `kind` makes it unforgeable via the public routes API. Trips are created only through the new `/trips` controller. Note: `updateRoute` (`routes.service.ts:175-178`) passes the raw DTO spread as `data` — this is safe only because of the whitelist; keep it that way.
- **No new npm dependencies** anywhere. Mobile handoff state uses zustand (already a house dependency, cf. existing mobile stores); web handoff uses `sessionStorage`.
- **Tenant-data policy:** all testing on approved test tenants only. No prod data writes. The migration is applied to prod by the OWNER, not by any agent.
- **Style:** Prettier — double quotes, semicolons, printWidth 100. NestJS DTOs use class-validator. Jest with `Test.createTestingModule`, mock at module boundary. NO Vitest, NO snapshot tests. Conventional Commits.
- **Migrations:** latest applied migration is `20260903000000_supplier_geocode`; the new (single) migration takes slot `20260904000000_adhoc_trips_and_fulfillment`. The `FulfillPath { ROUTE, SHIP }` enum ALREADY EXISTS in the DB and Prisma schema (created in `0_init`, used by `Customer.fulfillPath @default(ROUTE)`) — do not re-create it.
- **`Order.routeRunStopId` is never cleared** on run completion/cancel — stale non-null values persist in prod data. Trip eligibility must mirror the dispatch sweep's `routeRunStopId: null` predicate exactly (reject BOTH active and stale attachments, with distinct reasons) or dispatch would silently drop orders the picker accepted.
- **NO backfill of `Order.fulfillPath` from `Customer.fulfillPath`.** Customer values are untrusted (settable via DTOs since launch, read by nothing). Backfilling SHIP would drop customers out of the dispatch sweep on deploy. Column default ROUTE = byte-identical behavior for every existing order. The customer default applies to NEW orders only, inside `OrdersService.create`.
- **Geocode helper:** free function `geocodeAddress(addr: {line1, city, state, zip}, apiKey, logger?)` in `apps/api/src/common/geocode.util.ts` (Google; returns `null` on any failure). Config key: `googleMaps.apiKey`.
- **Phase 0 live finding (2026-08-24, already confirmed):** prod optimize returns 400 on the demo tenant because demo customer addresses were seeded with `lat = null` (Prisma seed bypasses geocode-on-create) and `GOOGLE_MAPS_API_KEY` appears unset on the prod API. WP13 fixes the seed with deterministic synthetic coordinates so the optimizer's local NN+2-opt fallback works with no API key.
- **The "route PATCH replace-all wipes stops" landmine does NOT exist** in this feature's path: `updateRoute` updates scalars only; stops go through separate add/reorder/remove endpoints with active-run guards. State this in the PR description as "provably not in this feature's path".
- Agents work in the worktree `C:\ClaudeCode\routeflow\.claude\worktrees\adhoc-trips`; all paths below are repo-relative; run all commands from the repo root.
- After the schema change (WP1), run `npx prisma generate` — it writes the SHARED root Prisma client; WP3-6 need it before they can typecheck.

## Work packages

File lists are DISJOINT across packages; ordering is expressed via `dependsOn`.

### WP1 — Schema + migration

- **files:** `apps/api/prisma/schema.prisma`, `apps/api/prisma/migrations/20260904000000_adhoc_trips_and_fulfillment/migration.sql`
- **dependsOn:** none
- **brief:** One migration, exact SQL below. Mirror it in `schema.prisma`: new `enum RouteKind`, `Route.kind` + compound index, `Order.fulfillPath` (REUSES the existing `FulfillPath` enum — do not redeclare it), three nullable `Driver` home-base fields. No backfill statements of any kind. No index on `Order.fulfillPath` (2-value enum, ~100% ROUTE). After editing, run `npx prisma generate`.
- **exact code — migration.sql:**

```sql
CREATE TYPE "RouteKind" AS ENUM ('SCHEDULED', 'ADHOC');
ALTER TABLE "Route" ADD COLUMN "kind" "RouteKind" NOT NULL DEFAULT 'SCHEDULED';
CREATE INDEX "Route_tenantId_kind_idx" ON "Route"("tenantId", "kind");
ALTER TABLE "Order" ADD COLUMN "fulfillPath" "FulfillPath" NOT NULL DEFAULT 'ROUTE';
ALTER TABLE "Driver" ADD COLUMN "homeLat" DOUBLE PRECISION;
ALTER TABLE "Driver" ADD COLUMN "homeLng" DOUBLE PRECISION;
ALTER TABLE "Driver" ADD COLUMN "homeAddress" TEXT;
```

- **exact code — schema.prisma diffs (add to existing models; everything else unchanged):**

```prisma
enum RouteKind {
  SCHEDULED
  ADHOC
}

model Route {
  // ...existing fields unchanged...
  kind RouteKind @default(SCHEDULED)
  // ...existing indexes unchanged, plus:
  @@index([tenantId, kind])
}

model Order {
  // ...existing fields unchanged...
  fulfillPath FulfillPath @default(ROUTE)
}

model Driver {
  // ...existing fields unchanged...
  homeLat     Float?
  homeLng     Float?
  homeAddress String?
}
```

### WP2 — Shared types + grouping helper

- **files:** `packages/types/index.ts`, `packages/types/trip-grouping.ts`
- **dependsOn:** none
- **brief:** `packages/types/index.ts` already exports `FulfillPath` (L72) and `DEVELOPER_MODE_ADDON`. Add a `RouteKind` enum (`SCHEDULED | ADHOC`, string values) next to `FulfillPath`, create `trip-grouping.ts` with the exact code below, and re-export everything from it in `index.ts` (`export * from "./trip-grouping";`). Pure module — no imports beyond its own file.
- **exact code — `packages/types/trip-grouping.ts` (entire file):**

```ts
export interface TripGroupableOrder {
  id: string;
  orderNumber?: string | null;
  customerId?: string | null;
  customerName?: string | null;
}

export interface TripStopGroup {
  customerId: string;
  customerName: string | null;
  orderIds: string[];
}

export interface TripSkippedOrder {
  orderId: string;
  orderNumber: string | null;
  reason: "NO_CUSTOMER";
}

export interface TripGroupingResult {
  groups: TripStopGroup[];
  skipped: TripSkippedOrder[];
}

/**
 * Groups orders into one delivery stop per distinct customer, preserving
 * first-seen order. Pure and deterministic — consumed by the web trip builder
 * (client preview), the API TripsService (server truth), and mirrored in
 * mobile at apps/mobile/lib/trip-grouping.ts, so all three agree.
 */
export function groupOrdersForTrip(orders: TripGroupableOrder[]): TripGroupingResult {
  const groups: TripStopGroup[] = [];
  const byCustomer = new Map<string, TripStopGroup>();
  const skipped: TripSkippedOrder[] = [];
  for (const order of orders) {
    if (!order.customerId) {
      skipped.push({
        orderId: order.id,
        orderNumber: order.orderNumber ?? null,
        reason: "NO_CUSTOMER",
      });
      continue;
    }
    let group = byCustomer.get(order.customerId);
    if (!group) {
      group = {
        customerId: order.customerId,
        customerName: order.customerName ?? null,
        orderIds: [],
      };
      byCustomer.set(order.customerId, group);
      groups.push(group);
    }
    if (!group.orderIds.includes(order.id)) group.orderIds.push(order.id);
  }
  return { groups, skipped };
}
```

### WP3 — API routes: sweep narrowing, kind filter, DTOs, specs

- **files:** `apps/api/src/routes/routes.service.ts`, the DTO files under `apps/api/src/routes/dto/` that hold `CreateRouteRunDto` and the `GET /routes` list query DTO, `apps/api/src/routes/routes.service.spec.ts`
- **dependsOn:** WP1
- **brief:** Four surgical touches. (1) `CreateRouteRunDto` gains optional `orderIds` (below). (2) `createRun` — after the existing route load + active-run ConflictException guard (~L511-567), add the guard + conditional narrowing of the dispatch sweep (`prisma.order.updateMany` at L619-632). The sweep's existing `where` keys (`customerId` filter, `status: { notIn: [DELIVERED, CANCELLED] }`, `routeRunStopId: null`, any tenant scoping) stay byte-identical; the ONLY change is the conditional spread. (3) `findAllRoutes` (~L99-104): default `kind` to SCHEDULED (line below) + add optional `@IsEnum(RouteKind) kind?` to the list query DTO (create the DTO with only this field if the handler currently takes no DTO). `getCustomerRouteAssignments` (~L410, derives from `RouteStop.customerId`) must ALSO filter to `route.kind: SCHEDULED` (adapt to the query's actual shape — a `route: { kind: RouteKind.SCHEDULED }` relation filter) or ad-hoc trips pollute the "Currently in:" customer hints forever. (4) Fix the comment at `routes.service.ts:569` — it claims a 3-tier depot snapshot but the code snapshots route-level depot only; make the comment tell the truth. Do NOT add `kind` to `CreateRouteDto`/`UpdateRouteDto`.
- **exact code — createRun guard + sweep narrowing:**

```ts
// after the route load + existing active-run ConflictException guard:
if (dto.orderIds?.length && route.kind !== RouteKind.ADHOC) {
  throw new BadRequestException("orderIds can only be provided when dispatching an ad-hoc trip");
}
const adhocOrderIds =
  route.kind === RouteKind.ADHOC && dto.orderIds?.length ? dto.orderIds : null;

// in the sweep's where (L619-632) — every existing key retained byte-identical, plus ONLY:
...(adhocOrderIds ? { id: { in: adhocOrderIds } } : {}),
```

- **exact code — findAllRoutes default:**

```ts
where.kind = query?.kind ?? RouteKind.SCHEDULED;
```

- **exact code — CreateRouteRunDto addition:**

```ts
@IsOptional()
@IsArray()
@ArrayMaxSize(200)
@IsString({ each: true })
orderIds?: string[];
```

- **specs (extend `routes.service.spec.ts`, existing tests untouched):** (a) SCHEDULED dispatch, no `orderIds` → deep-equal the FULL sweep where-object and assert no `id` key (exact assertions below — copy every key currently present at L619-632 into the expected literal, verbatim); (b) SCHEDULED + `orderIds` → `BadRequestException`, `order.updateMany` never called; (c) ADHOC + `orderIds` → where contains `id: { in: [...] }` AND still contains the `customerId` filter and `routeRunStopId: null` (intersection semantics); (d) ADHOC without `orderIds` → where identical to (a); (e) second dispatch on a route with an active run → existing ConflictException still fires (re-pin).
- **exact code — key spec assertions for (a):**

```ts
const sweepArgs = prismaMock.order.updateMany.mock.calls[0][0];
expect(sweepArgs.where).toEqual({
  // copy EVERY key exactly as it exists today at routes.service.ts:619-632 —
  // customerId filter, status: { notIn: [OrderStatus.DELIVERED, OrderStatus.CANCELLED] },
  // routeRunStopId: null, plus any tenant-scoping key present in the current code.
});
expect(sweepArgs.where).not.toHaveProperty("id");
```

### WP4 — API trips module (new) + registration + specs

- **files:** `apps/api/src/trips/trips.module.ts`, `apps/api/src/trips/trips.controller.ts`, `apps/api/src/trips/trips.service.ts`, `apps/api/src/trips/dto/create-trip.dto.ts`, `apps/api/src/trips/dto/trip-eligibility.dto.ts`, `apps/api/src/trips/trips.service.spec.ts`, `apps/api/src/trips/trips.controller.spec.ts`, `apps/api/src/app.module.ts`
- **dependsOn:** WP1, WP2
- **brief:** New module (register `TripsModule` in `app.module.ts` imports). Trips get their own controller so the routes DTOs stay byte-identical. Two endpoints, both `@Roles(OPERATOR)` (copy the guard/decorator stack from the optimize endpoint in `routes.controller.ts` — same auth conventions, tenant context, etc.):
  - `GET /trips/eligibility?orderIds=a,b,c` → `[{ orderId, orderNumber, customerId, customerName, eligible, reason?, detail? }]` (customerId/customerName included so the web builder can run `groupOrdersForTrip` client-side on this payload alone).
  - `POST /trips` (`CreateTripDto` below) → creates a DRAFT ad-hoc route. Flow: (outside any tx) load the requested orders tenant-scoped with `customer` (incl. its addresses) and `routeRunStop.routeRun` (incl. driver) → run every order through `checkEligibility` (single shared predicate, also used by the GET) → if ANY ineligible, throw `ConflictException` with body `{ ineligible: [{ orderId, orderNumber, customerName, reason, detail }] }` → `resolveOrigin()` (geocode HTTP strictly OUTSIDE the tx) → (single `tenantTransaction`, matching the service-layer transaction convention used in `routes.service.ts`) ONE `route.create` with `kind: RouteKind.ADHOC`, `name: dto.name ?? \`Trip ${new Date().toISOString().slice(0, 10)}\``, `driverId: dto.driverId ?? null`, `depotLat/depotLng/depotAddress`from the resolved origin, and nested`stops: { create: [...] }`— one stop per group from`groupOrdersForTrip`(import from`@routeflow/types`), `stopNumber`1..n,`customerAddressId`= the customer's default address picked by sorting loaded addresses with the same tiebreak`addStop`uses:`isDefault`desc, then`createdAt`asc. **ZERO order writes** — a draft trip is inert; orders attach only at dispatch (WP3's sweep). Return the created route with stops. Discard-a-draft is the existing`DELETE /routes/:id`(full cascade + order unlink already verified) — no new endpoint. Known limitation (leave a code comment): same customer with two delivery addresses → one stop, because`RouteStop`is customer-keyed and the sweep matches on`customerId`.
- **exact code — DTOs (`dto/create-trip.dto.ts`):**

```ts
import { Type, Transform } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from "class-validator";

export enum TripOriginType {
  TENANT = "TENANT",
  DRIVER = "DRIVER",
  ADDRESS = "ADDRESS",
}

export class TripOriginDto {
  @IsEnum(TripOriginType)
  type!: TripOriginType;

  @ValidateIf((o) => o.type === TripOriginType.DRIVER)
  @IsString()
  @IsNotEmpty()
  driverId?: string;

  @ValidateIf((o) => o.type === TripOriginType.ADDRESS)
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  line1?: string;

  @IsOptional() @IsString() @MaxLength(100) city?: string;
  @IsOptional() @IsString() @MaxLength(50) state?: string;
  @IsOptional() @IsString() @MaxLength(20) zip?: string;
  @IsOptional() @IsNumber() lat?: number;
  @IsOptional() @IsNumber() lng?: number;
}

export class CreateTripDto {
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsString({ each: true })
  orderIds!: string[];

  @IsOptional() @IsString() @MaxLength(120) name?: string;
  @IsOptional() @IsString() driverId?: string;

  @ValidateNested()
  @Type(() => TripOriginDto)
  origin!: TripOriginDto;
}
```

- **exact code — eligibility query DTO (`dto/trip-eligibility.dto.ts`):**

```ts
export class TripEligibilityQueryDto {
  @Transform(({ value }) => (typeof value === "string" ? value.split(",").filter(Boolean) : value))
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @IsString({ each: true })
  orderIds!: string[];
}
```

- **exact code — `checkEligibility` (in `trips.service.ts`; adjust Prisma relation names — `customer.addresses`, `routeRunStop.routeRun`, run-status enum — to match `schema.prisma` exactly):**

```ts
export type TripIneligibleReason =
  | "SHIP_FULFILLMENT"
  | "INELIGIBLE_STATUS"
  | "ON_ACTIVE_RUN"
  | "PREVIOUSLY_DISPATCHED"
  | "NO_ADDRESS"
  | "NOT_FOUND";

const TRIP_ELIGIBLE_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.CONFIRMED,
  OrderStatus.PARTIALLY_DELIVERED,
];

/** Single shared predicate for GET /trips/eligibility and POST /trips.
 *  Mirrors the dispatch sweep exactly: status in the eligible set, ROUTE
 *  fulfillment, routeRunStopId null, customer has >= 1 address row. */
function checkEligibility(
  order: LoadedTripOrder | null,
): { ok: true } | { ok: false; reason: TripIneligibleReason; detail?: string } {
  if (!order) return { ok: false, reason: "NOT_FOUND" };
  if (order.fulfillPath === FulfillPath.SHIP)
    return {
      ok: false,
      reason: "SHIP_FULFILLMENT",
      detail: "Shipped by supplier/carrier, not routed",
    };
  if (!TRIP_ELIGIBLE_STATUSES.includes(order.status))
    return { ok: false, reason: "INELIGIBLE_STATUS", detail: `Status is ${order.status}` };
  if (order.routeRunStopId != null) {
    const run = order.routeRunStop?.routeRun;
    const active = run != null && (run.status === "SCHEDULED" || run.status === "IN_PROGRESS");
    if (active)
      return {
        ok: false,
        reason: "ON_ACTIVE_RUN",
        detail: `Already on an active run${run.driver?.contactName ? ` with ${run.driver.contactName}` : ""}`,
      };
    return {
      ok: false,
      reason: "PREVIOUSLY_DISPATCHED",
      detail: "Attached to a finished run (stale link)",
    };
  }
  // NO_ADDRESS only when ZERO CustomerAddress rows exist — un-geocoded rows are
  // fine, the optimizer geocodes stops inline before validating.
  if (!order.customer || order.customer.addresses.length === 0)
    return { ok: false, reason: "NO_ADDRESS", detail: "Customer has no delivery address" };
  return { ok: true };
}
```

- **exact code — `resolveOrigin` (in `trips.service.ts`):**

```ts
private async resolveOrigin(
  tenantId: string,
  origin: TripOriginDto,
): Promise<{ depotLat: number; depotLng: number; depotAddress: string }> {
  switch (origin.type) {
    case TripOriginType.DRIVER: {
      const driver = await this.prisma.driver.findFirst({ where: { id: origin.driverId, tenantId } });
      if (!driver) throw new NotFoundException("Driver not found");
      if (driver.homeLat == null || driver.homeLng == null) {
        throw new BadRequestException(
          `${driver.contactName ?? "This driver"} has no home base set. Add a home address on the driver profile first.`,
        );
      }
      return { depotLat: driver.homeLat, depotLng: driver.homeLng, depotAddress: driver.homeAddress ?? "Driver home base" };
    }
    case TripOriginType.ADDRESS: {
      const addr = { line1: origin.line1!, city: origin.city ?? "", state: origin.state ?? "", zip: origin.zip ?? "" };
      const apiKey = this.configService.get<string>("googleMaps.apiKey");
      const geo = await geocodeAddress(addr, apiKey, this.logger);
      if (!geo) {
        // HARD 400, deliberately inverting geocodeAddress's best-effort contract:
        // a silently-null origin would make resolveDepot fall back to the tenant
        // warehouse — the worst possible failure for a custom-origin trip.
        throw new BadRequestException("Could not locate the trip start address. Check it and try again.");
      }
      return {
        depotLat: geo.lat,
        depotLng: geo.lng,
        depotAddress: [origin.line1, origin.city, origin.state, origin.zip].filter(Boolean).join(", "),
      };
    }
    case TripOriginType.TENANT:
    default: {
      // Mirror resolveDepot tiers 2-3 (route-optimization.service.ts L78-140,
      // READ-ONLY reference): tier 2 = the SystemConfig cached tenant depot;
      // tier 3 = geocode the tenant's own address via geocodeAddress. Transplant
      // that lookup here verbatim into resolveTenantDepot(tenantId) returning
      // { depotLat, depotLng, depotAddress } | null.
      const depot = await this.resolveTenantDepot(tenantId);
      if (!depot) {
        throw new BadRequestException(
          "No tenant depot is configured. Set a depot in route settings or choose a different start point.",
        );
      }
      return depot;
    }
  }
}
```

- **specs — `trips.service.spec.ts`** (mock `geocodeAddress` via `jest.mock("../common/geocode.util", () => ({ geocodeAddress: jest.fn() }))`): grouping produces one stop per customer with the default-address tiebreak; ADDRESS origin success → `route.create` called with `depotLat/depotLng/depotAddress` from the geocode result and `kind: ADHOC`; **geocode-null hard-stop (exact assertions below)**; DRIVER origin with `homeLat: null` → 400 naming the driver; `createTrip` NEVER calls `order.update`/`order.updateMany` (assert on the mock); each rejection reason (SHIP order, DRAFT status, stale-attached vs active-attached — distinct reasons, no-address customer, unknown id) surfaces in the 409 `ineligible` array with the right `reason`; GET eligibility and POST createTrip return identical reasons for the same fixture set (call both against one fixture, compare); server stop grouping deep-equals `groupOrdersForTrip(fixture)` output.
- **exact code — geocode-null spec assertions:**

```ts
(geocodeAddress as jest.Mock).mockResolvedValue(null);
await expect(
  service.createTrip(tenantId, {
    orderIds: [eligibleOrder.id],
    origin: {
      type: TripOriginType.ADDRESS,
      line1: "1 Nowhere Rd",
      city: "Austin",
      state: "TX",
      zip: "78701",
    },
  }),
).rejects.toBeInstanceOf(BadRequestException);
expect(prismaMock.route.create).not.toHaveBeenCalled();
```

- **specs — `trips.controller.spec.ts`:** assert the OPERATOR roles metadata on both handlers (copy the metadata-reflection pattern from an existing controller spec in the repo); re-pin that the optimize endpoint's throttle decorator in `routes.controller.ts` is untouched (import and reflect, read-only).

### WP5 — API orders: fulfillPath end-to-end

- **files:** `apps/api/src/orders/orders.service.ts`, `apps/api/src/orders/orders.controller.ts`, the DTO files under `apps/api/src/orders/dto/` holding `ListOrdersDto` and `CreateOrderDto`, new `apps/api/src/orders/dto/update-fulfill-path.dto.ts`, `apps/api/src/orders/orders.service.spec.ts`
- **dependsOn:** WP1
- **brief:** Five touches. (1) `ListOrdersDto` (existing fields: customerId, productId, search, status, urgent, page, limit, deliveryDateFrom/To) gains `@IsOptional() @IsEnum(FulfillPath) fulfillPath?: FulfillPath;` and `findAll` (flat filters ~L291) gains one line: `if (query.fulfillPath) where.fulfillPath = query.fulfillPath;`. Ensure `fulfillPath` is present on list and detail payloads (it will be by default unless a `select` prunes it — check). (2) `CreateOrderDto` gains the same optional field; in `create()` (L1437), where the customer is already loaded, set `fulfillPath: dto.fulfillPath ?? customer.fulfillPath ?? FulfillPath.ROUTE` on the created order (add `fulfillPath` to the customer load's select if one exists). (3) New `PATCH /orders/:id/fulfill-path`, modeled directly on the existing `PATCH :id/commission-rate` endpoint in `orders.controller.ts` (same roles — OPERATOR/TENANT_ADMIN — same tenant plumbing). Service method: tenant-scoped load (404 if missing); reject with 400 when status is OUT_FOR_DELIVERY, DELIVERED, or CANCELLED ("Fulfillment path can only be changed while the order is open"); otherwise `order.update({ data: { fulfillPath } })`. (4) `changeStatus` (L2076) OUT_FOR_DELIVERY notification: the driver-name block (~L2276-2284) is guarded by `order.routeRunId` — add ONLY the additive else-if below; the ROUTE branch stays untouched. Do NOT touch the transition map (L2100-2107) or the DELIVERED branch (L2168-2225). (5) Do not touch `updateShipment` (L4257) — shipment tracking is fully built.
- **exact code — DTOs:**

```ts
// ListOrdersDto AND CreateOrderDto each gain:
@IsOptional()
@IsEnum(FulfillPath)
fulfillPath?: FulfillPath;

// dto/update-fulfill-path.dto.ts (entire file body):
export class UpdateFulfillPathDto {
  @IsEnum(FulfillPath)
  fulfillPath!: FulfillPath;
}
```

- **exact code — carrier-name else-if (appended to the existing block; existing code unchanged):**

```ts
if (order.routeRunId) {
  // ...existing driver-name lookup — UNCHANGED...
} else if (order.fulfillPath === FulfillPath.SHIP) {
  driverName = order.shippingCarrier ?? "the carrier";
}
```

- **specs (extend `orders.service.spec.ts`):** **SHIP-vs-ROUTE DELIVERED invoicing parity (exact assertions below)**; open-draft-invoice DELIVERED path still calls `reconcileOrderDraftInvoice(id, { basis: "order" })` and never `basis: "delivered"` (re-pin); OUT_FOR_DELIVERY on a run-less SHIP order writes no run data and uses the carrier name in the notification variable; create() default chain — dto value wins, else customer's `fulfillPath`, else ROUTE (three cases); `findAll` passes `fulfillPath` through when present and where has NO `fulfillPath` key when omitted; fulfill-path patch rejects OUT_FOR_DELIVERY/DELIVERED/CANCELLED and succeeds on CONFIRMED.
- **exact code — invoicing parity spec assertions:**

```ts
// Fixture: OUT_FOR_DELIVERY order, one item { qty: 10, deliveredQty: 4, invoicedQty: 0 }, no open draft invoice.
mockLoadedOrder({ ...baseOrder, fulfillPath: FulfillPath.ROUTE });
await service.changeStatus(tenantId, baseOrder.id, OrderStatus.DELIVERED, actor);
const routeCall = invoicesMock.createInvoiceFromOrderWithTenant.mock.calls[0];

jest.clearAllMocks(); // re-arm all mocks identically before the SHIP pass
mockLoadedOrder({ ...baseOrder, fulfillPath: FulfillPath.SHIP });
await service.changeStatus(tenantId, baseOrder.id, OrderStatus.DELIVERED, actor);
const shipCall = invoicesMock.createInvoiceFromOrderWithTenant.mock.calls[0];

expect(shipCall).toEqual(routeCall); // deep-equal: SHIP bills ordered qty 10, deliveredQty 4 ignored — byte-identical to ROUTE
```

### WP6 — API drivers: home base

- **files:** `apps/api/src/drivers/` — the DTO file holding `UpdateDriverDto`, `drivers.service.ts`, and its spec file
- **dependsOn:** WP1
- **brief:** `UpdateDriverDto` (currently contactName/phone/vehicle\*) gains four optional structured fields: `homeLine1?`, `homeCity?`, `homeState?`, `homeZip?` (all `@IsOptional() @IsString()` with sane `@MaxLength`). In the driver update path (serves `PATCH /drivers/:id` OPERATOR and `PATCH /drivers/me`): when any home field is present in the DTO, compose `homeAddress` as the comma-joined non-empty parts (or `null` if all empty), then BEST-EFFORT geocode via `geocodeAddress({ line1, city, state, zip }, configService.get("googleMaps.apiKey"), logger)` — on success write `homeLat/homeLng`, on null write `homeLat: null, homeLng: null` (no throw; this mirrors the customers/suppliers geocode-on-save convention; a trip using a driver with no coords gets a helpful 400 from WP4's `resolveOrigin`). Spec: home fields update composes address + writes coords on geocode success; writes nulls without throwing on geocode failure; an update WITHOUT home fields never calls `geocodeAddress`. No driver-app UI anywhere.

### WP7 — Web API clients + trip draft

- **files:** `apps/web/lib/api/routes.ts`, `apps/web/lib/api/orders.ts`, `apps/web/lib/trip-draft.ts` (new)
- **dependsOn:** WP2
- **brief:** `routes.ts`: add `kind: "SCHEDULED" | "ADHOC"` to the `Route` type; `useRoutes` accepts optional `kind` param (wired into the query key + querystring); `useCreateRouteRun`'s input gains optional `orderIds?: string[]`; new `useCreateTrip()` (POST `/trips`, body `{ orderIds, name?, driverId?, origin }` with `origin` typed as the union `{ type: "TENANT" } | { type: "DRIVER"; driverId: string } | { type: "ADDRESS"; line1: string; city?: string; state?: string; zip?: string }`; invalidate the routes query on success) and new `useTripEligibility(orderIds: string[])` (GET `/trips/eligibility?orderIds=` csv, enabled when non-empty). Follow the file's existing fetch/mutation idioms exactly — `usePatchOrderCommissionRate` at `orders.ts` ~L527 is the shape precedent. `orders.ts`: add `fulfillPath: "ROUTE" | "SHIP"` to the `Order` type; `useOrders` accepts optional `fulfillPath`; new `usePatchOrderFulfillPath` cloned from `usePatchOrderCommissionRate` targeting `PATCH /orders/:id/fulfill-path`.
- **exact code — `apps/web/lib/trip-draft.ts` (entire file):**

```ts
const KEY = "rf-trip-draft-v1";
const TTL_MS = 30 * 60 * 1000;

export interface TripDraft {
  orderIds: string[];
  savedAt: number;
}

export function saveTripDraft(orderIds: string[]): void {
  try {
    sessionStorage.setItem(
      KEY,
      JSON.stringify({ orderIds, savedAt: Date.now() } satisfies TripDraft),
    );
  } catch {
    /* storage unavailable — builder will show its empty state */
  }
}

export function loadTripDraft(): TripDraft | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const draft = JSON.parse(raw) as TripDraft;
    if (
      !Array.isArray(draft.orderIds) ||
      draft.orderIds.length === 0 ||
      Date.now() - draft.savedAt > TTL_MS
    ) {
      sessionStorage.removeItem(KEY);
      return null;
    }
    return draft;
  } catch {
    return null;
  }
}

export function clearTripDraft(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    /* noop */
  }
}
```

### WP8 — Web trip builder + routes hygiene

- **files:** `apps/web/app/(dashboard)/routes/page.tsx`, `apps/web/app/(dashboard)/routes/trips/new/page.tsx` (new), `apps/web/app/(dashboard)/routes/trips/page.tsx` (new), `apps/web/app/(dashboard)/routes/trips/_components/TripOriginPicker.tsx` (new), `apps/web/app/(dashboard)/routes/trips/_components/TripStopList.tsx` (new), `apps/web/app/(dashboard)/routes/trips/_components/TripSkippedPanel.tsx` (new)
- **dependsOn:** WP2, WP7
- **brief:** Living under `/routes` means deep-link dev-mode gating is inherited from `DEV_MODE_PREFIXES` — add no gating code. **Builder (`trips/new`)** is a phased client page:
  1. **PICKING** — `loadTripDraft()`; if null, empty state linking back to `/orders` (the `?n=` query param is display-only order count). Fetch `useTripEligibility(draft.orderIds)`; run `groupOrdersForTrip` (import from `@routeflow/types`) over the ELIGIBLE rows of that payload for the stop preview (`TripStopList`, grouped by customer, per-customer remove); show ineligible rows in `TripSkippedPanel` with human labels per reason (include the known limitation note: one stop per customer even with multiple addresses). Driver picker (existing drivers hook) sits ABOVE `TripOriginPicker` because the DRIVER_HOME origin needs a selected driver. Origin options: DEPOT (label from `useRouteSettings()` depot), DRIVER_HOME, CUSTOM (structured line1/city/state/zip fields — the server geocodes; no Maps JS). Date picker for the run date.
  2. **Build** — `useCreateTrip().mutate({ orderIds: remainingIds, driverId, origin })`; on success immediately fire `useOptimizeTemplate()` — it is zero-arg returning a mutation whose `mutate(routeId: string)` — BEST-EFFORT: its `onError` shows a warning toast ("Trip created; optimization unavailable — stops in selection order") and proceeds; never roll back the route.
  3. **BUILT** — render `TemplateRouteMap` (from `apps/web/app/(dashboard)/routes/templates/[id]/TemplateRouteMap.tsx`; props `{ stops, selectedStopId?, onSelectStop?, onRemoveStop?, depotLat?, depotLng?, depotAddress? }` — NOT CreateRouteMap/RouteMap) with the created route's stops + depot; optional name edit via existing route update hook.
  4. **Send** — `useCreateRouteRun` with `{ routeId, date, driverId, orderIds: remainingIds }`; on success `clearTripDraft()` (this is the ONLY auto-clear) and `router.replace` to the run's page (match how `routes/page.tsx` links to a run). **Discard** button (BUILT phase): `useDeleteRoute(routeId)` + `clearTripDraft()` + back to `/orders`.
     **Hygiene:** `routes/page.tsx` switches its list to `useRoutes({ kind: "SCHEDULED" })`, and gains a "Trips" section between Active Runs and Templates: last 5 ADHOC routes via `useRoutes({ kind: "ADHOC" })` (a "Draft" pill when a trip has no runs, a delete affordance via `useDeleteRoute`, link to full list). Full list page `trips/page.tsx`: all ADHOC routes, same row treatment. Match the page's existing section/card idioms.

### WP9 — Web orders list, forms, ShipmentCard, CommandPalette

- **files:** `apps/web/app/(dashboard)/orders/page.tsx`, `apps/web/app/(dashboard)/orders/[id]/page.tsx`, `apps/web/app/(dashboard)/orders/_components/CreateOrderModal.tsx`, `apps/web/app/(dashboard)/customers/_components/CustomerFormModal.tsx`, `apps/web/app/(dashboard)/customers/page.tsx`, `apps/web/app/(dashboard)/customers/[id]/page.tsx`, `apps/web/components/ShipmentCard.tsx`, `apps/web/components/CommandPalette.tsx`
- **dependsOn:** WP7
- **brief:**
  - **Orders list (`orders/page.tsx`)** — multi-select already exists (`selectMode`, `selected: Set<string>`, bulkbar ~L423-475, tri-state header checkbox ~L515-533). Add a "Plan delivery trip" button to the EXISTING bulkbar, rendered only when `useDeveloperMode().enabled` (from `apps/web/lib/api/addons.ts` — hide-only gating uses `enabled`, NOT `resolved`); on click: `saveTripDraft([...selected])` then `router.push(\`/routes/trips/new?n=${selected.size}\`)`. Also: a "Shipped" (SHIP) pill in the status cell when `order.fulfillPath === "SHIP"`; a fulfillment filter Select (All/Route/Ship) wired through ALL SIX of the page's `useUrlFilters`touchpoints (declaration, parse, apply-to-query, UI control, active-filter chips, clear-all); a`fulfillPath` column in the CSV export.
  - **Order detail (`orders/[id]/page.tsx`)** — inline fulfillment control using `usePatchOrderFulfillPath` (disabled once status is OUT_FOR_DELIVERY/DELIVERED/CANCELLED, matching the server rule). For SHIP orders, relabel the existing action-bar buttons ONLY (handlers unchanged): "Out for Delivery" (~L2299/2306, `handleLock`) → "Mark shipped"; "Mark as Delivered" (~L2335/2341, `handleDeliver`) → "Mark delivered"; "Return to Confirmed" (~L2349) → "Unmark shipped". After a SHIP order is marked shipped, nudge tracking entry by incrementing a local counter passed to `ShipmentCard`'s new `openSignal` prop.
  - **`ShipmentCard.tsx`** — add optional `openSignal?: number` prop; on change to a positive value, open/expand the card's tracking edit state (whatever boolean it already keeps): `useEffect(() => { if (openSignal) setOpen(true); }, [openSignal]);`. Undefined = behavior byte-identical (backwards-compatible; the card is used elsewhere).
  - **`CreateOrderModal.tsx`** — zod schema (~L44) gains `fulfillPath: z.enum(["ROUTE", "SHIP"]).default("ROUTE")`; defaultValues (~L304) seed it; when a customer is selected, reset the field to that customer's `fulfillPath` (the per-customer default); a two-option segmented control in the form; **parked-draft round-trip is mandatory** — include `fulfillPath` in the parked-draft payload (~L674) AND the hydrate path (~L794-807), the file's own documented trap.
  - **`CustomerFormModal.tsx`** — "Default fulfillment" Select: zod schema (~L19), `initialData` type (~L93), BOTH branches of `buildDefaultValues` (~L120 and ~L143), create payload (~L263), update payload (~L307). Both callers must pass `fulfillPath` in `initialData`: `customers/page.tsx` (~L1082) and `customers/[id]/page.tsx` (~L3853).
  - **`CommandPalette.tsx`** — new command `act-plan-trip` ("Plan delivery trip" → navigate to `/routes/trips/new`), AND add `"act-plan-trip"` to `DEV_MODE_COMMAND_IDS` (~L69) IN THE SAME COMMIT — a command outside that list leaks to non-dev tenants and bounces off the gated route. No sidebar nav leaf (the `/routes` `startsWith` active-state would double-light), no new keyboard chord.
  - Do NOT touch `apps/web/app/(dashboard)/layout.tsx`.

### WP10 — Mobile plumbing, multi-select, trip builder

- **files:** `apps/mobile/app/(operator)/_layout.tsx`, `apps/mobile/lib/operator-tabs.ts`, `apps/mobile/app/(operator)/(tabs)/dispatch.tsx`, `apps/mobile/app/(operator)/(tabs)/orders/index.tsx`, `apps/mobile/app/(operator)/trips/_layout.tsx` (new), `apps/mobile/app/(operator)/trips/new.tsx` (new), `apps/mobile/app/(operator)/trips/index.tsx` (new), `apps/mobile/lib/trip-draft.ts` (new), `apps/mobile/lib/trip-grouping.ts` (new), `apps/mobile/lib/api/admin.ts`, `apps/mobile/__tests__/trip-grouping.test.ts` (new), `apps/mobile/__tests__/operator-tabs.test.ts`
- **dependsOn:** none (transplants WP2's helper verbatim from this plan)
- **brief:**
  - **Gating — BOTH edits required:** `_layout.tsx` `DEV_MODE_SECTIONS` Set (~L13) adds `"trips"`; `lib/operator-tabs.ts` `SECTION_TO_TAB` (~L41) adds `trips: "dispatch"` (an unmapped section produces a dead tab bar). Add a "Trips" row to the dispatch hub `dispatch.tsx` (already dev-gated) linking to `/trips`. Do NOT touch `more.tsx` (ungated — an entry there would bounce).
  - **Orders multi-select (`orders/index.tsx`)** — port the web `Set<string>` idiom (NOT ScanTray): NavBar (from `packages/ui/src/mobile/ios/NavBar.tsx`, `leading` prop) gets a "Select"/"Done" leading button hidden when dev mode is off (use the same dev-mode hook `_layout.tsx` uses for `DEV_MODE_SECTIONS`); in select mode rows show checkmarks and tapping toggles membership; a bottom bulkbar shows "N selected · Plan trip" only. Plan trip stores ids in the trip-draft store and routes to `/trips/new`. `orders` must NOT join `DEV_MODE_SECTIONS`.
  - **`lib/trip-draft.ts`** — a small zustand store (house style): `{ orderIds: string[]; setOrderIds(ids): void; clear(): void }`.
  - **`lib/trip-grouping.ts`** — byte-for-byte mirror of the WP2 `packages/types/trip-grouping.ts` exact-code block above (mobile Jest's `moduleNameMapper` stubs `@routeflow/types`, so mobile mirrors shared helpers locally — same convention as `lib/shipping.ts`).
  - **Trip builder (`trips/new.tsx`)** — a review screen (SafeAreaView + NavBar + ScrollView, NOT FormSheet): Stops section (grouped via `groupOrdersForTrip` over the eligibility payload, swipe-to-drop a customer) → Skipped section with reasons → "Start from" (all three origin types; ADDRESS = structured line1/city/state/zip fields, server geocodes — no Maps JS) → Driver → Date → "Create trip" runs the same 3-call sequence as web (POST `/trips` → POST `/routes/:id/optimize` best-effort, warn-don't-fail → create run with `orderIds`) → clear draft store → land on the run screen. `trips/index.tsx`: minimal list of ADHOC routes (kind param). `trips/_layout.tsx`: plain Stack.
  - **`lib/api/admin.ts`** — this WP owns ALL mobile API-client changes (WP11 only consumes them): add `fulfillPath: "ROUTE" | "SHIP"` to `AdminOrder`; add `fulfillPath?` to `useAdminOrders` params (~L224); add `fulfillPath?` to the create-order payload type used by NewOrderScreen; add hooks for trip eligibility, create-trip, kind-filtered routes list, and pass-through of `orderIds` on the run-creation mutation — following the file's existing hook conventions (if run-creation hooks live in a different `lib/api/` file, edit that file too; all of `apps/mobile/lib/api/` belongs to this WP).
  - **Tests:** new `__tests__/trip-grouping.test.ts` — every skip reason (NO_CUSTOMER), group totals, first-seen ordering, duplicate-id dedupe; extend `__tests__/operator-tabs.test.ts` — `trips` maps to `dispatch`. Pure logic only, per mobile Jest convention.

### WP11 — Mobile fulfillment

- **files:** `apps/mobile/app/(operator)/(tabs)/orders/[id].tsx`, `apps/mobile/lib/order-actions.ts` (new), `apps/mobile/components/NewOrderScreen.tsx`, `apps/mobile/components/CustomerForm.tsx`, `apps/mobile/__tests__/order-actions.test.ts` (new)
- **dependsOn:** WP10 (consumes `AdminOrder.fulfillPath` + payload types from `lib/api/admin.ts`)
- **brief:** EXTRACT the private `statusActions(current)` function (~L100 in `orders/[id].tsx`) to `apps/mobile/lib/order-actions.ts` with signature `statusActions(status: OrderStatus, fulfillPath: "ROUTE" | "SHIP" = "ROUTE")`. With `fulfillPath === "ROUTE"` the output must be byte-identical to today. With `"SHIP"`: relabel "Out for Delivery" → "Mark shipped", "Mark as Delivered" → "Mark delivered", "Return to Confirmed" → "Unmark shipped", and DROP the "Partial delivery" action entirely (a dead end for carrier shipments — the target statuses themselves are unchanged). The order detail screen passes `order.fulfillPath` and shows a SHIP pill near the status. `CustomerForm.tsx` (single form for create+edit): "Default fulfillment" control wired into its payloads and initial values. `NewOrderScreen.tsx`: fulfillment row in `OrderOptionsSection` (~L2368) seeded from the selected customer's default, included in the submit payload (~L1725) AND the draft payload + hydrate (~L1488/1503 — round-trip required). Tests (`order-actions.test.ts`, pure logic): SHIP relabels + dropped partial-delivery; ROUTE output deep-equals the pre-extraction behavior; every action's target status passes `canTransitionOrder` from `apps/mobile/lib/order-status-flow.ts`.

### WP12 — Playwright gate spec

- **files:** `apps/web/e2e/19-trip-builder-gate.spec.ts` (new), `apps/web/playwright.config.ts` (adjust paths if the e2e dir and config sit at repo root — put the spec wherever specs 01-18 live)
- **dependsOn:** WP8, WP9
- **brief:** Existing specs are numbered 01-09 and 11-18 (there is NO 10 — do not recycle it); the new spec is 19. Copy the branching pattern from `18-sales-agents-gate.spec.ts` VERBATIM for auth + addon detection: fetch `GET /api/v1/tenants/me/addons` with the operator access token, branch on `addons.includes("developer_mode")`, and assert BOTH branches — enabled: orders-list select mode exposes the "Plan delivery trip" bulkbar action and `/routes/trips/new` renders the builder; disabled: no bulkbar trip action, and `/routes/trips/new` bounces (inherited `/routes` prefix gating). STRICTLY READ-ONLY: never click Build/Create trip/Send — assert visibility only. Every spec needs its own `playwright.config.ts` `projects[]` entry or it silently never runs.
- **exact code — playwright.config.ts projects[] entry:**

```ts
{
  name: "trip-builder-gate",
  testMatch: /19-trip-builder-gate\.spec\.ts/,
  dependencies: ["setup"],
  use: { ...devices["Desktop Chrome"], storageState: path.join(AUTH_DIR, "operator.json") },
},
```

### WP13 — Demo-seed coordinates, Phase 0 findings note, code map

- **files:** `apps/api/scripts/demo-seed.js`, `docs/phase0-adhoc-trips-findings.md` (new), `.claude/code-map/api.md`, `.claude/code-map/web.md`, `.claude/code-map/mobile.md`, `.claude/code-map/packages.md`, `.claude/code-map/INDEX.md`, `.claude/code-map/CHANGELOG.md`, `.claude/code-map/_meta.json`
- **effort:** low
- **dependsOn:** WP1-WP12 (runs last; documents the finished state)
- **brief:** (1) `demo-seed.js`: add deterministic synthetic lat/lng to EVERY demo customer address — both the creates (near the fulfillPath fields at ~L168-229) and the upserts (~L549-562, in BOTH create and update branches so re-seeding repairs existing null rows). This makes the optimizer's local NN+2-opt fallback work with no `GOOGLE_MAPS_API_KEY`. (2) Findings note (short, dated 2026-08-24): live check on the demo tenant showed optimize returning 400 — root cause: demo customer addresses seeded with `lat = null` (Prisma seed bypasses geocode-on-create) and `GOOGLE_MAPS_API_KEY` unset on the prod API; fix = deterministic seed coords (this WP) + optional owner action to set the key; also record: route PATCH replace-all landmine confirmed absent from this feature's path. (3) Code map: update the touched entries in `{api,web,mobile,packages}.md` (+ INDEX where new files warrant), add ONE dated bullet atop `CHANGELOG.md` summarizing this feature, and REPLACE (never accumulate) the `_meta.json` notes + bump `mappedSha`/`generatedAt`.
- **exact code — deterministic coords helper for demo-seed.js:**

```js
// Deterministic Austin-area spread — no randomness, so re-seeding is idempotent.
const DEMO_ORIGIN = { lat: 30.2672, lng: -97.7431 }; // downtown Austin
function demoAddressCoords(index) {
  const row = index % 7;
  const col = Math.floor(index / 7) % 7;
  return {
    lat: DEMO_ORIGIN.lat + (row - 3) * 0.015, // ~1.6 km N-S steps
    lng: DEMO_ORIGIN.lng + (col - 3) * 0.018, // ~1.7 km E-W steps
  };
}
```

## Acceptance criteria

1. Exactly one new migration exists at `apps/api/prisma/migrations/20260904000000_adhoc_trips_and_fulfillment/migration.sql` and matches WP1's SQL; `schema.prisma` mirrors it; NO backfill of `Order.fulfillPath`; the pre-existing `FulfillPath` enum is reused, not redeclared.
2. `CreateRouteDto` and `UpdateRouteDto` contain no `kind` field (kind is unforgeable via the public routes API).
3. `createRun`: `orderIds` on a non-ADHOC route → 400 before any writes; on ADHOC, the sweep where gains ONLY `id: { in: ... }` while retaining the `customerId` filter and `routeRunStopId: null`; a SCHEDULED dispatch produces a where-object deep-equal to today's (spec asserts full deep-equal AND `not.toHaveProperty("id")`); ADHOC without `orderIds` sweeps identically to SCHEDULED; the active-run 409 guard still fires.
4. `findAllRoutes` defaults to `kind: SCHEDULED` (ships before any ADHOC row can exist); `getCustomerRouteAssignments` filters to SCHEDULED routes.
5. `GET /trips/eligibility` and `POST /trips` exist, both OPERATOR-only, sharing ONE `checkEligibility` predicate (spec pins agreement); eligible = status ∈ {PENDING, CONFIRMED, PARTIALLY_DELIVERED} ∧ `fulfillPath: ROUTE` ∧ `routeRunStopId: null` ∧ ≥1 CustomerAddress row; non-null `routeRunStopId` distinguishes ON_ACTIVE_RUN (run SCHEDULED/IN_PROGRESS, with run/driver detail) from PREVIOUSLY_DISPATCHED; NO_ADDRESS only on zero address rows.
6. `POST /trips` with any ineligible order → 409 listing `{orderId, orderNumber, customerName, reason, detail}` per order; on success creates ONE route (`kind: ADHOC`, depot\* = resolved origin, one stop per distinct customer via `groupOrdersForTrip`, default-address tiebreak `isDefault` desc / `createdAt` asc, stopNumber 1..n) and performs ZERO order writes (spec-pinned).
7. `resolveOrigin`: DRIVER without home coords → 400 naming the driver; ADDRESS geocode failure → 400 AND `route.create` never called (spec-pinned); TENANT mirrors resolveDepot tiers 2-3; geocode HTTP happens outside the transaction.
8. Orders: `fulfillPath` on list/detail payloads; `ListOrdersDto.fulfillPath` filters `findAll` (omitted ⇒ no where key, spec-pinned); `create()` defaults `dto.fulfillPath ?? customer.fulfillPath ?? ROUTE`; `PATCH /orders/:id/fulfill-path` exists (OPERATOR/TENANT_ADMIN, commission-rate precedent) and rejects OUT_FOR_DELIVERY/DELIVERED/CANCELLED.
9. `changeStatus`: additive carrier-name else-if only; ROUTE notification branch, transition map, and the entire DELIVERED branch byte-unchanged; the SHIP-vs-ROUTE DELIVERED invoicing parity spec (deep-equal `createInvoiceFromOrderWithTenant` calls, ordered qty 10 billed, deliveredQty 4 ignored) exists and passes; open-draft reconcile still `basis: "order"`.
10. Drivers: `UpdateDriverDto` home fields; best-effort geocode on save (null coords on failure, no throw); no driver-facing UI anywhere in the diff.
11. `packages/types`: `RouteKind` exported; `trip-grouping.ts` matches WP2's code and is re-exported from `index.ts`; `apps/mobile/lib/trip-grouping.ts` mirrors it byte-for-byte with its own Jest test.
12. Web: bulkbar "Plan delivery trip" rendered only when `useDeveloperMode().enabled`; `DEV_MODE_PREFIXES` unchanged (no `/orders`); trip builder at `/routes/trips/new` implements PICKING → Build (optimize best-effort, warn-don't-fail) → BUILT (`TemplateRouteMap`) → Send (`useCreateRouteRun` + `orderIds`); draft auto-clears ONLY on dispatch success; Discard = `useDeleteRoute` + clear; routes page lists SCHEDULED only + Trips section; SHIP pill, fulfillment filter through all 6 `useUrlFilters` touchpoints, CSV column.
13. Web forms: `CreateOrderModal` fulfillPath round-trips through the parked-draft payload AND hydrate; `CustomerFormModal` covers both `buildDefaultValues` branches, both payloads, and both callers' `initialData`; order detail has the fulfill-path control (disabled once shipped), SHIP relabels on existing handlers only, and the `ShipmentCard.openSignal` nudge (prop optional and backwards-compatible).
14. `CommandPalette`: `act-plan-trip` added AND present in `DEV_MODE_COMMAND_IDS` in the same commit; no new nav leaf or chord.
15. Mobile: `DEV_MODE_SECTIONS` += `trips` AND `SECTION_TO_TAB` += `trips: "dispatch"` (both); Trips row on `dispatch.tsx`; nothing added to `more.tsx`; orders select-mode affordances hidden without dev mode and `orders` NOT added to `DEV_MODE_SECTIONS`; builder screens exist with all three origin types; `statusActions` extracted to `lib/order-actions.ts(status, fulfillPath = "ROUTE")` — ROUTE output byte-identical, SHIP relabels + drops "Partial delivery"; NewOrderScreen + CustomerForm wired with draft round-trip; mobile Jest tests (trip-grouping, order-actions, operator-tabs) pass.
16. `e2e/19-trip-builder-gate.spec.ts` exists (read-only, asserts BOTH addon branches, 18-spec pattern) with its own `playwright.config.ts` project entry exactly as WP12 specifies.
17. Demo-seed adds deterministic coords to all demo customer addresses (creates AND upsert-update branches); Phase 0 findings note committed under `docs/`; code map files + CHANGELOG updated, `_meta.json` notes replaced with bumped `mappedSha`/`generatedAt`.
18. Diff-clean untouchables: `completeStop`, `completeWithPayment`, `recordDeliveryPaymentInTx`, all `reconcile*` functions, delivery-payment specs, `route-optimization.service.ts`, optimize endpoints/throttles, `apps/web/app/(dashboard)/layout.tsx`.
19. `npm run verify` passes; all pre-existing specs green without modification (except the explicitly extended spec files).

## Verification commands

- Per-round (cheap): `npx tsc -p apps/api/tsconfig.build.json --noEmit`
- Final gate: `npm run verify` (turbo check-types + lint + test)
- Playwright is NOT part of the gate — it needs a running stack. Spec 19 is review-only at gate time; it runs later against a local stack per the repo's local-e2e reference.

## Risks & rollback

- **Sweep regression is the money risk.** Any change to the SCHEDULED where-object alters which orders attach to runs (and thus delivery payments downstream). The conditional-spread pattern + the deep-equal/no-`id` spec is the tripwire — reviewers should diff L619-632 by eye as well.
- **Silent origin fallback.** If the geocode-null 400 is weakened to best-effort, `resolveDepot` will silently substitute the tenant warehouse for a custom origin — the "route.create never called" spec is the guard; do not soften it.
- **fulfillPath backfill creep.** Any migration or seed writing `Order.fulfillPath = SHIP` from customer data would drop live orders out of dispatch on deploy. The migration must contain exactly the WP1 SQL.
- **Gating leaks.** Web: a CommandPalette command outside `DEV_MODE_COMMAND_IDS`, or a nav leaf, leaks the feature. Mobile: a `more.tsx` entry (ungated) or a missing `SECTION_TO_TAB` mapping (dead tab bar) are the two known failure shapes.
- **Parked-draft/hydrate drift.** Both order forms have documented round-trip traps; a missed hydrate path silently loses `fulfillPath` on draft restore.
- **Shared Prisma client.** `npx prisma generate` writes the shared root client; if parallel sessions run in other worktrees, coordinate before regenerating.
- **Rollback:** the feature is additive and dev-gated. Code rollback = revert the PR branch (no prod deploy happens from this pipeline). Schema rollback (owner-run, only if ever applied): drop the three Driver columns, `Order.fulfillPath`, `Route_tenantId_kind_idx`, `Route.kind`, then `DROP TYPE "RouteKind"` — safe while no ADHOC rows exist. Prod apply is owner-run (validated backup → `railway run --service postgres node apps/api/scripts/prod-migrate.mjs` → BEFORE app deploy; post-checks: `SELECT count(*) FROM "Route" WHERE kind <> 'SCHEDULED'` = 0 and same for `"Order"."fulfillPath" <> 'ROUTE'`). End state of this pipeline: hook-verified branch + OPEN PR + owner runbook — no merge, no prod writes.

### Critical Files for Implementation

- apps/api/src/routes/routes.service.ts
- apps/api/src/trips/trips.service.ts (new)
- apps/api/src/orders/orders.service.ts
- apps/web/app/(dashboard)/routes/trips/new/page.tsx (new)
- packages/types/trip-grouping.ts (new)

## Design directives (UX) — binding for WP8–WP11; review lenses check these

Derived from the Intent principles/anti-pattern catalog and ui-ux-pro-max rules, scoped to this feature. The existing design system (web: navy/brand tokens, Radix + Tailwind, lucide icons; mobile: iOS kit in `packages/ui/src/mobile/ios/`, Ionicons) is authoritative — these directives operate WITHIN it.

1. **Transparent consequences (Intent P1/P3).** The trip builder's primary CTA must state what it does with real numbers: "Send 3 stops · 7 orders to {driverName}" (web + mobile). After dispatch, navigate to the run page (visible outcome), plus a success toast. The SHIP "Mark shipped" action gets one line of helper text: "Sets the order to Out for Delivery — the customer is notified it's on the way."
2. **Nothing silently missing (Cat 9 Dead Ends / plan's visible-reason rule).** Skipped/ineligible orders ALWAYS render in a skipped panel with per-order reason text (from `groupOrdersForTrip` client-side and the server's `ineligible[]` post-submit). Never drop an order from the preview without a visible row explaining why.
3. **Destructive safeguards (Cat 9 Destructive Defaults, High).** "Discard trip" (after Build) and trip Delete on the trips list require an inline confirm step (same two-tap idiom as the orders bulkbar delete). Dispatch itself is NOT gated by a confirm — the CTA's explicit count copy is the consent.
4. **No dead ends.** Builder empty states are instructive: no selection → "Select orders from the Orders list to plan a trip" + button to /orders; expired selection (web `?n>0` but draft gone) → explain + link back; driver without home base → message NAMES the driver and links to their profile; optimize failure → warning toast, route remains usable (never a blocked screen).
5. **Feedback on every mutation (Cat 9 Missing Feedback, High).** Build/Optimize/Send/Discard each get: disabled+loading state on the button (no double-submit), success or error toast with the server's message. 150–300ms transitions only; respect reduced-motion; no decorative animation.
6. **Real conditions (Intent P2) — mobile operator is in a warehouse, one-handed.** All new touch targets ≥44pt with pressed feedback (opacity/highlight, no layout shift). Bottom bulkbar and the builder footer CTA respect safe-area insets and sit ABOVE the tab bar; the list gets bottom content inset so the last row is never hidden. Select-mode row toggles use the full row as the hit area, not just the checkmark icon.
7. **Review screen carries full context (Cat 9 Assumption of Context).** Before Send, the builder shows: every stop with its orders + per-customer totals, the resolved origin (label + address text), driver, date. The operator should never need to remember what they selected on the previous screen.
8. **Badge semantics.** SHIP pill = icon (Truck/cube) + text label, never color alone; contrast ≥4.5:1 (web: sky-700 on sky-50 ring-sky-200 passes; mobile: use the existing Pill gray/sky variant). ROUTE orders get NO badge (default majority = noise).
9. **Honest, plain labels (Intent P6).** No urgency/pressure copy anywhere. Fulfillment control labels: "Delivery route" / "Ship via carrier" with the one-line helper "Ships via carrier — won't appear on delivery routes." Disabled options must look disabled and explain why (e.g. origin modes: "Set a depot in Settings → Route").
10. **Icons.** Vector only (lucide on web, Ionicons on mobile), one family per surface, consistent sizes; no emoji as icons anywhere.
