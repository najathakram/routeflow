import {
  SENDS_AFTER_DELIVERY_SHORT,
  canEmailAgain,
  invoiceResendCopy,
  type InvoiceSendState,
} from "./invoice-send-state";

/** #2088 - the one confirmation copy (shared by web and mobile through @routeflow/types). */
const state = (s: InvoiceSendState["state"]): InvoiceSendState => ({
  state: s,
  lastSentAt: "2026-10-02T15:00:00.000Z",
  lastSentTo: "ap@acme.test",
});

describe("invoiceResendCopy", () => {
  it("never (or an older API with no sendState): a plain Send with no confirmation", () => {
    for (const s of [
      undefined,
      null,
      { state: "never", lastSentAt: null, lastSentTo: null } as const,
    ]) {
      expect(invoiceResendCopy(s)).toEqual({
        action: "Send",
        confirm: null,
        confirmButton: "Send",
      });
    }
  });

  it("changedSinceSent: the owner's modified-since sentence with the date", () => {
    const c = invoiceResendCopy(state("changedSinceSent"));
    expect(c.action).toBe("Email again");
    expect(c.confirm).toMatch(
      /^This invoice was emailed on Oct \d{1,2}, 2026\. It has been modified since\. Email the updated invoice\?$/,
    );
    expect(c.confirmButton).toBe("Email updated invoice");
  });

  it("unchanged: the no-changes sentence with the date", () => {
    const c = invoiceResendCopy(state("unchanged"));
    expect(c.confirm).toMatch(
      /^No changes since the last email on Oct \d{1,2}, 2026\. Email it again\?$/,
    );
    expect(c.confirmButton).toBe("Email again");
  });

  it("sentBeforeTracking: says the changes cannot be checked", () => {
    expect(invoiceResendCopy(state("sentBeforeTracking")).confirm).toMatch(
      /^This invoice was emailed on Oct \d{1,2}, 2026\. Changes since then can't be checked\. Email it again\?$/,
    );
  });

  it("a missing or bad date reads 'an earlier date', never 'Invalid Date'", () => {
    const c = invoiceResendCopy({ state: "unchanged", lastSentAt: "nonsense", lastSentTo: null });
    expect(c.confirm).toContain("an earlier date");
    expect(c.confirm).not.toContain("Invalid");
  });
});

describe("canEmailAgain / lock copy", () => {
  it("SENT, VIEWED, OVERDUE, PARTIAL and PAID can be emailed again; DRAFT, VOID and written off cannot", () => {
    for (const s of ["SENT", "VIEWED", "OVERDUE", "PARTIAL", "PAID"])
      expect(canEmailAgain(s)).toBe(true);
    for (const s of ["DRAFT", "VOID", "WRITTEN_OFF"]) expect(canEmailAgain(s)).toBe(false);
  });
  it("the locked label is the owner's words", () => {
    expect(SENDS_AFTER_DELIVERY_SHORT).toBe("Sends after delivery");
  });
});
