import * as fs from "fs";
import * as path from "path";

/**
 * B1373 (class, not instance): the counter and Create Order list products through the ONE `ProductSearchList`.
 * Red if either screen grows its own product listbox again (a mirror drifts: the counter's flat list did).
 */
const read = (f: string) => fs.readFileSync(path.join(__dirname, f), "utf8");

describe("one product type-ahead list", () => {
  it.each(["CreateOrderModal.tsx", "CounterLiveMatches.tsx"])(
    "%s renders ProductSearchList",
    (f) => {
      const src = read(f);
      expect(src).toMatch(/from "@\/components\/ProductSearchList"/);
      expect(src).toMatch(/<ProductSearchList\b/);
    },
  );

  it.each(["CreateOrderModal.tsx", "CounterLiveMatches.tsx", "CounterSaleScreen.tsx"])(
    "%s draws no product listbox of its own",
    (f) => {
      const src = read(f);
      // the only inline listboxes left are the customer pickers
      const productListboxes = src.match(
        /role="listbox"[\s\S]{0,120}aria-label="(Products|Matching items)"/g,
      );
      expect(productListboxes).toBeNull();
    },
  );
});
