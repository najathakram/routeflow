import { headerLine } from "./unknown-state";

describe("headerLine (M5)", () => {
  it("says what a missing state does, never that customers can still order", () => {
    const line = headerLine(5);
    expect(line).toBe(
      "5 customers need a state. Until it's set, products with a legal state ban stay hidden from them and can't be sold to them, and other state limits won't reach them.",
    );
    expect(line).not.toMatch(/can still order/);
  });

  it("singular and all-clear forms", () => {
    expect(headerLine(1)).toMatch(/^1 customer needs a state\./);
    expect(headerLine(0)).toBe("Every customer has a state on file.");
  });
});
