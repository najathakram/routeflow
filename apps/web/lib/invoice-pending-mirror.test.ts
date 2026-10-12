import { isPendingMirrorInvoice, pendingMirrorCopy } from "./invoice-pending-mirror";

const draft = {
  orderId: "o1",
  status: "DRAFT",
  deliveryBatchId: null,
  order: { status: "OUT_FOR_DELIVERY" },
};

describe("isPendingMirrorInvoice", () => {
  it("derives from the order status when the server sends no flag (unchanged)", () => {
    expect(isPendingMirrorInvoice(draft)).toBe(true);
    expect(isPendingMirrorInvoice({ ...draft, order: { status: "DELIVERED" } })).toBe(false);
  });

  it("the server's pendingMirror wins: a shipped carrier order's draft is NOT a mirror", () => {
    expect(isPendingMirrorInvoice({ ...draft, pendingMirror: false })).toBe(false);
  });

  it("the server's pendingMirror wins the other way too", () => {
    expect(
      isPendingMirrorInvoice({ ...draft, order: { status: "DELIVERED" }, pendingMirror: true }),
    ).toBe(true);
  });
});

describe("pendingMirrorCopy: no delivery on a store-only order", () => {
  it("a delivery business keeps 'after delivery'", () => {
    const c = pendingMirrorCopy(false);
    expect(c.badge).toBe("Mirrors the order \u2014 ready to send after delivery");
    expect(c.note).toBe("you'll review and send this invoice after delivery.");
  });
  it("the fulfilment capability not known yet (loading, or a partial answer) never claims delivery", () => {
    const c = pendingMirrorCopy(null);
    expect(c.badge).toBe(
      "Mirrors the order \u2014 ready to send once it is handed over or delivered",
    );
    expect(c.note).toBe("you'll review and send this invoice once it is handed over or delivered.");
  });
  it("a store-only (POS-forced) business says 'after hand-over', never 'delivery'", () => {
    const c = pendingMirrorCopy(true);
    expect(c.badge).toBe("Mirrors the order \u2014 ready to send after hand-over");
    expect(c.note).toBe("you'll review and send this invoice after hand-over.");
    expect(`${c.badge} ${c.note}`).not.toMatch(/deliver/i);
  });
});
