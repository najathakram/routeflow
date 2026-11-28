import { sheetFigures } from "../common/testing/corrected-units-sheet-figures";

// QD-9's leak check (report-corrected-units-sheet.db.spec.ts) asserted `not.toMatch(/999/)` on the whole console
// output, which also prints the run's random category UUID and timestamps. #4556's Replay went red (run
// 46106483618) on a UUID that held "999" with no figure leaked. The check now reads the FIGURES the sheet prints
// (by their labels, as footerLines writes them) and asserts on those (L-420).

// The console shape from scripts/lib/report-corrected-units-sheet.mjs footerLines/formatConsole, this tenant's
// own figures (109 filed, three lines), on a category id that happens to contain "999".
const CLEAN = [
  "generated 2026-11-28T06:59:59.999Z",
  "lines listed: 3 (A 2, B 1)",
  "",
  "category 0133efd2-b2aa-4ca6-9993-991293174a1b period 2026-07: RECONCILED",
  "  filing LOCKED key 2026-07 generated 2026-08-30T00:00:00.000Z locked 2026-09-01T00:00:00.000Z snapshot unit basis 109",
  "  filed (snapshot, LOCKED): 109 | sum of line deltas: 0 | corrected period total: 109",
  "",
  "CSV: local-assets/reports/corrected-units-2026-11-28T06-59-59-999Z.csv",
].join("\n");

// The same sheet with the other tenant's filed 999 leaked into this tenant's footer.
const LEAKED = CLEAN.replace(
  "filed (snapshot, LOCKED): 109 | sum of line deltas: 0 | corrected period total: 109",
  "filed (snapshot, LOCKED): 999 | sum of line deltas: 0 | corrected period total: 999",
);

describe("QD-9 leak check reads the sheet's figures, not every digit run (L-420)", () => {
  it("the clean fixture really carries 999 in its ids and timestamps (so the old bare regex fails on it)", () => {
    expect(CLEAN).toMatch(/999/);
  });

  it("clean output: the figures are this tenant's own, and 999 is not among them", () => {
    const figures = sheetFigures(CLEAN);
    expect(figures).toEqual([109, 109, 0, 109]);
    expect(figures).not.toContain(999);
  });

  it("leaked output: the leaked 999 is read as a figure, so QD-9 still goes red on a real leak", () => {
    expect(sheetFigures(LEAKED)).toContain(999);
  });

  it("reads every figure label the footer prints, negative and decimal values included", () => {
    const out = [
      "  filed (snapshot, GENERATED): -12.5 | sum of line deltas: -3 | corrected period total: 9.25",
      "  LEDGER MOVED SINCE FILING by 12 (live ledger sum 130)",
      "  live ledger sum 41.125 | sum of line deltas: 0 | no filing holds this period (nothing filed to compare)",
    ].join("\n");
    expect(sheetFigures(out)).toEqual([-12.5, -3, 9.25, 12, 130, 41.125, 0]);
  });

  it("a figure printed as null (an unclassified line's total) is not read as a number", () => {
    expect(
      sheetFigures(
        "  filed (snapshot, LOCKED): 109 | sum of line deltas: 0 | corrected period total: null",
      ),
    ).toEqual([109, 0]);
  });
});
