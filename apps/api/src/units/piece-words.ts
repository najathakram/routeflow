/**
 * The unit-name comparison key: NFC, then trim, then case-fold. The ONE normaliser for the unit API and
 * everything that compares a unit name to a pack word or level label. Literal copy of
 * `unitNameKey` in `packages/types/piece-synonyms.ts`, pinned equal by the parity spec.
 */
export const unitNameKey = (name: string): string => name.normalize("NFC").trim().toLowerCase();

/**
 * The words that name the smallest unit ("Piece" is always there), so no tenant unit may carry one.
 * A literal copy of `packages/types/piece-synonyms.ts` (the API never value-imports
 * `@routeflow/types`, see `no-runtime-workspace-imports.spec.ts`); `piece-words-parity.spec.ts`
 * pins the two equal.
 */
export const PIECE_SYNONYMS: readonly string[] = ["piece", "pieces", "each", "unit", "pcs"];

/** True when `name` is Piece or one of its synonyms (case and surrounding spaces ignored). */
export const isPieceSynonym = (name: string): boolean => PIECE_SYNONYMS.includes(unitNameKey(name));
