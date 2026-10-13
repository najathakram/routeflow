import * as React from "react";
import { showOriginalPrice } from "@routeflow/pricing";
import { fmt } from "@/lib/formatting";

type PriceItem = {
  priceType?: string | null;
  originalPrice?: number | string | null;
  unitPrice: number | string;
};

/** The badge and colours of a lowered line, by stored price type. */
const LOWERED: Record<string, { label: string; amount: string; pill: string }> = {
  SPECIAL: {
    label: "Special price",
    amount: "text-success",
    pill: "bg-success-bg text-success ring-success/20",
  },
  DISCOUNTED: {
    label: "Discounted price",
    amount: "text-warning",
    pill: "bg-warning-bg text-warning ring-warning/20",
  },
  PROMO: {
    label: "Promo price",
    amount: "text-brand-600",
    pill: "bg-brand-50 text-brand-600 ring-brand-200",
  },
  MANUAL: {
    label: "Adjusted",
    amount: "text-warning",
    pill: "bg-warning-bg text-warning ring-warning/20",
  },
};

const PILL = "rounded-full px-1.5 py-0.5 text-[10px] font-medium ring-1";

/**
 * The invoice detail's per-line "Price" cell content. Row 322c: whether the stored original price may be struck beside the
 * charged one is pricing's `showOriginalPrice` (the rule the invoice PDF, the invoice email and every receipt read), not an
 * inline priceType ladder: nothing is struck when the tenant hides original prices or the line stores none (never a struck
 * $0.00), and a MANUAL upsell (charged above its base) shows green with an "Upsell" badge and never exposes the lower base.
 */
export function InvoiceLinePrice({
  item,
  hideOriginal,
}: {
  item: PriceItem;
  hideOriginal: boolean;
}) {
  const charged = fmt(Number(item.unitPrice));
  const isUpsell =
    item.priceType === "MANUAL" &&
    item.originalPrice != null &&
    Number(item.unitPrice) > Number(item.originalPrice);
  if (isUpsell) {
    return (
      <div className="flex flex-col items-end gap-0.5">
        {/* Upsell (above list): green, no strikethrough: the base is never shown to the buyer. */}
        <span className="money text-success">{charged}</span>
        <span className={`${PILL} bg-success-bg text-success ring-success/20`}>Upsell</span>
      </div>
    );
  }
  const lowered = LOWERED[item.priceType ?? ""];
  if (lowered && showOriginalPrice(item, hideOriginal)) {
    return (
      <div className="flex flex-col items-end gap-0.5">
        <span className="strike text-xs">{fmt(Number(item.originalPrice))}</span>
        <span className={`money ${lowered.amount}`}>{charged}</span>
        <span className={`${PILL} ${lowered.pill}`}>{lowered.label}</span>
      </div>
    );
  }
  return <span className="money text-navy/70">{charged}</span>;
}
