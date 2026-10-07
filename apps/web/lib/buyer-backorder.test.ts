import {
  SHIPS_WHEN_RESTOCKED,
  canOrderOutOfStock,
  isOrderBlocked,
  stockLine,
} from "./buyer-backorder";

/**
 * OOS PR2 (R3c): the portal reads the server's `canBackorder`. Out of stock + can backorder = "Add"
 * and "Ships when restocked"; out of stock + cannot (or unknown) = blocked, as before.
 */
const oos = (canBackorder?: boolean) => ({
  stockStatus: "OUT_OF_STOCK" as const,
  stockLeft: null,
  canBackorder,
});

describe("canOrderOutOfStock / isOrderBlocked", () => {
  it("out of stock + canBackorder true: orderable, not blocked", () => {
    expect(canOrderOutOfStock(oos(true))).toBe(true);
    expect(isOrderBlocked(oos(true))).toBe(false);
  });

  it.each([[false], [undefined]])(
    "out of stock + canBackorder %p (unknown fails closed): blocked, not orderable",
    (can) => {
      expect(canOrderOutOfStock(oos(can))).toBe(false);
      expect(isOrderBlocked(oos(can))).toBe(true);
    },
  );

  it.each([["IN_STOCK"], ["LOW"], [undefined]] as const)(
    "an item that is in stock (%p) is never blocked, whatever canBackorder says",
    (stockStatus) => {
      for (const canBackorder of [true, false, undefined]) {
        expect(isOrderBlocked({ stockStatus, canBackorder })).toBe(false);
        expect(canOrderOutOfStock({ stockStatus, canBackorder })).toBe(false);
      }
    },
  );
});

describe("stockLine", () => {
  it("out of stock + can backorder says it ships when restocked (a warning, not red)", () => {
    expect(stockLine(oos(true))).toEqual({ label: SHIPS_WHEN_RESTOCKED, cls: "text-warning" });
    expect(SHIPS_WHEN_RESTOCKED).toBe("Ships when restocked");
  });

  it("out of stock + cannot (or unknown) is the plain red Out of stock", () => {
    for (const can of [false, undefined]) {
      expect(stockLine(oos(can))).toEqual({ label: "Out of stock", cls: "text-danger" });
    }
  });

  it("low and in-stock lines are unchanged", () => {
    expect(stockLine({ stockStatus: "LOW", stockLeft: 3 })).toEqual({
      label: "Only 3 left",
      cls: "text-warning",
    });
    expect(stockLine({ stockStatus: "LOW", stockLeft: null })).toEqual({
      label: "Low stock",
      cls: "text-warning",
    });
    expect(stockLine({ stockStatus: "IN_STOCK", stockLeft: null })).toEqual({
      label: "In stock",
      cls: "text-success",
    });
  });
});
