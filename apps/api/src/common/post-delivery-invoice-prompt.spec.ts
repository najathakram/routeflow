import { postDeliveryInvoicePrompt } from "@routeflow/types";

/**
 * Owner request (#2089): "once an order is delivered, automatically open that order's
 * invoice and ask whether to send it" — the ONE decision shared by the mobile driver
 * (route stop completion), mobile operator (order detail's "any path into DELIVERED"),
 * and web (`handleDeliver`). `postDeliveryInvoicePrompt` lives in
 * `packages/types/post-delivery-invoice-prompt.ts`, which has no Jest runner of its own
 * (same as `pack-size.ts`), so the pinned suite lives here and imports the package like
 * any other consumer.
 */
describe("postDeliveryInvoicePrompt", () => {
  it("skips when there is no invoice at all", () => {
    expect(postDeliveryInvoicePrompt({ invoice: null, online: true })).toBe("skip");
    expect(postDeliveryInvoicePrompt({ invoice: undefined, online: true })).toBe("skip");
  });

  it("skips a VOID invoice — sendEmail itself refuses to send one", () => {
    expect(postDeliveryInvoicePrompt({ invoice: { status: "VOID" }, online: true })).toBe("skip");
  });

  it("offers 'issue-and-send' for a DRAFT invoice — sendEmail issues it (DRAFT→SENT) atomically on send, so there is no separate finalize step", () => {
    expect(postDeliveryInvoicePrompt({ invoice: { status: "DRAFT" }, online: true })).toBe(
      "issue-and-send",
    );
  });

  it.each(["SENT", "VIEWED", "PARTIAL", "PAID", "OVERDUE", "WRITTEN_OFF"] as const)(
    "offers a plain 'send' for an already-issued invoice (%s)",
    (status) => {
      expect(postDeliveryInvoicePrompt({ invoice: { status }, online: true })).toBe("send");
    },
  );

  it("is 'offline-later' regardless of invoice state — no network round trip means no way to know whether an invoice even exists", () => {
    expect(postDeliveryInvoicePrompt({ invoice: null, online: false })).toBe("offline-later");
    expect(postDeliveryInvoicePrompt({ invoice: { status: "DRAFT" }, online: false })).toBe(
      "offline-later",
    );
    expect(postDeliveryInvoicePrompt({ invoice: { status: "SENT" }, online: false })).toBe(
      "offline-later",
    );
  });

  it("offline is checked before 'no invoice' — never conflates the two", () => {
    // Regression pin: an implementation that checked `!invoice` first would read an
    // offline device with no cached invoice data as "skip" instead of "offline-later",
    // silently dropping the owner's ask on exactly the device state it matters most for.
    const result = postDeliveryInvoicePrompt({ invoice: null, online: false });
    expect(result).not.toBe("skip");
    expect(result).toBe("offline-later");
  });
});
