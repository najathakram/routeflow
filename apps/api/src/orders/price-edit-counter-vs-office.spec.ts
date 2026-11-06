/**
 * T-R1 (SA-1034 r8, SA-1056 A-1): the same OPERATOR with PRICING switched off, in the shipped `shadow` mode.
 * The counter is live by an owner-ruled slice, so it hands create() `priceEditAllowed = false` and create() refuses a
 * real price override 403 PRICE_EDIT_NOT_PERMITTED. The office POST /orders hands create() no option, so create() asks
 * `priceEditAllowedFor`, which in shadow answers by the role: the same price is accepted, and one `would-deny` line is
 * logged (group, site, tenant; never a name or a price). The counter half through the real CounterSaleService is in
 * counter-sale/counter-sale.service.spec.ts.
 */
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));

import { ForbiddenException, Logger } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { OperatorPermissionsService } from "../auth/permissions/operator-permissions.service";
import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";

/** list 10, tier-1 customer: a typed 6 is a DISCOUNTED override. */
const PLAIN = {
  id: "prod-1",
  name: "Plain Widget",
  unit: "each",
  pricePerUnit: 10,
  unitsPerBox: null,
  category: null,
  trackedCategoryId: null,
  trackedSubcategoryId: null,
  isActive: true,
};

describe("T-R1: a PRICING-denied OPERATOR in shadow, counter vs office", () => {
  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  let warn: jest.SpyInstance;
  beforeEach(async () => {
    jest.spyOn(OperatorPermissionsService.prototype, "mode").mockReturnValue("shadow");
    warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
    h = await buildOrdersService();
    h.prisma.user.findFirst.mockResolvedValue({
      deniedPermissionGroups: ["PRICING"],
      permissionsVersion: 1,
    });
    h.prisma.customer.findFirst.mockResolvedValue({ id: "cust-1", pricingTier: 1 });
    h.prisma.customer.findUnique.mockResolvedValue({
      id: "cust-1",
      pricingTier: 1,
      user: { status: "ACTIVE" },
      deletedAt: null,
    });
    h.prisma.customerPrice.findMany.mockResolvedValue([]);
    h.prisma.product.findMany.mockResolvedValue([PLAIN]);
    h.prisma.order.create.mockImplementation((args: any) =>
      Promise.resolve({
        id: "ord-new",
        orderNumber: "ORD-1",
        customerId: "cust-1",
        customer: { businessName: "Acme" },
        urgent: false,
        createdAt: new Date(),
        ...args.data,
        lineItems: [],
      }),
    );
  });
  afterEach(() => jest.restoreAllMocks());

  const create = (options?: object) =>
    h.service.create(
      { customerId: "cust-1", items: [{ productId: "prod-1", qty: 2, unitPrice: 6 }] } as never,
      { ...operatorPayload, tenantId: "t-1" } as never,
      options as never,
    );

  it("the counter's live answer (priceEditAllowed false) is refused 403 before any write", async () => {
    let err: unknown;
    try {
      await create({ priceEditAllowed: false });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ForbiddenException);
    expect((err as ForbiddenException).getResponse()).toMatchObject({
      code: API_ERROR_CODES.PRICE_EDIT_NOT_PERMITTED,
    });
    expect(h.prisma.order.create).not.toHaveBeenCalled();
  });

  it("the same POST /orders from the office (no option) is accepted, with one would-deny log", async () => {
    await create();
    expect(h.prisma.order.create).toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "would-deny groups=PRICING handler=OrdersService.create tenant=t-1",
    );
  });
});
