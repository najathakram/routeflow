import { readyNoticeOf } from "./ready-for-pickup.notice";

/** W-1043 (SA-1062 MUST 18-19): the messaging outcomes folded into the one notice. */
describe("readyNoticeOf", () => {
  const ok = { email: "buyer@acme.test", orderStatusEmails: true };
  const email = (o: Record<string, unknown>) => [{ channel: "EMAIL", ...o }] as never;

  it("an EMAIL send is SENT with the address", () => {
    expect(readyNoticeOf(email({ outcome: "sent" }), ok)).toEqual({
      notice: "SENT",
      email: "buyer@acme.test",
    });
  });
  it("another channel sending alone is not an email: OFF", () => {
    expect(readyNoticeOf([{ channel: "PORTAL", outcome: "sent" }] as never, ok)).toEqual({
      notice: "OFF",
    });
  });
  it("an import placeholder address is no email on file", () => {
    expect(
      readyNoticeOf(email({ outcome: "skipped", reason: "NO_CONTACT" }), {
        email: "x@placeholder.local",
        orderStatusEmails: true,
      }),
    ).toEqual({ notice: "NO_EMAIL" });
  });
  it.each(["NO_TRANSPORT", "NO_CUSTOMER", "INVOICE_POLICY"])(
    "an email skipped for %s did not go: FAILED",
    (reason) => {
      expect(readyNoticeOf(email({ outcome: "skipped", reason }), ok)).toEqual({
        notice: "FAILED",
      });
    },
  );
});
