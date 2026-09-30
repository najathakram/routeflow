import { componentSubLineText } from "@routeflow/pricing";
import { componentSubLineTexts } from "../lib/line-components";
import { invoiceLineSubLines } from "../lib/invoice-line-display";
import { orderLineCardModel } from "../lib/order-line-display";

/**
 * #2717 M3 (case 34, L-225): mobile prints a composed (mixed-pack) line's sub-lines through the SAME
 * `componentSubLineText` as web and the PDF, from BOTH display modules (invoice line and order card).
 * Pure logic only (RN cannot render here). A legacy line yields none.
 */
const comps = [
  {
    componentProductId: "o",
    name: "Oat",
    qty: 24,
    unitSku: null,
    unitBarcode: null,
    barcodeSymbology: null,
    displayUnitPrice4: null,
    position: 1,
  },
  {
    componentProductId: "a",
    name: "Almond",
    qty: 24,
    unitSku: "ALM-1",
    unitBarcode: "036000291452",
    barcodeSymbology: "UPC_A",
    displayUnitPrice4: "0.6250" as unknown as number, // a Decimal arrives as a string
    position: 0,
  },
];
const expected = [
  componentSubLineText({
    name: "Almond",
    qty: 24,
    unitSku: "ALM-1",
    unitBarcode: "036000291452",
    displayUnitPrice4: 0.625,
  }),
  componentSubLineText({
    name: "Oat",
    qty: 24,
    unitSku: null,
    unitBarcode: null,
    displayUnitPrice4: null,
  }),
];

describe("mobile composed-line sub-lines", () => {
  it("the shared helper sorts by position and uses componentSubLineText", () => {
    expect(componentSubLineTexts(comps)).toEqual(expected);
    expect(expected[0]).toContain("$0.63 (included)");
  });

  it("the invoice line display renders the same texts", () => {
    expect(invoiceLineSubLines({ components: comps })).toEqual(expected);
  });

  it("the order line card model carries the same texts", () => {
    const model = orderLineCardModel(
      {
        id: "l1",
        productId: "p",
        name: null,
        qty: 48,
        unitPrice: 30,
        boxes: 2,
        pieces: 0,
        unitsPerBox: 24,
        status: "PENDING",
        components: comps,
      } as never,
      "PENDING",
    );
    expect(model.subLines).toEqual(expected);
  });

  it("a legacy line (no components) has none, and the card model gains no key", () => {
    expect(componentSubLineTexts(undefined)).toEqual([]);
    expect(invoiceLineSubLines({})).toEqual([]);
    const model = orderLineCardModel(
      { id: "l2", productId: "p", name: null, qty: 4, unitPrice: 3, status: "PENDING" } as never,
      "PENDING",
    );
    expect(Object.keys(model)).not.toContain("subLines");
  });
});
