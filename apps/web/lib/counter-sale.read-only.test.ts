import { READ_ONLY_SENTENCE } from "@routeflow/types/read-only-copy";
import { counterSaleErrorCopy, isDefinitiveCounterSaleRefusal } from "./counter-sale";

/**
 * A READ_ONLY workspace refuses the sale with a 403 whose code is READ_ONLY. That 403 must read as the read-only line,
 * never the generic "you don't have permission" (the 401 / 403 branch used to win). It is still a DEFINITIVE refusal:
 * the guard rejects before the handler runs, so nothing was written and the cart stays.
 */
const LINE = READ_ONLY_SENTENCE; // SA-776: the one shared owner's sentence
const readOnly403 = {
  response: { status: 403, data: { code: "READ_ONLY", message: "RAW GUARD TEXT" } },
};

describe("counterSaleErrorCopy: READ_ONLY", () => {
  it("a 403 READ_ONLY says the read-only line, not the permission copy, and never the server text", () => {
    const copy = counterSaleErrorCopy(readOnly403);
    expect(copy).toBe(LINE);
    expect(copy).not.toMatch(/permission|RAW GUARD TEXT/);
  });

  it("a 403 READ_ONLY is a definitive refusal (nothing was written)", () => {
    expect(isDefinitiveCounterSaleRefusal(readOnly403)).toBe(true);
  });

  it("a code-less 403 and a 401 keep the permission copy", () => {
    const permission = "You don't have permission to complete a counter sale.";
    expect(counterSaleErrorCopy({ response: { status: 403 } })).toBe(permission);
    expect(counterSaleErrorCopy({ response: { status: 401 } })).toBe(permission);
  });
});
