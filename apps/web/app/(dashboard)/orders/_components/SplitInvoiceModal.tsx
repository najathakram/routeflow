"use client";

import * as React from "react";
import { roundMoney } from "@routeflow/pricing";
import { Modal, Button, useToast } from "@routeflow/ui/web";
import { previewSplitLineTotal, type SplitInvoiceLine } from "@/lib/split-invoice-line";
import { useCreatePartialInvoiceFromOrder } from "@/lib/api/invoices";
import { genericToastCopy } from "@/lib/generic-toast-copy";
import { KEPT_DRAFT_TOAST, keptDraftInvoiceId } from "@/lib/kept-draft-invoice";
import { WriteButton } from "@/lib/read-only-gate";

interface SplitInvoiceModalProps {
  isOpen: boolean;
  onClose: () => void;
  orderId: string;
  orderNumber: string | null;
  items: SplitInvoiceLine[];
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
  const createPartial = useCreatePartialInvoiceFromOrder({ localErrorToast: true });

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
  const selectedTotal = roundMoney(
    billable.reduce((s, it) => s + previewSplitLineTotal(it, qtyById[it.id] ?? 0), 0),
  );

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
        // The Net-N pick is the structured label, NOT the long-form T&C text
        // (`terms`) — posting it there would overwrite the tenant's configured
        // Terms & Conditions block on this invoice.
        paymentTermsLabel: terms || undefined,
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
          // Row 466: the split invoice was created and only the send failed. Open it, don't retry.
          const keptId = keptDraftInvoiceId(err);
          if (keptId) {
            toast({ ...KEPT_DRAFT_TOAST, variant: "warning" });
            onCreated?.(keptId);
            onClose();
            return;
          }
          toast({
            title: "Could not create invoice",
            description: genericToastCopy(
              err,
              "The invoice couldn't be created. Check the selected lines, then try again.",
            ),
            variant: "error",
          });
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
          <WriteButton
            type="button"
            loading={createPartial.isPending}
            disabled={billable.length === 0}
            onClick={submit}
          >
            Create invoice
          </WriteButton>
        </>
      }
    >
      <div className="space-y-4">
        {billable.length === 0 ? (
          <p className="text-sm text-navy/70">
            All items on this order have already been invoiced.
          </p>
        ) : (
          <div className="overflow-x-auto rounded-md border border-surface-border">
            <table className="w-full min-w-[420px] text-sm">
              <thead className="bg-surface-raised text-xs uppercase text-navy/70">
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
                        ${previewSplitLineTotal(it, q).toFixed(2)}
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
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-navy">Due date</label>
            <input
              type="date"
              value={dueDate}
              onChange={(e) => {
                // A hand-typed due date supersedes the term that derived it —
                // posting "Net 30" beside a date that is not issue+30 is the
                // exact label/due-date disagreement this model eliminates.
                setTerms("");
                setDueDate(e.target.value);
              }}
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
          <span className="text-navy/70">Invoice subtotal</span>
          <span className="text-base font-semibold text-navy">${selectedTotal.toFixed(2)}</span>
        </div>
      </div>
    </Modal>
  );
}
