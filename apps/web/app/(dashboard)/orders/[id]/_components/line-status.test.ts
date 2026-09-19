import { displayLineStatus } from "./line-status";

describe("displayLineStatus", () => {
  const li = (over: Record<string, unknown> = {}) => ({
    status: "PENDING",
    deliveredQty: 0,
    qty: 8,
    ...over,
  });

  it.each(["CANCELLED", "DELIVERED", "PARTIAL"])(
    "a real line-level %s outcome always wins, whatever the order or delivery data say",
    (status) => {
      expect(displayLineStatus(li({ status, deliveredQty: 8 }), "CONFIRMED")).toBe(status);
    },
  );

  it("derives DELIVERED / PARTIAL from deliveredQty vs qty when the line is still at its default", () => {
    expect(displayLineStatus(li({ deliveredQty: 8 }), "OUT_FOR_DELIVERY")).toBe("DELIVERED");
    expect(displayLineStatus(li({ deliveredQty: 3 }), "OUT_FOR_DELIVERY")).toBe("PARTIAL");
  });

  it("tolerates fractional-quantity float noise at the boundary", () => {
    expect(displayLineStatus(li({ qty: 0.3, deliveredQty: 0.1 + 0.2 }), "CONFIRMED")).toBe(
      "DELIVERED",
    );
  });

  it("falls back to the order's terminal state, else to the stored status", () => {
    expect(displayLineStatus(li(), "DELIVERED")).toBe("DELIVERED");
    expect(displayLineStatus(li(), "CONFIRMED")).toBe("PENDING");
  });
});
