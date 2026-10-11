"use client";

import * as React from "react";
import { TAP_TARGET, cn } from "@routeflow/ui/web";
import { centsToDollars } from "@routeflow/pricing";
import type { CounterSalePaymentMethod } from "@routeflow/types";
import { quickTenderOptions } from "@/lib/counter-sale";
import { scheduleScannerRefocus } from "@/lib/refocus-scanner";
import {
  SPLIT_SEGMENT_METHODS,
  canAddLeg,
  canRemoveLeg,
  cashDueCents,
  formatCents,
  legMethodAllowed,
  type SplitIssue,
  type SplitLegRow,
  type SplitSummary,
} from "@/lib/counter-split-tender";

const METHOD_LABEL: Record<CounterSalePaymentMethod, string> = {
  CASH: "Cash",
  CARD: "Card",
  CHECK: "Check",
  ON_ACCOUNT: "On account",
};

/**
 * The focused leg input scrolls clear of the sticky checkout bar: the screen publishes the bar's height as
 * `--counter-bar-h`; the fallback is a typical bar so the input never lands underneath it before that is measured.
 */
const CLEAR_OF_BAR: React.CSSProperties = { scrollMarginBottom: "var(--counter-bar-h, 7rem)" };

/** The one sanctioned way to move the cursor on the register: the guarded re-arm (never a bare .focus()). */
function moveTo(el: HTMLInputElement | undefined) {
  if (!el) return;
  scheduleScannerRefocus({ current: el }, 0, {
    select: true,
    yieldFrom: [{ current: document.activeElement as HTMLElement | null }],
  });
}

/**
 * "Split payment" (G7): payment lines that grow IN PLACE under the method row (no sheet, no modal). Each line is a method
 * segment above an amount; a cash line has quick-cash, a check line asks for its number. Remaining / Change live in the
 * sticky bar's `change-due` slot, not here. The screen owns the rows, the send and the lock; this draws them and reports edits.
 */
export function SplitTenderPanel({
  rows,
  summary,
  issue,
  isWalkIn,
  locked,
  focusFirst,
  onPatch,
  onAdd,
  onRemove,
  onPayOneWay,
  onSubmit,
  onAttempt,
  onPointer,
}: {
  rows: readonly SplitLegRow[];
  summary: SplitSummary;
  issue: SplitIssue | null;
  isWalkIn: boolean;
  locked: boolean;
  /** the clerk just opened the split: the first amount takes the cursor */
  focusFirst: boolean;
  onPatch: (id: string, patch: Partial<Omit<SplitLegRow, "id">>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onPayOneWay: () => void;
  /** Enter on a covered split: complete the sale once */
  onSubmit: () => void;
  /** Enter on the last line while a rule still holds the sale back: show what is missing */
  onAttempt: () => void;
  /** a pointer activation hands focus back to the scan field (keyboard activations keep it where it is) */
  onPointer: (e: React.MouseEvent) => void;
}) {
  const tapBtn = cn(TAP_TARGET, "rounded border px-3 text-sm disabled:opacity-40");
  const fields = React.useRef(new Map<string, HTMLInputElement>());
  const setField = (key: string) => (el: HTMLInputElement | null) => {
    if (el) fields.current.set(key, el);
    else fields.current.delete(key);
  };
  const firstId = rows[0]?.id;
  React.useEffect(() => {
    if (focusFirst && firstId) moveTo(fields.current.get(`${firstId}:amount`));
  }, [focusFirst, firstId]);

  /** Enter: complete once covered; else on to the next line; on the last line, say what is missing. */
  const onEnter = (index: number) => {
    const last = index === rows.length - 1;
    if (summary.covered || (last && summary.problem === null)) {
      onSubmit();
      return;
    }
    if (!last) moveTo(fields.current.get(`${rows[index + 1].id}:amount`));
    else onAttempt();
  };
  const enterKey = (index: number) => (e: React.KeyboardEvent) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    onEnter(index);
  };

  return (
    <div className="space-y-3" data-testid="split-tender-panel">
      <ul className="space-y-3" aria-label="Payment lines">
        {rows.map((r, i) => {
          const n = i + 1;
          const dueCents = r.method === "CASH" ? cashDueCents(rows, r.id, summary.totalCents) : 0;
          const lineIssue = issue && issue.rowId === r.id ? issue.text : null;
          const issueId = `split-issue-${n}`;
          return (
            <li key={r.id} className="space-y-2 rounded border p-2" data-testid={`split-leg-${n}`}>
              <div className="flex items-center gap-2">
                <div role="group" aria-label={`Payment ${n} method`} className="flex flex-1 gap-1">
                  {SPLIT_SEGMENT_METHODS.map((m) => (
                    <button
                      key={m}
                      type="button"
                      aria-pressed={r.method === m}
                      disabled={locked || !legMethodAllowed(rows, r.id, m)}
                      className={cn(
                        TAP_TARGET,
                        "flex-1 rounded border px-2 text-sm disabled:opacity-40",
                        r.method === m && "border-brand-600 bg-brand-50 font-semibold",
                      )}
                      onClick={(e) => {
                        onPatch(r.id, { method: m });
                        onPointer(e);
                      }}
                    >
                      {METHOD_LABEL[m]}
                    </button>
                  ))}
                </div>
                {canRemoveLeg(rows) ? (
                  <button
                    type="button"
                    className={cn(tapBtn, "px-0 text-lg leading-none")}
                    aria-label={`Remove payment ${n}`}
                    disabled={locked}
                    onClick={(e) => {
                      onRemove(r.id);
                      onPointer(e);
                    }}
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                ) : null}
              </div>
              <input
                ref={setField(`${r.id}:amount`)}
                aria-label={`Payment ${n} amount`}
                inputMode="decimal"
                placeholder="0.00"
                style={CLEAR_OF_BAR}
                className="min-h-[44px] w-full rounded border px-3 py-2 text-sm"
                value={r.amount}
                disabled={locked}
                aria-invalid={lineIssue ? true : undefined}
                aria-describedby={lineIssue ? issueId : undefined}
                onChange={(e) => onPatch(r.id, { amount: e.target.value })}
                onKeyDown={enterKey(i)}
              />
              {r.method === "CHECK" ? (
                <input
                  ref={setField(`${r.id}:ref`)}
                  aria-label={`Payment ${n} check number`}
                  placeholder="Check number"
                  style={CLEAR_OF_BAR}
                  className="min-h-[44px] w-full rounded border px-3 py-2 text-sm"
                  value={r.reference}
                  disabled={locked}
                  onChange={(e) => onPatch(r.id, { reference: e.target.value })}
                  onKeyDown={enterKey(i)}
                />
              ) : null}
              {r.method === "CASH" ? (
                <div className="flex flex-wrap gap-2" data-testid={`split-quick-cash-${n}`}>
                  {quickTenderOptions(centsToDollars(dueCents)).map((q) => (
                    <button
                      key={q.label}
                      type="button"
                      aria-label={`Cash ${q.label}`}
                      disabled={q.disabled || locked || dueCents <= 0}
                      className={tapBtn}
                      onClick={(e) => {
                        onPatch(r.id, { amount: String(q.amount) });
                        onPointer(e);
                      }}
                    >
                      {q.label}
                    </button>
                  ))}
                </div>
              ) : null}
              {lineIssue ? (
                <p
                  id={issueId}
                  role="alert"
                  className="text-sm text-red-700"
                  data-testid={`split-issue-${n}`}
                >
                  {lineIssue}
                </p>
              ) : null}
            </li>
          );
        })}
      </ul>

      {canAddLeg(rows, summary.remainingCents) ? (
        <button
          type="button"
          className={cn(tapBtn, "w-full")}
          disabled={locked}
          onClick={(e) => {
            onAdd();
            onPointer(e);
          }}
        >
          Add payment
        </button>
      ) : null}

      {!isWalkIn && summary.leftOnAccountCents > 0 ? (
        <p className="text-sm" data-testid="split-on-account">
          Left on account {formatCents(summary.leftOnAccountCents)}
        </p>
      ) : null}

      <button
        type="button"
        className={cn(
          TAP_TARGET,
          "w-full text-center text-sm text-brand-700 underline disabled:opacity-40",
        )}
        disabled={locked}
        onClick={(e) => {
          onPayOneWay();
          onPointer(e);
        }}
      >
        Pay one way
      </button>
    </div>
  );
}
