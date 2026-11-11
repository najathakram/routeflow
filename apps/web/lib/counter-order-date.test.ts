import { counterSaleErrorCopy } from "./counter-sale";
import { isCounterSaleHandledError } from "./counter-sale";
import { isOrderDateRefusalCopy } from "./counter-order-date";

// W-1188: the server's two date refusals map to fixed plain copy; the server's own message is never shown.
const refusal = (status: number, data: Record<string, unknown>) => ({ response: { status, data } });

describe("counter order date refusals", () => {
  it("past: names the earliest day the till takes", () => {
    const err = refusal(400, {
      code: "ORDER_DATE_OUT_OF_RANGE",
      message: "That order date is too far in the past.",
      policy: "COUNTER",
      min: "2024-11-09",
      max: "2027-11-10",
    });
    expect(counterSaleErrorCopy(err, { orderDate: "2024-01-01" })).toBe(
      "That date is more than 2 years back. Pick Nov 9, 2024 or later.",
    );
  });

  it("future: asks to check the year", () => {
    const err = refusal(400, {
      code: "ORDER_DATE_OUT_OF_RANGE",
      min: "2024-11-09",
      max: "2027-11-10",
    });
    expect(counterSaleErrorCopy(err, { orderDate: "2028-01-01" })).toBe(
      "That date is more than a year ahead. Check the year.",
    );
    // without the sent day the till cannot tell which bound it was: it says so without guessing
    expect(counterSaleErrorCopy(err)).toBe(
      "That date is outside the dates this till takes. Pick another day.",
    );
  });

  it("a locked month names the month and the category", () => {
    const err = refusal(409, {
      code: "ORDER_DATE_PERIOD_LOCKED",
      periodKey: "2026-10",
      categoryName: "Tobacco",
    });
    expect(counterSaleErrorCopy(err)).toBe(
      "October 2026 is filed and locked for Tobacco. Pick a date in an open month, or use today.",
    );
  });

  it("a locked month with no category name still reads whole", () => {
    const err = refusal(409, { code: "ORDER_DATE_PERIOD_LOCKED", periodKey: "2026-10" });
    expect(counterSaleErrorCopy(err)).toBe(
      "October 2026 is filed and locked. Pick a date in an open month, or use today.",
    );
  });

  it("the till answers with its own copy (the global toast stays quiet) and the chip can tell", () => {
    expect(isCounterSaleHandledError(refusal(400, { code: "ORDER_DATE_OUT_OF_RANGE" }))).toBe(true);
    expect(isCounterSaleHandledError(refusal(409, { code: "ORDER_DATE_PERIOD_LOCKED" }))).toBe(
      true,
    );
    expect(isOrderDateRefusalCopy("That date is more than a year ahead. Check the year.")).toBe(
      true,
    );
    expect(isOrderDateRefusalCopy("Voided — start a new sale")).toBe(false);
  });
});
