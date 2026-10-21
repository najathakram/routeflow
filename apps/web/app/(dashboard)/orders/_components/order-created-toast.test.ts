import { orderCreatedToast, showOrderCreatedToast } from "./order-created-toast";
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
