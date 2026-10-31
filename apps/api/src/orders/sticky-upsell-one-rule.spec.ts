import * as fs from "fs";
import * as path from "path";

/**
 * SA-1068 M4: the remembered-price rule has ONE home, `isStickyUpsell` in @routeflow/pricing. The server's buyer-merge
 * pricing and the units v2 Customer view call it (the till's display reads it through `customerLinePrice`), so a
 * hand-written `remembered > list` comparison in either file is a second copy that can drift from the display.
 */
const SRC = path.resolve(__dirname, "..");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const read = (rel: string) => strip(fs.readFileSync(path.join(SRC, rel), "utf8"));

describe("SA-1068 M4: one remembered-price rule", () => {
  it.each(["orders/buyer-merge-pricing.ts", "customers/customer-unit-prices.service.ts"])(
    "%s asks isStickyUpsell and carries no copy of the comparison",
    (file) => {
      const src = read(file);
      expect(src).toMatch(/isStickyUpsell\(/);
      expect(src).not.toMatch(/remembered\s*!=\s*null\s*&&/);
      expect(src).not.toMatch(/Number\(remembered\)\s*>/);
      expect(src).not.toMatch(/remembered\s*>\s*Number\(/);
    },
  );
});
