import { isPendingMirrorInvoice } from "./invoice-pending-mirror";

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
