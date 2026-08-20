/**
 * B4: `canRecordPayment` allow-list, mirroring web's gate exactly
 * (invoices/[id]/page.tsx). The server only rejects VOID, so a bare
 * "not paid, not void" gate used to offer "Record payment" on DRAFT and
 * WRITTEN_OFF too — the POST succeeds, but `recomputeStatus` treats DRAFT as
 * terminal, so a fully-paid invoice stays DRAFT and drops out of AR/aging.
 * See `invoice-actions.test.ts` for the rest of this module's gates.
 */
import { canRecordPayment } from "../lib/invoices-logic";

describe("canRecordPayment", () => {
  it.each(["DRAFT", "WRITTEN_OFF", "VOID", "PAID"])("%s → false", (status) => {
    expect(canRecordPayment(status)).toBe(false);
  });

  it.each(["SENT", "VIEWED", "PARTIAL", "OVERDUE"])("%s → true", (status) => {
    expect(canRecordPayment(status)).toBe(true);
  });
});
