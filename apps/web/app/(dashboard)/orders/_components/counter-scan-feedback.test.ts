import { addedCopy, noProductCopy, SCAN_ECHO_MAX } from "./counter-scan-feedback";

describe("counter-scan-feedback (F05 copy)", () => {
  it("names the rejected text", () => {
    expect(noProductCopy("123ABC")).toBe("No product for '123ABC'");
  });
  it("collapses whitespace and strips control characters", () => {
    expect(noProductCopy("  12\t3\u0000 ABC \n")).toBe("No product for '12 3 ABC'");
  });
  it("shortens a long text with an ellipsis", () => {
    const out = noProductCopy("9".repeat(SCAN_ECHO_MAX + 10));
    expect(out).toBe(`No product for '${"9".repeat(SCAN_ECHO_MAX)}…'`);
  });
  it("never echoes markup as anything but text (it is plain text copy)", () => {
    expect(noProductCopy("<b>x</b>")).toBe("No product for '<b>x</b>'");
  });
  it("confirms an add by product name", () => {
    expect(addedCopy("Corn Chips")).toBe("Added Corn Chips");
  });
  it("falls back to 'item' when the product has no name", () => {
    expect(addedCopy("")).toBe("Added item");
  });
});
