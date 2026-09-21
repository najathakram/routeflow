import { buildManualInvoiceLines } from "./manual-invoice-lines";

// The manual-invoice line builder, lifted verbatim out of InvoicesService.create() (4c-1 prefactor).
// InvoicesService.create's own specs pin it end to end; this pins the extracted contract.
const productMap = new Map([
  [
    "boxed",
    { id: "boxed", unitsPerBox: 12, trackedCategoryId: "cat", trackedSubcategoryId: "sub" },
  ],
  [
    "loose",
    { id: "loose", unitsPerBox: null, trackedCategoryId: null, trackedSubcategoryId: null },
  ],
]);
// A product re-packed to 6 since a quote was written with a 12-pack (B659).
productMap.set("repacked", {
  id: "repacked",
  unitsPerBox: 6,
  trackedCategoryId: "cat",
  trackedSubcategoryId: "sub",
});
const categoryMap = new Map([
  ["cat", { taxType: "PERCENT_OF_SALE", rate: 0.1, priceIncludesTax: false }],
]);
const clamp = (free: number | undefined, boxes: number | null, qty: number) =>
  Math.min(Math.max(0, free ?? 0), Math.max(0, (boxes ?? qty) - 1));
const build = (items: unknown[]) =>
  buildManualInvoiceLines(items as never, {
    productMap,
    categoryMap,
    tenantId: "t-1",
    clampFreeUnits: clamp,
  });

describe("buildManualInvoiceLines", () => {
  it("splits a boxed line into boxes/pieces, prices it per box, snapshots the pack and the tracked category", () => {
    const { itemsData, subtotal } = build([
      { description: "Boxed", productId: "boxed", qty: 1, boxes: 2, pieces: 6, unitPrice: 24 },
    ]);
    expect(itemsData[0]).toMatchObject({
      qty: 30,
      boxes: 2,
      pieces: 6,
      unitsPerBox: 12,
      subtotal: 60, // 2 boxes + 6/12 box at $24 = 2.5 x 24
      trackedCategoryId: "cat",
      trackedSubcategoryId: "sub",
      categoryTaxAmount: 6, // 10% of the 60 sale
      tenantId: "t-1", // a nested create bypasses forTenant()
    });
    expect(subtotal).toBe(60);
  });

  it("a non-product line is qty x price minus the line discount, untracked; the subtotal sums the lines", () => {
    const { itemsData, subtotal } = build([
      { description: "Fee", qty: 3, unitPrice: 10, discount: 5 },
      { description: "Loose", productId: "loose", qty: 2, unitPrice: 4.5 },
    ]);
    expect(itemsData.map((l) => l.subtotal)).toEqual([25, 9]);
    expect(itemsData[0]).toMatchObject({ boxes: null, unitsPerBox: null, categoryTaxAmount: 0 });
    expect(subtotal).toBe(34);
  });

  it("clamps BUY_N_GET_M free units through the injected clamp, and stores null when none", () => {
    const { itemsData } = build([
      { description: "Bogo", productId: "loose", qty: 5, unitPrice: 10, promoFreeUnits: 99 },
      { description: "Plain", productId: "loose", qty: 5, unitPrice: 10 },
    ]);
    expect(itemsData[0].promoFreeUnits).toBe(4); // capped at units - 1
    expect(itemsData[0].subtotal).toBe(10);
    expect(itemsData[1].promoFreeUnits).toBeNull();
  });

  describe("packSnapshot (an EXISTING line keeps the pack it was priced with, B659)", () => {
    const line = {
      description: "Repacked",
      productId: "repacked",
      boxes: 2,
      pieces: 6,
      unitPrice: 24,
    };

    it("without a snapshot the LIVE pack re-splits the line (a NEW line: unchanged behaviour)", () => {
      const { itemsData } = build([{ ...line, qty: 1 }]);
      expect(itemsData[0]).toMatchObject({ boxes: 3, pieces: 0, qty: 18, subtotal: 72 });
    });

    it("with the quote's pack a live pack change does NOT move the quoted subtotal, the split or the levy", () => {
      const { itemsData, subtotal } = build([{ ...line, qty: 1, packSnapshot: 12 }]);
      expect(itemsData[0]).toMatchObject({
        boxes: 2,
        pieces: 6,
        unitsPerBox: 12, // the snapshot, not the live 6
        qty: 30,
        subtotal: 60, // 2.5 boxes x $24, exactly what was quoted
        categoryTaxAmount: 6, // the levy is computed fresh, on the honoured price
      });
      expect(subtotal).toBe(60);
    });

    it("a null snapshot means no override (the live pack)", () => {
      const { itemsData } = build([{ ...line, qty: 1, packSnapshot: null }]);
      expect(itemsData[0]).toMatchObject({ boxes: 3, subtotal: 72 });
    });
  });
});

// ─── SA-077(2) ───────────────────────────────────────────────────────────────
describe("SA-077(2): a split no pack can price is refused, never silently dropped", () => {
  it("refuses a split on a product with no pack, naming the line", () => {
    expect(() =>
      build([
        {
          productId: "loose", // unitsPerBox: null
          description: "Flat widget",
          qty: 10,
          unitPrice: 11,
          boxes: 3,
          pieces: 2,
        },
      ]),
    ).toThrow(/Flat widget/);
  });

  it("leaves a boxed product's split alone — it has a pack, so it prices from the split", () => {
    const out = build([
      { productId: "boxed", description: "Boxed", qty: 24, unitPrice: 11, boxes: 2, pieces: 0 },
    ]);
    expect(out.itemsData[0].subtotal).toBeCloseTo(22, 2); // 11 * 2 boxes
  });

  it("leaves a plain unboxed line alone — no split, nothing to refuse", () => {
    const out = build([{ productId: "loose", description: "Flat", qty: 10, unitPrice: 11 }]);
    expect(out.itemsData[0].subtotal).toBeCloseTo(110, 2); // 11 per piece * 10
  });
});
