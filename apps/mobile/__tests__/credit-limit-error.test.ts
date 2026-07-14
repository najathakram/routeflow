import { parseCreditLimitError } from "../lib/credit-limit-error";

describe("parseCreditLimitError", () => {
  it("extracts limit/exposure/message from a 409 CREDIT_LIMIT_EXCEEDED", () => {
    const err = {
      response: {
        status: 409,
        data: {
          code: "CREDIT_LIMIT_EXCEEDED",
          message:
            "This edit would take the customer's exposure to 1200.00, over their credit limit of 1000.00.",
          limit: 1000,
          exposure: 1200,
        },
      },
    };
    expect(parseCreditLimitError(err)).toEqual({
      limit: 1000,
      exposure: 1200,
      message: err.response.data.message,
    });
  });

  it("returns null for a different 409 code", () => {
    const err = { response: { status: 409, data: { code: "REGULATED_AUTH_REQUIRED" } } };
    expect(parseCreditLimitError(err)).toBeNull();
  });

  it("returns null for a non-409 error", () => {
    expect(parseCreditLimitError({ response: { status: 500, data: {} } })).toBeNull();
  });

  it("returns null for a network error with no response", () => {
    expect(parseCreditLimitError(new Error("Network Error"))).toBeNull();
  });

  it("defaults a missing message", () => {
    const err = {
      response: { status: 409, data: { code: "CREDIT_LIMIT_EXCEEDED", limit: 500, exposure: 600 } },
    };
    expect(parseCreditLimitError(err)?.message).toBe(
      "This would exceed the customer's credit limit.",
    );
  });
});
