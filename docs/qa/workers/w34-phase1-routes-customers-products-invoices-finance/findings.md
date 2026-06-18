# W34 — Phase 1 Browser Walk: Routes, Customers, Products, Invoices, Finance

Worker: W34
Date: 2026-04-30
Tenant: ux-audit-1777265477001 (ux_admin / UxAdmin@123!)

---

## 1.4 Routes & Dispatch

### Route list [PASS with observations]

- 3 routes shown: W32-Bug5-Test (0 stops, unassigned), UX Route B (1 stop, no driver), UX Route A (5 stops, ux_driver_a)
- UI briefly showed "2 templates" then corrected to "3 templates" on reload — minor loading-order flicker

### Route detail [PASS with observations]

- Route A detail renders: driver, vehicle (Ford Transit UXA), 5 stops with customer names, Move up/Move down reorder controls, Edit, Change driver, Add stop, View on map, Optimize stops, Dispatch run, Delete route
- Stop addresses NOT shown on route detail — only customer business names visible
- After the Optimize API ran, stop order changed confirming the optimization works at API level

### Optimize stops [PARTIAL]

- API POST /routes/:id/optimize returns 201 and reorders stops — functional
- BUG W34-01 (P1): Clicking the Optimize stops button in the UI navigates away to /drivers instead of staying on the route detail and showing the updated order

### Dispatch page [PASS with observations]

- /dispatch loads: shows today's runs, all routes section, routes without driver count
- BUG W34-02 (P2): W32-Bug5-Test appears TWICE in the "All routes" section on the dispatch page (duplicate row — one labeled as "Route" and one as "W32-Bug5-Test")
- Could not fully test Dispatch run modal date picker or driver dropdown due to navigation instability triggered by JS injection

### Create Route [FAIL]

- BUG W34-03 (P0): /routes/create renders blank — shows only the title "Route" and a loading progress bar with no form fields at all. Cannot create a new route via the UI.

### Console messages

- Early session: "Uncaught (in promise) SyntaxError: Unexpected token '<'" on /home and /orders — API returning HTML for some fetch requests during session start
- No further errors on route pages once session stabilized

### Route-runs API data (verified via API call)

- SCHEDULED: W32-Bug5-Test (0 stops), W32-Bug5-TestRoute (0 stops)
- IN_PROGRESS: UX Route A (5 stops), UX Route B (1 stop)
- CANCELLED: UX Route A (3 stops)

---

## 1.5 Customers

### Customer list [PASS with observations]

- 9 customers total: UX Empty Cafe, UX Delivered Deli, UX Overdue Bistro, UX Standing Grill, Test, W28 MultiAddr Test, W28 Tester, testXSS Test, W18 Security Test
- Search box works — "UX" correctly filters to 4 UX customers
- Tabs visible: Customers, Suppliers, Map
- No CSV Import button visible
- No Merge customers option visible

### Customer data quality issues [FAIL]

- BUG W34-04 (P2): One customer has a business name of 1000+ "A" characters. Causes display overflow in customer list, new-order customer picker modal, and any surface rendering customer names. Leftover test pollution.
- BUG W34-05 (P1 SECURITY): A customer's business name contains a raw HTML/JS XSS payload. The payload appears to be rendered as text (not executed) in the accessibility tree, but storing unescaped HTML in a name field is a stored XSS vulnerability present across all customer-name surfaces.

### Customer detail [PASS with observations]

- Renders: account standing (outstanding $0, overdue $0, pending orders $0, credit notes $0), pricing tier (Tier 1), contact info, actions (View orders, View invoices, Delete customer)
- Missing: no separate tab layout (expected Overview / Orders / Invoices / Returns / Documents tabs)
- Missing: no Standing Orders section or Create Standing Order button
- Missing: no Documents tab or upload button

### Customer create [FAIL]

- BUG W34-06 (P0): /customers/create renders blank — only "Customer" title and spinner. No form fields ever appear.

---

## 1.6 Products

### Product list [PASS with observations]

- 14 products listed; filter tabs All / In stock / Low / Out all function correctly
- Low stock indicator: Almond Mix 16oz (qty=1)
- Out of stock: Test Delete Product W26 (qty=0), W31 Test Product (qty=0)
- Missing: no grid vs list view toggle
- Missing: no barcode scanner button
- Missing: no bulk select or delete-selected functionality
- Inline price cell editing not verified (no direct click interaction available in tool)

### Product detail [PASS with observations]

- Renders: SKU, Barcode, Unit, single base price, stock on hand, Adjust stock button, Recent movements log with type/date/qty
- Missing: price tiers not displayed — API returns 5 price tiers (priceTier2 through priceTier5) but UI shows only the base price
- Missing: Add Image button (image area exists but no upload action surfaced)
- Missing: Variants section

### Product create [FAIL]

- BUG W34-07 (P0): /products/create renders blank — only "Product" title and spinner. No form fields.

---

## 1.7 Invoices

### Invoice list [PASS with observations]

- 20 invoices shown across all statuses
- Status filter tabs: All, Draft, Sent, Overdue, Paid, Voided
- Search box present (placeholder: "Search number, customer...")
- Missing: no Recurring tab (RF-182 confirmed)
- Missing: no Create Invoice or "+" button — no UI entry point to create invoices from this screen
- INV-2026-0021 shows $0.00 of $0.00 (zero-value draft invoice — minor data quality)

### Overdue filter tab [FAIL — RF-174 confirmed]

- BUG W34-08 (P1): Overdue tab sends ?status=OVERDUE to the API. The API has no OVERDUE status stored — overdue is computed client-side from dueDate vs today. The filter returns 0 results even though 3 invoices display "Overdue" in the All view.
- Overdue invoices visible in All view: INV-2026-0024 (API status SENT, due 3/30/2026), INV-2026-0014 (API status PARTIAL, due 4/29/2026), INV-2026-0013 (API status SENT, due 4/29/2026)

### Voided filter tab [FAIL]

- BUG W34-09 (P1): Voided tab sends ?status=VOIDED. The API stores voided invoices with status "VOID" (not "VOIDED"). Tab always returns 0 results even though 6 VOID invoices exist.
- Verified via API: ?status=VOID returns 6, ?status=VOIDED returns 0, ?status=OVERDUE returns 0

### Invoice detail [FAIL]

- BUG W34-10 (P0): Direct navigation to /invoices/:id redirects to /home. Invoice detail pages are entirely inaccessible via URL. Could not verify View PDF, Record Payment, or Void functionality in the UI.

### Invoice PDF [FAIL — RF-153 confirmed]

- BUG W34-11 (P1): API returns pdfUrl: null for SENT invoice INV-2026-0024. No PDF URL is generated even after invoices are sent.

### Invoice create [FAIL]

- BUG W34-12 (P0): /invoices/create renders blank — only "Invoice" title and spinner. No form fields.

### Console messages

- No errors captured on invoice pages

---

## 1.8 Finance

### Finance main page (/finance) [PASS with observations]

- Renders as "VENDOR BILLS & EXPENSES" — this is the vendor-side expense tracker, not a revenue or KPI analytics dashboard
- Shows: $270.50 total unpaid bills, Scan Invoice button, New Bill button, tab navigation to All bills / Expenses / Suppliers
- Recent bills widget shows last 2 bills
- No revenue charts, no accounts-receivable summary, no record-payment entry point

### Finance sub-routes [FAIL]

- BUG W34-13 (P2): /finance/expenses returns "Unmatched Route — Page could not be found."
- BUG W34-14 (P2): /finance/payments returns "Unmatched Route — Page could not be found."
- BUG W34-15 (P2): /finance/dashboard returns "Unmatched Route — Page could not be found."
- BUG W34-16 (P2): /bookkeeping returns "Unmatched Route — Page could not be found."
- BUG W34-17 (P2): /payments returns "Unmatched Route — Page could not be found."

### Vendor bills (/vendor-bills) [PASS]

- List works with filter tabs (All / Unpaid / Paid / Draft); 2 bills displayed
- Bill detail renders correctly: supplier name, bill number, status badge, dates, total, line items, Mark received and Void action buttons
- New Bill form (/vendor-bills/new) renders fully: supplier dropdown, bill date, due date, notes, line items section with Scan (OCR) capability per item, Add item, Cancel and Create bill buttons

### Expenses (/expenses) [PASS with observations]

- Works at /expenses (NOT at /finance/expenses which 404s)
- 11 expenses listed; filter tabs All / Pending / Paid / Void work
- Several W27-prefixed expenses present (test data from previous worker runs)

### Analytics (/analytics) [PASS with observations]

- Works at /analytics (NOT at /finance/analytics)
- KPI cards: Revenue $32, Expenses $64, Net income -$32, A/R Outstanding $106, Days Sales Outstanding 1d, Avg order value $25
- Top products: "Not enough data yet"
- Top customers: Test ($100), UX Delivered Deli ($83), UX Overdue Bistro ($13), test ($6)
- No export buttons visible; charts likely rendered as visual components not captured in text mode

### Console messages

- No errors on finance pages

---

## Additional Findings

### Systemic create-form failure [FAIL — highest priority]

- BUG W34-18 (P0 SYSTEMIC): All entity create pages show identical blank-loading failure: routes, customers, products, invoices. Each shows only the entity type title plus a loading progress bar. No form ever renders. This single root cause may be blocking all create flows.

### Home page duplicate route

- BUG W34-19 (P2): The home page "Routes today" widget lists W32-Bug5-Test twice — appears as both "W32-Bug5-TestRoute" and "W32-Bug5-Test" in the daily dispatch readiness panel. Related to W34-02.

---

## Bug Summary

| #      | Severity | Page               | Description                                                                         |
| ------ | -------- | ------------------ | ----------------------------------------------------------------------------------- |
| W34-01 | P1       | /routes/:id        | Optimize stops button navigates to /drivers instead of staying on route detail      |
| W34-02 | P2       | /dispatch          | W32-Bug5-Test route appears twice in All routes list (duplicate)                    |
| W34-03 | P0       | /routes/create     | Create route form never renders — blank spinner only                                |
| W34-04 | P2       | /customers         | 1000+ char customer name overflows all customer picker surfaces                     |
| W34-05 | P1       | /customers         | XSS payload stored as customer business name — stored XSS risk                      |
| W34-06 | P0       | /customers/create  | Create customer form never renders — blank spinner only                             |
| W34-07 | P0       | /products/create   | Create product form never renders — blank spinner only                              |
| W34-08 | P1       | /invoices          | Overdue tab sends status=OVERDUE — no such status in API, always returns 0 (RF-174) |
| W34-09 | P1       | /invoices          | Voided tab sends status=VOIDED — API uses VOID, always returns 0                    |
| W34-10 | P0       | /invoices/:id      | Invoice detail pages redirect to /home — entirely inaccessible                      |
| W34-11 | P1       | /invoices/:id      | pdfUrl null on SENT invoices — no PDF generated (RF-153)                            |
| W34-12 | P0       | /invoices/create   | Create invoice form never renders — blank spinner only                              |
| W34-13 | P2       | /finance/expenses  | 404 Unmatched Route                                                                 |
| W34-14 | P2       | /finance/payments  | 404 Unmatched Route                                                                 |
| W34-15 | P2       | /finance/dashboard | 404 Unmatched Route                                                                 |
| W34-16 | P2       | /bookkeeping       | 404 Unmatched Route                                                                 |
| W34-17 | P2       | /payments          | 404 Unmatched Route                                                                 |
| W34-18 | P0       | All /create pages  | SYSTEMIC: routes/customers/products/invoices create forms all blank                 |
| W34-19 | P2       | /home              | Routes today widget shows W32-Bug5-Test twice (duplicate row)                       |
| W34-20 | P2       | /customers/:id     | Customer detail missing Documents tab, Returns tab, Standing Orders section         |
| W34-21 | P3       | /products/:id      | Product detail shows only base price — 5 price tiers not displayed                  |
| W34-22 | P2       | /invoices          | No Create Invoice button on invoice list — no manual creation UI entry point        |
| W34-23 | P2       | /invoices          | No Recurring tab (RF-182 confirmed)                                                 |
| W34-24 | P3       | /routes/:id        | Stop addresses not shown in route detail — customer names only                      |
| W34-25 | P3       | /customers         | No CSV import button, no Merge customers option                                     |
