import { BadRequestException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { ROLES_KEY } from "../auth/decorators/roles.decorator";
import { activeRuleWhere } from "../selling-restrictions/selling-restrictions.core";
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

describe("SellingRestrictionsAdminService.list", () => {
  function setup() {
    const prisma = createMockPrisma();
    const rules = { findMany: jest.fn().mockResolvedValue([]) };
    (prisma.forTenant() as any).sellingRestriction = rules;
    return { prisma, rules, service: new SellingRestrictionsAdminService(prisma) };
  }

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

describe("SellingRestrictionsAdminController", () => {
  it("reads are OPERATOR and the class is behind both guards", () => {
    const proto = SellingRestrictionsAdminController.prototype as unknown as Record<string, object>;
    expect(Reflect.getMetadata(ROLES_KEY, proto.list)).toEqual([UserRole.OPERATOR]);
    const guards = (
      Reflect.getMetadata("__guards__", SellingRestrictionsAdminController) ?? []
    ).map((g: { name: string }) => g.name);
    expect(guards).toEqual(expect.arrayContaining(["JwtAuthGuard", "RolesGuard"]));
  });
});
