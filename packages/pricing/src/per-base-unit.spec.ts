/**
 * SA-1029 (RED first): the per-piece price printed beside a pack line. Display only; never summed.
 * Expected values are hand-worked (round4 of unitPrice / the line's own pack), not read from the helper.
 */
import { computeLineSubtotal } from "./index";
import {
  DEFAULT_BASE_UNIT_WORD,
  baseUnitSuffix,
  formatPerBaseUnitPrice,
  perBaseUnitPrice,
} from "./per-base-unit";

const line = (over: Record<string, unknown> = {}) => ({
  unitPrice: 48,
  unitsPerBox: 24,
  productId: "p1",
  compositionMode: null,
  systemKind: null,
  ...over,
});

describe("perBaseUnitPrice (PB-1)", () => {
  it.each([
    ["2 boxes of 24 @ 48.00", line(), 2],
    ["1 case of 60 @ 30.00", line({ unitPrice: 30, unitsPerBox: 60 }), 0.5],
    ["1 box of 24 @ 30.01", line({ unitPrice: 30.01 }), 1.2504],
    ["box of 6 @ 10.00", line({ unitPrice: 10, unitsPerBox: 6 }), 1.6667],
    ["200-count @ 24.99", line({ unitPrice: 24.99, unitsPerBox: 200 }), 0.125],
    ["Case (24) @ 40.00", line({ unitPrice: 40 }), 1.6667],
    ["pallet (1440) @ 1999.00", line({ unitPrice: 1999, unitsPerBox: 1440 }), 1.3882],
  ])("%s", (_n, l, price) => {
    expect(perBaseUnitPrice(l as never, null)).toEqual({ price, unit: "pc" });
  });

  it("uses the base word: 1 case of 60 @ 30.00, Bag -> $0.50/bag", () => {
    const r = perBaseUnitPrice(line({ unitPrice: 30, unitsPerBox: 60 }) as never, "Bag");
    expect(r).toEqual({ price: 0.5, unit: "bag" });
    expect(formatPerBaseUnitPrice(r!)).toBe("$0.50/bag");
  });
});

describe("perBaseUnitPrice unit word (PB-4: unitWords, one source for the word)", () => {
  it('an explicit "Piece" label prints the default word, as every other screen does', () => {
    expect(perBaseUnitPrice(line() as never, "Piece")).toEqual({ price: 2, unit: "pc" });
  });
  it("a padded label is trimmed and lowercased", () => {
    expect(perBaseUnitPrice(line() as never, "  Bag ")).toEqual({ price: 2, unit: "bag" });
  });
});

describe("perBaseUnitPrice null cases (PB-2)", () => {
  it.each([
    ["pack 1", { unitsPerBox: 1 }],
    ["pack null", { unitsPerBox: null }],
    ["no product", { productId: null }],
    ["system line", { systemKind: "NSF_FEE" }],
    ["composed line", { compositionMode: "FIXED" }],
    ["NaN price", { unitPrice: NaN }],
    ["negative price", { unitPrice: -1 }],
  ])("%s -> null", (_n, over) => {
    expect(perBaseUnitPrice(line(over) as never, null)).toBeNull();
  });
});

describe("formatPerBaseUnitPrice (rule 2: min 2 / max 4 decimals)", () => {
  it.each([
    [2, "$2.00/pc"],
    [0.125, "$0.125/pc"],
    [1.2504, "$1.2504/pc"],
    [0.5, "$0.50/pc"],
    [1.6667, "$1.6667/pc"],
  ])("%s -> %s", (price, text) => {
    expect(formatPerBaseUnitPrice({ price, unit: "pc" })).toBe(text);
  });
});

describe("display only (PB-3)", () => {
  it("never multiplied back: 1 box + 2 pcs @ 10.00/6 stays 13.33", () => {
    expect(
      computeLineSubtotal({ unitPrice: 10, qty: 8, boxes: 1, pieces: 2, unitsPerBox: 6 } as never),
    ).toBe(13.33);
  });
});

describe("baseUnitSuffix (G-6: one word)", () => {
  it("the default word is pc and a loose line (no perBaseUnit) falls back to it", () => {
    expect(DEFAULT_BASE_UNIT_WORD).toBe("pc");
    expect(baseUnitSuffix(null)).toBe("pc");
    expect(baseUnitSuffix(undefined)).toBe("pc");
  });
  it("a pack line of a Bag product prints its own frozen word", () => {
    expect(baseUnitSuffix(perBaseUnitPrice(line(), "Bag"))).toBe("bag");
  });
  it("a pack line with no label prints the default, from the same constant", () => {
    expect(baseUnitSuffix(perBaseUnitPrice(line(), null))).toBe(DEFAULT_BASE_UNIT_WORD);
  });
});
