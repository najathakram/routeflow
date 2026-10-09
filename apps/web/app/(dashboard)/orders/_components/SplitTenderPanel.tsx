"use client";

import * as React from "react";
import { TAP_TARGET, cn } from "@routeflow/ui/web";
import { centsToDollars } from "@routeflow/pricing";
import type { CounterSalePaymentMethod } from "@routeflow/types";
import { quickTenderOptions } from "@/lib/counter-sale";
import {
  SPLIT_RULE,
  SPLIT_PROBLEM_COPY,
  canAddLeg,
  canRemoveLeg,
  cashDueCents,
  legMethodAllowed,
  type SplitLegRow,
  type SplitSummary,
} from "@/lib/counter-split-tender";

const money = (cents: number) => `$${centsToDollars(cents).toFixed(2)}`;

const METHOD_LABEL: Record<CounterSalePaymentMethod, string> = {
  CASH: "Cash",
  CARD: "Card",
  CHECK: "Check",
  ON_ACCOUNT: "On account",
};

/** The methods the counter offers on a line (the shared rule's list, narrowed to the screen's four). */
const OFFERED = SPLIT_RULE.allowed.filter((m): m is CounterSalePaymentMethod => m in METHOD_LABEL);

/**
 * "Split payment": up to TENDER_RULES.counter.maxLegs payment lines (method + amount). Remaining and Change are live, in
 * cents; a check line asks for its number; the cash line has quick-cash buttons aimed at what the OTHER lines left. The
 * screen owns the rows, the send and the lock; this only draws them and reports edits.
 */
export function SplitTenderPanel({
  rows,
  summary,
  isWalkIn,
  locked,
  onPatch,
  onAdd,
  onRemove,
  onBack,
  onPointer,
}: {
  rows: readonly SplitLegRow[];
  summary: SplitSummary;
  isWalkIn: boolean;
  locked: boolean;
  onPatch: (id: string, patch: Partial<Omit<SplitLegRow, "id">>) => void;
  onAdd: () => void;
  onRemove: (id: string) => void;
  onBack: () => void;
  /** a pointer activation hands focus back to the scan field (keyboard activations keep it where it is) */
  onPointer: (e: React.MouseEvent) => void;
}) {
  const tapBtn = cn(TAP_TARGET, "rounded border px-3 text-sm disabled:opacity-40");
  return (
    <div className="space-y-3" data-testid="split-tender-panel">
      <ul className="space-y-3" aria-label="Payment lines">
        {rows.map((r, i) => {
          const n = i + 1;
          const dueCents = r.method === "CASH" ? cashDueCents(rows, r.id, summary.totalCents) : 0;
          return (
            <li key={r.id} className="space-y-2 rounded border p-2" data-testid={`split-leg-${n}`}>
              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label={`Payment ${n} method`}
                  className="min-h-[44px] rounded border px-2 text-sm"
                  value={r.method}
                  disabled={locked}
                  onChange={(e) =>
                    onPatch(r.id, { method: e.target.value as CounterSalePaymentMethod })
                  }
                >
                  {OFFERED.map((m) => (
                    <option key={m} value={m} disabled={!legMethodAllowed(rows, r.id, m)}>
                      {METHOD_LABEL[m]}
                    </option>
                  ))}
                </select>
                <input
                  aria-label={`Payment ${n} amount`}
                  inputMode="decimal"
                  placeholder="0.00"
                  className="min-h-[44px] w-32 rounded border px-3 py-2 text-sm"
                  value={r.amount}
                  disabled={locked}
                  onChange={(e) => onPatch(r.id, { amount: e.target.value })}
                />
                <button
                  type="button"
                  className={cn(tapBtn, "ml-auto")}
                  aria-label={`Remove payment ${n}`}
                  disabled={locked || !canRemoveLeg(rows)}
                  onClick={(e) => {
                    onRemove(r.id);
                    onPointer(e);
                  }}
                >
                  Remove
                </button>
              </div>
              {r.method === "CHECK" ? (
                <input
                  aria-label={`Payment ${n} check number`}
                  placeholder="Check number"
                  className="min-h-[44px] w-full rounded border px-3 py-2 text-sm"
                  value={r.reference}
                  disabled={locked}
                  onChange={(e) => onPatch(r.id, { reference: e.target.value })}
                />
              ) : null}
              {r.method === "CASH" ? (
                <div className="flex flex-wrap gap-2" data-testid={`split-quick-cash-${n}`}>
                  {quickTenderOptions(centsToDollars(dueCents)).map((q) => (
                    <button
                      key={q.label}
                      type="button"
                      aria-label={`Cash ${q.label}`}
                      disabled={q.disabled || locked}
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
            </li>
          );
        })}
      </ul>

      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={tapBtn}
          disabled={locked || !canAddLeg(rows)}
          onClick={(e) => {
            onAdd();
            onPointer(e);
          }}
        >
          Add payment
        </button>
        {!canAddLeg(rows) && rows.length >= SPLIT_RULE.maxLegs ? (
          <span className="text-xs text-navy/70" data-testid="split-max-legs">
            Up to {SPLIT_RULE.maxLegs} payments
          </span>
        ) : null}
        <button
          type="button"
          className={cn(TAP_TARGET, "text-sm text-brand-700 underline disabled:opacity-40")}
          disabled={locked}
          onClick={(e) => {
            onBack();
            onPointer(e);
          }}
        >
          Back to single payment
        </button>
      </div>

      <dl className="space-y-1 text-sm" aria-live="polite">
        <div className="flex justify-between text-lg font-semibold" data-testid="split-remaining">
          <dt>Remaining</dt>
          <dd>{money(summary.remainingCents)}</dd>
        </div>
        {!isWalkIn && summary.leftOnAccountCents > 0 ? (
          <div className="flex justify-between" data-testid="split-on-account">
            <dt>Left on account</dt>
            <dd>{money(summary.leftOnAccountCents)}</dd>
          </div>
        ) : null}
        {summary.changeCents > 0 ? (
          <div className="text-3xl font-bold" data-testid="split-change">
            Change {money(summary.changeCents)}
          </div>
        ) : null}
      </dl>
      {summary.problem ? (
        <p role="status" className="text-sm text-navy/70" data-testid="split-problem">
          {SPLIT_PROBLEM_COPY[summary.problem]}
        </p>
      ) : null}
    </div>
  );
}
