"use client";

import * as React from "react";
import { Receipt, X } from "lucide-react";
import { Button, useToast } from "@routeflow/ui/web";
import { useVendorBills } from "@/lib/api/vendor-bills";
import {
  useRecordSupplierPayment,
  waterfallAllocations,
  allocationTotals,
  type SupplierPaymentMethod,
  type RecordSupplierPaymentDto,
} from "@/lib/api/supplier-payments";
import { fmt, fmtCalendarDate } from "@/lib/formatting";
import { SELECTABLE_PAYMENT_METHODS, PAYMENT_METHOD_LABELS } from "@/lib/payment-methods";

const fieldCls =
  "w-full rounded-lg border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500";

interface AllocRow {
  vendorBillId: string;
  billNumber: string;
  billDate?: string | null;
  amountDue: number;
  amount: string;
}

export interface RecordSupplierPaymentModalProps {
  supplierId: string;
  supplierName?: string;
  onClose: () => void;
  onSuccess?: () => void;
}

/**
 * AP mirror of the AR standalone-payment allocation UI
 * (finance/payments/page.tsx's RecordPaymentModal): oldest-first waterfall
 * pre-fill across a supplier's open bills, every row editable before confirm,
 * remainder stays on account (SupplierCredit) instead of erroring. There is
 * no DRAFT/PAID toggle here — BillPayment has no status machine at all
 * (PR-E plan landmine 3): recording a supplier payment is immediate and
 * final. Hand-rolled overlay (max-w-2xl) like GroupAsVariantsModal — the
 * shared `Modal` from @routeflow/ui/web is capped at max-w-lg.
 */
export function RecordSupplierPaymentModal({
  supplierId,
  supplierName,
  onClose,
  onSuccess,
}: RecordSupplierPaymentModalProps) {
  const { toast } = useToast();
  const record = useRecordSupplierPayment();
  const [totalAmount, setTotalAmount] = React.useState("");
  const [paidAt, setPaidAt] = React.useState(new Date().toISOString().split("T")[0]);
  const [method, setMethod] = React.useState<SupplierPaymentMethod>("CASH");
  const [reference, setReference] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [allocations, setAllocations] = React.useState<AllocRow[]>([]);

  // 500 matches RecordSupplierPaymentDto's @ArrayMaxSize(500) on allocations —
  // the fetch should never be the reason a bill can't be offered.
  const { data: billsData } = useVendorBills({ supplierId, limit: 500 });

  // Eligibility is arithmetic (totalOwed − totalPaid > 0.001), NEVER status —
  // VendorBillStatus.PARTIAL is overloaded between a short-received bill and
  // a part-paid one (PR-E plan landmine 1), so a short-received bill with
  // $0 paid must still be fully payable here.
  const eligibleBills = React.useMemo(() => {
    const rows = (billsData?.data ?? []).filter((b) => {
      if (b.status === "VOID") return false;
      return roundOwed(b) > 0.001;
    });
    return [...rows].sort((a, b) => {
      const ad = a.billDate ?? "";
      const bd = b.billDate ?? "";
      if (ad !== bd) return ad.localeCompare(bd);
      return (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
    });
  }, [billsData]);

  // Oldest-first is the DEFAULT pre-fill, not a cage — every row stays
  // editable below. Re-runs (overwriting manual edits) whenever the total or
  // the eligible-bill set changes, mirroring the AR modal's own behavior.
  React.useEffect(() => {
    if (!eligibleBills.length) {
      setAllocations([]);
      return;
    }
    const targets = eligibleBills.map((b) => ({ id: b.id, amountDue: roundOwed(b) }));
    const { allocations: prefill } = waterfallAllocations(parseFloat(totalAmount) || 0, targets);
    const byId = new Map(prefill.map((a) => [a.id, a.amount]));
    setAllocations(
      eligibleBills.map((b) => ({
        vendorBillId: b.id,
        billNumber: b.billNumber,
        billDate: b.billDate,
        amountDue: roundOwed(b),
        amount: byId.has(b.id) ? String(byId.get(b.id)) : "",
      })),
    );
    // eligibleBills is derived from billsData every render; length is the
    // stable dep (matches finance/payments/page.tsx's own RecordPaymentModal).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [eligibleBills.length, totalAmount]);

  const total = parseFloat(totalAmount) || 0;
  const totals = allocationTotals(
    total,
    allocations.map((a) => ({ amount: a.amount ? parseFloat(a.amount) : null })),
  );

  const updateAlloc = (idx: number, val: string) =>
    setAllocations((prev) => prev.map((a, i) => (i === idx ? { ...a, amount: val } : a)));

  const handleSubmit = async () => {
    if (!total || total <= 0) {
      toast({ title: "Enter a valid amount", variant: "error" });
      return;
    }
    if (totals.overAllocated) {
      toast({ title: "Allocated more than the amount paid", variant: "error" });
      return;
    }
    const validAllocs = allocations.filter((a) => a.amount && parseFloat(a.amount) > 0);
    const dto: RecordSupplierPaymentDto = {
      supplierId,
      totalAmount: total,
      method,
      paidAt,
      reference: reference || undefined,
      notes: notes || undefined,
      allocations: validAllocs.map((a) => ({
        vendorBillId: a.vendorBillId,
        amount: parseFloat(a.amount),
      })),
    };
    try {
      await record.mutateAsync(dto);
      toast({
        title: "Payment recorded",
        description:
          totals.excess > 0.001 ? `${fmt(totals.excess)} left as account credit.` : undefined,
        variant: "success",
      });
      onSuccess?.();
      onClose();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast({ title: msg ?? "Failed to record payment", variant: "error" });
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl bg-white shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <div className="flex items-center gap-2">
            <Receipt className="h-5 w-5 text-brand-500" />
            <h2 className="text-base font-semibold text-navy">
              Record Payment{supplierName ? ` — ${supplierName}` : ""}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-navy/70 hover:bg-surface-raised hover:text-navy"
          >
            <X size={18} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-navy">Amount Paid *</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={totalAmount}
                onChange={(e) => setTotalAmount(e.target.value)}
                placeholder="0.00"
                className={fieldCls}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-navy">Payment Date *</label>
              <input
                type="date"
                value={paidAt}
                onChange={(e) => setPaidAt(e.target.value)}
                className={fieldCls}
              />
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-navy">Payment Mode *</label>
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value as SupplierPaymentMethod)}
                className={fieldCls}
              >
                {SELECTABLE_PAYMENT_METHODS.map((m) => (
                  <option key={m} value={m}>
                    {PAYMENT_METHOD_LABELS[m]}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-navy">Reference #</label>
              <input
                type="text"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder="Check #, transaction ID..."
                className={fieldCls}
              />
            </div>
            <div className="col-span-2">
              <label className="mb-1.5 block text-sm font-medium text-navy">Notes (internal)</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                className={`${fieldCls} resize-none`}
                placeholder="Internal notes..."
              />
            </div>
          </div>

          {/* Bill allocation */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-navy">Apply to Bills</h3>
              <button
                type="button"
                onClick={() => setAllocations((prev) => prev.map((a) => ({ ...a, amount: "" })))}
                className="text-xs text-brand-500 hover:underline"
              >
                Clear
              </button>
            </div>
            {eligibleBills.length === 0 ? (
              <p className="text-sm text-navy/70 italic">No outstanding bills for this supplier.</p>
            ) : (
              <div className="overflow-hidden rounded-lg border border-surface-border">
                <table className="w-full text-sm">
                  <thead className="bg-surface-raised text-xs font-medium text-navy/70">
                    <tr>
                      <th className="px-3 py-2 text-left">Bill #</th>
                      <th className="px-3 py-2 text-right">Owed</th>
                      <th className="px-3 py-2 text-right">Applied</th>
                      <th className="px-3 py-2 text-right">After</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-border">
                    {allocations.map((a, idx) => {
                      const applied = parseFloat(a.amount) || 0;
                      const after = Math.max(0, a.amountDue - applied);
                      return (
                        <tr key={a.vendorBillId}>
                          <td className="px-3 py-2 font-medium text-brand-600">
                            {a.billNumber}
                            <div className="text-xs font-normal text-navy/50">
                              {fmtCalendarDate(a.billDate)}
                            </div>
                          </td>
                          <td className="px-3 py-2 text-right text-navy">{fmt(a.amountDue)}</td>
                          <td className="px-3 py-2 text-right">
                            <input
                              type="number"
                              step="0.01"
                              min="0"
                              max={a.amountDue}
                              value={a.amount}
                              onChange={(e) => updateAlloc(idx, e.target.value)}
                              className="w-28 rounded border border-surface-border px-2 py-1 text-right text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                            />
                          </td>
                          <td className="px-3 py-2 text-right text-navy/70">{fmt(after)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
            <div className="mt-3 space-y-1 text-sm text-right">
              <div className="flex justify-between text-navy/70">
                <span>Allocated:</span>
                <span>{fmt(totals.allocated)}</span>
              </div>
              <div className="flex justify-between text-navy/70">
                <span>Total paid:</span>
                <span>{fmt(total)}</span>
              </div>
              {totals.overAllocated ? (
                <div className="flex justify-between font-medium text-danger">
                  <span>⚠ Allocated more than paid:</span>
                  <span>{fmt(totals.allocated - total)}</span>
                </div>
              ) : (
                totals.excess > 0.001 && (
                  <div className="flex justify-between font-medium text-amber-600">
                    <span>→ Stays on account:</span>
                    <span>{fmt(totals.excess)}</span>
                  </div>
                )
              )}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-surface-border px-6 py-4">
          <Button variant="secondary" onClick={onClose} disabled={record.isPending}>
            Cancel
          </Button>
          <Button
            onClick={() => void handleSubmit()}
            loading={record.isPending}
            disabled={totals.overAllocated}
          >
            Record Payment
          </Button>
        </div>
      </div>
    </div>
  );
}

/** totalOwed − totalPaid, cents-safe against the Decimal→string/number
 *  round-trip (the API's Decimal columns don't always arrive as `number`). */
function roundOwed(b: { totalOwed: number | string; totalPaid: number | string }): number {
  return Number(b.totalOwed) - Number(b.totalPaid);
}
