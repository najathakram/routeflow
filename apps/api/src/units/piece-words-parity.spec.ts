import {
  PIECE_SYNONYMS as SHARED,
  isPieceSynonym as sharedIsPieceSynonym,
  unitNameKey as sharedUnitNameKey,
} from "../../../../packages/types/piece-synonyms";
import { PIECE_SYNONYMS, isPieceSynonym, unitNameKey } from "./piece-words";
import { PIECE_LABEL, unitNameKey as pricingUnitNameKey } from "@routeflow/pricing";

describe("piece words: the API copy equals the shared list", () => {
  it("lists the same words in the same order", () => {
    expect([...PIECE_SYNONYMS]).toEqual([...SHARED]);
  });

  it("includes the pricing package's Piece label", () => {
    expect(PIECE_SYNONYMS).toContain(PIECE_LABEL.toLowerCase());
  });

  it.each(["Piece", " PCS ", "each", "Unit", "pieces", "Case", "", "Box"])(
    "isPieceSynonym(%j) agrees with the shared helper",
    (name) => {
      expect(isPieceSynonym(name)).toBe(sharedIsPieceSynonym(name));
    },
  );

  describe("the shared isPieceSynonym helper", () => {
    it.each(["piece", "Piece", "  PIECES ", "each", "UNIT", "\tpcs\n"])(
      "%j is a piece synonym (case and surrounding whitespace ignored)",
      (name) => {
        expect(sharedIsPieceSynonym(name)).toBe(true);
      },
    );
    it.each(["", "   ", "Case", "Box", "pc", "piece set", "units"])(
      "%j is not a piece synonym (whole word only)",
      (name) => {
        expect(sharedIsPieceSynonym(name)).toBe(false);
      },
    );
  });

  describe("unitNameKey: NFC, then trim, then case-fold (one normaliser everywhere)", () => {
    const NFC = "Caf\u00e9";
    const NFD = "Cafe\u0301";
    const TABLE: Array<[string, string]> = [
      ["Case", "case"],
      ["  CASE  ", "case"],
      ["\u00a0Each\u00a0", "each"],
      ["\tPcs\n", "pcs"],
      [NFC, "caf\u00e9"],
      [NFD, "caf\u00e9"],
      [`  ${NFD.toUpperCase()}`, "caf\u00e9"],
      ["", ""],
      ["   ", ""],
    ];
    it("the API uses pricing's implementation itself (one helper, no second copy)", () => {
      expect(unitNameKey).toBe(pricingUnitNameKey);
    });
    it.each(TABLE)("%j -> %j in pricing's helper AND the types copy", (input, key) => {
      expect(unitNameKey(input)).toBe(key);
      expect(sharedUnitNameKey(input)).toBe(key);
    });
    it("NFC and NFD spellings of one word are the same key", () => {
      expect(NFC).not.toBe(NFD);
      expect(unitNameKey(NFD)).toBe(unitNameKey(NFC));
    });
    it("the piece check goes through the same key (NBSP, NFD-wrapped input)", () => {
      for (const w of ["\u00a0Each", "Each\u00a0", "  PCS", "Pie\u0063e"]) {
        expect(isPieceSynonym(w)).toBe(true);
        expect(sharedIsPieceSynonym(w)).toBe(true);
      }
    });
  });
});
