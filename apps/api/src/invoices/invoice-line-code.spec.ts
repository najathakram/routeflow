import { buildLadderView, type LadderViewUnit } from "@routeflow/pricing";
import { invoiceLineCode } from "./invoice-line-code";

const product = { unit: "Box", unitsPerBox: 24, pricePerUnit: "24.00" };
const piece: LadderViewUnit = {
  id: "u-piece",
  label: "Piece",
  factorToBase: 1,
  price: "1.00",
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
};
const view = buildLadderView(product, [piece]);
const codes = { sku: "SKU", barcode: "BOX-BC", unitSku: "PC-SKU", unitCodes: { base: "PC-CODE" } };

describe("S19: the printed code reads the line's mode (printedInvoiceCode's required lineMode)", () => {
  const line = (pieces: number, qty: number) => ({
    pieces,
    amount: pieces,
    sold: { label: "Piece", qty, unitPrice: 1 },
    invoiceUnit: { label: "Box", factor: 24 },
  });
  const base = { codes, view, legacyCodes: codes, soldUnit: "base" };

  it("legacy prints today's chain whatever the mode", () => {
    expect(invoiceLineCode({ ...base, choice: { mode: "legacy" }, line: line(72, 72) })).toBe(
      "PC-SKU",
    );
  });
  it("a whole number of the invoice unit (72 pieces = 3 Boxes) prints the invoice unit's code", () => {
    expect(
      invoiceLineCode({
        ...base,
        choice: { mode: "unit", unit: "pack", label: "Box" },
        line: line(72, 72),
      }),
    ).toBe("BOX-BC");
  });
  it("T18: 30 pieces are not a whole number of Boxes, the line reads in the unit sold and prints the SOLD unit's code", () => {
    expect(
      invoiceLineCode({
        ...base,
        choice: { mode: "unit", unit: "pack", label: "Box" },
        line: line(30, 30),
      }),
    ).toBe("PC-CODE");
  });
  it("ordered prints the sold unit's code; with no sold unit known, the pack", () => {
    expect(invoiceLineCode({ ...base, choice: { mode: "ordered" }, line: line(30, 30) })).toBe(
      "PC-CODE",
    );
    expect(
      invoiceLineCode({ ...base, soldUnit: null, choice: { mode: "ordered" }, line: line(30, 30) }),
    ).toBe("BOX-BC");
  });
});
