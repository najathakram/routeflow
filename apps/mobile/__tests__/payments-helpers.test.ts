/**
 * P10-PAR-4 pure-logic guards for the mobile payments parity screen. Locks the
 * method/status → pill+icon mapping and the void gating (void allowed unless
 * already VOID — matching the server contract so no shown action is rejected).
 */
import { paymentActionFlags, paymentMethodPill, paymentStatusPill } from "../lib/payments-logic";
import type { PaymentMethod } from "../lib/api/invoices";
import type { PaymentStatus } from "../lib/api/payments";

describe("paymentMethodPill", () => {
  const cases: [PaymentMethod, string, string][] = [
    ["CASH", "green", "Cash"],
    ["CHECK", "brand", "Check"],
    ["ACH", "purple", "ACH"],
    ["CREDIT_CARD", "orange", "Card"],
    ["CREDIT_NOTE", "purple", "Credit Note"],
    ["ADVANCE", "brand", "Advance"],
    ["OTHER", "gray", "Other"],
  ];
  it.each(cases)("%s → %s / %s", (method, variant, label) => {
    const p = paymentMethodPill(method);
    expect(p.variant).toBe(variant);
    expect(p.label).toBe(label);
    expect(typeof p.icon).toBe("string"); // valid Ionicon name
  });
});

describe("paymentStatusPill", () => {
  const cases: [PaymentStatus | undefined, string, string][] = [
    ["PAID", "green", "Paid"],
    ["DRAFT", "gray", "Draft"],
    ["VOID", "red", "Void"],
    [undefined, "green", "Paid"], // legacy rows default to Paid
  ];
  it.each(cases)("%s → %s / %s", (status, variant, label) => {
    expect(paymentStatusPill(status)).toEqual({ variant, label });
  });
});

describe("paymentActionFlags", () => {
  it.each(["PAID", "DRAFT", undefined] as (PaymentStatus | undefined)[])(
    "%s → can void",
    (status) => expect(paymentActionFlags(status)).toEqual({ canVoid: true }),
  );
  it("VOID → terminal, no void", () => {
    expect(paymentActionFlags("VOID")).toEqual({ canVoid: false });
  });
  it("CREDIT_NOTE method → no void (API refuses; matches web)", () => {
    expect(paymentActionFlags("PAID", "CREDIT_NOTE")).toEqual({ canVoid: false });
  });
  it.each(["ADVANCE", "CASH"] as PaymentMethod[])("%s method → voidable", (method) =>
    expect(paymentActionFlags("PAID", method)).toEqual({ canVoid: true }),
  );
});
