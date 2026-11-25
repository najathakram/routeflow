import { isWholeCents } from "@routeflow/pricing";
import { parseMoney, parseQuantity } from "./parse-money";

// T55 (SA-1295 A2 C4): strict cents. Refuses what import/parse-import-number.ts would accept.
describe("parseMoney (T55 strict cents)", () => {
  it.each([
    ["19.99", 19.99],
    ["0.10", 0.1],
    ["1,234.50", 1234.5],
    ["$1,234.50", 1234.5],
    ["-5.25", -5.25],
    ["(12.50)", -12.5],
    ["  7 ", 7],
    ["1,000", 1000],
  ])("reads %s as %s", (raw, value) => {
    expect(parseMoney(raw)).toEqual({ ok: true, value });
  });

  it("refuses more than 2 decimals instead of rounding", () => {
    expect(parseMoney("12.345")).toEqual({ ok: false, reason: "TOO_MANY_DECIMALS" });
    expect(parseMoney("0.001")).toEqual({ ok: false, reason: "TOO_MANY_DECIMALS" });
  });

  it("refuses a trailing sign", () => {
    expect(parseMoney("5-")).toEqual({ ok: false, reason: "TRAILING_SIGN" });
    expect(parseMoney("5.00+")).toEqual({ ok: false, reason: "TRAILING_SIGN" });
  });

  it("refuses an exponent", () => {
    expect(parseMoney("1e3")).toEqual({ ok: false, reason: "EXPONENT" });
    expect(parseMoney("2.5E2")).toEqual({ ok: false, reason: "EXPONENT" });
  });

  it("refuses non-finite and non-numeric text", () => {
    expect(parseMoney("Infinity")).toEqual({ ok: false, reason: "NOT_A_NUMBER" });
    expect(parseMoney("NaN")).toEqual({ ok: false, reason: "NOT_A_NUMBER" });
    expect(parseMoney("12abc")).toEqual({ ok: false, reason: "NOT_A_NUMBER" });
    expect(parseMoney("1,23")).toEqual({ ok: false, reason: "NOT_A_NUMBER" });
    expect(parseMoney("--5")).toEqual({ ok: false, reason: "NOT_A_NUMBER" });
  });

  it("reports blank as EMPTY, never as zero", () => {
    expect(parseMoney("")).toEqual({ ok: false, reason: "EMPTY" });
    expect(parseMoney("   ")).toEqual({ ok: false, reason: "EMPTY" });
  });

  it("applies the whole-cents predicate to a value too large to hold cents", () => {
    expect(parseMoney("90071992547409.93")).toEqual({ ok: false, reason: "NOT_WHOLE_CENTS" });
  });

  it("every value it accepts is whole cents", () => {
    for (const raw of ["0.07", "1.15", "19.99", "1,146.01", "(0.29)"]) {
      const r = parseMoney(raw);
      expect(r.ok && isWholeCents(r.value)).toBe(true);
    }
  });
});

describe("parseQuantity", () => {
  it("reads whole and 4-dp quantities, refuses finer, trailing sign and exponent", () => {
    expect(parseQuantity("3")).toEqual({ ok: true, value: 3 });
    expect(parseQuantity("1,200")).toEqual({ ok: true, value: 1200 });
    expect(parseQuantity("2.5")).toEqual({ ok: true, value: 2.5 });
    expect(parseQuantity("-4")).toEqual({ ok: true, value: -4 });
    expect(parseQuantity("1.00001")).toEqual({ ok: false, reason: "TOO_MANY_DECIMALS" });
    expect(parseQuantity("3-")).toEqual({ ok: false, reason: "TRAILING_SIGN" });
    expect(parseQuantity("1e2")).toEqual({ ok: false, reason: "EXPONENT" });
    expect(parseQuantity("")).toEqual({ ok: false, reason: "EMPTY" });
  });
});
