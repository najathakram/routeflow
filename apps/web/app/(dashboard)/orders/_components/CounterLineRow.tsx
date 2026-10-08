import * as React from "react";
import { TAP_TARGET, cn } from "@routeflow/ui/web";
import { unitWords } from "@routeflow/pricing";
import { cartTotals } from "@/lib/counter-sale";
import { NOTE_MAX, isBoxedLine, lineQtyLabel, type TypedQty } from "./counter-sale-line-edit";
import { stepLine, type SaleLine, type StepUnit } from "./counter-sale-scan";

const money = (n: number) => `$${n.toFixed(2)}`;

// The counter has no per-product label on a sale line yet, so its price unit prints the default words.
const UW = unitWords();

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
}: {
  label: string;
  value: number;
  locked: boolean;
  onCommit: (text: string) => boolean;
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
}: {
  line: SaleLine;
  locked: boolean;
  onQty: (tempId: string, typed: TypedQty) => boolean;
}) {
  return isBoxedLine(line) ? (
    <span className="flex items-center gap-1">
      <QtyField
        label={`Boxes of ${line.name}`}
        value={line.boxes ?? 0}
        locked={locked}
        onCommit={(t) => onQty(line.tempId, { boxes: t })}
      />
      <QtyField
        label={`Pieces of ${line.name}`}
        value={line.pieces ?? 0}
        locked={locked}
        onCommit={(t) => onQty(line.tempId, { pieces: t })}
      />
    </span>
  ) : (
    <QtyField
      label={`Set quantity of ${line.name}`}
      value={line.qty}
      locked={locked}
      onCommit={(t) => onQty(line.tempId, { qty: t })}
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
}: {
  line: SaleLine;
  locked: boolean;
  onStep: (tempId: string, unit: StepUnit, dir: 1 | -1) => void;
  onRemove: (tempId: string) => void;
  onNote: (tempId: string, note: string) => void;
  onQty: (tempId: string, typed: TypedQty) => boolean;
}) {
  const [editing, setEditing] = React.useState(false);
  const hasNote = !!l.note?.trim();
  return (
    <li className="flex flex-col gap-2 p-3 text-sm">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 break-words">
          {l.name} · {lineQtyLabel(l)}
          <span className="block text-xs text-navy/70">
            {l.listPrice !== undefined && l.listPrice !== l.unitPrice ? (
              <s className="mr-1 text-navy/50" data-testid="line-unit-price-was">
                {money(l.listPrice)}
              </s>
            ) : null}
            <span data-testid="line-unit-price">
              {money(l.unitPrice)} {isBoxedLine(l) ? `/ ${UW.pack.lower}` : "each"}
            </span>
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-2">
          <span>{money(cartTotals([l], 0).subtotal)}</span>
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
        <LineQtyEditor line={l} locked={locked} onQty={onQty} />
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
        />
      ) : hasNote ? (
        <p className="break-words text-xs text-navy/70" data-testid="line-note">
          {l.note}
        </p>
      ) : null}
    </li>
  );
}
