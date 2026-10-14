import {
  BadRequestException,
  ConflictException,
  ExecutionContext,
  ForbiddenException,
  ValidationPipe,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { UserRole } from "@prisma/client";
import { RolesGuard } from "../auth/guards/roles.guard";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { createMockPrisma } from "../testing/prisma-mock";
import { SellingRestrictionsAdminController } from "./selling-restrictions-admin.controller";
import { SellingRestrictionsAdminService } from "./selling-restrictions-admin.service";
import { BULK_RESTRICTION_MAX, BulkRestrictionDto } from "./dto/bulk-restriction.dto";

/**
 * Portal limits, Branch B: POST /selling-restrictions/bulk. Rows (a)-(e) and (j) of the spec, plus
 * tenant isolation. The real-Postgres twin (rollback, skip, isolation) is
 * selling-restrictions-admin.bulk.db.spec.ts.
 */
const user = { sub: "u1", username: "admin", role: UserRole.OPERATOR } as JwtPayload;
const ids = (n: number, prefix = "p") => Array.from({ length: n }, (_, i) => `${prefix}${i + 1}`);

/**
 * A tiny transactional fake: rules and audit rows live in arrays; `tenantTransaction` snapshots
 * them and restores the snapshot when the callback throws, like Postgres would roll back. A write
 * made OUTSIDE the transaction callback would survive the restore, so a rollback test proves the
 * writes really share one transaction.
 */
function setup(opts: { foreignProductIds?: string[] } = {}) {
  const prisma = createMockPrisma();
  const models = prisma.forTenant() as any;
  const store = { rules: [] as any[], targets: [] as any[], audits: [] as any[] };
  let failAudit = false;
  const rules = {
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn(async (a: any) => store.rules.find((r) => r.id === a?.where?.id) ?? null),
    // Row 509: ONE rule row per create (the legacy column mirrors the first target) ...
    create: jest.fn(async (a: any) => {
      store.rules.push(a.data);
      return a.data;
    }),
    updateMany: jest.fn(),
  };
  // ... plus one target row per product / label, in the same transaction.
  const targetRows = {
    createMany: jest.fn(async (a: any) => {
      store.targets.push(...a.data);
      return { count: a.data.length };
    }),
    findMany: jest.fn().mockResolvedValue([]),
  };
  models.sellingRestriction = rules;
  models.sellingRestrictionTarget = targetRows;
  models.$queryRaw = jest.fn().mockResolvedValue([]);
  // The label resolver asks for the tenant's non-archived labels among the ids: "c1" is the one it has.
  models.productCategory = {
    findMany: jest.fn(async (a: any) =>
      (a?.where?.id?.in ?? []).filter((id: string) => id === "c1").map((id: string) => ({ id })),
    ),
  };
  const foreign = new Set(opts.foreignProductIds ?? []);
  models.product.findMany.mockImplementation(async (a: any) =>
    (a?.where?.id?.in ?? []).filter((id: string) => !foreign.has(id)).map((id: string) => ({ id })),
  );
  models.auditLog.create.mockImplementation(async (a: any) => {
    if (failAudit) throw new Error("audit insert failed");
    const row = { id: `audit-${store.audits.length + 1}`, ...a.data };
    store.audits.push(row);
    return row;
  });
  (prisma.tenantTransaction as jest.Mock).mockImplementation(async (fn: any) => {
    const snap = {
      rules: [...store.rules],
      targets: [...store.targets],
      audits: [...store.audits],
    };
    try {
      return await fn({ ...models });
    } catch (e) {
      store.rules = snap.rules;
      store.targets = snap.targets;
      store.audits = snap.audits;
      throw e;
    }
  });
  const labels = { effectiveLabels: jest.fn() };
  return {
    prisma,
    models,
    rules,
    targetRows,
    store,
    failAuditWrite: () => (failAudit = true),
    service: new SellingRestrictionsAdminService(prisma, labels as any),
  };
}

const bulk = { jurisdiction: "STATE" as const, states: ["TX"] };

/** An existing rule's window: in force since long ago, open-ended, never lifted. */
const OPEN_SINCE_PAST = {
  effectiveFrom: new Date("2020-01-01T00:00:00Z"),
  effectiveTo: null,
  liftedAt: null,
};

describe("POST /selling-restrictions/bulk (row a, owner Q6): N products become ONE rule, one transaction, one audit row", () => {
  it("bulk with 12 products creates ONE rule with 12 target rows in ONE transaction and writes ONE audit row", async () => {
    const s = setup();
    const res = await s.service.bulkCreate({ ...bulk, productIds: ids(12) }, user);

    expect(s.prisma.tenantTransaction).toHaveBeenCalledTimes(1);
    expect(s.rules.create).toHaveBeenCalledTimes(1);
    expect(s.targetRows.createMany).toHaveBeenCalledTimes(1);
    const rule = s.rules.create.mock.calls[0][0].data;
    // the legacy column mirrors the FIRST target (SA condition 2)
    expect(rule).toMatchObject({
      tenantId: "test-tenant",
      productId: "p1",
      categoryId: null,
      jurisdiction: "STATE",
      states: ["TX"],
      surface: "BUYER_PORTAL", // the bulk default
      reason: "Portal limit", // the bulk default
      createdById: "u1",
      createdByName: "admin",
    });
    expect(typeof rule.id).toBe("string");
    const targets = s.targetRows.createMany.mock.calls[0][0].data;
    expect(targets).toHaveLength(12);
    expect(targets.map((t: any) => t.productId)).toEqual(ids(12));
    for (const t of targets) {
      expect(t).toMatchObject({
        tenantId: "test-tenant",
        ruleId: rule.id,
        categoryId: null,
        addedById: "u1",
        addedByName: "admin",
      });
    }

    expect(s.store.audits).toHaveLength(1);
    expect(s.store.audits[0]).toMatchObject({
      action: "selling_restriction.bulk_created",
      entityType: "SellingRestriction",
      userId: "u1",
      meta: expect.objectContaining({
        ids: [rule.id],
        scope: { productIds: ids(12) },
        productCount: 12,
        states: ["TX"],
      }),
    });

    expect(res).toEqual({
      created: 1,
      skipped: 0,
      createdIds: [rule.id],
      skippedProductIds: [],
      auditId: "audit-1",
      ruleId: rule.id,
    });
  });

  it("de-duplicates repeated product ids and keeps an explicit surface and reason", async () => {
    const s = setup();
    const res = await s.service.bulkCreate(
      { ...bulk, productIds: ["p1", "p2", "p1"], surface: "ALL", reason: "Not licensed in TX" },
      user,
    );
    expect(res.created).toBe(1);
    expect(s.rules.create.mock.calls[0][0].data).toMatchObject({
      surface: "ALL",
      reason: "Not licensed in TX",
    });
    expect(s.targetRows.createMany.mock.calls[0][0].data.map((t: any) => t.productId)).toEqual([
      "p1",
      "p2",
    ]);
  });

  it("a categoryId scope creates ONE rule with ONE label target", async () => {
    const s = setup();
    const res = await s.service.bulkCreate({ ...bulk, categoryId: "c1" }, user);
    expect(s.rules.create.mock.calls[0][0].data).toMatchObject({
      categoryId: "c1",
      productId: null,
      surface: "BUYER_PORTAL",
    });
    expect(s.targetRows.createMany.mock.calls[0][0].data).toEqual([
      expect.objectContaining({ categoryId: "c1", productId: null }),
    ]);
    expect(s.models.product.findMany).not.toHaveBeenCalled();
    expect(res).toMatchObject({ created: 1, skipped: 0 });
    expect(s.store.audits[0].meta.scope).toEqual({ categoryId: "c1" });
  });

  it("an operator cannot bulk-create an all-customer (FEDERAL) rule: 403, nothing written", async () => {
    const s = setup();
    await expect(
      s.service.bulkCreate({ jurisdiction: "FEDERAL", states: [], productIds: ["p1"] }, user),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(s.rules.create).not.toHaveBeenCalled();
    expect(s.store.audits).toHaveLength(0);
  });
});

describe("row b: a failing write rolls the whole rule back", () => {
  it("when the audit write fails after the rows, nothing persists", async () => {
    const s = setup();
    s.failAuditWrite();
    await expect(s.service.bulkCreate({ ...bulk, productIds: ids(12) }, user)).rejects.toThrow(
      "audit insert failed",
    );
    expect(s.targetRows.createMany).toHaveBeenCalledTimes(1); // the rows WERE written inside the tx ...
    expect(s.store.rules).toHaveLength(0); // ... and rolled back with it
    expect(s.store.targets).toHaveLength(0);
    expect(s.store.audits).toHaveLength(0);
  });

  it("when the target rows fail, no audit row is written and the rule row is rolled back", async () => {
    const s = setup();
    s.targetRows.createMany.mockRejectedValueOnce(new Error("FK violation"));
    await expect(s.service.bulkCreate({ ...bulk, productIds: ids(3) }, user)).rejects.toThrow(
      "FK violation",
    );
    expect(s.store.rules).toHaveLength(0);
    expect(s.store.audits).toHaveLength(0);
  });
});

/** A live rule as the identical-rule candidate read returns it (`_count.targets` = its target rows ever). */
const candidate = (over: Record<string, unknown> = {}) => ({
  id: "x1",
  productId: "p1",
  categoryId: null,
  jurisdiction: "STATE",
  states: ["TX"],
  surface: "BUYER_PORTAL",
  _count: { targets: 1 },
  ...OPEN_SINCE_PAST,
  ...over,
});

describe("row c: an identical live rule that holds ALL the products skips the create", () => {
  it("skips when one live rule with the same jurisdiction, states set and surface holds every product", async () => {
    const s = setup();
    s.rules.findMany.mockResolvedValue([
      // same states in a different order/spelling, same surface, not lifted, not expired
      candidate({ id: "x1", states: ["OK", "TX"] }),
    ]);
    s.targetRows.findMany.mockResolvedValue([{ ruleId: "x1" }, { ruleId: "x1" }, { ruleId: "x1" }]);
    const res = await s.service.bulkCreate(
      { ...bulk, states: ["Texas", "ok"], productIds: ["p1", "p2", "p3"] },
      user,
    );
    expect(res).toEqual({
      created: 0,
      skipped: 3,
      createdIds: [],
      skippedProductIds: ["p1", "p2", "p3"],
    });
    expect(s.rules.create).not.toHaveBeenCalled();
    expect(s.store.audits).toHaveLength(0);

    // The candidate read is tenant-scoped, matches jurisdiction + surface in SQL, excludes lifted and
    // expired rules, and only reads windows that could cover the request; the held read is by ACTIVE target.
    const where = s.rules.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      tenantId: "test-tenant",
      jurisdiction: "STATE",
      surface: "BUYER_PORTAL",
    });
    expect(JSON.stringify(where.AND)).toContain("liftedAt");
    expect(JSON.stringify(where.AND)).toContain("effectiveTo");
    expect(JSON.stringify(where.AND)).toContain("effectiveFrom");
    expect(s.targetRows.findMany.mock.calls[0][0].where).toMatchObject({
      tenantId: "test-tenant",
      ruleId: { in: ["x1"] },
      removedAt: null,
      OR: [{ productId: { in: ["p1", "p2", "p3"] } }],
    });
  });

  it("a rule holding only SOME of the products is not identical: ONE new rule with all of them", async () => {
    const s = setup();
    s.rules.findMany.mockResolvedValue([candidate({ id: "x1" })]);
    s.targetRows.findMany.mockResolvedValue([{ ruleId: "x1" }, { ruleId: "x1" }]); // 2 of 3
    const res = await s.service.bulkCreate({ ...bulk, productIds: ["p1", "p2", "p3"] }, user);
    expect(res).toMatchObject({ created: 1, skipped: 0 });
    expect(s.targetRows.createMany.mock.calls[0][0].data).toHaveLength(3);
  });

  it("different states set or surface is not identical", async () => {
    for (const other of [
      { states: ["TX"], surface: "BUYER_PORTAL" },
      { states: ["TX", "OK"], surface: "ALL" },
    ]) {
      const s = setup();
      s.rules.findMany.mockResolvedValue([candidate({ id: "x1", ...other })]);
      s.targetRows.findMany.mockResolvedValue([{ ruleId: "x1" }]);
      const res = await s.service.bulkCreate(
        { ...bulk, states: ["Texas", "ok"], productIds: ["p1"] },
        user,
      );
      expect(res.created).toBe(1);
    }
  });

  it("a pre-509 rule (zero target rows) holds exactly its legacy column", async () => {
    const s = setup();
    s.rules.findMany.mockResolvedValue([candidate({ _count: { targets: 0 } })]);
    const res = await s.service.bulkCreate({ ...bulk, productIds: ["p1"] }, user);
    expect(res).toEqual({ created: 0, skipped: 1, createdIds: [], skippedProductIds: ["p1"] });
    expect(s.targetRows.findMany).not.toHaveBeenCalled(); // no rule with target rows to read
    const other = setup();
    other.rules.findMany.mockResolvedValue([candidate({ _count: { targets: 0 } })]);
    const two = await other.service.bulkCreate({ ...bulk, productIds: ["p1", "p2"] }, user);
    expect(two.created).toBe(1);
  });

  it("an identical category rule is skipped too", async () => {
    const s = setup();
    s.rules.findMany.mockResolvedValue([
      candidate({ id: "x9", productId: null, categoryId: "c1" }),
    ]);
    s.targetRows.findMany.mockResolvedValue([{ ruleId: "x9" }]);
    const res = await s.service.bulkCreate({ ...bulk, categoryId: "c1" }, user);
    expect(res).toEqual({ created: 0, skipped: 1, createdIds: [] });
    expect(s.targetRows.findMany.mock.calls[0][0].where.OR).toEqual([
      { categoryId: { in: ["c1"] } },
    ]);
  });
});

describe("row c (dates): an existing rule is identical ONLY if its window covers the requested one", () => {
  const DAY = 24 * 60 * 60 * 1000;
  const existing = (w: { effectiveFrom: Date; effectiveTo: Date | null; liftedAt?: Date | null }) =>
    candidate({ surface: "ALL", liftedAt: null, ...w });
  const run = async (row: object, req: { effectiveFrom?: string; effectiveTo?: string } = {}) => {
    const s = setup();
    s.rules.findMany.mockResolvedValue([row]);
    s.targetRows.findMany.mockResolvedValue([{ ruleId: "x1" }]);
    const res = await s.service.bulkCreate(
      { ...bulk, surface: "ALL", productIds: ["p1"], ...req },
      user,
    );
    return { s, res };
  };

  it("existing expires tomorrow + requested open-ended from now => CREATED, not skipped", async () => {
    const now = Date.now();
    const { res } = await run(
      existing({ effectiveFrom: new Date(now - DAY), effectiveTo: new Date(now + DAY) }),
    );
    expect(res).toMatchObject({ created: 1, skipped: 0, skippedProductIds: [] });
  });

  it("existing scheduled next month + requested starting now => CREATED, not skipped", async () => {
    const now = Date.now();
    const { res } = await run(
      existing({ effectiveFrom: new Date(now + 30 * DAY), effectiveTo: null }),
    );
    expect(res).toMatchObject({ created: 1, skipped: 0 });
  });

  it("existing with a future lift date does not cover an open-ended request => CREATED", async () => {
    const now = Date.now();
    const { res } = await run(
      existing({
        effectiveFrom: new Date(now - DAY),
        effectiveTo: null,
        liftedAt: new Date(now + DAY),
      }),
    );
    expect(res).toMatchObject({ created: 1, skipped: 0 });
  });

  it("existing open-ended + requested bounded inside it => skipped", async () => {
    const now = Date.now();
    const { res } = await run(existing({ effectiveFrom: new Date(now - DAY), effectiveTo: null }), {
      effectiveFrom: new Date(now + DAY).toISOString(),
      effectiveTo: new Date(now + 10 * DAY).toISOString(),
    });
    expect(res).toMatchObject({ created: 0, skipped: 1, skippedProductIds: ["p1"] });
  });

  it("existing with the EQUAL window => skipped", async () => {
    const from = new Date(Date.now() + DAY);
    const to = new Date(Date.now() + 10 * DAY);
    const { res } = await run(existing({ effectiveFrom: from, effectiveTo: to }), {
      effectiveFrom: from.toISOString(),
      effectiveTo: to.toISOString(),
    });
    expect(res).toMatchObject({ created: 0, skipped: 1 });
  });

  it("existing bounded + requested ending later => CREATED", async () => {
    const now = Date.now();
    const { res } = await run(
      existing({ effectiveFrom: new Date(now - DAY), effectiveTo: new Date(now + 5 * DAY) }),
      { effectiveTo: new Date(now + 10 * DAY).toISOString() },
    );
    expect(res).toMatchObject({ created: 1, skipped: 0 });
  });

  it("the SQL read bounds the candidate window: starts no later, and (open request) no end", async () => {
    const { s } = await run(existing({ effectiveFrom: new Date(0), effectiveTo: null }));
    const and = JSON.stringify(s.rules.findMany.mock.calls[0][0].where.AND);
    expect(and).toContain("effectiveFrom");
    expect(and).toContain("lte");
  });
});

describe("row d: more than the cap is a 400", () => {
  const pipe = new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true });
  const validate = (body: object) =>
    pipe.transform(body, { type: "body", metatype: BulkRestrictionDto });

  it(`${BULK_RESTRICTION_MAX + 1} ids is a 400 with a clear message; ${BULK_RESTRICTION_MAX} pass`, async () => {
    const err = await validate({ ...bulk, productIds: ids(BULK_RESTRICTION_MAX + 1) }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(BadRequestException);
    expect(JSON.stringify((err as BadRequestException).getResponse())).toContain(
      `at most ${BULK_RESTRICTION_MAX} products`,
    );
    await expect(
      validate({ ...bulk, productIds: ids(BULK_RESTRICTION_MAX) }),
    ).resolves.toBeInstanceOf(BulkRestrictionDto);
  });

  it("the API cap equals the shared BULK_RESTRICTION_MAX_PRODUCTS", () => {
    const shared = (require("@routeflow/types") as { BULK_RESTRICTION_MAX_PRODUCTS: number })
      .BULK_RESTRICTION_MAX_PRODUCTS;
    expect(BULK_RESTRICTION_MAX).toBe(shared);
  });

  it("an empty productIds array and an unknown field are 400s", async () => {
    await expect(validate({ ...bulk, productIds: [] })).rejects.toBeInstanceOf(BadRequestException);
    await expect(validate({ ...bulk, productIds: ["p1"], extra: 1 })).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it("the service refuses an over-cap list too (defence in depth), writing nothing", async () => {
    const s = setup();
    await expect(
      s.service.bulkCreate({ ...bulk, productIds: ids(BULK_RESTRICTION_MAX + 1) }, user),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(s.prisma.tenantTransaction).not.toHaveBeenCalled();
  });
});

describe("row e: XOR and state validation are the SAME path as single create", () => {
  it.each([
    ["neither a category nor products", {}],
    ["both a category and products", { categoryId: "c1", productIds: ["p1"] }],
    ["a STATE rule with no states", { productIds: ["p1"], states: [] }],
    ["a FEDERAL rule that names states", { productIds: ["p1"], jurisdiction: "FEDERAL" }],
    ["a state that isn't one", { productIds: ["p1"], states: ["TX", "Tejas"] }],
    [
      "an end date not after the start",
      {
        productIds: ["p1"],
        effectiveFrom: "2026-10-01T00:00:00Z",
        effectiveTo: "2026-10-01T00:00:00Z",
      },
    ],
  ])(
    "bulk and single create both reject %s with the same message and write nothing",
    async (_n, over) => {
      const s = setup();
      const body: any = { ...bulk, ...over };
      const bulkErr = await s.service.bulkCreate(body, user).catch((e: unknown) => e);
      const { productIds, ...rest } = body;
      const single: any = { ...rest, reason: "x" };
      if (productIds) single.productId = productIds[0];
      const singleErr = await s.service.create(single, user).catch((e: unknown) => e);
      expect(bulkErr).toBeInstanceOf(BadRequestException);
      expect(singleErr).toBeInstanceOf(BadRequestException);
      expect((bulkErr as Error).message).toBe((singleErr as Error).message);
      expect(s.rules.create).not.toHaveBeenCalled();
      expect(s.store.audits).toHaveLength(0);
    },
  );

  it("FEDERAL with no states stores [] (TENANT_ADMIN only); state names become USPS codes", async () => {
    const s = setup();
    await s.service.bulkCreate(
      { jurisdiction: "FEDERAL", states: [], productIds: ["p1"] },
      { ...user, role: UserRole.TENANT_ADMIN },
    );
    expect(s.rules.create.mock.calls[0][0].data.states).toEqual([]);
    const t = setup();
    await t.service.bulkCreate(
      { ...bulk, states: ["Texas", "tx", " fl "], productIds: ["p1"] },
      user,
    );
    expect(t.rules.create.mock.calls[0][0].data.states).toEqual(["TX", "FL"]);
  });

  it("an unknown or archived label is the coded 409 RULE_TARGETS_NOT_FOUND, as in single create (was 404 / 409)", async () => {
    const s = setup();
    const err = await s.service
      .bulkCreate({ ...bulk, categoryId: "nope" }, user)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: "RULE_TARGETS_NOT_FOUND",
      notFoundIds: ["nope"],
    });
    expect(s.rules.create).not.toHaveBeenCalled();
  });

  it("refuses without a tenant context", async () => {
    const s = setup();
    (s.prisma.getTenantId as jest.Mock).mockReturnValue(null);
    await expect(
      s.service.bulkCreate({ ...bulk, productIds: ["p1"] }, user),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(s.prisma.tenantTransaction).not.toHaveBeenCalled();
  });
});

describe("tenant isolation", () => {
  it("a product id this tenant can't see (another tenant's) is the coded 409 and NOTHING is created", async () => {
    const s = setup({ foreignProductIds: ["other-tenant-p"] });
    const err = await s.service
      .bulkCreate({ ...bulk, productIds: ["p1", "other-tenant-p", "p2"] }, user)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: "RULE_TARGETS_NOT_FOUND",
      notFoundIds: ["other-tenant-p"],
    });
    expect(s.rules.create).not.toHaveBeenCalled();
    expect(s.targetRows.createMany).not.toHaveBeenCalled();
    expect(s.store.rules).toHaveLength(0);
    // The existence read is tenant-scoped.
    expect(s.models.product.findMany.mock.calls[0][0].where).toMatchObject({
      tenantId: "test-tenant",
    });
  });
});

describe("row j (create): OPERATOR and TENANT_ADMIN may create; CUSTOMER, DRIVER and buyers get 403", () => {
  const proto = SellingRestrictionsAdminController.prototype as unknown as Record<string, object>;
  const guard = new RolesGuard(new Reflector());
  const can = (user: Record<string, unknown>, handler: string) =>
    guard.canActivate({
      getHandler: () => proto[handler],
      getClass: () => SellingRestrictionsAdminController,
      switchToHttp: () => ({ getRequest: () => ({ user }) }),
    } as unknown as ExecutionContext);

  it.each(["create", "bulkCreate"])("%s", (handler) => {
    expect(can({ role: UserRole.OPERATOR }, handler)).toBe(true);
    expect(can({ role: UserRole.TENANT_ADMIN }, handler)).toBe(true);
    expect(can({ role: UserRole.CUSTOMER }, handler)).toBe(false);
    expect(can({ role: UserRole.DRIVER }, handler)).toBe(false);
    expect(can({ role: UserRole.DRIVER, canActAsDriver: true }, handler)).toBe(false);
    expect(can({ type: "BUYER" }, handler)).toBe(false); // the buyer-portal principal carries no role
  });
});
