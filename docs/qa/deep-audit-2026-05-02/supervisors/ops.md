# OPS squad — synthesis

## Top 5 product P0/P1 (after filtering env artifacts)

1. **BUG-OPS1-2** P0 — Invoice tax computed at ~15,000% effective rate ($3,369 tax on $22.46 subtotal). Repro: open INV-2026-0026 as operator. Fix: `invoices.service.ts` — ensure `taxAmount = subtotal * (taxRate / 100)`, not `subtotal * taxRate`; audit taxRate field unit in DB.

2. **BUG-OPS1-1** P1 — $0 order "Confirm order" button is fully enabled and silently no-ops (no toast, no API call, no error). Repro: new order with 0 line items → button green and clickable. Fix: `new-order.tsx` — add `disabled={items.length === 0}` and reduced opacity to Confirm button.

3. **BUG-OPS1-6 / BUG-W-5** P1 (duplicate, merged) — "Dispatch run" button enabled with no driver assigned; clicking opens modal that silently fails with no error surfaced. Repro: route with no driver → tap Dispatch run → click Dispatch → no toast, no run created. Fix: `route-detail.tsx` — disable Dispatch run when `driverId === null`; surface API 4xx error as toast.

4. **BUG-W-7** P2 — Route run detail shows "Unassigned" for driver even after a driver is assigned and dispatched. Repro: create route → assign driver → dispatch → run detail subtitle reads "Unassigned · 0/1 stops". Fix: include driver relation in `GET /route-runs/:id` response; bind subtitle to `routeRun.route.driver`.

5. **BUG-OPS1-3** P2 — Invoice deep-link URLs (`/invoices/<uuid>`) redirect to `/home` for authenticated operators; no shareable invoice links. Fix: ensure `(operator)/invoices/[id].tsx` route is registered and auth guard allows deep-link navigation for authenticated sessions.

---

## Counts

| Severity | Product bugs | Env artifacts |
|---|---|---|
| P0 | 1 | 0 |
| P1 | 3 | 0 |
| P2 | 4 | 2 |
| P3 | 1 | 1 |

*Notes: BUG-OPS1-6 and BUG-W-5 are merged as one product P1. BUG-W-2 counts as 1 product P1 (the underlying auth gap). BUG-W-1 and BUG-W-3 are env artifacts. BUG-W-4 is an env artifact.*

---

## Counts by category (product only)

- money: 2 (BUG-OPS1-2 tax catastrophe, BUG-OPS1-1 $0 order)
- flow-broken: 4 (BUG-OPS1-6/W-5 dispatch no-driver, BUG-W-7 unassigned label, BUG-OPS1-3 deep-link, BUG-OPS1-2 downstream billing)
- ux: 3 (BUG-OPS1-4 hardcoded date placeholder, BUG-W-8 dispatch date defaults tomorrow, BUG-W-6 rapid-tap drops stops)
- security: 1 (BUG-W-2 coexisting role tokens in localStorage)
- data-integrity: 1 (BUG-W-7)
- adversarial-input: 1 (BUG-OPS1-5 ThrottlerException leak)

---

## Verdict: HOLD

P0 tax miscalculation (BUG-OPS1-2) produces invoices charging ~150x the correct amount — this is a financial integrity failure that cannot ship.

---

## Pattern observation

Guards and validations exist in the backend but the frontend never surfaces errors or disables CTAs pre-emptively, leaving operators with silent failures on empty orders, driverless dispatches, and broken deep-links.

---

## Env artifacts (informational, not ship-blockers)

- **BUG-W-1** ("+New route" → /new-order) — Worker session had both `rf:op:accessToken` and `rf:buyer:accessToken` coexisting; buyer navigation hooks were active, making all route-screen button presses suspect. Not reproducible in a clean single-role session.
- **BUG-W-3** ("Optimize stops" → /invoices) — Identical contamination state as BUG-W-1; navigation to /invoices matches buyer auth hook intercepting the press. Needs clean-session retest before filing as product bug.
- **BUG-W-4** ("Dispatch run" → /new-order) — Worker self-reported it as intermittent and explicitly attributed it to buyer tokens in localStorage; re-test after BUG-W-2 fix before treating as product bug. The underlying real product bug (dispatch succeeds without driver) is captured separately as BUG-W-5.
- **BUG-OPS1-5** (ThrottlerException string in error banner) — P3, genuine but low-impact information leak; logged here for completeness, not a ship-blocker on its own.
