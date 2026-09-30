import { MoneyInvariantError } from "./money-invariants";
import { displayComponentUnitPrice } from "./component-price";

export interface ComponentPiecesInput {
  componentProductId: string;
  /** Whole pieces of this component on the ORDER line (they sum to the line's pieces). */
  qty: number;
}

/** The first `count` picks of the deterministic pick sequence for `comps`, per component. */
function picksThrough(comps: ComponentPiecesInput[], count: number): number[] {
  const total = comps.reduce((a, c) => a + c.qty, 0);
  const picked = comps.map(() => 0);
  for (let k = 1; k <= count; k++) {
    let best = -1;
    let bestDeficit = 0;
    for (let i = 0; i < comps.length; i++) {
      if (picked[i] >= comps[i].qty) continue;
      // deficit x total, in integers: qty*k - picked*total (the quota is qty*k/total).
      const deficit = comps[i].qty * k - picked[i] * total;
      if (
        best < 0 ||
        deficit > bestDeficit ||
        (deficit === bestDeficit && comps[i].qty > comps[best].qty)
      ) {
        best = i;
        bestDeficit = deficit;
      }
    }
    picked[best] += 1;
  }
  return picked;
}

/**
 * #2717 M3 (SA-572 A2, SA-579 Q7): the pieces of each component on ONE invoice bill of a FIXED
 * order line. `comps` are the order line's components (whole pieces, summing to the line's
 * pieces), `prior` the pieces billed by earlier invoices and `bill` the pieces billed now
 * (integers >= 0, prior + bill <= the line's pieces).
 *
 * The result is `through(prior + bill) - through(prior)` where `through(c)` is the first c picks
 * of ONE fixed pick sequence: every step picks the component furthest below its exact share
 * (qty * k / total), ties to the larger component then the lower index (largest remainder, made
 * cumulative). A prefix of one sequence is monotone, so no part is ever negative or above its
 * component, each bill sums to `bill`, the bills telescope to the order components exactly, a
 * full bill copies them verbatim and a whole-box partial of an untouched line is per-box x boxes.
 * A delivery shortfall never blocks invoicing (Q7). Pieces only, display only (I5). Throws
 * MoneyInvariantError on bad input or a bill past the order's pieces.
 */
export function allocateComponentPieces(input: {
  comps: ComponentPiecesInput[];
  prior: number;
  bill: number;
}): ComponentPiecesInput[] {
  const { comps, prior, bill } = input;
  for (const [label, n] of [
    ["prior", prior],
    ["bill", bill],
  ] as const) {
    if (!Number.isInteger(n) || n < 0) {
      throw new MoneyInvariantError(`${label} pieces must be an integer >= 0 (got ${n})`);
    }
  }
  if (comps.some((c) => !Number.isInteger(c.qty) || c.qty < 0)) {
    throw new MoneyInvariantError("component pieces must be integers >= 0");
  }
  const total = comps.reduce((a, c) => a + c.qty, 0);
  if (prior + bill > total) {
    throw new MoneyInvariantError(
      `prior ${prior} + bill ${bill} exceeds the line's ${total} pieces`,
    );
  }
  if (bill === 0) return comps.map((c) => ({ ...c, qty: 0 }));
  const before = picksThrough(comps, prior);
  const after = picksThrough(comps, prior + bill);
  return comps.map((c, i) => ({ ...c, qty: after[i] - before[i] }));
}

export interface ComponentSubLineInput {
  name: string;
  qty: number;
  unitSku?: string | null;
  unitBarcode?: string | null;
  /** The STORED 4-dp price (null = none). Shown as roundMoney(stored), never re-derived. */
  displayUnitPrice4?: number | null;
}

/** "$0.63 (included)" from the stored 4-dp price, or "(included)" with none. */
export function componentPriceText(displayUnitPrice4: number | null | undefined): string {
  if (displayUnitPrice4 == null || !Number.isFinite(displayUnitPrice4)) return "(included)";
  return `$${displayComponentUnitPrice(displayUnitPrice4).toFixed(2)} (included)`;
}

/**
 * The ONE text of a composed-line sub-line (L-225): web, mobile and the PDF all print this, so a
 * change is one edit. "<name> x <pieces> | SKU <sku> | <barcode> | $<price> (included)".
 */
export function componentSubLineText(c: ComponentSubLineInput): string {
  const parts = [`${c.name} x ${c.qty}`];
  if (c.unitSku) parts.push(`SKU ${c.unitSku}`);
  if (c.unitBarcode) parts.push(c.unitBarcode);
  parts.push(componentPriceText(c.displayUnitPrice4));
  return parts.join(" | ");
}
