# F08 · Returns, end to end

**Bug IDs (10):** B20, B21, B53, B61, B68, B69, B75, B82, B128, B166

**Root cause:** The whole module reasons about ORDERED quantity when it should reason about DELIVERED. B128 (driver files the delivered qty) and B53 (server caps against ordered) compound into a credit for goods the customer kept; B68/B69 are the non-atomic refund and the cancel/receive race.

**Ships as:** One PR.

**Files:** returns.service.ts (create, receive, processRefund, cancel) · apps/mobile/app/(driver)/route/stop/[stopId]/return/index.tsx · web returns list and detail · credit-notes.service.ts

**Together because:** The register says it explicitly — "whoever rewrites this map should fix both the quantity basis and the restock policy in one change" — the ordered-vs-delivered basis is a single decision every one of these ten depends on.

**Guardrails / shared infra:** None new.

**Dependencies / lane notes:** Positional with F09 (both edit credit-notes.service.ts) — F09 lands first per the credit-notes.service.ts lane (F03 -> F09 -> F08).

---

## Proof-tier assignment (frozen at seed — see plan's Phase 2 and `.claude/campaign/status/F08.jsonl`)

| ID   | Tier | Hunt-round SHA | Citation status              |
| ---- | ---- | -------------- | ---------------------------- |
| B20  | T1   | 2d0270fd       | AMBIGUOUS_FILE               |
| B21  | T2   | 2d0270fd       | NO_TOKEN_UNVERIFIED          |
| B53  | T1   | e5b0af8e       | MOVED (disambiguate in-file) |
| B61  | T1   | e5b0af8e       | NO_TOKEN_UNVERIFIED          |
| B68  | T1   | e5b0af8e       | NO_TOKEN_UNVERIFIED          |
| B69  | T1   | e5b0af8e       | NO_TOKEN_UNVERIFIED          |
| B75  | T2   | e5b0af8e       | MOVED (disambiguate in-file) |
| B82  | T1   | e5b0af8e       | MOVED (disambiguate in-file) |
| B128 | T1   | 0b2c3a0a       | TOKEN_NOT_FOUND              |
| B166 | T2   | 0b2c3a0a       | NO_TOKEN_UNVERIFIED          |

> T1 = jest spec (api or mobile pure-logic) · T2 = Playwright e2e, web-visible (proven-pending-deploy through the PR, per the plan) · T3 = recorded manual check (forbidden for Critical/High — none here are). See `.claude/campaign/citation-reanchor-log.md` for any bug ID flagged above whose citation needs a discovery-time check before trusting it verbatim.

---

## Bug details — register triple, evidence and suggested fix, pasted verbatim

### B20 — Return condition notes vanish on save

**Area:** Returns · web + API

**Meant to do:** The per-item "Condition / notes" field operators fill in when creating a return should be saved and shown back on the return's detail page.

**Actually does:** ReturnItem has no condition or notes column; returns.service.ts create() maps only productId/qty/reason/restock into the item write, dropping dto.items[].notes; detail pages render item.condition/item.notes, always blank.

**The gap:** Text typed into a field literally labeled "Condition / notes…" vanishes with no error, and the record permanently looks like nothing was entered.

**Evidence:** apps/api/prisma/schema.prisma:2670-2686 (ReturnItem, no condition/notes col); apps/api/src/returns/returns.service.ts:133-139; apps/web/.../returns/page.tsx:347 (input placeholder) + 174-178 (sent to API); apps/web/.../returns/[id]/page.tsx:631,644-650

**Suggested fix:** Add ReturnItem.condition/notes columns via migration and persist dto.items[].notes/condition in create(); until then remove the input so it doesn't imply capture.

### B21 — Returns can’t be cancelled from any screen

**Area:** Returns · web + mobile

**Meant to do:** An operator or the filing customer should be able to cancel a return before refund, reversing any stock/ledger effects already applied.

**Actually does:** POST /returns/:id/cancel exists with full reversal logic (returns.service.ts cancel()); mobile's useCancelReturn hook is exported but never imported/called anywhere; web has no cancel hook at all.

**The gap:** A fully-built, guarded server capability has zero UI entry point on either client — nobody can actually cancel a return.

**Evidence:** apps/api/src/returns/returns.controller.ts:90-94; apps/api/src/returns/returns.service.ts:381+ (cancel); apps/mobile/lib/api/returns.ts:138 (defined, repo-wide grep finds no other reference); apps/web/lib/api/returns.ts (no cancel mutation present)

**Suggested fix:** Add a Cancel action with confirmation to apps/web/app/(dashboard)/returns/[id]/page.tsx and apps/mobile/app/(operator)/returns/[id].tsx, wired to the existing endpoint/hook.

### B53 — Returns validate, restock and refund against ORDERED quantity, ignoring deliveredQty

**Area:** apps/api/src/returns + routes delivered-basis billing + credit-notes

**Meant to do:** A return can never exceed what was actually delivered and billed; the refund can never exceed what the customer paid; receive() can never restock goods that never shipped.

**Actually does:** create()'s cumulative cap reads `orderedQty = Number(orderLine.qty)` — deliveredQty appears nowhere in the module. Delivery writes deliveredQty without touching OrderItem.qty, and reconcileOrderDraftInvoice bills the delivered basis on the INVOICE only, so the return path still sees the ordered figures. receive() restocks the full returned qty unconditionally, and processRefund computes refund = item.qty * (line.subtotal / line.qty) from the order line, not the invoice.

**The gap:** A short-delivered order can have its full ORDERED quantity returned, restocked and refunded. Worse, processRefund's credit-note cap is keyed on `ret.order.invoices` with no status filter: any order carrying 2+ Invoice rows (of any status, VOID included) passes invoiceId undefined, and credit-notes' entire cap block is gated behind `if (dto.invoiceId)` — so the credit note is minted with no cap at all.

**Evidence:** apps/api/src/returns/returns.service.ts:100-121 (cap vs orderLine.qty), :230-286 (receive restocks full item.qty), :308-339 (refund from order-line subtotal/qty), :316-318 (invoices select, no status filter), :369-376 (invoiceId undefined when invoices.length !== 1); apps/api/src/routes/routes.service.ts:1717-1747 (deliveredQty written, OrderItem.qty untouched); apps/api/src/invoices/invoices.service.ts:1299-1370 (delivered-basis invoice items, OrderItem never mutated), :1477-1504 (split-order siblings, a routine 2+-invoice case); apps/api/src/credit-notes/credit-notes.service.ts:87-138 (whole cap block gated on dto.invoiceId).

**Suggested fix:** Cap return quantity against min(orderLine.qty, orderLine.deliveredQty) in create(); compute refundAmount from the invoice's per-unit price rather than the order line's; in processRefund select only non-VOID invoices and cap against their combined total when several remain, instead of skipping the cap.

### B61 — Driver-filed returns marked Damaged/Expired still restock into sellable inventory

**Area:** apps/mobile driver return screen + apps/api/src/returns

**Meant to do:** The driver picks a return reason at the stop; goods classified damaged/expired/quality-failed do not go back into sellable stock when the office receives the return.

**Actually does:** The driver screen maps rows to {productId, qty, reason} with no `restock` key; the server defaults `restock: i.restock ?? true`; the office's normal "Mark Received" sends a bare id and restocks every item whose flag is true — i.e. all of them.

**The gap:** The reason label never reaches the restock decision. The only escape is an all-or-nothing "Resolve without receiving" that suppresses restock for every line; there is no per-item correction for driver-filed returns on either surface.

**Evidence:** apps/mobile/app/(driver)/route/stop/[stopId]/return/index.tsx:93-99 (items map, no restock); apps/mobile/lib/api/returns.ts:92-99; apps/api/src/returns/returns.service.ts:133-139 (`restock: i.restock ?? true`), :230-286 (receive restocks every flagged item); apps/web/app/(dashboard)/returns/[id]/page.tsx:383-403 vs :405-424 (all-or-nothing); apps/mobile/app/(operator)/returns/new.tsx:183, :266-272 (per-line Restock switch exists for operator-authored returns only).

**Suggested fix:** Apply a reason -> restock policy at the driver screen (DAMAGED/QUALITY_ISSUE/EXCESS default to restock:false), and give the office receive UI a per-item restock toggle seeded from each item's reason.

### B68 — processRefund marks the return REFUNDED before minting the credit note, outside any shared transaction

**Area:** apps/api/src/returns + apps/api/src/credit-notes

**Meant to do:** REFUNDED means the refund exists: the RECEIVED -> REFUNDED flip and the credit-note mint are atomic, or the flip is reversible and the operation retryable.

**Actually does:** processRefund claims the transition with a non-transactional updateMany that also persists refundMethod/refundAmount/refundedAt, then calls creditNotes.create() in its own separate Serializable transaction (its comment: "Sequential, NOT nested"). That create() enforces a cumulative invoice-total cap that throws BadRequestException when exceeded.

**The gap:** Nothing links the claim to the mint. A cap rejection (routinely triggered by B53's ordered-basis refund) or a crash between the two leaves the return permanently REFUNDED with creditNoteId null — processRefund requires RECEIVED so it can't be re-entered, and cancel() refuses REFUNDED, so there is no recovery path.

**Evidence:** apps/api/src/returns/returns.service.ts:308-358 (claim + persist before any mint), :366-378 (create in a separate tx, creditNoteId written only on success), :325-326 (re-refund blocked), :397-399 (cancel blocked); apps/api/src/credit-notes/credit-notes.service.ts:97-138 (Serializable tx, cumulative cap throw at :134-138); returns-refund.spec.ts has no test for a create() failure after a successful claim.

**Suggested fix:** Wrap the RECEIVED -> REFUNDED claim and creditNotes.create in one transaction, or catch a create() failure and revert the return to RECEIVED so processRefund stays retryable.

### B69 — Return cancel() races receive() — compensation decided from a stale pre-transaction status

**Area:** apps/api/src/returns + inventory + regulated ledger

**Meant to do:** A cancelled return is fully compensated: if goods were already received (restocked, ledger reversed) by the time cancel() commits, cancel() undoes exactly those effects.

**Actually does:** cancel() reads the return with a plain findUnique OUTSIDE any transaction. Inside the transaction it atomically claims -> CANCELLED for any status not in [CANCELLED, REFUNDED] (so a concurrently-set RECEIVED still matches), but the undo branch tests the STALE status captured before the transaction opened.

**The gap:** If receive() commits between cancel()'s pre-tx read (still APPROVED) and its claim, the claim wins but the undo is skipped on the stale snapshot — the return ends CANCELLED while receive()'s inflated stock, StockMovement row and reversed regulated ledger stand uncompensated.

**Evidence:** apps/api/src/returns/returns.service.ts:381-385 (findUnique outside the tx), :406-412 (claim WHERE notIn [CANCELLED, REFUNDED]), :414-431 (undo gated on the closed-over stale status), :230-306 (receive(): own atomic claim, restock + StockMovement at :268-283, ledger reversal at :297-299, commits independently); apps/api/prisma/schema.prisma:287-296.

**Suggested fix:** Re-read the return's status inside cancel()'s transaction after the claim (or fold the compensation decision into the claim itself via an UPDATE ... RETURNING pre-image) and base the restock/ledger undo on that fresh value.

### B75 — Returns dashboard "Total Return Value" and per-row Value are always $0.00

**Area:** apps/web/app/(dashboard)/returns/page.tsx

**Meant to do:** The Returns dashboard KPI and each row's Value column show the dollar value of the returned goods.

**Actually does:** Both sum `(item.unitPrice ?? 0) * item.qty`, but ReturnItem has no price column and returns findAll()'s include never selects or derives one — unitPrice is always undefined and the `?? 0` fallback always fires. The server's real refundEstimate figure is computed only on the single-return detail/refund path and is never populated on the list endpoint.

**The gap:** Unconditionally $0.00 for every tenant with returns — a headline finance number that is always wrong.

**Evidence:** apps/api/prisma/schema.prisma:2670-2686 (no price field on ReturnItem); apps/api/src/returns/returns.service.ts:189-200 (findAll include, no price) vs :490-500 (refundEstimate computed elsewhere); apps/web/app/(dashboard)/returns/page.tsx:414-416, :469-471 (KPI), :626, :647-649 (row); apps/web/lib/api/returns.ts:23-33, :58-69.

**Suggested fix:** Have findAll join the originating order-line price and expose it as unitPrice, or return a server-computed per-return value on the list endpoint and sum that.

### B82 — Cancelled returns permanently consume the order's returnable quota

**Area:** apps/api/src/returns/returns.service.ts — create()

**Meant to do:** Only returns whose stock/ledger effects are still in force count against a product's per-order returnable quota — REJECTED returns are already excluded for exactly that reason.

**Actually does:** The cumulative-quota query filters `status: { not: 'REJECTED' }`, which includes CANCELLED, and sums those quantities into alreadyReturned before validating a new return.

**The gap:** cancel() fully reverses a return's stock decrement and ledger entries, making the goods legitimately re-returnable, but the CANCELLED row keeps consuming the quota — and there is no way to clear it: no delete-return endpoint exists, and deleteOrder itself refuses while any return (CANCELLED included) is attached, telling the caller to "delete those returns first".

**Evidence:** apps/api/src/returns/returns.service.ts:87-90 (quota query includes CANCELLED), :93-121 (quota math), :401-433 (cancel() reverses stock, deletes the StockMovement and un-reverses the ledger); returns.controller.ts has no @Delete route; apps/api/src/orders/orders.service.ts:4720-4726 (deleteOrder's unfiltered returnCount throw).

**Suggested fix:** Change the filter to `status: { notIn: ['REJECTED', 'CANCELLED'] }` so a fully-reversed return releases its quota, matching how REJECTED is already treated.

### B128 — Driver return files the DELIVERED quantity: refused deliveries 400, short deliveries credit goods the customer kept

**Area:** Driver returns · mobile driver + API returns

**Meant to do:** When a delivery is refused or short, the driver's Return screen files a return for the quantity NOT delivered, so those goods restock and the customer is credited for what they did not receive.

**Actually does:** Both the rendered rows and the POST body take qty straight from DeliveryMutation.quantityDelivered — the delivered side. REFUSED mutations carry 0, so the server rejects the submit outright; PARTIAL mutations carry the delivered amount, so the return covers exactly the goods the customer kept and was billed for.

**The gap:** The return quantity is read from the wrong side of the delivered/undelivered split: refusals can never be filed at all, and short deliveries generate a credit for goods that were handed over.

**Evidence:** apps/mobile/app/(driver)/route/stop/[stopId]/return/index.tsx:41-53 (returnRowsFromStop: qty = m.quantityDelivered, amount = price × quantityDelivered), :93-99 (issue() items[].qty = Math.round(m.quantityDelivered)), :210-223 (credit-note card built from the same amounts); apps/mobile/lib/short-pick.ts:22-27, :51-67 (REFUSED ⟺ clamped ≤ 0, so quantityDelivered is 0; PARTIAL carries the delivered amount); apps/api/src/routes/routes.service.ts:1913-1926 (mutation stores quantityDelivered; deliveredQty = 0 for REFUSED), :2289-2294 (COGS treats it as delivered); apps/api/src/returns/returns.service.ts:101-103 (400 on qty ≤ 0), :105-115 (only a cumulative ordered-qty ceiling, so 6-of-10 passes), :125-145 (Return + ReturnItem created, restock defaults true); reachable from apps/mobile/app/(driver)/route/stop/[stopId]/index.tsx:345-348.

**Suggested fix:** Compute the return quantity as orderedQty − quantityDelivered (ordered qty from the matched line item) for the rendered rows, the credit preview and the issue() payload, and guard against zero after that subtraction rather than shipping a quantity the server must reject.

### B166 — The Returns search box is fully inert — the endpoint never binds or uses a search param

**Area:** Returns list · web

**Meant to do:** Typing a return number, order number or customer name narrows the returns list, per the input's own placeholder and the debounced refetch it fires.

**Actually does:** The web hook sends search on every keystroke, but the returns controller binds only orderId, customerId, status, reason, page and limit, and neither service signature has a search parameter or builds one into its where clause.

**The gap:** A visible, debounced, URL-synced search control that cannot change a single row of the result.

**Evidence:** apps/web/app/(dashboard)/returns/page.tsx:395-401 (search passed), :534-536 (the placeholder), :419 (rows rendered straight from the response, with no client-side fallback filter either); apps/web/lib/api/returns.ts:79-89 (params forwarded verbatim); apps/api/src/returns/returns.controller.ts:30-49 (no @Query("search")); apps/api/src/returns/returns.service.ts:157-204 (no search in either signature or the where clause).

**Suggested fix:** Add @Query("search") to the returns controller, thread it through both service methods, and build an insensitive-contains OR over returnNumber, order.orderNumber and customer.businessName.

---

## Discovery instructions (per the campaign plan)

Discovery's job is to confirm these lines still say what the register says they say on
current master, and find what the register missed — **never a broad repo sweep**. Where the
citation table above flags a bug ID, search within the files that ID's evidence already
names; do not expand beyond them without a specific reason. Classify every bug ID as
`CONFIRMED on master@<sha>`, `ALREADY FIXED (evidence)`, or `EVIDENCE MOVED (new path:line)`
before writing any code. An already-fixed ID is flipped in the register with its evidence —
never silently carried, never silently dropped.
