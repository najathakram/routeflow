import {
  DELIVERED_LINE_LOCK_HINT,
  deleteUpdates,
  takeOffFields,
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
  // SA-1546 M1 (lead ruling): master's web rule stays for a line the server marks LOCKED until the server enforces LOCKED itself:
  // the screen locks it on PARTIALLY_DELIVERED only. Only CORRECT changes what the screen does.
  it("an operator can still reprice a delivered line on a DELIVERED order; on PARTIALLY_DELIVERED it stays locked", () => {
    const operatorLine = {
      id: "a",
      deliveredQty: 3,
      lineEditMode: "LOCKED" as const,
      lockedReason: "ROLE" as const,
      lockedOperatorNote: true,
    };
    expect(isLineDeliveredLocked("DELIVERED", operatorLine)).toBe(false);
    expect(deliveredLockedLineIds("DELIVERED", [operatorLine]).size).toBe(0);
    expect(isLineDeliveredLocked("PARTIALLY_DELIVERED", operatorLine)).toBe(true);
    expect([...deliveredLockedLineIds("PARTIALLY_DELIVERED", [operatorLine])]).toEqual(["a"]);
  });
  it("a LOCKED line on any other status than PARTIALLY_DELIVERED is not locked on the screen (master's rule)", () => {
    for (const status of ["CONFIRMED", "OUT_FOR_DELIVERY", "DELIVERED", "PENDING"])
      expect(isLineDeliveredLocked(status, { id: "a", lineEditMode: "LOCKED" })).toBe(false);
    expect(isLineDeliveredLocked(undefined, { id: "a", lineEditMode: "LOCKED" })).toBe(false);
  });
  it("PARTIALLY_DELIVERED locks a LOCKED line; CORRECT and EDIT never lock", () => {
    expect(isLineDeliveredLocked("PARTIALLY_DELIVERED", { id: "a", lineEditMode: "LOCKED" })).toBe(
      true,
    );
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

describe("take-off payload (SA-1533 (s))", () => {
  const lines = [
    { id: "ok", lineEditMode: "CORRECT" as const },
    { id: "locked", lineEditMode: "LOCKED" as const },
    { id: "plain", lineEditMode: "EDIT" as const },
    { id: "old" },
  ];

  it("a take-off of a line the server said is CORRECT carries deliveredTo 0", () => {
    expect(takeOffFields(lines[0])).toEqual({ deliveredTo: 0 });
    expect(deleteUpdates(lines, ["ok"])).toEqual([{ id: "ok", action: "DELETE", deliveredTo: 0 }]);
  });

  it("every other line, and a line the screen does not know, is a bare DELETE", () => {
    expect(takeOffFields(undefined)).toEqual({});
    expect(deleteUpdates(lines, ["locked", "plain", "old", "gone"])).toEqual([
      { id: "locked", action: "DELETE" },
      { id: "plain", action: "DELETE" },
      { id: "old", action: "DELETE" },
      { id: "gone", action: "DELETE" },
    ]);
  });
});
