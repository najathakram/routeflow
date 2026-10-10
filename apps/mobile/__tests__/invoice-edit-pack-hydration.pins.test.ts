import { readFileSync } from "fs";
import { join } from "path";

/**
 * B674/SA-144 — the operator invoice EDIT screen's hydration must recover a legacy
 * boxed line's pack from its OWN stored split (`packFromOwnSplit`), never fall back to
 * nothing at all. Before this fix `unitsPerBox` stayed null for a line stored with
 * `boxes` but no `unitsPerBox` snapshot, so `isSplit` (upb > 1) was false and the
 * case/piece stepper never rendered — the operator could not see or edit the split, and
 * saving re-priced the line as loose pieces. RN screens aren't renderable in this jest
 * lane (pure-logic only), so the wiring is source-pinned — see
 * invoice-unit-edit-guard-wiring.test.ts for the same pattern.
 */
describe("B674/SA-144: invoice edit hydration recovers a legacy line's pack from its own split", () => {
  const src = readFileSync(
    join(__dirname, "..", "app/(operator)/(tabs)/invoices/[id]/edit.tsx"),
    "utf8",
  );

  it("imports packFromOwnSplit from @routeflow/pricing", () => {
    expect(src).toMatch(/import\s*{[^}]*packFromOwnSplit[^}]*}\s*from\s*"@routeflow\/pricing"/);
  });

  it("the hydration's unitsPerBox falls back to packFromOwnSplit, never a bare `?? null` with no recovery", () => {
    // master added an index param `(it, i)`; anchor on the map call either way
    const at = src.search(
      /const hydratedLines = \(invoice\.items \?\? \[\]\)\.map\(\(it(?:, i)?\) => \(\{/,
    );
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, src.indexOf("}));", at) + 4);
    expect(block).toMatch(/unitsPerBox:\s*\n?\s*it\.unitsPerBox\s*\?\?\s*\n?\s*packFromOwnSplit\(/);
    // Never the old shape: a bare `it.unitsPerBox ?? null` with nothing else on the RHS.
    expect(block).not.toMatch(/unitsPerBox:\s*it\.unitsPerBox\s*\?\?\s*null,/);
  });
});
