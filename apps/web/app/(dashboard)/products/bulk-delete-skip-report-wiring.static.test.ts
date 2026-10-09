import * as fs from "fs";
import * as path from "path";

/**
 * #3323 fold (b) source pin: the products list hands a bulk delete's refusals to the skip-report dialog (the
 * toast keeps only the counts), so a refused family or active-order product is never lost.
 */
const src = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");

describe("products list: bulk delete skip report wiring", () => {
  it("renders the report from the refused items and clears it on Done", () => {
    expect(src).toMatch(
      /<BulkDeleteSkipReport skipped=\{skipReport\} onClose=\{\(\) => setSkipReport\(\[\]\)\}/,
    );
  });
  it("fills it from the result's skipped list and keeps the reasons out of the toast", () => {
    expect(src).toMatch(/if \(skipped\.length > 0\) setSkipReport\(skipped\)/);
    expect(src).not.toMatch(/skipped\.map\(\(s\) => s\.reason\)\.join/);
  });
});
