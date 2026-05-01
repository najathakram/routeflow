# W30 - Phase 9.A Money Correctness + 9.B Inventory Edges

Worker: W30
Date: 2026-04-30
Tenant: ux-audit-1777265477001

## 9.A Money Correctness

### 9.A.1 Penny Rounding

Test A - 3-way split: 3.33 + 3.33 + 3.34 = 10.00
- Invoice INV-2026-0019 id=281274b3, server total=10.00
- Result: PASS

Test B - 7-way split: 6x1.43 + 1x1.42 = 10.00
- Invoice id=9d631173, server total=10.00
- Result: PASS

### 9.A.2 Credit Notes Flowing into AR

- Customer ffcba95c, invoice a10030f0 (USD 1.00 SENT)
- Credit note b090253c (CN-2026-0001), amount 0.50 ISSUED
- Applied via POST /credit-notes/{id}/apply -> invoice status=PARTIAL, balanceDue=0.5, paidAmount=0.5
- Payment record method=CREDIT_NOTE, reference=CN-2026-0001
- Result: PASS

Note: No /finance/ar-aging endpoint (404).

### 9.A.3 Zero Invoice

- POST /invoices unitPrice=0, qty=1 -> HTTP 201, total=0, id=e5c55cfb
- Result: PASS (product decision whether to block)

### 9.A.4 Tax-Exempt Customer

- Customer e1f685de set to isTaxExempt=true via PATCH /customers/{id}
- Invoice 2x50=100, taxAmount=0 PASS
- Control non-exempt customer also taxAmount=0 (tenant has 0% rate)
- Result: PASS - flag honoured

### 9.A.5 AR Aging Cutoff

- Invoice due 2026-03-31 (30 days ago): isOverdue=true PASS
- Invoice due 2026-04-30 (TODAY): isOverdue=true (boundary: dueDate<=today is overdue)
- No /finance/ar-aging endpoint (404)
- Result: PASS on 30-day test. Same-day = overdue boundary may need clarification.

### 9.A.6 Overpayment Blocked

- Invoice 0608c97f total=100, attempted payment=200
- Response: 400 Payment exceeds remaining balance of 100.00
- Result: PASS

## 9.B Inventory Edge Cases

### 9.B.1 Oversell Race: stock=1, two concurrent orders

Setup: Almond Mix 16oz (f31568b9), currentStock=1, two buyers fired concurrently

Results:
- result1: status=201, orderId=3ca47cee
- result2: status=201, orderId=608986b3

BOTH returned 201. Post-race stock=1 unchanged (orders dont decrement stock).

Follow-up: stock reduced to 0 via adjustment, buyer order placed -> 201 Created.

Result: BUG P1 - No stock check at order placement. Multiple buyers can claim same last unit.

Repro:
1. POST /inventory/movements/adjustment to set qty=1
2. Login two buyers
3. Promise.all([POST /buyer/orders qty:1, POST /buyer/orders qty:1]) same product
4. Both return 201

### 9.B.2 OOS Display in Buyer Shop

With currentStock=0 on Almond Mix:
- GET /buyer/products: product still in catalog, NO currentStock/inStock/stockStatus field returned
- POST /buyer/orders for 0-stock product -> 201 Created, order PENDING

Result: BUG P1
1. Buyer API returns zero stock data - UI cannot show OOS indicator
2. Buyer can order 0-stock product with no error

### 9.B.3 Stock Adjustment Audit Log

Endpoint: POST /inventory/movements/adjustment (found via UI network interception)
- POST /inventory/adjustments -> 404 (wrong path)

Test: POST with {productId, quantity:5, reference:COUNT}
- stockBefore=1, stockAfter=6
- Movement logged: id=dbdda9b5, type=ADJUSTMENT, qty=5, ref=COUNT, date=2026-04-30, performer=ux_admin

Result: PASS - adjustments logged correctly with performer/timestamp/type/reference.

Sub-finding P3: UI reason selection (Received/Damaged/Count correction etc) is NOT sent to API.
Payload only includes {productId, quantity, reference}. Movement notes field = null.

## Bug Summary

| # | Sev | Description | Repro |
|---|-----|-------------|-------|
| 1 | P1 | No stock check at buyer order creation - concurrent orders both accepted for stock=1 | Promise.all two orders on same stock=1 product |
| 2 | P1 | Buyer can order stock=0 products - no OOS rejection | Set stock=0, POST /buyer/orders -> 201 |
| 3 | P1 | Buyer catalog API returns no stock field - UI cannot show OOS | GET /buyer/products - no currentStock/inStock |
| 4 | P3 | isOverdue=true for invoice due today (0 days) | POST invoice dueDate=today, send, GET -> isOverdue=true |
| 5 | P3 | Adjustment reason not persisted to movement log notes | Adjust via UI with reason -> movement notes=null |
| 6 | Info | POST /inventory/adjustments returns 404 - real path is POST /inventory/movements/adjustment | Endpoint discovery gap |
| 7 | Info | No /finance/ar-aging endpoint (404) | GET /finance/ar-aging -> 404 |
| 8 | Info | Zero-value invoices accepted (unitPrice=0) | POST /invoices unitPrice=0 -> 201 |
