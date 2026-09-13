/**
 * REG-B305: the driver run/stop payload must project the order's subtotal/tax/total
 * so the mobile app can quote and collect the tax-inclusive amount due, not just the
 * pre-tax line subtotal (`RUN_LINE_ITEMS_SELECT` has no tax field at all). Today
 * `RUN_STOP_INCLUDE` is a module-internal `const` in `routes.service.ts` (not
 * exported) — this import is red until the fix exports it.
 */
import { RUN_LINE_ITEMS_SELECT, RUN_STOP_INCLUDE } from "./routes.service";

describe("REG-B305 driver run/stop order projection", () => {
  it("REG-B305 the driver run/stop payload projects the order's subtotal, tax and total", () => {
    expect(RUN_STOP_INCLUDE.orders.select).toEqual(
      expect.objectContaining({ subtotal: true, tax: true, total: true }),
    );
    expect(RUN_STOP_INCLUDE.orders.select.lineItems).toEqual({
      select: RUN_LINE_ITEMS_SELECT,
    });
  });
});
