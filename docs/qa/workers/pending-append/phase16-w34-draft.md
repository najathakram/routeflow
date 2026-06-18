# PENDING APPEND — Phase 16 (W34: Phase 1 Browser Walk — Routes, Customers, Products, Invoices, Finance)

---

## Phase 16 — Phase 1 Browser Walk: Routes, Customers, Products, Invoices, Finance (W34)

**Worker:** W34 | **Date:** 2026-04-30 | **Method:** Chrome browser + javascript_tool

### 1.4 — Routes & Dispatch

- Route list renders correctly (3 routes with driver, stop counts, status).
- Route detail shows stop list with customer names, reorder controls. **Stop addresses not shown — customer names only.**
- `POST /routes/:id/optimize` (API): reorders stops correctly. **BUG: UI "Optimize" button navigates to /drivers instead of staying on page.**
- Dispatch page: runs listed correctly. **BUG: W32-Bug5-Test route appears twice in "All routes" list.**
- **BUG (P0): /routes/create shows only title "Route" + spinner — form never renders.**

### 1.5 — Customers

- Customer list: 9 customers, search works. No Import or Merge buttons visible in UI.
- **BUG (P2): Customer with 1000+ char business name overflows all customer-picker surfaces.**
- **BUG (P1): XSS payload `<img src=x onerror=alert("XSS-W18")>` stored as customer business name — appears as text (not executing) but must be sanitized before display.**
- Customer detail: shows account standing, pricing, contact, actions. **Missing tabs: Orders, Invoices, Returns, Documents, Standing Orders.**
- **BUG (P0): /customers/create shows only "Customer" + spinner — form never renders.**

### 1.6 — Products

- Product list: 14 products, stock filter tabs (All/In stock/Low/Out) work. Missing: grid/list toggle, barcode scanner button, bulk select/delete.
- Product detail: shows SKU, barcode, unit, base price, stock, adjust button, movement log. **Price tiers not displayed (API has 5 tiers, UI shows base price only).**
- **BUG (P0): /products/create shows only "Product" + spinner — form never renders.**

### 1.7 — Invoices

- Invoice list: 20 invoices, tab navigation (All/Draft/Sent/Overdue/Paid/Voided) visible.
- **BUG (P1): "Voided" tab sends `?status=VOIDED` but DB stores `VOID` — always returns 0 results despite 6 VOID invoices.**
- **BUG (P1): "Overdue" tab sends `?status=OVERDUE` — not a stored status, computed — always 0 results (RF-174 confirmed).**
- **BUG (P0): /invoices/:id redirects to /home — invoice detail inaccessible (RF-188 confirmed).**
- pdfUrl: null on SENT invoices — no PDF generated (RF-153 confirmed).
- **No "Create Invoice" button anywhere on the invoice list page.**
- **BUG (P0): /invoices/create shows only "Invoice" + spinner — form never renders.**

### 1.8 — Finance

- /finance renders as "VENDOR BILLS & EXPENSES" — not a revenue/KPI dashboard. Shows vendor bill total, Scan Invoice button, vendor bills navigation.
- **BUG (P2): /finance/expenses → 404 "Unmatched Route" (correct URL: /expenses).**
- **BUG (P2): /finance/payments → 404 "Unmatched Route."**
- **BUG (P2): /finance/dashboard → 404 "Unmatched Route" (RF-187 confirmed).**
- **BUG (P2): /bookkeeping → 404 "Unmatched Route."**
- **BUG (P2): /payments → 404 "Unmatched Route."**
- /vendor-bills, /expenses, /analytics, /suppliers all render correctly at their direct paths.
- Analytics KPIs: Revenue $32, Expenses $64, Net -$32, A/R $106, DSO 1d, Avg order $25.

---

### RF-203 — SYSTEMIC: All "Create" forms show only a spinner and never render (P0)

- **Severity:** P0
- **Domain:** operator-ux / all-create-flows
- **Surface:** web-operator
- **Source:** W34 / 1.4, 1.5, 1.6, 1.7
- **Issue:** Every "Create" page in the operator web dashboard — `/routes/create`, `/customers/create`, `/products/create`, `/invoices/create` — renders only the page title and a persistent spinner. No form fields appear. Operators cannot create any of these core entities through the web UI. This is a systemic failure affecting all creation flows. Root cause is likely a broken data-loading dependency (e.g., a required API call that fails silently, leaving the form component in an indefinite loading state).
- **Expected:** Navigating to `/routes/create`, `/customers/create`, `/products/create`, or `/invoices/create` displays a form with the appropriate input fields for creating that entity.
- **Actual:** Each create page shows only the page title and a spinner. No form fields appear after waiting 30+ seconds.
- **Repro:**
  1. Log in as operator.
  2. Navigate to any of: `/routes/create`, `/customers/create`, `/products/create`, `/invoices/create`.
  3. Wait 30 seconds — only a spinner is visible. No form fields appear.
- **Fix:** Debug the create page components to identify the failing dependency query. Likely causes: (a) a required lookup (e.g., customer list for invoice create, driver list for route create) is failing silently and blocking form render; (b) a missing `isLoading` guard is showing a spinner when no data is needed; or (c) a route guard redirecting before form loads. Add error boundaries to catch and display silent fetch failures instead of infinite spinners.
- **Prevention:** Add Playwright smoke tests for each create route: navigate to `/routes/create`, assert at least one form input field is visible within 5s. Add error boundary components wrapping all create pages to prevent silent infinite loading. Add to PR checklist: test all create flows before merging.

---

### RF-204 — Invoice "Voided" tab sends `status=VOIDED` but database uses `VOID` — always returns 0 results (P1)

- **Severity:** P1
- **Domain:** invoices / operator-ux
- **Surface:** web-operator / API
- **Source:** W34 / 1.7
- **Issue:** The invoice list "Voided" filter tab sends `GET /invoices?status=VOIDED`. The database and API use the status value `VOID` (not `VOIDED`). The filter therefore always returns 0 results, even though 6 VOID invoices exist. The "Voided" tab appears to show an empty state, misleading operators into believing they have no voided invoices. (A parallel bug exists for the "Overdue" tab — RF-174.)
- **Expected:** The "Voided" tab displays all invoices with `status = VOID`.
- **Actual:** `GET /invoices?status=VOIDED` returns 0 results. Operators see an empty list on the Voided tab despite having VOID invoices.
- **Repro:**
  1. Void at least one invoice as operator.
  2. Click the "Voided" tab on the invoices list.
  3. Tab shows 0 results.
  4. Confirm: `GET /invoices?status=VOID` returns the voided invoices; `GET /invoices?status=VOIDED` returns 0.
- **Fix:** Change the frontend filter value for the Voided tab from `"VOIDED"` to `"VOID"` to match the API enum. Audit all other filter tab values (Sent, Draft, Partial, Paid) for similar mismatches.
- **Prevention:** Export the `InvoiceStatus` enum from the shared API types package (or a shared `@routeflow/types` package). Import and use it in the frontend filter components to prevent string mismatches. Add an integration test for each status filter tab verifying non-zero results for each valid status.

---

### RF-205 — Route "Optimize stops" button navigates to /drivers instead of optimizing (P1)

- **Severity:** P1
- **Domain:** routes / dispatch
- **Surface:** web-operator
- **Source:** W34 / 1.4
- **Issue:** On the route detail page, clicking the "Optimize stops" button navigates the user away to the `/drivers` page instead of triggering stop reordering and staying on the route detail. The API endpoint `POST /routes/:id/optimize` works correctly (returns 201 and reorders stops), but the UI's `onPress` handler is wired to the wrong navigation target.
- **Expected:** Clicking "Optimize stops" calls `POST /routes/:id/optimize`, shows a loading state, then refreshes the stop list with the optimized order — all on the same route detail page.
- **Actual:** Clicking "Optimize stops" navigates to `/drivers`. The route stops are unchanged from the operator's perspective (optimization may or may not run server-side before the navigation).
- **Repro:**
  1. Navigate to any route detail page.
  2. Click "Optimize stops."
  3. Browser navigates to `/drivers` page.
- **Fix:** In the route detail component, change the "Optimize stops" button's `onPress` handler from a navigation call to an API mutation call (`mutation.mutateAsync()` calling `POST /routes/:id/optimize`). After the mutation resolves, refresh the stops list.
- **Prevention:** Add a Playwright test: click "Optimize stops" on a route page, assert the user remains on the route detail page and the stop order changes.

---

### RF-206 — Route appears twice in Dispatch "All routes" list (P2)

- **Severity:** P2
- **Domain:** routes / dispatch
- **Surface:** web-operator
- **Source:** W34 / 1.4
- **Issue:** The dispatch page "All routes" dropdown/list shows certain routes duplicated (e.g., "W32-Bug5-Test" appears twice). The same duplication appears in the home page "Routes today" widget. Root cause is likely an API query that JOINs route runs to routes without deduplication, returning one row per run rather than one per route.
- **Expected:** Each route appears exactly once in the dispatch route list.
- **Actual:** Routes with multiple runs (or a run with a specific status) appear duplicated in the list.
- **Repro:**
  1. Navigate to `/dispatch`.
  2. Open the "All routes" list.
  3. A route with multiple runs appears twice in the list.
- **Fix:** In the routes query that populates the dispatch list, add `DISTINCT ON (routes.id)` or use Prisma's `include` with `take: 1` on the runs relation, or deduplicate in the service layer by `route.id`.
- **Prevention:** Add a test asserting the dispatch route list contains each route exactly once, even when that route has multiple historical runs.

---

### RF-207 — Customer detail page is missing Orders, Invoices, Returns, Documents, and Standing Orders tabs (P2)

- **Severity:** P2
- **Domain:** customer-management / operator-ux
- **Surface:** web-operator
- **Source:** W34 / 1.5
- **Issue:** The customer detail page shows only: account standing, pricing tier, contact info, and action buttons. The expected tabs — Orders (showing the customer's order history), Invoices (their billing history), Returns (return records), Documents (tax documents, certificates), and Standing Orders (recurring order templates) — are absent. Operators cannot view a customer's complete history from their detail page without navigating to each module separately and filtering.
- **Expected:** Customer detail page has tabs: Overview, Orders, Invoices, Returns, Documents, Standing Orders. Each tab loads the related records filtered to this customer.
- **Actual:** No tabs — only a static overview section. No linked record lists.
- **Repro:**
  1. Navigate to any customer detail page (`/customers/:id`).
  2. Observe no tab navigation beyond the overview.
- **Fix:** Add tabbed navigation to the customer detail component. Each tab fetches and renders the appropriate list filtered by `customerId`. Wire to existing API endpoints: `GET /orders?customerId=X`, `GET /invoices?customerId=X`, `GET /returns?customerId=X`, etc.
- **Prevention:** Add this to the Phase 1 acceptance criteria checklist: customer detail page must show linked orders, invoices, and returns tabs.

---

### RF-208 — Invoice list missing "Create Invoice" button (P2)

- **Severity:** P2
- **Domain:** invoices / operator-ux
- **Surface:** web-operator
- **Source:** W34 / 1.7
- **Issue:** The `/invoices` list page has no "Create Invoice", "New Invoice", or equivalent button. Operators have no in-UI path to create a new invoice from the invoice list. The create form exists at `/invoices/create` but is not linked from anywhere in the invoices UI. (The create form itself is also broken — RF-203.)
- **Expected:** The invoice list page has a prominent "Create Invoice" (or "New Invoice") button that navigates to the create form.
- **Actual:** No create button exists on the invoices list page. No navigation path to invoice creation is exposed.
- **Repro:**
  1. Log in as operator.
  2. Navigate to `/invoices`.
  3. No "Create Invoice" button visible anywhere on the page.
- **Fix:** Add a "Create Invoice" button (or FAB) to the invoice list page header. Wire it to navigate to `/invoices/create` (after RF-203 is fixed).
- **Prevention:** Add to the UI component checklist: every list page must have a "Create" entry point visible without scrolling.

---

### RF-209 — Finance sub-routes return "Unmatched Route" 404: correct paths omit /finance/ prefix (P2)

- **Severity:** P2
- **Domain:** finance / navigation
- **Surface:** web-operator
- **Source:** W34 / 1.8 (extends RF-187)
- **Issue:** Multiple finance-related routes are registered without the `/finance/` prefix, but the operator UI and plan documentation reference them with the prefix. Affected routes: `/finance/expenses` (correct: `/expenses`), `/finance/payments` (no working equivalent found), `/finance/dashboard` (correct: `/finance`), `/bookkeeping` (correct app path unclear), `/payments` (no working equivalent). Any operator who navigates to these URLs via bookmark, documentation link, or direct entry sees "Unmatched Route."
- **Expected:** Finance module sub-routes (`/finance/expenses`, `/finance/payments`, `/finance/dashboard`) render the appropriate screens, or redirect to the correct URL.
- **Actual:** "Unmatched Route" error page for: `/finance/expenses`, `/finance/payments`, `/finance/dashboard`, `/bookkeeping`, `/payments`.
- **Repro:**
  1. Navigate to `/finance/expenses`, `/finance/payments`, `/finance/dashboard`, `/bookkeeping`, or `/payments`.
  2. "Unmatched Route" error page displayed.
- **Fix:** Add router redirects: `/finance/expenses` → `/expenses`, `/finance/dashboard` → `/finance`. Add dedicated routes for `/finance/payments` and `/bookkeeping` if these modules are planned. Update all navigation links and documentation to use the correct paths.
- **Prevention:** Add a broken-link checker to CI that validates all internal hrefs and navigation targets resolve to non-error pages.

---

### RF-210 — Product price tiers not displayed in web UI: only base price shown (P3)

- **Severity:** P3
- **Domain:** products / pricing
- **Surface:** web-operator
- **Source:** W34 / 1.6
- **Issue:** The product detail page shows only the base price. The API returns 5 price tiers for products (confirmed), but the product detail component never renders them. Operators cannot view or edit tier pricing from the product detail page — they must use the API directly.
- **Expected:** Product detail page shows a price tier table: Base, Tier 1 (qty ≥ N), Tier 2 (qty ≥ N), etc., with edit controls.
- **Actual:** Only the base `price` field is displayed. Price tiers are invisible in the UI.
- **Repro:**
  1. Configure price tiers for a product via API.
  2. Navigate to that product's detail page.
  3. Only base price is shown; no tier table visible.
- **Fix:** Add a "Price Tiers" section to the product detail component. Fetch `GET /products/:id/price-tiers` (or equivalent) and render as an editable table.
- **Prevention:** Add a product detail smoke test asserting that tier pricing is visible when the product has configured tiers.

---

## Phase 16 Summary Table

| RF     | Severity | Source         | Title                                                                                   |
| ------ | -------- | -------------- | --------------------------------------------------------------------------------------- |
| RF-203 | P0       | W34/all-create | SYSTEMIC: all /create pages show spinner only — forms never render                      |
| RF-204 | P1       | W34/1.7        | Invoice "Voided" tab sends status=VOIDED but DB uses VOID — always returns 0 results    |
| RF-205 | P1       | W34/1.4        | Route "Optimize stops" button navigates to /drivers instead of optimizing               |
| RF-206 | P2       | W34/1.4        | Route appears twice in Dispatch "All routes" list                                       |
| RF-207 | P2       | W34/1.5        | Customer detail page missing Orders, Invoices, Returns, Documents, Standing Orders tabs |
| RF-208 | P2       | W34/1.7        | Invoice list has no "Create Invoice" button                                             |
| RF-209 | P2       | W34/1.8        | Finance sub-routes return 404 — correct paths omit /finance/ prefix                     |
| RF-210 | P3       | W34/1.6        | Product price tiers not displayed in web UI — only base price shown                     |
