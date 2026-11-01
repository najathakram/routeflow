/**
 * SA-957 M2 / SA-958: what a product count's units are worth in pieces, in ONE place. The API's
 * `piecesOf` (which keeps its locks, refusals and Decimal) and the web's Count / Adjust preview both
 * take their factor and their sum from here, so the number a person sees is the number the server writes.
 */

/** The unit shapes a count can name: the pack, a ladder level, or the base unit. */
export interface CountFactorOption {
  kind: "pack" | "piece" | "level";
  /** Pieces per ONE of this unit as the ladder reports it (a pack's may be 0 / null-ish). */
  factorToBase: number;
}

/** A pack counts its size when over 1, else one piece; a level and the base unit count their own factor. */
export function countFactorOf(option: CountFactorOption): number {
  if (option.kind === "pack") {
    return Number.isFinite(option.factorToBase) && option.factorToBase > 1
      ? option.factorToBase
      : 1;
  }
  return option.factorToBase;
}

/**
 * The pieces in `parts`: each part's quantity x factor, summed, rounded ONCE to 3 places half up (the
 * StockMovement.quantity scale; matches `Prisma.Decimal.toDecimalPlaces(3)` on the API side). Unsigned.
 */
export function countPieces(parts: ReadonlyArray<{ quantity: number; factor: number }>): number {
  const sum = parts.reduce((total, p) => total + p.quantity * p.factor, 0);
  // toPrecision first: it drops binary float noise (0.1 + 0.2) before the half-up step.
  const scaled = Number((Math.abs(sum) * 1000).toPrecision(12));
  return (Math.sign(sum) * Math.floor(scaled + 0.5)) / 1000;
}
