# PENDING APPEND — Phase 15 (W30: Money Correctness + Inventory Edges)

---

## Phase 15 — Money Correctness and Inventory Edge Cases (W30)

**Worker:** W30 | **Date:** 2026-04-30 | **Method:** Chrome browser + javascript_tool

### 9.A — Money Correctness Results

| Test | Result | Notes |
|------|--------|-------|
| Penny rounding 3-way split ($10.00) | PASS | 3.33 + 3.33 + 3.34 = 10.00, no rounding error |
| Penny rounding 7-way split ($10.00) | PASS | 6×$1.43 + 1×$1.42 = 10.00, no rounding error |
| Credit note applied to invoice | PASS | PARTIAL status, balanceDue = $0.50, payment record created |
| $0 invoice creation | PASS | Accepted without error (product decision) |
| Tax-exempt customer $0 tax | PASS | isTaxExempt stored and honoured (0% tenant rate, no differential observable) |
| AR aging 30-day-old invoice overdue | PASS | isOverdue=true |
| AR aging invoice due today | BOUNDARY | isOverdue=true for dueDate=today (rule: dueDate ≤ today) — potential same-day grace issue |
| Overpayment blocked | PASS | 400 "Payment exceeds remaining balance of 100.00" |

### 9.B — Inventory Edge Results

| Test | Result | Notes |
|------|--------|-------|
| Oversell race (stock=1, two concurrent orders) | FAIL (P1) | Both return 201 — extends RF-017 |
| OOS ordering (stock=0) | FAIL (P1) | POST /buyer/orders succeeds at stock=0 — extends RF-017 |
| Buyer catalog OOS field | FAIL (P1) | GET /buyer/products returns no stock/inStock/available field — NEW |
| Stock adjustment audit log | PASS | Movements logged with performer, timestamp, type, reference |
| Adjustment reason persisted | FAIL (P3) | UI reason selector not transmitted to API — movement notes always null |

---

### RF-200 — GET /buyer/products returns no stock availability field: buyer UI cannot show OOS state (P1)

- **Severity:** P1
- **Domain:** buyer-portal / inventory
- **Surface:** API / web-buyer / mobile-buyer
- **Source:** W30 / 9.B.2
- **Issue:** `GET /buyer/products` (the buyer-facing product catalog endpoint) returns product records that contain no stock or availability information. The response includes `id, name, description, sku, barcode, unit, category, buyerPrice, unitsPerBox, isFeatured, thumbnailUrl, imageKeys` but has no `currentStock`, `inStock`, `stockStatus`, `available`, or equivalent field. The buyer UI therefore has no mechanism to grey out, hide, or label out-of-stock products. Combined with the lack of server-side stock validation at order creation (RF-017), buyers can add and order any product regardless of availability with no warning.
- **Expected:** `GET /buyer/products` returns an `inStock: boolean` or `stockStatus: "IN_STOCK" | "LOW" | "OUT_OF_STOCK"` field for each product. Out-of-stock items are visually distinguished (greyed out, "Out of stock" label, or hidden based on operator configuration).
- **Actual:** `GET /buyer/products` response contains no stock field of any kind. All products appear identically available regardless of their inventory level.
- **Repro:**
  1. Reduce a product's stock to 0 via operator inventory adjustment.
  2. Call `GET /buyer/products` as a buyer.
  3. Inspect any product in the response — no `inStock`, `currentStock`, or `stockStatus` field present.
  4. The product appears identical to in-stock products in the buyer catalog.
- **Fix:** Add an `inStock: boolean` (and optionally `stockStatus: string`) field to the buyer products DTO, computed from `product.currentStock > 0`. The buyer catalog component should render out-of-stock products with a greyed style and disabled Add-to-Cart button when `inStock: false`.
- **Prevention:** Add a DTO schema test verifying `GET /buyer/products` response includes stock availability data. Add a Playwright test ensuring a 0-stock product cannot be added to cart from the buyer UI.

---

### RF-201 — Inventory adjustment UI reason not transmitted to API: movement notes always null (P3)

- **Severity:** P3
- **Domain:** inventory / audit-trail
- **Surface:** web-operator / API
- **Source:** W30 / 9.B.3 sub-finding
- **Issue:** The stock adjustment UI presents a reason selector with options: Received / Damaged / Count correction / Waste / Other. The selected reason is a critical audit trail field that explains why stock changed. However, the submitted API payload contains only `{productId, quantity, reference}` — the selected reason is never included. The resulting `InventoryMovement.notes` field is always `null`. Operators reviewing the movement ledger cannot distinguish between a damaged write-off and a count correction.
- **Expected:** The selected reason from the UI selector is included in the API payload as `notes` or `reason`. The resulting movement record shows the reason text in the audit log.
- **Actual:** `POST /inventory/movements/adjustment` payload: `{productId, quantity, reference}`. `movement.notes = null` on all records regardless of reason selected.
- **Repro:**
  1. Navigate to a product detail page.
  2. Click "Adjust Stock."
  3. Select "Damaged" as the reason.
  4. Enter a quantity and submit.
  5. `GET /inventory/movements` — the new record shows `notes: null`.
- **Fix:** In the stock adjustment form component, include the selected reason in the POST body (e.g., `notes: selectedReason` or `adjustmentType: selectedReason`). Ensure the `notes` field is accepted and persisted by the API endpoint.
- **Prevention:** Add an API test verifying that `POST /inventory/movements/adjustment` with a `notes` body field persists the value in the resulting movement record.

---

### RF-202 — isOverdue=true for invoice due today: same-day grace boundary not documented (P3)

- **Severity:** P3
- **Domain:** finance-pricing / invoices
- **Surface:** API
- **Source:** W30 / 9.A.5
- **Issue:** The `isOverdue` computed property on invoices uses the rule `dueDate <= today`. An invoice with `dueDate = today` is flagged `isOverdue: true` even though the day has not yet ended. Depending on business expectations, some operations treat same-day invoices as still-due (not overdue) until end-of-business. This affects AR aging display and any automated overdue-escalation workflows.
- **Expected:** Business rule is documented and consistently applied. If same-day = still due, rule should be `dueDate < today`. If same-day = overdue, current behavior is correct but should be documented.
- **Actual:** `dueDate = today` → `isOverdue: true`. No documentation of the intended boundary behavior.
- **Repro:**
  1. Create an invoice with `dueDate = today`.
  2. Send it.
  3. `GET /invoices/:id` → `isOverdue: true`.
- **Fix:** Define the business rule explicitly: if same-day should NOT be overdue, change the condition to `dueDate < today` (strict). Update any AR aging reports to use the same boundary. Document the rule in the API spec.
- **Prevention:** Add a unit test explicitly asserting the boundary: invoice due today → PASS or FAIL overdue check, per documented business rule.

---

## Phase 15 Summary Table

| RF | Severity | Source | Title |
|----|----------|--------|-------|
| RF-200 | P1 | W30/9.B.2 | GET /buyer/products returns no stock field — buyer UI cannot show OOS status |
| RF-201 | P3 | W30/9.B.3 | Inventory adjustment reason not transmitted to API — movement notes always null |
| RF-202 | P3 | W30/9.A.5 | isOverdue=true for invoice due today — same-day grace boundary undocumented |
