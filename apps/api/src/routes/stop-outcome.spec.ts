import { NotificationEvent, OrderStatus } from "@prisma/client";
import { applyStopOutcomes, notifyStopOutcomes } from "./stop-outcome";

/**
 * SA-1101 §2.2 (RO-1, RO-2, RO-3, RO-13 at the unit level; the DB-lane rows run the same step end to end).
 * `applyStopOutcomes` reads the lines AFTER the recompute, decides each order from them, and writes both
 * statuses behind the NON_ROUTABLE guard. The notice loop reads the map it returns, never the pre-tx status.
 */
const CLOSED_AT = new Date("2026-11-04T18:30:00Z");
type Line = { orderId: string; status: string; deliveredQty: number | string };

function fakeTx(lines: Line[]) {
  return {
    orderItem: { findMany: jest.fn().mockResolvedValue(lines) },
    order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
}
const order = (id: string, status: OrderStatus = OrderStatus.OUT_FOR_DELIVERY) => ({ id, status });

describe("applyStopOutcomes (SA-1101 §2.2)", () => {
  it("RO-1: every line of the order at 0 -> REFUSED, deliveredAt cleared, no DELIVERED write", async () => {
    const tx = fakeTx([
      { orderId: "A", status: "CONFIRMED", deliveredQty: 0 },
      { orderId: "A", status: "CONFIRMED", deliveredQty: "0" },
    ]);
    const out = await applyStopOutcomes(tx, [order("A")], CLOSED_AT);
    expect(out.get("A")).toBe("REFUSED");
    expect(tx.order.updateMany).toHaveBeenCalledTimes(1);
    expect(tx.order.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ["A"] },
        status: { notIn: ["DRAFT", "DELIVERED", "REFUSED", "CANCELLED"] },
      },
      data: { status: "REFUSED", deliveredAt: null },
    });
  });

  it("RO-2: a mixed stop - A delivered in full, B refused in full - writes each its own status", async () => {
    const tx = fakeTx([
      { orderId: "A", status: "CONFIRMED", deliveredQty: 10 },
      { orderId: "B", status: "CONFIRMED", deliveredQty: 0 },
    ]);
    const out = await applyStopOutcomes(tx, [order("A"), order("B")], CLOSED_AT);
    expect(Object.fromEntries(out)).toEqual({ A: "DELIVERED", B: "REFUSED" });
    const calls = tx.order.updateMany.mock.calls.map(([a]) => a.data);
    expect(calls).toEqual(
      expect.arrayContaining([
        { status: "DELIVERED", deliveredAt: CLOSED_AT },
        { status: "REFUSED", deliveredAt: null },
      ]),
    );
  });

  it("RO-3: a short line (10 -> 7) is DELIVERED with deliveredAt set to the close time", async () => {
    const tx = fakeTx([{ orderId: "A", status: "CONFIRMED", deliveredQty: 7 }]);
    const out = await applyStopOutcomes(tx, [order("A")], CLOSED_AT);
    expect(out.get("A")).toBe("DELIVERED");
    expect(tx.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "DELIVERED", deliveredAt: CLOSED_AT } }),
    );
  });

  it("refused this visit but delivered on an earlier one (recompute left a line above 0) is DELIVERED", async () => {
    const tx = fakeTx([
      { orderId: "A", status: "CONFIRMED", deliveredQty: 5 },
      { orderId: "A", status: "CONFIRMED", deliveredQty: 0 },
    ]);
    expect((await applyStopOutcomes(tx, [order("A")], CLOSED_AT)).get("A")).toBe("DELIVERED");
  });

  it("a cancelled line carrying a quantity is ignored: refused plus cancelled is REFUSED", async () => {
    const tx = fakeTx([
      { orderId: "A", status: "CONFIRMED", deliveredQty: 0 },
      { orderId: "A", status: "CANCELLED", deliveredQty: 3 },
    ]);
    expect((await applyStopOutcomes(tx, [order("A")], CLOSED_AT)).get("A")).toBe("REFUSED");
  });

  it("an order with no lines closes DELIVERED, as an empty order always did", async () => {
    const tx = fakeTx([]);
    expect((await applyStopOutcomes(tx, [order("A")], CLOSED_AT)).get("A")).toBe("DELIVERED");
  });

  it("DRAFT and already-terminal orders are not read, written or put in the map", async () => {
    const tx = fakeTx([{ orderId: "A", status: "CONFIRMED", deliveredQty: 4 }]);
    const out = await applyStopOutcomes(
      tx,
      [
        order("A"),
        order("D", OrderStatus.DRAFT),
        order("X", OrderStatus.DELIVERED),
        order("R", OrderStatus.REFUSED),
        order("C", OrderStatus.CANCELLED),
      ],
      CLOSED_AT,
    );
    expect([...out.keys()]).toEqual(["A"]);
    expect(tx.orderItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orderId: { in: ["A"] } } }),
    );
  });

  it("a stop with nothing to decide makes no query at all", async () => {
    const tx = fakeTx([]);
    const out = await applyStopOutcomes(tx, [order("X", OrderStatus.DELIVERED)], CLOSED_AT);
    expect(out.size).toBe(0);
    expect(tx.orderItem.findMany).not.toHaveBeenCalled();
    expect(tx.order.updateMany).not.toHaveBeenCalled();
  });

  it("a garbage deliveredQty throws before any status is written", async () => {
    const tx = fakeTx([{ orderId: "A", status: "CONFIRMED", deliveredQty: "abc" }]);
    await expect(applyStopOutcomes(tx, [order("A")], CLOSED_AT)).rejects.toThrow(
      /invalid deliveredQty/,
    );
    expect(tx.order.updateMany).not.toHaveBeenCalled();
  });
});

describe("notifyStopOutcomes (SA-1101 §2.2, RO-1/RO-2)", () => {
  const o = (id: string) => ({
    id,
    status: OrderStatus.OUT_FOR_DELIVERY,
    customerId: `cust-${id}`,
    orderNumber: `SO-${id}`,
    total: 120,
  });
  const messaging = () => ({ notifyEvent: jest.fn().mockResolvedValue(undefined) });

  it("a refused order sends ORDER_REFUSED with the order number and no total, and no DELIVERED", () => {
    const m = messaging();
    notifyStopOutcomes(m, new Map([["A", "REFUSED"]]), [o("A")], "user-1", CLOSED_AT);
    expect(m.notifyEvent).toHaveBeenCalledTimes(1);
    expect(m.notifyEvent).toHaveBeenCalledWith(NotificationEvent.ORDER_REFUSED, {
      customerId: "cust-A",
      senderId: "user-1",
      vars: { orderNumber: "SO-A" },
    });
  });

  it("a mixed stop sends one notice each, of its own kind; a delivered one carries the post-reconcile total", () => {
    const m = messaging();
    notifyStopOutcomes(
      m,
      new Map([
        ["A", "DELIVERED"],
        ["B", "REFUSED"],
      ]),
      [o("A"), o("B")],
      null,
      CLOSED_AT,
      new Map([["A", 80]]),
    );
    const sent = m.notifyEvent.mock.calls.map(([event, args]) => [event, args.customerId]);
    expect(sent).toEqual([
      [NotificationEvent.DELIVERED, "cust-A"],
      [NotificationEvent.ORDER_REFUSED, "cust-B"],
    ]);
    expect(m.notifyEvent.mock.calls[0][1].vars.orderTotal).toMatch(/80/);
    expect(m.notifyEvent.mock.calls[0][1].vars.deliveredAt).toBeTruthy();
  });

  it("an order with no outcome (already terminal) sends nothing", () => {
    const m = messaging();
    notifyStopOutcomes(m, new Map(), [o("A")], "user-1", CLOSED_AT);
    expect(m.notifyEvent).not.toHaveBeenCalled();
  });

  it("a notifyEvent that rejects never throws out of the loop (fire-and-forget)", async () => {
    const m = { notifyEvent: jest.fn().mockRejectedValue(new Error("smtp down")) };
    expect(() =>
      notifyStopOutcomes(m, new Map([["A", "DELIVERED"]]), [o("A")], "user-1", CLOSED_AT),
    ).not.toThrow();
    await Promise.resolve();
  });
});
