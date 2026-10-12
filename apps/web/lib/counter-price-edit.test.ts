import { computeLineSubtotal } from "@routeflow/pricing";
import {
  isBoxedLine,
  lineDiscount,
  lineTotalAt,
  priceEditChip,
  resolveCounterPriceEdit,
  type PriceEditLine,
} from "./counter-price-edit";

const plain = (tierPrice: number, over: Partial<PriceEditLine> = {}): PriceEditLine => ({
  tierPrice,
  listPrice: tierPrice,
  tier: 1,
  qty: 1,
  ...over,
});
/** a 12-pack, box price 24.00, 2 boxes + 3 pieces (qty 27 pieces) */
const boxed: PriceEditLine = {
  tierPrice: 24,
  listPrice: 24,
  tier: 1,
  qty: 27,
  boxes: 2,
  pieces: 3,
  unitsPerBox: 12,
};

describe("resolveCounterPriceEdit (POS-5 money, golden)", () => {
  it.each([
    ["percent", 10, 10, 9],
    ["amount", 2.5, 10, 7.5],
    ["set", 0, 10, 0],
    ["percent", 100, 10, 0],
    ["set", "7.25", 10, 7.25],
    ["percent", 33.33, 19.99, 13.33],
  ] as const)("%s %s on %s -> %s", (mode, value, tier, expected) => {
    const r = resolveCounterPriceEdit(mode, value, plain(tier));
    expect(r).toMatchObject({ ok: true, unitPrice: expected, override: true });
  });

  it("a typed set price is rounded to cents (3.335 -> 3.34) and a 3-unit line totals 10.02", () => {
    const r = resolveCounterPriceEdit("set", 3.335, plain(5, { qty: 3 }));
    expect(r).toMatchObject({ ok: true, unitPrice: 3.34, lineTotal: 10.02 });
  });

  it.each([
    ["percent", 100.01, "PERCENT_RANGE"],
    ["percent", -1, "PERCENT_RANGE"],
    ["percent", 10.123, "PERCENT_PRECISION"],
    ["percent", 10.555, "PERCENT_PRECISION"],
    ["amount", 10.01, "AMOUNT_OVER_PRICE"],
    ["amount", -1, "NEGATIVE"],
    ["set", -0.01, "NEGATIVE"],
    ["set", "abc", "NOT_A_NUMBER"],
    ["set", "", "NOT_A_NUMBER"],
    ["set", "   ", "NOT_A_NUMBER"],
    ["percent", Number.NaN, "NOT_A_NUMBER"],
  ] as const)("%s %s is refused %s", (mode, value, refused) => {
    expect(resolveCounterPriceEdit(mode, value, plain(10))).toMatchObject({ ok: false, refused });
  });

  it("an amount over the price names the most that can be taken off (never clamps)", () => {
    expect(resolveCounterPriceEdit("amount", 11, plain(10))).toEqual({
      ok: false,
      refused: "AMOUNT_OVER_PRICE",
      max: 10,
    });
  });

  it("a result within 1/2 cent of the tier price is NOT an override (a plain line)", () => {
    expect(resolveCounterPriceEdit("set", 10.004, plain(10))).toMatchObject({
      ok: true,
      override: false,
      unitPrice: 10,
      discount: 0,
    });
    expect(resolveCounterPriceEdit("percent", 0, plain(10))).toMatchObject({ override: false });
    expect(resolveCounterPriceEdit("amount", 0, plain(10))).toMatchObject({ override: false });
  });

  it("a raised price is an override that contributes no discount", () => {
    expect(resolveCounterPriceEdit("set", 12, plain(10, { qty: 2 }))).toMatchObject({
      ok: true,
      override: true,
      unitPrice: 12,
      discount: 0,
    });
  });

  it("a special-tier customer's real change needs a reason; a trimmed reason clears it; the tier price needs none", () => {
    const special = plain(8, { tier: 3, listPrice: 10 });
    expect(resolveCounterPriceEdit("set", 6, special)).toEqual({
      ok: false,
      refused: "REASON_REQUIRED",
    });
    expect(resolveCounterPriceEdit("set", 6, special, "   ")).toMatchObject({
      refused: "REASON_REQUIRED",
    });
    expect(resolveCounterPriceEdit("set", 6, special, "damaged")).toMatchObject({
      ok: true,
      unitPrice: 6,
    });
    expect(resolveCounterPriceEdit("set", 8, special)).toMatchObject({ ok: true, override: false });
    // a standard-tier customer needs no reason
    expect(resolveCounterPriceEdit("set", 6, plain(8))).toMatchObject({ ok: true });
  });

  describe("a boxed line (12 per box, box price 24.00, 2 boxes + 3 pieces)", () => {
    it("10% off the BOX price is 21.60 and the line is prorated by computeLineSubtotal, never qty x price", () => {
      const r = resolveCounterPriceEdit("percent", 10, boxed);
      const expected = computeLineSubtotal({
        unitPrice: 21.6,
        qty: 27,
        boxes: 2,
        pieces: 3,
        unitsPerBox: 12,
      });
      expect(r).toMatchObject({ ok: true, unitPrice: 21.6, lineTotal: expected });
      expect(expected).toBe(48.6);
      expect(27 * 21.6).not.toBe(expected);
    });

    it("the discount is the difference of the two computeLineSubtotal totals", () => {
      const r = resolveCounterPriceEdit("percent", 10, boxed);
      expect(r).toMatchObject({ originalTotal: 54, discount: 5.4 });
      expect(lineDiscount(boxed, 21.6)).toBe(5.4);
      expect(lineTotalAt(boxed, 24)).toBe(54);
    });

    it("amount off is per BOX: $2 off a $24 box is 22.00", () => {
      expect(resolveCounterPriceEdit("amount", 2, boxed)).toMatchObject({ unitPrice: 22 });
    });

    it("isBoxedLine is true only for a pack above 1", () => {
      expect(isBoxedLine(boxed)).toBe(true);
      expect(isBoxedLine(plain(1))).toBe(false);
      expect(isBoxedLine({ unitsPerBox: 1 })).toBe(false);
      expect(isBoxedLine({ unitsPerBox: null })).toBe(false);
    });
  });
});

describe("priceEditChip (the neutral chip on an edited line)", () => {
  it.each([
    ["percent", 10, 10, 9, "10% off"],
    ["percent", 33.33, 19.99, 13.33, "33.33% off"],
    ["amount", 2, 10, 8, "$2.00 off each"],
    ["amount", 2.5, 24, 21.5, "$2.50 off each"],
    ["set", 7, 10, 7, "Price changed"],
    ["set", 0, 10, 0, "Price changed"],
  ] as const)("%s %s on %s -> net %s reads %j", (mode, value, tier, net, chip) => {
    expect(priceEditChip({ mode, value }, tier, net)).toBe(chip);
  });

  it("a net at or above the tier price always reads Price changed, whatever mode set it", () => {
    expect(priceEditChip({ mode: "percent", value: 10 }, 8, 9)).toBe("Price changed");
    expect(priceEditChip({ mode: "amount", value: 2 }, 8, 8)).toBe("Price changed");
    expect(priceEditChip({ mode: "set", value: 12 }, 10, 12)).toBe("Price changed");
  });

  it("a kept percent whose tier price moved is re-derived from the real figures, not the typed one", () => {
    // typed 10% off a 10.00 tier price (net 9.00); the customer's tier price is now 12.00
    expect(priceEditChip({ mode: "percent", value: 10 }, 12, 9)).toBe("25% off");
    // and the amount follows the real gap
    expect(priceEditChip({ mode: "amount", value: 1 }, 12, 9)).toBe("$3.00 off each");
  });
});
