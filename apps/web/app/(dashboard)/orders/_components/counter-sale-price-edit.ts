import { decideStaffOverride, isSpecialTier, roundMoney } from "@routeflow/pricing";
import {
  lineDiscount,
  lineTotalAt,
  priceEditChip,
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
  /** the line total at the system price (the struck figure) */
  original: number;
  /** the line total at the net price */
  net: number;
  /** money taken off; 0 for a raised price */
  discount: number;
  chip: string;
}

/** Display figures of an edited line; null for a plain line. */
export function editedLineFigures(l: SaleLine): EditedLineFigures | null {
  if (!l.override) return null;
  const view = priceEditLineOf(l, 1);
  return {
    original: lineTotalAt(view, view.tierPrice),
    net: lineTotalAt(view, l.unitPrice),
    discount: lineDiscount(view, l.unitPrice),
    chip: priceEditChip(l.override, view.tierPrice, l.unitPrice),
  };
}

/** The `Discounts` totals row: the rounded sum of the positive line discounts (0 = no row). */
export function discountsTotal(lines: readonly SaleLine[]): number {
  return roundMoney(lines.reduce((sum, l) => sum + (editedLineFigures(l)?.discount ?? 0), 0));
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
      isSpecialTier: isSpecialTier(tierFor(l.productId)),
      hasReason: !!l.override.reason?.trim(),
    });
    if ("refused" in decision) return l;
  }
  return null;
}
