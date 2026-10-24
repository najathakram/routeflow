/**
 * #2215: a Next App Router `page.tsx` may export only the page contract. Any other named export (helpers, types,
 * components that tests import) makes Next's generated page-type check fail the build whenever the file changes.
 * The order-detail line editor lives in `_components/order-line-edit.tsx`; this pins the page to its default export.
 */
import { readFileSync } from "fs";
import { join } from "path";

describe("orders/[id]/page.tsx exports only the Next page contract (#2215)", () => {
  const src = readFileSync(join(__dirname, "page.tsx"), "utf8");
  const exports = src.match(/^export\s+(?!default\b)[^\n]*/gm) ?? [];

  it("has no named exports", () => {
    expect(exports).toEqual([]);
  });

  it("has exactly one default export", () => {
    expect(src.match(/^export default\b/gm)).toHaveLength(1);
  });
});
