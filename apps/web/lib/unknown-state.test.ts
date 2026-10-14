import { headerLine } from "./unknown-state";

const OFF_TAIL =
  "Until it's set, products with a legal state ban stay hidden from them in your portal and can't be ordered there. Other state limits won't reach them. Staff orders aren't checked (turn on 'Also block restricted products on staff orders and invoices' to block them).";
const ON_TAIL =
  "Until it's set, products with a legal state ban stay hidden from them in your portal, and they can't be sold those products on any order. Other state limits won't reach them.";

describe("headerLine (M5)", () => {
  it("switch off: says staff orders are not checked", () => {
    const line = headerLine(5, false, false);
    expect(line).toBe(`5 customers need a state. ${OFF_TAIL}`);
    expect(line).not.toMatch(/can still order/);
  });

  it("switch on: says the products cannot be sold on any order", () => {
    expect(headerLine(5, false, true)).toBe(`5 customers need a state. ${ON_TAIL}`);
  });

  it("singular keeps its grammar in both states", () => {
    expect(headerLine(1, false, false)).toBe(`1 customer needs a state. ${OFF_TAIL}`);
    expect(headerLine(1, false, true)).toBe(`1 customer needs a state. ${ON_TAIL}`);
  });

  it("truncated: same switch-aware second part", () => {
    const lead =
      "Your customer list is too large to check all at once, so some customers may still need a state.";
    expect(headerLine(5, true, false)).toBe(`${lead} ${OFF_TAIL}`);
    expect(headerLine(5, true, true)).toBe(`${lead} ${ON_TAIL}`);
  });

  it("all clear", () => {
    expect(headerLine(0, false, false)).toBe("Every customer has a state on file.");
  });
});
