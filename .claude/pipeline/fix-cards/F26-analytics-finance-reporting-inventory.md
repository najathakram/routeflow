# F26 · Analytics, finance reporting and inventory

**Bug IDs (9):** B14, B25, B27, B28, B41, B42, B87, B88, B119

**Root cause:** Windowed DSO excludes unpaid invoices so narrow ranges read flatteringly low (B119); the web low-stock badge ignores per-product reorder points (B25); PO receive notes are collected, validated and discarded (B88); mileage rates point at a Settings page that does not exist (B42).

**Ships as:** One PR. Mostly one-file fixes with no shared hot file — a good candidate for a single dense batch.

**Files:** analytics.service.ts and other per-bug single-file locations (see the register's own evidence per ID)

**Together because:** No shared hot file; batched purely to avoid nine separate merge windows for small, independent fixes.

**Guardrails / shared infra:** None new. No lane conflicts — freely parallel.

**Dependencies / lane notes:** None.

---

## Proof-tier assignment (frozen at seed — see plan's Phase 2 and `.claude/campaign/status/F26.jsonl`)

| ID   | Tier | Hunt-round SHA | Citation status     |
| ---- | ---- | -------------- | ------------------- |
| B14  | T2   | 2d0270fd       | OUT_OF_BOUNDS       |
| B25  | T2   | 2d0270fd       | TOKEN_NOT_FOUND     |
| B27  | T3   | 2d0270fd       | OUT_OF_BOUNDS       |
| B28  | T2   | 2d0270fd       | TOKEN_NOT_FOUND     |
| B41  | T2   | 2d0270fd       | NO_TOKEN_UNVERIFIED |
| B42  | T2   | 2d0270fd       | NO_TOKEN_UNVERIFIED |
| B87  | T1   | e5b0af8e       | NO_TOKEN_UNVERIFIED |
| B88  | T1   | e5b0af8e       | MOVED (corrected)   |
| B119 | T2   | 0cd59277       | NO_TOKEN_UNVERIFIED |

> T1 = jest spec (api or mobile pure-logic) · T2 = Playwright e2e, web-visible (proven-pending-deploy through the PR, per the plan) · T3 = recorded manual check (forbidden for Critical/High — none here are). See `.claude/campaign/citation-reanchor-log.md` for any bug ID flagged above whose citation needs a discovery-time check before trusting it verbatim.

---

## Bug details — register triple, evidence and suggested fix, pasted verbatim

### B14 — Bookkeeping transaction detail page is unlinked

**Area:** Bookkeeping · web

**Meant to do:** Clicking a transaction/invoice row in the Transaction Ledger report should open a detail page with full line items, payment recording, and a PDF download for that transaction.

**Actually does:** `apps/web/app/(dashboard)/bookkeeping/[transactionId]/page.tsx` exists with a real detail view (useTransaction, RecordPaymentModal, PDF download via useDownloadInvoice) but its data hook `useTransaction` (apps/web/lib/api/bookkeeping.ts:61-64) has exactly one caller in the whole web app — the page itself (line 133). The Ledger report (apps/web/app/(dashboard)/finance/reports/page.tsx, `LedgerReport` at 1934) renders the invoice/order number as a plain `<span>` (lines 2045-2049, no `<Link>`/onClick) and its 'Record Payment' action (2076-2083) opens an inline modal on the same page rather than navigating anywhere. `/bookkeeping` itself is just a client-side redirect to `/finance/reports?report=ledger` (apps/web/app/(dashboard)/bookkeeping/page.tsx:6-11).

**The gap:** The detail page's PDF-download and full-line-item view are reachable only by hand-typing the URL; nothing in the app links to it.

**Evidence:** apps/web/lib/api/bookkeeping.ts:61-64 useTransaction (sole use at .../bookkeeping/[transactionId]/page.tsx:133); apps/web/app/(dashboard)/finance/reports/page.tsx:2045-2049 (plain span, no Link) and 2076-2083 (inline modal, no navigation); apps/web/app/(dashboard)/bookkeeping/page.tsx:6-11 (redirect to the Ledger report, confirming the Ledger is the page's only conceptual entry point).

**Suggested fix:** Wrap the Invoice # cell in LedgerReport with a `<Link href={`/bookkeeping/${tx.id}`}>` (or route to the existing invoice detail page if that's the intended canonical view) so the PDF-download/detail page becomes reachable.

### B25 — Web low-stock badge ignores reorder points

**Area:** Products / inventory · web

**Meant to do:** The Low Stock badge should reflect each product's own reorder threshold, consistent with what mobile and forecasting consider 'needs reorder.'

**Actually does:** Web list badges LOW whenever currentStock <= a hardcoded 5, ignoring reorderPoint entirely. Mobile computes low/out against p.reorderPoint ?? 5 (per-product, falls back to 5 only when unset). API forecasting flags needsReorder as currentStock < p.reorderPoint (per-product, no default).

**The gap:** A product with a configured reorderPoint above or below 5 shows the wrong badge on the web list (e.g. reorderPoint=50, stock=10 reads 'In Stock' on web but mobile/forecasting correctly flag it as needing reorder).

**Evidence:** apps/web/app/(dashboard)/products/page.tsx:113-118 getStockStatus() vs apps/mobile/app/(operator)/products/index.tsx:349-352 (threshold = p.reorderPoint ?? 5) vs apps/api/src/inventory/inventory.service.ts:1279-1314 (needsReorder line 1311, no flat fallback)

**Suggested fix:** Change getStockStatus() in apps/web/app/(dashboard)/products/page.tsx to compare currentStock against p.reorderPoint ?? 5 (mirroring mobile's fallback) instead of a hardcoded 5.

### B27 — Finance’s Purchase Orders tab is a dead end

**Area:** Finance / purchasing · web

**Meant to do:** The Finance Purchase Orders view should let staff open a PO's detail and create new POs from that screen.

**Actually does:** PurchaseOrdersTab in finance/expenses/page.tsx renders a plain table: rows are bare <tr> with no onClick/Link into any detail view, and the tab has no 'New PO' button (the visible 'New Purchase' button belongs to the sibling Vendor Bills tab, InventoryPurchasesTab). Real PO creation/detail/receive UI (CreatePOModal, PODetailRow, send/receive actions) lives entirely on the separate Inventory page's Purchase Orders tab.

**The gap:** Users on Finance's PO tab can only view status/total; there is no way to open, create, or act on a PO without navigating away to Inventory.

**Evidence:** apps/web/app/(dashboard)/finance/expenses/page.tsx:1588-1694 (PurchaseOrdersTab: rows at 1668-1687 have no click handler; 'New Purchase' button at 1131-1133 confirmed to belong to InventoryPurchasesTab, not this tab) vs apps/web/app/(dashboard)/inventory/page.tsx:1222 (CreatePOModal), 1698 (PODetailRow), 1910-2105 (Purchase Orders tab wiring w/ create+receive)

**Suggested fix:** Either link each row to the Inventory PO detail (e.g. router.push to /inventory?tab=purchase-orders&po=<id>) and add a 'New PO' button opening the same CreatePOModal used on Inventory, or replace this read-only tab with a clear pointer/redirect to the Inventory Purchase Orders tab.

### B28 — Cost-set movements show a raw code on web

**Area:** Inventory movements · web

**Meant to do:** Every StockMovement type recorded by the system should render a readable badge label in the web movements ledger, consistent with mobile.

**Actually does:** MOVEMENT_TYPE_LABELS/MOVEMENT_TYPE_VARIANTS in the web ledger cover only PURCHASE/SALE/ADJUSTMENT/RETURN/WRITE_OFF; COST_BASIS (a real Prisma enum value) falls through the `?? m.type` fallback and renders as the raw string 'COST_BASIS', and is also absent from the type-filter dropdown (built off the same map). Mobile explicitly maps COST_BASIS to the label 'Cost set'.

**The gap:** Web ledger shows the unstyled raw enum for cost-basis entries and offers no way to filter the list down to just them; mobile shows a proper label for the same data.

**Evidence:** apps/web/app/(dashboard)/inventory/movements/page.tsx:15-29 (label/variant maps), :158 (filter dropdown built from same map), :247 (label fallback to m.type) vs apps/api/prisma/schema.prisma:202-209 (enum MovementType incl. COST_BASIS) vs apps/mobile/app/(operator)/movements.tsx:24,40-41 ('Cost set')

**Suggested fix:** Add `COST_BASIS: "Cost set"` to MOVEMENT_TYPE_LABELS and a variant (e.g. "neutral") to MOVEMENT_TYPE_VARIANTS in apps/web/app/(dashboard)/inventory/movements/page.tsx, matching mobile's label.

### B41 — Expense categories are locked to the fixed list

**Area:** Expenses · web

**Meant to do:** Finance staff should be able to add tenant-specific expense categories beyond the default seeded list via the existing create-mutation hook.

**Actually does:** useCreateExpenseCategory is defined but has zero call sites anywhere in apps/web or apps/mobile; only the read hook useExpenseCategories is used, to populate category dropdowns in ScanInvoiceModal.tsx and the expenses pages. Categories come solely from an idempotent IRS Schedule C seed in bookkeeping.service.ts.

**The gap:** No button, form, or settings page anywhere calls POST /bookkeeping/expense-categories; tenants are permanently limited to the seeded IRS Schedule C list with no in-app way to add a custom one.

**Evidence:** apps/web/lib/api/finance.ts:270-276 (useCreateExpenseCategory, no other references in repo); consumers of useExpenseCategories only at apps/web/components/ScanInvoiceModal.tsx:559, apps/web/app/(dashboard)/finance/expenses/page.tsx:1718, apps/web/app/(dashboard)/finance/expenses/new/page.tsx:54,704; apps/api/src/bookkeeping/bookkeeping.service.ts:255,294 (seed-only origin)

**Suggested fix:** Add a small 'Add category' affordance (modal or inline form) in Settings or the Expenses page wired to useCreateExpenseCategory, or remove the dead hook if custom categories are out of scope.

### B42 — Mileage rates can’t be configured anywhere

**Area:** Expenses / mileage · web

**Meant to do:** Operators should be able to configure/manage mileage reimbursement rates so staff can record mileage expenses; the error message explicitly promises this is possible in Settings.

**Actually does:** useCreateMileageRate and useDeleteMileageRate (finance.ts:285-301) have zero UI consumers anywhere; only the read hook useMileageRates is used, in the Record Mileage tab. With no applicable rate, submit is blocked and the toast says 'No mileage rate found for this date. Add a rate in Settings' — but no Settings page (or anywhere else) has any mileage-rate management UI.

**The gap:** The error message points to a Settings feature that does not exist; a tenant with zero mileage rates configured has no in-app path to add one, making mileage expense entry permanently impossible until someone writes directly to the DB or hits the API out-of-band.

**Evidence:** apps/web/lib/api/finance.ts:285-301 (mutations defined, unused); apps/web/app/(dashboard)/finance/expenses/new/page.tsx:442(useMileageRates only),462-490(blocks submit),486('Add a rate in Settings'),626('No mileage rate set for this date'); zero matches for mileage in apps/web/app/(dashboard)/settings; apps/api/src/bookkeeping/bookkeeping.controller.ts:101-115 confirms the POST/DELETE endpoints exist and work — the gap is UI-only

**Suggested fix:** Build the missing Settings > Finance mileage-rates panel (list + add + delete) wired to useMileageRates/useCreateMileageRate/useDeleteMileageRate, matching the message's promise.

### B87 — Deposit policy is invisible to AR aging and unavailable when creating an invoice on mobile

**Area:** apps/api/src/bookkeeping (AR aging) + apps/mobile invoices/new

**Meant to do:** AR Aging reflects an overdue deposit, and mobile direct-create offers the deposit fields web already has.

**Actually does:** getArAgingInvoices never reads any deposit field and buckets purely by dueDate; mobile's new-invoice screen has zero deposit references and posts to the direct-create path, which takes depositPercent only from the DTO with no tenant-policy default.

**The gap:** A deposit-overdue invoice with a future dueDate shows as current in aging, and mobile-created invoices are always deposit-less even on deposit-policy tenants — the from-order path applies the default, the direct path does not.

**Evidence:** apps/api/src/bookkeeping/bookkeeping.service.ts:1299-1362 (no deposit fields); apps/api/src/invoices/invoices.service.ts:268-273 (doc comment: AR aging untouched by design), :492-493 (dto.depositPercent only) vs :647-666 (from-order default fallback); apps/mobile/app/(operator)/invoices/new.tsx (no deposit references); apps/web/app/(dashboard)/invoices/new/page.tsx:684-686, :1018-1096, :1566-1629 (full deposit UI).

**Suggested fix:** Call computeDepositFields per invoice inside getArAgingInvoices to surface a deposit-overdue signal, and add deposit inputs to the mobile new-invoice screen wired into the POST payload.

### B88 — Purchase-order receive notes are collected, validated, then discarded

**Area:** apps/api/src/inventory + apps/mobile purchase-orders receive

**Meant to do:** A note typed while receiving a purchase order (damage, a short shipment) is saved somewhere retrievable — on the PO or on the resulting stock movement.

**Actually does:** receivePurchaseOrder reads dto.items but never references dto.notes anywhere in its body; the StockMovement rows omit notes and the final purchaseOrder.update doesn't persist it either.

**The gap:** dto.notes is validated and shipped by the client, StockMovement.notes is a real field written by recordAdjustment in the same service, and the Movements list already renders it — only this write is missing.

**Evidence:** apps/api/src/inventory/dto/create-purchase-order.dto.ts:~36 [re-anchored master@6c8f1401; was :49 at hunt round master@e5b0af8e] (notes on ReceivePurchaseOrderDto); apps/api/src/inventory/inventory.service.ts:1119-1261 (no dto.notes reference), :1199-1211 (stockMovement.create, no notes key), :1245-1247 (final update), contrast :272-315 (recordAdjustment writes notes); apps/mobile/app/(operator)/purchase-orders/[id]/receive.tsx:26, :70, :140-145 (collected and sent); apps/mobile/app/(operator)/movements.tsx:180 (renders m.notes when present).

**Suggested fix:** Pass `notes: dto.notes` into the stockMovement.create call(s) inside receivePurchaseOrder (mirroring recordAdjustment) and/or persist it on the PurchaseOrder row, in the same transaction.

### B119 — Windowed DSO excludes still-unpaid invoices — narrow ranges read flatteringly low

**Area:** Analytics · web dashboard

**Meant to do:** Narrowing the Analytics date range should re-scope DSO to that period so 'This Month' and 'YTD' are comparable collection-speed numbers.

**Actually does:** getDso averages only invoices with status PAID, windowed on issueDate; invoices raised in the window but still unpaid vanish, so a 7-day window structurally caps the average near 7 days.

**The gap:** Survivorship-filtered average shrinks with window width; no caption warns, unlike the Dead Stock and Margin Alerts cards shipped in the same PR.

**Evidence:** apps/api/src/analytics/analytics.service.ts:191-195, 613-634; apps/api/src/analytics/analytics.controller.ts:99-102; apps/web/app/(dashboard)/analytics/page.tsx:325-332 (fetch), 405-409 (bare StatCard), 781-784 + 794-797 (siblings' captions). Verified bound: PAID invoices issued in the last N days can show at most ~N days issue-to-pay.

**Suggested fix:** Either compute a true windowed DSO (count open invoices at days-outstanding-to-now, or classic AR/credit-sales x days), or caption the card as 'average days-to-pay of invoices issued in this range that have been paid' like its siblings.

---

## Discovery instructions (per the campaign plan)

Discovery's job is to confirm these lines still say what the register says they say on
current master, and find what the register missed — **never a broad repo sweep**. Where the
citation table above flags a bug ID, search within the files that ID's evidence already
names; do not expand beyond them without a specific reason. Classify every bug ID as
`CONFIRMED on master@<sha>`, `ALREADY FIXED (evidence)`, or `EVIDENCE MOVED (new path:line)`
before writing any code. An already-fixed ID is flipped in the register with its evidence —
never silently carried, never silently dropped.
