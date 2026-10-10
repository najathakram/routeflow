import * as React from "react";
import { TAP_TARGET, cn } from "@routeflow/ui/web";
import { cartTotals } from "@/lib/counter-sale";
import { NOTE_MAX, isBoxedLine, lineQtyLabel, type TypedQty } from "./counter-sale-line-edit";
import { stepLine, type SaleLine, type StepUnit } from "./counter-sale-scan";
import { CounterLinePriceEdit, type CounterPriceEdit } from "./CounterLinePriceEdit";
import { editedLineFigures, priceEditLineOf } from "./counter-sale-price-edit";

const money = (n: number) => `$${n.toFixed(2)}`;

/** Every compact line control is a full 44 px target (TAP_TARGET) however small it looks. */
const LINE_BTN = cn(TAP_TARGET, "rounded border px-2 text-xs disabled:opacity-40");

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
  const btn = (label: string, text: string, unit: StepUnit, dir: 1 | -1) => (
    <button
      type="button"
      className={LINE_BTN}
      aria-label={label}
      disabled={locked || stepLine(line, unit, dir) === line}
      onClick={() => onStep(line.tempId, unit, dir)}
    >
      {text}
    </button>
  );
  return isBoxedLine(line) ? (
    <span
      className="flex flex-wrap items-center gap-1"
      role="group"
      aria-label={`Quantity of ${line.name}`}
    >
      {btn(`Remove a box from ${line.name}`, "\u2212 box", "box", -1)}
      {btn(`Add a box to ${line.name}`, "+ box", "box", 1)}
      {btn(`Remove a piece from ${line.name}`, "\u2212 pc", "piece", -1)}
      {btn(`Add a piece to ${line.name}`, "+ pc", "piece", 1)}
    </span>
  ) : (
    <span
      className="flex flex-wrap items-center gap-1"
      role="group"
      aria-label={`Quantity of ${line.name}`}
    >
      {btn(`Remove one ${line.name}`, "\u2212", "piece", -1)}
      {btn(`Add one ${line.name}`, "+", "piece", 1)}
    </span>
  );
}

/**
 * A TYPED quantity field (the steppers stay). The draft is local: Enter / blur commit it, Escape reverts, and a value the
 * screen refuses (not whole, or nothing left) snaps back to the line's quantity.
 */
function QtyField({
  label,
  value,
  locked,
  onCommit,
  onEnter,
}: {
  label: string;
  value: number;
  locked: boolean;
  onCommit: (text: string) => boolean;
  onEnter?: () => void;
}) {
  const [draft, setDraft] = React.useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    const text = draft;
    setDraft(null); // accepted or refused, the field re-reads the line
    onCommit(text);
  };
  return (
    <input
      type="number"
      inputMode="numeric"
      min={0}
      step={1}
      aria-label={label}
      className="min-h-[44px] w-16 rounded border px-2 text-center text-sm disabled:opacity-40"
      disabled={locked}
      value={draft ?? String(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          commit();
          onEnter?.();
        } else if (e.key === "Escape") {
          e.preventDefault();
          setDraft(null);
        }
      }}
    />
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
    <span className="flex items-center gap-1">
      <QtyField
        label={`Boxes of ${line.name}`}
        value={line.boxes ?? 0}
        locked={locked}
        onCommit={(t) => onQty(line.tempId, { boxes: t })}
        onEnter={onEnter}
      />
      <QtyField
        label={`Pieces of ${line.name}`}
        value={line.pieces ?? 0}
        locked={locked}
        onCommit={(t) => onQty(line.tempId, { pieces: t })}
        onEnter={onEnter}
      />
    </span>
  ) : (
    <QtyField
      label={`Set quantity of ${line.name}`}
      value={line.qty}
      locked={locked}
      onCommit={(t) => onQty(line.tempId, { qty: t })}
      onEnter={onEnter}
    />
  );
}

/**
 * One cart line. Top row: name + quantity label, subtotal, remove. Below: the stepper and the note. `locked` disables EVERY
 * control on the line (an unknown outcome, or the sale POST in flight).
 */
export function CounterLineRow({
  line: l,
  locked,
  onStep,
  onRemove,
  onNote,
  onQty,
  canEditPrices = false,
  priceTier = 1,
  customerName,
  onPriceEdit,
  onPriceReset,
  onPriceClosed,
  onQtyEnter,
}: {
  line: SaleLine;
  locked: boolean;
  onStep: (tempId: string, unit: StepUnit, dir: 1 | -1) => void;
  onRemove: (tempId: string) => void;
  onNote: (tempId: string, note: string) => void;
  onQty: (tempId: string, typed: TypedQty) => boolean;
  /** POS-5: the ONE gate (`canEditPrices(user)`). False = the price control does not exist (hidden, never disabled). */
  canEditPrices?: boolean;
  /** POS-5: the customer's pricing tier for this product (a special tier needs a reason for a real change) */
  priceTier?: number;
  customerName?: string;
  onPriceEdit?: (tempId: string, edit: CounterPriceEdit) => void;
  onPriceReset?: (tempId: string) => void;
  onPriceClosed?: () => void;
  /** Enter on a typed quantity: the screen hands focus back to the scan field. */
  onQtyEnter?: () => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const hasNote = !!l.note?.trim();
  const edited = editedLineFigures(l);
  return (
    <li className="flex flex-col gap-2 p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 break-words">
          {l.name} · {lineQtyLabel(l)}
        </span>
        <span className="flex shrink-0 items-center gap-2">
          {edited ? (
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
          onReset={() => onPriceReset?.(l.tempId)}
          onClosed={onPriceClosed}
        />
        {edited ? (
          <span
            className="rounded bg-navy/5 px-2 py-1 text-xs text-navy"
            data-testid="line-price-chip"
          >
            {edited.chip}
          </span>
        ) : null}
        <button
          type="button"
          className={LINE_BTN}
          aria-label={`${hasNote ? "Edit the note on" : "Add a note to"} ${l.name}`}
          aria-expanded={editing}
          disabled={locked}
          onClick={() => setEditing((v) => !v)}
        >
          {hasNote ? "Edit note" : "Add note"}
        </button>
        {hasNote ? (
          <button
            type="button"
            className={LINE_BTN}
            aria-label={`Clear the note on ${l.name}`}
            disabled={locked}
            onClick={() => {
              onNote(l.tempId, "");
              setEditing(false);
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
          className="min-h-[44px] w-full rounded border px-2 py-1 text-sm"
          placeholder="Flavor or note for this item (prints on invoice)"
          disabled={locked}
          value={l.note ?? ""}
          onChange={(e) => onNote(l.tempId, e.target.value)}
          data-counter-note=""
          autoFocus // opening the note puts the cursor in it: the next keys are the note, never a page shortcut
        />
      ) : hasNote ? (
        <p className="break-words text-xs text-navy/70" data-testid="line-note">
          {l.note}
        </p>
      ) : null}
    </li>
  );
}
