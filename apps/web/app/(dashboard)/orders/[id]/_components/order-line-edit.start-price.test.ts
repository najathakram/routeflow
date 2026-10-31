import { addedLineStartPrice } from "./order-line-edit";

/** B14 (SA-1072): a line added during an edit. List 10, Retail base 10 unless the row says otherwise. */
describe("addedLineStartPrice", () => {
  it("a tier price remembered from a SPECIAL line doesn't start the line", () => {
    expect(addedLineStartPrice({ lastPrice: 12, stickyPrice: null }, 10, 10, false)).toBe(10);
  });

  it("guard: a real upsell starts the line", () => {
    expect(addedLineStartPrice({ lastPrice: 12, stickyPrice: 12 }, 10, 10, false)).toBe(12);
  });

  it("guard: a discount below the base starts the line, whatever its type", () => {
    expect(addedLineStartPrice({ lastPrice: 7, stickyPrice: null }, 8, 10, false)).toBe(7);
  });

  it("guard: a contracted tier beats the memory", () => {
    expect(addedLineStartPrice({ lastPrice: 12, stickyPrice: 12 }, 8, 10, true)).toBe(8);
  });

  it("guard: no history keeps the base", () => {
    expect(addedLineStartPrice(undefined, 8, 10, false)).toBe(8);
  });
});
