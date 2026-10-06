import {
  previewSplitLineTotal,
  toSplitInvoiceLine,
  type SplitInvoiceLine,
} from "./split-invoice-line";

const line = (over: Partial<SplitInvoiceLine>): SplitInvoiceLine => ({
  id: "li-1",
  productName: "Widget",
  qty: 1,
  invoicedQty: 0,
  unitPrice: 1,
  subtotal: null,
  boxes: null,
  pieces: null,
  unitsPerBox: null,
  promoFreeUnits: null,
  ...over,
});

describe("toSplitInvoiceLine — the one order line -> modal line mapper", () => {
  it("carries the stored money, split, pack snapshot and free units (Decimal strings coerced)", () => {
    expect(
      toSplitInvoiceLine(
        {
          id: "li-9",
          qty: "24",
          invoicedQty: "0",
          unitPrice: "12.90",
          subtotal: "12.90",
          boxes: 1,
          pieces: 0,
          unitsPerBox: 24,
          promoFreeUnits: 2,
          product: { unit: "pc" },
        },
        "Case of widgets",
      ),
    ).toEqual({
      id: "li-9",
      productName: "Case of widgets",
      qty: 24,
      invoicedQty: 0,
      unitPrice: 12.9,
      subtotal: 12.9,
      boxes: 1,
      pieces: 0,
      unitsPerBox: 24,
      promoFreeUnits: 2,
      unit: "pc",
    });
  });

  it("a missing subtotal is null (never undefined/0) and the box size falls back to the product", () => {
    const m = toSplitInvoiceLine(
      { id: "x", qty: 5, unitPrice: 2, product: { unitsPerBox: 12 } },
      "Gum",
    );
    expect(m.subtotal).toBeNull();
    expect(m.boxes).toBeNull();
    expect(m.promoFreeUnits).toBeNull();
    expect(m.unitsPerBox).toBe(12);
    expect(m.invoicedQty).toBe(0);
  });
});

describe("previewSplitLineTotal — the server's partial-bill formula", () => {
  it("boxed: bills 24 of a 24-pack line stored at $12.90 as $12.90, never $309.60", () => {
    const l = line({
      qty: 24,
      unitPrice: 12.9,
      subtotal: 12.9,
      boxes: 1,
      pieces: 0,
      unitsPerBox: 24,
    });
    expect(previewSplitLineTotal(l, 24)).toBe(12.9);
  });

  it("boxed, no stored subtotal: re-priced boxed-aware, not qty x unitPrice", () => {
    const l = line({ qty: 24, unitPrice: 12.9, boxes: 1, pieces: 0, unitsPerBox: 24 });
    expect(previewSplitLineTotal(l, 24)).toBe(12.9);
    expect(previewSplitLineTotal(l, 12)).toBe(6.45);
  });

  it("free units: 12 pcs @ $35 with 2 free (stored $350), billing 5 previews $175.00 not $145.83", () => {
    const l = line({ qty: 12, unitPrice: 35, subtotal: 350, promoFreeUnits: 2 });
    expect(previewSplitLineTotal(l, 5)).toBe(175);
  });

  it("a later partial telescopes on invoicedQty: $10.00 over 3 pcs bills 3.33 / 3.34 / 3.33", () => {
    const base = { qty: 3, unitPrice: 3.33, subtotal: 10 };
    expect(previewSplitLineTotal(line({ ...base, invoicedQty: 0 }), 1)).toBe(3.33);
    expect(previewSplitLineTotal(line({ ...base, invoicedQty: 1 }), 1)).toBe(3.34);
    expect(previewSplitLineTotal(line({ ...base, invoicedQty: 2 }), 1)).toBe(3.33);
    expect(previewSplitLineTotal(line({ ...base, invoicedQty: 1 }), 2)).toBe(6.67);
  });

  it("a boxed free-unit line uses the box as the free unit (4/box, 1 free box, stored $30)", () => {
    const l = line({
      qty: 10,
      unitPrice: 10,
      subtotal: 30,
      boxes: 2,
      pieces: 2,
      unitsPerBox: 4,
      promoFreeUnits: 1,
    });
    // paid basis 6; billing 6 of 10 pcs from scratch: freeUnitsThrough(6) = floor(6/10) = 0 -> 30 * 6/6
    expect(previewSplitLineTotal(l, 6)).toBe(30);
    // billing all 10: freeUnitsThrough(10) = 1 -> paid 6 -> 30
    expect(previewSplitLineTotal(l, 10)).toBe(30);
  });

  it("a degenerate line (qty 0) previews 0", () => {
    expect(previewSplitLineTotal(line({ qty: 0, subtotal: 5 }), 3)).toBe(0);
  });
});
