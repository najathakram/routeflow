# Security Findings Index

Index only — full detail lives in the untracked root `SECURITY_AUDIT.md`; statuses are
best-effort as of 2026-08-28.

`SECURITY_AUDIT.md` is a full-monorepo static security audit (repo root, gitignored — the
repo goes public for CI, so this file is never committed). It has 40 findings: 1 Critical,
15 High, 7 Medium, 16 Low, 1 Info. This index tracks ID, a one-line title, severity, and a
best-effort remediation status — no exploit detail or PoC steps. Statuses are drawn from
`.claude/code-map/CHANGELOG.md`, the `project_security_audit_remediation` and
`project_security_audit_new_2026-07` session memories (16 Critical/High shipped via
PRs #84–#90; a further wave via PR #247), and, where cited, direct re-verification against
current source. Anything not corroborated by one of those sources is marked UNREVIEWED —
treat it as unconfirmed either way, not as "still open."

## Critical

| ID | Title | Status |
| -- | ----- | ------ |
| F1-001 | Cross-tenant data takeover via `POST /import/contacts/adopt-orphans` | FIXED (#84; re-verified in source — `import.service.ts` `adoptOrphanedContacts` now scopes strictly to null-tenant rows, comment-tagged `SECURITY (F1-001)`; further hardened by the tenant-scope findUnique sweep, #446) |

## High

| ID | Title | Status |
| -- | ----- | ------ |
| F1-002 | Cross-tenant invoice-PDF IDOR via `GET /bookkeeping/transactions/:id/pdf` | FIXED (#84; re-verified in source — `invoice.service.ts` `getPresignedUrl` now uses `forTenant()`; further hardened by the tenant-scope findUnique sweep, #446) |
| F2-001 | BOLA: any CUSTOMER could cancel ANY return in the tenant (and reverse stock) | FIXED (#84) |
| F2-003 | BOLA/BFLA: CUSTOMER could delete items from / generate orders from ANY tenant's order template | FIXED (#84; regression specs added under PR #191) |
| F3-001 | Google OAuth never checked `email_verified` before email-based account linking | FIXED (#85; regression specs added under PR #191) |
| F3-002 | Legacy per-tenant Google OAuth auto-provisioned a staff OPERATOR for ANY Google user | FIXED (#85) |
| F8-001 | OAuth access AND refresh tokens placed in redirect URL query string across all sign-in callbacks | FIXED (#88 — single-use exchange-code handoff replaces URL tokens) |
| F4-001 | Buyer could self-assign `pricingTier`/`isTaxExempt`/`creditLimit` via unvalidated `any` body on `PATCH /buyer/me` | FIXED (#84 — typed DTO) |
| F5-001 | `STORAGE_URL_SIGNING_SECRET` silently fell back to `JWT_SECRET` | FIXED (#87 HKDF derivation; hardened to fail-closed/FATAL-in-prod via `assertSecrets()` in #247) |
| F5-002 | `EncryptionService` silently downgraded to a hardcoded key when `ENCRYPTION_KEY` unset/mis-sized | FIXED (#87 — refuses placeholder-key writes in prod) |
| F6-001 | SSRF via tenant-controlled SMTP host/port passed to `nodemailer.createTransport` | FIXED (#85 — SSRF guard on tenant SMTP host/port) |
| F9-001 | Pagination `limit` unbounded across list endpoints | FIXED (#85 initial `@Max`; hardened via `common/pagination.ts` `MAX_LIST_LIMIT`/`clampLimit` in #247 — note: products/suppliers/buyer price-sort caps left as pre-existing bounds, not re-derived) |
| F9-004 | Redis throttler failed OPEN on Redis error, disabling rate limiting incl. login brute-force protection | FIXED (#85 — fails closed) |
| F11-001 | No real Content-Security-Policy header on web despite a "strict CSP" comment | FIXED (#86 — real CSP + `X-Frame-Options: DENY`) |
| F11-002 | Access AND refresh tokens for all identities stored in JS-readable `localStorage` | OPEN (confirmed still open 2026-07-13 — cross-domain web/API cookie design needed; `COOKIE_SECRET` provisioned but unused) |
| F12-001 | Production dependency tree contained critical + high CVEs | PARTIAL (CI `npm audit` gate added #247, blocks on critical; version bumps were deferred at that time and have continued incrementally since, most recently the 99-bump Dependabot sweep #463 on 2026-08-28 — current full-tree CVE count not re-verified for this index) |

## Medium

| ID | Title | Status |
| -- | ----- | ------ |
| F2-002 | BOLA: `GET /orders/:id/tracking` disclosed any order's delivery/driver info to any authenticated user | FIXED (#247 — CUSTOMER ownership gate added, mirrors `findOne`) |
| F3-004 | Password-reset token transmitted in URL query string | FIXED (#247 — token captured into state then stripped from the URL; `Referrer-Policy: no-referrer` on the route) |
| F5-003 | Buyer and staff JWTs shared one signing secret; refresh tokens carried no identity discriminator | OPEN (confirmed still open 2026-07-13) |
| F5-004 | Tenant secrets stored in plaintext in `SystemConfig` | FIXED (#247 — `SECRET_KEYS` allowlist encrypted via `EncryptionService`) |
| F9-006 | `trust proxy=2` with default throttler tracker enabled `X-Forwarded-For` spoofing of per-IP rate limit and audit IP | OPEN (confirmed still open 2026-07-13; deployment-topology-dependent) |
| F12-002 | `runStartupMigration()` executes raw `ALTER TABLE` DDL on every API boot | OPEN (confirmed still open 2026-07-13) |
| F12-005 | Google OAuth deep-link callback (mobile) established a session purely from `routeflow://` URL query-param tokens | OPEN (confirmed still open 2026-07-13 — no state/PKCE nonce) |

## Low

| ID | Title | Status |
| -- | ----- | ------ |
| F2-005 | Missing object-level authorization on `GET /orders/:id` and `PATCH /orders/:id/urgent` for non-CUSTOMER roles | UNREVIEWED |
| F2-006 | Run chat messages readable by any authenticated role; no role or participant check on `GET /messages` | UNREVIEWED |
| F2-007 | Unauthenticated Google Places proxy endpoints (paid API) | UNREVIEWED |
| F3-005 | Buyer login and registration leaked account existence/status (user enumeration) | UNREVIEWED |
| F4-002 | User-controlled Prisma `orderBy` field name in `customers.findAll` | UNREVIEWED |
| F4-003 | Systemic: multiple mutation endpoints accept `@Body() dto: any`, bypassing the global ValidationPipe | UNREVIEWED |
| F8-003 | Raw Prisma/exception messages echoed to client in bulk-import `errors` arrays | UNREVIEWED |
| F9-007 | Expensive route-optimization endpoints relied only on the global 100/60s throttle | UNREVIEWED |
| F9-008 | CSV import had byte-size caps but no row-count cap | UNREVIEWED |
| F9-009 | Bulk product delete accepted an unvalidated, unbounded `ids` array | UNREVIEWED |
| F10-002 | Customers could mutate line items on already-CONFIRMED orders without re-confirmation | UNREVIEWED |
| F10-003 | Credit-notes `findOne` lacked a method-level role guard; DRIVER could read any credit note in the tenant | UNREVIEWED |
| F10-004 | Vendor-bill payment/update accepted unvalidated `any` body | UNREVIEWED |
| F10-005 | Invoice tax base for boxed products used un-prorated raw qty, diverging from the box-prorated subtotal | UNREVIEWED |
| F12-003 | All three Docker images ran as root (no `USER` directive) | UNREVIEWED |
| F12-004 | Web & mobile Docker builds used `npm install --force` instead of `npm ci` | UNREVIEWED |

## Info

| ID | Title | Status |
| -- | ----- | ------ |
| F2-MATRIX | Endpoint × role authorization matrix (informational reference, Appendix B of the source doc — not itself a vulnerability) | N/A (informational) |
