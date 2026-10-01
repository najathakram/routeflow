# PENDING APPEND — Phase 14 (W31 Findings)

# Assign after Phase 12 (W32) and Phase 13 (W33) are appended to the report

---

## Phase 14 — Cascading Deletes, Price-at-Checkout Race, Low-Stock Propagation (W31)

**Worker:** W31 | **Date:** 2026-04-30 | **Method:** Chrome browser + javascript_tool

### 9.C — Cascading Deletes

| Test                                      | Action                 | Result                                                                                    | Notes                                     |
| ----------------------------------------- | ---------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------- |
| Delete customer with open PENDING order   | DELETE /customers/{id} | **P0 FAIL** — 200, both customer AND order deleted                                        | Data loss: open orders silently destroyed |
| Delete product with active order item     | DELETE /products/{id}  | PASS — 400 "Cannot delete product with active order items"                                | Snapshot preserved                        |
| Delete driver with active IN_PROGRESS run | DELETE /drivers/{id}   | PASS — 400 "Cannot delete driver with scheduled or in-progress runs. Deactivate instead." | Good UX — deactivate suggestion           |

### 13.10 — Price Change at Checkout Race

- **Sequential case:** order placed first, then price changed → order retains original price ($4.49). PASS.
- **True race (Promise.all):** simultaneous `PATCH /products/{id}` ($4.49→$99.99) and `POST /buyer/orders` → buyer's order captured $99.99 with no warning or cart re-pricing notification. PARTIAL FAIL.

### 13.13 — Low-Stock Warning Propagation

- `GET /products?stockStatus=LOW&limit=1` → `meta.total: 3` but `data.length: 1`
- Home dashboard "Low Stock" tile renders `data.length` (= 1) not `meta.total` (= 3)
- Result: operator sees "1 Low stock" when actually 3 products are below threshold
- Buyer order placement does NOT decrement stock (stock only changes via manual operator adjustment)

---

### RF-197 — DELETE /customers silently cascades to delete all linked orders (P0)

- **Severity:** P0
- **Domain:** data-integrity / customer-management
- **Surface:** API / web-operator
- **Source:** W31 / 9.C.1
- **Issue:** `DELETE /customers/:id` returns HTTP 200 with `{"success": true}` and hard-deletes the customer record AND all linked orders (including PENDING orders that have been placed but not yet fulfilled). This is silent, irreversible data loss. A single accidental click deletes a customer's entire order history including open, in-flight orders. No soft-delete, no confirmation at the API level, no blocking of deletion when open orders exist.
- **Expected:** `DELETE /customers/:id` should return HTTP 400 "Cannot delete customer with open orders" when PENDING or CONFIRMED orders exist, with a list of blocking order IDs. OR implement soft-delete (set `status: ARCHIVED`, filter from active lists) to preserve historical FK integrity while hiding the customer from active views.
- **Actual:** HTTP 200 `{"success": true}`. Customer and all linked orders are hard-deleted from the database. Linked invoices, returns, and standing order templates are also at risk of cascade deletion.
- **Repro:**
  1. As operator, create a customer and place at least one PENDING order for that customer.
  2. `DELETE /customers/{customerId}` (or click Delete in the UI).
  3. `GET /orders/{orderId}` → 404. The order is gone.
- **Fix:** Add a pre-delete check in `customers.service.ts`: query for PENDING/CONFIRMED orders for the customer. If any exist, throw `BadRequestException("Cannot delete customer with {n} open orders. Cancel them first.")`. Consider implementing soft-delete (`isArchived: Boolean @default(false)`) instead of hard delete for all customer records regardless of order state.
- **Prevention:** Add a DB-level safeguard: if Prisma schema uses `onDelete: Restrict` on the order→customer foreign key, the DB itself will reject the delete. Add integration tests covering the blocked-delete path. Add a UI "Delete" confirmation modal that shows the count of linked records and requires typing "DELETE" to confirm.

---

### RF-198 — Price-change-at-checkout race: buyer silently receives updated price with no warning (P2)

- **Severity:** P2
- **Domain:** buyer-portal / pricing
- **Surface:** API / web-buyer
- **Source:** W31 / 13.10
- **Issue:** When a buyer adds a product to their cart at $4.49 and an operator simultaneously changes the product price to $99.99, the buyer's checkout (if submitted within the race window) receives the new price with no warning. The order total jumps from ~$5.49 to ~$115.49 without any indication to the buyer. The buyer portal has no cart re-pricing notification, no price-lock token, and no "price has changed" confirmation step.
- **Expected:** The checkout API either (a) locks the price at add-to-cart time and alerts the buyer if it has changed before checkout, or (b) detects the price discrepancy server-side at order submission and returns HTTP 409 "Price has changed since item was added to cart. New price: $99.99. Please review and confirm."
- **Actual:** The checkout silently uses the current catalog price at order creation time. Buyer's order total changes without any user notification.
- **Repro:**
  1. Buyer adds Product X ($4.49) to cart.
  2. Simultaneously, operator changes Product X price to $99.99.
  3. Buyer submits checkout — order created at $99.99 with no warning.
- **Fix:** Implement a price-confirmation step: after the buyer submits checkout, server-side compare each line item's `unitPrice` against the current catalog price. If any differ by more than a configured threshold (e.g., >1%), return HTTP 409 with the new prices. The buyer must explicitly confirm the new total before the order is created.
- **Prevention:** Add a `cartSnapshotPrice` field to the order creation DTO. Server validates it matches current price and rejects with 409 if it doesn't. Add a Playwright test that changes a price mid-checkout and verifies the buyer sees a price-change warning.

---

### RF-199 — Home "Low Stock" tile reads `data.length` instead of `meta.total` — understates count (P2)

- **Severity:** P2
- **Domain:** operator-ux / dashboard
- **Surface:** web-operator
- **Source:** W31 / 13.13
- **Issue:** The operator home dashboard "Low Stock" tile fetches `GET /products?stockStatus=LOW&limit=1` and renders `response.data.length` (always 1 when any low-stock products exist) instead of `response.meta.total`. With 3 products below their reorder threshold, the tile shows "1 Low stock" instead of "3 Low stock." Operators cannot rely on this number to understand the true severity of stock alerts.
- **Expected:** The "Low Stock" tile shows the total count of products below their reorder threshold (e.g., "3 Low stock items").
- **Actual:** The tile shows 1 (the length of the single-item data array returned by limit=1 query) regardless of actual total.
- **Repro:**
  1. Create 3+ products and set their stock below their threshold.
  2. Navigate to home dashboard.
  3. The "Low Stock" tile shows "1" not "3".
  4. Confirm: `GET /products?stockStatus=LOW&limit=1` → `meta.total: 3, data.length: 1`.
- **Fix:** In the home dashboard component, change the low-stock count binding from `response.data.length` to `response.meta.total`. Alternatively, use `GET /products?stockStatus=LOW&limit=0` to get just the total without data, but the cleanest fix is reading `meta.total`.
- **Prevention:** Add a unit test for the low-stock tile component verifying it renders `meta.total`, not `data.length`. Add a Playwright assertion on the home page that the displayed count matches the actual number of low-stock products.

---

## Phase 14 Summary Table

| RF     | Severity | Source    | Title                                                                             |
| ------ | -------- | --------- | --------------------------------------------------------------------------------- |
| RF-197 | P0       | W31/9.C.1 | DELETE /customers silently cascades to delete all linked orders — P0 data loss    |
| RF-198 | P2       | W31/13.10 | Price-change-at-checkout race — buyer silently receives new price with no warning |
| RF-199 | P2       | W31/13.13 | Home "Low Stock" tile shows data.length (1) instead of meta.total (3)             |
