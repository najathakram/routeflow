import { readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";

/**
 * W-725 grep pin: a mobile screen resolves the tier a customer pays at ONLY through `customerTierFor` (@routeflow/pricing),
 * which skips a missing or invalid tier the same way on web, mobile and the api. A hand-rolled `?? customerTier ?? 1` chain
 * treats a non-integer or out-of-range tier differently and is how the screens drifted apart.
 */
const ROOT = join(__dirname, "..");
const DIRS = ["app", "components", "lib"];
const FORBIDDEN: Array<[RegExp, string]> = [
  [
    /\?\?\s*customerTier\b/,
    "`?? customerTier`: use customerTierFor(customerProductTier, customerTier)",
  ],
  [
    /cpMap\.get\([^)]*\)\s*\?\?/,
    "`cpMap.get(id) ??`: use customerTierFor(cpMap.get(id), customerTier)",
  ],
  [
    /customerTier\s*=\s*[^;\n]*pricingTier\s*\?\?\s*1/,
    "`customerTier = …pricingTier ?? 1`: use customerTierFor(undefined, …)",
  ],
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) return name === "__tests__" ? [] : sources(abs);
    return /\.(ts|tsx)$/.test(name) ? [abs] : [];
  });
}

describe("W-725: mobile tier fallbacks go through customerTierFor", () => {
  it("no screen hand-rolls the customer tier chain", () => {
    const offenders: string[] = [];
    for (const file of DIRS.flatMap((d) => sources(join(ROOT, d)))) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/^\s*(\*|\/\/)/.test(line)) return; // comments describe the rule
          for (const [re, why] of FORBIDDEN)
            if (re.test(line)) offenders.push(`${relative(ROOT, file)}:${i + 1} ${why}`);
        });
    }
    expect(offenders).toEqual([]);
  });
});
