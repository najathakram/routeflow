import { ancestorChain, parentChainCarries, type InheritanceState } from "./parent-carries";

/**
 * "Variants follow the parent" — the pure chain rule (the engine's computeEffectiveCategoryIds on the chain ending at
 * the PARENT). An unresolvable chain (a cycle, a missing link, deeper than the engine's 5-ancestor cap) is NOT
 * inheriting: the product gets its own row, so the label applies either way.
 */
const L = "cat-L";
const state = (
  links: Array<[string, string | null]>,
  rows: Array<[string, "INCLUDE" | "EXCLUDE", (string | null)?]> = [],
): InheritanceState => ({
  parentOf: new Map(links),
  rows: new Map(
    rows.map(([id, mode, pin]) => [
      id,
      [{ categoryId: L, mode, parentProductIdAtWrite: pin ?? null }],
    ]),
  ),
});

describe("parentChainCarries", () => {
  it("a variant under a parent carrying the label inherits it; a root never does", () => {
    const s = state(
      [
        ["p", null],
        ["v", "p"],
      ],
      [["p", "INCLUDE"]],
    );
    expect(parentChainCarries(s, "v", L)).toBe(true);
    expect(parentChainCarries(s, "p", L)).toBe(false);
  });

  it("a grandparent's label reaches the grandchild; `planned` counts as carrying", () => {
    const s = state([
      ["g", null],
      ["p", "g"],
      ["v", "p"],
    ]);
    expect(parentChainCarries(s, "v", L)).toBe(false);
    expect(parentChainCarries(s, "v", L, new Set(["g"]))).toBe(true);
  });

  it("the parent's own pinned opt-out stops it reaching the variant", () => {
    const s = state(
      [
        ["g", null],
        ["p", "g"],
        ["v", "p"],
      ],
      [
        ["g", "INCLUDE"],
        ["p", "EXCLUDE", "g"],
      ],
    );
    expect(parentChainCarries(s, "v", L)).toBe(false);
  });

  it("a CYCLE is unresolvable: not inheriting", () => {
    const s = state(
      [
        ["a", "b"],
        ["b", "a"],
        ["v", "a"],
      ],
      [["a", "INCLUDE"]],
    );
    expect(parentChainCarries(s, "v", L)).toBe(false);
  });

  it("a MISSING link (a parent the map does not know) is unresolvable: not inheriting", () => {
    const s = state([["v", "ghost"]]);
    expect(parentChainCarries(s, "v", L, new Set(["ghost"]))).toBe(false);
  });

  it("the CAP: 5 ancestors resolve, a 6th makes the chain unresolvable", () => {
    // a1 (root, labelled) <- a2 <- a3 <- a4 <- a5 <- v : v has exactly 5 ancestors
    const five = state(
      [
        ["a1", null],
        ["a2", "a1"],
        ["a3", "a2"],
        ["a4", "a3"],
        ["a5", "a4"],
        ["v", "a5"],
      ],
      [["a1", "INCLUDE"]],
    );
    expect(parentChainCarries(five, "v", L)).toBe(true);
    // one more level: v has 6 ancestors -> unresolvable
    const six = state(
      [
        ["a0", null],
        ["a1", "a0"],
        ["a2", "a1"],
        ["a3", "a2"],
        ["a4", "a3"],
        ["a5", "a4"],
        ["v", "a5"],
      ],
      [["a0", "INCLUDE"]],
    );
    expect(parentChainCarries(six, "v", L)).toBe(false);
  });
});

describe("ancestorChain", () => {
  it("nearest first, stops at a cycle, at an unknown link, and at the cap", () => {
    const m = new Map<string, string | null>([
      ["a", null],
      ["b", "a"],
      ["v", "b"],
    ]);
    expect(ancestorChain(m, "v")).toEqual(["b", "a"]);
    expect(
      ancestorChain(
        new Map([
          ["x", "y"],
          ["y", "x"],
          ["v", "x"],
        ]),
        "v",
      ),
    ).toEqual(["x", "y"]);
    expect(ancestorChain(new Map([["v", "ghost"]]), "v")).toEqual(["ghost"]);
    const deep = new Map<string, string | null>([
      ["a1", null],
      ["a2", "a1"],
      ["a3", "a2"],
      ["a4", "a3"],
      ["a5", "a4"],
      ["a6", "a5"],
      ["v", "a6"],
    ]);
    expect(ancestorChain(deep, "v")).toEqual(["a6", "a5", "a4", "a3", "a2"]);
  });
});
