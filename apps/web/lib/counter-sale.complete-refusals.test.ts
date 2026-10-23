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
      "Nothing changed. This customer is over their credit limit ($120.00 of $50.00). Take payment now, or record a payment first.",
    );
    expect(pickupCompleteErrorCopy(refusal(409, { code: "CREDIT_LIMIT_EXCEEDED" }))).toBe(
      "Nothing changed. This customer is over their credit limit. Take payment now, or record a payment first.",
    );
  });

  it("a selling restriction at the store", () => {
    expect(pickupCompleteErrorCopy(refusal(409, { code: "SELLING_RESTRICTED" }))).toBe(
      "Nothing changed. An item on this order can't be sold at the store. Edit the order, or deliver it.",
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
