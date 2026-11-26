import * as fs from "fs";
import * as path from "path";
import { parseQuantityExpression, QUANTITY_EXPRESSION_MAX_LENGTH } from "./quantity-expression";

/**
 * SA-1256 typed sums PR 1: the K pins on the reader. `5*2` typed in a quantity box works out to 10.
 * The reader is exact (integer fractions), never rounds under `whole`, and never throws.
 */
const BUILDER = { max: 100_000, whole: true } as const;
const read = (text: string) => parseQuantityExpression(text, BUILDER);
/** The value, or the refusal reason: one string per case, so a wrong value prints in the failure. */
const answer = (text: string): number | string => {
  const r = read(text);
  return r.ok ? r.value : r.reason;
};

describe("parseQuantityExpression", () => {
  describe("K1: works a sum out exactly", () => {
    it.each([
      ["5*2", 10],
      ["5x2", 10],
      ["5×2", 10],
      ["5 * 2", 10],
      ["2+3", 5],
      ["2+3*4", 14],
      ["10-2-3", 5],
      ["12/4/3", 1],
      ["10/3*3", 10],
      ["57/100*100", 57],
      ["1/49*49", 1],
      ["0x10", 0],
      ["(2+3)*4", 20],
      ["2*(3+4)*2", 28],
      ["((7))", 7],
      ["  6*4  ", 24],
      ["12", 12],
      ["007", 7],
      ["5-5", 0],
    ])("%s = %s", (text, expected) => {
      expect(answer(text)).toBe(expected);
    });

    it("a result below zero is returned as it is, for the box to refuse against its own minimum", () => {
      expect(answer("2-5")).toBe(-3);
    });
  });

  describe("K2: under `whole`, a result that is not a whole number is refused, never rounded", () => {
    it.each([
      ["5/2", "not-whole"],
      ["12/5", "not-whole"],
      ["10/4", "not-whole"],
      ["1/3+1/3", "not-whole"],
      ["2.5", "invalid"],
    ])("%s -> %s", (text, expected) => {
      expect(answer(text)).toBe(expected);
    });

    it("without `whole` the same sum gives its exact value", () => {
      expect(parseQuantityExpression("5/2", { max: 100_000, whole: false })).toEqual({
        ok: true,
        value: 2.5,
      });
    });
  });

  describe("K3: refused without throwing", () => {
    it.each([
      ["", "empty"],
      ["   ", "empty"],
      ["abc", "invalid"],
      ["5*", "invalid"],
      ["*5", "invalid"],
      ["5/0", "invalid"],
      ["5/(2-2)", "invalid"],
      ["-3", "invalid"],
      ["+5", "invalid"],
      ["3*-2", "invalid"],
      ["2(3)", "invalid"],
      ["(2)(3)", "invalid"],
      ["5 5", "invalid"],
      ["1e5", "invalid"],
      ["1,000", "invalid"],
      ["2,5", "invalid"],
      ["0b1", "invalid"],
      ["alert(1)", "invalid"],
      ["constructor", "invalid"],
      ["５*２", "invalid"], // full-width digits
      ["5X2", "invalid"],
      ["5÷2", "invalid"],
      ["5**2", "invalid"],
      ["2^3", "invalid"],
      ["5%", "invalid"],
      ["(5", "invalid"],
      ["5)", "invalid"],
      ["()", "invalid"],
      ["12]", "invalid"],
      ["3a", "invalid"],
      ["=5*2", "invalid"],
    ])("%j -> %s", (text, expected) => {
      expect(answer(text)).toBe(expected);
    });

    it("refuses 33 characters and accepts 32", () => {
      expect(QUANTITY_EXPRESSION_MAX_LENGTH).toBe(32);
      const sum32 = "1+".repeat(15) + "10"; // 32 characters, 15 + 10
      expect(sum32).toHaveLength(32);
      expect(answer(sum32)).toBe(25);
      expect(answer(sum32 + "0")).toBe("invalid");
    });

    it("refuses 500 brackets", () => {
      expect(answer("(".repeat(500) + "1" + ")".repeat(500))).toBe("invalid");
    });

    it("refuses a number too long to hold exactly instead of losing digits", () => {
      expect(answer("99999999999999999999")).toBe("too-big");
      expect(answer("99999999999999999999-1")).toBe("too-big");
      expect(answer("99999999*99999999*99999999")).toBe("too-big");
      expect(answer("1/99999999/99999999/99999999")).toBe("too-big");
    });

    it("never throws and never returns NaN or Infinity, whatever the text", () => {
      const texts = [
        "\u0000",
        "💥",
        "1/0/0",
        "((((",
        "))))",
        "9".repeat(32),
        "1/" + "9".repeat(30),
      ];
      for (const text of texts) {
        const r = read(text);
        if (r.ok) expect(Number.isFinite(r.value)).toBe(true);
        else expect(typeof r.reason).toBe("string");
      }
    });
  });

  describe("K4: the cap", () => {
    it("1000*100 passes at exactly the cap", () => {
      expect(answer("1000*100")).toBe(100_000);
    });
    it.each([
      ["1000*101", "too-big"],
      ["100000+1", "too-big"],
      ["999*999", "too-big"],
      ["100001", "too-big"],
    ])("%s -> %s", (text, expected) => {
      expect(answer(text)).toBe(expected);
    });
    it("a step above the cap is fine when the result is within it", () => {
      expect(answer("1000*1000/100")).toBe(10_000);
    });
  });

  it("K5: the reader is hand-written (no eval, Function, Number() or parseFloat in the file)", () => {
    const src = fs.readFileSync(path.join(__dirname, "quantity-expression.ts"), "utf8");
    for (const banned of ["eval(", "Function(", "Number(", "parseFloat"]) {
      expect(src.includes(banned)).toBe(false);
    }
  });
});
