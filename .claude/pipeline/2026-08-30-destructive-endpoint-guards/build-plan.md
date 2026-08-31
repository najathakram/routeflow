# Build plan — destructive endpoint guards (B126, B127)

Status: APPROVED · REVIEWED 2026-08-30 — TP1's fake store REPLACED (the original could not
express T1 and would have failed the correct implementation: no `findMany`, no FK-`in` filter
support, no NULL-tenant children); P1 gains the R8 `orderCreditNote` cleanup; mutation probe
extended. Base master `6c8f1401`. Branch `fix/destructive-endpoint-guards`.
**Workdir: `C:/ClaudeCode/routeflow/.claude/worktrees/destructive-guards`** — an isolated worktree.
Do NOT work in the main checkout: another session is live there.

House rules: Jest only (no snapshots, no Vitest). NestJS `Test.createTestingModule`, mocked at the
module boundary. Prettier — double quotes, semicolons, printWidth 100, trailing commas. Conventional
Commits. Do NOT touch `turbo.json`, `local-assets/`, or the e2e-routeflow TenantAddon backfill. Do
NOT change repo visibility, do NOT push, do NOT merge.

---

## TEST PACKAGES — authored FIRST, must be RED before implementation

### TP1 · B126 controller specs

**Files (owns exclusively):** `apps/api/src/system-config/settings.controller.clear-financial.spec.ts`
**satisfies:** — **provenBy:** T1, T2, T3, T4, T5, T6

Write T1–T6 exactly as specified in `test-plan.md`. Two mock strategies in one file:

**T1 uses a purpose-built fake store — NOT `createMockPrisma`.** Exact shape (REPLACED in review:
the fake must model parents _and_ NULL-tenant children, support `findMany` and FK-`in` delete
filters, or the **correct** implementation fails the test):

```ts
type Row = {
  id: string;
  tenantId: string | null;
  invoiceId?: string;
  vendorBillId?: string;
  poId?: string;
  creditNoteId?: string;
};

const PARENTS = ["invoice", "creditNote", "vendorBill", "purchaseOrder", "payment"] as const;
const CHILDREN: Record<string, { fk: string; parent: string }> = {
  invoicePayment: { fk: "invoiceId", parent: "invoice" },
  invoiceItem: { fk: "invoiceId", parent: "invoice" },
  billPayment: { fk: "vendorBillId", parent: "vendorBill" },
  vendorBillItem: { fk: "vendorBillId", parent: "vendorBill" },
  purchaseOrderItem: { fk: "poId", parent: "purchaseOrder" },
  orderCreditNote: { fk: "creditNoteId", parent: "creditNote" }, // R8
};

function makeFakeStore(tenantId: string | null) {
  const rows: Record<string, Row[]> = {};
  for (const p of PARENTS) {
    rows[p] = [
      { id: `${p}-a`, tenantId: "tenant-a" },
      { id: `${p}-b`, tenantId: "tenant-b" },
    ];
  }
  for (const [child, { fk, parent }] of Object.entries(CHILDREN)) {
    // One NULL-tenant child per parent row — the production shape (nested-created
    // children carry tenantId = NULL) that a naive where:{tenantId} fix would miss.
    rows[child] = rows[parent].map((p) => ({
      id: `${child}-of-${p.id}`,
      tenantId: null,
      [fk]: p.id,
    }));
  }

  // Faithful to Prisma's contract: empty/absent where matches EVERYTHING (the
  // production defect); equality and { in: [...] } filters both supported.
  const matches = (r: Row, where?: Record<string, any>): boolean => {
    if (!where || Object.keys(where).length === 0) return true;
    return Object.entries(where).every(([k, v]) =>
      v && typeof v === "object" && Array.isArray(v.in)
        ? v.in.includes((r as any)[k])
        : (r as any)[k] === v,
    );
  };

  const model = (name: string) => ({
    findMany: jest.fn(async (args?: any) => rows[name].filter((r) => matches(r, args?.where))),
    deleteMany: jest.fn(async (args?: any) => {
      const before = rows[name].length;
      rows[name] = rows[name].filter((r) => !matches(r, args?.where));
      return { count: before - rows[name].length };
    }),
  });

  const models = Object.fromEntries(Object.keys(rows).map((m) => [m, model(m)]));
  return {
    rows,
    prisma: {
      ...models,
      getTenantId: jest.fn().mockReturnValue(tenantId),
      forTenant: jest.fn().mockReturnValue(models),
      tenantTransaction: jest.fn(async (fn: any) => fn(models)),
      $transaction: jest.fn(async (fn: any) => fn(models)),
    },
  };
}
```

T1 then asserts, after `clearFinancialData({ confirmTenantId: "tenant-a" })`:

```ts
for (const p of PARENTS) {
  expect(rows[p].map((r) => r.id)).toEqual([`${p}-b`]); // tenant B's parents survive; A's gone
}
for (const [c, { parent }] of Object.entries(CHILDREN)) {
  // tenant B's children survive; tenant A's NULL-tenant children are gone
  expect(rows[c].map((r) => r.id)).toEqual([`${c}-of-${parent}-b`]);
}
```

Against the current implementation the parent assertion fails (everything is wiped) — the red
gate. Against a naive `where: { tenantId }`-only fix, the child assertion fails (NULL-tenant
children of tenant A survive). Two independent failure directions, as `test-plan.md` requires.

T2/T3/T5/T6 may use `createMockPrisma()` (stock) since they assert call shape / absence of calls.
T4 reads the `@Roles` metadata by reflection — mirror the existing
`apps/api/src/customers/customers.controller.roles.spec.ts` for the exact `ROLES_KEY` import and style.

⚠️ Do not import the implementation's constants to build expectations — spell the ten model names out
in the test, so a model deleted from the handler is caught rather than silently followed.

### TP2 · B127 service specs

**Files (owns exclusively):** `apps/api/src/customers/customers.service.delete-all.spec.ts`
**satisfies:** — **provenBy:** T7, T8, T9

Write T7–T9 per `test-plan.md`. Read `deleteAllCustomers` (~line 1959) and `batchDelete` (~line 1926)
in `apps/api/src/customers/customers.service.ts` first — `batchDelete`'s pre-flight is the reference
behaviour and its `groupBy` call shape is what your mock must satisfy:

```ts
prisma.forTenant().invoice.groupBy; // by: ["customerId"], where: { customerId: { in }, status: { in: ["PAID","SENT"] } }, _count: { _all: true }
```

Assert on `ConflictException`, on the message naming customer + count, and — critically — that
`tenantTransaction` was **not** entered.

---

## IMPLEMENTATION PACKAGES

### P1 · Harden `clearFinancialData` (B126)

**Files (owns exclusively):** `apps/api/src/system-config/settings.controller.ts`,
`apps/api/src/system-config/dto/clear-financial-data.dto.ts` (new)
**satisfies:** R1, R2, R3, R4, R8 — **provenBy:** T1, T2, T3, T4, T5, T6

New DTO (match the style of `update-route-settings.dto.ts`):

```ts
import { IsNotEmpty, IsString } from "class-validator";

/**
 * Typed confirmation for the irreversible financial-data wipe. The caller must
 * echo their OWN tenantId, which proves both intent and that they know which
 * tenant they are clearing. Compared server-side against prisma.getTenantId().
 */
export class ClearFinancialDataDto {
  @IsString()
  @IsNotEmpty()
  confirmTenantId!: string;
}
```

Replace the handler with (add `ForbiddenException` to the existing `@nestjs/common` import; every
other symbol used here is already imported in this file):

```ts
  @Delete("financial-data")
  @Roles(UserRole.TENANT_ADMIN)
  @UsePipes(new ValidationPipe({ whitelist: true, transform: true }))
  async clearFinancialData(@Body() dto: ClearFinancialDataDto) {
    const tenantId = this.prisma.getTenantId();

    // R2 — prisma.tenantTransaction hands back the RAW, UNSCOPED tx when there is
    // no tenant (prisma.service.ts:48 `if (!tenantId) return fn(rawTx)`), and
    // forTenant() is unscoped for SUPER_ADMIN too. A destructive bulk wipe has no
    // legitimate all-tenant mode, so refuse rather than inherit that fall-through.
    if (!tenantId) {
      throw new ForbiddenException(
        "Clearing financial data requires a tenant context; it cannot be run across tenants.",
      );
    }

    // R4 — typed confirmation: the caller must echo their own tenantId.
    if (dto?.confirmTenantId !== tenantId) {
      throw new BadRequestException(
        "confirmTenantId must match the calling tenant to confirm this irreversible action.",
      );
    }

    // R1 — scope every delete. ⚠️ CHILDREN ARE DELETED BY PARENT ID, NOT BY tenantId.
    // `tenantId` is `String?` on ALL of these models, and nested-created child rows
    // (invoice lines written via their parent) carry tenantId = NULL — they bypass
    // the tenant extension's data.tenantId injection. A naive
    // `deleteMany({ where: { tenantId } })` on a child would therefore be SAFE but
    // INCOMPLETE: it protects other tenants yet silently skips NULL-tenant rows,
    // orphaning line items whose parent invoice we just deleted. Deleting children
    // by their parent's id removes them regardless of their own tenantId. This is
    // the same pattern customers.service.ts `deleteAllCustomers` already uses.
    // tenantTransaction is kept as defence in depth; the explicit filters carry
    // correctness, because the proxy injects nothing when tenantId is null.
    await this.prisma.tenantTransaction(async (tx) => {
      const invoices = await tx.invoice.findMany({ where: { tenantId }, select: { id: true } });
      const invoiceIds = invoices.map((i: { id: string }) => i.id);
      if (invoiceIds.length) {
        await tx.invoicePayment.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
        await tx.invoiceItem.deleteMany({ where: { invoiceId: { in: invoiceIds } } });
      }
      await tx.invoice.deleteMany({ where: { tenantId } });

      // R8 — OrderCreditNote.creditNoteId is a REQUIRED FK with no onDelete
      // (Prisma default = Restrict): deleting a linked credit note would abort
      // the whole transaction, 500ing the endpoint for exactly the tenants that
      // use order↔credit links. Remove the links by parent id first (same
      // NULL-tenant reasoning as the other children). CreditNoteItem, by
      // contrast, has onDelete: Cascade and needs no explicit delete.
      const creditNotes = await tx.creditNote.findMany({
        where: { tenantId },
        select: { id: true },
      });
      const creditNoteIds = creditNotes.map((c: { id: string }) => c.id);
      if (creditNoteIds.length) {
        await tx.orderCreditNote.deleteMany({ where: { creditNoteId: { in: creditNoteIds } } });
      }
      await tx.creditNote.deleteMany({ where: { tenantId } });

      const bills = await tx.vendorBill.findMany({ where: { tenantId }, select: { id: true } });
      const billIds = bills.map((b: { id: string }) => b.id);
      if (billIds.length) {
        await tx.billPayment.deleteMany({ where: { vendorBillId: { in: billIds } } });
        await tx.vendorBillItem.deleteMany({ where: { vendorBillId: { in: billIds } } });
      }
      await tx.vendorBill.deleteMany({ where: { tenantId } });

      const pos = await tx.purchaseOrder.findMany({ where: { tenantId }, select: { id: true } });
      const poIds = pos.map((p: { id: string }) => p.id);
      if (poIds.length) {
        // NOTE: PurchaseOrderItem's FK is `poId`, not `purchaseOrderId`.
        await tx.purchaseOrderItem.deleteMany({ where: { poId: { in: poIds } } });
      }
      await tx.purchaseOrder.deleteMany({ where: { tenantId } });

      // Payment's parent is Transaction, which this endpoint does not touch, so
      // payments are never orphaned by the deletes above; tenantId scoping is right
      // here. NULL-tenant payments are consequently not cleared — a pre-existing
      // limitation of untagged legacy rows, not one introduced by this change.
      await tx.payment.deleteMany({ where: { tenantId } });
    });

    return { success: true, message: "All financial data cleared successfully" };
  }
```

⚠️ Deletion ORDER still satisfies FK constraints — children before their parents throughout.
⚠️ Keep the response body identical; it is a public API contract.
⚠️ Schema facts already verified against `apps/api/prisma/schema.prisma` — do not re-derive: all ten
models have `tenantId String?` (nullable); FKs are `InvoicePayment.invoiceId`, `InvoiceItem.invoiceId`,
`BillPayment.vendorBillId`, `VendorBillItem.vendorBillId`, `PurchaseOrderItem.poId`,
`Payment.transactionId`, `CreditNote.customerId`. Referential actions (re-verified 2026-08-30):
`OrderCreditNote.creditNoteId` required, **no onDelete ⇒ Restrict** (hence R8);
`CreditNoteItem.creditNoteId` **onDelete: Cascade** (no explicit delete needed);
`InvoicePayment.creditNoteId` optional ⇒ SetNull (safe); `InvoiceItem.invoiceId`,
`VendorBillItem.vendorBillId`, `PurchaseOrderItem.poId` Cascade — explicit child deletes are
defence in depth there, but `BillPayment.vendorBillId` and `InvoicePayment.invoiceId` have no
onDelete (Restrict), so their children-first order IS correctness.

### P2 · Pre-flight guard on `deleteAllCustomers` (B127)

**Files (owns exclusively):** `apps/api/src/customers/customers.service.ts`
**satisfies:** R5, R6 — **provenBy:** T7, T8, T9

Insert a PAID/SENT pre-flight at the very top of `deleteAllCustomers`, **before** any deletion and
before `tenantTransaction` is entered, mirroring `batchDelete` (~1929-1944): same statuses
`["PAID","SENT"]`, same `ConflictException`, same message shape. Scope it to the customers this call
would delete. Preserve the existing early return `{ deleted: 0 }` when there are no customers, and
change nothing else in the method.

Prefer extracting the shared pre-flight into a small private helper used by BOTH `batchDelete` and
`deleteAllCustomers` **only if** it can be done without altering `batchDelete`'s observable behaviour
or message. If that is not cleanly possible, duplicate the check and add a comment pointing at the
sibling — divergence risk is the thing to avoid, not duplication per se.

### P3 · Code map (dependsOn: P1, P2)

**Files (owns exclusively):** `.claude/code-map/api.md`, `.claude/code-map/CHANGELOG.md`,
`.claude/code-map/_meta.json`
**satisfies:** R7 — **provenBy:** gate

Surgical edits only. `api.md`: note both hardened endpoints and — the durable lesson —
that `tenantTransaction`/`forTenant` are **unscoped when tenantId is null**, so destructive handlers
must scope explicitly and refuse a null tenant. One dated bullet at the top of `CHANGELOG.md`.
`_meta.json`: set `mappedSha` + `generatedAt`, REPLACE `notes` with that bullet (never accumulate).
⚠️ `_meta.json` MUST parse — validate with
`python -c "import json;json.load(open('.claude/code-map/_meta.json',encoding='utf-8'))"`.

---

## Verification

Run jest **directly** — turbo replays cached logs verbatim, so a jest summary alone proves nothing:

- **perRound:** `cd apps/api && npx tsc --noEmit -p tsconfig.build.json`
- **final:**
  - `cd apps/api && npx jest src/system-config src/customers`
  - `cd apps/api && npx tsc --noEmit -p tsconfig.build.json`
  - `npx prettier --check "apps/api/src/**/*.ts"`
  - `python -c "import json;json.load(open('.claude/code-map/_meta.json',encoding='utf-8'))"`

**Red gate (before implementation):**
`cd apps/api && npx jest src/system-config/settings.controller.clear-financial.spec.ts src/customers/customers.service.delete-all.spec.ts`
— expect FAILING ASSERTIONS, not import/syntax errors.

## Mutation probe (after green)

| file                                                | behavior                                          | test |
| --------------------------------------------------- | ------------------------------------------------- | ---- |
| `apps/api/src/system-config/settings.controller.ts` | drop `where` from the `invoice.deleteMany` call   | T1   |
| `apps/api/src/system-config/settings.controller.ts` | remove the `if (!tenantId) throw` guard           | T3   |
| `apps/api/src/system-config/settings.controller.ts` | remove the `orderCreditNote.deleteMany` call (R8) | T1   |
| `apps/api/src/customers/customers.service.ts`       | remove the PAID/SENT pre-flight                   | T7   |
