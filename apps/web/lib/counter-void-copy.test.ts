import { API_ERROR_CODES } from "@routeflow/types";
import {
  COUNTER_VOID_ERROR_CODES,
  COUNTER_VOID_ERROR_COPY,
  cleanVoidReason,
  handBackLines,
  voidReasonProblem,
} from "./counter-void-copy";
import { counterVoidErrorCopy } from "./counter-void-error";
import { codedToastCopy } from "./generic-toast-copy";

const err = (status: number, code?: string) => ({
  response: { status, data: { code, message: "RAW SERVER TEXT" } },
});

describe("counter void copy (SA-762r)", () => {
  it("every code in the closed set has its own sentence, and none is the server's", () => {
    for (const code of COUNTER_VOID_ERROR_CODES) {
      expect(counterVoidErrorCopy(err(409, code))).toBe(COUNTER_VOID_ERROR_COPY[code]);
      expect(counterVoidErrorCopy(err(409, code))).not.toMatch(/RAW SERVER TEXT/);
    }
    expect(new Set(COUNTER_VOID_ERROR_CODES).size).toBe(9);
  });

  it("the four void-only codes are in the app-wide coded copy map too (same sentences)", () => {
    for (const code of [
      API_ERROR_CODES.COUNTER_SALE_VOID_HAS_RETURN,
      API_ERROR_CODES.COUNTER_SALE_VOID_FOREIGN_PAYMENT,
      API_ERROR_CODES.COUNTER_SALE_VOID_NOT_TODAY,
      API_ERROR_CODES.COUNTER_SALE_VOID_BUSY,
    ]) {
      expect(codedToastCopy(err(409, code))).toBe(COUNTER_VOID_ERROR_COPY[code]);
    }
  });

  it("an unknown code or no response falls to the generic fixed copy", () => {
    expect(counterVoidErrorCopy(err(500, "NEW_THING"))).not.toMatch(/RAW SERVER TEXT/);
    expect(counterVoidErrorCopy(new Error("boom"))).toBe("Something went wrong. Please try again.");
  });

  it("the reason is 3-200 characters after control characters are stripped and the ends trimmed", () => {
    expect(voidReasonProblem("")).not.toBeNull();
    expect(voidReasonProblem("  ab \n")).not.toBeNull();
    expect(voidReasonProblem("abc")).toBeNull();
    expect(voidReasonProblem(`  ${"x".repeat(200)} `)).toBeNull();
    expect(voidReasonProblem("x".repeat(201))).not.toBeNull();
    expect(cleanVoidReason(" a\u0000b\tc ")).toBe("abc");
  });

  it("the hand-back reads the server's amounts: cash, then the card terminal line; absent methods print nothing", () => {
    expect(handBackLines({ CASH: 12.5, CARD: 10 }).join(" · ")).toBe(
      "Give back $12.50 cash · Void the card payment on the card terminal",
    );
    expect(handBackLines({ CASH: 0 })).toEqual([]);
    expect(handBackLines(null)).toEqual([]);
    expect(handBackLines({ CHECK: 5 })).toEqual(["Return the $5.00 check to the customer"]);
  });
});
