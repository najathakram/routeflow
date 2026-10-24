import { pickupCompleteErrorCopy } from "./counter-sale";

/**
 * #3689 review MUST 4 + NIT: "Complete at counter" refusals each get their own fixed copy (never the server's message). The
 * credit refusal is judged before the first write (SA-905 MUST 1), so every one of these says nothing changed. In complete
 * mode the shared lines never say "pickup".
 */
const refusal = (status: number, data: Record<string, unknown>) => ({ response: { status, data } });

describe("pickupCompleteErrorCopy: Complete at counter refusals (I-120)", () => {
  it("the business does not hand orders over at the store", () => {
    expect(pickupCompleteErrorCopy(refusal(409, { code: "COUNTER_COMPLETE_UNAVAILABLE" }))).toBe(
      "Nothing changed. This business doesn't hand orders over at the store.",
    );
  });

  it("over the credit limit, with the server's figures", () => {
    expect(
      pickupCompleteErrorCopy(
        refusal(409, { code: "CREDIT_LIMIT_EXCEEDED", limit: 50, exposure: 120 }),
      ),
    ).toBe(
      "This customer is over their credit limit ($120.00 of $50.00). Take payment now, or record a payment first.",
    );
    expect(pickupCompleteErrorCopy(refusal(409, { code: "CREDIT_LIMIT_EXCEEDED" }))).toBe(
      "This customer is over their credit limit. Take payment now, or record a payment first.",
    );
  });

  it("a selling restriction at the store", () => {
    expect(pickupCompleteErrorCopy(refusal(409, { code: "SELLING_RESTRICTED" }))).toBe(
      "An item on this order can't be sold at the store. Edit the order, or deliver it.",
    );
  });

  it("on an active delivery run", () => {
    expect(pickupCompleteErrorCopy(refusal(400, { code: "ORDER_ON_ACTIVE_RUN" }))).toBe(
      "Nothing changed. This order is on an active delivery run. Remove it from the run first.",
    );
  });

  it("complete mode never says pickup", () => {
    const complete = (code?: string) =>
      pickupCompleteErrorCopy(refusal(409, code ? { code } : {}), undefined, true);
    expect(complete()).toBe("Couldn't complete the order. Check it and try again.");
    expect(complete("PICKUP_NOT_READY")).toBe(
      "This order can't be completed now: it's a draft, part-delivered, or cancelled.",
    );
    expect(complete("PICKUP_KEY_CONFLICT")).toBe(
      "Already completed. Record any payment on the invoice.",
    );
    for (const code of [undefined, "PICKUP_NOT_READY", "PICKUP_KEY_CONFLICT"])
      expect(complete(code)).not.toMatch(/pick(ed)? ?up/i);
  });

  it("the hand-over keeps its own words", () => {
    expect(pickupCompleteErrorCopy(refusal(409, { code: "PICKUP_NOT_READY" }))).toBe(
      "This order isn't ready for pickup yet. Confirm it and mark it ready first.",
    );
  });
});

// I-120 R8/R9 (owner 7a): the new refusals get their own fixed copy too (never the server's message).
describe("pickupCompleteErrorCopy: R8/R9 refusals (owner 7a)", () => {
  const refusal = (data: Record<string, unknown>) => ({ response: { status: 409, data } });
  it("shipped with the carrier (Q2 = A)", () => {
    expect(pickupCompleteErrorCopy(refusal({ code: "COUNTER_COMPLETE_SHIPPED" }))).toBe(
      "Nothing changed. This order has shipped with the carrier.",
    );
  });
  it("on a driver's run, naming the driver (Q1 = A)", () => {
    expect(
      pickupCompleteErrorCopy(refusal({ code: "COUNTER_COMPLETE_ON_RUN", driverName: "Sam" })),
    ).toBe("This order is on Sam's run. Completing it here takes it off the run.");
    expect(pickupCompleteErrorCopy(refusal({ code: "COUNTER_COMPLETE_ON_RUN" }))).toBe(
      "This order is on a delivery run. Completing it here takes it off the run.",
    );
  });
  // W-776 (SA-925): the pre-check's closed day says nothing changed; the post-claim code keeps "Handed over"
  it("a closed day refused before any write says nothing changed, not handed over", () => {
    expect(pickupCompleteErrorCopy(refusal({ code: "COUNTER_COMPLETE_DAY_CLOSED" }), 25)).toBe(
      "Nothing changed. This register's day is closed. A manager or owner can reopen it on the till.",
    );
    expect(pickupCompleteErrorCopy(refusal({ code: "COUNTER_SALE_DAY_CLOSED" }), 25)).toBe(
      "Handed over. $25.00 still due.",
    );
  });
  it("the driver has started the stop", () => {
    expect(pickupCompleteErrorCopy(refusal({ code: "COUNTER_COMPLETE_STOP_STARTED" }))).toBe(
      "Nothing changed. The driver has started this stop. Finish it on the route.",
    );
  });
});
