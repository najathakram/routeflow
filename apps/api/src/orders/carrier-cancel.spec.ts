/**
 * B1082 / B1083: a carrier (SHIP) order whose parcel is with the carrier is not cancelled or deleted,
 * and the order read tells the web so (`cancelBlockedReason`). Gated on the billing moment, so an
 * UNSET-mode business is untouched. Built on OrdersService.prototype with a minimal `self` (the
 * service spec sits at its size-ratchet cap).
 */
import { OrderStatus } from "@prisma/client";
import { carrierCancelBlockedReason } from "./order-status-invoicing";
import {
  EDIT_REVISIONS,
  lastShipStateSource,
  recordShipStateChange,
  shipStateMarker,
} from "./order-ship-state";
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
      // the last ship-state marker: a shipped order that is open again was REOPENED after delivery
      orderRevision: {
        findFirst: jest.fn().mockResolvedValue({ source: "REOPENED_FROM_DELIVERY" }),
      },
    };
    const self: any = {
      prisma: { forTenant: () => db, getTenantId: () => "t1" },
      featureConfig: cfg(mode),
      cancelImpact: jest.fn(),
    };
    return { db, self };
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

/**
 * B1 (lead ruling): a deliberate "Unmark shipped" makes the order cancellable again (the parcel never
 * left); a REOPEN after delivery keeps it with the carrier. The last ship-state marker decides; no status
 * history table exists, so the markers are OrderRevision rows. Real helpers over an in-memory revision store.
 */
describe("B1: unmark vs reopen (ship-state markers)", () => {
  const makeStore = () => {
    const revisions: Array<{ orderId: string; revisionNumber: number; source: string }> = [];
    const tx = {
      orderRevision: {
        aggregate: async ({ where }: any) => ({
          _max: {
            revisionNumber: Math.max(
              0,
              ...revisions.filter((r) => r.orderId === where.orderId).map((r) => r.revisionNumber),
            ),
          },
        }),
        create: async ({ data }: any) => void revisions.push(data),
      },
    };
    const prisma: any = {
      getTenantId: () => "t1",
      tenantTransaction: async (fn: any) => fn(tx),
      forTenant: () => ({
        orderItem: { findMany: async () => [] },
        orderRevision: {
          findFirst: async ({ where }: any) => {
            const rows = revisions
              .filter((r) => r.orderId === where.orderId && where.source.in.includes(r.source))
              .sort((a, b) => b.revisionNumber - a.revisionNumber);
            return rows[0] ? { source: rows[0].source } : null;
          },
        },
      }),
    };
    return prisma;
  };
  const base = { id: "o1", fulfillPath: "SHIP" as const, subtotal: 10, tax: 0, total: 10 };
  const blocked = (prisma: any, status: OrderStatus) =>
    carrierCancelBlockedReason(cfg("ship"), "t1", { ...order(status), id: "o1" }, (id) =>
      lastShipStateSource(prisma, id),
    );
  const change = (prisma: any, from: OrderStatus, to: OrderStatus, mode = "ship") =>
    recordShipStateChange(
      { prisma, featureConfig: cfg(mode) },
      { ...base, status: from },
      to,
      undefined,
      "r",
    );

  it("shipMarker: only the two transitions leave a marker, and only on SHIP orders", () => {
    expect(shipStateMarker("SHIP", OrderStatus.OUT_FOR_DELIVERY, OrderStatus.CONFIRMED)).toBe(
      "UNMARKED_SHIPPED",
    );
    expect(shipStateMarker("SHIP", OrderStatus.DELIVERED, OrderStatus.CONFIRMED)).toBe(
      "REOPENED_FROM_DELIVERY",
    );
    expect(shipStateMarker("SHIP", OrderStatus.DELIVERED, OrderStatus.PARTIALLY_DELIVERED)).toBe(
      "REOPENED_FROM_DELIVERY",
    );
    expect(shipStateMarker("SHIP", OrderStatus.CONFIRMED, OrderStatus.OUT_FOR_DELIVERY)).toBeNull();
    expect(
      shipStateMarker("ROUTE", OrderStatus.OUT_FOR_DELIVERY, OrderStatus.CONFIRMED),
    ).toBeNull();
  });

  it("mark shipped -> unmark -> cancel: ALLOWED (shippedAt is still set, the last marker is the unmark)", async () => {
    const prisma = makeStore();
    await change(prisma, OrderStatus.OUT_FOR_DELIVERY, OrderStatus.CONFIRMED);
    expect(await blocked(prisma, OrderStatus.CONFIRMED)).toBeNull();
  });

  it("deliver -> reopen -> cancel: BLOCKED (the goods went out)", async () => {
    const prisma = makeStore();
    await change(prisma, OrderStatus.DELIVERED, OrderStatus.CONFIRMED);
    expect(await blocked(prisma, OrderStatus.CONFIRMED)).toBe("WITH_CARRIER");
  });

  it("the LAST marker decides: reopen, ship again, unmark -> cancellable; unmark, ship, deliver, reopen -> blocked", async () => {
    const a = makeStore();
    await change(a, OrderStatus.DELIVERED, OrderStatus.CONFIRMED);
    await change(a, OrderStatus.OUT_FOR_DELIVERY, OrderStatus.CONFIRMED);
    expect(await blocked(a, OrderStatus.CONFIRMED)).toBeNull();
    const b = makeStore();
    await change(b, OrderStatus.OUT_FOR_DELIVERY, OrderStatus.CONFIRMED);
    await change(b, OrderStatus.DELIVERED, OrderStatus.CONFIRMED);
    expect(await blocked(b, OrderStatus.CONFIRMED)).toBe("WITH_CARRIER");
  });

  it("out for delivery is blocked whatever the markers say; no marker at all reads as unmarked", async () => {
    const prisma = makeStore();
    await change(prisma, OrderStatus.OUT_FOR_DELIVERY, OrderStatus.CONFIRMED);
    expect(await blocked(prisma, OrderStatus.OUT_FOR_DELIVERY)).toBe("WITH_CARRIER");
    expect(await blocked(makeStore(), OrderStatus.CONFIRMED)).toBeNull();
  });

  it("D3: a business that does not bill at shipment gets no marker (nothing for the guard to read)", async () => {
    const prisma = makeStore();
    await change(prisma, OrderStatus.DELIVERED, OrderStatus.CONFIRMED, "unset");
    expect(await lastShipStateSource(prisma, "o1")).toBeNull();
  });

  it("D3: the order's edit history (findOne's revisions) leaves the markers out", () => {
    expect(EDIT_REVISIONS.where.source.notIn).toEqual([
      "UNMARKED_SHIPPED",
      "REOPENED_FROM_DELIVERY",
    ]);
  });

  it("a marker write that fails never fails the status change", async () => {
    const prisma = makeStore();
    prisma.tenantTransaction = async () => {
      throw new Error("db down");
    };
    await expect(
      change(prisma, OrderStatus.OUT_FOR_DELIVERY, OrderStatus.CONFIRMED),
    ).resolves.toBeUndefined();
  });

  it("wiring pins: changeStatus records the marker; updateOrderItems blocks credits for a with-carrier order", () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const src = require("fs").readFileSync(
      require("path").join(__dirname, "orders.service.ts"),
      "utf8",
    );
    expect(src).toMatch(/await recordShipStateChange\(this, order, dto\.status/);
    expect(src).toMatch(/blockCredits: await blockCreditsUnderLock\(tx, orderId, carrier\)/);
    expect(src).toMatch(/revisions: EDIT_REVISIONS/);
    // D2: the guard is computed once, BEFORE the un-tx'd invoice revert
    const guardAt = src.indexOf("carrierEditGuard(this, order)");
    expect(guardAt).toBeGreaterThan(0);
    expect(guardAt).toBeLessThan(src.indexOf("revertLinkedInvoicesForOrderEdit(orderId)"));
  });
});
