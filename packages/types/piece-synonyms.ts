/**
 * The comparison key of a unit name: NFC-normalise, THEN trim, THEN case-fold. ONE normaliser for
 * every place a unit name is stored (TenantUnit.nameKey), looked up, or compared (rename, pack word,
 * level collisions, piece synonyms, the web duplicate check), so "Cafe"+U+0301 and U+00E9 are one word.
 * The implementation the API and the money math use is `unitNameKey` in `packages/pricing`
 * (`unit-levels.ts`; pricing may only import types for types, so this copy is literal), pinned equal by
 * `apps/api/src/units/piece-words-parity.spec.ts`. The SQL side (`normalize(x, NFC)` + lower + btrim)
 * mirrors it in `units.service.ts`.
 */
export const unitNameKey = (name: string): string => name.normalize("NFC").trim().toLowerCase();

/**
 * Words that name the smallest unit. "Piece" is always there as every product's factor-1 level, so a
 * tenant unit may never be called any of these (U-1 add and rename, U-6 backfill) and the web "More"
 * chips never offer them. ONE list: `apps/api/src/units/piece-words.ts` holds a literal copy (the API
 * never value-imports this package) pinned equal by `piece-words-parity.spec.ts`.
 * Compared as `unitNameKey(name)`.
 */
export const PIECE_SYNONYMS: readonly string[] = ["piece", "pieces", "each", "unit", "pcs"];

/** True when `name` is Piece or one of its synonyms (case and surrounding spaces ignored). */
export const isPieceSynonym = (name: string): boolean => PIECE_SYNONYMS.includes(unitNameKey(name));
