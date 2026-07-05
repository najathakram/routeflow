# 04 · Operator — Orders, Returns & the scan-to-add order builder

**Role(s):** Operator / Tenant Admin (full lifecycle); Customer role sees a reduced, own-orders
view (box-splitting hidden). **Entered via:** left-sidebar nav → **Orders**, **Returns**; the
`/invoices/new` "New sale" builder is reached from **Invoices → New**. Deep links preselect list
views (`?status=PENDING`, `?action=new` on `/orders` opens the create modal).

This is the operator's order lifecycle on web: an orders **list** (saved views + filters + bulk
ops + CSV export), an order **detail** page (inline line-item editor with per-line price/discount
override, status transitions, invoice generation + multi-channel send, split-invoice), a
**Create Order** modal (customer + product search + scan + merge guard), a confusingly-named
**`/invoices/new` order builder** (documented here — it builds orders, not just invoices; see
_Faster ways_), and the **Returns** list + detail. All money math flows through
`apps/web/lib/pricing.ts` (`computeLineSubtotal` boxed proration, `roundMoney`) — a mirror of the
API helper. Web has no offline queue and no floating barcode FAB; scanning is a focused text input
that accepts keyboard-emulation **and** paste-mode scanners on **Enter**.

---

## Screens

### Orders list — `/orders`
- **File:** `apps/web/app/(dashboard)/orders/page.tsx`
- **Purpose:** The operator's order inbox — browse, filter, search, bulk-cancel/delete, export, open one.
- **Shows:**
  - `PageHeader` **"Orders"** with a right cluster: **Export** (CSV), **Select** (toggles bulk mode), **New Order** (opens `CreateOrderModal`).
  - **Saved-view chips** (`SAVED_VIEWS`): **All · Pending · Confirmed · Out for Delivery · Urgent · Delivered · Cancelled**. The active chip is derived from the current URL filters; clicking one clears filters then applies that view's filter set (`{status}` or `{urgent:true}`).
  - **Filter bar:** a **search** box (client-side filter over `customer.businessName` + `orderNumber`), a **status** `Select` (`STATUS_OPTIONS` includes `DRAFT`, `PARTIALLY_DELIVERED` not present as a chip), an **Urgent only** toggle (shows a red count badge), a **Delivery date** from–to range (`dateFrom`/`dateTo`, each clamps the other's min/max), and a **Clear all** link. All except search are URL-backed via `useUrlFilters` (survive refresh / shareable).
  - **Table** (single view — no card/table toggle on web): columns **⚠ · Order # · Customer · Items · Total · Status · Delivery Date · Created**, plus a leading checkbox column in select mode and a trailing **Eye** (view) action. Urgent rows get a red left border and a `⚠` icon and **always float to the top** regardless of sort. Money rendered `$X,XXX.XX`.
  - **Pagination** footer: "Showing a–b of N", a **Per page** selector (10/20/50/100), and numbered page buttons (up to 7). When a client search is active it shows "Showing N of total (filtered)" and hides the per-page/pager (search filters only the current page).
- **Actions:**
  - Sort by clicking **Order # / Customer / Total / Status / Delivery Date / Created** headers (`toggleSort` flips asc/desc; default `createdAt` desc). Sorting is client-side over the current page.
  - Row click (or Enter) → `/orders/{id}`; in select mode a row click toggles its checkbox instead.
  - **Select** → bulk mode: per-row checkbox + a **Select all** header checkbox (indeterminate state). A warning-styled action bar appears with **Cancel N** (bulk `PATCH status→CANCELLED` via `Promise.all`) and **Delete N** (two-step: **Delete N** → inline **Confirm Delete / No**). Delete → `useBulkDeleteOrders` → `DELETE /orders/bulk {ids}`; the API only deletes **PENDING/CANCELLED** orders, so a partial result toasts "`X deleted, Y failed (only PENDING/CANCELLED orders can be deleted)`".
  - **Export** → `handleExport`: fetches up to **1000** rows honoring the current server filters (not the client search — search is re-applied client-side), `downloadCsv` with columns Order #, Customer, Items, Total, Status, Delivery Date, Created. Warns if `meta.total > 1000` ("Exported first 1000 rows — narrow filters…").
  - Data hook: `useOrders({status, urgent, deliveryDateFrom, deliveryDateTo, page, limit})` → `GET /orders`.
- **States:** loading (spinner row); error ("Failed to load orders. Please try again."); two empty states via `EmptyState variant="orders"` — filtered ("No matching orders" + **Clear filters**) vs virgin ("No orders yet" + **Create order**); select-mode action bar only when `selected.size > 0`.

### Order detail — `/orders/[id]`
- **File:** `apps/web/app/(dashboard)/orders/[id]/page.tsx`
- **Purpose:** Full order view with status transitions, an inline replace-nothing line-item editor (qty / substitute / price override / add / delete), invoice generation + send, split-invoice, and carrier shipment.
- **Shows:**
  - Back link **"Orders"**; header with `orderNumber`, an **URGENT** pill, **Created** date and a **Delivery:** pill.
  - **Status + action bar:** a `Badge` for the (locally-tracked) status plus status-specific buttons (see rules) and an **Edit Items** button on editable statuses.
  - **Line Items card** (read mode): a table **Product · Qty · Unit Price · Total · Status**. Qty renders boxed splits as `"2 boxes + 3 pcs"` (title tooltip = total pieces) or a flat number. Unit Price shows a price-type treatment: `SPECIAL` → struck original + green price + **Special** tag; `DISCOUNTED`/`MANUAL` (with `originalPrice`) → struck original + amber price + **Discounted**/**Adjusted** tag; else plain. Per-line **Total** uses `computeLineSubtotal` (boxed proration). Custom (unlisted, no `productId`) lines get a **Custom** tag. Footer **Order Total**.
  - **Sidebar:** **Customer** card (businessName, contactName, link to profile); **Summary** (delivery date, line items count, total qty, subtotal, tax, order total); **ShipmentCard** (carrier + tracking, save/clear); **Invoice(s)** card (lists linked invoices with status/due + view link; **Generate Invoice (full order)** when none exists; **Split into invoice…** when any line has remaining un-invoiced qty).
  - **Order Notes** card when notes exist (read mode).
- **Actions (status transitions → `useUpdateOrderStatus` → `PATCH /orders/:id/status {status, reason?}`):**
  - **DRAFT:** **Publish Order** (→PENDING), **Delete Draft** (inline confirm → `DELETE /orders/:id`). DRAFT orders **auto-enter edit mode** on load so items can be added immediately.
  - **PENDING:** **Confirm Order** (→CONFIRMED), **Cancel Order** (→`ConfirmDialog`), **Delete** (inline confirm).
  - **CONFIRMED:** **Out for Delivery** (→OUT_FOR_DELIVERY), **Unconfirm** (`window.confirm` →PENDING), **Return to Pending** (opens `DemoteReasonModal`, requires a reason), **Cancel Order**.
  - **OUT_FOR_DELIVERY:** **Mark as Delivered** (→DELIVERED then `useCreateInvoiceFromOrder` → opens `SendInvoiceModal`), **Return to Confirmed** (demote-reason modal), **Cancel Order**.
  - **DELIVERED:** **Reopen Order** (demote-reason modal →CONFIRMED).
  - **CANCELLED:** **Reopen Order** (`window.confirm` → `useReopenOrder` → `POST /orders/:id/reopen` →PENDING), **Delete** (inline confirm).
  - **Edit Items** (`enterEditMode`): `EditableLineItems` — per line a **qty** number input, **Substitute** (`SubstitutePicker` product search; replaces productId + resets price to the substitute's catalog price), **Not available** (marks `cancelled` → sends `action:"CANCEL"` on save), a **trash** (removes; existing saved lines queue `action:"DELETE"`, falling back to CANCEL if already invoiced), and a **PriceEditRow** on editable orders (see below). A dashed **Scan barcode or type name…** row auto-focuses on open, resolves scans (barcode → SKU exact → single search hit → else `InlineCreateProductModal` prefilled with the code), and dedups (re-adding an existing product bumps its qty). **Add custom item** inline form (name + unit price + qty). A live **Subtotal / Tax (%) / New total** preview mirrors the server. Save → `useUpdateOrderItems` → `PATCH /orders/:id/items {items, replaceAll:false}` (incremental diff — see rules). DRAFT edit mode shows **Save Draft** + **Publish Order** (saves items then →PENDING) + **Cancel**; non-draft shows **Save Changes** + **Cancel**.
  - **PriceEditRow** (per-line price editor): a **Unit price** `$` input and a synced **$ off / unit** input — both are lenses over one net `unitPrice`; setting off-amount = `basePrice − price`, clearing either reverts to `basePrice`. When overridden (`unitPrice < basePrice`), shows `was $X.XX` struck through and an optional **reason** text field. On save an overridden line sends `unitPrice` + `overrideReason`; `basePrice` = `originalPrice ?? unitPrice` from the loaded line.
  - **Generate Invoice (full order)** → `useCreateInvoiceFromOrder` → `POST /invoices/from-order/:id` (idempotent). **Split into invoice…** → `SplitInvoiceModal` (per-item qty allocation + terms/due; `POST /invoices/from-order/:orderId/partial`, increments `invoicedQty`).
  - **SendInvoiceModal** (after Mark Delivered, or manual): **Mark as Sent** (`useSendInvoice` → `POST /invoices/:id/send`), **Send via WhatsApp** (`wa.me` deep link, prefilled message), **Send via Email** (`useSendInvoiceEmail` → server email, only if `customer.email`), **Send via Text** (`sms:` link), **Download PDF** (two-step: `GET /invoices/:id/pdf` for a URL, then auth-fetch the bytes as a blob — a direct `window.open` 401s because the storage URL needs a JWT, RF-075).
  - **ShipmentCard** save/clear → `useUpdateOrderShipment` → `PATCH /orders/:id/shipment {shippingCarrier, shippingTrackingNumber}`.
  - Data hooks: `useOrder(id)`, `useCustomerPriceHistory(order.customerId)` (carry-forward prices for newly-added lines in edit mode).
- **States:** loading spinner; not-found ("Order not found." + Back); status locally tracked in `localStatus` for snappy transitions; `canEdit = DRAFT|PENDING|CONFIRMED` gates Edit Items and the per-line price editor; mutation buttons show `loading`; delete/cancel are confirmed inline or via `ConfirmDialog`; demotions require a typed reason.

### Create Order modal — `CreateOrderModal`
- **File:** `apps/web/app/(dashboard)/orders/_components/CreateOrderModal.tsx`
- **Purpose:** Take an order on behalf of a customer without leaving the list — customer search, catalog/scan product add, pricing tier, one-time discounts, unlisted lines, order-level discount, urgent flag, and the merge-vs-separate guard.
- **Shows:**
  - **Customer** section: search-by-business-name dropdown (debounced 300ms, top 8) → selected chip with **X** to change.
  - **Products** section: search-by-name/SKU/**scan** input (Enter routes through the barcode handler). Results list top-level products; **variants** expand inline (chevron; disabled/dimmed when already added). A **Create new product** row (opens `InlineCreateProductModal`; treats a 6+ digit query as a SKU). **Add custom item** inline form (name + unit price + qty).
  - **Line item rows:** catalog lines show the price with a **Special price** (emerald, permanent `CustomerPrice` tier) or **Discounted** (amber, one-time) treatment vs plain list price; a per-piece price hint for boxed products; a one-time **Price** input (only when not a permanent SPECIAL) with a **Last: $x** hint when price history is below list. Qty controls: for boxed products a **boxes** + **pcs** pair (pcs capped at `unitsPerBox − 1`, with "1 box = N pcs · {qty} pcs total") — otherwise a **−/+** stepper. Live **line total** via `computeLineSubtotal`. Unlisted rows have an editable name + price and a **Custom** tag.
  - **Order totals:** Subtotal, Tax (`settings.taxRate`), an **Order discount** input (`discountAmount`), Total.
  - **Options:** Requested Delivery Date (optional), Notes, **Mark as Urgent** checkbox.
  - Footer: **Cancel** (ghost) · **Save as Draft** (secondary) · **Create Order** (primary).
- **Actions:**
  - Tier resolution: `getTierPrice(product, effectiveTier)` where `effectiveTier` = per-product `CustomerPrice` tier override, else the customer's `pricingTier`. Tier ≠ 1 → `priceType:"SPECIAL"`.
  - Adding a product already present increments qty (supports repeated scans); scan re-focuses the search input for the next scan; `addLineItem` scrolls the touched row into view.
  - Scan flow (`barcodeScanHandlerRef`): `GET /products/barcode/:code` → search by SKU exact → first search hit → else open create-product modal prefilled with the scanned code as SKU.
  - **Save as Draft** (`onSaveDraft`, looser validation — items optional, sends `status:"DRAFT"`) and **Create Order** (`onSubmit`) both funnel through `submitOrder` → `useCreateOrder` → `POST /orders {customerId, items, notes, urgent, requestedDeliveryDate?, discountAmount?, status?, mergeChoice?}`.
  - **Merge guard:** if the customer already has a DRAFT/PENDING order (pre-checked via `useActiveOrderForCustomer` → `GET /orders/active`, **or** a 409 `MERGE_CHOICE_REQUIRED` at submit), an **"Open order exists"** modal forces **Merge into {orderNumber}** vs **Create as separate order/draft** — never silent. Item serialization only sends `unitPrice` for **one-time DISCOUNTED** lines (permanent SPECIAL prices are resolved server-side from `CustomerPrice`); boxed lines also send `{boxes, pieces}`; unlisted lines send `{name, qty, unitPrice}`.
- **States:** API error banner; per-section inline validation (customer required; ≥1 product for Create; qty > 0); everything resets on open; mutation buttons show `loading`.

### Scan-to-add order builder — `/invoices/new`  ⚠️ *confusingly named — builds orders*
- **File:** `apps/web/app/(dashboard)/invoices/new/page.tsx`
- **Purpose:** A basis-first "Create an invoice" flow that, for the **New sale** path, actually **creates an order and its invoice together** (`POST /orders/sell`). Named `/invoices/new` and titled "New Invoice", but the primary path is an order builder. (Distinct from `/invoices/create`, which bills an existing order — see catalogue item #5.)
- **Shows / Steps:**
  1. **`InvoiceBasisChooser`** — three cards: **Bill an existing order**, **New sale** (products now, delivered today or billed before delivery), and a subtle **Other charge** (a fee/correction with no order → standalone invoice).
  2. **Bill an existing order** (`ExistingOrderInvoiceFlow`) — pick a customer → `useUninvoicedOrders` lists orders with remaining qty → **Bill whole order** (`useCreateInvoiceFromOrder`) or **Choose items…** (`SplitInvoiceModal`). Navigates to `/invoices/{id}`.
  3. **New sale / Other charge** — a customer + line-item form. **New sale** has a **Going out today?** toggle (Yes = van/cash sale, order delivered + invoice issued now; No = PENDING order + draft invoice). A top-of-table **scan/search** input mirrors the order modal (barcode → SKU/name → create-product), a live suggestion dropdown ("Add →" / "Already added · +1"), per-row product search (`ProductSearchInput` with its own `BarcodeScannerButton`), qty/box controls, discount, **taxable** checkbox, an optional **avg-cost** display column (never submitted), Terms dropdown (drives due-date), issue/due dates, reference/subject, notes, terms text (prefilled from settings).
- **Actions:**
  - **New sale** submit → `useCreateSale` → `POST /orders/sell {customerId, items, deliveredNow, notes?, discountAmount?, send}`. Line total = `qty * unitPrice − discount` (this page uses per-piece math, **not** `computeLineSubtotal` — boxed `{boxes, pieces}` are passed through to the server which prorates).
  - **Standalone / Other charge** submit → `useCreateInvoice` → `POST /invoices` (no order).
  - **Preview** / **Download** → save a reusable draft (`currentDraftId`) then two-step PDF fetch (auth blob).
- **States:** basis screen first; lenient `validateForPreview` (customer + dates only); strict `validate` for finalize; empty rows stripped from preview/submit; toasts on success/failure.

### Returns list — `/returns`
- **File:** `apps/web/app/(dashboard)/returns/page.tsx`
- **Purpose:** Track and triage returns; open one; create a new return request against a delivered order.
- **Shows:** `PageHeader` **"Returns"** + **New Return**. Three **KPI cards** (Pending Review count, Total Return Value `Σ unitPrice*qty`, This Month count — from an unfiltered `useReturns({limit:500})` summary query). **Filter bar:** search (debounced), **status** select (`PENDING/APPROVED/IN_TRANSIT/RECEIVED/REFUNDED/REJECTED/CANCELLED`), **reason** select (`DAMAGED/WRONG_ITEM/EXCESS_ORDER/CUSTOMER_REFUSED/QUALITY_ISSUE`), Clear filters. **Table:** Return # · Customer · Order # · Date · Items · Reason · Status (`Badge`) · view Eye. Pagination (20/page).
- **Actions:** row click / Eye → `/returns/{id}`; **New Return** → `CreateReturnModal`. Data: `useReturns({status, reason, search, page, limit})`.
- **CreateReturnModal:** customer select (search) → **delivered** order select (`useOrders({customerId, status:"DELIVERED"})`) → reason → an **Items to Return** table auto-built from the order's line items (**unlisted lines with no `productId` are excluded — can't be returned**), each with a return-qty input capped at `orderedQty` + condition notes → general notes. Validation: customer/order/reason required, ≥1 item qty > 0, each `0 < qty ≤ orderedQty`. Submit → `useCreateReturn` → `POST /returns`.
- **States:** loading spinner; error (with **Try again**); filtered vs virgin empty state (`EmptyState variant="returns"`).

### Return detail — `/returns/[id]`
- **File:** `apps/web/app/(dashboard)/returns/[id]/page.tsx`
- **Purpose:** Drive a return through its status flow and settle it (credit note or refund).
- **Shows:** header `returnNumber` + status `Badge`; a **Detail card** (customer, order link, reason, submitted date, notes, items table: Product · Ordered Qty · Return Qty · Condition/Notes); sidebar **Status Timeline** (`PENDING → APPROVED → IN_TRANSIT → RECEIVED → REFUNDED`, with REJECTED/CANCELLED shown as a red terminal card) and a quick **Summary** (items, total return qty, reason).
- **Actions (status-gated):** **PENDING** → **Approve** (`useApproveReturn`, `ConfirmActionModal`) / **Reject** (`useRejectReturn`, danger confirm); **APPROVED** → **Mark In Transit** (`useMarkReturnInTransit`); **IN_TRANSIT** → **Mark Received** (`useMarkReturnReceived`); **RECEIVED** → **Issue Credit Note** (`useCreateCreditNote` → seeded from return total, routes to `/credit-notes`) or **Process Refund** (`ProcessRefundModal` with a **Restock returned items** checkbox → `useProcessRefund {id, restock}`); **REFUNDED/PROCESSED/REJECTED/CANCELLED** → terminal (italic status note only).
- **States:** loading; not-found ("Return not found." + Back); mutation `loading`; terminal statuses show no actions.

---

## Key flows (end-to-end)

- **Take a phone order (modal):** Orders **New Order** → search & pick customer → search/scan products (boxed items split into boxes + loose pcs; tier price auto-applies; enter a one-time discounted price if needed) → optional order discount, delivery date, notes, urgent → **Create Order** → merge-vs-separate prompt if the customer has an open order → `POST /orders` → back to list.
- **Take a sale that's going out now (`/invoices/new`):** Invoices → New → **New sale** → **Yes, delivered today** → scan/add products → **Save/Send** → `POST /orders/sell` (order marked delivered + invoice issued) → invoice detail.
- **Edit line prices before billing:** order detail → **Edit Items** → adjust qty / **Substitute** / set **Unit price** or **$ off / unit** with a reason / **Add custom item** / trash a line → live total updates → **Save Changes** (`PATCH /orders/:id/items replaceAll:false`).
- **Confirm & fulfil:** list (Pending view) → detail → **Confirm Order** → **Out for Delivery** → **Mark as Delivered** (auto-creates invoice, opens **SendInvoiceModal**: WhatsApp / Email / SMS / mark sent / PDF).
- **Bill an order in parts:** detail → **Split into invoice…** (or `/invoices/new` → Bill existing → Choose items…) → allocate per-item qty + terms/due → creates partial invoices, decrements remaining qty.
- **Process a return:** Returns → **New Return** (delivered order → items + reason) → detail → **Approve** → **Mark In Transit** → **Mark Received** → **Process Refund** (optionally restock) or **Issue Credit Note**.

## Use cases

- As an operator, I want saved status views + a shareable URL filter so I can jump straight to Pending/Urgent orders. (path: Orders list)
- As an operator, I want urgent orders pinned to the top no matter how I sort so I never miss a rush order. (path: Orders list)
- As an operator, I want to bulk-cancel or bulk-delete stale orders, knowing only PENDING/CANCELLED can be hard-deleted. (path: Orders list select mode)
- As an operator, I want to give a customer a one-time per-line discount (net price + reason) that carries forward next time, without touching the catalog. (path: order detail Edit Items / Create Order modal)
- As an operator, I want to split a boxed product into whole boxes + loose pieces and have the total prorate correctly. (path: Create Order modal / `/invoices/new`)
- As an operator, I want an explicit merge-vs-separate choice when a customer already has an open order so I never double-ship or silently merge. (path: Create Order modal)
- As an operator, I want to record a van/cash sale (order + invoice in one shot) by scanning items. (path: `/invoices/new` New sale)
- As an operator, I want to walk a return from request to refund/credit and optionally restock. (path: Returns detail)

## Business rules & edge cases

- **Money discipline.** Live line totals in the modal, order-detail read table, and edit-mode preview use `computeLineSubtotal` (`apps/web/lib/pricing.ts`): boxed products (`unitsPerBox > 1`) treat `unitPrice` as the **box price** and prorate loose pieces (`box + pieces/upb`); never `qty * unitPrice` for a boxed line. `roundMoney` rounds every displayed amount to cents. Locked by `e2e/06-critical-paths.spec.ts` CP-02/CP-05 (list + API `$X.XX`) and CP-06 (order-detail totals well-formed). **Exception:** `/invoices/new` computes its line total as `qty*unitPrice − discount` per-piece (boxed `{boxes,pieces}` are passed to the server, which prorates authoritatively).
- **Line-discount / override convention.** An override is stored as a **net `unitPrice`** plus the list price as `originalPrice` (rendered struck-through) — the API sets `priceType` to `DISCOUNTED`/`MANUAL`/`SPECIAL`. The UI **never re-derives a discount from originalPrice** (would double-count). In `PriceEditRow`, "Unit price" and "$ off / unit" are two lenses over the same net price; `basePrice = originalPrice ?? unitPrice`. In the create modal, `unitPrice` is only sent for a **one-time DISCOUNTED** line — permanent **SPECIAL** (tier) prices resolve server-side from `CustomerPrice`, so sending them would be redundant.
- **Price carry-forward.** `useCustomerPriceHistory` (`GET /orders/price-history?customerId`) is fetched once on customer/order load; a newly added or scanned line pre-fills the remembered `lastPrice` **only when it is below** the current tier/catalog price (increases never auto-apply). Shown as "Last: $x".
- **Which statuses lock editing/deletion.** Edit Items + per-line price editing are gated to **DRAFT / PENDING / CONFIRMED** (`canEdit`), mirroring the API `updateOrderItems` guard; OUT_FOR_DELIVERY/DELIVERED/CANCELLED are read-only. Bulk **delete** and single delete only succeed on **PENDING/CANCELLED** (API-enforced; partial failures reported). Status transitions are computed per current status; demotions (Return to Pending/Confirmed, Reopen) require a typed reason via `DemoteReasonModal`; Cancel uses `ConfirmDialog`; Unconfirm/CANCELLED-reopen use `window.confirm`.
- **Incremental item save.** `PATCH /orders/:id/items` is sent with **`replaceAll:false`** so an add-only payload isn't treated as a full replace (which would delete untouched lines). New catalog lines have no `id` (API creates them); trashed existing lines send `action:"DELETE"` (hard-delete if uninvoiced, else CANCEL); substitutes send `substituteProductId`; unchanged lines are omitted. An empty `updates` array short-circuits (no request).
- **Merge guard.** Creating an order for a customer with an existing DRAFT/PENDING order forces an explicit **Merge / Create separate** choice — surfaced proactively (`GET /orders/active`) or reactively (409 `MERGE_CHOICE_REQUIRED`). The chosen `mergeChoice` is re-sent with the stashed form values; works for both Create Order and Save as Draft.
- **Box/piece integers.** In the create modal, loose **pieces** are capped at `unitsPerBox − 1` and `qty = boxes*upb + pieces` is authoritative; the shared `normalizeBoxesPieces` (mirrored in `pricing.ts`) forces integer boxes/pieces and rolls overflow pieces into boxes. Order-detail edit mode uses a single integer qty input (no box/piece split there).
- **Custom / unlisted lines.** Free-text `name` + required per-piece `unitPrice`, never boxed, `productId` null → serialized `{name, qty, unitPrice}`. Rendered with a **Custom** tag. Unlisted lines **cannot be returned** (excluded from `CreateReturnModal`).
- **Scan resolution order (all three builders).** barcode field (`GET /products/barcode/:code`) → product search with **exact SKU** match → single search hit (create modal also opens the dropdown on >1) → else open `InlineCreateProductModal` prefilled with the scanned code as SKU. After add, the input re-focuses and the touched row auto-scrolls into view. Handles both keyboard-emulation and paste-mode scanners (fires on **Enter**).
- **Invoice PDF auth.** PDFs are fetched two-step (`GET /invoices/:id/pdf` → URL → auth-fetch bytes → blob URL). A direct `window.open` of the storage URL 401s (JWT required, RF-075).
- **Returns flow.** Only **delivered** orders are selectable for a new return; per-item return qty is capped at ordered qty. Status flow `PENDING→APPROVED→IN_TRANSIT→RECEIVED→REFUNDED` with REJECTED/CANCELLED terminals; settlement from RECEIVED is either a credit note (seeded from return total, amount editable before issuing) or a refund (with optional restock).
- **Carrier shipment vs own route.** The order-detail **ShipmentCard** records an external carrier + tracking number — separate from delivery via the tenant's own routes/runs (dispatch area).

## Relevant files

- `apps/web/app/(dashboard)/orders/page.tsx` — orders list (saved views, filters, bulk ops, CSV export, sort).
- `apps/web/app/(dashboard)/orders/[id]/page.tsx` — order detail, `PriceEditRow`, `EditableLineItems`, `SendInvoiceModal`, `DemoteReasonModal`, `SubstitutePicker`, status transitions.
- `apps/web/app/(dashboard)/orders/_components/CreateOrderModal.tsx` — create-order modal + merge guard.
- `apps/web/app/(dashboard)/orders/_components/SplitInvoiceModal.tsx` — split-into-invoices (referenced by detail + `/invoices/new`).
- `apps/web/app/(dashboard)/invoices/new/page.tsx` — basis chooser + scan-to-add order/sale builder (**confusingly named**).
- `apps/web/app/(dashboard)/returns/page.tsx`, `returns/[id]/page.tsx` — returns list + detail.
- `apps/web/lib/api/orders.ts` — `useOrders`, `useOrder`, `useUpdateOrderStatus/Items`, `useReopenOrder`, `useDeleteOrder`, `useBulkDeleteOrders`, `useUpdateOrderShipment`, `useCreateSale`, `useUninvoicedOrders`, `useActiveOrderForCustomer`, `useCustomerPriceHistory`.
- `apps/web/lib/api/returns.ts`, `apps/web/lib/api/invoices.ts`, `apps/web/lib/api/credit-notes.ts` — return/invoice/credit-note mutations.
- `apps/web/lib/pricing.ts` — `computeLineSubtotal`, `roundMoney`, `normalizeBoxesPieces`, `getTierPrice`.
- `apps/web/components/BarcodeScannerButton.tsx`, `apps/web/components/InlineCreateProductModal.tsx`, `apps/web/components/ShipmentCard.tsx`, `apps/web/lib/export.ts`, `apps/web/lib/product-display.ts`, `apps/web/lib/hooks/useUrlFilters.ts`.
- Specs: `apps/web/e2e/02-operator.spec.ts` (OP-04 list search, OP-05 status filter, OP-12 returns list), `apps/web/e2e/06-critical-paths.spec.ts` (CP-02 order-list money, CP-05 orders API money, CP-06 order-detail money).

---

## 💡 Faster ways
*(improvement ideas — quarantined from the inventory above; nothing here is built yet)*

- **Rename / merge the `/invoices/new` order builder.** The route is titled "New Invoice" but its main path (`New sale`) creates an **order + invoice** via `POST /orders/sell`, and it duplicates `CreateOrderModal`'s scan/search/box-split UI in a slightly different (non-`computeLineSubtotal`) implementation. Redesign should either (a) fold "New sale" into the Create Order flow and keep `/invoices/new` only for existing-order + standalone billing, or (b) rename it "New sale" and route it under Orders. Resolves catalogue item #5 and eliminates the second, drifting line-math implementation. **Flagged finding — see summary.**
- **One order-entry surface, not three.** Line-item entry is implemented three times (`CreateOrderModal`, order-detail `EditableLineItems`, `/invoices/new`) with subtly different qty controls (box/piece split exists in two, a plain qty input in the third) and price treatments. Extract a shared `<OrderLineEditor>` so box-splitting, price-override, scan-resolution, and carry-forward behave identically everywhere.
- **Quick reorder / duplicate.** No "reorder" or "duplicate order" action exists — a common wholesale need. A **Reorder** button on order detail (and a row action) that seeds `CreateOrderModal` with the prior lines (and remembered prices) would cut repeat-order entry to one click.
- **Keyboard-driven line entry.** The edit-mode and modal scan inputs already accept Enter; add explicit arrow-key navigation of the suggestion dropdown, a visible keyboard hint, and Tab-to-qty so a whole order can be entered without the mouse. Pair with a global **Cmd/Ctrl+K** to open Create Order.
- **Unify list polish.** The Orders list has sortable headers, a per-page selector, and a rich `EmptyState`; the Returns list lacks sortable headers and a per-page selector and hand-rolls its empty state. Standardize both on the same table/empty/pagination kit (catalogue item #7).
- **Persist sort + surface server-side sort.** Orders sorting is client-side over the current page only, so sorting a 20-row page doesn't sort the whole result set — misleading with pagination. Push sort to the API (`GET /orders?sort=`) and persist the choice in the URL like the filters.
