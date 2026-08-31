# Test plan — destructive endpoint guards (B126, B127)

Status: APPROVED · REVIEWED 2026-08-30 — T1/T2 extended to cover R8 (`orderCreditNote` links).
Jest only. NestJS `Test.createTestingModule`, mocked at the module boundary.
NO snapshot tests. NO Vitest. Prettier: double quotes, semicolons, printWidth 100, trailing commas.

## ⚠️ The vacuity trap this plan exists to avoid — read first

`apps/api/src/testing/prisma-mock.ts` (`createMockPrisma`) sets:

```ts
forTenant: jest.fn().mockReturnValue(models),          // SAME surface as the unscoped client
getTenantId: jest.fn().mockReturnValue("test-tenant"),
tenantTransaction: jest.fn((fn) => fn(models)),        // injects NOTHING
```

So with the stock mock, `prisma.invoice.deleteMany({})` and
`prisma.forTenant().invoice.deleteMany({})` are **indistinguishable**, and `tenantTransaction`'s real
runtime proxy injection is invisible at the module boundary. A test written against the stock mock
would pass against the _unfixed_ code. Two consequences, both binding:

1. **Implementation constraint.** The fix MUST pass an explicit `where: { tenantId }` to each of the
   ten `deleteMany` calls. Relying on `tenantTransaction`'s proxy alone is untestable here _and_
   unsafe anyway (see R2 / `prisma.service.ts:48`). `tenantTransaction` is still used, as defence in
   depth — but the explicit `where` is what carries correctness.
2. **Test constraint.** T1 uses a purpose-built **fake store**, not the stock mock, so that "tenant
   B's rows survive" is a real observation rather than an assertion about a jest.fn.

## Coverage matrix

| R#  | Requirement                                                    | Tests             |
| --- | -------------------------------------------------------------- | ----------------- |
| R1  | Only the calling tenant's rows are deleted                     | T1, T2            |
| R2  | Null tenantId refuses, deletes nothing                         | T3                |
| R3  | Requires TENANT_ADMIN                                          | T4                |
| R4  | Typed confirmation must equal caller's tenantId                | T5, T6            |
| R5  | PAID/SENT blocks bulk customer delete                          | T7, T8            |
| R6  | Happy path still deletes                                       | T9                |
| R7  | Code map valid                                                 | gate (JSON parse) |
| R8  | OrderCreditNote links removed by parent id, tenant B's survive | T1                |

Every T# names its R#. Every R# has ≥1 T#.

---

### T1 — (R1) tenant B survives, and tenant A's NULL-tenant children still go · **headline test**

**File:** `apps/api/src/system-config/settings.controller.clear-financial.spec.ts`
**Level:** integration-flavoured unit, against a **fake store** (not `createMockPrisma`).

⚠️ The fake must model the parent/child reality, because the implementation deletes children by
**parent id**, not by tenantId (`tenantId` is `String?` and nested-created children carry NULL):

- Parents (`invoice`, `vendorBill`, `purchaseOrder`, `creditNote`, `payment`) hold rows tagged
  `tenantId: "tenant-a"` and `tenantId: "tenant-b"`.
- Children (`invoiceItem`, `invoicePayment` → `invoiceId`; `vendorBillItem`, `billPayment` →
  `vendorBillId`; `purchaseOrderItem` → `poId`; `orderCreditNote` → `creditNoteId` (R8)) hold, for
  EACH parent, one row with **`tenantId: null`** plus its parent FK. This is the production shape
  the naive fix would miss.
- `findMany({ where: { tenantId }, select: { id: true } })` filters by tenantId.
- `deleteMany({ where })` supports `{ tenantId }` **and** `{ <fk>: { in: [...] } }`, and — faithfully
  reproducing the production defect — deletes **everything** when `where` is absent/empty.
- `getTenantId()` → `"tenant-a"`; `tenantTransaction(fn)` invokes `fn` with that same fake.

**When** `clearFinancialData({ confirmTenantId: "tenant-a" })`.
**Then** three assertions, all required:

1. every `tenant-b` **parent** row still exists;
2. every child row belonging to a **tenant-b parent** still exists (proves we didn't delete children
   by a blanket filter);
3. tenant-a's parents AND their **NULL-tenant children** are gone (proves the wipe is complete, not
   merely safe).

**Oracle:** the expected end-state is derived from the seed data — "tenant B keeps exactly what it
started with, tenant A keeps nothing" — never from what the handler happens to call. The fake's
delete semantics mirror Prisma's contract, so the _datastore_ judges.

**Not vacuous:** against today's code (`deleteMany({})`) assertion 1 fails. Against a naive
`where: { tenantId }` fix, assertion 3 fails on the NULL-tenant children. It can fail in two
independent directions.

**Mutation that must turn it red:** drop `where` from the `invoice.deleteMany` call.

---

### T2 — (R1) no delete is ever unscoped

**Same file.** Stock `createMockPrisma` is acceptable — this asserts call shape.

**Given** `getTenantId()` → `"test-tenant"`. **When** the handler runs. **Then** across all models
the handler touches (the ten financial models plus `orderCreditNote`),
assert **every** recorded `deleteMany` call received a `where` that is non-empty and
scopes by either `tenantId` or a parent-id `in` filter — i.e. **zero** calls made with `undefined`,
`{}`, or `{ where: {} }`. Also assert at least one delete happened, so a handler that deletes nothing
cannot pass vacuously.

**Oracle:** "no unscoped delete" is the security property stated in R1, independent of which filter
shape the implementation picks — so this test survives a legitimate refactor between tenantId-scoping
and parent-id-scoping, while still failing the original defect.
**Mutation:** unscope any single `deleteMany`.

---

### T3 — (R2) a null tenantId refuses and deletes nothing

**Given** `getTenantId()` → `null` (the SUPER_ADMIN / no-context case).
**When** `clearFinancialData({ confirmTenantId: "anything" })`.
**Then** it **rejects** (`ForbiddenException`) and **no `deleteMany` on any model was called**, and
`tenantTransaction` was never entered.

**Oracle:** `prisma.service.ts:48` (`if (!tenantId) return fn(rawTx)`) proves the unscoped
fall-through is real; the spec says a destructive endpoint has no all-tenant mode.
**Not vacuous:** delete the null check and this test fails — the handler would proceed to wipe.
**Mutation:** remove the `if (!tenantId) throw` guard.

---

### T4 — (R3) the route demands TENANT_ADMIN

**File:** extend `apps/api/src/system-config/settings.controller.spec.ts` (or the new spec).
**Given** the `Reflector` metadata on `SettingsController.prototype.clearFinancialData`.
**When** read via `Reflect.getMetadata(ROLES_KEY, ...)` — the same reflection style as the existing
`customers.controller.roles.spec.ts`.
**Then** it includes `UserRole.TENANT_ADMIN` and **not** a bare `OPERATOR`-only gate.

**Oracle:** the sibling `@Patch("margin")` is the reference — this endpoint is strictly more
dangerous, so it may not be laxer. **Mutation:** delete the `@Roles(TENANT_ADMIN)` decorator.

---

### T5 — (R4) a mismatched confirmation refuses and deletes nothing

**Given** `getTenantId()` → `"tenant-a"`. **When** called with `{ confirmTenantId: "tenant-b" }`.
**Then** rejects (`BadRequestException`) and **no `deleteMany` was called**.
**Mutation:** drop the equality comparison.

### T6 — (R4) a missing confirmation refuses and deletes nothing

**When** called with `{}` / undefined body. **Then** rejects and nothing is deleted.
**Oracle for T5/T6:** the confirmation is a precondition; failing it must be side-effect free — which
is checked directly, not inferred from the thrown type.

---

### T7 — (R5) a PAID invoice blocks the bulk customer delete

**File:** `apps/api/src/customers/customers.service.delete-all.spec.ts`
**Given** two customers in the tenant, one holding a `PAID` invoice — expressed through
`prisma.forTenant().invoice.groupBy` returning a blocker row, exactly as `batchDelete` consumes it.
**When** `deleteAllCustomers()`.
**Then** throws `ConflictException`, the message names the blocking customer and its invoice count,
and **`tenantTransaction` was never entered** (nothing deleted).

**Oracle:** the sibling `batchDelete` (customers.service.ts ~1926-1944) is the specification —
same statuses `["PAID","SENT"]`, same exception type, same message shape. Consistency with the
sibling _is_ the requirement, so the oracle is another piece of shipped code, not this implementation.
**Mutation:** remove the pre-flight → the call proceeds and the test fails.

### T8 — (R5) a SENT invoice blocks it too

As T7 with status `SENT`. **Oracle:** the sibling blocks on `{ in: ["PAID","SENT"] }`; a fix that
only checks `PAID` is half a fix. **Mutation:** narrow the status list to `["PAID"]`.

### T9 — (R6) no blockers ⇒ the delete still happens

**Given** `groupBy` returns `[]`. **When** `deleteAllCustomers()`. **Then** it does **not** throw,
`tenantTransaction` IS entered, and the returned `deleted` count matches the seeded customers.
Also assert the zero-customer case still short-circuits to `{ deleted: 0 }`.

**Not vacuous:** guards the obvious over-correction — a fix that simply always throws would pass
T7/T8 and fail here. **Mutation:** make the pre-flight throw unconditionally.

---

## Anti-vacuity rules for whoever writes these

- Never assert only "a jest.fn was called" for R1 — T1 must observe **surviving rows**.
- Never assert only the thrown type for R2/R4/R5 — always also assert **nothing was deleted**.
- Do not weaken to `toMatchObject` where an exact `where` shape is the point.
- Do not reach for `createMockPrisma` in T1: its `forTenant` returns the unscoped surface and would
  make the test pass against the unfixed code.

## Running them (gate trust)

Turbo replays cached logs verbatim, so a jest summary alone proves nothing. Invoke jest **directly**:

```
cd apps/api && npx jest src/system-config/settings.controller.clear-financial.spec.ts src/customers/customers.service.delete-all.spec.ts
```

Red gate expects **failing assertions** on these paths before any implementation lands — not
syntax/import errors, which would be a broken test rather than a red one.
