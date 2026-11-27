import { readFileSync } from "fs";
import { join } from "path";

/**
 * R-285 M-2: the mobile screen is not renderable in this jest lane (logic-only), so the H1 fix
 * (a re-scan keeps its row's mode) is source-pinned: queueScan must take its mode from scanMode(...),
 * not straight from the screen default.
 */
describe("stock-count screen: a scan takes its mode from the row (R-285 M-2)", () => {
  const src = readFileSync(
    join(__dirname, "..", "app/(operator)/products/stock-count/[id].tsx"),
    "utf8",
  );

  it("passes scanMode(...) as the mode of queueScan", () => {
    expect(src).toMatch(
      /autosave\.queueScan\([^;]*scanMode\(rowsRef\.current,\s*[\w.]+,\s*modeRef\.current\)/,
    );
  });

  it("never hands the bare default mode to queueScan", () => {
    expect(src).not.toMatch(/autosave\.queueScan\([^;]*,\s*modeRef\.current\)\s*;/);
  });
});
