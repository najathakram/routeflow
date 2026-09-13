# api — Security hardening SEC-1 (+ SEC-3 audit-IP)

> Split from `.claude/code-map/api.md` (verbatim, lines 2231-2249) on 2026-09-13. See [`../INDEX.md`](../INDEX.md).

## Security hardening — SEC-1 (2026-07-16, branch sec/authz-validation-hardening)

Authz + input-validation batch from the security audit (each fix has a `*.security.spec.ts` negative+positive case):

- **F2-005** — `orders.service.findOne` now scopes DRIVER to orders on a run they drive (`routeRun.driverId === driver.id`; null-run never driver-readable); `orders.controller.toggleUrgent` is `@Roles(OPERATOR, CUSTOMER)` (DRIVER denied). **F10-002** — `orders.service.updateOrderItems` `shouldRevert` no longer excludes CUSTOMER, so a customer editing a CONFIRMED order forces it back to PENDING (re-confirmation); DRIVER still excluded.
- **F2-006** — `messages.service` shared `assertRunChatParticipant(role,userId,runId)` gates BOTH reads (`findByRun`) AND writes (`create`) of the INTERNAL run-chat: staff (OPERATOR/TENANT_ADMIN) all, DRIVER only their assigned run (no null-runId firehose), else `Forbidden` — so a CUSTOMER can neither read nor INJECT into the operator↔driver thread; controller passes `req.user`.
- **F10-003** — `credit-notes.service.findOneForUser` denies DRIVER up front (mirrors `findAllForUser`).
- **F10-004 + F4-003** — vendor-bills create/update/recordPayment now use class-validator DTOs (`dto/{create-vendor-bill,update-vendor-bill,record-vendor-bill-payment}.dto.ts`); recordPayment also rejects `amount<=0` in the service. Internal callers still hit the `any` service methods.
- **F4-002** — `customers.service.findAll` orderBy uses a `validSortFields` allowlist checked via `Object.hasOwn` (NOT a bare index — so prototype keys `__proto__`/`constructor`/`toString`… can't resolve to an inherited truthy value and reach Prisma as a malformed orderBy → 500); unknown/injection/non-scalar → safe `createdAt desc`.
- **F8-003** — `import.service` (all 10 sites) + `products.service` bulk-import/`bulkAssignParent` mask raw errors: intentional `HttpException` validation messages are surfaced, but a raw/unknown error (Prisma constraint text) is genericized to a fixed reason + `logger.warn`ed server-side (no schema disclosure). **F9-009** — `DELETE /products/bulk` body is a DTO (`@ArrayMaxSize(500)`); the web `useBulkDeleteProducts` mutation CHUNKS a large selection into sequential ≤500-id batches (aggregating `deleted`) so "Show all → Select all → Delete" on a >500-product tenant still succeeds.
- **F9-007** — `route-optimization.controller` optimize/analyze (4 routes) got `@Throttle({default:{ttl:60_000,limit:10}})`.
- **F9-008** — `import.service.parseCsv` rejects `>MAX_IMPORT_ROWS` (20 000) with a 400 thrown outside the swallowing try.
- **F9-009** — `DELETE /products/bulk` body is a DTO (`@IsArray @ArrayNotEmpty @ArrayMaxSize(500) @IsString({each})`).
- **F3-005** — `buyer-auth.service` login returns a CONSTANT "Invalid credentials" for not-found/deleted/**suspended** (removed the suspended enumeration oracle; mirrors staff `validateUser`). Register-side "email exists" Conflict left as a documented UX tradeoff.

## Security hardening — SEC-3 (audit-IP, 2026-07-16)

- **F9-006** — `audit.interceptor.ts` now records `req.ip` (Express trust-proxy-aware; `trust proxy = 2` set in main.ts) instead of the LEFTMOST `X-Forwarded-For` entry, which a client could spoof by prepending a fake value → poisoning the audit trail's source IP. Spec `audit.interceptor.security.spec.ts`. (F5-003 refresh-token type-claim + F12-005 mobile-deep-link deferred — see the security backlog note.)

