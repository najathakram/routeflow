import { readFileSync } from "fs";
import { join } from "path";

/**
 * Row 330b (owner ruling): staff product screens show the real count ("0 in stock", amber), never a red "Out of
 * Stock" badge, and the product stays sellable. The buyer portal keeps its own availability copy.
 */
const FILES = [
  "_components/product-status.tsx",
  "[id]/ProductStockCostCard.tsx",
  "[id]/page.tsx",
  "page.tsx",
];

describe("staff stock badge shows the count (row 330b)", () => {
  it.each(FILES)(
    "%s has no 'Out of Stock' badge label and no danger tone on an empty product",
    (f) => {
      const src = readFileSync(join(__dirname, f), "utf8");
      expect(src).not.toMatch(/label="Out of Stock"/);
      expect(src).not.toMatch(/OUT_OF_STOCK"[^\n]*danger/);
    },
  );
});
