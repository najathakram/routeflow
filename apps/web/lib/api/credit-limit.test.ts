import { parseCreditLimitError } from "./credit-limit";

const api = (status: number, data: object) => ({ response: { status, data } });

describe("parseCreditLimitError", () => {
  it("returns the server's numbers and a FIXED sentence built from them, never the server message (B986)", () => {
    expect(
      parseCreditLimitError(
        api(409, {
          code: "CREDIT_LIMIT_EXCEEDED",
          limit: 100,
          exposure: 110.5,
          message: "secret server sentence",
        }),
      ),
    ).toEqual({
      limit: 100,
      exposure: 110.5,
      message:
        "This would put the customer's balance at $110.50, over their $100.00 credit limit. Collect a payment to bring it under the limit, or cancel the change.",
    });
  });

  it("without usable numbers the sentence is still fixed and says what to do", () => {
    const out = parseCreditLimitError(api(409, { code: "CREDIT_LIMIT_EXCEEDED", limit: "x" }));
    expect(out).toEqual({
      limit: 0,
      exposure: 0,
      message:
        "This would exceed the customer's credit limit. Collect a payment to bring them under it, or cancel the change.",
    });
  });

  it("is null for other codes, non-409s and non-axios errors", () => {
    expect(parseCreditLimitError(api(409, { code: "SELLING_RESTRICTED" }))).toBeNull();
    expect(parseCreditLimitError(api(400, { code: "CREDIT_LIMIT_EXCEEDED" }))).toBeNull();
    expect(parseCreditLimitError(new Error("network"))).toBeNull();
    expect(parseCreditLimitError(undefined)).toBeNull();
  });
});
