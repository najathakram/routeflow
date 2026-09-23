import { invoiceLineQtyText, invoiceLineUnitNoun } from "../lib/invoice-line-display";

/**
 * B653 (mobile piece): the operator invoice detail's per-line qty/unit text. Fixtures mirror
 * `buildInvoiceUnitLine`'s actual stored shape for a units_v1 line: boxes = unit count, pieces = 0.
 */

describe("invoiceLineQtyText", () => {
  it('REG-B653-mobile: a units_v1 line reads "N Case(s)", never "N boxes"', () => {
    expect(invoiceLineQtyText({ qty: 36, boxes: 3, pieces: 0, unitLabel: "Case" })).toBe("3 Cases");
    expect(invoiceLineQtyText({ qty: 12, boxes: 1, pieces: 0, unitLabel: "Case" })).toBe("1 Case");
  });

  it('REG-B653-mobile: an ordinary boxed line (no unitLabel) is unchanged — still "boxes"/"pcs"', () => {
    expect(invoiceLineQtyText({ qty: 27, boxes: 2, pieces: 3 })).toBe("2 boxes + 3 pcs");
    expect(invoiceLineQtyText({ qty: 27, boxes: 2, pieces: 3, unitLabel: null })).toBe(
      "2 boxes + 3 pcs",
    );
  });

  it("REG-B653-mobile: a plain non-boxed line is unaffected", () => {
    expect(invoiceLineQtyText({ qty: 5, boxes: null, pieces: null })).toBe("5");
  });
});

describe("invoiceLineUnitNoun", () => {
  it('REG-B653-mobile: names the units_v1 unit ("Case") for the "@ price/<noun>" suffix', () => {
    expect(invoiceLineUnitNoun({ unitLabel: "Case" })).toBe("Case");
  });

  it('REG-B653-mobile: defaults to "box" for an ordinary boxed line — unchanged from today', () => {
    expect(invoiceLineUnitNoun({ unitLabel: null })).toBe("box");
    expect(invoiceLineUnitNoun({})).toBe("box");
    expect(invoiceLineUnitNoun({ unitLabel: "  " })).toBe("box");
  });
});
