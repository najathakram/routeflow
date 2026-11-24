import * as React from "react";
import { LineItemRow, type LineItemRowItem } from "@/components/LineItemRow";
import { NOTE_MAX, isBoxedLine, typedQtyOverCap, type TypedQty } from "./counter-sale-line-edit";
import { QTY_AT_CAP_HINT, QTY_TOO_LARGE_COPY, qtyRefusalMessage } from "./counter-qty-refusal";
import { stepLine, type SaleLine, type StepUnit } from "./counter-sale-scan";
import { CounterLinePriceEdit, type CounterPriceEdit } from "./CounterLinePriceEdit";
import { editedLineFigures, priceEditLineOf } from "./counter-sale-price-edit";
import type { LineStockView } from "@/lib/line-stock";

/** R7b 1.4: the one sentence (a line and the Payment area both say it; the server refusal at Complete stays authoritative). */
export const COUNTER_LICENSE_NOTE = "Needs a licensed customer: choose one before paying";

/**
 * B1373: the price state of a counter line in the order row's words. An edited line is DISCOUNTED below its catalogue price
 * and MANUAL ("Upsell") above it; an unedited line keeps the price type the customer's prices gave it (SPECIAL for a tier or
 * a customer price). Display only: the till prices every line through cartTotals -> @routeflow/pricing.
 */
export function counterPriceType(l: SaleLine): LineItemRowItem["priceType"] {
  const list = l.listPrice;
  if (l.override) {
    if (list === undefined || l.unitPrice === list) return "STANDARD";
    return l.unitPrice < list ? "DISCOUNTED" : "MANUAL";
  }
  return l.priceType === "SPECIAL" || l.special ? "SPECIAL" : "STANDARD";
}

/** B1373: a till line as the order builder's `LineItemRow` reads it. UI-only fields (note open, sell-by) come from the row. */
export function counterRowItem(
  l: SaleLine,
  ui: { noteOpen?: boolean; sellBy?: "case" | "unit" } = {},
): LineItemRowItem {
  const boxed = isBoxedLine(l);
  return {
    tempId: l.tempId,
    productId: l.productId,
    productName: l.name,
    unit: l.unit || "piece", // the till's word for a line held without one (a plain line printed "/ piece")
    packLabel: l.packLabel,
    baseLabel: l.baseLabel,
    listPrice: l.listPrice ?? l.tierPrice ?? l.unitPrice,
    unitPrice: l.unitPrice,
    priceType: counterPriceType(l),
    qty: l.qty,
    // a pack of 1 is a plain line on the till (isBoxedLine): the order row then shows its plain stepper
    ...(boxed ? { unitsPerBox: l.unitsPerBox, boxes: l.boxes ?? 0, pieces: l.pieces ?? 0 } : {}),
    category: l.category,
    trackedCategoryId: l.trackedCategoryId ?? null,
    note: l.note,
    noteOpen: ui.noteOpen,
    sellBy: boxed ? ui.sellBy : undefined,
  };
}

/**
 * One cart line, drawn by the order builder's `LineItemRow` (B1373: the till lists its lines the way the regular order does).
 * The till's own rules stay here: `locked` disables EVERY control (an unknown outcome, or the sale POST in flight); a typed
 * quantity goes through `setLineQty` (whole numbers, the 100,000-piece cap, said when refused); the price changes only through
 * the till's price dialog (tap the price), gated by EDIT_LINE_PRICE; History opens that dialog at the picked price.
 */
/** SA-1262: the till holds a quantity box's text until Enter, Tab or blur (a scan into a box is one whole number). */
const COUNTER_QTY_ENTRY = { commit: "enter" } as const;

export function CounterLineRow({
  line: l,
  locked,
  onStep,
  onRemove,
  onNote,
  needsLicense,
  onQty,
  canEditPrices = false,
  priceTier = 1,
  customerName,
  historyCustomerId = null,
  onPriceEdit,
  onPriceReset,
  onPriceClosed,
  onNoteClosed,
  hideOriginalPrice = false,
  moveId,
  stock,
  active = true,
}: {
  line: SaleLine;
  locked: boolean;
  onStep: (tempId: string, unit: StepUnit, dir: 1 | -1) => void;
  onRemove: (tempId: string) => void;
  onNote: (tempId: string, note: string) => void;
  /** R7b 1.4: a walk-in sale holds a line that needs a licensed customer: show the one amber note on the line. */
  needsLicense?: boolean;
  /** A typed quantity (raw field text); false = refused, the line is unchanged. */
  onQty: (tempId: string, typed: TypedQty) => boolean;
  /** POS-5: the ONE gate (`staffMay(role, "EDIT_LINE_PRICE")`). False = the price cannot be changed (no pencil, no dialog). */
  canEditPrices?: boolean;
  /** POS-5: the customer's pricing tier for this product (a special tier needs a reason for a real change) */
  priceTier?: number;
  customerName?: string;
  /** W-853: the NAMED customer (never a walk-in) whose past prices the line offers; shown only with `canEditPrices`. */
  historyCustomerId?: string | null;
  onPriceEdit?: (tempId: string, edit: CounterPriceEdit) => void;
  onPriceReset?: (tempId: string) => void;
  onPriceClosed?: () => void;
  /** The note field closed (Enter, Escape or the note toggle): the screen re-arms the scan field (SA-762r #8). */
  onNoteClosed?: () => void;
  /** The tenant's `invoice.hideOriginalPrice` (`GET /settings`): no struck catalogue price, as on the receipt. */
  hideOriginalPrice?: boolean;
  /** SA-1086 PR-2: the live stock note for this line (one read for the cart, see `useCounterLineStock`); a note, never a gate. */
  stock?: LineStockView;
  /** W-1187 PR-2b: the row's id inside the till's `SortableLines`; absent = no drag handle. */
  moveId?: string;
  /** Q09 (as in Create Order): only the line being worked on (the newest) shows "Tap to change" under its price. */
  active?: boolean;
}) {
  const [noteOpen, setNoteOpen] = React.useState(false);
  const [sellBy, setSellBy] = React.useState<"case" | "unit">("case");
  const [historyPick, setHistoryPick] = React.useState<{ value: number } | null>(null);
  const [priceRequest, setPriceRequest] = React.useState(0);
  const [refusal, setRefusal] = React.useState<string | null>(null);
  const noteAtOpenRef = React.useRef(""); // Escape puts the note back to what it was when the field took focus
  const boxed = isBoxedLine(l);
  const edited = editedLineFigures(l, hideOriginalPrice);
  const priceEditable = canEditPrices && !locked;

  const closeNote = () => {
    setNoteOpen(false);
    onNoteClosed?.();
  };
  /**
   * A typed quantity: NaN is a field mid-edit (left alone). Every refusal says why on the line: the field's own text first
   * (zero, too large; a boxed line's 0 boxes and 0 pieces), then a pack total over the cap that no single field shows.
   */
  const typed = (value: number, toTyped: (text: string) => TypedQty) => {
    if (!Number.isFinite(value)) return;
    const t = toTyped(String(value));
    if (onQty(l.tempId, t)) return setRefusal(null);
    // refused because the line is locked: nothing true to add; a plain line's 0 is said by the row's own "at least 1" note
    if (locked || (!boxed && value < 1)) return setRefusal(null);
    setRefusal(
      qtyRefusalMessage(String(value), boxed ? "boxes" : "qty") ??
        (typedQtyOverCap(l, t) ? QTY_TOO_LARGE_COPY : null),
    );
  };
  // A "+" that does nothing only because the line is full says so (a dead button alone gives no reason).
  const atCap = !locked && stepLine(l, "piece", 1) === l;
  const fullHintId = React.useId();

  return (
    <LineItemRow
      item={counterRowItem(l, { noteOpen, sellBy })}
      marginFloor={0}
      floorAcked={false}
      costRevealed={false}
      locked={locked}
      inlinePrice={false}
      noteMaxLength={NOTE_MAX}
      noteAutoFocus
      hideOriginalPrice={hideOriginalPrice}
      touchTargets
      qtyEntry={COUNTER_QTY_ENTRY}
      flexFrom="lg"
      labels={{
        remove: `Remove ${l.name}`,
        note: `${l.note?.trim() ? "Edit the note on" : "Add a note to"} ${l.name}`,
        decrease: `Remove one ${l.name}`,
        increase: `Add one ${l.name}`,
        qty: `Set quantity of ${l.name}`,
        price: `Change price for ${l.name}`,
      }}
      moveId={moveId}
      stock={stock}
      active={active}
      increaseBlockedBy={atCap && !boxed ? fullHintId : undefined}
      onTapPrice={priceEditable ? () => setPriceRequest((n) => n + 1) : undefined}
      customerPriceHistory={
        canEditPrices && historyCustomerId && l.productId
          ? {
              customerId: historyCustomerId,
              customerName,
              // Use opens the price dialog at that number: nothing is priced until Apply (the one write)
              onUsePrice: (price) => !locked && setHistoryPick({ value: price }),
            }
          : undefined
      }
      onQtyDelta={(delta) => {
        setRefusal(null);
        onStep(l.tempId, "piece", delta > 0 ? 1 : -1);
      }}
      onSetQty={(v) => typed(v, (qty) => ({ qty }))}
      onSetBoxes={(v) => typed(v, (boxes) => ({ boxes }))}
      onSetPieces={(v) => typed(v, (pieces) => ({ pieces }))}
      // Unit mode on a boxed line: the typed count is pieces, re-split into boxes + pieces by setLineQty
      onSetUnitQty={(v) => typed(v, (pieces) => ({ boxes: "0", pieces }))}
      onSetSellBy={setSellBy}
      // the till prices only through its dialog (inlinePrice off) and shows no cost, so these never fire
      onSetDiscountedPrice={() => {}}
      onSetToFloor={() => {}}
      onAckFloor={() => {}}
      onToggleCostRevealed={() => {}}
      onUpdateUnlistedName={() => {}}
      onUpdateUnlistedPrice={() => {}}
      onToggleNoteOpen={() => {
        if (noteOpen) return closeNote();
        setNoteOpen(true);
      }}
      onSetNote={(note) => onNote(l.tempId, note.slice(0, NOTE_MAX))}
      // The order row keeps a note's field on screen while it has text, so Escape puts back what was there when the
      // field took focus (not when the toggle opened it: a later edit, or a remounted row, would wipe the saved note).
      onNoteFocus={() => {
        noteAtOpenRef.current = l.note ?? "";
      }}
      // Leaving the field for nowhere (blur, Enter, Escape) closes it and re-arms the scan field. A note with text keeps its
      // field on show, so the field is let go of first: the guarded re-arm never takes focus from a field still in use.
      onNoteBlur={(e) => {
        if (e.relatedTarget === null) closeNote();
      }}
      onNoteKeyDown={(e) => {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          e.currentTarget.blur(); // saved (each keystroke already is)
        } else if (e.key === "Escape") {
          e.preventDefault();
          onNote(l.tempId, noteAtOpenRef.current);
          e.currentTarget.blur();
        }
      }}
      onRemove={() => onRemove(l.tempId)}
      unitSlot={
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <CounterLinePriceEdit
            canEditPrices={canEditPrices}
            trigger={false}
            openRequest={priceRequest}
            name={l.name}
            line={priceEditLineOf(l, priceTier)}
            edited={!!l.override}
            customerName={customerName}
            locked={locked}
            onApply={(edit) => onPriceEdit?.(l.tempId, edit)}
            openWith={historyPick}
            onReset={() => onPriceReset?.(l.tempId)}
            onClosed={onPriceClosed}
          />
          {edited ? (
            <span className="rounded bg-navy/5 px-2 py-1 text-navy" data-testid="line-price-chip">
              {edited.chip}
            </span>
          ) : null}
          {l.remembered && !l.override ? (
            <span
              className="rounded bg-navy/5 px-2 py-1 text-navy"
              data-testid="line-last-price-chip"
            >
              Last price
            </span>
          ) : null}
          {atCap && !boxed ? (
            <span
              id={fullHintId}
              className="basis-full text-navy/70"
              data-testid="counter-line-full"
            >
              {QTY_AT_CAP_HINT}
            </span>
          ) : null}
          {refusal ? (
            <span
              role="alert"
              className="basis-full text-red-700"
              data-testid="counter-qty-refusal"
            >
              {refusal}
            </span>
          ) : null}
          {needsLicense ? (
            <p className="basis-full text-amber-800" data-testid="line-license-note">
              {COUNTER_LICENSE_NOTE}
            </p>
          ) : null}
        </div>
      }
    />
  );
}
