# F24 · At-door change requests (ships combined with F22 as one PR — see F22's card)

**Bug IDs (5):** B134, B135, B162, B163, B164

**Root cause:** Approval un-sends the order's issued invoice with nothing to restore it (B134) and re-validates money in-transaction while reading its delivery window before it (B135); the customer notification fires at REQUEST time quoting the pre-change total (B162); a blocked request orphans a PENDING row (B163); a buyer's request reaches nobody who can act on it (B164).

**Ships as:** COMBINED with F22 into one PR — see F22's card for the full 8-ID list and rationale.

**Files:** orders/change-requests.service.ts · orders.service.ts approval path · apps/mobile/.../stop/[stopId]/adjust.tsx · buyer portal order page

**Together because:** Both F22 and F24 wait on F07 and both rewrite orders.service.ts post-dispatch paths — combining removes a dependency edge.

**Guardrails / shared infra:** None new.

**Dependencies / lane notes:** Requires F07 (semantic).

---

## Proof-tier assignment (frozen at seed — see plan's Phase 2 and `.claude/campaign/status/F24.jsonl`)

| ID   | Tier | Hunt-round SHA | Citation status              |
| ---- | ---- | -------------- | ---------------------------- |
| B134 | T1   | 0b2c3a0a       | MOVED (disambiguate in-file) |
| B135 | T1   | 0b2c3a0a       | NO_TOKEN_UNVERIFIED          |
| B162 | T1   | 0b2c3a0a       | NO_TOKEN_UNVERIFIED          |
| B163 | T1   | 0b2c3a0a       | NO_TOKEN_UNVERIFIED          |
| B164 | T1   | 0b2c3a0a       | NO_TOKEN_UNVERIFIED          |

> T1 = jest spec (api or mobile pure-logic) · T2 = Playwright e2e, web-visible (proven-pending-deploy through the PR, per the plan) · T3 = recorded manual check (forbidden for Critical/High — none here are). See `.claude/campaign/citation-reanchor-log.md` for any bug ID flagged above whose citation needs a discovery-time check before trusting it verbatim.

---

## Bug details — register triple, evidence and suggested fix, pasted verbatim

### B134 — At-door approval un-sends the order's issued invoice, and a failed approval never restores it

**Area:** At-door changes · API (orders + invoices)

**Meant to do:** Approving a change at the door merges the delta and keeps the paperwork consistent; a refused approval leaves everything untouched, as the code's own "a throw rolls the claim back with the merge" comment promises.

**Actually does:** revertLinkedInvoicesForOrderEdit runs unconditionally on its own connection before the transaction opens, flipping SENT/VIEWED/OVERDUE invoices to DRAFT with sentAt and pdfUrl nulled. Nothing re-sends them, and nothing compensates a merge that then fails.

**The gap:** The sibling order-edit path skips this revert for post-delivery statuses; the at-door path — whose whole window is those statuses — kept the old unconditional, non-transactional form.

**Evidence:** apps/api/src/orders/orders.service.ts:4137-4142 (unconditional revert, with a comment citing a line range in updateOrderItems that no longer exists), :4087-4093 (window admits PENDING/CONFIRMED/OUT_FOR_DELIVERY), :4159-4161 (the transaction opens after), :4455-4470 (settleStockForEdit and assertWithinCreditLimit throw inside it), :4513 (post-commit reconcile re-syncs but leaves the invoice DRAFT); contrast :2595-2609 (updateOrderItems' postDeliveryEdit exemption); apps/api/src/invoices/invoices.service.ts:3914-3965 (status select, deposit-only exemption at :3927-3939, throw-on-payments at :3945-3952, DRAFT + sentAt null + pdfUrl null at :3954-3963); apps/mobile/app/(driver)/route/stop/[stopId]/adjust.tsx:265-297 (the driver only ever sees a toast).

**Suggested fix:** Pass the transaction into revertLinkedInvoicesForOrderEdit (it already accepts a tx) so a failed merge rolls it back, and mirror updateOrderItems' postDeliveryEdit exemption so an at-door merge re-syncs the issued invoice in place instead of un-sending it.

### B135 — At-door approval re-validates money inside the transaction but reads its delivery window before it

**Area:** At-door changes · API (change-request approval)

**Meant to do:** Once the driver closes the stop the at-door window shuts: approval should return STOP_ALREADY_COMPLETED or LINE_ALREADY_DELIVERED rather than mutate a delivered, invoiced order.

**Actually does:** Order status, stop status and per-line deliveredQty are read before the transaction and never re-read inside it. A stop completion committing in that gap is invisible, and the merge writes new quantities and totals onto an order that is already DELIVERED.

**The gap:** Stock and credit were deliberately re-checked inside the transaction; the three window guards were not, and the change-request claim does not serialize against stop completion.

**Evidence:** apps/api/src/orders/orders.service.ts:4079-4086 (pre-tx read including routeRunStop), :4087-4099 (all three window guards from that snapshot), :4142-4157 (four more pre-tx round trips widening the gap), :4159-4172 (tx opens; heldItems re-read feeds only the stock delta), :4174-4189 (the claim — the only race-safe part), :4198-4205 and :4311-4316 (stale deliveredQty reads), :4455-4470 (stock and credit re-run in-tx); apps/api/src/routes/routes.service.ts:1814+ (completeWithPayment writes deliveredQty at :1925 and order.status DELIVERED at :1936-1938 — grep for changeRequest in that file returns zero hits, so nothing serializes the two); apps/api/src/invoices/invoices.service.ts:1299-1336 (the merged delta can never reach a finalized invoice).

**Suggested fix:** Inside the transaction, after the FOR UPDATE lock, re-read order.status, the linked RouteRunStop status and the target line's deliveredQty, and re-run the three window guards there — the same treatment the stock and credit guards already get.

### B162 — "Order changed at door" fires when the change is requested, quoting the pre-change total

**Area:** At-door changes · messaging (customer notifications)

**Meant to do:** The customer message tells them what actually happened to their order and what they now owe.

**Actually does:** The notification fires immediately after the PENDING request row is created, with the total read from the untouched pre-change order. It is the only trigger, so a declined or guard-blocked request still tells the customer the order "was adjusted".

**The gap:** A past-tense, money-bearing message is fired at request time and never re-fired or corrected after the merge that changes the total.

**Evidence:** apps/api/src/orders/change-requests.service.ts:51-57 (the order is read once and never re-read), :138-152 (the row is created PENDING), :154-166 (the notify with the pre-change total), :171-185 (the summary states the requested delta as fact), :400-419 (the requester notification never reaches the customer for a driver-filed change); apps/api/src/messaging/messaging-config.service.ts:42-45 (the template: "was adjusted at delivery … New total"), :16, :78-86 (the event is seeded OFF); repo-wide grep returns exactly one trigger; apps/mobile/app/(driver)/route/stop/[stopId]/adjust.tsx:50-56 and :288-293 (the screen's own comment admits the request was created and the buyer notified before the regulated guard rejected it).

**Suggested fix:** Move the trigger to the resolution paths — fire after the at-door approval commits, with the post-merge total it already returns — and either suppress it on decline or send a distinct "change requested" template at creation.

### B163 — A blocked at-door change orphans a PENDING request; only the licence path cleans up

**Area:** At-door change requests · mobile driver + API

**Meant to do:** A change the server refuses at the door leaves no trace — the screen's own comment says a blocked request is remembered so it can be declined and cleaned up instead of lingering PENDING.

**Actually does:** Only the regulated-licence branch records the created request for decline. The credit-limit branch and the generic branch (line already delivered, stop already completed, 5xx) return false and drop it, and no server sweep or expiry exists.

**The gap:** A refused change leaves a permanent PENDING row that lights the orders-list badge and the order page card until an operator manually declines it.

**Evidence:** apps/mobile/app/(driver)/route/stop/[stopId]/adjust.tsx:254-259, :274-282 (the blocked-request ref is set only in the regulated branch), :288-292, :293-297, :515-522, :151-160 (the decline helper is wired only to the licence modal); apps/mobile/components/CreditLimitGuardModal.tsx:8-17, :54-60 (Cancel is the only button on driver screens); apps/api/src/orders/change-requests.service.ts:138-152 (the row commits before any resolve); apps/api/src/orders/orders.service.ts:4464-4470, :4099, :4205 (all three refusals are post-create); the only changeRequest writers are create and the claim updates — there is no expiry or sweep; the badge chain runs from orders.service.ts:314-319 to apps/web/app/(dashboard)/orders/page.tsx:909-919.

**Suggested fix:** Assign the created request id in every post-create failure branch (credit and generic) and decline it on the modal's Cancel/exit the way the licence path already does; optionally add a server-side sweep that declines PENDING requests whose run has completed.

### B164 — A buyer's at-door change request reaches nobody who can act on it

**Area:** At-door change requests · buyer portal + API + driver

**Meant to do:** A buyer told that "changes need the seller's confirmation" while the truck is en route has that request reach the office or the driver inside the minutes-long window the API deliberately enforces.

**Actually does:** Creating the request fires exactly one notification and it targets the CUSTOMER. There is no internal alert, no socket emit for change requests, and no driver screen queries or renders them — the only staff-side signal is an unpolled badge on the web orders list.

**The gap:** Nobody who could act is told inside the window; by the time the run ends, the only options left are Decline or roll it to the next delivery.

**Evidence:** apps/web/app/buyer/portal/[seller]/orders/[id]/page.tsx:309 (the promise) and :218-302 (the fully built modal); apps/api/src/orders/change-requests.service.ts:50-169 (the only notify in create is customer-directed at :154-166), :77-85 (the window is IN_PROGRESS-only); apps/api/src/messaging/messaging-config.service.ts:12-24 (the event maps to customer channels; internal channels exist only for four other events); grep changeRequest across apps/mobile/app/(driver) matches only adjust.tsx, which creates them; apps/api/src/routes/routes.service.ts:1160-1180 (the run payload carries no change requests); the sole staff visibility is orders.service.ts:314-319 → apps/web/app/(dashboard)/orders/page.tsx:909-919, and that list does not poll.

**Suggested fix:** Emit an internal ops notification and the existing orders gateway event on change-request create, and include pending change requests in the route-run payload so the driver's stop screen surfaces them at the door.

---

## Discovery instructions (per the campaign plan)

Discovery's job is to confirm these lines still say what the register says they say on
current master, and find what the register missed — **never a broad repo sweep**. Where the
citation table above flags a bug ID, search within the files that ID's evidence already
names; do not expand beyond them without a specific reason. Classify every bug ID as
`CONFIRMED on master@<sha>`, `ALREADY FIXED (evidence)`, or `EVIDENCE MOVED (new path:line)`
before writing any code. An already-fixed ID is flipped in the register with its evidence —
never silently carried, never silently dropped.
