# Bug test plan — B100 (F16b invoice-number counter)

Design of record: `cause-ruling.md` §2. Facts that bind the tests: `cause-refutation.md` §7. The tenancy and
concurrency claims are provable ONLY in the DB lane (L-061): `*.db.spec.ts` run by `npm run test:db -w apps/api`
(`jest.db.config.js`) under `node scripts/local-env.mjs --db --db-specs -- "…"` against the compose Postgres
(helper precedent: `apps/api/src/common/testing/db-lane.db.spec.ts`, `apps/api/src/common/db-locks.db.spec.ts`). Unit specs mock at
the module boundary. Every REG test states the wrong value it fails on TODAY.

## Red gate

### T1 — `apps/api/src/invoices/invoice-numbering.db.spec.ts` (DB lane) — REG-B100

Seeds two throwaway tenants (test-tenant slugs only, `assertTestTenant`-style guard) and cleans up after.

- T1a `REG-B100-A cross-tenant candidate`: tenant B holds `INV-2026-0037`; tenant A calls the real
  `InvoicesService.create()` (or `generateInvoiceNumber` through the public mint path) → expect `INV-2026-0001`.
  TODAY: `INV-2026-0038`.
- T1a2 `REG-B100-A convert path` (**oracle corrected 2026-09-08, RED-gate remediation**): the convert path
  already runs inside `tenantTransaction`, whose tx proxy injects `tenantId` into `findFirst`, so it cannot
  leak cross-tenant and an `INV-2026-0001` expectation PASSES today (measured). What is false today is D3 —
  that it mints from the same `NumberingSequence` primitive. So: tenant A's (INVOICE, 2026) counter is seeded
  at `nextNumber 700`, no invoices; convert → expect `INV-2026-0700` and the row left at `701`.
  TODAY: `INV-2026-0001` (measured), row untouched at 700.
- T1b `REG-B100-B the 9999 wall`: tenant A holds `INV-2026-9999` and `INV-2026-10000`; mint → expect
  `INV-2026-10001`. TODAY: `ConflictException` (409) — the candidate is `INV-2026-10000` again.
- T1c `REG-B100-C ten concurrent mints`: `Promise.all` of 10 `create()` in tenant A → 10 distinct numbers, the
  set equals `{max+1 … max+10}`, zero rejections. TODAY: ≥ 1 P2002/409.
- T1d `REG-B100-D lazy seed from the true max`: tenant A holds `INV-2026-0412`, `INV-2026-0412-R1` and an
  imported `INV-08841`; no `NumberingSequence` row for (A, INVOICE, 2026) → first mint `INV-2026-0413`, and a
  `NumberingSequence` row now exists with `nextNumber = 414`. TODAY: the number depends on the platform-wide
  max (wrong by construction) and no row is written. The test seeds that platform-wide max ITSELF (a second
  tenant holding `INV-2026-9000`, added by the RED-gate remediation) so the value oracle is red in isolation
  too, not only when the sibling T1b happened to run first: TODAY, alone, `INV-2026-9001` (measured).
- T1e `REG-B100-D2 year boundary`: with (A, INVOICE, 2025) at `nextNumber 500`, a 2026 mint yields
  `INV-2026-0001` and leaves the 2025 row untouched. TODAY: no per-year row exists at all; the test seeds a
  second tenant holding `INV-2026-0042` (RED-gate remediation) so the `…-0001` oracle is red on its own —
  TODAY, alone, `INV-2026-0043` (measured).

### T2 — `apps/api/src/invoices/invoices.service.spec.ts` (unit) — REG-B100

- T2a `REG-B100-E duplicate() maps P2002 to 409`: `invoice.create` mock throws
  `PrismaClientKnownRequestError` code P2002 → expect `ConflictException`. TODAY: the raw error propagates (500).
- T2b `REG-B100-F convertToInvoice maps P2002 to 409` (in `estimates.service.spec.ts`): same shape. TODAY: 500.

## Pins (no REG token — the red-gate sample is exactly the REG-B100-tokened tests)

**Expected colour BEFORE the fix is stated per pin (L-060), so no auditor has to infer it.** The red gate
collects the REG-B100 tests only (T1a–T1e, T2a, T2b); a pin that is green today is an invariant, not a repro.

- P1 format (**RED today**): `NumberingService.reserveNext("INVOICE", { year: 2026 })` returns `INV-2026-0038` for
  `nextNumber 38` and `INV-2026-10001` for `10001` (fixed width 4, wider past 9999; never truncated). Each test
  also asserts its own discriminating half through the already-public `format()` helper, so the two are not
  interchangeable.
- P2 year-0 series untouched (**RED today**, on the returned shape): `reserveNext(docType)` with no year keys
  `year: 0` and formats without a year segment. Amendment (2026-09-08, RED-gate remediation): the pre-B100
  `reserveNext` trio (fast-path / collision-guard / cap) could NOT stay byte-identical — the retired `exists`
  predicate and `{ number, advanced }` shape are gone (cause-ruling.md §2 D1) — so the collision-guard and cap
  invariants are re-pinned against the new jump design in the same file instead ("jumps past an out-of-band
  imported block", "cap: throws ConflictException …"). Every other expectation in `numbering.service.spec.ts`
  is unchanged.
- P3 tenant resolution (**RED today**, on the NEW half): `reserveNext("INVOICE", { year, tenantId })` with no
  request tenant mints from `opts.tenantId`; with NEITHER source it throws `BadRequestException` and writes no
  row. Rewritten 2026-09-08 (RED-gate remediation): the refusal half alone already passed pre-fix
  (`requireTenant()` read no opts), so the new half leads — measured RED pre-fix with
  `[BadRequestException: A tenant context is required.]` where `INV-2026-0007` was expected.
- P4 `-R{i}` untouched (**GREEN today** — invariant pin, outside the red gate): `createSplitInvoices` derives
  `[base, base-R1]` from the ONE reserved base. Asserted behaviourally on `invoice.create`'s arguments
  (`invoices.service.spec.ts`), never on source text — a regex over `invoices.service.ts` would be satisfied by
  a comment or dead code (L-087).
- P5 one primitive (**RED today**): `generateInvoiceNumber` delegates to `NumberingService.reserveNext` (spy on
  the service; the five mint sites never call `prisma.invoice.findFirst` for numbering any more). The private
  helper `generateInvoiceNumber(db?, tenantId?)` is KEPT by the fix design, so this pin stays meaningful.
- P6 allocation order unchanged (**GREEN today** — invariant pin, outside the red gate):
  `payment-requests.service.ts:106` `orderBy` still `[issueDate asc, invoiceNumber asc]`. Asserted on the
  `invoice.findMany` argument in `payment-requests.service.spec.ts` (the spec that owns that service), not as
  source text from the invoices spec.

## Harness notes (the engine's harness-integrity check verifies this list)

- Every `invoices.service.spec.ts` mock of `prisma.invoice.findFirst` that served numbering becomes dead;
  the testing module needs a `NumberingService` provider — mock `reserveNext` at the module boundary
  (`{ provide: NumberingService, useValue: { reserveNext: jest.fn().mockResolvedValue("INV-2026-0001") } }`).
- `estimates.service.spec.ts` gains the same provider.
- The DB lane spec must import the real `NumberingService`/`NumberingModule` and use the compose DB URL the
  lane injects; it must create and delete its own tenants and rows (no shared fixtures).
- `createInvoiceFromOrderWithTenant` passes `tenantId` explicitly — the unit pin for that path asserts
  `reserveNext` received `{ tenantId }` without a request context.
