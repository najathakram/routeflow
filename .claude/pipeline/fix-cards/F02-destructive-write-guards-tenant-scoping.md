# F02 · Destructive-write guards and tenant scoping

**Bug IDs (8):** B24, B96, B101, B126, B127, B130, B154, B188 _(B188 added post-kickoff 2026-08-31 — see its section below)_

**Root cause:** Destructive paths that skipped the guard their own siblings carry, on a Prisma client with no tenant injection and no RLS behind it. B126 is ten unscoped deleteMany({}) calls that empty every tenant's finances from any operator token.

**Ships as:** TWO PRs under one card. F02a — ✅ **SHIPPED pre-campaign as PR #506** (master `cc8c7d46`, deployed, post-deploy-check 9/9): B126 and B127 are `already-fixed` in the ledger; the run's pipeline artifacts are tracked at `.claude/pipeline/2026-08-30-destructive-endpoint-guards/` (PR #509). **F02b is the only remaining work:** B24, B96, B101, B130, B154, B188. Its discovery must read #506's diff first — the guards it added (typed confirmation DTO, PAID/SENT pre-flight, null-tenant ForbiddenException) are the sibling patterns F02b's fixes should reuse.

**Files:** system-config/settings.controller.ts · customers.service.ts (deleteAll, batchDelete, merge) · products.service.ts (bulkDelete) · routes.service.ts (deleteRoute) · web products and customers list pages · prisma/prisma.service.ts · prisma/rls.sql · bookkeeping/invoice.service.ts + invoice.processor.ts (B188)

**Together because:** One missing pattern — tenant-scoped client, status pre-flight, role escalation, typed confirmation — and B154 is what decides which rows B24 destroys.

**Guardrails / shared infra:** Also delivers G1 (extend the signature scanner) and G8 (tenant-isolation backstops / RLS under migration control — see the plan's G8 section for the critical caveat that RLS does NOT close B126 by itself; B126's real fix is routing settings.controller.ts's raw $transaction through tenantTransaction).

**Dependencies / lane notes:** Must land before F15, F16 (positional — same customers.service.ts delete paths). No semantic predecessor. ⚠️ An unmerged sibling hotfix exists on branch `claude/relaxed-hodgkin-e12254` (worktree `hungry-colden-9a670b`, commit `27795982`): "delete order-credit-note links before credit notes in customer purges" — a follow-up to #506's deleteAll touching `customers.service.ts` (+35) with specs (+88). F02b's Phase-0 must check whether it has merged: if yes, rebase over it and reuse its pattern; if still unmerged, coordinate with its session (or absorb the commit) rather than re-deriving the same fix and colliding in the lane.

---

## Proof-tier assignment (frozen at seed — see plan's Phase 2 and `.claude/campaign/status/F02.jsonl`)

| ID   | Tier | Hunt-round SHA | Citation status                                                | Ledger state                                     |
| ---- | ---- | -------------- | -------------------------------------------------------------- | ------------------------------------------------ |
| B24  | T2   | 2d0270fd       | NO_TOKEN_UNVERIFIED                                            | queued                                           |
| B96  | T1   | 0cd59277       | NO_TOKEN_UNVERIFIED                                            | queued                                           |
| B101 | T1   | 0cd59277       | OUT_OF_BOUNDS                                                  | queued                                           |
| B126 | T1   | 0b2c3a0a       | MOVED (corrected)                                              | **already-fixed — PR #506, deployed + verified** |
| B127 | T1   | 0b2c3a0a       | NO_TOKEN_UNVERIFIED                                            | **already-fixed — PR #506, deployed + verified** |
| B130 | T2   | 0b2c3a0a       | NO_TOKEN_UNVERIFIED                                            | queued                                           |
| B154 | T2   | 0b2c3a0a       | AMBIGUOUS_FILE                                                 | queued                                           |
| B188 | T1   | 77b88623       | FRESH — verified on current master 2026-08-31, citations exact | queued _(added post-kickoff)_                    |

> T1 = jest spec (api or mobile pure-logic) · T2 = Playwright e2e, web-visible (proven-pending-deploy through the PR, per the plan) · T3 = recorded manual check (forbidden for Critical/High — none here are). See `.claude/campaign/citation-reanchor-log.md` for any bug ID flagged above whose citation needs a discovery-time check before trusting it verbatim.

---

## Bug details — register triple, evidence and suggested fix, pasted verbatim

### B24 — Bulk product delete erases history without a guard

**Area:** Products · web

**Meant to do:** Deleting a product (single or bulk) should not silently destroy financial/inventory history for a product still referenced by orders, invoices, or bills.

**Actually does:** Web bulk delete hard-deletes and cascades through orderItem, invoiceItem, stockMovement, purchaseOrderItem, vendorBillItem etc. with zero active-order-items guard. The guarded single delete exists (blocks when active order items exist) but is dead code on web; it IS wired to a working, reachable 'Delete product?' flow on mobile.

**The gap:** Bulk delete on web permanently destroys order/invoice/stock-movement history with no safety check at all; web itself has no UI path to the safer guarded delete.

**Evidence:** apps/api/src/products/products.service.ts:1103-1112 (remove(), guarded) vs :1134-1156 (bulkDelete(), unguarded cascade incl. orderItem L1150, invoiceItem L1147, stockMovement L1152, vendorBillItem L1143); apps/web/app/(dashboard)/products/page.tsx:1076-1088,1357-1364 (bulk delete wired, no confirm modal); apps/web/app/(dashboard)/products/[id]/page.tsx:316 (useDeleteProduct declared, never called — grep for 'deleteProduct.' in file returns nothing); CORRECTION: apps/mobile/app/(operator)/products/[id].tsx:69,169-184,475 wires the same guarded endpoint to a live Delete button, reachable from apps/mobile/app/(operator)/products/index.tsx:283.

**Suggested fix:** Apply the same active-order-items guard to bulkDelete (or check/soft-delete instead of a hard cascading delete), and add a working, confirmed Delete action to the web product detail page using the existing (currently dead) useDeleteProduct hook.

### B96 — Deleting a SCHEDULED route hard-deletes all completed runs — POD, signatures, and regulated identity records destroyed

**Area:** Routes · API + web

**Meant to do:** Deleting a route removes the route definition and future scheduling; historical delivery evidence (POD photos, signatures, regulated age/identity verifications) survives — exactly the rationale the code's own ADHOC guard states.

**Actually does:** The delivered-run guard is gated on route.kind === ADHOC only. For SCHEDULED routes, deleteRoute unlinks orders, then deleteMany's every RouteRunStop and RouteRun — the only rows carrying podPhotoUrls, signatureUrl, ageVerified/identityVerified/identityVerifiedAt.

**The gap:** Guard rationale applies identically to scheduled routes but explicitly exempts them; any OPERATOR, and the web bulk-delete, can erase months of compliance evidence in one action.

**Evidence:** apps/api/src/routes/routes.service.ts:519-574 (guard at 536-543 with comment 'SCHEDULED routes are untouched by this guard'; routeRunStop.deleteMany at 560, routeRun.deleteMany at 564); apps/api/src/routes/routes.controller.ts:124-128 (@Delete(':id'), @Roles(OPERATOR)); apps/api/prisma/schema.prisma:1235-1249 (podPhotoUrls/signatureUrl/ageVerified/identityVerified/identityVerifiedAt live only on RouteRunStop — grep for 'pod' across schema returns only line 1235); apps/web/app/(dashboard)/routes/page.tsx:290 (bulk Promise.all deleteRoute).

**Suggested fix:** Extend the delivered-run refusal to SCHEDULED routes (any IN_PROGRESS/COMPLETED run blocks hard delete) and offer soft-delete/archive of the route definition instead, keeping RouteRun/RouteRunStop history intact.

### B101 — Customer merge trips RESTRICT FKs (500 + rollback) or cascade-destroys payment requests, documents, and POD history

**Area:** Customers · API

**Meant to do:** Merging duplicate customers moves all of the secondary's records to the primary, then removes the empty shell; a merge completes cleanly or explains what blocks it.

**Actually does:** mergeCustomers never clears CustomerLink/AgentAssignment/CommissionAccrual/CustomerCommissionRate (RESTRICT → P2003 → unhandled 500, full rollback) and never re-points BuyerPaymentRequest/CustomerDocument (CASCADE → silently erased); line 1642 hard-deletes the secondary's RouteRunStops despite SET NULL.

**The gap:** Merge 500s for portal-linked or commissioned customers; when it succeeds it destroys payment-request audit trail, uploaded documents, and delivery/POD rows that could have survived.

**Evidence:** apps/api/src/customers/customers.service.ts:1578-1707 (read in full: routeRunStop.deleteMany at 1642, customer.delete at 1692, no try/catch, no customerLink/agentAssignment/commissionAccrual/customerCommissionRate handling), :2230 (bulk-delete path DOES clear customerLink first), :2272 (customerLink.upsert on portal invite); customers.controller.ts:95-98 (POST /customers/merge, OPERATOR). FK actions verified in migrations (no later ALTERs found): 0_init/migration.sql:3939 CustomerLink RESTRICT, :3402 CustomerDocument CASCADE, :3495 RouteRunStop.customerId SET NULL; 20260823000000:78 BuyerPaymentRequest CASCADE; 20260901000000:277/286/301 CustomerCommissionRate/AgentAssignment/CommissionAccrual RESTRICT.

**Suggested fix:** In mergeCustomers: delete-or-repoint CustomerLink (keep primary's if both exist), re-point AgentAssignment/CommissionAccrual/CustomerCommissionRate, BuyerPaymentRequest and CustomerDocument to the primary, and re-point (not delete) RouteRunStops. Catch P2003 and return an actionable 409 naming the blocking relation.

### B126 — DELETE /settings/financial-data runs an unscoped deleteMany — it empties every tenant's finances

**Area:** Settings · API (system-config)

**Meant to do:** A tenant clearing its bookkeeping data for a fresh start removes only its own invoices, payments, credit notes, vendor bills and purchase orders — and a destructive action is gated at least as tightly as a display preference.

**Actually does:** One unscoped transaction empties invoicePayment, invoiceItem, invoice, creditNote, billPayment, vendorBillItem, vendorBill, purchaseOrderItem, purchaseOrder and payment for the whole database, and it is callable by any OPERATOR token in any tenant. The same token is refused PATCH /settings/margin.

**The gap:** Ten deletes run with an empty where clause on a Prisma client that has no tenant injection and no RLS behind it, so "clear my finances" means everyone's finances.

**Evidence:** apps/api/src/system-config/settings.controller.ts:29-32 (class guards + @Roles(OPERATOR)), :359-383 (clearFinancialData — $transaction with ten deleteMany({}) at 363,365,367,369,371,373,375,377,379,381), :186-189 [re-anchored: settings.controller.ts now ~L185 on master@6c8f1401; was :186-189 at hunt round master@0b2c3a0a] (contrast: a hand-passed tenantId on a raw updateMany, proving the injected client is unscoped), :496-498/:520-521/:537-538 (siblings gated @Roles(TENANT_ADMIN)); apps/api/src/prisma/prisma.service.ts:31-50 and :56-138 (tenant injection exists only inside tenantTransaction), :215-221 (forTenant); apps/api/src/prisma/prisma.module.ts (plain provider, no $extends); apps/api/prisma/migrations — 21 dirs, zero hits for row level security / current_setting; apps/api/src/auth/guards/roles.guard.ts:20-23.

**Suggested fix:** Route the whole block through prisma.tenantTransaction (its proxy injects tenantId into every deleteMany) or add an explicit where: { tenantId } to all ten calls, and raise the handler to @Roles(TENANT_ADMIN) behind a typed confirmation.

### B127 — DELETE /customers/all destroys PAID invoices and payments that both sibling delete paths refuse to touch

**Area:** Customers · API (bulk delete)

**Meant to do:** Deleting customers never destroys settled financial history: a customer holding orders, invoices or returns is soft-deleted and the money records survive with their FK intact — which is exactly what the single-delete and batch-delete paths enforce.

**Actually does:** deleteAllCustomers hard-deletes every customer plus their invoice payments, invoice items, invoices, credit notes, returns, orders, transactions, payments and advance payments, with no status check, no soft-delete fallback, no force flag and no confirmation.

**The gap:** The two guards that exist — the financial-records check and the PAID/SENT pre-flight — were added to the single and batch paths and never to their delete-all sibling.

**Evidence:** apps/api/src/customers/customers.controller.ts:131-135 (@Delete("all") @Roles(OPERATOR)), :137-142 (batch-delete, same role), :397-400 (single delete, force param); apps/api/src/customers/customers.service.ts:1761-1793 (deleteCustomer — order/invoice/return counts, ConflictException, soft-delete branch), :1926-1944 (batchDelete's PAID/SENT groupBy blocker plus the in-code comment about not letting bulk deletion destroy PAID invoices), :1958-2070 (deleteAllCustomers — zero status checks: invoicePayment 1974, invoiceItem 1975, invoice 1978, creditNote 1980, payment 2004, transaction 2006/2046, advancePayment 2047, customer 2062, user 2063); apps/web/lib/api/customers.ts:476-480 (useDeleteAllCustomers defined; no component in web or mobile calls it).

**Suggested fix:** Give deleteAllCustomers the same PAID/SENT pre-flight batchDelete uses — or route it through deleteCustomer per id so the financial-records guard and soft-delete fallback apply — and require a typed confirmation before it runs.

### B130 — Customer "Delete" soft-deletes with an Undo on the detail page but hard-deletes with a full cascade from the list

**Area:** Customers · web dashboard

**Meant to do:** Deleting a customer means the same thing on both screens, and prefers the safe mode the API's own error message recommends — force=true, a soft delete that preserves all records.

**Actually does:** The detail page sends force=true behind a confirm and an 8-second Undo. The list's "Delete N" calls batchDelete, which loops deleteCustomer without force — a cascading hard delete — with no dialog and no inverse.

**The gap:** One click from a list permanently destroys advance payments, negotiated prices, addresses, contacts, standing orders and the login row, with no confirmation and no way back.

**Evidence:** apps/web/app/(dashboard)/customers/[id]/page.tsx:1976-1995 (soft delete + restore via runUndoable); apps/web/lib/api/customers.ts:392-404 (force="true"), :463-475 (batch-delete); apps/api/src/customers/customers.service.ts:1776-1783 (Conflict unless force), :1785-1793 (soft branch), :1795-1913 (hard cascade — advancePayment 1895, customerPrice 1896, customerAddress 1897, contactPerson 1900, tags 1901, comments 1902, orderTemplate+items 1867-1876, recurringInvoice+items 1855-1864, estimate+items 1843-1852, route rows 1879-1881, customer+user 1908-1909), :1926-1957 (batchDelete calls deleteCustomer(id) at :1950 with no force); apps/web/app/(dashboard)/customers/page.tsx:336-357 (handleBulkDelete, bare catch swallowing the 409 detail at :352-354), :699-706 ("Delete {selected.size}" wired straight in, no ConfirmDialog).

**Suggested fix:** Make batchDelete pass force=true (or apply the detail page's guard), add a ConfirmDialog naming the customers, and surface the 409's per-customer breakdown instead of a generic toast.

### B154 — Products selection accumulates invisibly across pages and filters, and its own buttons target different sets

**Area:** Products · web dashboard

**Meant to do:** A bar reading "40 items selected" means the same forty items for every button on it, and a bulk write either covers all of them or reports what it skipped.

**Actually does:** toggleAll concatenates the current page onto the existing set and nothing resets it on page, search or category change. Assign-to-type then receives only the visible subset and clears the entire selection on success, while delete takes the full hidden set.

**The gap:** Two buttons on one bar silently mean different item sets, and off-page products are dropped from a write with no message.

**Evidence:** apps/web/app/(dashboard)/products/page.tsx:736 (selected state), :741, :1027-1029, :1053-1056 (the filtered list is one page), :1065-1074 (toggleAll concatenates), :1076-1088 (bulk delete uses the full set), :1327-1332 and :1367-1373 (the bar prints selected.size), :1370-1382, :1386-1396 (AssignToSectionModal receives only the visible intersection and clears everything on success), :1480-1543; apps/web/components/AssignToSectionModal.tsx:17, :70-72, :107; verified no reset — the only setSelected(new Set()) calls are the Select toggle, Deselect all and the two modal success handlers. The same accumulate-and-never-reset shape exists at customers/page.tsx:324-334 and orders/page.tsx:216-229.

**Suggested fix:** Reset selected whenever page, search, category or section changes (or scope it per page), pass the full selection to AssignToSectionModal, and report processed-versus-skipped the way vendor-bills already does.

### B188 — Invoice PDF generation reads and overwrites transactions with no tenant scoping (added post-kickoff 2026-08-31)

**Area:** Bookkeeping · API (queue processor)

**Meant to do:** Generating an invoice PDF for a transaction renders the calling tenant's own invoice, uploads it, and records the object key on that tenant's transaction — with the same tenant scoping its sibling getPresignedUrl gained in the F1-002 security fix.

**Actually does:** generateInvoicePdf fetches the transaction with a bare findUnique (full customer, order, items and payments), renders and uploads the PDF, returns a working presigned URL for it, and persists pdfUrl with a bare update — no step checks tenantId. Handed any other tenant's transactionId, it exfiltrates that tenant's complete invoice as a 15-minute presigned URL and overwrites that tenant's Transaction.pdfUrl.

**The gap:** The F1-002 fix hardened the read path (getPresignedUrl, ten lines below) but never touched the generate path — and because the method runs in a Bull processor with no request context, the job payload carries only transactionId, so there is nothing to scope by even where forTenant() would otherwise apply.

**Evidence:** apps/api/src/bookkeeping/invoice.service.ts:37-53 (bare this.prisma.transaction.findUnique with full include), :86-89 (bare transaction.update writing pdfUrl), :91 (returns the presigned URL); contrast :96-110 (getPresignedUrl via forTenant(), F1-002 comment); apps/api/src/bookkeeping/invoice.processor.ts:16-22 (sole caller — Bull @Process("generate-invoice"); GenerateInvoiceJobData = transactionId only at :6-8); apps/api/src/bookkeeping/bookkeeping.module.ts:33 (queue registered); apps/api/src/orders/orders.service.ts:78 (@InjectQueue("invoices") injected; grep across apps/api/src finds NO invoiceQueue.add / .add("generate-invoice") — the producer was never wired, so the path is DORMANT today; severity High-latent, Critical the moment a producer lands).

**Suggested fix:** Carry tenantId in GenerateInvoiceJobData and scope both queries by it — findUnique → findFirst({ where: { id, tenantId } }), update → updateMany({ where: { id, tenantId } }) — refusing the job when no row matches; apply the same guard to any future synchronous caller before the queue gains a producer.

**Discovery note:** Citations are fresh (verified on master@77b88623, 2026-08-31, by the capability-model follow-up session) — no re-anchor needed unless bookkeeping/invoice.service.ts changes before F02b runs. T1 proof: a jest spec on InvoiceService with a mocked Prisma asserting both queries carry tenantId in their where clause (mirror the shape of settings.controller.clear-financial.spec.ts).

---

## Discovery instructions (per the campaign plan)

Discovery's job is to confirm these lines still say what the register says they say on
current master, and find what the register missed — **never a broad repo sweep**. Where the
citation table above flags a bug ID, search within the files that ID's evidence already
names; do not expand beyond them without a specific reason. Classify every bug ID as
`CONFIRMED on master@<sha>`, `ALREADY FIXED (evidence)`, or `EVIDENCE MOVED (new path:line)`
before writing any code. An already-fixed ID is flipped in the register with its evidence —
never silently carried, never silently dropped.
