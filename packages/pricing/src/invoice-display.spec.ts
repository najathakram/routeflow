import { creditedThrough } from "./pricing";
import { buildLadderView, type LadderViewUnit } from "./price-ladder";
import {
  invoiceLineDisplay,
  printedInvoiceCode,
  unitCodeOf,
  type ProductCodes,
} from "./invoice-display";
import type { LadderProduct } from "./unit-levels";

describe("T17: invoice unit Piece, 3 Boxes of 24 at $18.90", () => {
  const line = {
    pieces: 72,
    amount: 56.7,
    sold: { label: "Box", qty: 3, unitPrice: 18.9 },
  };

  it("shows 72 Pieces at $0.7875 for $56.70; the amount is the stored amount", () => {
    expect(invoiceLineDisplay({ ...line, invoiceUnit: { label: "Piece", factor: 1 } })).toEqual({
      mode: "invoice-unit",
      qty: 72,
      unitLabel: "Piece",
      unitPrice: 0.7875,
      amount: 56.7,
    });
  });

  it("T18: 30 pieces with the invoice unit Box of 24 is not a whole number of boxes, so it stays in the unit sold", () => {
    const r = invoiceLineDisplay({
      pieces: 30,
      amount: 22.5,
      sold: { label: "Piece", qty: 30, unitPrice: 0.75 },
      invoiceUnit: { label: "Box", factor: 24 },
    });
    expect(r).toEqual({
      mode: "unit-sold",
      qty: 30,
      unitLabel: "Piece",
      unitPrice: 0.75,
      amount: 22.5,
    });
  });

  it("a whole number of the invoice unit converts upward too (72 pieces as 3 Boxes)", () => {
    const r = invoiceLineDisplay({
      pieces: 72,
      amount: 56.7,
      sold: { label: "Piece", qty: 72, unitPrice: 0.7875 },
      invoiceUnit: { label: "Box", factor: 24 },
    });
    expect(r).toMatchObject({ mode: "invoice-unit", qty: 3, unitPrice: 18.9, amount: 56.7 });
  });

  it("legacy and ordered (no invoice unit) show the unit sold; junk input never throws", () => {
    expect(invoiceLineDisplay({ ...line, invoiceUnit: null })).toMatchObject({
      mode: "unit-sold",
      qty: 3,
      unitLabel: "Box",
      unitPrice: 18.9,
    });
    expect(
      invoiceLineDisplay({ ...line, pieces: NaN, invoiceUnit: { label: "Piece", factor: 1 } }).mode,
    ).toBe("unit-sold");
    expect(invoiceLineDisplay({ ...line, invoiceUnit: { label: "X", factor: 0 } }).mode).toBe(
      "unit-sold",
    );
  });
});

// T17b is a GUARD, not a red: it pins the arithmetic (`creditedThrough` from the line amount, not from the rounded display
// price) and passes today. The credit-note path that must use it is not built yet; its real red row moves to S23.
describe("G1 / T17b (guard): credits compute in the unit sold, never from the display price", () => {
  it("credit 10 of 72 invoiced Pieces (3 Boxes of 24 at $18.90) is computed once from the line amount", () => {
    const fromLine = creditedThrough(56.7, 10, 72);
    expect(fromLine).toBe(7.88); // roundMoney(56.70 x 10 / 72), through @routeflow/pricing
    const display = invoiceLineDisplay({
      pieces: 72,
      amount: 56.7,
      sold: { label: "Box", qty: 3, unitPrice: 18.9 },
      invoiceUnit: { label: "Piece", factor: 1 },
    });
    // The wrong way: round the 4-decimal display price to cents, then multiply.
    const perPiece = Math.round(display.unitPrice * 100) / 100;
    expect(Math.round(perPiece * 10 * 100) / 100).toBe(7.9);
    expect(fromLine).not.toBe(7.9);
  });
});

describe("unit codes (one code per unit) and the printed code", () => {
  const product: LadderProduct = { unit: "Box", unitsPerBox: 24, pricePerUnit: "18.90" };
  const rows: LadderViewUnit[] = [
    {
      label: "Case",
      factorToBase: 144,
      price: null,
      priceTier2: null,
      priceTier3: null,
      priceTier4: null,
      priceTier5: null,
      id: "u-case",
    },
  ];
  const view = buildLadderView(product, rows);
  const codes: ProductCodes = {
    sku: "SKU-1",
    barcode: "BAR-1",
    unitSku: "PC-1",
    unitCodes: { "u-case": "CASE-1" },
  };

  it("pack = barcode else sku; base = unit code, else the shared barcode counts as the base's; other units = their own code", () => {
    expect(unitCodeOf(codes, "pack")).toBe("BAR-1");
    expect(unitCodeOf({ ...codes, barcode: null }, "pack")).toBe("SKU-1");
    expect(unitCodeOf(codes, "base")).toBe("PC-1");
    expect(unitCodeOf({ ...codes, unitSku: null }, "base")).toBe("BAR-1");
    expect(unitCodeOf({ sku: "S" }, "base")).toBe("S");
    expect(unitCodeOf(codes, "u-case")).toBe("CASE-1");
    expect(unitCodeOf(codes, "u-none")).toBeNull();
  });

  it("T16: legacy choice routes to legacyInvoiceCode", () => {
    for (let mask = 0; mask < 8; mask++) {
      const p = {
        unitSku: mask & 1 ? "U" : null,
        barcode: mask & 2 ? "B" : null,
        sku: mask & 4 ? "S" : null,
      };
      const want = p.unitSku ?? p.barcode ?? p.sku ?? null;
      expect(
        printedInvoiceCode({ mode: "legacy" }, codes, view, p, undefined, "invoice-unit"),
      ).toBe(want);
    }
  });

  it("PF-8 / T18: 30 pieces with the invoice unit set to Box reads in Pieces and prints the Piece code", () => {
    const line = invoiceLineDisplay({
      pieces: 30,
      amount: 22.5,
      sold: { label: "Piece", qty: 30, unitPrice: 0.75 },
      invoiceUnit: { label: "Box", factor: 24 },
    });
    expect(line.unitLabel).toBe("Piece");
    const box = { mode: "unit", unit: "pack", label: "Box" } as const;
    expect(printedInvoiceCode(box, codes, view, undefined, "base", line.mode)).toBe("PC-1");
    // Whole boxes keep the invoice unit's own code.
    expect(printedInvoiceCode(box, codes, view, undefined, "base", "invoice-unit")).toBe("BAR-1");
  });

  it("a unit invoice unit prints that unit's code; ordered prints the unit sold's code", () => {
    expect(
      printedInvoiceCode(
        { mode: "unit", unit: "base", label: "Piece" },
        codes,
        view,
        undefined,
        undefined,
        "invoice-unit",
      ),
    ).toBe("PC-1");
    expect(
      printedInvoiceCode(
        { mode: "unit", unit: "u-case", label: "Case" },
        codes,
        view,
        undefined,
        undefined,
        "invoice-unit",
      ),
    ).toBe("CASE-1");
    expect(
      printedInvoiceCode({ mode: "ordered" }, codes, view, undefined, "u-case", "unit-sold"),
    ).toBe("CASE-1");
    expect(
      printedInvoiceCode({ mode: "ordered" }, codes, view, undefined, undefined, "unit-sold"),
    ).toBe("BAR-1"); // no sold unit known: the pack
  });
});
