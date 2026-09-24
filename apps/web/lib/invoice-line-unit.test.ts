import * as fs from "fs";
import * as path from "path";
import { formatQtySplit } from "@routeflow/pricing";
import { hasUnitLine, invoiceLineQtyText, isUnitLine, unitLabelsOf } from "./invoice-line-unit";

describe("invoiceLineQtyText — FLAG-OFF characterization: a line with no unit reads exactly as before", () => {
  const packLines = [
    { qty: 13, boxes: 2, pieces: 3 },
    { qty: 48, boxes: 2, pieces: 0 },
    { qty: 6, boxes: 0, pieces: 6 },
    { qty: 7 },
    { qty: "2.5" },
    { qty: 10, boxes: null, pieces: null },
  ];
  const noUnit: Array<string | null | undefined> = [undefined, null, "", "   "];

  it.each(packLines.flatMap((l) => noUnit.map((u) => [l, u] as const)))(
    "%j with unitLabel %j is byte-identical to formatQtySplit",
    (line, unitLabel) => {
      expect(invoiceLineQtyText({ ...line, unitLabel })).toBe(
        formatQtySplit({ qty: line.qty, boxes: (line as any).boxes, pieces: (line as any).pieces }),
      );
    },
  );
});

describe("invoiceLineQtyText — a line sold by a unit names its unit, not 'boxes'", () => {
  it("3 Cases (864 pieces) reads '3 Cases', and 1 reads '1 Case'", () => {
    expect(invoiceLineQtyText({ qty: 864, boxes: 3, pieces: 0, unitLabel: "Case" })).toBe(
      "3 Cases",
    );
    expect(invoiceLineQtyText({ qty: 288, boxes: 1, pieces: 0, unitLabel: "Case" })).toBe("1 Case");
  });

  it("the stored piece total is NOT what it shows: 864 pieces never appears as the quantity", () => {
    expect(invoiceLineQtyText({ qty: 864, boxes: 3, pieces: 0, unitLabel: "Case" })).not.toMatch(
      /864/,
    );
  });

  it("a factor-1 unit has no split, so it reads its count and label", () => {
    expect(invoiceLineQtyText({ qty: 5, boxes: null, pieces: null, unitLabel: "Piece" })).toBe(
      "5 Piece",
    );
  });

  it("trims the label", () => {
    expect(invoiceLineQtyText({ qty: 576, boxes: 2, pieces: 0, unitLabel: "  Case " })).toBe(
      "2 Cases",
    );
  });
});

describe("isUnitLine / hasUnitLine / unitLabelsOf", () => {
  it("only a non-blank unitLabel makes a unit line", () => {
    expect(isUnitLine({ unitLabel: "Case" })).toBe(true);
    for (const u of [undefined, null, "", "  "]) expect(isUnitLine({ unitLabel: u })).toBe(false);
    expect(isUnitLine(null)).toBe(false);
  });

  it("an invoice holds a unit line when ANY line does (and an empty/missing list does not)", () => {
    expect(hasUnitLine([{ unitLabel: null }, { unitLabel: "Case" }])).toBe(true);
    expect(hasUnitLine([{ unitLabel: null }, {}])).toBe(false);
    expect(hasUnitLine([])).toBe(false);
    expect(hasUnitLine(undefined)).toBe(false);
  });

  it("lists each distinct unit once, in line order", () => {
    expect(
      unitLabelsOf([
        { unitLabel: "Case" },
        { unitLabel: null },
        { unitLabel: "Pallet" },
        { unitLabel: "Case " },
      ]),
    ).toEqual(["Case", "Pallet"]);
    expect(unitLabelsOf(undefined)).toEqual([]);
  });
});

describe("wiring — the invoice detail page renders line quantities through invoiceLineQtyText", () => {
  // The page is too large to render in a spec; this pins that the ONE place it prints a line's quantity
  // goes through the unit-aware helper (a bare formatQtySplit there would show 3 Cases as "3 boxes").
  const page = fs.readFileSync(
    path.join(__dirname, "../app/(dashboard)/invoices/[id]/page.tsx"),
    "utf8",
  );

  it("uses invoiceLineQtyText(item) and has no direct formatQtySplit call left", () => {
    expect(page).toContain("invoiceLineQtyText(item)");
    expect(page).not.toMatch(/formatQtySplit\(/);
  });
});
