import { BadRequestException } from "@nestjs/common";
import type { LadderUnit } from "@routeflow/pricing";
import { describeParts, piecesOf } from "./product-count";

/**
 * SA-828 (row 657): the pure unit -> pieces conversion of a product count. The factor comes from
 * the product's server ladder (resolveLineUnits), never from the client; a packed unit is counted
 * whole, and a fractional count is only for pieces.
 */
const pack12 = { unit: "Box", unitsPerBox: 12 };
const level = (label: string, factorToBase: number): LadderUnit => ({
  label,
  factorToBase,
  price: null,
  priceTier2: null,
  priceTier3: null,
  priceTier4: null,
  priceTier5: null,
});
const ladder = [level("Case", 24), level("Pallet", 480)];
const caseOf12 = [level("Case", 12)];

const pieces = (p: any, l: any, parts: Array<{ unit?: string | null; quantity: number }>) =>
  piecesOf(p, l, parts).pieces.toString();

const rejection = (fn: () => unknown): any => {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected a throw");
};

describe("piecesOf", () => {
  it("3 Case with a Case level of 12 = 36 pieces", () => {
    expect(pieces(pack12, caseOf12, [{ unit: "Case", quantity: 3 }])).toBe("36");
  });

  it("the factor is the ladder's, whatever the pack size is (Case 24 -> 2 = 48)", () => {
    expect(pieces(pack12, ladder, [{ unit: "Case", quantity: 2 }])).toBe("48");
    expect(pieces(pack12, ladder, [{ unit: "pallet", quantity: 1 }])).toBe("480");
  });

  it("no unit (or null / blank) counts the pack: 2 packs of 12 = 24", () => {
    expect(pieces(pack12, ladder, [{ quantity: 2 }])).toBe("24");
    expect(pieces(pack12, ladder, [{ unit: null, quantity: 2 }])).toBe("24");
    expect(pieces(pack12, ladder, [{ unit: " ", quantity: 2 }])).toBe("24");
    expect(pieces(pack12, ladder, [{ unit: "Box", quantity: 2 }])).toBe("24");
  });

  it("a product with no pack size counts its pack as factor 1", () => {
    expect(pieces({ unit: "Each", unitsPerBox: null }, [], [{ unit: "Each", quantity: 7 }])).toBe(
      "7",
    );
    expect(pieces({ unit: "Each", unitsPerBox: 1 }, [], [{ quantity: 7 }])).toBe("7");
  });

  it("Piece on a 12-pack is factor 1, and only a factor-1 unit may be fractional", () => {
    expect(pieces(pack12, ladder, [{ unit: "Piece", quantity: 5 }])).toBe("5");
    expect(pieces(pack12, ladder, [{ unit: "Piece", quantity: 2.5 }])).toBe("2.5");
    expect(pieces({ unit: "Each", unitsPerBox: null }, [], [{ quantity: 0.125 }])).toBe("0.125");
  });

  it("a fractional Case is refused with COUNT_FRACTIONAL_PACK and the unit's name", () => {
    const e = rejection(() => piecesOf(pack12, ladder, [{ unit: "Case", quantity: 1.5 }]));
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.getResponse()).toEqual({
      code: "COUNT_FRACTIONAL_PACK",
      message: "Count whole Cases, or count in pieces.",
    });
  });

  it("a fractional pack is refused too, named by the pack's label", () => {
    const e = rejection(() => piecesOf(pack12, ladder, [{ quantity: 0.5 }]));
    expect(e.getResponse()).toMatchObject({
      code: "COUNT_FRACTIONAL_PACK",
      message: "Count whole Boxes, or count in pieces.",
    });
  });

  it("an unknown unit is the ladder's own 400 UNIT_NOT_OFFERED", () => {
    const e = rejection(() => piecesOf(pack12, ladder, [{ unit: "Drum", quantity: 1 }]));
    expect(e).toBeInstanceOf(BadRequestException);
    expect(e.getResponse()).toMatchObject({ code: "UNIT_NOT_OFFERED" });
  });

  it("several parts sum, each converted and checked on its own (3 Case + 4 Piece)", () => {
    expect(
      pieces(pack12, caseOf12, [
        { unit: "Case", quantity: 3 },
        { unit: "Piece", quantity: 4 },
      ]),
    ).toBe("40");
    expect(() =>
      piecesOf(pack12, caseOf12, [
        { unit: "Piece", quantity: 4 },
        { unit: "Case", quantity: 0.5 },
      ]),
    ).toThrow(BadRequestException);
  });

  it('SA-828a C1: "3 cases + 4 boxes" on a 24 / 12 ladder is 72 + 48 = 120 pieces', () => {
    const each = { unit: "Piece", unitsPerBox: null };
    const ladder2412 = [level("Box", 12), level("Case", 24)];
    const r = piecesOf(each, ladder2412, [
      { unit: "Case", quantity: 3 },
      { unit: "Box", quantity: 4 },
    ]);
    expect(r.pieces.toString()).toBe("120");
    expect(r.parts.map((p) => [p.unit, p.quantity, p.factor, p.pieces.toString()])).toEqual([
      ["Case", 3, 24, "72"],
      ["Box", 4, 12, "48"],
    ]);
  });

  it("two parts that resolve to the same unit are a 400 COUNT_DUPLICATE_UNIT (at most one per level)", () => {
    for (const parts of [
      [{ unit: "Case" }, { unit: "CASE" }],
      [{ unit: null }, { unit: "Box" }], // the pack named two ways
    ]) {
      const e = rejection(() =>
        piecesOf(
          pack12,
          ladder,
          parts.map((p) => ({ ...p, quantity: 1 })),
        ),
      );
      expect(e).toBeInstanceOf(BadRequestException);
      expect(e.getResponse()).toMatchObject({ code: "COUNT_DUPLICATE_UNIT" });
    }
  });

  it("describeParts names each part with its resolved factor and the total", () => {
    const r = piecesOf(pack12, caseOf12, [
      { unit: "Case", quantity: 3 },
      { unit: "Piece", quantity: 4 },
    ]);
    expect(describeParts(r.parts, r.pieces)).toBe("3 Case (x12) + 4 Piece (x1) = 40 pieces");
  });

  it("SA-957 M2 parity table: the same fixtures the web preview is pinned to (equal pieces)", () => {
    // Mirrored literally in apps/web/lib/product-count.test.ts ("parity with the API's piecesOf").
    const each = { unit: "Each", unitsPerBox: null };
    const one = { unit: "Each", unitsPerBox: 1 };
    const ladder2412 = [level("Box", 12), level("Case", 24)];
    const table: Array<
      [string, any, any, Array<{ unit?: string | null; quantity: number }>, string]
    > = [
      ["3-place base quantity on a no-pack product", each, [], [{ quantity: 0.125 }], "0.125"],
      ["a pack of 1", one, [], [{ quantity: 7 }], "7"],
      ["a pack of null", each, [], [{ unit: "Each", quantity: 7 }], "7"],
      [
        "3 Case + 4 Box on 24 / 12",
        { unit: "Piece", unitsPerBox: null },
        ladder2412,
        [
          { unit: "Case", quantity: 3 },
          { unit: "Box", quantity: 4 },
        ],
        "120",
      ],
      [
        "the pack's own size",
        pack12,
        ladder,
        [{ quantity: 2 }, { unit: "Piece", quantity: 2.5 }],
        "26.5",
      ],
    ];
    for (const [, product, lad, parts, want] of table) {
      expect(pieces(product, lad, parts)).toBe(want);
    }
  });

  it("rounds to 3 decimal places", () => {
    expect(pieces({ unit: "Each", unitsPerBox: null }, [], [{ quantity: 1.0004 }])).toBe("1");
  });

  it("more pieces than the movement column holds is a 400, not a database error", () => {
    expect(() => piecesOf(pack12, ladder, [{ unit: "Pallet", quantity: 9_999_999 }])).toThrow(
      BadRequestException,
    );
    expect(pieces(pack12, ladder, [{ unit: "Piece", quantity: 9_999_999.999 }])).toBe(
      "9999999.999",
    );
  });
});
