import { Test, TestingModule } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { BadRequestException, ExecutionContext, ForbiddenException } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { SettingsController } from "./settings.controller";
import { ClearFinancialDataDto } from "./dto/clear-financial-data.dto";
import { SystemConfigService } from "./system-config.service";
import { PrismaService } from "../prisma/prisma.service";
import { EmailService } from "../email/email.service";
import { RolesGuard } from "../auth/guards/roles.guard";
import { createMockPrisma } from "../testing/prisma-mock";

// B126 — DELETE /settings/financial-data wiped EVERY tenant's finances: unscoped
// deleteMany across the financial models, no null-tenant guard, no typed confirmation,
// and gated only by the controller-level @Roles(OPERATOR). T1-T6 prove the hardened
// contract from .claude/pipeline/2026-08-30-destructive-endpoint-guards/spec.md (R1-R4).
//
// T1 uses a purpose-built fake store, NOT createMockPrisma — see the "vacuity trap" note
// in test-plan.md: createMockPrisma's forTenant()/tenantTransaction() hand back the SAME
// unscoped model surface as the raw client, so a test built on it cannot distinguish a
// scoped delete from an unscoped one. The fake instead models the real parent/child shape:
// nested-created child rows (invoice items, bill payments, ...) carry tenantId: null and
// are reachable only through their parent — the shape a naive `where: { tenantId }` fix on
// a child model would silently miss. Its `tenantTransaction` calls the REAL
// `_wrapTxWithTenant` from prisma.service.ts, so the tenantId that proxy injects into
// every deleteMany is observable here instead of being invisible at the module boundary.

const MODELS = [
  "invoicePayment",
  "invoiceItem",
  "invoice",
  // OrderCreditNote.creditNoteId is ON DELETE RESTRICT, so the join rows must be cleared
  // before their credit notes or the whole transaction aborts on a FK violation.
  "orderCreditNote",
  "creditNote",
  "billPayment",
  "vendorBillItem",
  "vendorBill",
  "purchaseOrderItem",
  "purchaseOrder",
  "payment",
] as const;

const PARENT_MODELS = ["invoice", "vendorBill", "purchaseOrder", "creditNote", "payment"] as const;

// Child model -> { parent model, FK field on the child row, relation field on the child }.
// PurchaseOrderItem's FK is `poId` and its relation is `po`, not `purchaseOrderId`/
// `purchaseOrder` — deliberately spelled out here rather than imported from the
// implementation, so a wrong FK/relation name in the handler is caught.
const CHILD_FK: Partial<
  Record<(typeof MODELS)[number], { parent: string; fk: string; relation: string }>
> = {
  invoicePayment: { parent: "invoice", fk: "invoiceId", relation: "invoice" },
  invoiceItem: { parent: "invoice", fk: "invoiceId", relation: "invoice" },
  orderCreditNote: { parent: "creditNote", fk: "creditNoteId", relation: "creditNote" },
  billPayment: { parent: "vendorBill", fk: "vendorBillId", relation: "vendorBill" },
  vendorBillItem: { parent: "vendorBill", fk: "vendorBillId", relation: "vendorBill" },
  purchaseOrderItem: { parent: "purchaseOrder", fk: "poId", relation: "po" },
};

type FakeRow = { id: string; tenantId: string | null; [fk: string]: string | null };

/**
 * Purpose-built fake datastore for T1 (build-plan.md TP1), extended per test-plan.md's
 * parent/child description: parents seeded one row per tenant; children seeded one row
 * PER PARENT with tenantId: null plus the parent's FK. deleteMany faithfully reproduces
 * Prisma's contract — an absent/empty `where` deletes everything.
 */
function makeFakeStore(tenantId: string | null) {
  const rows: Record<string, FakeRow[]> = {};

  for (const m of PARENT_MODELS) {
    rows[m] = [
      { id: `${m}-a`, tenantId: "tenant-a" },
      { id: `${m}-b`, tenantId: "tenant-b" },
    ];
  }
  for (const m of MODELS) {
    const child = CHILD_FK[m];
    if (!child) continue;
    rows[m] = [
      { id: `${m}-a`, tenantId: null, [child.fk]: `${child.parent}-a` },
      { id: `${m}-b`, tenantId: null, [child.fk]: `${child.parent}-b` },
    ];
  }

  // Every key of a `where` is ANDed, exactly as Prisma does. That is what makes the
  // tenantTransaction proxy's injected tenantId OBSERVABLE: it arrives as an EXTRA
  // condition on top of the handler's own filter, not as a replacement for it.
  const matches = (name: string, row: FakeRow, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([key, cond]) => {
      if (key === "tenantId") return row.tenantId === cond;
      const child = CHILD_FK[name as (typeof MODELS)[number]];
      // Relation filter, e.g. `{ invoice: { tenantId } }` — resolve the parent rows it
      // selects, then test this row's FK against them.
      if (child && key === child.relation) {
        const parentIds = new Set(
          rows[child.parent]
            .filter((p) => matches(child.parent, p, cond as Record<string, unknown>))
            .map((p) => p.id),
        );
        return parentIds.has(row[child.fk] as string);
      }
      // Scalar list filter, e.g. `{ invoiceId: { in: [...] } }`.
      const list = (cond as { in?: unknown })?.in;
      return Array.isArray(list) && list.includes(row[key]);
    });

  const model = (name: string) => ({
    findMany: jest.fn(async (args?: { where?: { tenantId?: string } }) => {
      const scope = args?.where?.tenantId;
      const list =
        scope === undefined ? rows[name] : rows[name].filter((r) => r.tenantId === scope);
      return list.map((r) => ({ id: r.id }));
    }),
    deleteMany: jest.fn(async (args?: { where?: Record<string, unknown> }) => {
      const where = args?.where;
      const before = rows[name].length;
      if (!where || Object.keys(where).length === 0) {
        // Faithfully reproduces the production defect: an absent/empty where wipes everything.
        rows[name] = [];
      } else {
        rows[name] = rows[name].filter((r) => !matches(name, r, where));
      }
      return { count: before - rows[name].length };
    }),
  });

  const models = Object.fromEntries(MODELS.map((m) => [m, model(m)])) as Record<
    (typeof MODELS)[number],
    ReturnType<typeof model>
  >;
  const txClient = { ...models, $executeRaw: jest.fn().mockResolvedValue(0) };

  // The REAL tenant proxy from prisma.service.ts, not an imitation of it. `deleteMany` is
  // in its SCOPED_METHODS, so it rewrites every call as `where: { ...args.where, tenantId }`
  // — which re-scopes a parent-relation filter back onto the CHILD's own (null) tenantId
  // and matches nothing. Reaching for the production wrapper is what stops this fake from
  // drifting away from the code it stands in for.
  const wrapWithTenant = (tx: unknown, id: string) =>
    (
      PrismaService.prototype as unknown as {
        _wrapTxWithTenant(rawTx: unknown, tenantId: string): typeof txClient;
      }
    )._wrapTxWithTenant(tx, id);

  return {
    rows,
    prisma: {
      ...models,
      getTenantId: jest.fn().mockReturnValue(tenantId),
      forTenant: jest.fn().mockReturnValue(models),
      // Mirrors PrismaService.tenantTransaction: proxied when a tenant is in context,
      // raw when it is not (prisma.service.ts `if (!tenantId) return fn(rawTx)`).
      tenantTransaction: jest.fn(async (fn: (tx: typeof txClient) => unknown) =>
        fn(tenantId ? wrapWithTenant(txClient, tenantId) : txClient),
      ),
      $transaction: jest.fn(async (fn: (tx: typeof txClient) => unknown) => fn(txClient)),
    },
  };
}

function stubSvc() {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    getAll: jest.fn().mockResolvedValue({}),
  };
}

async function buildController(prisma: unknown): Promise<SettingsController> {
  const module: TestingModule = await Test.createTestingModule({
    controllers: [SettingsController],
    providers: [
      { provide: SystemConfigService, useValue: stubSvc() },
      { provide: ConfigService, useValue: { get: jest.fn() } },
      { provide: PrismaService, useValue: prisma },
      { provide: EmailService, useValue: { send: jest.fn().mockResolvedValue(undefined) } },
    ],
  }).compile();
  return module.get<SettingsController>(SettingsController);
}

// The production handler is still parameterless pre-fix (`async clearFinancialData()`);
// the hardened contract (R1-R4) requires it to take a confirmation body. Calling through
// this cast — rather than typing `controller` as `any` — is what lets these tests compile
// against TODAY'S signature while still exercising the DTO the fix must add, so the file
// fails on the assertions below instead of on a TS2554 argument-count error.
type ClearFinancialCaller = (dto?: unknown) => Promise<unknown>;
function callClearFinancialData(controller: SettingsController, dto?: unknown) {
  return (controller.clearFinancialData as unknown as ClearFinancialCaller)(dto);
}

function deleteManyMocks(prisma: ReturnType<typeof createMockPrisma>) {
  return prisma as unknown as Record<
    (typeof MODELS)[number],
    { deleteMany: jest.Mock; findMany: jest.Mock }
  >;
}

// R1: "no unscoped delete" — a where that scopes by tenantId, by a parent RELATION filter
// (`{ invoice: { tenantId } }`), or by a parent-id `in` filter. Every key must scope.
function isScopedWhere(args: unknown): boolean {
  if (!args || typeof args !== "object") return false;
  const where = (args as { where?: unknown }).where;
  if (!where || typeof where !== "object" || Array.isArray(where)) return false;
  const keys = Object.keys(where as Record<string, unknown>);
  if (keys.length === 0) return false;
  return keys.every((k) => {
    const v = (where as Record<string, unknown>)[k];
    if (k === "tenantId") return typeof v === "string" && v.length > 0;
    if (!v || typeof v !== "object" || Array.isArray(v)) return false;
    const nested = v as { tenantId?: unknown; in?: unknown };
    if (typeof nested.tenantId === "string") return nested.tenantId.length > 0;
    return Array.isArray(nested.in);
  });
}

// Runs the REAL RolesGuard against the REAL decorator metadata for this handler, with the
// class-level @Roles(OPERATOR) genuinely in play (getAllAndOverride reads handler THEN class).
// Reading the metadata directly would not do: `expect(roles).toEqual(arrayContaining([
// TENANT_ADMIN]))` also passes for @Roles(TENANT_ADMIN, OPERATOR), which re-admits the exact
// role R3 forbids — RolesGuard grants on `requiredRoles.some(...)` and ROLE_SATISFIES[OPERATOR]
// is [OPERATOR]. Only running the guard makes that mutation visible.
function guardAdmits(role: UserRole): boolean {
  const guard = new RolesGuard(new Reflector());
  const context = {
    getHandler: () => SettingsController.prototype.clearFinancialData,
    getClass: () => SettingsController,
    switchToHttp: () => ({ getRequest: () => ({ user: { role } }) }),
  } as unknown as ExecutionContext;
  return guard.canActivate(context);
}

describe("SettingsController#clearFinancialData — DELETE /settings/financial-data", () => {
  // T1 (R1) — headline test: tenant B survives completely, and tenant A's NULL-tenant
  // children (not just its tenant-tagged parents) are gone. Against today's unscoped
  // deleteMany, assertion 1 fails. Against a naive `where: { tenantId }` fix applied to a
  // child model, assertion 3 fails (children never carry a tenantId, so they'd survive).
  it("T1: wipes tenant A completely (parents + NULL-tenant children) and leaves tenant B untouched", async () => {
    const { rows, prisma } = makeFakeStore("tenant-a");
    const controller = await buildController(prisma);

    await callClearFinancialData(controller, { confirmTenantId: "tenant-a" });

    // 1. Every tenant-b PARENT row still exists.
    for (const m of PARENT_MODELS) {
      expect(rows[m].map((r) => r.id)).toContain(`${m}-b`);
    }

    // 2. Every child row belonging to a tenant-b PARENT still exists — proves children
    //    weren't wiped by a blanket filter that ignores which parent they belong to.
    for (const m of MODELS) {
      if (!CHILD_FK[m]) continue;
      expect(rows[m].map((r) => r.id)).toContain(`${m}-b`);
    }

    // 3. Tenant-a's parents AND their NULL-tenant children are gone — proves the wipe of
    //    the calling tenant is complete, not merely safe toward other tenants.
    for (const m of PARENT_MODELS) {
      expect(rows[m].map((r) => r.id)).not.toContain(`${m}-a`);
    }
    for (const m of MODELS) {
      if (!CHILD_FK[m]) continue;
      expect(rows[m].map((r) => r.id)).not.toContain(`${m}-a`);
    }
  });

  // REG-B126 — canonical regression pin for the fix landed in #506 (cc8c7d46):
  // DELETE /settings/financial-data ran ten unscoped deleteMany({}) calls, reachable by
  // any OPERATOR token, wiping every tenant's finances. This test collapses the two
  // load-bearing halves of that fix into one oracle: (1) the RolesGuard no longer admits
  // OPERATOR — only TENANT_ADMIN — and (2) every deleteMany the wipe issues carries a
  // tenant-scoping filter, never an absent/empty where. T1-T6b above are the detailed
  // proof; this is the one test a revert of either half must break.
  it("REG-B126 DELETE /settings/financial-data is tenant-scoped and refuses a plain OPERATOR", async () => {
    expect(guardAdmits(UserRole.OPERATOR)).toBe(false);
    expect(guardAdmits(UserRole.TENANT_ADMIN)).toBe(true);

    const prisma = createMockPrisma();
    prisma.getTenantId.mockReturnValue("tenant-a");
    const controller = await buildController(prisma);
    const models = deleteManyMocks(prisma);

    await callClearFinancialData(controller, { confirmTenantId: "tenant-a" });

    for (const m of MODELS) {
      expect(models[m].deleteMany).toHaveBeenCalled();
      for (const call of models[m].deleteMany.mock.calls) {
        expect(isScopedWhere(call[0])).toBe(true);
      }
    }
  });

  // T1b (R1) — pins the transaction helper, naming the CAUSE that T1 catches by outcome.
  // tenantTransaction hands the callback `_wrapTxWithTenant`, which lists `deleteMany` in
  // SCOPED_METHODS and appends `tenantId` to every where — re-scoping the parent-relation
  // filters back onto the child's own (null) tenantId. The wipe must therefore run on the
  // raw $transaction, which the null-tenant refusal (T3) is what makes safe.
  it("T1b: runs the wipe on the raw $transaction, never on the tenantId-injecting tenantTransaction", async () => {
    const { prisma } = makeFakeStore("tenant-a");
    const controller = await buildController(prisma);

    await callClearFinancialData(controller, { confirmTenantId: "tenant-a" });

    expect(prisma.$transaction).toHaveBeenCalled();
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
  });

  // T2 (R1) — call-shape assertion across every model the wipe touches: independent of
  // which filter shape the implementation picks (tenantId-scoping vs parent-relation
  // scoping), no deleteMany may ever be invoked with an absent/empty where. Also guards
  // against a handler that vacuously "passes" by deleting nothing at all.
  it("T2: never calls deleteMany on any of the cleared models with an absent/empty where", async () => {
    const prisma = createMockPrisma();
    prisma.getTenantId.mockReturnValue("test-tenant");
    const controller = await buildController(prisma);
    const models = deleteManyMocks(prisma);

    await callClearFinancialData(controller, { confirmTenantId: "test-tenant" });

    for (const m of MODELS) {
      // Every model must actually be cleared: "no unscoped delete" must not be
      // satisfiable by a handler that simply skips models. Note there is nothing to seed
      // here — a parent-relation filter needs no id lookup, so no `if (ids.length)` guard
      // can quietly skip a child model the way an id-list implementation could.
      expect(models[m].deleteMany).toHaveBeenCalled();
      for (const call of models[m].deleteMany.mock.calls) {
        expect(isScopedWhere(call[0])).toBe(true);
      }
    }
  });

  // T3 (R2) — the SUPER_ADMIN / no-tenant-context case must refuse outright rather than
  // inherit prisma.service.ts's `if (!tenantId) return fn(rawTx)` unscoped fall-through.
  it("T3: a null tenantId refuses with ForbiddenException and deletes nothing", async () => {
    const prisma = createMockPrisma();
    prisma.getTenantId.mockReturnValue(null);
    const controller = await buildController(prisma);
    const models = deleteManyMocks(prisma);

    await expect(
      callClearFinancialData(controller, { confirmTenantId: "anything" }),
    ).rejects.toThrow(ForbiddenException);

    for (const m of MODELS) {
      expect(models[m].deleteMany).not.toHaveBeenCalled();
    }
    // Both transaction helpers, so "nothing was entered" holds whichever one the handler
    // settles on. This matters more than it looks: the wipe runs on the RAW $transaction
    // (T1b), so this refusal is the only thing standing between a null tenant and an
    // entirely unscoped delete.
    expect(prisma.tenantTransaction).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  // T4 (R3) — asserted as BEHAVIOUR, the way the spec words it ("a plain OPERATOR is
  // refused"), not as decorator metadata. This endpoint is strictly more dangerous than
  // sibling @Patch("margin") (also TENANT_ADMIN-gated), so it may not be left on the laxer
  // class-level @Roles(OPERATOR) — and must not quietly re-admit OPERATOR alongside
  // TENANT_ADMIN either, which a containment check cannot see.
  it("T4: the RolesGuard refuses a plain OPERATOR and admits TENANT_ADMIN", () => {
    expect(guardAdmits(UserRole.OPERATOR)).toBe(false);
    expect(guardAdmits(UserRole.TENANT_ADMIN)).toBe(true);
  });

  // T5 (R4) — the typed confirmation is a precondition; failing it must be side-effect free.
  it("T5: a confirmTenantId that mismatches the caller's tenant refuses (BadRequestException) and deletes nothing", async () => {
    const prisma = createMockPrisma();
    prisma.getTenantId.mockReturnValue("tenant-a");
    const controller = await buildController(prisma);
    const models = deleteManyMocks(prisma);

    await expect(
      callClearFinancialData(controller, { confirmTenantId: "tenant-b" }),
    ).rejects.toThrow(BadRequestException);

    for (const m of MODELS) {
      expect(models[m].deleteMany).not.toHaveBeenCalled();
    }
  });

  // T6 (R4) — a missing confirmation is refused the same way as a mismatched one.
  it("T6: a missing confirmTenantId refuses and deletes nothing", async () => {
    const prisma = createMockPrisma();
    prisma.getTenantId.mockReturnValue("tenant-a");
    const controller = await buildController(prisma);
    const models = deleteManyMocks(prisma);

    // Typed, not a bare rejects.toThrow(): otherwise ANY incidental crash — a TypeError
    // dereferencing an absent body, say — would satisfy the assertion without the
    // confirmation check existing at all.
    await expect(callClearFinancialData(controller, {})).rejects.toThrow(BadRequestException);
    // An entirely absent body is refused the same way, which forces the handler to read
    // `dto?.confirmTenantId` rather than dereference an undefined argument.
    await expect(callClearFinancialData(controller)).rejects.toThrow(BadRequestException);

    for (const m of MODELS) {
      expect(models[m].deleteMany).not.toHaveBeenCalled();
    }
  });

  // T6b (R4) — closes the coverage gap the RED-gate audit flagged: T5/T6 call the
  // handler directly, so nothing exercises the ValidationPipe path over the DTO the
  // spec puts in scope (apps/api/src/system-config/dto/clear-financial-data.dto.ts).
  // plainToInstance + validateSync is exactly what ValidationPipe runs.
  //
  // Asserting on the ERRORED PROPERTY, not merely on "some error came back": a DTO
  // carrying no class-validator metadata at all yields a single property-less
  // `unknownValue` error (class-validator 0.15 forbidUnknownValues), which a bare
  // "length > 0" check would happily accept as validation working.
  it("T6b: the ClearFinancialDataDto refuses an empty or absent confirmTenantId", () => {
    const propsOf = (plain: Record<string, unknown>) =>
      validateSync(plainToInstance(ClearFinancialDataDto, plain)).map((e) => e.property);

    // RED TODAY: the DTO declares confirmTenantId but carries no @IsString()/@IsNotEmpty(),
    // so no per-property error is ever raised for it.
    expect(propsOf({})).toContain("confirmTenantId");
    expect(propsOf({ confirmTenantId: "" })).toContain("confirmTenantId");

    // ...and a caller echoing a real tenantId passes validation.
    expect(propsOf({ confirmTenantId: "tenant-a" })).not.toContain("confirmTenantId");
  });
});
