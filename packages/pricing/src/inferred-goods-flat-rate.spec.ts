import { inferredFlatRate } from "./inferred-flat-rate";
import { inferredGoodsFlatRate, NSF_FEE_DESCRIPTION_PREFIX, NSF_FEE_SYSTEM_KIND } from "./nsf-line";

/**
 * #2656 / SA-549: ONE goods-only inferred flat rate. The NSF bounce-fee line is untaxed and sits in
 * the header subtotal, so it is excluded from the inference — its line AND its money — and the
 * subtracted subtotal is ROUNDED to cents (the API writes, so its rounding is the truth; the mobile
 * and b294 copies did not round and could disagree by a 4-dp step).
 */
const goods = (over: Record<string, unknown> = {}) => ({ taxRate: 0, subtotal: 112, ...over });
const fee = (subtotal: number, over: Record<string, unknown> = {}) => ({
  taxRate: 0,
  subtotal,
  systemKind: NSF_FEE_SYSTEM_KIND,
  description: `${NSF_FEE_DESCRIPTION_PREFIX} #1`,
  ...over,
});

describe("inferredGoodsFlatRate (#2656)", () => {
  it("excludes the NSF line and its money: $100 goods + $25 fee at $7.50 tax reads 0.075, not a diluted 0.06", () => {
    const r = inferredGoodsFlatRate({
      subtotal: 125,
      taxAmount: 7.5,
      lines: [goods({ subtotal: 100 }), fee(25)],
    });
    expect(r).toEqual({ rate: 0.075, regularTax: 7.5, verified: true });
  });

  it("ROUNDS subtotal − ΣNSF to cents: fees 25.1 + 0.2 (float 25.300000000000001) read 0.0888, never 0.0887", () => {
    const lines = [goods(), fee(25.1), fee(0.2)];
    const r = inferredGoodsFlatRate({ subtotal: 137.3, taxAmount: 9.94, lines });
    expect(r?.rate).toBe(0.0888);
    // The unrounded shape the mobile/b294 copies computed disagrees — the reason for ONE helper.
    const unrounded = inferredFlatRate({
      subtotal: 137.3 - (25.1 + 0.2),
      taxAmount: 9.94,
      lines: [goods()],
    });
    expect(unrounded?.rate).toBe(0.0887);
  });

  it("recognises a pre-backfill NSF line by its description prefix (the transition leg)", () => {
    const r = inferredGoodsFlatRate({
      subtotal: 125,
      taxAmount: 7.5,
      lines: [goods({ subtotal: 100 }), fee(25, { systemKind: null })],
    });
    expect(r?.rate).toBe(0.075);
  });

  it("with no NSF line it is exactly inferredFlatRate", () => {
    const inv = { subtotal: 200, taxAmount: 16.5, lines: [goods({ subtotal: 200 })] };
    expect(inferredGoodsFlatRate(inv)).toEqual(inferredFlatRate(inv));
  });

  it("an invoice of ONLY an NSF line has no goods to infer from: null", () => {
    expect(inferredGoodsFlatRate({ subtotal: 25, taxAmount: 0, lines: [fee(25)] })).toBeNull();
  });
});
