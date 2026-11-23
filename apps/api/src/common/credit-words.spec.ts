import { COUNTER_METHOD_LABEL } from "@routeflow/pricing";
import { CREDIT_WORDS } from "@routeflow/types";
import { CREDIT_WORDS_API } from "./credit-words";

/**
 * SA-1211 A1.4: the shared credit words and the api's mirror are equal key for key and word for word, so the owner's word
 * is one edit in each, pinned here. The receipt's method label (pricing) reads the same noun.
 */
describe("credit words: the api mirror equals the shared map (A1.4)", () => {
  it("same keys, same words", () => {
    expect(CREDIT_WORDS_API).toEqual(CREDIT_WORDS);
  });

  it("the one word is Credit", () => {
    expect(CREDIT_WORDS.noun).toBe("Credit");
    expect(CREDIT_WORDS.balance).toBe("Credit {amount}");
    expect(CREDIT_WORDS.apply).toBe("Apply {amount} credit");
    expect(CREDIT_WORDS.returnGiven).toBe("Credit given");
    expect(CREDIT_WORDS.kept).toBe("Kept as credit");
  });

  it("the receipt's credit tender reads the noun (pricing keeps a literal, pinned here)", () => {
    expect(COUNTER_METHOD_LABEL.STORE_CREDIT).toBe(CREDIT_WORDS.noun);
    expect(COUNTER_METHOD_LABEL.ADVANCE).toBe(CREDIT_WORDS.noun); // A1.7
  });
});
