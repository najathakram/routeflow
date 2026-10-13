/**
 * B4: `canRecordPayment` allow-list, mirroring web's gate exactly
 * (invoices/[id]/page.tsx). The server only rejects VOID, so a bare
 * "not paid, not void" gate used to offer "Record payment" on DRAFT and
 * WRITTEN_OFF too — the POST succeeds, but `recomputeStatus` treats DRAFT as
 * terminal, so a fully-paid invoice stays DRAFT and drops out of AR/aging.
 * See `invoice-actions.test.ts` for the rest of this module's gates.
 */
import { canRecordPayment, canWriteOff, isOpenInvoiceStatus } from "../lib/invoices-logic";

describe("canRecordPayment", () => {
  it.each(["DRAFT", "WRITTEN_OFF", "VOID", "PAID"])("%s → false", (status) => {
    expect(canRecordPayment(status)).toBe(false);
  });

  it.each(["SENT", "VIEWED", "PARTIAL", "OVERDUE"])("%s → true", (status) => {
    expect(canRecordPayment(status)).toBe(true);
  });
});

describe("isOpenInvoiceStatus (the shared open set)", () => {
  it.each(["SENT", "VIEWED", "PARTIAL", "OVERDUE"])(
    "%s is open, and may be paid / written off",
    (s) => {
      expect(isOpenInvoiceStatus(s)).toBe(true);
      expect(canRecordPayment(s)).toBe(true);
      expect(canWriteOff(s)).toBe(true);
    },
  );

  it.each(["DRAFT", "PAID", "VOID", "WRITTEN_OFF", "", "SOMETHING_NEW"])("%s is not open", (s) => {
    expect(isOpenInvoiceStatus(s)).toBe(false);
    expect(canWriteOff(s)).toBe(false);
  });

  it("a missing status is not open", () => {
    expect(isOpenInvoiceStatus(undefined)).toBe(false);
    expect(isOpenInvoiceStatus(null)).toBe(false);
  });
});
