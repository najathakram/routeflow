import { InvoiceStatus, OrderStatus } from "@prisma/client";
import { InvoicesService } from "./invoices.service";
import { resolvePendingMirror } from "./pending-mirror";

const cfg = (mode: string) => ({ getEffectiveMode: jest.fn().mockResolvedValue(mode) });
const draft = { orderId: "o1", status: InvoiceStatus.DRAFT, deliveryBatchId: null };
const order = (status: OrderStatus, fulfillPath: "ROUTE" | "SHIP") => ({ status, fulfillPath });

describe("resolvePendingMirror", () => {
  it.each(["ship", "both", "pickup_ship"])(
    "a SHIPPED carrier order of a %s business is NOT a pending mirror (sendable + editable)",
    async (mode) => {
      expect(
        await resolvePendingMirror(
          cfg(mode),
          "t1",
          draft,
          order(OrderStatus.OUT_FOR_DELIVERY, "SHIP"),
        ),
      ).toBe(false);
    },
  );

  it("an unset-mode business keeps the lock until DELIVERED, even for a SHIP order", async () => {
    expect(
      await resolvePendingMirror(
        cfg("unset"),
        "t1",
        draft,
        order(OrderStatus.OUT_FOR_DELIVERY, "SHIP"),
      ),
    ).toBe(true);
  });

  it("a ROUTE order out for delivery stays locked (route invoices bill at delivery)", async () => {
    expect(
      await resolvePendingMirror(
        cfg("ship"),
        "t1",
        draft,
        order(OrderStatus.OUT_FOR_DELIVERY, "ROUTE"),
      ),
    ).toBe(true);
  });

  it.each([OrderStatus.PENDING, OrderStatus.CONFIRMED])(
    "a SHIP order not yet shipped (%s) stays locked",
    async (status) => {
      expect(await resolvePendingMirror(cfg("ship"), "t1", draft, order(status, "SHIP"))).toBe(
        true,
      );
    },
  );

  it("delivered, non-draft, batch-linked and order-less invoices are never pending mirrors", async () => {
    const f = cfg("ship");
    expect(await resolvePendingMirror(f, "t1", draft, order(OrderStatus.DELIVERED, "SHIP"))).toBe(
      false,
    );
    expect(
      await resolvePendingMirror(
        f,
        "t1",
        { ...draft, status: InvoiceStatus.SENT },
        order(OrderStatus.CONFIRMED, "ROUTE"),
      ),
    ).toBe(false);
    expect(
      await resolvePendingMirror(
        f,
        "t1",
        { ...draft, deliveryBatchId: "b1" },
        order(OrderStatus.CONFIRMED, "ROUTE"),
      ),
    ).toBe(false);
    expect(await resolvePendingMirror(f, "t1", { ...draft, orderId: null }, null)).toBe(false);
  });

  it("an unreadable mode reads as unset (locked), never throws", async () => {
    const bad = { getEffectiveMode: jest.fn().mockRejectedValue(new Error("down")) };
    expect(
      await resolvePendingMirror(bad, "t1", draft, order(OrderStatus.OUT_FOR_DELIVERY, "SHIP")),
    ).toBe(true);
  });
});

describe("rebuildIssuedDepositMirrorOnDelivery: keyed on the billing moment", () => {
  const rebuild = (InvoicesService.prototype as any).rebuildIssuedDepositMirrorOnDelivery;
  const mirror = {
    id: "i1",
    status: InvoiceStatus.SENT,
    deliveryBatchId: null,
    depositPercent: 50,
    items: [],
    payments: [],
  };
  const SHIPPED_AT = new Date("2026-10-01T00:00:00Z");
  const db = (fulfillPath: string, shippedAt: Date | null = SHIPPED_AT) => ({
    invoice: { findMany: jest.fn().mockResolvedValue([mirror]) },
    order: {
      findUnique: jest.fn().mockResolvedValue({ id: "o1", fulfillPath, shippedAt, lineItems: [] }),
    },
  });
  const self = (mode: string) => ({
    rebuildSiblingDrafts: jest.fn().mockResolvedValue([]),
    featureConfig: cfg(mode),
    prisma: { getTenantId: () => "t1" },
  });

  it.each(["ship", "both", "pickup_ship"])(
    "ship -> send -> DELIVERED leaves a %s business's invoice unchanged (no delivered-basis restate)",
    async (mode) => {
      const s = self(mode);
      expect(await rebuild.call(s, "o1", db("SHIP"))).toBeNull();
      expect(s.rebuildSiblingDrafts).not.toHaveBeenCalled();
    },
  );

  it("MONEY: a SHIP order that went CONFIRMED -> DELIVERED WITHOUT shipping was never settled at shipment: its deposit invoice IS restated on a short delivery", async () => {
    const s = self("ship");
    await rebuild.call(s, "o1", db("SHIP", null));
    expect(s.rebuildSiblingDrafts).toHaveBeenCalledTimes(1);
  });

  it("a SHIP order of an UNSET business was not billed at shipment: rebuilt on delivery as before", async () => {
    const s = self("unset");
    await rebuild.call(s, "o1", db("SHIP"));
    expect(s.rebuildSiblingDrafts).toHaveBeenCalledTimes(1);
  });

  it("a ROUTE order's deposit mirror is still rebuilt on the delivered basis (unchanged)", async () => {
    const s = self("ship");
    await rebuild.call(s, "o1", db("ROUTE"));
    expect(s.rebuildSiblingDrafts).toHaveBeenCalledTimes(1);
  });
});
