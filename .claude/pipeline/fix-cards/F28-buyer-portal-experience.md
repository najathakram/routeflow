# F28 · Buyer portal experience

**Bug IDs (6):** B43, B44, B45, B153, B175, B176

**Root cause:** The cart excludes unpriceable lines from the total but still orders them and errors with a raw UUID (B153); "Estimated arrival" is a static preference, not an ETA (B175); stopsAhead undercounts by one (B176). Plus two genuine feature gaps — mobile buyers cannot pay online (B44) and the ownership-checked customer returns API has no customer UI (B45).

**Ships as:** One PR.

**Files:** buyer portal cart/checkout · web/mobile ETA + tracking surfaces · returns customer-facing UI

**Together because:** One buyer-facing surface, several independent UX/feature-gap defects batched together.

**Guardrails / shared infra:** None new. No lane conflicts — freely parallel.

**Dependencies / lane notes:** None.

---

## Proof-tier assignment (frozen at seed — see plan's Phase 2 and `.claude/campaign/status/F28.jsonl`)

| ID   | Tier | Hunt-round SHA | Citation status              |
| ---- | ---- | -------------- | ---------------------------- |
| B43  | T1   | 2d0270fd       | OK                           |
| B44  | T3   | 2d0270fd       | NO_TOKEN_UNVERIFIED          |
| B45  | T2   | 2d0270fd       | NO_TOKEN_UNVERIFIED          |
| B153 | T1   | 0b2c3a0a       | MOVED (disambiguate in-file) |
| B175 | T1   | 0b2c3a0a       | NO_TOKEN_UNVERIFIED          |
| B176 | T1   | 0b2c3a0a       | MOVED (corrected)            |

> T1 = jest spec (api or mobile pure-logic) · T2 = Playwright e2e, web-visible (proven-pending-deploy through the PR, per the plan) · T3 = recorded manual check (forbidden for Critical/High — none here are). See `.claude/campaign/citation-reanchor-log.md` for any bug ID flagged above whose citation needs a discovery-time check before trusting it verbatim.

---

## Bug details — register triple, evidence and suggested fix, pasted verbatim

### B43 — Buyer tracking map is a placeholder

**Area:** Buyer app · tracking

**Meant to do:** While an order is out for delivery, the buyer should see the driver's live position on a map alongside the driver name, stops-ahead count, and ETA window.

**Actually does:** driverName, stopsAhead, and estimatedArrivalWindow all render live from the tracking payload; directly beneath them sits a static box reading 'Live map coming soon' with a map-outline icon — no map, no live location.

**The gap:** The visually central element of the 'Delivery tracking' card — the map — is an inert placeholder while three other live data points on the same card work.

**Evidence:** apps/mobile/app/(customer)/orders/[id].tsx:251-274 (trackingLive block: driverName L253-255, stopsAhead L256-262, ETA L263-270, placeholder L271-274)

**Suggested fix:** Implement the live map (reuse whatever location-tracking/map component the driver route view uses) or drop the placeholder box until it ships, since it currently occupies space promising a feature that isn't built.

### B44 — Mobile buyers can’t pay online

**Area:** Buyer app · payments

**Meant to do:** Per 'mobile mirrors web', the mobile buyer Payments screen should let a customer pay an outstanding balance by card or declare a cash payment, same as the web buyer portal.

**Actually does:** apps/mobile/app/(customer)/payments.tsx is entirely read-only: wallet tiles, active-credit list, statement PDF download, paginated payment history, and static 'How to pay' remittance text (bank/check/ACH/wire fields) — no payment-initiating action anywhere. The per-invoice detail screen likewise only shows 'Amount due' and a read-only payment list.

**The gap:** A mobile-only buyer has no way to pay online at all — only to read manual bank-transfer instructions — while the web buyer portal has full card-charge and cash-declaration flows.

**Evidence:** apps/mobile/app/(customer)/payments.tsx:1-268 (no mutation, no Pay button; 'How to pay' static fields L241-261); apps/mobile/app/(customer)/invoices/[id].tsx:155-231 (Amount due + read-only Payments list, no pay action); useStartCardPayment/useDeclareCashPayment defined apps/web/lib/api/buyer-payments.ts:109,122, consumed only by apps/web/app/buyer/portal/[seller]/payments/_components/MakePaymentPanel.tsx:13-14,118,320; zero matches for either hook under apps/mobile

**Suggested fix:** Port MakePaymentPanel's card/cash flow (or a mobile-appropriate equivalent using the same buyer-payments API) into the mobile Payments screen so buyers can pay from the app instead of switching to web.

### B45 — Customer returns API has no customer UI

**Area:** Buyer portal · returns

**Meant to do:** Given the API is deliberately built to let a CUSTOMER create, list, view, and cancel their own returns (with ownership checks), customers should be able to request and track returns from their own portal — web buyer portal or mobile customer app.

**Actually does:** returns.controller.ts grants CUSTOMER role on POST / (create), GET / (list), GET /:id (find, ownership-checked in findOneForUser), and POST /:id/cancel (ownership-checked); returns.service.ts enforces per-customer ownership at lines 66, 166, 387-389, 436-439, and a dedicated security spec (returns.security.spec.ts) verifies a customer can read only their own return. But no component under apps/web/app/buyer/** or apps/mobile/app/(customer)/** imports the returns API at all — the only consumers of lib/api/returns.ts are the OPERATOR web dashboard and the mobile (operator)/(driver) roles.

**The gap:** The authorized, ownership-checked CUSTOMER capability is entirely unreachable from any customer-facing UI on either platform — a real customer can only get a return started by calling an operator, defeating the purpose of the role grant.

**Evidence:** apps/api/src/returns/returns.controller.ts:19-31 (create/list allow CUSTOMER),54-55(find, CUSTOMER + TENANT_ADMIN),90-91(cancel allows CUSTOMER); apps/api/src/returns/returns.service.ts:66,166,387-389,436-439 (ownership checks); apps/api/src/returns/returns.security.spec.ts:125-137; consumers of lib/api/returns.ts limited to apps/web/app/(dashboard)/returns/page.tsx and [id]/page.tsx (operator dashboard) and apps/mobile/app/(operator)/returns/{index,new,[id]}.tsx + apps/mobile/app/(driver)/route/stop/[stopId]/return/index.tsx; zero matches under apps/web/app/buyer/** or apps/mobile/app/(customer)/**

**Suggested fix:** Build a minimal customer-facing returns flow (start a return from an invoice/order line, view status, cancel) in both the buyer web portal and the mobile (customer) app, reusing the already-authorized POST/GET/cancel endpoints.

### B153 — The buyer cart excludes unpriceable lines from the total but still orders them, and a deleted product errors with a raw UUID

**Area:** Buyer portal · cart / checkout

**Meant to do:** The Estimated Total is what the buyer is agreeing to, and a failure at Place Order names the offending item rather than an internal identifier.

**Actually does:** An unresolvable line renders "Price unavailable", contributes 0 to the total, and is still submitted; the server applies no isActive filter on the buyer create path and prices it normally. A hard-deleted product surfaces "Product <uuid> not found".

**The gap:** The approved total and the created order can differ, the item count and the money disagree, and the error names a UUID with no way to clear the line.

**Evidence:** apps/web/lib/buyer-cart.ts:20-40, :44-46, :145 (totalQty sums every item); apps/web/app/buyer/portal/[seller]/cart/page.tsx:58-61, :92, :144-147 (unresolved lines excluded from the subtotal), :158-171 (every cart item submitted), :194, :456-473, :549 ("Subtotal ({cart.totalQty} items)"), :560-566 (the disclosure copy); apps/api/src/buyer/buyer-catalog.service.ts:168-177 (the catalog does filter isActive) vs buyer.controller.ts:509-523 (create delegates with no active-product check); apps/api/src/orders/orders.service.ts:1526-1530 (product.findMany with no isActive), :1648 (the raw-UUID BadRequestException).

**Suggested fix:** Block or strip unresolved lines at Place Order (or send them explicitly unpriced), base the "Subtotal (N items)" count on priced lines only, and map the server's "Product <id> not found" to a named, removable cart line.

### B175 — Buyer "Estimated arrival" is the customer's static delivery-hours preference, not an ETA

**Area:** Buyer tracking · API + mobile

**Meant to do:** Sitting beside a live stops-ahead counter under "Delivery tracking", an "Estimated: 9:00 – 11:00" line reads as a projection of when the driver will actually arrive today.

**Actually does:** The field is copied verbatim from the customer's delivery-window profile fields — the same standing preference staff edit and the optimizer consumes as a solver constraint. It never varies with stops ahead, run progress or clock time.

**The gap:** A static preference is surfaced under an "Estimated" label; the value itself is truthful, only the word is not.

**Evidence:** apps/api/src/orders/orders.service.ts:4633 (the select) and :4683-4686 (copied straight through, no other input); apps/api/src/customers/customers.service.ts:648-653 (a plain profile update, confirming it is a standing preference); apps/api/src/route-optimization/route-optimization.service.ts:211-228 (used elsewhere only as a feasibility constraint); apps/mobile/app/(customer)/orders/[id].tsx:263-270 (rendered as "Estimated: {start} – {end}").

**Suggested fix:** Relabel the field and the UI line to "Delivery window" — what it actually is — or compute a genuine per-run arrival estimate and only then keep the "Estimated" wording.

### B176 — stopsAhead skips the stop the driver is working, undercounting by one

**Area:** Buyer tracking · API

**Meant to do:** "N stops ahead of you" counts every stop still standing between the driver and this customer, including the one the driver is currently at.

**Actually does:** The filter counts only PENDING prior stops, so an in-progress stop is excluded. With the driver mid-delivery at stop 3 and stop 4 pending, a customer at stop 5 is told "1 stop ahead of you" when two remain.

**The gap:** IN_PROGRESS is treated as resolved alongside COMPLETED and SKIPPED, though it is the one stop still being worked.

**Evidence:** apps/api/src/orders/orders.service.ts:4665-4671 (the predicate, with a comment describing it as counting pending stops before this customer's); apps/api/prisma/schema.prisma:99-104 (the status enum has four values, so IN_PROGRESS is the only non-terminal status the filter drops); apps/api/src/routes/routes.service.ts:~1405 [re-anchored master@6c8f1401; was :1429-1431 at hunt round master@0b2c3a0a] (updateStopStatus sets IN_PROGRESS and stamps arrivedAt, confirming the state is entered in normal driving flow); apps/mobile/app/(customer)/orders/[id].tsx:256-262 (a count of 0 renders "You're next on the route").

**Suggested fix:** Change the predicate to exclude only COMPLETED and SKIPPED, so an in-progress stop counts.

---

## Discovery instructions (per the campaign plan)

Discovery's job is to confirm these lines still say what the register says they say on
current master, and find what the register missed — **never a broad repo sweep**. Where the
citation table above flags a bug ID, search within the files that ID's evidence already
names; do not expand beyond them without a specific reason. Classify every bug ID as
`CONFIRMED on master@<sha>`, `ALREADY FIXED (evidence)`, or `EVIDENCE MOVED (new path:line)`
before writing any code. An already-fixed ID is flipped in the register with its evidence —
never silently carried, never silently dropped.
