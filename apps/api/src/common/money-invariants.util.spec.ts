import { BadRequestException } from "@nestjs/common";
import {
  assertMoneyInvariantsOrThrow,
  assertNoNegativeLineSubtotal,
  assertInvoiceTotalsSane,
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
      "Invoice discount (100) cannot exceed subtotal (10).",
    );
  });

  it("allows a discount equal to the subtotal", () => {
    expect(() => assertInvoiceTotalsSane({ discount: 10, subtotal: 10, total: 0 })).not.toThrow();
  });

  it("refuses a negative total even when the discount is within the subtotal (e.g. a negative levy)", () => {
    expect(() => assertInvoiceTotalsSane({ discount: 5, subtotal: 10, total: -0.5 })).toThrow(
      "Invoice total cannot be negative (calculated: -0.5).",
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
