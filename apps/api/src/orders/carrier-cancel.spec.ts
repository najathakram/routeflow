/**
 * B1082 / B1083: a carrier (SHIP) order whose parcel is with the carrier is not cancelled or deleted,
 * and the order read tells the web so (`cancelBlockedReason`). Gated on the billing moment, so an
 * UNSET-mode business is untouched. Built on OrdersService.prototype with a minimal `self` (the
 * service spec sits at its size-ratchet cap).
 */
import { OrderStatus } from "@prisma/client";
import { carrierCancelBlockedReason } from "./order-status-invoicing";
import { OrdersService } from "./orders.service";

const cfg = (mode: string) => ({ getEffectiveMode: jest.fn().mockResolvedValue(mode) });
const SHIPPED_AT = new Date("2026-10-01T00:00:00Z");
const order = (status: OrderStatus, over: Record<string, unknown> = {}) => ({
  id: "o1",
  tenantId: "t1",
  status,
  fulfillPath: "SHIP" as const,
  shippedAt: SHIPPED_AT,
  ...over,
});

describe("carrierCancelBlockedReason", () => {
  it.each(["ship", "both", "pickup_ship"])(
    "out for delivery / partly delivered, and a shipped order reopened to PENDING or CONFIRMED, are WITH_CARRIER for a %s business",
    async (mode) => {
      for (const status of [
        OrderStatus.OUT_FOR_DELIVERY,
        OrderStatus.PARTIALLY_DELIVERED,
        OrderStatus.PENDING, // cancel -> reopen of a shipped order lands here, shippedAt kept
        OrderStatus.CONFIRMED,
      ])
        expect(await carrierCancelBlockedReason(cfg(mode), "t1", order(status))).toBe(
          "WITH_CARRIER",
        );
    },
  );

  it("an order that never shipped (no shippedAt) is cancellable while open", async () => {
    expect(
      await carrierCancelBlockedReason(
        cfg("ship"),
        "t1",
        order(OrderStatus.CONFIRMED, { shippedAt: null }),
      ),
    ).toBeNull();
    expect(
      await carrierCancelBlockedReason(
        cfg("ship"),
        "t1",
        order(OrderStatus.PENDING, { shippedAt: null }),
      ),
    ).toBeNull();
  });

  it("an UNSET-mode business, a ROUTE order, and a delivered / cancelled order are never blocked", async () => {
    expect(
      await carrierCancelBlockedReason(cfg("unset"), "t1", order(OrderStatus.OUT_FOR_DELIVERY)),
    ).toBeNull();
    expect(
      await carrierCancelBlockedReason(
        cfg("ship"),
        "t1",
        order(OrderStatus.OUT_FOR_DELIVERY, { fulfillPath: "ROUTE" }),
      ),
    ).toBeNull();
    expect(
      await carrierCancelBlockedReason(cfg("ship"), "t1", order(OrderStatus.DELIVERED)),
    ).toBeNull();
    expect(
      await carrierCancelBlockedReason(cfg("ship"), "t1", order(OrderStatus.CANCELLED)),
    ).toBeNull();
  });
});

describe("OrdersService wiring", () => {
  const fakeSelf = (o: ReturnType<typeof order>, mode: string) => {
    const db = {
      order: { findUnique: jest.fn().mockResolvedValue({ ...o, lineItems: [], invoices: [] }) },
      return: { count: jest.fn().mockResolvedValue(0) },
    };
    return {
      db,
      self: {
        prisma: { forTenant: () => db, getTenantId: () => "t1" },
        featureConfig: cfg(mode),
        cancelImpact: jest.fn(),
      } as any,
    };
  };
  const operator = { sub: "u1", role: "OPERATOR", tenantId: "t1" } as any;

  it("B1082: deleteOrder refuses an order with the carrier (coded 409) before touching anything", async () => {
    const { self, db } = fakeSelf(order(OrderStatus.OUT_FOR_DELIVERY), "ship");
    await expect(
      (OrdersService.prototype as any).deleteOrder.call(self, "o1", operator),
    ).rejects.toMatchObject({
      status: 409,
      response: expect.objectContaining({ code: "ORDER_WITH_CARRIER_NO_CANCEL" }),
    });
    expect(db.return.count).not.toHaveBeenCalled();
    expect(self.cancelImpact).not.toHaveBeenCalled();
  });

  it("B1082: deleteOrder of a reopened shipped order (PENDING, shippedAt set) is refused too", async () => {
    const { self } = fakeSelf(order(OrderStatus.PENDING), "ship");
    await expect(
      (OrdersService.prototype as any).deleteOrder.call(self, "o1", operator),
    ).rejects.toMatchObject({ status: 409 });
  });

  it("B1082: an UNSET-mode business deletes exactly as before (the guard lets it through)", async () => {
    const { self } = fakeSelf(order(OrderStatus.OUT_FOR_DELIVERY), "unset");
    self.cancelImpact.mockResolvedValue({
      blockingPayments: [{ amount: 5, invoiceNumber: "INV-1" }],
    });
    // it gets past the carrier guard and stops at the existing payments refusal
    await expect(
      (OrdersService.prototype as any).deleteOrder.call(self, "o1", operator),
    ).rejects.toThrow(/recorded payments/);
  });

  it("B1083: findOne puts cancelBlockedReason on the order", async () => {
    const { self } = fakeSelf(order(OrderStatus.OUT_FOR_DELIVERY), "ship");
    const read = await (OrdersService.prototype as any).findOne.call(self, "o1", operator);
    expect(read.cancelBlockedReason).toBe("WITH_CARRIER");
    const { self: other } = fakeSelf(order(OrderStatus.OUT_FOR_DELIVERY), "unset");
    expect(
      (await (OrdersService.prototype as any).findOne.call(other, "o1", operator))
        .cancelBlockedReason,
    ).toBeNull();
  });
});
