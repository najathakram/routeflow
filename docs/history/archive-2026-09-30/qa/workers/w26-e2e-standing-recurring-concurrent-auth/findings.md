# W26 � E2E-3/4/6/7

Worker: W26
Date: 2026-04-30
Method: Chrome browser + browser javascript_tool
Tenant: ux-audit-1777265477001

---

## E2E-3 � Standing Orders

### Buyer4 Login

- Buyer portal login endpoint: POST /api/v1/buyer/auth/login with X-Tenant-Slug header
- Standard operator login endpoint returns 401 for buyer accounts
- Buyer4 logs in successfully via customer portal UI

### UI Observation � Buyer Portal Standing Orders Page

- URL: /standing-orders
- Accessed via: More > Standing Orders in buyer portal nav
- UI shows: "Standing Orders � No standing orders."
- The page calls GET /api/v1/buyer/standing-orders which returns 404 Not Found

### API Fetch Results (buyer token)

- GET /buyer/standing-orders: 404 (route does not exist)
- GET /buyer/templates: 200, returns empty array (requires X-Tenant-Slug header)
- GET /buyer/order-templates: 404
- GET /standing-order-templates: 404
- GET /buyer/standing-order-templates: 404
- GET /order-templates (operator): 200, returns empty array

### Standing Order Data Found

- One order exists with standing-order notes: id 4489462b, notes: Auto-generated from standing order: UX Weekly Protein & Almonds, status: PENDING
- The origin field on all 20 orders is null (no origin=standing value set)
- The templateId on the standing-generated order is also null
- No pause/skip UI available (empty state page only)

### Operator-Side Orders Check (admin token)

- GET /api/v1/orders: 20 orders total, 0 with origin field set
- 1 order has standing-order text in notes field, but no structured metadata

---

## E2E-4 � Recurring Invoices

### UI Observation

- /invoices page tabs: All, Draft, Sent, Overdue, Paid, Voided � no Recurring tab
- Navigating to /invoices/recurring redirects to /home (route not registered)
- No Create Recurring button visible anywhere

### API Fetch Results

- GET /invoices/recurring: 404 (treated as ID param)
- GET /recurring-invoices: 200 � returns 2 recurring invoice templates

### Recurring Invoice Templates

Both for customer UX Delivered Deli:

- 6fef478d: MONTHLY, isActive=false, nextRunAt=2026-05-01, lastRunAt=null
- 61bc82ba: MONTHLY, isActive=true, nextRunAt=2026-05-01, lastRunAt=null

### RF-151 � endDate Field Confirmed Missing

- PATCH /api/v1/recurring-invoices/:id with {endDate:2026-12-31} returns 200 OK
- endDate field NOT in response (silently ignored by Prisma)
- Subsequent GET also has no endDate field
- Field does not exist in DB schema

### Child Invoice Auto-Generation

- recurringInvoiceId field exists in Invoice schema
- 0 invoices currently have recurringInvoiceId set
- Active template nextRunAt is 2026-05-01, lastRunAt is null

---

## E2E-6 � Concurrent Edits

### Test Setup

- Product: Almond Mix 16oz (ID: f31568b9-99bd-4a86-ae76-85f2b7da7704)
- Original price: 8.99

### Promise.all Concurrent PATCH Results

Run 1: status1=200 price1=5.99, status2=200 price2=7.99, finalPrice=5.99
Run 2: status1=200 price1=5.99, status2=200 price2=7.99, finalPrice=7.99
Product restored to 8.99 after test.

### Findings

- No conflict detection (no OCC, ETag, or version field)
- Both concurrent requests return 200 with no error
- Final value is non-deterministic (last DB write wins)
- Silent data loss: one write discarded with no notification

---

## E2E-7 � Auth Edge Cases

### Test 1: Wrong Tenant Code via UI

- Input: bad-tenant-code in company code field
- UI response: Company code not found. Check with your administrator.
- Behavior is correct

### Test 2: Wrong Password / Lockout

- 10 consecutive failed attempts tested
- All returned: 401 {message: Invalid credentials}
- After all attempts, correct password still works (200 + token)
- No lockout, no rate limit, no CAPTCHA, no attempt counter in response
- UI shows Invalid credentials with no warning about future lockout

### Test 3: Invalid Tenant Code via Fetch � CRITICAL BUG FOUND

Test A (correct behavior � tenantCode in body):
POST /api/v1/auth/login body: {identifier: ux_admin, password: UxAdmin@123!, tenantCode: INVALID-TENANT-CODE-XYZ}
Response: 401 Unauthorized

Test B (BUG � no X-Tenant-Slug header):
POST /api/v1/auth/login body: {username: ux_admin, password: UxAdmin@123!}
Response: 200 with valid JWT

JWT payload: sub=8dbfdcf3, username=ux_admin, role=TENANT_ADMIN, tenantId=null, tenantSlug=null, isAdmin=true

Test C (BUG � invalid X-Tenant-Slug header):
POST /api/v1/auth/login headers: X-Tenant-Slug=INVALID-TENANT-CODE-XYZ
Body: {username: ux_admin, password: UxAdmin@123!}
Response: 200 with same null-tenant JWT

The null-tenant token can access:

- GET /products: 200, 20 products from 2 FOREIGN tenant IDs (<live-tenant-uuid>, 584e28dc)
- GET /customers: 200, 20 customers
- GET /orders: 200, 20 orders
- GET /users: 200, 14 users

Cross-tenant data leak confirmed. The ux-audit tenant (8ee7bbf5) normally has 13 products under valid auth. The null-tenant token sees 20 products from completely different tenants.

Root cause: When no valid X-Tenant-Slug is resolved, auth issues a token with tenantId=null. Data queries with null tenantId lack tenant filtering, returning cross-tenant data.

### Test 4: Forgot Password Link

- Forgot? link is present on the login page (next to Remember me checkbox)

### Test 5: localStorage Token Structure

Admin session: accessToken (15-min JWT), refreshToken (3-day JWT), tenantSlug, routeflow-offline-queue
Buyer session: buyerAccessToken, buyerRefreshToken, buyerActiveSeller
Tokens stored in plain localStorage (JavaScript-accessible, not HttpOnly cookies)

---

## Bug Summary

| #   | Severity    | Description                                                                                                                                                                                                                                       |
| --- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | P0 CRITICAL | Null-tenant token cross-tenant data leak: Login without valid X-Tenant-Slug header issues tenantId=null JWT. This token bypasses tenant isolation and reads foreign-tenant data (products, customers, orders, users from other tenants verified). |
| B2  | P1 HIGH     | No brute-force protection: No rate limiting, lockout, or CAPTCHA after 10+ failed login attempts.                                                                                                                                                 |
| B3  | P1 HIGH     | GET /buyer/standing-orders endpoint missing: Buyer portal UI calls this route, backend returns 404. Standing orders page always shows empty state.                                                                                                |
| B4  | P2 MEDIUM   | endDate field missing from RecurringInvoice schema (RF-151 confirmed): PATCH silently ignores endDate, returns 200 with no error.                                                                                                                 |
| B5  | P2 MEDIUM   | No recurring invoice UI: No Recurring tab, no Create Recurring button. Correct endpoint is /recurring-invoices but is not accessible from UI.                                                                                                     |
| B6  | P2 MEDIUM   | Concurrent writes cause silent data loss: No OCC/ETag/version. Two concurrent PATCHes both return 200; one write is silently discarded non-deterministically.                                                                                     |
| B7  | P3 LOW      | Standing order origin field not set: Auto-generated orders have origin=null instead of origin=standing. Cannot filter by origin field.                                                                                                            |
| B8  | P3 LOW      | Tokens in plain localStorage: Access and refresh tokens are JS-readable. HttpOnly cookies would reduce XSS exposure.                                                                                                                              |
