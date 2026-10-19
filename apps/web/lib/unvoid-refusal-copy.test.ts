import { API_ERROR_CODES, UNVOID_BILLING_COPY } from "@routeflow/types";
import { unvoidRefusalCopy } from "./unvoid-refusal-copy";

const refusal = (data: Record<string, unknown>, status = 409) => ({ response: { status, data } });

describe("unvoidRefusalCopy: SA-814d copy is picked from `reason`, never from the message", () => {
  it.each(["OTHER_INVOICE", "LINE_REDUCED"] as const)("%s", (reason) => {
    expect(
      unvoidRefusalCopy(
        refusal({ code: API_ERROR_CODES.ORDER_BILLING_CHANGED, reason, message: "x" }),
      ),
    ).toBe(UNVOID_BILLING_COPY[reason]);
  });

  it("null for a body with no or an unknown reason, another code, or a non-409 (the caller keeps its message)", () => {
    const code = API_ERROR_CODES.ORDER_BILLING_CHANGED;
    expect(unvoidRefusalCopy(refusal({ code, message: "m" }))).toBeNull();
    expect(unvoidRefusalCopy(refusal({ code, reason: "NOPE" }))).toBeNull();
    expect(unvoidRefusalCopy(refusal({ code, reason: "toString" }))).toBeNull();
    expect(unvoidRefusalCopy(refusal({ code: "OTHER", reason: "OTHER_INVOICE" }))).toBeNull();
    expect(unvoidRefusalCopy(refusal({ code, reason: "OTHER_INVOICE" }, 500))).toBeNull();
    expect(unvoidRefusalCopy(new Error("network"))).toBeNull();
  });
});
