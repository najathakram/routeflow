import { genericToastCopy } from "./generic-toast-copy";

/**
 * Row 563: a backdated purchase or adjustment on the inventory page (QuickRestock / Adjust Stock, "Backdate") into a filed
 * period is refused with 409 STOCK_DATE_IN_FILED_PERIOD. Those forms have no error handler of their own, so the global
 * mutation toast must name the period and the next step (fixed copy from the structured `period`), not a generic 409.
 */
it("the filed-period refusal names the period and the next step (fixed copy, B986)", () => {
  const message =
    "This date is on or before September 30, 2026, which is already filed (September 2026). Use a date after September 30, 2026.";
  const err = {
    response: {
      status: 409,
      data: { code: "STOCK_DATE_IN_FILED_PERIOD", message, period: "September 2026" },
    },
  };
  expect(genericToastCopy(err)).toBe(
    "September 2026 is already filed for this product, so stock can't be dated on or before it. Choose a later date.",
  );
});
