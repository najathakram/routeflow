import {
  REFUND_COPY,
  creditOutcomeLine,
  refundedLine,
  storeCreditAddedLine,
  takeBackCreditLabel,
} from "./refund-copy";

// W-712 (SA-929): the money words per host. "for the next order" is true only where the credit is
// not held for a carrying order of its own (the settled counter sale).
describe("creditOutcomeLine contexts", () => {
  it("counter (settled sale): store credit for the next order", () => {
    expect(creditOutcomeLine("$12.40", "nextOrder", "Acme Foods")).toBe(
      "$12.40 is given as store credit for Acme Foods, to use on the next order.",
    );
  });
  it("order create/edit (carrying order): goes toward this order, never 'next order'", () => {
    const line = creditOutcomeLine("$12.40", "thisOrder", "Acme Foods");
    expect(line).toBe(
      "$12.40 is given as store credit for Acme Foods and goes toward this order when you save.",
    );
    expect(line).not.toMatch(/next order/i);
  });
  it("Returns page with the apply-to choice: neutral", () => {
    const line = creditOutcomeLine("$12.40", "account", "Acme Foods");
    expect(line).toBe("$12.40 is given as store credit for Acme Foods.");
    expect(line).not.toMatch(/next order|this order/i);
  });
  it("no name falls back to 'the customer'; a name ending in s needs no possessive", () => {
    expect(creditOutcomeLine("$1.00", "account")).toBe(
      "$1.00 is given as store credit for the customer.",
    );
    expect(creditOutcomeLine("$1.00", "account", "Acme Goods")).not.toMatch(/'s|s'/);
  });
  it("one word for credit: store credit, and one verb: give", () => {
    expect(takeBackCreditLabel("$12.40")).toBe("Take back items and give $12.40 store credit");
  });
});

describe("server-answer lines", () => {
  it("refundedLine names the tender", () => {
    expect(refundedLine("CASH", "$9.00")).toBe("Refunded $9.00 in cash.");
    expect(refundedLine("CARD", "$9.00")).toBe("Refunded $9.00 to the card.");
    expect(refundedLine("CHECK", "$9.00")).toBe("Refunded $9.00 by check.");
  });
  it("storeCreditAddedLine", () => {
    expect(storeCreditAddedLine("$9.00")).toBe("$9.00 given as store credit.");
  });
});

describe("SA-959: a walk-in return is never a credit note", () => {
  it("the one refusal sentence names the way forward", () => {
    expect(REFUND_COPY.walkInNoRefund).toBe(
      "This sale can't be refunded here. Ask office staff to refund it.",
    );
  });
  it("no walk-in credit-note wording is left in the copy module", async () => {
    const mod = (await import("./refund-copy")) as Record<string, unknown>;
    expect(mod.takeBackWalkInLabel).toBeUndefined();
    expect(mod.creditNoteRecordedLine).toBeUndefined();
    expect((REFUND_COPY as Record<string, unknown>).walkInCreditNote).toBeUndefined();
  });
});
