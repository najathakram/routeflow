import { sanitizeMoneyInput, parseMoney } from "../lib/money-input";

/**
 * Locks the never-reformat-while-typing sanitizer: intermediate drafts like
 * "2." must survive verbatim — the old inputs re-derived text from the parsed
 * number, turning "type 2 . 5 0" into 2.05.
 */
describe("sanitizeMoneyInput", () => {
  it("preserves intermediate drafts", () => {
    expect(sanitizeMoneyInput("2.")).toBe("2.");
    expect(sanitizeMoneyInput("")).toBe("");
    expect(sanitizeMoneyInput("0.0")).toBe("0.0");
  });

  it("the reported sequence: 2 → 2. → 2.5 → 2.50 stays literal", () => {
    expect(sanitizeMoneyInput("2")).toBe("2");
    expect(sanitizeMoneyInput("2.")).toBe("2.");
    expect(sanitizeMoneyInput("2.5")).toBe("2.5");
    expect(sanitizeMoneyInput("2.50")).toBe("2.50");
  });

  it("clamps decimal places", () => {
    expect(sanitizeMoneyInput("2.555")).toBe("2.55");
    expect(sanitizeMoneyInput("2.5", 0)).toBe("25"); // no dot allowed at 0 decimals
    expect(sanitizeMoneyInput("1.2345", 3)).toBe("1.234");
  });

  it("normalizes commas and a leading dot", () => {
    expect(sanitizeMoneyInput("2,5")).toBe("2.5");
    expect(sanitizeMoneyInput(".5")).toBe("0.5");
    expect(sanitizeMoneyInput(".")).toBe("0.");
  });

  it("strips junk and collapses extra dots", () => {
    expect(sanitizeMoneyInput("abc2x")).toBe("2");
    expect(sanitizeMoneyInput("$12.50")).toBe("12.50");
    expect(sanitizeMoneyInput("1.2.3")).toBe("1.23");
    expect(sanitizeMoneyInput("-3")).toBe("3"); // money fields are non-negative
  });
});

describe("parseMoney", () => {
  it("empty → null (a cleared field is 'no value', never 0/NaN)", () => {
    expect(parseMoney("")).toBeNull();
    expect(parseMoney("   ")).toBeNull();
  });

  it("parses drafts, including trailing-dot intermediates", () => {
    expect(parseMoney("2.")).toBe(2);
    expect(parseMoney("2.50")).toBe(2.5);
    expect(parseMoney("0.")).toBe(0);
  });
});
