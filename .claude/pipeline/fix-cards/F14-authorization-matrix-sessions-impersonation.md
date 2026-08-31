# F14 · Authorization matrix, sessions and impersonation

**Bug IDs (7):** B52, B132, B133, B138, B155, B165, B168

**Root cause:** @Roles grants widened without matching the sibling route, and an uploads owner-lookup table that fails open. A driver can rewrite negotiated contract prices (B132), rewrite any standing order the 6am cron then bills (B133), and post backdated stock adjustments (B168); supplier-statement scans read cross-tenant (B52); signing out during impersonation revokes every session of the real tenant admin (B138).

**Ships as:** One PR. (The impersonation-exit residual is deliberately deferred to F29 — Low severity, touches only the tenant cookie.)

**Files:** customers.controller.ts · order-templates.controller.ts · inventory.controller.ts · uploads.controller.ts · impersonation.guard.ts · jwt.strategy.ts · auth.service.ts

**Together because:** One class of authorization-matrix defect (widened @Roles grant, or a lookup table that fails open) across several controllers.

**Guardrails / shared infra:** Delivers G2 — a controller authorization reflection spec (PR #491 already established the pattern) extended to pin every route's @Roles and @RequireAddon, paired with a default-deny rule for unmatched tenant-scoped upload prefixes (B52).

**Dependencies / lane notes:** No lane conflicts — freely parallel.

---

## Proof-tier assignment (frozen at seed — see plan's Phase 2 and `.claude/campaign/status/F14.jsonl`)

| ID   | Tier | Hunt-round SHA | Citation status              |
| ---- | ---- | -------------- | ---------------------------- |
| B52  | T1   | e5b0af8e       | NO_TOKEN_UNVERIFIED          |
| B132 | T1   | 0b2c3a0a       | AMBIGUOUS_FILE               |
| B133 | T1   | 0b2c3a0a       | MOVED (disambiguate in-file) |
| B138 | T2   | 0b2c3a0a       | TOKEN_NOT_FOUND              |
| B155 | T2   | 0b2c3a0a       | NO_TOKEN_UNVERIFIED          |
| B165 | T1   | 0b2c3a0a       | OUT_OF_BOUNDS                |
| B168 | T1   | 0b2c3a0a       | NO_TOKEN_UNVERIFIED          |

> T1 = jest spec (api or mobile pure-logic) · T2 = Playwright e2e, web-visible (proven-pending-deploy through the PR, per the plan) · T3 = recorded manual check (forbidden for Critical/High — none here are). See `.claude/campaign/citation-reanchor-log.md` for any bug ID flagged above whose citation needs a discovery-time check before trusting it verbatim.

---

## Bug details — register triple, evidence and suggested fix, pasted verbatim

### B52 — Supplier-statement scans are readable cross-tenant — prefix missing from the uploads owner lookup

**Area:** apps/api/src/uploads/uploads.controller.ts

**Meant to do:** GET /uploads/<key> denies any authenticated user outside the owning tenant for every tenant-scoped storage prefix, scanned supplier statements included.

**Actually does:** OWNER_LOOKUPS holds only 7 keys (products, customers, expenses, invoice-scans, invoice-pdfs, statement-pdfs, payments). The `supplier-statements/<scanId>/<n>.<ext>` prefix matches neither the tenants|regulated-filings|tobacco-reports regex nor any OWNER_LOOKUPS entry, so the `if (ownerLookup && ...)` guard is skipped entirely — no tenant check runs and the file streams for any authenticated JWT bearer.

**The gap:** The controller's own header comment claims eight of eleven prefixes are owner-gated; only seven are, and the missing one is a genuinely tenant-scoped model with no fallback denial.

**Evidence:** apps/api/src/uploads/uploads.controller.ts:54-101 (OWNER_LOOKUPS, 7 keys), :168-178 (guard silently no-ops when ownerLookup is undefined); apps/api/src/uploads/uploads-access.guard.ts:24-53 (any valid JWT reaches the controller); apps/api/src/supplier-statements/supplier-statements.service.ts:482-498 (key format); apps/api/prisma/schema.prisma:2509-2521 (SupplierStatementScan.tenantId).

**Suggested fix:** Add a `supplier-statements` entry to OWNER_LOOKUPS keyed off the scanId path segment (findUnique select tenantId), and make an unmatched tenant-scoped prefix deny by default rather than fall through.

### B132 — Drivers can overwrite any customer's negotiated contract price; only the clear path was hardened

**Area:** Customer pricing · API

**Meant to do:** Per-product negotiated pricing is office data — the service's own inline comment states that only operator-level users may change a negotiated override.

**Actually does:** A DRIVER token can POST /customers/:id/prices for any customer and rewrite an existing pricingTier or msrp to any value. Every later order line for that customer bills at the driver-chosen tier, and the driver cannot undo it because DELETE is operator-only.

**The gap:** The operator-level check was added only to the branch that clears an override; the upsert below it, which overwrites the price, has no role check at all.

**Evidence:** apps/api/src/customers/customers.controller.ts:239-249 (@Post(":id/prices") @Roles(OPERATOR, DRIVER)) vs :251-257 (@Delete(":id/prices/:priceId") @Roles(OPERATOR) only); apps/api/src/customers/customers.service.ts:1088-1110 (the clear-path branch whose comment names the exact risk and throws "Only operators can remove a price override"), :1113-1129 (the unguarded customerPrice.upsert — user is never consulted again); apps/api/src/auth/guards/roles.guard.ts:20-23; the only mutation callers are operator surfaces (apps/mobile/app/(operator)/customers/[id]/catalog.tsx:19-20,69 and apps/web/app/(dashboard)/customers/[id]/page.tsx:88-89,940) — apps/mobile/app/(driver)/ has no customer-pricing screen.

**Suggested fix:** Apply the operator-level check to the whole method (move it to the top of upsertCustomerPrice) and drop UserRole.DRIVER from @Post(":id/prices") so it matches its DELETE sibling — no driver screen calls it.

### B133 — Drivers can rewrite any customer's standing order; the 6am cron turns it into a billed order

**Area:** Standing orders · API (order-templates)

**Meant to do:** A standing order belongs to one customer and is changed by the office or by that customer. Deleting and manually generating are already withheld from drivers, so editing the same template should be too.

**Actually does:** A DRIVER token can add items to, or change the schedule and isActive flag of, ANY standing order in the tenant. generateDailyOrders then materialises the template into a real order that gets invoiced.

**The gap:** DRIVER is granted on the edit endpoints but excluded from delete and generate, and the ownership wrappers branch only on role === CUSTOMER, so drivers pass every check.

**Evidence:** apps/api/src/order-templates/order-templates.controller.ts:47-56 (@Patch(":id") admits DRIVER) vs :58-63 (@Delete(":id") excludes DRIVER), :65-70 (@Post(":id/items") — the only mutation on the controller that passes no @CurrentUser), :72-81, :83-88 (@Post(":id/generate") excludes DRIVER); apps/api/src/order-templates/order-templates.service.ts:83-92 and :104-113 (ownership branches only on role === CUSTOMER), :193-204 (addItem takes no user), :251-252 (@Cron("0 6 * * *") generateDailyOrders); apps/api/src/auth/guards/roles.guard.ts:20-23.

**Suggested fix:** Drop UserRole.DRIVER from @Patch(":id"), @Post(":id/items") and @Delete(":id/items/:itemId") to match the delete/generate siblings, and route addItem through an addItemForUser wrapper so it is consistent with every other mutation on the controller.

### B138 — Signing out during impersonation deletes every refresh token of the real tenant admin

**Area:** Impersonation · platform admin + web

**Meant to do:** Ending an impersonation session affects the support engineer's browser only; the customer's own sessions on their own devices are untouched — which is what the banner's "Exit impersonation" does.

**Actually does:** The header's Sign out is still rendered during impersonation and POSTs /auth/logout with the impersonation token, whose sub is the tenant's own TENANT_ADMIN. The server deletes every RefreshToken row for that user, signing the customer out everywhere.

**The gap:** A destructive server-side revoke is reachable from a control that, during impersonation, should either be hidden or routed to the local-only exit.

**Evidence:** apps/api/src/platform-admin/platform-admin.service.ts:571-598 (impersonate mints sub: adminUser.id with impersonatedBy, 15m); apps/web/lib/api-client.ts:102-117 (interceptor prefers the impersonation token for Authorization and X-Tenant-Slug); apps/web/app/(dashboard)/layout.tsx:947-953 (Sign out rendered unconditionally), :979-989 (exit() is local-only, no server call); apps/web/lib/auth-context.tsx:97-100 → apps/web/lib/auth.ts:92-104 (POST /auth/logout first); apps/api/src/auth/auth.controller.ts:102-111 → auth.service.ts:315-318 (refreshToken.deleteMany({ where: { userId } }) — every device); apps/api/src/auth/strategies/jwt.strategy.ts:19-49 (returns no impersonatedBy, so nothing downstream can distinguish an impersonated logout).

**Suggested fix:** Hide or repoint the header Sign out while an impersonation is active (route it to the banner's local exit), and defensively make the API skip refreshToken.deleteMany when the JWT carries impersonatedBy — which also requires propagating that claim through JwtStrategy.validate.

### B155 — Active Sessions lists rotated rows: sign-in times are wrong and Revoke fails on any refreshed session

**Area:** Active Sessions · web settings

**Meant to do:** "These are all devices currently signed into your account. Revoke any session you don't recognize." — the list shows when each device signed in, and Revoke ends that device's session.

**Actually does:** Every token refresh deletes the row and creates a new one with a new uuid and createdAt, so "Signed in" reports the last rotation, and Revoke on a since-rotated session 404s into a Forbidden that surfaces as "Failed to revoke session" while the device keeps working.

**The gap:** The list is a one-shot snapshot of rows the rotation path destroys roughly every fifteen minutes; ids and timestamps are stale by design.

**Evidence:** apps/api/src/auth/auth.service.ts:245 (deleteMany on every refresh), :295 (store the new token), :615-638 (an upsert keyed on the new hash always takes the create branch), :322-345 (listSessions returns id/createdAt), :347-354 (revokeSession → findUnique → "Session not found"); apps/api/prisma/schema.prisma:1707-1713; apps/api/src/config/configuration.ts:112 (15-minute access token, so an active device rotates about four times an hour); apps/web/app/(dashboard)/settings/page.tsx:1622-1635 (mount-only load, no refetch), :1637-1649, :1651-1665 (revoke-all swallows each error, so "All sessions revoked" always shows), :1739-1745.

**Suggested fix:** Give RefreshToken a stable session identity — carry id and createdAt forward on rotation, or add a sessionId the rotated row inherits — and reload the list after a failed revoke so the user sees current rows instead of a generic error.

### B165 — The impersonation guard can never fire — impersonated writes are audited as the tenant's own admin

**Area:** Impersonation audit trail · API

**Meant to do:** Support staff impersonating a tenant have full write access precisely because every write is traceable back to the platform operator who made it, as both the guard and the impersonate() docblock state.

**Actually does:** The guard's audit log is unreachable twice over: the JWT strategy returns a hand-listed object that omits impersonatedBy, and the guard runs as a global APP_GUARD before req.user exists at all. Writes land in the tenant's trail attributed to the tenant admin.

**The gap:** Two independent breaks put the guard's only side effect out of reach, so the traceability its own comment promises does not exist on any request.

**Evidence:** apps/api/src/auth/strategies/jwt.strategy.ts:20-49 (the returned literal has no impersonatedBy; canActAsDriver was added at :41 and #491 reasoned explicitly about which claims to copy); apps/api/src/auth/jwt-payload.interface.ts:21 (the claim is typed) and apps/api/src/platform-admin/platform-admin.service.ts:582-593 (it is minted); apps/api/src/auth/guards/impersonation.guard.ts:22-25 (the short-circuit) and :30-36 (the unreachable log); apps/api/src/app.module.ts:177-184 (registered as APP_GUARD, with JwtAuthGuard applied at route level only); decisive: apps/api/src/tenant/tenant-status.guard.ts:20-26 states in its own doc comment that an APP_GUARD runs before req.user is populated, decodes the header itself, and wrongly cites ImpersonationGuard as using the same workaround; apps/api/src/audit/audit.interceptor.ts:49 stamps userId with no impersonation marker.

**Suggested fix:** Have the guard decode impersonatedBy straight from the Authorization header the way TenantStatusGuard already does, add the claim to the JWT strategy's whitelist, and add an impersonatedBy column on AuditLog so the tenant-visible trail — not just the API log — names the acting platform operator.

### B168 — Drivers can post backdated stock adjustments and receive purchase orders while stock counts stay operator-only

**Area:** Inventory · API role matrix

**Meant to do:** Correcting stock levels and receiving supplier goods is warehouse and office work — the operator-only gate on the stock-count commit states that policy for the counted-correction path.

**Actually does:** A DRIVER token can post any signed adjustment up to ±9,999,999.999 with an arbitrary effective date — writing a movement, moving currentStock, minting a lot and recomputing later snapshots — and can create and receive purchase orders, while the identical-effect stock-count commit and the PO send/close endpoints refuse the same token.

**The gap:** Four inventory writes were widened to DRIVER and their nearest siblings were not; no driver screen calls any of them, so the grant is pure exposure.

**Evidence:** apps/api/src/inventory/inventory.controller.ts:39-41 (class @Roles(OPERATOR)), :57-61 and :63-67 (purchase and adjustment movements widened to DRIVER), :69-73 (the un-widened stock-count commit), :171-175 and :194-198 (PO create and receive widened), :189-192 and :200-204 (send and close inherit OPERATOR); apps/api/src/inventory/inventory.service.ts:272-328 (recordAdjustment writes createdAt from the caller-supplied effective date, increments currentStock, mints a lot on a positive delta and recomputes backdated snapshots); apps/api/src/inventory/dto/record-adjustment.dto.ts:1-26 (signed quantity, free-text reference, optional date, no reason enum, no approval); client reach: the mobile hooks are imported only by operator screens and apps/mobile/app/(driver)/ contains no inventory screen at all.

**Suggested fix:** Remove UserRole.DRIVER from the four inventory write endpoints so they match the stock-count commit and the PO send/close siblings; if a driver receiving flow is ever wanted, add a scoped endpoint rather than widening these.

---

## Discovery instructions (per the campaign plan)

Discovery's job is to confirm these lines still say what the register says they say on
current master, and find what the register missed — **never a broad repo sweep**. Where the
citation table above flags a bug ID, search within the files that ID's evidence already
names; do not expand beyond them without a specific reason. Classify every bug ID as
`CONFIRMED on master@<sha>`, `ALREADY FIXED (evidence)`, or `EVIDENCE MOVED (new path:line)`
before writing any code. An already-fixed ID is flipped in the register with its evidence —
never silently carried, never silently dropped.
