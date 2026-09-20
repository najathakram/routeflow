import { parseCreditLimitError } from "./credit-limit";

const api = (status: number, data: object) => ({ response: { status, data } });

describe("parseCreditLimitError", () => {
  it("returns the server's numbers and sentence for the 409, verbatim", () => {
    expect(
      parseCreditLimitError(
        api(409, { code: "CREDIT_LIMIT_EXCEEDED", limit: 100, exposure: 110, message: "Over." }),
      ),
    ).toEqual({ limit: 100, exposure: 110, message: "Over." });
  });

  it("defaults a missing message and numbers", () => {
    expect(parseCreditLimitError(api(409, { code: "CREDIT_LIMIT_EXCEEDED" }))).toEqual({
      limit: 0,
      exposure: 0,
      message: "This would exceed the customer's credit limit.",
    });
  });

  it("is null for other codes, non-409s and non-axios errors", () => {
    expect(parseCreditLimitError(api(409, { code: "SELLING_RESTRICTED" }))).toBeNull();
    expect(parseCreditLimitError(api(400, { code: "CREDIT_LIMIT_EXCEEDED" }))).toBeNull();
    expect(parseCreditLimitError(new Error("network"))).toBeNull();
    expect(parseCreditLimitError(undefined)).toBeNull();
  });
});
