# W15 — Buyer Portal Browser Testing (All 4 Buyer Accounts)

**Audited:** 2026-04-30
**Scope:** Live buyer portal at `https://routeflowmobile-production.up.railway.app`
**Tenant:** `ux-audit-1777265477001`
**Accounts tested:** Buyer 1 (empty), Buyer 2 (delivered+PAID), Buyer 3 (CONFIRMED+OVERDUE), Buyer 4 (standing M/W/F)
**Status:** Browser testing completed

---

## Critical Context: Auth Isolation Problem

The buyer portal and operator portal share the same `localStorage` domain. `buyerAccessToken`/`buyerRefreshToken` and operator `accessToken`/`refreshToken` all live in `localStorage` at `routeflowmobile-production.up.railway.app`. When operator tabs are open, the buyer session is silently overwritten within seconds. This root bug caused many secondary failures; noted where relevant.

---

## Findings

### W15-001 — Buyer and Operator Tokens Share localStorage Namespace → Session Stomping (P0)

- **Severity:** P0
- **Screen:** Auth / All screens
- **Issue:** The buyer portal uses `buyerAccessToken` and the operator portal uses `accessToken`, but both live in the same `localStorage` at the same origin. Any open operator tab continuously writes its own `accessToken`, causing the buyer session to be silently invalidated within seconds.
- **Evidence:** `buyerAccessToken` present immediately after login; gone ~30 seconds later with operator tabs active. Confirmed via `localStorage` inspection.
- **Impact:** Buyers cannot maintain a session when the operator portal is also open. In practice, any multi-account workflow (operator + buyer testing) silently breaks buyer auth.
- **Fix:** Host buyer portal on a separate subdomain, OR use `sessionStorage` for buyer tokens, OR namespace all keys and guard auth initialization against stomping.

---

### W15-002 — Buyer Token Expiry Redirects to Operator Login (`/login`) Instead of `/customer-login` (P1)

- **Severity:** P1
- **Screen:** Auth
- **Issue:** On buyer token expiry/invalidation, app redirects to `/login` (operator "Staff & Drivers" page) instead of `/customer-login`.
- **Fix:** Buyer auth guard should redirect to `/customer-login` on 401.

---

### W15-003 — `/customer-login` Hijacked by Operator Session → Redirects to `/home` (P1)

- **Severity:** P1
- **Screen:** Auth / Login
- **Issue:** Navigating to `/customer-login` while an operator `accessToken` is in `localStorage` immediately redirects to the operator home (`/home`) — never shows buyer login form.
- **Fix:** Buyer portal route guard should check only `buyerAccessToken`, not `accessToken`.

---

### W15-004 — Invoice Detail Shows Infinite Spinner on 401 (P1)

- **Severity:** P1
- **Screen:** Invoices — Invoice Detail
- **Issue:** `GET /api/v1/buyer/invoices/:id` returns 401 → UI shows infinite spinner with no error message, no retry, no escape. Confirmed via network monitoring.
- **Fix:** Add 401 error handler in invoice detail; show "Unable to load invoice. Please sign in again" with link to `/customer-login`.

---

### W15-005 — "Place Order" Button Silently Fails When Buyer Token Is Missing (P1)

- **Severity:** P1
- **Screen:** Cart
- **Issue:** When buyer token is invalidated, clicking "Place order" does nothing — no toast, no redirect, no disabled state. CORS preflight fires but POST is dropped.
- **Note:** When buyer token IS valid (isolated clean session), checkout works correctly.
- **Fix:** Handle 401 from `POST /api/v1/buyer/orders` with user-facing error and redirect to buyer login.

---

### W15-021 — `GET /api/v1/buyer/standing-orders` Returns 404 (P1)

- **Severity:** P1
- **Screen:** More — Standing Orders
- **Issue:** Direct API call `GET /api/v1/buyer/standing-orders` (with valid auth token) returns 404. The UI shows standing orders via some other route, but the documented path doesn't exist.
- **Fix:** Verify and document the correct buyer standing-orders API route.

---

### W15-006 — Buyer-Portal Orders Have Timestamp-Based Order Numbers vs Sequential for Operator Orders (P2)

- **Severity:** P2
- **Screen:** Orders
- **Issue:** Buyer-portal orders: `#ORD-1777431385833` (13-digit timestamp). Operator orders: `#ORD-00001` (sequential). Mixed formats on the same orders list.
- **Fix:** Use the same sequential number generator for buyer-portal orders.

---

### W15-007 — No Delivery Timestamp on DELIVERED Order Detail (P2)

- **Severity:** P2
- **Screen:** Orders — Order Detail
- **Issue:** DELIVERED order detail shows only order creation date. No `deliveredAt` timestamp.
- **Fix:** Display `deliveredAt` field on DELIVERED orders.

---

### W15-008 — No PDF Download Button on Invoice Detail (P2)

- **Severity:** P2
- **Screen:** Invoices — Invoice Detail
- **Issue:** Invoice detail page has no "Download PDF" or "View PDF" action.
- **Fix:** Add PDF download CTA on invoice detail page.

---

### W15-009 — Dashboard Stats Missing Order Count and Unpaid Amount Values (P2)

- **Severity:** P2
- **Screen:** More — Profile / Stats
- **Issue:** Stats row shows "Orders | $0 Total Spend | Unpaid" but numeric values for "Orders" count and "Unpaid" amount are blank — only Total Spend shows a value.
- **Fix:** Bind orders count and unpaid balance from buyer profile API response to correct stat cells.

---

### W15-010 — Category Filter Pills Go Blank During Search (P2)

- **Severity:** P2
- **Screen:** Catalog / Shop
- **Issue:** When a search query is typed, category filter pill labels disappear — blank pill shapes visible while search results are correct.
- **Fix:** Ensure pill labels are not cleared by search state change.

---

### W15-011 — Scrolling on Invoice Detail Triggers Back Navigation (P2)

- **Severity:** P2
- **Screen:** Invoices — Invoice Detail
- **Issue:** Scrolling down on invoice detail navigates user back to Orders tab (reproduced once).
- **Fix:** Verify scroll gesture not intercepted as a "go back" navigation event.

---

### W15-012 — No Next Fire Date Shown on Standing Order Card (P2)

- **Severity:** P2
- **Screen:** More — Standing Orders
- **Issue:** Standing order card shows schedule days (Mon · Wed · Fri) but not the computed next fire date.
- **Fix:** Calculate and display next fire date on standing order card.

---

### W15-020 — Deep-Link Without Buyer Session Goes to Marketing Page, Not `/customer-login` (P2)

- **Severity:** P2
- **Screen:** Auth / Deep Links
- **Issue:** Direct URL to buyer routes (e.g., `/invoices`) without `buyerActiveSeller` in localStorage redirects to marketing homepage (`/`) instead of `/customer-login`.
- **Fix:** Buyer route guard should redirect to `/customer-login` when no buyer session exists.

---

### W15-013 — Products Not Listed on Standing Order Card (P3)

- **Severity:** P3
- **Screen:** More — Standing Orders
- **Issue:** Card shows "2 items" but is non-tappable and doesn't list product names.
- **Fix:** Make card tappable to detail screen, or show top product names inline.

---

### W15-014 — Delivery Date Field Shows Raw `YYYY-MM-DD` Format String as Placeholder (P3)

- **Severity:** P3
- **Screen:** Cart
- **Issue:** Delivery date field placeholder shows `YYYY-MM-DD` engineering format string.
- **Fix:** Replace with date picker or localized placeholder like "Select delivery date".

---

### W15-015 — Sign-Out Behavior Unverifiable Due to Auth Isolation Issue (P3)

- **Severity:** P3
- **Screen:** More — Sign Out
- **Issue:** Sign-out button present but behavior could not be fully verified due to W15-001 auth environment.
- **Fix:** Ensure sign-out clears `buyerAccessToken`, `buyerRefreshToken`, `buyerActiveSeller` and redirects to `/customer-login`.

---

## Summary Table

| ID      | Severity | Area            | Title                                                           |
| ------- | -------- | --------------- | --------------------------------------------------------------- |
| W15-001 | **P0**   | Auth            | Buyer/operator tokens share localStorage — session stomping     |
| W15-002 | P1       | Auth            | Token expiry redirects to operator login, not `/customer-login` |
| W15-003 | P1       | Auth            | `/customer-login` hijacked by operator session                  |
| W15-004 | P1       | Invoices        | Infinite spinner on 401                                         |
| W15-005 | P1       | Cart            | "Place order" silently fails when buyer token invalid           |
| W15-021 | P1       | Standing Orders | Buyer standing-orders API path 404                              |
| W15-006 | P2       | Orders          | Timestamp order numbers (13-digit) vs sequential                |
| W15-007 | P2       | Orders          | No delivery timestamp on DELIVERED orders                       |
| W15-008 | P2       | Invoices        | No PDF download on invoice detail                               |
| W15-009 | P2       | More            | Stats panel missing values                                      |
| W15-010 | P2       | Catalog         | Category pills blank during search                              |
| W15-011 | P2       | Invoices        | Scroll triggers back navigation                                 |
| W15-012 | P2       | Standing Orders | No next fire date shown                                         |
| W15-020 | P2       | Auth            | Deep-link without session goes to marketing page                |
| W15-013 | P3       | Standing Orders | Products not listed on card                                     |
| W15-014 | P3       | Cart            | Raw `YYYY-MM-DD` placeholder                                    |
| W15-015 | P3       | Auth            | Sign-out behavior unverifiable                                  |

**Total: 1 P0, 5 P1, 8 P2, 3 P3 = 17 findings**
