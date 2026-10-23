import {
  duplicatePaymentRefMessage,
  isDuplicatePaymentRef,
  isRecordPaymentLocalRefusal,
  toastDuplicatePaymentRef,
} from "./duplicate-payment-ref";

/** Row 498 (SA-837): the one reader and toast of 409 DUPLICATE_PAYMENT_REF for every web record-payment surface. */
const dup = {
  response: {
    status: 409,
    data: {
      code: "DUPLICATE_PAYMENT_REF",
      message: "RAW",
      existingPayment: {
        id: "pay-1",
        paymentNumber: "PAY-A-0001",
        paidAt: "2026-10-01T12:00:00.000Z",
        amount: 150,
        invoiceId: "inv-1",
        invoiceNumber: "INV-0042",
      },
    },
  },
};
const SENTENCE =
  "A payment with this reference was already recorded on Oct 1, 2026 for $150.00 (INV-0042).";

describe("duplicate payment reference (web)", () => {
  it("reads only a 409 DUPLICATE_PAYMENT_REF that names the existing payment", () => {
    expect(isDuplicatePaymentRef(dup)).toBe(true);
    expect(isDuplicatePaymentRef({ response: { status: 400, data: dup.response.data } })).toBe(
      false,
    );
    expect(isDuplicatePaymentRef({ response: { status: 409, data: { code: "OTHER" } } })).toBe(
      false,
    );
    expect(
      isDuplicatePaymentRef({ response: { status: 409, data: { code: "DUPLICATE_PAYMENT_REF" } } }),
    ).toBe(false);
    expect(isDuplicatePaymentRef(new Error("x"))).toBe(false);
  });

  it("the sentence names the date, amount and invoice, never the raw server message", () => {
    expect(duplicatePaymentRefMessage(dup)).toBe(SENTENCE);
    expect(duplicatePaymentRefMessage(new Error("x"))).toBeNull();
  });

  it("keeps the global toast quiet for the refusal (and the day-close refusal)", () => {
    expect(isRecordPaymentLocalRefusal(dup)).toBe(true);
    expect(
      isRecordPaymentLocalRefusal({
        response: { status: 409, data: { code: "DAY_CLOSED_FOR_PAYMENT_DATE" } },
      }),
    ).toBe(true);
    expect(isRecordPaymentLocalRefusal({ response: { status: 500, data: {} } })).toBe(false);
  });

  it.each(["OPERATOR", "TENANT_ADMIN", "SUPER_ADMIN"])(
    "a %s gets the sentence and a Record anyway action that resends",
    (role) => {
      const toast = jest.fn();
      const resend = jest.fn();
      expect(toastDuplicatePaymentRef(dup, toast, role, resend)).toBe(true);
      const t = toast.mock.calls[0][0];
      expect(t.description).toBe(SENTENCE);
      expect(t.action.label).toBe("Record anyway");
      t.action.onClick();
      expect(resend).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["CUSTOMER", "DRIVER", undefined, null])(
    "a %s gets the sentence and no action",
    (role) => {
      const toast = jest.fn();
      expect(toastDuplicatePaymentRef(dup, toast, role, jest.fn())).toBe(true);
      expect(toast.mock.calls[0][0].action).toBeUndefined();
    },
  );

  it("returns false and shows nothing for any other error", () => {
    const toast = jest.fn();
    expect(toastDuplicatePaymentRef(new Error("x"), toast, "OPERATOR", jest.fn())).toBe(false);
    expect(toast).not.toHaveBeenCalled();
  });
});
