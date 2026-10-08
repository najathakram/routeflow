import {
  PIECE_SYNONYMS as SHARED,
  isPieceSynonym as sharedIsPieceSynonym,
} from "../../../../packages/types/piece-synonyms";
import { PIECE_SYNONYMS, isPieceSynonym } from "./piece-words";
import { PIECE_LABEL } from "@routeflow/pricing";

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
});
