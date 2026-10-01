# PENDING APPEND — Phase 17 (W35: Phase 1 Drivers/Returns/Settings/Vendor Bills + Phase 2 Buyer Portal)

---

## Phase 17 — Drivers, Returns, Settings, Vendor Bills + Buyer Portal (W35)

**Worker:** W35 | **Date:** 2026-04-30 | **Method:** Chrome browser + javascript_tool

### 1.9 — Drivers

| Bug    | Severity | Description                                                                |
| ------ | -------- | -------------------------------------------------------------------------- |
| W35-01 | P1       | /drivers immediately redirects to /routes — driver list page never renders |
| W35-02 | P1       | /drivers/add → "Unmatched Route" 404                                       |
| W35-03 | P1       | /drivers/:id → "Unmatched Route" 404                                       |

`canActAsDriver` field absent from driver API response. Driver vehicle/plate/edit/delete all untestable due to routing failures.

### 1.10 — Returns

| Bug    | Severity | Description                                                                                    |
| ------ | -------- | ---------------------------------------------------------------------------------------------- |
| W35-04 | P1       | /returns shows empty state despite confirmed APPROVED return (RET-2026-421539, DAMAGED) in API |
| W35-05 | P1       | /returns/:id → "Unmatched Route" 404 — return detail inaccessible                              |
| W35-06 | P2       | No "Create Return" button visible in operator UI                                               |

### 1.11 — Finance / Analytics

| Bug    | Severity | Description                                                    |
| ------ | -------- | -------------------------------------------------------------- |
| W35-07 | P2       | /finance/expenses → 404 (RF-209 confirmed)                     |
| W35-08 | P2       | /bookkeeping → 404 (RF-209 confirmed)                          |
| W35-09 | P2       | "Mark Received" button visible on already-RECEIVED vendor bill |
| W35-10 | P3       | Vendor Bills missing Partial and Void filter tabs              |
| W35-11 | P2       | GET /analytics → 404; only /analytics/revenue works            |

Finance page loads correctly at /finance: $270.50 owing, 2 unpaid bills. Analytics at /analytics: Revenue $32, Expenses $64, Net -$32.

### 1.12 — Settings

| Bug    | Severity | Description                                                            |
| ------ | -------- | ---------------------------------------------------------------------- |
| W35-12 | P1       | No Users tab — cannot manage users, canActAsDriver, or reset passwords |
| W35-13 | P1       | No Branding tab — no logo upload or brand color picker                 |
| W35-14 | P1       | No Integrations tab — no Zoho connector                                |
| W35-15 | P2       | No "Send Test" button for notifications                                |
| W35-16 | P2       | ZIP field accepts 4-digit input — no validation                        |
| W35-17 | P2       | Tax rate accepts -5 and 150 — no range validation                      |
| W35-18 | P1       | GET /tenant/settings → 404 — settings save may not persist             |
| W35-19 | P1       | /settings/users → "Unmatched Route" 404                                |

### Phase 2 — Buyer Portal (all 4 buyers)

| Bug    | Severity | Description                                                                               |
| ------ | -------- | ----------------------------------------------------------------------------------------- |
| W35-20 | P1       | /invoices renders Orders list component ABOVE Invoices content — routing/layout bug       |
| W35-21 | P1       | /more renders Orders list ABOVE More menu — same layout bug                               |
| W35-22 | P1       | POST /buyer/cart/items → 404 — add to cart completely broken                              |
| W35-23 | P1       | GET /buyer/cart → 404 — cart unreadable                                                   |
| W35-24 | P2       | No "Add to Cart" button on buyer product cards                                            |
| W35-25 | P2       | No favorite/bookmark button on buyer product cards                                        |
| W35-26 | P2       | /profile redirects to /orders in buyer portal                                             |
| W35-27 | P1       | GET /buyer/standing-orders → 404 (RF-180 confirmed)                                       |
| W35-28 | P1       | GET /buyer/me → 404 — buyer profile endpoint missing                                      |
| W35-29 | P1       | No buyer home/dashboard page — portal lands on /orders                                    |
| W35-30 | P2       | Buyer2 "Total Spend" shows $0 despite 3 DELIVERED orders                                  |
| W35-31 | P2       | Dual operator+buyer tokens in localStorage triggers company-code page on fresh navigation |
| W35-32 | P3       | Vendor Bills filter tabs missing Partial and Void status filters                          |

Confirmed working: Buyer2 PAID invoices show no Pay Now CTA. Buyer4 order statuses render correctly. Portal login at /customer-login works.

---

### RF-211 — /drivers page immediately redirects to /routes: driver list inaccessible (P1)

- **Severity:** P1
- **Domain:** drivers / operator-ux
- **Surface:** web-operator
- **Source:** W35 / 1.9
- **Issue:** Navigating to `/drivers` briefly renders the driver list (a GET /routes fires simultaneously), then immediately redirects to `/routes`. Operators cannot access the driver management page. Driver creation (`/drivers/add` → 404), driver detail (`/drivers/:id` → 404), and the `canActAsDriver` toggle are all inaccessible.
- **Expected:** `/drivers` renders a list of drivers (name, status, vehicle, canActAsDriver). `/drivers/add` renders a create form. `/drivers/:id` renders driver detail with edit controls.
- **Actual:** `/drivers` redirects to `/routes`. `/drivers/add` and `/drivers/:id` → "Unmatched Route" 404.
- **Repro:**
  1. Log in as operator.
  2. Navigate to `/drivers` — briefly sees driver list, then redirected to `/routes`.
  3. Navigate to `/drivers/add` or `/drivers/[any-uuid]` — "Unmatched Route" error.
- **Fix:** Fix the `/drivers` route definition to prevent the redirect. Register `/drivers/add` and `/drivers/:id` in the router. Check for a router configuration error that causes a navigation side-effect on mount (e.g., an `useEffect` navigating away in the driver list component).
- **Prevention:** Add Playwright smoke tests for each of: `/drivers`, `/drivers/add`, `/drivers/:id` — assert the correct component renders without redirect.

---

### RF-212 — /returns list shows empty state despite approved returns in API (P1)

- **Severity:** P1
- **Domain:** returns / operator-ux
- **Surface:** web-operator
- **Source:** W35 / 1.10
- **Issue:** The `/returns` page renders an empty state ("No returns found") even though at least one APPROVED return (RET-2026-421539, DAMAGED) exists in the API. `GET /returns` directly returns the record correctly. The returns list component either uses a different query, applies a filter that excludes APPROVED returns, or fails to load results silently. Additionally, `/returns/:id` → "Unmatched Route" 404.
- **Expected:** `/returns` displays all returns in the tenant. Each return is clickable and opens a detail view at `/returns/:id`.
- **Actual:** `/returns` shows empty state. `/returns/:id` → "Unmatched Route" 404.
- **Repro:**
  1. Log in as operator.
  2. Confirm `GET /returns` via API returns at least one APPROVED return record.
  3. Navigate to `/returns` in the UI — "No returns found."
  4. Navigate to `/returns/[any-uuid]` — "Unmatched Route" error.
- **Fix:** Debug the returns list component query. Check if it applies a status filter by default (e.g., `status=PENDING`) that excludes APPROVED returns. Remove or make the default filter configurable. Register `/returns/:id` in the router.
- **Prevention:** Add a Playwright test: create a return via API, navigate to `/returns`, assert the return appears. Add `/returns/:id` to the router smoke test list.

---

### RF-213 — Settings page missing Users, Branding, and Integrations tabs (P1)

- **Severity:** P1
- **Domain:** settings / operator-ux
- **Surface:** web-operator
- **Source:** W35 / 1.12
- **Issue:** The `/settings` page renders only: Business Profile, Invoicing, and Notifications tabs. The Users tab (for managing operator accounts, resetting passwords, toggling `canActAsDriver`), the Branding tab (logo upload, brand color), and the Integrations tab (Zoho connector) are entirely absent from the settings UI. Additionally, `/settings/users` → "Unmatched Route" 404 and `GET /tenant/settings` → 404 (settings save endpoint missing).
- **Expected:** Settings page shows 6 tabs: Business Profile, Invoicing, Users, Notifications, Branding, Integrations. Each renders the appropriate configuration UI.
- **Actual:** Only 3 tabs visible (Business Profile, Invoicing, Notifications). Users, Branding, Integrations tabs absent. `/settings/users` → 404. `GET /tenant/settings` → 404.
- **Repro:**
  1. Log in as operator.
  2. Navigate to `/settings`.
  3. Count the visible tabs — only 3 visible, not 6.
  4. Navigate to `/settings/users` — "Unmatched Route" error.
  5. Call `GET /tenant/settings` — 404.
- **Fix:** (1) Add the missing tabs to the settings tab navigator. (2) Register `/settings/users`, `/settings/branding`, `/settings/integrations` routes. (3) Implement the `GET /tenant/settings` API endpoint to read and return current tenant configuration. (4) Implement the `PATCH /tenant/settings` endpoint to persist changes.
- **Prevention:** Add acceptance tests for all 6 settings tabs before closing the settings feature. Add a route coverage test ensuring all documented `/settings/*` paths resolve without 404.

---

### RF-214 — Settings Business Profile fields have no validation: ZIP accepts 4-digit, tax rate accepts negative/over-100 (P2)

- **Severity:** P2
- **Domain:** settings / validation
- **Surface:** web-operator
- **Source:** W35 / 1.12
- **Issue:** The Business Profile settings form accepts invalid input without validation errors: (1) ZIP code field accepts "1234" (4 digits, US ZIP requires 5 or 5+4); (2) Tax rate field accepts "-5" (negative, invalid) and "150" (over 100%, invalid). Invalid values are submitted to the API without client-side rejection.
- **Expected:** ZIP field validates US format (5 digits or 5+4 "12345-6789"). Tax rate field validates range 0–100. Invalid inputs show inline error messages.
- **Actual:** Both fields accept invalid values without any validation feedback.
- **Repro:**
  1. Navigate to `/settings` → Business Profile tab.
  2. Enter "1234" in the ZIP field — no error shown.
  3. Enter "-5" in the tax rate field — no error shown.
  4. Enter "150" in the tax rate field — no error shown.
- **Fix:** Add client-side validation: ZIP pattern `/^\d{5}(-\d{4})?$/`; tax rate range `min=0 max=100`. Add server-side validation in the API DTO with `@IsPostalCode('US')` and `@Min(0) @Max(100)`. Both layers must validate independently.
- **Prevention:** Add form validation tests for all settings fields. Add API validation tests for the settings update endpoint with out-of-range inputs.

---

### RF-215 — POST /buyer/cart/items and GET /buyer/cart return 404: buyer cart completely broken (P1)

- **Severity:** P1
- **Domain:** buyer-portal / cart
- **Surface:** API / web-buyer / mobile-buyer
- **Source:** W35 / Phase 2
- **Issue:** The buyer cart API endpoints do not exist. `POST /buyer/cart/items` → 404; `GET /buyer/cart` → 404. The buyer UI also has no "Add to Cart" button on product cards. The entire cart-based buyer shopping flow is absent — buyers cannot add items to a cart, review a cart, or checkout via cart. (Direct `POST /buyer/orders` works as an alternative, but has no UI surface and skips the cart review step.)
- **Expected:** `POST /buyer/cart/items` adds a product to the buyer's cart. `GET /buyer/cart` returns the current cart with line items, quantities, and totals. The buyer product catalog shows an "Add to Cart" button on each product card.
- **Actual:** Both cart endpoints return 404. No "Add to Cart" button exists on product cards.
- **Repro:**
  1. Log in as buyer.
  2. `POST /buyer/cart/items` with `{productId, qty: 1}` → 404.
  3. `GET /buyer/cart` → 404.
  4. Navigate to buyer catalog — no "Add to Cart" button on any product card.
- **Fix:** Implement cart endpoints: `POST /buyer/cart/items`, `GET /buyer/cart`, `DELETE /buyer/cart/items/:id`, `POST /buyer/cart/checkout`. Alternatively, redesign the buyer checkout flow to use direct order creation (skipping persistent cart) but add a quantity stepper + "Place Order" CTA to the product catalog.
- **Prevention:** Add E2E buyer checkout test covering: browse catalog → add item → view cart → checkout → verify order created.

---

### RF-216 — Buyer portal /invoices and /more pages render Orders list above their own content (P1)

- **Severity:** P1
- **Domain:** buyer-portal / routing
- **Surface:** web-buyer
- **Source:** W35 / Phase 2
- **Issue:** In the buyer portal, navigating to `/invoices` renders the Orders list component in full above the Invoices content. Similarly, `/more` renders the Orders list above the More menu. The layout/routing has a layering bug where the Orders tab content bleeds into other tab views, making those pages nearly unusable.
- **Expected:** `/invoices` renders only the buyer's invoice list. `/more` renders only the More menu (profile, settings, sign out).
- **Actual:** Both pages render the Orders list component occupying the upper portion of the screen, with the actual page content below it.
- **Repro:**
  1. Log in as buyer.
  2. Navigate to the Invoices tab — Orders list appears at the top.
  3. Navigate to the More tab — Orders list appears at the top.
- **Fix:** Debug the tab navigator layout component. Check for a shared `<Orders>` component incorrectly rendered in the tab layout shell rather than within the Orders tab only. Check for a missing `key` prop on tab screens causing stale renders.
- **Prevention:** Add Playwright buyer portal tab navigation tests: navigate to each tab, assert only the expected content is visible (check DOM for absence of "Orders" heading on the Invoices and More tabs).

---

### RF-217 — GET /buyer/me returns 404: buyer self-profile endpoint missing (P1)

- **Severity:** P1
- **Domain:** buyer-portal / profile
- **Surface:** API / web-buyer
- **Source:** W35 / Phase 2
- **Issue:** `GET /buyer/me` → 404. Buyers have no API endpoint to fetch their own profile data. `GET /buyer/profile` returns 200 (buyer profile readable), but `/buyer/me` — which the buyer portal components likely call — is missing. This may cause the buyer's profile section to fail silently and show blank profile information.
- **Expected:** `GET /buyer/me` returns the authenticated buyer's profile (business name, contact, address).
- **Actual:** `GET /buyer/me` → 404 "Cannot GET /api/v1/buyer/me".
- **Repro:**
  1. Log in as buyer.
  2. `GET /buyer/me` → 404.
  3. `GET /buyer/profile` → 200 (works, but has different path than what components may expect).
- **Fix:** Either add a `/buyer/me` alias route that maps to the same handler as `/buyer/profile`, or ensure the buyer portal components use `/buyer/profile` consistently.
- **Prevention:** Audit all buyer portal API calls in the mobile app source — ensure all paths match deployed API endpoints. Add an API contract test for every `/buyer/*` endpoint.

---

### RF-218 — No buyer home/dashboard page: portal lands directly on /orders (P1)

- **Severity:** P1
- **Domain:** buyer-portal / ux
- **Surface:** web-buyer / mobile-buyer
- **Source:** W35 / Phase 2
- **Issue:** After buyer login, the portal navigates directly to the Orders list (`/orders`). There is no home/dashboard screen showing the buyer's account summary (balance, recent orders, invoice summary, outstanding amounts). The plan specified a buyer dashboard with KPI cards. The buyer has no at-a-glance financial or delivery summary view.
- **Expected:** Buyer portal home screen shows: outstanding balance, number of open orders, recent invoices summary, quick reorder from standing orders.
- **Actual:** Buyer portal opens directly on the Orders list. No dashboard or home screen exists.
- **Repro:**
  1. Log in as buyer.
  2. Observe landing page — orders list, no balance/dashboard.
- **Fix:** Implement a buyer home/dashboard screen as the default landing page. Wire to existing API endpoints: `GET /buyer/profile` (balance), `GET /buyer/orders?limit=3`, `GET /buyer/invoices?limit=3&status=SENT`.
- **Prevention:** Add the buyer dashboard as a gated acceptance criterion before Phase 2 sign-off. Add a buyer portal E2E test that validates the home screen renders KPIs.

---

### RF-219 — Buyer "Total Spend" shows $0 despite delivered orders (P2)

- **Severity:** P2
- **Domain:** buyer-portal / analytics
- **Surface:** web-buyer
- **Source:** W35 / Phase 2
- **Issue:** The buyer portal "More" page shows a "Total Spend" figure of $0 for Buyer 2, despite having 3 DELIVERED orders with invoices. The aggregate spend computation either uses the wrong data source (e.g., unpaid invoice balances only) or the query excludes DELIVERED orders from the spend total.
- **Expected:** "Total Spend" shows the sum of all completed order totals (or paid invoice amounts) for the buyer.
- **Actual:** "Total Spend" shows $0 despite existing delivered and paid orders.
- **Repro:**
  1. Log in as Buyer 2 (has delivered orders).
  2. Navigate to the "More" tab.
  3. "Total Spend" displays $0.
- **Fix:** Debug the "Total Spend" query. Ensure it sums `order.total` for DELIVERED orders (or `invoice.paidAmount` for PAID/PARTIAL invoices). Check for a null guard that's zeroing out results.
- **Prevention:** Add a buyer analytics integration test: verify Total Spend is non-zero for a buyer with confirmed paid orders.

---

### RF-220 — Dual operator+buyer tokens in localStorage triggers company-code page on fresh navigation (P2)

- **Severity:** P2
- **Domain:** auth / buyer-portal
- **Surface:** web-buyer / web-operator
- **Source:** W35 / Phase 2
- **Issue:** When both operator tokens (`accessToken`, `refreshToken`) and buyer tokens (`buyerAccessToken`, `buyerRefreshToken`) are present in localStorage (after logging into both), opening a new tab or performing a fresh navigation sends the user to the company code/tenant selection page instead of either the operator dashboard or buyer portal.
- **Expected:** Fresh navigation respects the most recently active session and routes to the appropriate dashboard.
- **Actual:** Fresh navigation triggers the company-code entry page, forcing the user to re-enter their tenant code even though they are already authenticated.
- **Repro:**
  1. Log in as operator.
  2. In the same browser, log in as buyer (different session).
  3. Open a new tab and navigate to the app URL.
  4. Company-code entry page appears instead of either dashboard.
- **Fix:** On app initialization, check for both token types. Prioritize the buyer token if on a buyer-portal route, or the operator token if on a dashboard route. Add a clear session-type indicator (`lastSessionType: 'operator' | 'buyer'`) to localStorage to guide routing.
- **Prevention:** Add an E2E test covering dual-session scenario: log in as operator, then buyer, then open fresh tab — assert correct landing page renders.

---

### RF-221 — Mark Received button active on already-RECEIVED vendor bills (P2)

- **Severity:** P2
- **Domain:** vendor-bills / operator-ux
- **Surface:** web-operator
- **Source:** W35 / 1.11
- **Issue:** The "Mark Received" action button is visible and clickable on vendor bills that already have `RECEIVED` status. Clicking it again would either create a duplicate receiving event, throw an error, or silently succeed as a no-op. The button should be hidden or disabled when the bill is already in RECEIVED state.
- **Expected:** "Mark Received" button is hidden or disabled (greyed out, not clickable) on bills with status=RECEIVED.
- **Actual:** "Mark Received" button visible and clickable on RECEIVED bills.
- **Repro:**
  1. Mark a vendor bill as Received.
  2. Observe the "Mark Received" button remains visible.
- **Fix:** Add a conditional render: `{bill.status !== 'RECEIVED' && <MarkReceivedButton />}`. If the button must remain visible as a historical indicator, disable it: `<Button disabled={bill.status === 'RECEIVED'}>`.
- **Prevention:** Add a component test: render vendor bill detail with `status='RECEIVED'` — assert "Mark Received" button is absent or disabled.

---

### RF-222 — GET /analytics returns 404: analytics API root endpoint missing (P2)

- **Severity:** P2
- **Domain:** analytics / API
- **Surface:** API / web-operator
- **Source:** W35 / 1.11
- **Issue:** `GET /analytics` → 404. The correct working sub-endpoint is `GET /analytics/revenue` (returns 200). The analytics API has no root endpoint or index route. Any component that navigates to `/analytics` (or tries `GET /analytics`) receives an error. The web UI analytics page at `/analytics` works only because it directly calls `/analytics/revenue` — but discovering the analytics API is non-obvious.
- **Expected:** `GET /analytics` returns either a summary of all analytics data or a 301/302 redirect to `/analytics/revenue`.
- **Actual:** `GET /analytics` → 404.
- **Repro:**
  1. `GET /analytics` → 404.
  2. `GET /analytics/revenue` → 200 (works).
- **Fix:** Add a root analytics controller handler at `GET /analytics` that returns a summary or redirects to `/analytics/revenue`. Alternatively, document the correct endpoint path prominently.
- **Prevention:** Add an API index test ensuring all controller paths have at least a root health/index route.

---

### RF-223 — Vendor Bills filter tabs missing Partial and Void status filters (P3)

- **Severity:** P3
- **Domain:** vendor-bills / operator-ux
- **Surface:** web-operator
- **Source:** W35 / 1.11
- **Issue:** The vendor bills list shows only a subset of the available status filters. The "Partial" (partially paid) and "Void" status filter tabs are missing. Operators cannot quickly view partially-paid or voided bills without applying a manual search or API filter.
- **Expected:** Vendor Bills filter tabs include: All, Draft, Received, Partial, Paid, Void.
- **Actual:** Only a subset of status filters visible. Partial and Void tabs absent.
- **Repro:**
  1. Navigate to `/vendor-bills`.
  2. Count the filter tab options — Partial and Void are not present.
- **Fix:** Add "Partial" and "Void" filter tabs to the vendor bills tab navigator, each filtering by the corresponding status value.
- **Prevention:** Add a vendor bills smoke test asserting all documented bill status filters are present in the UI.

---

## Phase 17 Summary Table

| RF     | Severity | Source     | Title                                                                                       |
| ------ | -------- | ---------- | ------------------------------------------------------------------------------------------- |
| RF-211 | P1       | W35/1.9    | /drivers redirects to /routes; /drivers/add and /:id → 404 — driver management inaccessible |
| RF-212 | P1       | W35/1.10   | /returns shows empty state despite APPROVED returns; /returns/:id → 404                     |
| RF-213 | P1       | W35/1.12   | Settings missing Users, Branding, Integrations tabs; GET /tenant/settings → 404             |
| RF-214 | P2       | W35/1.12   | Settings ZIP and tax rate fields have no validation                                         |
| RF-215 | P1       | W35/Phase2 | POST /buyer/cart/items and GET /buyer/cart → 404 — buyer cart completely broken             |
| RF-216 | P1       | W35/Phase2 | Buyer /invoices and /more pages render Orders list above their own content                  |
| RF-217 | P1       | W35/Phase2 | GET /buyer/me → 404 — buyer profile read endpoint missing                                   |
| RF-218 | P1       | W35/Phase2 | No buyer home/dashboard page — portal lands on /orders                                      |
| RF-219 | P2       | W35/Phase2 | Buyer "Total Spend" shows $0 despite delivered orders                                       |
| RF-220 | P2       | W35/Phase2 | Dual operator+buyer tokens trigger company-code page on fresh navigation                    |
| RF-221 | P2       | W35/1.11   | Mark Received button active on already-RECEIVED vendor bills                                |
| RF-222 | P2       | W35/1.11   | GET /analytics → 404 — analytics API root endpoint missing                                  |
| RF-223 | P3       | W35/1.11   | Vendor Bills missing Partial and Void filter tabs                                           |
