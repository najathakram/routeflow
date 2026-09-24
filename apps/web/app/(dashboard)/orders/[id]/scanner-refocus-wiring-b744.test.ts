import fs from "fs";
import path from "path";

/**
 * B744 wiring (order-edit family). Adding an item in order-edit mode re-arms the add input twice
 * (80 ms, then a 200 ms fallback); the archived / ambiguous / network-error rescan paths SELECT
 * the code in it after an awaited lookup. Every one of those must route through the shared
 * `scheduleScannerRefocus`, which never takes focus from a text-entry field — this page shows
 * each line's note textarea and qty input at all times. Behavior is unit-tested in
 * lib/refocus-scanner.test.ts; this page has no render harness (a full one is a follow-up), so
 * this pins the WIRING.
 *
 * Out of scope and pinned UNCHANGED: B62's one-time mount autofocus (REG-B62). It is a different
 * trigger (edit mode opening / pricing settling), and its stricter rule is deliberate — it will
 * not take focus from ANY element the operator clicked while waiting, a button included.
 */
const src = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8");

const BARE_REARM = /setTimeout\(\s*\(\)\s*=>\s*\w+\.current\?\.(focus|select)\(\)/g;

describe("B744 — order-edit scanner re-arm wiring (REG-B744)", () => {
  it("imports the shared guarded re-arm", () => {
    expect(src).toMatch(
      /import\s*\{[^}]*\bscheduleScannerRefocus\b[^}]*\}\s*from\s*"@\/lib\/refocus-scanner"/,
    );
  });

  it("leaves no bare, unconditional setTimeout re-arm of a ref", () => {
    expect(src.match(BARE_REARM) ?? []).toEqual([]);
  });

  it("keeps the add path's two re-arms (80 ms, then the 200 ms fallback), each guarded", () => {
    expect(
      src.match(/scheduleScannerRefocus\(\s*addInputRef\s*,\s*\[\s*80\s*,\s*200\s*\]\s*\)/g) ?? [],
    ).toHaveLength(1);
  });

  it("routes the three rescan paths' select() through the helper at 50 ms", () => {
    expect(
      src.match(
        /scheduleScannerRefocus\(\s*addInputRef\s*,\s*50\s*,\s*\{\s*select:\s*true\s*\}\s*\)/g,
      ) ?? [],
    ).toHaveLength(3);
  });

  it("pin: B62's one-time mount autofocus keeps its own stricter guard, unchanged", () => {
    expect(src).toMatch(
      /if \(active && active !== document\.body && active !== el\) return;\s*\n\s*el\.focus\(\);/,
    );
  });
});
