import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative, sep } from "path";

/**
 * SA-1041 structural pin: `familyPriceAuthorityError(` is how a writer refuses a price the family owns.
 * The count per non-spec source file is exact and may only shrink; a new call site is a new writer that must
 * ask `priceAuthority` first, so it is added here in the same diff, deliberately.
 */
const SRC = join(__dirname, "..");
const EXPECTED: Record<string, number> = {
  // SA-1082 A-1: a variant's price is its own, so the variant refusals went (4 to 2, and the family editor's 1 to 0).
  "products/family-price.ts": 2,
  "products/product-units-price-guard.ts": 1,
  "products/product-price-write.service.ts": 1,
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.ts$/.test(name) && !/\.(spec|test)\.ts$/.test(name) ? [full] : [];
  });
}

describe("familyPriceAuthorityError call sites", () => {
  const found: Record<string, number> = {};
  for (const file of sources(SRC)) {
    const n = readFileSync(file, "utf8").split("familyPriceAuthorityError(").length - 1;
    if (n > 0) found[relative(SRC, file).split(sep).join("/")] = n;
  }

  it("matches the pinned count per file (exact, shrink-only)", () => {
    expect(found).toEqual(EXPECTED);
  });
});
