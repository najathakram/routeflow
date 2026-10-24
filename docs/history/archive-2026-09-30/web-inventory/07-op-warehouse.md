## 7. Operator — Warehouse: Inventory, Products, Suppliers, Vendor Bills, Purchases

**Role(s):** Operator / Tenant Admin (warehouse & back-office). Everything is tenant-scoped via JWT
(`tenantId`/`role`) on the shared `apiClient`; tobacco flags/surfaces additionally require the
tenant's `tobacco_dealer` add-on (`useHasAddon`, `lib/api/tobacco.ts`). • **Entered via:** the
dashboard left nav — **Inventory** (`/inventory`), **Products** (`/products`), **Suppliers**
(`/suppliers`). Movements, vendor-bill detail, supplier detail, and the create-product modal are
reached from those hubs. Money math flows through `lib/pricing.ts`; every monetary write is rounded
(see [`README.md`](README.md) "Money discipline").

This is the operator's inventory backbone: the product catalog, on-hand stock and its money value
(weighted-average cost), cost-basis tooling (set / bulk-set / recompute), stock-count sessions,
purchase orders, demand forecasting, suppliers + their AP balances, and vendor bills (received →
paid, with unlinked-item mapping). Barcode scanning (USB HID keystroke-burst detection + a camera
`BarcodeScannerButton`) is woven through nearly every entry point.

> ⚠️ **Routing note surfaced up-front (full verdict at the end):** `/vendor-bills` (list) and
> `/purchases` are both **redirect-only** — the working vendor-bill _list_ now lives in the Finance
> app at `/finance/expenses` (Inventory tab, documented in [`08-op-finance.md`](08-op-finance.md)).
> Only `/vendor-bills/[id]` (detail) and `/products/[id]` etc. are live pages here. See
> **💡 Faster ways**.

---

### Screens

#### Inventory hub — `/inventory`

- **File:** `apps/web/app/(dashboard)/inventory/page.tsx` (~2700 lines; hosts all modals inline)
- **Purpose:** Stock valuation + the five inventory workflows behind one tab bar.
- **Shows:** Title "Inventory". **Three summary cards:** Total Products (`stockItems.length`),
  **Inventory Value** (`$` from `useInventoryValuation` `GET /inventory/valuation` → `totalValue`,
  else summed `totalValue`; an `Info` tooltip when value is `0`), Out of Stock (count of
  `currentStock <= 0`, red when > 0). When `missingCostCount > 0` the value card renders an amber
  **"{n} missing cost"** pill that toggles a table filter; a brand-blue banner appears when
  > 50% of products are OOS ("stock quantities were not included in the initial import…"). **Tab
  > bar** (`@radix-ui/react-tabs`): **Stock · Stock Count · Suppliers · Purchase Orders ·
  > Forecasting**.
- **Stock tab:** search box (name/SKU/category) with an **8-row typeahead** (ranks SKU-exact →
  SKU-prefix → name → SKU/category substring; Enter or click opens the Adjust modal pre-selected);
  a "{shown} of {total}" counter; and a button row — **Set Costs ({n})** _or_ **Costs** (label
  flips on `missingCostCount`; opens BulkSetCost when missing, else Recompute), **Recompute**,
  **Adjust Stock**, **Add Product** (opens `InlineCreateProductModal`), **Scan Invoice** (opens
  `ScanInvoiceModal`), and primary **Quick Restock**. `StockTable` columns (sortable via
  `useSortableData` / `SortableTh`, hover-revealed chevrons): Product, SKU (mono), Category, Current
  Stock (colored red ≤0 / warning ≤5), **Per Box** (`unitsPerBox`), **Unit Cost** (`$` 2dp with an
  `Info` "standard cost … or weighted average … updates automatically when vendor bills are
  received"; renders an amber **"No cost set"** button when `averageCost == null`), Total Value, and
  per-row actions **Set cost · Adjust · Movements** (→ `/inventory/movements?product={id}`).
- **Other tabs:** **Stock Count** → `<StockCountTab>` (see below). **Suppliers** → a lightweight
  read-only table (Name/Contact/Phone/Email/Status) + **Add Supplier** modal (this is a _second_,
  simpler supplier surface than `/suppliers`). **Purchase Orders** → `<PurchaseOrdersTab>`: filters
  (status `DRAFT|SENT|PARTIAL|RECEIVED|CLOSED`, supplier, date from/to), **Create PO** modal
  (multi-line: product select + qty + unit cost, live subtotal + total), rows with a status
  `Badge`, expand-row (`PODetailRow`) showing line items and status-gated **Send / Receive / Close**
  actions. **Forecasting** → `<ForecastingTab>` (`useForecasting` `GET /inventory/forecasting`):
  Product, Current Stock, Avg Daily Sales, Days Remaining (colored badge ≤7 red / ≤30 yellow),
  inline-editable Reorder Point & Reorder Qty (`InlineNumberEdit` → `useUpdateReorderSettings`
  `PATCH /inventory/products/:id/reorder-settings`), "Reorder Now"/"OK" status, and a **Create PO**
  shortcut on `needsReorder` rows.
- **Modals (all inline in this file):**
  - **QuickRestockModal** (`useRecordPurchase` `POST /inventory/movements/purchase`): supplier,
    product, qty (whole-number guard for non-decimal units), unit cost, a **PO/Invoice reference
    combobox** (options merged from recent `useVendorBills` + `usePurchaseOrders`; picking one
    back-fills the supplier), notes, and a **Backdate** toggle + `effectiveDate`.
  - **AdjustStockModal** (`useRecordAdjustment` `POST /inventory/movements/adjustment`): product
    typeahead **with USB-barcode capture** (matches on exact SKU), signed quantity (step 0.001; live
    "→ new total"), reference, notes, backdate. Opens pre-selected from the Stock table / typeahead.
  - **SetCostModal** (`Modal`; `useSetCostBasis` `PATCH /inventory/products/:id/cost-basis`
    `{unitCost, notes?, applyToLots?}`): unit cost (step 0.0001, 4dp), notes, **"Also rewrite open
    stock lots (FIFO/LIFO)"** toggle. Copy: "Recorded as an audited COST_BASIS movement; future
    purchases keep updating the average from here." Toast "Cost basis set".
  - **BulkSetCostModal** (`useBulkSetCostBasis` `POST /inventory/cost-basis/bulk`): one `$` input per
    product from `valuation.missingCostProducts`; skips blanks; button reads "Set {n} Cost(s)"; toast
    "{updated} products updated".
  - **RecomputeModal** (`useRecomputeCosts` `POST /inventory/recompute-costs`): **dry-run on open**
    (`{dryRun:true}`) → preview with 3 stat tiles (products scanned / costs will change / no purchase
    history) + a Current→Recomputed diff table; **Apply Recompute** re-runs with `{dryRun:false}`.
    Amber note steers no-history products to Set Costs.
  - **CreateSupplierModal / CreatePOModal / ReceivePOModal / ReorderSettingsModal** as above.
- **States:** per-tab skeletons (`animate-pulse` rows); Stock-tab empty variants ("No products
  found." / "No products match…" / "Every product has a cost basis — nothing to fix here." when the
  missing-cost filter is on); PO/forecast empty rows; import-artifact banner.

#### Stock movements log — `/inventory/movements`

- **File:** `apps/web/app/(dashboard)/inventory/movements/page.tsx`
- **Purpose:** Paginated audit log of every stock movement.
- **Shows:** Back link to `/inventory`, title "Stock Movements", a "{total} records" count. Filters:
  Product select, **Type** select (`PURCHASE` "Purchase", `SALE` "Sale", `ADJUSTMENT` "Adjustment",
  `RETURN` "Return", `WRITE_OFF` "Write-Off"), and a from/to date range. Table columns: Date
  (`MMM D, YYYY, hh:mm`), Product (name + mono SKU), **Type** `Badge` (PURCHASE=success, SALE=danger,
  ADJUSTMENT=neutral, RETURN=warning, WRITE_OFF=neutral), Quantity (mono, `+`/`−` colored, 3dp,
  - unit), **Unit Cost** (`$` 4dp or "—"), Supplier, Reference (mono), Notes, **By** (`performedBy.
username`). Data via `useStockMovements` `GET /inventory/movements` (`limit:50`, deep-links via
    `?product=`).
- **Actions:** filters set query params (reset to page 1); Clear button; prev/next pagination.
- **States:** "Loading…"; empty "No movements found."; pagination hidden when `totalPages <= 1`.

#### Products catalog — `/products`

- **File:** `apps/web/app/(dashboard)/products/page.tsx`
- **Purpose:** The master catalog — grid/table, search, filters, quick-edit, variants, bulk ops.
- **Shows:** `PageHeader` "Products" / "Manage your product catalog". **Grid card:** thumbnail
  (`object-cover` + `objectPosition` from the focal in the URL, else a `Package` icon), SKU, name
  (variants show only `variantName`, parent name as caption), `$price / unit`, a **"{n} var."** pill,
  stock `Badge` (In Stock / Low Stock / Out of Stock — `getStockStatus`: inactive or ≤0 = OOS, ≤5 =
  LOW), and an **Add variant** link on parents. **Table columns:** Product (with an amber **"tobacco"**
  badge when `isTobacco`), SKU/Barcode, Category, Unit, **Price** (hover-pencil inline edit; tier
  cascade — capping T2–T5 that exceed the new T1), **Avg Cost** (`$`2dp or amber "No cost set"),
  **Per Box**, **T2–T5** tier prices, **Stock** (badge + qty). Toolbar: search (USB-barcode capture),
  Category select, **Stock** select (All / In Stock / Low / Out of Stock), per-page (20/50/100/200/
  Show all), grid⇄table toggle.
- **Actions:** **New Product** (opens `CreateProductModal`), **Select** (multi-select →
  **Group as variants of…** `GroupAsVariantsModal`, **Delete {n}** `useBulkDeleteProducts`
  `DELETE /products/bulk`), **Quick Edit** (forces table view; inline-edits SKU/Barcode, Category,
  Per Box, T2–T5 with camera-scan row-jump and Enter/Esc; toast "{field} updated"), row click →
  `/products/{id}`. A floating **Undo/Redo** bar tracks the last 20 quick edits
  (`useUpdateProduct` `PATCH /products/:id`). Hooks: `useProducts` `GET /products`
  (`search/category/stockStatus/page/limit/includeVariants`), `useCreateProduct` `POST /products`,
  `uploadProductImages` `POST /products/:id/images`.
- **States:** 10-card skeleton; error banner "Failed to load data…"; `EmptyState` (variant
  "products") — "No products yet" (→ New product) or "No matching products" (→ Clear filters);
  numbered pagination; "Showing all {n}" when limit 0.

#### Create product — `/products/create` ⚠️ _redirect_

- **File:** `apps/web/app/(dashboard)/products/create/page.tsx` — server `redirect("/products?action=
new")` (RF-203: the real create surface is the `CreateProductModal` on the list, not a page).
- **CreateProductModal (`/products?action=new`):** **Photos** (multi-file drop zone + previews;
  uploaded _after_ the product is created, so no focal is set at create time — focal is set later on
  the detail page's crop flow), **Variant of** (`SearchableProductPicker` over standalone products +
  a barcode-scan-to-parent button; pre-fills category/unit/price/perBox from parent), **Flavor /
  variety** (required for variants; live "Will appear as: Parent · Variant" preview), **Name**
  (standalone only), **SKU / Barcode** (+ scanner), **Unit** (`UnitCombobox`), **Price per unit**
  (required, `$`, validated ≥0), **Category** (datalist), **Description**, **Costing Method**
  (`FIFO` default / `LIFO` / `AVCO` / `STANDARD`; STANDARD reveals a required **Standard Cost**
  4dp), **Units per box**. Submit → `useCreateProduct`, toast "Product created", then image upload.

#### Product detail — `/products/[id]`

- **File:** `apps/web/app/(dashboard)/products/[id]/page.tsx`
- **Purpose:** Full product management: image gallery + focal crop, edit form, pricing tiers,
  variants, cost history, tobacco flag.
- **Shows:** **Image gallery** (left, **4:5 portrait**) with thumbnail strip, prev/next + "{n}/{total}",
  lightbox, and operator controls **Move left/right · Set default · Crop / focal**. **Stock card:**
  status badge, "On hand" qty, "Avg cost" (`$` or amber "No cost set"), "View stock movements" link.
  **Details card:** editable name + read-only SKU; a **tobacco banner** when `isTobacco` ("purchases
  and sales tracked separately for monthly tax reports" → `/tobacco`); a **variant-of banner** with
  Unlink when it has a parent; InfoRows (SKU/Barcode, Category, Unit, Tier 1 Price, Variant of,
  Flavor/variety); a **Pricing Tiers** grid (T2–T5 with "Set all to Tier 1" and ≤-previous-tier
  warnings); Description. **Sales Demand** (real invoiced sales — range toggle 30D/6M/1Y/5Y ×
  metric toggle Units/Revenue, one payload so the metric switch never refetches;
  `GET /analytics/demand/:id?range=`; explicit never-sold and empty-window states, the latter
  offering a jump to the smallest range containing the last sale). **CostHistoryCard** (line =
  avg cost, orange dots = purchase costs; hidden if no history; `GET /analytics/cost-history/:id`).
  **Variants** table for parents (Link existing / Add Variant; per-row toggle-active).
- **Actions:** **Edit** (drafts → `useUpdateProduct` `PATCH /products/:id`), **Deactivate/Activate**
  (confirm), **Mark as tobacco** (operator + `useHasAddon("tobacco_dealer")`; `PATCH {isTobacco}`),
  image add/reorder/set-default/delete + **Crop/focal** (re-upload replaces the key, encoding the new
  focal into the filename), variant create/link/unlink/edit, **Delete product** `useDeleteProduct`.
- **States:** "Loading…"; "Product not found." (+ Back); edit/upload/crop busy states; error toasts.

#### Suppliers list — `/suppliers`

- **File:** `apps/web/app/(dashboard)/suppliers/page.tsx`
- **Purpose:** Vendor directory with AP visibility, search, filters, bulk ops, list/grid.
- **Shows:** `PageHeader` "Suppliers" / "{total} suppliers · {$total} outstanding". List columns:
  Supplier (name + contact, `Building2` avatar), Contact (phone/mobile + email), Location (city,
  state), **Lead** (`{days}d`), **Outstanding** (`$` warning-colored + "{n} bills"), Status
(`Active`/`Inactive` badge), hover actions (Edit / Delete). A footer sums total outstanding. Grid
  cards add website/address/notes and inline **Deactivate/Reactivate/Delete** with confirm.
- **Actions:** **New Supplier** / **Edit** → `SupplierModal` (company name\*, contact, lead time,
  phone, mobile, email, website, full address, notes) → `useCreateSupplier`/`useUpdateSupplier`;
  **Select** → bulk delete (parallel `useDeleteSupplier`); **Deactivate** `useDeactivateSupplier`;
  row click → `/suppliers/{id}`. Status filter tabs (all/active/inactive), 300ms debounced search,
  view toggle. Hooks from `lib/api/suppliers.ts` (`GET/POST/PATCH/DELETE /suppliers`, `limit:0`).
- **States:** list/grid skeletons; error banner; empty ("No suppliers yet…" / "No suppliers match
  your filters." + Clear); confirm-before-delete inline; disabled buttons while mutating.

#### Supplier detail — `/suppliers/[id]`

- **File:** `apps/web/app/(dashboard)/suppliers/[id]/page.tsx`
- **Purpose:** One supplier: contact info + AP KPIs + bill history.
- **Shows:** Back link, name + contact + status badge + **Edit**. **Three KPI cards:** Outstanding
  (`$`, warning if >0, "{n} open bills"), Total Billed ("{n} bills"), Total Paid ("{n} paid bills").
  **Contact Details** card (phone/mobile, email link, website link, address, `{days} day lead time`,
  notes) or "No contact details recorded." **Purchase Bills** table via `useVendorBills({supplierId,
limit:50})`: Bill # (mono), Date, Status `Badge` (`DRAFT` neutral / `RECEIVED` warning / `PARTIAL`
  warning / `PAID` success / `VOID` danger), Billed, Paid, Due (outstanding), Notes; footer sums
  outstanding; empty "No bills recorded for this supplier."
- **Actions:** **Edit** (same `SupplierModal` form) → `useUpdateSupplier`; bill rows are display-only
  here (detail lives at `/vendor-bills/[id]`).
- **States:** skeleton; "Supplier not found."; page title = supplier name.

#### Vendor bills list — `/vendor-bills` ⚠️ _redirect_

- **File:** `apps/web/app/(dashboard)/vendor-bills/page.tsx` — `redirect("/purchases")`, which itself
  redirects to `/finance/expenses`. **The real vendor-bill list UI is the Finance Expenses
  "Inventory" tab** (see [`08-op-finance.md`](08-op-finance.md)). The list's status enum, the
  **needs-mapping KPI chip** (`meta.needsMappingCount` from `useVendorBills({needsMapping})`), and the
  **UNLINKED_ITEMS row badge** are surfaced by that Finance surface, not by any page in this section.

#### Vendor bill detail — `/vendor-bills/[id]`

- **File:** `apps/web/app/(dashboard)/vendor-bills/[id]/page.tsx` (a live, functional page)
- **Purpose:** Edit/receive/pay/void one vendor bill; reconcile unlinked line items.
- **Shows:** Back link "Vendor Bills" (→ `/purchases`), Bill # + status `Badge` + red **"Overdue"**
  pill (`dueDate < today` and status ∉ PAID/VOID). Supplier/dates card, **Line Items** (Description +
  linked product name, Qty, Unit Cost, Amount), **Totals** (Total / Amount Paid / Balance Due),
  Notes, and a sidebar **Payment History** + **Balance Summary**. Edit mode swaps in a
  supplier/date/notes form and an editable line grid ("— Custom item —" or a product select that
  auto-fills description + `averageCost`).
- **Actions (status-gated):** **DRAFT** → Edit, **Mark Received** (`useReceiveVendorBill`
  `POST /vendor-bills/:id/receive` — books stock + updates weighted-average cost), **Void**
  (`useVoidVendorBill`). **RECEIVED/PARTIAL** → **Revert to Draft** (`useRevertVendorBillToDraft`;
  warns stock is decremented but _average costs are not reversed_) + **Record Payment**
  (`RecordPaymentModal` → `useRecordVendorBillPayment` `POST /vendor-bills/:id/payments`
  `{amount, method: CASH|CHECK|ACH|OTHER, reference?, notes?}`, remembers last method via
  `usePreferences`). **PAID/VOID** → disabled labels.
- **🔑 UNLINKED_ITEMS 409 flow:** `handleReceive()` calls receive; on failure it runs
  `getUnlinkedItemsError(err)` — which returns the payload only when `err.response.data.code ===
"UNLINKED_ITEMS"`. If matched, it opens **UnlinkedItemsModal** ("Some lines won't update costs")
  listing the unlinked lines (or "no line items at all" copy); **Receive anyway** re-calls
  `handleReceive(true)` with `acknowledgeUnlinked:true`; **Go back and map items** returns to edit.
- **States:** `Loader2` spinner; "Vendor bill not found."; amber pre-receive warning banner when the
  bill has no items or unmapped items.

#### Purchases — `/purchases` ⚠️ _redirect (legacy)_

- **File:** `apps/web/app/(dashboard)/purchases/page.tsx` — renders nothing; on mount it
  `router.replace`s to `/finance/expenses` (`?tab=bills → ?tab=inventory`, `?tab=expenses →
?tab=other`). No PO UI, no vendor-bill UI, no data hooks. **Fully retired legacy route.**

---

### Shared components & libraries (drive the screens above)

- **`ScanInvoiceModal`** (`components/ScanInvoiceModal.tsx`): OCR invoice intake. **Upload** (JPEG/
  PNG/WebP/GIF/HEIC/PDF up to 10 pages) → **Process** (`scanInvoice` `POST /invoice-scan`, Claude
  extracts supplier, date, tax, total, and line items each with a `high|medium|low|none` confidence)
  → **Review** in one of three **modes — Bill / Expense / Both**. Each line maps to a catalog product
  (or stays unlinked) with editable qty/unit-price and a mismatch warning vs the invoice line total;
  **Split by variety** fans a parent line into per-variant qty rows. Submit fires
  `useCreateVendorBill` → `useReceiveVendorBill({acknowledgeUnlinked:true})` (+ `useSaveProductMapping`
  to train future extraction, + `useCreateExpense` in expense/both mode).
- **Stock-count kit** (`components/inventory/`): **`StockCountTab`** orchestrates a **session** kept
  in `localStorage` (per-tenant, debounced ~200ms, survives reload) — a scan/typeahead input
  (unknown barcode → `InlineCreateProductModal` pre-filled), a **qty-per-scan** setting, a
  **default mode** (`ADD` | `REPLACE`), and a row table (Product / Current snapshot / Scanned
  (editable) / Mode / **Δ** colored by sign / Delete). **`StockCountRow`** = one row;
  **`StockCountBulkBar`** (appears at ≥2 selected) sets mode/qty across rows; **`StockCountReviewModal`**
  shows Before/After/Δ + a notes field and **commits** via `useCommitStockCount`
  `POST /stock-count/commit` `{sessionId, notes?, items:[{productId, quantity, mode}]}` → `{applied,
skipped}` (missing-product IDs surface an error asking to drop stale rows). ADD delta = scannedQty;
  REPLACE delta = scanned − snapshot.
- **`InlineCreateProductModal`** (`components/InlineCreateProductModal.tsx`): quick create used by the
  Stock tab and scan callbacks — Variant of (+ scan-to-parent), Flavor/variety, Name, SKU/Barcode,
  Unit, Price, Category, Units per box → `useCreateProduct`; `onCreated` auto-selects the new product.
- **`image-focal.ts`**: focal point is encoded **in the filename** — `…/<uuid>-fp<X>x<Y>.jpg` where
  `X`,`Y` are integers 0–100 (% across / down). `parseFocalPoint` (regex `-fp(\d{1,3})x(\d{1,3})`,
  strips query string, falls back to `{50,50}`), `objectPositionForUrl` → the CSS `object-position`
  used on every product image. **No DB column** — re-cropping = re-upload with a new key.
- **`product-display.ts`**: `displayProductName` composes `"{parent} · {variant}"` for variants
  (guards against double-prefixing), returns `name` for standalone.
- **`lib/api/tobacco.ts`**: `TOBACCO_ADDON = "tobacco_dealer"`; `useHasAddon(key)` (`GET /tenants/me/
addons`) gates the tobacco flag toggle/badges; false while loading.
- **Inventory hooks** (`lib/api/inventory.ts`): overview `GET /inventory/overview`, movements +
  `movements/purchase` + `movements/adjustment`, valuation `GET /inventory/valuation`, cost-basis
  (`PATCH …/cost-basis`, `POST …/cost-basis/bulk`, `POST …/recompute-costs`), suppliers, PO lifecycle
  (`send`/`receive`/`close`), forecasting + reorder-settings.

### Key flows (end-to-end)

- **Receive a vendor bill + map unlinked items:** open a bill at `/vendor-bills/[id]` (from a
  supplier's bill list, or created via `ScanInvoiceModal`) → **Mark Received**. If lines are
  unmapped the API 409s with `UNLINKED_ITEMS`; the **UnlinkedItemsModal** lists them → either **Go
  back and map items** (Edit → pick products) or **Receive anyway** (`acknowledgeUnlinked:true`).
  Receiving books stock and updates each linked product's weighted-average cost.
- **Set / recompute costs:** Inventory → Stock tab. A product with no basis shows an amber
  **"No cost set"** → **Set cost** (`SetCostModal`, audited `COST_BASIS` movement, optional
  rewrite-lots). Many missing at once → **Set Costs ({n})** bulk grid. To rebuild from purchase
  history → **Recompute** → dry-run preview (Current→Recomputed diff) → **Apply Recompute**.
- **Add a product with a focal crop:** Products → **New Product** (or Stock tab **Add Product**) →
  fill the form, drop photos → Create (`POST /products`), images upload after. Set the crop later on
  **`/products/[id]` → Crop / focal** (4:5), which re-uploads with the focal baked into the filename.
- **Stock-count session:** Inventory → **Stock Count** → set qty-per-scan + default mode → scan/type
  each SKU (unknown → inline-create), edit qty/mode, use the **bulk bar** for batches → **Review**
  (Before/After/Δ + notes) → **commit** (`POST /stock-count/commit`). Session persists in
  `localStorage` until commit.
- **Purchase-order lifecycle:** Inventory → **Purchase Orders** → **Create PO** (supplier + lines) →
  row **Send** (`POST …/send`) → **Receive** (`ReceivePOModal`, qtys default to ordered; books stock +
  updates avg cost) → **Close** (`POST …/close`).
- **Quick restock (no PO):** Stock tab → **Quick Restock** → product + qty + unit cost (+ optional
  supplier/reference combobox) → records a `PURCHASE` movement and updates the average in one step.

### Use cases

- As an operator I want a live inventory value plus counts of low/out-of-stock SKUs so I know what to
  reorder and what stock is worth. (path: `/inventory` Stock tab + summary cards)
- As an operator I want to record what a unit actually costs me (audited, 4dp) so margins and
  valuation are accurate — and to bulk-fix or recompute costs when history is missing. (Set/Bulk/
  Recompute modals)
- As an operator I want to receive a supplier bill and be _stopped_ if lines aren't mapped to
  products, so average costs stay correct. (`/vendor-bills/[id]` + UNLINKED_ITEMS flow)
- As an operator I want to run a physical stock count offline-ish and commit deltas in one pass.
  (Stock Count session)
- As an operator I want to raise, send, and receive POs line-by-line so incoming stock and its cost
  update correctly. (Purchase Orders tab)
- As an operator I want supplier AP visibility (outstanding, billed, paid, per-bill) in one place.
  (`/suppliers`, `/suppliers/[id]`)
- As an operator I want to add/curate the catalog fast — grid/table, quick-edit, variants, tiered
  pricing, focal-cropped photos, and a tobacco flag. (`/products`, `/products/[id]`)

### Business rules & edge cases

- **Weighted-average cost:** the displayed unit cost is the standard cost for STANDARD-costed
  products else the weighted-average (`averageCost`), shown 2dp in tables / 4dp in cost dialogs.
  Receiving (vendor bill, PO receive, Quick Restock) and Set-cost all feed the average; **Set-cost is
  an audited `COST_BASIS` movement**; `applyToLots` additionally rewrites open FIFO/LIFO lots.
  **Recompute** replays purchase movements to rebuild averages and repair snapshots — always
  **dry-run first**, and it leaves no-history products untouched (steer to Set Costs). Vendor-bill
  **revert-to-draft decrements stock but does NOT reverse average cost** (explicit warning).
- **No-cost gating & valuation:** products with `averageCost == null` render an amber "No cost set"
  chip everywhere (Stock table, Products table, product detail) and are **excluded from Inventory
  Value** (`missingCostCount`); the value card's amber chip filters the Stock table to them.
- **Stock thresholds:** OOS = `currentStock <= 0` (or inactive on the products list); LOW =
  `0 < stock <= 5` (products page's client rule) — the Inventory forecasting tab uses per-product
  `reorderPoint`/`reorderQty` instead.
- **Boxes/pieces (`unitsPerBox`):** surfaced as a Per Box column and a create-form field; downstream
  line math is prorated via `pricing.ts` (never re-derive `qty * unitPrice` for a boxed line).
  Non-decimal units force whole-number quantities in Quick Restock; decimal units (kg/g/L/…) allow
  step 0.001 in restock/adjust/stock-count.
- **Tier pricing cascade:** editing T1 (inline or detail) copies to T2–T5 if they all matched the old
  T1, else caps any tier above the new T1; saving T*n* caps higher tiers similarly. Detail-page tiers
  warn when a tier exceeds the one above it.
- **Tobacco flag:** setting `isTobacco = true` requires `useHasAddon("tobacco_dealer")`; without the
  add-on the toggle/badges are hidden. (Reporting lives in `/tobacco`, see
  [`09-op-analytics-tobacco.md`](09-op-analytics-tobacco.md).)
- **Focal-point encoding:** stored in the image filename (`-fp<X>x<Y>`), 0–100 integers, default
  centre `{50,50}`; no DB migration; re-crop = re-upload. Applied via `object-position` on
  `object-cover` images (README "Product image focal point").
- **Vendor-bill status:** `DRAFT → RECEIVED/PARTIAL → PAID`, plus `VOID`. Overdue is derived
  (`dueDate < today` and not PAID/VOID). Payment method persisted as a user preference.
- **Barcode resolution:** two mechanisms — USB HID keystroke-burst capture on search/adjust inputs
  (≥6 chars + fast Enter) and a camera `BarcodeScannerButton`; a scanned code resolves to a product
  (or its parent) via `GET /products/barcode/:code`, else offers inline-create pre-filled.
- **Duplicate supplier surfaces:** suppliers are editable both at `/suppliers` (full form + AP) and in
  the Inventory **Suppliers tab** (name/contact only + a simpler add modal) — two UIs over the same
  `/inventory/suppliers` vs `/suppliers` data (worth unifying).
- **Redirect chain (see verdict):** `/products/create` → `/products?action=new`; `/vendor-bills` →
  `/purchases` → `/finance/expenses`; `/purchases` → `/finance/expenses`.
- **Realtime:** `inventory.low.stock` invalidates queries (and toasts) per the app-wide realtime map
  (README). No offline queue on web (unlike driver mobile); the movements query degrades to empty on
  fetch failure.

### Relevant files (all absolute)

`C:\ClaudeCode\routeflow\apps\web\app\(dashboard)\inventory\page.tsx`,
`…\inventory\movements\page.tsx`;
`…\products\page.tsx`, `…\products\create\page.tsx`, `…\products\[id]\page.tsx`;
`…\suppliers\page.tsx`, `…\suppliers\[id]\page.tsx`;
`…\vendor-bills\page.tsx`, `…\vendor-bills\[id]\page.tsx`;
`…\purchases\page.tsx`;
components `…\components\ScanInvoiceModal.tsx`, `…\components\InlineCreateProductModal.tsx`,
`…\components\inventory\{StockCountTab,StockCountRow,StockCountBulkBar,StockCountReviewModal}.tsx`,
`…\components\{SupplierSelect,BarcodeScannerButton,SearchableProductPicker,GroupAsVariantsModal,UnitCombobox}.tsx`;
libs `…\lib\image-focal.ts`, `…\lib\product-display.ts`, `…\lib\use-sortable-data.ts`,
`…\lib\api\{inventory,products,suppliers,vendor-bills,tobacco}.ts`;
specs `…\apps\web\e2e\02-operator.spec.ts`, `…\apps\web\e2e\06-critical-paths.spec.ts`.

---

### 💡 Faster ways _(redesign suggestions — NOT current behavior)_

- **Unify `/purchases`, `/vendor-bills`, and Finance Expenses into one "Bills & Purchasing" hub.**
  Today the vendor-bill _list_ is a triple-redirect into the Finance app while the _detail_ page
  lives under `/vendor-bills/[id]`, POs live in an Inventory tab, and `/purchases` is dead. One hub
  (Bills · POs · Expenses tabs) would end the "which page manages bills?" confusion the redirects
  encode.
- **One suppliers surface.** Collapse the Inventory **Suppliers tab** (name/contact only) into
  `/suppliers` (full form + AP KPIs) so there's a single source of truth and no two-modal drift.
- **Bulk cost-basis straight from a received bill.** Recompute/BulkSetCost operate on the whole
  catalog; a "set costs for the {n} lines on this bill" action on `/vendor-bills/[id]` (and in
  `ScanInvoiceModal`) would fix missing costs exactly where they originate, instead of hunting them
  later from the valuation chip.
- **Drag-and-drop item→product mapping.** The UNLINKED_ITEMS modal and ScanInvoice review both use
  per-line dropdowns; a drag-to-match (or "map all high-confidence" one-click) panel would cut the
  clicks on multi-line invoices, and could persist mappings the way `useSaveProductMapping` already
  hints at.
- **Consolidate the four stock-mutation modals.** Quick Restock, Adjust Stock, Set Cost, and PO
  Receive are separate inline dialogs that overlap heavily (product picker + qty + unit cost). A
  single "Stock movement" sheet with a movement-type switch would shrink `inventory/page.tsx`
  (~2700 lines) and give one consistent scan/typeahead everywhere.
- **Set the focal point at create time.** Photos in `CreateProductModal` upload centre-cropped; the
  operator must revisit `/products/[id]` to crop. Folding the crop step into create avoids a second
  visit for every new product with a photo.
