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
      // B297 (SA-088): the rate trio categoryTaxAmount was computed from.
      categoryTaxType: "PERCENT_OF_SALE",
      categoryTaxRate: 0.1,
      categoryPriceIncludesTax: false,
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
    expect(itemsData[0]).toMatchObject({
      boxes: null,
      unitsPerBox: null,
      categoryTaxAmount: 0,
      // B297: no category (untracked line) → an all-null snapshot.
      categoryTaxType: null,
      categoryTaxRate: null,
      categoryPriceIncludesTax: null,
    });
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
    // SA-095a: restored to an unconditional refusal (no packRecorded bypass). A split with a
    // pack of 1 was already refused here before B659 touched this file — the "silently zeroed
    // to qty 0" state finding 7 describes predates SA-077(2) (#1256) and can't be reached on
    // master today. The HIGH gap (a pack-of-1 product can never convert) is still fixed, at the
    // estimate-conversion CALLER: case 1 in estimate-convert-lines.ts forwards packSnapshot
    // without boxes/pieces for a recorded-but-degenerate pack, so this refusal never fires for
    // that path — see estimates.convert-levy.spec.ts's own pack-of-1 coverage.
    it("boxes 1, pieces 0 on a unitsPerBox-1 product refuses, naming the line — SA-077(2) applies here too", () => {
      expect(() =>
        build([
          { description: "Single", productId: "upb1", qty: 1, boxes: 1, pieces: 0, unitPrice: 25 },
        ]),
      ).toThrow(/Single/);
    });
  });

  describe("subtotalSnapshot: a legacy split with no pack copies its money verbatim, never recomputed (B659 review round 2, Senior Architect ruling)", () => {
    it("boxes/pieces snapshot LITERALLY (never normalizeBoxesPieces), unitsPerBox stays null, and the subtotal is the snapshot, not qty x unitPrice", () => {
      const { itemsData, subtotal } = build([
        {
          description: "Legacy no-pack",
          productId: "boxed", // a live pack of 12 exists — must never be consulted
          qty: 6,
          unitPrice: 10, // 6 x 10 = 60, but the snapshot below is 45 (a folded-in discount)
          boxes: 0,
          pieces: 6,
          subtotalSnapshot: 45,
        },
      ]);
      expect(itemsData[0]).toMatchObject({
        qty: 6,
        boxes: 0,
        pieces: 6,
        unitsPerBox: null,
        subtotal: 45, // copied verbatim, never recomputed to 60
        categoryTaxAmount: 4.5, // PERCENT_OF_SALE 10% of the copied 45, never of a recomputed 60
      });
      expect(subtotal).toBe(45);
    });

    it("a non-boxed product (no category, no pack at all) still copies the subtotal and reports unitBasisQty as qty for the levy basis", () => {
      const { itemsData } = build([
        {
          description: "Legacy no-pack, untracked",
          productId: "loose",
          qty: 6,
          unitPrice: 10,
          boxes: 0,
          pieces: 6,
          subtotalSnapshot: 45,
        },
      ]);
      expect(itemsData[0]).toMatchObject({
        subtotal: 45,
        boxes: 0,
        pieces: 6,
        categoryTaxAmount: 0,
      });
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
