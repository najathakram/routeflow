import * as React from "react";
import { Lock } from "lucide-react";
import {
  DELIVERED_LINE_LOCK_HINT,
  TAKE_OFF_BODY,
  correctableLineNote,
  takeOffTitle,
} from "@/lib/order-line-lock";

/**
 * B1234 (D-O2-a) + SA-1506: what the edit builder shows for a DELIVERED line. A LOCKED line (the server's `lineEditMode`) shows
 * its quantity as read-only text and the sentence that says why; a CORRECTABLE line (an admin) keeps its controls and shows the
 * correction note; taking it off asks first.
 */
export function DeliveredLockedQty({ qty }: { qty: number }) {
  return (
    <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-navy/40">
      Qty
      <span className="mono w-16 px-2 py-1 text-right text-sm normal-case tracking-normal text-navy">
        {qty}
      </span>
    </span>
  );
}

export function DeliveredLockedHint({ text }: { text?: string }) {
  return (
    <p className="ml-11 mt-1 flex items-center gap-1.5 text-xs text-navy/70">
      <Lock className="h-3 w-3 shrink-0" aria-hidden="true" />
      {text || DELIVERED_LINE_LOCK_HINT}
    </p>
  );
}

/** SA-1408 item 1: the note on a line an admin may correct. */
export function CorrectableLineNote({ qty, unit }: { qty: number; unit?: string | null }) {
  return (
    <p className="ml-11 mt-1 text-xs text-navy/70" data-testid="correctable-note">
      {correctableLineNote(qty, unit)}
    </p>
  );
}

/** SA-1408 item 2: the take-off confirm. Take off removes the line on save; Keep leaves it. */
export function TakeOffConfirm({
  item,
  onTakeOff,
  onKeep,
}: {
  item: string;
  onTakeOff: () => void;
  onKeep: () => void;
}) {
  return (
    <div
      role="alertdialog"
      aria-label={takeOffTitle(item)}
      className="ml-11 mt-2 rounded-lg border border-surface-border bg-surface-raised p-3"
    >
      <p className="text-sm font-medium text-navy">{takeOffTitle(item)}</p>
      <p className="mt-1 text-xs text-navy/70">{TAKE_OFF_BODY}</p>
      <div className="mt-2 flex gap-2">
        <button
          type="button"
          className="rounded bg-danger px-3 py-1 text-xs font-medium text-white"
          onClick={onTakeOff}
        >
          Take off
        </button>
        <button
          type="button"
          className="rounded px-3 py-1 text-xs text-navy/70 hover:bg-surface-border"
          onClick={onKeep}
        >
          Keep
        </button>
      </div>
    </div>
  );
}
