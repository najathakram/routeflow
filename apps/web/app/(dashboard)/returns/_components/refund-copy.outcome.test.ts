import {
  creditOutcomeLine,
  refundOutcomeLine,
  refundedLine,
  storeCreditAddedLine,
  takeBackCreditLabel,
} from "./refund-copy";

// W-712 (SA-929): the money words per host. "for the next order" is true only where the credit is
// not held for a carrying order of its own (the settled counter sale).
describe("creditOutcomeLine contexts", () => {
  it("counter (settled sale): store credit for the next order", () => {
    expect(creditOutcomeLine("$12.40", "nextOrder", "Acme Foods")).toBe(
      "$12.40 is added as store credit for Acme Foods, to use on the next order.",
    );
  });
  it("order create/edit (carrying order): goes toward this order, never 'next order'", () => {
    const line = creditOutcomeLine("$12.40", "thisOrder", "Acme Foods");
    expect(line).toBe("$12.40 is added as store credit for Acme Foods and goes toward this order.");
    expect(line).not.toMatch(/next order/i);
  });
  it("Returns page with the apply-to choice: neutral", () => {
    const line = creditOutcomeLine("$12.40", "account", "Acme Foods");
    expect(line).toBe("$12.40 is added as store credit for Acme Foods.");
    expect(line).not.toMatch(/next order|this order/i);
  });
  it("no name falls back to 'the customer'; a name ending in s needs no possessive", () => {
    expect(creditOutcomeLine("$1.00", "account")).toBe(
      "$1.00 is added as store credit for the customer.",
    );
    expect(creditOutcomeLine("$1.00", "account", "Jones")).not.toMatch(/'s|s'/);
  });
  it("walk-in: never an account or possessive; says what happens", () => {
    const line = creditOutcomeLine("$12.40", "walkIn", "Walk-in");
    expect(line).toBe(
      "Walk-in sales can't hold store credit. $12.40 is recorded as a credit note on this sale.",
    );
    expect(line).not.toMatch(/account|'s/i);
  });
  it("one word for credit: store credit; refund line drops 'not onto their account'", () => {
    expect(refundOutcomeLine("$12.40")).toBe("$12.40 goes back to the customer.");
    expect(takeBackCreditLabel("$12.40")).toBe("Take back items and add $12.40 store credit");
  });
});

describe("server-answer lines", () => {
  it("refundedLine names the tender", () => {
    expect(refundedLine("CASH", "$9.00")).toBe("Refunded $9.00 in cash.");
    expect(refundedLine("CARD", "$9.00")).toBe("Refunded $9.00 to the card.");
    expect(refundedLine("CHECK", "$9.00")).toBe("Refunded $9.00 by check.");
  });
  it("storeCreditAddedLine", () => {
    expect(storeCreditAddedLine("$9.00")).toBe("$9.00 added as store credit.");
  });
});
