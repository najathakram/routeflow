## 4. Operator — Home, Dispatch, Orders

**Role(s):** Operator / Tenant Admin (dispatch back-office); an operator who also has `canActAsDriver` can flip into a driver view without leaving Home. • **Entered via:** The operator tab bar (`(operator)/(tabs)`), whose visible tabs are **Home · Dispatch · Orders · Warehouse · More** (Finance is registered but hidden, `href: null`). Home is the launch screen; Orders detail/edit/split screens are reached by drilling in or via deep links like `/(operator)/orders?status=PENDING`.

This is the operator's daily command center: a KPI + readiness dashboard (Home), a route/driver assignment board (Dispatch), and the full order lifecycle (browse → detail → edit line items → split into invoices), plus an ad-hoc "New order" builder with barcode scanning. Everything is tenant-scoped through the JWT; all money math runs through the shared `pricing.ts` box/piece-aware helpers.

### Screens

#### Operator Home (KPI dashboard + readiness) — `/(operator)/(tabs)/home`

- **File:** `apps/mobile/app/(operator)/(tabs)/home.tsx`
- **Purpose:** "Today" landing screen — dispatch readiness, KPIs, and today's routes; doubles as a driver dashboard when the operator can act as a driver.
- **Shows:**
  - `NavBar` large title **"Today"**, eyebrow with the weekday/date (uppercase), subtitle `"N runs today"`; trailing notifications bell (red dot when `stats.returnsToProcess > 0`) and an avatar chip with the operator's initials.
  - **Mode switcher** (only if `user.canActAsDriver`): a segmented control **Operator | Driver** (briefcase / car icons) — local state only, no navigation.
  - **Dispatch readiness hero** (brand gradient): eyebrow "DISPATCH READINESS", big `readiness.pct`%, `"{loaded} of {total} runs rolling"`, a progress bar. Readiness = runs whose status is `IN_PROGRESS` or `COMPLETED` ÷ today's runs.
  - **KPI grid** (4 `KpiCard`s, each tappable): **Pending orders** (`stats.pendingOrders`), **Active drivers** (`stats.activeDrivers`), **Low stock** (`stats.lowStockProducts`), **Overdue invoices** (`stats.invoicesOverdue`).
  - **"Routes today"** section: up to 6 route cards — badge from route name initials, `"{name} · {driverName}"`, `"{n} stops"`, a status `Pill` (On route / Rolled / No driver / Scheduled) and a `ProgressTrack` with a percent.
  - **Driver inline view** (mode = Driver): active-run stats (`Stops / Done / Left`), progress bar, an "UP NEXT · STOP N" hero (customer businessName + address line1) or an "All stops done!" card; a Stops list of `StopCard`s (Delivered / Skipped / Up next). If no active run but a scheduled one exists: a "ready to depart" hero with a **Start day** button. Else an empty "No route today" state.
- **Actions:**
  - Bell → `router.push('/(operator)/exceptions')`; avatar → `/(operator)/more`.
  - Hero: **New order** → `/(operator)/new-order`; **Dispatch** → `/(operator)/dispatch`; **Fleet** → `/(operator)/fleet`.
  - KPI cards: Pending orders → `/(operator)/orders?status=PENDING`; Active drivers → `/(operator)/drivers`; Low stock → `/(operator)/warehouse`; Overdue invoices → `/(operator)/invoices?status=OVERDUE`.
  - Routes "All" link → `/(operator)/dispatch`; a route card → `/(operator)/route-runs/{activeRunId}` if it has an active run, else `/(operator)/routes/{routeId}`.
  - Driver view: "Open stop" / a StopCard → `/(driver)/route/stop/{stopId}`; **Start day** → `useUpdateRunStatus` → `PATCH /route-runs/:id/status {status:"IN_PROGRESS"}`, then `startLocationTracking(runId)`.
  - Data hooks: `useAdminDashboard` (aggregated client-side from list `meta.total`s — there is no single stats endpoint), `useAdminRoutes({limit:10})`, `useAdminDrivers`, `useOperatorRouteRuns` (today + `status:"IN_PROGRESS"` merged), `useActiveRouteRun`/`useScheduledRouteRuns` (`GET /route-runs?assignedToMe=true&status=…`).
- **States:** loading (spinners for KPIs and routes), empty ("No routes scheduled" / driver "No route today"), role-gated (mode switcher hidden unless `canActAsDriver`), notification dot gated on returns count. No pull-to-refresh here.

#### Dispatch (routes + drivers board) — `/(operator)/(tabs)/dispatch`

- **File:** `apps/mobile/app/(operator)/(tabs)/dispatch.tsx`
- **Purpose:** Assign routes to drivers and monitor today's runs; a two-tab board.
- **Shows:**
  - `NavBar` large title **"Dispatch"** (inline "Assign"), trailing **+ New** action.
  - A `SegmentedControl` **Routes | Drivers**.
  - **Routes tab:** a red warning banner **"N routes without a driver"** when any route is unassigned; **"Today's runs"** list (each row: `route.name`, `"{driverContactName} · {done}/{total} stops"`, status `Pill` — green COMPLETED / orange IN_PROGRESS / gray CANCELLED / brand otherwise); **"All routes"** list (name, `"{driverName} · {n} stops"`, and either a green **Assigned** pill or an **Assign** button).
  - **Drivers tab:** driver rows — avatar initials, `"{firstName} {lastName}"`, subtitle `vehicleMake vehicleModel` or status, and a status `Pill` (green ACTIVE / gray).
- **Actions:**
  - **+ New** (nav) and route "+ New route" → `/(operator)/routes/new`; drivers "+ New driver" → `/(operator)/drivers/new`.
  - Run row → `/(operator)/route-runs/{runId}`; route row → `/(operator)/routes/{routeId}`; **Assign** (stops propagation) → `/(operator)/routes/{routeId}/assign-driver`; driver row → `/(operator)/driver?id={driverId}`.
  - Hooks: `useAdminRoutes({limit:50})`, `useAdminDrivers`, `useOperatorRouteRuns({date:today,limit:50})`.
- **States:** loading (spinner per tab / runs), empty ("No runs scheduled today." / "No routes defined yet." / "No drivers on this tenant."), warning banner (unassigned routes). No pull-to-refresh.

#### Orders list — `/(operator)/(tabs)/orders`

- **File:** `apps/mobile/app/(operator)/(tabs)/orders/index.tsx`
- **Purpose:** Search/filter all orders and open one; the operator's order inbox.
- **Shows:**
  - `NavBar` large title **"Orders"**, trailing **New** action.
  - `SearchBar` ("Search orders, customers…") and a `FilterChipRow`: **All · Pending · Confirmed · Out · Delivered · Cancelled** (default **All**; a `?status=` deep-link param preselects).
  - Order rows: `orderNumber`, an **URGENT** flash badge when `order.urgent`, `"{customerName} · {n} items · {createdAt}"`, a status `Pill`, a **"{n} pending"** duplicate badge when the same customer has >1 PENDING order (O-6 duplicate detection, active on All/Pending filters), the formatted `total`, and a chevron.
- **Actions:** **New** / empty-state **New order** → `/(operator)/new-order`; a row → `/(operator)/orders/{id}`. Hook: `useAdminOrders({status,search,limit:50})` → `GET /orders`.
- **States:** loading spinner; empty ("No orders here." or "No orders match your search." with a New order CTA); **pull-to-refresh** (`RefreshControl` on `isFetching && !isLoading`).

#### Order detail — `/(operator)/(tabs)/orders/[id]`

- **File:** `apps/mobile/app/(operator)/(tabs)/orders/[id].tsx`
- **Purpose:** Full order view with status transitions, item breakdown, shipment, and management actions.
- **Shows:**
  - `NavBar` inline title = `orderNumber`, back button labeled **"Orders"** (see rule below).
  - **Status + customer card:** status `Pill` + optional red **Urgent** pill; customer `businessName`; `contactName · phone`; `Requested {date}` and `Delivered {date}` when present; italic order `notes`.
  - **Items card:** each line shows product name (or free-text `name`) + a **Custom** tag when `!productId`; a qty line that renders boxed splits as `"1 box + 2 pcs"` (or `"8 ea"` when flat) plus `unitPrice` and `/ box of N` suffix for boxed; per-line `subtotal`; a small per-item status pill (Delivered / Partial). Footer rows: **Subtotal**, **Tax** (if any), **Total**.
  - **Shipment section** (`ShipmentSection`): carrier + tracking number, a tappable "Track package" row when a tracking URL resolves, and an **Add tracking / Edit shipment** button.
  - **Status card:** context-sensitive transition buttons (see rules).
  - **More card:** Split into invoice…, Mark/Clear urgent, View customer, Delete order.
- **Actions:**
  - **Edit items** (Items card, only when editable) → `/(operator)/orders/{id}/edit-items`.
  - Status buttons → `useChangeOrderStatus` → `PATCH /orders/:id/status {status}`; some prompt a `confirm()` first (Cancel, Quick deliver, Back to pending/confirmed reversions).
  - **Split into invoice…** → `/(operator)/orders/{id}/split-invoice`.
  - **Mark/Clear urgent** → `useToggleOrderUrgent` → `PATCH /orders/:id/urgent {urgent}`.
  - **View customer** → `/(operator)/customers/{customerId}`.
  - **Delete order** → `confirm()` (destructive) → `useDeleteOrder` → `DELETE /orders/:id`, then back.
  - Shipment save/clear → `useUpdateOrderShipment` → `PATCH /orders/:id/shipment {shippingCarrier, shippingTrackingNumber}`.
  - Hook: `useAdminOrder(id)` → `GET /orders/:id`. Errors surface via `showToast` from `err.response.data.message`.
- **States:** loading spinner; error/not-found ("Order not found" + Back button); read-only gating (Edit items hidden and price/status controls suppressed on terminal statuses); every mutation is fed by `changeMut.isPending`-style disabling.

#### Edit order items (integer stepper + price-override modal) — `/(operator)/(tabs)/orders/[id]/edit-items`

- **File:** `apps/mobile/app/(operator)/(tabs)/orders/[id]/edit-items.tsx`
- **Purpose:** Replace-all editor for an order's lines — adjust quantities (boxes/pieces), substitute products, override prices, add unlisted lines.
- **Shows:**
  - `NavBar` inline title **"Edit items"**, back labeled with `orderNumber`.
  - One `DraftItemCard` per catalog line: name, tappable meta line (`$unitPrice / box of N` or `/ unit`) with a strikethrough catalog price + orange color when overridden and a pencil affordance; live line total; a **Qty** stepper OR (for boxed products with `unitsPerBox > 1` and non-customer role) a **Boxes** stepper plus a **Loose pieces** stepper capped at `unitsPerBox − 1` with a "{upb} per box" hint. Action chips: **Substitute**, **Override price / Price overridden**, and a red trash button.
  - `UnlistedDraftCard`s for ad-hoc lines: **Custom** tag, editable name, `$ price / unit`, a Qty stepper, trash.
  - Footer: **"N ITEMS"** eyebrow + running total (mirrors server box-price math), **Save changes** button.
  - Steppers use `sanitizeIntInput` (integer-only, strips leading zeros, blocks decimals even with an Android decimal keypad).
- **Actions:**
  - **Add product** / **Substitute** → opens `ProductPicker` (searches `useProducts({limit:0})`; substitute inherits the old line's qty and replaces the productId).
  - **Add unlisted item** → `UnlistedItemModal` (name + unit price + qty; price and qty required).
  - **Override price** → `PriceOverrideModal` (see convention below).
  - **Save changes** → `useUpdateOrderItems` → `PATCH /orders/:id/items {items}`; on success shows "Items updated" and `router.replace('/(operator)/(tabs)/orders')`.
  - Hooks: `useAdminOrder`, `useCustomerPriceHistory(customerId)` (for carry-forward pricing), `useProducts`.
- **States:** loading spinner; empty ("No items. Add one below."); "Orders can't be saved empty." toast blocks an empty save; role-gating — box splitting hidden for `CUSTOMER` role (`canSplitBoxes`); price editing gated to DRAFT/PENDING/CONFIRMED (`canEditPrice`); saving disables the button ("Saving…").
- **Steps (price override modal):** 1) open modal → 2) type **New unit price** OR **Amount off / unit** (the two stay in sync as a lens over `catalogPrice − newPrice`) → 3) optional **Reason** (e.g. "daily market price") → 4) **Apply** (valid only when price > 0) — sets the line's `unitPrice` + `overrideReason`.

#### Split into invoices — `/(operator)/(tabs)/orders/[id]/split-invoice`

- **File:** `apps/mobile/app/(operator)/(tabs)/orders/[id]/split-invoice.tsx` (thin wrapper) → `apps/mobile/components/SplitInvoiceScreen.tsx` (the real UI)
- **Purpose:** Split one order into N partial invoices, allocating item quantities across draft invoices and creating them in one batch.
- **Shows:**
  - `NavBar` inline title **"Split into invoices"**, back labeled **"Order"**; trailing **Create N** (or **Done** when everything is invoiced).
  - A helper card explaining the flow.
  - One or more **Invoice {i}** draft cards. Each billable line shows `productName`, a live `"{globalLeft} of {totalRemaining} {unit} left · $unitPrice/ea"` counter (orange when items remain, green when zero), a qty `TextInput`, quick buttons **None / Half / All**, and a per-line total. Per-draft footer: **Terms** pills (Due on Receipt / Net 15 / 30 / 45 / 60), a **Due date** `YYYY-MM-DD` input, a **Send immediately on create** checkbox, and an invoice **subtotal**.
  - A **"Not yet allocated"** tally card and a bottom action showing **"N INVOICES TO CREATE"** + combined total.
  - An **"All items invoiced"** done state when nothing is billable (with a note to Void/Delete an invoice to re-split).
- **Actions:**
  - **Add another invoice** → appends a draft; **Remove** removes one; **Half/All/None** set qty relative to the remaining cap.
  - **Create N invoices** → `submitAll()` iterates drafts and calls `useCreatePartialInvoiceFromOrder` → `POST /invoices/from-order/:orderId/partial {items, terms, dueDate, send}` **sequentially** (so server-side `OrderItem.invoicedQty` increments don't race); already-created drafts are marked and skipped on retry.
  - Source items come from the parent order's `lineItems` mapped to `{id, productName, qty, invoicedQty, unitPrice, unit}`.
- **States:** loading/error wrappers ("Order not found."); all-done state; per-draft "Created" badge + dimming after success; `bulkPending` overlay + "Creating…" button; validation via `alertInfo` for empty allocation or bad `YYYY-MM-DD` due date; a partial-failure stops the loop and surfaces the server message while keeping already-created invoices.
- **Steps:** 1) screen auto-fills the first draft with every billable item at full remaining qty → 2) operator dials qtys down / adds more drafts / sets terms+due+send → 3) tap Create → 4) sequential POSTs, then `onCreated`/back.

#### New order (ad-hoc order builder) — `/(operator)/new-order`

- **File:** `apps/mobile/app/(operator)/new-order.tsx` (wrapper) → `apps/mobile/components/NewOrderScreen.tsx` (shared with driver/stop flows)
- **Purpose:** Operator-initiated order: pick a customer, add catalog/unlisted items (tap or barcode scan), review a cart, save. Both Back and post-save land on the orders list.
- **Shows:**
  - **Step 1 — Customer picker:** `NavBar` "Choose customer", `SearchBar`, customer rows (avatar initials, `businessName`, `contactName · phone`). Locked/hidden when a `customerId` is passed in (e.g. from a stop).
  - **Step 2 — Product pick:** `NavBar` "New order" with a trailing **Save** action; a tappable customer chip ("Change" unless locked); `SearchBar` with a barcode icon; category chips (All + up to 6 from product categories); an **Add unlisted item** CTA with a custom-line count; product rows — image placeholder, `displayName` (composes "Parent - Variant"), meta `"SKU … · $price / box of N"`, and either an **Add (+)** button, a qty stepper (non-boxed), or a boxed dual-stepper (**Boxes** + **Loose {unit}** capped at `upb−1`, with a trash button).
  - **Footer:** ONE tappable summary chip (**"N ITEMS ˄ / $total"**, brandWash — the chip itself opens the cart review; the separate "View / edit" button was removed as a duplicate affordance) and a **Confirm** button. A hint "Add at least one item to confirm." when empty. Case-packed rows carry inline **Cases + Loose** steppers (`BoxedQtyBand`) with the split summary + per-line **Edit** on a second band line.
  - **Cart review modal** (`CartModal`): per-line price input (the "discounted price"), showing `Current: $catalog` when overridden or `Last: $historyPrice` when a cheaper prior price exists; Boxes/Loose or Qty steppers; line totals; unlisted rows with a Custom tag; **Add unlisted item**; sticky footer with **ORDER TOTAL**, **Keep adding**, **Save order**.
  - A floating draggable **BarcodeFab** scanner button (hidden while cart/scanner open).
- **Actions:**
  - Pick customer → advances to product step; **Change** → re-pick (unless locked).
  - **+ / steppers** adjust `items` state; boxed products increment by the box; scanning routes through `handleBarcodeScanned` → local barcode/sku/id match → `resolveProductByCode` server fallback → if not found and role is OPERATOR/TENANT_ADMIN, offers to create the product with the scanned barcode prefilled (`/(operator)/products/new?barcode=…`).
  - **Save / Confirm** → `onSave()`: if the customer already has a DRAFT/PENDING order (`useActiveOrderForCustomer` → `GET /orders/active`), prompts **Merge / Create separate / Cancel** via `chooseAction`; then `useCreateOrderAsDriver` → `POST /orders {customerId, items, routeRunId?, routeRunStopId?, mergeChoice?}`. A 409 `MERGE_CHOICE_REQUIRED` re-prompts. Success toasts "Order N saved" and navigates to the orders list.
  - Hooks: `useAdminCustomers`, `useProducts({limit:0})`, `useCustomerPriceHistory(customerId)` → `GET /orders/price-history`.
- **States:** loading spinners (customers, products); empty ("No customers…", "No products…"); scanning toasts; barcode network error surfaces a retry toast; merge-conflict prompt; Save disabled until `totalItems > 0` and not pending ("Saving…").
- **Steps:** 1) choose customer → 2) add items (tap / stepper / scan / unlisted) → 3) optional cart review + price overrides → 4) Confirm → merge-choice check → `POST /orders` → orders list.

### Key flows (end-to-end journeys through this area)

- **Take a phone order:** Home/Orders **New** → New order → Choose customer → add products (or scan barcodes; boxed items split into boxes+loose pieces) → cart review, adjust the discounted price → **Confirm** → merge-choice prompt if the customer has an open order → `POST /orders` → lands on Orders list.
- **Confirm & dispatch an order:** Orders list (filter Pending) → order detail → **Confirm order** (`PATCH …/status → CONFIRMED`) → **Send for delivery** (`→ OUT_FOR_DELIVERY`) → Dispatch → assign the route to a driver → driver rolls the run.
- **Fix an order before billing:** order detail → **Edit items** → change qty/boxes, **Substitute** a product, **Override price** (net price + reason), add an unlisted line → **Save changes** (`PATCH …/items`) → back to Orders list.
- **Bill an order in parts:** order detail → **Split into invoice…** → allocate item qtys across N draft invoices (None/Half/All), set terms + due date + send flag per draft → **Create N invoices** (sequential `POST …/partial`) → invoices created, remaining qty decremented.
- **Assign an unassigned route:** Home readiness/Dispatch warning banner → Dispatch Routes tab → **Assign** on a driverless route → `/(operator)/routes/:id/assign-driver`.
- **Operator covers a delivery:** Home → flip mode switch to **Driver** → **Start day** on the scheduled run (`PATCH …/status → IN_PROGRESS` + location tracking) → open the next stop.

### Use cases

- As an operator, I want a single "Today" screen showing readiness, pending orders, low stock, and overdue invoices so that I know what needs attention first. (path: Home)
- As an operator, I want to filter orders by status and spot duplicate pending orders per customer so that I don't ship the same thing twice. (path: Orders list)
- As an operator, I want to split a boxed product into whole boxes plus loose pieces with integer steppers so that the price prorates correctly. (path: New order / Edit items)
- As an operator, I want to give a customer a one-time discounted price with a reason so that the override is recorded without changing the catalog. (path: Edit items / New order cart)
- As an operator, I want to bill a large order across several invoices with different terms so that the customer can pay in stages. (path: Split invoices)
- As an operator with driver rights, I want to switch into a driver view and start my run so that I can cover a route myself. (path: Home mode switch)
- As an operator, I want to scan a barcode to add an item, and be offered to create the product if it's unknown, so that I'm never dead-ended mid-order. (path: New order)

### Business rules & edge cases

- **Status gating (order detail):** transitions are computed per current status — DRAFT→Submit for review (PENDING); PENDING→Confirm / Cancel; CONFIRMED→Send for delivery / Quick deliver / Back to pending / Cancel; OUT_FOR_DELIVERY→Mark delivered / Partial delivery / Back to confirmed / Cancel; PARTIALLY_DELIVERED→Mark fully delivered / Back out for delivery / Cancel. DELIVERED and CANCELLED are terminal (no transitions, urgent toggle hidden). Reversions and cancels require a `confirm()` dialog.
- **Editable statuses:** Edit items and per-line price/discount editing are allowed only on **DRAFT / PENDING / CONFIRMED** (mirrors the API `updateOrderItems` guard); the mobile screen explicitly re-includes DRAFT.
- **Integer boxes/pieces:** all qty/box/piece inputs are integer-only via `sanitizeIntInput` (strips non-digits and leading zeros, blocks decimals even on an Android decimal keypad); loose pieces are capped at `unitsPerBox − 1`; a line drops to zero (removed) when boxes and pieces are both 0. `qty` is total pieces = `boxes*unitsPerBox + pieces` and is the server's source of truth.
- **Box-price proration:** boxed products (`unitsPerBox > 1`) use the shared `computeLineSubtotal` (BOX price × box-equivalent, prorating loose pieces) — never `qty * unitPrice`. Live totals in Edit items / New order / cart mirror this so the footer agrees with the server.
- **Price-override convention:** the override is the _net_ `unitPrice` (the discounted price). New order only sends `unitPrice` when it is **below** the catalog price (treated as a one-time override); the "Amount off / unit" field is a synced lens over `catalogPrice − newPrice`. Overridden lines render the catalog price struck through in orange. Edit items also carries an optional `overrideReason`.
- **Price carry-forward:** when a customer + product has prior price history and the last price is below catalog, newly added/scanned lines pre-fill that remembered price (operator can still change it); shown as "Last: $x" in the cart.
- **Unlisted (ad-hoc) lines:** free-text `name` + required per-piece `unitPrice`, never boxed, `productId` null; serialized as `{name, qty, unitPrice}`. In Edit items' replace-all save, existing catalog lines + any unlisted lines are re-sent (empty save is blocked).
- **Merge-vs-separate:** creating an order for a customer who already has a DRAFT/PENDING order forces an explicit choice (Merge / Create separate) — either pre-checked via `GET /orders/active` or via a 409 `MERGE_CHOICE_REQUIRED` response; the UI never silently merges or duplicates. Duplicate PENDING orders are surfaced with a "{n} pending" badge on the list (O-6).
- **Split-invoice safety:** per-item allocations across all drafts cannot exceed `qty − invoicedQty`; inputs clamp on blur; invoices are POSTed **sequentially** to avoid racing `invoicedQty` increments; a mid-batch failure stops and preserves already-created invoices; when everything is invoiced the screen shows an all-done state and directs the operator to Void/Delete an invoice to re-split. `useCreatePartialInvoiceFromOrder` invalidates both `orders` and `admin/orders` caches so re-splitting sees fresh remaining qty.
- **Barcode resolution order:** local barcode/sku/id match → `resolveProductByCode` (server barcode → exact SKU → substring) → offer to create a product (only for OPERATOR/TENANT_ADMIN) with the scanned code prefilled; scanned-but-uncached products are stashed so they still contribute to totals and the cart, and the just-scanned row auto-scrolls into view.
- **Role gating:** `canActAsDriver` unlocks the Home mode switch; box-splitting is hidden for `CUSTOMER` role; product creation from a failed scan is limited to OPERATOR/TENANT_ADMIN.
- **Carrier shipment vs own route:** the order-detail Shipment section records an external carrier + tracking number (with a derived "Track package" link) — distinct from delivery via the tenant's own routes/runs.
- **Navigation quirks:** tab presses pop each tab's stack to its root (fixes "Orders reopened the edit screen"); order detail Back, Edit-items save, New-order Back, and post-save all `router.replace('/(operator)/(tabs)/orders')` rather than `router.back()`, because a deep-linked entry has an empty back stack (the "back is not working" fix).
- **Dashboard aggregation:** there is no single stats endpoint — `useAdminDashboard` derives KPIs client-side from list `meta.total`s and bookkeeping; `lowStockProducts = max(0, lowTotal − outOfStock)`; the notifications dot keys off `returnsToProcess`.
