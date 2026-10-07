"use client";

import * as React from "react";
import { X, StickyNote, Pencil } from "lucide-react";
import { cn, type BadgeStatus } from "@routeflow/ui/web";
import { computeLineSubtotal, perUnitPrice } from "@routeflow/pricing";
import { MarginHint } from "@/components/MarginHint";
import { MoneyInput } from "@/components/MoneyInput";
import { PriceChips, PriceHistoryButton } from "@/components/PriceHistory";
import type { PackBase } from "@/lib/order-line-unit";
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
  /** #2696(c): why the price moved — required when it moves off a special (tier) price. */
  overrideReason?: string;
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
  /** units_v1: the non-pack unit this line sells by (`undefined` = the pack). `qty` then counts that
   *  unit and `unitPrice` is per unit — no boxes/pieces. Sent as `unitLabel`. */
  unitLabel?: string;
  /** UI-only: the pack fields a unit switch overwrote, so choosing the pack restores them. */
  packBase?: PackBase;
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
  /** New-order only: shows the customer price-history popover beside the price. Omitted by vendor
   *  bills, the scan screen and read-only rows, which therefore get no button. "Use this price" must
   *  be the line's existing price-change path (`onSetDiscountedPrice`). */
  customerPriceHistory?: {
    customerId?: string | null;
    customerName?: string | null;
    onUsePrice: (price: number) => void;
  };
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
  /** #2696 (b): a typed qty for a plain (non-case) line. When given, the qty between − / + is a
   *  tap-to-type input; when omitted (other callers), it stays the read-only count it was. */
  onSetQty?: (value: number) => void;
  /** Optional control rendered under the price block (the order modal's "Sell by" unit picker). */
  unitSlot?: React.ReactNode;
  /**
   * #2865 case c (SA-632): set while this line's default selling unit is not yet resolved (a PENDING line). Every
   * quantity control is disabled (aria-busy) and the row shows the tap count with "loading units", or, when the
   * ladder failed to load, a readable error and a real Retry button. `taps` is the PENDING TAP COUNT (N taps = N
   * of the default unit once it resolves), never a quantity in a guessed unit.
   */
  pendingUnit?: {
    status: "loading" | "failed";
    taps: number;
    onRetry: () => void;
    /** A Retry is in flight: the button is disabled and says so; a failed retry returns to the failed state. */
    retrying?: boolean;
  };

  /** Registers/unregisters this row's root `<li>` with the caller (e.g.
   *  `CreateOrderModal`'s `rowRefs` map, used to scroll a just-scanned/just-added
   *  row into view). Optional — a consumer with no such need omits it. */
  rowRef?: (el: HTMLLIElement | null) => void;

  // ── Read-only / order-detail variant (order-ui-redesign-spec.md §6.1) ──
  // Reserved, unused: the read-only row shipped as the sibling `LineItemRowReadOnly`
  // (this row takes 14 required edit callbacks, so a prop variant would force no-ops on
  // every read-only caller). Use that component for order-detail; these props stay only so
  // existing type imports keep compiling.
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

/** SA-558d: the ONE case/unit wording, shared by the row and the scan screen's PriceEditor. */
export const caseWord = (n: number | null | undefined) => (n === 1 ? "box" : "boxes");
export const unitWord = (n: number | null | undefined) => (n === 1 ? "pc" : "pcs");

/**
 * Renders one order line item: name/price display, the case/unit qty controls
 * (or a plain +/- stepper for non-boxed products), the live line total, the
 * per-line note toggle, and remove. Pure lift-and-parametrize out of
 * `CreateOrderModal.tsx`'s inline `.map()` — every branch below existed there
 * unchanged; see that file's git history for prior art. No behavior change.
 */
/**
 * #2696 (d): on a case-packed line in Case mode the loose-units field is OPT-IN ("+ units"), never
 * shown by default — so a new line submits pieces = 0. Shown whenever pieces > 0 regardless (an
 * edited line with boxes + pieces, or one switched back from Unit mode, never hides its units).
 * Shared by the row and the scan screen's PriceEditor so the two cannot drift.
 */
export function useLooseUnitsToggle(pieces: number | null | undefined) {
  const [open, setOpen] = React.useState(false);
  return {
    showLooseUnits: open || (pieces ?? 0) > 0,
    openLooseUnits: () => setOpen(true),
    closeLooseUnits: () => setOpen(false),
  };
}

export function LineItemRow({
  item: li,
  category,
  marginFloor,
  floorAcked,
  costRevealed,
  priceHistoryEntry,
  customerPriceHistory,
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
  unitSlot,
  pendingUnit,
  onTapPrice,
  onSetQty,
  rowRef,
}: LineItemRowProps) {
  const { showLooseUnits, openLooseUnits, closeLooseUnits } = useLooseUnitsToggle(li.pieces);
  const qtyLocked = !!pendingUnit;
  const historyButton = customerPriceHistory && !li.isUnlisted && (
    <PriceHistoryButton
      customerId={customerPriceHistory.customerId}
      customerName={customerPriceHistory.customerName}
      productId={li.productId || null}
      productName={li.productName}
      unitHint={li.unitLabel ?? (li.unitsPerBox && li.unitsPerBox > 1 ? "case" : li.unit)}
      packHint={li.unitsPerBox ?? null}
      onUsePrice={customerPriceHistory.onUsePrice}
      focusSelector="[data-line-price-input]"
    />
  );
  return (
    <li
      ref={rowRef}
      className={cn(
        // B565: under `sm` the row is a 2-column grid (info | actions, then qty | total) so
        // the boxed controls no longer squeeze the info column to ~40px at 390px. From `sm`
        // up it is the original single flex row — the grid-placement classes on the
        // children are inert inside a flex container.
        "grid grid-cols-[minmax(0,1fr)_auto] gap-x-2 gap-y-2 px-3 py-2.5 sm:flex sm:items-start sm:gap-3",
        category ? "border-l-2 border-l-amber-300 bg-amber-50/30" : "",
        highlighted ? "ring-2 ring-brand-500" : "",
      )}
    >
      {li.isUnlisted ? (
        // ── Unlisted (custom) line — editable name + price, no catalog data ──
        <div className="col-start-1 row-start-1 min-w-0 flex-1 space-y-1">
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
            <textarea
              rows={2}
              maxLength={2000}
              value={li.note ?? ""}
              onChange={(e) => onSetNote(e.target.value)}
              placeholder="Flavor or note for this item (prints on invoice)"
              className="mt-1 w-full resize-y rounded border border-surface-border bg-white px-2 py-1 text-xs text-navy placeholder:text-navy/40 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          )}
        </div>
      ) : (
        <div className="col-start-1 row-start-1 min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-navy">{li.productName}</p>
          {/* Price display with special/discount indicators */}
          <div
            className={cn(
              "mt-0.5 flex flex-wrap items-center gap-1.5",
              onTapPrice ? "cursor-pointer" : "",
            )}
            onClick={qtyLocked ? undefined : onTapPrice}
            aria-disabled={onTapPrice && qtyLocked ? true : undefined}
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
            {onTapPrice && (
              <>
                <Pencil aria-label="Change price" className="h-3 w-3 text-navy/50" />
                <span className="text-[10px] text-navy/50 underline sm:hidden">Tap to change</span>
              </>
            )}
          </div>
          {/* Price history: its own row so it shows in EVERY configuration — the price input only
              renders without `onTapPrice`, and both real callers pass it (tap-to-edit price). */}
          {historyButton && (
            <div className="mt-0.5 flex items-center gap-1 text-[10px] text-navy/60">
              {historyButton}
              <span className="hidden whitespace-nowrap sm:inline">Price history</span>
              <PriceChips
                customerId={customerPriceHistory?.customerId}
                productId={li.productId || null}
                unitHint={li.unitLabel ?? (li.unitsPerBox && li.unitsPerBox > 1 ? "case" : li.unit)}
                packHint={li.unitsPerBox ?? null}
                onUsePrice={customerPriceHistory!.onUsePrice}
              />
            </div>
          )}
          {/* Price per piece (when product has box packaging) */}
          {li.unitsPerBox && li.unitsPerBox > 1 && (
            <div className="mt-0.5 text-[10px] text-navy/70">
              ${perUnitPrice(li.unitPrice, li.unitsPerBox)?.toFixed(2)} / piece
            </div>
          )}
          {unitSlot && <div className="mt-1">{unitSlot}</div>}
          {/* #2865 F2: the pending-unit status lives IN the info column (full width at every breakpoint). As a row child it
              became a fourth flex item at sm+ and was crushed between the qty controls and the total. */}
          {pendingUnit && <PendingUnitStatus pending={pendingUnit} />}
          {/* Regulated tag (regulated-items-spec: "{Category} · regulated"). */}
          {category && (
            <span className="mt-1 inline-flex items-center rounded-full bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 ring-1 ring-amber-200">
              {category.name} · regulated
            </span>
          )}
          {/* One-time discount input (only when no special price already applied). #2696 (b): when
              the price is tap-to-edit (onTapPrice), the sheet owns the price — no inline box. */}
          {li.priceType !== "SPECIAL" && !onTapPrice && (
            <div className="mt-1 flex items-center gap-1 flex-wrap">
              <span className="text-[10px] text-navy/70">
                {li.unitsPerBox && li.unitsPerBox > 1 ? "Box price:" : "Price:"}
              </span>
              <MoneyInput
                min={0}
                placeholder={li.listPrice.toFixed(2)}
                value={li.discountedPrice ?? null}
                onChange={(v) => onSetDiscountedPrice(v)}
                disabled={qtyLocked}
                data-line-price-input
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
            <textarea
              rows={2}
              maxLength={2000}
              value={li.note ?? ""}
              onChange={(e) => onSetNote(e.target.value)}
              placeholder="Flavor or note for this item (prints on invoice)"
              className="mt-1 w-full resize-y rounded border border-surface-border bg-white px-2 py-1 text-xs text-navy placeholder:text-navy/40 focus:outline-none focus:ring-1 focus:ring-brand-500"
            />
          )}
        </div>
      )}
      {/* Qty controls */}
      {li.unitsPerBox ? (
        // Not #2080 — a narrower 320px glitch found alongside it: the grid's `minmax(0,1fr)`
        // track resolves to ~170-182px there, and a `min-w-[190px]` floor forced this column
        // past it. `min-w-0` below `sm` lets the column shrink; its CONTENT fits the shrunk
        // track because the cases/units row below wraps (spec 56 measures the content, not
        // this box). `sm:min-w-[190px]` keeps desktop unchanged.
        <fieldset
          data-testid="line-qty-controls"
          disabled={qtyLocked}
          aria-busy={qtyLocked}
          aria-label={
            qtyLocked
              ? "Line quantity controls, locked while the selling unit loads"
              : "Line quantity controls"
          }
          className="col-start-1 row-start-2 m-0 flex min-w-0 flex-col gap-0.5 border-0 p-0 sm:min-w-[190px]"
        >
          {/* Case | Unit sell-by toggle — UI-only; the payload always
              carries {qty, boxes, pieces} regardless of the mode. */}
          <div className="inline-flex self-start overflow-hidden rounded border border-surface-border text-[10px] font-medium">
            <button
              type="button"
              disabled={qtyLocked}
              onClick={() => onSetSellBy("case")}
              className={cn(
                "px-1.5 py-0.5 transition-colors",
                (li.sellBy ?? "case") === "case"
                  ? "bg-brand-500 text-white"
                  : "bg-white text-navy/70 hover:bg-surface-raised",
              )}
            >
              Box
            </button>
            <button
              type="button"
              disabled={qtyLocked}
              onClick={() => onSetSellBy("unit")}
              className={cn(
                "border-l border-surface-border px-1.5 py-0.5 transition-colors",
                li.sellBy === "unit"
                  ? "bg-brand-500 text-white"
                  : "bg-white text-navy/70 hover:bg-surface-raised",
              )}
            >
              Piece
            </button>
          </div>
          {li.sellBy === "unit" ? (
            <div className="flex items-center gap-1.5">
              <input
                disabled={qtyLocked}
                type="number"
                min={0}
                value={li.qty}
                onChange={(e) => onSetUnitQty(parseInt(e.target.value, 10) || 0)}
                onFocus={(e) => e.target.select()}
                className="w-16 rounded border border-surface-border bg-white px-1.5 py-1 text-center text-sm font-semibold text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
                title="Total pieces"
              />
              <span className="text-xs text-navy/70">pcs</span>
            </div>
          ) : (
            // Two no-wrap groups in a wrapping row: "[n] cases" and "+ [n] units" together
            // need ~186px, but under `sm` the column's track can be narrower (~170-182px at
            // 320px, less as the line total in column 2 grows). The second group drops to
            // its own line there instead of overflowing into the line total; on one line
            // (every `sm`+ layout) nothing changes.
            <div
              data-testid="line-qty-cases-row"
              className="flex flex-wrap items-center gap-x-1.5 gap-y-1"
            >
              <span className="flex items-center gap-1.5 whitespace-nowrap">
                <input
                  disabled={qtyLocked}
                  type="number"
                  min={0}
                  value={li.boxes ?? 0}
                  onChange={(e) => onSetBoxes(parseInt(e.target.value, 10))}
                  onFocus={(e) => e.target.select()}
                  className="w-12 rounded border border-surface-border bg-white px-1.5 py-1 text-center text-sm font-semibold text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
                  title="Number of whole boxes"
                />
                <span className="text-xs text-navy/70">{caseWord(li.boxes ?? 0)}</span>
              </span>
              {showLooseUnits ? (
                <span className="flex items-center gap-1.5 whitespace-nowrap">
                  <span className="text-xs text-navy/30">+</span>
                  <input
                    disabled={qtyLocked}
                    type="number"
                    min={0}
                    max={li.unitsPerBox - 1}
                    value={li.pieces ?? 0}
                    onChange={(e) => onSetPieces(parseInt(e.target.value, 10))}
                    onFocus={(e) => e.target.select()}
                    className="w-12 rounded border border-surface-border bg-white px-1.5 py-1 text-center text-sm font-semibold text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
                    title="Extra pieces (less than a full box)"
                    aria-label="Extra pieces"
                  />
                  <span className="text-xs text-navy/70">{unitWord(li.pieces ?? 0)}</span>
                  {/* SA-563: hidden at 0 cases — the units ARE the line then, never a removable extra. */}
                  {(li.boxes ?? 0) >= 1 && (
                    <button
                      disabled={qtyLocked}
                      type="button"
                      onClick={() => {
                        onSetPieces(0);
                        closeLooseUnits();
                      }}
                      aria-label="Remove extra pieces"
                      className="relative before:absolute before:-inset-2 before:content-[''] text-xs text-navy/50 hover:text-danger"
                    >
                      ×
                    </button>
                  )}
                </span>
              ) : (
                <button
                  type="button"
                  disabled={qtyLocked}
                  onClick={openLooseUnits}
                  // hitSlop 8 (mobile parity, #2706): the pseudo-element grows the tap target, not the layout.
                  className="relative before:absolute before:-inset-2 before:content-[''] whitespace-nowrap rounded border border-dashed border-surface-border px-1.5 py-0.5 text-[10px] font-medium text-navy/60 hover:bg-surface-raised"
                >
                  + pieces
                </button>
              )}
            </div>
          )}
          <span className="text-[10px] text-navy/30">
            1 box = {li.unitsPerBox} pcs
            {li.qty > 0 && (
              <>
                {" "}
                · <span className="font-medium text-navy/70">{li.qty} pcs total</span>
              </>
            )}
          </span>
        </fieldset>
      ) : (
        <fieldset
          disabled={qtyLocked}
          aria-busy={qtyLocked}
          aria-label={
            qtyLocked
              ? "Line quantity controls, locked while the selling unit loads"
              : "Line quantity controls"
          }
          className="col-start-1 row-start-2 m-0 flex min-w-0 items-center gap-1 border-0 p-0"
        >
          <button
            type="button"
            onClick={() => onQtyDelta(-1)}
            disabled={li.qty <= 1}
            className="flex h-6 w-6 items-center justify-center rounded border border-surface-border text-sm text-navy/70 hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-30 transition-colors"
          >
            −
          </button>
          {onSetQty ? (
            <input
              disabled={qtyLocked}
              type="number"
              inputMode="numeric"
              min={1}
              value={li.qty}
              onChange={(e) => onSetQty(parseInt(e.target.value, 10))}
              onFocus={(e) => e.target.select()}
              aria-label="Quantity"
              className="h-6 w-10 rounded border border-surface-border bg-white px-1 text-center text-sm font-semibold text-navy [appearance:textfield] focus:outline-none focus:ring-1 focus:ring-brand-500 [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
            />
          ) : (
            <span className="w-8 text-center text-sm font-semibold text-navy">{li.qty}</span>
          )}
          <button
            type="button"
            disabled={qtyLocked}
            onClick={() => onQtyDelta(1)}
            className="flex h-6 w-6 items-center justify-center rounded border border-surface-border text-sm text-navy/70 hover:bg-surface-raised transition-colors"
          >
            +
          </button>
        </fieldset>
      )}
      {/* Line total */}
      <span
        data-testid="line-total"
        className="col-start-2 row-start-2 self-center text-right text-sm font-semibold text-navy sm:w-16 sm:self-auto"
      >
        $
        {computeLineSubtotal({
          unitPrice: li.unitPrice,
          qty: li.qty,
          boxes: li.boxes ?? null,
          pieces: li.pieces ?? null,
          unitsPerBox: li.unitsPerBox ?? null,
        }).toFixed(2)}
      </span>
      <div
        data-testid="line-actions-column"
        className="col-start-2 row-start-1 flex shrink-0 items-start gap-2 sm:gap-3"
      >
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
      </div>
    </li>
  );
}

/** The pending-unit status under a locked quantity: the tap count + "loading units", or the failure + a real Retry button. */
export function PendingUnitStatus({
  pending,
}: {
  pending: NonNullable<LineItemRowProps["pendingUnit"]>;
}) {
  return pending.status === "failed" ? (
    <div
      role="alert"
      data-testid="pending-unit-status"
      className="mt-1 flex w-full flex-wrap items-center gap-2 text-xs text-danger"
    >
      <span>{pending.taps} added · Couldn&apos;t load the selling units.</span>
      <button
        type="button"
        onClick={pending.onRetry}
        // #2865 F2: the order form's keydown rule preventDefaults Enter (no implicit submit), which also cancels a
        // button's native Enter activation. Stop only THIS button's Enter from reaching it; every other control keeps it.
        onKeyDown={(e) => {
          if (e.key === "Enter") e.stopPropagation();
        }}
        disabled={pending.retrying}
        aria-busy={pending.retrying || undefined}
        className="rounded border border-danger/40 px-2 py-0.5 font-medium hover:bg-danger/10 focus:outline-none focus:ring-2 focus:ring-brand-500 disabled:opacity-60"
      >
        {pending.retrying ? "Retrying…" : "Retry"}
      </button>
    </div>
  ) : (
    <div
      role="status"
      aria-live="polite"
      data-testid="pending-unit-status"
      className="mt-1 w-full text-xs text-navy/60"
    >
      {pending.taps} · loading units
    </div>
  );
}
