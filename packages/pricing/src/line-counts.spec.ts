import {
  formatInvoiceLineCounts,
  formatLineCounts,
  formatLineWord,
  formatUnitCounts,
  summarizeLineCounts,
  type CountableLine,
} from "./line-counts";

const text = (lines: CountableLine[]) => formatLineCounts(summarizeLineCounts(lines));

// W-1185: boxes and pieces are never added; a named unit counts in its own word.
describe("summarizeLineCounts / formatLineCounts", () => {
  it("boxed lines keep boxes and pieces apart, never 10 and never 54", () => {
    const lines: CountableLine[] = [
      { qty: 36, boxes: 3, pieces: 0, unitsPerBox: 12 },
      { qty: 16, boxes: 1, pieces: 4, unitsPerBox: 12 },
      { qty: 2, unit: "each" },
    ];
    const c = summarizeLineCounts(lines);
    expect(c.lines).toBe(3);
    expect(c.boxes).toBe(4);
    expect(c.pieces).toBe(6);
    expect(c.byUnit).toEqual([
      { word: "box", count: 4 },
      { word: "pc", count: 6 },
    ]);
    expect(formatLineCounts(c)).toBe("3 lines · 4 boxes · 6 pcs");
    expect(formatUnitCounts(c)).toBe("4 boxes · 6 pcs");
  });

  it("a named Case line counts cases, not 24 pcs and not 2 boxes", () => {
    const lines = [{ qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12, unitLabel: "Case" }];
    const c = summarizeLineCounts(lines);
    expect(c.boxes).toBe(0);
    expect(c.pieces).toBe(0);
    expect(c.byUnit).toEqual([{ word: "case", count: 2 }]);
    expect(text(lines)).toBe("1 line · 2 cases");
  });

  it("a named Pallet line counts pallets", () => {
    expect(text([{ qty: 96, boxes: 2, pieces: 0, unitsPerBox: 48, unitLabel: "Pallet" }])).toBe(
      "1 line · 2 pallets",
    );
  });

  it("a named line with no safe count falls back to qty", () => {
    expect(text([{ qty: 5, unitLabel: "Case" }])).toBe("1 line · 5 cases");
  });

  it("an unboxed bottle line counts bottles (qty is the bottle count)", () => {
    expect(text([{ qty: 6, product: { unit: "bottle" } }])).toBe("1 line · 6 bottles");
    expect(text([{ qty: 6, unit: "bottle" }])).toBe("1 line · 6 bottles");
  });

  it("a generic each line merges into pcs, a box-like unit into boxes", () => {
    expect(
      text([
        { qty: 2, unit: "each" },
        { qty: 1, boxes: null, pieces: 3 },
      ]),
    ).toBe("2 lines · 5 pcs");
    expect(text([{ qty: 3, unit: "Box" }])).toBe("1 line · 3 boxes");
    expect(text([{ qty: 3 }])).toBe("1 line · 3 pcs");
  });

  it("a till line uses the product's own pack and base words", () => {
    expect(
      text([
        { qty: 13, boxes: 1, pieces: 1, unitsPerBox: 12, packLabel: "Case", baseLabel: "Can" },
      ]),
    ).toBe("1 line · 1 can · 1 case");
    expect(
      text([
        { qty: 26, boxes: 2, pieces: 2, unitsPerBox: 12, packLabel: "Case", baseLabel: "Can" },
      ]),
    ).toBe("1 line · 2 cans · 2 cases");
  });

  it("generic pack and base labels fall back to the default words", () => {
    expect(text([{ qty: 13, boxes: 1, pieces: 1, packLabel: "Box", baseLabel: "Piece" }])).toBe(
      "1 line · 1 box · 1 pc",
    );
  });

  it("singulars: 1 box + 1 pc", () => {
    expect(text([{ qty: 13, boxes: 1, pieces: 1, unitsPerBox: 12 }])).toBe("1 line · 1 box · 1 pc");
  });

  it("empty list and a zero-qty line both read 0 lines", () => {
    expect(text([])).toBe("0 lines");
    expect(formatUnitCounts(summarizeLineCounts([]))).toBe("");
    expect(text([{ qty: 0, unit: "each" }])).toBe("0 lines");
    expect(text([{ qty: 0, boxes: 0, pieces: 0 }])).toBe("0 lines");
    expect(summarizeLineCounts([{ qty: 0 }])).toEqual({
      lines: 0,
      boxes: 0,
      pieces: 0,
      byUnit: [],
    });
  });

  it("a zero-qty line is not counted among lines", () => {
    expect(
      text([
        { qty: 0, unit: "each" },
        { qty: 2, unit: "each" },
      ]),
    ).toBe("1 line · 2 pcs");
  });

  it("a fraction shows at most 3 decimals, trailing zeros dropped", () => {
    expect(text([{ qty: 1.5, unit: "kg" }])).toBe("1 line · 1.5 kg");
    expect(text([{ qty: 0.3333, unit: "kg" }])).toBe("1 line · 0.333 kg");
    expect(
      text([
        { qty: 2.5, unit: "lb" },
        { qty: 0.5, unit: "lb" },
      ]),
    ).toBe("2 lines · 3 lb");
  });

  it("reads Decimal-as-string quantities", () => {
    expect(text([{ qty: "12.000", boxes: "2.000", pieces: "0.000" }])).toBe("1 line · 2 boxes");
  });

  it("orders boxes first, named units in first-seen order, pcs last", () => {
    const c = summarizeLineCounts([
      { qty: 6, unit: "each" },
      { qty: 2, unit: "bottle" },
      { qty: 24, boxes: 2, pieces: 0, unitsPerBox: 12, unitLabel: "Case" },
      { qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12 },
      { qty: 1, unit: "dozen" },
    ]);
    expect(c.byUnit.map((u) => u.word)).toEqual(["box", "bottle", "case", "dozen", "pc"]);
    expect(formatLineCounts(c)).toBe("5 lines · 1 box · 2 bottles · 2 cases · 1 dozen · 6 pcs");
  });

  it("keys are compared lower-case", () => {
    expect(
      text([
        { qty: 1, unit: "Bottle" },
        { qty: 2, unit: "bottle" },
      ]),
    ).toBe("2 lines · 3 bottles");
  });

  it("a box-labelled named line merges with boxed lines", () => {
    expect(
      text([
        { qty: 24, boxes: 2, unitsPerBox: 12, unitLabel: "Box" },
        { qty: 12, boxes: 1 },
      ]),
    ).toBe("2 lines · 3 boxes");
  });

  // Moved from apps/web/lib/order-qty-summary.test.ts (F03 / F19): "Total quantity 42" added 3
  // cases and 6 bottles into one unitless number.
  it("3 cases (36 pcs stored) + 6 bottles reads per unit, never 42", () => {
    expect(
      formatUnitCounts(
        summarizeLineCounts([
          { qty: 36, boxes: 3, pieces: 0 },
          { qty: 6, product: { unit: "bottle" } },
        ]),
      ),
    ).toBe("3 boxes · 6 bottles");
  });

  it("loose pieces merge with plain each-lines under the piece word", () => {
    expect(
      formatUnitCounts(
        summarizeLineCounts([
          { qty: 16, boxes: 1, pieces: 4 },
          { qty: 2, product: { unit: "each" } },
        ]),
      ),
    ).toBe("1 box · 6 pcs");
  });

  it("one unit alone, and the empty order", () => {
    expect(formatUnitCounts(summarizeLineCounts([{ qty: 1, product: { unit: "case" } }]))).toBe(
      "1 case",
    );
    expect(formatUnitCounts(summarizeLineCounts([]))).toBe("");
  });

  it("a named unit line (Pallet) keeps its own label, lower-case", () => {
    expect(
      formatUnitCounts(
        summarizeLineCounts([
          // Real stored shape (unit-line-build.ts): boxes = count, pieces = 0, qty = count x factor.
          { qty: 96, boxes: 2, pieces: 0, unitsPerBox: 48, unitLabel: "Pallet" },
        ]),
      ),
    ).toBe("2 pallets");
  });
});

describe("formatLineWord", () => {
  it("agrees with the number", () => {
    expect(formatLineWord(0)).toBe("0 lines");
    expect(formatLineWord(1)).toBe("1 line");
    expect(formatLineWord(12)).toBe("12 lines");
  });
});

describe("formatInvoiceLineCounts", () => {
  it("counts a plain line in its own selling unit, a named line in its own word", () => {
    const items = [
      { qty: 6, boxes: null, pieces: null, unitLabel: null, product: { unit: "bottle" } },
      {
        qty: 24,
        boxes: 2,
        pieces: 0,
        unitsPerBox: 12,
        unitLabel: "Case",
        product: { unit: "can" },
      },
    ];
    expect(formatInvoiceLineCounts(items)).toBe("2 lines · 6 bottles · 2 cases");
    expect(formatInvoiceLineCounts(items)).toBe(text(items));
  });

  // W-1185 fix 3 (selling unit): the live product.unit names a plain line; baseLabel is not read.
  it("a plain line counts in product.unit: box, bag, kg", () => {
    expect(formatInvoiceLineCounts([{ qty: 1, product: { unit: "box" } }])).toBe("1 line · 1 box");
    expect(formatInvoiceLineCounts([{ qty: 1, product: { unit: "bag" } }])).toBe("1 line · 1 bag");
    expect(formatInvoiceLineCounts([{ qty: 1.5, product: { unit: "kg" } }])).toBe(
      "1 line · 1.5 kg",
    );
    expect(formatInvoiceLineCounts([{ qty: 2, unit: "bottle" }])).toBe("1 line · 2 bottles");
  });

  it("a manual line (no product) or a generic unit word counts as pieces", () => {
    expect(formatInvoiceLineCounts([{ qty: 4 }])).toBe("1 line · 4 pcs");
    expect(formatInvoiceLineCounts([{ qty: 4, product: { unit: "each" } }])).toBe("1 line · 4 pcs");
    expect(formatInvoiceLineCounts([{ qty: 4, product: null, baseLabel: "Piece" }])).toBe(
      "1 line · 4 pcs",
    );
  });

  it("an issued plain line's baseLabel is not read: product.unit wins", () => {
    expect(formatInvoiceLineCounts([{ qty: 1, baseLabel: "bar", product: { unit: "box" } }])).toBe(
      "1 line · 1 box",
    );
    // No unit to read: baseLabel is still not the word, so the generic piece word.
    expect(formatInvoiceLineCounts([{ qty: 6, baseLabel: "Bottle" }])).toBe("1 line · 6 pcs");
  });

  it("orders the named words alphabetically, whatever the line order", () => {
    const box = { qty: 1, product: { unit: "box" } };
    const named = { qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12, unitLabel: "Case" };
    const bag = { qty: 1, product: { unit: "bag" } };
    const piece = { qty: 2 };
    const want = "4 lines · 1 box · 1 bag · 1 case · 2 pcs";
    for (const lines of [
      [box, named, bag, piece],
      [piece, bag, named, box],
      [named, piece, box, bag],
    ]) {
      expect(text(lines)).toBe(want);
      expect(formatInvoiceLineCounts(lines)).toBe(want);
    }
  });

  it("matches the builder's own count for the same lines (parity)", () => {
    const lines = [
      { qty: 1, product: { unit: "box" } },
      { qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12, unitLabel: "Case" },
      { qty: 1, product: { unit: "bag" } },
    ];
    expect(formatInvoiceLineCounts(lines)).toBe("3 lines · 1 box · 1 bag · 1 case");
    expect(formatInvoiceLineCounts(lines)).toBe(text(lines));
  });

  // W-1185 fix round 2 (MUST): the bare number in the qty column is pieces by default.
  it("three plain lines with no unit keep their quantity", () => {
    expect(formatInvoiceLineCounts([{ qty: 10 }, { qty: 5 }, { qty: 3 }])).toBe("3 lines · 18 pcs");
  });

  it("two boxed lines plus one plain line read boxes then pieces", () => {
    expect(
      formatInvoiceLineCounts([
        { qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12 },
        { qty: 12, boxes: 1, pieces: 0, unitsPerBox: 12 },
        { qty: 1 },
      ]),
    ).toBe("3 lines · 2 boxes · 1 pc");
  });

  // W-1185 fix round 2 (SHOULD 2): a named unit with no safe count never reads qty as the count.
  it("a named unit with no safe count and a real factor counts the line only", () => {
    expect(
      formatInvoiceLineCounts([{ qty: 30, boxes: null, unitsPerBox: 12, unitLabel: "Case" }]),
    ).toBe("1 line");
  });

  it("a named unit with no safe count and factor 1 or none reads qty", () => {
    expect(formatInvoiceLineCounts([{ qty: 4, unitsPerBox: 1, unitLabel: "Each" }])).toBe(
      "1 line · 4 pcs",
    );
    expect(formatInvoiceLineCounts([{ qty: 4, unitsPerBox: null, unitLabel: "Case" }])).toBe(
      "1 line · 4 cases",
    );
  });

  it("a boxed line reads the frozen pack and base words, as the till does", () => {
    expect(
      formatInvoiceLineCounts([
        {
          qty: 13,
          boxes: 1,
          pieces: 1,
          packLabel: "Case",
          baseLabel: "Can",
          product: { unit: "x" },
        },
      ]),
    ).toBe("1 line · 1 can · 1 case");
  });

  // W-1185 fix 1 (F2): the NSF bounce fee is a system line, not goods.
  it("a system line (the NSF bounce fee) is not counted", () => {
    expect(
      formatInvoiceLineCounts([
        { qty: 3, boxes: 3, pieces: 0 },
        { qty: 1, boxes: null, pieces: null, systemKind: "NSF_FEE" },
      ]),
    ).toBe("1 line · 3 boxes");
    expect(formatInvoiceLineCounts([{ qty: 1, systemKind: "NSF_FEE" }])).toBe("0 lines");
  });
});

// W-1185 fix 1 (F1): every bucket key is singular, so a tenant's plural spelling folds in.
describe("singular bucket keys", () => {
  it("an already-plural named label reads as its singular for one", () => {
    expect(text([{ qty: 1, unitLabel: "Cases" }])).toBe("1 line · 1 case");
    expect(text([{ qty: 1, unitLabel: "Pallets" }])).toBe("1 line · 1 pallet");
  });

  it("Case and Cases share one bucket", () => {
    expect(
      text([
        { qty: 24, boxes: 2, unitsPerBox: 12, unitLabel: "Case" },
        { qty: 12, boxes: 1, unitsPerBox: 12, unitLabel: "Cases" },
      ]),
    ).toBe("2 lines · 3 cases");
  });

  it("plural pack, base and unit words fold into the same words", () => {
    expect(text([{ qty: 1, boxes: 0, pieces: 1, baseLabel: "Cans" }])).toBe("1 line · 1 can");
    expect(text([{ qty: 1, unit: "Bottles" }])).toBe("1 line · 1 bottle");
    expect(text([{ qty: 3, unit: "pc." }])).toBe("1 line · 3 pcs");
    expect(text([{ qty: 2, unit: "Pieces" }])).toBe("1 line · 2 pcs");
    expect(text([{ qty: 2, unit: "Units" }])).toBe("1 line · 2 pcs");
    expect(text([{ qty: 2, boxes: 2, packLabel: "Boxes" }])).toBe("1 line · 2 boxes");
    expect(text([{ qty: 2, unit: "Boxes" }])).toBe("1 line · 2 boxes");
  });

  it("singularises ies, ch/sh/x/z + es and leaves ss and invariant words alone", () => {
    expect(text([{ qty: 2, unit: "Candies" }])).toBe("1 line · 2 candies");
    expect(text([{ qty: 1, unit: "Candies" }])).toBe("1 line · 1 candy");
    expect(text([{ qty: 1, unit: "Batches" }])).toBe("1 line · 1 batch");
    expect(text([{ qty: 1, unit: "Glass" }])).toBe("1 line · 1 glass");
    expect(text([{ qty: 2, unit: "Dozen" }])).toBe("1 line · 2 dozen");
    expect(text([{ qty: 2, unit: "Gross" }])).toBe("1 line · 2 gross");
    expect(text([{ qty: 2, unit: "kg" }])).toBe("1 line · 2 kg");
  });

  it("keeps a two-letter abbreviation whole", () => {
    expect(text([{ qty: 1, unit: "CS" }])).toBe("1 line · 1 cs");
    expect(text([{ qty: 3, unit: "CS" }])).toBe("1 line · 3 cs");
  });
});

// W-1185 fix 1 (F8): a quantity shows up to 3 decimals, like the qty column.
describe("fraction precision", () => {
  it("a small fraction is not rounded to 0, a 3-dp one is kept", () => {
    expect(text([{ qty: 0.004, unit: "kg" }])).toBe("1 line · 0.004 kg");
    expect(text([{ qty: 0.333, unit: "kg" }])).toBe("1 line · 0.333 kg");
    expect(text([{ qty: 1.25, unit: "kg" }])).toBe("1 line · 1.25 kg");
  });
});
