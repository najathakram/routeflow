// W-870: not about the permission check; the live denied-groups read is mocked (a mocked Prisma has no permissions row).
jest.mock("./counter-sale/till-permission.guard", () =>
  require("../testing/till-user").tillGuardMock(),
);
/**
 * SA-1034: the price-edit capability is checked at every override site (staff-override.ts
 * `assertPriceEditAllowed`, sites pinned in price-edit-sites.pin.spec.ts). Each site's value comes from
 * `staffMay(role, "EDIT_LINE_PRICE", [])`; this spec drives that value both ways at the module boundary:
 *  - `false`: a line that becomes a NEW override is refused 403 PRICE_EDIT_NOT_PERMITTED before the write;
 *  - `true` (both staff roles today): the override is written unchanged.
 * Sites: create (pack line), updateOrderItems (substitute, add, existing-line edit), a unit line, an
 * invoice line. Pure (mocked Prisma, no database).
 */
jest.mock("../common/db-locks", () => ({
  ...jest.requireActual("../common/db-locks"),
  withAdvisoryLock: jest.fn(async (_opts: unknown, fn: () => Promise<unknown>) => ({
    acquired: true,
    value: await fn(),
  })),
}));
jest.mock("../auth/permissions/staff-capabilities", () => {
  const actual = jest.requireActual("../auth/permissions/staff-capabilities");
  return { ...actual, staffMay: jest.fn(actual.staffMay) };
});

import { ForbiddenException } from "@nestjs/common";
import { PriceType } from "@prisma/client";
import type { LadderUnit } from "@routeflow/pricing";
import { staffMay } from "../auth/permissions/staff-capabilities";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { priceInvoiceLine, type LineOverrideCtx } from "../invoices/invoice-line-override";
import { resolveLineUnits } from "../products/line-units";
import { buildOrdersService, operatorPayload } from "./testing/orders-service-harness";
import { buildUnitLine } from "./unit-line-build";

const staffMayMock = staffMay as jest.MockedFunction<typeof staffMay>;
const capability = (allowed: boolean) => staffMayMock.mockReturnValue(allowed);

const refused = async (p: Promise<unknown> | (() => unknown)) => {
  let err: unknown;
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    err = e;
  }
  expect(err).toBeInstanceOf(ForbiddenException);
  expect((err as ForbiddenException).getResponse()).toMatchObject({
    code: API_ERROR_CODES.PRICE_EDIT_NOT_PERMITTED,
  });
};

/** list 10, tier-1 customer: a typed 6 is a DISCOUNTED override; a typed 10 is no override. */
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

afterEach(() => {
  staffMayMock.mockReset();
  staffMayMock.mockImplementation(
    jest.requireActual("../auth/permissions/staff-capabilities").staffMay,
  );
});

describe("SA-1034 price-edit capability — create (pack line)", () => {
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
  const create = (unitPrice: number) =>
    h.service.create(
      { customerId: "cust-1", items: [{ productId: "prod-1", qty: 2, unitPrice }] } as never,
      { ...operatorPayload, tenantId: "t-1" } as never,
    );

  it("capability false: an override is refused 403 before any write", async () => {
    capability(false);
    await refused(create(6));
    expect(staffMayMock).toHaveBeenCalledWith(operatorPayload.role, "EDIT_LINE_PRICE", []);
    expect(h.prisma.order.create).not.toHaveBeenCalled();
    expect(h.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("capability false: a typed price that is no override (the server price) still passes", async () => {
    capability(false);
    await create(10);
    expect(h.prisma.order.create).toHaveBeenCalled();
  });

  it("capability true: the override is written unchanged (DISCOUNTED, attributed)", async () => {
    capability(true);
    await create(6);
    const line = h.prisma.order.create.mock.calls[0][0].data.lineItems.create[0];
    expect(line).toMatchObject({
      unitPrice: 6,
      priceType: "DISCOUNTED",
      originalPrice: 10,
      overriddenBy: operatorPayload.sub,
    });
  });
});

describe("SA-1034 price-edit capability — updateOrderItems", () => {
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
  });
  const edit = (items: unknown[]) =>
    h.service.updateOrderItems(
      "ord-1",
      { items, replaceAll: false } as never,
      operatorPayload as never,
    );

  describe("substitute", () => {
    beforeEach(() => h.prisma.order.findUnique.mockResolvedValue({ ...ORDER, lineItems: [LINE] }));
    const sub = (unitPrice: number) =>
      edit([{ id: "li-A", substituteProductId: "prod-sub", qty: 2, unitPrice }]);

    it("capability false: an override is refused 403 before the line is written", async () => {
      capability(false);
      await refused(sub(6));
      expect(staffMayMock).toHaveBeenCalledWith(operatorPayload.role, "EDIT_LINE_PRICE", []);
      expect(h.prisma.orderItem.update).not.toHaveBeenCalled();
    });

    it("capability true: the override is written unchanged", async () => {
      capability(true);
      await sub(6);
      expect(h.prisma.orderItem.update.mock.calls[0][0].data).toMatchObject({
        productId: "prod-sub",
        unitPrice: 6,
        priceType: "DISCOUNTED",
        overriddenBy: operatorPayload.sub,
      });
    });
  });

  describe("add a line", () => {
    beforeEach(() => h.prisma.order.findUnique.mockResolvedValue({ ...ORDER, lineItems: [] }));
    const add = (unitPrice: number) => edit([{ productId: "prod-1", qty: 2, unitPrice }]);

    it("capability false: an override is refused 403 before the line is created", async () => {
      capability(false);
      await refused(add(6));
      expect(h.prisma.orderItem.create).not.toHaveBeenCalled();
    });

    it("capability true: the override is created unchanged", async () => {
      capability(true);
      await add(6);
      expect(h.prisma.orderItem.create.mock.calls[0][0].data).toMatchObject({
        unitPrice: 6,
        priceType: "DISCOUNTED",
        overriddenBy: operatorPayload.sub,
      });
    });
  });

  describe("existing-line price edit", () => {
    beforeEach(() => h.prisma.order.findUnique.mockResolvedValue({ ...ORDER, lineItems: [LINE] }));
    const reprice = (unitPrice: number) => edit([{ id: "li-A", qty: 2, unitPrice }]);

    it("capability false: an override is refused 403 before the line is written", async () => {
      capability(false);
      await refused(reprice(6));
      expect(h.prisma.orderItem.update).not.toHaveBeenCalled();
    });

    it("capability false: re-sending the stored price is no override and passes", async () => {
      capability(false);
      await reprice(10);
      expect(h.prisma.orderItem.update).toHaveBeenCalled();
    });

    it("capability true: the override is written unchanged", async () => {
      capability(true);
      await reprice(6);
      expect(h.prisma.orderItem.update.mock.calls[0][0].data).toMatchObject({
        unitPrice: 6,
        priceType: "DISCOUNTED",
        overriddenBy: operatorPayload.sub,
      });
    });
  });
});

describe("SA-1034 price-edit capability — a unit line (buildUnitLine)", () => {
  const product = { unit: "Box", unitsPerBox: 24, pricePerUnit: "1.00" };
  const units = [
    {
      label: "Case",
      factorToBase: 288,
      price: "24.00",
      priceTier2: null,
      priceTier3: null,
      priceTier4: null,
      priceTier5: null,
    },
  ] as LadderUnit[];
  const build = (priceEditAllowed: boolean, unitPrice: number, stored?: Record<string, unknown>) =>
    buildUnitLine({
      priceEditAllowed,
      product,
      units,
      resolved: resolveLineUnits(product, units, { unitLabel: "Case" }),
      item: { productId: "p1", qty: 3, unitLabel: "Case", unitPrice },
      tier: 1,
      taxFor: () => ({
        amount: 0,
        snapshot: {
          categoryTaxType: null,
          categoryTaxRate: null,
          categoryPriceIncludesTax: null,
        } as never,
      }),
      position: 0,
      tenantId: "t1",
      overriddenBy: "user-1",
      stored: stored as never,
    });

  it("capability false: a typed override is refused 403", async () => {
    await refused(() => build(false, 20));
  });

  it("capability false: a held override re-sent unchanged is kept (no new stamp, no refusal)", () => {
    const held = {
      unitLabel: "Case",
      unitPrice: "20.00",
      priceType: PriceType.DISCOUNTED,
      originalPrice: "24.00",
      overrideReason: "agreed",
      overriddenBy: "user-0",
    };
    expect(build(false, 20, held)).toMatchObject({ unitPrice: 20, overriddenBy: "user-0" });
  });

  it("capability true: the override is built unchanged", () => {
    expect(build(true, 20)).toMatchObject({
      unitPrice: 20,
      priceType: PriceType.DISCOUNTED,
      overriddenBy: "user-1",
    });
  });
});

describe("SA-1034 price-edit capability — an invoice line (priceInvoiceLine)", () => {
  const ctx = (priceEditAllowed: boolean): LineOverrideCtx => ({
    actorId: "user-1",
    priceEditAllowed,
    tierOf: () => 1,
    ladders: new Map(),
  });
  const product = { id: "p1", name: "Plain Widget", pricePerUnit: 10, unitsPerBox: null };
  const price = (allowed: boolean, unitPrice: number) =>
    priceInvoiceLine({ ctx: ctx(allowed), item: { unitPrice }, product, unitLabel: null });

  it("capability false: an override is refused 403", async () => {
    await refused(() => price(false, 6));
  });

  it("capability false: the tier price typed back is no override and passes", () => {
    expect(price(false, 10).stamp).toMatchObject({ priceType: "STANDARD", overriddenBy: null });
  });

  it("capability true: the override is decided unchanged", () => {
    expect(price(true, 6)).toEqual({
      unitPrice: 6,
      stamp: {
        priceType: "DISCOUNTED",
        originalPrice: 10,
        overrideReason: null,
        overriddenBy: "user-1",
      },
    });
  });
});
