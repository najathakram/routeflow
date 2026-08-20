"use client";

import * as React from "react";
import { Paperclip, Wallet } from "lucide-react";
import { Button, useToast } from "@routeflow/ui/web";
import {
  useRecordPaymentStandalone,
  useUploadPaymentImage,
  useInvoices,
  type StandalonePaymentDto,
  type InvoiceStatus,
} from "@/lib/api/invoices";
import { waterfallAllocations, allocationTotals } from "@/lib/api/supplier-payments";
import { fmt } from "@/lib/formatting";

const fieldCls =
  "w-full rounded-lg border border-surface-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500";

const BANK_DATE_LABEL = "Money received in bank";
const BANK_DATE_HELP =
  "When the funds actually landed in your account — e.g. a post-dated check's clearing date. Leave blank if unknown.";

/** Statuses an invoice can be paid against. Mirrors finance/payments/page.tsx's
 *  OPEN_STATUSES — filtered client-side, since ListInvoicesDto validates
 *  `status` as a single enum value (a comma-list 400s server-side). */
const OPEN_STATUSES: InvoiceStatus[] = ["SENT", "VIEWED", "PARTIAL", "OVERDUE"];

interface AllocRow {
  invoiceId: string;
  invoiceNumber: string;
  amountDue: number;
  amount: string;
}

export interface CustomerRecordPaymentModalProps {
  customerId: string;
  customerName?: string;
  onClose: () => void;
  onSuccess?: () => void;
}

/**
 * The missing customer-level AR entry point (PR-E WP4). This is NOT a third
 * implementation of standalone-payment allocation: it calls the exact same
 * server endpoint/DTO as finance/payments/page.tsx's RecordPaymentModal
 * (`useRecordPaymentStandalone` / `StandalonePaymentDto` — recordStandalonePayment
 * already turns any excess into an AdvancePayment, never an error) and shares
 * the waterfall/clamp/remainder math with the AP modal via
 * `@/lib/api/supplier-payments`, rather than re-deriving either. Only the
 * customer picker is gone — `customerId` is a fixed prop here.
 *
 * (finance/payments/page.tsx itself is out of scope for this change — it
 * keeps its own copy of this same UI, unchanged.)
 */
export function CustomerRecordPaymentModal({
  customerId,
  customerName,
  onClose,
  onSuccess,
}: CustomerRecordPaymentModalProps) {
  const { toast } = useToast();
  const record = useRecordPaymentStandalone();
  const uploadPaymentImage = useUploadPaymentImage();
  const [totalAmount, setTotalAmount] = React.useState("");
  const [bankCharges, setBankCharges] = React.useState("");
  const [paidAt, setPaidAt] = React.useState(new Date().toISOString().split("T")[0]);
  const [settledAt, setSettledAt] = React.useState("");
  const [method, setMethod] = React.useState<StandalonePaymentDto["method"]>("CASH");
  const [reference, setReference] = React.useState("");
  const [notes, setNotes] = React.useState("");
  const [allocations, setAllocations] = React.useState<AllocRow[]>([]);
  const [file, setFile] = React.useState<File | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);

  // A generous page size — the fetch should never be the reason an open
  // invoice can't be offered for allocation.
  const { data: invoicesData } = useInvoices({ customerId, page: 1, limit: 500 });

  // Open invoices, oldest first (issueDate, then createdAt) — the array order
  // IS the pre-fill allocation order.
  const openInvoices = React.useMemo(() => {
    const rows = (invoicesData?.data ?? []).filter(
      (inv) => OPEN_STATUSES.includes(inv.status) && (inv.balanceDue ?? 0) > 0.001,
    );
    return [...rows].sort((a, b) => {
      const ad = a.issueDate ?? "";
      const bd = b.issueDate ?? "";
      if (ad !== bd) return ad.localeCompare(bd);
      return (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
    });
  }, [invoicesData]);

  // Oldest-first is the DEFAULT pre-fill, not a cage — every row stays
  // editable below. Re-runs (overwriting manual edits) whenever the total or
  // the open-invoice set changes, matching the original RecordPaymentModal.
  React.useEffect(() => {
    if (!openInvoices.length) {
      setAllocations([]);
      return;
    }
    const targets = openInvoices.map((inv) => ({ id: inv.id, amountDue: inv.balanceDue ?? 0 }));
    const { allocations: prefill } = waterfallAllocations(parseFloat(totalAmount) || 0, targets);
    const byId = new Map(prefill.map((a) => [a.id, a.amount]));
    setAllocations(
      openInvoices.map((inv) => ({
        invoiceId: inv.id,
        invoiceNumber: inv.invoiceNumber,
        amountDue: inv.balanceDue ?? 0,
        amount: byId.has(inv.id) ? String(byId.get(inv.id)) : "",
      })),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openInvoices.length, totalAmount]);

  const total = parseFloat(totalAmount) || 0;
  const totals = allocationTotals(
    total,
    allocations.map((a) => ({ amount: a.amount ? parseFloat(a.amount) : null })),
  );

  const updateAlloc = (idx: number, val: string) =>
    setAllocations((prev) => prev.map((a, i) => (i === idx ? { ...a, amount: val } : a)));

  const handleSave = async (status: "DRAFT" | "PAID") => {
    if (!total || total <= 0) {
      toast({ title: "Enter a valid amount", variant: "error" });
      return;
    }
    if (totals.overAllocated) {
      toast({ title: "Allocated more than the amount received", variant: "error" });
      return;
    }
    const validAllocs = allocations.filter((a) => a.amount && parseFloat(a.amount) > 0);
    const dto: StandalonePaymentDto = {
      customerId,
      totalAmount: total,
      method,
      paidAt,
      settledAt: settledAt || undefined,
      bankCharges: bankCharges ? parseFloat(bankCharges) : undefined,
      reference: reference || undefined,
      notes: notes || undefined,
      status,
      allocations: validAllocs.map((a) => ({
        invoiceId: a.invoiceId,
        amount: parseFloat(a.amount),
      })),
    };
    try {
      const res = await record.mutateAsync(dto);
      toast({
        title: `Payment ${status === "DRAFT" ? "saved as draft" : "recorded"}`,
        variant: "success",
      });
      // Best-effort: the payment already succeeded — an image-upload failure
      // must never look like the payment itself failed.
      const createdPaymentId = res.payments[0]?.id;
      if (file && createdPaymentId) {
        try {
          await uploadPaymentImage.mutateAsync({ paymentId: createdPaymentId, file });
        } catch {
          toast({
            title: "Payment saved, image upload failed",
            description: "You can attach it later from the payment detail page.",
            variant: "error",
          });
        }
      }
      onSuccess?.();
      onClose();
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
      toast({ title: msg ?? "Failed to record payment", variant: "error" });
    }
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/40 p-4">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl bg-white shadow-modal">
        <div className="flex items-center justify-between border-b border-surface-border px-6 py-4">
          <div className="flex items-center gap-2">
            <Wallet className="h-5 w-5 text-brand-500" />
            <h2 className="text-lg font-semibold text-navy">
              Record Payment{customerName ? ` — ${customerName}` : ""}
            </h2>
          </div>
          <button onClick={onClose} className="text-navy/70 hover:text-navy text-xl">
            ×
          </button>
        </div>
        <div className="overflow-y-auto px-6 py-4 space-y-4">
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="mb-1.5 block text-sm font-medium text-navy">
                Amount Received *
              </label>
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
              <label className="mb-1.5 block text-sm font-medium text-navy">Bank Charges</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={bankCharges}
                onChange={(e) => setBankCharges(e.target.value)}
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
              <label className="mb-1.5 mt-3 block text-sm font-medium text-navy/60">
                {BANK_DATE_LABEL}
              </label>
              <input
                type="date"
                value={settledAt}
                onChange={(e) => setSettledAt(e.target.value)}
                className={fieldCls}
              />
              <p className="mt-1 text-xs text-navy/50">{BANK_DATE_HELP}</p>
            </div>
            <div>
              <label className="mb-1.5 block text-sm font-medium text-navy">Payment Mode *</label>
              <select
                value={method}
                onChange={(e) => setMethod(e.target.value as StandalonePaymentDto["method"])}
                className={fieldCls}
              >
                <option value="CASH">Cash</option>
                <option value="CHECK">Check</option>
                <option value="ACH">ACH / Bank Transfer</option>
                <option value="CREDIT_CARD">Credit Card</option>
                <option value="OTHER">Other</option>
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
            <div className="col-span-2">
              <label className="mb-1.5 block text-sm font-medium text-navy">
                Attach image (optional)
              </label>
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              {file ? (
                <div className="flex items-center justify-between gap-2 rounded-lg border border-surface-border bg-surface-raised px-3 py-2 text-sm text-navy">
                  <span className="flex min-w-0 items-center gap-1.5">
                    <Paperclip className="h-3.5 w-3.5 shrink-0 text-navy/70" />
                    <span className="truncate">{file.name}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setFile(null)}
                    className="shrink-0 text-navy/50 transition-colors hover:text-danger"
                    title="Remove attachment"
                  >
                    ×
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-surface-border bg-white px-3 py-2 text-sm text-navy/70 transition-colors hover:bg-surface-raised"
                >
                  <Paperclip className="h-3.5 w-3.5" />
                  Attach receipt / check photo
                </button>
              )}
            </div>
          </div>

          {/* Invoice allocation */}
          <div>
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-navy">Apply to Invoices</h3>
              <button
                type="button"
                onClick={() => setAllocations((prev) => prev.map((a) => ({ ...a, amount: "" })))}
                className="text-xs text-brand-500 hover:underline"
              >
                Clear
              </button>
            </div>
            {openInvoices.length === 0 ? (
              <p className="text-sm text-navy/70 italic">No unpaid invoices for this customer.</p>
            ) : (
              <div className="overflow-hidden rounded-lg border border-surface-border">
                <table className="w-full text-sm">
                  <thead className="bg-surface-raised text-xs font-medium text-navy/70">
                    <tr>
                      <th className="px-3 py-2 text-left">Invoice #</th>
                      <th className="px-3 py-2 text-right">Amount Due</th>
                      <th className="px-3 py-2 text-right">Apply ($)</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-surface-border">
                    {allocations.map((a, idx) => (
                      <tr key={a.invoiceId}>
                        <td className="px-3 py-2 font-medium text-brand-600">{a.invoiceNumber}</td>
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
                      </tr>
                    ))}
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
                <span>Total received:</span>
                <span>{fmt(total)}</span>
              </div>
              {totals.overAllocated ? (
                <div className="flex justify-between font-medium text-danger">
                  <span>⚠ Allocated more than received:</span>
                  <span>{fmt(totals.allocated - total)}</span>
                </div>
              ) : (
                totals.excess > 0.001 && (
                  <div className="flex justify-between font-medium text-amber-600">
                    <span>⚠ Unallocated (→ advance):</span>
                    <span>{fmt(totals.excess)}</span>
                  </div>
                )
              )}
            </div>
          </div>
        </div>

        <div className="flex items-center justify-end gap-3 border-t border-surface-border px-6 py-4">
          <Button variant="secondary" onClick={onClose} disabled={record.isPending}>
            Cancel
          </Button>
          <Button
            variant="secondary"
            onClick={() => void handleSave("DRAFT")}
            loading={record.isPending}
            disabled={totals.overAllocated}
          >
            Save as Draft
          </Button>
          <Button
            onClick={() => void handleSave("PAID")}
            loading={record.isPending}
            disabled={totals.overAllocated}
          >
            Save as Paid
          </Button>
        </div>
      </div>
    </div>
  );
}
