import { addressStateFields } from "./address-state";

/**
 * F4 / F5 — `addressStateFields` derives the two `CustomerAddress` columns the selling-restrictions
 * engine reads (it reads ONLY `stateCode`) from the free-text `state` AND the row's `zip`, and never
 * guesses. The rules themselves are pinned to the backfill script in
 * `common/us-address-state.parity.spec.ts`; the writers that spread this are pinned in
 * `customers.address-state-writers.spec.ts` and `import/import-address-state.spec.ts`.
 */
const fields = (state: string | null | undefined, zip: string | null = null) =>
  addressStateFields(state, zip);
const RESOLVED = (stateCode: string) => ({ stateCode, stateNeedsReview: false });
const UNRESOLVED = { stateCode: null, stateNeedsReview: true };

describe("addressStateFields", () => {
  it.each([
    ["Texas", "TX"],
    ["texas", "TX"],
    [" TX ", "TX"],
    ["tx", "TX"],
    ["New York", "NY"],
    ["colorado", "CO"],
    ["Calif.", "CA"],
    ["TX 77001", "TX"],
    ["Texas, USA", "TX"],
  ])("%j resolves to %s with no zip, and needs no review", (state, code) => {
    expect(fields(state)).toEqual(RESOLVED(code));
  });

  it.each([["Tejas"], ["Unknown"], [""], ["   "], ["N/A"], [null], [undefined]])(
    "%j is never guessed: null + flagged for review (fail closed in the engine, still creatable)",
    (state) => {
      expect(fields(state as string | null | undefined)).toEqual(UNRESOLVED);
    },
  );

  it("a zip that CONTRADICTS the resolved state is unresolved, never a written guess (ZIP_CONFLICT)", () => {
    expect(fields("Texas", "10001")).toEqual(UNRESOLVED); // a New York zip
    expect(fields("Texas", "78701")).toEqual(RESOLVED("TX"));
    expect(fields("TX 10001")).toEqual(UNRESOLVED); // the zip written inside the text counts too
  });
});

describe("an AMBIGUOUS name resolves ONLY with a confirming civilian zip (lead ruling, #988)", () => {
  // name, a zip that CONFIRMS it, the code it resolves to
  const cases: Array<[string, string, string]> = [
    ["Washington", "98101", "WA"],
    ["Kansas", "66101", "KS"],
    ["Indiana", "46201", "IN"],
    ["Delaware", "19901", "DE"],
    ["Oregon", "97201", "OR"],
    ["Nevada", "89101", "NV"],
    ["Wyoming", "82001", "WY"],
    ["Virginia", "23219", "VA"],
    ["California", "90210", "CA"],
    ["Louisiana", "70112", "LA"],
    ["Florida", "33101", "FL"],
    ["Georgia", "30301", "GA"],
  ];

  it.each(cases)(
    "%s alone is UNRESOLVED; with a confirming zip (%s) it is %s",
    (name, zip, code) => {
      for (const text of [name, name.toUpperCase(), ` ${name.toLowerCase()} `])
        expect(fields(text)).toEqual(UNRESOLVED); // no zip: never a guess
      expect(fields(name, "")).toEqual(UNRESOLVED);
      expect(fields(name, zip)).toEqual(RESOLVED(code));
      expect(fields(`${name} ${zip}`)).toEqual(RESOLVED(code)); // a zip written inside the text confirms too
    },
  );

  it("a DC zip never confirms Washington (a conflict), and blank / invalid / military / unassigned zips never confirm", () => {
    expect(fields("Washington", "20001")).toEqual(UNRESOLVED);
    for (const zip of ["09001", "34001", "96201", "00100", "9810", "abcde"])
      expect(fields("Washington", zip)).toEqual(UNRESOLVED);
  });

  it("a bare 2-letter code is never ambiguous, and an unambiguous name still resolves", () => {
    expect(fields("LA")).toEqual(RESOLVED("LA"));
    expect(fields("WA")).toEqual(RESOLVED("WA"));
    expect(fields("Texas")).toEqual(RESOLVED("TX"));
    expect(fields("West Virginia")).toEqual(RESOLVED("WV"));
  });
});
