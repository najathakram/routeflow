# W35 - Phase 1.9-1.12 + Phase 2 Buyer Portal Walk

Worker: W35
Date: 2026-04-30
Tenant: ux-audit-1777265477001

## 1.9 Drivers

CRITICAL BUG: /drivers redirects immediately to /routes on every navigation. Network shows GET /api/v1/routes fired. Redirect is silent with no JS error.

Drivers briefly visible: ux_driver_b (Toyota HiAce, UXB1777265477001, active), ux_driver_a (Ford Transit, UXA1777265477001, active).

BUG-1 [CRITICAL]: /drivers redirects to /routes - page inaccessible.
BUG-2 [CRITICAL]: /drivers/add shows Unmatched Route 404.
BUG-3 [CRITICAL]: /drivers/:id shows Unmatched Route 404.

Vehicle plate, canActAsDriver, edit, status toggle, delete: all untestable.
API GET /api/v1/drivers: returns full data. canActAsDriver not in driver response.

## 1.10 Returns

BUG-4 [HIGH]: /returns shows empty state despite 1 APPROVED return in API (RET-2026-421539, DAMAGED).
BUG-5 [HIGH]: /returns/:id shows Unmatched Route 404.
BUG-6 [MEDIUM]: No Create Return button in operator UI.

Tabs: All, Pending, Processed, Cancelled. Return has creditNoteId=null.

## 1.11 Vendor Bills / Bookkeeping / Analytics

Finance (/finance): Loads OK. 2 unpaid bills, $270.50 owing.
Vendor Bills (/vendor-bills): Loads OK. 2 bills. Filters: All, Unpaid, Paid, Draft.
BUG-7 [LOW]: Missing Partial and Void filter tabs.
BUG-8 [MEDIUM]: Mark received button on already-RECEIVED bill.
New Bill: Form loads OK.
BUG-9 [HIGH]: /finance/expenses shows Unmatched Route 404.
BUG-10 [HIGH]: /bookkeeping shows Unmatched Route 404.
Analytics (/analytics): Loads OK. Revenue $32, Expenses $64, Net -$32, A/R $106, DSO 1d. Top products: not enough data. Top customers: Test $100, UX Delivered Deli $83.
BUG-11 [MEDIUM]: GET /api/v1/analytics returns 404. /analytics/revenue -> 200. /finance/dashboard -> 404.

## 1.12 Settings

Single-page form only - no tabs. Fields: Phone, Address, City, ZIP (12345), Tax Rate (0.155), Notifications toggle, Save.

BUG-12 [HIGH]: No Users tab - cannot manage users/canActAsDriver/reset passwords.
BUG-13 [HIGH]: No Branding tab - no logo upload or color picker.
BUG-14 [HIGH]: No Integrations tab - no Zoho.
BUG-15 [MEDIUM]: No Send Test button for notifications.
BUG-16 [MEDIUM]: ZIP accepts invalid format (4 digits) with no error.
BUG-17 [MEDIUM]: Tax rate accepts -5 and 150 with no error.
BUG-18 [HIGH]: GET /api/v1/tenant/settings returns 404 - save may not persist.
BUG-19 [HIGH]: /settings/users shows Unmatched Route 404.

## Phase 2 Buyer Portal

Login at /customer-login. Tokens: buyerAccessToken/buyerRefreshToken/buyerActiveSeller. Operator + buyer tokens coexist in localStorage.
Nav: Orders, Catalog, Invoices, More. No home/dashboard page - lands on /orders.

BUG-20 [CRITICAL]: /invoices page renders Orders list above Invoices content.
BUG-21 [HIGH]: /more page renders Orders list above More menu.

### Buyer 1 (ux_buyer1)

NOT empty - has 1 PENDING ($3391.46, 4 items), 6+ CANCELLED, 2 DELIVERED, 1 VOID invoice.
Cart (/orders/cart): Empty, loads OK.
BUG-22 [CRITICAL]: POST /api/v1/buyer/cart/items returns 404.
BUG-23 [CRITICAL]: GET /api/v1/buyer/cart returns 404.
BUG-24 [MEDIUM]: No Add to Cart button on product cards.
BUG-25 [MEDIUM]: No favorite button on products.
BUG-26 [MEDIUM]: /profile redirects to /orders.
GET /api/v1/buyer/me: 404.

### Buyer 2 (ux_buyer2 - delivered + PAID)

Orders: 3 DELIVERED, 1 CANCELLED.
Invoices: 3 PAID (INV-2026-0016, INV-2026-0006, INV-2026-0004), 1 PARTIAL (INV-2026-0005), 3 VOID.
PAID invoices: no Pay Now CTA. CORRECT. PAID detail: no Pay Now button. CORRECT.
BUG-27 [MEDIUM]: Total Spend $0 on More page despite delivered orders.

### Buyer 3 (ux_buyer3 - expected CONFIRMED + OVERDUE)

BUG-28 [MEDIUM]: Expected CONFIRMED order shows as PENDING. QA seed mismatch.
BUG-29 [MEDIUM]: Expected OVERDUE invoice not present. Only 1 PAID invoice. QA seed mismatch.
Overdue badge / Pay Now: untestable.

### Buyer 4 (ux_buyer4 - standing M/W/F)

Orders: 1 PENDING, 1 CONFIRMED, 1 OUT_FOR_DELIVERY. All display correctly.
BUG-30 [HIGH]: GET /api/v1/buyer/standing-orders returns 404.
BUG-31 [HIGH]: Standing orders shows No standing orders - M/W/F template missing from QA data.

## Bug Summary

| #   | Severity | Page                   | Description                                |
| --- | -------- | ---------------------- | ------------------------------------------ |
| 1   | Critical | /drivers               | Redirects to /routes immediately           |
| 2   | Critical | /drivers/add           | 404 Unmatched Route                        |
| 3   | Critical | /drivers/:id           | 404 Unmatched Route                        |
| 4   | High     | /returns               | Empty state despite APPROVED return in API |
| 5   | High     | /returns/:id           | 404 Unmatched Route                        |
| 6   | Medium   | /returns               | No Create Return button                    |
| 7   | High     | /finance/expenses      | 404 Unmatched Route                        |
| 8   | High     | /bookkeeping           | 404 Unmatched Route                        |
| 9   | Medium   | /vendor-bills/:id      | Mark received on already-RECEIVED bill     |
| 10  | Low      | /vendor-bills          | Missing Partial and Void filter tabs       |
| 11  | Medium   | /analytics             | GET /analytics returns 404                 |
| 12  | High     | /settings              | No Users tab                               |
| 13  | High     | /settings              | No Branding tab                            |
| 14  | High     | /settings              | No Integrations tab                        |
| 15  | Medium   | /settings              | No Send Test for notifications             |
| 16  | Medium   | /settings              | ZIP accepts invalid format                 |
| 17  | Medium   | /settings              | Tax rate accepts out-of-range values       |
| 18  | High     | /settings              | GET /tenant/settings 404                   |
| 19  | High     | /settings/users        | 404 Unmatched Route                        |
| 20  | Critical | Buyer /invoices        | Orders list on invoices page               |
| 21  | High     | Buyer /more            | Orders list on more page                   |
| 22  | Critical | Buyer /catalog         | POST /buyer/cart/items 404                 |
| 23  | Critical | Buyer /catalog         | GET /buyer/cart 404                        |
| 24  | Medium   | Buyer /catalog         | No Add to Cart button                      |
| 25  | Medium   | Buyer /catalog         | No favorite button                         |
| 26  | Medium   | Buyer /profile         | Redirects to /orders                       |
| 27  | High     | Buyer /standing-orders | GET /buyer/standing-orders 404             |
| 28  | High     | Buyer /standing-orders | No templates in QA data                    |
| 29  | Medium   | Buyer /more            | Total Spend $0 despite delivered orders    |
| 30  | Medium   | Buyer general          | Dual tokens cause company-code page        |
| 31  | Medium   | Buyer3                 | OVERDUE invoice missing from seed          |
| 32  | Medium   | Buyer3                 | CONFIRMED order shows as PENDING in seed   |
| 33  | High     | Buyer general          | No dashboard/home page                     |
| 34  | Medium   | Buyer general          | GET /buyer/me returns 404                  |
