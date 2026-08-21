/**
 * BUY_N_GET_M ("buy N get M free") — mobile mirror parity.
 *
 * Pins `applyBestPromotion` / `computeLineSubtotal`'s BOGO behavior in the
 * MOBILE copy of the pricing engine to the exact same numbers as the server
 * spec (`apps/api/src/common/pricing.spec.ts`) and the web mirror. The
 * Promotions block itself is asserted byte-identical across all three
 * mirrors in the api spec (`mirror parity` describe block); this file locks
 * that the mobile EXPORTS actually behave the same, not just look the same.
 *
 * Money is the whole point here: free units must reduce the line SUBTOTAL
 * exactly (never a rounded net-unit-price — 35 × 5/6 = 29.1667 would drift
 * cents when multiplied back). See apps/api/src/common/pricing.ts's header.
 */
import {
  applyBestPromotion,
  computeLineSubtotal,
  roundMoney,
  type PromotionRule,
} from "../lib/pricing";

const promo = (
  over: Partial<PromotionRule> & Pick<PromotionRule, "id" | "type">,
): PromotionRule => ({
  value: 0,
  scope: "ALL",
  minQty: null,
  category: null,
  productIds: null,
  ...over,
});

const bogo = (id: string, n: number, m: number) =>
  promo({ id, type: "BUY_N_GET_M", minQty: n, value: m });

const ctxUnits = (qtyUnits: number) => ({
  productId: "p1",
  category: "Beverages",
  qtyPieces: qtyUnits,
  qtyUnits,
});

describe("applyBestPromotion (mobile mirror) — BUY_N_GET_M owner's exact table", () => {
  it.each([
    [5, 0],
    [6, 1],
    [11, 1],
    [12, 2],
    [18, 3],
  ])("N=5,M=1: %i whole units → %i free", (qtyUnits, expectedFree) => {
    const r = applyBestPromotion(35, [bogo("a", 5, 1)], ctxUnits(qtyUnits));
    expect(r.freeUnits).toBe(expectedFree);
    if (expectedFree > 0) {
      expect(r.appliedPromoId).toBe("a");
      expect(r.unitPrice).toBe(35); // never a faked/rounded net price for this type
      expect(r.originalPrice).toBeNull();
    } else {
      expect(r.appliedPromoId).toBeNull();
    }
  });
});

describe("applyBestPromotion (mobile mirror) — pieces never count toward BUY_N_GET_M", () => {
  it("loose pieces below a full box never earn or receive free units", () => {
    // 5 whole boxes + 40 loose pieces — still 0 free; qtyUnits is whole
    // SELLING units only (boxes for a boxed line), never pieces.
    const r = applyBestPromotion(35, [bogo("a", 5, 1)], {
      productId: "p1",
      category: "Beverages",
      qtyPieces: 5 * 24 + 40,
      qtyUnits: 5,
    });
    expect(r.freeUnits).toBe(0);
    expect(r.appliedPromoId).toBeNull();
  });

  it("the 6th WHOLE box (not more loose pieces) earns the free unit", () => {
    const r = applyBestPromotion(35, [bogo("a", 5, 1)], {
      productId: "p1",
      category: "Beverages",
      qtyPieces: 6 * 24,
      qtyUnits: 6,
    });
    expect(r.freeUnits).toBe(1);
    expect(r.appliedPromoId).toBe("a");
  });
});

describe("computeLineSubtotal (mobile mirror) — BUY_N_GET_M exactness", () => {
  it("$35 base × 12 boxes, 2 free, is exactly $350.00 — matches the server to the cent", () => {
    const r = applyBestPromotion(35, [bogo("a", 5, 1)], ctxUnits(12));
    expect(r.freeUnits).toBe(2);
    expect(r.unitPrice).toBe(35);

    const subtotal = computeLineSubtotal({
      unitPrice: r.unitPrice,
      qty: 12,
      boxes: 12,
      pieces: 0,
      unitsPerBox: 6,
      freeUnits: r.freeUnits,
    });
    expect(subtotal).toBe(350);
    // Guard the impossible drift: a rounded net-unit-price (35 × 5/6 = 29.17)
    // multiplied back by 12 would be $350.04, four cents off.
    expect(subtotal).not.toBe(roundMoney((35 * 5) / 6) * 12);
  });

  it("clamps freeUnits to the line's available whole units — never negative", () => {
    expect(
      computeLineSubtotal({
        unitPrice: 35,
        qty: 18,
        boxes: 3,
        pieces: 0,
        unitsPerBox: 6,
        freeUnits: 9,
      }),
    ).toBe(0);
  });

  it("defaults freeUnits to 0 — every existing call site is unaffected", () => {
    expect(computeLineSubtotal({ unitPrice: 220, qty: 2 })).toBe(440);
    expect(
      computeLineSubtotal({ unitPrice: 220, qty: 22, boxes: 2, pieces: 0, unitsPerBox: 11 }),
    ).toBe(440);
  });
});

describe("applyBestPromotion (mobile mirror) — best-of vs PERCENT, both directions", () => {
  it("BUY_N_GET_M wins when its saving is larger", () => {
    const r = applyBestPromotion(
      35,
      [bogo("bogo", 5, 1), promo({ id: "pct", type: "PERCENT", value: 10 })],
      ctxUnits(12),
    );
    // BOGO saves 2 x $35 = $70; PERCENT (10% off 12 units) saves $3.50 x 12 = $42.
    expect(r.appliedPromoId).toBe("bogo");
    expect(r.freeUnits).toBe(2);
    expect(r.unitPrice).toBe(35);
  });

  it("PERCENT wins when its saving is larger", () => {
    const r = applyBestPromotion(
      35,
      [bogo("bogo", 5, 1), promo({ id: "pct", type: "PERCENT", value: 50 })],
      ctxUnits(12),
    );
    // PERCENT (50% off 12 units) saves $17.50 x 12 = $210, beating BOGO's $70.
    expect(r.appliedPromoId).toBe("pct");
    expect(r.freeUnits).toBe(0);
    expect(r.unitPrice).toBe(17.5);
    expect(r.originalPrice).toBe(35);
  });
});

describe("applyBestPromotion (mobile mirror) — value/minQty validation guards", () => {
  it("a non-integer or < 1 N or M is ignored, never a crash", () => {
    const cases: PromotionRule[] = [
      bogo("a", 0, 1),
      bogo("a", 5, 0),
      bogo("a", 5.5, 1),
      bogo("a", 5, 1.5),
      bogo("a", -5, 1),
      promo({ id: "a", type: "BUY_N_GET_M", minQty: null, value: 1 }),
    ];
    for (const rule of cases) {
      expect(() => applyBestPromotion(35, [rule], ctxUnits(12))).not.toThrow();
      const r = applyBestPromotion(35, [rule], ctxUnits(12));
      expect(r.appliedPromoId).toBeNull();
      expect(r.freeUnits).toBe(0);
      expect(r.unitPrice).toBe(35);
    }
  });
});

describe("applyBestPromotion (mobile mirror) — legacy promo output is bit-for-bit unchanged", () => {
  it("re-runs an existing PERCENT/FIXED scenario and asserts identical output", () => {
    const promos = [
      promo({ id: "a", type: "PERCENT", value: 10 }),
      promo({ id: "b", type: "FIXED", value: 25 }),
      promo({ id: "c", type: "PERCENT", value: 5 }),
    ];
    const r = applyBestPromotion(100, promos, {
      productId: "p1",
      category: "Beverages",
      qtyPieces: 1,
      qtyUnits: 7,
    });
    expect(r).toEqual({
      unitPrice: 75,
      originalPrice: 100,
      appliedPromoId: "b",
      freeUnits: 0,
    });
  });
});
