// InvoicesService / NotificationsService import ESM-only modules Jest's CommonJS parser cannot load.
jest.mock("../invoices/invoices.service", () => ({ InvoicesService: class InvoicesService {} }));
jest.mock("../notifications/notifications.service", () => ({
  NotificationsService: class NotificationsService {},
}));

import { ForbiddenException } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { ConfigService } from "@nestjs/config";
import { OrdersService } from "./orders.service";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { createMockPrisma } from "../testing/prisma-mock";

const autoMock = () =>
  new Proxy({} as Record<string | symbol, jest.Mock>, {
    get: (t, k) =>
      k === "then" || typeof k === "symbol"
        ? undefined
        : (t[k] ??= jest.fn().mockResolvedValue(undefined)),
  });

describe("OrdersService.create: an explicit PICKUP needs the till (BO-07)", () => {
  let service: OrdersService;
  let prisma: ReturnType<typeof createMockPrisma>;
  const user = (role: string) => ({ sub: "user-1", username: "u", role, tenantId: "t-1" }) as never;
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
  const pickup = {
    customerId: "cust-1",
    items: [{ productId: "prod-1", qty: 1 }],
    fulfillPath: "PICKUP",
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

  const denyOrders = (groups: string[]) =>
    prisma.user.findFirst.mockResolvedValue({
      deniedPermissionGroups: groups,
      permissionsVersion: 1,
    });

  it("an operator denied the till (ORDERS) is refused 403 PERMISSION_DENIED, the guard's own body; nothing is written", async () => {
    denyOrders(["ORDERS"]);
    const err = await service
      .create(pickup as never, user("OPERATOR"), { skipAutoMerge: true })
      .catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toMatchObject({
      statusCode: 403,
      code: "PERMISSION_DENIED",
      groups: ["ORDERS"],
    });
    expect(prisma.order.create).not.toHaveBeenCalled();
  });

  it("control: an operator who holds the till still creates the PICKUP order", async () => {
    denyOrders([]);
    await service.create(pickup as never, user("OPERATOR"), { skipAutoMerge: true });
    expect(prisma.order.create.mock.calls[0][0].data.fulfillPath).toBe("PICKUP");
  });

  it("control: a tenant admin creates the PICKUP order with no permissions read", async () => {
    await service.create(pickup as never, user("TENANT_ADMIN"), { skipAutoMerge: true });
    expect(prisma.order.create.mock.calls[0][0].data.fulfillPath).toBe("PICKUP");
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it("control: a denied operator still creates a NON-pickup order (the till is only the PICKUP path)", async () => {
    denyOrders(["ORDERS"]);
    const { fulfillPath: _omit, ...delivery } = pickup;
    await service.create(delivery as never, user("OPERATOR"), { skipAutoMerge: true });
    expect(prisma.order.create.mock.calls[0][0].data.fulfillPath).toBe("ROUTE");
  });
});
