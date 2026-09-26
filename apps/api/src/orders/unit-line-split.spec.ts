jest.mock("@sentry/node", () => ({ captureMessage: jest.fn() }));

import * as Sentry from "@sentry/node";
import { assertUnitLineSplit, isEmptyUnitLineSplit, UnitLineSplitError } from "./unit-line-split";

const capture = Sentry.captureMessage as unknown as jest.Mock;
beforeEach(() => capture.mockClear());

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
  });

  it("an allowed line is never reported", () => {
    assertUnitLineSplit({ ...caseLine, qty: 36, boxes: 3, pieces: 0 }, "writer");
    expect(capture).not.toHaveBeenCalled();
  });

  it("names a line with no description by its product, then generically", () => {
    const base = { ...caseLine, qty: 36, boxes: 0, pieces: 0 };
    expect(() => assertUnitLineSplit({ ...base, productId: "p-9" }, "w")).toThrow(
      /^p-9 is sold by the Case/,
    );
    expect(() => assertUnitLineSplit(base, "w")).toThrow(/^This line is sold by the Case/);
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

describe("change-request writes run the unit-aware target check first (#2230, SA-388f)", () => {
  // The two change-request paths that re-derive a line's split from `wasBoxSplit` would carry an
  // existing all-empty split forward; assertChangeTargetAllowed must refuse a unit-aware target
  // BEFORE either one writes. Scoped to approveChangeRequestAtStop's own body.
  const fs = require("fs") as typeof import("fs");
  const path = require("path") as typeof import("path");
  const src = fs.readFileSync(path.resolve(__dirname, "orders.service.ts"), "utf8");
  const start = src.indexOf("  async approveChangeRequestAtStop(");
  const rest = src.slice(start + 1);
  const next = rest.search(/\n {2}(?:async |private |public |protected |static )?\w+\(/);
  const body = next === -1 ? rest : rest.slice(0, next);

  it("finds the method, the check and both split-deriving writes", () => {
    expect(start).toBeGreaterThan(-1);
    expect(body).toContain("unitAware.assertChangeTargetAllowed(");
    expect(body).toContain("const wasBoxSplit = src.boxes != null;");
    expect(body).toContain("const wasBoxSplit = existing.boxes != null;");
  });

  it.each([
    ["const wasBoxSplit = src.boxes != null;"],
    ["const wasBoxSplit = existing.boxes != null;"],
  ])("assertChangeTargetAllowed runs before `%s`", (write) => {
    const check = body.indexOf("unitAware.assertChangeTargetAllowed(");
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(body.indexOf(write));
  });
});
