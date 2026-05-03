"use client";

import * as React from "react";
import { Modal, Button, useToast } from "@routeflow/ui/web";
import { useCreatePartialInvoiceFromOrder } from "@/lib/api/invoices";

interface OrderItemForSplit {
  id: string;
  productName: string;
  qty: number;
  invoicedQty: number;
  unitPrice: number;
  unit?: string;
}

interface SplitInvoiceModalProps {
  isOpen: boolean;
  onClose: () => void;
  orderId: string;
  orderNumber: string | null;
  items: OrderItemForSplit[];
  /** Default tenant terms (e.g. "Net 30"). Used to compute the initial due date. */
  defaultTerms?: string;
  onCreated?: (invoiceId: string) => void;
}

const TERM_DAYS: Record<string, number> = {
  "Due on Receipt": 0,
  "Net 15": 15,
  "Net 30": 30,
  "Net 45": 45,
  "Net 60": 60,
};

function todayPlusDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function SplitInvoiceModal({
  isOpen,
  onClose,
  orderId,
  orderNumber,
  items,
  defaultTerms = "Net 30",
  onCreated,
}: SplitInvoiceModalProps) {
  const { toast } = useToast();
  const createPartial = useCreatePartialInvoiceFromOrder();

  // Per-row qty to invoice (defaults to remaining for each row).
  const [qtyById, setQtyById] = React.useState<Record<string, number>>({});
  const [terms, setTerms] = React.useState(defaultTerms);
  const [dueDate, setDueDate] = React.useState(() => todayPlusDays(TERM_DAYS[defaultTerms] ?? 30));
  const [send, setSend] = React.useState(false);

  // When items change (e.g. modal reopens after a previous split), reset defaults to remaining.
  React.useEffect(() => {
    if (!isOpen) return;
    const next: Record<string, number> = {};
    items.forEach((it) => {
      const remaining = Math.max(0, it.qty - it.invoicedQty);
      next[it.id] = remaining;
    });
    setQtyById(next);
    setTerms(defaultTerms);
    setDueDate(todayPlusDays(TERM_DAYS[defaultTerms] ?? 30));
    setSend(false);
  }, [isOpen, items, defaultTerms]);

  const billable = items.filter((it) => it.qty - it.invoicedQty > 0.001);
  const selectedTotal = billable.reduce((s, it) => {
    const q = qtyById[it.id] ?? 0;
    return s + q * it.unitPrice;
  }, 0);

  const onTermsChange = (newTerms: string) => {
    setTerms(newTerms);
    setDueDate(todayPlusDays(TERM_DAYS[newTerms] ?? 30));
  };

  const submit = () => {
    const chosen = billable
      .map((it) => ({ orderItemId: it.id, qty: qtyById[it.id] ?? 0 }))
      .filter((row) => row.qty > 0);
    if (chosen.length === 0) {
      toast({ title: "Pick at least one item to invoice", variant: "error" });
      return;
    }
    createPartial.mutate(
      {
        orderId,
        items: chosen,
        terms,
        dueDate,
        send,
      },
      {
        onSuccess: (invoice) => {
          toast({
            title: `Invoice ${invoice.invoiceNumber} created`,
            description: send ? "Marked as sent." : "Saved as draft.",
            variant: "success",
          });
          onCreated?.(invoice.id);
          onClose();
        },
        onError: (err: any) => {
          const msg =
            err?.response?.data?.message ||
            err?.message ||
            "Failed to create invoice. Please try again.";
          toast({ title: "Could not create invoice", description: msg, variant: "error" });
        },
      },
    );
  };

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title="Split into invoice"
      description={`Order ${orderNumber ?? orderId.slice(0, 8)} — choose what to bill on this invoice.`}
      className="max-w-2xl"
      footer={
        <>
          <Button variant="secondary" type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            loading={createPartial.isPending}
            disabled={billable.length === 0}
            onClick={submit}
          >
            Create invoice
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {billable.length === 0 ? (
          <p className="text-sm text-navy/60">
            All items on this order have already been invoiced.
          </p>
        ) : (
          <div className="overflow-hidden rounded-md border border-surface-border">
            <table className="w-full text-sm">
              <thead className="bg-surface-raised text-xs uppercase text-navy/60">
                <tr>
                  <th className="px-3 py-2 text-left">Product</th>
                  <th className="px-3 py-2 text-right">Remaining</th>
                  <th className="px-3 py-2 text-right">Qty to invoice</th>
                  <th className="px-3 py-2 text-right">Line total</th>
                </tr>
              </thead>
              <tbody>
                {billable.map((it) => {
                  const remaining = it.qty - it.invoicedQty;
                  const q = qtyById[it.id] ?? 0;
                  return (
                    <tr key={it.id} className="border-t border-surface-border">
                      <td className="px-3 py-2 text-navy">{it.productName}</td>
                      <td className="px-3 py-2 text-right text-navy/70">
                        {remaining} {it.unit ?? ""}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <input
                          type="number"
                          min={0}
                          max={remaining}
                          step="any"
                          value={q}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            setQtyById((prev) => ({
                              ...prev,
                              [it.id]: Number.isNaN(v) ? 0 : Math.min(Math.max(0, v), remaining),
                            }));
                          }}
                          className="w-24 rounded border border-surface-border px-2 py-1 text-right text-sm focus:outline-none focus:ring-1 focus:ring-brand-500"
                        />
                      </td>
                      <td className="px-3 py-2 text-right font-medium text-navy">
                        ${(q * it.unitPrice).toFixed(2)}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-navy">Terms</label>
            <select
              value={terms}
              onChange={(e) => onTermsChange(e.target.value)}
              className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            >
              {Object.keys(TERM_DAYS).map((t) => (
                <option key={t} value={t}>{t}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-navy">Due date</label>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => setDueDate(e.target.value)}
              className="w-full rounded border border-surface-border px-3 py-2 text-sm text-navy focus:outline-none focus:ring-2 focus:ring-brand-500"
            />
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm text-navy">
          <input
            type="checkbox"
            checked={send}
            onChange={(e) => setSend(e.target.checked)}
            className="h-4 w-4 accent-brand-500"
          />
          Send immediately (mark as SENT)
        </label>

        <div className="flex items-center justify-between border-t border-surface-border pt-3 text-sm">
          <span className="text-navy/60">Invoice subtotal</span>
          <span className="text-base font-semibold text-navy">${selectedTotal.toFixed(2)}</span>
        </div>
      </div>
    </Modal>
  );
}
