import { readFileSync } from "fs";
import { join } from "path";

/**
 * #2131 review round 1, point 3: `BarcodeScanner.tsx`'s enforced aim box used to be
 * `ScanCamera`'s own generic default (centered on ITS measured layout), which drifted
 * from the box this screen actually DRAWS (offset 40dp above center — see the
 * `(SCREEN_HEIGHT - WINDOW_SIZE) / 2 - 40` top-dark height below the "Clear scan window"
 * box) — a barcode aligned with the visible box could fall outside the invisible enforced
 * one. The fix: this screen computes its OWN exact rect and passes it to `ScanCamera`
 * explicitly, so drawing and enforcement are provably the same source.
 */
describe("BarcodeScanner.tsx: explicit aimBox matches the drawn scan window (#2131 review round 1)", () => {
  const src = readFileSync(join(__dirname, "..", "components", "BarcodeScanner.tsx"), "utf8");

  it("computes its own AIM_BOX using the SAME WINDOW_SIZE and vertical offset the drawn box uses", () => {
    const at = src.indexOf("const AIM_BOX");
    expect(at).toBeGreaterThan(-1);
    const decl = src.slice(at, src.indexOf("};", at) + 2);
    expect(decl).toMatch(/width:\s*WINDOW_SIZE/);
    expect(decl).toMatch(/height:\s*WINDOW_SIZE/);
    // The same "- 40" the top-dark spacer already uses, so the two can never drift apart.
    expect(decl).toMatch(/SCREEN_HEIGHT\s*-\s*WINDOW_SIZE\)\s*\/\s*2\s*-\s*40/);
  });

  it("passes AIM_BOX to ScanCamera in continuous mode only (single-shot stays untouched)", () => {
    const at = src.indexOf("<ScanCamera");
    const tag = src.slice(at, src.indexOf("/>", at));
    expect(tag).toMatch(/aimBox=\{continuous \? AIM_BOX : undefined\}/);
  });
});
