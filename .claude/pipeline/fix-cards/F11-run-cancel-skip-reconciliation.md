# F11 · Run cancel and skip reconciliation

**Bug IDs (4):** B32, B34, B129, B146

**Root cause:** A run's terminal transitions write only their own status row. Cancelling strands every order on a stale routeRunStopId so it can never be dispatched again (B129); a skip is invisible to the buyer's tracking card (B146); the driver's Skip button never calls the API at all (B34).

**Ships as:** One PR.

**Files:** routes.service.ts (updateRunStatus, updateStopStatus) · orders.service.ts (getOrderTracking) · mobile driver stop screen and operator route-runs screen

**Together because:** One class of terminal-transition bug across cancel/skip.

**Guardrails / shared infra:** None new. Consumes G7's extracted lineItems const.

**Dependencies / lane notes:** Requires F07 and F10 (semantic).

---

## Proof-tier assignment (frozen at seed — see plan's Phase 2 and `.claude/campaign/status/F11.jsonl`)

| ID   | Tier | Hunt-round SHA | Citation status     |
| ---- | ---- | -------------- | ------------------- |
| B32  | T3   | 2d0270fd       | OK                  |
| B34  | T1   | 2d0270fd       | OK                  |
| B129 | T1   | 0b2c3a0a       | NO_TOKEN_UNVERIFIED |
| B146 | T1   | 0b2c3a0a       | AMBIGUOUS_FILE      |

> T1 = jest spec (api or mobile pure-logic) · T2 = Playwright e2e, web-visible (proven-pending-deploy through the PR, per the plan) · T3 = recorded manual check (forbidden for Critical/High — none here are). See `.claude/campaign/citation-reanchor-log.md` for any bug ID flagged above whose citation needs a discovery-time check before trusting it verbatim.

---

## Bug details — register triple, evidence and suggested fix, pasted verbatim

### B32 — Two identical “Open in Google Maps” buttons

**Area:** Route runs · mobile

**Meant to do:** A single, unambiguous "Open in Google Maps" action reflecting the driver's actual remaining work (pending stops, from wherever they are now).

**Actually does:** Two separate buttons both labeled "Open in Google Maps" can render simultaneously: one (!isTerminal-gated, handleOpenInMaps) opens only PENDING/IN_PROGRESS stops with a live-GPS origin when the run is IN_PROGRESS; the other (visible whenever pins.length>0, regardless of terminal status) opens ALL stops including COMPLETED/SKIPPED ones with no origin, via openRouteInMaps(stops).

**The gap:** Identical labels hide materially different routes — tapping the wrong one can navigate through already-completed/skipped stops or drop the live-location origin.

**Evidence:** apps/mobile/app/(operator)/route-runs/[id].tsx:151-162 (handleOpenInMaps: filters to pending/in-progress + GPS origin), :350-355 (button 1, gated `!isTerminal`), :378-383 (button 2, gated only `pins.length > 0`, calls `openRouteInMaps(stops as any)` with all stops, no origin).

**Suggested fix:** Remove the redundant second button (lines 378-383) and route all cases through the single handleOpenInMaps action (adjust its pending-stop filter/gating if a completed run should still support "open all stops", but keep exactly one clearly-labeled control).

### B34 — “Skip stop” never records the skip

**Area:** Driver app · stops

**Meant to do:** Driver taps Skip stop to mark a stop as skipped so dispatch/operators can see it wasn't delivered and can follow up or reroute.

**Actually does:** Confirm dialog fires, then the onConfirm callback only calls router.replace("/(driver)/route") — no API call is made; the stop's status is never touched.

**The gap:** Stop status stays PENDING/IN_PROGRESS forever; operator route-runs view and any completion metrics never learn the stop was skipped.

**Evidence:** apps/mobile/app/(driver)/route/stop/[stopId]/index.tsx:334-344 (SecondaryBtn "Skip stop" onPress -> confirm(...) -> () => router.replace(...) only); useUpdateStopStatus defined apps/mobile/lib/api/routes.ts:313-327 (PATCH /route-runs/:runId/stops/:stopId, supports SKIPPED) but its only caller repo-wide is apps/mobile/app/(operator)/route-runs/[id].tsx — not imported in the stop detail file.

**Suggested fix:** Wire the Skip-stop confirm handler to call useUpdateStopStatus({runId, stopId, status: "SKIPPED"}) before navigating back, matching the operator route-runs screen's usage.

### B129 — Cancelling a run strands its orders on a stale stop link — they can never be dispatched again

**Area:** Route dispatch · web + API

**Meant to do:** Cancelling a run releases its undelivered orders back to dispatch — the modal only warns that "X customers with orders will not be delivered" — and the buyer's tracking card stops implying a delivery is in flight.

**Actually does:** updateRunStatus writes routeRun.status = CANCELLED and nothing else. Orders keep their status and their routeRunStopId, so every later dispatch sweep skips them as already-dispatched, and getOrderTracking keeps returning driver and run data forever while the buyer card renders a driver name and an arrival window.

**The gap:** Cancel is the only non-destructive exit from a run, and it is the one path that never unlinks the orders — while delete is refused as soon as any delivery has been recorded.

**Evidence:** apps/api/src/routes/routes.service.ts:1353-1403 (CANCELLED writes status only — no order or link cleanup), :922-930 (createRun sweep requires routeRunStopId: null), :1314-1323 (deleteRun: "This run has recorded deliveries; cancel it instead of deleting." — the Catch-22 is in the error text); apps/api/src/trips/trips.service.ts:112-126 (checkEligibility returns PREVIOUSLY_DISPATCHED / "Attached to a finished run (stale link)" for exactly this state), :181-189; repo-wide, the only writers of routeRunStopId: null are routes.service.ts:550,557 (deleteRoute) and :1330,1337 (deleteRun), and no order DTO exposes the field on update; apps/api/src/orders/orders.service.ts:4629-4689 (getOrderTracking has no CANCELLED handling); apps/mobile/app/(customer)/orders/[id].tsx:251-255, :263-270; apps/mobile/lib/api/buyer.ts:575-581 (20s poll keyed on a status that is never touched); apps/web/app/(dashboard)/routes/[id]/dispatch/page.tsx:186-250, 613-640 (the Cancel Run button, visible on any non-terminal run).

**Suggested fix:** When status becomes CANCELLED, run a transaction that nulls routeRunId/routeRunStopId on every non-DELIVERED order on the run and reverts OUT_FOR_DELIVERY back to CONFIRMED; have getOrderTracking return a cancelled/null tracking shape when the run is cancelled.

### B146 — Skipping a customer's stop is invisible to their tracking card and never reconciles the order

**Area:** Route stops · API + buyer app

**Meant to do:** If the driver bypasses this customer's stop, the buyer's "you're next" messaging should stop implying the delivery is still coming, and the order should leave OUT_FOR_DELIVERY.

**Actually does:** updateStopStatus writes only routeRunStop.status. stopsAhead counts only stops before the customer's own, so a skipped own-stop leaves it at 0 and the card reads "You're next on the route". The tracking payload carries stopStatus, and no client reads it.

**The gap:** The one field that would expose the skip is emitted and then ignored by every consumer, and the order's own status is never reconciled.

**Evidence:** apps/api/src/routes/routes.service.ts:1405-1433 (updateStopStatus writes status/driverNote/arrivedAt and never touches the linked order); apps/api/src/orders/orders.service.ts:4665-4671 (the stopsAhead filter structurally excludes the customer's own stop), :4681 (stopStatus emitted); repo-wide grep for stopStatus in apps/mobile returns only the two type declarations (lib/api/buyer.ts:562, lib/api/orders.ts:581) — zero reads in apps/mobile/app/(customer)/orders/[id].tsx:251-278, which renders driverName, runStatus, stopsAhead and estimatedArrivalWindow only; apps/mobile/lib/api/buyer.ts:575-581 (the poll continues because order.status is still OUT_FOR_DELIVERY).

**Suggested fix:** Have getOrderTracking short-circuit on the customer's own stop status (returning a skipped/cancelled tracking shape), render tracking.stopStatus in the buyer card, and decide whether a SKIPPED stop should revert the order to CONFIRMED so it can be re-swept.

---

## Discovery instructions (per the campaign plan)

Discovery's job is to confirm these lines still say what the register says they say on
current master, and find what the register missed — **never a broad repo sweep**. Where the
citation table above flags a bug ID, search within the files that ID's evidence already
names; do not expand beyond them without a specific reason. Classify every bug ID as
`CONFIRMED on master@<sha>`, `ALREADY FIXED (evidence)`, or `EVIDENCE MOVED (new path:line)`
before writing any code. An already-fixed ID is flipped in the register with its evidence —
never silently carried, never silently dropped.
