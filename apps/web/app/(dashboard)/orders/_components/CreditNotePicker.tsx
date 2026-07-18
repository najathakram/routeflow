"use client";

import * as React from "react";
import { useCreditNotes, openCreditBalance, type CreditNote } from "@/lib/api/credit-notes";
import { MoneyInput } from "@/components/MoneyInput";

// ─── Types ────────────────────────────────────────────────────────────────────

/** An operator's request to apply (part of) a credit note. `amount` omitted =
 *  "up to the credit's remaining balance" — matches the API's AppliedCreditNoteDto. */
export interface CreditSelection {
  creditNoteId: string;
  amount?: number;
}

export interface CreditNotePickerProps {
  customerId: string | null;
  value: CreditSelection[];
  onChange: (next: CreditSelection[]) => void;
  /** When given, renders a display-only "Estimated balance due" line — credits
   *  never change the order/invoice total, only the invoice's balance due. */
  estimatedOrderTotal?: number;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * Customer-scoped picker for open credit notes. Auto-populates once a customer
 * is chosen; each row is a checkbox + optional "amount to apply" (blank = up to
 * remaining). Purely intent — the actual money movement happens server-side
 * when the order's invoice(s) settle (see settleOrderCreditsInTx).
 */
export function CreditNotePicker({
  customerId,
  value,
  onChange,
  estimatedOrderTotal,
}: CreditNotePickerProps) {
  const { data } = useCreditNotes(customerId ? { customerId, limit: 100 } : undefined, {
    enabled: !!customerId,
  });
  const credits = customerId ? (data?.data ?? []) : [];

  const selectedIds = new Set(value.map((v) => v.creditNoteId));
  // Rows = ISSUED credits with an open balance (mirrors the credit-note detail
  // page's `canApply` — DRAFT/APPLIED/VOID are never selectable) OR a credit
  // already in `value` regardless of status/balance, so an edit-mode picker
  // still shows a selection that's since been fully consumed.
  const rows = credits.filter(
    (cn) => selectedIds.has(cn.id) || (cn.status === "ISSUED" && openCreditBalance(cn) > 0.001),
  );

  if (!customerId || rows.length === 0) return null;

  // Display-only estimate: an explicit amount is shown as-is (the server clamps
  // it to min(amount, remaining, invoice balance)); an "up to remaining"
  // selection shows the currently-known remaining balance.
  const totalApplied = value.reduce((sum, sel) => {
    const cn = credits.find((c) => c.id === sel.creditNoteId);
    if (!cn) return sum;
    const est = sel.amount != null ? sel.amount : openCreditBalance(cn);
    return sum + est;
  }, 0);

  function toggle(cn: CreditNote, checked: boolean) {
    if (checked) onChange([...value, { creditNoteId: cn.id }]);
    else onChange(value.filter((v) => v.creditNoteId !== cn.id));
  }

  function setAmount(creditNoteId: string, amount: number | null) {
    onChange(
      value.map((v) =>
        v.creditNoteId === creditNoteId ? { ...v, amount: amount ?? undefined } : v,
      ),
    );
  }

  return (
    <section className="space-y-2">
      <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">
        Apply credit notes
      </p>
      <ul className="divide-y divide-surface-border overflow-hidden rounded-lg border border-surface-border">
        {rows.map((cn) => {
          const selection = value.find((v) => v.creditNoteId === cn.id);
          const checked = !!selection;
          const remaining = openCreditBalance(cn);
          const isExpired = !!cn.expiresAt && new Date(cn.expiresAt).getTime() <= Date.now();
          return (
            <li key={cn.id} className="flex flex-col gap-1.5 px-3 py-2.5">
              <label className="flex items-center gap-2.5 text-sm">
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={isExpired && !checked}
                  onChange={(e) => toggle(cn, e.target.checked)}
                  className="h-4 w-4 shrink-0 accent-brand-500"
                />
                <span className="shrink-0 font-mono text-xs font-medium text-navy">
                  {cn.creditNoteNumber}
                </span>
                <span className="min-w-0 flex-1 truncate text-navy/70" title={cn.reason}>
                  {cn.reason}
                </span>
                <span className="shrink-0 font-medium text-navy">
                  ${remaining.toFixed(2)} available
                </span>
              </label>
              {isExpired ? (
                <span className="ml-6 text-[11px] text-danger">
                  Expired — can no longer be applied
                </span>
              ) : (
                cn.expiresAt && (
                  <span className="ml-6 text-[11px] text-navy/50">
                    Expires {new Date(cn.expiresAt).toLocaleDateString()}
                  </span>
                )
              )}
              {checked && (
                <div className="ml-6 flex items-center gap-1.5">
                  <span className="text-[11px] text-navy/70">Amount</span>
                  <span className="flex items-center rounded border border-surface-border bg-white px-1.5 focus-within:ring-1 focus-within:ring-brand-500">
                    <span className="text-xs text-navy/40">$</span>
                    <MoneyInput
                      min={0}
                      value={selection?.amount ?? null}
                      onChange={(v) => setAmount(cn.id, v)}
                      placeholder="up to remaining"
                      className="w-28 rounded-none border-0 bg-transparent px-1 py-0.5 text-right text-xs placeholder:text-navy/40 focus:ring-0"
                    />
                  </span>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {value.length > 0 && (
        <div className="space-y-0.5 rounded-lg bg-surface-raised px-3 py-2 text-xs">
          <div className="flex justify-between text-navy/70">
            <span>Credits to apply at invoicing</span>
            <span className="font-medium text-navy">−${totalApplied.toFixed(2)}</span>
          </div>
          {estimatedOrderTotal != null && (
            <div className="flex justify-between text-navy/70">
              <span>Estimated balance due</span>
              <span className="font-medium text-navy">
                ${Math.max(0, estimatedOrderTotal - totalApplied).toFixed(2)}
              </span>
            </div>
          )}
          <p className="pt-0.5 text-[10px] text-navy/50">
            Display only — credits reduce the invoice balance due, never the order total.
          </p>
        </div>
      )}
    </section>
  );
}
