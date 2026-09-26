import { assertUnitLineSplit, isEmptyUnitLineSplit, UnitLineSplitError } from "./unit-line-split";

/** #2230 / SA-388d: only the all-empty split on a multi-piece unit line is refused. */
describe("unit-line split guard (#2230, SA-388d)", () => {
  const caseLine = { unitLabel: "Case", unitsPerBox: 12 };

  it.each([
    ["3 whole Cases", { ...caseLine, qty: 36, boxes: 3, pieces: 0 }],
    [
      "a part-Case delivery (0 boxes + 5 pieces, SA-178)",
      { ...caseLine, qty: 5, boxes: 0, pieces: 5 },
    ],
    ["1 Case + 5 pieces", { ...caseLine, qty: 17, boxes: 1, pieces: 5 }],
    [
      "an Each line (factor 1, no split)",
      { unitLabel: "Each", unitsPerBox: 1, qty: 4, boxes: null, pieces: null },
    ],
    ["a unit line with no factor stored", { unitLabel: "Each", unitsPerBox: null, qty: 4 }],
    ["a zero-quantity unit line", { ...caseLine, qty: 0, boxes: 0, pieces: 0 }],
    ["a pack line (no unitLabel) with no split", { unitLabel: null, unitsPerBox: 12, qty: 36 }],
    ["Decimal-like values", { ...caseLine, qty: { toString: () => "36" }, boxes: 3, pieces: 0 }],
  ])("allows %s", (_name, line) => {
    expect(isEmptyUnitLineSplit(line as any)).toBe(false);
    expect(assertUnitLineSplit(line as any, "test")).toBe(line);
  });

  it.each([
    ["boxes 0 + pieces 0", { ...caseLine, qty: 36, boxes: 0, pieces: 0 }],
    ["boxes null + pieces null", { ...caseLine, qty: 36, boxes: null, pieces: null }],
    ["factor as a string", { unitLabel: "Case", unitsPerBox: "12", qty: "36", boxes: null }],
  ])("refuses the all-empty split: %s", (_name, line) => {
    expect(isEmptyUnitLineSplit(line as any)).toBe(true);
    expect(() => assertUnitLineSplit(line as any, "writer")).toThrow(UnitLineSplitError);
    expect(() => assertUnitLineSplit(line as any, "writer")).toThrow(/writer: refusing .*"Case"/);
  });
});

describe("every unit-line writer runs the guard before it writes (#2230)", () => {
  // The writers cannot reach the refused shape today (buildLine refuses a count <= 0; a part-unit
  // delivery keeps its pieces), so the guard is defence in depth: pin that each one still calls it.
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, "..", rel), "utf8");

  it.each([
    ["orders/unit-line-build.ts", '"buildUnitLine"'],
    ["invoices/invoice-unit-line.ts", '"buildInvoiceUnitLine"'],
    ["invoices/invoices.service.ts", '"buildInvoiceItemData"'],
    ["invoices/order-backsync-lines.ts", '"orderLineShape"'],
  ])("%s calls assertUnitLineSplit(…, %s)", (file, where) => {
    const src = read(file);
    expect(src).toContain("assertUnitLineSplit(");
    expect(src).toMatch(new RegExp(`${where},?\\s*\\)`));
  });
});
