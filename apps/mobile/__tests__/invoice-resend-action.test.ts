import { invoiceSendAction } from "../lib/invoices-logic";

/** #2088 - the mobile Send / Email again tile: first send, re-send with the tracked state, locked with its reason. */
const sent = {
  state: "unchanged",
  lastSentAt: "2026-10-02T15:00:00.000Z",
  lastSentTo: "a@b.test",
} as const;
const changed = { ...sent, state: "changedSinceSent" } as const;
const lock = { reason: "SENDS_AFTER_DELIVERY" } as const;

describe("invoiceSendAction", () => {
  it("a DRAFT never emailed: a plain Send tile with no confirmation", () => {
    expect(invoiceSendAction({ status: "DRAFT", pendingMirror: false })).toMatchObject({
      show: true,
      locked: false,
      label: "Send",
      confirm: null,
    });
  });

  it.each(["SENT", "VIEWED", "OVERDUE", "PARTIAL", "PAID"])(
    "%s: 'Email again' with the no-changes confirmation",
    (status) => {
      const a = invoiceSendAction({ status, pendingMirror: false, sendState: sent });
      expect(a).toMatchObject({ show: true, locked: false, label: "Email again" });
      expect(a.confirm).toMatch(/^No changes since the last email on .* Email it again\?$/);
    },
  );

  it("modified since: the modified-since sentence and the 'Email updated invoice' button (same words as web)", () => {
    const a = invoiceSendAction({ status: "SENT", pendingMirror: false, sendState: changed });
    expect(a.confirm).toMatch(/It has been modified since\. Email the updated invoice\?$/);
    expect(a.confirmButton).toBe("Email updated invoice");
  });

  it("a server lock: shown LOCKED with the reason in the business's words, never missing, no confirmation", () => {
    expect(
      invoiceSendAction({ status: "DRAFT", pendingMirror: true, sendLocked: lock }),
    ).toMatchObject({
      show: true,
      locked: true,
      label: "Sends once handed over or delivered",
      confirm: null,
    });
    expect(
      invoiceSendAction({ status: "DRAFT", pendingMirror: true, sendLocked: lock, storeOnly: true })
        .label,
    ).toBe("Sends after pickup");
    expect(
      invoiceSendAction({
        status: "DRAFT",
        pendingMirror: true,
        sendLocked: lock,
        storeOnly: false,
      }).label,
    ).toBe("Sends after delivery");
  });

  it("the client never derives the lock: a pending mirror WITHOUT sendLocked shows no send tile (older API)", () => {
    expect(invoiceSendAction({ status: "DRAFT", pendingMirror: true })).toMatchObject({
      show: false,
      locked: false,
    });
  });

  it("marked sent, not emailed: a first email with no confirmation (the detail line says it was only marked)", () => {
    const marked = {
      state: "markedSentNotEmailed",
      lastSentAt: "2027-01-05T10:00:00.000Z",
      lastSentTo: null,
    } as const;
    expect(
      invoiceSendAction({ status: "SENT", pendingMirror: false, sendState: marked }),
    ).toMatchObject({
      show: true,
      label: "Email invoice",
      confirm: null,
    });
  });

  it("VOID and written-off invoices show no send tile", () => {
    for (const status of ["VOID", "WRITTEN_OFF"])
      expect(invoiceSendAction({ status, pendingMirror: false }).show).toBe(false);
  });
});
