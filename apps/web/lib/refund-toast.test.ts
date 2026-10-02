import { refundSuccessToast } from "./refund-toast";

describe("refundSuccessToast (B959)", () => {
  const unbilled = [
    {
      productId: "pz",
      name: "Stray Item",
      qty: 2,
      message: "Stray Item was not billed on this order, so no refund was given for it.",
    },
  ];

  it("a normal credit refund says a credit note was minted", () => {
    expect(refundSuccessToast("CREDIT_NOTE", { creditNoteId: "cn-1" })).toEqual({
      title: "Store credit issued",
      description: "A credit note has been minted for the customer.",
    });
  });

  it("a MIXED return names the item that got no refund (never a silent $0)", () => {
    const t = refundSuccessToast("CREDIT_NOTE", { creditNoteId: "cn-1", unbilledItems: unbilled });
    expect(t.title).toBe("Refunded, but not every item");
    expect(t.description).toContain("A credit note has been minted");
    expect(t.description).toContain(
      "Stray Item was not billed on this order, so no refund was given for it.",
    );
  });

  it("a $0 resolution (no credit note minted) never claims one was minted, and still names the unbilled item", () => {
    const t = refundSuccessToast("CREDIT_NOTE", { creditNoteId: null, unbilledItems: unbilled });
    expect(t.description).not.toContain("has been minted");
    expect(t.description).toContain("No credit note was needed.");
    expect(t.description).toContain("Stray Item was not billed");
  });

  it("an external refund keeps its own wording", () => {
    expect(refundSuccessToast("EXTERNAL_REFUND", {})).toEqual({
      title: "Refund recorded",
      description: "The return has been marked as refunded outside RouteFlow.",
    });
  });
});
