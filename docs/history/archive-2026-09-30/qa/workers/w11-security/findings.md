# W11 — Security & IDOR Deep-Dive Code Audit

**Audited:** 2026-04-29
**Scope:** Authorization middleware, role-based access control, IDOR vulnerabilities, privilege escalation, PII exposure, API key leakage
**Status:** Read-only audit — no files modified

---

## Summary

Seven high-severity findings identified. The most critical is a **privilege escalation via mass assignment**: any authenticated user (driver, customer, buyer) can promote themselves to OPERATOR by sending `{"role": "OPERATOR"}` to `PATCH /users/:id` on their own user record. This completely compromises the multi-tenant RBAC model.

---

## Findings

### W11-001 — Any user can self-promote to OPERATOR via PATCH /users/:id (mass assignment)

- **Severity:** P0
- **File:** `apps/api/src/users/dto/update-user.dto.ts:7`, `apps/api/src/users/users.service.ts`
- **Issue:** `UpdateUserDto` contains `@IsOptional() @IsEnum(UserRole) role?: UserRole`. The same DTO is used for both admin-editing a user and self-editing. `users.service.ts::update()` passes the DTO directly to Prisma without stripping the `role` field for non-admin callers. Any authenticated user who knows their own user ID can call `PATCH /users/:id` with `{"role": "OPERATOR"}` and gain operator privileges instantly.
- **Evidence:**
  - `apps/api/src/users/dto/update-user.dto.ts` line 7 — `role?: UserRole` present in DTO, no `@Exclude()` or controller-level stripping
  - `apps/api/src/users/users.controller.ts:70-76` — endpoint exists, JwtAuthGuard applied, but no check that caller is OPERATOR or TENANT_ADMIN before allowing role change
  - `apps/api/src/users/users.service.ts` — `update()` accepts full DTO and applies to Prisma
- **Repro:**
  1. Login as any driver: `POST /auth/login` `{"username":"driver_a","password":"..."}`
  2. Note userId from JWT decode
  3. `PATCH /users/{userId}` with header `Authorization: Bearer <token>` and body `{"role":"OPERATOR"}`
  4. Observe 200 response; re-login to get new JWT with role OPERATOR
  5. Full operator access to all routes, orders, products, etc.
- **Fix:** Split into two DTOs — `UpdateUserSelfDto` (no role field) and `UpdateUserAdminDto` (role field). Strip role in the controller's self-update path, or add an explicit guard that only TENANT_ADMIN can mutate the role field.

---

### W11-002 — GET /returns/:id exposes any return to any CUSTOMER (IDOR)

- **Severity:** P1
- **File:** `apps/api/src/returns/returns.controller.ts:44-48`
- **Issue:** `GET /returns/:id` fetches the return by ID with a tenant check (`forTenant()`) but no ownership check for CUSTOMER role. A customer with a valid JWT can enumerate return IDs and read returns belonging to other customers in the same tenant.
- **Evidence:** `returns.controller.ts` lines 44-48 — only `JwtAuthGuard` + `RolesGuard([OPERATOR, CUSTOMER])`. `returns.service.ts::findOne()` — only `forTenant(tenantId)`, no `.customerId = requestingUser.customerId` filter for CUSTOMER role.
- **Repro:**
  1. Login as `harbor_cafe` (has return R-001)
  2. Login as `north_deli` (has return R-002)
  3. As `north_deli`, call `GET /returns/R-001` — receives harbor_cafe's return data
- **Impact:** Cross-customer PII leak within a tenant. Delivery photos, signatures, return reasons all exposed.
- **Fix:** In `returns.service.ts::findOne()`, if `user.role === 'CUSTOMER'`, add `AND customerId = user.customerId` to the query.

---

### W11-003 — POST /returns/:id/cancel has no ownership check for CUSTOMER role

- **Severity:** P1
- **File:** `apps/api/src/returns/returns.controller.ts` (cancel endpoint)
- **Issue:** Same pattern as W11-002 — tenant isolation but no ownership enforcement. A customer can cancel another customer's return by ID.
- **Evidence:** Cancel endpoint has `RolesGuard([OPERATOR, CUSTOMER])` but the service only filters by tenantId.
- **Fix:** Same pattern as W11-002 — add customerId filter for CUSTOMER callers.

---

### W11-004 — GET /customers/:id is accessible by DRIVER role, returns full customer PII

- **Severity:** P1
- **File:** `apps/api/src/customers/customers.controller.ts:150-153`
- **Issue:** `GET /customers/:id` allows `[OPERATOR, DRIVER]` roles. The response includes full customer PII: email, phone, full address, credit terms, balance, all order history. Drivers need to see delivery address for their current stop, but should not see billing info, credit balance, or contact details of customers not on their current route.
- **Evidence:** `customers.controller.ts:150-153` — `@Roles(Role.OPERATOR, Role.DRIVER)`. `customers.service.ts::findOne()` — no field projection for DRIVER role, returns full entity.
- **Impact:** Any driver can enumerate all customer IDs and harvest full PII for the entire tenant.
- **Fix:** If caller role is DRIVER, return a projection limited to: name, delivery address, phone. Strip email, creditTerms, balance, notes, taxExempt status.

---

### W11-005 — UpdateUserDto role field present in self-update path (same root as W11-001)

- **Severity:** P1
- **File:** `apps/api/src/users/dto/update-user.dto.ts`
- **Issue:** Separate from the controller-level issue — even if controller is fixed, the DTO's role field being `@IsOptional()` (not `@IsNotAllowed()` or absent) means any future route reuse could re-introduce the vulnerability. The fix must be at the DTO level.
- **Fix:** Remove `role` from the shared DTO entirely; create a separate `AdminUpdateUserDto` that extends the base with role field.

---

### W11-006 — GET /orders/:id accessible by DRIVER with no route-assignment check

- **Severity:** P2
- **File:** `apps/api/src/orders/orders.controller.ts`
- **Issue:** `GET /orders/:id` allows DRIVER role. The service filters by tenantId but does not verify that the order belongs to a stop on a run currently assigned to this driver. Drivers can read all orders in the tenant.
- **Fix:** For DRIVER role, check that a RouteRunStop for this order exists on an active run assigned to the requesting driver.

---

### W11-007 — No rate limiting on auth endpoints

- **Severity:** P2
- **File:** `apps/api/src/auth/auth.controller.ts`
- **Issue:** `POST /auth/login` and `POST /auth/register` have no rate limiting or account lockout. An attacker can brute-force passwords without restriction.
- **Evidence:** No `@Throttle()` decorator on auth endpoints; no NestJS ThrottlerModule configured in `app.module.ts`.
- **Fix:** Apply NestJS ThrottlerModule at 10 req/min per IP on auth endpoints. Add exponential backoff after 5 failed attempts per username.

---

### W11-008 — GET /public/places/config returns Google Maps API key unauthenticated

- **Severity:** P2
- **File:** `apps/api/src/public/public-places.controller.ts:34-39`
- **Issue:** `GET /public/places/config` is a public (no auth) endpoint that returns the server's Google Maps API key to any caller. The key is intended for the mobile app's autocomplete, but being unauthenticated means any script can harvest it and use it for billing abuse.
- **Evidence:** `public-places.controller.ts:34-39` — no guards; returns `{ apiKey: process.env.GOOGLE_MAPS_API_KEY }`.
- **Fix:** Require JwtAuthGuard on this endpoint, or return a short-lived session token/signature rather than the raw key.

---

### W11-009 — JWT payload contains tenantId and role — no re-verification on sensitive writes

- **Severity:** P2
- **Note:** The JWT carries both `tenantId` and `role`. If a token is compromised, the server trusts the embedded role until expiry. There is no server-side session revocation. This is a design-level risk rather than a code bug, but should be flagged for the threat model.
- **Fix:** Ensure JWT expiry is short (≤15 min) with refresh tokens, or add a server-side token blacklist on role change.

---

## Summary Table

| ID      | Severity | Title                                                               |
| ------- | -------- | ------------------------------------------------------------------- |
| W11-001 | P0       | Any user can self-promote to OPERATOR via PATCH /users/:id          |
| W11-002 | P1       | GET /returns/:id — no ownership check for CUSTOMER role             |
| W11-003 | P1       | POST /returns/:id/cancel — no ownership check                       |
| W11-004 | P1       | GET /customers/:id returns full PII to DRIVER role                  |
| W11-005 | P1       | UpdateUserDto role field in self-update path                        |
| W11-006 | P2       | GET /orders/:id accessible by DRIVER without route-assignment check |
| W11-007 | P2       | No rate limiting on auth endpoints                                  |
| W11-008 | P2       | GET /public/places/config leaks Google Maps API key unauthenticated |
| W11-009 | P2       | JWT role not re-verified server-side on role change                 |
