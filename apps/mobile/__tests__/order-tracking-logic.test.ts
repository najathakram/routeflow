import { buildReorderItems, canReorder, trackingStepIndex } from "../lib/order-tracking-logic";

describe("buildReorderItems", () => {
  it("drops CANCELLED lines and lines with no productId", () => {
    const order = {
      lineItems: [
        { id: "1", productId: "p1", qty: 3, status: "CONFIRMED" },
        { id: "2", productId: "p2", qty: 1, status: "CANCELLED" },
        { id: "3", productId: "", qty: 2, status: "CONFIRMED" },
      ],
    } as any;
    expect(buildReorderItems(order)).toEqual([{ productId: "p1", qty: 3 }]);
  });

  it("carries boxes/pieces through unchanged for boxed lines", () => {
    const order = {
      lineItems: [{ id: "1", productId: "p1", qty: 24, boxes: 2, pieces: 0, status: "DELIVERED" }],
    } as any;
    expect(buildReorderItems(order)).toEqual([{ productId: "p1", qty: 24, boxes: 2, pieces: 0 }]);
  });

  it("drops zero/negative-qty lines", () => {
    const order = {
      lineItems: [{ id: "1", productId: "p1", qty: 0, status: "CONFIRMED" }],
    } as any;
    expect(buildReorderItems(order)).toEqual([]);
  });
});

describe("canReorder", () => {
  it("is false for DRAFT and PENDING, true otherwise", () => {
    expect(canReorder({ status: "DRAFT" })).toBe(false);
    expect(canReorder({ status: "PENDING" })).toBe(false);
    expect(canReorder({ status: "CONFIRMED" })).toBe(true);
    expect(canReorder({ status: "DELIVERED" })).toBe(true);
    expect(canReorder({ status: "CANCELLED" })).toBe(true);
  });
});

describe("trackingStepIndex", () => {
  it("indexes the happy-path statuses in order", () => {
    expect(trackingStepIndex("PENDING")).toBe(0);
    expect(trackingStepIndex("DELIVERED")).toBe(4);
  });
  it("returns -1 for CANCELLED / unknown", () => {
    expect(trackingStepIndex("CANCELLED")).toBe(-1);
  });
});
