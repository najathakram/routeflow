import { BadRequestException } from "@nestjs/common";
import {
  assertMoneyInvariantsOrThrow,
  assertNoNegativeLineSubtotal,
  assertInvoiceTotalsSane,
  storedInvoiceTotals,
} from "./money-invariants.util";

describe("assertMoneyInvariantsOrThrow (B451 gap 4)", () => {
  it("does not throw for a valid breakdown", () => {
    expect(() =>
      assertMoneyInvariantsOrThrow({ subtotal: 100, discount: 10, total: 90 }),
    ).not.toThrow();
  });

  it("maps a money-invariant violation to a 400 BadRequestException with a stable code — never a 500", () => {
    let caught: unknown;
    try {
      assertMoneyInvariantsOrThrow({ subtotal: 4.99, discount: 500, total: -495.01 });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(BadRequestException);
    const response = (caught as BadRequestException).getResponse() as Record<string, unknown>;
    expect(response.code).toBe("MONEY_INVARIANT");
    expect(typeof response.message).toBe("string");
    expect((caught as BadRequestException).getStatus()).toBe(400);
  });
});

describe("assertNoNegativeLineSubtotal (B659 review finding 5 — extracted out of InvoicesService.create())", () => {
  it("does not throw when every line's subtotal is >= 0", () => {
    expect(() =>
      assertNoNegativeLineSubtotal([
        { description: "A", subtotal: 0 },
        { description: "B", subtotal: 5 },
      ]),
    ).not.toThrow();
  });

  it("throws a 400 naming the offending line when a line's subtotal is negative", () => {
    expect(() => assertNoNegativeLineSubtotal([{ description: "Widget", subtotal: -5 }])).toThrow(
      BadRequestException,
    );
    expect(() => assertNoNegativeLineSubtotal([{ description: "Widget", subtotal: -5 }])).toThrow(
      'Line item "Widget" has a negative subtotal (-5). Discount cannot exceed line total.',
    );
  });

  it("coerces a Decimal-shaped (string/number) subtotal before comparing", () => {
    expect(() =>
      assertNoNegativeLineSubtotal([
        { description: "Widget", subtotal: "-1.50" as unknown as number },
      ]),
    ).toThrow(BadRequestException);
  });
});

describe("assertInvoiceTotalsSane (B1030, extracted from InvoicesService.create())", () => {
  it("refuses a discount above the subtotal with the fixed message (the numbers as given)", () => {
    expect(() => assertInvoiceTotalsSane({ discount: 100, subtotal: 10, total: -90 })).toThrow(
      "Invoice discount ($100.00) cannot exceed subtotal ($10.00).",
    );
  });

  it("allows a discount equal to the subtotal", () => {
    expect(() => assertInvoiceTotalsSane({ discount: 10, subtotal: 10, total: 0 })).not.toThrow();
  });

  it("refuses a negative total even when the discount is within the subtotal (e.g. a negative levy)", () => {
    expect(() => assertInvoiceTotalsSane({ discount: 5, subtotal: 10, total: -0.5 })).toThrow(
      "Invoice total cannot be negative (calculated: -$0.50).",
    );
  });

  it("the discount check runs first (the more specific message wins)", () => {
    expect(() => assertInvoiceTotalsSane({ discount: 100, subtotal: 10, total: -90 })).toThrow(
      /Invoice discount/,
    );
  });

  it("a 400 BadRequestException, like create()", () => {
    try {
      assertInvoiceTotalsSane({ discount: 2, subtotal: 1, total: -1 });
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toMatchObject({ status: 400 });
    }
  });
});

// SA-651: update() applies a NOT-WORSE rule on legacy data. create() stays strict (no `before`).
describe("assertInvoiceTotalsSane NOT-WORSE rule (B1030, SA-651)", () => {
  const SANE = { discount: 0, subtotal: 100, total: 100 };
  const LEGACY = { discount: 80, subtotal: 10, total: -70 }; // already insane: discount > subtotal, total < 0

  it("(1) sane -> insane is refused, with create()'s message", () => {
    expect(() =>
      assertInvoiceTotalsSane({ discount: 100, subtotal: 10, total: -90 }, SANE),
    ).toThrow("Invoice discount ($100.00) cannot exceed subtotal ($10.00).");
  });

  it("(2) insane -> WORSE by total (it goes down) is refused", () => {
    expect(() =>
      assertInvoiceTotalsSane({ discount: 80, subtotal: 10, total: -75 }, LEGACY),
    ).toThrow("Invoice discount ($80.00) cannot exceed subtotal ($10.00).");
  });

  it("(3) insane -> WORSE by discount minus subtotal (it goes up) is refused even when the total holds", () => {
    expect(() =>
      assertInvoiceTotalsSane({ discount: 90, subtotal: 10, total: -70 }, LEGACY),
    ).toThrow("Invoice discount ($90.00) cannot exceed subtotal ($10.00).");
  });

  it("(4) insane -> UNCHANGED saves (a notes-only or no-op edit of a legacy invoice)", () => {
    expect(() => assertInvoiceTotalsSane({ ...LEGACY }, LEGACY)).not.toThrow();
  });

  it("(5) insane -> IMPROVED (total up and discount minus subtotal down) saves, even though it is still insane", () => {
    expect(() =>
      assertInvoiceTotalsSane({ discount: 60, subtotal: 10, total: -50 }, LEGACY),
    ).not.toThrow();
  });

  it("(6) create() stays strict: with no `before`, an insane invoice is always refused", () => {
    expect(() => assertInvoiceTotalsSane(LEGACY)).toThrow(/cannot exceed subtotal/);
  });

  it("(7) a negative TOTAL that is not worse than a legacy negative total saves; a lower one is refused", () => {
    const before = { discount: 5, subtotal: 10, total: -3 };
    expect(() =>
      assertInvoiceTotalsSane({ discount: 5, subtotal: 10, total: -3 }, before),
    ).not.toThrow();
    expect(() => assertInvoiceTotalsSane({ discount: 5, subtotal: 10, total: -4 }, before)).toThrow(
      "Invoice total cannot be negative (calculated: -$4.00).",
    );
  });
});

// SA-651 lead nits: strict when the stored totals are missing; the refusal names the axis in money.
describe("storedInvoiceTotals strictness (B1030)", () => {
  it("normalises Prisma-Decimal-like values", () => {
    const d = (n: number) => ({ toString: () => String(n), valueOf: () => n });
    expect(storedInvoiceTotals({ discount: d(5), subtotal: d(10), total: d(5) })).toEqual({
      discount: 5,
      subtotal: 10,
      total: 5,
    });
  });

  it("a missing row, or a null/undefined stored subtotal or total, is NOT provable (undefined)", () => {
    expect(storedInvoiceTotals(null)).toBeUndefined();
    expect(storedInvoiceTotals({ discount: 80, total: -70 })).toBeUndefined();
    expect(storedInvoiceTotals({ discount: 80, subtotal: null, total: -70 })).toBeUndefined();
    expect(storedInvoiceTotals({ discount: 80, subtotal: 10, total: null })).toBeUndefined();
    expect(storedInvoiceTotals({ discount: 80, subtotal: "abc", total: -70 })).toBeUndefined();
  });

  it("missing stored columns take the strict path: a discount above the subtotal is refused, not exempted as legacy", () => {
    const before = storedInvoiceTotals({ discount: 80, total: -70 }); // subtotal column absent
    expect(() =>
      assertInvoiceTotalsSane({ discount: 80, subtotal: 10, total: -70 }, before),
    ).toThrow(BadRequestException);
  });
});

describe("assertInvoiceTotalsSane refusal names the axis in money (B1030)", () => {
  it("discount axis: names discount and subtotal as money", () => {
    expect(() => assertInvoiceTotalsSane({ discount: 100, subtotal: 10.5, total: -90 })).toThrow(
      "Invoice discount ($100.00) cannot exceed subtotal ($10.50).",
    );
  });

  it("total axis: names the calculated total as money", () => {
    expect(() => assertInvoiceTotalsSane({ discount: 5, subtotal: 10, total: -0.5 })).toThrow(
      "Invoice total cannot be negative (calculated: -$0.50).",
    );
  });
});
