import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { noRestrictionsProvider } from "../selling-restrictions/testing/no-restrictions-provider";
import { Test } from "@nestjs/testing";
import { NotFoundException } from "@nestjs/common";
import { StockAlertService } from "./stock-alert.service";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";
import { createMockPrisma } from "../testing/prisma-mock";

describe("StockAlertService (P5-03)", () => {
  let service: StockAlertService;
  let restrictions: { restrictedProductIdsFor: jest.Mock };
  let prisma: ReturnType<typeof createMockPrisma>;
  let notifications: { sendToCustomer: jest.Mock };

  beforeEach(async () => {
    prisma = createMockPrisma();
    notifications = { sendToCustomer: jest.fn().mockResolvedValue(undefined) };

    const mod = await Test.createTestingModule({
      providers: [
        StockAlertService,
        { provide: PrismaService, useValue: prisma },
        { provide: NotificationsService, useValue: notifications },
        noRestrictionsProvider,
      ],
    }).compile();
    service = mod.get(StockAlertService);
    restrictions = mod.get(SellingRestrictionsService) as unknown as typeof restrictions;
    restrictions.restrictedProductIdsFor.mockReset().mockResolvedValue(new Set<string>());
  });

  it("subscribe: idempotent upsert to PENDING on (tenant, customer, product)", async () => {
    prisma.product.findFirst.mockResolvedValue({ id: "p1" });

    const first = await service.subscribe("cust-1", "p1", "tenant-1");
    const second = await service.subscribe("cust-1", "p1", "tenant-1");

    expect(first).toEqual({ subscribed: true });
    expect(second).toEqual({ subscribed: true });
    expect(prisma.stockAlert.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.stockAlert.upsert).toHaveBeenCalledWith({
      where: {
        tenantId_customerId_productId: {
          tenantId: "tenant-1",
          customerId: "cust-1",
          productId: "p1",
        },
      },
      create: { tenantId: "tenant-1", customerId: "cust-1", productId: "p1", status: "PENDING" },
      update: { status: "PENDING", notifiedAt: null },
    });
  });

  it("subscribe: 404 when the product is missing or inactive", async () => {
    prisma.product.findFirst.mockResolvedValue(null);
    await expect(service.subscribe("cust-1", "nope", "tenant-1")).rejects.toThrow(
      NotFoundException,
    );
    expect(prisma.stockAlert.upsert).not.toHaveBeenCalled();
  });

  it("unsubscribe: deleteMany by customer+product (no-op safe)", async () => {
    await expect(service.unsubscribe("cust-1", "p1")).resolves.toEqual({ subscribed: false });
    expect(prisma.stockAlert.deleteMany).toHaveBeenCalledWith({
      where: { customerId: "cust-1", productId: "p1" },
    });
  });

  it("subscriptionsFor: only PENDING product ids", async () => {
    prisma.stockAlert.findMany.mockResolvedValue([{ productId: "p1" }, { productId: "p2" }]);
    await expect(service.subscriptionsFor("cust-1")).resolves.toEqual({
      productIds: ["p1", "p2"],
    });
    expect(prisma.stockAlert.findMany).toHaveBeenCalledWith({
      where: { customerId: "cust-1", status: "PENDING" },
      select: { productId: true },
    });
  });

  it("fire: exactly one notification per PENDING alert, each flipped to NOTIFIED", async () => {
    prisma.product.findFirst.mockResolvedValue({ id: "p1", name: "Cola 24pk", currentStock: 12 });
    prisma.stockAlert.findMany.mockResolvedValue([
      { id: "a1", customerId: "c1", productId: "p1", status: "PENDING" },
      { id: "a2", customerId: "c2", productId: "p1", status: "PENDING" },
    ]);
    // Each atomic claim wins (row still PENDING).
    prisma.stockAlert.updateMany.mockResolvedValue({ count: 1 });

    const res = await service.fireForProducts(["p1", "p1"]);

    expect(res).toEqual({ notified: 2 });
    expect(prisma.product.findFirst).toHaveBeenCalledTimes(1);
    expect(notifications.sendToCustomer).toHaveBeenCalledTimes(2);
    expect(notifications.sendToCustomer).toHaveBeenCalledWith(
      "c1",
      "Back in stock",
      expect.stringContaining("Cola 24pk"),
      { type: "STOCK_ALERT", productId: "p1" },
    );
    // Claim is a status-guarded updateMany, run BEFORE the push.
    expect(prisma.stockAlert.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.stockAlert.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: "a1", status: "PENDING" },
      data: { status: "NOTIFIED", notifiedAt: expect.any(Date) },
    });
  });

  it("fire: a buyer a selling restriction hides this product from gets no push, and their alert is left PENDING", async () => {
    prisma.product.findFirst.mockResolvedValue({ id: "p1", name: "Cola 24pk", currentStock: 12 });
    prisma.stockAlert.findMany.mockResolvedValue([
      { id: "a1", tenantId: "t1", customerId: "c1", productId: "p1", status: "PENDING" },
      { id: "a2", tenantId: "t1", customerId: "c2", productId: "p1", status: "PENDING" },
    ]);
    prisma.stockAlert.updateMany.mockResolvedValue({ count: 1 });
    // c1 is restricted for p1 (a state limit); c2 is not
    restrictions.restrictedProductIdsFor.mockImplementation(
      async (_t: string, customerId: string) =>
        customerId === "c1" ? new Set(["p1"]) : new Set<string>(),
    );

    const res = await service.fireForProducts(["p1"]);

    expect(res).toEqual({ notified: 1 });
    expect(notifications.sendToCustomer).toHaveBeenCalledTimes(1);
    expect(notifications.sendToCustomer.mock.calls[0][0]).toBe("c2");
    // c1's alert is never claimed: it stays PENDING and fires if the limit is lifted before the next restock
    expect(prisma.stockAlert.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.stockAlert.updateMany.mock.calls[0][0]).toMatchObject({ where: { id: "a2" } });
  });

  it("fire: when the restriction read fails the buyer is not pushed (fail closed) and the other alerts still fire", async () => {
    prisma.product.findFirst.mockResolvedValue({ id: "p1", name: "Cola 24pk", currentStock: 12 });
    prisma.stockAlert.findMany.mockResolvedValue([
      { id: "a1", tenantId: "t1", customerId: "c1", productId: "p1", status: "PENDING" },
      { id: "a2", tenantId: "t1", customerId: "c2", productId: "p1", status: "PENDING" },
    ]);
    prisma.stockAlert.updateMany.mockResolvedValue({ count: 1 });
    restrictions.restrictedProductIdsFor.mockImplementation(
      async (_t: string, customerId: string) => {
        if (customerId === "c1") throw new Error("db down");
        return new Set<string>();
      },
    );

    const res = await service.fireForProducts(["p1"]);

    expect(res).toEqual({ notified: 1 });
    expect(notifications.sendToCustomer.mock.calls.map((c: any[]) => c[0])).toEqual(["c2"]);
  });

  it("fire: one restriction read per customer, not per product", async () => {
    prisma.product.findFirst.mockResolvedValue({ id: "p1", name: "Cola 24pk", currentStock: 12 });
    prisma.stockAlert.findMany.mockResolvedValue([
      { id: "a1", tenantId: "t1", customerId: "c1", productId: "p1", status: "PENDING" },
    ]);
    prisma.stockAlert.updateMany.mockResolvedValue({ count: 1 });
    restrictions.restrictedProductIdsFor.mockClear();
    restrictions.restrictedProductIdsFor.mockResolvedValue(new Set<string>());

    await service.fireForProducts(["p1", "p2"]);

    expect(restrictions.restrictedProductIdsFor).toHaveBeenCalledTimes(1);
  });

  it("fire: a lost atomic claim (concurrent restock already took it) sends no push", async () => {
    prisma.product.findFirst.mockResolvedValue({ id: "p1", name: "Cola 24pk", currentStock: 12 });
    prisma.stockAlert.findMany.mockResolvedValue([
      { id: "a1", customerId: "c1", productId: "p1", status: "PENDING" },
    ]);
    // The row was already flipped by a concurrent fire between the read and claim.
    prisma.stockAlert.updateMany.mockResolvedValue({ count: 0 });

    const res = await service.fireForProducts(["p1"]);

    expect(res).toEqual({ notified: 0 });
    expect(notifications.sendToCustomer).not.toHaveBeenCalled();
  });

  it("fire: second fire is a no-op (no PENDING rows remain)", async () => {
    prisma.product.findFirst.mockResolvedValue({ id: "p1", name: "Cola 24pk", currentStock: 12 });
    prisma.stockAlert.findMany.mockResolvedValue([]);

    const res = await service.fireForProducts(["p1"]);

    expect(res).toEqual({ notified: 0 });
    expect(notifications.sendToCustomer).not.toHaveBeenCalled();
    expect(prisma.stockAlert.updateMany).not.toHaveBeenCalled();
  });

  it("fire: in-stock guard — no fire while on-hand <= 0", async () => {
    prisma.product.findFirst.mockResolvedValue({ id: "p1", name: "Cola 24pk", currentStock: 0 });

    const res = await service.fireForProducts(["p1"]);

    expect(res).toEqual({ notified: 0 });
    expect(prisma.stockAlert.findMany).not.toHaveBeenCalled();
    expect(notifications.sendToCustomer).not.toHaveBeenCalled();
  });

  it("fire: a push failure is swallowed and the entry is STILL cleared", async () => {
    prisma.product.findFirst.mockResolvedValue({ id: "p1", name: "Cola 24pk", currentStock: 3 });
    prisma.stockAlert.findMany.mockResolvedValue([
      { id: "a1", customerId: "c1", productId: "p1", status: "PENDING" },
    ]);
    prisma.stockAlert.updateMany.mockResolvedValue({ count: 1 });
    notifications.sendToCustomer.mockRejectedValue(new Error("expo down"));

    await expect(service.fireForProducts(["p1"])).resolves.toEqual({ notified: 1 });
    // The entry is claimed (cleared) BEFORE the push, so a failed push still leaves it NOTIFIED.
    expect(prisma.stockAlert.updateMany).toHaveBeenCalledWith({
      where: { id: "a1", status: "PENDING" },
      data: { status: "NOTIFIED", notifiedAt: expect.any(Date) },
    });
  });
});
