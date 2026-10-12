import {
  computeLineSubtotal,
  decideStaffOverride,
  formatReceiptMoney,
  isSpecialTier,
  roundMoney,
} from "@routeflow/pricing";

/**
 * POS-5: the counter's price edit, resolved on the client to ONE net unit price (the server stores only that:
 * net `unitPrice` + `originalPrice`, discount 0). Everything runs through @routeflow/pricing; a line's money is
 * ALWAYS `computeLineSubtotal`, never qty x unitPrice (a boxed line's unit price is the BOX price).
 */
export type PriceEditMode = "set" | "percent" | "amount";

export type PriceEditRefusal =
  "NOT_A_NUMBER" | "NEGATIVE" | "PERCENT_RANGE" | "AMOUNT_OVER_PRICE" | "REASON_REQUIRED";

/** What the edit needs to know about the line. `tierPrice` is the system price for this customer (no edit). */
export interface PriceEditLine {
  tierPrice: number;
  listPrice: number;
  /** the customer's pricing tier (1 = standard; anything else is a special price) */
  tier: number;
  qty: number;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
}

export type PriceEditResult =
  | {
      ok: true;
      /** false = the result is within 1/2 cent of the tier price: a plain line, nothing to send */
      override: boolean;
      unitPrice: number;
      lineTotal: number;
      /** the line total at the tier price (the struck figure) */
      originalTotal: number;
      /** money taken off the line; 0 for a raised price */
      discount: number;
    }
  | {
      ok: false;
      refused: PriceEditRefusal;
      /** AMOUNT_OVER_PRICE: the most that can be taken off */
      max?: number;
    };

export const isBoxedLine = (line: Pick<PriceEditLine, "unitsPerBox">): boolean =>
  Number(line.unitsPerBox ?? 0) > 1;

/** A line's total at `unitPrice`, through the one helper every cart total uses. */
export function lineTotalAt(line: PriceEditLine, unitPrice: number): number {
  return computeLineSubtotal({
    unitPrice,
    qty: line.qty,
    boxes: line.boxes ?? undefined,
    pieces: line.pieces ?? undefined,
    unitsPerBox: line.unitsPerBox ?? undefined,
  });
}

/** Money taken off a line by moving it from the tier price to `unitPrice` (never negative). */
export function lineDiscount(line: PriceEditLine, unitPrice: number): number {
  return Math.max(0, roundMoney(lineTotalAt(line, line.tierPrice) - lineTotalAt(line, unitPrice)));
}

function parse(value: string | number): number | null {
  if (typeof value === "string" && value.trim() === "") return null;
  const n = typeof value === "number" ? value : Number(value.trim());
  return Number.isFinite(n) ? n : null;
}

/**
 * `value` is the typed number: the new price (`set`), a percent (`percent`) or dollars off per selling unit
 * (`amount`, per box on a boxed line). Percent and amount always start from the TIER price, never from a
 * previous edit. A result within 1/2 cent of the tier price is no override. A special-tier customer's real
 * change needs a reason (the shared rule, `decideStaffOverride`), so `reason` is judged here too.
 */
export function resolveCounterPriceEdit(
  mode: PriceEditMode,
  value: string | number,
  line: PriceEditLine,
  reason?: string | null,
): PriceEditResult {
  const n = parse(value);
  if (n === null) return { ok: false, refused: "NOT_A_NUMBER" };
  let wanted: number;
  if (mode === "set") {
    if (n < 0) return { ok: false, refused: "NEGATIVE" };
    wanted = roundMoney(n);
  } else if (mode === "percent") {
    if (n < 0 || n > 100 || roundMoney(n) !== n) return { ok: false, refused: "PERCENT_RANGE" };
    wanted = roundMoney(line.tierPrice * (1 - n / 100));
  } else {
    if (n < 0) return { ok: false, refused: "NEGATIVE" };
    if (n > line.tierPrice)
      return { ok: false, refused: "AMOUNT_OVER_PRICE", max: roundMoney(line.tierPrice) };
    wanted = roundMoney(line.tierPrice - n);
  }
  const decision = decideStaffOverride({
    overridePrice: wanted,
    baselinePrice: line.tierPrice,
    listPrice: line.listPrice,
    isSpecialTier: isSpecialTier(line.tier),
    hasReason: !!reason?.trim(),
  });
  if ("refused" in decision) return { ok: false, refused: "REASON_REQUIRED" };
  const unitPrice = decision.unitPrice;
  return {
    ok: true,
    override: decision.priceType === "DISCOUNTED" || decision.priceType === "MANUAL",
    unitPrice,
    lineTotal: lineTotalAt(line, unitPrice),
    originalTotal: lineTotalAt(line, line.tierPrice),
    discount: lineDiscount(line, unitPrice),
  };
}

/** What the clerk chose, kept on the cart line (the NET price itself lives in the line's `unitPrice`). */
export interface PriceOverride {
  mode: PriceEditMode;
  /** the number typed: the price, the percent, or the dollars off per selling unit */
  value: number;
  /** trimmed; absent when blank */
  reason?: string;
}

const dollars = (n: number) => formatReceiptMoney(roundMoney(n));

/**
 * The neutral chip on an edited line: `{p}% off`, `{$a} off each`, or `Price changed` (a set price, or a net at or
 * above the tier price). A percent or amount is re-derived from the real tier and net prices when they no longer
 * agree with what was typed (a customer pick moved the tier price under a kept edit).
 */
export function priceEditChip(
  override: Pick<PriceOverride, "mode" | "value">,
  tierPrice: number,
  netPrice: number,
): string {
  const tier = roundMoney(tierPrice);
  const net = roundMoney(netPrice);
  if (override.mode === "set" || net >= tier) return "Price changed";
  if (override.mode === "percent") {
    const typedStillTrue = roundMoney(tier * (1 - override.value / 100)) === net;
    const pct = typedStillTrue ? override.value : roundMoney((1 - net / tier) * 100);
    return `${pct}% off`;
  }
  return `${dollars(tier - net)} off each`;
}
