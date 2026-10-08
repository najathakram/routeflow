/**
 * Words that name the smallest unit. "Piece" is always there as every product's factor-1 level, so a
 * tenant unit may never be called any of these (U-1 add and rename, U-6 backfill) and the web "More"
 * chips never offer them. ONE list: `apps/api/src/units/piece-words.ts` holds a literal copy (the API
 * never value-imports this package) pinned equal by `piece-words-parity.spec.ts`.
 * Compared as lower(trim(name)).
 */
export const PIECE_SYNONYMS: readonly string[] = ["piece", "pieces", "each", "unit", "pcs"];

/** True when `name` is Piece or one of its synonyms (case and surrounding spaces ignored). */
export const isPieceSynonym = (name: string): boolean =>
  PIECE_SYNONYMS.includes(name.trim().toLowerCase());
