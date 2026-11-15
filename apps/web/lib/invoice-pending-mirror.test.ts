import { isPendingMirrorInvoice, paidInAdvance, pendingMirrorCopy } from "./invoice-pending-mirror";

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

  // SA-1101 P: a refused order is post-delivery, so its $0 draft is not a pending mirror (it would be re-mirrored at the full amount).
  it("a REFUSED order's draft is not a pending mirror, like a delivered or partly delivered one", () => {
    for (const status of ["REFUSED", "DELIVERED", "PARTIALLY_DELIVERED"]) {
      expect(isPendingMirrorInvoice({ ...draft, order: { status } })).toBe(false);
    }
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
    expect(c.note).toBe("you'll review and send this invoice after delivery.");
  });
  it("the fulfilment capability not known yet (loading, or a partial answer) never claims delivery", () => {
    const c = pendingMirrorCopy(null);
    expect(c.note).toBe("you'll review and send this invoice once it is handed over or delivered.");
  });
  it("a store-only (POS-forced) business says 'after pickup', never 'delivery'", () => {
    const c = pendingMirrorCopy(true);
    expect(c.note).toBe("you'll review and send this invoice after pickup.");
    expect(c.note).not.toMatch(/deliver/i);
  });
  it("R4: the pill's words are gone; only the note remains", () => {
    expect(Object.keys(pendingMirrorCopy(true))).toEqual(["note"]);
  });
});

describe("paidInAdvance (UX guide B6)", () => {
  it("full: a DRAFT with nothing left to pay", () => {
    expect(paidInAdvance({ status: "DRAFT", total: 89.77, balanceDue: 0 })).toBe("full");
  });
  it("part: a DRAFT with some paid and some due", () => {
    expect(paidInAdvance({ status: "DRAFT", total: 100, balanceDue: 40 })).toBe("part");
  });
  it("none: a SENT invoice, an unpaid DRAFT, a $0 DRAFT, or a missing balance", () => {
    expect(paidInAdvance({ status: "SENT", total: 100, balanceDue: 0 })).toBe("none");
    expect(paidInAdvance({ status: "DRAFT", total: 100, balanceDue: 100 })).toBe("none");
    expect(paidInAdvance({ status: "DRAFT", total: 0, balanceDue: 0 })).toBe("none");
    expect(paidInAdvance({ status: "DRAFT", total: 100 })).toBe("none");
  });
  // SA ruling (b): the chip claims money received, so a credit note never earns it.
  it("none: a DRAFT settled only by a credit note", () => {
    expect(paidInAdvance({ status: "DRAFT", total: 50, balanceDue: 0, creditApplied: 50 })).toBe(
      "none",
    );
  });
  it("part: credit 20 plus 30 paid is only part paid in advance", () => {
    expect(paidInAdvance({ status: "DRAFT", total: 50, balanceDue: 0, creditApplied: 20 })).toBe(
      "part",
    );
  });
  it("credit never counts: full only when cash settles the whole total; credit 60 plus 0 paid is none", () => {
    expect(paidInAdvance({ status: "DRAFT", total: 100, balanceDue: 0, creditApplied: 0 })).toBe(
      "full",
    );
    expect(paidInAdvance({ status: "DRAFT", total: 100, balanceDue: 40, creditApplied: 60 })).toBe(
      "none",
    );
  });
});
