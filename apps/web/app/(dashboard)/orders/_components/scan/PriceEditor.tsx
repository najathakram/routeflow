"use client";

import * as React from "react";
import { X } from "lucide-react";
import { Button, cn } from "@routeflow/ui/web";
import { computeLineSubtotal, perUnitPrice, pillLabel, unitWords } from "@routeflow/pricing";
import { MarginHint } from "@/components/MarginHint";
import { MoneyInput } from "@/components/MoneyInput";
import { PendingUnitStatus, type LineItemRowProps } from "@/components/LineItemRow";
import {
  caseWord,
  unitWord,
  useLooseUnitsToggle,
  type LineItemRowItem,
} from "@/components/LineItemRow";

export interface PriceEditorProps {
  line: LineItemRowItem;
  /** `floorForCategory(marginConfig, line.category)` — resolved by the caller, as for the row. */
  marginFloor: number;
  floorAcked: boolean;
  costRevealed: boolean;
  priceHistoryEntry?: { lastPrice: number };
  onQtyDelta: (delta: number) => void;
  /** #2865 case c (SA-632): set while the line's default selling unit is not yet resolved: the qty controls are locked. */
  pendingUnit?: LineItemRowProps["pendingUnit"];
  onSetBoxes: (value: number) => void;
  onSetPieces: (value: number) => void;
  onSetUnitQty: (value: number) => void;
  onSetSellBy: (mode: "case" | "unit") => void;
  onSetDiscountedPrice: (value: number | null) => void;
  onSetToFloor: (floorPrice: number) => void;
  onAckFloor: () => void;
  onToggleCostRevealed: () => void;
  onClose: () => void;
  /** #2696(c): `decideStaffOverride(...).refused === "REASON_REQUIRED"` for this line, decided by
   *  the caller with @routeflow/pricing — the server's own rule. */
  reasonRequired?: boolean;
  /** Given ⇒ an overridden price shows a Reason field (required when `reasonRequired`). */
  onSetOverrideReason?: (reason: string) => void;
}

/**
 * The price / quantity editor the scan screen opens when the operator taps a row's price
 * (scanner-redesign-spec.md §6, LANE-S step 6): a focused sheet for the one line, so a phone
 * operator is not editing five tiny inputs inside a dense row.
 *
 * It owns NO state and adds NO new write path. Every edit goes through the SAME handlers the row
 * uses (`onSetDiscountedPrice`, `onSetBoxes`, …), and the margin/floor check is `MarginHint` itself
 * — the same component instance the row renders — so "Set to floor" and "Sell anyway" behave
 * identically and moving them into a sheet cannot introduce a floor-bypass path. Money is shown
 * with `computeLineSubtotal` / `perUnitPrice` from `@routeflow/pricing`, never re-derived here.
 *
 * Dismissal (Escape) is handled by the screen that mounts this, which closes only the editor.
 */
export function PriceEditor({
  line: li,
  marginFloor,
  floorAcked,
  costRevealed,
  priceHistoryEntry,
  onQtyDelta,
  pendingUnit,
  onSetBoxes,
  onSetPieces,
  onSetUnitQty,
  onSetSellBy,
  onSetDiscountedPrice,
  onSetToFloor,
  onAckFloor,
  onToggleCostRevealed,
  onClose,
  reasonRequired = false,
  onSetOverrideReason,
}: PriceEditorProps) {
  // #2696 (d): the loose-units field is opt-in ("+ units"); shown whenever pieces > 0 regardless.
  const { showLooseUnits, openLooseUnits, closeLooseUnits } = useLooseUnitsToggle(li.pieces);
  const qtyLocked = !!pendingUnit;
  const w = unitWords({ packLabel: li.packLabel, baseUnitLabel: li.baseLabel });
  const boxed = !!li.unitsPerBox;
  // The row labels the price "{Pack} price" only for a real pack (> 1), though it shows the case
  // qty controls for any unitsPerBox — mirror both.
  const packed = (li.unitsPerBox ?? 0) > 1;
  const dialogRef = React.useRef<HTMLDivElement>(null);
  // Move focus into the sheet on open so Tab/Shift+Tab start inside it, not on the screen behind.
  React.useEffect(() => {
    dialogRef.current?.focus();
  }, []);
  const lineTotal = computeLineSubtotal({
    unitPrice: li.unitPrice,
    qty: li.qty,
    boxes: li.boxes ?? null,
    pieces: li.pieces ?? null,
    unitsPerBox: li.unitsPerBox ?? null,
  });
  const perPiece =
    boxed && li.unitsPerBox! > 1 ? perUnitPrice(li.unitPrice, li.unitsPerBox!) : null;
  const inputCls =
    "rounded border border-surface-border bg-white px-2 py-1.5 text-center text-sm font-semibold text-navy focus:outline-none focus:ring-2 focus:ring-brand-500";

  return (
    <div className="fixed inset-0 z-[90] flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label="Close price editor"
        onClick={onClose}
        tabIndex={-1}
        className="absolute inset-0 bg-black/40"
      />
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={`Edit ${li.productName}`}
        className="relative z-10 max-h-[85vh] w-full max-w-md space-y-4 overflow-y-auto rounded-t-2xl bg-white p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shadow-xl sm:rounded-2xl"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-base font-semibold text-navy">{li.productName}</h3>
            <p className="text-xs text-navy/60">
              List ${li.listPrice.toFixed(2)} / {li.unit}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded p-1 text-navy/50 hover:bg-surface-raised hover:text-navy"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {/* Quantity — the row's own case/unit control, one field at a time. */}
        <fieldset
          disabled={qtyLocked}
          aria-busy={qtyLocked}
          aria-label={
            qtyLocked
              ? "Line quantity controls, locked while the selling unit loads"
              : "Line quantity controls"
          }
          className="m-0 border-0 p-0 min-w-0 space-y-2"
        >
          {boxed ? (
            <>
              <div className="inline-flex overflow-hidden rounded border border-surface-border text-xs font-medium">
                {(["case", "unit"] as const).map((mode) => {
                  const full = mode === "case" ? w.pack.one : w.base.one;
                  const cut = pillLabel(full) !== full;
                  return (
                    <button
                      key={mode}
                      type="button"
                      onClick={() => onSetSellBy(mode)}
                      aria-pressed={(li.sellBy ?? "case") === mode}
                      aria-label={cut ? full : undefined}
                      title={cut ? full : undefined}
                      className={cn(
                        "max-w-[104px] truncate whitespace-nowrap px-3 py-1.5 transition-colors",
                        mode === "unit" && "border-l border-surface-border",
                        (li.sellBy ?? "case") === mode
                          ? "bg-brand-500 text-white"
                          : "bg-white text-navy/70 hover:bg-surface-raised",
                      )}
                    >
                      {pillLabel(full)}
                    </button>
                  );
                })}
              </div>
              {li.sellBy === "unit" ? (
                <label className="flex items-center gap-2 text-sm text-navy/70">
                  <input
                    type="number"
                    min={0}
                    value={li.qty}
                    onChange={(e) => onSetUnitQty(parseInt(e.target.value, 10) || 0)}
                    onFocus={(e) => e.target.select()}
                    className={cn(inputCls, "w-24")}
                    aria-label={`Total ${w.base.lowerOther}`}
                  />
                  {w.base.short.other}
                </label>
              ) : (
                <div className="flex items-center gap-2 text-sm text-navy/70">
                  <input
                    type="number"
                    min={0}
                    value={li.boxes ?? 0}
                    onChange={(e) => onSetBoxes(parseInt(e.target.value, 10) || 0)}
                    onFocus={(e) => e.target.select()}
                    className={cn(inputCls, "w-20")}
                    aria-label={w.pack.other}
                  />
                  <span
                    className="min-w-0 max-w-[6rem] truncate"
                    title={w.isDefaultPack ? undefined : w.pack.other}
                  >
                    {caseWord(li.boxes ?? 0, w)}
                  </span>
                  {/* #2696 (d): loose units on top of cases are opt-in, as on the row. */}
                  {showLooseUnits ? (
                    <>
                      {/* SA-558d: its own element — a bare "+" text node glued to "cases". */}
                      <span className="text-navy/30">+</span>
                      <input
                        type="number"
                        min={0}
                        max={li.unitsPerBox! - 1}
                        value={li.pieces ?? 0}
                        onChange={(e) => onSetPieces(parseInt(e.target.value, 10) || 0)}
                        onFocus={(e) => e.target.select()}
                        className={cn(inputCls, "w-20")}
                        aria-label={`Extra ${w.base.lowerOther}`}
                      />
                      <span
                        className="min-w-0 max-w-[6rem] truncate"
                        title={w.isDefaultBase ? undefined : w.base.other}
                      >
                        {unitWord(li.pieces ?? 0, w)}
                      </span>
                      {/* SA-563: hidden at 0 cases, as on the row. */}
                      {(li.boxes ?? 0) >= 1 && (
                        <button
                          type="button"
                          onClick={() => {
                            onSetPieces(0);
                            closeLooseUnits();
                          }}
                          aria-label={`Remove extra ${w.base.lowerOther}`}
                          className="relative before:absolute before:-inset-2 before:content-[''] text-navy/50 hover:text-danger"
                        >
                          ×
                        </button>
                      )}
                    </>
                  ) : (
                    <button
                      type="button"
                      onClick={openLooseUnits}
                      aria-label={`+ ${w.base.lowerOther}: add extra ${w.base.lowerOther}`}
                      className="relative before:absolute before:-inset-2 before:content-[''] rounded border border-dashed border-surface-border px-2 py-1 text-xs font-medium text-navy/60 hover:bg-surface-raised"
                    >
                      + {w.base.lowerOther}
                    </button>
                  )}
                </div>
              )}
              <p className="text-xs text-navy/50">
                1 {w.pack.lower} = {li.unitsPerBox} {w.base.short.other} · {li.qty}{" "}
                {w.baseShortFor(li.qty)} total
              </p>
            </>
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => onQtyDelta(-1)}
                disabled={li.qty <= 1}
                aria-label="One fewer"
                className="flex h-9 w-9 items-center justify-center rounded border border-surface-border text-lg text-navy/70 hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-30"
              >
                −
              </button>
              <span
                className="w-10 text-center text-base font-semibold text-navy"
                aria-live="polite"
              >
                {li.qty}
              </span>
              <button
                type="button"
                onClick={() => onQtyDelta(1)}
                aria-label="One more"
                className="flex h-9 w-9 items-center justify-center rounded border border-surface-border text-lg text-navy/70 hover:bg-surface-raised"
              >
                +
              </button>
            </div>
          )}
        </fieldset>
        {pendingUnit && <PendingUnitStatus pending={pendingUnit} />}

        {/* Price — #2696(c): a special (customer) price is the default here, never locked; moving
            off it needs a reason (below), as the server requires. */}
        <section className="space-y-1">
          <label className="block text-xs font-medium text-navy/70">
            {packed ? `${li.sellBy === "unit" ? w.base.one : w.pack.one} price` : "Price"}
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex items-center rounded border border-surface-border bg-white px-2 focus-within:ring-2 focus-within:ring-brand-500">
              <span className="text-sm text-navy/40">$</span>
              <MoneyInput
                min={0}
                placeholder={(li.specialPrice ?? li.listPrice).toFixed(2)}
                value={li.discountedPrice ?? null}
                onChange={(v) => onSetDiscountedPrice(v)}
                aria-label="Price"
                disabled={qtyLocked}
                className="w-24 rounded-none border-0 bg-transparent px-1 py-1.5 text-right text-sm focus:ring-0"
              />
            </span>
            {priceHistoryEntry && priceHistoryEntry.lastPrice !== li.listPrice && (
              <span className="text-xs text-navy/50">
                Last: ${priceHistoryEntry.lastPrice.toFixed(2)}
              </span>
            )}
          </div>
          {li.specialPrice != null && (
            <p className="text-xs text-emerald-700">
              Special price ${li.specialPrice.toFixed(2)} / {li.unit} for this customer.
            </p>
          )}
          {onSetOverrideReason && li.discountedPrice != null && (
            <div className="space-y-1 pt-1">
              <label className="block space-y-1">
                <span className="block text-xs font-medium text-navy/70">
                  {reasonRequired ? "Reason (required)" : "Reason (optional)"}
                </span>
                <input
                  type="text"
                  maxLength={200}
                  value={li.overrideReason ?? ""}
                  onChange={(e) => onSetOverrideReason(e.target.value)}
                  aria-invalid={reasonRequired}
                  aria-describedby={reasonRequired ? "price-reason-hint" : undefined}
                  placeholder="e.g. dented cans, manager approved"
                  className={cn(
                    "w-full rounded border bg-white px-2 py-1.5 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500",
                    reasonRequired ? "border-danger" : "border-surface-border",
                  )}
                />
              </label>
              {reasonRequired && (
                <span id="price-reason-hint" className="block text-xs text-danger">
                  This changes the customer&apos;s special price — say why.
                </span>
              )}
            </div>
          )}
        </section>

        {/* The negotiation floor: the SAME component the row renders. */}
        <MarginHint
          unitPrice={li.unitPrice}
          unitCost={li.unitCost}
          unitsPerBox={li.unitsPerBox}
          productId={li.productId || undefined}
          floor={marginFloor}
          acked={floorAcked}
          onSetToFloor={onSetToFloor}
          onSellAnyway={onAckFloor}
          concealed={!costRevealed}
          onToggleConcealed={onToggleCostRevealed}
        />

        <div className="flex items-center justify-between border-t border-surface-border pt-3">
          <div>
            <p className="text-xs text-navy/60">Line total</p>
            <p className="text-base font-semibold text-navy" aria-live="polite">
              ${lineTotal.toFixed(2)}
            </p>
            {perPiece != null && (
              <p className="text-[11px] text-navy/50">
                ${perPiece.toFixed(2)} / {w.base.lower}
              </p>
            )}
          </div>
          <Button type="button" onClick={onClose}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}
