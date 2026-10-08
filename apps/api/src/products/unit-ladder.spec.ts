import { flattenLadder, LadderError, MAX_FACTOR } from "./unit-ladder";

const fl = (base: string, levels: Array<[string, number, string | null]>) =>
  flattenLadder(
    base,
    levels.map(([label, perParent, parentLabel]) => ({ label, perParent, parentLabel })),
  );

describe("flattenLadder (chained -> flat)", () => {
  it("6 Bottle = 1 Pack, 4 Pack = 1 Case -> Case holds 24 Bottles (flat 1/6/24, perParent 6,4)", () => {
    const out = fl("Bottle", [
      ["Pack", 6, null],
      ["Case", 4, "Pack"],
    ]);
    expect(out.map((l) => [l.label, l.factorToBase, l.perParent])).toEqual([
      ["Pack", 6, 6],
      ["Case", 24, 4],
    ]);
  });

  it("resolves a child listed BEFORE its parent (order is not the dependency order)", () => {
    const out = fl("Bottle", [
      ["Case", 4, "Pack"],
      ["Pack", 6, null],
    ]);
    expect(out.find((l) => l.label === "Case")?.factorToBase).toBe(24);
  });

  it("a legacy flat ladder (Case 50, Inner 12 siblings under the base) loads as-is", () => {
    const out = fl("Piece", [
      ["Case", 50, null],
      ["Inner", 12, "Piece"],
    ]);
    expect(out.map((l) => [l.label, l.factorToBase, l.parentLabel])).toEqual([
      ["Case", 50, null],
      ["Inner", 12, null],
    ]);
  });

  it("a parent may be ANY lower level, not only the previous row (tree, not a line)", () => {
    const out = fl("Bottle", [
      ["Pack", 6, null],
      ["Tray", 4, null],
      ["Case", 3, "Pack"],
    ]);
    expect(out.find((l) => l.label === "Case")?.factorToBase).toBe(18);
  });

  it("caps a factor at 1,000,000 (409) and allows exactly 1,000,000", () => {
    expect(() =>
      fl("Bottle", [
        ["Pack", 1000, null],
        ["Pallet", 1001, "Pack"],
      ]),
    ).toThrow(LadderError);
    try {
      fl("Bottle", [
        ["Pack", 1000, null],
        ["Pallet", 1001, "Pack"],
      ]);
    } catch (e) {
      expect((e as LadderError).status).toBe(409);
      expect((e as LadderError).message).toBe(
        "That's more than 1,000,000 Bottles in one Pallet. Check the numbers.",
      );
    }
    const ok = fl("Bottle", [
      ["Pack", 1000, null],
      ["Pallet", 1000, "Pack"],
    ]);
    expect(ok[1].factorToBase).toBe(MAX_FACTOR);
  });

  it.each([[1], [0], [-3], [2.5], [Number.NaN]])(
    "rejects perParent %p (whole number, 2 or more)",
    (n) => {
      try {
        fl("Bottle", [["Pack", n as number, null]]);
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(LadderError);
        expect((e as LadderError).status).toBe(400);
        expect((e as LadderError).message).toBe("Enter a whole number, 2 or more.");
        expect((e as LadderError).field).toBe("perParent");
      }
    },
  );

  it("two levels of the same size collide (409) and name both", () => {
    try {
      fl("Bottle", [
        ["Pack", 6, null],
        ["Tray", 6, null],
      ]);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as LadderError).status).toBe(409);
      expect((e as LadderError).message).toBe(
        "Pack and Tray would both hold 6 Bottles. Change one.",
      );
    }
  });

  it("the same unit twice (case-insensitive) is refused", () => {
    expect(() =>
      fl("Bottle", [
        ["Pack", 6, null],
        ["pack", 4, "Pack"],
      ]),
    ).toThrow("Pack is already in this ladder. Use each unit once.");
  });

  it("a level named like the base is refused", () => {
    expect(() => fl("Bottle", [["bottle", 6, null]])).toThrow("Pick a bigger unit than Bottle.");
  });

  it("an unknown or circular parent is refused", () => {
    expect(() => fl("Bottle", [["Case", 4, "Ghost"]])).toThrow(LadderError);
    expect(() =>
      fl("Bottle", [
        ["A", 2, "B"],
        ["B", 2, "A"],
      ]),
    ).toThrow(LadderError);
    expect(() => fl("Bottle", [["A", 2, "A"]])).toThrow(LadderError);
  });

  it("a parent edit recomputes every descendant", () => {
    const before = fl("Bottle", [
      ["Pack", 6, null],
      ["Case", 4, "Pack"],
    ]);
    const after = fl("Bottle", [
      ["Pack", 8, null],
      ["Case", 4, "Pack"],
    ]);
    expect(before[1].factorToBase).toBe(24);
    expect(after[1].factorToBase).toBe(32);
  });
});
