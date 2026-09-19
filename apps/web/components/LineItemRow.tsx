"use client";

import * as React from "react";
import { X, StickyNote } from "lucide-react";
import { cn, type BadgeStatus } from "@routeflow/ui/web";
import { computeLineSubtotal, perUnitPrice } from "@routeflow/pricing";
import { MarginHint } from "@/components/MarginHint";
import { MoneyInput } from "@/components/MoneyInput";
import type { TrackedCategory } from "@/lib/api/tracked-categories";

/**
 * A single order line item, as built by `CreateOrderModal` (and, in future, the
 * scan-to-order screen — scanner-redesign-spec.md §4.1). Extracted verbatim from
 * `CreateOrderModal`'s own `LineItem` interface — kept as a standalone export so
 * every consumer of `LineItemRow` shares one shape instead of a local copy.
 */
export interface LineItemRowItem {
  tempId: string;
  /** Empty string for unlisted (ad-hoc) lines — `isUnlisted` is the real flag. */
  productId: string;
  productName: string;
  unit: string;
  listPrice: number; // standard pricePerUnit from product catalog
  specialPrice?: number; // permanent customer-specific price (from CustomerPrice)
  discountedPrice?: number; // one-time ad-hoc override (below list = discount, above = upsell)
  unitPrice: number; // effective price used for display totals
  priceType: "STANDARD" | "SPECIAL" | "DISCOUNTED" | "MANUAL";
  qty: number; // total pieces (authoritative)
  unitsPerBox?: number; // set when product has box packaging
  boxes?: number; // whole boxes (only when unitsPerBox is set)
  pieces?: number; // extra loose pieces (only when unitsPerBox is set)
  unitCost?: number; // Product.averageCost (per piece) — for the live margin hint
  category?: string; // for the per-category margin floor
  /** Regulated tracked-category id (null for standard products) — maps a blocked
   *  category from the 409 license guard back to the cart line. */
  trackedCategoryId?: string | null;
  /** True for a free-text, non-catalog line (sent as { name, qty, unitPrice }). */
  isUnlisted?: boolean;
  /** Optional per-line note — carried onto the invoice line (buyer-visible). */
  note?: string;
  /** Note input expanded for this row (icon toggle; note text survives collapse). */
  noteOpen?: boolean;
  /** UI-only qty entry mode for case-packed lines. NEVER submitted — the payload always
   *  carries {qty, boxes, pieces} and the per-case unitPrice. */
  sellBy?: "case" | "unit";
}

export interface LineItemRowProps {
  item: LineItemRowItem;
  /** `lineCategory(item)` result — the caller resolves the tracked category, the
   *  row only renders the "· regulated" tag / amber left-border off it. */
  category?: TrackedCategory | null;
  /** `floorForCategory(marginConfig, item.category)` — resolved by the caller. */
  marginFloor: number;
  floorAcked: boolean;
  costRevealed: boolean;
  priceHistoryEntry?: { lastPrice: number };
  /** Last-scanned highlight ring (scanner-redesign-spec.md §4.1/§5.1) — unused by
   *  `CreateOrderModal`, which never passes it; reserved for the scan screen. */
  highlighted?: boolean;

  onQtyDelta: (delta: number) => void;
  onSetBoxes: (value: number) => void;
  onSetPieces: (value: number) => void;
  onSetUnitQty: (value: number) => void;
  onSetSellBy: (mode: "case" | "unit") => void;
  onSetDiscountedPrice: (value: number | null) => void;
  onSetToFloor: (floorPrice: number) => void;
  onAckFloor: () => void;
  onToggleCostRevealed: () => void;
  onToggleNoteOpen: () => void;
  onSetNote: (note: string) => void;
  onUpdateUnlistedName: (name: string) => void;
  onUpdateUnlistedPrice: (value: number | null) => void;
  onRemove: () => void;
  /** Scan screen only (scanner-redesign-spec.md §4.1) — `CreateOrderModal` omits
   *  this; not wired to any gesture in this extraction pass. */
  onSwipeDelete?: () => void;
  /** Opens the floating price editor (scanner-redesign-spec.md §6) instead of the
   *  inline discount input. When omitted (every current caller), the price stays
   *  inline-editable exactly as it is today — this prop only adds a click target
   *  around the existing price display, it never removes the inline input. */
  onTapPrice?: () => void;

  /** Registers/unregisters this row's root `<li>` with the caller (e.g.
   *  `CreateOrderModal`'s `rowRefs` map, used to scroll a just-scanned/just-added
   *  row into view). Optional — a consumer with no such need omits it. */
  rowRef?: (el: HTMLLIElement | null) => void;

  // ── Read-only / order-detail variant (order-ui-redesign-spec.md §6.1) ──
  // Additive prop surface only — no consumer sets these yet, and this extraction
  // does not implement the read-only rendering path (that is order-ui-redesign-
  // spec.md's own T4/T6). Declared now so that work is a diff to this file's
  // rendering, not another rewrite of its props.
  /** When true, a future pass renders qty/price as plain text, hides the
   *  remove/note affordances and `MarginHint`, and ignores every callback above. */
  readOnly?: boolean;
  thumbnailUrl?: string | null;
  sku?: string | null;
  /** Pre-composed via `displayProductName` for the read-only path. Falls back to
   *  `item.productName` when omitted, which every current (editable) caller does. */
  displayName?: string;
  lineStatus?: BadgeStatus;
  deliveredQty?: number | null;
}

/**
 * Renders one order line item: name/price display, the case/unit qty controls
 * (or a plain +/- stepper for non-boxed products), the live line total, the
 * per-line note toggle, and remove. Pure lift-and-parametrize out of
 * `CreateOrderModal.tsx`'s inline `.map()` — every branch below existed there
 * unchanged; see that file's git history for prior art. No behavior change.
 */
export function LineItemRow({
  item: li,
  category,
  marginFloor,
  floorAcked,
  costRevealed,
  priceHistoryEntry,
  highlighted,
  onQtyDelta,
  onSetBoxes,
  onSetPieces,
  onSetUnitQty,
  onSetSellBy,
  onSetDiscountedPrice,
  onSetToFloor,
  onAckFloor,
  onToggleCostRevealed,
  onToggleNoteOpen,
  onSetNote,
  onUpdateUnlistedName,
  onUpdateUnlistedPrice,
  onRemove,
  onTapPrice,
  rowRef,
}: LineItemRowProps) {
  return (
    <li
      ref={rowRef}
      className={cn(
        "flex items-start gap-3 px-3 py-2.5",
        category ? "border-l-2 border-l-amber-300 bg-amber-50/30" : "",
        highlighted ? "ring-2 ring-brand-500" : "",
      )}
    >
      {li.isUnlisted ? (
        // ── Unlisted (custom) line — editable name + price, no catalog data ──
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              value={li.productName}
              onChange={(e) => onUpdateUnlistedName(e.target.value)}
              placeholder="Item name"
              className="min-w-0 flex-1 rounded border border-surface-border bg-white px-2 py-1 text-sm font-medium text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
            <span className="shrink-0 rounded-full bg-brand-50 px-1.5 py-0.5 text-[10px] font-medium text-brand-700 ring-1 ring-brand-200">
              Custom
            </span>
          </div>
          <div className="flex items-center gap-1">
            <span className="text-[10px] text-navy/70">Price:</span>
            <span className="flex items-center rounded border border-surface-border bg-white px-1.5 focus-within:ring-1 focus-within:ring-brand-500">
              <span className="text-navy/40 text-xs">$</span>
              <MoneyInput
                value={li.unitPrice}
                onChange={(v) => onUpdateUnlistedPrice(v)}
                className="w-16 rounded-none border-0 bg-transparent px-0 py-0.5 text-right text-xs focus:ring-0"
              />
            </span>
            <span className="text-[10px] text-navy/70">/ {li.unit}</span>
          </div>
          {(li.noteOpen || li.note?.trim()) && (
            <input
              type="text"
              maxLength={500}
              value={li.note ?? ""}
              onChange={(e) => onSetNote(e.target.value)}
              placeholder="Flavor or note for this item (prints on invoice)"
              className="mt-1 w-full rounded border border-surface-border bg-white px-2 py-1 text-xs text-navy placeholder:text-navy/40 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          )}
        </div>
      ) : (
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-navy">{li.productName}</p>
          {/* Price display with special/discount indicators */}
          <div
            className={cn(
              "mt-0.5 flex flex-wrap items-center gap-1.5",
              onTapPrice ? "cursor-pointer" : "",
            )}
            onClick={onTapPrice}
            role={onTapPrice ? "button" : undefined}
            tabIndex={onTapPrice ? 0 : undefined}
          >
            {li.priceType === "SPECIAL" ? (
              <>
                <span className="text-xs text-navy/70 line-through">
                  ${li.listPrice.toFixed(2)}
                </span>
                <span className="text-xs font-medium text-emerald-600">
                  ${li.unitPrice.toFixed(2)} / {li.unit}
                </span>
                <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-emerald-200">
                  Special price
                </span>
              </>
            ) : li.priceType === "DISCOUNTED" ? (
              <>
                <span className="text-xs text-navy/70 line-through">
                  ${li.listPrice.toFixed(2)}
                </span>
                <span className="text-xs font-medium text-amber-600">
                  ${li.unitPrice.toFixed(2)} / {li.unit}
                </span>
                <span className="rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-amber-200">
                  Discounted
                </span>
              </>
            ) : li.priceType === "MANUAL" ? (
              <>
                {/* Upsell (sold above list). Operator-only green badge;
                    no strikethrough — the base is never shown to the buyer. */}
                <span className="text-xs font-medium text-emerald-600">
                  ${li.unitPrice.toFixed(2)} / {li.unit}
                </span>
                <span className="rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 ring-1 ring-emerald-200">
                  Upsell
                </span>
              </>
            ) : (
              <span className="text-xs text-navy/70">
                ${li.unitPrice.toFixed(2)} / {li.unit}
              </span>
            )}
          </div>
          {/* Price per piece (when product has box packaging) */}
          {li.unitsPerBox && li.unitsPerBox > 1 && (
            <div className="mt-0.5 text-[10px] text-navy/70">
              ${perUnitPrice(li.unitPrice, li.unitsPerBox)?.toFixed(2)} / piece
            </div>
          )}
          {/* Regulated tag (regulated-items-spec: "{Category} · regulated"). */}
          {category && (
            <span className="mt-1 inline-flex items-center rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-amber-200">
              {category.name} · regulated
            </span>
          )}
          {/* One-time discount input (only when no special price already applied) */}
          {li.priceType !== "SPECIAL" && (
            <div className="mt-1 flex items-center gap-1 flex-wrap">
              <span className="text-[10px] text-navy/70">
                {li.unitsPerBox && li.unitsPerBox > 1 ? "Case price:" : "Price:"}
              </span>
              <MoneyInput
                min={0}
                placeholder={li.listPrice.toFixed(2)}
                value={li.discountedPrice ?? null}
                onChange={(v) => onSetDiscountedPrice(v)}
                className="w-20 rounded border border-surface-border bg-white px-1.5 py-0.5 text-xs text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
              {priceHistoryEntry && priceHistoryEntry.lastPrice !== li.listPrice && (
                <span className="text-[10px] text-navy/50">
                  Last: ${priceHistoryEntry.lastPrice.toFixed(2)}
                </span>
              )}
            </div>
          )}
          {/* Live cost & margin — the negotiation floor (shared
              component; tapping the cost opens cost history) */}
          <div className="mt-0.5">
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
          </div>
          {(li.noteOpen || li.note?.trim()) && (
            <input
              type="text"
              maxLength={500}
              value={li.note ?? ""}
              onChange={(e) => onSetNote(e.target.value)}
              placeholder="Flavor or note for this item (prints on invoice)"
              className="mt-1 w-full rounded border border-surface-border bg-white px-2 py-1 text-xs text-navy placeholder:text-navy/40 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          )}
        </div>
      )}
      {/* Qty controls */}
      {li.unitsPerBox ? (
        <div className="flex flex-col gap-0.5 min-w-[190px]">
          {/* Case | Unit sell-by toggle — UI-only; the payload always
              carries {qty, boxes, pieces} regardless of the mode. */}
          <div className="inline-flex self-start overflow-hidden rounded border border-surface-border text-[10px] font-medium">
            <button
              type="button"
              onClick={() => onSetSellBy("case")}
              className={cn(
                "px-1.5 py-0.5 transition-colors",
                (li.sellBy ?? "case") === "case"
                  ? "bg-brand-500 text-white"
                  : "bg-white text-navy/70 hover:bg-surface-raised",
              )}
            >
              Case
            </button>
            <button
              type="button"
              onClick={() => onSetSellBy("unit")}
              className={cn(
                "border-l border-surface-border px-1.5 py-0.5 transition-colors",
                li.sellBy === "unit"
                  ? "bg-brand-500 text-white"
                  : "bg-white text-navy/70 hover:bg-surface-raised",
              )}
            >
              Unit
            </button>
          </div>
          {li.sellBy === "unit" ? (
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={0}
                value={li.qty}
                onChange={(e) => onSetUnitQty(parseInt(e.target.value, 10) || 0)}
                onFocus={(e) => e.target.select()}
                className="w-16 rounded border border-surface-border bg-white px-1.5 py-1 text-center text-sm font-semibold text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
                title="Total units"
              />
              <span className="text-xs text-navy/70">units</span>
            </div>
          ) : (
            <div className="flex items-center gap-1.5">
              <input
                type="number"
                min={0}
                value={li.boxes ?? 0}
                onChange={(e) => onSetBoxes(parseInt(e.target.value, 10))}
                onFocus={(e) => e.target.select()}
                className="w-12 rounded border border-surface-border bg-white px-1.5 py-1 text-center text-sm font-semibold text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
                title="Number of whole cases"
              />
              <span className="text-xs text-navy/70">cases</span>
              <span className="text-xs text-navy/30">+</span>
              <input
                type="number"
                min={0}
                max={li.unitsPerBox - 1}
                value={li.pieces ?? 0}
                onChange={(e) => onSetPieces(parseInt(e.target.value, 10))}
                onFocus={(e) => e.target.select()}
                className="w-12 rounded border border-surface-border bg-white px-1.5 py-1 text-center text-sm font-semibold text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
                title="Extra loose units (less than a full case)"
              />
              <span className="text-xs text-navy/70">units</span>
            </div>
          )}
          <span className="text-[10px] text-navy/30">
            1 case = {li.unitsPerBox} units
            {li.qty > 0 && (
              <>
                {" "}
                · <span className="font-medium text-navy/70">{li.qty} pcs total</span>
              </>
            )}
          </span>
        </div>
      ) : (
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onQtyDelta(-1)}
            disabled={li.qty <= 1}
            className="flex h-6 w-6 items-center justify-center rounded border border-surface-border text-sm text-navy/70 hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-30 transition-colors"
          >
            −
          </button>
          <span className="w-8 text-center text-sm font-semibold text-navy">{li.qty}</span>
          <button
            type="button"
            onClick={() => onQtyDelta(1)}
            className="flex h-6 w-6 items-center justify-center rounded border border-surface-border text-sm text-navy/70 hover:bg-surface-raised transition-colors"
          >
            +
          </button>
        </div>
      )}
      {/* Line total */}
      <span className="w-16 text-right text-sm font-semibold text-navy">
        $
        {computeLineSubtotal({
          unitPrice: li.unitPrice,
          qty: li.qty,
          boxes: li.boxes ?? null,
          pieces: li.pieces ?? null,
          unitsPerBox: li.unitsPerBox ?? null,
        }).toFixed(2)}
      </span>
      <button
        type="button"
        onClick={onToggleNoteOpen}
        className={cn(
          "shrink-0 rounded p-1 transition-colors hover:bg-surface-raised",
          li.note?.trim() ? "text-brand-500" : "text-navy/30 hover:text-navy",
        )}
        title="Add flavor / note"
      >
        <StickyNote className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        onClick={onRemove}
        className="shrink-0 rounded p-1 text-navy/30 hover:bg-surface-raised hover:text-danger transition-colors"
        title="Remove"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </li>
  );
}
