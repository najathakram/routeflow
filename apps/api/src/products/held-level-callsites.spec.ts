import { readFileSync, readdirSync } from "fs";
import { join, relative, sep } from "path";

/**
 * SA-1044 (B11a) rule 6. A held line's unit level is re-priced from the LIVE ladder only through
 * `resolveUnitPrice`, and every caller must first ask `heldLevelState` whether the held level is
 * gone or resized (a gone/resized line keeps its snapshot; it is never re-resolved). So:
 *
 *  - the non-spec api files that call `resolveUnitPrice(` are EXACTLY the set below, and each one
 *    also calls `heldLevelState(` — a new caller fails the build until it judges the held level;
 *  - the web files that call `useProductUnits(` (the ladder readers behind the Sell-by picker) are
 *    EXACTLY the set below — a new picker must offer the held snapshot option too.
 *
 * Both sets are shrink-only: removing a caller means deleting its entry here.
 */
const API_RESOLVE_CALLERS = ["invoices/invoice-line-override.ts", "orders/unit-line-build.ts"];

const WEB_LADDER_READERS = [
  "app/(dashboard)/invoices/new/page.tsx",
  // SA-828: a stock count's unit rows. It holds no sale line, so there is no held level to offer.
  "app/(dashboard)/products/[id]/CountAdjustModal.tsx",
  "app/(dashboard)/products/[id]/ProductUnitsCard.tsx",
  "app/(dashboard)/products/[id]/units-v2/structure/UnitsBesideGrid.tsx",
  "components/OrderLineUnitPicker.tsx",
  "lib/api/product-units.ts",
];

const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
// A fresh regex per use: a shared /g regex is stateful under .test().
const calls = (text: string, fn: string) =>
  new RegExp(`\\b${fn}\\s*(?:<[^>]*>)?\\(`).test(strip(text));

const walk = (dir: string, exts: string[]): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) {
      return e.name === "node_modules" || e.name.startsWith(".") || e.name === "__tests__"
        ? []
        : walk(join(dir, e.name), exts);
    }
    const isTest = /\.(spec|test)\.tsx?$/.test(e.name);
    return !isTest && exts.some((x) => e.name.endsWith(x)) ? [join(dir, e.name)] : [];
  });

const callers = (root: string, exts: string[], fn: string) =>
  walk(root, exts)
    .filter((f) => calls(readFileSync(f, "utf8"), fn))
    .map((f) => relative(root, f).split(sep).join("/"))
    .sort();

const API_ROOT = join(__dirname, "..");
const WEB_ROOT = join(__dirname, "..", "..", "..", "web");

describe("held-level call-site pin (SA-1044 rule 6)", () => {
  it("the scanner sees calls and ignores comments (a regex that matches nothing would pass vacuously)", () => {
    expect(calls("const p = resolveUnitPrice(a, b);", "resolveUnitPrice")).toBe(true);
    expect(calls("useProductUnits<Foo>(id)", "useProductUnits")).toBe(true);
    expect(calls("// resolveUnitPrice(a)\n/* resolveUnitPrice(b) */", "resolveUnitPrice")).toBe(
      false,
    );
    expect(calls("import { resolveUnitPrice } from 'x';", "resolveUnitPrice")).toBe(false);
    expect(calls("myResolveUnitPrice(a)", "resolveUnitPrice")).toBe(false);
  });

  it("only the pinned api files call resolveUnitPrice(", () => {
    expect(callers(API_ROOT, [".ts"], "resolveUnitPrice")).toEqual(API_RESOLVE_CALLERS);
  });

  it.each(API_RESOLVE_CALLERS)("%s judges the held level with heldLevelState(", (rel) => {
    expect(calls(readFileSync(join(API_ROOT, rel), "utf8"), "heldLevelState")).toBe(true);
  });

  it("only the pinned web files call useProductUnits(", () => {
    expect(callers(WEB_ROOT, [".ts", ".tsx"], "useProductUnits")).toEqual(WEB_LADDER_READERS);
  });
});
