# Spec — F14 v2: authorization / tenancy matrix

**Status:** DRAFT for the lead · batch F14 (rows B52 B132 B133 B138 B155 B165 B168) · branch
`fix/F14-authz-matrix-v2` (worktree `.claude/worktrees/rf-F14`, at master `39632d27`).
**Input:** `.claude/pipeline/2026-09-02-wave-a-completion/F14.md` (every verdict "confirmed") and
`SEQUENCE.md` (allocations: e2e specs **31** `31-impersonation-signout`, **32** `32-active-sessions`;
lesson id **L-044**; no other numbers). Companion: [test-plan.md](./test-plan.md).
**Supersedes** `.claude/pipeline/2026-09-01-F14-authz-matrix/` (untracked, branch `fix/F14-authz-matrix`,
written against `3d1d8ea9`). Where this document differs from that one it is deliberate and marked
`[v1 diff]`; the card is authoritative.

Risk class: **HIGH on every requirement** — auth, tenancy, PII. Every claim below about a file was
re-read at `39632d27` in the worktree (L-026); line numbers are from there.

## 0. The seam, in one sentence

Each row is a place where the request's IDENTITY (tenant, role, impersonation claim, session row)
is established on one path and a sibling path never consults it — an unmapped storage prefix that
skips the owner-tenant lookup and then serves; DRIVER grants that outlived the deleted driver
screens; an `impersonatedBy` claim minted but dropped by both JWT strategies; a refresh rotation
that destroys the row identity the Active Sessions UI keys on. L-029 names the pattern: an
invariant with a known exception is a bug with a scheduled date.

Layers touched (L-008 — the commit title MUST name both): **api** and **web**, plus the
approved-tenant seed script `apps/api/scripts/e2e-seed.js`. **No mobile file. No schema change.
No migration** (`AuditLog.impersonatedBy` shipped in `20260908000000`, F01/#548).

## 1. Requirements

Format: `R# (row · priority · tier) — title` → statement → verification. Priorities: **P0** a
Critical/tenant-boundary leak; **P1** a privilege or session-integrity defect; **P2** defence in
depth / uniformity that pins P0–P1 against regression. Tier per the frozen shard
`.claude/campaign/status/F14.jsonl`: B52 B132 B133 B165 B168 = **T1** (jest, `apps/api`);
B138 B155 = **T2** (Playwright against the DEPLOYED site — campaign decision D1: `apps/web` has no
unit runner, so a web-side proof is an e2e spec discharged POST-deploy, reading STEP conclusions,
never the job's — L-041).

### Uploads (B52 · Critical)

**R1 (B52 · P0 · T1) — `supplier-statements/` is owner-gated.**
`GET /uploads/supplier-statements/<scanId>/<n>.<ext>` on the JWT path resolves
`SupplierStatementScan.findUnique({ where: { id: scanId }, select: { tenantId } })` (unscoped
`PrismaService`, exactly like the seven existing `OWNER_LOOKUPS` entries at
`uploads.controller.ts:61-101`) and serves only when the row exists AND `row.tenantId === caller.tenantId`.
A missing row, a `NULL tenantId` row (`SupplierStatementScan.tenantId` is `String?`,
`schema.prisma:2548`) or a caller with no `tenantId` → `ForbiddenException("Cross-tenant file access denied")`.
`SUPER_ADMIN` and the signed-URL path (`req.signedUrlAuthorized`) stay exempt as today.
Key writer: `supplier-statements.service.ts:500`. The id segment carries no extension, so the
existing strip at `:169` is a no-op here.
→ **T1, T2, T3, T4.**

**R2 (B52 · P0 · T1) — the JWT path fails CLOSED for every prefix neither gate knows.**
After the regex gate (`tenants|regulated-filings|tobacco-reports`, `:155`) and the owner-lookup
gate (`:170`), if `!tenantMatch && !ownerLookup && caller?.role !== "SUPER_ADMIN"` →
`ForbiddenException("Cross-tenant file access denied")` (same message: no disclosure of which
prefixes exist). Applies to unknown first segments AND flat keys with no slash. The deny happens
**before** `fs.existsSync` — 403-vs-404 must not leak key existence. Sweep at `39632d27`
(`storage.upload(` call sites, 14; distinct key prefixes written, 11): `expenses/`, `statement-pdfs/`,
`customers/`, `invoice-pdfs/`, `payments/`, `products/`, `supplier-statements/`, `tenants/`,
`invoice-scans/`, `regulated-filings/`, `tobacco-reports/` — after R1 every one of the 11 is
covered by one of the two gates, so the deny only ever fires for a key nobody writes.
`bookkeeping/invoice.service.ts:89` `invoices/<txId>.pdf` is EXCLUDED on purpose: it goes through
its own S3 client + `getSignedUrl` and is never served by this controller. An EXPIRED signature
falls through to the JWT path (`uploads-access.guard.ts:46-49`); an unknown prefix there now
403s instead of 200 — intended. Header comment (`:54-60`, `:162-165`) is rewritten to state
"three regex-scoped prefixes, eight owner-lookup prefixes, everything else denied".
**Collateral, in scope:** `uploads-xss.security.spec.ts:233,296` stubs the guard with
`canActivate: () => true` and serves flat keys (`foo.png`, `doc.pdf`, `evil.svg`) with NO caller —
under R2 those header tests would 403. The stub must set `req.signedUrlAuthorized = true` (it tests
response headers, not auth — its own comment says so). `uploads-signed-url.security.spec.ts:204`
already expects 4xx on a missing signature and stays green.
→ **T5, T4.**

### DRIVER grants that outlived their screens (B132 · B133 · B168)

Shared facts (verified): `RolesGuard` (`roles.guard.ts:30-34`) resolves `getAllAndOverride(handler, class)`;
`TENANT_ADMIN` satisfies `OPERATOR`; an OPERATOR/TENANT_ADMIN with `canActAsDriver` ADDS `DRIVER`
to what they satisfy and keeps `OPERATOR` — so dropping DRIVER from a grant regresses no operator
who also drives. `apps/mobile/app/(driver)` at `39632d27` contains `cash, driver-*, map, orders, route`
and no file referencing `order-templates`, `purchase-orders`, `movements/*` or `/prices` (re-run in
this session). The grants' origin commits (`898fc1fb`/`1eec1a4b`, `f52acb09`) added driver screens
that `028f86b0` deleted; the server grants were never withdrawn.

**R3 (B132 · P1 · T1) — `POST /customers/:id/prices` requires OPERATOR, matching its DELETE sibling.**
`customers.controller.ts:240-241` `@Roles(UserRole.OPERATOR)`; equals `deleteCustomerPrice`'s
(`:252`). `GET :id/prices` (`:232-233`) keeps DRIVER — a read, out of scope (L-008).
→ **T7.**

**R4 (B132 · P1 · T1) — the service refuses non-operators before any read.**
`CustomersService.upsertCustomerPrice(customerId, dto, user: JwtPayload)` — `user` becomes
required (single caller passes it). The `operatorLevel` computation now at `:1101-1108` (inside the
clear-both branch only) is hoisted to the top: `role ∈ {OPERATOR, TENANT_ADMIN, SUPER_ADMIN}` else
`ForbiddenException("Only operators can change a price override")`, evaluated **before**
`assertMsrpAllowed()` and before `customerPrice.findUnique` — a driver must not learn whether an
override exists. The inner check becomes redundant and is removed. Ordering relative to the
empty-DTO `BadRequestException`: role first (authorization before semantics); the existing
"400s when neither field present" test uses an operator payload and is unaffected.
**The existing pin `customers.service.spec.ts:1222` "a DRIVER may still null the tier on a row that
keeps its MSRP" asserts the bug and is INVERTED** (a DRIVER → `ForbiddenException`, `upsert` never
called). `[v1 diff]` v1 proposed a new message string; this keeps the existing wording family.
→ **T8.**

**R5 (B133 · P1 · T1) — standing-order mutations exclude DRIVER, uniformly.**
`order-templates.controller.ts`: `create` (`:41-46`, the sibling the register missed),
`update` (`:48-57`), `addItem` (`:66-71`), `removeItem` (`:73-82`) drop `UserRole.DRIVER`.
Resulting matrix: `create/update/remove/removeItem/generateOrder` = `{OPERATOR, CUSTOMER}`;
`addItem` = `{OPERATOR}` (CUSTOMER never had it — granting CUSTOMER self-service adds is an
owner decision, flagged in §4, not made here). Reads `findAll/findOne` carry no `@Roles` and are
out of scope; residual recorded in §4: a DRIVER can still LIST every template. Cron amplification:
`generateDailyOrders` `@Cron("0 6 * * *")` (`:251+`) materialises whatever a driver wrote into
billed orders — which is why the write matrix matters more than the read.
→ **T9.**

**R6 (B133 · P2 · T1) — every mutation on the controller goes through an ownership wrapper.**
`addItem` gains `@CurrentUser() user` and calls a new
`addItemForUser(templateId, dto, user) { await this.findOneForUser(templateId, user); return this.addItem(templateId, dto); }`
placed beside `removeItemForUser/generateOrderForUser` (`:240-249`). For OPERATOR the wrapper is
a pass-through today (the ownership branch is CUSTOMER-only, `:83-92`); its value is uniformity —
a future CUSTOMER grant on `addItem` cannot ship unguarded. `[v1 diff]` v1 dropped the wrapper as
"guards nothing"; SEQUENCE §1 makes F14 the owner of this 4-line service edit and F13 rebases over
it — keep it. **Collision:** F13 B48 rewrites `createOrderFromTemplate` (`:309-372`) and B09 may
extend `updateForUser`; different regions of the same two files. Land B133 LAST in the batch.
→ **T10, T11.**

**R7 (B168 · P1 · T1) — inventory writes inherit the class-level OPERATOR gate.**
Delete the handler-level `@Roles(UserRole.OPERATOR, UserRole.DRIVER)` on `recordPurchase`
(`:57-61`), `recordAdjustment` (`:63-67`), `createPO` (`:171-175`), `receivePO` (`:194-198`) so
they inherit class `@Roles(UserRole.OPERATOR)` (`:39-41`) exactly like `sendPO`/`closePO`, which
carry no decorator. Effective roles of all seven writes (`+commitStockCount`) = `[OPERATOR]`.
Reads `getStockOverview/listMovements/listPOs/getPO` keep DRIVER — pinned so the fix cannot
over-reach. Harm today: `recordAdjustment` (`inventory.service.ts:272-328`) writes
`StockMovement.createdAt` from a caller-supplied `effectiveDate`, moves `currentStock` by any signed
`Decimal(10,3)` and mints a `StockLot`; `record-adjustment.dto.ts` has no reason field — DTO
hardening is out of scope (§4).
→ **T12, T13.**

### Impersonation identity (B165 · B138)

**R8 (B165 · P1 · T1) — both JWT strategies propagate `impersonatedBy`; absent stays absent.**
`jwt.strategy.ts:24-49` returns a hand-listed literal without the claim `jwt-payload.interface.ts:21`
types and `platform-admin.service.ts:582-593` mints. Add `impersonatedBy: payload.impersonatedBy ?? undefined`
to the whitelist — never a fabricated value. `buyer-jwt.strategy.ts:20-25` likewise
(`buyer-admin.service.ts:115-120` mints it on BUYER tokens; `buyer-jwt-payload.interface.ts:9`
types it). `isAdmin` stays deliberately un-propagated (the #491 reasoning in the file holds:
`impersonatedBy` is not an authorization input; `RolesGuard` ignores it). This is the shared
groundwork R10/R11 depend on — **edit once, first** (SEQUENCE §2 F14-internal order).
→ **T14.**

**R9 (B165 · P1 · T1) — the durable tenant trail names who really wrote.**
`AuditInterceptor` (`audit.interceptor.ts:46-55`) runs AFTER route guards, so it reads the VERIFIED
`req.user`; it passes `impersonatedBy: user?.impersonatedBy ?? null`. `CreateAuditLogDto`
(`audit.service.ts:4-12`) gains `impersonatedBy?: string | null`; `log()` writes
`impersonatedBy: dto.impersonatedBy ?? null` into `auditLog.create` (column
`schema.prisma:3327`, comment "F14 wires the guard that stamps it" — L-035: the schema comment IS
the spec). The existing try/catch that swallows audit failures is unchanged (an audit write must
never fail the request). `GET /platform-admin/audit-logs` (`findMany`, no `select`) returns the
column automatically; an admin-UI "via" column is a follow-up (§4).
→ **T15, T16.**

**R10 (B165 · P2 · T1) — `ImpersonationGuard` can actually observe the claim.**
It is registered as `APP_GUARD` (`app.module.ts:184`) while `JwtAuthGuard` is route-level only
(no `APP_GUARD` JwtAuthGuard exists — grep), and Nest runs global guards first, so
`request.user` (`impersonation.guard.ts:19-25`) is ALWAYS undefined there: the log has never once
fired. Fix: decode the claim from the `Authorization` header exactly as `tenant-status.guard.ts:43-59`
does (base64url payload segment, `try/catch`, NO signature check — acceptable for a log-only side
effect; `JwtAuthGuard` still verifies downstream), prefer `request.user` when a future ordering
sets it, and on non-`GET/HEAD/OPTIONS` log
`Impersonation write: <METHOD> <path> (admin=<impersonatedBy>, acting-as=<sub>, tenant=<tenantId>)`.
No header / malformed / no claim → return `true` silently. **Always returns `true`** — this guard
never blocks. Keeping the guard (rather than deleting the `APP_GUARD`) preserves the docblocks
`platform-admin.service.ts:566-569` and e2e CC-05 cite and makes `tenant-status.guard.ts`'s
"same approach used by ImpersonationGuard" comment true instead of requiring an edit there.
→ **T17.**

**R11 (B138 · P1 · T1 — API defence in depth) — logout under impersonation revokes nothing.**
`auth.controller.ts:102-111` `logout()` today calls `authService.logout(user.id)` →
`refreshToken.deleteMany({ where: { userId } })` (`auth.service.ts:315-318`). An impersonation
token's `sub` IS the tenant's `TENANT_ADMIN` (`platform-admin.service.ts:576-593`), so a super-admin
signing out revokes every device of the customer's admin. With R8 in place `@CurrentUser()` (which
returns `req.user` whole) carries `impersonatedBy`; when it is set, `logout` still clears the
`rf_refresh` cookie (harmless — an impersonation has no refresh token) but does NOT call
`authService.logout`, returning `{ message: "Impersonation session ended" }`. Unimpersonated
logout is byte-for-byte unchanged.
→ **T18, T21(4).**

**R12 (B138 · P1 · T2 — web, primary) — while impersonating, the header offers an exit, never "Sign out".**
`Header` (`layout.tsx:640-`) renders `menu.signOut` unconditionally (`:947-951`) and has no
impersonation awareness; only `ImpersonationBanner` (`:964-1010`) reads the state, and its `exit()`
(`:979-989`) is local. Requirement: `Header` subscribes exactly as the banner does
(`getImpersonation` + `subscribeImpersonation`, re-read on `pathname`). When `imp` is non-null,
the menu item in the sign-out slot is **"Exit impersonation"** (`LogOut` icon; when `imp.expired`,
label **"Return to admin"** — mirroring the banner) and invokes a shared `exitImpersonation()`
exported from `apps/web/lib/impersonation.ts` = the banner's body (`clearTenantCookie();
clearImpersonation(); window.location.href = "/admin/tenants"` — hard load so every provider
remounts). The banner's `exit` calls the same function (one copy). **No request to
`POST /auth/logout` is issued from the exit path.** `[v1 diff]` the card conditions on
`imp && !imp.expired`; this spec hides "Sign out" for ANY non-null `imp` (expired included),
because an expired impersonation plus "Sign out" races `api-client.ts:102-117`'s auto-exit
redirect with a `/auth/logout` POST — the safe state is "never Sign out while impersonation
state exists". Labels go through i18n (`lib/i18n/messages.ts`: `menu.exitImpersonation`,
`menu.returnToAdmin`, en + es) to match the menu's existing `t("menu.signOut")` pattern.
`api-client.ts` is NOT edited (its auto-exit belongs to B173/F29). `lib/auth.ts logout()` is NOT
edited (its only caller is the header item this requirement replaces; a guard there would be a
second copy of the same decision — L-030).
→ **T21.**

### Session identity (B155)

**R13 (B155 · P1 · T1 — API) — refresh rotates the session row IN PLACE; identity survives.**
Today `refresh()` (`auth.service.ts:245`) `deleteMany({ where: { tokenHash } })` then
`storeRefreshToken` (`:619-638`) `upsert({ where: { tokenHash: NEW } })` — which can only take the
`create` branch → a new `id` and `createdAt` every rotation; with a 15-minute access token that is
~4 rotations/hour/device, so `listSessions` (`:322-345`) shows "Signed in" = last rotation and
`revokeSession` (`:347-354`) 403s "Session not found" for any id the UI captured before a
rotation. Requirement: after the stored-token, realm and user checks and after minting the new
pair, run
`refreshToken.updateMany({ where: { id: stored.id, tokenHash: oldHash }, data: { tokenHash: newHash, expiresAt, lastUsedAt: now, userAgent/ipAddress/deviceName ONLY when deviceInfo was supplied (else undefined — never nulled) } })`.
`id`, `createdAt`, `userId`, `tenantId` are never written (L-037: enumerate every column the
rotation touches and say why). If `count === 0` — the concurrent-rotation race the old
`deleteMany` comment tolerated — fall back to today's `storeRefreshToken` create, so two
simultaneous refreshes of one token still both succeed and the loser gets a fresh row exactly as
today. The `deleteMany` at `:245` is removed (the update IS the invalidation of the old hash).
**Preserve token consumption on the inactive-user branch** (`:247-250` today throws AFTER the
delete): an `!ACTIVE`/`deletedAt` user's presented token must still be destroyed
(`deleteMany({ where: { tokenHash } })`) before the 401 — otherwise the row survives in
`listSessions`. `login`/`mintSessionForUser` keep `storeRefreshToken` (a login IS a new session).
Mobile posts the body token to the same endpoint and is unaffected. Every other `RefreshToken`
writer was enumerated (`:316, :352, :472, :564, :619; google-oauth.service.ts:739`) — only
`:245 + :619` form the rotation.
→ **T19, T22.**

**R14 (B155 · P1 · T2 — web) — Active Sessions tells the truth and never lies about success.**
`SessionsCard` (`settings/page.tsx:1614-1665`): each session `<li>` carries
`data-session-id={session.id}` (the e2e's handle; also useful to support). `handleRevoke`'s catch
calls `loadSessions()` so a genuinely stale row disappears instead of a generic error; success path
unchanged. `handleRevokeAll` uses `Promise.allSettled`, counts rejections, toasts "All sessions
revoked" only when every call succeeded, otherwise
`{ title: "Some sessions could not be revoked", variant: "error" }` and reloads. No layout change.
→ **T22, T23.**

### Preconditions that gate DISCHARGE, not landing

**R15 (B138 precondition · P1) — the e2e tenant has an ACTIVE TENANT_ADMIN.**
`impersonate()` requires one (`platform-admin.service.ts:576-579` → 404 otherwise) and
`e2e-seed.js` seeds only OPERATOR `admin` and CUSTOMER `harbor_cafe` (`:87-107`, `:180-200`).
Add an idempotent `e2e_admin` TENANT_ADMIN (ACTIVE, `forcePasswordChange: false`,
`email e2e_admin@e2e-routeflow.test`) to both branches of the seed (existing-tenant and fresh)
and a `CREDENTIALS.tenantAdmin` entry in `apps/web/e2e/helpers/constants.ts`. The seed is
`assertTestTenant`-guarded and targets the approved `e2e-routeflow` tenant only. **The prod
reseed is an OWNER/LEAD action** (`railway run --service postgres node apps/api/scripts/e2e-seed.js`);
until it runs, spec 31 skips with the reason "e2e tenant has no TENANT_ADMIN" — and a skip is
NOT a discharge (L-041). Spec 31 must target the e2e tenant **by slug**
(`GET /platform-admin/tenants?search=e2e-routeflow`, then `slug === TENANT_SLUG`), never
`?limit=1` as CC-05 does — the client-data policy forbids impersonating whichever tenant sorts
first.
→ **T24, T21 (skip logic).**

**R16 (both T2 rows · P1) — specs 31 and 32 each get a `playwright.config.ts` project entry.**
One project per spec file, **no shared `storageState`** (31 manages super-admin + tenant-admin
sessions itself; 32 must not consume the shared `operator.json` refresh token because it revokes
its own session), `dependencies: ["setup"]` only where the spec reads a setup artefact. A spec
without a project entry never runs (the `08-create-order-escape` precedent the config's own
comments cite). Verification is by the post-deploy run's STEP log listing both project names, not
by `npx playwright test --list` — **never run Playwright locally, not even `--list`**: it
overwrites `.campaign/runs/web-e2e.json` (SEQUENCE §6.5).
→ **T21, T22 discharge protocol.**

**R17 (B165 deploy precondition · P0) — the F01 column is live in prod before F14 deploys.**
`railway run npx prisma migrate status` must list `20260908000000_campaign_schema_foundation` as
applied. If it is not, `AuditService`'s try/catch is ALREADY silently swallowing every audit write
in prod today, and F14 would stamp into a missing column. Recorded in the PR body.
→ **T25.**

## 2. Completeness sweep — every changed surface × empty / unauthorized / concurrent / stale

| Surface                                | Empty                                                                                        | Unauthorized                                                                                                                                       | Concurrent                                                                                                                                                                                                                          | Stale                                                                                                                                                                                                                                    |
| -------------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /uploads/*` (R1, R2)              | empty key → 404 "Missing file key" (unchanged, before auth)                                  | no bearer & no sig → 401 from guard; other tenant → 403; unknown prefix → 403; flat key → 403; missing/NULL-tenant owner row → 403 (fail closed)   | read-only; none                                                                                                                                                                                                                     | file on disk but scan row deleted → 403 (deny precedes `existsSync`, no existence leak); EXPIRED signature → JWT path → same rules; legacy volume files under an unlisted prefix → 403 for bearer, still servable via a fresh signed URL |
| `POST /customers/:id/prices` (R3, R4)  | `{productId}` only → 400 (after the role gate)                                               | DRIVER → 403 at `RolesGuard`; DRIVER reaching the service by any future path → 403 before any DB read; `user` undefined → 403                      | two operator upserts race on the `customerId_productId` unique — Prisma `upsert` serialises (unchanged)                                                                                                                             | row deleted between read and write → `upsert` creates (unchanged)                                                                                                                                                                        |
| order-templates mutations (R5, R6)     | —                                                                                            | DRIVER → 403 on create/update/addItem/removeItem; CUSTOMER non-owner → 403 via `findOneForUser`; cross-tenant CUSTOMER JWT (no customer row) → 403 | cron at 06:00 and a manual `generate` racing — pre-existing, untouched                                                                                                                                                              | template deleted → 404 before ownership (pre-existing 404/403 distinction — out of scope)                                                                                                                                                |
| inventory writes (R7)                  | —                                                                                            | DRIVER → 403 on all four; operators/tenant admins (incl. `canActAsDriver`) unchanged                                                               | —                                                                                                                                                                                                                                   | —                                                                                                                                                                                                                                        |
| `JwtStrategy`/`BuyerJwtStrategy` (R8)  | claim absent → `impersonatedBy: undefined`, never `null`/`""`                                | invalid token → 401 (unchanged)                                                                                                                    | —                                                                                                                                                                                                                                   | an impersonation token minted BEFORE deploy already carries the claim → propagated the moment the API restarts (≤ 15 min window)                                                                                                         |
| `AuditInterceptor`/`AuditService` (R9) | plain user → `impersonatedBy: null`; anonymous mutation → `userId null, impersonatedBy null` | —                                                                                                                                                  | fire-and-forget `setImmediate`; the request never waits                                                                                                                                                                             | column missing → create throws → swallowed (existing) — hence R17                                                                                                                                                                        |
| `ImpersonationGuard` (R10)             | no `Authorization` → `true`, no log                                                          | malformed JWT → `true`, no log (JwtAuthGuard rejects downstream)                                                                                   | —                                                                                                                                                                                                                                   | expired token → still logs the write attempt (JwtAuthGuard 401s it; log line is harmless)                                                                                                                                                |
| `POST /auth/logout` (R11)              | —                                                                                            | expired impersonation token → 401 from `JwtAuthGuard`, nothing revoked                                                                             | super-admin logs out on two tabs → both no-ops                                                                                                                                                                                      | a browser still running the PRE-deploy web bundle POSTs `/auth/logout` with an impersonation token → the API half now refuses to revoke — this is why R11 exists alongside R12                                                           |
| Header sign-out slot (R12)             | no impersonation → "Sign out" exactly as today                                               | —                                                                                                                                                  | another tab clears impersonation → `storage` event → this tab re-renders "Sign out" (`subscribeImpersonation` is key-filtered)                                                                                                      | expired impersonation → "Return to admin" (never "Sign out"); `api-client` auto-exits on the next request regardless                                                                                                                     |
| `POST /auth/refresh` (R13)             | no cookie and no body → 401 (unchanged)                                                      | unknown/revoked hash → 401; wrong realm → 401; inactive user → token consumed then 401                                                             | two refreshes of one token: winner `count 1` rotates in place; loser `count 0` → fallback create → BOTH succeed (today's semantics); a refresh that starts after the winner committed → `findUnique` miss → 401 (today's semantics) | rows created pre-deploy rotate in place from their next refresh; their `createdAt` stays the last pre-deploy rotation (unrepairable — the original login time is gone)                                                                   |
| Active Sessions card (R14)             | zero rows → "No active sessions found." (unchanged)                                          | 401 on list → toast "Failed to load sessions" (unchanged)                                                                                          | user revokes on device A while device B refreshes: B's row id is stable → A's revoke lands                                                                                                                                          | revoke of a row already gone → 403 → list reloads, row absent, error toast; revoke-all with one failure → honest error toast + reload                                                                                                    |

## 3. Deploy day — users and data that already exist

No migration. No backfill. No new entitlement, flag or SKU — nothing to grant, so L-016's
"who grants it?" question has no subject. Behaviour changes the moment the API container restarts
and the web bundle swaps; announce each in the PR:

- **DRIVER-role accounts (R3, R5, R7).** A true `role: DRIVER` account hitting any of the nine
  writes (`POST customers/:id/prices`; order-templates `create/update/addItem/removeItem`;
  inventory `movements/purchase`, `movements/adjustment`, `purchase-orders`, `purchase-orders/:id/receive`)
  receives **403 "Forbidden resource"** (Nest's `RolesGuard` false). What that driver sees: the
  shipped driver app has no screen that issues these calls (verified: `(driver)` directory
  contents; the mobile hooks `lib/api/order-templates.ts`, `lib/api/inventory.ts`,
  `lib/api/purchase-orders.ts` are imported only by `(operator)` screens), and the web customer
  page gates the price surface on `isOperator` — so **no shipped UI path changes for a driver**.
  An in-flight request racing the restart gets a 403 instead of a 201; nothing partial is written
  (the guard runs before the handler). Operators and tenant admins, including `canActAsDriver`
  ones, are unaffected (`ROLE_SATISFIES` keeps OPERATOR). **Owner pre-deploy check (read-only):**
  count prod users with `role = 'DRIVER'` per tenant and confirm none is a human who has been
  using the operator web UI under a DRIVER account — such a person would lose these four surfaces
  and needs an OPERATOR (or `canActAsDriver`) account instead. If any exists, re-role BEFORE deploy.
- **Supplier-statement files (R1).** Every existing `supplier-statements/<scanId>/…` file becomes
  readable on the JWT path only by the scan's own tenant. Scans with `tenantId IS NULL` (the model
  allows it; the writer injects it via `forTenant().create`, but legacy rows may predate that)
  become unreadable by bearer for everyone except SUPER_ADMIN — fail closed, by design; a signed
  URL still serves them. **Owner pre-deploy check (read-only):**
  `SELECT count(*) FROM "SupplierStatementScan" WHERE "tenantId" IS NULL AND "fileKey" IS NOT NULL`
  — if > 0, decide whether to backfill `tenantId` from the parent supplier BEFORE deploy (D4 owner
  work, not this batch) or accept the deny.
- **Default-deny (R2).** Any file on the Railway volume under a prefix outside the 11 live ones
  403s for bearer callers. None is written by the code at `39632d27`; a stray legacy directory
  would surface as a 403 in the API log with the requested key — that is the signal, not an
  outage. Web JWT-path fetches (`lib/fetch-pdf-blob.ts`) hit only `invoice-pdfs/` and
  `statement-pdfs/` (both mapped); `<img>` and portal loads use signed URLs. Post-deploy smoke
  must include one bearer PDF fetch (`invoice-pdfs/`) and one signed image load.
- **Existing refresh tokens (R13).** No shape change; every row already there keeps working. From
  its next refresh a row rotates in place and its `id` becomes stable; its `createdAt` remains
  whatever the last pre-deploy rotation wrote — "Signed in" for sessions that predate the deploy
  is cosmetic-wrong until the user next logs in, and **no backfill can fix it** (the original
  login time was destroyed by the old code — record as unrepairable, D4). Mobile refresh (body
  token) is unchanged. Active Sessions becomes stable from the first post-deploy refresh.
- **Existing impersonation sessions (R8, R11, R12).** Tokens minted before deploy already carry
  `impersonatedBy` (the minting side never dropped it) and expire within 15 minutes; the new
  strategy propagates the claim for them immediately. A super-admin mid-impersonation on the OLD
  web bundle still sees "Sign out" until the tab reloads; if clicked, the NEW API refuses to
  revoke (R11) — the two halves cover each other across the bundle swap.
- **Audit rows written before deploy (R9)** under impersonation stay attributed to the tenant
  admin alone; **unidentifiable, unrepairable** (nothing recorded who acted). Recorded as D4
  residue, not repaired.
- **Rollback story.** One squash commit, `git revert` it; **no data shape changed**, so old code
  reads every row the new code wrote: sessions rotated in place are ordinary rows found by
  `tokenHash`; fallback-created rows are ordinary rows; `AuditLog.impersonatedBy` values are
  ignored by old readers. Reverting re-opens every bug (B52 cross-tenant read included) — a
  rollback is a security regression and must be followed by a re-land, not left standing.
- **Order inside the batch** (card + SEQUENCE §2): B52 → B165 → B138 → B155 → B168 → B132 → B133
  (B133 last: the F13 collision). R8 is edited once and precedes R11.

## 4. Non-goals — the scope fence (L-008: surface, do not build)

Sibling findings the card names that must NOT ride along; each is recorded for the register
(B212+ ids allocated by the lead before any `REG-` title is written — SEQUENCE §4):

1. **DRIVER reads** — `GET /customers/:id/prices`, `GET /customers/:id`, inventory
   `overview/movements/purchase-orders(/:id)`, order-templates `findAll/findOne` (a DRIVER can
   still LIST every standing order — residual, recorded).
2. **CUSTOMER self-service `addItem`** on order templates — owner decision, flagged not decided.
3. **`POST /auth/change-password` and `DELETE /auth/sessions/:id` under impersonation** act on the
   tenant admin's account (`auth.service.ts:564, :352`) — same class as B138, deliberate actions,
   owner to rule.
4. **Buyer-realm logout under buyer impersonation** (`buyer-admin.service.ts:115-120` mints the
   claim) — only the buyer STRATEGY whitelist is in scope (R8); no buyer logout change.
5. **`api-client.ts` auto-exit / tenant-cookie behaviour** — B173 / F29.
6. **Admin-UI "via" column** for `AuditLog.impersonatedBy`; any "this device" marker or
   `sessionId` column in Active Sessions (in-place rotation needs none).
7. **DTO hardening** — `createPO(@Body() dto: any)`, `receivePO(dto: any)`,
   `record-adjustment.dto.ts` reason/bounds.
8. **`bookkeeping/invoice.service.ts` `invoices/` S3 path** — not served by this controller.
9. **Deleting the `APP_GUARD` `ImpersonationGuard`** and moving the log into the interceptor —
   acceptable alternative the lead may prefer; not chosen here (R10 explains why).
10. **The 22 other DRIVER-admitted mutations** (routes, at-door orders, returns, drafts, payment
    images — v1 discovery's census) — legitimate driver work, unchanged.
11. **A repo-wide authorization-matrix snapshot spec** (v1's R14: 64 controllers / 643 routes
    against a checked-in table) — a guardrail feature, its own PR; and a checked-in expected table
    is a snapshot test in all but name, which `CLAUDE.md` forbids. `[v1 diff]`
12. **`tenant-status.guard.ts`** — no edit; R10 makes its comment true.
13. **Mobile** — nothing. **Migrations** — none (F01 shipped every column; SEQUENCE §5).
14. **Repo-wide gates** (`npm run verify`, `validate-lessons`, `campaign-check`) run in the close-out.

## 5. Files (the whole change surface)

- api: `uploads/uploads.controller.ts` · `customers/customers.controller.ts` ·
  `customers/customers.service.ts` · `order-templates/order-templates.controller.ts` ·
  `order-templates/order-templates.service.ts` · `inventory/inventory.controller.ts` ·
  `auth/strategies/jwt.strategy.ts` · `buyer/strategies/buyer-jwt.strategy.ts` ·
  `auth/guards/impersonation.guard.ts` · `audit/audit.interceptor.ts` · `audit/audit.service.ts` ·
  `auth/auth.controller.ts` · `auth/auth.service.ts`
- api specs — extended: `uploads/uploads-tenant-scope.security.spec.ts`,
  `uploads/uploads-xss.security.spec.ts` (stub only), `customers/customers.controller.roles.spec.ts`,
  `customers/customers.service.spec.ts`, `order-templates/order-templates.service.spec.ts`,
  `audit/audit.interceptor.security.spec.ts`, `auth/auth.controller.cookie.spec.ts`,
  `auth/auth.service.spec.ts`; — new: `order-templates/order-templates.controller.roles.spec.ts`,
  `inventory/inventory.controller.roles.spec.ts`, `auth/strategies/jwt.strategy.spec.ts`,
  `auth/guards/impersonation.guard.spec.ts`, `audit/audit.service.spec.ts` (if none exists)
- web: `app/(dashboard)/layout.tsx` · `lib/impersonation.ts` · `lib/i18n/messages.ts` ·
  `app/(dashboard)/settings/page.tsx` · `e2e/31-impersonation-signout.spec.ts` (new) ·
  `e2e/32-active-sessions.spec.ts` (new) · `e2e/helpers/constants.ts` · `playwright.config.ts`
- scripts: `apps/api/scripts/e2e-seed.js`
- close-out: `.claude/lessons/LESSONS.md` (**L-044**, from `_meta.json.nextId`, never inferred
  from a gap) + `_meta.json` · `.claude/code-map/api.md`, `web.md`, `_meta.json` ·
  `.claude/campaign/status/F14.jsonl`

## 6. Lessons carried into this plan

L-008 (scope fence, §4; commit title names api+web) · L-026 (every file claim re-read; the
`customers.service.spec.ts:1222` inversion and the `uploads-xss` stub are the corrections) ·
L-029/L-031 (enumerate every path to the state: 14 upload sites, 6 RefreshToken writers, every
DRIVER grant on each controller) · L-030 (one decision, one place: `exitImpersonation()` is the
single copy; no second guard in `auth.ts`) · L-035 (the `AuditLog.impersonatedBy` comment is the
spec) · L-037 (R13 enumerates every column the rotation writes and why) · L-041 (T2 discharge
reads STEP conclusions; a skipped spec 31 proves nothing) · L-039 (the register has headroom
after #594 — `nextId` 42, L-044 pre-allocated; still read `validate-lessons` `binding:` before
appending).
