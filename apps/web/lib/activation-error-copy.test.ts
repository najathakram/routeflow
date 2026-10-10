import { API_ERROR_CODES } from "@routeflow/types";
import { activationEndedSentence, activationErrorText } from "./activation-error-copy";
import { codedToastCopy } from "./generic-toast-copy";

const RAW = "secret internal detail: row 42 violates fk_x";
const ended = (data: Record<string, unknown> = {}) => ({
  response: {
    status: 409,
    data: { code: API_ERROR_CODES.ACTIVATION_PERIOD_ALREADY_ENDED, message: RAW, ...data },
  },
});
const FULL = { invoiceNumber: "RF-2026-0042", endedOn: "2026-10-01", minDays: 41 };

describe("activationEndedSentence: ACTIVATION_PERIOD_ALREADY_ENDED copy built from the body fields", () => {
  it("names the open invoice, the date the window ended and the minimum days", () => {
    expect(activationEndedSentence(FULL)).toBe(
      "Invoice RF-2026-0042 is still open and this payment's window ended on 2026-10-01. Mark it paid or void it in RouteFlow invoices, or activate for at least 41 days.",
    );
  });

  it("says 1 day, not 1 days", () => {
    expect(activationEndedSentence({ ...FULL, minDays: 1 })).toContain("at least 1 day.");
  });

  it.each([
    [{}, "An invoice is still open and this payment's window has already ended."],
    [
      { endedOn: "2026-10-01" },
      "An invoice is still open and this payment's window ended on 2026-10-01.",
    ],
    [
      { invoiceNumber: "RF-2026-0042" },
      "Invoice RF-2026-0042 is still open and this payment's window has already ended.",
    ],
  ])("tolerates missing fields: %j", (body, lead) => {
    expect(activationEndedSentence(body)).toBe(
      `${lead} Mark it paid or void it in RouteFlow invoices, or activate for more days.`,
    );
  });

  it("ignores malformed fields instead of rendering them", () => {
    const text = activationEndedSentence({
      invoiceNumber: "<script>alert(1)</script>",
      endedOn: "yesterday",
      minDays: -3,
    });
    expect(text).not.toContain("script");
    expect(text).not.toContain("yesterday");
    expect(text).not.toContain("-3");
    expect(text).toContain("activate for more days");
  });
});

describe("activationErrorText: the manual activation error line", () => {
  it("maps the coded 409 and never shows the raw server message", () => {
    expect(activationErrorText(ended(FULL))).toBe(activationEndedSentence(FULL));
    expect(activationErrorText(ended(FULL))).not.toContain(RAW);
  });

  it("a coded 409 with no usable fields still gets the fallback sentence", () => {
    expect(activationErrorText(ended())).toContain("activate for more days");
  });

  it("any other failure keeps today's behaviour: the server message, else 'Activation failed'", () => {
    expect(activationErrorText({ response: { status: 400, data: { message: "Bad plan" } } })).toBe(
      "Bad plan",
    );
    expect(activationErrorText(new Error("network"))).toBe("Activation failed");
  });
});

describe("codedToastCopy maps the same code for the generic mutation toast", () => {
  it("uses the fixed sentence built from the body fields", () => {
    expect(codedToastCopy(ended(FULL))).toBe(activationEndedSentence(FULL));
  });
});
