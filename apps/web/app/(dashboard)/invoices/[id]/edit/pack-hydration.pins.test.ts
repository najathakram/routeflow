import { readFileSync } from "fs";
import { join } from "path";

/**
 * B674/SA-144 — the invoice edit page's hydration must recover a legacy boxed line's pack
 * (unitsPerBox never snapshotted, boxes stored) from its OWN split via `packFromOwnSplit`,
 * never fall back to the live product — which, if the product was repacked since the sale,
 * silently re-splits the line's pieces at the new pack on the next save. This page has no
 * existing render-test coverage (a pre-existing gap, not backfilled here); source-pinned
 * instead so the wiring can't silently regress to the old live-product fallback.
 */
describe("B674/SA-144: invoice edit page hydration recovers a legacy line's pack from its own split", () => {
  const src = readFileSync(join(__dirname, "page.tsx"), "utf8");

  it("imports packFromOwnSplit from @routeflow/pricing", () => {
    expect(src).toMatch(/import\s*{[^}]*packFromOwnSplit[^}]*}\s*from\s*"@routeflow\/pricing"/);
  });

  it("the hydration's upb falls back to packFromOwnSplit, never the live product.unitsPerBox", () => {
    const at = src.indexOf("const isBoxSplit = it.boxes != null;");
    expect(at).toBeGreaterThan(-1);
    const block = src.slice(at, at + 400);
    expect(block).toMatch(/it\.unitsPerBox\s*\?\?\s*\n?\s*packFromOwnSplit\(/);
    // Never the old shape: a live-product fallback for an EXISTING (already-stored) line.
    expect(block).not.toContain("it.product?.unitsPerBox");
  });
});
