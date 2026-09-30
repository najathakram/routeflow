/**
 * Pins the row summary's exact strings and its agreement with the footer math.
 * The summary and the footer total both feed the same raw line fields into
 * computeLineSubtotal — if they ever disagree, the operator sees one number on
 * the row and pays another at the bottom.
 */
import { boxedLineSummary } from "../lib/boxed-line-summary";
import { computeLineSubtotal } from "@routeflow/pricing";

describe("boxedLineSummary", () => {
  it("formats cases + loose with the prorated subtotal", () => {
    // (2 + 1/6) box-equivalents × $12/case = $26.00
    expect(boxedLineSummary({ qty: 13, boxes: 2, pieces: 1 }, 6, 12)).toBe(
      "2 cases + 1 loose · $26.00",
    );
  });

  it("uses the singular for one case", () => {
    expect(boxedLineSummary({ qty: 6, boxes: 1, pieces: 0 }, 6, 12)).toBe("1 case · $12.00");
  });

  it("formats a loose-only line", () => {
    expect(boxedLineSummary({ qty: 3, boxes: 0, pieces: 3 }, 6, 12)).toBe("3 loose · $6.00");
  });

  it("passes RAW fields to the subtotal so row and footer agree, even qty-only", () => {
    // A boxed line always carries its split in practice — every sale-line
    // helper writes boxes/pieces (incrementLine, setLineBoxes/Pieces/Units),
    // so a qty-only boxed line is unreachable through the builders' UI. If one
    // ever occurred, computeLineSubtotal's fallback treats unitPrice as
    // per-PIECE (12 × 7 = 84, not 12 × 7/6): the display text still derives
    // the split, but the money would not. The helper deliberately does NOT
    // normalize before the subtotal call, because the footer memo passes the
    // same raw fields — row-vs-footer agreement is the invariant that matters,
    // and this test pins it. If this ever fails with $14.00, someone made the
    // summary normalize without making the footer normalize too.
    expect(boxedLineSummary({ qty: 7 }, 6, 12)).toBe("1 case + 1 loose · $84.00");
  });

  it("renders the 0 placeholder for an empty line", () => {
    expect(boxedLineSummary({ qty: 0, boxes: 0, pieces: 0 }, 6, 12)).toBe("0 · $0.00");
  });

  it("uses the resolved price it is given (override applied by the caller)", () => {
    expect(boxedLineSummary({ qty: 6, boxes: 1, pieces: 0 }, 6, 10)).toBe("1 case · $10.00");
  });

  it("agrees with the footer's computeLineSubtotal to the cent", () => {
    const line = { qty: 16, boxes: 2, pieces: 4 };
    const expected = computeLineSubtotal({
      unitPrice: 9.99,
      qty: 16,
      boxes: 2,
      pieces: 4,
      unitsPerBox: 6,
    });
    expect(boxedLineSummary(line, 6, 9.99).endsWith(`$${expected.toFixed(2)}`)).toBe(true);
  });
});
