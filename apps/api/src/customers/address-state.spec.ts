import { addressStateFields } from "./address-state";

/**
 * F4 — `addressStateFields` derives the two `CustomerAddress` columns the selling-restrictions
 * engine reads (it reads ONLY `stateCode`) from the free-text `state`, and never guesses: an
 * AMBIGUOUS text ("Washington", "Oregon", ...) is unresolved. The writers that spread it are pinned
 * in `customers.address-state-writers.spec.ts`.
 */
describe("addressStateFields", () => {
  it.each([
    ["Texas", "TX"],
    ["texas", "TX"],
    [" TX ", "TX"],
    ["tx", "TX"],
    ["New York", "NY"],
    ["colorado", "CO"],
  ])("%j resolves to %s and needs no review", (state, code) => {
    expect(addressStateFields(state)).toEqual({ stateCode: code, stateNeedsReview: false });
  });

  it.each([["Tejas"], ["Unknown"], [""], ["   "], ["N/A"], [null], [undefined]])(
    "%j is never guessed: null + flagged for review (fail closed in the engine, still creatable)",
    (state) => {
      expect(addressStateFields(state as string | null | undefined)).toEqual({
        stateCode: null,
        stateNeedsReview: true,
      });
    },
  );
});

describe("addressStateFields never guesses an AMBIGUOUS name (lead ruling, #988)", () => {
  const exactNames = [
    "Washington",
    "Kansas",
    "Indiana",
    "Delaware",
    "Oregon",
    "Nevada",
    "Wyoming",
    "Virginia",
    "California",
    "Louisiana",
    "Florida",
    "Georgia",
  ];

  it.each(exactNames)(
    "%s alone is UNRESOLVED (null + needs review): a city of that name exists elsewhere",
    (name) => {
      for (const text of [name, name.toUpperCase(), ` ${name.toLowerCase()} `])
        expect(addressStateFields(text)).toEqual({ stateCode: null, stateNeedsReview: true });
    },
  );

  it("a bare 2-letter code is never ambiguous, and an unambiguous name still resolves", () => {
    expect(addressStateFields("LA")).toEqual({ stateCode: "LA", stateNeedsReview: false });
    expect(addressStateFields("WA")).toEqual({ stateCode: "WA", stateNeedsReview: false });
    expect(addressStateFields("Texas")).toEqual({ stateCode: "TX", stateNeedsReview: false });
    expect(addressStateFields("West Virginia")).toEqual({
      stateCode: "WV",
      stateNeedsReview: false,
    });
  });
});
