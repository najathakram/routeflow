import { basePriceText, invoiceDisplayLines } from "@routeflow/pricing";
import { pdfItemDisplay } from "./invoice-pdf-item";

// SA-827 (T3): the PDF row mapper. The template is jest-mocked, so the row shape is proved here.
const PIECES = { kind: "pieces", label: "Piece" } as const;
const item = {
  description: "Acme Mixed Case",
  qty: 30,
  boxes: 2,
  pieces: 0,
  unitsPerBox: 15,
  unitPrice: 30.01,
  subtotal: 60.02,
};
const comps = [
  {
    componentProductId: "a1",
    name: "Acme Cola",
    qty: 10,
    unitSku: "AC-1",
    unitBarcode: "123",
    displayUnitPrice4: null,
    position: 0,
  },
  {
    componentProductId: "a2",
    name: "Acme Lime",
    qty: 20,
    unitSku: null,
    unitBarcode: null,
    displayUnitPrice4: null,
    position: 1,
  },
];

describe("basePriceText", () => {
  it("prints cents, up to 4 dp when needed", () => {
    expect(basePriceText(2.0005)).toBe("$2.0005");
    expect(basePriceText(2)).toBe("$2.00");
  });
});

describe("pdfItemDisplay", () => {
  it("today layout maps to today (template keeps its own row)", () => {
    const l = invoiceDisplayLines(item, comps, { kind: "legacy", label: null });
    expect(pdfItemDisplay(l)).toEqual({ layout: "today" });
  });

  it("pieces layout: qty cell, 4 dp price, original price hidden", () => {
    const l = invoiceDisplayLines(item, null, PIECES);
    expect(pdfItemDisplay(l)).toEqual({
      layout: "pieces",
      qtyText: "30 Piece",
      priceText: "$2.0007",
      hideOriginalPrice: true,
    });
  });

  it("components layout: rows, group row, category tax row", () => {
    const l = invoiceDisplayLines(
      { ...item, categoryTax: { name: "Tobacco", amount: 3.5 } },
      comps,
      PIECES,
    );
    const d = pdfItemDisplay(l, new Map([["a1", "data:image/png;base64,AA"]]));
    expect(d).toEqual({
      layout: "components",
      rows: [
        {
          name: "Acme Cola",
          unitSku: "AC-1",
          barcodeText: "123",
          barcodeDataUri: "data:image/png;base64,AA",
          qtyText: "10 Piece",
          priceText: "$2.001",
          amountText: "$20.01",
        },
        {
          name: "Acme Lime",
          unitSku: null,
          barcodeText: null,
          barcodeDataUri: null,
          qtyText: "20 Piece",
          priceText: "$2.0005",
          amountText: "$40.01",
        },
      ],
      group: { description: "Acme Mixed Case", amountText: "$60.02" },
      categoryTax: { label: "Tobacco tax", amountText: "$3.50" },
    });
  });

  it("components layout without a levy has null categoryTax", () => {
    const d = pdfItemDisplay(invoiceDisplayLines(item, comps, PIECES));
    expect(d.layout === "components" && d.categoryTax).toBeNull();
  });
});

// SA-1029 (RED first): the pieces view prints on the shared min-2 / max-4 decimal formatter.
describe("SA-1029 basePriceText on the shared formatter", () => {
  it.each([
    [2, "$2.00"],
    [0.7875, "$0.7875"],
    [0.125, "$0.125"],
    [1.2504, "$1.2504"],
  ])("%s -> %s", (n, text) => {
    expect(basePriceText(n)).toBe(text);
  });
});
