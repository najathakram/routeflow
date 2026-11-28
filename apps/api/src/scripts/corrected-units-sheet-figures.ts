/**
 * Test helper for the corrected-units sheet specs (L-420): the FIGURES the console output prints, in order,
 * read by the labels `footerLines` in `apps/api/scripts/lib/report-corrected-units-sheet.mjs` writes. A leak
 * check asserts on these, never on a bare digit run over the whole output: that output also carries the run's
 * random category UUIDs and timestamps, which hold any short digit run sooner or later.
 *
 * A label followed by something that is not a number (`null` for an unclassified line's total) yields nothing.
 */
const FIGURE =
  /(?:snapshot unit basis|filed \(snapshot, [A-Z_]+\):|sum of line deltas:|corrected period total:|LEDGER MOVED SINCE FILING by|live ledger sum) (-?\d+(?:\.\d+)?)(?![\d.])/g;

export function sheetFigures(out: string): number[] {
  return [...out.matchAll(FIGURE)].map((m) => Number(m[1]));
}
