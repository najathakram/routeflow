import {
  BadRequestException,
  ConflictException,
  ExecutionContext,
  NotFoundException,
  ValidationPipe,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { RolesGuard } from "../auth/guards/roles.guard";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { createMockPrisma } from "../testing/prisma-mock";
import { activeRuleWhere } from "../selling-restrictions/selling-restrictions.core";
import { SellingRestrictionsAdminController } from "./selling-restrictions-admin.controller";
import {
  PRODUCT_LIMITS_PAGE_SIZE,
  SellingRestrictionsAdminService,
} from "./selling-restrictions-admin.service";
import { BULK_RESTRICTION_MAX, LiftBatchDto } from "./dto/bulk-restriction.dto";

/**
 * Portal limits, Branch B: POST /selling-restrictions/lift-batch (row f) and the product-page chips
 * GET /selling-restrictions?productId= (row i), plus the role gate on both (row j) and tenant
 * isolation. The real-Postgres twin is selling-restrictions-admin.bulk.db.spec.ts.
 */
const TENANT = "test-tenant";
const user = { sub: "u1", username: "operator", role: UserRole.OPERATOR } as JwtPayload;
const DAY = 86_400_000;

type Rule = Record<string, any>;
const rule = (id: string, over: Rule = {}): Rule => ({
  id,
  tenantId: TENANT,
  categoryId: null,
  productId: "p1",
  jurisdiction: "STATE",
  states: ["TX"],
  surface: "BUYER_PORTAL",
  effectiveFrom: new Date(Date.now() - DAY),
  effectiveTo: null,
  reason: "Portal limit",
  createdById: "u0",
  createdByName: "admin",
  createdAt: new Date(Date.now() - DAY),
  liftedById: null,
  liftedByName: null,
  liftedAt: null,
  liftReason: null,
  category: null,
  product: { name: "Acme pod" },
  // Row 509: a rule row's target rows (none = a pre-509 rule, read by its legacy column).
  targets: [] as Rule[],
  ...over,
});

/** `where` evaluator for the operators these queries use (tenant + id/in + liftedAt null + OR/AND). */
function matches(row: Rule, where: Rule | undefined): boolean {
  if (!where) return true;
  return Object.entries(where).every(([k, v]) => {
    if (k === "AND") return (v as Rule[]).every((w) => matches(row, w));
    if (k === "OR") return (v as Rule[]).some((w) => matches(row, w));
    if (k === "targets") {
      const rows = (row.targets ?? []) as Rule[];
      return "some" in v
        ? rows.some((t) => matches(t, v.some))
        : rows.every((t) => !matches(t, v.none));
    }
    if (v === null) return row[k] === null;
    if (v instanceof Date || typeof v !== "object") return row[k] === v;
    if ("in" in v) return (v.in as unknown[]).includes(row[k]);
    if ("gt" in v)
      return row[k] !== null && (row[k] instanceof Date ? row[k] > v.gt : String(row[k]) > v.gt);
    if ("lte" in v) return row[k] !== null && row[k] <= v.lte;
    throw new Error(`unsupported where ${k}`);
  });
}

/** An in-memory rules table with a rolling-back tenantTransaction (see the bulk spec). */
function setup(rules: Rule[] = []) {
  const prisma = createMockPrisma();
  const models = prisma.forTenant() as any;
  const store = { rules: rules.map((r) => ({ ...r })), audits: [] as Rule[] };
  models.sellingRestriction = {
    findMany: jest.fn(async (a: any) => {
      let rows = store.rules.filter((r) => matches(r, a?.where));
      if (a?.orderBy?.id === "asc") rows = [...rows].sort((x, y) => (x.id < y.id ? -1 : 1));
      if (a?.take) rows = rows.slice(0, a.take);
      return rows.map((r) => ({
        ...r,
        targets: ((r.targets ?? []) as Rule[]).filter((t) =>
          matches(t, a?.include?.targets?.where),
        ),
        _count: { targets: (r.targets ?? []).length },
      }));
    }),
    findFirst: jest.fn(
      async (a: any) =>
        store.rules.find((r) => matches(r, { tenantId: TENANT, ...a?.where })) ?? null,
    ),
    updateMany: jest.fn(async (a: any) => {
      const hit = store.rules.filter((r) => matches(r, a.where));
      hit.forEach((r) => Object.assign(r, a.data));
      return { count: hit.length };
    }),
    createMany: jest.fn(),
  };
  // The row lock (`SELECT … FOR UPDATE`) and the target summary reads are raw SQL; the fake has nothing to wait on.
  models.$queryRaw = jest.fn().mockResolvedValue([]);
  models.auditLog.create.mockImplementation(async (a: any) => {
    const row = { id: `audit-${store.audits.length + 1}`, ...a.data };
    store.audits.push(row);
    return row;
  });
  (prisma.tenantTransaction as jest.Mock).mockImplementation(async (fn: any) => {
    const snap = {
      rules: store.rules.map((r) => ({ ...r })),
      audits: [...store.audits],
    };
    try {
      return await fn({ ...models });
    } catch (e) {
      store.rules = snap.rules;
      store.audits = snap.audits;
      throw e;
    }
  });
  const labels = { effectiveLabels: jest.fn() };
  return {
    prisma,
    models,
    store,
    labels,
    row: (id: string) => store.rules.find((r) => r.id === id)!,
    service: new SellingRestrictionsAdminService(prisma, labels as any),
  };
}

describe("row f: POST /selling-restrictions/lift-batch", () => {
  it("lift-batch lifts N live rules in ONE transaction with ONE audit row and the default reason", async () => {
    const s = setup([rule("r1"), rule("r2"), rule("r3"), rule("r4")]);
    const res = await s.service.liftBatch({ ids: ["r1", "r2", "r3"] }, user);
    expect(res).toEqual({ lifted: 3, ids: ["r1", "r2", "r3"] });
    expect(s.prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    for (const id of ["r1", "r2", "r3"]) {
      expect(s.row(id)).toMatchObject({
        liftedById: "u1",
        liftedByName: "operator",
        liftReason: "Limit lifted",
      });
      expect(s.row(id).liftedAt).toBeInstanceOf(Date);
    }
    expect(s.row("r4").liftedAt).toBeNull(); // not asked for, not touched
    expect(s.store.audits).toHaveLength(1);
    expect(s.store.audits[0]).toMatchObject({
      action: "selling_restriction.batch_lifted",
      entityType: "SellingRestriction",
      userId: "u1",
      meta: { ids: ["r1", "r2", "r3"], reason: "Limit lifted" },
    });
    // ONE guarded write, never widened: tenant + the exact ids + liftedAt IS NULL.
    const writes = s.models.sellingRestriction.updateMany.mock.calls;
    expect(writes).toHaveLength(1);
    expect(writes[0][0].where).toEqual({
      tenantId: TENANT,
      id: { in: ["r1", "r2", "r3"] },
      liftedAt: null,
    });
    // Row 509: the rule rows are locked (FOR UPDATE, shared with target edits) BEFORE the guarded write.
    const lock = s.models.$queryRaw as jest.Mock;
    expect(lock).toHaveBeenCalledTimes(1);
    expect(lock.mock.invocationCallOrder[0]).toBeLessThan(
      s.models.sellingRestriction.updateMany.mock.invocationCallOrder[0],
    );
    expect(String(lock.mock.calls[0][0].join(" "))).toContain("FOR UPDATE");
  });

  it("a second lift-batch of the same ids is a 409 and overwrites nothing (liftedAt, liftReason, actor)", async () => {
    const s = setup([rule("r1"), rule("r2")]);
    await s.service.liftBatch({ ids: ["r1", "r2"], reason: "Undone right after creating" }, user);
    const before = ["r1", "r2"].map((id) => ({ ...s.row(id) }));
    const err = await s.service
      .liftBatch({ ids: ["r1", "r2"], reason: "second" }, {
        ...user,
        sub: "u2",
        username: "other",
      } as JwtPayload)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      alreadyLiftedIds: ["r1", "r2"],
      notFoundIds: [],
    });
    expect(["r1", "r2"].map((id) => s.row(id))).toEqual(before);
    expect(s.row("r1").liftReason).toBe("Undone right after creating");
    expect(s.store.audits).toHaveLength(1);
  });

  it("one already-lifted id in the batch is a 409 and the OTHER ids stay live (nothing changed)", async () => {
    const earlier = new Date(Date.now() - DAY);
    const s = setup([rule("r1"), rule("r2", { liftedAt: earlier, liftReason: "first" })]);
    await expect(s.service.liftBatch({ ids: ["r1", "r2"] }, user)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(s.row("r1").liftedAt).toBeNull();
    expect(s.row("r2")).toMatchObject({ liftedAt: earlier, liftReason: "first" });
    expect(s.store.audits).toHaveLength(0);
  });

  it("a lift that loses a race (the guarded write hits fewer rows) rolls the whole batch back", async () => {
    const s = setup([rule("r1"), rule("r2")]);
    const real = s.models.sellingRestriction.updateMany.getMockImplementation();
    s.models.sellingRestriction.updateMany.mockImplementationOnce(async (a: any) => {
      // Another request lifts r2 between our read and our write.
      s.row("r2").liftedAt = new Date();
      s.row("r2").liftReason = "the other request";
      return real!(a);
    });
    await expect(s.service.liftBatch({ ids: ["r1", "r2"] }, user)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(s.row("r1").liftedAt).toBeNull(); // rolled back with the batch
    expect(s.store.audits).toHaveLength(0);
  });

  it("repeated ids collapse; an explicit reason is kept", async () => {
    const s = setup([rule("r1")]);
    const res = await s.service.liftBatch({ ids: ["r1", "r1"], reason: "Law repealed" }, user);
    expect(res).toEqual({ lifted: 1, ids: ["r1"] });
    expect(s.row("r1").liftReason).toBe("Law repealed");
  });

  it("an unknown or another tenant's id is a 409, that rule is untouched, and nothing else is lifted", async () => {
    const s = setup([rule("r1"), rule("foreign", { tenantId: "other-tenant" })]);
    const err = await s.service
      .liftBatch({ ids: ["r1", "foreign", "nope"] }, user)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      notFoundIds: ["foreign", "nope"],
    });
    expect(s.row("foreign").liftedAt).toBeNull();
    expect(s.row("r1").liftedAt).toBeNull();
  });

  it("refuses without a tenant context, and an empty list, before any read or write", async () => {
    const s = setup([rule("r1")]);
    await expect(s.service.liftBatch({ ids: [] }, user)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    (s.prisma.getTenantId as jest.Mock).mockReturnValue(null);
    await expect(s.service.liftBatch({ ids: ["r1"] }, user)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(s.prisma.tenantTransaction).not.toHaveBeenCalled();
    expect(s.models.sellingRestriction.updateMany).not.toHaveBeenCalled();
  });

  it(`more than ${BULK_RESTRICTION_MAX} ids, or none, is a 400 at the DTO`, async () => {
    const pipe = new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    });
    const validate = (body: object) =>
      pipe.transform(body, { type: "body", metatype: LiftBatchDto });
    const many = Array.from({ length: BULK_RESTRICTION_MAX + 1 }, (_, i) => `r${i}`);
    await expect(validate({ ids: many })).rejects.toBeInstanceOf(BadRequestException);
    await expect(validate({ ids: [] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(validate({ ids: many.slice(0, BULK_RESTRICTION_MAX) })).resolves.toBeInstanceOf(
      LiftBatchDto,
    );
    // A blank reason means the default, never an empty stored reason.
    await expect(validate({ ids: ["r1"], reason: "  " })).resolves.toEqual({ ids: ["r1"] });
  });

  it("single lift keeps working through the same guarded core (404 unknown, 409 already lifted)", async () => {
    const s = setup([rule("r1")]);
    const dto = await s.service.lift("r1", { reason: "Law repealed" }, user);
    expect(dto).toMatchObject({ id: "r1", status: "LIFTED", liftReason: "Law repealed" });
    expect(s.store.audits).toEqual([
      expect.objectContaining({ action: "selling_restriction.lifted", entityId: "r1" }),
    ]);
    await expect(s.service.lift("r1", { reason: "again" }, user)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(s.row("r1").liftReason).toBe("Law repealed");
    await expect(s.service.lift("nope", { reason: "x" }, user)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(s.store.audits).toHaveLength(1);
  });
});

describe("row i: GET /selling-restrictions?productId= — the product-page chips", () => {
  const VARIANT = "v1";
  const PARENT = "parent1";
  const labelsFor = (categoryIds: string[]) =>
    new Map([
      [
        VARIANT,
        {
          productId: VARIANT,
          name: "Acme pod mint",
          nameKnown: true,
          effectiveCategoryIds: new Set(categoryIds),
          lineageIds: new Set([VARIANT, PARENT]),
          resolvable: true,
        },
      ],
    ]);
  const seeded = () => [
    rule("a-own", { productId: VARIANT, product: { name: "Acme pod mint" } }),
    rule("b-parent", { productId: PARENT, product: { name: "Acme pod" }, states: ["NY"] }),
    rule("c-cat", {
      productId: null,
      categoryId: "cat-vapes",
      category: { name: "Vapes" },
      product: null,
      surface: "ALL",
    }),
    rule("d-other", { productId: "unrelated" }),
    rule("e-lifted", { productId: VARIANT, liftedAt: new Date(Date.now() - 1000) }),
    rule("f-scheduled", { productId: VARIANT, effectiveFrom: new Date(Date.now() + DAY) }),
  ];

  it("?productId= returns its own (PRODUCT), its parent's (PARENT) and its category's (CATEGORY) active rules", async () => {
    const s = setup(seeded());
    s.labels.effectiveLabels.mockResolvedValue(labelsFor(["cat-vapes"]));
    const res = await s.service.productLimits(VARIANT);
    expect(s.labels.effectiveLabels).toHaveBeenCalledWith(TENANT, [VARIANT]);
    expect(res.nextCursor).toBeNull();
    expect(res.items.map((i) => [i.id, i.via, i.viaLabel])).toEqual([
      ["a-own", "PRODUCT", null],
      ["b-parent", "PARENT", "Acme pod"],
      ["c-cat", "CATEGORY", "Vapes"],
    ]);
    expect(res.items[1]).toEqual({
      id: "b-parent",
      jurisdiction: "STATE",
      states: ["NY"],
      surface: "BUYER_PORTAL",
      reason: "Portal limit",
      effectiveFrom: expect.any(String),
      effectiveTo: null,
      via: "PARENT",
      viaLabel: "Acme pod",
      liftedAt: null,
      directTarget: false,
      targetSummary: { products: 0, categories: 0, preview: [] },
    });
    // Tenant-scoped, ACTIVE only (the engine's own predicate), deterministic keyset order.
    const q = s.models.sellingRestriction.findMany.mock.calls[0][0];
    expect(q.where.tenantId).toBe(TENANT);
    expect(q.where.AND[0]).toEqual(activeRuleWhere(q.where.AND[0].effectiveFrom.lte));
    expect(q.orderBy).toEqual({ id: "asc" });
  });

  it("row 509: rules WITH target rows reach the product through active targets only (TARGET, PARENT, CATEGORY); a removed target is gone", async () => {
    const t = (over: Rule) => ({ removedAt: null, addedAt: new Date(Date.now() - DAY), ...over });
    const s = setup([
      rule("t-own", {
        productId: "first",
        targets: [
          t({ productId: "first" }),
          t({ productId: VARIANT, product: { name: "Acme pod mint" } }),
        ],
      }),
      rule("t-parent", {
        productId: PARENT,
        targets: [t({ productId: PARENT, product: { name: "Acme pod" } })],
      }),
      rule("t-cat", {
        productId: null,
        categoryId: "cat-vapes",
        targets: [t({ productId: null, categoryId: "cat-vapes", category: { name: "Vapes" } })],
      }),
      // the legacy column still names the variant, but its only target row was removed: no longer binds it
      rule("t-removed", {
        productId: VARIANT,
        targets: [t({ productId: VARIANT, removedAt: new Date(Date.now() - 1000) })],
      }),
    ]);
    s.labels.effectiveLabels.mockResolvedValue(labelsFor(["cat-vapes"]));
    const res = await s.service.productLimits(VARIANT);
    expect(res.items.map((i) => [i.id, i.via, i.viaLabel, i.directTarget])).toEqual([
      ["t-cat", "CATEGORY", "Vapes", false],
      ["t-own", "PRODUCT", null, true],
      ["t-parent", "PARENT", "Acme pod", false],
    ]);
  });

  it("an EXCLUDE opt-out (the category is not in the product's effective labels) hides the category chip", async () => {
    const s = setup(seeded());
    s.labels.effectiveLabels.mockResolvedValue(labelsFor([]));
    const res = await s.service.productLimits(VARIANT);
    expect(res.items.map((i) => i.via)).toEqual(["PRODUCT", "PARENT"]);
    expect(
      JSON.stringify(s.models.sellingRestriction.findMany.mock.calls[0][0].where),
    ).not.toContain("categoryId");
  });

  it("pages with an opaque id keyset cursor, then ends with nextCursor null", async () => {
    const many = Array.from({ length: PRODUCT_LIMITS_PAGE_SIZE + 1 }, (_, i) =>
      rule(`r${String(i).padStart(3, "0")}`, { productId: VARIANT }),
    );
    const s = setup(many);
    s.labels.effectiveLabels.mockResolvedValue(labelsFor([]));
    const first = await s.service.productLimits(VARIANT);
    expect(first.items).toHaveLength(PRODUCT_LIMITS_PAGE_SIZE);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.nextCursor).not.toContain(first.items[first.items.length - 1].id); // opaque
    const second = await s.service.productLimits(VARIANT, first.nextCursor!);
    expect(second.items.map((i) => i.id)).toEqual([
      `r${String(PRODUCT_LIMITS_PAGE_SIZE).padStart(3, "0")}`,
    ]);
    expect(second.nextCursor).toBeNull();
  });

  it("a malformed cursor is a 400; an unknown or another tenant's product is a 404", async () => {
    const s = setup(seeded());
    s.labels.effectiveLabels.mockResolvedValue(labelsFor([]));
    await expect(s.service.productLimits(VARIANT, "not-a-cursor")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    s.labels.effectiveLabels.mockResolvedValue(
      new Map([
        [
          "foreign",
          {
            productId: "foreign",
            name: "foreign",
            nameKnown: false,
            effectiveCategoryIds: new Set(),
            lineageIds: new Set(["foreign"]),
            resolvable: false,
          },
        ],
      ]),
    );
    await expect(s.service.productLimits("foreign")).rejects.toBeInstanceOf(NotFoundException);
    expect(s.models.sellingRestriction.findMany).not.toHaveBeenCalled();
  });

  it("without productId the route still returns the rules list unchanged", async () => {
    const service = { list: jest.fn().mockResolvedValue([]), productLimits: jest.fn() };
    const controller = new SellingRestrictionsAdminController(service as any);
    await controller.list("ACTIVE");
    expect(service.list).toHaveBeenCalledWith("ACTIVE");
    expect(service.productLimits).not.toHaveBeenCalled();
    await controller.list(undefined, "v1", "cur");
    expect(service.productLimits).toHaveBeenCalledWith("v1", "cur");
  });
});

describe("row j: OPERATOR and TENANT_ADMIN may lift and read chips; CUSTOMER, DRIVER and buyers get 403", () => {
  const proto = SellingRestrictionsAdminController.prototype as unknown as Record<string, object>;
  const guard = new RolesGuard(new Reflector());
  const can = (principal: Record<string, unknown>, handler: string) =>
    guard.canActivate({
      getHandler: () => proto[handler],
      getClass: () => SellingRestrictionsAdminController,
      switchToHttp: () => ({ getRequest: () => ({ user: principal }) }),
    } as unknown as ExecutionContext);

  it.each(["lift", "liftBatch", "list"])("%s", (handler) => {
    expect(can({ role: UserRole.OPERATOR }, handler)).toBe(true);
    expect(can({ role: UserRole.TENANT_ADMIN }, handler)).toBe(true);
    expect(can({ role: UserRole.CUSTOMER }, handler)).toBe(false);
    expect(can({ role: UserRole.DRIVER }, handler)).toBe(false);
    expect(can({ type: "BUYER" }, handler)).toBe(false);
  });
});
