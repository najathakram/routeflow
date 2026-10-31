import * as React from "react";
import { TAP_TARGET, cn } from "@routeflow/ui/web";
import { formatReceiptMoney as money, unitWords } from "@routeflow/pricing";
import { priceUnitWord } from "@/lib/product-unit-label";
import { cartTotals } from "@/lib/counter-sale";
import {
  NOTE_MAX,
  isBoxedLine,
  registerPriceLabel,
  registerQtyLabel,
  sellingUnitLabel,
  typedQtyOverCap,
  type TypedQty,
} from "./counter-sale-line-edit";
import {
  qtyRefusalMessage,
  QTY_AT_CAP_HINT,
  QTY_TOO_LARGE_COPY,
  type QtyFieldKind,
} from "./counter-qty-refusal";
import { stepLine, type SaleLine, type StepUnit } from "./counter-sale-scan";
import { CounterLinePriceEdit, type CounterPriceEdit } from "./CounterLinePriceEdit";
import { cartStrikesList, editedLineFigures, priceEditLineOf } from "./counter-sale-price-edit";
import { PriceHistoryButton } from "@/components/PriceHistory";

// SA-934 A-1: the words are the builder's call, per line (LineItemRow): the product's own pack and base words when the line
// carries them, else the defaults (a line held before this has neither and prints Box / pcs). A plain line prints its own unit (row 298).
const wordsOf = (l: SaleLine) => unitWords({ packLabel: l.packLabel, baseUnitLabel: l.baseLabel });

/** Every compact line control is a full 44 px target (TAP_TARGET) however small it looks. */
const LINE_BTN = cn(TAP_TARGET, "rounded border px-2 text-xs disabled:opacity-40");

/** W-717: the note buttons are secondary to the steppers, so they drop the border (one weight per role, not six equal boxes). */
const LINE_BTN_QUIET = cn(
  TAP_TARGET,
  "rounded px-2 text-xs text-navy/70 underline-offset-2 hover:underline disabled:opacity-40",
);

/** B1208: a boxed line steps by a box or a piece; a plain line by one. Nothing steps a line to zero (x removes it). */
export function LineStepper({
  line,
  locked,
  onStep,
}: {
  line: SaleLine;
  locked: boolean;
  onStep: (tempId: string, unit: StepUnit, dir: 1 | -1) => void;
}) {
  const hintId = React.useId();
  // A "+" that is off only because the line is full says so (a disabled button alone gives no reason).
  const atCap = (unit: StepUnit, dir: 1 | -1) =>
    dir === 1 && !locked && stepLine(line, unit, dir) === line;
  const anyAtCap = atCap("piece", 1) || (isBoxedLine(line) && atCap("box", 1));
  const hint = anyAtCap ? (
    <span id={hintId} className="basis-full text-xs text-navy/70" data-testid="counter-line-full">
      {QTY_AT_CAP_HINT}
    </span>
  ) : null;
  const btn = (label: string, text: string, unit: StepUnit, dir: 1 | -1) => (
    <button
      type="button"
      className={LINE_BTN}
      aria-label={label}
      aria-describedby={atCap(unit, dir) ? hintId : undefined}
      disabled={locked || stepLine(line, unit, dir) === line}
      onClick={() => onStep(line.tempId, unit, dir)}
    >
      {text}
    </button>
  );
  const w = wordsOf(line);
  const unitLabel = sellingUnitLabel(line, w);
  return isBoxedLine(line) ? (
    <span
      className="flex flex-wrap items-center gap-1"
      role="group"
      aria-label={`Quantity of ${line.name}`}
    >
      {btn(`Remove a box from ${line.name}`, `\u2212 ${unitLabel}`, "box", -1)}
      {btn(`Add a box to ${line.name}`, `+ ${unitLabel}`, "box", 1)}
      {btn(`Remove a piece from ${line.name}`, `\u2212 1 ${w.baseShortFor(1)}`, "piece", -1)}
      {btn(`Add a piece to ${line.name}`, `+ 1 ${w.baseShortFor(1)}`, "piece", 1)}
      {hint}
    </span>
  ) : (
    <span
      className="flex flex-wrap items-center gap-1"
      role="group"
      aria-label={`Quantity of ${line.name}`}
    >
      {btn(`Remove one ${line.name}`, "\u2212", "piece", -1)}
      {btn(`Add one ${line.name}`, "+", "piece", 1)}
      {hint}
    </span>
  );
}

/**
 * A TYPED quantity field (the steppers stay). The draft is local: Enter / blur commit it, Escape reverts, and a value the
 * screen refuses (not whole, or nothing left) snaps back to the line's quantity AND says why (CQ-12), until the next edit.
 */
function QtyField({
  label,
  kind,
  value,
  locked,
  onCommit,
  overCap,
  onEnter,
  tabOut = false,
}: {
  label: string;
  kind: QtyFieldKind;
  value: number;
  locked: boolean;
  onCommit: (text: string) => boolean;
  /** A clean whole number the cap alone refuses (a boxed line's boxes and pieces together): the row words it. */
  overCap?: (text: string) => boolean;
  onEnter?: () => void;
  /** The LAST quantity field of the line: Tab with a typed draft commits it and hands focus to the scan box. */
  tabOut?: boolean;
}) {
  const [draft, setDraft] = React.useState<string | null>(null);
  const [refusal, setRefusal] = React.useState<string | null>(null);
  const messageId = React.useId();
  const commit = () => {
    if (draft === null) return;
    const text = draft;
    setDraft(null); // accepted or refused, the field re-reads the line
    setRefusal(
      onCommit(text)
        ? null
        : (qtyRefusalMessage(text, kind) ?? (overCap?.(text) ? QTY_TOO_LARGE_COPY : null)),
    );
  };
  return (
    <>
      <input
        type="number"
        inputMode="numeric"
        min={0}
        step={1}
        aria-label={label}
        aria-invalid={refusal ? true : undefined}
        aria-describedby={refusal ? messageId : undefined}
        className="min-h-[44px] w-20 rounded border px-2 text-center text-sm disabled:opacity-40"
        disabled={locked}
        value={draft ?? String(value)}
        onChange={(e) => {
          setRefusal(null);
          setDraft(e.target.value);
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          // Tab is redirected only to finish an uncommitted typed edit; a plain Tab moves on normally
          if (e.key === "Enter" || (tabOut && e.key === "Tab" && !e.shiftKey && draft !== null)) {
            e.preventDefault();
            commit();
            onEnter?.();
          } else if (e.key === "Escape") {
            e.preventDefault();
            setRefusal(null);
            setDraft(null);
          }
        }}
      />
      {refusal ? (
        <span
          id={messageId}
          role="alert"
          className="basis-full text-xs text-red-700"
          data-testid="counter-qty-refusal"
        >
          {refusal}
        </span>
      ) : null}
    </>
  );
}

/** The typed editor for one line: a quantity for a plain line, boxes + pieces for a boxed one. */
function LineQtyEditor({
  line,
  locked,
  onQty,
  onEnter,
}: {
  line: SaleLine;
  locked: boolean;
  onQty: (tempId: string, typed: TypedQty) => boolean;
  onEnter?: () => void;
}) {
  return isBoxedLine(line) ? (
    <span className="flex flex-wrap items-center gap-1">
      <QtyField
        kind="boxes"
        label={`Boxes of ${line.name}`}
        value={line.boxes ?? 0}
        locked={locked}
        onCommit={(t) => onQty(line.tempId, { boxes: t })}
        overCap={(t) => typedQtyOverCap(line, { boxes: t })}
        onEnter={onEnter}
      />
      <QtyField
        kind="pieces"
        label={`Pieces of ${line.name}`}
        value={line.pieces ?? 0}
        locked={locked}
        onCommit={(t) => onQty(line.tempId, { pieces: t })}
        overCap={(t) => typedQtyOverCap(line, { pieces: t })}
        onEnter={onEnter}
        tabOut
      />
    </span>
  ) : (
    <QtyField
      kind="qty"
      label={`Set quantity of ${line.name}`}
      value={line.qty}
      locked={locked}
      onCommit={(t) => onQty(line.tempId, { qty: t })}
      overCap={(t) => typedQtyOverCap(line, { qty: t })}
      onEnter={onEnter}
      tabOut
    />
  );
}

/**
 * One cart line. Top row: name + quantity label, subtotal, remove. Below: the stepper and the note. `locked` disables EVERY
 * control on the line (an unknown outcome, or the sale POST in flight).
 */
/** R7b 1.4: the one sentence (a line and the Payment area both say it; the server refusal at Complete stays authoritative). */
export const COUNTER_LICENSE_NOTE = "Needs a licensed customer: choose one before paying";

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
  onQtyEnter,
  hideOriginalPrice = false,
}: {
  line: SaleLine;
  locked: boolean;
  onStep: (tempId: string, unit: StepUnit, dir: 1 | -1) => void;
  onRemove: (tempId: string) => void;
  onNote: (tempId: string, note: string) => void;
  /** R7b 1.4: a walk-in sale holds a line that needs a licensed customer: show the one amber note on the line. */
  needsLicense?: boolean;
  onQty: (tempId: string, typed: TypedQty) => boolean;
  /** POS-5: the ONE gate (`staffMay(role, "EDIT_LINE_PRICE")`). False = the price control does not exist (hidden, never disabled). */
  canEditPrices?: boolean;
  /** POS-5: the customer's pricing tier for this product (a special tier needs a reason for a real change) */
  priceTier?: number;
  customerName?: string;
  /** W-853: the NAMED customer (never a walk-in) whose past prices the line offers; shown only with `canEditPrices`. */
  historyCustomerId?: string | null;
  onPriceEdit?: (tempId: string, edit: CounterPriceEdit) => void;
  onPriceReset?: (tempId: string) => void;
  onPriceClosed?: () => void;
  /** The note field closed (Enter, Escape, Clear note or the toggle): the screen re-arms the scan field (SA-762r #8). */
  onNoteClosed?: () => void;
  /** Enter on a typed quantity: the screen hands focus back to the scan field. */
  onQtyEnter?: () => void;
  /** The tenant's `invoice.hideOriginalPrice` (`GET /settings`): no struck catalogue price, as on the receipt. */
  hideOriginalPrice?: boolean;
}) {
  const [editing, setEditing] = React.useState(false);
  const [historyPick, setHistoryPick] = React.useState<{ value: number } | null>(null);
  const noteAtOpenRef = React.useRef(""); // Escape puts the note back to what it was when the field opened
  const closeNote = () => {
    setEditing(false);
    onNoteClosed?.();
  };
  const hasNote = !!l.note?.trim();
  const edited = editedLineFigures(l, hideOriginalPrice);
  return (
    <li className="flex flex-col gap-2 p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 break-words">
          {l.name} · {registerQtyLabel(l, wordsOf(l))}
          <span className="block text-xs text-navy/70">
            {cartStrikesList(l, hideOriginalPrice) ? (
              <s className="mr-1 tabular-nums text-navy/50" data-testid="line-unit-price-was">
                {money(l.listPrice ?? l.unitPrice)}
              </s>
            ) : null}
            <span className="tabular-nums" data-testid="line-unit-price">
              {registerPriceLabel(l, wordsOf(l), money, priceUnitWord)}
            </span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {edited?.original != null ? (
            <s className="text-xs text-navy/60" data-testid="line-original-total">
              {money(edited.original)}
            </s>
          ) : null}
          <span data-testid={edited ? "line-net-total" : undefined}>
            {money(cartTotals([l], 0).subtotal)}
          </span>
          <button
            type="button"
            className={LINE_BTN}
            aria-label={`Remove ${l.name}`}
            disabled={locked}
            onClick={() => onRemove(l.tempId)}
          >
            ×
          </button>
        </span>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <LineStepper line={l} locked={locked} onStep={onStep} />
        <LineQtyEditor line={l} locked={locked} onQty={onQty} onEnter={onQtyEnter} />
        <CounterLinePriceEdit
          canEditPrices={canEditPrices}
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
        {canEditPrices && historyCustomerId && l.productId ? (
          <fieldset disabled={locked} className="contents">
            <PriceHistoryButton
              customerId={historyCustomerId}
              customerName={customerName}
              productId={l.productId}
              productName={l.name}
              unitHint={isBoxedLine(l) ? "case" : l.unit}
              packHint={l.unitsPerBox ?? null}
              // Use opens the price dialog at that number: nothing is priced until Apply (the one write)
              onUsePrice={(price) => !locked && setHistoryPick({ value: price })}
            />
          </fieldset>
        ) : null}
        {edited ? (
          <span
            className="rounded bg-navy/5 px-2 py-1 text-xs text-navy"
            data-testid="line-price-chip"
          >
            {edited.chip}
          </span>
        ) : null}
        {l.remembered && !l.override ? (
          <span
            className="rounded bg-navy/5 px-2 py-1 text-xs text-navy"
            data-testid="line-last-price-chip"
          >
            Last price
          </span>
        ) : null}
        <button
          type="button"
          className={LINE_BTN_QUIET}
          aria-label={`${hasNote ? "Edit the note on" : "Add a note to"} ${l.name}`}
          aria-expanded={editing}
          disabled={locked}
          onClick={() => {
            if (editing) return closeNote();
            noteAtOpenRef.current = l.note ?? "";
            setEditing(true);
          }}
        >
          {hasNote ? "Edit note" : "Add note"}
        </button>
        {hasNote ? (
          <button
            type="button"
            className={LINE_BTN_QUIET}
            aria-label={`Clear the note on ${l.name}`}
            disabled={locked}
            onClick={() => {
              onNote(l.tempId, "");
              closeNote();
            }}
          >
            Clear note
          </button>
        ) : null}
      </div>
      {editing ? (
        <input
          type="text"
          maxLength={NOTE_MAX}
          aria-label={`Note for ${l.name}`}
          className="min-h-[44px] w-full text-ellipsis rounded border px-2 py-1 text-sm"
          placeholder="Flavor or note for this item (prints on invoice)"
          disabled={locked}
          value={l.note ?? ""}
          onChange={(e) => onNote(l.tempId, e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              closeNote(); // saved (each keystroke already is): close and re-arm the scan field
            } else if (e.key === "Escape") {
              e.preventDefault();
              onNote(l.tempId, noteAtOpenRef.current);
              closeNote();
            }
          }}
          onBlur={(e) => {
            // Focus lost to nowhere (a click on blank space): save, close, back to the scan box. Moving to another
            // control on purpose is left alone.
            if (e.relatedTarget === null) closeNote();
          }}
          data-counter-note=""
          autoFocus // opening the note puts the cursor in it: the next keys are the note, never a page shortcut
        />
      ) : hasNote ? (
        <p className="break-words text-xs text-navy/70" data-testid="line-note">
          {l.note}
        </p>
      ) : null}
      {needsLicense ? (
        <p className="text-xs text-amber-800" data-testid="line-license-note">
          {COUNTER_LICENSE_NOTE}
        </p>
      ) : null}
    </li>
  );
}
