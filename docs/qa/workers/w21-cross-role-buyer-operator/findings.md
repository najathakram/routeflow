# W21 - Phase 13 Cross-Role Real-Time Testing: Operator-Buyer

Worker: W21
Date: 2026-04-30
Tenant: ux-audit-1777265477001
API base: https://routeflowapi-production.up.railway.app/api/v1
App URL: https://routeflowmobile-production.up.railway.app
Operator account: ux_admin
Buyer 1: ux_buyer1_1777265477001@ux-audit.test (UX Empty Cafe)

## Architecture Finding (applies to all scenarios)

No real-time update mechanism exists. The app uses pure REST/HTTP exclusively:
- No WebSocket connections detected
- No Server-Sent Events (SSE) detected
- No active polling intervals -- dashboard stats fetched once on page mount only
- Network API calls go to routeflowapi-production-d504.up.railway.app (different from documented routeflowapi-production.up.railway.app)

All latency results: never-in-60s for UI auto-updates. Backend data correct immediately; frontend is stale.

## Console Errors

- [expo-notifications] Listening to push token changes is not yet fully supported on web -- every page load, non-blocking
- No JS errors thrown during testing
- No failed network requests during normal navigation

## Network Observations

- Preflight OPTIONS requests on home load for: /drivers, /customers, /bookkeeping/summary, /products, routes/route-runs
- No periodic re-fetch of stat tiles while user stays on home page
- Pending orders tile: one-time mount query, no subscription

## Scenario Results

### Scenario 13.1 - Buyer places order -> Operator dashboard updates

- Actor: Buyer 1 (UX Empty Cafe) placed ORD-1777431385838 PENDING at 14:16:40 UTC ($63.46, 4 items: Multigrain Bread x2, Protein Bars x1, Almond Mix 16oz x2, Toilet Rolls 9pk x1)
- Observer: Operator on /home -- Pending orders tile, baseline = 6
- Latency: Never in 120s -- MutationObserver confirmed zero DOM changes over 2+ minutes while page stayed open
- Update correct (after navigation): Yes -- /orders Pending tab shows ORD-1777431385838, customer UX Empty Cafe, $63.46, 4 items, notes "QA Test W21 13.1 new order test"
- Result: FAIL (auto-update) / PASS (navigation)
- Evidence: Dashboard showed 6 for 120+ seconds. Updated to 7 only when operator navigated away and returned.
- Bug signals:
  1. No real-time updates -- operator home dashboard completely static once loaded
  2. POST /buyer/orders is upsert -- while PENDING order exists, endpoint updates/returns that order instead of creating new one

### Scenario 13.2 - Operator confirms order -> Buyer portal updates

- Actor: Operator confirmed ORD-1777431385838 via Confirm order button at 14:20:46 UTC
- Observer: Buyer 1 -- order status for ORD-1777431385838
- Latency (operator UI): ~2 seconds -- Confirm order button replaced with Send for delivery/Quick deliver/Back to pending/Cancel order immediately
- Latency (buyer API): ~21 seconds (first poll at 14:21:07 returned CONFIRMED)
- Update correct: Yes -- CONFIRMED in buyer API. Operator detail: Confirmed chip, UX Empty Cafe, Alex Empty 555-8001, correct items, $63.46 total
- Result: PASS (data) / PARTIAL (real-time -- operator updates instantly, buyer requires page navigation)
- Bug signals:
  1. No WebSocket/SSE push to buyer portal -- buyer must reload to see CONFIRMED status

### Scenario 13.7 - Operator voids invoice -> Buyer portal updates

- Setup: INV-2026-0011 (UX Empty Cafe, $26.97, SENT) created and sent at 14:27:00 UTC
- Actor: Operator voided INV-2026-0011 at 14:30:41 UTC (Void button + confirmation dialog: "INV-2026-0011 will be marked void")
- Observer: Buyer 1 -- invoice list
- Latency (operator UI): ~2 seconds -- status chip -> Voided, $0.00 shown, Record payment CTA removed, toast "Invoice voided"
- Latency (buyer API): ~23 seconds (first poll at 14:31:04 returned VOID)
- Update correct: Yes -- INV-2026-0011 is VOID in buyer API. Pay CTA removed on operator side immediately.
- Result: PASS (data) / PARTIAL (UI -- buyer requires page refresh)
- Bug signals:
  1. pdfUrl is null -- View PDF button exists but leads nowhere
  2. Buyer invoice list endpoint returns lineItems: [] -- items only on detail endpoint
  3. Confirmation dialog before void is good UX protection

### Scenario 13.8 - Operator creates and sends invoice -> Buyer sees it

- Setup: Buyer 1 had 0 invoices before test
- Actor: Operator created INV-2026-0011 as DRAFT at 14:26:51, sent at 14:27:00 UTC
- Observer: Buyer 1 -- invoices list
- Latency (buyer API): ~11 seconds (poll at 14:27:11 returned INV-2026-0011 SENT)
- Update correct: Partial -- correct status SENT, total $26.97, due date 2026-05-14, correct customer. Line items on detail endpoint: Multigrain Bread x2 @ $5.99, Protein Bars 10pk x1 @ $14.99. PDF link null.
- Result: PASS (data visibility) / PARTIAL (PDF link null)
- Bug signals:
  1. Invoice POST /invoices requires items[].qty not lineItems[].quantity -- error: "property lineItems should not exist", "items.0.property quantity should not exist"
  2. Invoice send: POST /invoices/{id}/send works; PATCH /invoices/{id}/status returns 404 (inconsistent with PATCH /orders/{id}/status which works)
  3. pdfUrl: null for manually created invoices -- no PDF generated

### Scenario 13.9 - Buyer cancels PENDING order -> Operator pipeline decrements

- Setup: ORD-1777431385839 PENDING (UX Empty Cafe, 1x Iced Coffee 4pk, $21.92). Operator home baseline = 7 Pending orders at 14:32:37 UTC.
- Actor: Buyer 1 cancelled via POST /buyer/orders/{id}/cancel at 14:32:47 UTC. Result: {"message":"Order cancelled"}
- Observer: Operator on /home -- Pending orders tile
- Latency (auto-update): Never in 61s -- DOM poll showed val=7 unchanged at 14:33:38 (51s after cancel)
- Latency (navigation): After navigating to /orders then back to /home, count dropped to 6
- Operator sees CANCELLED order: Yes -- Cancelled tab shows ORD-1777431385839 (UX Empty Cafe, 1 item, $21.92) at top of list immediately after navigation
- Result: FAIL (auto-update) / PASS (navigation)
- Bug signals:
  1. Same root cause: no real-time dashboard updates
  2. Buyer cancel endpoint is POST /buyer/orders/{id}/cancel -- REST-unconventional
  3. Pending orders tile count inconsistent with GET /orders?status=PENDING -- tile may count PENDING+CONFIRMED+other active statuses; label is misleading

## Summary Table

Scenario | Auto-Update Latency | Navigation Latency | Data Correct | Result
13.1 Buyer places order -> Op home | Never in 120s | ~3s (page mount) | Yes | FAIL / PASS
13.2 Op confirms order -> Buyer sees | Never (UI); ~21s (API) | ~3s (page mount) | Yes | PARTIAL
13.7 Op voids invoice -> Buyer sees | Never (UI); ~23s (API) | ~3s (page mount) | Yes | PARTIAL
13.8 Op sends invoice -> Buyer sees | Never (UI); ~11s (API) | ~3s (page mount) | Partial (no PDF) | PARTIAL
13.9 Buyer cancels -> Op pipeline | Never in 61s | ~3s (page mount) | Yes | FAIL / PASS

## Key Bug Signals (Prioritized)

### P1 - Critical UX: No real-time updates on operator dashboard
Dashboard stats load once on mount and never refresh. Operators can miss buyer orders indefinitely.
Fix: Implement polling (refetch every 30s) or WebSocket/SSE for dashboard stat tiles.

### P2 - High: Operator Pending orders count is misleading
Tile showed 7 while GET /orders?status=PENDING returned 4. Tile appears to count PENDING+CONFIRMED+other. Label should match the actual query.

### P3 - High: Invoice PDF link is always null for manually-created invoices
pdfUrl: null on all manually-created invoices. View PDF button leads nowhere. Buyer cannot download invoice.

### P4 - Medium: Buyer invoice list returns no line items
GET /buyer/invoices returns lineItems: [] for all invoices. Only GET /buyer/invoices/{id} returns items.

### P5 - Medium: Invoice API endpoint inconsistencies
- POST /invoices requires items[].qty (not lineItems[].quantity)
- Invoice send: POST /invoices/{id}/send works; PATCH /invoices/{id}/status returns 404
- Order cancel (buyer): POST /buyer/orders/{id}/cancel (not PATCH/DELETE)

### P6 - Medium: XSS payload visible in Operator orders list (W18 contamination)
ORD-1777431385834 customer name is HTML tag displayed as literal text. Properly escaped in UI (not executed), but indicates no server-side sanitization of customer name field.

### P7 - Medium: Buyer portal has no push mechanism for any status changes
All status changes require buyer page reload. No toast, badge, or notification mechanism observed.

### P8 - Low: Possible cross-tenant invoice data in operator Sent filter
Invoices from Blue Dreamz (product: Bam Bam AAA Flower) appeared in ux-audit tenant Sent filter. Does not belong to this tenant. Possible cross-tenant leak or affa data contamination.

## Resources Created During Testing

Resource | ID | Status at End
ORD-1777431385838 | 514b08ee-c2ef-406e-98ad-61da7acd0aad | CONFIRMED
ORD-1777431385839 | 4805bde4-fe0e-4d6f-a8ab-77be99fe553a | CANCELLED
INV-2026-0011 | aa5f3e01-5dee-4351-9617-ab20af20a480 | VOID
