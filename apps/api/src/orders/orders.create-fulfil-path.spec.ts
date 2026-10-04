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
import { FULFILMENT_CAPABILITY_READER } from "./counter-sale/fulfilment-capability-reader";
import type { FulfilmentCapability } from "./counter-sale/capability-shape";

/**
 * SA-655 item 10, wiring: OrdersService.create resolves the order's fulfil path through the ONE
 * resolver (resolve-fulfil-path.ts) against the caller's tenant capability. Staff and the buyer portal
 * both arrive here (the buyer controller calls create() with a CUSTOMER pseudo-user). An unset tenant is
 * exactly today.
 */
const autoMock = () =>
  new Proxy({} as Record<string | symbol, jest.Mock>, {
    get: (t, k) =>
      k === "then" || typeof k === "symbol"
        ? undefined
        : (t[k] ??= jest.fn().mockResolvedValue(undefined)),
  });

const cap = (methods: FulfilmentCapability["methods"]): FulfilmentCapability => ({
  methods,
  staffDefault: methods[0],
  staffOpensAs: "counter",
  portalMethods: methods,
  portalDefault: methods[0],
  counter: "always",
  fleet: true,
  consistent: true,
});

describe("OrdersService.create — capability-aware fulfil path", () => {
  let service: OrdersService;
  let prisma: ReturnType<typeof createMockPrisma>;
  let reader: { get: jest.Mock };
  const staff = {
    sub: "user-op",
    username: "operator",
    role: "OPERATOR",
    tenantId: "t-1",
  } as never;
  const buyer = { sub: "user-cust", role: "CUSTOMER", type: "BUYER", tenantId: "t-1" } as never;
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
  const body = (extra: object = {}) =>
    ({ customerId: "cust-1", items: [{ productId: "prod-1", qty: 1 }], ...extra }) as never;
  const written = () => prisma.order.create.mock.calls[0][0].data.fulfillPath;

  async function build(withReader: boolean) {
    prisma = createMockPrisma();
    reader = { get: jest.fn().mockResolvedValue(undefined) };
    const module = await Test.createTestingModule({ providers: [OrdersService] })
      .useMocker((token) => {
        if (token === PrismaService) return prisma;
        if (token === ConfigService) return { get: jest.fn().mockReturnValue(0.1) };
        if (token === EntitlementsService) return { hasFlag: jest.fn().mockResolvedValue(true) };
        if (token === FULFILMENT_CAPABILITY_READER && withReader) return reader;
        return autoMock();
      })
      .compile();
    service = module.get(OrdersService);
    const customer = {
      id: "cust-1",
      pricingTier: 1,
      fulfillPath: "ROUTE",
      user: { status: "ACTIVE" },
      deletedAt: null,
    };
    prisma.customer.findFirst.mockResolvedValue(customer);
    prisma.customer.findUnique.mockResolvedValue(customer);
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
  }

  describe("unset tenant (reader yields the unset capability or none): exactly today", () => {
    beforeEach(() => build(true));
    it("customer default ROUTE -> ROUTE, explicit SHIP -> SHIP", async () => {
      await service.create(body(), staff, { skipAutoMerge: true });
      expect(written()).toBe("ROUTE");
      prisma.order.create.mockClear();
      await service.create(body({ fulfillPath: "SHIP" }), staff, { skipAutoMerge: true });
      expect(written()).toBe("SHIP");
    });
    it("a staff PICKUP request is refused 400 and nothing is written", async () => {
      await expect(
        service.create(body({ fulfillPath: "PICKUP" }), staff, { skipAutoMerge: true }),
      ).rejects.toMatchObject({ status: 400 });
      expect(prisma.order.create).not.toHaveBeenCalled();
    });
    it("a buyer PICKUP request is refused 400 too", async () => {
      await expect(
        service.create(body({ fulfillPath: "PICKUP" }), buyer, { skipAutoMerge: true }),
      ).rejects.toMatchObject({ status: 400 });
      expect(prisma.order.create).not.toHaveBeenCalled();
    });
  });

  describe("module without a bound reader", () => {
    beforeEach(() => build(false));
    it("is today: customer default decides", async () => {
      await service.create(body(), staff, { skipAutoMerge: true });
      expect(written()).toBe("ROUTE");
    });
  });

  describe("mode pickup", () => {
    beforeEach(async () => {
      await build(true);
      reader.get.mockResolvedValue(cap(["PICKUP"]));
    });
    it("staff: no request and the customer's ROUTE default resolve PICKUP", async () => {
      await service.create(body(), staff, { skipAutoMerge: true });
      expect(written()).toBe("PICKUP");
      expect(reader.get).toHaveBeenCalledWith("t-1");
    });
    it("staff: an old client's hard-sent ROUTE still resolves PICKUP", async () => {
      await service.create(body({ fulfillPath: "ROUTE" }), staff, { skipAutoMerge: true });
      expect(written()).toBe("PICKUP");
    });
    it("staff: an explicit SHIP ('Ship this order instead') stays SHIP", async () => {
      await service.create(body({ fulfillPath: "SHIP" }), staff, { skipAutoMerge: true });
      expect(written()).toBe("SHIP");
    });
    it("buyer: PICKUP is written; SHIP is refused FULFIL_METHOD_NOT_OFFERED before any write", async () => {
      await service.create(body(), buyer, { skipAutoMerge: true });
      expect(written()).toBe("PICKUP");
      prisma.order.create.mockClear();
      await expect(
        service.create(body({ fulfillPath: "SHIP" }), buyer, { skipAutoMerge: true }),
      ).rejects.toMatchObject({
        status: 400,
        response: expect.objectContaining({ code: "FULFIL_METHOD_NOT_OFFERED" }),
      });
      expect(prisma.order.create).not.toHaveBeenCalled();
    });
    it("the internal options.fulfillPath (counter sale) beats the resolver and never reads it", async () => {
      await service.create(body(), staff, { skipAutoMerge: true, fulfillPath: "PICKUP" as never });
      expect(written()).toBe("PICKUP");
      expect(reader.get).not.toHaveBeenCalled();
    });
  });
});
