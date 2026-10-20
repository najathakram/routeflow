import { countErrorText } from "../lib/product-count-error";

const err = (data: unknown) => ({ response: { data } });

describe("countErrorText", () => {
  it("fractional pack gets the fixed copy", () => {
    expect(countErrorText(err({ code: "COUNT_FRACTIONAL_PACK", message: "raw" }))).toBe(
      "Use a whole number, or switch to pcs.",
    );
  });
  it("a filed period shows the server sentence", () => {
    expect(
      countErrorText(err({ code: "STOCK_DATE_IN_FILED_PERIOD", message: "Q3 2026 is filed." })),
    ).toBe("Q3 2026 is filed.");
  });
  it("anything else is the generic line, never the raw message", () => {
    const generic = "Couldn't save the count. Try again.";
    expect(countErrorText(err({ code: "OTHER", message: "boom" }))).toBe(generic);
    expect(countErrorText(err({ message: "boom" }))).toBe(generic);
    expect(countErrorText(new Error("network"))).toBe(generic);
    expect(countErrorText(null)).toBe(generic);
  });
});
