# B803: re-delivery remainder plan — design memo (pre-build, needs an SA ruling)

Written per the Mac Lead's instruction: read the server delivery-entry contract
(SA-109/109a, SA-113b's evidence-row model) and write up what a remainder
delivery needs — `deliveredQty` on `RUN_LINE_ITEMS_SELECT` and a plan qty of
`qty − deliveredQty` — **before building**, since this touches the server
contract. Everything below is cited against `origin/master` (b8863d56),
verified by direct read, not assumed. Nothing has been implemented yet.

## 1. What B803 is actually closing

Today, once a line has `deliveredQty > 0` for ANY reason, every client-side
"is this line adjustable" gate excludes it outright — it is treated as fully
settled and simply disappears from the review screen, never shown at a
reduced remaining quantity:

- `short-pick.tsx:55` — `li.status !== "CANCELLED" && Number(li.deliveredQty ?? 0) === 0`
- `payment.tsx:118` — identical predicate
- `adjust.tsx:102` — identical predicate (pre-delivery order adjustment, a
  different screen/endpoint, same gate)
- `at-door-diff.ts:54` — `if (Number(orig.deliveredQty ?? 0) > 0) continue;`
  with the comment "Lines already (partially) delivered are never
  adjustable — server 409s (LINE_ALREADY_DELIVERED)."

So a driver who returns to finish a partially-delivered line today would see
**nothing to deliver** for it, not "4 remaining." That is the actual gap.
Exposing `deliveredQty` on `RUN_LINE_ITEMS_SELECT` alone does not fix
anything by itself — every one of these gates also has to change from
"exclude if `deliveredQty > 0`" to "exclude only if `deliveredQty >= qty`
(nothing remains)," and the reviewed quantity has to become
`remaining = qty − deliveredQty`, not the full `qty`.

`RUN_LINE_ITEMS_SELECT` (`apps/api/src/routes/routes.constants.ts:16-34`)
does not currently select `deliveredQty` at all — `RouteRunOrderItem`
(`apps/mobile/lib/api/routes.ts`) has no such field either. `OrderItem`
already has the column (`apps/api/prisma/schema/sales.prisma:783`,
`Decimal @default(0)`), so adding it to the select is a plain projection
widening — **no migration needed**.

## 2. The critical risk: `quantityDelivered` is a CUMULATIVE overwrite, not a per-visit increment

This is the part that makes this money-adjacent and the reason for the SA
gate, not the select change itself.

`routes.service.ts:2556` is the ONLY place `OrderItem.deliveredQty` gets
written during delivery completion, and it is a flat **overwrite**, not an
increment:

```ts
data: { deliveredQty: (d.type as any) === "REFUSED" ? 0 : d.quantityDelivered },
```

`assertDeliveriesFitStop` (`apps/api/src/routes/delivery-lines.util.ts:41-46`)
validates `0 <= quantityDelivered <= item.qty` — the line's **full original**
`qty`, never "remaining." If `quantityDelivered` meant "this visit's
increment," the bound would have to be the remaining amount, not the full
order quantity. It isn't. `apps/mobile/lib/api/orders.ts:62`'s own comment
confirms the intent: `/** Cumulative qty already delivered — gates at-door
adjustability (server: LINE_ALREADY_DELIVERED). */`

**Consequence**: if a line already carries `deliveredQty = 6` (of 10) from a
first visit, and a follow-up stop's short-pick screen naively sends
`quantityDelivered = 4` (meaning "I delivered the remaining 4 today"), the
server would **overwrite** `deliveredQty` to `4` — silently losing the
previously-recorded `6`. The correct payload for that line on the follow-up
visit is `quantityDelivered = 6 + 4 = 10` (the new cumulative total), not
`4`. `buildDeliveries`/`deliveryTypeForQty` (mobile `lib/short-pick.ts`)
already compare a `qty` value against `orderedQty` — the "remaining-qty
default" design has to feed them the RIGHT numbers so the resulting
`quantityDelivered` sent to the server is cumulative, or a remainder
delivery under-records the total by exactly the amount from the prior visit.
This is the one thing that must not ship wrong — it is a silent accounting
loss, not a crash or a 400.

## 3. There is no existing "reopen and continue" path — reopening is destructive

The only existing mechanic that touches a completed stop's delivered state a
second time is **reopening the stop**
(`routes.service.ts`, the reopen handler, ~3034-3057):

```ts
// 1. Delete delivery mutations for this stop
await tx.deliveryMutation.deleteMany({ where: { routeRunStopId: stopId } });
// 2. Reset order items → PENDING ... data: { status: "PENDING", deliveredQty: 0 }
```

Reopening **deletes every `DeliveryMutation` row for the stop and resets
every line's `deliveredQty` to 0** — it is a full undo, not a "continue
where you left off." A remainder delivery is NOT a reopen; it has to be a
**separate, later stop** for the same order, with the FIRST visit's
`deliveredQty` still standing when the second stop's review screen loads.

## 4. Scheduling the follow-up visit is already solved — this is NOT new ground

`Routes.addStop(routeId, dto: AddStopDto)` (`apps/api/src/routes/routes.service.ts:409`)
already lets staff add an order to a route/stop. B803 does not need a new
stop-creation mechanism — an operator can already schedule a follow-up stop
for the same order on a later run. The gap is purely: when the DRIVER opens
THAT follow-up stop's short-pick review, does it correctly show "4
remaining" (not "10 ordered," not "nothing to review")?

`PARTIALLY_DELIVERED` is a real, actively-used `OrderStatus`
(`sales.prisma:9`, with transitions/UI/credit-exposure/returns-eligibility
wired across api/mobile/web) — but it is a **manual, staff-driven**
transition today (`apps/mobile/lib/order-actions.ts` ~93, an operator action
from `OUT_FOR_DELIVERY`), not something the driver app's stop-completion
flow sets automatically. Stop completion unconditionally flips every linked
order to `DELIVERED` regardless of any line's PARTIAL/REFUSED outcome
(`routes.service.ts`, step 3 of `completeStop`/`completeWithPayment`:
`data: { status: OrderStatus.DELIVERED }`, filtered only by
`NON_ROUTABLE_ORDER_STATUSES`). Whether B803 should also make a
PARTIAL/REFUSED-containing completion land on `PARTIALLY_DELIVERED`
automatically instead of `DELIVERED` is an open question below — today an
operator does that by hand.

## 5. No existing server guard blocks a remainder completion call

`LINE_ALREADY_DELIVERED` (`orders.service.ts:5259`, `if (Number((held ??
li).deliveredQty ?? 0) > 0) throw new ConflictException(...)`) guards the
**order-edit / change-request** path (`adjust.tsx`'s endpoint) — it does NOT
guard `completeStop`/`completeWithPayment`. `assertDeliveriesFitStop` has no
analogous "already delivered" check; it only bounds `quantityDelivered`
against the line's full `qty`. So a second delivery-completion call against
a partially-delivered line is not currently rejected server-side — the gap
really is client-side (the review screen never shows/offers it), plus the
cumulative-arithmetic correctness described in §2.

## 6. SA-113b's evidence-row model — an alternative source of truth to consider

SA-113b (`.claude/sa/RULINGS.md`, landing via Lane F's round 7, **not yet
merged to master**) defines the canonical "how much has this line actually
received" as: sum `quantityDelivered` over every `DeliveryMutation` row for
the line where `quantityDelivered != null` (an "evidence" row — the close
paths always set it; the change-request path never does), REFUSED counting
as 0, ADD_ON/null-`quantityDelivered` rows excluded entirely as
change-provenance, not delivery evidence.

This is a DIFFERENT, more robust way to answer "how much delivered so far"
than reading the single `OrderItem.deliveredQty` scalar: it derives from the
mutation-row history directly rather than trusting a value that (a) a client
bug could under/over-write per §2, and (b) reopening wipes to 0 along with
the rows themselves (§3) — so on the ONE line where the two sources could
diverge (a client that got the cumulative math wrong on a remainder visit),
the evidence-row sum would still be internally consistent with the
`DeliveryMutation` audit trail, while `deliveredQty` would just be wrong.
The cost: it is not a plain `select: true` on `RUN_LINE_ITEMS_SELECT` — it
needs an aggregation (a join/subquery over `DeliveryMutation`, or a
server-computed field), and it depends on SA-113b's basis logic actually
landing first.

**Given the Mac Lead's framing names `deliveredQty` on `RUN_LINE_ITEMS_SELECT`
specifically, this memo treats that as the default proposed shape (§7) and
flags the evidence-row alternative as a question for the SA (§8), not a
recommendation to switch** — a plain column read is far cheaper and ships
independently of Lane F's round 7, but inherits the correctness risk in §2
that the client MUST get right every time.

## 7. Proposed minimal shape (NOT decided — for the SA to rule on)

1. **Server**: add `deliveredQty: true` to `RUN_LINE_ITEMS_SELECT`
   (`routes.constants.ts`). No migration. `RouteRunOrderItem`
   (`apps/mobile/lib/api/routes.ts`) gains `deliveredQty?: number`, mirroring
   the richer `Order` type's existing field.
2. **Client gates**: change every "adjustable" predicate listed in §1 from
   `deliveredQty === 0` to `deliveredQty < qty` (line has remaining qty and
   isn't cancelled) — `short-pick.tsx`, `payment.tsx`'s fallback/rich
   derivations both route through the shared `shortPickLinesFromOrder`/
   `adjustableLines` (B762 lineage, not yet merged) — that shared predicate
   is the ONE place this needs to change on the mobile side going forward,
   not four separate inline copies.
3. **Client remaining-qty math**: the reviewed/defaulted quantity for a line
   becomes `remaining = qty - deliveredQty`, and the value SENT to the
   server as `quantityDelivered` must be `deliveredQty + (whatever the
driver confirms delivered this visit, 0..remaining)` — cumulative, per
   §2. This is the one piece that most needs an explicit test/pin before it
   ships anywhere near real money.
4. **Order status on a short/refused completion**: open question, see §8.

## 8. Open questions for the SA ruling

1. **Source of truth**: `OrderItem.deliveredQty` (cheap, ships independent
   of Lane F) or the SA-113b evidence-row sum (more robust, depends on
   round 7 landing first, needs a real aggregation)? Or `deliveredQty` now,
   with a note to reconcile against the evidence-row sum once round 7 lands?
2. **Cumulative arithmetic**: confirm the client must send
   `deliveredQty + thisVisitAmount`, never `thisVisitAmount` alone, as
   `quantityDelivered` — and whether that computation belongs in a new pure
   `lib/short-pick.ts` helper (testable) rather than inline in the screen.
3. **Order status after a short/refused completion**: should
   `completeStop`/`completeWithPayment` set the order to
   `PARTIALLY_DELIVERED` instead of unconditionally `DELIVERED` when any
   line landed PARTIAL/REFUSED — closing the gap in §4 — or is that
   explicitly out of scope for B803 (leave it a manual staff action)?
4. **Multiple remainder visits**: is a THIRD visit (remainder of a
   remainder) in scope, or is B803 exactly one follow-up? The cumulative
   design in §7.3 generalizes to N visits for free if `deliveredQty` is
   trusted as accurate; flagging in case that generalization itself needs
   review.
5. Does this depend on B762 landing first? The client gate this touches
   (`shortPickLinesFromOrder`/`adjustableLines`) only exists as a single
   shared function on B762's branch (`fix/b762-multi-order-short-pick`,
   local sha 2e4d61be) — on master today it's still four separate inline
   copies (§1). Building B803 against master directly would mean touching
   all four sites now and reconciling with B762's extraction later, or
   building B803 as a rebase on top of B762 once it merges.

Branch: `fix/b803-redelivery-remainder-plan`, worktree `rf-lane-b803`, base
`origin/master` @ b8863d56. No code changes yet — this file is the entire
diff, pending the SA's ruling.
