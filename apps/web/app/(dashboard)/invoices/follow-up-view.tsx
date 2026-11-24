"use client";

import * as React from "react";
import Link from "next/link";
import { Button, cn, useToast } from "@routeflow/ui/web";
import { useInvoices, useSendInvoiceReminder, type Invoice } from "@/lib/api/invoices";
import { CustomerRecordPaymentModal } from "@/components/CustomerRecordPaymentModal";
import { useAuth } from "@/lib/auth-context";
import { WriteButton } from "@/lib/read-only-gate";
import { useUrlFilters } from "@/lib/hooks/useUrlFilters";
import { fmt, fmtCalendarDate } from "@/lib/formatting";

/**
 * P-30 / SA-1264 PR-1: the "Follow up" view on the Invoices list. Three lenses over the list API (Due soon, Overdue,
 * To collect), oldest due first; a daily batch sent as `limit`; the owed amount is the server's `balanceDue` (the
 * confirmed balance) with `pendingAmount` beside it, never subtracted and never re-derived here; Record payment takes
 * ONE customer's invoices only (the server checks the same).
 */
export const FOLLOW_UP_BATCH_KEY = "rf.followUp.batch";
export const FOLLOW_UP_BATCHES = [5, 10, 20, 50] as const;
const DEFAULT_BATCH = 10;
const SHOW_ALL_LIMIT = 1000; // the list API's MAX_LIST_LIMIT
const DUE_SOON_DAYS = 7;

const LENSES = [
  { key: "due-soon", label: "Due soon", params: { dueWithinDays: DUE_SOON_DAYS } },
  { key: "overdue", label: "Overdue", params: { isOverdue: true } },
  { key: "to-collect", label: "To collect", params: { toCollect: true } },
] as const;
type LensKey = (typeof LENSES)[number]["key"];

/** The kept batch for this user on this device; anything outside 5/10/20/50 reads as the default. */
function readBatch(userId: string): number {
  const kept = Number(localStorage.getItem(`${FOLLOW_UP_BATCH_KEY}.${userId}`));
  return (FOLLOW_UP_BATCHES as readonly number[]).includes(kept) ? kept : DEFAULT_BATCH;
}

function ReminderButton({ invoice }: { invoice: Invoice }) {
  const { toast } = useToast();
  const send = useSendInvoiceReminder();
  return (
    <Button
      variant="secondary"
      size="sm"
      disabled={send.isPending}
      aria-label={`Send reminder for ${invoice.invoiceNumber}`}
      onClick={() =>
        send.mutate(
          { id: invoice.id },
          { onSuccess: () => toast({ title: "Reminder sent.", variant: "success" }) },
        )
      }
    >
      Send reminder
    </Button>
  );
}

export function FollowUpView({ onExit }: { onExit: () => void }) {
  const { toast } = useToast();
  const { user } = useAuth();
  const userId = user?.id ?? "anon";
  const [filters, setFilter] = useUrlFilters({ lens: "" });
  const lens = LENSES.find((l) => l.key === filters.lens) ?? LENSES[1];
  const [batch, setBatch] = React.useState(DEFAULT_BATCH);
  const [showAll, setShowAll] = React.useState(false);
  const [selected, setSelected] = React.useState<string[]>([]);
  const [paying, setPaying] = React.useState(false);

  React.useEffect(() => setBatch(readBatch(userId)), [userId]);

  const { data, isLoading } = useInvoices({
    ...lens.params,
    sortBy: "dueDate",
    sortOrder: "asc",
    page: 1,
    limit: showAll ? SHOW_ALL_LIMIT : batch,
  });
  const rows = data?.data ?? [];
  const total = data?.meta?.total ?? rows.length;
  const picked = selected.filter((id) => rows.some((r) => r.id === id));
  const pickedCustomer = rows.find((r) => r.id === picked[0])?.customer?.id;

  function chooseBatch(n: number) {
    setBatch(n);
    localStorage.setItem(`${FOLLOW_UP_BATCH_KEY}.${userId}`, String(n));
  }

  function toggle(inv: Invoice) {
    if (picked.includes(inv.id)) return setSelected(picked.filter((id) => id !== inv.id));
    if (pickedCustomer && inv.customer?.id !== pickedCustomer) {
      toast({ title: "Select one customer's invoices.", variant: "error" });
      return;
    }
    setSelected([...picked, inv.id]);
  }

  return (
    <div className="space-y-4 p-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-2xl font-bold text-navy">Follow up</h2>
        <Button variant="secondary" size="sm" onClick={onExit}>
          All invoices
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {LENSES.map((l) => (
          <button
            key={l.key}
            type="button"
            aria-pressed={lens.key === l.key}
            onClick={() => {
              setShowAll(false);
              setFilter("lens", l.key satisfies LensKey);
            }}
            className={cn(
              "min-h-[44px] rounded-full border px-3 py-1.5 text-sm font-medium transition-colors",
              lens.key === l.key
                ? "border-brand-500 bg-brand-500 text-white"
                : "border-surface-border bg-white text-navy hover:bg-surface-raised",
            )}
          >
            {l.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-navy">
        <div className="flex items-center gap-3">
          <span className="font-semibold">{showAll ? `All ${total}` : `Today's ${batch}`}</span>
          {total > rows.length && !showAll && (
            <button type="button" className="underline" onClick={() => setShowAll(true)}>
              {`Show all (${total})`}
            </button>
          )}
          {showAll && (
            <button type="button" className="underline" onClick={() => setShowAll(false)}>
              Back to today&apos;s batch
            </button>
          )}
          <select
            aria-label="Daily batch"
            value={batch}
            onChange={(e) => chooseBatch(Number(e.target.value))}
            className="h-9 rounded border border-surface-border bg-white px-2 text-sm"
          >
            {FOLLOW_UP_BATCHES.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </div>
        <WriteButton size="sm" disabled={picked.length === 0} onClick={() => setPaying(true)}>
          Record payment
        </WriteButton>
      </div>

      {!isLoading && rows.length === 0 ? (
        <p className="rounded border border-surface-border p-6 text-sm text-navy/70">
          Nothing to follow up here.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-surface-border text-left text-navy/70">
              <th className="w-10 py-2" />
              <th>Customer</th>
              <th>Invoice</th>
              <th>Due</th>
              <th className="text-right">Owed</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((inv) => (
              <tr key={inv.id} className="border-b border-surface-border">
                <td className="py-2">
                  <input
                    type="checkbox"
                    aria-label={`Select ${inv.invoiceNumber}`}
                    checked={picked.includes(inv.id)}
                    onChange={() => toggle(inv)}
                    className="h-5 w-5"
                  />
                </td>
                <td>{inv.customer?.businessName}</td>
                <td>
                  <Link href={`/invoices/${inv.id}`} className="text-brand-600 underline">
                    {inv.invoiceNumber}
                  </Link>
                </td>
                <td>{fmtCalendarDate(inv.dueDate)}</td>
                <td className="text-right">
                  <div className="font-semibold">{fmt(Number(inv.balanceDue ?? 0))}</div>
                  {Number(inv.pendingAmount ?? 0) > 0 && (
                    <div className="text-xs text-navy/70">{`${fmt(Number(inv.pendingAmount))} pending`}</div>
                  )}
                </td>
                <td className="text-right">
                  <ReminderButton invoice={inv} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {paying && pickedCustomer && (
        <CustomerRecordPaymentModal
          customerId={pickedCustomer}
          customerName={rows.find((r) => r.id === picked[0])?.customer?.businessName}
          invoiceIds={picked}
          onClose={() => setPaying(false)}
          onSuccess={() => setSelected([])}
        />
      )}
    </div>
  );
}
