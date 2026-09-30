import { readFileSync, readdirSync } from "fs";
import { join } from "path";

/**
 * Tripwire (L-167): buyer product visibility lives in ONE builder, buyer-product-visibility.ts.
 * No other non-spec file under apps/api/src/buyer/ may hand-repeat a raw `isActive: true`
 * (a product `where` that does is how a hidden product leaks on one surface). The baseline for
 * every other file is 0 except the two justified non-product entries below; the builder file itself is the only allowed home.
 */
const BUILDER = "buyer-product-visibility.ts";
const BASELINE: Record<string, number> = {
  // Non-product-where occurrences only (never a product filter):
  "buyer-dashboard.service.ts": 1, // orderTemplate.count where — a template flag, not a product
  "replenishment.service.ts": 1, // a SELECT projection (visibility is decided by isBuyerVisibleProduct)
};

const RAW_ACTIVE = /\bisActive\s*:\s*true\b/g;
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

const dir = __dirname;
const files = readdirSync(dir).filter(
  (f) => f.endsWith(".ts") && !f.endsWith(".spec.ts") && f !== BUILDER,
);

describe("buyer product visibility call sites", () => {
  it("the scanner can see a raw isActive: true (not vacuous)", () => {
    expect(strip("where: { isActive: true }").match(RAW_ACTIVE)).toHaveLength(1);
    expect(strip("// isActive: true\nconst a = 1;").match(RAW_ACTIVE)).toBeNull();
  });

  it("the builder file is the one place that owns the clause", () => {
    expect(strip(readFileSync(join(dir, BUILDER), "utf8")).match(RAW_ACTIVE)).toHaveLength(1);
  });

  it.each(files)("%s has no raw isActive: true outside the builder", (f) => {
    const n = (strip(readFileSync(join(dir, f), "utf8")).match(RAW_ACTIVE) ?? []).length;
    expect(n).toBe(BASELINE[f] ?? 0);
  });
});
