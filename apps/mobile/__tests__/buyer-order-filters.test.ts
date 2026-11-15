/** UX guide B12: the buyer Orders chips -> query params, and the filtered empty-state line. */
import { buyerOrderQuery, buyerOrdersEmptyText } from "../lib/buyer-order-filters";

describe("buyerOrderQuery", () => {
  it("Active asks for the ACTIVE group, no single status", () => {
    expect(buyerOrderQuery("ACTIVE")).toEqual({ statusGroup: "ACTIVE" });
  });
  it("guard: All sends nothing; Pending sends only PENDING", () => {
    expect(buyerOrderQuery("ALL")).toEqual({});
    expect(buyerOrderQuery("PENDING")).toEqual({ status: "PENDING" });
  });
});

describe("buyerOrdersEmptyText", () => {
  it("names the filter instead of claiming no orders exist", () => {
    expect(buyerOrdersEmptyText("CANCELLED")).toBe("No cancelled orders.");
    expect(buyerOrdersEmptyText("OUT_FOR_DELIVERY")).toBe("No out for delivery orders.");
  });
  it("guard: All keeps No orders yet.", () => {
    expect(buyerOrdersEmptyText("ALL")).toBe("No orders yet.");
  });
});
