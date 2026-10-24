import * as fs from "fs";
import * as path from "path";

// The order-unit switch preview waits for U-1 (PRICING_RULES_NOT_READY server-side): no web source may plan a switch
// or materialize a pack. The API-side twin is pack-write-path.spec.ts (USE_ALLOW).
const WEB = path.resolve(__dirname, "../../../../..");
const ROOTS = ["app", "components", "lib"];
const NAMES = /\b(?:planOrderUnitSwitch|materializePack)\b/;

function walk(dir: string, out: string[]): void {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!["node_modules", ".next"].includes(e.name)) walk(p, out);
    } else if (/\.(ts|tsx)$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) out.push(p);
  }
}

describe("no order-unit switch planning in the web", () => {
  const files: string[] = [];
  for (const r of ROOTS) walk(path.join(WEB, r), files);

  it("scans a real set of files and the detector is not vacuous", () => {
    expect(files.some((f) => f.endsWith("ProductPricingV2.tsx"))).toBe(true);
    expect(NAMES.test("planOrderUnitSwitch(view, scope, to)")).toBe(true);
  });

  it("no web source names planOrderUnitSwitch or materializePack", () => {
    const users = files.filter((f) => NAMES.test(fs.readFileSync(f, "utf8")));
    expect(users.map((f) => path.relative(WEB, f))).toEqual([]);
  });
});
