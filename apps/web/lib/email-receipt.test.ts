import { API_ERROR_CODES } from "@routeflow/types";
import {
  RECEIPT_EMAIL_COPY,
  isFinalReceiptEmailPhase,
  isValidReceiptEmail,
  receiptEmailFailureOf,
  receiptEmailPrefill,
} from "./email-receipt";

/** SA-751r: the pure rules of the Email receipt control. Placeholders only (acme / example.com). */
describe("RECEIPT_EMAIL_COPY (the UX brief's words, exactly)", () => {
  it("is the signed copy", () => {
    expect(RECEIPT_EMAIL_COPY.button).toBe("Email receipt");
    expect(RECEIPT_EMAIL_COPY.placeholder).toBe("name@example.com");
    expect(RECEIPT_EMAIL_COPY.invalid).toBe("Check the email address.");
    expect(RECEIPT_EMAIL_COPY.sending).toBe("Sending…");
    expect(RECEIPT_EMAIL_COPY.sendAgain).toBe("Send again");
    expect(RECEIPT_EMAIL_COPY.tryAgain).toBe("Try again");
    expect(RECEIPT_EMAIL_COPY.sent("a@b.co")).toBe("Sent to a@b.co.");
    expect(RECEIPT_EMAIL_COPY.failed).toBe("Couldn't send. Try again.");
    expect(RECEIPT_EMAIL_COPY.orderLimit).toBe("This receipt reached its email limit.");
    expect(RECEIPT_EMAIL_COPY.dayLimit).toBe("Today's email limit is reached. Print instead.");
    expect(RECEIPT_EMAIL_COPY.unavailable).toBe("This sale can't be emailed any more.");
    expect(RECEIPT_EMAIL_COPY.offline).toBe(
      "You're offline. Print it, or send it later from Today's sales.",
    );
  });
});

describe("isValidReceiptEmail", () => {
  it.each(["name@example.com", "first.last+tag@sub.example.co.uk", "  padded@example.com  "])(
    "accepts %j",
    (s) => expect(isValidReceiptEmail(s)).toBe(true),
  );
  it.each([
    "",
    "   ",
    "name",
    "name@",
    "@example.com",
    "name@example",
    "name@example.c",
    "na me@example.com",
    "Name <name@example.com>",
    "a@b@example.com",
    "name@example..com",
    ".name@example.com",
    "name.@example.com",
    "name@-example.com",
    `${"a".repeat(250)}@example.com`,
  ])("refuses %j", (s) => {
    expect(isValidReceiptEmail(s)).toBe(false);
  });
});

describe("receiptEmailPrefill", () => {
  it("a named customer's address is the suggestion", () => {
    expect(receiptEmailPrefill({ email: " buyer@example.com ", isWalkIn: false })).toBe(
      "buyer@example.com",
    );
  });
  it("a walk-in, no customer, no email and an internal placeholder address all open empty", () => {
    expect(receiptEmailPrefill(null)).toBe("");
    expect(receiptEmailPrefill(undefined)).toBe("");
    expect(receiptEmailPrefill({ email: "x@example.com", isWalkIn: true })).toBe("");
    expect(receiptEmailPrefill({ email: null })).toBe("");
    expect(receiptEmailPrefill({ email: "no-email+1@placeholder.local" })).toBe("");
    expect(receiptEmailPrefill({ email: "u@imported.local" })).toBe("");
  });
});

describe("receiptEmailFailureOf (an error is told by its code, never its text)", () => {
  const err = (code?: string, message = "RAW SERVER TEXT") => ({
    response: { status: 429, data: { code, message } },
  });
  it("maps the two limit codes", () => {
    expect(receiptEmailFailureOf(err(API_ERROR_CODES.RECEIPT_EMAIL_ORDER_LIMIT))).toBe(
      "orderLimit",
    );
    expect(receiptEmailFailureOf(err(API_ERROR_CODES.RECEIPT_EMAIL_DAY_LIMIT))).toBe("dayLimit");
  });
  it("a sale voided after the view opened (RECEIPT_NOT_AVAILABLE) is final: it can never be sent, so it is not a retryable failure", () => {
    expect(receiptEmailFailureOf(err(API_ERROR_CODES.RECEIPT_NOT_AVAILABLE, "x"))).toBe(
      "unavailable",
    );
    expect(isFinalReceiptEmailPhase("unavailable")).toBe(true);
  });
  it("only the limits and 'unavailable' are final phases", () => {
    for (const p of ["orderLimit", "dayLimit", "unavailable"] as const)
      expect(isFinalReceiptEmailPhase(p)).toBe(true);
    for (const p of ["idle", "sending", "sent", "failed"] as const)
      expect(isFinalReceiptEmailPhase(p)).toBe(false);
  });
  it("everything else is a plain failure the cashier can retry", () => {
    for (const e of [
      err(API_ERROR_CODES.RECEIPT_EMAIL_NOT_SENT),
      err(undefined),
      { response: { status: 500 } },
      new Error("Network Error"),
      null,
      undefined,
      "boom",
    ])
      expect(receiptEmailFailureOf(e)).toBe("failed");
  });
});
