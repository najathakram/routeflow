import { countFactorOf, countPieces } from "./count-pieces";
import { pluralize } from "./unit-words";

/**
 * SA-957 M2 / SA-958: the one rule for what a count's units are worth in pieces, and the one plural,
 * shared by the API's `piecesOf` and the web's preview (CLAUDE.md "no mirrors").
 */
describe("countFactorOf", () => {
  it("a pack counts its size when over 1, else one piece", () => {
    expect(countFactorOf({ kind: "pack", factorToBase: 12 })).toBe(12);
    expect(countFactorOf({ kind: "pack", factorToBase: 1 })).toBe(1);
    expect(countFactorOf({ kind: "pack", factorToBase: 0 })).toBe(1);
    expect(countFactorOf({ kind: "pack", factorToBase: Number.NaN })).toBe(1);
  });
  it("a level and the base unit count their own factor", () => {
    expect(countFactorOf({ kind: "level", factorToBase: 24 })).toBe(24);
    expect(countFactorOf({ kind: "piece", factorToBase: 1 })).toBe(1);
  });
});

describe("countPieces", () => {
  it('"3 cases + 4 boxes" on a 24 / 12 ladder is 72 + 48 = 120', () => {
    expect(
      countPieces([
        { quantity: 3, factor: 24 },
        { quantity: 4, factor: 12 },
      ]),
    ).toBe(120);
  });
  it("sums first and rounds ONCE to 3 places, half up (the movement column's scale)", () => {
    expect(countPieces([{ quantity: 1.0004, factor: 1 }])).toBe(1);
    expect(countPieces([{ quantity: 1.0005, factor: 1 }])).toBe(1.001);
    expect(countPieces([{ quantity: 0.125, factor: 1 }])).toBe(0.125);
    expect(
      countPieces([
        { quantity: 0.1, factor: 1 },
        { quantity: 0.2, factor: 1 },
      ]),
    ).toBe(0.3); // not 0.30000000000000004
  });
  it("an empty list is zero", () => {
    expect(countPieces([])).toBe(0);
  });
});

describe("the count's plural is the shared pluralize (unit-words.ts), never a second one", () => {
  it('"Case" -> "Cases", "Box" -> "Boxes", "Piece" -> "Pieces", "bag" -> "bags"', () => {
    expect(pluralize("Case")).toBe("Cases");
    expect(pluralize("Box")).toBe("Boxes");
    expect(pluralize("Piece")).toBe("Pieces");
    expect(pluralize("bag")).toBe("bags");
  });
});
