import { BadRequestException } from "@nestjs/common";
import { assertMoneyInvariantsOrThrow } from "./money-invariants.util";

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
