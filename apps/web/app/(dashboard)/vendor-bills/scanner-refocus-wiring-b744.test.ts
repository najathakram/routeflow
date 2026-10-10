import fs from "fs";
import path from "path";

/**
 * B744 wiring (vendor-bills family). The bill scan handler re-arms its scan input after an
 * AWAITED lookup — on the add path and on the item-not-found path. Both re-arms must route through
 * the shared `scheduleScannerRefocus`, which never takes focus from a text-entry field (a line's
 * qty / cost / description, the notes textarea). The behavior itself is unit-tested in
 * lib/refocus-scanner.test.ts; this page has no render harness (a full one is a follow-up), so
 * this pins the WIRING: the helper is used, and no bare unconditional re-arm survives.
 */
const src = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");

const BARE_REARM = /setTimeout\(\s*\(\)\s*=>\s*\w+\.current\?\.(focus|select)\(\)/g;

describe("B744 — vendor-bills scanner re-arm wiring (REG-B744)", () => {
  it("imports the shared guarded re-arm", () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\bscheduleScannerRefocus\b[^}]*\}\s*from\s*"@\/lib\/refocus-scanner"/,
    );
  });

  it("leaves no bare, unconditional setTimeout re-arm of a ref", () => {
    expect(src.match(BARE_REARM) ?? []).toEqual([]);
  });

  it("routes both scan-handler re-arms (not-found and after-add) through the helper at 50 ms", () => {
    expect(src.match(/scheduleScannerRefocus\(\s*scanInputRef\s*,\s*50\s*\)/g) ?? []).toHaveLength(
      2,
    );
  });
});
