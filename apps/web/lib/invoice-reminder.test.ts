import { canSendReminder } from "./invoice-reminder";

/**
 * R4 (SA-770): "Send Reminder" is offered on every ISSUED, UNPAID invoice that still owes a balance,
 * not only on SENT / VIEWED / OVERDUE. A past-due PARTIAL invoice that owes $5 was missing the button.
 */
describe("canSendReminder", () => {
  it("shows on a PARTIAL invoice that still owes a balance", () => {
    expect(canSendReminder({ status: "PARTIAL", balanceDue: 5 })).toBe(true);
  });

  it("hides on a PARTIAL invoice with nothing left to collect", () => {
    expect(canSendReminder({ status: "PARTIAL", balanceDue: 0 })).toBe(false);
  });

  it.each(["SENT", "VIEWED", "OVERDUE"] as const)("shows on %s with a balance", (status) => {
    expect(canSendReminder({ status, balanceDue: 30 })).toBe(true);
  });

  it.each(["DRAFT", "PAID", "VOID", "WRITTEN_OFF"] as const)("hides on %s", (status) => {
    expect(canSendReminder({ status, balanceDue: 30 })).toBe(false);
  });

  it("hides when the balance is zero (exactly settled or overpaid)", () => {
    expect(canSendReminder({ status: "SENT", balanceDue: 0 })).toBe(false);
    expect(canSendReminder({ status: "OVERDUE", balanceDue: 0 })).toBe(false);
  });

  it("hides when the balance is unknown", () => {
    expect(canSendReminder({ status: "PARTIAL", balanceDue: undefined })).toBe(false);
    expect(canSendReminder({ status: "SENT", balanceDue: null })).toBe(false);
  });

  it("accepts a decimal-string balance (the API serialises money as strings)", () => {
    expect(canSendReminder({ status: "PARTIAL", balanceDue: "5.00" })).toBe(true);
    expect(canSendReminder({ status: "PARTIAL", balanceDue: "0.00" })).toBe(false);
  });
});
