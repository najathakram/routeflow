# QA Audit: Auth/Session & Standing Orders Scheduling

## Part A: Auth/Session Edge Cases

### W20-001 — No forced password change enforcement at API layer

- **Severity:** P1
- **File:** apps/api/src/auth/strategies/jwt.strategy.ts:19-34
- **Issue:** forcePasswordChange flag is in JWT but no server-side guard blocks endpoints
- **Evidence:** JWT strategy passes flag through without validation; no middleware checks it
- **Impact:** Malicious clients can bypass password change requirement
- **Fix:** Implement ForcePasswordChangeGuard that blocks all endpoints except auth operations

---

### W20-002 — Tenant code enumeration in login

- **Severity:** P2
- **File:** apps/api/src/auth/strategies/local.strategy.ts and auth.service.ts:31-54
- **Issue:** TenantResolutionMiddleware silently fails on invalid tenant; same error for bad tenant/password
- **Evidence:** Silent skip of unknown tenants; generic "Invalid credentials" error for both cases
- **Impact:** Attackers can enumerate valid tenant slugs
- **Fix:** Always require explicit tenant slug validation; consistent error messaging

---

### W20-003 — No timeout/single-use enforcement on email verification tokens

- **Severity:** P2
- **File:** apps/api/src/auth/auth.service.ts:288-320
- **Issue:** Email verification tokens are JWTs with no database tracking; can be reused indefinitely
- **Evidence:** Line 293 verifies signature only; line 309-316 allows replay; no revocation
- **Impact:** Leaked verification emails can verify accounts multiple times
- **Fix:** Store token hashes in DB; mark as used on verification; reject reused tokens

---

### W20-004 — Refresh token race condition in user status check

- **Severity:** P1
- **File:** apps/api/src/auth/auth.service.ts:113-195
- **Issue:** User status checked at line 135-138 but tokens issued at 161-164; no atomic transaction
- **Evidence:** No Prisma $transaction() wrapping; status could change between check and issue
- **Impact:** Suspended/deleted users can briefly issue new tokens in race condition window
- **Fix:** Wrap refresh in transaction; re-fetch user inside transaction before issuing tokens

---

### W20-005 — Concurrent sessions have no safeguards or alerts

- **Severity:** P2
- **File:** apps/api/src/auth/auth.service.ts:204-236
- **Issue:** Unlimited concurrent sessions; no detection of suspicious activity (new IP, device count, etc)
- **Evidence:** No constraint on token count per user; no automatic revocation on suspicious access
- **Impact:** Account takeover easier; attackers create many sessions undetected
- **Fix:** Add max concurrent sessions, IP-based locking, or require re-auth for sensitive ops

---

## Part B: Standing Orders / Recurring Scheduling

### W20-006 — Cron scheduler hardcoded to UTC, not tenant timezone

- **Severity:** P1
- **File:** apps/api/src/order-templates/order-templates.service.ts:222 and recurring-invoices.service.ts:198
- **Issue:** Cron jobs hardcoded to UTC but TenantConfig.timezone exists but unused
- **Evidence:** @Cron("0 6 \* \* \*") fires at 06:00 UTC; TenantConfig.timezone defined at schema line 323 but never read
- **Impact:** Standing orders fire at wrong local time for all tenants
- **Fix:** Custom scheduler that reads TenantConfig.timezone and converts UTC to local time check

---

### W20-007 — DST transitions cause double-fire or missed fires

- **Severity:** P2
- **File:** apps/api/src/order-templates/order-templates.service.ts:222-263
- **Issue:** Timezone-unaware cron can skip/double-fire on DST boundaries
- **Evidence:** Line 240 idempotency check uses non-timezone-aware startOfDay()
- **Impact:** Orders skip or duplicate on DST boundary days
- **Fix:** Use timezone-aware date library for all comparisons

---

### W20-008 — Server downtime = missed orders (no recovery mechanism)

- **Severity:** P2
- **File:** apps/api/src/order-templates/order-templates.service.ts:222-263
- **Issue:** Cron job skipped if server down; no retry or recovery on restart
- **Evidence:** @Cron fires once daily; no queue mechanism; no lastRunAt tracking on template
- **Impact:** Standing orders silent skipped if server unavailable
- **Fix:** Replace @Cron with Bull queue job running every minute; implement catch-up on restart

---

### W20-009 — Template item edits do NOT apply to scheduled orders

- **Severity:** P2
- **File:** apps/api/src/order-templates/order-templates.service.ts:161-178
- **Issue:** Template edits only affect future orders; existing orders keep old items (denormalized)
- **Evidence:** Line 163-170 updates template but not existing orders; items are independent records
- **Impact:** Customers receive stale product lists in scheduled orders
- **Fix:** Document behavior; add API to retroactively update pending orders if needed

---

### W20-010 — Template deletion with pending orders

- **Severity:** P2
- **File:** apps/api/src/order-templates/order-templates.service.ts:180-184
- **Issue:** Template hard-deleted but Prisma schema has no onDelete:Cascade; deletion fails if orders exist
- **Evidence:** Line 182 delete() call; schema line 821 has no cascade; Prisma defaults to Restrict
- **Impact:** Deletion fails if orders exist; prevents cleanup; orders become dangling
- **Fix:** Require cancellation of all pending orders before deletion, or implement soft-delete

---

### W20-011 — Cron jobs run without tenant context (cross-tenant leak risk)

- **Severity:** P2
- **File:** apps/api/src/order-templates/order-templates.service.ts:223-233 and recurring-invoices.service.ts:199-206
- **Issue:** Cron jobs use prisma.forTenant() but have no HTTP context to set TenantContext
- **Evidence:** Line 230 calls forTenant() in cron context; TenantContext set only by middleware for HTTP
- **Impact:** Cross-tenant data leakage or orders generated for wrong tenant
- **Fix:** Explicitly loop all tenants in cron; set context per iteration; ensure AsyncLocalStorage for tasks

---

## Summary

Critical P1 Issues:

- W20-001: API bypass via forced password change flag
- W20-004: Refresh token race condition
- W20-006: Cron hardcoded UTC (wrong times for all tenants)
- W20-011: Cron runs without tenant context

High P2 Issues:

- W20-002: Tenant enumeration
- W20-003: Email token replay
- W20-005: Concurrent session abuse
- W20-007: DST boundary bugs
- W20-008: Silent missed orders on downtime
- W20-009: Stale template items in orders
- W20-010: Deletion blocking issue
