import { MoneyInvariantError } from "./money-invariants";
import { displayComponentUnitPrice } from "./component-price";

export interface ComponentPiecesInput {
  componentProductId: string;
  /** Whole pieces of this component on the ORDER line (they sum to the line's pieces). */
  qty: number;
}

/**
 * #2717 M3 (SA-572 A2, SA-579 Q7): the pieces of each component on ONE invoice bill of a FIXED
 * order line. `comps` are the order line's components, `billed[i]` the pieces of `comps[i]`
 * already billed on earlier invoices, `bill` the pieces billed now (an integer >= 0).
 *
 * The bill is split over what is still unbilled (weight = unbilled pieces) by largest remainder
 * (remainder desc, then weight desc, then index asc): a full bill of what is left copies the
 * unbilled components verbatim, a whole-box partial of an untouched line is per-box x boxes,
 * and because each part is capped by its unbilled pieces the bills telescope back to the order
 * components exactly. A delivery shortfall never blocks invoicing (Q7). Display only: these are
 * pieces, never money (I5). Throws MoneyInvariantError on a bad input or a bill above the
 * unbilled total.
 */
export function allocateComponentPieces(input: {
  comps: ComponentPiecesInput[];
  billed: number[];
  bill: number;
}): ComponentPiecesInput[] {
  const { comps, billed, bill } = input;
  if (!Number.isInteger(bill) || bill < 0) {
    throw new MoneyInvariantError(`bill pieces must be an integer >= 0 (got ${bill})`);
  }
  if (billed.length !== comps.length) {
    throw new MoneyInvariantError("billed must have one entry per component");
  }
  const unbilled = comps.map((c, i) => {
    const left = c.qty - billed[i];
    if (!Number.isInteger(c.qty) || !Number.isInteger(billed[i]) || billed[i] < 0 || left < 0) {
      throw new MoneyInvariantError(`component ${c.componentProductId} has invalid pieces`);
    }
    return left;
  });
  const total = unbilled.reduce((a, w) => a + w, 0);
  if (bill > total) {
    throw new MoneyInvariantError(`bill ${bill} exceeds the ${total} unbilled pieces`);
  }
  if (bill === 0 || total === 0) return comps.map((c) => ({ ...c, qty: 0 }));
  const shares = unbilled.map((w, index) => {
    const num = bill * w;
    return { index, w, floor: Math.floor(num / total), rem: num % total };
  });
  let leftover = bill - shares.reduce((a, s) => a + s.floor, 0);
  const order = [...shares].sort((a, b) => b.rem - a.rem || b.w - a.w || a.index - b.index);
  const out = shares.map((s) => s.floor);
  for (let i = 0; leftover > 0; i++, leftover--) out[order[i].index] += 1;
  return comps.map((c, i) => ({ ...c, qty: out[i] }));
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
