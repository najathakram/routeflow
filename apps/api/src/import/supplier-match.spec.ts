import { matchSupplier, type SupplierCandidate } from "./supplier-match";

const suppliers: SupplierCandidate[] = [
  { id: "sup-1", name: "Acme Foods" },
  { id: "sup-2", name: "Acme Foods Distribution" },
  { id: "sup-3", name: "Beta Wholesale" },
];

describe("matchSupplier", () => {
  it("matches a unique exact name, case/whitespace-insensitive", () => {
    expect(matchSupplier("  acme foods  ", suppliers)).toEqual(suppliers[0]);
  });

  it("returns null when the exact name is ambiguous (two suppliers with the same name)", () => {
    const dupes: SupplierCandidate[] = [
      { id: "a", name: "Acme Foods" },
      { id: "b", name: "acme foods" },
    ];
    expect(matchSupplier("Acme Foods", dupes)).toBeNull();
  });

  it("falls back to a unique startsWith match", () => {
    // No exact hit for "Beta Wholesale Inc"; "Beta Wholesale" is a prefix of it.
    expect(matchSupplier("Beta Wholesale Inc", suppliers)).toEqual(suppliers[2]);
  });

  it("returns null when startsWith is ambiguous", () => {
    const candidates: SupplierCandidate[] = [
      { id: "a", name: "Acme" },
      { id: "b", name: "Acme Foods" },
    ];
    // Both "Acme" and "Acme Foods" are prefixes of the detected name — no
    // exact hit exists to break the tie.
    expect(matchSupplier("Acme Foods Wholesale", candidates)).toBeNull();
  });

  it("falls back to a unique substring match (either direction)", () => {
    const single: SupplierCandidate[] = [{ id: "sup-9", name: "Wholesale" }];
    expect(matchSupplier("Beta Wholesale", single)).toEqual(single[0]);
  });

  it("returns null when substring matching is ambiguous", () => {
    const candidates: SupplierCandidate[] = [
      { id: "p", name: "XAcme FoodsY" },
      { id: "q", name: "ZAcme FoodsW" },
    ];
    // Neither name is an exact hit or a prefix/suffix relationship with the
    // detected string, but both CONTAIN it — ambiguous substring match.
    expect(matchSupplier("Acme Foods", candidates)).toBeNull();
  });

  it("returns null when nothing matches at all", () => {
    expect(matchSupplier("Totally Unknown Supplier", suppliers)).toBeNull();
  });

  it("returns null for an empty or whitespace-only detected name", () => {
    expect(matchSupplier("", suppliers)).toBeNull();
    expect(matchSupplier("   ", suppliers)).toBeNull();
  });

  it("returns null when there are no candidate suppliers at all", () => {
    expect(matchSupplier("Acme Foods", [])).toBeNull();
  });
});
