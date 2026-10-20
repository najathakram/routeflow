import {
  DELIVERED_LINE_LOCK_HINT,
  deliveredLockedLineIds,
  isLineDeliveredLocked,
} from "./order-line-lock";

describe("isLineDeliveredLocked (B1234)", () => {
  it("locks a delivered line of a PARTIALLY_DELIVERED order", () => {
    expect(isLineDeliveredLocked("PARTIALLY_DELIVERED", { deliveredQty: 2 })).toBe(true);
    expect(isLineDeliveredLocked("PARTIALLY_DELIVERED", { deliveredQty: "0.5" })).toBe(true);
  });

  it("does not lock an undelivered line", () => {
    expect(isLineDeliveredLocked("PARTIALLY_DELIVERED", { deliveredQty: 0 })).toBe(false);
    expect(isLineDeliveredLocked("PARTIALLY_DELIVERED", { deliveredQty: "0" })).toBe(false);
    expect(isLineDeliveredLocked("PARTIALLY_DELIVERED", { deliveredQty: null })).toBe(false);
    expect(isLineDeliveredLocked("PARTIALLY_DELIVERED", {})).toBe(false);
  });

  it.each(["DRAFT", "PENDING", "CONFIRMED", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"])(
    "%s: nothing is locked (the API changes nothing for these statuses)",
    (status) => {
      expect(isLineDeliveredLocked(status, { deliveredQty: 5 })).toBe(false);
    },
  );

  it("an unknown or missing status locks nothing", () => {
    expect(isLineDeliveredLocked(undefined, { deliveredQty: 5 })).toBe(false);
    expect(isLineDeliveredLocked(null, { deliveredQty: 5 })).toBe(false);
  });
});

describe("deliveredLockedLineIds", () => {
  const lines = [{ id: "a", deliveredQty: 2 }, { id: "b", deliveredQty: 0 }, { id: "c" }];
  it("returns only the delivered lines' ids on a PARTIALLY_DELIVERED order", () => {
    expect([...deliveredLockedLineIds("PARTIALLY_DELIVERED", lines)]).toEqual(["a"]);
  });
  it("returns nothing on any other status", () => {
    expect(deliveredLockedLineIds("DELIVERED", lines).size).toBe(0);
    expect(deliveredLockedLineIds("PENDING", lines).size).toBe(0);
  });
});

describe("copy", () => {
  it("has no em or en dash", () => {
    expect(DELIVERED_LINE_LOCK_HINT).not.toMatch(/[–—]/);
  });
});
