import * as React from "react";
import { cartTotals } from "@/lib/counter-sale";
import { isBoxedLine, lineQtyLabel } from "./counter-sale-line-edit";
import { stepLine, type SaleLine, type StepUnit } from "./counter-sale-scan";

const money = (n: number) => `$${n.toFixed(2)}`;

const STEP_BTN = "rounded border px-2 py-0.5 text-xs disabled:opacity-40";

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
      className={STEP_BTN}
      aria-label={label}
      disabled={locked || stepLine(line, unit, dir) === line}
      onClick={() => onStep(line.tempId, unit, dir)}
    >
      {text}
    </button>
  );
  return isBoxedLine(line) ? (
    <span className="flex items-center gap-1" role="group" aria-label={`Quantity of ${line.name}`}>
      {btn(`Remove a box from ${line.name}`, "\u2212 box", "box", -1)}
      {btn(`Add a box to ${line.name}`, "+ box", "box", 1)}
      {btn(`Remove a piece from ${line.name}`, "\u2212 pc", "piece", -1)}
      {btn(`Add a piece to ${line.name}`, "+ pc", "piece", 1)}
    </span>
  ) : (
    <span className="flex items-center gap-1" role="group" aria-label={`Quantity of ${line.name}`}>
      {btn(`Remove one ${line.name}`, "\u2212", "piece", -1)}
      {btn(`Add one ${line.name}`, "+", "piece", 1)}
    </span>
  );
}

/** One cart line: name + quantity label, the stepper, the line subtotal and the remove button. */
export function CounterLineRow({
  line: l,
  locked,
  onStep,
  onRemove,
}: {
  line: SaleLine;
  locked: boolean;
  onStep: (tempId: string, unit: StepUnit, dir: 1 | -1) => void;
  onRemove: (tempId: string) => void;
}) {
  return (
    <li className="flex items-center justify-between gap-2 p-3 text-sm">
      <span>
        {l.name} · {lineQtyLabel(l)}
      </span>
      <span className="flex items-center gap-3">
        <LineStepper line={l} locked={locked} onStep={onStep} />
        <span>{money(cartTotals([l], 0).subtotal)}</span>
        <button
          type="button"
          aria-label={`Remove ${l.name}`}
          disabled={locked}
          onClick={() => onRemove(l.tempId)}
        >
          ×
        </button>
      </span>
    </li>
  );
}
