# PENDING APPEND — Phase 12 (W32) + Phase 13 (W33)
# DO NOT EDIT MASTER REPORT UNTIL ENHANCEMENT AGENT (a5717f8c2d384d48a) COMPLETES

---

## Phase 12 — Standing Orders, Locale/Timezone, and Memory Bug Regressions (W32)

**Worker:** W32 | **Date:** 2026-04-30 | **Method:** Chrome browser + javascript_tool

### Phase 9.D — Standing Order Scheduling Corners

**Template discovery:** Two MONTHLY recurring invoice templates exist in the ux-audit tenant. Both have `lastRunAt: null` — the scheduler has never fired. One is paused (`isActive: false`), one active (`isActive: true`), both with `nextRunAt: 2026-05-01`.

**Pause/enable:** `PATCH /recurring-invoices/{id}` with `{isActive: false}` returns 200 and persists correctly. No per-occurrence "skip" capability exists — toggling `isActive` is all-or-nothing.

**Edit propagation:** Notes edits persist successfully (200 OK). Child invoice propagation is untestable because the scheduler has never fired in this tenant.

**Buyer-side:** `GET /buyer/standing-orders` → 404 (already filed as RF-180).

### E2E-8 — Locale and Timezone

**Date display:** Orders page shows `"Apr 30"` (relative-month), invoices `"3/30/2026"` (US M/D/YYYY), finance `"Apr 28, 2026"`. No raw UTC strings shown. Currency is consistent US dollar format across all pages. **PASS.**

**requestedDeliveryDate storage:** `POST /orders` with `requestedDeliveryDate: '2026-12-31T23:30:00Z'` → 201, but response and follow-up GET show field as `null`. **RF-173 CONFIRMED.**

### Memory Bug Regressions

| Bug | Result | Notes |
|-----|--------|-------|
| #1 GET /route-runs/my-stats → 200 | PASS | Confirmed by W29 |
| #2 Buyer can cancel own PENDING order | PASS | POST /buyer/orders/{id}/cancel → 200 "Order cancelled" |
| #3 PATCH /customers/me buyer profile edit | PARTIAL-FAIL | Fix works for operator-token CUSTOMER flow; PATCH /buyer/profile → 404 |
| #4 GET /buyer/returns filtered to customer | FAIL | Endpoint missing entirely → 404 |
| #5 Route-run create with no POD photos → 201 | PASS | Confirmed, no constraint error |
| #6 Driver change-password title | N/A | Mobile-only screen |

---

### RF-185 — PATCH /buyer/profile returns 404: buyers cannot edit their own profile

- **Severity:** P2
- **Domain:** buyer-portal
- **Surface:** API / web-buyer
- **Source:** W32 / Memory Bug #3
- **Issue:** Memory bug #3 was reported as fixed by adding `PATCH /customers/me` to the operator-facing customers controller. However, buyer portal users authenticate via a separate auth system and use `/buyer/*` endpoints. `PATCH /buyer/profile` returns 404 — no such route exists. Buyers currently have no way to update their name, phone, or address via the API. `GET /buyer/profile` (GET) returns 200 and shows their profile; only the write path is missing.
- **Expected:** `PATCH /buyer/profile` with updated fields returns 200 with the updated buyer profile.
- **Actual:** `PATCH /buyer/profile` returns 404 "Cannot PATCH /api/v1/buyer/profile". Buyer profile is read-only.
- **Repro:**
  1. Log in as a buyer (`ux_buyer1_1777265477001@ux-audit.test` / `UxBuyer@123!`).
  2. Call `GET /buyer/profile` — 200, profile data returned.
  3. Call `PATCH /buyer/profile` with `{businessName: "Test Edit"}` — 404.
- **Fix:** Add a `PATCH /buyer/profile` endpoint to the buyer router that calls the buyer's customer record update. Reuse the same DTO validation as the operator-facing `PATCH /customers/me` endpoint.
- **Prevention:** When a fix is noted as "add PATCH /customers/me", verify it also covers the buyer-portal auth flow at `/buyer/profile`. Add integration tests covering both auth paths for profile edit.

---

### RF-186 — GET /buyer/returns returns 404: no buyer-facing returns endpoint

- **Severity:** P2
- **Domain:** buyer-portal / returns
- **Surface:** API / web-buyer / mobile-buyer
- **Source:** W32 / Memory Bug #4
- **Issue:** Memory bug #4 was reported as fixed by adding customer-role filtering in `returns.service.ts::findAllForUser()`. However, the fix only affects the operator-facing `/returns` endpoint when called with a CUSTOMER-role token. There is no `/buyer/returns` endpoint in the buyer router. Buyers have no API path to view their own returns, and the buyer portal has no returns list screen.
- **Expected:** `GET /buyer/returns` (authenticated as buyer) returns the buyer's own return records (DAMAGED, QUALITY_ISSUE, etc.).
- **Actual:** `GET /buyer/returns` returns 404 "Cannot GET /api/v1/buyer/returns". No returns list or detail accessible to buyers.
- **Repro:**
  1. Log in as buyer (`ux_buyer2_1777265477001@ux-audit.test` / `UxBuyer@123!`).
  2. Call `GET /buyer/returns` — 404.
  3. Try `GET /returns` with buyer token — 401 (correctly rejected from operator path).
- **Fix:** Add `GET /buyer/returns` and `GET /buyer/returns/:id` to the buyer router. Wire them to `returns.service.ts::findAllForUser()` which already has the customer-scoping logic.
- **Prevention:** Ensure buyer-portal feature coverage is verified in both the `/buyer/*` router AND the web/mobile buyer UI screen. Add a buyer-portal endpoint coverage test that maps every buyer feature (returns, orders, invoices, profile, standing orders) to its corresponding `/buyer/*` endpoint.

---

### RF-187 — /finance/dashboard web route shows "Unmatched Route" 404

- **Severity:** P3
- **Domain:** operator-ux / navigation
- **Surface:** web-operator
- **Source:** W32 / E2E-8 observation
- **Issue:** Navigating directly to `/finance/dashboard` produces an "Unmatched Route" error page. The correct URL for the finance section is `/finance`. Any deep-link, bookmark, or documentation pointing to `/finance/dashboard` produces an error page.
- **Expected:** `/finance/dashboard` either renders the finance dashboard or redirects to `/finance`.
- **Actual:** "Unmatched Route" error page — no redirect, no meaningful error message.
- **Repro:**
  1. Log in as operator.
  2. Navigate directly to `https://routeflowmobile-production.up.railway.app/finance/dashboard`.
  3. Observe "Unmatched Route" error page.
- **Fix:** Add a redirect from `/finance/dashboard` → `/finance` in the app router, or register `/finance/dashboard` as an alias. Update any documentation/links referencing `/finance/dashboard`.
- **Prevention:** Add a link-checker step to CI that validates all internal navigation targets resolve to non-error pages.

---

## Phase 12 Summary Table

| RF | Severity | Source | Title |
|----|----------|--------|-------|
| RF-185 | P2 | W32/Bug#3 | PATCH /buyer/profile returns 404 — buyer profile is read-only |
| RF-186 | P2 | W32/Bug#4 | GET /buyer/returns returns 404 — no buyer-facing returns endpoint |
| RF-187 | P3 | W32/E2E-8 | /finance/dashboard route → "Unmatched Route" 404 |

---

## Phase 13 — Bulk Operations, Browser Rendering, and Accessibility (W33)

**Worker:** W33 | **Date:** 2026-04-30 | **Method:** Chrome browser + javascript_tool + axe-core

### 9.L Bulk Operations

**Bulk delete UI:** No checkboxes, select-all, or bulk toolbar on `/orders`. Confirmed at both UI layer (W33) and API layer (W28). **GAP at both layers.**

**CSV export UI:** No export button of any kind on `/orders`. Confirmed at both UI (W33) and API layers (W28, API rejects `?format=csv`). **GAP at both layers.**

**Rapid order create (RF-172):** 5 sequential `POST /orders` for same customer × product → all 5 return the same order ID. Distinct `notes` payloads and varying `qty` values silently dropped on upsert. **RF-172 CONFIRMED.**

**Orders/customers search:** Client-side only (0 API calls while typing confirmed via fetch interceptor). No pagination — all records rendered in a single list. With a large tenant, this would cause significant performance degradation.

**Product images:** `/products` renders 0 `<img>` elements. Image upload exists in the API but images are never rendered in the web UI.

### 9.G Browser Rendering

**Zoom 200%:** PASS — no horizontal overflow, all nav elements fit within viewport.

**Print stylesheet:** `/invoices/:id` redirects to `/home`. Zero `@media print` CSS rules anywhere. No PDF export. **GAP.**

**Mobile 375px:** PASS — React Native Web's mobile-first design adapts cleanly to 375px.

### 9.I Accessibility (axe-core 4.7.0)

**Color contrast sitewide:** Secondary text `#89898d`/`#8a8a8e` on light backgrounds achieves 3.39–3.43:1; WCAG AA requires 4.5:1 for normal text. Affects 9–16 nodes per page across all pages tested.

**Landmark structure:** Zero `<main>` elements and zero `<h1>` on any page — entirely absent sitewide.

**Keyboard navigation:** Zero `:focus` CSS rules (no focus ring), no skip-to-content links, interactive controls use `div[tabindex=0]` instead of semantic `<button>`/`<a>`.

**Form ARIA:** Zero `<label>`, `aria-label`, `aria-labelledby`, `aria-describedby`, `aria-invalid`, or `aria-live` on any form input. Errors cannot be announced to screen readers.

**Status badges:** Status chips (Pending, Confirmed, etc.) use unstyled `<div>` with no ARIA role or label. Text is visible (not color-only) but semantically opaque to screen readers.

---

### RF-188 — No invoice PDF export and no invoice detail route

- **Severity:** P2
- **Domain:** invoices / operator-ux
- **Surface:** web-operator
- **Source:** W33 / 9.G.2
- **Issue:** The invoices list at `/invoices` has no "View", "Download PDF", or detail link. Navigating to `/invoices/:id` (clicking any invoice) redirects to `/home`. There are zero `@media print` CSS rules, no PDF download buttons, and no print layout. For a delivery SaaS whose core financial workflow involves sending invoices to buyers, the inability to view or export a single invoice from the web operator dashboard is a critical UX gap.
- **Expected:** Each invoice in the list is clickable, opening a detail view with line items, totals, due date, and a PDF download/print button. The PDF matches the branded tenant template.
- **Actual:** `/invoices/:id` redirects to `/home`. No invoice detail view or PDF export exists on the web operator dashboard.
- **Repro:**
  1. Log in as operator.
  2. Navigate to `/invoices`.
  3. Click any invoice — redirected to `/home`.
  4. Attempt direct navigation to `/invoices/[any-uuid]` — redirected to `/home`.
- **Fix:** Implement an invoice detail route at `/invoices/:id` with: line items table, status, totals, payment history, and a PDF download button. The PDF route at `GET /invoices/:id/pdf` already exists in the API — wire it to a download button.
- **Prevention:** Add a coverage check ensuring every list page has a working detail route before merging. The plan defined `/invoices/[id]` as a test target — add it to the automated smoke test checklist.

---

### RF-189 — Color contrast failures sitewide — secondary text does not meet WCAG AA 4.5:1

- **Severity:** P2
- **Domain:** accessibility / design
- **Surface:** web-operator
- **Source:** W33 / 9.I.1 (axe-core 4.7.0 scan)
- **Issue:** Secondary text across metadata, subtitles, timestamps, and secondary labels uses `#89898d` on `#fcfcfd` (ratio 3.39:1) and `#8a8a8e` on `#ffffff` (ratio 3.43:1). WCAG AA requires 4.5:1 for normal-weight text at ≤18pt. This affects 9–16 elements per page and is a sitewide design-system issue, not isolated to one component.
- **Expected:** All text on non-decorative UI elements meets WCAG AA 4.5:1 contrast ratio.
- **Actual:** Secondary text achieves 3.39–3.43:1 — 24–25% below WCAG AA minimum. Axe flags 9–16 nodes per page as "serious" violations.
- **Repro:**
  1. Navigate to `/home`, `/orders`, or `/new-order`.
  2. Run `axe.run()` in console after loading axe-core from CDN.
  3. Observe `color-contrast` violations in the results.
- **Fix:** Darken secondary text color from `#89898d` → approximately `#767679` (achieves 4.5:1 on white). Update the design token/theme file so the change propagates sitewide. Verify fix with axe-core before merging.
- **Prevention:** Add axe-core to the CI pipeline (`@axe-core/playwright` or `@axe-core/react`). Block merges that introduce new color-contrast violations. Add a design system lint rule for minimum contrast ratios on text tokens.

---

### RF-190 — No semantic landmark structure: missing `<main>` and `<h1>` sitewide

- **Severity:** P2
- **Domain:** accessibility
- **Surface:** web-operator
- **Source:** W33 / 9.I.1
- **Issue:** Every page lacks a `<main>` landmark element and a `<h1>` heading. React Native Web renders a `<div>` root structure without semantic HTML5 landmarks. Screen reader users cannot jump directly to the main content area ("skip to main"), and the page hierarchy is semantically flat. Axe flags `landmark-one-main`, `page-has-heading-one`, and `region` on every page.
- **Expected:** Each page has one `<main>` element wrapping primary content and one `<h1>` identifying the page/section.
- **Actual:** Zero `<main>` elements, zero `<h1>` on any page audited.
- **Repro:** Run `document.querySelector('main')` on any page → `null`. Run `document.querySelector('h1')` → `null`.
- **Fix:** Wrap primary content in a `<main role="main">` component (or equivalent ARIA landmark). Add a visually-shown or visually-hidden `<h1>` to each page that reflects the page title (e.g., "Orders", "Dashboard", "Customers"). In Expo Web, use `<View role="main">` or the `accessibilityRole="main"` prop.
- **Prevention:** Add axe-core landmark checks to CI. Add an ESLint rule or Expo custom linter rule requiring `accessibilityRole="main"` on top-level screen components.

---

### RF-191 — No keyboard focus ring: interactive elements have no visible focus indicator

- **Severity:** P2
- **Domain:** accessibility / keyboard-navigation
- **Surface:** web-operator
- **Source:** W33 / 9.I.2
- **Issue:** Zero `:focus` or `:focus-visible` CSS rules exist in any stylesheet. React Native Web generates utility class styles without standard browser focus rings. Interactive elements (order cards, status tabs, nav items) all use `div[tabindex=0]` rather than semantic `<button>` or `<a>`, further defeating the browser's default focus behavior. No skip-to-content links exist. Keyboard-only users and users with motor disabilities cannot navigate the app.
- **Expected:** Every interactive element shows a clear visible focus ring when focused via keyboard. Tab order is logical. Skip-to-content link is present at the top of the page.
- **Actual:** Zero focus indicators in CSS. Interactive elements are non-semantic divs. Keyboard navigation is partially functional (Tab reaches elements) but no visual indicator shows which element has focus.
- **Repro:**
  1. Load `/orders`.
  2. Press Tab repeatedly — elements receive focus but no ring is visible.
  3. Run `document.querySelectorAll(':focus-visible')` → empty during keyboard navigation.
- **Fix:** Add global CSS: `:focus-visible { outline: 2px solid #0052cc; outline-offset: 2px; }`. Replace interactive `div[tabindex=0]` elements with `<Pressable role="button">` (Expo) or `<button>` (web). Add a skip-to-content anchor as the first focusable element.
- **Prevention:** Add axe-core focus-order tests to CI. Add a Playwright keyboard-navigation smoke test that Tabs through each major page and verifies at least one element has a visible focus ring.

---

### RF-192 — Form inputs lack all ARIA labels and error associations

- **Severity:** P2
- **Domain:** accessibility
- **Surface:** web-operator
- **Source:** W33 / 9.I.4
- **Issue:** All form inputs across the app have no `<label>`, no `aria-label`, no `aria-labelledby`, no `aria-describedby`, no `aria-invalid`, and no `aria-live` announcements. Validation errors appear as visual text below fields but are not associated with the field programmatically. Screen readers cannot: (a) announce the field's purpose when focused, or (b) announce validation errors when they appear.
- **Expected:** Every input has a programmatic label accessible to screen readers. Validation errors are announced via `aria-live="polite"` or associated with inputs via `aria-describedby`.
- **Actual:** Zero labeled inputs, zero error associations on any tested form including `/new-order`.
- **Repro:**
  1. Navigate to `/new-order`.
  2. Run `Array.from(document.querySelectorAll('input')).map(i => ({label: document.querySelector('[for="'+i.id+'"]'), ariaLabel: i.ariaLabel}))` → all null.
- **Fix:** Add `<label htmlFor>` or `aria-label` to every input. Add `aria-describedby` pointing to error message containers. Set `aria-invalid="true"` when a field fails validation. Add `role="alert"` or `aria-live="polite"` to error containers.
- **Prevention:** Add a form-accessibility lint rule (eslint-plugin-jsx-a11y) that errors on inputs without labels. Add axe-core "form-field-multiple-labels" and "label" checks to CI.

---

### RF-193 — No bulk order selection, delete, or CSV export at UI or API layer

- **Severity:** P2
- **Domain:** operator-ux / data-export
- **Surface:** web-operator / API
- **Source:** W33 / 9.L.1, 9.L.2 (extending W28 API findings)
- **Issue:** The orders list has no checkbox column, no "Select all" control, and no bulk action toolbar. The API has no bulk delete endpoint and rejects `GET /orders?format=csv`. Both layers are absent. For a tenant managing hundreds of daily orders, the inability to export or bulk-manage orders is a significant workflow gap.
- **Expected:** Orders list has a checkbox for each row + a "Select all" control. A bulk actions menu allows delete, status change, and CSV export of selected orders.
- **Actual:** No checkboxes, no bulk toolbar, no export button at UI layer. API has no bulk endpoint or CSV export support.
- **Repro:**
  1. Navigate to `/orders`.
  2. Inspect DOM — `document.querySelectorAll('input[type="checkbox"]').length` → 0.
  3. API: `GET /orders?format=csv` → returns JSON, not CSV.
- **Fix:** (1) Add checkbox column to orders list. (2) Add "Select all" toggle. (3) Add bulk action toolbar (delete selected, change status). (4) Add `GET /orders?format=csv` API response using `fast-csv` or similar. (5) Add "Export CSV" button wired to the API endpoint.
- **Prevention:** Add bulk operations and export to the product requirements before implementation. Add a Playwright test for export: click Export, verify file download begins with correct Content-Disposition header.

---

### RF-194 — Client-side-only search with no server-side pagination on orders and customers

- **Severity:** P2
- **Domain:** performance / scalability
- **Surface:** web-operator
- **Source:** W33 / 9.L.4, 9.L.5
- **Issue:** The orders and customers list pages load all records in a single API call, then filter in-browser. The search field triggers zero API calls while typing (confirmed via fetch interceptor). With a small test tenant (9 customers, ~14 orders), performance is acceptable. With a real tenant having hundreds of customers and thousands of orders, the initial payload and in-browser filtering will cause significant lag, memory pressure, and timeout failures.
- **Expected:** Search triggers a debounced API call (`GET /orders?search=<term>`). Lists paginate (e.g., 25 records per page with Load More / pagination controls).
- **Actual:** All records loaded on mount. Search is client-side only. Zero pagination controls. Zero API calls during search.
- **Repro:**
  1. Navigate to `/orders`.
  2. Open DevTools Network tab.
  3. Type in the search box — 0 network requests fired.
- **Fix:** (1) Add `search`, `page`, and `limit` query params to `GET /orders` and `GET /customers` API endpoints. (2) Wire the UI search fields to debounced API calls (300ms). (3) Add pagination controls (Load More or numbered pages).
- **Prevention:** Set a performance budget: list pages must not load more than 50 records per page. Add a performance test verifying the orders page loads within 2s with 10,000 order records in the DB.

---

### RF-195 — Product images not rendered in web UI (0 `<img>` elements on /products)

- **Severity:** P2
- **Domain:** products / operator-ux
- **Surface:** web-operator
- **Source:** W33 / 9.L.6
- **Issue:** The `/products` page renders product names, SKUs, units, prices, and stock levels as text only. Zero `<img>` elements exist in the DOM. The API supports `POST /products/:id/images` (confirmed), and the product data includes image URLs, but the web UI never renders them. Operators cannot visually identify products, making barcode-less workflows significantly harder.
- **Expected:** Each product card on `/products` displays a thumbnail image (or a placeholder image icon if no image is uploaded).
- **Actual:** `/products` shows 0 `<img>` elements. Products are text-only.
- **Repro:**
  1. Navigate to `/products`.
  2. Run `document.querySelectorAll('img').length` → 0.
- **Fix:** Read `product.imageUrls[0]` (or whichever field stores the primary image URL) and render it as a `<Image>` component on each product card. Show a placeholder icon if `imageUrls` is empty or null.
- **Prevention:** Add a visual regression test with a product that has an uploaded image — verify the image renders in the products list.

---

### RF-196 — Status badges lack ARIA roles: not announced as status by screen readers

- **Severity:** P3
- **Domain:** accessibility
- **Surface:** web-operator
- **Source:** W33 / 9.I.3
- **Issue:** Status chips (Pending, Confirmed, Out, Delivered, Cancelled) are plain `<div>` elements with no `role`, `aria-label`, or `aria-describedby`. Screen readers encounter raw divs with text but no semantic indication that they represent status indicators. Combined with color coding, status communication relies on both color and text (good), but the programmatic semantics are absent.
- **Expected:** Status badges use `role="status"` or `aria-label="Order status: Pending"` so screen readers announce them appropriately.
- **Actual:** `aria-label: null`, `role: null` on all status elements.
- **Repro:** Run `document.querySelectorAll('[class*="status"]').forEach(el => console.log(el.role, el.ariaLabel))` on `/orders` → all null.
- **Fix:** Add `role="img"` and `aria-label="Status: {status}"` to status badge components. Alternatively use `role="status"` if the badge updates dynamically. Update the shared status chip component so the fix propagates everywhere.
- **Prevention:** Add an axe-core test verifying status elements have ARIA labels. Add jsx-a11y lint rule for `role="img"` on decorative status elements.

---

## Phase 13 Summary Table

| RF | Severity | Source | Title |
|----|----------|--------|-------|
| RF-188 | P2 | W33/9.G.2 | No invoice PDF export + /invoices/:id redirects to /home — invoice detail missing |
| RF-189 | P2 | W33/9.I.1 | Color contrast sitewide failure — 3.39:1 vs WCAG AA 4.5:1 requirement |
| RF-190 | P2 | W33/9.I.1 | No semantic landmark structure — zero `<main>` and `<h1>` on any page |
| RF-191 | P2 | W33/9.I.2 | No keyboard focus ring — zero `:focus` CSS rules; interactive elements are non-semantic divs |
| RF-192 | P2 | W33/9.I.4 | Form inputs lack all ARIA labels and error associations |
| RF-193 | P2 | W33/9.L.1-2 | No bulk order select/delete/export at UI or API layer |
| RF-194 | P2 | W33/9.L.4-5 | Client-side-only search with no server-side pagination on orders and customers |
| RF-195 | P2 | W33/9.L.6 | Product images not rendered in web UI — /products shows zero img elements |
| RF-196 | P3 | W33/9.I.3 | Status badges lack ARIA roles — not announced as status by screen readers |
