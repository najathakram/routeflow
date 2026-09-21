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
// A product re-packed to 24 since a quote was written with a 12-pack, regulated by a PER-UNIT
// (not percent-of-sale) levy — review finding 2's no-split repro.
productMap.set("repacked-pu", {
  id: "repacked-pu",
  unitsPerBox: 24,
  trackedCategoryId: "cat-pu",
  trackedSubcategoryId: "sub",
});
// unitsPerBox 1 is not a real box pack (review finding 7's repro).
productMap.set("upb1", {
  id: "upb1",
  unitsPerBox: 1,
  trackedCategoryId: null,
  trackedSubcategoryId: null,
});
const categoryMap = new Map([
  ["cat", { taxType: "PERCENT_OF_SALE", rate: 0.1, priceIncludesTax: false }],
  ["cat-pu", { taxType: "EXCISE_PER_UNIT", rate: 1, priceIncludesTax: false }],
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

  describe("upbForPieces (the per-piece levy basis) follows packSnapshot too, not only the boxed split (B659 review finding 2)", () => {
    it("a NO-SPLIT line (no boxes/pieces recorded): a converted 6-box line quoted at pack 12, live pack 24, bases the levy on 72 pieces, not 144", () => {
      const { itemsData } = build([
        {
          description: "PU no-split",
          productId: "repacked-pu",
          qty: 6, // 6 boxes, quoted at $10/box
          unitPrice: 10,
          packSnapshot: 12,
        },
      ]);
      expect(itemsData[0]).toMatchObject({
        boxes: null, // no split recorded — the live-pack read used to bite exactly this case
        qty: 6,
        subtotal: 60,
        categoryTaxAmount: 72, // 6 x 12 (quoted) = 72 pieces x $1 — never 6 x 24 (live) = 144
      });
    });

    it("without a packSnapshot a no-split line still falls back to the LIVE pack (a NEW line: unchanged behaviour)", () => {
      const { itemsData } = build([
        {
          description: "PU no-split, no snapshot",
          productId: "repacked-pu",
          qty: 6,
          unitPrice: 10,
        },
      ]);
      expect(itemsData[0]).toMatchObject({ categoryTaxAmount: 144 }); // 6 x 24 (live)
    });
  });

  describe("a pack of 1 is not a box split — the `if (pack)` guard must be `> 1` (B659 review finding 7)", () => {
    it("boxes 1, pieces 0 on a unitsPerBox-1 product keeps qty 1 and its full price, never collapses to qty 0", () => {
      const { itemsData } = build([
        { description: "Single", productId: "upb1", qty: 1, boxes: 1, pieces: 0, unitPrice: 25 },
      ]);
      // A truthy `if (pack)` let unitsPerBox 1 through into normalizeBoxesPieces, whose OWN gate
      // (hasBoxPackaging = upb > 1) then falls back to an `input.qty` this caller never passes —
      // silently zeroing the line to qty 0 / $0 for every caller (API, mobile).
      expect(itemsData[0]).toMatchObject({ qty: 1, boxes: null, pieces: null, subtotal: 25 });
    });
  });
});
