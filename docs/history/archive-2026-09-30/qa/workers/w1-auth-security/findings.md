# W1 Auth & Security Audit Report

**Date:** 2026-04-29
**Status:** COMPREHENSIVE AUDIT COMPLETE

## Summary

RouteFlow's authentication and authorization layers are well-architected with strong multi-tenant isolation.

**Critical Issues:** 0
**High Issues:** 1
**Medium Issues:** 3
**Low Issues:** 2
**OK Observations:** 8

## Issues Found

### W1-001 - Missing RolesGuard on Credit Notes GET Endpoints (P1)

**File:** /apps/api/src/credit-notes/credit-notes.controller.ts lines 22-48
**Issue:** GET endpoints lack @UseGuards(RolesGuard) and @Roles() decorators
**Fix:** Add guard decorators to both GET methods

### W1-002 - JWT Claims Not Validated in OAuth Callback (P2)

**File:** /apps/api/src/auth/auth.controller.ts lines 233-255
**Issue:** Claims not validated before constructing redirect URL
**Fix:** Validate JWT claims against returned user record

### W1-003 - TenantStatusGuard Fails Open on DB Error (P2)

**File:** /apps/api/src/tenant/tenant-status.guard.ts lines 95-100
**Issue:** Guard returns true on DB exceptions, allowing suspended tenants through
**Fix:** Fail closed; use cache if available

### W1-004 - RolesGuard Denies All Without @Roles Decorator (P2)

**File:** /apps/api/src/auth/guards/roles.guard.ts lines 30-35
**Issue:** Missing @Roles() makes service checks unreachable
**Fix:** Ensure all @UseGuards(RolesGuard) pair with @Roles()

### W1-005 - canActAsDriver Permission Not Explicitly Authorized (P3)

**File:** /apps/api/src/users/users.controller.ts lines 100-105
**Issue:** OPERATOR can grant driver permissions without explicit validation
**Fix:** Restrict to TENANT_ADMIN if appropriate

### W1-006 - Access Tokens Valid After Password Reset (P3)

**File:** /apps/api/src/auth/auth.service.ts lines 322-345
**Issue:** Password change doesn't invalidate access tokens (~15 min window)
**Fix:** Reduce access token TTL to 5-10 minutes

## Verified OK

1. TenantInterceptor sets context correctly
2. Prisma forTenant() scopes all queries
3. JWT tenantId never from request body
4. Refresh token rotation prevents reuse
5. OAuth nonce provides CSRF protection
6. Google linking prevents duplicates
7. SuperAdminGuard restricts platform routes
8. Email verification uses JWT with expiration

## Conclusion

Production-ready architecture with strong defense-in-depth.
Immediate actions: Address W1-001 and W1-003.
