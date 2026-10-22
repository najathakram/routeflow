import { duplicateRefPrompt } from "../lib/duplicate-payment-ref";
import {
  RECORD_ANYWAY_LABEL,
  duplicatePaymentRefBody,
  withRecordAnyway,
} from "@routeflow/types/payment-ref-copy";

/**
 * Row 498 (SA-837), mobile: the pure copy and flag builder behind the "Possible duplicate payment" alert. The
 * screens (invoice record-payment, standalone payments/record) only turn the prompt into an Alert and resend.
 */
const existing = {
  id: "pay-1",
  paymentNumber: "PAY-A-0001",
  paidAt: "2026-10-01T12:00:00.000Z",
  amount: 150,
  invoiceId: "inv-1",
  invoiceNumber: "INV-0042",
};
const dup = (over: Record<string, unknown> = {}) =>
  Object.assign(new Error("RAW SERVER TEXT"), {
    response: {
      status: 409,
      data: {
        code: "DUPLICATE_PAYMENT_REF",
        message: "RAW SERVER TEXT",
        existingPayment: existing,
        ...over,
      },
    },
  });

describe("duplicateRefPrompt", () => {
  it("names the existing payment's date, amount and invoice in the one shared sentence", () => {
    const p = duplicateRefPrompt(dup(), "OPERATOR");
    expect(p?.message).toBe(
      "A payment with this reference was already recorded on Oct 1, 2026 for $150.00 (INV-0042).",
    );
    expect(p?.message).not.toContain("RAW SERVER TEXT");
  });

  it.each(["OPERATOR", "TENANT_ADMIN", "SUPER_ADMIN"])("offers Record anyway to %s", (role) => {
    expect(duplicateRefPrompt(dup(), role)?.recordAnywayLabel).toBe(RECORD_ANYWAY_LABEL);
  });

  it.each(["CUSTOMER", "DRIVER", null, undefined])("does not offer Record anyway to %s", (role) => {
    expect(duplicateRefPrompt(dup(), role)?.recordAnywayLabel).toBeNull();
  });

  it("is null for any other error", () => {
    expect(duplicateRefPrompt(new Error("x"), "OPERATOR")).toBeNull();
    expect(
      duplicateRefPrompt({ response: { status: 409, data: { code: "OTHER" } } }, "OPERATOR"),
    ).toBeNull();
    expect(
      duplicateRefPrompt(
        { response: { status: 400, data: { code: "DUPLICATE_PAYMENT_REF" } } },
        "OPERATOR",
      ),
    ).toBeNull();
  });

  it("says 'an invoice' when the existing payment has no invoice number", () => {
    const p = duplicateRefPrompt(
      dup({ existingPayment: { ...existing, invoiceNumber: null } }),
      "OPERATOR",
    );
    expect(p?.message).toContain("(an invoice)");
  });
});

describe("the resend body", () => {
  it("is the same payment with recordAnyway: true", () => {
    expect(withRecordAnyway({ amount: 10, method: "CHECK" })).toEqual({
      amount: 10,
      method: "CHECK",
      recordAnyway: true,
    });
  });

  it("reads the body of a 409 DUPLICATE_PAYMENT_REF only", () => {
    expect(duplicatePaymentRefBody(dup())?.existingPayment.id).toBe("pay-1");
    expect(duplicatePaymentRefBody(undefined)).toBeNull();
  });
});
