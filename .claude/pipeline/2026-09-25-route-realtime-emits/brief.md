# Brief — route-driven realtime events (#2095 follow-up to B104)

Status: IMPLEMENTED 2026-09-25 (uncommitted; see .claude/handoffs/2026-09-25-route-realtime-emits.md).

Branch `feat/2095-route-realtime-emits`, stacked on `feat/2095-buyer-portal-tracking` @ 32ddb9c14
(not on master yet — the buyer customer rooms live only there). Worktree:
`C:/ClaudeCode/routeflow/.claude/worktrees/vibrant-heyrovsky-e36966`. Test tenants/placeholders only
(`acme`, `c-a1`, `t-1` style ids); never a live-client name.

## Preamble (why)

- **Problem.** Buyers watching "Track your delivery" (web buyer portal + mobile `(customer)` app) and
  operators learn about driver progress only by polling (web 60 s, mobile 20–30 s). B104 put buyer
  sockets in `tenant:<t>:customer:<c>` rooms, but no route mutation emits into them:
  `completeStop`/`completeWithPayment` flip orders to DELIVERED without `emitOrderStatusChanged`;
  `emitStopCompleted` and `emitLowStock` have zero callers, so every `route.stop.completed` and
  `inventory.low.stock` listener (web + mobile, staff + buyer) is dead.
- **Privacy rule (owner):** a buyer may only ever see its OWN order/stop — never another customer's
  name, address, order or stop. Every event below states its audience; the specs prove it.
- **Success signal:** a stop completion pushes, within the same request, (1) `order.statusChanged`
  to operators + that order's own customer room, (2) `route.stop.completed` to operators only,
  (3) `route.progress` `{ runId }` to the customer rooms of the run's other open stops.
- **Deploy day:** no schema, no backfill, no gate. Old clients ignore `route.progress`; removing the
  dead `inventory.low.stock` listeners removes nothing that ever fired. Rollback = revert.
- **Non-goals:** a live `inventory.low.stock` (see decisions); driver GPS to buyers; `deleteRun`
  (only deletable with no deliveries — the card disappears on the next poll); changing poll
  intervals; any change to `apps/web/.../DeliveryTrackingCard*` UI.

## Decisions per event (FINAL — do not re-decide)

| Event                  | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                 | Audience                                                                                                                                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `order.statusChanged`  | **(a) emit** from `completeStop` + `completeWithPayment` (→ DELIVERED, one per order whose PRE-tx status is routable — the same `NON_ROUTABLE_ORDER_STATUSES` filter the P6-5 DELIVERED notification loop already uses) and from `reopenStop` (→ CONFIRMED, one per order the reopen actually flipped from DELIVERED/OUT_FOR_DELIVERY).                                                                                                  | operators + the order's OWN customer room (existing `emitOrderStatusChanged`, unchanged).                                                                                                                              |
| `route.stop.completed` | **(a) emit** once per completion from `completeStop` + `completeWithPayment`.                                                                                                                                                                                                                                                                                                                                                            | **operators only** (existing emitter, unchanged). The buyer web listener is **deleted**: a buyer's own completion already arrives as `order.statusChanged` → DELIVERED, so the stop event would double-toast.          |
| `route.progress` (NEW) | **(a) emit** `{ runId }` — the run id and NOTHING else — after every run/stop mutation that can move a tracking card: `createRun` (dispatch), `updateRunStatus` (start/complete/cancel/reschedule), `updateStopStatus` (arrive/skip), `completeStop`, `completeWithPayment`, `reopenStop`, `reorderRunStops`.                                                                                                                            | the customer rooms of the run's stops whose status is **not COMPLETED**, read AFTER the commit (a stop's own `customerId` ∪ its linked orders' `customerId`s, deduped). Never operators (they have the richer events). |
| `inventory.low.stock`  | **(b) delete** the emitter (`emitLowStock`, `LowStockPayload`) and every listener. Reasons: stock is decremented at ~10 sites in 6 services with no single choke point, the N4 daily low-stock digest (`inventory/low-stock-digest.service.ts`) already delivers the signal to admins, and a buyer must never receive seller stock levels (mobile `useBuyerSocket` listened for it). A live low-stock push is a separate feature ticket. | —                                                                                                                                                                                                                      |

**All emits happen only after the DB write commits** (after the `await` of `tenantTransaction` /
`$transaction` / the bare `update`) and **never fail the request**: the write has already committed,
so a failed audience read or a throwing gateway call is one `logger.warn` line, never a 500 (a 500
after commit makes the driver app retry into "Stop is already completed"). An idempotent replay
(`checkIdempotencyKey` hit) returns before any emit — no duplicate pushes.

Known, accepted approximation (documented in code): the DELIVERED `previousStatus` and the
"which orders flipped" set come from the pre-tx `stop.orders` snapshot, exactly like the existing
P6-5 notification loop beside it. The event is a cache-invalidation nudge; clients refetch truth.

## Package P1 — gateway (`apps/api/src/gateways/routeflow.gateway.ts`)

Files: `apps/api/src/gateways/routeflow.gateway.ts`. Risk: HIGH (who receives — tenancy/privacy). dependsOn: none.

1. Delete `LowStockPayload` and `emitLowStock`.
2. `StopCompletedPayload.customerId` becomes `string | null` (a run stop's `customerId` is nullable
   in the schema). Doc-comment `emitStopCompleted`: operators only; a buyer learns of its own
   delivery through `order.statusChanged`.
3. Add, exactly:

```ts
/**
 * #2095: a run moved (dispatched, started, a stop arrived/completed/skipped/reopened, stops
 * reordered, the run ended). Carries the run id and nothing else — never a stop, a count, a name
 * or an address — so a buyer's tracking card refetches its OWN figures from the tracking endpoint.
 */
export interface RouteProgressPayload {
  runId: string;
}
```

```ts
  /**
   * #2095: tells the customers on a run that it moved. Each named customer room gets `{ runId }`
   * and nothing else; the payload is rebuilt here so an extra field a caller passes can never
   * leak. One `to([...rooms])` call, so a socket in several of the rooms receives it once.
   * Operators are not addressed: they get `route.stop.completed` / `driver.status.updated`.
   */
  emitRouteProgress(tenantId: string | null, customerIds: string[], payload: RouteProgressPayload) {
    const rooms = [...new Set(customerIds)].map((id) => this.customerRoom(tenantId, id));
    if (rooms.length === 0) return;
    this.server.to(rooms).emit("route.progress", { runId: payload.runId });
  }
```

## Package P2 — helper module (NEW `apps/api/src/routes/route-realtime.ts`)

Files: `apps/api/src/routes/route-realtime.ts` (new). Risk: HIGH (audience rule — tenancy/privacy). dependsOn: P1.

A plain class (NOT a Nest provider — no module or spec-harness changes), built per call by
`RoutesService`. Shape (fill the bodies; keep every method never-rejecting):

```ts
import { OrderStatus, RouteRunStatus, RouteRunStopStatus } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import type { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { NON_ROUTABLE_ORDER_STATUSES } from "./routes.constants";

type RealtimeGateway = Pick<
  RouteFlowGateway,
  "emitOrderStatusChanged" | "emitStopCompleted" | "emitRouteProgress" | "emitDriverStatusUpdated"
>;

/** An order as the route methods already hold it (pre-tx snapshot). */
export interface RouteOrderRef {
  id: string;
  orderNumber: string | null;
  customerId: string;
  status: OrderStatus;
}

/**
 * #2095: every realtime announcement a run/stop mutation makes, called only AFTER the caller's
 * write committed. Nothing here throws: the write is done, so a failed read or emit is one warn
 * line, never a failed request (a 500 after commit sends the driver app into a retry).
 */
export class RouteRealtime {
  constructor(
    private readonly prisma: Pick<PrismaService, "forTenant" | "getTenantId">,
    private readonly gateway: RealtimeGateway,
    private readonly logger: { warn(message: string): void },
  ) {}

  /** `route.progress` `{ runId }` to the customers of every stop on the run not yet COMPLETED. */
  async runProgress(runId: string): Promise<void> { /* see audience rule below */ }

  /** A stop completed: DELIVERED per routable order, `route.stop.completed`, the auto-completed
   *  run's driver status (moved verbatim from routes.service), then `route.progress`. */
  async stopCompleted(args: {
    runId: string;
    stopId: string;
    stopCustomerId: string | null;
    orders: RouteOrderRef[];
    autoCompleted: boolean;
  }): Promise<void> { ... }

  /** A stop reopened: CONFIRMED per order the reopen flipped, then `route.progress`. */
  async stopReopened(runId: string, reopened: RouteOrderRef[]): Promise<void> { ... }
}
```

Audience read for `runProgress` (tenant-scoped, post-commit):

```ts
const stops = await this.prisma.forTenant().routeRunStop.findMany({
  where: { routeRunId: runId, status: { not: RouteRunStopStatus.COMPLETED } },
  select: { customerId: true, orders: { select: { customerId: true } } },
});
// customerIds = stop.customerId ∪ each order.customerId, non-null, deduped; emit only if non-empty
this.gateway.emitRouteProgress(this.prisma.getTenantId(), [...ids], { runId });
```

`stopCompleted` order: (1) for each order with `!NON_ROUTABLE_ORDER_STATUSES.includes(o.status)`:
`emitOrderStatusChanged(tenantId, { orderId: o.id, orderNumber: o.orderNumber ?? "", customerId:
o.customerId, status: OrderStatus.DELIVERED, previousStatus: o.status })`; (2)
`emitStopCompleted(tenantId, { runId, stopId, customerId: stopCustomerId, orderId: <the order id
when the stop has exactly one order, else undefined>, completedAt: new Date().toISOString() })`;
(3) if `autoCompleted`: the block currently at `routes.service.ts` ~2416–2431 moved verbatim
(`forTenant().routeRun.findUnique({ where: { id: runId }, include: { driver: … } })` →
`emitDriverStatusUpdated(..., status: RouteRunStatus.COMPLETED, ...)`); (4) `await
this.runProgress(runId)`. Wrap each step in its own try/catch so one failure never suppresses the
others; the warn line names the step and the run id (ids only — no customer names).

## Package P3 — wire `apps/api/src/routes/routes.service.ts` (dependsOn P1, P2)

Files: `apps/api/src/routes/routes.service.ts`. Risk: LOW. dependsOn: P1, P2.

**Size ratchet:** `apps/api/src/common/size-ratchet.spec.ts` allows 3189 + 25 = 3214 lines; the
file is 3208 now. The file must END ≤ 3214 — target ≤ 3208 (never grow it). The extraction that
pays for the new calls is moving the two duplicated `if (autoCompleted) { … emitDriverStatusUpdated
… }` blocks (completeStop ~2416–2431, completeWithPayment ~2715–2730 — read-only + emit, no DB
writes) into `RouteRealtime.stopCompleted`. DB writes never move (lesson: ratchet extractions move
read-only computation only).

- Add `import { RouteRealtime } from "./route-realtime";` and one member:
  ```ts
  /** #2095: post-commit realtime announcements (never throws). */
  private get live() { return new RouteRealtime(this.prisma, this.gateway, this.logger); }
  ```
  (a getter, not a field initializer — field initializers can run before parameter properties.)
- `completeStop` / `completeWithPayment`: replace each `if (autoCompleted) {…}` block with
  `await this.live.stopCompleted({ runId, stopId, stopCustomerId: stop.customerId, orders: stop.orders, autoCompleted });`
  placed where the block was (after the P6-5 notification loop, before the `findUniqueOrThrow`).
  `stop` is fetched with `findFirst({ include: { orders: { select: {...} } } })`, so its scalar
  `customerId` is present.
- `updateRunStatus`: after the existing `emitDriverStatusUpdated` block, `await this.live.runProgress(id);`
- `updateStopStatus`: `const updated = await this.prisma.forTenant().routeRunStop.update(…);`
  `await this.live.runProgress(runId); return updated;`
- `createRun`: after the `applyStopRegulatedFlags(...).catch(...)` statement, `await this.live.runProgress(run.id);`
- `reorderRunStops`: after the `$transaction([...])`, `await this.live.runProgress(runId);`
- `reopenStop`: declare `const reopened: typeof stop.orders = [];` before the tx; inside the
  existing `if (order.status === "DELIVERED" || order.status === "OUT_FOR_DELIVERY")` branch push
  the order after its update; after the tx, `await this.live.stopReopened(runId, reopened);`
  (the reopen's CONFIRMED is announced only once the tx commits; a thrown tx announces nothing).

## Package P4 — clients (dependsOn P1)

Files: `apps/web/lib/hooks/useBuyerNotifications.ts`, `apps/web/lib/hooks/useNotifications.ts`, `apps/web/lib/hooks/useRealtimeUpdates.ts`, `apps/mobile/hooks/useSocket.ts`, `apps/mobile/hooks/useBuyerSocket.ts`, `apps/api/src/inventory/low-stock-digest.service.ts`. Risk: LOW. dependsOn: P1.

- `apps/web/lib/hooks/useBuyerNotifications.ts`: remove the `route.stop.completed` listener
  (`onStopCompleted`, its on/off). Add `route.progress` → `qc.invalidateQueries({ queryKey:
["buyer", "order"] })` (prefix: every order detail + its `["buyer","order",id,"tracking"]`
  card) — silent, **no toast**. Keep `BuyerNotificationType`'s `"delivery"` member (stored history).
- `apps/web/lib/hooks/useNotifications.ts`: remove `onLowStock` and its on/off. Keep the
  `NotificationType` union unchanged (stored `"stock"` entries still render).
- `apps/web/lib/hooks/useRealtimeUpdates.ts`: remove the `inventory.low.stock` on/off.
- `apps/mobile/hooks/useSocket.ts`: remove the `inventory.low.stock` listener; widen its local
  `StopCompletedPayload` only if the compiler needs it.
- `apps/mobile/hooks/useBuyerSocket.ts`: remove the `inventory.low.stock` listener; add
  `socket.on("route.progress", () => { void qc.invalidateQueries({ queryKey: ["buyer-order-tracking"] }); })`.
- `apps/api/src/inventory/low-stock-digest.service.ts`: its header comment says the realtime
  event is "UNCHANGED"; reword to say the realtime event was removed (#2095 follow-up) and this
  digest is the low-stock signal.

## Package P5 — specs (the proof)

Files: `apps/api/src/gateways/testing/live-gateway-harness.ts` (new), `apps/api/src/routes/route-realtime.spec.ts` (new), `apps/api/src/routes/routes.realtime-wiring.spec.ts` (new), `apps/web/lib/hooks/useBuyerNotifications.test.ts`, and the seven `apps/api/src/routes/*.spec.ts` files named below. Risk: HIGH (the privacy proof). dependsOn: P1–P4. Build order is sequential P1 → P2 → P3 → P4 → P5.

Specs that name `"emitLowStock"` inside a `Pick<RouteFlowGateway, …>` union stop compiling when
the method is removed — remove the key and its `emitLowStock: jest.fn()` line in exactly those
files: `apps/api/src/routes/{routes.service.spec.ts, routes.delivery-qty-guard.spec.ts,
routes.dispatch-draft.spec.ts, routes.reopen-cancelled-lines.spec.ts,
routes.service.run-terminal-release.pins.spec.ts, routes.service.run-terminal-release.spec.ts,
routes.service.stop-state-guards.spec.ts}`. Leave untyped `emitLowStock: jest.fn()` object mocks
elsewhere untouched (harmless; avoids conflicts with other lanes). In `routes.service.spec.ts`
also add `emitRouteProgress: jest.fn()` and `emitDriverStatusUpdated: jest.fn()` to its gateway mock + union.

**T1 — NEW `apps/api/src/gateways/testing/live-gateway-harness.ts`** (test-only helper; do NOT edit
`routeflow.gateway.buyer-rooms.spec.ts`): factor the harness pattern of that spec — Nest app with
`IoAdapter` on port 0, real `RouteFlowGateway`, `JwtModule` secret, a `PrismaService` stand-in
supplied by the caller, `connect(token)` awaiting `handleConnection` to completion via a spy,
`flush(...clients)` via the socket-id marker, `serverRooms`, `buyerToken`, `staffToken`,
`close()`. The stand-in store must keep the honest-where rule (throw on any filter shape it does
not model — L-081).

**T2 — NEW `apps/api/src/routes/route-realtime.spec.ts`** — `RouteRealtime` driving the REAL
gateway on the live harness (who actually receives). Store: tenants t-1 (ACTIVE), t-2 (ACTIVE);
customers c-a1, c-b, c-c, c-d at t-1, c-x at t-2; buyer links buyer-a→c-a1, buyer-b→c-b,
buyer-c→c-c, buyer-d→c-d (t-1), buyer-x→c-x (t-2); operator at t-1 and an operator at t-2. Run
`run-1` (t-1) stops: s1 c-a1 COMPLETED (the stop just completed, order ord-a1 was OUT_FOR_DELIVERY),
s2 c-b PENDING, s3 c-c SKIPPED, s4 customerId null with an order of c-d IN_PROGRESS; `run-2` (t-1)
stop c-? PENDING for a customer on neither list must not be read. The db stand-in for
`forTenant().routeRunStop.findMany` applies `routeRunId`, `status.not` and `select` honestly;
`forTenant().routeRun.findUnique` returns a run with a driver when asked.
Assertions (each with a concrete oracle):

- `stopCompleted` for s1: buyer-a receives exactly `[order.statusChanged]` with `{orderId:"ord-a1",
status:"DELIVERED", previousStatus:"OUT_FOR_DELIVERY", customerId:"c-a1"}` and NO `route.progress`
  (its stop is COMPLETED); buyer-b, buyer-c, buyer-d each receive exactly one `route.progress`
  whose payload's keys are exactly `["runId"]` and value `{runId:"run-1"}`; none of b/c/d receives
  any `order.statusChanged` or `route.stop.completed`; buyer-x and the t-2 operator receive nothing;
  the t-1 operator receives `order.statusChanged` + `route.stop.completed` (payload `runId:"run-1",
stopId:"s1", customerId:"c-a1"`) and NO `route.progress`.
- An order whose pre-tx status is DRAFT / CANCELLED / DELIVERED gets no `order.statusChanged`.
- `autoCompleted:true` with a driver → the t-1 operator also receives `driver.status.updated`
  `status:"COMPLETED"`; `autoCompleted:false` → it does not.
- `runProgress("run-1")` with a buyer linked to two of the run's customers → that socket gets ONE
  `route.progress`; a run whose stops are all COMPLETED → no emit at all (the gateway spy not called).
- `emitRouteProgress("t-1", ["c-b"], { runId: "run-1", customerName: "leak" } as any)` → buyer-b's
  payload keys are exactly `["runId"]`.
- Never rejects: the audience read rejecting, or `emitOrderStatusChanged` throwing, → the method
  resolves, `logger.warn` called with a message containing `run-1`, and the other steps still ran
  (e.g. `route.stop.completed` still reached the operator when the status emit threw).
- `stopReopened("run-1", [ord-a1 as DELIVERED])` → buyer-a gets `order.statusChanged`
  `{status:"CONFIRMED", previousStatus:"DELIVERED"}`; the operator gets it too.
- `inventory.low.stock` is gone: `expect((gateway as any).emitLowStock).toBeUndefined()`.

**T3 — NEW `apps/api/src/routes/routes.realtime-wiring.spec.ts`** — the service calls the right
announcement AFTER commit. Build the Nest testing module exactly like `routes.service.spec.ts`
(same providers; copy its `beforeEach`). Spy `jest.spyOn(RouteRealtime.prototype, "stopCompleted"
| "stopReopened" | "runProgress").mockResolvedValue()`. Make `prisma.tenantTransaction` record
`"commit"` into an `events` array after the callback resolves, and each spy record `"announce"`;
assert `events` ends `["commit", "announce"]`.

- `completeStop` (orders: one OUT_FOR_DELIVERY, one DRAFT; stop.customerId "c-a1") → `stopCompleted`
  called once with `{ runId:"run-1", stopId:"stop-1", stopCustomerId:"c-a1", orders:<both>,
autoCompleted:false }`, after commit.
- `completeStop` whose transaction rejects → rejects, and `stopCompleted` never called.
- `completeStop` with an idempotency key that is already cached → `stopCompleted` never called.
- `completeWithPayment` → `stopCompleted` once, after commit.
- `updateRunStatus` SCHEDULED→IN_PROGRESS → `runProgress("run-1")` once; `updateStopStatus`
  SKIPPED → `runProgress("run-1")` once, after the update resolved; `reorderRunStops` (SCHEDULED
  run) → `runProgress("run-1")` once, after `$transaction` resolved.
- `reopenStop` on a COMPLETED stop with orders [DELIVERED ord-1, CANCELLED ord-2] → `stopReopened`
  called with `("run-1", [ord-1 only])`, after commit.
- `createRun` → `runProgress(<run id>)` once (reuse the setup of an existing passing createRun test
  in `routes.service.spec.ts`).

**T4 — `apps/web/lib/hooks/useBuyerNotifications.test.ts`** (existing file; add a describe):
`route.progress` invalidates `["buyer","order"]` and pushes NO notification; the hook does not
subscribe to `route.stop.completed` (`fakeSocket.emit("route.stop.completed", …)` adds nothing and
the handler map has no entry).

**T5 — size ratchet:** `apps/api/src/routes/routes.service.ts` ≤ 3214 lines (run the ratchet spec
explicitly, it is in `testPathIgnorePatterns`).

## Verification commands (all must exist; run from the worktree root)

- `npm run check-types -w apps/api` · `npm run check-types -w apps/web` · `npm run check-types -w apps/mobile`
- `npx jest --maxWorkers=2 src/routes src/gateways` from `apps/api`
- `npx jest --maxWorkers=1 --testPathIgnorePatterns=/node_modules/ -- src/common/size-ratchet.spec.ts` from `apps/api` (the `--` matters: the ignore option is an array and swallows a following path, running the whole suite)
- `npx jest lib/hooks` from `apps/web`
- `npm run lint -w apps/api` · `npm run lint -w apps/web` · `npm run lint -w apps/mobile`
- Format only the changed paths: `npx prettier --write <changed files>` (never repo-wide).

Lessons carried: L-081 (honest where-applying stand-ins), L-165 (assert delivered events by the
ordering marker, never wall-clock waits), the ratchet rule (extract read-only code; DB writes stay).
