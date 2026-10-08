import { unitNameKey } from "@routeflow/pricing";

/**
 * The unit-name comparison key (NFC, then trim, then case-fold) is `unitNameKey` from
 * `@routeflow/pricing`, the ONE implementation (the API imports pricing at runtime; it cannot import
 * `@routeflow/types`). Re-exported here so every unit module reaches it from one place.
 */
export { unitNameKey };

/**
 * The words that name the smallest unit ("Piece" is always there), so no tenant unit may carry one.
 * A literal copy of `packages/types/piece-synonyms.ts` (the API never value-imports
 * `@routeflow/types`, see `no-runtime-workspace-imports.spec.ts`); `piece-words-parity.spec.ts`
 * pins the two equal.
 */
export const PIECE_SYNONYMS: readonly string[] = ["piece", "pieces", "each", "unit", "pcs"];

/** True when `name` is Piece or one of its synonyms (case and surrounding spaces ignored). */
export const isPieceSynonym = (name: string): boolean => PIECE_SYNONYMS.includes(unitNameKey(name));
