import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";

/**
 * SA-1034: the price-edit capability is checked at every override site, through the ONE helper
 * `assertPriceEditAllowed` (staff-override.ts), with a required boolean the caller computes as
 * `staffMay(role, "EDIT_LINE_PRICE", deniedGroups)`.
 *
 *  - `decideTierOverride(` has exactly the callers listed below; a new one is reviewed and added here.
 *  - each override-site file keeps at least its count of `assertPriceEditAllowed(` calls (a floor:
 *    a count may grow with a new site, never drop).
 *  - `assertPriceEditAllowed` takes a required `boolean`.
 *  - every `staffMay(…, "EDIT_LINE_PRICE"…)` passes its `deniedGroups` argument explicitly.
 * Pure source reads: no Nest, no database.
 */
const SRC = join(__dirname, "..");
const read = (f: string) => readFileSync(join(SRC, f), "utf8");

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) {
      if (name !== "node_modules" && name !== "testing") sourceFiles(abs, out);
    } else if (name.endsWith(".ts") && !name.endsWith(".spec.ts")) {
      out.push(relative(SRC, abs));
    }
  }
  return out;
}

/** The code of a file with `//` and block comments removed, so a mention in prose never counts. */
const code = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
const callCount = (text: string, name: string) =>
  [...code(text).matchAll(new RegExp(`(?<!function )\\b${name}\\(`, "g"))].length;

const DECIDE_TIER_OVERRIDE_CALLERS: Record<string, number> = {
  "orders/orders.service.ts": 2, // create (pack line) + updateOrderItems (substitute)
  "orders/replace-all-line-build.ts": 1, // the create auto-merge's new line
  "invoices/invoice-line-override.ts": 1, // invoice line create / edit (pack line)
};

/** Shrink-only floors: the `assertPriceEditAllowed(` calls each override-site file makes. */
const ASSERT_FLOORS: Record<string, number> = {
  "orders/orders.service.ts": 4, // create pack, substitute, diff-add, existing-line edit
  "orders/unit-line-build.ts": 1, // a unit line's new override stamp (create + unit-line-edit)
  "orders/replace-all-line-build.ts": 1, // replace-all repriced line + the create auto-merge's new line
  "invoices/invoice-line-override.ts": 1, // invoice line create / edit, pack and unit
};

describe("SA-1034: price-edit capability is checked at every override site", () => {
  const files = sourceFiles(SRC);

  it("decideTierOverride( has exactly 4 callers outside staff-override.ts (a new caller must be reviewed)", () => {
    const found: Record<string, number> = {};
    for (const f of files) {
      if (f === join("orders", "staff-override.ts")) continue;
      const n = callCount(read(f), "decideTierOverride");
      if (n > 0) found[f.split("\\").join("/")] = n;
    }
    expect(Object.values(found).reduce((a, b) => a + b, 0)).toBe(4);
    expect(found).toEqual(DECIDE_TIER_OVERRIDE_CALLERS);
  });

  it.each(Object.entries(ASSERT_FLOORS))(
    "%s keeps at least %i assertPriceEditAllowed( calls (shrink-only floor)",
    (file, floor) => {
      expect(callCount(read(file), "assertPriceEditAllowed")).toBeGreaterThanOrEqual(floor);
    },
  );

  it("assertPriceEditAllowed takes a required boolean (no undefined, no optional parameter)", () => {
    const sig = read("orders/staff-override.ts").match(
      /export function assertPriceEditAllowed\(([^)]*)\)/,
    );
    expect(sig).not.toBeNull();
    const params = sig![1];
    expect(params).toMatch(/^\s*\w+\s*:\s*boolean\s*$/);
    expect(params).not.toMatch(/undefined|\?/);
  });

  it("unit-line-edit threads the capability into both unit-line builders", () => {
    const n = [
      ...code(read("orders/unit-line-edit.ts")).matchAll(
        /priceEditAllowed: ctx\.priceEditAllowed/g,
      ),
    ].length;
    expect(n).toBe(2);
  });

  it('every staffMay(…, "EDIT_LINE_PRICE"…) call passes its deniedGroups argument', () => {
    const bare: string[] = [];
    let total = 0;
    for (const f of files) {
      for (const m of code(read(f)).matchAll(/staffMay\(([^()]*(?:\([^()]*\))?[^()]*)\)/g)) {
        if (!m[1].includes('"EDIT_LINE_PRICE"')) continue;
        total++;
        if (m[1].split(",").length < 3) bare.push(`${f}: staffMay(${m[1]})`);
      }
    }
    expect(bare).toEqual([]);
    expect(total).toBeGreaterThanOrEqual(4); // create, updateOrderItems, the counter sale, invoice lines
  });
});
