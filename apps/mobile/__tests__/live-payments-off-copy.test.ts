import { API_ERROR_CODES } from "@routeflow/types";
import { LIVE_PAYMENTS_OFF_COPY, livePaymentsOffCopy } from "../lib/live-payments-off-copy";

/** SA-1547 M1 (mobile mirror of web's generic-toast-copy): fixed copy by code, never the server message. */
describe("livePaymentsOffCopy", () => {
  const err = (code: string) => ({ response: { status: 409, data: { code, message: "raw" } } });

  it("maps the wall's code to the test-business sentence", () => {
    expect(LIVE_PAYMENTS_OFF_COPY).toBe("This is a test business. Payments are switched off.");
    expect(livePaymentsOffCopy(err(API_ERROR_CODES.LIVE_PAYMENTS_OFF))).toBe(
      LIVE_PAYMENTS_OFF_COPY,
    );
  });

  it("returns null for any other code or shape", () => {
    expect(livePaymentsOffCopy(err("SOMETHING_ELSE"))).toBeNull();
    expect(livePaymentsOffCopy(null)).toBeNull();
    expect(livePaymentsOffCopy(new Error("x"))).toBeNull();
  });
});
