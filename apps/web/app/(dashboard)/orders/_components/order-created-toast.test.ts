import {
  ACTION_TOAST_MS,
  addedLineQty,
  orderCreatedToast,
  showOrderCreatedToast,
} from "./order-created-toast";
import { wasCreatedHere } from "@/lib/order-created-echo";

describe("orderCreatedToast", () => {
  const created = { id: "ord-123456789", orderNumber: "ORD-00042" };

  it("create: 'Order created' with a View Order action that navigates to the new order", () => {
    const onViewOrder = jest.fn();
    const t = orderCreatedToast({ asDraft: false, created, onViewOrder });
    expect(t.title).toBe("Order created");
    expect(t.variant).toBe("success");
    expect(t.action?.label).toBe("View Order");
    t.action?.onClick();
    expect(onViewOrder).toHaveBeenCalledWith("ord-123456789");
  });

  it("draft: 'Order saved as draft' with the same action", () => {
    const onViewOrder = jest.fn();
    const t = orderCreatedToast({ asDraft: true, created, onViewOrder });
    expect(t.title).toBe("Order saved as draft");
    expect(t.action?.label).toBe("View Order");
    t.action?.onClick();
    expect(onViewOrder).toHaveBeenCalledWith("ord-123456789");
  });

  it("merge: names the merged order and offers 'View Merged Order' to that order's id", () => {
    const onViewOrder = jest.fn();
    const t = orderCreatedToast({ mergeChoice: "merge", asDraft: false, created, onViewOrder });
    expect(t.title).toBe("Merged into order ORD-00042");
    expect(t.action?.label).toBe("View Merged Order");
    t.action?.onClick();
    expect(onViewOrder).toHaveBeenCalledWith("ord-123456789");
  });

  it("merge without an order number falls back to a short id", () => {
    const t = orderCreatedToast({
      mergeChoice: "merge",
      asDraft: false,
      created: { id: "abcdef123456" },
    });
    expect(t.title).toBe("Merged into order #abcdef");
  });

  it("F28: with an action the toast stays until dismissed (not 8 s); without one it keeps the default", () => {
    const withAction = orderCreatedToast({ asDraft: false, created, onViewOrder: jest.fn() });
    expect(withAction.duration).toBeGreaterThanOrEqual(60 * 60 * 1000);
    expect(orderCreatedToast({ asDraft: false, created }).duration).toBeUndefined();
  });

  it("no action without a handler or without a created id — never a dead button", () => {
    expect(orderCreatedToast({ asDraft: false, created }).action).toBeUndefined();
    expect(
      orderCreatedToast({ asDraft: false, created: {}, onViewOrder: jest.fn() }).action,
    ).toBeUndefined();
    expect(orderCreatedToast({ asDraft: false, onViewOrder: jest.fn() }).action).toBeUndefined();
  });

  it("F17: building the toast records the order as this tab's own, for the realtime echo", () => {
    orderCreatedToast({
      asDraft: false,
      created: { id: "o9", orderNumber: "ORD-9" },
      onViewOrder: jest.fn(),
    });
    expect(wasCreatedHere("ORD-9")).toBe(true);
    expect(wasCreatedHere("ORD-10")).toBe(false);
  });
  it("row 604 S6: a new order-created toast replaces the previous one instead of stacking", () => {
    let n = 0;
    const api = { toast: jest.fn(() => `t${++n}`), dismiss: jest.fn() };
    showOrderCreatedToast(api, { asDraft: false, created: { id: "o1", orderNumber: "ORD-1" } });
    expect(api.dismiss).not.toHaveBeenCalled();
    showOrderCreatedToast(api, { asDraft: false, created: { id: "o2", orderNumber: "ORD-2" } });
    expect(api.dismiss).toHaveBeenCalledTimes(1);
    expect(api.dismiss).toHaveBeenCalledWith("t1");
    expect(api.toast).toHaveBeenCalledTimes(2);
    // the echo dedupe still runs for every order
    expect(wasCreatedHere("ORD-1")).toBe(true);
    expect(wasCreatedHere("ORD-2")).toBe(true);
  });
});

describe("N01: the merged toast says what the merge added and the order's new total", () => {
  const created = { id: "ord-16", orderNumber: "ORD-00016", total: 131.94 };

  it("names the added lines and the total FROM THE RESPONSE (never recomputed)", () => {
    const t = orderCreatedToast({
      mergeChoice: "merge",
      created,
      addedLines: [
        { name: "Corn Chips", qty: "3 cases" },
        { name: "Iced Tea", qty: "2" },
      ],
    });
    expect(t.title).toBe("Merged into order ORD-00016");
    expect(t.description).toBe("+3 cases Corn Chips, +2 Iced Tea · new total $131.94");
  });

  it("a response total that arrives as a string (Decimal) is shown as returned", () => {
    const t = orderCreatedToast({
      mergeChoice: "merge",
      created: { ...created, total: "131.9" as unknown as number },
      addedLines: [{ name: "Corn Chips", qty: "3 cases" }],
    });
    expect(t.description).toBe("+3 cases Corn Chips · new total $131.90");
  });

  it("with no total in the response it still names the lines, and states no total", () => {
    const t = orderCreatedToast({
      mergeChoice: "merge",
      created: { id: "ord-16", orderNumber: "ORD-00016" },
      addedLines: [{ name: "Corn Chips", qty: "3 cases" }],
    });
    expect(t.description).toBe("+3 cases Corn Chips");
  });

  it("a long merge lists the first three lines and counts the rest", () => {
    const t = orderCreatedToast({
      mergeChoice: "merge",
      created,
      addedLines: ["A", "B", "C", "D", "E"].map((name) => ({ name, qty: "1" })),
    });
    expect(t.description).toBe("+1 A, +1 B, +1 C, +2 more · new total $131.94");
  });

  it("keeps the persistent duration and the View Merged Order action", () => {
    const onViewOrder = jest.fn();
    const t = orderCreatedToast({
      mergeChoice: "merge",
      created,
      onViewOrder,
      addedLines: [{ name: "Corn Chips", qty: "3 cases" }],
    });
    expect(t.action?.label).toBe("View Merged Order");
    expect(t.duration).toBe(ACTION_TOAST_MS);
  });

  it("a plain create or draft toast gets no description", () => {
    const t = orderCreatedToast({ created, addedLines: [{ name: "Corn Chips", qty: "3" }] });
    expect(t.description).toBeUndefined();
  });

  it("describes a submitted line in its own unit words", () => {
    expect(addedLineQty({ qty: 5 })).toBe("5");
    expect(addedLineQty({ qty: 30, unitsPerBox: 12, boxes: 2, pieces: 6 })).toBe("2 boxes + 6 pcs");
    expect(addedLineQty({ qty: 12, unitsPerBox: 12, boxes: 1, pieces: 0 })).toBe("1 box");
    expect(addedLineQty({ qty: 4, unitLabel: "tray" })).toBe("4 tray");
    expect(addedLineQty({ qty: 24, unitsPerBox: 12, boxes: 2, pieces: 0, packLabel: "Case" })).toBe(
      "2 cases",
    );
  });
});
