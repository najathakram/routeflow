import { API_ERROR_CODES } from "@routeflow/types";
import { voidFailureDescription, VOID_FALLBACK_COPY } from "./invoice-void-copy";

/** Row 182: the void toast prefers the fixed coded copy, then the server's own sentence, then a generic fallback. */
describe("voidFailureDescription", () => {
  it("a recognised coded refusal reads the fixed copy, not the raw server sentence", () => {
    const err = {
      response: {
        status: 403,
        data: { code: API_ERROR_CODES.READ_ONLY, message: "RAW SERVER TEXT" },
      },
    };
    const out = voidFailureDescription(err);
    expect(out).not.toContain("RAW SERVER TEXT");
    expect(out.length).toBeGreaterThan(10);
  });

  it("an uncoded refusal keeps the server's actionable sentence", () => {
    const msg = "$80.00 in cash/check/card payments — reverse or refund those first";
    expect(voidFailureDescription({ response: { status: 400, data: { message: msg } } })).toBe(msg);
  });

  it("no response at all reads the generic fallback", () => {
    expect(voidFailureDescription(new Error("Network Error"))).toBe(VOID_FALLBACK_COPY);
  });
});
