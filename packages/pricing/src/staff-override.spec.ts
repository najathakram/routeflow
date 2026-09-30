import { decideStaffOverride, needsOverrideReason, withinStaffOverrideTolerance } from "./index";

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

// SA-558b (3): ONE exported predicate, called by decideStaffOverride AND by the api's existing-line
// edit (baseline = the STORED price, hasReason = sent-or-stored) and add-during-edit (baseline = the
// tier price). Clients call it with each action's baseline too. Its matrix is pinned once, here.
describe("#2696(c) needsOverrideReason — the one predicate", () => {
  const base = { baselinePrice: 8, isSpecialTier: true };
  it.each([
    ["the baseline itself", 8, false, false],
    ["inside the ½¢ band", 8.004, false, false],
    ["a real change, no reason", 9, false, true],
    ["a real change, with a reason", 9, true, false],
  ])("special line, %s ⇒ needs a reason: %s", (_l, p, hasReason, expected) => {
    expect(needsOverrideReason({ ...base, overridePrice: p, hasReason })).toBe(expected);
  });
  it("a non-special line never needs a reason", () => {
    expect(
      needsOverrideReason({
        baselinePrice: 10,
        isSpecialTier: false,
        overridePrice: 3,
        hasReason: false,
      }),
    ).toBe(false);
  });
  it("decideStaffOverride refuses exactly when needsOverrideReason is true", () => {
    for (const p of [7, 7.996, 8, 8.004, 8.006, 9, 10, 12]) {
      for (const hasReason of [false, true]) {
        const refused =
          "refused" in
          decideStaffOverride({
            overridePrice: p,
            baselinePrice: 8,
            listPrice: 10,
            isSpecialTier: true,
            hasReason,
          });
        expect(refused).toBe(
          needsOverrideReason({
            overridePrice: p,
            baselinePrice: 8,
            isSpecialTier: true,
            hasReason,
          }),
        );
      }
    }
  });
});

/**
 * SA-588 — the ±½¢ band is decided in 4-dp units through the one `round4`, never with a raw float
 * subtraction (`Math.abs(a - b) <= 0.005` put 3,224 of 28,572 exact-½¢ cases OUT of band).
 */
describe("SA-588 withinStaffOverrideTolerance — exact ½¢ boundary is deterministic", () => {
  const cents = (n: number) => n / 100;
  const bases: number[] = [];
  for (const mag of [1, 7, 13, 99, 250, 1234, 9999, 55555, 99999]) {
    for (let c = 1; c <= 99; c += 2) bases.push(mag + cents(c));
  }
  bases.push(0.01, 0.02, 0.5, 99999.99);

  it("exactly ±0.005 from every base is IN band (both directions)", () => {
    const out: string[] = [];
    for (const base of bases) {
      for (const sign of [1, -1]) {
        const p = base + sign * 0.005;
        if (!withinStaffOverrideTolerance(p, base)) out.push(`${base}${sign > 0 ? "+" : "-"}`);
        if (!withinStaffOverrideTolerance(base, p)) out.push(`rev ${base}${sign > 0 ? "+" : "-"}`);
      }
    }
    expect(out).toEqual([]);
  });

  it("one 4-dp unit beyond (±0.0051) is OUT of band", () => {
    const out: string[] = [];
    for (const base of bases) {
      for (const sign of [1, -1]) {
        if (withinStaffOverrideTolerance(base + sign * 0.0051, base)) out.push(`${base}`);
      }
    }
    expect(out).toEqual([]);
  });

  it("the 1.00005-style 5-dp literal cases agree with round4 semantics", () => {
    expect(withinStaffOverrideTolerance(1.0055, 1.0005)).toBe(true);
    expect(withinStaffOverrideTolerance(1.0056, 1.0005)).toBe(false);
  });

  it("needsOverrideReason and decideStaffOverride use the same band at the boundary", () => {
    const out: string[] = [];
    for (const base of bases) {
      const p = base + 0.005;
      if (
        needsOverrideReason({
          overridePrice: p,
          baselinePrice: base,
          isSpecialTier: true,
          hasReason: false,
        })
      )
        out.push(`needs ${base}`);
      const d = decideStaffOverride({
        overridePrice: p,
        baselinePrice: base,
        listPrice: base + 1,
        isSpecialTier: true,
        hasReason: false,
      });
      if ("refused" in d) out.push(`decide ${base}`);
    }
    expect(out).toEqual([]);
  });
});
