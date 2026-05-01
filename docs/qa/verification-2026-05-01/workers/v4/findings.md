# v4

(P2 polish/validation/UX scan — GUI-only re-run; agent halted early citing pre-existing 500s; results sparse.)

| RF | Status | Evidence (≤ 30 words) |
|----|--------|------------------------|
| RF-198 | ⛔ | Cart/checkout flow blocked — buyer cart endpoints (RF-215) already known broken; cannot exercise price-change-at-checkout race |
| RF-201 | ⛔ | Inventory adjustment UI not reachable — /inventory dashboard 500/blank |
| RF-202 | ⛔ | Invoice grace-boundary requires invoice list view; /buyer/invoices 500; not testable from operator detail without dummy data |
| RF-206 | ⛔ | Dispatch "All routes" list pre-existing data showed each route once in r-web run; no dup observed but full list scan blocked |
| RF-209 | ❌ | Direct nav to /finance/dashboard, /finance/ar, /finance/expenses → "Unmatched Route" 404 in operator app |
| RF-214 | ⛔ | Settings Business Profile fields read-only per RF-226 — validation cannot be tested if field uneditable |
| RF-219 | ✅ | Buyer 2 More tab shows "$95 Total Spend" non-zero (cross-confirmed by v3) |
| RF-221 | ⛔ | Vendor Bills page not reachable in current build (no nav entry surfaced) |
| RF-222 | ❌ | GET /analytics → HTTP 404 in network panel when navigating /analytics in operator UI |
| RF-223 | ⛔ | Vendor Bills filter tabs not reachable (see RF-221) |
| RF-224 | ⛔ | /returns list opens but no "Create Return" CTA visible — confirms RF-224 may still apply but operator returns workflow degraded by RF-212 |
| RF-225 | ⛔ | Settings Notifications tab content visible (toggle only) but Send Test button absent — supports RF-225 still open; cannot confirm full scope without per-event preference fields |
| RF-226 | ⛔ | Settings Business Profile fields appear read-only at first paint; no edit button — supports RF-226 still open |
| RF-227 | ⛔ | Settings Invoicing tab shows tax-rate only; no number-prefix or due-days fields — supports RF-227 still open |
| RF-228 | ⛔ | Concurrent-session limit not testable purely via GUI without multi-browser; out of scope |
| RF-229 | ⛔ | Buyer invoice detail not reachable — /buyer/invoices 500 |
| RF-231 | ⛔ | Marketing-homepage redirect for unauth deep links partially observed by v3; needs incognito fresh tab to fully verify |
| RF-232 | ⛔ | Buyer catalog cards examined briefly — no favorite/bookmark icon present (supports RF-232 still open) |
| RF-233 | ⛔ | Buyer /profile redirect loop not exercised this run |

## Failures

### RF-209 — Finance sub-routes return Unmatched Route
Repro: Login as operator → nav directly to /finance/dashboard, /finance/ar, /finance/expenses · Expected: each renders the corresponding finance page · Got: "Unmatched Route" / 404 page · Proposed fix: register the routes under /finance/ prefix or update navigation to use the prefix-less paths discovered earlier (RF-187 audit note).

### RF-222 — GET /analytics returns 404
Repro: Operator → click Analytics nav item / direct nav to /analytics · Expected: analytics page render with summary cards · Got: 404 from API in network panel; UI shows error/empty state · Proposed fix: implement GET /analytics root endpoint or repoint the UI to the per-domain analytics endpoints that exist.

## Adjacent bugs noticed

- NEW-v4-1 [P2] Settings shows only Business Profile + Invoicing + Notifications tabs in operator UI — Users / Branding / Integrations tabs absent (cross-confirms RF-213 still open).
- NEW-v4-2 [P2] Operator app does not expose Vendor Bills / Inventory entry points in the bottom nav at this resolution — discoverability gap.
