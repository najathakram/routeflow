# L1-Polish

## Coverage
| Pass | Fail | Partial | Blocked |
|------|------|---------|---------|
| 1 | 2 | 0 | 16 |

## RF status table (all 19 P2s)
| RF | Original verdict | Verified now? | Notes |
|---|---|---|---|
| RF-198 | P2 | ⛔ BLOCKED | Cart/checkout endpoints (RF-215) broken; cannot exercise price-change race |
| RF-201 | P3 | ⛔ BLOCKED | Inventory adjustment UI unreachable; /inventory 500 |
| RF-202 | P3 | ⛔ BLOCKED | Invoice list /buyer/invoices 500; grace-boundary untestable |
| RF-206 | P2 | ⛔ BLOCKED | Full list scan blocked; v3 confirmed once per route (no dup observed) |
| RF-209 | P2 | ❌ FAIL | Direct nav to /finance/* → "Unmatched Route" 404 |
| RF-214 | P2 | ⛔ BLOCKED | Fields read-only per RF-226; validation untestable |
| RF-219 | P2 | ✅ PASS | Buyer 2 More tab shows "$95 Total Spend" (cross-confirmed v3) |
| RF-221 | P2 | ⛔ BLOCKED | Vendor Bills not reachable; nav entry missing |
| RF-222 | P2 | ❌ FAIL | GET /analytics → HTTP 404 in network panel |
| RF-223 | P3 | ⛔ BLOCKED | Vendor Bills page unreachable (see RF-221) |
| RF-224 | P2 | ⛔ BLOCKED | /returns opens; no "Create Return" CTA (operator workflow degraded by RF-212) |
| RF-225 | P2 | ⛔ BLOCKED | Send Test button absent; no per-event preference fields |
| RF-226 | P2 | ⛔ BLOCKED | Business Profile fields read-only; no edit button |
| RF-227 | P2 | ⛔ BLOCKED | Invoicing tab shows tax-rate only; no prefix/due-days |
| RF-228 | P2 | ⛔ BLOCKED | Concurrent-session limit untestable via GUI; out of scope |
| RF-229 | P2 | ⛔ BLOCKED | Buyer invoice detail unreachable (/buyer/invoices 500) |
| RF-231 | P2 | ⛔ BLOCKED | Marketing-homepage redirect partially observed; needs incognito fresh tab |
| RF-232 | P2 | ⛔ BLOCKED | Favorite/bookmark icon absent (supports RF-232 still open) |
| RF-233 | P2 | ⛔ BLOCKED | /profile redirect loop not exercised |

## Re-open list (FAIL/PARTIAL P2)
- **RF-209** (P2 FAIL): Finance sub-routes (`/finance/dashboard`, `/finance/ar`, `/finance/expenses`) return "Unmatched Route" 404. Register routes under `/finance/` prefix or update nav to prefix-less paths (RF-187 audit).
- **RF-222** (P2 FAIL): `GET /analytics` returns 404. Implement root endpoint or redirect to `/analytics/revenue`.

## New regressions
- **NEW-v4-1** [P2]: Settings shows only Business Profile + Invoicing + Notifications tabs — Users / Branding / Integrations tabs absent (cross-confirms RF-213 still open).
- **NEW-v4-2** [P2]: Operator app does not expose Vendor Bills / Inventory entry points in bottom nav — discoverability gap.

## Domain verdict (polish only): HOLD

**Rationale**: 16 of 19 P2s blocked by pre-existing P1 infrastructure failures (broken endpoints, UI routing, 500s). Only 1 P2 fully passes (RF-219); 2 clear failures (RF-209, RF-222) require engineering. New regressions in Settings discoverability and nav suggest broader DOM/routing instability. Polish domain cannot be cleared until blocking P1s are fixed.
