import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { activeRuleWhere } from "../selling-restrictions/selling-restrictions.core";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { createMockPrisma } from "../testing/prisma-mock";
import { SellingRestrictionsAdminController } from "./selling-restrictions-admin.controller";
import {
  SellingRestrictionsAdminService,
  restrictionStatus,
  statusWhere,
} from "./selling-restrictions-admin.service";

const NOW = new Date("2026-09-20T12:00:00Z");
const DAY = 86_400_000;
const row = (over: Record<string, unknown> = {}) => ({
  id: "r1",
  tenantId: "t",
  categoryId: "c1",
  productId: null,
  jurisdiction: "STATE",
  states: ["TX"],
  surface: "ALL",
  effectiveFrom: new Date(NOW.getTime() - DAY),
  effectiveTo: null,
  reason: "why",
  createdById: "u1",
  createdByName: "admin",
  createdAt: NOW,
  liftedById: null,
  liftedByName: null,
  liftedAt: null,
  liftReason: null,
  category: { name: "Alcohol" },
  product: null,
  ...over,
});

describe("restrictionStatus (the engine's own window rule)", () => {
  it.each([
    ["in force", {}, "ACTIVE"],
    ["not started", { effectiveFrom: new Date(NOW.getTime() + DAY) }, "SCHEDULED"],
    ["ended exactly now (exclusive)", { effectiveTo: NOW }, "EXPIRED"],
    ["lifted in the past", { liftedAt: new Date(NOW.getTime() - 1) }, "LIFTED"],
    [
      "a lift scheduled for later is still in force",
      { liftedAt: new Date(NOW.getTime() + DAY) },
      "ACTIVE",
    ],
  ])("%s => %s", (_n, over, want) => {
    expect(restrictionStatus(row(over) as any, NOW)).toBe(want);
  });
});

const user = { sub: "u1", username: "admin" } as JwtPayload;
// Row 509 (SA condition 5): an all-customer (FEDERAL) rule is TENANT_ADMIN-only.
const tenantAdmin = { ...user, role: UserRole.TENANT_ADMIN } as JwtPayload;

function setup() {
  const prisma = createMockPrisma();
  const models = prisma.forTenant() as any;
  const rules = {
    findMany: jest.fn().mockResolvedValue([]),
    findFirst: jest.fn(),
    create: jest.fn(),
    createMany: jest.fn().mockResolvedValue({ count: 1 }),
    updateMany: jest.fn(),
  };
  models.sellingRestriction = rules;
  // Row 509: a rule's targets are written as rows, read back as a summary (raw SQL) and the lift takes a row lock.
  const targetRows = { createMany: jest.fn().mockResolvedValue({ count: 1 }) };
  models.sellingRestrictionTarget = targetRows;
  models.$queryRaw = jest.fn().mockResolvedValue([]);
  // `findMany` resolves the target ids (non-archived labels only): "c1" is the one label this tenant has.
  models.productCategory = {
    findMany: jest.fn(async (a: any) =>
      (a?.where?.id?.in ?? []).filter((id: string) => id === "c1").map((id: string) => ({ id })),
    ),
  };
  models.product.findMany.mockResolvedValue([{ id: "p1" }]);
  const labels = { effectiveLabels: jest.fn() };
  return {
    prisma,
    models,
    rules,
    targetRows,
    service: new SellingRestrictionsAdminService(prisma, labels as any),
  };
}

describe("SellingRestrictionsAdminService.list", () => {
  it("computes each rule's status, and a status filter is applied in SQL before the read cap", async () => {
    const s = setup();
    s.rules.findMany.mockResolvedValue([
      row({ id: "a" }),
      row({ id: "b", effectiveFrom: new Date(Date.now() + DAY) }),
      row({ id: "c", liftedAt: new Date(Date.now() - DAY) }),
    ]);
    expect((await s.service.list()).map((r) => `${r.id}:${r.status}`)).toEqual([
      "a:ACTIVE",
      "b:SCHEDULED",
      "c:LIFTED",
    ]);
    expect(s.rules.findMany.mock.calls[0][0].where).toEqual({}); // no filter => all
    await s.service.list("LIFTED");
    const call = s.rules.findMany.mock.calls[1][0];
    expect(call.where).toEqual(statusWhere("LIFTED", call.where.liftedAt.lte));
    expect(call.take).toBe(500); // the cap applies AFTER the filter
    await s.service.list("ACTIVE");
    const where = s.rules.findMany.mock.calls[2][0].where;
    expect(where).toEqual(activeRuleWhere(where.effectiveFrom.lte));
  });

  it("returns display names and refuses without a tenant context", async () => {
    const s = setup();
    s.rules.findMany.mockResolvedValue([row()]);
    expect((await s.service.list())[0]).toMatchObject({
      categoryName: "Alcohol",
      productName: null,
    });
    (s.prisma.getTenantId as jest.Mock).mockReturnValue(null);
    await expect(s.service.list()).rejects.toBeInstanceOf(BadRequestException);
  });
});

const base = {
  categoryId: "c1",
  jurisdiction: "STATE" as const,
  states: ["TX"],
  reason: "Statute 12",
};

describe("SellingRestrictionsAdminService.create", () => {
  it.each([
    ["neither a category nor a product", { categoryId: undefined }],
    ["both a category and a product", { productId: "p1" }],
    ["a STATE rule with no states", { states: [] }],
    ["a FEDERAL rule that names states", { jurisdiction: "FEDERAL" as const }],
    ["a state that isn't one", { states: ["TX", "Tejas"] }],
    [
      "an end date not after the start",
      { effectiveFrom: "2026-10-01T00:00:00Z", effectiveTo: "2026-10-01T00:00:00Z" },
    ],
  ])("rejects %s and writes nothing", async (_n, over) => {
    const s = setup();
    await expect(s.service.create({ ...base, ...over } as any, user)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(s.rules.create).not.toHaveBeenCalled();
    expect(s.targetRows.createMany).not.toHaveBeenCalled();
  });

  it("stores state names as de-duplicated USPS codes, stamped with tenant and user, then audits in the same transaction", async () => {
    const s = setup();
    s.rules.findFirst.mockResolvedValue(row({ states: ["TX", "FL"] }));
    await s.service.create({ ...base, states: ["Texas", "tx", " fl "] }, user);
    expect(s.rules.create).toHaveBeenCalledTimes(1);
    expect(s.targetRows.createMany).toHaveBeenCalledTimes(1);
    const data = s.rules.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      tenantId: "test-tenant",
      categoryId: "c1",
      productId: null,
      jurisdiction: "STATE",
      states: ["TX", "FL"],
      surface: "ALL",
      createdById: "u1",
      createdByName: "admin",
    });
    expect(data.effectiveFrom).toBeInstanceOf(Date);
    // Row 509: one target row for the one label, stamped with the rule's id, tenant and creator.
    expect(s.targetRows.createMany.mock.calls[0][0].data).toEqual([
      expect.objectContaining({
        tenantId: "test-tenant",
        ruleId: data.id,
        productId: null,
        categoryId: "c1",
        addedById: "u1",
        addedByName: "admin",
      }),
    ]);
    expect(s.models.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "selling_restriction.created", entityId: "r1" }),
    });
    // The response is still the single rule's list item (the web's create caller reads it).
    expect(s.rules.findFirst.mock.calls[0][0].where).toEqual({
      id: data.id,
      tenantId: "test-tenant",
    });
  });

  it("a FEDERAL rule stores no states; a product-scoped rule needs the product to exist", async () => {
    const s = setup();
    s.rules.findFirst.mockResolvedValue(row({ jurisdiction: "FEDERAL", states: [] }));
    await s.service.create({ productId: "p1", jurisdiction: "FEDERAL", reason: "x" }, tenantAdmin);
    expect(s.rules.create.mock.calls[0][0].data).toMatchObject({
      productId: "p1",
      categoryId: null,
      states: [],
    });
    s.models.product.findMany.mockResolvedValue([]);
    // Row 509: an unknown id is the coded 409 RULE_TARGETS_NOT_FOUND (was a plain 404).
    const err = await s.service
      .create({ productId: "nope", jurisdiction: "FEDERAL", reason: "x" }, tenantAdmin)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect((err as ConflictException).getResponse()).toMatchObject({
      code: "RULE_TARGETS_NOT_FOUND",
      notFoundIds: ["nope"],
    });
  });

  it("an unknown or archived label is RULE_TARGETS_NOT_FOUND (409, was 404 / 409), and a tenant context is needed", async () => {
    const s = setup();
    // unknown AND archived both resolve to "not among the tenant's non-archived labels"
    await expect(s.service.create({ ...base, categoryId: "gone" }, user)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(s.models.productCategory.findMany.mock.calls[0][0].where).toMatchObject({
      tenantId: "test-tenant",
      archivedAt: null,
    });
    (s.prisma.getTenantId as jest.Mock).mockReturnValue(null);
    await expect(s.service.create(base, user)).rejects.toBeInstanceOf(BadRequestException);
    expect(s.rules.create).not.toHaveBeenCalled();
  });
});

describe("SellingRestrictionsAdminService.lift", () => {
  it("lifts through a write guarded on liftedAt IS NULL, then audits", async () => {
    const s = setup();
    s.rules.updateMany.mockResolvedValue({ count: 1 });
    s.rules.findFirst.mockResolvedValue(row({ liftedAt: NOW }));
    await s.service.lift("r1", { reason: "Law repealed" }, user);
    const call = s.rules.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({ tenantId: "test-tenant", id: { in: ["r1"] }, liftedAt: null });
    expect(call.data).toMatchObject({
      liftedById: "u1",
      liftedByName: "admin",
      liftReason: "Law repealed",
    });
    expect(s.models.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ action: "selling_restriction.lifted", entityId: "r1" }),
    });
  });

  it("a second lift is a 409 and never overwrites; an unknown id is a 404; needs a tenant", async () => {
    const s = setup();
    s.rules.updateMany.mockResolvedValue({ count: 0 });
    s.rules.findFirst.mockResolvedValue(row({ liftedAt: NOW }));
    await expect(s.service.lift("r1", { reason: "x" }, user)).rejects.toBeInstanceOf(
      ConflictException,
    );
    s.rules.findFirst.mockResolvedValue(null);
    await expect(s.service.lift("nope", { reason: "x" }, user)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    (s.prisma.getTenantId as jest.Mock).mockReturnValue(null);
    await expect(s.service.lift("r1", { reason: "x" }, user)).rejects.toBeInstanceOf(
      BadRequestException,
    );
    expect(s.models.auditLog.create).not.toHaveBeenCalled();
  });
});

describe("SellingRestrictionsAdminController", () => {
  it("reads, create and lift are OPERATOR (TENANT_ADMIN satisfies it), and the class is behind both guards", () => {
    const proto = SellingRestrictionsAdminController.prototype as unknown as Record<string, object>;
    expect(Reflect.getMetadata(ROLES_KEY, proto.list)).toEqual([UserRole.OPERATOR]);
    expect(Reflect.getMetadata(ROLES_KEY, proto.create)).toEqual([UserRole.OPERATOR]);
    expect(Reflect.getMetadata(ROLES_KEY, proto.bulkCreate)).toEqual([UserRole.OPERATOR]);
    expect(Reflect.getMetadata(ROLES_KEY, proto.lift)).toEqual([UserRole.OPERATOR]);
    expect(Reflect.getMetadata(ROLES_KEY, proto.liftBatch)).toEqual([UserRole.OPERATOR]);
    const guards = (
      Reflect.getMetadata("__guards__", SellingRestrictionsAdminController) ?? []
    ).map((g: { name: string }) => g.name);
    expect(guards).toEqual(expect.arrayContaining(["JwtAuthGuard", "RolesGuard"]));
  });
});
