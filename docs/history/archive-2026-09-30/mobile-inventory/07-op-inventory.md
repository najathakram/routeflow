## 7. Operator — Warehouse & Inventory: Products, Stock, Purchase Orders, Returns, Tobacco

**Role(s):** Operator (warehouse / back-office staff). Everything is tenant-scoped via JWT (`tenantId`/`role`); tobacco screens additionally require the tenant's `tobacco_dealer` add-on. • **Entered via:** The **Warehouse** bottom tab (business icon) is the hub. The **More** tab (`(operator)/(tabs)/more.tsx`) links out to Products (`OPERATIONS` group, "Products · Catalog & stock"), Shipments ("Shipments · Carrier tracking"), Returns ("Returns · Approvals & credits"), Purchase Orders ("Purchase Orders · Restock & receive inventory"), Pick & load (`WAREHOUSE` group, "Pick & load · Warehouse scanning (coming soon)"), and — only when the tobacco add-on is enabled — Tobacco ("Tobacco · Compliance tracking & monthly reports", `INSIGHTS` group). Movements is reached from a product's detail page; the barcode scanner is reachable from nearly every list via a nav icon or the draggable FAB.

This area is the operator's inventory backbone: maintaining the product catalog, tracking on-hand stock and its money value (weighted-average cost), running purchase orders from draft through receipt, processing customer returns, monitoring carrier shipments, and (add-on) tobacco dealer compliance reporting. Barcode scanning is woven through every entry point.

### Screens

#### Products list — `/(operator)/products`

- **File:** `apps/mobile/app/(operator)/products/index.tsx`
- **Purpose:** Searchable, stock-status-filtered catalog list.
- **Shows:** Large title "Products". Per-row card: product `name`; a sub-line of `SKU <sku>` (or `BC <barcode>` if no SKU, or "No SKU") · `unit` · `$<pricePerUnit>` (2dp); right-aligned on-hand qty with `/ <reorderPoint>` when set; a thin `ProgressTrack` bar (stock ÷ reorder threshold, capped 100%) colored red/orange/brand; and a status `Pill` — **Out** (stock ≤ 0, red), **Low** (0 < stock ≤ threshold, orange), or **Inactive** (gray, when `!isActive`). Default threshold when `reorderPoint` is null is 5.
- **Actions:** Barcode nav icon → `/(operator)/products/scan`. "Add" (bold) → `/(operator)/products/new`. `SearchBar` "Search name, SKU, barcode…" → refetches `useAdminProducts({ search, stockStatus, limit:100 })` = `GET /products`. `FilterChipRow` All / In stock / Low / Out → sets `stockStatus` (undefined | IN_STOCK | LOW | OUT_OF_STOCK). Row tap → `/(operator)/products/${id}`. Empty-state "Add product" button → `/(operator)/products/new`. Back → `router.back()`.
- **States:** **loading** (centered spinner); **empty** ("No products yet." / "No products match." when searching, plus an Add-product CTA); **pull-to-refresh** (`RefreshControl`, refreshing while `isFetching && !isLoading`).

#### New product — `/(operator)/products/new`

- **File:** `apps/mobile/app/(operator)/products/new.tsx` (thin wrapper around `ProductForm`)
- **Purpose:** Create a product; optionally pre-fills barcode from a scan.
- **Shows:** Renders `<ProductForm title="New product">` (see ProductForm below). If routed with a `barcode` param (from the scan flow), the Barcode field is prefilled.
- **Actions:** Submit "Save" → `useCreateProduct` = `POST /products` with the product DTO (name, sku, barcode, category, unit, unitsPerBox, description, pricePerUnit, standardCost, currentStock, isActive). On success it fires a **separate** `useUpdateReorderSettings` = `PATCH /inventory/products/:id/reorder-settings` (fire-and-forget, only if reorderPoint/reorderQty were entered), toasts "Product created", then `router.replace('/(operator)/products/${res.id}')`.
- **States:** submit label switches to "Saving…" while `mut.isPending`; validation errors render inline in ProductForm; API errors surface as a toast.

#### Create alias — `/(operator)/products/create`

- **File:** `apps/mobile/app/(operator)/products/create.tsx`
- **Purpose:** Route guard (RF-203). Re-exports `./new`. On web, a `/products/create` URL would otherwise fall through to the `[id]` segment, treat "create" as a product ID, 404, and spin forever. This static file intercepts it and renders the New Product form with no fetch.
- **Shows / Actions / States:** Identical to New product.

#### Product detail — `/(operator)/products/[id]`

- **File:** `apps/mobile/app/(operator)/products/[id].tsx`
- **Purpose:** Read-only overview of one product with quick links to edit, set-cost, adjust-stock, and (add-on) tobacco flagging.
- **Shows:** Inline title "Product". **Header card:** `name` (large), optional `description`, and pills — Out of stock / Low stock (mutually exclusive), Inactive, and a brand `category` pill. **Details card:** SKU, Barcode, Unit (defaults "ea"), Price (`$` 2dp). Cost line uses the **effective cost** = `standardCost ?? averageCost`; if neither set, shows a "No cost set" amber chip. When cost exists it shows Cost (`$` 2dp) and a **Margin %** chip = `round((price−cost)/price*100)` colored green (≥25%) / orange (≥10%) / red (<10%). **Stock card:** On hand (`<stock> <unit>`), Reorder at, Reorder qty (each only if set). **Recent movements card** (only if movements exist): up to 10 rows of `type`, date + notes, and signed `+/-quantity` colored green/red.
- **Actions:** "Edit" (bold) → `/(operator)/products/${id}/edit`. Details card "Set cost" link → `/(operator)/products/${id}/set-cost`. Stock card "Adjust" link → `/(operator)/products/${id}/adjust-stock`. **Tobacco toggle** (only when `useHasAddon(TOBACCO_ADDON)`): "Mark as tobacco product" / "Unmark tobacco product" → `useUpdateProduct` = `PATCH /products/:id` `{ isTobacco: !current }`, toasts accordingly. "Delete product" → `confirm(...)` then `useDeleteProduct` = `DELETE /products/:id`, toast "Product deleted", `router.back()`.
- **States:** **loading** (spinner under a "Product" nav bar) — shown while `isLoading || !product`; **defensive redirect** (RF-203): if `id === "create"` or `"new"`, `router.replace('/(operator)/products/new')` and no fetch fires; **addon-gated** (tobacco toggle hidden unless add-on present); mutation-pending disables the tobacco/delete buttons.

#### Edit product — `/(operator)/products/[id]/edit`

- **File:** `apps/mobile/app/(operator)/products/[id]/edit.tsx` (wrapper around `ProductForm`)
- **Purpose:** Edit an existing product.
- **Shows:** `<ProductForm title="Edit product">` seeded via `productFormFromValues(product)` (maps `standardCost ?? costPerUnit`, stringifies numbers).
- **Actions:** "Save" → `useUpdateProduct` = `PATCH /products/:id` with the product DTO (reorder fields stripped out), then a separate `useUpdateReorderSettings` = `PATCH /inventory/products/:id/reorder-settings` if reorder values present; toast "Saved"; `router.back()`.
- **States:** **loading** (spinner) while product loads; "Saving…" label while pending; inline validation + error toast.

#### Set cost basis — `/(operator)/products/[id]/set-cost`

- **File:** `apps/mobile/app/(operator)/products/[id]/set-cost.tsx` (uses `FormSheet`)
- **Purpose:** Set/override the audited weighted-average cost basis for one product.
- **Shows:** Modal FormSheet titled "Set cost basis", subtitle = product name. "Current average cost" row = `$<averageCost>` to **4 decimals** (or "No cost set"). "Cost per unit ($)" input (hint "What one unit costs you to buy.", placeholder "0.0000", decimal keypad). Options: "Also rewrite open stock lots" switch (hint "For FIFO/LIFO products only.") and a Notes textarea. Footer help: "Recorded as an audited COST_BASIS movement. Future purchases keep updating the average from here."
- **Actions:** "Set cost" → validates cost is finite ≥ 0 → `useSetCostBasis` = `PATCH /inventory/products/:id/cost-basis` `{ unitCost, notes?, applyToLots? }`, toast "Cost basis set", `router.back()`.
- **States:** validation toast if cost invalid; "Saving…" label while pending; error toast on failure.

#### Adjust stock — `/(operator)/products/[id]/adjust-stock`

- **File:** `apps/mobile/app/(operator)/products/[id]/adjust-stock.tsx` (uses `FormSheet`)
- **Purpose:** Apply a signed stock delta with an audited reason.
- **Shows:** FormSheet "Adjust stock", subtitle = product name. "Current stock" row = `<currentStock> units`. Quantity field "Change (+/−)" with a −/input/+ stepper (numbers-and-punctuation keypad so negatives are typable). **Reason** chips: Received / Damaged / Count correction / Waste / Other (default **COUNT**). Notes textarea. Footer help: "Adjustments are logged as stock movements."
- **Actions:** "Apply" → validates delta is finite and ≠ 0 → `useAdjustProductStock` = `POST /inventory/movements/adjustment` `{ productId, quantity, reference: reason, notes }`. RF-201: the selected reason chip is joined into notes (`"<reason> — <freetext>"`) so the audit trail is always populated. Toast "Stock added"/"Stock removed"; `router.back()`.
- **States:** validation toast on zero/invalid delta; "Saving…" while pending; error toast on failure.

#### Scan product (barcode) — `/(operator)/products/scan`

- **File:** `apps/mobile/app/(operator)/products/scan.tsx` (renders `BarcodeScanner`)
- **Purpose:** Full-screen camera scan that resolves a code to a product or bounces to create.
- **Shows:** Full-screen `BarcodeScanner` — camera view with a dark surround, a centered ~70%-width square scan window, "Align barcode within the box" hint, and a top-right close button. A "Looking up…" pill overlays while resolving.
- **Actions:** On scan → `resolveProductByCode(code)` (`lib/barcode-resolve.ts`) which tries the ladder: `GET /products/barcode/<code>` → `GET /products?search=<code>` exact-SKU → first search hit. If **found**, `router.replace('/(operator)/products/${id}')`; if **not found**, `router.replace('/(operator)/products/new', { barcode: code })` to create with the code prefilled. Close → `router.back()`.
- **States:** **camera-permission gate** (permission box "Camera Access Required" with Grant Access / Cancel); **busy** ("Looking up…" overlay, ignores repeat scans); **error** (toast "Couldn't look up barcode. Try again." for non-404 / network errors, then re-enables scanning). Barcode types supported: ean13, ean8, code128, qr, upc_a, upc_e, code39.

#### Adjust stock picker — `/(operator)/products/adjust-picker`

- **File:** `apps/mobile/app/(operator)/products/adjust-picker.tsx`
- **Purpose:** Find a product (search or scan) then jump into its adjust-stock screen. This is the Warehouse "Adjust" quick-action target.
- **Shows:** Inline title "Adjust stock". `SearchBar` "Search by name or SKU…" with a trailing barcode icon. Per-row: `name`, `SKU <sku>` (or "No SKU") · `unit`, a brand stock pill (numeric on-hand), chevron. Uses `useAdminProducts({ search, limit:0 })` — `limit:0` returns everything matching so any SKU is findable.
- **Actions:** Row tap → `/(operator)/products/${id}/adjust-stock`. Trailing barcode icon or the draggable `BarcodeFab` → open `BarcodeScanner`; on scan → `resolveProductByCode` → jump to that product's adjust-stock, else toast `No product for "<code>"`. Back → `router.back()`.
- **States:** **loading** (spinner); **empty** ("No products yet." / "No matches." while searching); scanner overlay when open; FAB hidden while the inline scanner is open.

#### Warehouse (tab) — `/(operator)/(tabs)/warehouse`

- **File:** `apps/mobile/app/(operator)/(tabs)/warehouse.tsx`
- **Purpose:** Stock-health dashboard: valuation KPIs, tappable stock-status filters, low/out lists, and warehouse quick-actions.
- **Shows:** Large title "Warehouse", eyebrow "STOCK & LOW-STOCK". **KPI cards (4):** Low stock (count = server LOW total − OUT total), Out of stock (server OUT total), Inventory value (`$<valuation.totalValue>` rounded to whole dollars; label switches to "Value · <n> no cost" when `missingCostCount > 0`), SKUs tracked (all-products total). A 5th purple card toggles the "active-only" refinement — "Low & active" or "OOS & active". Below: an optional "Filtering: …" banner, a **quick-actions row** (Orders / Buy stock / Movements / Adjust), a section header, and a list of low/out products with `name`, `<stock> / <reorderPoint>`, a colored `ProgressTrack`, and `SKU/barcode · unit`.
- **Actions:** Barcode nav icon → `/(operator)/products/scan`. "All" → `/(operator)/products`; "Add" → `/(operator)/products/new`. Low-stock KPI toggles filter LOW↔ALL; Out-of-stock KPI toggles OUT_OF_STOCK↔ALL; purple KPI toggles the active-only variant; "Filtering" banner clears back to ALL. Quick-actions: **Orders** → `/(operator)/orders`; **Buy stock** → `/(operator)/vendor-bills/new` (has a TODO to become a picker: Scan bill / Enter manually / View all); **Movements** → `/(operator)/products` (note: this quick-action currently routes to Products, not the movements log); **Adjust** → `/(operator)/products/adjust-picker`. Product row → `/(operator)/products/${id}`. Data via `useInventoryValuation` (`GET /inventory/valuation`) + several `useAdminProducts` queries.
- **States:** **loading** (spinner); **empty** section text varies by filter ("No products configured." / "No matches for that search." / "No out-of-stock items." / "All stock levels healthy."); active-filter banner when a filter is engaged. No pull-to-refresh here.

#### Stock movements log — `/(operator)/movements`

- **File:** `apps/mobile/app/(operator)/movements.tsx`
- **Purpose:** Chronological audit log of all stock movements, filterable by type / product.
- **Shows:** Inline title "Stock movements". `SearchBar` "Filter by product name…" (client-side filter on `productName`) with trailing barcode icon. Optional "Showing: <product>" banner when a product filter is active. `FilterChipRow`: All / Received / Sold / Adjusted / Returned / Cost set (maps to type PURCHASE / SALE / ADJUSTMENT / RETURN / COST_BASIS). Per-row: `productName`, a meta line of date (Mon D, h:mm) · reference · notes, a signed quantity colored green(+)/red(−), and a dotted type `Pill`. **COST_BASIS rows** show `$<unitCost>` instead of a quantity (they move no stock). Data via `useInventoryMovements({ type, productId, limit:100 })` = `GET /inventory/movements`.
- **Actions:** Filter chips set `type`; barcode icon or the draggable `BarcodeFab` opens the scanner → `resolveProductByCode` → sets the product filter (or toasts `No product for "<code>"`); tapping the "Showing:" banner clears it. Back → `router.back()`.
- **States:** **loading** (spinner); **empty** ("No stock movements yet."); scanner overlay; the query `.catch` returns `{ data: [], meta:{total:0} }` so a fetch failure degrades to the empty state rather than an error screen.

#### Purchase orders list — `/(operator)/purchase-orders`

- **File:** `apps/mobile/app/(operator)/purchase-orders/index.tsx`
- **Purpose:** List POs with All / Open / Received filters.
- **Shows:** Large title "Purchase Orders". Per-row card: `poNumber`; sub-line `supplier.name` · "Expected <date>" (if set); a dotted status `Pill` — Draft (gray) / Sent (orange) / Partial (brand) / Received (green) / Closed (gray); footer with total (`$` from `totalAmount`, else computed `Σ qtyOrdered × unitCost`) and `<n> item(s)`.
- **Actions:** "+ New" (bold) → `/(operator)/purchase-orders/new`. Filter chips All / Open / Received: **All/Received** → `usePurchaseOrders(status?)` = `GET /inventory/purchase-orders`; **Open** → `useOpenPurchaseOrders()` which fans out three parallel calls (DRAFT, SENT, PARTIALLY_RECEIVED) and merges/sorts by createdAt desc. Row → `/(operator)/purchase-orders/${id}`. Back → `router.back()`.
- **States:** **loading** (spinner); **empty** ("No purchase orders"); **pull-to-refresh** (`RefreshControl`).

#### New purchase order — `/(operator)/purchase-orders/new`

- **File:** `apps/mobile/app/(operator)/purchase-orders/new.tsx` (uses `FormSheet` + `OptionPickerSheet` + product-picker store)
- **Purpose:** Create a multi-line PO against a supplier.
- **Shows:** FormSheet "New Purchase Order". **Supplier** picker row ("Select supplier…") backed by `OptionPickerSheet`. **Details:** Expected date (hint "Format: YYYY-MM-DD"), Notes. **Items:** repeatable blocks — "Item N" with a Product picker row (chevron), Qty ordered, Unit cost ($). "+ Add item" / per-item "Remove".
- **Actions:** Supplier field opens the picker sheet (`useSuppliers` = `GET /inventory/suppliers`); on focus, suppliers are refetched and — if none selected yet — the newest supplier is auto-selected. Product picker → `/(operator)/purchase-orders/pick-product?callbackKey=<pickerKey>`; the selection returns via `useProductPickerStore` and **auto-fills Unit cost from the product's `standardCost`**. "Create PO" validates a supplier and ≥1 product each with qty > 0 → `useCreatePO` = `POST /inventory/purchase-orders` `{ supplierId, items:[{productId, qtyOrdered, unitCost}], expectedDate?, notes? }`, then `router.replace('/(operator)/purchase-orders/${result.id}')`.
- **States:** validation toasts ("Please select a supplier." / "Add at least one product." / "Each item needs a quantity greater than 0."); "Creating…" label while pending; error toast on failure.
- **Steps:** 1) pick supplier → 2) add item(s), pick each product (unit cost auto-fills) → 3) enter qty/cost → 4) Create PO → lands on the PO detail.

#### Purchase order detail — `/(operator)/purchase-orders/[id]`

- **File:** `apps/mobile/app/(operator)/purchase-orders/[id].tsx`
- **Purpose:** View one PO and drive its lifecycle (send → receive → close).
- **Shows:** Inline title = `poNumber`. Header card: status `Pill` (Draft/Sent/Partially Received/Received/Closed), supplier name (large), "Expected <date>", italic notes. **Receipt-progress card** (when anything ordered): "Items received" `<received> / <ordered>` with a fill bar. **Items card:** per line — product name, "Ordered: X · Received: Y · Remaining: Z", `$<unitCost> / unit`, line subtotal; plus a **Total** row (`totalAmount` or computed sum).
- **Actions:** **Receive Items** button (only when status SENT or PARTIALLY_RECEIVED) → `/(operator)/purchase-orders/${id}/receive`. **Send to Supplier** (only DRAFT) → confirm → `useSendPO` = `POST /inventory/purchase-orders/:id/send`, toast "PO sent to supplier". **Close PO** (only RECEIVED) → confirm ("cannot be undone", destructive) → `useClosePO` = `POST /inventory/purchase-orders/:id/close`, toast "PO closed". Back → Purchase Orders list.
- **States:** **loading** (spinner under a "Purchase Order" bar); **status-gated action buttons** (each appears only for its eligible status; buttons show "Sending…"/"Closing…" while pending). Confirmation dialogs for send/close.

#### Receive PO items — `/(operator)/purchase-orders/[id]/receive`

- **File:** `apps/mobile/app/(operator)/purchase-orders/[id]/receive.tsx` (uses `FormSheet`)
- **Purpose:** Enter received quantities per line to book stock in.
- **Shows:** FormSheet "Receive Items", subtitle = `poNumber`. One qty input per PO line, each **pre-seeded to the remaining qty** (`max(0, ordered − received)`), with hint "Ordered: X · Previously received: Y · Remaining: Z". Notes textarea.
- **Actions:** "Confirm receipt" requires ≥1 positive qty → `useReceivePO` = `POST /inventory/purchase-orders/:id/receive` `{ items:[{itemId, qtyReceived}], notes? }`, toast "Items received", `router.back()`. Receiving updates stock and the weighted-average cost via the movements pipeline.
- **States:** validation toast ("Enter a quantity for at least one item."); "Saving…" label while pending; error toast.

#### Pick product (PO line picker) — `/(operator)/purchase-orders/pick-product`

- **File:** `apps/mobile/app/(operator)/purchase-orders/pick-product.tsx`
- **Purpose:** Search-select a product for a PO line; returns the choice to New-PO via the picker store.
- **Shows:** Inline title "Select product". `SearchBar` "Search products…". `useAdminProducts({ isActive:true, limit:200, search })`. Per-row: `name` and a `SKU <sku> · $<standardCost> · <unit>` sub-line (parts omitted when null), chevron.
- **Actions:** Row tap → `useProductPickerStore.setSelection(callbackKey, { id, name, standardCost })` then `router.back()` (New-PO reads this and auto-fills unit cost). Cancel (back) → `router.back()`.
- **States:** **loading** (spinner); **empty** ("No active products." / "No products match.").

#### Quick receive (record purchase) — `/(operator)/purchase-orders/record`

- **File:** `apps/mobile/app/(operator)/purchase-orders/record.tsx` (uses `FormSheet` + `OptionPickerSheet`)
- **Purpose:** Single-line stock receipt without a formal PO (books stock + updates weighted-average cost directly).
- **Shows:** FormSheet "Quick Receive". Product picker ("Select product…", chevron). Qty received + Unit cost ($) side by side. Optional section: Supplier picker (nullable, "None"), Reference ("Invoice #, delivery note…"), Notes.
- **Actions:** "Record receipt" validates a product and qty > 0 → `useRecordPurchase` = `POST /inventory/movements/purchase` `{ productId, quantity, unitCost, supplierId?, reference?, notes? }`, toast "Stock received", `router.back()`. Product/supplier options from `useAdminProducts` / `useSuppliers`.
- **States:** validation toasts ("Please select a product." / "Enter a quantity greater than 0."); "Recording…" label while pending; error toast.

#### Returns list — `/(operator)/returns`

- **File:** `apps/mobile/app/(operator)/returns/index.tsx`
- **Purpose:** Review and action customer returns inline (approve / reject / mark received).
- **Shows:** Large title "Returns". `FilterChipRow`: All / Pending / Approved / Cancelled (RF-212: default **All** so existing returns are visible — was previously PENDING and looked empty). Per-row card: `returnNumber`; sub-line `customer.businessName` · "Order <orderNumber>"; a dotted status `Pill` — Pending (orange) / Approved (brand) / In transit (brand) / Processed (green) / Cancelled (gray); a 2-line item summary `<qty> × <product name> · …`; and a humanized `reason` (underscores→spaces, lowercased). Data via `useAdminReturns({ status, limit:100 })` = `GET /returns`.
- **Actions (status-gated, inline):** For **PENDING** rows: **Approve** → `useApproveReturn` = `POST /returns/:id/approve` (toast "Return approved"), and **Reject** → confirm (destructive) → `useRejectReturn` = `POST /returns/:id/reject` (toast "Return rejected"). For **APPROVED / IN_TRANSIT** rows: **Mark received** → `useReceiveReturn` = `POST /returns/:id/receive` (toast "Marked received"). Each mutation refetches the list. Back → `router.back()`.
- **States:** **loading** (spinner); **empty** ("No returns to process."); **pull-to-refresh** (`RefreshControl`); action buttons appear only for eligible statuses (Processed/Cancelled show none — effectively terminal/read-only). Reject uses a destructive confirm dialog.

#### Tobacco compliance — `/(operator)/tobacco`

- **File:** `apps/mobile/app/(operator)/tobacco/index.tsx`
- **Purpose:** Add-on-gated dashboard for tobacco-dealer compliance: monthly KPIs, generatable/shareable monthly reports, and the flagged-inventory list.
- **Shows (when enabled):** Inline title "Tobacco". **This-month KPIs (4):** Purchases (month) `$`, Sales `$` with "· $<tax> tax" label, Flagged products count, Tobacco stock value `$`— from`useTobaccoOverview`=`GET /tobacco/overview`. **MONTHLY REPORTS** group: "Last completed month: YYYY-MM" with a Generate button; a list (up to 12) of report rows showing period `YYYY-MM`, and for GENERATED reports "Sales $ · Tax $ (· regen ×N)" with a document icon + chevron, or the failure/error message with a red alert icon. **TOBACCO INVENTORY** group: rows of flagged products (`name`, `<currentStock> <unit> · $<totalValue>`), each tappable to the product page, with a "No cost" orange pill when `averageCost` is null.
- **Actions:** **Generate** → `useGenerateTobaccoReport` = `POST /tobacco/reports/generate` `{ year, month }` (previous UTC month), toast "Report YYYY-MM generated". Tapping a GENERATED report → `fetchTobaccoReportUrl(id, "pdf")` (`GET /tobacco/reports/:id/pdf`) then `sharePdf(...)` (native share sheet). Inventory row → `/(operator)/products/${id}`. Back → "More".
- **States:** **addon-gated:** when `useHasAddon(TOBACCO_ADDON)` is false, the whole screen is a shield-icon empty state — "Tobacco compliance is not enabled / Ask your platform administrator to enable the Tobacco Dealer Compliance add-on." **loading** (spinner); **empty reports** ("No reports yet."); **empty inventory** ("No products flagged as tobacco yet — flag them from a product page."); FAILED report rows are non-tappable and show the error; Generate button shows a spinner while pending; share failures toast "Could not share the report."

#### Shipments — `/(operator)/shipments`

- **File:** `apps/mobile/app/(operator)/shipments.tsx`
- **Purpose:** List invoices that shipped via a carrier (have a tracking number).
- **Shows:** Large/inline title "Shipments". A "<n> shipment(s)" count row. Per-card: cube icon, `customer.businessName`, sub-line `invoiceNumber · <carrier label> · <shipped date>`, chevron; plus a tracking sub-row showing the tracking number — as a tappable "Track package" pill (with open-outline icon) when the carrier has a known URL, otherwise plain text. Data via `useAdminInvoices({ shipped:true, limit:100 })` = `GET /invoices?shipped=true`.
- **Actions:** Card tap → `/(operator)/invoices/${id}`. "Track package" → `Linking.openURL(getTrackingUrl(carrier, tracking))` (external browser; toast "Couldn't open the tracking link." on failure; `stopPropagation` so it doesn't also open the invoice). Back → "More".
- **States:** **loading** (spinner); **empty** (`IosEmptyState` "No shipments yet / Invoices with a carrier tracking number show up here."); **pull-to-refresh** (`RefreshControl`).

#### Pick & load — `/(operator)/pick`

- **File:** `apps/mobile/app/(operator)/pick.tsx`
- **Purpose:** Placeholder for future warehouse pick/load verification.
- **Shows:** Inline title "Pick & load". A single `IosEmptyState`: "Pick & load isn't live yet / You'll verify items against the route manifest here once warehouse scanning is enabled for your team." with a "Back to more" action.
- **Actions:** "Back to more" / back → `router.back()`.
- **States:** Always the not-implemented empty state (no backend `/routes/:id/picks` endpoint exists yet). This is an honest placeholder, not a functional screen.

### Shared components (opened; drive the screens above)

- **`ProductForm`** (`components/ProductForm.tsx`): the create/edit form. Sections — **Basics** (Name\*, Category, Description), **Identifiers** (SKU, Barcode with a native scan button → `/(operator)/products/scan`, Unit, **Pieces per box** with box-price hint), **Pricing** (Price per unit — hinted as the BOX price when pieces-per-box > 1, Standard cost), **Stock** (On-hand quantity, Reorder at, Reorder quantity), and an **Active** switch (hint "Inactive products are hidden from order entry."). `buildProductPayload` validates Name and a non-negative Price, and only sends `unitsPerBox` when it's an integer > 1 (values ≤ 1 mean "sold by piece" and the field is omitted). Inline red error banner for validation.
- **`FormSheet`** (`components/FormSheet.tsx`): the modal container for all form screens (close-X header, title/subtitle, keyboard-avoiding scroll body, Cancel/Submit footer). Provides `FormSection`, `FormField` (label/hint/error, feeds an a11y label to inputs), and `FormTextInput`. Web-only `beforeunload` guard when `warnIfDirty`.
- **`BarcodeScanner`** (`components/BarcodeScanner.tsx`): camera overlay with permission gate, scan window, dedupe (fires once per mount), supported symbologies ean13/ean8/code128/qr/upc_a/upc_e/code39.
- **`BarcodeFab`** (`components/BarcodeFab.tsx`): draggable floating scan button (default right edge, ~2/3 down), position persisted across screens in `useFabPositionStore`, drag-vs-tap discrimination, hidden while a modal scanner is open. Used on adjust-picker and movements.

### Key flows (end-to-end journeys through this area)

- **Add a product by scanning an unknown label:** Products list (or Warehouse) → barcode icon → Scan screen → `resolveProductByCode` misses → `router.replace` to New product with `barcode` prefilled → fill ProductForm → "Save" (`POST /products` [+ `PATCH …/reorder-settings`]) → lands on Product detail.
- **Set a cost basis then read the margin:** Product detail → "Set cost" → enter unit cost (4-dp) → "Set cost" (`PATCH /inventory/products/:id/cost-basis`, audited COST_BASIS movement) → back on detail the Cost + colored Margin% chip now render, and the movements log shows a "Cost set" row displaying the `$` cost (no stock change).
- **Adjust stock with an audited reason:** Warehouse "Adjust" → adjust-picker (search or scan) → Product's adjust-stock → enter +/− delta, pick a reason chip → "Apply" (`POST /inventory/movements/adjustment`, reason folded into notes) → back; the delta appears in the movements log colored green/red.
- **Purchase order lifecycle:** PO list → "+ New" → pick supplier + products (unit cost auto-fills from standardCost) → "Create PO" (`POST …/purchase-orders`, status DRAFT) → detail → "Send to Supplier" (`POST …/send`, DRAFT→SENT) → "Receive Items" (`POST …/receive`, seeds remaining qty, books stock + updates weighted-average cost, SENT→PARTIALLY_RECEIVED/RECEIVED) → "Close PO" (`POST …/close`, RECEIVED→CLOSED).
- **Quick receive (no PO):** `/(operator)/purchase-orders/record` → pick product, enter qty + unit cost → "Record receipt" (`POST /inventory/movements/purchase`) — stock and average cost update in one step.
- **Process a return:** More → Returns → filter Pending → row **Approve** (`POST /returns/:id/approve`) → filter Approved → **Mark received** (`POST /returns/:id/receive`); or **Reject** a pending one (`POST /returns/:id/reject`, destructive confirm).
- **Tobacco monthly report:** More (add-on visible) → Tobacco → "Generate" for the last completed month (`POST /tobacco/reports/generate`) → tap the GENERATED report → PDF URL fetched (`GET /tobacco/reports/:id/pdf`) → native share sheet.

### Use cases

- As an operator, I want to scan a shelf/label barcode and either open the matching product or immediately start creating it, so that catalog upkeep is one tap. (path: Products/Warehouse → scan → product detail _or_ new product)
- As an operator, I want a live count of low- and out-of-stock SKUs plus total inventory value, so that I know what to reorder and what stock is worth. (path: Warehouse tab)
- As an operator, I want to record what a unit actually costs me (to 4 decimals) as an audited event, so that margins and inventory valuation are accurate. (path: product detail → set-cost)
- As an operator, I want to adjust stock with a reason (Received/Damaged/Count/Waste/Other), so that every change is traceable in the movements log. (path: Warehouse → Adjust → adjust-picker → adjust-stock)
- As an operator, I want to raise a PO, send it, and receive it line-by-line against remaining quantities, so that incoming stock and its cost update correctly. (path: purchase-orders → new → [id] → receive)
- As an operator, I want to receive a one-off delivery without a PO, so that ad-hoc restocks still update stock and average cost. (path: purchase-orders/record)
- As an operator, I want to approve, reject, or receive customer returns inline, so that credits and restocking move without opening each return. (path: returns)
- As a tobacco dealer, I want monthly compliance KPIs and a downloadable/shareable PDF report, so that I can file with regulators. (path: tobacco)
- As an operator, I want to look up a carrier tracking number for a shipped invoice, so that I can answer "where's my delivery" without leaving the app. (path: shipments)

### Business rules & edge cases

- **Weighted-average cost:** the "effective cost" shown on product detail is `standardCost ?? averageCost`; `averageCost` is displayed to **4 decimals** on set-cost but 2 on the detail card. Receiving (via PO receive or Quick Receive) and Set-cost all feed the weighted-average pipeline; Set-cost is recorded as an **audited `COST_BASIS` movement** and "future purchases keep updating the average from here." `applyToLots` additionally rewrites open FIFO/LIFO stock lots.
- **Integer boxes/pieces (`unitsPerBox`):** only sent when it's an integer > 1; ≤ 1 or blank means "sold by piece" (field omitted). When set, `pricePerUnit` is the **BOX price** and a loose piece is prorated as `price ÷ unitsPerBox` — surfaced via hints in ProductForm and used downstream by the boxes+pieces order editor. Adjust-stock accepts negatives (numbers-and-punctuation keypad); delta must be finite and ≠ 0.
- **Stock thresholds:** low = `0 < stock ≤ reorderPoint`, out = `stock ≤ 0`; when `reorderPoint` is null the default threshold is **5**. Warehouse computes Low count as server-LOW minus server-OUT to avoid double-counting.
- **Margin coloring:** `round((price−cost)/price*100)` → green ≥ 25%, orange ≥ 10%, red < 10%; "No cost set" amber chip when neither cost is present.
- **PO status gating:** Send only from DRAFT; Receive only from SENT / PARTIALLY_RECEIVED; Close only from RECEIVED (and "cannot be undone"). Receive inputs default to remaining qty and require ≥ 1 positive. "Open" filter = DRAFT ∪ SENT ∪ PARTIALLY_RECEIVED merged from three calls.
- **New-PO supplier/product ergonomics:** newest supplier auto-selected on focus if none chosen; product selection round-trips through `useProductPickerStore` keyed by a per-line `pickerKey` and auto-fills unit cost from the product's `standardCost`.
- **Returns status gating:** Approve/Reject only for PENDING; Mark received only for APPROVED / IN_TRANSIT; Processed & Cancelled are effectively terminal (no inline actions). Reject/receive/refund/cancel/approve/in-transit are all `POST /returns/:id/<action>`. Default filter is All (RF-212).
- **Tobacco add-on gating:** every tobacco surface checks `useHasAddon("tobacco_dealer")` = `GET /tenants/me/addons`. The product-detail tobacco flag toggle is hidden without it; the More-menu Tobacco row is hidden without it; the Tobacco screen itself shows a "not enabled — ask your platform administrator" state. `isTobacco` on a product requires the add-on to set true. Report periods are computed in **UTC**; the default target is the previous month.
- **Barcode resolution ladder** (`resolveProductByCode`): exact `Product.barcode` → exact SKU (case-insensitive, from `/products?search=`) → first name/SKU substring hit → not found. Only 404s fall through; network/5xx errors propagate so the UI shows a retry toast instead of a false "not found." Recently-added items often lack a barcode, so scanning a printed **SKU** label still resolves.
- **Route guards:** `/products/create` is a static alias to New so Expo Router never treats "create"/"new" as a product id; the `[id]` detail screen also defensively redirects those ids to the New form.
- **Pick & load is not implemented** — no backend endpoint exists; the screen is an explicit "isn't live yet" placeholder. The Warehouse "Movements" quick-action currently routes to `/(operator)/products` rather than the movements log (likely a wiring gap worth noting for redesign).
- **Route manifest / multi-tenant / offline:** all queries hit tenant-scoped endpoints via the shared `apiClient` (JWT carries `tenantId`). The movements query swallows fetch errors into an empty result. No explicit offline-queue/replay is present in these warehouse screens (unlike the driver flows); mutations surface failures as toasts and rely on TanStack Query cache invalidation for refresh.

Relevant files (all absolute): `C:\ClaudeCode\routeflow\apps\mobile\app\(operator)\products\{index,new,create,[id],adjust-picker,scan}.tsx` and `products\[id]\{edit,set-cost,adjust-stock}.tsx`; `...\app\(operator)\(tabs)\warehouse.tsx`; `...\app\(operator)\movements.tsx`; `...\app\(operator)\purchase-orders\{index,new,[id],pick-product,record}.tsx` and `purchase-orders\[id]\receive.tsx`; `...\app\(operator)\returns\index.tsx`; `...\app\(operator)\tobacco\index.tsx`; `...\app\(operator)\shipments.tsx`; `...\app\(operator)\pick.tsx`; shared: `...\components\{ProductForm,FormSheet,BarcodeScanner,BarcodeFab}.tsx`; hooks: `...\lib\api\{products,inventory,purchase-orders,returns,tobacco,admin}.ts`, `...\lib\barcode-resolve.ts`.
