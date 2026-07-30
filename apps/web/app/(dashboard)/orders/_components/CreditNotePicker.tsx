"use client";

import * as React from "react";
import {
  useCreditNotes,
  useCreateCreditNote,
  openCreditBalance,
  type CreditNote,
} from "@/lib/api/credit-notes";
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
  const fetched = customerId ? (data?.data ?? []) : [];

  // Credits created inline this session, ahead of the refetch landing. Reset
  // whenever the operator swaps customers so a stale creation never leaks in.
  const [justCreated, setJustCreated] = React.useState<CreditNote[]>([]);
  React.useEffect(() => {
    setJustCreated([]);
  }, [customerId]);
  const credits = React.useMemo(() => {
    const byId = new Map(fetched.map((c) => [c.id, c]));
    for (const c of justCreated) if (!byId.has(c.id)) byId.set(c.id, c);
    return Array.from(byId.values());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, justCreated, customerId]);

  // Inline "+ New credit note" create form state.
  const createCreditNote = useCreateCreditNote();
  const [createOpen, setCreateOpen] = React.useState(false);
  const [createAmount, setCreateAmount] = React.useState<number | null>(null);
  const [createReason, setCreateReason] = React.useState("");
  const [createExpiresAt, setCreateExpiresAt] = React.useState("");
  const [createError, setCreateError] = React.useState("");

  const selectedIds = new Set(value.map((v) => v.creditNoteId));
  // Rows = ISSUED credits with an open balance (mirrors the credit-note detail
  // page's `canApply` — DRAFT/APPLIED/VOID are never selectable) OR a credit
  // already in `value` regardless of status/balance, so an edit-mode picker
  // still shows a selection that's since been fully consumed.
  const rows = credits.filter(
    (cn) => selectedIds.has(cn.id) || (cn.status === "ISSUED" && openCreditBalance(cn) > 0.001),
  );

  if (!customerId) return null;

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

  // Inline create. On success, select the new credit immediately from the
  // create response — don't wait for the refetch — and merge it into
  // `justCreated` so its row and the running total render right away. The
  // server's pre-gate (validateSelectionsForCustomer) accepts a freshly
  // minted credit: it is ISSUED with its full balance open.
  function submitCreate() {
    setCreateError("");
    // Re-narrow: the `!customerId` early return above doesn't narrow a prop
    // inside a closure, and a credit note is always customer-scoped.
    if (!customerId) return;
    const amount = createAmount ?? 0;
    const reason = createReason.trim();
    if (!(amount > 0)) {
      setCreateError("Enter an amount greater than $0.");
      return;
    }
    if (!reason) {
      setCreateError("Enter a reason.");
      return;
    }
    // Same rule the server enforces (CreditNotesService.create rejects
    // expiresAt <= now) and the same check the credit-notes page modal makes —
    // without it, picking today silently 400s and the operator just retries.
    if (createExpiresAt) {
      const d = new Date(createExpiresAt);
      if (isNaN(d.getTime()) || d.getTime() <= Date.now()) {
        setCreateError("Expiry date must be in the future.");
        return;
      }
    }
    createCreditNote.mutate(
      {
        customerId,
        amount,
        reason,
        // No issueDate: the server accepts-and-ignores it only for old bundles.
        ...(createExpiresAt ? { expiresAt: new Date(createExpiresAt).toISOString() } : {}),
      },
      {
        onSuccess: (created) => {
          setJustCreated((prev) => [...prev, created]);
          onChange([...value, { creditNoteId: created.id }]);
          setCreateOpen(false);
          setCreateAmount(null);
          setCreateReason("");
          setCreateExpiresAt("");
        },
        onError: (err) => {
          // Surface the server's reason — a fixed "try again" hides the actual
          // problem (bad expiry, amount cap) and the operator retries forever.
          const msg = (err as { response?: { data?: { message?: string | string[] } } })?.response
            ?.data?.message;
          setCreateError(
            (Array.isArray(msg) ? msg[0] : msg) ||
              "Could not create the credit note. Please try again.",
          );
        },
      },
    );
  }

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">
          Apply credit notes
        </p>
        <button
          type="button"
          onClick={() => {
            setCreateError("");
            setCreateOpen((v) => !v);
          }}
          className="text-xs font-medium text-brand-500 hover:text-brand-600"
        >
          {createOpen ? "Cancel" : "+ New credit note"}
        </button>
      </div>
      {createOpen && (
        <div className="space-y-2 rounded-lg border border-dashed border-brand-300 bg-brand-50 px-3 py-2.5">
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-24 space-y-1">
              <label className="block text-[10px] font-medium text-navy/70">Amount</label>
              <span className="flex h-9 items-center rounded border border-surface-border bg-white px-1.5 focus-within:ring-1 focus-within:ring-brand-500">
                <span className="text-xs text-navy/40">$</span>
                <MoneyInput
                  min={0}
                  value={createAmount}
                  onChange={setCreateAmount}
                  placeholder="0.00"
                  className="w-full rounded-none border-0 bg-transparent px-1 py-0.5 text-right text-sm focus:ring-0"
                />
              </span>
            </div>
            <div className="min-w-[160px] flex-1 space-y-1">
              <label className="block text-[10px] font-medium text-navy/70">Reason</label>
              <input
                type="text"
                value={createReason}
                onChange={(e) => setCreateReason(e.target.value)}
                placeholder="e.g. Damaged goods"
                className="h-9 w-full rounded border border-surface-border bg-white px-2 text-sm text-navy placeholder:text-navy/40 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>
            <div className="w-36 space-y-1">
              <label className="block text-[10px] font-medium text-navy/70">
                Expires <span className="font-normal text-navy/50">(optional)</span>
              </label>
              <input
                type="date"
                min={new Date(Date.now() + 86400000).toISOString().slice(0, 10)}
                value={createExpiresAt}
                onChange={(e) => setCreateExpiresAt(e.target.value)}
                className="h-9 w-full rounded border border-surface-border bg-white px-2 text-sm text-navy focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
            </div>
            <button
              type="button"
              onClick={submitCreate}
              disabled={createCreditNote.isPending}
              className="h-9 rounded bg-brand-500 px-3 text-sm font-medium text-white hover:bg-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {createCreditNote.isPending ? "Creating…" : "Create"}
            </button>
          </div>
          {createError && <p className="text-xs text-danger">{createError}</p>}
        </div>
      )}
      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-surface-border bg-surface-raised px-3 py-4 text-center text-xs text-navy/70">
          No open credits for this customer.
        </p>
      ) : (
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
      )}
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
