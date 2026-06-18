# r-web

Headline: ❌ FLOW FAIL — Three production 500 errors block new-order creation and entire buyer experience.

| Step                                   | Status | Notes                                                                                                               |
| -------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------- |
| 1. Operator login                      | ✅     | Landed on /home as ux_admin; "UX Audit Co" tenant confirmed. Throttler fired for ~2 min first (anomaly).            |
| 2. Place ad-hoc order                  | ❌     | "Choose customer" shows "No customers yet." GET /api/v1/customers → 500. Blocked.                                   |
| 3. Confirm order (PENDING → CONFIRMED) | ⚠️     | Confirmed via API PATCH (200 OK). UI deep-link to /orders/:id redirects to /home; cannot open order detail via URL. |
| 4. Add order to route                  | ✅     | Navigated to UX Route A; UX Overdue Bistro already stop 5. Existing route used.                                     |
| 5. Dispatch / create run               | ✅     | "Dispatch run" modal opened with date 2026-05-01; run confirmed IN_PROGRESS via API.                                |
| 6. Buyer login (ux_buyer2)             | ✅     | ux_buyer2 session found; linked to UX Delivered Deli / UX Audit Co.                                                 |
| 7. Buyer sees orders                   | ❌     | GET /api/v1/buyer/orders?limit=30 → 500; spinner never resolves.                                                    |
| 8. Buyer invoice view                  | ❌     | GET /api/v1/buyer/invoices?limit=30 → 500; Invoices tab shows infinite spinner.                                     |

## Anomalies (NEW findings)

- **NEW-rweb-1 [P1]** GET /api/v1/customers returns 500 — Operator "New Order" flow shows "No customers yet"; cannot place any new order via UI. Endpoint: `GET https://routeflowapi-production-d504.up.railway.app/api/v1/customers`.

- **NEW-rweb-2 [P0]** GET /api/v1/buyer/orders returns 500 — Buyer orders page spins indefinitely; buyers cannot see any of their orders. Endpoint: `GET https://routeflowapi-production-d504.up.railway.app/api/v1/buyer/orders?limit=30`.

- **NEW-rweb-3 [P0]** GET /api/v1/buyer/invoices returns 500 — Buyer invoices page spins indefinitely; buyers cannot view invoices. Endpoint: `GET https://routeflowapi-production-d504.up.railway.app/api/v1/buyer/invoices?limit=30`.

- **NEW-rweb-4 [P2]** Login throttler fires aggressively — After ~3 login attempts within 60s, subsequent attempts blocked for >2 minutes with "ThrottlerException: Too Many Requests".

- **NEW-rweb-5 [P2]** /orders/:id deep-link redirects to /home — Cannot navigate directly to an order detail page by URL; breaks back-navigation and external links.

- **NEW-rweb-6 [P3]** Bottom nav intercepts coordinate-targeted clicks — At 620px viewport, clicks on modal buttons near y≈829 sometimes register on bottom nav. Modal Dispatch button only reliable via accessibility ref.

- **NEW-rweb-7 [P2]** Active run shows wrong scheduled date — Run for UX Route A shows scheduledDate 2026-04-30 (yesterday) despite being dispatched on 2026-05-01. Possible timezone offset bug.

## Blockers

- **NEW-rweb-2** and **NEW-rweb-3**: P0 — entire buyer experience broken in production.
- **NEW-rweb-1**: P1 — operators cannot create new orders for any customer.
