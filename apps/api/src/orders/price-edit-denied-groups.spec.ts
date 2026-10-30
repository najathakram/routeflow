/**
 * W-870 / SA-1034: the price-edit capability is read over the OPERATOR's LIVE denied groups at the three sites the
 * permissions rollout left on `[]` (orders create, updateOrderItems' unit-line gate, the invoice line override). Each case
 * is an OPERATOR with PRICING denied who types a price that is a real override: 403 PRICE_EDIT_NOT_PERMITTED before any
 * write. On the `[]` base every case below is allowed (200), which is the permission hole this pins shut.
 * Pure (mocked Prisma, the denied-groups read mocked at the module boundary, the real `staffMay`).
 */
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));
jest.mock("./counter-sale/till-permission.guard", () => ({
  ...jest.requireActual("./counter-sale/till-permission.guard"),
  operatorDeniedGroups: jest.fn(),
}));

import { ForbiddenException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { loadOverride } from "../invoices/invoice-line-override";
import { operatorDeniedGroups } from "./counter-sale/till-permission.guard";
import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";

const deniedMock = operatorDeniedGroups as jest.MockedFunction<typeof operatorDeniedGroups>;

const refused = async (p: Promise<unknown>) => {
  let err: unknown;
  try {
    await p;
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ForbiddenException);
  expect((err as ForbiddenException).getResponse()).toMatchObject({
    code: API_ERROR_CODES.PRICE_EDIT_NOT_PERMITTED,
  });
};

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

beforeEach(() => {
  deniedMock.mockReset();
  deniedMock.mockResolvedValue(["PRICING"]);
});

describe("orders create: an OPERATOR with PRICING denied cannot type a price", () => {
  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  beforeEach(async () => {
    h = await buildOrdersService();
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
  const create = (unitPrice: number, options?: object) =>
    h.service.create(
      { customerId: "cust-1", items: [{ productId: "prod-1", qty: 2, unitPrice }] } as never,
      { ...operatorPayload, tenantId: "t-1" } as never,
      options as never,
    );

  it("a typed override is refused 403 before any write; the denied groups were read for the OPERATOR", async () => {
    await refused(create(6));
    expect(deniedMock).toHaveBeenCalledTimes(1);
    expect(deniedMock.mock.calls[0][1]).toMatchObject({ sub: operatorPayload.sub });
    expect(h.prisma.order.create).not.toHaveBeenCalled();
  });

  it("the same operator with nothing denied still overrides (the read is the only difference)", async () => {
    deniedMock.mockResolvedValue([]);
    await create(6);
    expect(h.prisma.order.create).toHaveBeenCalled();
  });

  it("a caller that sets priceEditAllowed itself (the counter) is not read for a second time", async () => {
    await create(6, { priceEditAllowed: true });
    expect(deniedMock).not.toHaveBeenCalled();
  });
});

describe("updateOrderItems: the unit-line price gate reads the live denials once, before the transaction", () => {
  let h: Awaited<ReturnType<typeof buildOrdersService>>;
  const ORDER = {
    id: "ord-1",
    customerId: "cust-1",
    orderNumber: "ORD-123",
    status: "DRAFT" as const,
    source: "APP" as const,
    urgent: false,
    subtotal: 10,
    tax: 0,
    total: 10,
    notes: null,
    routeRunId: null,
    routeRunStopId: null,
    customer: { businessName: "Test Business" },
  };
  const LINE = {
    id: "li-A",
    orderId: "ord-1",
    productId: "prod-1",
    qty: 2,
    unitPrice: 10,
    subtotal: 20,
    status: "PENDING",
    priceType: "STANDARD",
    boxes: null,
    pieces: null,
  };
  beforeEach(async () => {
    h = await buildOrdersService();
    h.prisma.customer.findFirst.mockResolvedValue({ pricingTier: 1 });
    h.prisma.customerPrice.findMany.mockResolvedValue([]);
    h.prisma.orderItem.findMany.mockResolvedValue([{ subtotal: 12, status: "PENDING" }]);
    h.prisma.product.findMany.mockResolvedValue([PLAIN]);
    h.prisma.product.findFirst.mockResolvedValue(PLAIN);
    h.prisma.product.findUnique.mockResolvedValue(PLAIN);
    h.prisma.product.findUniqueOrThrow.mockResolvedValue({ ...PLAIN, id: "prod-sub" });
    h.prisma.order.findUnique.mockResolvedValue({ ...ORDER, lineItems: [LINE] });
  });
  const sub = (unitPrice: number) =>
    h.service.updateOrderItems(
      "ord-1",
      {
        items: [{ id: "li-A", substituteProductId: "prod-sub", qty: 2, unitPrice }],
        replaceAll: false,
      } as never,
      { ...operatorPayload, tenantId: "t-1" } as never,
    );

  it("a substitute at a typed override is refused 403 before the line is written", async () => {
    await refused(sub(6));
    expect(deniedMock).toHaveBeenCalledTimes(1);
    expect(h.prisma.orderItem.update).not.toHaveBeenCalled();
  });
});

describe("loadOverride (the invoice line override) reads the live denials itself", () => {
  const db = {
    customer: { findFirst: jest.fn().mockResolvedValue({ pricingTier: 1 }) },
    customerPrice: { findMany: jest.fn().mockResolvedValue([]) },
    productUnit: { findMany: jest.fn().mockResolvedValue([]) },
    customerUnitPrice: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const prisma = { forTenant: () => db, getTenantId: () => "t1" };
  const load = (actor: { sub: string; tenantId?: string; role: string }) =>
    loadOverride(prisma, { customerId: "c1", items: [] }, new Map() as never, actor, {
      hasFlagStrict: jest.fn().mockResolvedValue(false),
    } as never);

  it("an OPERATOR with PRICING denied: priceEditAllowed is false", async () => {
    const ctx = await load({ sub: "op-1", tenantId: "t-1", role: "OPERATOR" });
    expect(ctx?.priceEditAllowed).toBe(false);
    expect(deniedMock).toHaveBeenCalledTimes(1);
  });

  it("a TENANT_ADMIN is allowed and no permissions read is made", async () => {
    const ctx = await load({ sub: "adm-1", tenantId: "t-1", role: "TENANT_ADMIN" });
    expect(ctx?.priceEditAllowed).toBe(true);
    expect(deniedMock).not.toHaveBeenCalled();
  });
});
