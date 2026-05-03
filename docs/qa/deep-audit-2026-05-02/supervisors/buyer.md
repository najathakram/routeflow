# BUYER squad — synthesis

## Top 5 product P0/P1 (after filtering env artifacts)

1. **BUG-B2-1 (P0)** — `GET /api/v1/buyer/invoices` returns 400 on all filtered requests because the API rejects `statuses[]=SENT&statuses[]=OVERDUE` array-style query params. Invoices tab is broken for every buyer; confirmed across ux_buyer1/2/3.
2. **BUG-B1-4 (P1)** — Operator and buyer tokens coexist in localStorage (`rf:op:accessToken` + `rf:buyer:accessToken`); `getStoredUser()` priority favours operator, so a buyer tab silently renders operator UI. Core auth isolation failure, confirmed by CROSS-1 and all workers.
3. **BUG-B2-6 (P1)** — Auth guard reads token from in-memory store on mount only; deleting `rf:buyer:accessToken` from localStorage while the app is open does not trigger a re-check or redirect. No `storage` event listener present. Direct instance of confirmed issue (c).
4. **BUG-B2-5 (P1)** — Unauthenticated access to `/invoices/:id` deep-link redirects to the marketing homepage (`/`) instead of `/customer-login?returnTo=<path>`; intended URL is lost.
5. **BUG-B1-1 (P1)** — Catalog data hook catches 401 and resolves with `[]`, rendering "No products found" with no redirect to `/customer-login` and no error toast. Auth failures are silently swallowed by all buyer data hooks.

## Counts

| Severity | Product bugs | Env artifacts |
|----------|-------------|---------------|
| P0       | 1           | 0             |
| P1       | 5           | 4             |
| P2       | 4           | 0             |
| P3       | 0           | 0             |

## Counts by category (product only)

| Category          | Count |
|-------------------|-------|
| flow-broken       | 3     |
| security          | 3     |
| data-integrity    | 1     |
| adversarial-input | 1     |
| money             | 1     |
| ux                | 1     |

## Verdict: HOLD

The P0 (invoice 400 on all filtered requests) renders the invoices tab non-functional for every buyer. Two confirmed P1 security issues (token isolation failure + stale auth guard) are systemic and affect every authenticated session. These must be fixed before ship.

## Pattern observation

Auth plumbing has two layered failures — tokens are neither isolated by role nor re-validated reactively — causing cascading UX breakage across catalog, orders, and invoices surfaces.

## Env artifacts (informational, not ship-blockers)

- **BUG-B1-2** — Triple-route mount at `/orders` (home + orders + catalog rendered simultaneously): symptom of op token dominating buyer session in shared incognito localStorage; root cause is issues (a)+(b), not a standalone router defect. Cannot confirm in a clean single-tab session.
- **BUG-B1-3** — Orders list shows "No orders yet" while home dashboard shows delivered orders: most likely the op session was calling the operator `/api/v1/orders` endpoint rather than `/api/v1/buyer/orders`. Indistinguishable from a real product bug without a clean session; reclassified as env artifact pending retesting under isolated auth.
- **BUG-B2-2** — `/invoices` URL redirects non-deterministically to home/orders/catalog: the 400 from BUG-B2-1 plus stale op token triggered unhandled error fallback; directly caused by issues (a)+(b)+(c). Underlying cause (invoice 400) is tracked as BUG-B2-1.
- **BUG-B2-3** — `GET /api/v1/buyer/invoices?limit=30` returns 401 when navigated via bottom-nav: request sent without Authorization header is consistent with stale in-memory auth state after op-session token overwrite; direct symptom of issues (a)+(b). Cannot independently confirm in clean session.
