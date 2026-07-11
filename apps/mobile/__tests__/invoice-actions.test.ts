/**
 * Gating for the mobile invoice actions ported from web (Wave 3):
 * write-off eligibility and payment editability.
 */
import { canWriteOff, isPaymentEditable } from "../lib/invoices-logic";

describe("canWriteOff", () => {
  it("allows only unpaid-but-live statuses", () => {
    for (const s of ["SENT", "VIEWED", "PARTIAL", "OVERDUE"] as const) {
      expect(canWriteOff(s)).toBe(true);
    }
  });
  it("blocks draft/paid/void/written-off", () => {
    for (const s of ["DRAFT", "PAID", "VOID", "WRITTEN_OFF"] as const) {
      expect(canWriteOff(s)).toBe(false);
    }
  });
});

describe("isPaymentEditable", () => {
  it("allows a normal cash payment on a live invoice", () => {
    expect(isPaymentEditable("CASH", "PAID", "PARTIAL")).toBe(true);
  });
  it("blocks Advance / Credit-Note source draws (server rejects them)", () => {
    expect(isPaymentEditable("ADVANCE", "PAID", "PARTIAL")).toBe(false);
    expect(isPaymentEditable("CREDIT_NOTE", "PAID", "PARTIAL")).toBe(false);
  });
  it("blocks a voided payment", () => {
    expect(isPaymentEditable("CASH", "VOID", "PARTIAL")).toBe(false);
  });
  it("blocks edits on terminal invoice states", () => {
    expect(isPaymentEditable("CASH", "PAID", "VOID")).toBe(false);
    expect(isPaymentEditable("CASH", "PAID", "WRITTEN_OFF")).toBe(false);
    expect(isPaymentEditable("CASH", "PAID", "PAID")).toBe(false);
  });
});
