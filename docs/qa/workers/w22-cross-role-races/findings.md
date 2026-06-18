# W22 — Phase 13 Cross-Role Race Conditions & Phase 10 Security

**Date:** 2026-04-30
**Tenant:** `ux-audit-1777265477001`
**Accounts:** ux_admin, ux_buyer2, ux_buyer3
**Status:** Complete

---

## Pre-test Notes

- Buyer login endpoint: `POST /buyer/auth/login` with `email/password` + `X-Tenant-Slug` header.
- `POST /buyer/orders` adds items to buyer's existing PENDING order (server-side cart) rather than creating a fresh order each time.
- The frontend JS bundle hardcodes a different API hostname (`routeflowapi-production-d504.up.railway.app`) than the documented URL (`routeflowapi-production.up.railway.app`) — both resolve identically.

---

## Scenario 13.10 — Price Race at Checkout

**Product:** Butter 500g (pricePerUnit: $5.49 → changed to $50.00)

**Result: PASS** — Server enforces live pricing server-side. `unitPrice` in `POST /buyer/orders` items is a rejected field (400). Resulting order line shows $50.00 consistently in both buyer and operator views.

**UX gap:** Buyer who saw $5.49 in catalog is silently charged $50.00 with no warning. See RF-145.

---

## Scenario 13.13 — Buyer Order Depletes Stock Below Threshold

**Result: INFORMATIONAL**

Placing a buyer order does NOT decrement inventory. Stock is only decremented when a driver completes a route stop with POD at delivery. The low-stock panel reflects physical on-hand stock only, not "available minus pending orders." There is no "reserved inventory" concept.

A product can have 50 pending orders against 1 unit of on-hand stock and the dashboard shows stock = 1 (no alert). Low-stock alert cannot be triggered by order placement — only by manual adjustments or delivery completion.

**Note:** This is a design decision, not a bug. Operators have no visibility into committed/reserved stock.

---

## Scenario 13.14 — Two Buyers Race for Last Unit

**Product:** Baby Spinach 4oz — stock set to exactly 1 via inventory adjustment

**Test:** Both Buyer 2 and Buyer 3 submitted checkout simultaneously (391ms round-trip via `Promise.all`).

**Results:**

- Buyer 2: HTTP 201 Created — order `fa23eaad`
- Buyer 3: HTTP 201 Created — order `28d3247b`
- Post-race stock: 1 (unchanged — orders don't decrement)

**FAIL — Oversell confirmed** (browser-confirms RF-017). Both buyers received success for the same last unit. No server-side stock check exists at order creation.

---

## Scenario 10.3 — Privilege Escalation from Buyer DevTools

**Result: PASS** — All operator-side endpoints return 401 for buyer JWT. Cross-buyer IDOR returns 403. Query param overrides for `customerId` are silently ignored (returns own orders only).

| Endpoint                                    | Result |
| ------------------------------------------- | ------ |
| POST /routes                                | 401    |
| PATCH /products/:id                         | 401    |
| GET /orders                                 | 401    |
| GET /users, /customers, /drivers, /invoices | 401    |
| GET /buyer/orders/{other-buyer-order}       | 403    |

---

## Scenario 10.7 — Secrets in JS Bundle

**Result: PASS** — No database strings, JWT secrets, private keys, or credentials found.

**Minor note:** API base URL hardcoded as `https://routeflowapi-production-d504.up.railway.app` (different subdomain from documented `routeflowapi-production.up.railway.app`). See RF-146.

---

## New Findings

### W22-001 — Price change at checkout not communicated to buyer (P3 UX)

- If a product price changes between when the buyer adds it to cart and when they check out, the buyer is silently charged the new price. No warning message, no price-change indicator. The server correctly enforces live pricing — this is purely a UX communication gap.
- **Fix:** Return a `priceAdjusted: true` flag in the 201 order response when the charged price differs from a buyer's cached price; buyer portal should surface "Prices updated for X items."

### W22-002 — Frontend bundle hardcodes non-documented API hostname (P3)

- The frontend JS bundle (`entry-accc24f5ed58f1773525d07807cf3835.js`) hardcodes `https://routeflowapi-production-d504.up.railway.app` as the API base URL. This differs from the documented hostname (`routeflowapi-production.up.railway.app`). Both work currently.
- Risk: the d504 subdomain may be a different Railway deployment with a potentially different code version. If the two deployments diverge, the frontend could silently be talking to a different backend.
- **Fix:** Move API base URL to `EXPO_PUBLIC_API_URL` build-time env var. Ensure both hostnames point to the same deployment.

---

## Summary Table

| Scenario                           | Result        | Severity          | Notes                                 |
| ---------------------------------- | ------------- | ----------------- | ------------------------------------- |
| 13.10 — Price race at checkout     | PASS          | —                 | UX gap: no warning (RF-145)           |
| 13.13 — Low-stock from buyer order | INFORMATIONAL | Medium design gap | No stock reservation concept          |
| 13.14 — Oversell race              | FAIL          | High              | Confirms RF-017 via live browser test |
| 10.3 — Buyer privilege escalation  | PASS          | —                 |                                       |
| 10.7 — Secrets in bundle           | PASS          | Low note          | Hardcoded d504 hostname (RF-146)      |
