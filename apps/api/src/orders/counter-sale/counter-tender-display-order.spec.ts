import { readFileSync } from "fs";
import { join } from "path";
import { COUNTER_TENDER_DISPLAY_ORDER } from "@routeflow/pricing";

/**
 * (B) ONE list of the tender methods' display order, in pricing (the API cannot value-import @routeflow/types and the web
 * imports pricing): Today's sales and the receipt document import it, none keeps a second list. This pins the imports, so
 * a copy cannot creep back; the behaviour (order of the rows) is pinned in counter-sale-today.pure.spec.ts and
 * documents/render-order-receipt.spec.ts.
 */
const read = (rel: string) => readFileSync(join(__dirname, "..", "..", rel), "utf8");

describe("COUNTER_TENDER_DISPLAY_ORDER: one list (non-cash first, CASH last)", () => {
  it("is non-cash methods first and CASH last", () => {
    expect(COUNTER_TENDER_DISPLAY_ORDER[COUNTER_TENDER_DISPLAY_ORDER.length - 1]).toBe("CASH");
    expect(COUNTER_TENDER_DISPLAY_ORDER.indexOf("CARD")).toBeLessThan(
      COUNTER_TENDER_DISPLAY_ORDER.indexOf("CASH"),
    );
  });

  it.each(["orders/counter-sale/counter-sale-today.ts", "documents/receipt-model.ts"])(
    "%s imports it from @routeflow/pricing and declares no list of its own",
    (file) => {
      const src = read(file);
      expect(src).toMatch(/COUNTER_TENDER_DISPLAY_ORDER[\s\S]*from "@routeflow\/pricing"/);
      expect(src).not.toMatch(/\[\s*"CASH"\s*,\s*"CARD"/);
    },
  );
});
