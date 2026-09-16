import { assertMoneyInvariants, MoneyInvariantError } from "./money-invariants";

describe("assertMoneyInvariants", () => {
  it("passes for an ordinary, fully-positive breakdown", () => {
    expect(() =>
      assertMoneyInvariants({ subtotal: 100, discount: 10, tax: 8, shipping: 5, total: 103 }),
    ).not.toThrow();
  });

  it("passes with discount/tax/shipping omitted (default to 0)", () => {
    expect(() => assertMoneyInvariants({ subtotal: 50, total: 50 })).not.toThrow();
  });

  it.each([
    ["subtotal", { subtotal: -1, total: -1 }],
    ["discount", { subtotal: 10, discount: -5, total: 15 }],
    ["tax", { subtotal: 10, tax: -1, total: 9 }],
    ["shipping", { subtotal: 10, shipping: -1, total: 9 }],
    ["total", { subtotal: 10, total: -1 }],
  ])("throws MoneyInvariantError when %s is negative", (name, input) => {
    expect(() => assertMoneyInvariants(input as any)).toThrow(MoneyInvariantError);
    try {
      assertMoneyInvariants(input as any);
    } catch (e) {
      expect((e as MoneyInvariantError).code).toBe("MONEY_INVARIANT");
      expect((e as MoneyInvariantError).message).toContain(name);
    }
  });

  it("throws MoneyInvariantError when discount exceeds subtotal, even with a total the caller computed as non-negative", () => {
    // Mirrors the B451 gap-4 repro: subtotal 4.99, discount 500 — a caller that
    // (wrongly) floors `total` at 0 before calling this would otherwise sneak
    // past a total-only check. The discount>subtotal check is independent.
    expect(() => assertMoneyInvariants({ subtotal: 4.99, discount: 500, total: 0 })).toThrow(
      MoneyInvariantError,
    );
  });

  it("REGRESSION PIN (B451): the exact orders.service.ts gap-4 repro throws", () => {
    // 1 x $4.99 line, discountAmount 500 — total = 4.99 - 500 = -495.01.
    const subtotal = 4.99;
    const discount = 500;
    const total = subtotal - discount;
    expect(() => assertMoneyInvariants({ subtotal, discount, total })).toThrow(MoneyInvariantError);
  });

  it("REGRESSION PIN (B451): the exact estimates.service.ts gap-4 repro throws", () => {
    // No items -> subtotal 0, discount 500 -> total = -500.
    const subtotal = 0;
    const discount = 500;
    const total = subtotal - discount;
    expect(() => assertMoneyInvariants({ subtotal, discount, total })).toThrow(MoneyInvariantError);
  });

  it("REGRESSION PIN (B451): the exact vendor-bills.service.ts gap-4 repro throws", () => {
    // qty 1, unitCost -500 -> pre-tax items total -500, no tax -> totalOwed -500.
    const itemsTotal = -500;
    const tax = 0;
    const totalOwed = itemsTotal + tax;
    expect(() => assertMoneyInvariants({ subtotal: itemsTotal, tax, total: totalOwed })).toThrow(
      MoneyInvariantError,
    );
  });
});
