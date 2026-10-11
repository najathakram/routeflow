// InvoicesService / NotificationsService import ESM-only modules Jest's CommonJS parser cannot load.
jest.mock("../invoices/invoices.service", () => ({ InvoicesService: class InvoicesService {} }));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: class NotificationsService {},
}));

import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { OrdersService } from "./orders.service";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { createMockPrisma } from "../testing/prisma-mock";

/**
 * SA-655: create() takes two INTERNAL options for the counter sale — `fulfillPath` (PICKUP is not a
 * writable DTO value, so it can only arrive here) and `onReplay` (the signal that the order handed
 * back is an Idempotency-Key replay, fired from BOTH replay exits: the pre-check and the P2002 race).
 * Existing callers pass neither and are unchanged.
 */
const autoMock = () =>
  new Proxy({} as Record<string | symbol, jest.Mock>, {
    get: (t, k) =>
      k === "then" || typeof k === "symbol"
        ? undefined
        : (t[k] ??= jest.fn().mockResolvedValue(undefined)),
  });

describe("OrdersService.create — counter-sale options", () => {
  let service: OrdersService;
  let prisma: ReturnType<typeof createMockPrisma>;
  const staff = {
    sub: "user-op",
    username: "operator",
    role: "OPERATOR",
    tenantId: "t-1",
  } as never;
  const PRODUCT = {
    id: "prod-1",
    name: "Widget",
    unit: "Box",
    pricePerUnit: 5,
    unitsPerBox: 1,
    category: null,
    trackedCategoryId: null,
    trackedSubcategoryId: null,
    isActive: true,
    kind: "STANDARD",
    portalVisible: true,
    parent: null,
  };
  const original = {
    id: "ord-old",
    customerId: "cust-1",
    lineItems: [{ productId: "prod-1", qty: 1, status: "PENDING" }],
  };
  const body = {
    customerId: "cust-1",
    items: [{ productId: "prod-1", qty: 1 }],
    idempotencyKey: "k1",
  };

  beforeEach(async () => {
    prisma = createMockPrisma();
    const module = await Test.createTestingModule({ providers: [OrdersService] })
      .useMocker((token) => {
        if (token === PrismaService) return prisma;
        if (token === ConfigService) return { get: jest.fn().mockReturnValue(0.1) };
        if (token === EntitlementsService) return { hasFlag: jest.fn().mockResolvedValue(true) };
        return autoMock();
      })
      .compile();
    service = module.get(OrdersService);
    prisma.customer.findFirst.mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
      fulfillPath: "ROUTE",
    });
    prisma.customer.findUnique.mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
      user: { status: "ACTIVE" },
      deletedAt: null,
    });
    prisma.product.findMany.mockResolvedValue([PRODUCT]);
    prisma.order.create.mockResolvedValue({
      id: "ord-new",
      customerId: "cust-1",
      orderNumber: "x",
      total: 0,
      urgent: false,
      createdAt: new Date(),
      customer: { id: "cust-1", businessName: "Acme" },
      lineItems: [],
    });
    (prisma.tenantTransaction as jest.Mock).mockImplementation((fn: any) =>
      fn({
        ...prisma,
        $queryRaw: jest.fn().mockResolvedValue([{ max: null }]),
        $executeRaw: jest.fn().mockResolvedValue(0),
      }),
    );
  });

  it("options.fulfillPath PICKUP is written to the order (beats the customer's ROUTE default)", async () => {
    await service.create({ ...body, idempotencyKey: undefined } as never, staff, {
      skipAutoMerge: true,
      fulfillPath: "PICKUP" as never,
    });
    expect(prisma.order.create.mock.calls[0][0].data.fulfillPath).toBe("PICKUP");
  });

  it("options.counterSale writes counterSale: true; without it the column is not written (SA-672e)", async () => {
    await service.create({ ...body, idempotencyKey: undefined } as never, staff, {
      skipAutoMerge: true,
      fulfillPath: "PICKUP" as never,
      counterSale: true,
    });
    expect(prisma.order.create.mock.calls[0][0].data.counterSale).toBe(true);
    prisma.order.create.mockClear();
    await service.create({ ...body, idempotencyKey: undefined } as never, staff, {
      skipAutoMerge: true,
      fulfillPath: "PICKUP" as never,
    });
    expect(prisma.order.create.mock.calls[0][0].data).not.toHaveProperty("counterSale");
  });

  it("a counter sale stamps soldById with the acting staff user; any other order does not write it (row 317)", async () => {
    await service.create({ ...body, idempotencyKey: undefined } as never, staff, {
      skipAutoMerge: true,
      fulfillPath: "PICKUP" as never,
      counterSale: true,
    });
    expect(prisma.order.create.mock.calls[0][0].data.soldById).toBe("user-op");
    prisma.order.create.mockClear();
    await service.create({ ...body, idempotencyKey: undefined } as never, staff, {
      skipAutoMerge: true,
      fulfillPath: "PICKUP" as never,
    });
    expect(prisma.order.create.mock.calls[0][0].data).not.toHaveProperty("soldById");
  });

  it("a replay of a counter sale writes nothing, so the first cashier's soldById is never overwritten (row 317)", async () => {
    jest.spyOn(service as any, "findReplayCandidateByKey").mockResolvedValue(original);
    const otherStaff = { ...(staff as object), sub: "user-other" } as never;
    await service.create(body as never, otherStaff, {
      skipAutoMerge: true,
      counterSale: true,
      onReplay: jest.fn(),
    } as never);
    expect(prisma.order.create).not.toHaveBeenCalled();
    expect(prisma.order.update).not.toHaveBeenCalled();
    expect(prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it("without the option the customer default still decides (unchanged)", async () => {
    await service.create({ ...body, idempotencyKey: undefined } as never, staff, {
      skipAutoMerge: true,
    });
    expect(prisma.order.create.mock.calls[0][0].data.fulfillPath).toBe("ROUTE");
  });

  it("onReplay fires on the pre-check replay, with the original order, and nothing is written", async () => {
    jest.spyOn(service as any, "findReplayCandidateByKey").mockResolvedValue(original);
    const onReplay = jest.fn();
    await expect(
      service.create(body as never, staff, { skipAutoMerge: true, onReplay } as never),
    ).resolves.toBe(original);
    expect(onReplay).toHaveBeenCalledTimes(1);
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it("onReplay fires on the concurrent-race replay (P2002 on the key) too", async () => {
    jest
      .spyOn(service as any, "findReplayCandidateByKey")
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(original);
    prisma.order.create.mockRejectedValue(
      Object.assign(new Error("dup"), {
        code: "P2002",
        meta: { target: ["tenantId", "idempotencyKey"] },
      }),
    );
    const onReplay = jest.fn();
    await expect(
      service.create(body as never, staff, { skipAutoMerge: true, onReplay } as never),
    ).resolves.toBe(original);
    expect(onReplay).toHaveBeenCalledTimes(1);
  });

  it("a fresh create never fires onReplay", async () => {
    jest.spyOn(service as any, "findReplayCandidateByKey").mockResolvedValue(null);
    const onReplay = jest.fn();
    await service.create(body as never, staff, { skipAutoMerge: true, onReplay } as never);
    expect(onReplay).not.toHaveBeenCalled();
  });
});
