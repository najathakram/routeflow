# Brief — PR-6 · P4-b/c: guard-order and `findUnique` tenancy pins (test-only, light loop)

Branch `test/imp-p4-guard-order-and-findunique-pins` (after PR-5). Commit type `test:`. Scale:
small (no production files unless a guard is found to authorize on an unverified claim — then
this becomes a `fix:` with an Opus security fix + lesson). Loop: Sonnet builds → Opus `high`
review with the security lens → gates → Fable rules on disputes.

## Why (from the architecture review, P-15 / P-16)

`app.module.ts:176-185` registers three global guards in order `ThrottlerGuard` (stock) →
`TenantStatusGuard` → `ImpersonationGuard`; `JwtAuthGuard` is route-level (`@UseGuards`), so the
two custom global guards run **before** signature verification and decode the bearer payload by
hand (`tenant-status.guard.ts:43-59`, `impersonation.guard.ts:86-103`). Extraction verdict: safe by
design — `TenantStatusGuard` can only **deny** (403 for SUSPENDED/CANCELLED/READ_ONLY-write) or
pass through; `ImpersonationGuard` only logs, marking claims `unverified-bearer`; a forged claim
that passes them still meets `JwtAuthGuard`'s signature check. Nothing pins that invariant
today: `tenant-status.guard.spec.ts` never exercises a forged token against the chain, and
`impersonation.guard.spec.ts` covers logging only. Separately, Layer-1 tenancy cannot inject
`where.tenantId` into `findUnique`, so it **post-filters** the row to `null`
(`prisma.service.ts:144-153`; the tx proxy does the same at `:123-131`); `prisma-isolation.spec.ts`
exists — read it first and extend rather than duplicate.

## Requirements

| R#  | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Test   |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| R1  | The global guard chain, in the registered order, never grants access on an unverified claim: for a route guarded by `JwtAuthGuard`, a token that is (a) unsigned (`h.<payload>.s`), (b) signed with the wrong secret, or (c) expired — carrying `role: "SUPER_ADMIN"`, `tenantId: null`, `impersonatedBy: "admin"` — yields **401**; a correctly signed token yields **200**.                                                                                       | T1     |
| R2  | `TenantStatusGuard` fails **closed** on unverified claims: a forged token naming a SUSPENDED tenant → 403 before `JwtAuthGuard` runs; a forged token naming an ACTIVE tenant → passes the guard (then 401 downstream); `tenantId: null` → passes (then 401). `ImpersonationGuard` never returns false or throws for any bearer shape.                                                                                                                               | T1     |
| R3  | `app.module.ts` registers exactly `[ThrottlerGuard, TenantStatusGuard, ImpersonationGuard]` as `APP_GUARD` in that order and does **not** register `JwtAuthGuard` globally; a load-bearing comment above the block states the invariant (the only production edit: a comment).                                                                                                                                                                                      | T2     |
| R4  | Cross-tenant `findUnique` returns `null` and `findUniqueOrThrow` throws, for `Customer`, `Product`, `Order`, `Invoice`, under (a) `prisma.forTenant()` and (b) `prisma.tenantTransaction(tx => …)`; same-tenant `findUnique` returns the row. On the compose DB (superuser → RLS bypassed) this proves the JS layers; the spec also asserts `current_setting('app.current_tenant_id', true)` equals the tenant inside `tenantTransaction` (the RLS layer is armed). | T3     |
| R5  | Bookkeeping: code-map entries for the new specs; `_meta.json`; `docs/IMPROVEMENTS.md` P4 note; lessons `_meta.json.updatedAt` (no lesson unless R1/R2 finds a defect).                                                                                                                                                                                                                                                                                              | review |

## Tests

- **T1** `apps/api/src/auth/guards/guard-chain.security.spec.ts` (unit, no HTTP server): build a
  `Test.createTestingModule` with `JwtModule.register({ secret: "test-secret" })`, the real
  `JwtStrategy` (config mocked to return that secret), `TenantStatusGuard` with a mocked
  `PrismaService` (`tenant.findUnique` → `{ status }` by id), `ImpersonationGuard`, and a stock
  `ThrottlerGuard` mock returning true. Drive the chain **in the registered order** through a
  helper `runChain(req)` that calls each global guard's `canActivate` with a fake
  `ExecutionContext` (the `impersonation.guard.spec.ts` fake is the pattern), then `JwtAuthGuard`
  (`canActivate` → Passport; use `new JwtAuthGuard().canActivate(ctx)` with the strategy
  registered). Oracles: unsigned/wrong-secret/expired → rejects `UnauthorizedException`;
  forged SUSPENDED tenant → `ForbiddenException` from `TenantStatusGuard` (assert it was thrown
  by the second guard, before `JwtAuthGuard` was called — spy); forged ACTIVE / null tenant →
  passes guards 1-3 then 401; signed → resolves; `ImpersonationGuard` returns `true` for all.
  Tokens: build with `jsonwebtoken`-free helpers: unsigned = `base64url` header/payload + `"s"`;
  wrong secret = `JwtService.sign` with another secret; expired = `sign({...}, { expiresIn: -10 })`.
- **T2** `apps/api/src/app.module.guards.spec.ts` (static): read `app.module.ts`, extract the
  ordered list of `provide: APP_GUARD` `useClass`/`useExisting` names → `toEqual(["ThrottlerGuard","TenantStatusGuard","ImpersonationGuard"])`;
  assert `JwtAuthGuard` does not appear with `APP_GUARD`. Oracle before the comment edit: same
  (this test pins, it does not go red — declare it a regression pin, not red-gate).
- **T3** `apps/api/src/prisma/tenant-findunique.db.spec.ts` (PR-1's lane): create two tenants
  (`slug: qa-pin-<random>`, allowed by the test-tenant policy) and one row per model per tenant
  with the raw client; run the four models × two access paths; `afterAll` deletes what it
  created. Uses `describeDb`/`requireLocalDatabaseUrl`.

## Files

New: the three spec files. Edited: `apps/api/src/app.module.ts` (comment only), bookkeeping
files. Nothing else.

## Acceptance

`npm test -w apps/api` green (T1, T2); `npm run local:test:db` green (T3); Opus security-lens
review states in its verdict whether any guard makes an authorization decision on an unverified
claim; if yes → stop, convert to `fix:`.
