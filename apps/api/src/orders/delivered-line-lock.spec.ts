import { ConflictException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import {
  assertDeliveredLinesUntouched,
  deliveredLockApplies,
  isDeliveredLine,
  type DeliveredLockLine,
} from "./delivered-line-lock";

/**
 * B1234 (D-O2-a): the pure guard. The service-level behaviour is pinned in
 * orders.delivered-line-lock.spec.ts; this pins the predicate and every payload shape.
 */
const PD = { status: "PARTIALLY_DELIVERED" };
const staff = { role: UserRole.OPERATOR };

const DELIVERED: DeliveredLockLine = {
  id: "d",
  productId: "p1",
  qty: 10,
  boxes: null,
  pieces: null,
  unitLabel: null,
  unitPrice: "4.50",
  deliveredQty: "4",
};
const OPEN: DeliveredLockLine = { ...DELIVERED, id: "o", productId: "p2", deliveredQty: 0 };

const refuses = (items: any[], opts: { replaceAll?: boolean; role?: any; diff?: boolean } = {}) =>
  expect(() =>
    assertDeliveredLinesUntouched(
      PD,
      [DELIVERED, OPEN],
      { items, replaceAll: opts.replaceAll },
      { role: opts.role ?? UserRole.OPERATOR },
      opts.diff ?? true,
    ),
  ).toThrow(ConflictException);
const allows = (items: any[], opts: { replaceAll?: boolean; role?: any; diff?: boolean } = {}) =>
  expect(() =>
    assertDeliveredLinesUntouched(
      PD,
      [DELIVERED, OPEN],
      { items, replaceAll: opts.replaceAll },
      { role: opts.role ?? UserRole.OPERATOR },
      opts.diff ?? true,
    ),
  ).not.toThrow();

describe("isDeliveredLine / deliveredLockApplies", () => {
  it("delivered = any delivered quantity; string decimals count", () => {
    expect(isDeliveredLine({ deliveredQty: 0 })).toBe(false);
    expect(isDeliveredLine({ deliveredQty: "0" })).toBe(false);
    expect(isDeliveredLine({ deliveredQty: null })).toBe(false);
    expect(isDeliveredLine({})).toBe(false);
    expect(isDeliveredLine({ deliveredQty: "0.5" })).toBe(true);
    expect(isDeliveredLine({ deliveredQty: 4 })).toBe(true);
  });

  it("applies to PARTIALLY_DELIVERED only", () => {
    expect(deliveredLockApplies("PARTIALLY_DELIVERED")).toBe(true);
    for (const s of ["DRAFT", "PENDING", "CONFIRMED", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"])
      expect(deliveredLockApplies(s)).toBe(false);
    expect(deliveredLockApplies(undefined)).toBe(false);
  });
});

describe("assertDeliveredLinesUntouched: per-line (merge) payloads", () => {
  it("refuses a quantity change, a price change, a substitution, a unit change, a CANCEL and a DELETE", () => {
    refuses([{ id: "d", action: "UPDATE", qty: 9 }]);
    refuses([{ id: "d", qty: 11 }]);
    refuses([{ id: "d", action: "UPDATE", qty: 10, unitPrice: 4 }]);
    refuses([{ id: "d", substituteProductId: "p9" }]);
    refuses([{ id: "d", productId: "p9", qty: 10 }]);
    refuses([{ id: "d", unitLabel: "Case", qty: 10 }]);
    refuses([{ id: "d", action: "CANCEL" }]);
    refuses([{ id: "d", action: "DELETE" }]);
    refuses([{ orderItemId: "d", qty: 3 }]); // a buyer-shaped entry names the line the same way
  });

  it("refuses a box/piece change, and allows the same split restated", () => {
    const split = { ...DELIVERED, qty: 26, boxes: 2, pieces: 2, unitsPerBox: 12 };
    const run = (entry: any) =>
      assertDeliveredLinesUntouched(PD, [split], { items: [entry] }, staff, true);
    expect(() => run({ id: "d", boxes: 3, pieces: 2 })).toThrow(ConflictException);
    expect(() => run({ id: "d", boxes: 2, pieces: 1 })).toThrow(ConflictException);
    expect(() => run({ id: "d", qty: 26, boxes: 2, pieces: 2 })).not.toThrow();
  });

  it("a unit-aware line compares its COUNT (stored in boxes), not the base-piece qty", () => {
    const unit = { ...DELIVERED, unitLabel: "Case", qty: 48, boxes: 4 };
    const run = (entry: any) =>
      assertDeliveredLinesUntouched(PD, [unit], { items: [entry] }, staff, true);
    expect(() => run({ id: "d", qty: 5, unitLabel: "Case" })).toThrow(ConflictException);
    expect(() => run({ id: "d", qty: 4, unitLabel: "Case" })).not.toThrow();
  });

  it("allows a restated value, a note, a reason-only entry and a price within half a cent", () => {
    allows([{ id: "d", action: "UPDATE", qty: 10, notes: "left at dock" }]);
    allows([{ id: "d", action: "UPDATE", qty: 10, unitPrice: 4.5, notes: "x" }]);
    allows([{ id: "d", action: "UPDATE", qty: 10.0001, unitPrice: 4.501 }]);
    allows([{ id: "d", overrideReason: "damaged" }]);
    allows([{ id: "d", notes: "n" }]);
  });

  it("touches only delivered lines: every edit of an UNDELIVERED line, and a new line, is allowed", () => {
    allows([{ id: "o", action: "UPDATE", qty: 1, unitPrice: 1 }]);
    allows([{ id: "o", action: "DELETE" }]);
    allows([{ id: "o", action: "CANCEL" }]);
    allows([{ id: "o", substituteProductId: "p9" }]);
    allows([{ productId: "p1", qty: 2 }]); // an id-less add, even for a delivered line's product
    allows([{ name: "Ad hoc", qty: 1, unitPrice: 2 }]);
    allows([
      { id: "o", action: "UPDATE", qty: 3 },
      { id: "d", action: "UPDATE", qty: 10, notes: "ok" },
    ]);
  });

  it("one locked entry among allowed ones refuses the whole edit", () => {
    refuses([
      { id: "o", action: "UPDATE", qty: 3 },
      { id: "d", action: "UPDATE", qty: 9 },
    ]);
  });
});

describe("assertDeliveredLinesUntouched: replace modes", () => {
  it("a staff replace-all is refused while any line is delivered, whatever the payload says", () => {
    refuses([{ productId: "p1", qty: 10 }], { replaceAll: true });
    refuses([], { replaceAll: true });
  });

  it("a driver or buyer full-list (non-diff) save is refused too; their per-line diff follows the line rules", () => {
    refuses([{ productId: "p1", qty: 10 }], { role: UserRole.DRIVER, diff: false });
    refuses([{ productId: "p1", qty: 10 }], { role: UserRole.CUSTOMER, diff: false });
    refuses([{ id: "d", action: "CANCEL" }], { role: UserRole.DRIVER, diff: true });
    allows([{ id: "o", action: "UPDATE", qty: 3 }], { role: UserRole.DRIVER, diff: true });
  });

  it("a replace on an order with NOTHING delivered is not refused by the lock", () => {
    expect(() =>
      assertDeliveredLinesUntouched(
        PD,
        [OPEN],
        { items: [{ productId: "p2", qty: 5 }], replaceAll: true },
        staff,
        false,
      ),
    ).not.toThrow();
  });
});

describe("assertDeliveredLinesUntouched: every other status is untouched", () => {
  it.each(["DRAFT", "PENDING", "CONFIRMED", "OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"])(
    "%s: no refusal for any payload",
    (status) => {
      for (const items of [
        [{ id: "d", action: "DELETE" }],
        [{ id: "d", action: "UPDATE", qty: 1, unitPrice: 1 }],
      ])
        expect(() =>
          assertDeliveredLinesUntouched({ status }, [DELIVERED], { items }, staff, true),
        ).not.toThrow();
      expect(() =>
        assertDeliveredLinesUntouched(
          { status },
          [DELIVERED],
          { items: [], replaceAll: true },
          staff,
          true,
        ),
      ).not.toThrow();
    },
  );
});

describe("the refusal", () => {
  it("is a 409 with the coded body and fixed copy", () => {
    try {
      assertDeliveredLinesUntouched(
        PD,
        [DELIVERED],
        { items: [{ id: "d", action: "DELETE" }] },
        staff,
        true,
      );
      throw new Error("expected a refusal");
    } catch (e: any) {
      expect(e).toBeInstanceOf(ConflictException);
      expect(e.getStatus()).toBe(409);
      expect(e.getResponse()).toMatchObject({ code: "ORDER_LINE_DELIVERED_LOCKED" });
      expect(JSON.stringify(e.getResponse())).not.toMatch(/[–—]/);
    }
  });
});
