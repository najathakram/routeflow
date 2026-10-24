## 5. Operator — Money: Invoices, Finance, Expenses, Vendor Bills, Analytics

**Role(s):** Operator (admin/back-office). All screens call the tenant-scoped admin/finance endpoints; none are driver- or customer-facing. • **Entered via:** The **Finance** hub is _not_ a visible bottom tab (registered with `href: null` in `(tabs)/_layout.tsx`); it and every screen in this area are reached from the **More** tab (`(tabs)/more.tsx`) list rows — "Finance", "Invoices", "Expenses", "Analytics", plus "Shipments" (an invoice-filtered view), "Suppliers", and (addon-gated) "Tobacco". Invoices also have a dedicated Expo-Router stack under `(tabs)/invoices/`.

This is the operator's accounts-receivable and accounts-payable surface: issue and collect customer **invoices** (AR), track vendor **bills** and one-off **expenses** (AP), scan paper invoices/receipts with AI extraction, and read finance/analytics KPIs (revenue, net income, A/R outstanding, DSO, AOV). Money math runs through the shared `lib/pricing.ts` helpers (`computeLineSubtotal`, `effectiveQty`, `roundMoney`) so boxed lines prorate correctly.

### Screens

#### Invoices list — `/(operator)/(tabs)/invoices` (index)

- **File:** `apps/mobile/app/(operator)/(tabs)/invoices/index.tsx`
- **Purpose:** Browse/search/filter all customer invoices (AR).
- **Shows:** Large title "Invoices"; a search bar ("Search number, customer…"); a filter chip row **All / Draft / Sent / Overdue / Paid / Voided**. Each row: `invoiceNumber`, `customer.businessName`, `Due <date>` (if set), a status `Pill` (Draft=gray, Sent/Viewed=brand, Partial=orange, Paid=green, Overdue=red, Voided=gray), and a footer showing `balanceDue` (falls back to `total`) big + "of $total". A row uses the red **Overdue** pill whenever the server's computed `inv.isOverdue` flag is set, regardless of stored status.
- **Actions:** "New" (NavBar trailing) → `router.push("/(operator)/invoices/new")`; row tap → `/(operator)/invoices/:id`; search/filter re-query `useAdminInvoices` → `GET /invoices` (params: `status`, `search`, `isOverdue` when Overdue filter chosen, `limit:50`). The Overdue chip sends `isOverdue:true` and clears `status`.
- **States:** loading (spinner); empty ("No invoices yet." / "No invoices match." when searching); pull-to-refresh (`RefreshControl`).

#### Invoice detail — `/(operator)/(tabs)/invoices/[id]`

- **File:** `apps/mobile/app/(operator)/(tabs)/invoices/[id].tsx`
- **Purpose:** View one invoice, record payments, send, share PDF, void/delete, edit due date & shipment.
- **Shows:** Header card — status Pill, `customer.businessName`, large `balanceDue`, sub-line "of $total · paid $paidAmount", and a tappable **due-date** row ("Due <date>" or "Set due date" with a pencil). An **action grid** of tiles (see Actions). **Items** card — each line `description`, `qty × unitPrice`, line `subtotal`; then Subtotal, Tax (if any), Discount (if any), and bold **Total**. **Shipment** section (`ShipmentSection`, on any non-void invoice) — carrier + tracking number with a "Track package" deep link (`getTrackingUrl` → `Linking.openURL`) and Add/Edit. **Payments** card — each payment's `method`, date (`paidAt`/`createdAt`), `reference`, `notes`, and green `+$amount`.
- **Actions (tiles, conditionally rendered by status):**
  - "Record payment" (when not Paid and not Void) → `/(operator)/invoices/:id/record-payment`.
  - "Send" (only when status DRAFT) → `useSendInvoice`. If the customer has an email → `POST /invoices/:id/send-email` `{email}`; if **no email on file**, a `chooseAction` sheet offers **Mark as Sent** (`POST /invoices/:id/send`), **Share PDF**, or Cancel.
  - "Share PDF" → `useInvoicePdf` (`GET /invoices/:id/pdf`); on success hands the `url` to `sharePdf()` (OS share sheet); a **202** response means "PDF is still generating, try again."
  - "Void" (when not Void) → `confirm` → `useVoidInvoice` `POST /invoices/:id/void` (destructive). Voiding releases `OrderItem.invoicedQty` on the source order (invalidates orders queries so Split becomes available again).
  - "Delete invoice" (**only** when already Void) → `confirm` → `useDeleteInvoice` `DELETE /invoices/:id`; server rejects if payments exist.
  - Due-date pencil → modal (YYYY-MM-DD input) → `useUpdateInvoice` `PATCH /invoices/:id` `{dueDate}`.
  - Shipment Add/Edit → `ShipmentEditModal` → `useUpdateInvoiceShipment` `PATCH /invoices/:id/shipment` (empty strings clear it).
- **States:** loading spinner until `invoice` resolves; permission/terminal-status read-only — Paid hides "Record payment"; Void hides "Record payment"/"Send"/"Void" and swaps in "Delete"; Void also hides the Shipment section. Defensive redirect: if `id === "create"` or `"new"` reaches this route it `router.replace`s to `/(operator)/invoices/new` (RF-203, avoids a doomed lookup / infinite spinner).

#### Record payment — `/(operator)/(tabs)/invoices/[id]/record-payment`

- **File:** `apps/mobile/app/(operator)/(tabs)/invoices/[id]/record-payment.tsx`
- **Purpose:** Log a payment against an invoice.
- **Shows:** `FormSheet` titled "Record payment" (subtitle = invoiceNumber). Method chips: **Cash / Check / ACH / Credit card / Advance / Credit note / Other**. Amount field (pre-filled to the invoice `balanceDue`), hint "Balance due: $X". **Quick presets 25% / 50% / 75% / 100%** of balance. Reference, Payment date (YYYY-MM-DD, hint "leave blank for today", placeholder = _local_ today), Notes. When method is **ACH or CHECK**, an extra **"Bank charges (optional)"** field appears.
- **Actions:** "Record" → validates amount > 0 → `useRecordInvoicePayment` `POST /invoices/:id/payments` `{amount, method, reference?, notes?, bankCharges?, paidAt?}`; on success toast "Payment recorded" and `router.back()`.
- **States:** inline error ("Enter a positive amount."); submit label flips to "Saving…".

#### New invoice (standalone composer) — `/(operator)/(tabs)/invoices/new`

- **File:** `apps/mobile/app/(operator)/(tabs)/invoices/new.tsx` (also served at `/invoices/create` via `create.tsx`, a one-line `export { default } from "./new"` alias to intercept the `[id]` fall-through)
- **Purpose:** Compose a brand-new customer invoice from catalog products + ad-hoc lines. Posts to `POST /invoices` (this is _not_ the from-order/partial path — for that, use the order detail's "Split into invoice").
- **Shows / Steps (two-phase):**
  1. **Customer picker** — search bar, list of customers (avatar initials, businessName, contactName). Empty/loading states.
  2. **Composer** — a customer chip ("Change" resets to the picker); "Search items…" bar; product rows (44px image placeholder, `displayName` = parent+variant, SKU, `$price / box of N` or `/ unit`), each with a **+**/stepper. Boxed products (`unitsPerBox > 1`) step in whole **boxes** and show `Nb + pieces`. An **"Add unlisted item"** CTA (free-text description + required price + qty, never boxed, tagged "Custom"). **Payment terms** pills (Due on Receipt / Net 15 / Net 30 (default) / Net 45 / Net 60) — picking a term recomputes the **Due date** (YYYY-MM-DD, editable). A **"Send immediately on create"** checkbox. Sticky footer: total-items + running `$total` (tap → Review sheet) and a **Create** button. A **Review sheet** lists each line with an inline **price-override** input (shows "was $catalog" strikethrough when overridden), qty stepper, per-line total, remove, and unlisted-line editing.
- **Actions:** floating `BarcodeFab` → `handleScanned` matches local barcode/SKU/id, else `resolveProductByCode` (server lookup); a no-match offers "Create" → `/(operator)/products/new?barcode=…`. "Save"/"Create" → validates ≥1 item and due-date format → `useCreateInvoice` `POST /invoices` `{customerId, items[], dueDate, terms, send}`; on success `router.replace("/(operator)/invoices/:id")`. Line items serialize `{description, productId?, qty, unitPrice, boxes?, pieces?}`; unlisted lines omit `productId`.
- **States:** product list loading/empty; disabled Save until items exist; `alertInfo` guards for "Add at least one item" and "Bad due date". `router.back()` falls back to the invoices list on web (empty history).

#### Finance hub — `/(operator)/(tabs)/finance`

- **File:** `apps/mobile/app/(operator)/(tabs)/finance.tsx`
- **Purpose:** AP landing page — vendor bills & expenses overview.
- **Shows:** Large title "Finance", eyebrow "VENDOR BILLS & EXPENSES". Two primary CTAs: **Scan Invoice** (brand) and **New Bill**. Two KPI cards computed client-side from the last 10 bills: **Unpaid bills** (count of RECEIVED+PARTIAL) and **Amount owing** (sum of their `totalOwed`). Quick-link tiles: **All bills**, **Expenses**, **Suppliers**. A **Recent bills** section (supplier name · billNumber, formatted billDate, `totalOwed`, status pill: Draft/Received/Partial=orange, Paid=green, Void=gray) with "See all".
- **Actions:** Scan Invoice → `/(operator)/vendor-bills/scan`; New Bill → `/(operator)/vendor-bills/new`; All bills / See all → `/(operator)/vendor-bills`; Expenses → `/(operator)/expenses`; Suppliers → `/(operator)/suppliers`; bill row → `/(operator)/vendor-bills/:id`. Data: `useVendorBills({limit:10})` → `GET /vendor-bills`.
- **States:** loading spinner; empty ("No vendor bills yet. Scan an invoice to get started."); pull-to-refresh.

#### Expenses list — `/(operator)/expenses` (index)

- **File:** `apps/mobile/app/(operator)/expenses/index.tsx`
- **Purpose:** Browse one-off business expenses.
- **Shows:** Inline title "Expenses" (back → "Finance"); filter chips **All / Pending / Paid / Void**. Rows: `description ?? category.name ?? "Expense"`, sub-line `date · supplier · category`, status pill (Pending/Received=orange, Paid=green, Void=gray), `amount`, chevron.
- **Actions:** "New" → `/(operator)/expenses/new`; row → `/(operator)/expenses/:id`; filter → `useExpenses({status, limit:50})` → `GET /expenses`.
- **States:** loading; empty ("No expenses yet." + an "Add expense" button); pull-to-refresh.

#### New expense — `/(operator)/expenses/new`

- **File:** `apps/mobile/app/(operator)/expenses/new.tsx`
- **Purpose:** Create an expense record.
- **Shows:** `FormSheet` "New Expense". A **scan-receipt banner** ("Have a paper receipt?") linking to the vendor-bills scanner. Fields: **Amount ($)** (required), **Date** (defaults to today if blank), Description, **Category** (bottom-sheet picker with category-name→icon mapping), Reference #, **Payment method** (grid picker: Cash/Card/Bank transfer/Check/Other), **Supplier** (optional, `OptionPickerSheet`, nullable), Notes.
- **Actions:** "Create expense" → validates amount > 0 → `useCreateExpense` `POST /expenses`; on success `router.replace("/(operator)/expenses/:id")`. Scan banner → `/(operator)/vendor-bills/scan`. Categories via `useExpenseCategories`, suppliers via `useSuppliers`.
- **States:** toast on invalid amount / error; submit label "Creating…".

#### Expense detail — `/(operator)/expenses/[id]`

- **File:** `apps/mobile/app/(operator)/expenses/[id].tsx`
- **Purpose:** View, inline-edit, or delete a single expense.
- **Shows:** Header card — large `amount`, long-form date, status pill, description. **Details** card (only rendered when any detail exists): Category, Supplier, Payment (title-cased), Reference #, Notes. An inline **Edit** form (amount, date, description, category/supplier/payment pickers via `OptionPickerSheet`, reference, notes). A **Delete expense** button.
- **Actions:** "Edit" (NavBar trailing, hidden when Void) toggles the edit form; "Save changes" → `useUpdateExpense` `PATCH /expenses/:id` (sends `categoryId`/`supplierId` = null when cleared); "Cancel" exits edit; "Delete expense" → `confirm` → `useDeleteExpense` `DELETE /expenses/:id` → `router.back()`.
- **States:** loading spinner; **Void** expenses are read-only (Edit and Delete both hidden); toast on invalid amount/errors.

#### Vendor bills list — `/(operator)/vendor-bills` (index)

- **File:** `apps/mobile/app/(operator)/vendor-bills/index.tsx`
- **Purpose:** Browse all vendor bills (AP).
- **Shows:** Inline title "Vendor Bills" (back → "Finance"); filter chips **All / Unpaid (RECEIVED) / Paid (FULL) / Draft**. Rows: `supplier.name · billNumber`, an amber **"Needs items — won't update costs"** warning when `billNeedsMapping` is true (DRAFT with no items or unlinked lines), billDate · "Due <date>", status pill, `totalOwed`, chevron.
- **Actions:** NavBar "Scan" → `/(operator)/vendor-bills/scan`; "New" → `/(operator)/vendor-bills/new`; row → `/(operator)/vendor-bills/:id`; filters → `useVendorBills({status, limit:50})` → `GET /vendor-bills`.
- **States:** loading; empty ("No bills yet." + "Scan invoice" button); pull-to-refresh.

#### New vendor bill — `/(operator)/vendor-bills/new`

- **File:** `apps/mobile/app/(operator)/vendor-bills/new.tsx`
- **Purpose:** Manually enter a vendor bill with line items.
- **Shows:** `FormSheet` "New Vendor Bill" with a **scan banner** ("Have a paper bill?"). **Supplier** picker (nullable). **Bill date / Due date** (YYYY-MM-DD), Notes. **Line items** — each row: Description with **product autocomplete** (`useProducts` search, suggestions show name + SKU) and a **Scan** icon (native → `BarcodeScanner`, web → expands suggestions); picking a suggestion/scan auto-fills `unitCost` from the product's `pricePerUnit`. Qty + Unit cost ($). "Add item" appends rows; "Remove" per row (when >1).
- **Actions:** "Create bill" → filters to items with a description → `useCreateVendorBill` `POST /vendor-bills` `{supplierId?, billDate?, dueDate?, notes?, items:[{description, qty, unitCost}]}`; on success `router.replace("/(operator)/vendor-bills/:id")`.
- **States:** toast "Add at least one line item." if none; submit "Creating…".

#### Scan invoice (AI OCR) — `/(operator)/vendor-bills/scan`

- **File:** `apps/mobile/app/(operator)/vendor-bills/scan.tsx`
- **Purpose:** Photograph a paper vendor invoice/receipt; AI extracts supplier, items, totals into a draft bill.
- **Steps:** (1) **Upload** — "Add receipt" → native prompt (Take photo / Choose from library; web goes straight to file picker). (2) **Scanning** — shows the image with an overlay "AI is reading your invoice…" (usually 10–20s). (3) **Review** — extracted **Supplier / Invoice # / Date / Total**, and **Line items** each with a **confidence dot** (green=high, orange=medium/partial, red=none) + a legend, showing `productName ?? description`, `qty × $unitCost`, `lineTotal`.
- **Actions:** image pick → `useScanInvoice` `POST /vendor-bills/scan-invoice` (multipart, 90s timeout). "Create vendor bill" → for each matched item saves a **product mapping** (`useSaveProductMapping` `POST /vendor-bills/product-mappings`, so the AI learns supplier→product) → matches supplier by name → `useCreateVendorBill` `POST /vendor-bills` (items with `qty>0 || unitCost>0`) → `router.replace("/(operator)/vendor-bills/:id")`. Back/Cancel from Review → `confirm("Discard scan?")`.
- **States:** scan error → returns to Upload with toast "Could not read invoice. Try a clearer photo."; creating → "Creating bill…".

#### Vendor bill detail — `/(operator)/vendor-bills/[id]`

- **File:** `apps/mobile/app/(operator)/vendor-bills/[id].tsx`
- **Purpose:** View a bill, mark it received (posts inventory/cost), or void it.
- **Shows:** Header card — supplier name, billNumber, bill date / due date, large `totalOwed`, notes, status pill. An amber **warn banner** when `billNeedsMapping`: "No line items — receiving won't update inventory or costs." or "Some lines aren't linked to products and won't update costs." **Line items** list (`product.name ?? description`, `qty × unitCost`, lineTotal). Actions row.
- **Actions:** "Mark received" (only DRAFT/RECEIVED) → `useReceiveVendorBill` `POST /vendor-bills/:id/receive`. If the server returns a **409 `UNLINKED_ITEMS`**, a `confirm("Some lines won't update costs", …)` lists up to 5 skipped lines and, on "Receive anyway", retries with `{acknowledgeUnlinked:true}`. "Void" (DRAFT/RECEIVED/PARTIAL) → `confirm` → `useVoidVendorBill` `POST /vendor-bills/:id/void`. Receiving invalidates inventory + products caches (weighted-average cost update).
- **States:** loading spinner; action row hidden entirely once FULL or VOID (terminal, read-only).

#### Split into invoices (from order) — `/(operator)/(tabs)/orders/[id]/split-invoice`

- **Files:** `apps/mobile/app/(operator)/(tabs)/orders/[id]/split-invoice.tsx` (thin wrapper) → shared `apps/mobile/components/SplitInvoiceScreen.tsx`
- **Purpose:** The **from-order** invoice path — split one order into N partial invoices (AR). This is where operators bill an order (the standalone `new.tsx` composer does _not_ touch orders). Reached from the operator order detail's "Split into invoice…".
- **Shows:** Per-order billable items (only lines where `qty - invoicedQty > 0`). One or more **draft invoice cards**; the first draft auto-fills every billable item at full remaining qty. Each item row shows a live "**X of Y ea left**" tally (orange when unallocated, green when zero) at `$unitPrice/ea`, a qty input, **None / Half / All** quick buttons, and a line total. Per-draft footer: **Terms** pills → recompute **Due date**, a **"Send immediately on create"** checkbox, and an invoice subtotal. A bottom "N invoices to create · $total" bar; a "Not yet allocated" tally; an all-done state ("All items invoiced").
- **Actions:** "Add another invoice" appends a draft. "Create N" → `submitAll` POSTs each draft **sequentially** via `useCreatePartialInvoiceFromOrder` `POST /invoices/from-order/:orderId/partial` `{items:[{orderItemId, qty}], terms, dueDate, send}`; created drafts are marked (badge, opacity) so a partial failure is recoverable. On success `onCreated` → `router.back()`.
- **States:** loading/error (order not found); all-invoiced done state with re-split instructions (void/delete an invoice to free items); allocations clamp on blur to remaining qty (can't over-invoice); bulk-pending overlay.

#### Analytics — `/(operator)/analytics`

- **File:** `apps/mobile/app/(operator)/analytics/index.tsx`
- **Purpose:** Read-only finance & sales KPI dashboard.
- **Shows:** Six KPI cards — **Revenue**, **Expenses**, **Net income**, **A/R outstanding** (from `useAdminFinanceDashboard` → `GET /bookkeeping/dashboard`), **Days sales outstanding** (`useAnalyticsDso` → `GET /analytics/dso`, shown as `Nd`), **Avg order value** (`useAnalyticsAov` → `GET /analytics/aov`). Currency compacts to `$X.Xk`. Two lists: **Top products** and **Top customers** (top 5 each, rank + name + revenue) from `GET /analytics/products/top` and `GET /analytics/customers/top`.
- **Actions:** none interactive beyond back; all queries fail soft (each `.catch` returns zeros/empty).
- **States:** finance block loading spinner; per-list "Not enough data yet." empty state.

### Key flows (end-to-end journeys through this area)

- **Invoice a customer directly:** More → Invoices → "New" → pick customer → add products (stepper/barcode/unlisted, optional price override in Review) → set terms/due date, optionally "Send immediately" → **Create** (`POST /invoices`) → land on the new invoice detail.
- **Invoice an existing order (split):** Operator order detail → "Split into invoice…" → `SplitInvoiceScreen` → allocate qtys across one or more drafts (None/Half/All) → set each draft's terms/due/send → **Create N** (`POST /invoices/from-order/:orderId/partial` per draft, sequential) → back to order.
- **Collect payment:** Invoice detail → "Record payment" → choose method (+ bank charges for ACH/CHECK) → amount (or a %) → "Record" (`POST /invoices/:id/payments`) → balance/paid update; status advances toward PARTIAL/PAID server-side.
- **Send / share:** Invoice detail → "Send" (`send-email` if email present, else Mark-as-Sent or Share) OR "Share PDF" (`GET /invoices/:id/pdf` → OS share sheet; 202 = still generating).
- **Void → delete:** Invoice detail → "Void" (`/void`, frees order invoicedQty) → the tile becomes "Delete invoice" → `DELETE /invoices/:id` (rejected if payments exist).
- **AP via scan:** Finance → "Scan Invoice" → photo → AI extract → review confidence → "Create vendor bill" (`/scan-invoice` then `POST /vendor-bills`, saving product mappings) → bill detail → "Mark received" (posts inventory + weighted-avg cost; 409 UNLINKED_ITEMS → confirm "Receive anyway").
- **Expense capture:** Finance → Expenses → "New" (or the scan banner → vendor-bill scanner) → amount/date/category/payment → Create → expense detail (inline edit / delete).

### Use cases

- As an operator, I want to bill a delivered order in installments so that I can invoice partial shipments without over-invoicing. (path: order detail → split-invoice → per-draft allocation → Create N)
- As an operator, I want to give a customer a one-time discounted price on a line so that I can honor a negotiated rate. (path: invoices/new → Review sheet → per-line price override, shows "was $catalog")
- As an operator, I want to record a cash/check/ACH payment against an invoice so that the balance and A/R reflect reality. (path: invoice detail → record-payment)
- As an operator, I want to email or share an invoice PDF so that the customer gets a copy even if no email is on file. (path: invoice detail → Send / Share PDF)
- As an operator, I want to snap a photo of a supplier invoice so that a vendor bill with line items is created without manual typing. (path: finance → scan → review → create)
- As an operator, I want to mark a vendor bill received so that inventory quantities and weighted-average costs update. (path: vendor-bill detail → Mark received)
- As an operator, I want to log a fuel/rent expense (optionally from a receipt scan) so that net income and expense KPIs are accurate. (path: expenses → new)
- As an operator, I want a one-glance read on revenue, net income, A/R outstanding, DSO and AOV so that I can gauge cash health. (path: More → Analytics)

### Business rules & edge cases

- **Integer boxes/pieces & boxed pricing:** For products with `unitsPerBox > 1`, the composer steps in whole boxes (`boxes*upb + pieces`), and totals use `computeLineSubtotal`/`effectiveQty` with `roundMoney` — never `qty * unitPrice` (which over-charges by `unitsPerBox`). Line payload carries `boxes`/`pieces` so the server prorates.
- **Price-override convention:** A line's optional `unitPrice` is a one-time override of the catalog price (for boxed items it's the **box** price). Empty/invalid clears it. The Review sheet shows the override highlighted with a "was $catalog" strikethrough. Unlisted lines are never boxed (`qty × unitPrice`) and omit `productId`.
- **Invoice status gating:** Record payment hidden when PAID or VOID; Send only on DRAFT; Void hidden once VOID; **Delete only from VOID** and only if no payments exist (server-enforced). Overdue is a **computed** flag (`isOverdue`) that overrides the stored status for the list pill.
- **Void frees order lines:** Voiding an order-linked invoice releases `OrderItem.invoicedQty` (queries invalidated) so the order can be re-split; the split screen's all-done state tells the operator to void/delete to re-split.
- **Split can't over-invoice:** `SplitInvoiceScreen` clamps each item to `qty - invoicedQty` (minus other drafts' allocations); drafts POST **sequentially** so server-side `invoicedQty` increments don't race; a partial failure keeps already-created invoices.
- **Vendor-bill "needs mapping":** `billNeedsMapping` (DRAFT with no items or any line lacking `productId`) surfaces amber warnings; receiving such a bill won't update inventory/costs. Receiving with unlinked lines throws **409 UNLINKED_ITEMS** → the UI confirms and retries with `acknowledgeUnlinked:true`, skipping those lines. Received bills update **weighted-average cost** (products/inventory caches invalidated).
- **Vendor-bill terminal states:** FULL and VOID hide all actions (read-only). Void is irreversible.
- **Scan/OCR:** 90s timeout; per-item confidence (high/medium/low/none); on save the app persists supplier→product **mappings** for AI learning; only items with `qty>0 || unitCost>0` are kept.
- **PDF generation is async:** `GET /invoices/:id/pdf` may return **202** (null → "still generating, try again"); otherwise the signed `url` is handed to the OS share sheet (no download).
- **No-email customers:** Send offers Mark-as-Sent / Share PDF instead of emailing (the placeholder sentinel email is never surfaced).
- **Date handling:** payment/due-date placeholders use **local** today (not UTC); due dates validate strict `YYYY-MM-DD`.
- **Multi-tenant / auth:** every hook hits tenant-scoped endpoints via the shared authenticated `apiClient`; analytics/finance queries fail soft to zeros so the dashboard still renders.
- **Addon gating (adjacent):** the Tobacco compliance area is only listed in More when `useHasAddon(TOBACCO_ADDON)` is true — Finance/Invoices themselves are not addon-gated.

Files (all absolute):

- `C:\ClaudeCode\routeflow\apps\mobile\app\(operator)\(tabs)\invoices\index.tsx`, `[id].tsx`, `[id]\record-payment.tsx`, `create.tsx`, `new.tsx`, `_layout.tsx`
- `C:\ClaudeCode\routeflow\apps\mobile\app\(operator)\(tabs)\finance.tsx`
- `C:\ClaudeCode\routeflow\apps\mobile\app\(operator)\expenses\{index,new,[id]}.tsx`
- `C:\ClaudeCode\routeflow\apps\mobile\app\(operator)\vendor-bills\{index,new,[id],scan}.tsx`
- `C:\ClaudeCode\routeflow\apps\mobile\app\(operator)\analytics\index.tsx`
- `C:\ClaudeCode\routeflow\apps\mobile\app\(operator)\(tabs)\orders\[id]\split-invoice.tsx` + shared `C:\ClaudeCode\routeflow\apps\mobile\components\SplitInvoiceScreen.tsx`, `ShipmentSection.tsx`
- API: `C:\ClaudeCode\routeflow\apps\mobile\lib\api\{invoices,vendor-bills,expenses,admin}.ts`
