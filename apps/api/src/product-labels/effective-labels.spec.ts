import { computeEffectiveCategoryIds, type LabelChainLink } from "./effective-labels";

const inc = (categoryId: string) => ({ categoryId, mode: "INCLUDE" as const });
/** An EXCLUDE pinned to the parent it was approved against (`pin`); omit for a legacy/unpinned row. */
const exc = (categoryId: string, pin?: string | null) => ({
  categoryId,
  mode: "EXCLUDE" as const,
  parentProductIdAtWrite: pin,
});
const link = (productId: string, ...assignments: LabelChainLink["assignments"]) => ({
  productId,
  assignments,
});
const ids = (chain: LabelChainLink[]) => [...computeEffectiveCategoryIds(chain)].sort();

describe("computeEffectiveCategoryIds", () => {
  it("a standalone product carries its own INCLUDE labels", () => {
    expect(ids([link("p", inc("a"), inc("b"))])).toEqual(["a", "b"]);
  });

  it("a variant inherits its parent's labels", () => {
    expect(ids([link("p", inc("a")), link("v")])).toEqual(["a"]);
  });

  it("a variant's own INCLUDE adds to the parent's", () => {
    expect(ids([link("p", inc("a")), link("v", inc("c"))])).toEqual(["a", "c"]);
  });

  it("an EXCLUDE on a standalone product (chain root) is ignored — nothing to opt out of", () => {
    expect(ids([link("p", inc("a"), exc("a", "p"))])).toEqual(["a"]);
  });

  describe("opt-out pinned to its approved parent (PC-lead ruling, option A)", () => {
    it("MATCHING pin: the opt-out removes the parent's label, keeping the rest", () => {
      expect(ids([link("p", inc("a"), inc("b")), link("v", exc("a", "p"))])).toEqual(["b"]);
    });

    it("NULL pin (legacy row / column not yet written): INERT — the label stays, the restriction applies", () => {
      expect(ids([link("p", inc("a")), link("v", exc("a", null))])).toEqual(["a"]);
    });

    it("ABSENT pin (the column does not exist yet): INERT", () => {
      expect(ids([link("p", inc("a")), link("v", exc("a"))])).toEqual(["a"]);
    });

    it("MISMATCHED pin: approved against P1 but the variant now sits under P2 which ALSO carries the label — still DENY (round-3 finding 1)", () => {
      // pin = P1; current parent = P2 (carries a) → the stale opt-out does not travel.
      expect(ids([link("P2", inc("a")), link("v", exc("a", "P1"))])).toEqual(["a"]);
    });

    it("reparented under a parent WITHOUT the label: nothing to subtract, nothing leaks", () => {
      expect(ids([link("P2", inc("b")), link("v", exc("a", "P1"))])).toEqual(["b"]);
    });

    it("three-level chain: the pin must equal the IMMEDIATE parent's id", () => {
      // v's current parent is m (which inherits a from root r); pin = m → effective; pin = r → inert.
      expect(ids([link("r", inc("a")), link("m"), link("v", exc("a", "m"))])).toEqual([]);
      expect(ids([link("r", inc("a")), link("m"), link("v", exc("a", "r"))])).toEqual(["a"]);
    });

    it("an unpinned EXCLUDE on a middle link is inert too", () => {
      expect(ids([link("r", inc("a")), link("m", exc("a", null)), link("v")])).toEqual(["a"]);
    });
  });
});
