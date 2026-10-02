import { MoneyInvariantError } from "./money-invariants";
import { creditedThrough, isWholeCents, roundMoney } from "./pricing";

const toCents = (n: number): number => Math.round(roundMoney(n) * 100);

/**
 * #2717 (SA-572 A2 / I7): split `total` into whole-cent parts proportional to integer
 * `weights` so the parts sum EXACTLY to `total` (largest-remainder; per-part roundMoney can
 * drift a cent). Works in integer cents. Leftover cents go by remainder desc, then weight desc,
 * then index asc.
 *
 * Total 0 gives zeros. Throws MoneyInvariantError on a negative or non-finite total, a total that
 * is not whole cents (a sub-cent 0.005, a 10.005: refused, never silently rounded), a negative,
 * non-finite or non-integer weight, or a positive total with no positive weight.
 */
export function allocateCentsLargestRemainder(total: number, weights: number[]): number[] {
  if (!Number.isFinite(total) || total < 0) {
    throw new MoneyInvariantError(`allocation total must be a finite amount >= 0 (got ${total})`);
  }
  if (!isWholeCents(total)) {
    throw new MoneyInvariantError(`allocation total must be whole cents (got ${total})`);
  }
  for (const w of weights) {
    if (!Number.isInteger(w) || w < 0) {
      throw new MoneyInvariantError(`allocation weights must be integers >= 0 (got ${w})`);
    }
  }
  const cents = toCents(total);
  if (cents === 0) return weights.map(() => 0);
  const sumW = weights.reduce((a, w) => a + w, 0);
  if (!(sumW > 0)) {
    throw new MoneyInvariantError("cannot allocate a positive total over zero weight");
  }
  const shares = weights.map((w, index) => {
    const num = cents * w;
    return { index, w, floor: Math.floor(num / sumW), rem: num % sumW };
  });
  let leftover = cents - shares.reduce((a, s) => a + s.floor, 0);
  const order = [...shares].sort((a, b) => b.rem - a.rem || b.w - a.w || a.index - b.index);
  const out = shares.map((s) => s.floor);
  for (let i = 0; leftover > 0; i++, leftover--) out[order[i].index] += 1;
  return out.map((c) => c / 100);
}

export interface ComponentCreditInput {
  /** The stored (source) line subtotal S — a whole-cent amount >= 0. */
  storedSubtotal: number;
  /** Total pieces on the line, P (integer > 0). */
  linePieces: number;
  /** Pieces already credited before this event (integer >= 0). */
  priorPieces: number;
  /** Pieces returned this event, per component (integers >= 0). */
  parts: number[];
}

export interface ComponentCredit {
  /** The event's credit, whole cents. */
  total: number;
  /** `total` split across `parts` by largest remainder; sums to `total`. */
  parts: number[];
}

/**
 * #2717 (I7, SA-574 H2): credit for returning `parts` pieces of a line, on a LINEAR
 * cumulative basis over the stored subtotal: creditedThrough(c) = roundMoney(S * c / P); event
 * total = creditedThrough(prior + now) - creditedThrough(prior). Monotone, never negative, and
 * the events sum to S exactly at c = P. With no free units and prior = 0 it equals
 * `prorateLineSubtotal(S, now, P)`. Deliberately NOT built on `prorateLineSubtotal`'s free-unit
 * path, which is non-monotone.
 *
 * Throws MoneyInvariantError on a negative/non-finite or non-whole-cents subtotal, linePieces not an integer > 0,
 * a negative or non-integer prior or part, or prior + sum(parts) > linePieces.
 */
export function prorateComponentCredit(input: ComponentCreditInput): ComponentCredit {
  const { storedSubtotal, linePieces, priorPieces, parts } = input;
  if (!Number.isFinite(storedSubtotal) || storedSubtotal < 0) {
    throw new MoneyInvariantError(
      `stored subtotal must be a finite amount >= 0 (got ${storedSubtotal})`,
    );
  }
  if (!isWholeCents(storedSubtotal)) {
    throw new MoneyInvariantError(`stored subtotal must be whole cents (got ${storedSubtotal})`);
  }
  if (!Number.isInteger(linePieces) || linePieces <= 0) {
    throw new MoneyInvariantError(`linePieces must be an integer > 0 (got ${linePieces})`);
  }
  if (!Number.isInteger(priorPieces) || priorPieces < 0) {
    throw new MoneyInvariantError(`priorPieces must be an integer >= 0 (got ${priorPieces})`);
  }
  for (const p of parts) {
    if (!Number.isInteger(p) || p < 0) {
      throw new MoneyInvariantError(`piece counts must be integers >= 0 (got ${p})`);
    }
  }
  const now = parts.reduce((a, p) => a + p, 0);
  if (priorPieces + now > linePieces) {
    throw new MoneyInvariantError(
      `credited pieces ${priorPieces + now} exceed the line's ${linePieces}`,
    );
  }
  const through = (c: number) => creditedThrough(storedSubtotal, c, linePieces);
  const total = roundMoney(through(priorPieces + now) - through(priorPieces));
  return { total, parts: allocateCentsLargestRemainder(total, parts) };
}
