import { NotFoundException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaService } from "../prisma/prisma.service";
import { AuditService } from "../audit/audit.service";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { createMockPrisma } from "../testing/prisma-mock";
import { ProductPortalVisibilityService } from "./product-portal-visibility.service";

describe("ProductPortalVisibilityService", () => {
  let service: ProductPortalVisibilityService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let audit: { log: jest.Mock };
  let gateway: { emitProductUpdated: jest.Mock };
  let order: string[];
  const tx = { product: { findMany: jest.fn(), updateMany: jest.fn() } };

  beforeEach(async () => {
    prisma = createMockPrisma();
    order = [];
    tx.product.findMany.mockReset().mockImplementation(async () => {
      order.push("findMany");
      return [];
    });
    tx.product.updateMany.mockReset().mockImplementation(async () => {
      order.push("updateMany");
      return { count: 1 };
    });
    (prisma as any).tenantTransaction = jest.fn(async (fn: (t: unknown) => unknown) => fn(tx));
    (prisma as any).getTenantId = jest.fn().mockReturnValue("t1");
    audit = { log: jest.fn().mockResolvedValue(undefined) };
    gateway = { emitProductUpdated: jest.fn() };
    const mod = await Test.createTestingModule({
      providers: [
        ProductPortalVisibilityService,
        { provide: PrismaService, useValue: prisma },
        { provide: AuditService, useValue: audit },
        { provide: RouteFlowGateway, useValue: gateway },
      ],
    }).compile();
    service = mod.get(ProductPortalVisibilityService);
  });

  it("single toggle writes, audits once (ids + old/new only) and emits once", async () => {
    tx.product.findMany.mockResolvedValue([{ id: "p1", portalVisible: true }]);
    const res = await service.setOne("p1", false, "u1");
    expect(res).toEqual({ id: "p1", portalVisible: false });
    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["p1"] } },
      data: { portalVisible: false },
    });
    expect(audit.log).toHaveBeenCalledTimes(1);
    expect(audit.log).toHaveBeenCalledWith({
      tenantId: "t1",
      userId: "u1",
      action: "product.portal_visibility_changed",
      entityType: "Product",
      entityId: "p1",
      meta: { from: true, to: false },
    });
    expect(gateway.emitProductUpdated).toHaveBeenCalledTimes(1);
    expect(gateway.emitProductUpdated).toHaveBeenCalledWith("t1", {
      productId: "p1",
      action: "updated",
    });
  });

  it("unchanged value is a 200 no-op: no write, no audit, no emit", async () => {
    tx.product.findMany.mockResolvedValue([{ id: "p1", portalVisible: false }]);
    await expect(service.setOne("p1", false, "u1")).resolves.toEqual({
      id: "p1",
      portalVisible: false,
    });
    expect(tx.product.updateMany).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
    expect(gateway.emitProductUpdated).not.toHaveBeenCalled();
  });

  it("unknown or foreign id -> 404, nothing written", async () => {
    tx.product.findMany.mockResolvedValue([]);
    await expect(service.setOne("nope", true, "u1")).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.product.updateMany).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
    expect(gateway.emitProductUpdated).not.toHaveBeenCalled();
  });

  it("bulk: one unknown id aborts everything and writes nothing", async () => {
    tx.product.findMany.mockResolvedValue([{ id: "p1", portalVisible: true }]);
    await expect(service.setBulk(["p1", "ghost"], false, "u1")).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(tx.product.updateMany).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
    expect(gateway.emitProductUpdated).not.toHaveBeenCalled();
  });

  it("bulk: id-set assertion happens BEFORE the many-write; updates only changed ids; one tx", async () => {
    tx.product.findMany.mockImplementation(async () => {
      order.push("findMany");
      return [
        { id: "p1", portalVisible: true },
        { id: "p2", portalVisible: false },
        { id: "p3", portalVisible: true },
      ];
    });
    const res = await service.setBulk(["p1", "p2", "p3"], false, "u1");
    expect(order).toEqual(["findMany", "updateMany"]);
    expect((prisma as any).tenantTransaction).toHaveBeenCalledTimes(1);
    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ["p1", "p3"] } },
      data: { portalVisible: false },
    });
    expect(res).toEqual({ portalVisible: false, updated: 2, unchanged: 1 });
    expect(audit.log).toHaveBeenCalledTimes(2);
    expect(audit.log.mock.calls.map((c) => c[0].entityId).sort()).toEqual(["p1", "p3"]);
    for (const [arg] of audit.log.mock.calls) expect(arg.meta).toEqual({ from: true, to: false });
    expect(gateway.emitProductUpdated).toHaveBeenCalledTimes(1);
    expect(gateway.emitProductUpdated).toHaveBeenCalledWith("t1", {
      productId: null,
      action: "bulk",
    });
  });

  it("bulk with nothing changed: no write, audit or emit", async () => {
    tx.product.findMany.mockResolvedValue([{ id: "p1", portalVisible: true }]);
    const res = await service.setBulk(["p1"], true, "u1");
    expect(res).toEqual({ portalVisible: true, updated: 0, unchanged: 1 });
    expect(tx.product.updateMany).not.toHaveBeenCalled();
    expect(audit.log).not.toHaveBeenCalled();
    expect(gateway.emitProductUpdated).not.toHaveBeenCalled();
  });
});
