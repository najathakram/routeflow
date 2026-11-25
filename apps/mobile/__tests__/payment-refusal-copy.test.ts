import { readFileSync } from "fs";
import { join } from "path";
import {
  ADVANCE_NOT_AVAILABLE_COPY,
  DRAFT_PAYMENT_HAS_EXCESS_COPY,
  INVOICE_NOT_PAYABLE_COPY,
  INVOICE_NOT_PAYABLE_DEFAULT_COPY,
  paymentRefusalCopy,
} from "../lib/payment-refusal-copy";

/**
 * SA-1299 P4 (B1396, B1385): staff on mobile read the ruled words (the same strings as web, one shared source in
 * @routeflow/types), never the server's raw text. Each code is shown by its own sentence at every screen that
 * records a payment or applies an advance.
 */
const RAW = "Cannot record payment on a draft invoice (raw server text)";
const err = (data: Record<string, unknown>) => ({
  response: { status: 400, data: { message: RAW, ...data } },
});

describe("paymentRefusalCopy (mobile reads the ruled words)", () => {
  it.each([
    [
      "DRAFT",
      "This invoice is still a draft. Send it to the customer first, then record the payment.",
    ],
    ["VOID", "This invoice is void, so it can't take a payment."],
    ["WRITTEN_OFF", "This invoice was written off, so it can't take a payment."],
  ])("INVOICE_NOT_PAYABLE (%s) -> its own sentence, never the raw text", (reason, sentence) => {
    const copy = paymentRefusalCopy(err({ code: "INVOICE_NOT_PAYABLE", reason }));
    expect(copy).toBe(sentence);
    expect(copy).not.toContain("raw server text");
    expect(INVOICE_NOT_PAYABLE_COPY[reason as keyof typeof INVOICE_NOT_PAYABLE_COPY]).toBe(
      sentence,
    );
  });

  it("INVOICE_NOT_PAYABLE with no or an unknown reason makes no claim about the status", () => {
    expect(paymentRefusalCopy(err({ code: "INVOICE_NOT_PAYABLE" }))).toBe(
      INVOICE_NOT_PAYABLE_DEFAULT_COPY,
    );
    expect(paymentRefusalCopy(err({ code: "INVOICE_NOT_PAYABLE", reason: "PAID" }))).toBe(
      INVOICE_NOT_PAYABLE_DEFAULT_COPY,
    );
  });

  it("DRAFT_PAYMENT_HAS_EXCESS and ADVANCE_NOT_AVAILABLE -> their ruled sentences", () => {
    expect(paymentRefusalCopy(err({ code: "DRAFT_PAYMENT_HAS_EXCESS" }))).toBe(
      "A draft payment can't be more than the invoices it pays. Allocate the full amount, or save it as paid.",
    );
    expect(DRAFT_PAYMENT_HAS_EXCESS_COPY).toContain("Allocate the full amount");
    expect(paymentRefusalCopy(err({ code: "ADVANCE_NOT_AVAILABLE" }))).toBe(
      "This advance comes from a payment that isn't confirmed yet, so it can't be applied. Once that payment is confirmed, you can apply it.",
    );
    expect(ADVANCE_NOT_AVAILABLE_COPY).toMatch(
      /Once that payment is confirmed, you can apply it\.$/,
    );
  });

  it("any other body, or none, is null (the screen keeps its own fallback)", () => {
    expect(paymentRefusalCopy(err({ code: "SOMETHING_ELSE" }))).toBeNull();
    expect(paymentRefusalCopy(new Error("x"))).toBeNull();
    expect(paymentRefusalCopy(undefined)).toBeNull();
  });
});

describe("the mobile screens that record a payment or apply an advance use it", () => {
  const root = join(__dirname, "..");
  it.each([
    "app/(operator)/payments/record.tsx",
    "app/(operator)/(tabs)/invoices/[id]/record-payment.tsx",
    "app/(operator)/customers/[id].tsx",
    "app/(operator)/(tabs)/invoices/[id].tsx",
  ])("%s toasts paymentRefusalCopy(e) before the server's raw message", (rel) => {
    const src = readFileSync(join(root, rel), "utf8");
    expect(src).toMatch(/paymentRefusalCopy\(e\)\s*\?\?/);
    expect(src).toContain('lib/payment-refusal-copy"');
  });
});
