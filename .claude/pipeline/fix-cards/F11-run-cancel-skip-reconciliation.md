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

---

## ⚠️ Inbound handoff from F05 (2026-09-01, PR pending) — two ungated terminal paths

F05 made a cash-carrying run impossible to **COMPLETE** unsettled, gating all three completion
paths (`updateRunStatus`, plus the RF-016 auto-complete inside `completeStop` and
`completeWithPayment` — that auto-complete bypasses `updateRunStatus` entirely, which is why one
guard was not enough). Its Fable final pass then found the two paths F05 deliberately did NOT
take, because this batch owns them by charter:

1. **CANCEL is ungated.** `updateRunStatus` gates only `dto.status === COMPLETED`, so an operator
   cancelling a broken-down run (web `routes/[id]/page.tsx` sends `PATCH :id/status` CANCELLED;
   `canCancel` is true for IN_PROGRESS) closes it with the driver's cash still in the truck and
   `settlementNote` null. **F05 already removed the money-trap half:** `settleRun` now accepts
   CANCELLED so the cash can be reconciled post-hoc and is never stranded. What is left is the
   forcing function — decide whether cancel should refuse while unsettled physical money exists
   (same predicate and message as the COMPLETED backstop), or whether an operator prompt is the
   better UX. This is a workflow-policy call, which is why F05 left it here rather than shipping a
   new block on an operator's emergency action.
2. **`deleteRun` is ungated.** Its only guard is an existing `deliveryMutation` — which a
   payment-only `completeWithPayment` (payment, no `deliveries[]`) never creates — and it checks
   no run status. So a cash-collected run can be hard-deleted, and because delete unlinks
   `order.routeRunId`, it destroys the very linkage `getRunCashCollections` uses to find those
   payments: the cash becomes unattributable, not just unreconciled.

Reuse, do not reinvent: `RoutesService.getRunCashCollections(runId, startedAt?, client?)` already
returns `{ cashTotal, checkTotal, count }` over CONFIRMED CASH/CHECK payments plus RUN-referenced
advances, and the COMPLETED backstop's message is the wording to match.

---

## Handed to F11 by F10 (2026-09-01) — order un-pinning on cancel

F10 closed B72's driver-side resurrection hole. What shipped in
`forbiddenRunTransition` (`dto/update-run-status.dto.ts`) is a **deny-list**:
`CANCELLED → COMPLETED` and `COMPLETED → SCHEDULED` are refused for everyone, and inside
`updateRunStatus`'s DRIVER branch a cancelled run is refused outright
("This run was cancelled — ask your operator to restart it"), so a stale driver device cannot
replay "start run" on a called-off run.

**CANCELLED is deliberately NOT terminal**, and F11 must not make it so. The first draft of
F10 did make it terminal; review caught that this strands the run and its orders permanently.
Verified on `master@df1ef9a3`:

- `deleteRun` (`routes.service.ts:1320`) refuses any run with a recorded `deliveryMutation`
  ("This run has recorded deliveries; cancel it instead of deleting").
- Nothing in the CANCELLED branch clears `Order.routeRunId` / `routeRunStopId`, and the
  dispatch sweep requires `routeRunStopId: null`, so those orders cannot be re-collected onto
  a new run.
- The only other escape is **destructive**: `deleteRoute` (`:538`) refuses only
  `IN_PROGRESS`/`COMPLETED` runs, so a CANCELLED run passes; it then unpins the orders
  (`:565`), detaches delivery mutations and deletes the run stops — destroying the POD photos,
  signatures and timestamps of stops that really were delivered. Its own R3 comment states the
  false premise out loud: "scheduled/cancelled runs, **which recorded nothing**". Filed as
  **B209**; F11 or a later routes batch owns that fix. F10 recorded it and deliberately did
  not fix it.

So today an operator un-cancel is the only non-destructive recovery, which is why F10 left it
legal for operators.

**Requirement for F11:** the CANCEL-path side-effect reset should **unpin the linked orders**
(clear `routeRunId`/`routeRunStopId` for orders with nothing delivered on that stop) so the
dispatch sweep can re-collect them onto a new run. That gives a cancelled run a second,
forward recovery path that does not depend on un-cancelling the original run — and only once
that exists would making CANCELLED terminal be safe, if a later batch still wants it.

### Reversal completeness — the enumeration F10 had to do (reuse it, don't redo it)

F10's B55 fix removed reopenStop's stock write. The Fable final pass then found a SECOND
survivor the register never named: `OrderItem.deliveredQty`. The lesson for F11 is the method,
not the field — **a reversal must enumerate every field the forward operation wrote**, not just
the one the bug report named. Here is that enumeration, current as of F10 (`master@df1ef9a3`),
so F11's CANCEL path can start from it:

| Forward write (completeStop / completeWithPayment) | Reversed by reopenStop? |
| --- | --- |
| `routeRunStop.update` — status, completedAt, driverNote, podPhotoUrls, signatureUrl, safeDropEnabled, ageVerified, identityVerified, identityType, identityVerifiedAt | YES — full reset, plus the `podHistory` archive (B120) |
| `deliveryMutation.create` (per delivered line) | YES — `deleteMany` on the stop |
| `order.updateMany` → status DELIVERED | YES — back to CONFIRMED |
| `routeRun.update` → COMPLETED + completedAt (RF-016 auto-complete) | YES — back to IN_PROGRESS, completedAt null, settlement reset |
| `orderItem.update` → **`deliveredQty`** (completeWithPayment only, written whether or not money changed hands) | **WAS NOT — fixed in F10.** `reconcileOrderDraftInvoice(basis:"delivered")` bills `Number(li.deliveredQty ?? 0)`, so leaving it billed the undone delivery |
| `recordDeliveryPaymentInTx` → InvoicePayment / invoice status / AdvancePayment | **NOT reversed BY DESIGN** — F10's B54 guard *refuses* the reopen while confirmed money stands, rather than unwinding money. Refusal and reversal are different strategies; be explicit about which one each write gets |

⚠️ **Coupling F11 must know about:** it is precisely the **no-confirmed-money** case that B54
permits, and that same case is what reached the `deliveredQty` over-billing. A fix can open the
path to a latent bug — B54's guard is what made the B55-adjacent hole reachable. Expect the same
shape when CANCEL starts resetting side effects.

### Routes/invoicing caveat for the CANCEL/settlement work

The actionable set is `{completeStop, completeWithPayment}`. **`completeWithPayment` is only
conditionally covered**: it ensures an invoice exists solely when `dto.payment.amount > 0`, and
`payment` is `@IsOptional()` — so whether a delivery gets invoiced currently depends on whether
the driver happened to collect money at the door.

- **Extract a helper; do NOT route through `changeStatus`.** `changeStatus` opens its own
  transactions, re-runs role gates and the transition matrix, and fires notifications; nesting it
  inside `completeStop`'s open transaction re-runs guards against half-applied state.
- ⚠️ **Do not copy F07's ConflictException retry loop into an open transaction.** That loop is
  only safe because each attempt is a **fresh** transaction. Inside an already-open tx a failed
  statement can abort the whole transaction, so the helper cannot inherit that shape.

(Also recorded in the bug register under B210, so this survives the fix card.)
