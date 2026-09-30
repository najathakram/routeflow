# Security Findings Index

Index only — full detail lives in the untracked root `SECURITY_AUDIT.md`. Statuses reflect a
source re-verification pass on 2026-09-11; see
[`../security/security-testing-program.md`](../security/security-testing-program.md) for the
standing program this re-verification feeds into.

`SECURITY_AUDIT.md` is a full-monorepo static security audit (repo root, gitignored — the
repo goes public for CI, so this file is never committed). It has 40 findings: 1 Critical,
15 High, 7 Medium, 16 Low, 1 Info. This index tracks ID, a one-line title, severity, and a
best-effort remediation status — no exploit detail or PoC steps. Statuses are drawn from
`.claude/code-map/CHANGELOG.md`, the `project_security_audit_remediation` and
`project_security_audit_new_2026-07` session memories (16 Critical/High shipped via
PRs #84–#90; a further wave via PR #247), and, where cited, direct re-verification against
current source. Anything not corroborated by one of those sources is marked UNREVIEWED —
treat it as unconfirmed either way, not as "still open."

The bug registry is the system of record for every security finding; this index maps audit
ids to registry ids.

## Critical

| ID | Title | Status | Registry |
| -- | ----- | ------ | -------- |
| F1-001 | Cross-tenant data takeover via `POST /import/contacts/adopt-orphans` | FIXED (#84; re-verified in source — `import.service.ts` `adoptOrphanedContacts` now scopes strictly to null-tenant rows, comment-tagged `SECURITY (F1-001)`; further hardened by the tenant-scope findUnique sweep, #446) | B361 |

## High

| ID | Title | Status | Registry |
| -- | ----- | ------ | -------- |
| F1-002 | Cross-tenant invoice-PDF IDOR via `GET /bookkeeping/transactions/:id/pdf` | FIXED (#84; re-verified in source — `invoice.service.ts` `getPresignedUrl` now uses `forTenant()`; further hardened by the tenant-scope findUnique sweep, #446) | B362 |
| F2-001 | BOLA: any CUSTOMER could cancel ANY return in the tenant (and reverse stock) | FIXED (#84) | B363 |
| F2-003 | BOLA/BFLA: CUSTOMER could delete items from / generate orders from ANY tenant's order template | FIXED (#84; regression specs added under PR #191) | B364 |
| F3-001 | Google OAuth never checked `email_verified` before email-based account linking | FIXED (#85; regression specs added under PR #191) | B365 |
| F3-002 | Legacy per-tenant Google OAuth auto-provisioned a staff OPERATOR for ANY Google user | FIXED (#85) | B366 |
| F8-001 | OAuth access AND refresh tokens placed in redirect URL query string across all sign-in callbacks | FIXED (#88 — single-use exchange-code handoff replaces URL tokens) | B367 |
| F4-001 | Buyer could self-assign `pricingTier`/`isTaxExempt`/`creditLimit` via unvalidated `any` body on `PATCH /buyer/me` | FIXED (#84 — typed DTO) | B368 |
| F5-001 | `STORAGE_URL_SIGNING_SECRET` silently fell back to `JWT_SECRET` | FIXED (#87 HKDF derivation; hardened to fail-closed/FATAL-in-prod via `assertSecrets()` in #247) | B369 |
| F5-002 | `EncryptionService` silently downgraded to a hardcoded key when `ENCRYPTION_KEY` unset/mis-sized | FIXED (#87 — refuses placeholder-key writes in prod) | B370 |
| F6-001 | SSRF via tenant-controlled SMTP host/port passed to `nodemailer.createTransport` | FIXED (#85 — SSRF guard on tenant SMTP host/port) | B371 |
| F9-001 | Pagination `limit` unbounded across list endpoints | FIXED (#85 initial `@Max`; hardened via `common/pagination.ts` `MAX_LIST_LIMIT`/`clampLimit` in #247 — note: products/suppliers/buyer price-sort caps left as pre-existing bounds, not re-derived) | B372 |
| F9-004 | Redis throttler failed OPEN on Redis error, disabling rate limiting incl. login brute-force protection | FIXED (#85 — fails closed). RF-160 (the `POST /auth/login` limit itself, 10/5min per IP) made env-configurable via `AUTH_LOGIN_THROTTLE_LIMIT`/`AUTH_LOGIN_THROTTLE_TTL_MS`: prod default unchanged; local override documented (wave B′) | B373 |
| F11-001 | No real Content-Security-Policy header on web despite a "strict CSP" comment | FIXED (#86 — real CSP + `X-Frame-Options: DENY`) | B374 |
| F11-002 | Access AND refresh tokens for all identities stored in JS-readable `localStorage` | OPEN (confirmed still open 2026-07-13 — cross-domain web/API cookie design needed; `COOKIE_SECRET` provisioned but unused) — tracked: registry B355 (batch F48) | B355 |
| F12-001 | Production dependency tree contained critical + high CVEs | PARTIAL (CI `npm audit` gate added #247, blocks on critical; version bumps were deferred at that time and have continued incrementally since, most recently the 99-bump Dependabot sweep #463 on 2026-08-28 — current full-tree CVE count not re-verified for this index) | B388 |

## Medium

| ID | Title | Status | Registry |
| -- | ----- | ------ | -------- |
| F2-002 | BOLA: `GET /orders/:id/tracking` disclosed any order's delivery/driver info to any authenticated user | FIXED (#247 — CUSTOMER ownership gate added, mirrors `findOne`) | B375 |
| F3-004 | Password-reset token transmitted in URL query string | FIXED (#247 — token captured into state then stripped from the URL; `Referrer-Policy: no-referrer` on the route) | B376 |
| F5-003 | Buyer and staff JWTs shared one signing secret; refresh tokens carried no identity discriminator | OPEN (confirmed still open 2026-07-13) — tracked: registry B356 (batch F48) | B356 |
| F5-004 | Tenant secrets stored in plaintext in `SystemConfig` | FIXED (#247 — `SECRET_KEYS` allowlist encrypted via `EncryptionService`) | B377 |
| F9-006 | `trust proxy=2` with default throttler tracker enabled `X-Forwarded-For` spoofing of per-IP rate limit and audit IP | OPEN (confirmed still open 2026-07-13; deployment-topology-dependent) — tracked: registry B357 (batch F48) | B357 |
| F12-002 | `runStartupMigration()` executes raw `ALTER TABLE` DDL on every API boot | FIXED (PR-1 `imp-03a`, 2026-09-03 — boot DDL deleted from `main.ts` and `platform-config.service.ts`; read-only drift gate `apps/api/scripts/schema-drift.mjs` + static tripwire `src/common/no-runtime-ddl.spec.ts`) | B378 |
| F12-005 | Google OAuth deep-link callback (mobile) established a session purely from `routeflow://` URL query-param tokens | OPEN (confirmed still open 2026-07-13 — no state/PKCE nonce) — tracked: registry B358 (batch F48) | B358 |

## Low

| ID | Title | Status | Registry |
| -- | ----- | ------ | -------- |
| F2-005 | Missing object-level authorization on `GET /orders/:id` and `PATCH /orders/:id/urgent` for non-CUSTOMER roles | FIXED (re-verified 2026-09-11 — orders.service.ts:474-491 and :5396-5403 ownership gates; DRIVER excluded at orders.controller.ts:471-473) | B379 |
| F2-006 | Run chat messages readable by any authenticated role; no role or participant check on `GET /messages` | FIXED (re-verified 2026-09-11 — messages.service.ts:23-37 assertRunChatParticipant on create and findByRun) | B380 |
| F2-007 | Unauthenticated Google Places proxy endpoints (paid API) | FIXED (re-verified 2026-09-11 — public-places.controller.ts:39,49,115 carry @UseGuards(JwtAuthGuard)) | B381 |
| F3-005 | Buyer login and registration leaked account existence/status (user enumeration) | PARTIAL (re-verified 2026-09-11 — login side fixed: buyer-auth.service.ts:198-217 constant "Invalid credentials", covered by buyer-auth.security.spec.ts; registration still returns a distinct 409 at :40-45 → registry B359 (batch F48)) | B359 |
| F4-002 | User-controlled Prisma `orderBy` field name in `customers.findAll` | FIXED (re-verified 2026-09-11 — customers.service.ts:160-183 validSortFields allowlist) | B382 |
| F4-003 | Systemic: multiple mutation endpoints accept `@Body() dto: any`, bypassing the global ValidationPipe | PARTIAL (re-verified 2026-09-11 — 9 routes still use @Body() dto: any: customers.controller.ts:216,228,306,312; estimates.controller.ts:14; inventory.controller.ts:171,193,213; returns.controller.ts:26 → registry B360 (batch F48)) | B360 |
| F8-003 | Raw Prisma/exception messages echoed to client in bulk-import `errors` arrays | FIXED (re-verified 2026-09-12 — apps/api/src/import/import.service.ts:80-89 — pushRowError logs the real error server-side and returns only a generic '<label>: import failed' message to the client, comment-tagged F8-003) | B390 |
| F9-007 | Expensive route-optimization endpoints relied only on the global 100/60s throttle | FIXED (re-verified 2026-09-11 — route-optimization.controller.ts:6-8 OPTIMIZE_THROTTLE 10/60s on every optimize/analyze/variants route) | B383 |
| F9-008 | CSV import had byte-size caps but no row-count cap | FIXED (re-verified 2026-09-11 — import.service.ts:21 MAX_IMPORT_ROWS=20000 enforced at :72-75) | B384 |
| F9-009 | Bulk product delete accepted an unvalidated, unbounded `ids` array | FIXED (re-verified 2026-09-11 — bulk-delete-products.dto.ts:9-15 @ArrayMaxSize(500)) | B385 |
| F10-002 | Customers could mutate line items on already-CONFIRMED orders without re-confirmation | FIXED (re-verified 2026-09-12 — apps/api/src/orders/orders.service.ts:4467-4477 — an item edit on a pre-dispatch CONFIRMED order reverts it to PENDING to force re-confirmation, comment-tagged F10-002) | B391 |
| F10-003 | Credit-notes `findOne` lacked a method-level role guard; DRIVER could read any credit note in the tenant | FIXED (re-verified 2026-09-11 — credit-notes.service.ts:520-533 findOneForUser DRIVER/CUSTOMER gates) | B386 |
| F10-004 | Vendor-bill payment/update accepted unvalidated `any` body | FIXED (re-verified 2026-09-12 — apps/api/src/vendor-bills/vendor-bills.controller.ts:170,192 — updateBill and the payment route now take typed DTOs (UpdateVendorBillDto, RecordVendorBillPaymentDto), no any body remains) | B392 |
| F10-005 | Invoice tax base for boxed products used un-prorated raw qty, diverging from the box-prorated subtotal | FIXED (re-verified 2026-09-12 — apps/api/src/invoices/invoices.service.ts:476-482 (create) and :3364-3368 (edit) — regular tax is computed as each line's stored post-discount subtotal times taxRate (RF-079), the same box-prorated basis the line itself bills on, not raw qty*unitPrice) | B393 |
| F12-003 | All three Docker images ran as root (no `USER` directive) | PARTIAL (re-verified 2026-09-11 — api and web drop root: apps/api/docker-entrypoint.sh:11-13, apps/web/Dockerfile:82; apps/mobile/Dockerfile runner stage still root → Plane ROAD task 11) | B389 |
| F12-004 | Web & mobile Docker builds used `npm install --force` instead of `npm ci` | FIXED (re-verified 2026-09-11 — apps/web/Dockerfile:29-32 and apps/mobile/Dockerfile:29-32 use npm ci) | B387 |

## Info

| ID | Title | Status | Registry |
| -- | ----- | ------ | -------- |
| F2-MATRIX | Endpoint × role authorization matrix (informational reference, Appendix B of the source doc — not itself a vulnerability) | N/A (informational) | ROAD-64 |
