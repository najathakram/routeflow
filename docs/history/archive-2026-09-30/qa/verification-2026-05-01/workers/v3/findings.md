# v3

| RF     | Status      | Evidence (≤ 30 words)                                                                                                                                               |
| ------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RF-002 | ❌ FAIL     | `window.io` undefined; no `wss://` entries in network panel on /home or /catalog after 30 s logged in as op and buyer                                               |
| RF-007 | ⚠️ PARTIAL  | Dispatch tab rendered in ~5 s (not 20–40 s); Warehouse tab ~7 s. Improvement observed but no skeleton shown — blank white during load                               |
| RF-090 | ❌ FAIL     | `/settings/users` → "Unmatched Route / Page could not be found". No Users tab in /settings                                                                          |
| RF-188 | ❌ FAIL     | `/invoices/7cf5d188-5563-46de-b09a-a56d35d69472` → redirects to `/home`. No invoice detail route                                                                    |
| RF-203 | ❌ FAIL     | `/routes/create` shows spinner for 15 s then redirects to `/home`. Form never renders                                                                               |
| RF-205 | ❌ FAIL     | "Optimize stops" button on route detail makes no network request; stays on page with no action. Not navigating to /drivers (old bug), but optimize POST never fires |
| RF-211 | ⚠️ PARTIAL  | `/drivers` now renders driver list (ux_driver_a, ux_driver_b) — redirect to /routes is FIXED. But `/drivers/add` → "Unmatched Route"                                |
| RF-212 | ⚠️ PARTIAL  | `/returns` renders with tabs (All/Pending/Processed/Cancelled). "Unmatched Route" is FIXED. But "No returns to process" despite API returning 1 APPROVED return     |
| RF-213 | ❌ FAIL     | Settings page shows only Business Profile + Invoicing tax rate + Notifications toggle. No Users, Branding, or Integrations tabs                                     |
| RF-215 | ⚠️ PARTIAL  | "+" Add to Cart button visible on catalog; click adds item (frontend local state). But `GET /buyer/cart` → HTTP 404; `POST /buyer/cart/items` not called            |
| RF-216 | ❌ FAIL     | Direct navigation to `/invoices` → redirects to `/orders` (Orders tabs shown, Orders bottom-nav active). URL: /orders                                               |
| RF-218 | ❌ FAIL     | Buyer login lands on `/orders`. No home/dashboard with balance or summary. `/home` redirects to `/orders`                                                           |
| RF-220 | ✅ VERIFIED | Buyer2 (has delivered orders) shows "$95 Total Spend" in More tab — not $0                                                                                          |

## Failures

### RF-002 — Frontend never connects to Socket.IO gateway

Repro: Log in as operator, stay on /home for 30 s; check `window.io` and network for wss:// entries. Expected: Socket.IO connection established. Got: `window.io === undefined`; zero socket/wss network entries on both op and buyer surfaces. Suspected cause: Socket.IO client not imported in Expo web bundle. Proposed fix: Wire socket client in root layout; connect on auth token available.

### RF-007 — Tab transition freeze (PARTIAL)

Repro: Click Dispatch or Warehouse tab. Expected: Skeleton + content within 2–3 s. Got: 5–7 s blank white before render — better than 20–40 s but still no skeleton indicator. Suspected cause: Heavy fetch blocks render; no Suspense boundary. Proposed fix: Add skeleton placeholders that display immediately.

### RF-090 — Settings Users tab absent

Repro: Operator → /settings → no Users tab; /settings/users → "Unmatched Route". Expected: Users tab with CRUD + role management. Got: Page not found. Suspected cause: Route not registered. Proposed fix: Register /settings/users and build Users management screen.

### RF-188 — Invoice detail /invoices/:id redirects to /home

Repro: Navigate to `/invoices/<valid-uuid>` as operator. Expected: Invoice detail screen. Got: Immediate redirect to /home. Suspected cause: Route unregistered in operator stack. Proposed fix: Register `/invoices/:id` route.

### RF-203 — Create forms spinner only

Repro: Navigate `/routes/create` or `/customers/create`. Expected: Form with input fields. Got: Spinner ~15 s then redirect to /home. Suspected cause: Auth guard loop before render. Proposed fix: Render form immediately; load secondary data async.

### RF-205 — Optimize stops button inert

Repro: Route detail with 5 stops → click "Optimize stops". Expected: POST /routes/:id/optimize called, stops reorder. Got: Zero network requests; page unchanged. Suspected cause: Click handler missing API call. Proposed fix: Implement POST /routes/:id/optimize in handler.

### RF-211 — /drivers/add Unmatched Route (PARTIAL)

Repro: `/drivers/add` → "Unmatched Route". Expected: Driver create form. Got: Page not found. Suspected cause: Sub-routes not registered. Proposed fix: Register `/drivers/add` and `/drivers/:id`.

### RF-212 — /returns empty despite APPROVED return (PARTIAL)

Repro: Operator → /returns; API returns total:1 APPROVED. Expected: Return listed. Got: "No returns to process." on all tabs. Suspected cause: UI filters for PENDING only or status mapping wrong. Proposed fix: All tab must pass no status filter; check field mapping.

### RF-213 — Settings missing Users/Branding/Integrations

Repro: Operator → /settings; observe tabs. Expected: Business Profile, Users, Invoicing, Branding, Notifications, Integrations. Got: Only contact fields + tax rate + one notification toggle. Suspected cause: Tabs not built. Proposed fix: Implement missing settings screens.

### RF-215 — Buyer cart API 404 (PARTIAL)

Repro: Buyer clicks "+" → UI shows cart (local state). GET /buyer/cart → 404. Expected: Server-persisted cart. Got: Frontend-only; cart lost on refresh. Suspected cause: /buyer/cart endpoint not registered. Proposed fix: Implement GET /buyer/cart and POST /buyer/cart/items.

### RF-216 — Buyer /invoices redirects to /orders

Repro: Buyer → navigate directly to `/invoices`. Expected: Invoices list. Got: Orders page with Orders tabs; URL = /orders; Orders nav active. Note: clicking Invoices bottom-nav tab from /orders works correctly. Suspected cause: Buyer router missing /invoices deep-link entry. Proposed fix: Register /invoices in buyer stack; fix bottom-nav push target.

### RF-218 — No buyer home/dashboard

Repro: Log in as buyer; /home → /orders. Expected: Dashboard with balance, order count, invoice summary. Got: /orders list. Suspected cause: Buyer stack has no home route. Proposed fix: Add buyer dashboard screen at buyer root.

## Adjacent bugs noticed

- NEW-v3-1 [P1] Buyer deep-links /more and /invoices via direct URL always redirect to /orders — router catch-all sends all unregistered buyer routes to /orders.
- NEW-v3-2 [P2] `GET /buyer/orders` returns HTTP 500 — buyer orders API broken server-side.
- NEW-v3-3 [P2] `GET /buyer/invoices` returns HTTP 500 — buyer invoices API broken; UI shows "No invoices yet."
- NEW-v3-4 [P2] `/returns` "All" tab-click navigates to /orders instead of showing all-status returns — same router issue as RF-216.
- NEW-v3-5 [P2] Rate-limit throttler active on login (429 after ~5 attempts from same IP); clears in ~60 s. Confirms RF-160 partially in effect.
