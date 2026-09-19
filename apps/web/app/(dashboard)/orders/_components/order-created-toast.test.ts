import { orderCreatedToast } from "./order-created-toast";

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

  it("keeps the toast up longer only when there is an action to reach for", () => {
    const withAction = orderCreatedToast({ asDraft: false, created, onViewOrder: jest.fn() });
    expect(withAction.duration).toBe(8000);
    expect(orderCreatedToast({ asDraft: false, created }).duration).toBeUndefined();
  });

  it("no action without a handler or without a created id — never a dead button", () => {
    expect(orderCreatedToast({ asDraft: false, created }).action).toBeUndefined();
    expect(
      orderCreatedToast({ asDraft: false, created: {}, onViewOrder: jest.fn() }).action,
    ).toBeUndefined();
    expect(orderCreatedToast({ asDraft: false, onViewOrder: jest.fn() }).action).toBeUndefined();
  });
});
