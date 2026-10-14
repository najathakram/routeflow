import {
  canEmailAgain,
  invoiceResendCopy,
  invoiceSendStateLine,
  sendsAfterLabel,
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

  it("markedSentNotEmailed: a first email, no confirmation (it was only marked sent)", () => {
    expect(invoiceResendCopy(state("markedSentNotEmailed"))).toEqual({
      action: "Email invoice",
      confirm: null,
      confirmButton: "Email invoice",
    });
  });

  it("a missing or bad date reads 'an earlier date', never 'Invalid Date'", () => {
    const c = invoiceResendCopy({ state: "unchanged", lastSentAt: "nonsense", lastSentTo: null });
    expect(c.confirm).toContain("an earlier date");
    expect(c.confirm).not.toContain("Invalid");
  });
});

describe("invoiceSendStateLine", () => {
  const at = "2026-10-02T15:00:00.000Z";
  it("is null when never emailed (or no state from an older API)", () => {
    expect(invoiceSendStateLine(undefined)).toBeNull();
    expect(invoiceSendStateLine({ state: "never", lastSentAt: null, lastSentTo: null })).toBeNull();
  });

  it("unchanged / modified / cannot-check / marked-sent, with the recipient when known", () => {
    expect(
      invoiceSendStateLine({ state: "unchanged", lastSentAt: at, lastSentTo: "a@b.test" }),
    ).toMatch(/^Emailed Oct \d{1,2}, 2026 to a@b\.test\. No changes since\.$/);
    expect(
      invoiceSendStateLine({ state: "changedSinceSent", lastSentAt: at, lastSentTo: "a@b.test" }),
    ).toMatch(/Modified since\.$/);
    expect(
      invoiceSendStateLine({ state: "sentBeforeTracking", lastSentAt: at, lastSentTo: null }),
    ).toMatch(/^Emailed Oct \d{1,2}, 2026\. Changes since then can't be checked\.$/);
    expect(
      invoiceSendStateLine({ state: "markedSentNotEmailed", lastSentAt: at, lastSentTo: null }),
    ).toMatch(/^Marked as sent Oct \d{1,2}, 2026\. No email on record\.$/);
  });
});

describe("canEmailAgain / lock copy", () => {
  it("SENT, VIEWED, OVERDUE, PARTIAL and PAID can be emailed again; DRAFT, VOID and written off cannot", () => {
    for (const s of ["SENT", "VIEWED", "OVERDUE", "PARTIAL", "PAID"])
      expect(canEmailAgain(s)).toBe(true);
    for (const s of ["DRAFT", "VOID", "WRITTEN_OFF"]) expect(canEmailAgain(s)).toBe(false);
  });

  it("the locked label follows the business: pickup for store-only, delivery otherwise, neutral while unknown", () => {
    expect(sendsAfterLabel(false)).toBe("Sends after delivery");
    expect(sendsAfterLabel(true)).toBe("Sends after pickup");
    expect(sendsAfterLabel(null)).toBe("Sends once handed over or delivered");
  });
});
