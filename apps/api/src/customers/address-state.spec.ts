import { addressStateFields } from "./address-state";

/**
 * F4 — `addressStateFields` derives the two `CustomerAddress` columns the selling-restrictions
 * engine reads (it reads ONLY `stateCode`) from the free-text `state`. The writers that spread it
 * are pinned in `customers.address-state-writers.spec.ts`.
 */
describe("addressStateFields", () => {
  it.each([
    ["Texas", "TX"],
    ["texas", "TX"],
    [" TX ", "TX"],
    ["tx", "TX"],
    ["New York", "NY"],
    ["california", "CA"],
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
