# Spec — F11: run cancel / skip reconciliation (B129 · B211 · B146 · B34)

**Status:** PLANNED (writer-side, per the lead's rulings R1/R2/R6 of 2026-09-02). Repo: RouteFlow
monorepo, worktree `.claude/worktrees/rf-F11`, branch `fix/F11-run-cancel-skip-v2` at
`master@c60fe214`. Line numbers below are at that SHA and were re-read in the worktree, not
copied from the card (L-026).

**Rows:** B129 (Critical, T1) · B211 (new — the COMPLETED-with-SKIPPED strand, T1, token
`REG-B211`) · B146 (High, T1) · B34 (High, T1). **B32 is OUT** (moved to F20 by the reconcile
chore; not built, not tested, not mentioned in any REG title here). F11 has **no Playwright leg
and no post-deploy T2 discharge**; every proof is jest (api or mobile pure-logic).

**Lesson id:** **L-045** (pre-allocated; never take `_meta.json.nextId`, which is 51). A second,
unallocated lesson — only if one genuinely emerges — takes `nextId` and bumps it.

**Files touched (the fence — anything else is a scope question, L-008):**

| Layer   | File                                                                                                                                          | Change                                                                                                                                                |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| api     | `apps/api/src/routes/routes.service.ts`                                                                                                       | `releaseUndeliveredOrders` helper, `sweepOrdersOntoStops` extraction, tx in `updateRunStatus`, RF-016 hooks, `reopenStop` refusal, `findOneRun` guard |
| api     | `apps/api/src/routes/dto/update-run-status.dto.ts`                                                                                            | doc text only (the "would strand" sentence is now false)                                                                                              |
| api     | `apps/api/src/orders/orders.service.ts`                                                                                                       | `getOrderTracking` CANCELLED short-circuit (:5331 neighbourhood) — nothing else in this file                                                          |
| api     | `apps/api/src/routes/routes.service.run-terminal-release.spec.ts` (new)                                                                       | REG-B129 / REG-B211 proofs                                                                                                                            |
| api     | `apps/api/src/routes/routes.service.run-terminal-release.pins.spec.ts` (new)                                                                  | pins                                                                                                                                                  |
| api     | `apps/api/src/orders/orders.service.tracking-contract.spec.ts` (new)                                                                          | REG-B129 / REG-B146 tracking contract proof                                                                                                           |
| api     | `apps/api/src/orders/orders.service.tracking-contract.pins.spec.ts` (new)                                                                     | pins                                                                                                                                                  |
| api     | `apps/api/src/routes/routes.service.stop-state-guards.spec.ts`                                                                                | comment at T9b (:390-394) only — the test body stays byte-identical                                                                                   |
| mobile  | `apps/mobile/lib/order-tracking-logic.ts`                                                                                                     | `trackingHeadline`, `trackingRefetchInterval`                                                                                                         |
| mobile  | `apps/mobile/app/(customer)/orders/[id].tsx`                                                                                                  | render the headline; hide ETA for a skipped stop                                                                                                      |
| mobile  | `apps/mobile/lib/api/buyer.ts`                                                                                                                | `useBuyerOrderTracking` refetchInterval → helper                                                                                                      |
| mobile  | `apps/mobile/lib/skip-stop.ts` (new)                                                                                                          | pure skip handler                                                                                                                                     |
| mobile  | `apps/mobile/app/(driver)/route/stop/[stopId]/index.tsx`                                                                                      | wire Skip through the handler + `useUpdateStopStatus`                                                                                                 |
| mobile  | `apps/mobile/lib/api/routes.ts`                                                                                                               | `useUpdateRunStatus.onSuccess` also invalidates `["orders"]` (R14, droppable)                                                                         |
| mobile  | `apps/mobile/__tests__/order-tracking-logic.test.ts`, `__tests__/skip-stop.test.ts` (new), `__tests__/f11-run-cancel-skip.pins.test.ts` (new) | proofs + pins                                                                                                                                         |
| web     | `apps/web/lib/api/routes.ts`                                                                                                                  | `useUpdateRouteRunStatus.onSuccess` invalidates `["orders"]`, `["trips-eligible-orders"]` (R14, droppable)                                            |
| scripts | `scripts/repair-f11-stranded-orders.mjs` (new), `scripts/REPAIR-RUNBOOK.md`                                                                   | D4 repair flight + runbook section                                                                                                                    |
| meta    | `.claude/skills/bug-hunt/scan-ignore.json`                                                                                                    | delete the `confirm-navigate` suppression (:74) — it was suppressing B34 itself                                                                       |
| meta    | `.claude/code-map/{api,mobile,web}.md` + `_meta.json`, `.claude/lessons/LESSONS.md` + `_meta.json`, `.claude/campaign/status/F11.jsonl`       | close-out bookkeeping                                                                                                                                 |

---

## 0. The invariant this batch establishes

> **`Order.routeRunStopId != null` ⇒ that order is on a run that is SCHEDULED or IN_PROGRESS, or it
> was delivered (or its stop was worked) on a run that finished.** A run going terminal releases
> every order on a stop that recorded no work.

Today (c60fe214) the pointer is SET only by createRun's sweep (`routes.service.ts:941-967`) and
`orders.service.ts:2236-2237` / `:1379-1382`, and CLEARED only by `deleteRoute` (:564-565) and
`deleteRun` (:1344-1345). No terminal transition touches it: `updateRunStatus` (:1368-1467) issues
one `routeRun.update` (:1449-1455) with no order write and no transaction; `updateStopStatus`
(:1716-1763) writes only the stop row; RF-016 in `completeStop` (:2164-2167) and
`completeWithPayment` (:2419-2423) writes only run status. Every re-dispatch reader requires the
pointer to be null — the sweep's own `where` (:945), `trips.service.ts` `getEligibleOrders`
(:189) and `checkEligibility` (:112-126, whose PREVIOUSLY_DISPATCHED "Attached to a finished run
(stale link)" message _is_ the stranded state). L-029: the invariant existed for the dispatch path
and the teardown paths were never enrolled. F11 enrolls them writer-side (R1 ruling), keeping the
invariant strict rather than teaching every present and future reader an exception.

**Why writer-side is safe on cancel:** `reopenStop` refuses CANCELLED runs at :2694-2695 _before_
it reads any stop, so its `deliveredQty` zeroing (:2769-2778) and order demotion are unreachable
for a cancelled run. **The one reachable hazard** — a SKIPPED stop on a COMPLETED run (reopenStop
accepts SKIPPED at :2696-2697 and resets the run to IN_PROGRESS at :2860-2864) — is closed by R7
in the SAME PR (L-030 shape: release and refusal are two halves of one decision and must land
together).

---

## 1. Requirements

Priority: **P0** = ships or the batch does not; **P1** = required, same PR; **P2** = required
unless the lead drops it, same PR; **REC** = recorded, not built. Verification: **T1** = jest proof
with the named `REG-` token (see test-plan.md); **pin** = jest regression pin in a `*.pins.*`
file; **tsc** = type-check; **review** = PR-body statement + reviewer read; **dry-run** = script
executed read-only against local docker Postgres, output pasted in build-plan.md.

### R1 — the release helper (B129, P0, T1: T1 T2 T3 T14)

`private async releaseUndeliveredOrders(tx, stopIds: string[]): Promise<{ released: number }>` in
`routes.service.ts`. Semantics, in this order, both writes through the SAME `tx` (the
`tenantTransaction` client — tenant-scoped; these are `updateMany` through the proxy, not nested
creates, so L-021's NULL-tenantId class does not apply):

1. **Defensive status revert, scoped to the released stops, BEFORE the unlink** (the run filter is
   lost once the pointer is null):
   `tx.order.updateMany({ where: { routeRunStopId: { in: stopIds }, status: OrderStatus.OUT_FOR_DELIVERY }, data: { status: OrderStatus.CONFIRMED } })`.
   No run-lifecycle code writes OUT_FOR_DELIVERY (the only writer is `changeStatus`'s manual
   matrix, `orders.service.ts:2440-2442`); the revert exists so an office-set OUT_FOR_DELIVERY
   order is trip-eligible again (`TRIP_ELIGIBLE_STATUSES` excludes it). Precedent: reopenStop
   :2774-2776.
2. **The release:**
   `tx.order.updateMany({ where: { routeRunStopId: { in: stopIds }, status: { notIn: [OrderStatus.DELIVERED, OrderStatus.CANCELLED] } }, data: { routeRunId: null, routeRunStopId: null } })`.
3. `stopIds.length === 0` ⇒ **no write at all** (return `{ released: 0 }`).

**The predicate is stop status, not mutation existence.** Callers pass the ids of stops whose
`status !== "COMPLETED"`. `completeStop` (:2088) and `completeWithPayment` (:2301-2304) both write
`stop.status = "COMPLETED"` inside the payment's/delivery's own transaction, with `deliveries`
optional — so COMPLETED is the only durable "work was recorded here" marker, and every at-door
payment sits on a COMPLETED stop by construction. A `deliveryMutation`-existence predicate would
release a payment-only completion (no `deliveries[]` ⇒ no mutation) — the exact hole F05 found in
`deleteRun`.

**Stop rows are KEPT** (`arrivedAt`, `driverNote`, `podHistory` are history). Nothing else is
written. **The helper never routes through `orders.service.changeStatus`** (it opens its own
transactions, re-runs role gates and the matrix, fires notifications — F10 handoff :197-199) and
**never carries F07's ConflictException retry loop** (only safe in a fresh tx — handoff :200-202).

**L-037 enumeration — every forward write of dispatch/run lifecycle, and what the release does:**

| Forward write                                                                                                                                                                                                                            | Written by                                                                         | On release                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Order.routeRunId`, `Order.routeRunStopId`                                                                                                                                                                                               | createRun sweep :966; orders.service :2236, :1380                                  | **REVERSED** (step 2) for orders on non-COMPLETED stops, status ∉ {DELIVERED, CANCELLED} — **and the stop's status is re-checked IN the write** (`routeRunStop: { status: { not: "COMPLETED" } }`, on both writes), so a stop completed between the caller's read and the write is excluded                                                                                                                                                     |
| `ChangeRequest.status = PENDING` (+ payload)                                                                                                                                                                                             | change-requests.service :71-83, only while `order.routeRun.status === IN_PROGRESS` | **DECLINED** (step 3) for the orders step 2 actually released — `resolution: "DECLINED"`, `resolutionReason: "Run cancelled — order released to dispatch"`, `resolvedAt`, `updatedAt`; resolver identity left null. Not reversible: the order leaves the run, so the CR's own create/apply precondition is gone and a re-dispatch would otherwise let the driver apply the items twice. **No notification** (`notifyRequester` — follow-up row) |
| `Order.status = OUT_FOR_DELIVERY`                                                                                                                                                                                                        | changeStatus manual matrix only                                                    | **REVERSED** to CONFIRMED (step 1) — defensive, scoped to released stops                                                                                                                                                                                                                                                                                                                                                                        |
| `RouteRunStop.ageCheckRequired / identityCheckRequired`                                                                                                                                                                                  | `applyStopRegulatedFlags` (post-sweep)                                             | **KEPT** — stop-local, harmless; a re-dispatch re-derives on the new run's stops                                                                                                                                                                                                                                                                                                                                                                |
| `RouteRun.startedAt`                                                                                                                                                                                                                     | updateRunStatus IN_PROGRESS                                                        | **KEPT** — history                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `RouteRunStop.status = SKIPPED`, `driverNote`, `arrivedAt`                                                                                                                                                                               | updateStopStatus                                                                   | **KEPT** — history; the reopen path onto it is **REFUSED** on a COMPLETED run (R7)                                                                                                                                                                                                                                                                                                                                                              |
| `RouteRunStop.status = COMPLETED` + POD columns, `deliveryMutation`, `Order.status = DELIVERED`, `OrderItem.deliveredQty`                                                                                                                | completeStop / completeWithPayment                                                 | **UNTOUCHED BY CONSTRUCTION** — the predicate excludes COMPLETED stops, so none of this is ever in scope                                                                                                                                                                                                                                                                                                                                        |
| `InvoicePayment` / `AdvancePayment` (at-door)                                                                                                                                                                                            | `recordDeliveryPaymentInTx` (completeWithPayment)                                  | **UNTOUCHED** — always on a COMPLETED stop (see above)                                                                                                                                                                                                                                                                                                                                                                                          |
| `InvoicePayment` recorded by the OFFICE on an order pinned to a non-COMPLETED stop                                                                                                                                                       | invoices.service (not the run lifecycle)                                           | **NEITHER reversed NOR refused — attribution moves off the run BY DESIGN.** See R15.                                                                                                                                                                                                                                                                                                                                                            |
| `Order.routeRunId` read as a REPORTING join — `getRunCashCollections` (:1495, run settlement) and `BookkeepingService.getSalesByDriver` (bookkeeping.service.ts:1853-1915, invoice → order → routeRun → driver, `if (!driver) continue`) | not a write — the two readers of the pointer                                       | **BOTH shift BY DESIGN.** Cash: R15. Sales-by-Driver: every invoice on a released order (payment or not) drops out until a re-dispatch re-pins it. See R15.                                                                                                                                                                                                                                                                                     |
| `RouteRun.settlementNote / settlementVariance`                                                                                                                                                                                           | settleRun                                                                          | **KEPT** — settleRun already accepts CANCELLED (:1636-1660); money is reconciled post-hoc, never stranded                                                                                                                                                                                                                                                                                                                                       |

### R2 — cancel transaction placement (B129, P0, T1: T1 T4 T14)

`updateRunStatus`, `dto.status === CANCELLED` (after every existing guard — driver branch, matrix,
`completedAt` composite guard — all unchanged):

```
const updated = await this.prisma.tenantTransaction(async (tx) => {
  const row = await tx.routeRun.update({ where: { id }, data: updates, include: { driver: … } });   // the write that exists today at :1449-1455
  const stops = await tx.routeRunStop.findMany({ where: { routeRunId: id, status: { not: "COMPLETED" } }, select: { id: true } });
  await this.releaseUndeliveredOrders(tx, stops.map((s) => s.id));
  return row;
});
// gateway.emitDriverStatusUpdated(...) AFTER the tx, exactly as today
```

- **A transaction is introduced** where today there is a bare update. It wraps: the status write,
  the in-tx read of non-COMPLETED stop ids, and the two release writes. **Nothing else.** The
  gateway emit stays outside (it is fire-and-forget I/O; a failed emit must not roll back a
  cancel, and a rolled-back cancel must not have been broadcast).
- **Stop ids are read INSIDE the tx**, not from the initial `findUnique`, so a driver's
  `completeStop` that commits between the operator's read and the operator's write is seen (that
  stop is now COMPLETED and drops out). Belt and braces: step 2's `status notIn [DELIVERED, …]`
  also excludes the orders that completion just flipped. Residual: Prisma interactive
  transactions run READ COMMITTED; a completeStop that commits _after_ the in-tx stop read but
  before the order write is still excluded by the status filter. No run-row `FOR UPDATE` is
  taken (recorded, not built — updateRunStatus's only concurrent writers are other status PATCHes,
  which are idempotent under the matrix; see §3).
- **Only CANCELLED and COMPLETED (R6) take the transaction.** `SCHEDULED` / `IN_PROGRESS` writes —
  including un-cancel (R3) — stay the single `routeRun.update` they are today, so F10's T9b
  fixture (no route, no stops, no tx) is untouched.
- The response shape is unchanged (`updated` with `driver`). No new response field.

### R3 — un-cancel contract (B129, P0, T1: T5 T6; pin: F10 T9b)

`CANCELLED → SCHEDULED | IN_PROGRESS` **stays legal for operators** (F10 handoff :142-160, the
matrix at `update-run-status.dto.ts:29-38`, T9b). Drivers stay refused (F10 T9c). **Ruling:**

- Un-cancel is a **status-only restore**. **Already-released orders are NOT re-pinned.** The run
  comes back with whatever stops still reference orders (COMPLETED stops keep their delivered
  orders; released stops are empty). **Re-dispatch (`createRun` on the same route) re-collects the
  released orders** — that is the forward recovery path F10 asked for (:162-166).
- **No route-kind branching.** ADHOC and SCHEDULED un-cancel identically; there is no re-sweep
  and therefore no ADHOC refusal (the card's (D) is superseded by the ruling). A missing `route`
  relation is irrelevant — nothing reads it.
- **No order write of any kind on un-cancel.** Proven by T6 (`order.updateMany` never called) and
  by the path test T5.
- The DTO doc (:18-25, "…so a terminal CANCELLED would strand the run AND its undelivered
  orders…") and T9b's comment (stop-state-guards.spec.ts:390-394) are rewritten to state the new
  truth: cancel releases; un-cancel restores status only; re-dispatch re-collects. **Text only —
  T9b's body does not change** (it is the pin that un-cancel is still legal). (R12)

### R4 — `findOneRun` legacy fallback (B129, P1, T1: T7)

`findOneRun` (:1254-1255) backfills a run's stops from the customers' CURRENT open orders when no
stop has linked orders ("legacy/seeded data"). After a cancel-release a cancelled run is exactly
that shape, so its detail page would display unrelated live orders as if they were on the cancelled
run. Guard: `if (!anyLinked && normalisedStops.length > 0 && run.status !== RouteRunStatus.CANCELLED)`.

**Recorded, not fixed (follow-up row, allocate B212+):** an _un-cancelled_ run whose every stop
was released (R3) is IN_PROGRESS/SCHEDULED with orderless stops and WILL hit this fallback — the
driver would see the customers' current open orders on a run that carries none, and a completion
would flip none of them DELIVERED (completeStop uses `stop.orders` from the DB, not the fallback).
Exposure today is API-only: no web or mobile surface calls un-cancel (operator home starts
`scheduledData[0]` only; driver start targets the active run). The durable fix is retiring the
fallback or keying it on a marker the run lifecycle actually writes — out of F11's fence.

### R5 — `getOrderTracking` contract (B129 + B146 (b), P0, T1: T15; pins: P9 P10)

`orders.service.ts:5301-5363`. Written contract, in evaluation order:

1. `order.routeRunStop == null` ⇒ `{ status, tracking: null }` (exists at :5331; after F11 this is
   the common case for a released order — the fix "heals" the buyer card through the pointer).
2. **NEW:** `routeRunStop.routeRun.status === CANCELLED` ⇒ `{ status, tracking: null }`. This is
   the belt for rows stranded BEFORE deploy (every run cancelled to date) until the D4 repair (R13)
   frees them; after the repair it is unreachable for new data and stays as the contract.
3. Otherwise the full payload is returned **unchanged** — including for a **SKIPPED own-stop on an
   IN_PROGRESS or COMPLETED run**: `stopStatus: "SKIPPED"`, `stopsAhead` computed exactly as
   today (:5341-5343 — it structurally excludes the own stop and is NOT changed). **The client
   branches on `stopStatus`** (R8); the server does not invent a "skipped shape".

The ownership gate (F2-002, :5323-5329) runs BEFORE any of the above and is unchanged.

### R6 — the COMPLETED half: B211 (P0, T1: T8 T9 T10 T11; pins: P4 P8)

The same helper at the three places a run becomes COMPLETED. At each, the released set is
"stops that are not COMPLETED" — which, because each entry point has already established
`allDone`/no-incomplete, is exactly the SKIPPED stops:

1. **`updateRunStatus` COMPLETED branch.** The gates stay in order and unchanged: stops-complete
   check (:1419-1429, SKIPPED counts as complete at :1424), then the B152 cash backstop
   (`getUnsettledPhysicalMoney`, :1436-1442). THEN the same `tenantTransaction` shape as R2:
   status write (`completedAt` set as today) → in-tx `routeRunStop.findMany` of non-COMPLETED stop
   ids → `releaseUndeliveredOrders`. Gate reads happen pre-tx against the pre-release state — this
   is conservative (more orders counted ⇒ the cash gate can only block more, never less).
2. **RF-016 in `completeStop`** (:2140-2170): inside the existing `tx`, immediately after
   `tx.routeRun.update({ status: COMPLETED, completedAt })` (:2164-2167), call
   `releaseUndeliveredOrders(tx, allStops.filter((s) => s.id !== stopId && s.status !== "COMPLETED").map((s) => s.id))`.
   `allStops` is already loaded at :2140 (after this stop's own COMPLETED write, so the `id !==
stopId` clause is a second guard, not the only one). **A withheld auto-completion (unsettled
   cash, :2151-2162) releases nothing** — the run is still IN_PROGRESS.
3. **RF-016 in `completeWithPayment`** (:2398-2425): identical one-line insertion after
   :2419-2423. F05 owns the cash gate text in these blocks and F08 cites :2289-2294 beside them —
   the insertion is one call after the existing `tx.routeRun.update`, nothing else moves (L-008).

Also inherited from R2 of the lead's ruling and RECORDED (follow-up row): only `completeWithPayment`
(:2346) writes `OrderItem.deliveredQty`; `completeStop` and office-delivered orders leave it 0.
F11 does not touch it.

### R7 — reopenStop refusal for a released SKIPPED stop (B211/B146, P0, T1: T12; pin: P4)

In `reopenStop`, immediately after the two existing state checks (:2694-2697) and BEFORE the
driver-isolation block and before `tenantTransaction`:

```
if (stop.status === "SKIPPED" && run.status === "COMPLETED")
  throw new BadRequestException(
    "This run is complete and the skipped stop's orders were released to dispatch — dispatch them on a new run instead of reopening this stop.",
  );
```

- **One named condition** (L-030): "run COMPLETED ∧ stop SKIPPED" is, after F11, the definition of
  "this stop's orders were released" — every COMPLETED transition releases SKIPPED stops (R6).
  The alternative predicate `stop.orders.length === 0` was **rejected**: it reads the release's
  _effect_ rather than the state that caused it, and it would let a pre-fix stranded stop (orders
  still attached) reopen into a run whose settlement is already closed — a hole that then closes
  itself the moment the D4 repair runs, i.e. behaviour that depends on repair timing.
- The refusal is **REFUSAL, not reversal** (L-037 says which): the released orders are
  re-dispatchable on a new run; nothing needs unwinding.
- Reopening a **COMPLETED** stop on a COMPLETED run is unchanged (P4 pins it) — that path never
  releases anything and stays the sanctioned way back into a completed run.
- Placement note: reopenStop's existing order is state-checks-then-ownership (unlike B72's
  ownership-first sites). F11 inserts beside the existing state checks and does not reorder — a
  reorder is a B72-class change with its own row.

### R8 — buyer card copy and poll (B146, P0, T1: T17 T18 T19 T20)

`apps/mobile/lib/order-tracking-logic.ts` (already owns `trackingStepIndex`) gains two pure
helpers; the screen and hook call them.

```ts
export function trackingHeadline(t: {
  runStatus: string;
  stopStatus: string;
  stopsAhead: number;
}): string | null;
```

Precedence, first match wins:

1. `runStatus === "CANCELLED"` → `"This delivery run was cancelled — your order will be rescheduled."`
   (defensive: the server returns `tracking: null` for CANCELLED after R5, but a new app against
   an old server, or a stale cache, must never read "You're next").
2. `stopStatus === "SKIPPED"` → `"Your stop was skipped on this run — the seller will follow up to reschedule."`
   (regardless of `runStatus` — a SKIPPED stop on a pre-fix COMPLETED run reads the same).
3. `runStatus === "IN_PROGRESS"` → today's copy: `stopsAhead === 0 ? "You're next on the route" : \`${n} stop${n === 1 ? "" : "s"} ahead of you\``.
4. otherwise `null`.

```ts
export function trackingRefetchInterval(data: BuyerOrderTracking | undefined): number | false;
```

Returns `20_000` when `data.status ∈ {OUT_FOR_DELIVERY, PARTIALLY_DELIVERED}` (today's rule,
buyer.ts:613-616) **OR** `data.tracking?.runStatus === "IN_PROGRESS"` (new — a CONFIRMED order on a
live run never refreshed, so it could never observe its own skip); `false` otherwise.
`useBuyerOrderTracking`'s `refetchInterval` becomes `(q) => trackingRefetchInterval(q.state.data)`.

Screen (`(customer)/orders/[id].tsx:256-262`): the inline `runStatus === "IN_PROGRESS" ? …`
ternary is replaced by `{headline ? <Text style={styles.trackingLine}>{headline}</Text> : null}`
with `const headline = trackingHeadline(tracking.tracking)`. The `Driver:` line stays. **The
Estimated-arrival line is hidden when `stopStatus === "SKIPPED"`** (an arrival window under
"skipped" is a contradiction). The web has no tracking consumer (verified: no `/tracking` reader
in `apps/web`) — nothing to change there.

### R9 — the skip handler (B34, P0, T1: T21 T22 T23 T24)

New pure module `apps/mobile/lib/skip-stop.ts`:

```ts
export interface SkipStopDeps {
  runId: string | undefined;
  stopId: string;
  mutate: (
    vars: { runId: string; stopId: string; status: "SKIPPED" },
    cbs: { onSuccess: () => void; onError: (e: unknown) => void },
  ) => void;
  navigateBack: () => void;
  toast: (msg: string) => void;
}
export function createSkipStopHandler(deps: SkipStopDeps): () => void;
```

The returned function is the confirm dialog's `onConfirm`:

1. `!runId` → `toast("Run not loaded yet — try again")`, **no mutate, no navigation**.
2. A call while a previous mutate is still in flight → **no-op** (closure flag; `SecondaryBtn`
   at index.tsx:440-446 has no `disabled` prop, so the guard lives in the handler). The flag
   clears on `onSuccess` and `onError`.
3. Otherwise `mutate({ runId, stopId, status: "SKIPPED" }, …)`:
   - `onSuccess` → `toast("Stop skipped")` then `navigateBack()` — **navigation only after the
     server (or the offline queue) has accepted the write**.
   - `onError(e)` with `e.isOfflineQueued === true` (api-client.ts:184 — the queue rejects with
     that flag after enqueueing the PATCH) → `toast("Offline — skip queued and will sync when you reconnect")`
     then `navigateBack()`. A skip is a single idempotent PATCH (updateStopStatus has no
     same-status guard; a replay landing twice rewrites SKIPPED), so "queued, go back" is correct
     here — unlike adjust.tsx:276-279, which refuses because a half-applied edit is dangerous.
   - any other error → `toast(e?.response?.data?.message ?? e?.message ?? "Could not skip this stop")`,
     **driver stays on the stop**.

### R10 — wiring the driver screen; un-suppress the scan (B34, P0, T1: T25 T26)

`apps/mobile/app/(driver)/route/stop/[stopId]/index.tsx`:

- add `useUpdateStopStatus` to the `lib/api/routes` import (:21-27); import `createSkipStopHandler`;
  `const updateStopStatus = useUpdateStopStatus();`
- the `confirm(...)` at :334-339 keeps its title/body/options; its `onConfirm` becomes
  `createSkipStopHandler({ runId, stopId, mutate: updateStopStatus.mutate, navigateBack: () => router.replace("/(driver)/route" as any), toast: showToast })`
  (`showToast` and `confirm` are already imported at :12-13; `runId` is `params.runId ?? runIdFromActive`, :76-79).
- `useUpdateStopStatus` already invalidates `["route-runs", runId]` and `["route-runs","active"]`
  (routes.ts:384-387), which is `useActiveRouteRun`'s key, so the driver's list refreshes.
- **Delete `.claude/skills/bug-hunt/scan-ignore.json:74`** — the `"confirm-navigate"` suppression
  for exactly this `confirm(` call. It was hiding B34 from the scanner; after the fix the call is
  no longer a bare navigation and needs no suppression. The scanner is expected to stay quiet on
  the new shape; if it does not, the answer is a narrower rule, not a re-suppression.
- **Server: no change.** Skip stays a stop-only write (`updateStopStatus`), which the operator
  screen's `handleSkip` (route-runs/[id].tsx:165-182) already uses — both entry points hit one
  PATCH and B211's release covers both when the run completes. `handleSkip` is NOT refactored onto
  the helper (refetch semantics, no navigation) — optional, not required.

**B34 stays NARROW.** The controller's unvalidated inline body
(`routes.controller.ts:255`, `@Body() body: { status: "IN_PROGRESS" | "SKIPPED"; driverNote?: string }`),
a class-validator DTO, a transactional `updateStopStatus`, writing `skipReason`, and a
`FAILED_DELIVERY` stop status are **NOT built** — one follow-up row (R11).

### R11 — recorded, not fixed (REC, review)

The build-plan carries a "Follow-up rows to file (allocate B212+ from the register BEFORE any
REG- title is written)" table with at least:

| Finding                                                                                                                                                                                                          | Where                                                                  |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `RouteRunStop.skipReason` (schema.prisma:1247, "F11 wires the driver screen") has **zero writers and zero readers** repo-wide                                                                                    | schema + grep evidence; F11 deliberately does not wire it (narrow B34) |
| `PATCH /route-runs/:id/stops/:stopId` body is an unvalidated inline type                                                                                                                                         | routes.controller.ts:255                                               |
| Only `completeWithPayment` writes `OrderItem.deliveredQty`; `completeStop` and office-delivered orders leave 0                                                                                                   | routes.service.ts:2346 (inherited from F08's finding, per ruling R2)   |
| `findOneRun` legacy fallback fires for an un-cancelled, fully-released run                                                                                                                                       | routes.service.ts:1254-1255 (R4)                                       |
| `deleteRun` recorded-work gate + B209 `deleteRoute` (F10 handoff; F05 handoff item 2) and the cancel-while-unsettled policy call (F05 handoff item 1 — F11 recommends NO new block: settleRun accepts CANCELLED) | next routes batch (SEQUENCE §5)                                        |
| The cancel/complete transaction takes no run-row `FOR UPDATE`                                                                                                                                                    | R2                                                                     |

### R12 — documentation truth (P1, review)

- `update-run-status.dto.ts:18-25` and `stop-state-guards.spec.ts:390-394` comment: rewritten per
  R3. No code in either.
- The web cancel dialog (`routes/[id]/page.tsx:888`, "The run will be marked CANCELLED and the
  route can be dispatched again") becomes TRUE with this batch — **no change to it**.
- PR body states R15's attribution decision and the L-037 table verbatim.

### R13 — D4 historical repair (P1, dry-run + review)

**Decision: a D4 repair IS owed.** D4 (DECISIONS.md:48-53) binds "each batch that fixed a
damage-writing bug" to repair its identifiable historical rows, and this damage is exactly
identifiable by state: every run cancelled to date and every SKIPPED stop on a COMPLETED run.

`scripts/repair-f11-stranded-orders.mjs`, house pattern of `repair-f10-reopen-damage.mjs`:

- **Scope, derived not hardcoded:** `Order` rows with `routeRunStopId IS NOT NULL` whose stop's run
  is `CANCELLED`, OR whose stop is `SKIPPED` on a `COMPLETED` run — AND `Order.status NOT IN
('DELIVERED','CANCELLED')`. Nothing else is ever considered. Optional `--tenant <slug>` narrows.
- **Writes = the helper's three writes, verbatim**, per run in one transaction: (1) OUT_FOR_DELIVERY →
  CONFIRMED for in-scope orders, (2) null both pointers, (3) every PENDING `ChangeRequest` on the
  orders write 2 actually released → DECLINED (`resolution='DECLINED'`, the helper's own
  `RELEASED_CHANGE_REQUEST_REASON`, `resolvedAt`/`updatedAt` = NOW()), keyed by the same locked id
  array as write 2. Inside the tx the run's status, each order's pointer, AND each order's stop
  status are RE-READ (the stop re-check runs before the drift comparison, dropping any order whose
  stop has gone COMPLETED since the scan from all three writes); drift aborts that run.
- **Dry run by default** (`default_transaction_read_only = on`); writing needs `--execute
--i-have-a-fresh-backup --confirm <runId>` (repeatable, or `--confirm-all-listed`). Report lines
  `skipped (stop completed since scan): N` (orders dropped by the in-tx stop re-check) and `change
requests declined: N` (a projected COUNT in dry run, the actual write count in execute). JSONL
  before-state per order `{ orderId, routeRunId, routeRunStopId, status, pendingChangeRequestIds }`
  to `local-assets/f11-repair-<ts>.jsonl` — `pendingChangeRequestIds` are the exact CR ids write 3
  declined for that order, so the decline is reversible row by row. **Ids, statuses, dates, counts
  only — never names.** Refuses a non-prod database name without `--force-nonprod`.
- **`scripts/REPAIR-RUNBOOK.md`** gains a section "F11 — stranded orders on cancelled / completed
  runs" (command sequence, what it repairs, what it only reports) and a row in §4 Rolling back:
  `UPDATE "Order" SET "routeRunId"='<before>', "routeRunStopId"='<before>', status='<before>'::"OrderStatus" WHERE id='<id>';`
  from the JSONL before-state.
- **Reported, not repaired:** in-scope orders carrying a CONFIRMED CASH/CHECK `InvoicePayment`
  (R15's edge, historical instances) are still released, but each is listed as
  `attributionMoved: true` so the owner can check the run's settlement if one was recorded.
- It is **owner-run on prod after the deploy** (fresh verified backup first — runbook §1). Until it
  runs, R5's CANCELLED short-circuit is what protects the buyer card for pre-fix rows, which is
  why R5 ships in the same PR.
- Verification: the builder runs the dry run against the local docker DB seeded with one cancelled
  run and one completed-with-skipped run and pastes the output in build-plan.md. No jest.

### R14 — client caches (P2, droppable; tsc + review)

After a CANCELLED or COMPLETED status write the just-released orders reappear in pickers only when
their caches invalidate: `apps/mobile/lib/api/routes.ts` `useUpdateRunStatus.onSuccess` (:199-209)
also `invalidateQueries({ queryKey: ["orders"] })`; `apps/web/lib/api/routes.ts`
`useUpdateRouteRunStatus.onSuccess` (:368-378) also invalidates `["orders"]` and
`["trips-eligible-orders"]`. Cosmetic; **the web hook may be dropped if the lead wants api+mobile
only** — if kept, the commit title names `web` (L-008).

### R15 — the office-recorded-payment edge and the run-pointer's report readers (P0 decision, review + T1 pin P1)

**Decision: RELEASE, and document.** `getRunCashCollections` (:1484-1519) attributes a payment to a
run through `invoice.order.routeRunId` (:1495), so releasing an order moves any CONFIRMED CASH/CHECK
`InvoicePayment` on it off the run's expected figure. The only orders released sit on
**non-COMPLETED** stops, so that money was never collected at the door (at-door money always
COMPLETEs the stop, :2301-2304); it is a prepayment or an office-recorded receipt, and counting it
in the _driver's_ expected cash was already a mis-attribution the settlement inherited. After
release, `settleRun` (post-cancel, which it accepts) computes an expected figure that reflects what
the driver could actually have carried. This "only non-COMPLETED-stop orders are released" argument
is now enforced at WRITE time, not only at scan time: the repair script's in-transaction stop
re-read (R13) and the service's `routeRunStop: { status: { not: "COMPLETED" } }` relation filter
both refuse to release an order whose stop has gone COMPLETED, whether that happened before the
scan or between the scan and the write.

Refusing the release for such an order was **rejected**: it re-creates the Critical (a stranded,
un-dispatchable order) for the rare edge, and its only recourse would be the un-cancel path R3
deliberately keeps status-only. Residual, stated plainly: if a driver did take cash on a stop that
was never completed and the office recorded it against the order, the settlement expected figure
drops by that amount and the count shows a **positive** variance (cash in hand > expected) — a
visible surplus for the operator to investigate, not a hidden loss. The COMPLETED-path gate
(`getUnsettledPhysicalMoney`) reads before the release and is therefore never weakened by it.

**The pointer has a SECOND reader, and it shifts too — accepted, not worked around.**
`BookkeepingService.getSalesByDriver` (`bookkeeping.service.ts:1853-1915`) joins invoice → order →
routeRun → driver and skips any invoice whose order has no run (`if (!driver) continue;`). So the
release drops **every** invoice on a released order out of the Sales-by-Driver report — a wider set
than R15's payment edge, since no payment need exist — until a re-dispatch re-pins the order, at
which point the credit lands on the driver who actually delivers it. That is the correct reading:
the report has always attributed through the LIVE pointer (a re-dispatch or a driver reassignment
already moved credit between drivers, and an order that never rode a route never appears at all),
and a stop that recorded no work is the proof this driver did not deliver that order. Excluding
released orders from the release — or synthesising a "last driver" attribution — was rejected: the
first re-creates the Critical, the second invents history the schema does not keep. Consequences
to state, not to code around: (a) `scripts/repair-f11-stranded-orders.mjs` (R13) makes the shift
retroactive across every historical cancelled / completed-with-skipped run the moment the owner
runs it, and its per-order print is payment-scoped so these invoices are not itemised; (b) if
Sales-by-Driver feeds driver pay or commission for a past period, export it before the repair runs.
Both live in the PR body and in `REPAIR-RUNBOOK.md`'s F11 section beside the settlement note (R12).

---

## 2. Un-cancel and re-dispatch, end to end (the path R3 promises)

1. Run R1 (route X, stops s1 COMPLETED with order A delivered, s2 PENDING with order B, s3 SKIPPED
   with order C) is cancelled. In one tx: status CANCELLED; B and C lose their pointers (A keeps
   hers — s1 is COMPLETED). B and C are now eligible in the trip builder and for the sweep.
2. Operator un-cancels (PATCH IN_PROGRESS): status-only. s2 and s3 show no orders. B and C are
   NOT re-pinned. (If the operator wanted R1 back with B and C, the answer is: leave it cancelled
   and dispatch again.)
3. Operator dispatches route X again → `createRun` sweep (`routeRunStopId: null`, status ∉
   {DELIVERED, CANCELLED}, fulfillPath ROUTE) pins B and C to the new run's stops. A is untouched.
   This is T5.

---

## 3. Completeness sweep

| Case                                                           | Behaviour                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Empty** — run with zero stops, or every stop COMPLETED       | Status writes; `releaseUndeliveredOrders` receives `[]` and writes nothing (R1.3). T3.                                                                                                                                                                                   |
| **Unauthorized** — DRIVER sends CANCELLED                      | Refused today by the allowed-statuses check (:1385-1391) before anything F11 adds; unchanged (pin P7). A DRIVER's own COMPLETED (allowed) DOES release SKIPPED stops' orders — intended (R6).                                                                            |
| **Cross-tenant**                                               | `forTenant()` findUnique 404s a foreign run; the release runs through the `tenantTransaction` client. No new surface.                                                                                                                                                    |
| **Concurrent — two operators cancel at once**                  | Second request reads CANCELLED, matrix allows same→same (idempotent retries), the tx re-runs: update is a no-op, in-tx stop read returns the same non-COMPLETED stops, `updateMany` on orders whose pointer is already null matches 0 rows. No throw. T14.               |
| **Concurrent — cancel racing a driver's completeStop**         | In-tx stop read (R2) sees the stop as COMPLETED if completion committed first; if completion commits between the stop read and the order write, the `status notIn [DELIVERED,…]` filter excludes the orders completion just flipped. Recorded residual: no run-row lock. |
| **Concurrent — RF-016 auto-complete racing a PATCH COMPLETED** | Both release the same SKIPPED stops; second matches 0 rows. Idempotent.                                                                                                                                                                                                  |
| **Stale** — run deleted meanwhile                              | `findUnique` → 404 before any write, as today.                                                                                                                                                                                                                           |
| **Stale** — pre-fix stranded rows (deploy day)                 | Buyer card: R5's CANCELLED short-circuit. Dispatch: still refused until R13 runs (that is the repair's job). SKIPPED-on-COMPLETED pre-fix stops: R7 refuses their reopen from deploy onward; their orders free up when R13 runs.                                         |
| **Withheld auto-complete** (unsettled cash)                    | No release (run stays IN_PROGRESS). T11.                                                                                                                                                                                                                                 |
| **PARTIALLY_DELIVERED order on a non-COMPLETED stop**          | Released (status ∉ {DELIVERED, CANCELLED}); status kept. Whether the trips picker admits it is `TRIP_ELIGIBLE_STATUSES`' call, unchanged. Recorded.                                                                                                                      |

---

## 4. Deploy day and rollback

- **No migration.** Every column F11 reads exists; `skipReason` is not written (R10/R11).
- **Order of operations:** merge → deploy (public window per CLAUDE.md, wait for `BUILDING`, then
  private) → `npm run post-deploy-check` → **owner runs R13** (backup → dry run → per-run execute)
  → owner spot-checks one previously cancelled run's orders in the trip builder (should now be
  eligible).
- **Code rollback** = revert the PR. Orders released by the new code before the revert stay
  released — that is a CORRECT state (free for dispatch), nothing to undo; the pre-revert cancel
  simply behaves like a delete-without-deleting for its undelivered orders. The D4 repair has its
  own rollback (R13 JSONL + runbook §4).
- **Mobile/server skew:** old app + new server — the buyer card still hardcodes the ternary but
  receives `tracking: null` for CANCELLED (R5) so it falls to "Not yet on a delivery route." for
  CONFIRMED orders; a SKIPPED stop still reads "You're next" until the app updates (B146's UI half
  is app-side by nature). New app + old server — helper's CANCELLED branch covers the payload the
  old server still returns. Driver skip: new app hits the existing PATCH (no server change).

---

## 5. Non-goals (the fence)

- **B32** — moved to F20. Not built, not tested, no REG-B32 anywhere in F11's PR or build-plan.
- **`updateStopStatus` expansion** — DTO/class-validator body, transactional write, `skipReason`
  write, `FAILED_DELIVERY` status (R11 follow-up).
- **`deleteRun` / `deleteRoute` gates (B209, F05 handoff item 2)** and **cancel-while-unsettled
  block (F05 item 1)** — next routes batch; F11 recommends no new block on cancel.
- **Making CANCELLED terminal** — forbidden by F10's handoff (:142); F11 keeps un-cancel legal.
- **Re-sweep on un-cancel / ADHOC un-cancel refusal** — superseded by the R3 ruling.
- **Any change to F08's returns layer**, to `deliveredQty` semantics, or to `stopsAhead`'s
  computation.
- **Reader-side release** (teaching the sweep/trips to treat a CANCELLED-run link as free) —
  rejected by the ruling and by L-029; the reconcile branch's `discovery.md` conclusion that
  argued for it is superseded.
- **Refactoring the operator screen's `handleSkip`** onto the new helper — optional, not required.
- **A run-row `FOR UPDATE` in the cancel tx**, and **a new response field** on `updateRunStatus`.
- **Web tracking UI** — there is none; none is added.

---

## 6. Ledger and bookkeeping

- `.claude/campaign/status/F11.jsonl` must, at close-out, carry rows B129, B146, B34, **B211** and
  NOT B32 — the reconcile chore (`chore/campaign-reconcile-f07-f10`, SEQUENCE §3 step 0) files
  B211 in and moves B32 out. If F11 lands before that chore, F11's build-plan appends the B211 row
  (`tier T1, roundSha c60fe214`) and the lead confirms B32's disposition; a B32 row left in F11's
  shard with no `REG-B32` row in F11's build-plan makes `campaign-check` red. F11's build-plan
  carries `## Manual verification` → `(none)` (F11 has no T3).
- Lesson **L-045**, Symptom/Root cause/Lesson/Guard; category `domain`; guard = `REG-B129 (T5)`
  and `REG-B211 (T12)`. Bump `_meta.json.updatedAt`; do not touch `nextId` unless a second lesson
  is written.
- Code map: `api.md` (routes.service — the helper, the tx, the reopen refusal; orders.service —
  getOrderTracking contract), `mobile.md` (skip-stop.ts, order-tracking-logic.ts helpers, the two
  screens), `web.md` only if R14's web half ships; bump `_meta.json`.
