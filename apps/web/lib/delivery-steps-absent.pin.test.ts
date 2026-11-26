import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * W-1306 inventory pin (SA-1277, class-not-instance): "a delivery step hidden with no reason" is decided in ONE
 * place, `deliveryStepsAbsentReason` / `isPosOrder` in packages/types. A new ad-hoc copy of the POS predicate in
 * web or mobile fails here; the fix is to call the helper, not to add a row.
 */
const ROOT = resolve(__dirname, "../../..");
const SKIP = new Set(["node_modules", ".next", "dist", "coverage", ".expo", "e2e"]);

function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.(test|spec)\.tsx?$/.test(name)) out.push(p);
  }
  return out;
}

const files = [...sources(join(ROOT, "apps/web")), ...sources(join(ROOT, "apps/mobile"))];

describe("one POS / delivery-steps predicate (W-1306)", () => {
  it("scans a real file set", () => {
    expect(files.length).toBeGreaterThan(200);
  });
  it("no app declares its own isPosOrder", () => {
    const own = files.filter((f) =>
      /function\s+isPosOrder\b|const\s+isPosOrder\s*=/.test(readFileSync(f, "utf8")),
    );
    expect(own).toEqual([]);
  });
  it("no app re-derives PICKUP-and-not-a-counter-sale by hand", () => {
    const adhoc = files.filter((f) => {
      const src = readFileSync(f, "utf8");
      return /fulfillPath\s*===\s*"PICKUP"\s*&&\s*[\w.?]*counterSale\s*!==\s*true/.test(src);
    });
    expect(adhoc).toEqual([]);
  });
});
