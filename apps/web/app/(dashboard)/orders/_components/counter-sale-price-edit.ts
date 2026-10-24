import {
  decideStaffOverride,
  isSpecialTier,
  roundMoney,
  showOriginalPrice,
} from "@routeflow/pricing";
import {
  lineTotalAt,
  priceEditChip,
  typedPriceEditChip,
  type PriceEditLine,
} from "@/lib/counter-price-edit";
import type { CounterPriceEdit } from "./CounterLinePriceEdit";
import type { SaleLine } from "./counter-sale-scan";

/**
 * POS-5: pure cart operations for an edited price. The server stores ONE net unit price per line, so an edit is
 * `unitPrice` = the net, `tierPrice` = the system price for this customer, and `override` = what was chosen. Every
 * line total is `computeLineSubtotal` (through `lineTotalAt` / `cartTotals`), never qty x unitPrice.
 */

/** The system price for this customer on a line: the stored `tierPrice` when edited, else its own `unitPrice`. */
export const lineTierPrice = (l: SaleLine): number =>
  l.override ? (l.tierPrice ?? l.unitPrice) : l.unitPrice;

/** What the price dialog needs to know about a line. `tier` is the customer's tier for this product. */
export function priceEditLineOf(l: SaleLine, tier: number): PriceEditLine {
  const tierPrice = lineTierPrice(l);
  return {
    tierPrice,
    listPrice: l.listPrice ?? tierPrice,
    tier,
    // S19b: the layer's special flag when the layer priced the line (flag on); else the dialog reads the tier.
    ...(l.special !== undefined ? { isSpecial: l.special } : {}),
    qty: l.qty,
    boxes: l.boxes,
    pieces: l.pieces,
    unitsPerBox: l.unitsPerBox,
  };
}

/** The line without any edited-price state (a plain line again, priced at `unitPrice`). */
function plainLine(l: SaleLine, unitPrice: number): SaleLine {
  const { override: _o, tierPrice: _t, priceEdited: _e, ...rest } = l;
  return { ...rest, unitPrice };
}

/**
 * Apply one dialog result to one line. It REPLACES any earlier edit (never stacks: the percent / amount were taken
 * from the tier price). A result within 1/2 cent of the tier price (`override: false`) returns a plain line.
 */
export function applyPriceEdit(
  lines: readonly SaleLine[],
  tempId: string,
  edit: CounterPriceEdit,
): SaleLine[] {
  return lines.map((l) => {
    if (l.tempId !== tempId) return l;
    const tier = lineTierPrice(l);
    const plain = plainLine(l, tier);
    if (!edit.override) return plain;
    return {
      ...plain,
      unitPrice: edit.unitPrice,
      tierPrice: tier,
      priceEdited: true,
      override: {
        mode: edit.mode,
        value: edit.value,
        ...(edit.reason ? { reason: edit.reason } : {}),
      },
    };
  });
}

/** `Reset price`: the line goes back to the system price, with no marker. */
export function resetPriceEdit(lines: readonly SaleLine[], tempId: string): SaleLine[] {
  return lines.map((l) => (l.tempId === tempId && l.override ? plainLine(l, lineTierPrice(l)) : l));
}

export interface EditedLineFigures {
  /** the line total at the LIST price (the struck figure, the receipt's reference); null when nothing is struck */
  original: number | null;
  /** the line total at the net price */
  net: number;
  /** money taken off the LIST total; 0 when nothing is struck (a raised price, no known list, or the tenant hides original prices) */
  discount: number;
  chip: string;
}

/**
 * Does the cart strike the catalogue (LIST) price beside this line's unit price? Row 322d: the SAME decision the receipt makes
 * (pricing's `showOriginalPrice`, with the tenant's `invoice.hideOriginalPrice`) and only when the price was LOWERED below
 * the list: the cart's old private rule is gone. A line with no known list price strikes nothing.
 */
export function cartStrikesList(
  l: Pick<SaleLine, "unitPrice" | "listPrice">,
  hideOriginalPrice = false,
): boolean {
  if (l.listPrice === undefined || !(l.unitPrice < l.listPrice)) return false;
  return showOriginalPrice(
    { unitPrice: l.unitPrice, originalPrice: l.listPrice },
    hideOriginalPrice,
  );
}

/**
 * The ONE list-measured figure set of a line, for EVERY struck line (edited or not): the line total at the LIST price, at the
 * net price, and the money between them. This is what the receipt strikes and sums into Discounts (`receiptLineAmounts`): a
 * plain line priced from a special tier is stored SPECIAL with the list as its original, so it counts too. null when the cart
 * strikes nothing on this line.
 */
function listFigures(
  l: SaleLine,
  hideOriginalPrice: boolean,
): { original: number; net: number; discount: number } | null {
  if (!cartStrikesList(l, hideOriginalPrice)) return null;
  const view = priceEditLineOf(l, 1);
  const original = lineTotalAt(view, l.listPrice as number);
  const net = lineTotalAt(view, l.unitPrice);
  const discount = roundMoney(original - net);
  return discount > 0 ? { original, net, discount } : null;
}

/**
 * Display figures of an edited line; null for a plain line. The struck "original", the net and the discount measure from the
 * LIST whenever the list is struck, so struck -> net -> Discounts agree arithmetically and equal what the receipt prints
 * (tier 10 / list 12 / price 8 / qty 2: $24.00 struck, $16.00 net, Discounts $8.00). The CHIP says what the clerk typed
 * (CQ-15: "10% off", "$2.00 off each"), measured from the customer's tier price, for as long as that is still true; once the
 * tier moved under a kept edit, or the list is not struck, it is re-derived from the list / tier as before. The chip is
 * therefore the clerk's own figure and may read differently from the list-measured Discounts row beside it.
 */
export function editedLineFigures(
  l: SaleLine,
  hideOriginalPrice = false,
): EditedLineFigures | null {
  if (!l.override) return null;
  const view = priceEditLineOf(l, 1);
  const struck = listFigures(l, hideOriginalPrice);
  const reference = struck ? (l.listPrice as number) : view.tierPrice;
  return {
    original: struck?.original ?? null,
    net: struck?.net ?? lineTotalAt(view, l.unitPrice),
    discount: struck?.discount ?? 0,
    // CQ-15: what was typed, while it is still true against the tier price; else measured from the reference (the list).
    chip:
      typedPriceEditChip(l.override, view.tierPrice, l.unitPrice) ??
      priceEditChip(l.override, reference, l.unitPrice),
  };
}

/**
 * The `Discounts` totals row: the rounded sum of the list-measured discount of EVERY struck line, edited or not (0 = no row),
 * so it equals what the receipt's Discounts row will print for the same sale.
 */
export function discountsTotal(lines: readonly SaleLine[], hideOriginalPrice = false): number {
  return roundMoney(
    lines.reduce((sum, l) => sum + (listFigures(l, hideOriginalPrice)?.discount ?? 0), 0),
  );
}

/** How many lines carry an edited price. */
export const editedCount = (lines: readonly SaleLine[]): number =>
  lines.filter((l) => !!l.override).length;

/**
 * The first edited line the server would refuse for want of a reason (a special-tier customer, a real change, no
 * reason on file). The rule is the shared `decideStaffOverride`, never a copy of it.
 */
export function lineNeedingReason(
  lines: readonly SaleLine[],
  tierFor: (productId: string) => number,
): SaleLine | null {
  for (const l of lines) {
    if (!l.override) continue;
    const tierPrice = lineTierPrice(l);
    const decision = decideStaffOverride({
      overridePrice: l.unitPrice,
      baselinePrice: tierPrice,
      listPrice: l.listPrice ?? tierPrice,
      isSpecialTier: l.special ?? isSpecialTier(tierFor(l.productId)),
      hasReason: !!l.override.reason?.trim(),
    });
    if ("refused" in decision) return l;
  }
  return null;
}
