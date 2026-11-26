import {
  DELIVERED_LINE_LOCK_HINT,
  deliveredLockedLineIds,
  isLineDeliveredLocked,
  lockedLineHint,
  savedTitle,
  CORRECTED_SAVED_TITLE,
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

describe("SA-1506: the server's lineEditMode decides (L-072, no second rule)", () => {
  it("LOCKED is locked on any status; CORRECT and EDIT never are", () => {
    expect(isLineDeliveredLocked("CONFIRMED", { id: "a", lineEditMode: "LOCKED" })).toBe(true);
    expect(
      isLineDeliveredLocked("PARTIALLY_DELIVERED", {
        id: "a",
        lineEditMode: "CORRECT",
        deliveredQty: 3,
      }),
    ).toBe(false);
    expect(
      isLineDeliveredLocked("PARTIALLY_DELIVERED", {
        id: "a",
        lineEditMode: "EDIT",
        deliveredQty: 3,
      }),
    ).toBe(false);
  });
  it("a line with no field falls back to the B1234 rule (older server)", () => {
    expect(isLineDeliveredLocked("PARTIALLY_DELIVERED", { id: "a", deliveredQty: 3 })).toBe(true);
    expect(isLineDeliveredLocked("CONFIRMED", { id: "a", deliveredQty: 3 })).toBe(false);
  });
  it("a reason's sentence is the shared copy, with the item and invoice words filled", () => {
    expect(lockedLineHint({ lockedReason: "REOPEN_FIRST" })).toBe(
      "Reopen the order to correct delivered items.",
    );
    expect(lockedLineHint({ lockedReason: "WRITTEN_OFF", lockedInvoiceNumber: "INV-9" })).toContain(
      "INV-9",
    );
    expect(lockedLineHint({ lockedReason: "UNIT" }, "Cola")).toMatch(/^Cola is sold by unit/);
    expect(lockedLineHint({ lockedReason: "STATUS", lockedStatus: "CANCELLED" })).toMatch(
      /cancelled/,
    );
  });
  it("ROLE: an operator is told who can correct; otherwise the old hint", () => {
    expect(lockedLineHint({ lockedReason: "ROLE", lockedOperatorNote: true })).toBe(
      "Delivered. Only an admin can correct a delivered line.",
    );
    expect(lockedLineHint({ lockedReason: "ROLE" })).toBe(DELIVERED_LINE_LOCK_HINT);
  });
  it("no admin-facing sentence says a line can't be changed or removed", () => {
    for (const r of [
      "REOPEN_FIRST",
      "ON_RUN",
      "ROUTE",
      "RETURN",
      "SPLIT_BILL",
      "WRITTEN_OFF",
      "SHIPMENT_BILLED",
    ] as const)
      expect(lockedLineHint({ lockedReason: r })).not.toMatch(/can't be changed or removed/);
  });
  it("the save toast names a correction only when a correctable line was touched or taken off", () => {
    const order = { lineItems: [{ id: "c", lineEditMode: "CORRECT" as const }, { id: "e" }] };
    const it = (id: string, qty: number, correctable = false) => ({
      id,
      qty,
      originalQty: 5,
      cancelled: false,
      correctable,
    });
    expect(savedTitle(order, [it("c", 4, true), it("e", 5)], [])).toBe(CORRECTED_SAVED_TITLE);
    expect(savedTitle(order, [it("e", 4)], [])).toBe("Order updated");
    expect(savedTitle(order, [it("e", 5)], ["c"])).toBe(CORRECTED_SAVED_TITLE);
  });
});
