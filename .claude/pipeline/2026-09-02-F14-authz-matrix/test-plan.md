# Test plan — F14 v2: authorization / tenancy matrix

**Status:** DRAFT for the lead · companion to [spec.md](./spec.md) · branch `fix/F14-authz-matrix-v2`.
Tier split is frozen in `.claude/campaign/status/F14.jsonl`: **B52 B132 B133 B165 B168 = T1**
(jest in `apps/api`); **B138 B155 = T2** (Playwright specs **31** and **32**, discharged
POST-deploy — D1: `apps/web` has no unit runner). Every proof title carries the exact token
`REG-B<id>` (campaign-check matches `/REG-B(\d{2,3})(?![0-9])/` — `REG-B52` is not satisfied by
`REG-B520`). Every test must go RED when its named mutation is applied; every R# maps to ≥ 1 T#;
every T# names its R#.

Conventions (CLAUDE.md): `Test.createTestingModule`, mock at the module boundary,
`createMockPrisma()` from `apps/api/src/testing/prisma-mock.ts` (defaults: `findUnique → null`,
`updateMany → { count: 0 }`, `deleteMany → { count: 0 }`, `upsert → {}`), supertest for HTTP-shaped
uploads specs, class-validator DTOs. **No snapshot tests, no Vitest.** Prettier: semicolons,
double quotes, printWidth 100. **Never run Playwright locally — not even `--list`** (it overwrites
`.campaign/runs/web-e2e.json`); e2e specs are typechecked only and run from the deploy signal.
Force jest execution when reading the campaign artefact (`npx jest` direct or `turbo run test --force`,
L-034) — a cache replay is not a run.

**Oracle discipline.** Every expected value below is derivable WITHOUT reading the implementation:
from the HTTP contract (403/200/401), from the `RolesGuard` resolution algorithm
(`getAllAndOverride(handler, class)`), from `node:crypto` (`sha256` of a known token), from a JWT
we build ourselves, or from a server-side count taken before and after through an independent
token. Where a test could pass without exercising the fix, the **Vacuity** line says what stops it.

---

## A. T1 — jest, `apps/api`

### T1 · `REG-B52` cross-tenant supplier-statement read is refused — R1

- **Level:** integration (supertest, `uploads-tenant-scope.security.spec.ts` harness `:70-160`:
  `overrideGuard(UploadsAccessGuard)` sets `req.user` from `x-test-tenant`/`x-test-role`).
- **Setup:** `prismaMock.supplierStatementScan = { findUnique: jest.fn(({ where: { id } }) => Promise.resolve(scans[id] ?? null)) }`
  with `scans = { ss1: { tenantId: "t1" }, ssNull: { tenantId: null } }`;
  `write("supplier-statements/ss1/1.txt")`, `write("supplier-statements/missing/1.txt")`,
  `write("supplier-statements/ssNull/1.txt")` in `beforeAll`.
- **Given** a JWT caller `tenantId: t2, role: OPERATOR` · **When** `GET /uploads/supplier-statements/ss1/1.txt`
  · **Then** 403, body message `"Cross-tenant file access denied"`, and `supplierStatementScan.findUnique`
  was called with `{ where: { id: "ss1" }, select: { tenantId: true } }`.
- **Oracle:** the HTTP contract every other owner-gated prefix in this same file already asserts
  (403 for `t2` on `products/p1/…`); the lookup shape is the `select`-only contract the header
  comment states. Independent of the controller's code.
- **Mutation → red:** delete the `"supplier-statements"` entry from `OWNER_LOOKUPS`. With R2 in
  place this test STAYS green (the default-deny 403s it) — so T1 alone is not proof of R1; **T2 is
  the discriminating half** (see below). Both mutations must be run: (i) entry removed → T2 red;
  (ii) entry removed AND default-deny removed → T1 red.
- **Vacuity:** a 403 from the default-deny is indistinguishable here. Stopped by asserting the
  `findUnique` call (a default-deny never touches Prisma) — with the entry removed and the deny in
  place, the call assertion fails.

### T2 · `REG-B52` the owning tenant still reads its scan — R1

- **Level:** integration (same harness).
- **Given** caller `tenantId: t1` · **When** `GET /uploads/supplier-statements/ss1/1.txt` · **Then** 200
  and the body is the written bytes.
- **Oracle:** the fixture's own `tenantId` equals the caller's; 200 is what the same harness
  asserts for `products/p1` from `t1`.
- **Mutation → red:** remove the `OWNER_LOOKUPS` entry (default-deny then 403s the owner).
- **Vacuity:** none — a 200 requires the lookup to resolve AND match.

### T3 · `REG-B52` missing or NULL-tenant scan row fails closed — R1

- **Level:** integration (same harness).
- **Given** caller `t1` · **When** `GET …/supplier-statements/missing/1.txt` and
  `GET …/supplier-statements/ssNull/1.txt` · **Then** both 403 (never 404 — the file exists on disk
  and must not be disclosed).
- **Oracle:** fail-closed rule already pinned for `products/missing/…` and `expenses/eOrphan/…`
  in this file; the disk fixture exists, so a 404 would prove the deny ran AFTER the fs check.
- **Mutation → red:** in the owner branch change `if (!owner || …)` to `if (owner && …)`.
- **Vacuity:** the `ssNull` case can pass via `owner.tenantId !== caller.tenantId` (`null !== "t1"`)
  even if the explicit null check is dropped — that is fine; the requirement is the 403, not the
  branch.

### T4 · `REG-B52` SUPER_ADMIN reads any prefix, mapped or not — R1, R2

- **Level:** integration (same harness).
- **Given** `x-test-role: SUPER_ADMIN`, `x-test-tenant` absent · **When** `GET …/supplier-statements/ss1/1.txt`
  and `GET /uploads/legacy-prefix/x/file.txt` · **Then** both 200.
- **Oracle:** the exemption the header comment and every existing SUPER_ADMIN test in the file
  state.
- **Mutation → red:** drop `caller?.role !== "SUPER_ADMIN"` from the new default-deny condition.
- **Vacuity:** none.

### T5 · `REG-B52` unmapped prefixes and flat keys are denied on the JWT path, before the filesystem, and only there — R2

- **Level:** integration (same harness; `write("legacy-prefix/x/file.txt")`, `write("flat.txt")`).
- **Given** caller `t1, OPERATOR` · **When**
  (a) `GET /uploads/legacy-prefix/x/file.txt` → **403**;
  (b) `GET /uploads/flat.txt` → **403**;
  (c) `GET /uploads/legacy-prefix/nope/absent.txt` (NOT written) → **403, not 404**;
  (d) the same (a) key with `x-test-signed: 1` (the harness's signed-URL simulation) → **200**;
  (e) `jest.spyOn(fs, "existsSync")` reset before (a): after (a) the spy was **not called**.
- **Oracle:** (a)–(c) the fail-closed rule stated in R2; (c) and (e) are the "deny precedes
  existence check" contract, derivable from the disclosure requirement alone; (d) the signed-URL
  exemption already asserted for `products/` in this file.
- **Mutation → red:** (i) delete the default-deny block → (a)(b) 200, (c) 404; (ii) move the block
  after `fs.existsSync` → (c) 404 and (e) fails; (iii) drop the `!reqAny.signedUrlAuthorized`
  wrap → (d) 403.
- **Vacuity:** (e) is vacuous if the spy is installed after the request — install in `beforeEach`,
  assert call count 0 for (a), and add a positive control: T2's 200 path shows `existsSync` called
  once (proves the spy works).
- **Collateral pins to keep green:** `uploads-xss.security.spec.ts` guard stub gains
  `req.signedUrlAuthorized = true` (spec §R2); its header assertions are unchanged and re-run.
  `uploads-signed-url.security.spec.ts:204` "rejects a missing signature" expects 4xx — 403 fits.

### T6 · `REG-B52` every live prefix is reachable by its owner (coverage table) — R1, R2

- **Level:** integration (same harness).
- **Given** the 11 prefixes from the sweep (`expenses, statement-pdfs, customers, invoice-pdfs, payments, products, supplier-statements, tenants, invoice-scans, regulated-filings, tobacco-reports`)
  each with a `t1`-owned fixture (10 already exist in the file; `supplier-statements/ss1` is the
  11th) · **When** `GET` each as `t1` · **Then** 200 for all 11 — table-driven `it.each`.
- **Oracle:** the sweep list itself, produced by `grep storage.upload(` + key templates at
  `39632d27` and recorded in spec §R2 — a source-of-truth OUTSIDE the controller.
- **Mutation → red:** remove any single owner lookup or regex alternative → that row 403s.
- **Vacuity:** the list must be a literal in the test, not derived from `OWNER_LOOKUPS` (private
  anyway). If a future prefix is added to `StorageService` callers without a gate, this test does
  not catch it by itself — that gap is what R2's default-deny converts from a leak into a 403.

### T7 · `REG-B132` `upsertCustomerPrice` declares the same roles as its DELETE sibling and no DRIVER — R3

- **Level:** unit (reflection; `customers.controller.roles.spec.ts` pattern `:9-12`).
- **Given** `const r = new Reflector()` · **When**
  `post = r.get<UserRole[]>(ROLES_KEY, CustomersController.prototype.upsertCustomerPrice)`,
  `del = r.get(ROLES_KEY, CustomersController.prototype.deleteCustomerPrice)` · **Then**
  `Array.isArray(post) && post.length > 0`, `post` does not contain `UserRole.DRIVER`, and
  `[...post].sort()` equals `[...del].sort()`.
- **Oracle:** the DELETE sibling's decorator, already OPERATOR-only, is the reference — the test
  asserts symmetry with a route this batch does not touch.
- **Mutation → red:** restore `UserRole.DRIVER` on the POST decorator.
- **Vacuity:** if a handler is renamed both `get()`s return `undefined` and `toEqual` passes
  vacuously — stopped by the explicit non-empty-array assertion and by
  `expect(typeof proto.upsertCustomerPrice).toBe("function")`.

### T8 · `REG-B132` the service refuses a DRIVER before any read; operators unaffected — R4

- **Level:** unit (`customers.service.spec.ts` describe `upsertCustomerPrice` `:1171`,
  `createMockPrisma`; payloads `operatorPayload`, `driverPayload` already defined there).
- **Given** `prisma.customerPrice.findUnique.mockResolvedValue({ id: "cp-1", pricingTier: 3, msrp: 5 })`
  · **When** `service.upsertCustomerPrice("cust-1", { productId: "p1", pricingTier: "WHOLESALE" }, driverPayload)`
  · **Then** rejects `ForbiddenException`; `prisma.forTenant().customerPrice.findUnique` and
  `.upsert` were **never called**; the MSRP entitlement helper was not consulted (spy on
  `assertMsrpAllowed` when `msrp` is in the DTO). Pins: `operatorPayload` still resolves and calls
  `upsert` with `update: { pricingTier: "WHOLESALE", msrp: 5 }`; a `TENANT_ADMIN` payload resolves;
  `user` `undefined` → `ForbiddenException` (compile-time this is a type error once `user` is
  required — cast in the test).
- **Existing pin `:1222` "a DRIVER may still null the tier on a row that keeps its MSRP" is
  INVERTED** to `rejects.toThrow(ForbiddenException)` + `upsert not called` and retitled with the
  `REG-B132` token. It encoded the bug.
- **Oracle:** the role set `{OPERATOR, TENANT_ADMIN, SUPER_ADMIN}` is the DELETE route's
  effective set under `ROLE_SATISFIES` — a contract from `roles.guard.ts`, not from the service.
  "Never called" is observable on the mock.
- **Mutation → red:** (i) delete the hoisted check → DRIVER reaches `upsert`; (ii) move it below
  `findUnique` → the "never called" assertion fails while the throw still happens.
- **Vacuity:** a `rejects.toThrow` would also pass on a `BadRequestException` — assert the class
  AND the message prefix `Only operators`.

### T9 · `REG-B133` every order-template mutation declares roles and none admits DRIVER — R5

- **Level:** unit (reflection; NEW `order-templates.controller.roles.spec.ts` modelled on the
  customers one).
- **Given** handlers `create, update, remove, addItem, removeItem, generateOrder` · **When**
  `Reflector.get(ROLES_KEY, OrderTemplatesController.prototype[h])` for each · **Then** each is a
  non-empty array with no `UserRole.DRIVER`; additionally `create/update/remove/removeItem/generateOrder`
  each contain `OPERATOR` and `CUSTOMER`, and `addItem` equals `[OPERATOR]` (spec §R5 matrix).
  Pin: `findAll`/`findOne` have NO `@Roles` (records the residual so a later change is deliberate).
- **Oracle:** the target matrix written in spec §R5 — derived from the DELETE/generate siblings
  that already exclude DRIVER, i.e. from decorators this batch does not edit.
- **Mutation → red:** restore DRIVER on any one of the four.
- **Vacuity:** same guard as T7 — assert `typeof proto[h] === "function"` and non-empty arrays.

### T10 · `REG-B133` the controller routes `addItem` through the ownership wrapper — R6

- **Level:** unit (controller instance with a stub service).
- **Given** `svc = { addItemForUser: jest.fn().mockResolvedValue("ok"), addItem: jest.fn() }`,
  `ctrl = new OrderTemplatesController(svc as any)` · **When**
  `await ctrl.addItem("t1", { productId: "p1", qty: 2 } as any, { sub: "u1", role: "OPERATOR" } as any)`
  · **Then** `svc.addItemForUser` called with `("t1", dto, user)`; `svc.addItem` **not** called;
  return value `"ok"`.
- **Oracle:** the delegation contract `removeItem → removeItemForUser` already in the same
  controller (`:73-82`) — symmetry with an untouched sibling.
- **Mutation → red:** revert the handler to `this.service.addItem(templateId, dto)`.
- **Vacuity:** none (a direct call assertion).

### T11 · `REG-B133` `addItemForUser` rejects a non-owning CUSTOMER and never creates — R6

- **Level:** unit (`order-templates.service.spec.ts` describe "template ownership (F2-003)" `:142`,
  `createMockPrisma`; fixtures `template` (owner `c-owner`), `asCustomer`, `asOperator`).
- **Given** `prisma.customer.findFirst.mockResolvedValue({ id: "c-attacker" })`,
  `prisma.product.findUnique.mockResolvedValue({ id: "p1" })` · **When**
  `service.addItemForUser("t1", { productId: "p1", qty: 1 }, asCustomer("u-attacker"))` · **Then**
  rejects `ForbiddenException`; `prisma.orderTemplateItem.create` **not called**. Pins: owner
  (`{ id: "c-owner" }`) resolves and `create` is called with `data: { templateId: "t1", productId: "p1", qty: 1, … }`;
  `asOperator` resolves without consulting `customer.findFirst`; a CUSTOMER with no customer row
  (`null`) → `ForbiddenException`.
- **Oracle:** the four sibling tests for `removeItemForUser` in the same describe — identical
  contract on an untouched method.
- **Mutation → red:** delete the wrapper (compile error = red) or make it skip `findOneForUser`
  (create is called for the attacker).
- **Vacuity:** the operator pin must assert `customer.findFirst` NOT called, or an implementation
  that always checks ownership would still pass — acceptable, but the pin exists to lock the
  current "staff manage all" semantics.

### T12 · `REG-B168` all seven inventory writes resolve to `[OPERATOR]` exactly as `RolesGuard` sees them — R7

- **Level:** unit (reflection; NEW `inventory.controller.roles.spec.ts`).
- **Given** `r = new Reflector()` · **When**
  `r.getAllAndOverride<UserRole[]>(ROLES_KEY, [InventoryController.prototype[h], InventoryController])`
  for `h ∈ {recordPurchase, recordAdjustment, createPO, receivePO, commitStockCount, sendPO, closePO}`
  · **Then** each equals `[UserRole.OPERATOR]` (no DRIVER).
- **Oracle:** `getAllAndOverride([handler, class])` is the exact resolution `roles.guard.ts:31-34`
  performs, and the class decorator `@Roles(UserRole.OPERATOR)` at `:41` is untouched — the
  expected value comes from the class, not from the edited lines. `sendPO`/`closePO` are the
  already-correct controls (never had a handler decorator).
- **Mutation → red:** restore `@Roles(OPERATOR, DRIVER)` on any of the four writes.
- **Vacuity:** `typeof proto[h] === "function"` guard; and the array must be `toEqual([OPERATOR])`,
  not `toContain` (a `[OPERATOR, DRIVER]` would pass `toContain`).

### T13 · `REG-B168` the four inventory reads still admit DRIVER (over-reach pin) — R7

- **Level:** unit (same spec).
- **Given/When** as T12 for `getStockOverview, listMovements, listPOs, getPO` · **Then** each
  contains `UserRole.DRIVER` and `UserRole.OPERATOR`.
- **Oracle:** spec §R7 states reads are out of scope; the decorators at `:45-53`, `:177-185` are
  the reference and are not edited.
- **Mutation → red:** removing DRIVER from any read — this pins the FENCE, so it goes red on
  scope creep, not on the fix.
- **Vacuity:** none.

### T14 · `REG-B165 / REG-B138` both strategies pass `impersonatedBy` through, and only when present — R8

- **Level:** unit (NEW `jwt.strategy.spec.ts`; `new JwtStrategy({ get: () => ({ secret: "s" }) } as any)`
  and `new BuyerJwtStrategy(...)`).
- **Given** payload `{ sub: "u1", username: "a", role: "TENANT_ADMIN", status: "ACTIVE", tenantId: "t1", impersonatedBy: "sa1" }`
  · **When** `await strategy.validate(payload)` · **Then** result `impersonatedBy === "sa1"`, and
  `sub/id/role/tenantId` still present. **Given** the same payload without the claim · **Then**
  `result.impersonatedBy === undefined` and `"impersonatedBy" in result` is false OR the value is
  strictly `undefined` (never `null`/`""`). Same two cases for `BuyerJwtStrategy` with
  `{ sub: "b1", email: "b@x", type: "BUYER", impersonatedBy: "sa1" }`. Pin: `isAdmin` is NOT in the
  staff result (the #491 exclusion stays).
- **Oracle:** the claim is minted by `platform-admin.service.ts:592` / `buyer-admin.service.ts:120`
  with that exact name; the interface `jwt-payload.interface.ts:21` types it. A value we put in
  must come out unchanged — reflexive, implementation-independent.
- **Mutation → red:** remove the whitelist line → `impersonatedBy` undefined in case 1.
- **Vacuity:** case 2 alone passes on the unfixed code — it is a pin, never the proof; the file's
  two `it`s must be read together (name them so).

### T15 · `REG-B165` the audit interceptor forwards `impersonatedBy` from `req.user` — R9

- **Level:** unit (`audit.interceptor.security.spec.ts` `makeCtx` harness `:11-12`).
- **Given** `req = { method: "POST", url: "/api/v1/orders", ip: "203.0.113.9", headers: {}, socket: {}, user: { sub: "u1", tenantId: "t1", impersonatedBy: "sa1" } }`
  · **When** `interceptor.intercept(makeCtx(req), next)` then `await new Promise(r => setImmediate(r))`
  · **Then** `auditService.log` called with `expect.objectContaining({ userId: "u1", tenantId: "t1", impersonatedBy: "sa1" })`.
  **Given** `user: { sub: "u1", tenantId: "t1" }` · **Then** called with `impersonatedBy: null`.
- **Oracle:** `req.user` is the verified strategy output (T14); the DTO field name is the schema
  column name (`schema.prisma:3327`) — the expected shape is fixed by the column, not the code.
- **Mutation → red:** revert the interceptor's `log({...})` to omit the field →
  `objectContaining({ impersonatedBy: "sa1" })` fails.
- **Vacuity:** the fire-and-forget `setImmediate` — assert only AFTER flushing, and use positive
  `toHaveBeenCalledWith` (a `not.toHaveBeenCalledWith` before the flush is always green).

### T16 · `REG-B165` `AuditService.log` writes `impersonatedBy` into the row — R9

- **Level:** unit (`audit.service.spec.ts` — new if absent; `createMockPrisma`).
- **Given** `prisma.auditLog.create.mockResolvedValue({})` · **When**
  `await service.log({ tenantId: "t1", userId: "u1", action: "POST /orders", entityType: "orders", impersonatedBy: "sa1" })`
  · **Then** `create` called with `data: expect.objectContaining({ impersonatedBy: "sa1" })`;
  without the field → `data.impersonatedBy === null`. Pin: `create` rejecting → `log` resolves
  (never throws).
- **Oracle:** the Prisma column exists and is nullable — `null` is its documented absent value.
- **Mutation → red:** drop `impersonatedBy` from the `create` data.
- **Vacuity:** none.

### T17 · `REG-B165` `ImpersonationGuard` logs impersonated writes from the header claim, before `req.user` exists — R10

- **Level:** unit (NEW `impersonation.guard.spec.ts`; token built as `tenant-status.guard.spec.ts:5`:
  `` `h.${Buffer.from(JSON.stringify({ sub: "ta1", tenantId: "t1", impersonatedBy: "sa1" })).toString("base64url")}.s` ``;
  `jest.spyOn(Logger.prototype, "log")`).
- **Given** `req = { headers: { authorization: "Bearer <token>" }, method: "POST", url: "/api/v1/orders?x=1" }`
  **with `req.user` undefined** (exactly as production, `APP_GUARD` runs before `JwtAuthGuard`)
  · **When** `guard.canActivate(ctx)` · **Then** returns `true` AND the log spy received a string
  containing `admin=sa1`, `acting-as=ta1`, `tenant=t1`, `POST /api/v1/orders` (query stripped).
  Cases: `GET` with the claim → `true`, no log; no `authorization` header → `true`, no log;
  malformed token `Bearer not.a.jwt` → `true`, no log, no throw; token without the claim → no log;
  `req.user = { impersonatedBy: "sa1", sub: "ta1", tenantId: "t1" }` and NO header → still logs
  (the `req.user` path is kept for a future ordering).
- **Oracle:** the JWT is constructed by the test with `node:buffer` — the expected `admin/acting-as/tenant`
  values are ours; "never blocks" is the guard's docblock contract and `platform-admin.service.ts:566-569`.
- **Mutation → red:** revert the guard to read only `request.user` → the header case never logs
  (the harness never sets `req.user`, exactly like production).
- **Vacuity:** the `not.toHaveBeenCalled` cases are green on any no-op — the header POST case is
  the proof; keep it first in the file and name the others "pin".

### T18 · `REG-B138` `POST /auth/logout` under impersonation clears the cookie and revokes nothing — R11

- **Level:** unit (`auth.controller.cookie.spec.ts` `makeController`/`makeRes` harness `:10-20`).
- **Given** `authService = { logout: jest.fn().mockResolvedValue({ message: "Logged out successfully" }) }`
  · **When** `await controller.logout({ id: "u1", impersonatedBy: "sa1" } as any, res)` · **Then**
  `res.clearCookie` called with `"rf_refresh"` (existing options) and `authService.logout`
  **not called**; result `{ message: "Impersonation session ended" }`. Pin:
  `controller.logout({ id: "u1" } as any, res)` → `authService.logout("u1")` called once.
- **Oracle:** `@CurrentUser()` returns `req.user` whole (`current-user.decorator.ts`), so the
  shape we pass IS the strategy output shape from T14 — the two tests compose without a live
  request. "Not called" is observable on the stub.
- **Mutation → red:** remove the `impersonatedBy` branch → `logout` called in case 1.
- **Vacuity:** none.

### T19 · `REG-B155` refresh rotates the row in place, keeps identity, tolerates the race, still consumes an inactive user's token — R13

- **Level:** unit (`auth.service.spec.ts` describe `refresh` `:280`; `createMockPrisma`,
  `jwtService.sign` mocked to return `"mock-token"`, `jwtService.verify → { sub: "user-1" }`).
- **Given** `prisma.refreshToken.findUnique.mockResolvedValue({ id: "rt-1", userId: "user-1", tokenHash: "h-old", expiresAt: future, createdAt: T0, userAgent: null, ipAddress: null, deviceName: null })`,
  `prisma.user.findUnique → MOCK_USER`, `prisma.tenant.findUnique → { slug }`,
  `prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 })` · **When**
  `await service.refresh("incoming-token")` · **Then**
  `updateMany` called once with `where: { id: "rt-1", tokenHash: "h-old" }` and
  `data.tokenHash === createHash("sha256").update("mock-token").digest("hex")`,
  `data.lastUsedAt` a Date, `data.expiresAt` a Date; `data` has **no** `id`, `createdAt`, `userId`,
  `tenantId` keys; `refreshToken.upsert` **not called**; `refreshToken.deleteMany` **not called**.
  With `deviceInfo` omitted, `data.userAgent/ipAddress/deviceName` are `undefined` (never `null`).
  **Race pin:** `updateMany.mockResolvedValue({ count: 0 })` → `upsert` (the `storeRefreshToken`
  create) IS called once and `refresh` resolves with tokens. **Inactive pin:**
  `prisma.user.findUnique → { ...MOCK_USER, status: "SUSPENDED" }` → rejects `UnauthorizedException`
  and `refreshToken.deleteMany({ where: { tokenHash: "h-old" } })` was called (token consumed);
  `updateMany` not called.
- **Oracle:** the new hash is computed in the test with `node:crypto` from the mocked token —
  independent of `hashToken`; the `where` must name the stored row's `id` (identity) AND the old
  hash (compare-and-swap) — both are values the test supplied; "no `id`/`createdAt` in `data`" is
  the identity-preservation contract stated by the bug (revoke-by-listed-id works iff `id` is
  stable).
- **Mutation → red:** (i) restore `deleteMany` + `storeRefreshToken` → `updateMany` never called;
  (ii) drop the `count === 0` fallback → race pin: `upsert` not called; (iii) delete the
  inactive-branch `deleteMany` → inactive pin red; (iv) write `createdAt: new Date()` in `data` →
  the key-absence assertion fails.
- **Vacuity:** `prisma-mock` defaults `updateMany → { count: 0 }`, so a happy-path test that forgets
  to set `count: 1` silently exercises the FALLBACK and passes an `upsert`-called assertion for
  the wrong reason. Set `count` explicitly in every case and assert `upsert` NOT called on the
  happy path.

---

## B. T2 — Playwright, discharged post-deploy (specs 31 and 32)

Both specs: own `playwright.config.ts` project, **no shared `storageState`**, `retries: 2`
inherited, API origin via `apiBase(baseURL)` (`e2e/helpers/api.ts`). Titles carry the token.
Discharge = the deploy-signal run's e2e STEP conclusion `success` AND the test's `✓` line in the
log (L-041); `skipped` or a green job with skipped steps proves nothing. Neither spec touches a
live client tenant: 31 targets `e2e-routeflow` by slug; 32 logs in as the seed operator.

### T21 · spec 31 `REG-B138` signing out while impersonating ends the impersonation and revokes none of the tenant admin's sessions — R12, R11, R15, R16

- **Level:** e2e (`apps/web/e2e/31-impersonation-signout.spec.ts`, project `impersonation-signout`).
- **Skip conditions** (each with its reason string): `!HAS_SUPER_ADMIN_CREDS`; `CREDENTIALS.tenantAdmin`
  login returns non-200 (→ "e2e tenant has no TENANT_ADMIN — run e2e-seed.js"); e2e tenant not
  found by slug.
- **Given**
  1. `POST <api>/auth/login` via `page.request` as `CREDENTIALS.tenantAdmin` with header
     `X-Tenant-Slug: TENANT_SLUG` → `adminAccess`, `adminRefresh` (creates ≥ 1 `RefreshToken` row
     for the admin). Record `adminSessionsBefore = GET /auth/sessions` (bearer `adminAccess`) —
     `N ≥ 1`; remember the newest row's `id` for cleanup.
  2. `loginAsSuperAdmin(page)`; `saToken = localStorage.superAdminToken`;
     `GET /platform-admin/tenants?search=e2e-routeflow` → pick the row whose `slug === TENANT_SLUG`
     (assert exactly one).
  3. Enter impersonation **through the real UI**: on `/admin/tenants`, search the slug, click that
     row's **Impersonate** (handler `admin/tenants/page.tsx:190-197` sets the three localStorage
     keys + tenant cookie and hard-loads `/dashboard`). Fallback if the list has no search control:
     `POST /platform-admin/tenants/<id>/impersonate` via `page.request` (bearer `saToken`), then
     `page.evaluate` writes `impersonationToken/impersonationTenantSlug/impersonationUsername`
     and `setTenantCookie(context, baseURL, TENANT_SLUG)`, then `page.goto("/dashboard")`.
     Either way, capture `impToken` (from localStorage) and take
     `nBefore = GET /auth/sessions` count with bearer `impToken` (this lists the TENANT_ADMIN's
     sessions — the impersonation token's `sub` is that admin).
  4. Register `page.on("request", r => r.url().includes("/auth/logout") && logoutCalls++)`
     BEFORE opening the menu.
- **When** on `/dashboard` (banner "Impersonating **e2e-routeflow**" visible) click
  `getByRole("button", { name: "Open user menu" })` (`layout.tsx:885`) · **Then**
  (a) `getByRole("menuitem", { name: "Sign out" })` has **count 0**;
  (b) `getByRole("menuitem", { name: "Exit impersonation" })` visible; click it;
  (c) `waitForURL("**/admin/tenants")`; `localStorage.impersonationToken` is `null`;
  (d) `logoutCalls === 0`;
  (e) `nAfter = GET /auth/sessions` with bearer `impToken` (still valid — 15 min) → `nAfter === nBefore`
  and the admin's row id from step 1 is still listed.
- **Cleanup (`finally`, pass or fail):** `DELETE /auth/sessions/<step-1 row id>` with bearer
  `adminAccess` (leaves the tenant as found); `logout(page)` helper clears localStorage.
- **Oracle:** (e) is a **server-side count taken through a token the UI never touches** — before
  vs after — independent of any web code; pre-fix the count drops to 0 because `deleteMany({ userId })`
  revoked the admin everywhere (the bug's exact symptom). (a)/(b) are the menu contract from
  spec §R12. (d) is supplementary (see vacuity).
- **Mutation → red:** (i) restore the unconditional "Sign out" item → (a) red; (ii) make "Exit
  impersonation" call `logout()` instead of `exitImpersonation()` → (d) red and (e) red
  (`nAfter` 0) — unless R11 is also in place, in which case (e) stays `N` and (d) alone catches it;
  (iii) revert R11 while keeping R12 → this spec stays green (the web never calls logout) —
  **R11 is proven only by T18**, which is why the jest companion is not optional.
- **Vacuity:** (d) is vacuous if the URL filter never matches (API on another origin) — filter on
  `includes("/auth/logout")`, origin-agnostic, and add a positive control in the same spec:
  after cleanup, call the helper `logout(page)`… no — the helper is localStorage-only. Instead the
  positive control is (e): a drop to 0 is the observable failure and does not depend on request
  interception at all. Treat (d) as belt, (e) as braces.
- **Precondition risk:** without the TENANT_ADMIN seed on prod the spec SKIPS — B138 then holds
  at `proven-pending-deploy` on T18 alone plus a T3 manual walk-through recorded in the PR, and
  the lead schedules the reseed. A skip is never a discharge (L-041).

### T22 · spec 32 `REG-B155` a session captured before a token rotation can still be revoked, and the revoke bites — R13, R14, R16

- **Level:** e2e (`apps/web/e2e/32-active-sessions.spec.ts`, project `active-sessions`, NO
  `storageState` — this test revokes its OWN session and must not consume the shared
  `operator.json` refresh token).
- **Given** `setTenantCookie(context, baseURL, TENANT_SLUG)`; `loginAsOperator(page)` (fresh
  session → new `RefreshToken` row + `rf_refresh` cookie on the API origin, path `/api/v1/auth`);
  `token = operatorAccessToken(page)`; `rows = GET <api>/auth/sessions` (bearer `token`) →
  `sid = rows[0].id` (newest `createdAt`; CI runs `workers: 1`, so the newest row is this login's);
  `POST <api>/auth/refresh` via `page.request` with an empty JSON body (the cookie is sent because
  `page.request` shares the context jar) → 200 with a new pair; then `rows2 = GET /auth/sessions`
  (bearer = the NEW access token from the refresh response).
- **When** `page.goto("/settings")`, scroll to **Active Sessions**, locate
  `[data-session-id="${sid}"]` · **Then**
  (a) the row **exists** (pre-fix: the rotation replaced the row, so `sid` is gone → red here);
  (b) `rows2.some(r => r.id === sid)` is true (API-level statement of the same fact);
  (c) click that row's **Revoke** → toast "Session revoked" visible, row detached;
  (d) `POST <api>/auth/refresh` via `page.request` again → **401** (the rotated cookie's row is
  the one we revoked).
  Pin: `rows2.find(r => r.id === sid).createdAt === rows[0].createdAt` ("Signed in" is the login
  time, not the rotation time).
- **Oracle:** (b) and (d) are API facts read with tokens the UI did not produce: a row id that
  survives `/auth/refresh` is the identity contract; a 401 on the SECOND refresh proves the revoke
  hit THIS session's row (if it had hit someone else's, our refresh would still succeed). The
  `createdAt` equality is the "Signed in" truth, checked as raw ISO strings.
- **Mutation → red:** (i) restore delete+create rotation → (a)(b) red; (ii) keep in-place rotation
  but make `revokeSession` a no-op → (c) may still toast (if the API returns 200) but (d) returns
  200 → red; (iii) drop `data-session-id` → (a) red.
- **Vacuity:** none of (a)–(d) can pass without both halves. Guard the toast text against i18n
  drift by asserting the API `DELETE /auth/sessions/<sid>` response 200 via `page.waitForResponse`
  as well.
- **Side effects:** the spec ends with its own session revoked; subsequent page calls 401 → the
  web redirects to `/login` — acceptable, and no other project's session is touched.

### T23 · spec 32 `REG-B155` a failed revoke refreshes the list instead of lying — R14

- **Level:** e2e (same spec file, second `test`).
- **Given** fresh `loginAsOperator`, `/settings` open with ≥ 1 row;
  `page.route("**/auth/sessions/*", r => r.request().method() === "DELETE" ? r.fulfill({ status: 403, contentType: "application/json", body: '{"message":"Session not found"}' }) : r.continue())`;
  `listCalls = 0` counted via `page.on("request")` on `GET …/auth/sessions` (no id suffix) —
  record `listCallsBefore` after the initial load settles.
- **When** click **Revoke** on any row · **Then** toast "Failed to revoke session" visible AND
  `listCalls === listCallsBefore + 1` (the card re-fetched); the row set equals the server's list.
- **Oracle:** the 403 is manufactured by the test; the re-fetch count is a request-level fact.
  Pre-fix the catch toasts and never reloads → count unchanged → red.
- **Mutation → red:** remove `loadSessions()` from the catch.
- **Vacuity:** `page.route` on a cross-origin API URL — use a glob that matches the API origin
  (`**/auth/sessions/*`), and assert the route actually fired (`routeHits === 1`) so an unmatched
  pattern cannot produce a green through a real 200.
- **Revoke-all honesty** (`Promise.allSettled` branch) is verified by the same route with two
  rows and the **Sign out all → Yes** flow → toast "Some sessions could not be revoked"; include
  only if the fresh login plus one extra `POST /auth/login` via `page.request` gives ≥ 2 rows
  (`Sign out all` renders only when `sessions.length > 1`). Cleanup revokes both.

---

## C. Contract / process checks (no `REG-` token; they gate discharge, not the red gate)

### T24 · seed contract — the e2e tenant gains an ACTIVE TENANT_ADMIN — R15

- **Level:** integration, local, manual. `npm run db:up`; `node apps/api/scripts/e2e-seed.js`
  twice (idempotency: second run prints "exists"); `POST /api/v1/auth/login` with
  `CREDENTIALS.tenantAdmin` + `X-Tenant-Slug: e2e-routeflow` → 200, `user.role === "TENANT_ADMIN"`,
  `user.tenantSlug === "e2e-routeflow"`; `assertTestTenant` is the first thing the script calls
  (unchanged). Prod: owner runs `railway run --service postgres node apps/api/scripts/e2e-seed.js`
  and pastes the "Created … e2e_admin" / "exists" line into the PR.
- **Oracle:** the login response, not the script's console output.
- **Mutation → red:** seed with `status: "PENDING"` → `impersonate()` 404s (`platform-admin.service.ts:576-579`)
  and T21 skips — visible as a skip in the step log, which is precisely the state L-041 says to
  refuse.

### T25 · prod schema precondition — R17

- **Level:** process. `railway run npx prisma migrate status` output shows
  `20260908000000_campaign_schema_foundation` applied; paste into the PR. If not applied: STOP,
  apply per the canonical flow step 1, and note that prod audit writes have been silently failing.
- **Oracle:** Prisma's own migration ledger.

---

## D. Traceability

| R#  | Requirement (short)                                              | Tests              |
| --- | ---------------------------------------------------------------- | ------------------ |
| R1  | supplier-statements owner-gated                                  | T1 T2 T3 T4 T6     |
| R2  | JWT path default-deny, before fs, signed/SA exempt               | T4 T5 T6           |
| R3  | POST prices OPERATOR at the route                                | T7                 |
| R4  | service gate hoisted; legacy DRIVER pin inverted                 | T8                 |
| R5  | order-template mutation matrix excludes DRIVER                   | T9                 |
| R6  | addItem through ownership wrapper                                | T10 T11            |
| R7  | inventory writes inherit OPERATOR; reads keep DRIVER             | T12 T13            |
| R8  | strategies propagate impersonatedBy                              | T14                |
| R9  | audit rows stamped                                               | T15 T16            |
| R10 | guard logs from header, never blocks                             | T17                |
| R11 | logout under impersonation revokes nothing                       | T18 T21(e)         |
| R12 | header exit item, no Sign out, no /auth/logout                   | T21                |
| R13 | in-place rotation, race fallback, inactive consumption           | T19 T22            |
| R14 | sessions card truth (data-session-id, reload, honest revoke-all) | T22 T23            |
| R15 | TENANT_ADMIN seed + skip logic                                   | T24 T21            |
| R16 | project entries for 31/32                                        | T21 T22 (step log) |
| R17 | F01 column live before deploy                                    | T25                |

| T#  | Level              | REG token           | R#              |
| --- | ------------------ | ------------------- | --------------- |
| T1  | integration        | REG-B52             | R1              |
| T2  | integration        | REG-B52             | R1              |
| T3  | integration        | REG-B52             | R1              |
| T4  | integration        | REG-B52             | R1 R2           |
| T5  | integration        | REG-B52             | R2              |
| T6  | integration        | REG-B52             | R1 R2           |
| T7  | unit               | REG-B132            | R3              |
| T8  | unit               | REG-B132            | R4              |
| T9  | unit               | REG-B133            | R5              |
| T10 | unit               | REG-B133            | R6              |
| T11 | unit               | REG-B133            | R6              |
| T12 | unit               | REG-B168            | R7              |
| T13 | unit               | REG-B168 (pin)      | R7              |
| T14 | unit               | REG-B165 / REG-B138 | R8              |
| T15 | unit               | REG-B165            | R9              |
| T16 | unit               | REG-B165            | R9              |
| T17 | unit               | REG-B165            | R10             |
| T18 | unit               | REG-B138            | R11             |
| T19 | unit               | REG-B155            | R13             |
| T21 | e2e (spec 31)      | REG-B138            | R12 R11 R15 R16 |
| T22 | e2e (spec 32)      | REG-B155            | R13 R14 R16     |
| T23 | e2e (spec 32)      | REG-B155            | R14             |
| T24 | manual/integration | —                   | R15             |
| T25 | process            | —                   | R17             |

(T20 is intentionally unassigned — an earlier draft's `revokeSession` unit was folded into T19's
key-absence assertion because a mocked `findUnique` made it vacuous.)

## E. Red-gate protocol

1. Write every T1 test first against `39632d27`; run `npx jest <file>` per file (never rely on a
   turbo summary — L-009/L-034). Each `REG-` test must FAIL on an assertion (not a compile error,
   except T10/T11 where the wrapper's absence is a type error — accept that as red).
2. Implement in the card's order (B52 → B165 → B138 → B155 → B168 → B132 → B133); after each,
   re-run only that row's tests, then the full `apps/api` suite once at the end with `--force`.
3. Run each **Mutation → red** line above as a probe (revert, run, restore) and record the red
   in the PR body per test id. A test whose mutation stays green is not a proof and blocks the PR.
4. T2: typecheck the two specs (`npm run check-types` in `apps/web`), review the project entries,
   never execute locally. After merge + deploy, read the e2e STEP conclusion and grep the log for
   `✓ … REG-B138` and `✓ … REG-B155`; write `proven` only then; a skip leaves the row at
   `proven-pending-deploy` with the skip reason recorded.
5. Close-out: L-044 (id from `_meta.json.nextId`; check `validate-lessons` `binding:` first),
   code-map `api.md`/`web.md`, `status/F14.jsonl`.
