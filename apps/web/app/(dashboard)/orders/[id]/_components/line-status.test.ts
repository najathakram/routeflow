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

/** SA-1066 F15 (R14): a default line on an OPEN pickup order shows no badge; real outcomes still show; delivery is unchanged. */
describe("displayLineStatus on a pickup order", () => {
  const li = (over: Record<string, unknown> = {}) => ({
    status: "PENDING",
    deliveredQty: 0,
    qty: 8,
    ...over,
  });

  it.each(["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY"])(
    "R14: a default line on an open PICKUP order (%s) has no badge",
    (orderStatus) => {
      expect(displayLineStatus(li(), orderStatus, "PICKUP")).toBeNull();
    },
  );

  it("R14 guard: a cancelled line still shows Cancelled on a pickup order", () => {
    expect(displayLineStatus(li({ status: "CANCELLED" }), "CONFIRMED", "PICKUP")).toBe("CANCELLED");
  });

  it("R14 guard: a delivered or partial outcome still shows on a pickup order", () => {
    expect(displayLineStatus(li({ status: "DELIVERED" }), "CONFIRMED", "PICKUP")).toBe("DELIVERED");
    expect(displayLineStatus(li({ status: "PARTIAL" }), "CONFIRMED", "PICKUP")).toBe("PARTIAL");
    expect(displayLineStatus(li({ deliveredQty: 3 }), "CONFIRMED", "PICKUP")).toBe("PARTIAL");
  });

  it("R14 guard: a handed-over (DELIVERED) pickup order reads Delivered, a cancelled one keeps its stored status", () => {
    expect(displayLineStatus(li(), "DELIVERED", "PICKUP")).toBe("DELIVERED");
    expect(displayLineStatus(li(), "CANCELLED", "PICKUP")).toBe("PENDING");
  });

  it.each(["ROUTE", "SHIP", null, undefined])(
    "R14 guard: a default line on a %s order is unchanged (PENDING)",
    (path) => {
      expect(displayLineStatus(li(), "CONFIRMED", path)).toBe("PENDING");
    },
  );
});
