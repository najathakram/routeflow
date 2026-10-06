"use client";

import * as React from "react";
import { roundMoney } from "@routeflow/pricing";
import { MarginHint } from "@/components/MarginHint";
import { MoneyInput } from "@/components/MoneyInput";
import { PriceHistoryButton } from "@/components/PriceHistory";

// ─── Per-line price / discount editor (DRAFT only) ────────────────────────────
// Single source of truth is the line's `unitPrice`. The "$ off / unit" field is a
// lens over `basePrice - unitPrice`; both inputs resolve to one net unit price,
// which is what the server stores (net unitPrice + originalPrice strikethrough).
export function PriceEditRow({
  basePrice,
  unitPrice,
  originalUnitPrice,
  overrideReason,
  onPriceChange,
  onReasonChange,
  unitCost,
  unitsPerBox,
  floor,
  isSpecial,
  history,
}: {
  basePrice: number;
  unitPrice: number;
  /** B465 fix round 3: this line's OWN price when the edit session started —
   *  the reason-required check keys on THIS diverging from `unitPrice`, never
   *  on `overridden` (unitPrice vs `basePrice`, the tier/list reference) — a
   *  SPECIAL line's stored price is already below/above basePrice by design,
   *  so that comparison flagged every untouched SPECIAL line. */
  originalUnitPrice?: number;
  overrideReason?: string;
  onPriceChange: (netPrice: number) => void;
  onReasonChange: (reason: string) => void;
  unitCost?: number | null;
  unitsPerBox?: number | null;
  floor?: number;
  /** B465: this customer's documented contract price for the product — a
   *  reason is REQUIRED to override it, never optional like a plain line. */
  isSpecial?: boolean;
  /** Customer price-history popover for this line (omitted when there is no customer/product). */
  history?: {
    customerId?: string | null;
    customerName?: string | null;
    productId?: string | null;
    productName: string;
    unitHint?: string | null;
    packHint?: number | null;
    /** The order being edited: its own lines are not shown as history (hunt2 F6). */
    excludeOrderId?: string | null;
  };
}) {
  // "Sell anyway" acknowledges a below-floor price for this session; the override
  // is logged via overrideReason so reports can isolate below-floor sales.
  const [floorAcked, setFloorAcked] = React.useState(false);
  // Cost eye — cost/margin hidden by default; per-row reveal, never persisted.
  const [costRevealed, setCostRevealed] = React.useState(false);

  // Price ↔ $-off lens on MoneyInput: each field keeps its own draft while
  // focused (typing is never reformatted — the old toFixed(2) echo effect here
  // was the "type 2.50, get 2.05" bug); the unfocused sibling re-syncs from
  // the parent's unitPrice.
  const offValue = unitPrice < basePrice ? roundMoney(basePrice - unitPrice) : null;

  const commitPrice = (v: number | null) => {
    if (v == null) {
      onPriceChange(basePrice); // empty → clear override
      return;
    }
    onPriceChange(roundMoney(Math.max(0, v)));
  };

  const commitOff = (v: number | null) => {
    if (v == null || v <= 0) {
      onPriceChange(basePrice); // no discount → back to list price
      return;
    }
    onPriceChange(roundMoney(Math.max(0, basePrice - v)));
  };

  const overridden = Math.abs(unitPrice - basePrice) > 0.0001;
  const isUpsell = unitPrice > basePrice + 0.0001;
  // B465 fix round 3: the reason-REQUIRED state is scoped to a price this
  // session actually changed — never to `overridden` alone, which a SPECIAL
  // line trips just by being priced at its (correct, untouched) tier rate.
  const priceChangedThisSession =
    originalUnitPrice != null && Math.abs(unitPrice - originalUnitPrice) > 0.0001;
  const reasonRequired = !!isSpecial && priceChangedThisSession;
  // #815 proof-run finding: the block below (was-$X/upsell badge + reason input) used
  // to render ONLY on `overridden` (vs basePrice) — so repricing a SPECIAL line to
  // EXACTLY the list price made `overridden` false and hid the reason field entirely,
  // even though `reasonRequired` (vs originalUnitPrice, a DIFFERENT baseline) was still
  // true and the server still 400s without one. The render gate below is
  // `overridden || reasonRequired`; the was-$X/upsell badge itself stays scoped to
  // `overridden` alone (showing "was $10.00" when the price literally is $10.00 would
  // be nonsensical).

  return (
    <div className="ml-11 mt-1 flex flex-wrap items-center gap-x-3 gap-y-1.5 text-xs">
      <label className="flex items-center gap-1.5 text-navy/70">
        <span>Unit price</span>
        <span className="flex items-center rounded border border-surface-border bg-white px-1.5 focus-within:ring-1 focus-within:ring-brand-500">
          <span className="text-navy/40">$</span>
          <MoneyInput
            value={unitPrice}
            onChange={commitPrice}
            className="w-16 rounded-none border-0 bg-transparent px-0 py-1 text-right text-xs focus:ring-0"
          />
        </span>
        {/* "Use this price" is the SAME path as typing: commitPrice -> onPriceChange (the special-price
            reason and margin-floor rules key off the price that results). */}
        {history && <PriceHistoryButton {...history} onUsePrice={commitPrice} />}
      </label>
      <label className="flex items-center gap-1.5 text-navy/70">
        <span>$ off / unit</span>
        <span className="flex items-center rounded border border-surface-border bg-white px-1.5 focus-within:ring-1 focus-within:ring-brand-500">
          <span className="text-navy/40">−$</span>
          <MoneyInput
            value={offValue}
            onChange={commitOff}
            placeholder="0.00"
            className="w-14 rounded-none border-0 bg-transparent px-0 py-1 text-right text-xs placeholder:text-navy/40 focus:ring-0"
          />
        </span>
      </label>
      {(overridden || reasonRequired) && (
        <>
          {overridden &&
            (isUpsell ? (
              // Upsell: green "+$X" instead of a struck-through "was" (which would
              // read as a discount). The base is hidden from the customer server-side.
              <span className="font-medium text-emerald-600">
                Upsell +${(unitPrice - basePrice).toFixed(2)}
              </span>
            ) : (
              <span className="text-navy/50">
                was <span className="line-through">${basePrice.toFixed(2)}</span>
              </span>
            ))}
          <input
            type="text"
            value={overrideReason ?? ""}
            onChange={(e) => onReasonChange(e.target.value)}
            // B465: a SPECIAL-tier line's contract price can only be CHANGED
            // with a documented reason — the server refuses the save
            // otherwise (400), so this reads as required, never optional,
            // but ONLY while this session is actually changing the price
            // (reasonRequired) — an untouched SPECIAL line, or one whose
            // price reverted back to its original value, is not a repricing
            // attempt and keeps the reason optional like any other line.
            placeholder={reasonRequired ? "reason (required)" : "reason (optional)"}
            required={reasonRequired}
            aria-required={reasonRequired}
            aria-invalid={reasonRequired && !overrideReason?.trim() ? true : undefined}
            className={
              reasonRequired && !overrideReason?.trim()
                ? "min-w-0 flex-1 rounded border border-danger bg-danger-bg/30 px-2 py-1 text-navy outline-none ring-1 ring-danger placeholder:text-danger/70"
                : "min-w-0 flex-1 rounded border border-surface-border bg-white px-2 py-1 text-navy outline-none placeholder:text-navy/40"
            }
          />
        </>
      )}
      {/* Live cost & margin — the negotiation floor (pos-cost-roles-spec §1) */}
      {floor != null && (
        <div className="basis-full">
          <MarginHint
            unitPrice={unitPrice}
            unitCost={unitCost}
            unitsPerBox={unitsPerBox}
            floor={floor}
            acked={floorAcked}
            onSetToFloor={(floorPrice) => onPriceChange(floorPrice)}
            onSellAnyway={() => {
              setFloorAcked(true);
              if (!overrideReason) onReasonChange("Below margin floor - approved");
            }}
            concealed={!costRevealed}
            onToggleConcealed={() => setCostRevealed((v) => !v)}
          />
        </div>
      )}
    </div>
  );
}
