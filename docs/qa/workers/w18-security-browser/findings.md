# W18 — Security Browser Testing (IDOR, Tenant Isolation, Role Boundaries, XSS)

**Audited:** 2026-04-29
**Tenant:** `ux-audit-1777265477001`
**API base:** `https://routeflowapi-production-d504.up.railway.app/api/v1`
**Status:** Live browser testing completed

---

## Summary

SQL injection: blocked (Prisma parameterization). Cross-tenant IDOR: blocked. Buyer-to-operator privilege escalation: blocked. Auth boundary: correct. **However, two role-enforcement gaps found (driver can read returns + credit notes) and stored XSS in free-text fields confirmed.**

---

## Findings

### W18-003 — Driver Can Read All Customer Returns (P2)
- **Severity:** P2
- **Issue:** `GET /api/v1/returns` returns HTTP 200 with the full tenant returns list to a DRIVER-role JWT. Drivers should not see customer return records.
- **Evidence:** `GET /api/v1/returns` with `ux_driver_a` token → 200 with full returns list (identical to TENANT_ADMIN response).
- **Fix:** Add `@Roles(Role.TENANT_ADMIN, Role.OPERATOR)` guard to `GET /returns` in `returns.controller.ts`.

---

### W18-004 — Driver Can Access Credit Notes Endpoint (P2)
- **Severity:** P2
- **Issue:** `GET /api/v1/credit-notes` returns HTTP 200 for DRIVER-role JWT. Returns empty array only because test tenant has 0 credit notes — not because of access control.
- **Evidence:** `GET /api/v1/credit-notes` with driver token → 200 `{"data":[],"meta":{"total":0}}`. Same as operator response.
- **Fix:** Add `@Roles(Role.TENANT_ADMIN, Role.OPERATOR)` guard to credit notes controller.

---

### W18-005 — Stored XSS in Customer businessName (API Level) (P2)
- **Severity:** P2
- **Issue:** API accepts and stores raw HTML/JavaScript in `businessName` with no sanitization. React Native Web frontend correctly escapes via React's text renderer (no execution in tested UI). Risk: PDF generators, email templates, admin panels, WebViews with `dangerouslySetInnerHTML`.
- **Evidence:**
  ```
  POST /api/v1/customers
  {"businessName": "<img src=x onerror=alert('XSS-W18')>", ...}
  → 201 Created; businessName stored verbatim as raw HTML
  GET /api/v1/customers → businessName returned as raw HTML in API response
  Frontend: escaped correctly — no alert fired
  ```
- **Fix:** Add server-side HTML sanitization (strip-tags library or NestJS `@Transform` decorator) on all free-text fields (`businessName`, `contactName`, `notes`, `displayName`). Strip `<script>`, `onerror`, `onload`, `onclick`. Do not rely solely on client-side escaping.

---

### W18-006 — Stored XSS in Order Notes (API Level) (P2)
- **Severity:** P2
- **Issue:** Order `notes` field stores raw `<script>` tags without sanitization. Same risk as W18-005.
- **Evidence:**
  ```
  POST /api/v1/orders  {"notes": "<script>window._xss_w18=1</script>", ...}
  → 201 Created; notes stored verbatim
  Frontend: window._xss_w18 = undefined (React escapes correctly)
  ```
- **Fix:** Same as W18-005 — apply sanitization at the service/DTO layer.

---

## Confirmed PASS Items

| Test | Result |
|------|--------|
| Cross-tenant IDOR (fake UUIDs) | PASS — 404 returned, no data leak |
| Buyer JWT against operator endpoints | PASS — 401 across all staff API routes |
| Buyer-to-buyer order IDOR | PASS — 403 when accessing other buyer's orders |
| Auth boundary (unauthenticated access) | PASS — immediate redirect, no content flash |
| SQL injection in query params | PASS — Prisma parameterization + DTO validation block all tested payloads |

---

## Cleanup Required

XSS test artifacts in `ux-audit-1777265477001`:
- Customer `ffcba95c-a168-491a-9d88-e82435593527` — businessName contains XSS payload
- Customer `665e1007-c2ef-4c10-a1fd-2c4b1525d5d0` — businessName contains XSS payload
- Order `6af05a85-7fb3-479b-ae6f-53fc6bff2a0e` — notes contains `<script>` payload

Run: `DELETE /api/v1/customers/<id>` and cancel the test order with operator token.

---

## Summary Table

| ID | Severity | Title |
|----|----------|-------|
| W18-003 | P2 | Driver can read all customer returns |
| W18-004 | P2 | Driver can access credit notes endpoint |
| W18-005 | P2 | Stored XSS in customer businessName (API level) |
| W18-006 | P2 | Stored XSS in order notes (API level) |
