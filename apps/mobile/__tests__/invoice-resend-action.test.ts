import { invoiceSendAction } from "../lib/invoices-logic";

/** #2088 - the mobile Send / Email again tile: first send, re-send with the tracked state, locked with its reason. */
const sent = {
  state: "unchanged",
  lastSentAt: "2026-10-02T15:00:00.000Z",
  lastSentTo: "a@b.test",
} as const;
const changed = { ...sent, state: "changedSinceSent" } as const;

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

  it("a pending order mirror: the tile is shown LOCKED with the reason, never missing, and cannot confirm", () => {
    expect(invoiceSendAction({ status: "DRAFT", pendingMirror: true })).toMatchObject({
      show: true,
      locked: true,
      label: "Sends after delivery",
      confirm: null,
    });
    // the server's own lock wins even where the client derivation says unlocked
    expect(
      invoiceSendAction({
        status: "DRAFT",
        pendingMirror: false,
        sendLocked: { reason: "SENDS_AFTER_DELIVERY" },
      }),
    ).toMatchObject({ locked: true });
  });

  it("VOID and written-off invoices show no send tile", () => {
    for (const status of ["VOID", "WRITTEN_OFF"])
      expect(invoiceSendAction({ status, pendingMirror: false }).show).toBe(false);
  });
});
