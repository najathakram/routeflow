import { decideStaffOverride } from "./index";

/**
 * #2696(c) / SA-558 + SA-558a — ONE rule for a staff-typed price on an order line, shared by the
 * api (create + substitute), web and mobile (their "needs a reason" check IS
 * `decideStaffOverride(...).refused === "REASON_REQUIRED"`, never a mirrored predicate).
 *   - within ½¢ of the baseline (the customer's tier price) ⇒ NOT an override: SPECIAL on a
 *     special-tier line, STANDARD otherwise; the clean baseline is kept (never the near-miss float);
 *   - a real change on a SPECIAL line with no reason ⇒ refused (the api owns the 400 text);
 *   - otherwise an override: < list ⇒ DISCOUNTED, ≥ list ⇒ MANUAL, originalPrice = list, the
 *     price rounded to cents.
 */
const SPECIAL = { baselinePrice: 8, listPrice: 10, isSpecialTier: true };
const STANDARD_LINE = { baselinePrice: 10, listPrice: 10, isSpecialTier: false };

describe("#2696(c) decideStaffOverride — the decision matrix", () => {
  it.each([
    ["the tier price itself", 8],
    // Inside the ½¢ band. The band test is the api's own `Math.abs(p - base) <= 0.005` verbatim
    // (byte-identical with the substitute path), so an exact-½¢ literal like 8.005 falls either
    // side of it with binary float; the pins sit clearly inside.
    ["0.4¢ above", 8.004],
    ["0.4¢ below", 7.996],
  ])("special line, %s ⇒ stays SPECIAL at the clean tier price, no reason needed", (_l, p) => {
    expect(decideStaffOverride({ ...SPECIAL, overridePrice: p, hasReason: false })).toEqual({
      priceType: "SPECIAL",
      unitPrice: 8,
      originalPrice: 10,
    });
  });

  it.each([
    ["just past ½¢ above", 8.006],
    ["between tier and list", 9],
    ["at list", 10],
    ["above list", 12],
    ["below tier", 7],
  ])("special line, %s, NO reason ⇒ refused (reason required)", (_l, p) => {
    expect(decideStaffOverride({ ...SPECIAL, overridePrice: p, hasReason: false })).toEqual({
      refused: "REASON_REQUIRED",
    });
  });

  it("special line with a reason, below list ⇒ DISCOUNTED, rounded to cents, originalPrice = list", () => {
    expect(decideStaffOverride({ ...SPECIAL, overridePrice: 9.456, hasReason: true })).toEqual({
      priceType: "DISCOUNTED",
      unitPrice: 9.46,
      originalPrice: 10,
    });
  });

  it.each([
    ["at list", 10, 10],
    ["above list (an upsell)", 12.004, 12],
  ])("special line with a reason, %s ⇒ MANUAL", (_l, p, rounded) => {
    expect(decideStaffOverride({ ...SPECIAL, overridePrice: p, hasReason: true })).toEqual({
      priceType: "MANUAL",
      unitPrice: rounded,
      originalPrice: 10,
    });
  });

  it("a non-special line: the list price itself ⇒ STANDARD, originalPrice null", () => {
    expect(decideStaffOverride({ ...STANDARD_LINE, overridePrice: 10, hasReason: false })).toEqual({
      priceType: "STANDARD",
      unitPrice: 10,
      originalPrice: null,
    });
  });

  it("a non-special line never needs a reason: below list ⇒ DISCOUNTED, above ⇒ MANUAL", () => {
    expect(decideStaffOverride({ ...STANDARD_LINE, overridePrice: 8, hasReason: false })).toEqual({
      priceType: "DISCOUNTED",
      unitPrice: 8,
      originalPrice: 10,
    });
    expect(decideStaffOverride({ ...STANDARD_LINE, overridePrice: 11, hasReason: false })).toEqual({
      priceType: "MANUAL",
      unitPrice: 11,
      originalPrice: 10,
    });
  });
});
