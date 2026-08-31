# F07 · Order lifecycle, stock conservation and teardown

**Bug IDs (7):** B10, B56, B64, B65, B105, B108, B116

**Root cause:** changeStatus/deleteOrder do not conserve what they touch — cancelling voids the invoice for already-delivered goods (B56), never returns the creation-time stock decrement (B64), and deleting skips the regulated-ledger reversal both sibling paths perform (B65). Auto-invoice is fire-and-forget (B105) and the credit settle is swallowed (B108).

**Ships as:** One PR.

**Files:** orders.service.ts changeStatus / deleteOrder · invoices.service.ts (voidInvoiceInTx) · regulated-ledger.service.ts

**Together because:** The status machine and its teardown; conserving stock, invoices and the ledger are one invariant. Serialized after F06 (same file).

**Guardrails / shared infra:** None new. Belongs to BOTH the orders.service.ts lane AND the invoices.service.ts lane (B105/B108 call into invoices; B56 uses voidInvoiceInTx) — easy to miss since it reads as an orders-only batch by name.

**Dependencies / lane notes:** Requires F03 (semantic, recomputeStatus/confirmed-payment predicate) and F06 (positional, same file). Must land before F11, F22+F24 (semantic — the status machine must be conserving before anything else reads it).

---

## Proof-tier assignment (frozen at seed — see plan's Phase 2 and `.claude/campaign/status/F07.jsonl`)

| ID   | Tier | Hunt-round SHA | Citation status              |
| ---- | ---- | -------------- | ---------------------------- |
| B10  | T2   | 2d0270fd       | n/a                          |
| B56  | T1   | e5b0af8e       | MOVED (disambiguate in-file) |
| B64  | T1   | e5b0af8e       | NO_TOKEN_UNVERIFIED          |
| B65  | T1   | e5b0af8e       | NO_TOKEN_UNVERIFIED          |
| B105 | T1   | 0cd59277       | MOVED (disambiguate in-file) |
| B108 | T1   | 0cd59277       | NO_TOKEN_UNVERIFIED          |
| B116 | T1   | 0cd59277       | TOKEN_NOT_FOUND              |

> T1 = jest spec (api or mobile pure-logic) · T2 = Playwright e2e, web-visible (proven-pending-deploy through the PR, per the plan) · T3 = recorded manual check (forbidden for Critical/High — none here are). See `.claude/campaign/citation-reanchor-log.md` for any bug ID flagged above whose citation needs a discovery-time check before trusting it verbatim.

---

## Bug details — register triple, evidence and suggested fix, pasted verbatim

### B10 — “Editing closed” banner can never appear

**Area:** Orders · web

**Meant to do:** When an order can no longer be edited because it's out for delivery/dispatched, the order-detail page should show an explanatory banner telling the operator why editing is closed.

**Actually does:** orders.service.ts's computeEditWindow now only sets closedReason to null (editable) or "STATUS" (editable ⟺ status !== CANCELLED; per its own comment, dispatch no longer closes the window). The web page's only reference to closedReason checks === "DISPATCHED", which the API can never emit.

**The gap:** The banner branch is dead code — it can never render under current API behavior; more broadly, closedReason is checked nowhere else, so no banner/explanation appears at all when canEdit is false (e.g., a CANCELLED order), the Edit Items button just silently disappears.

**Evidence:** apps/api/src/orders/orders.service.ts lines 447-458 (computeEditWindow: closedReason ∈ {null, "STATUS"}); apps/web/app/(dashboard)/orders/[id]/page.tsx line 2217 (`order?.editWindow?.closedReason === "DISPATCHED"`) — the only occurrence of `closedReason` in the file

**Suggested fix:** Change the web check to closedReason === "STATUS" (or drop the DISPATCHED-specific string) and update the copy to describe the CANCELLED case; also delete the stale comment on line 2216 claiming dispatch closes editing, which contradicts the P5-08 comment at lines 1695-1697 in the same file.

### B56 — Cancelling a PARTIALLY_DELIVERED order voids the invoice for goods already delivered

**Area:** apps/api/src/orders (changeStatus) + apps/api/src/invoices (voidInvoiceInTx)

**Meant to do:** Cancelling an order should never make already-delivered, already-earned revenue vanish — an invoice for goods that left the warehouse shouldn't be voidable without a trace.

**Actually does:** PARTIALLY_DELIVERED -> CANCELLED is a legal transition, and the cancel branch blanket-voids every non-VOID invoice on the order. The only gate (cancelImpact/assertCancellableOrThrow) blocks solely on external non-wallet payments already recorded — it never reads deliveredQty.

**The gap:** An order with deliveredQty > 0 and an unpaid delivery invoice (bill-on-account, or a stop completed without collecting) can be cancelled from the UI — single or bulk, straight from the PARTIALLY_DELIVERED filter — voiding the invoice for goods the customer already has, leaving no residual billable record. The codebase's own settleStockForEdit already refuses to treat delivered stock as returnable, so the signal exists and is simply not consulted here.

**Evidence:** apps/api/src/orders/orders.service.ts:2172-2182 (transition matrix), :2308-2332 (cancel branch, blanket void, no deliveredQty read), :2419-2487 (cancelImpact/assertCancellableOrThrow — external payments only), :3732-3760 (settleStockForEdit, the deliveredQty-aware precedent); apps/web/app/(dashboard)/orders/page.tsx:59 (PARTIALLY_DELIVERED filter), :233-239 (handleBulkCancel, no client-side status gate).

**Suggested fix:** Block — or require an explicit reason/override on — DELIVERED/PARTIALLY_DELIVERED -> CANCELLED whenever any active line has deliveredQty > 0, mirroring the rule settleStockForEdit already enforces.

### B64 — Cancelling an order never returns its creation-time stock decrement

**Area:** apps/api/src/orders/orders.service.ts — changeStatus CANCELLED branch

**Meant to do:** Cancelling credits back the creation-time stock decrement for undelivered goods, symmetric with editing an order's lines down to zero.

**Actually does:** The CANCELLED branch releases wallet credits and voids invoices inside a tenantTransaction and never touches Product.currentStock — nor does it flip surviving OrderItem rows to CANCELLED. reopenOrder reverts item status but never re-decrements, so the original decrement is never returned even across a cancel + reopen cycle.

**The gap:** currentStock is permanently understated after every cancel; only the edit-to-zero path (settleStockForEdit) credits stock back, clamped to the undelivered remainder.

**Evidence:** apps/api/src/orders/orders.service.ts:2308-2332 (CANCELLED branch: releaseOrderCreditsInTx + releaseWalletPaymentsInTx + voidInvoiceInTx only), :1850-1902 (creation decrement under FOR UPDATE), :3666-3900 (settleStockForEdit, the clamped credit-back precedent), :2489-2531 (reopenOrder never re-decrements); apps/api/src/invoices/invoices.service.ts has zero currentStock references, confirming the void path isn't doing it silently.

**Suggested fix:** Call settleStockForEdit (or equivalent) with an empty final item set from the CANCELLED branch so each line's stock is credited back clamped to (qty - deliveredQty), and flip surviving OrderItem rows to CANCELLED in the same transaction.

### B65 — Deleting an order skips the regulated-ledger reversal that every other invoice-destruction path performs

**Area:** apps/api/src/orders + regulated ledger

**Meant to do:** Every regulated SALE ledger row corresponds to a live invoice; any path that destroys an invoice reverses its ledger entries first, because the ledger is append-only with no FK.

**Actually does:** deleteOrder hard-deletes each linked invoice inline (invoicePayment.deleteMany, invoiceItem.deleteMany, invoice.delete) with no ledger call anywhere — RegulatedLedgerService isn't even imported into OrdersService, unlike invoices.service.ts's voidInvoiceInTx and deleteInvoice, which both call reverseInvoiceEntries.

**The gap:** deleteOrder is a third, unguarded invoice-destruction path that skips the reversal its two siblings perform, permanently overstating regulated sales and excise once the source invoice is gone.

**Evidence:** apps/api/src/orders/orders.service.ts:4697-4774 (deleteOrder; inline invoice teardown at :4749-4762, no ledger reference in the file); apps/api/src/invoices/invoices.service.ts:3762-3773 (voidInvoiceInTx -> reverseInvoiceEntries at :3768), :4755-4794 (deleteInvoice -> reverseInvoiceEntries at :4777, with the comment explaining why it must precede the delete); apps/api/src/regulated/regulated-ledger.service.ts.

**Suggested fix:** Route deleteOrder's per-invoice teardown through invoicesService.deleteInvoice, or call ledger.reverseInvoiceEntries for each invoice before the rows are removed.

### B105 — Auto-invoice on Mark delivered is fire-and-forget — failure leaves a delivered, never-billed order

**Area:** Orders → invoicing · API

**Meant to do:** Marking a draft-less order (buyer-portal, standing, imported) DELIVERED should produce its invoice, or tell the operator to retry — the thrown message itself says "please retry".

**Actually does:** createInvoiceFromOrderWithTenant runs unawaited; any throw (including the code's own ConflictException on P2002) lands in a .catch that only logs. The API returns 200 and the operator sees a success toast.

**The gap:** A delivered order silently never reaches AR: no retry, no queue, no flag, no sweep for delivered-uninvoiced orders — only a server log line.

**Evidence:** apps/api/src/orders/orders.service.ts:2280-2290 (missing await, log-only .catch at :2285-2289); apps/api/src/invoices/invoices.service.ts:1248-1256 (P2002 → ConflictException wrapper on createSplitInvoices), :2305 (createInvoiceFromOrderWithTenant), :2723-2733 (generateInvoiceNumber = read-max-then-add-one, no lock — concurrent same-tenant creates genuinely collide), :527-531 (same P2002 path in create(), comment "RF-050: duplicate invoiceNumber under concurrent requests" confirms it happens); apps/api/prisma/schema.prisma:1896 @@unique([tenantId, invoiceNumber]); grep confirms no compensating delivered-but-uninvoiced reconcile job exists.

**Suggested fix:** Await the creation inside the request (or move it to a persistent retry queue); on failure either roll back the toast with an actionable error or flag the order as invoice-pending so a sweep/operator can retry.

### B108 — Delivery credit-note settle swallowed on tx failure; the documented send() fallback excludes exactly those credits

**Area:** Credit notes · API delivery flow

**Meant to do:** A credit note the operator attached to an order with an explicit amount is applied to the order's invoice at delivery, so the customer owes only the post-credit balance.

**Actually does:** If the Serializable settle transaction fails (40001/deadlock/timeout), delivery succeeds with only a warn; send() and sendEmail() both exclude explicit-amount credit ids from auto-apply, so nothing ever applies the credit.

**The gap:** The catch's justification comment is false: the claimed catch-up path deliberately excludes every credit the swallowed settle was responsible for.

**Evidence:** apps/api/src/orders/orders.service.ts:2296-2307 (swallow + false comment); apps/api/src/invoices/invoices.service.ts:3384-3394 and 3558-3559 (explicitIds excluded in send and sendEmail); apps/api/src/credit-notes/credit-notes.service.ts:465,492 (notIn filter), 914-1000 (explicit-intent apply pass); only other settle callers: invoices.service.ts:1244, orders.service.ts:2017, 3563 — none re-run for a delivered drafted order.

**Suggested fix:** On settle failure, retry with backoff or enqueue a reconcile job instead of warn-and-drop; alternatively stop excluding an explicit intent from send()'s auto-apply when it has no matching CREDIT_NOTE payment yet (the settle clamp already makes re-application safe).

### B116 — Order create decrements stock row-by-row inside one 5s-capped transaction

**Area:** Orders · API

**Meant to do:** A large multi-SKU order should be created and its stock decremented the same as a small one, regardless of line count.

**Actually does:** One tenantTransaction (no timeout/maxWait options) row-locks all products, then awaits one tx.product.update per line sequentially; Prisma 7's default 5s interactive-transaction ceiling governs, and only P2002 is retried — a timeout fails the order outright.

**The gap:** Large orders (or lock contention, which also consumes the 5s budget) hit the default timeout, roll back, and are not retried.

**Evidence:** apps/api/src/orders/orders.service.ts:1846-1902 (loop + sequential per-line update 1897-1902, tenantTransaction with no options at 1850), :1961 (P2002-only retry); apps/api/src/prisma/prisma.service.ts:10-12 (no transactionOptions in constructor), :36-51 (options forwarded verbatim to $transaction); apps/api/package.json:49 (@prisma/client ^7.10.0, default timeout 5000ms/maxWait 2000ms).

**Suggested fix:** Pass an explicit { timeout, maxWait } to tenantTransaction sized for the largest realistic order, and replace the per-line loop with a single set-based raw UPDATE joining a VALUES list of (productId, qty).

---

## Discovery instructions (per the campaign plan)

Discovery's job is to confirm these lines still say what the register says they say on
current master, and find what the register missed — **never a broad repo sweep**. Where the
citation table above flags a bug ID, search within the files that ID's evidence already
names; do not expand beyond them without a specific reason. Classify every bug ID as
`CONFIRMED on master@<sha>`, `ALREADY FIXED (evidence)`, or `EVIDENCE MOVED (new path:line)`
before writing any code. An already-fixed ID is flipped in the register with its evidence —
never silently carried, never silently dropped.
