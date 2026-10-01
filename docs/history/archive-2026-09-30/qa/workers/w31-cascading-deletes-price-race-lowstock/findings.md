# W31 — Phase 9.C Cascading Deletes + 13.10 Price at Checkout + 13.13 Low-Stock

**Worker:** W31
**Date:** 2026-04-30
**Method:** Chrome browser + javascript_tool (all API calls via browser JS fetch)
**API Domain:** https://routeflowapi-production-d504.up.railway.app/api/v1
**Frontend:** https://routeflowmobile-production.up.railway.app
**Tenant:** ux-audit-1777265477001 (tenantId: 8ee7bbf5-991b-41b1-adcb-4a6c20981401)

---

## 9.C.1 — Delete customer with open orders

**Setup:** Created customer `W31 Delete Test Customer` (id: `d97b0b0a`), placed PENDING order `fe0c7785`.

**Delete attempt:** `DELETE /customers/d97b0b0a` → **200 `{"success": true}`**

**Verification after delete:**

- GET /customers/d97b0b0a → 404 (customer deleted)
- GET /orders/fe0c7785 → 404 (order ALSO deleted)

**RESULT: FAIL — P0 — Silent cascading delete.** Customer AND linked PENDING order both hard-deleted with no warning. Expected: 400 "Cannot delete customer with open orders" OR soft-delete preserving historical FK integrity. This is data loss — orders that have been placed and are awaiting fulfillment can be silently destroyed.

---

## 9.C.2 — Delete product referenced by open order

**Setup:** Created `W31 Test Product` (`989b7b25`), created order referencing it.

**Delete attempt:** `DELETE /products/989b7b25` → **400 `{"message": "Cannot delete product with active order items"}`**

**Order line item after failed delete:** productName: "W31 Test Product", qty: 1, unitPrice: 5 — snapshot preserved.

**RESULT: PASS** — deletion blocked; order line item snapshot intact.

---

## 9.C.3 — Delete driver with active route run

**Driver:** UX Driver Alpha (`d79a6f4a`), has 1 IN_PROGRESS run (`9f5256c9`).

**Delete attempt:** `DELETE /drivers/d79a6f4a` → **400 `{"message": "Cannot delete a driver with scheduled or in-progress route runs. Deactivate them instead."}`**

**RESULT: PASS** — blocked with clear, actionable error. Deactivate suggestion is good UX.

---

## 13.10 — Price change at checkout race

**Product:** Apple Juice 1L (`35137ede`), original price $4.49.

**Sequential case (order first, then price change):**

- Order placed at $4.49, then operator changed price to $99.99
- Order line item still shows unitPrice: "4.49" — price locked at order time
- RESULT: PASS for sequential case

**True race (simultaneous PATCH product + POST buyer order via Promise.all):**

- Both fired simultaneously
- Result: orderStatus 201, lineItemUnitPrice: "99.99", orderTotal: "$115.49"
- Buyer received NEW price ($99.99) with no warning or cart re-pricing notification
- RESULT: PARTIAL FAIL — P2

---

## 13.13 — Low-stock warning propagation

**Finding:** Buyer order placement does NOT decrement stock.

- Ordered 98 units of Apple Juice (stock=100) → stock remained at 100 after order placed
- Stock fields (currentStock, reorderPoint) rejected by both POST and PATCH product DTOs ("should not exist")
- Stock only adjustable via operator UI `/products/{id}/adjust-stock`

**Dashboard tile bug:**

- `GET /products?stockStatus=LOW&limit=1` → meta.total: 3, data: [1 item]
- Home dashboard "Low Stock" tile shows **"1"** (reads `data.length`) instead of **"3"** (reads `meta.total`)
- RESULT: FAIL — P2 — operator undercounts low-stock items by factor of (total/limit)

---

## New Issues Found

| #    | Severity | Description                                                                                                               |
| ---- | -------- | ------------------------------------------------------------------------------------------------------------------------- |
| NI-1 | **P0**   | DELETE /customers cascades to silently delete all linked orders — open PENDING orders destroyed with no warning           |
| NI-2 | P2       | Price-change-at-checkout race: simultaneous price edit + buyer checkout captures new price silently with no buyer warning |
| NI-3 | P2       | Home "Low Stock" dashboard tile shows data.length (1) instead of meta.total (3) — understates low-stock count             |
| NI-4 | INFO     | Buyer order placement does not decrement stock — stock only adjusts via manual operator adjustment                        |

---

## RF Numbers to Assign (new from W31)

- **RF-197**: DELETE /customers silently cascades to delete linked orders (P0)
- **RF-198**: Price-change-at-checkout race — buyer gets new price with no warning (P2)
- **RF-199**: Home "Low Stock" tile reads data.length instead of meta.total — understates count (P2)
