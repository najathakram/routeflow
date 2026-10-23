import { readFileSync } from "fs";
import { join } from "path";
import { RETIRED_COSTING_METHODS, SELECTABLE_COSTING_METHODS } from "@routeflow/types";

/**
 * SA-804 (1) / B1232 (c): no web picker may offer a retired costing method. The product-create picker is
 * rendered in ProductCreateModal.test.tsx; the tenant Costing tab lives in the settings page (too heavy to
 * mount here), so this pins its option list by source. A new picker must be added to PICKER_FILES.
 */
const WEB_ROOT = join(__dirname, "..");
const PICKER_FILES = ["components/ProductCreateModal.tsx", "app/(dashboard)/settings/page.tsx"];

describe("costing pickers offer no retired method", () => {
  it("the shared lists are disjoint and the retired pair is FIFO + LIFO", () => {
    expect([...RETIRED_COSTING_METHODS]).toEqual(["FIFO", "LIFO"]);
    for (const m of RETIRED_COSTING_METHODS) {
      expect((SELECTABLE_COSTING_METHODS as readonly string[]).includes(m)).toBe(false);
    }
  });

  it.each(PICKER_FILES)("%s has no FIFO/LIFO option", (rel) => {
    const src = readFileSync(join(WEB_ROOT, rel), "utf8");
    for (const m of RETIRED_COSTING_METHODS) {
      expect(src).not.toMatch(new RegExp(`value=["']${m}["']`));
      expect(src).not.toMatch(new RegExp(`value:\s*["']${m}["']`));
    }
  });
});
