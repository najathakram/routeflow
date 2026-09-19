"use client";

import * as React from "react";
import Link from "next/link";
import { Modal, Button } from "@routeflow/ui/web";
import { AlertTriangle, ArrowUpRight, Loader2 } from "lucide-react";
import { fmt } from "@/lib/formatting";
import { useOrder } from "@/lib/api/orders";
import { orderLineName } from "@/lib/product-display";
import { useInvoice } from "@/lib/api/invoices";

/**
 * Floating previews that let staff jump between an invoice and its source order (in
 * either direction) without leaving the page — to double-check the numbers agree.
 * Both render the linked document's line items + totals and surface a divergence
 * warning when an order's total no longer matches what its invoices bill. They read
 * server-stored subtotals (never re-derive), so what the popup shows is exactly what
 * was billed.
 */

const EPSILON = 0.01;

/** Amber note shown when an order's total and its invoiced total disagree. */
export function DivergenceNote({
  orderTotal,
  invoicedTotal,
  className,
}: {
  orderTotal: number;
  invoicedTotal: number;
  className?: string;
}) {
  const diff = Math.abs(orderTotal - invoicedTotal);
  if (diff <= EPSILON) return null;
  return (
    <div
      className={
        "flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 " +
        (className ?? "")
      }
      role="status"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-500" />
      <span>
        This order&apos;s total (<span className="font-semibold">{fmt(orderTotal)}</span>)
        doesn&apos;t match its invoiced total (
        <span className="font-semibold">{fmt(invoicedTotal)}</span>) — a{" "}
        <span className="font-semibold">{fmt(diff)}</span> difference. Open both to reconcile.
      </span>
    </div>
  );
}

function LineTable({
  rows,
}: {
  rows: Array<{ id: string; label: string; qtyLabel: string; unitPrice: number; subtotal: number }>;
}) {
  return (
    <div className="overflow-x-auto rounded-lg border border-surface-border">
      <table className="w-full text-sm">
        <thead>
          <tr className="bg-surface-raised text-navy/60">
            <th className="px-3 py-2 text-left font-medium">Item</th>
            <th className="px-3 py-2 text-right font-medium">Qty</th>
            <th className="px-3 py-2 text-right font-medium">Unit</th>
            <th className="px-3 py-2 text-right font-medium">Total</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-t border-surface-border">
              <td className="px-3 py-2 text-navy">{r.label}</td>
              <td className="px-3 py-2 text-right text-navy/70">{r.qtyLabel}</td>
              <td className="px-3 py-2 text-right text-navy/70">{fmt(r.unitPrice)}</td>
              <td className="px-3 py-2 text-right font-medium text-navy">{fmt(r.subtotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function qtyLabel(li: { qty: number; boxes?: number | null; pieces?: number | null }): string {
  if (li.boxes != null) {
    const b = `${li.boxes} box${li.boxes === 1 ? "" : "es"}`;
    return li.pieces ? `${b} + ${li.pieces}` : b;
  }
  return String(li.qty);
}

function ModalState({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-4">{children}</div>;
}

/** Invoice → source order. Shows the order's lines/totals + a divergence note. */
export function OrderPreviewModal({
  open,
  onClose,
  orderId,
}: {
  open: boolean;
  onClose: () => void;
  orderId: string;
}) {
  const { data: order, isLoading } = useOrder(open ? orderId : "");
  // Sum this order's own non-void invoice totals for the divergence note. Only
  // meaningful once the order is fully invoiced; a partial split legitimately bills
  // less, so suppress the note unless the whole order has been invoiced.
  const nonVoid = (order?.invoices ?? []).filter((i) => i.status !== "VOID");
  const invoicedTotal = nonVoid.reduce((s, i) => s + Number(i.total), 0);
  const fullyInvoiced =
    (order?.status === "DELIVERED" || order?.status === "CANCELLED") && nonVoid.length > 0;
  const rows = (order?.lineItems ?? [])
    .filter((li) => li.status !== "CANCELLED")
    .map((li) => ({
      id: li.id,
      label: orderLineName(li) ?? "Custom item",
      qtyLabel: qtyLabel(li),
      unitPrice: Number(li.unitPrice),
      subtotal: li.subtotal != null ? Number(li.subtotal) : Number(li.unitPrice) * Number(li.qty),
    }));

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={order ? `Order ${order.orderNumber ?? ""}`.trim() : "Order"}
      className="max-w-2xl"
      footer={
        order ? (
          <Button href={`/orders/${order.id}`} variant="secondary" size="sm">
            Open full order <ArrowUpRight className="ml-1 h-4 w-4" />
          </Button>
        ) : null
      }
    >
      {isLoading || !order ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin text-navy/50" />
        </div>
      ) : (
        <ModalState>
          {fullyInvoiced && (
            <DivergenceNote orderTotal={Number(order.total)} invoicedTotal={invoicedTotal} />
          )}
          <LineTable rows={rows} />
          <div className="flex justify-end">
            <dl className="w-56 space-y-1 text-sm">
              <div className="flex justify-between text-navy/70">
                <dt>Subtotal</dt>
                <dd>{fmt(Number(order.subtotal))}</dd>
              </div>
              <div className="flex justify-between text-navy/70">
                <dt>Tax</dt>
                <dd>{fmt(Number(order.tax))}</dd>
              </div>
              <div className="flex justify-between border-t border-surface-border pt-1 font-semibold text-navy">
                <dt>Order total</dt>
                <dd>{fmt(Number(order.total))}</dd>
              </div>
            </dl>
          </div>
        </ModalState>
      )}
    </Modal>
  );
}

/** Order → one of its invoices. Shows the invoice's lines/totals/balance + note. */
export function InvoicePreviewModal({
  open,
  onClose,
  invoiceId,
  orderTotal,
}: {
  open: boolean;
  onClose: () => void;
  invoiceId: string;
  /** The source order's total (for the divergence note). */
  orderTotal?: number;
}) {
  const { data: invoice, isLoading } = useInvoice(open ? invoiceId : "");
  const rows = (invoice?.items ?? []).map((it) => ({
    id: it.id,
    label: it.description,
    qtyLabel: qtyLabel({ qty: it.qty, boxes: it.boxes, pieces: it.pieces }),
    unitPrice: Number(it.unitPrice),
    subtotal: it.subtotal != null ? Number(it.subtotal) : Number(it.unitPrice) * Number(it.qty),
  }));
  const total = invoice ? Number(invoice.total) : 0;
  const paid = invoice?.paidAmount ?? 0;
  const balance = invoice?.balanceDue ?? Math.max(0, total - paid);

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={invoice ? `Invoice ${invoice.invoiceNumber}` : "Invoice"}
      className="max-w-2xl"
      footer={
        invoice ? (
          <Button href={`/invoices/${invoice.id}`} variant="secondary" size="sm">
            Open full invoice <ArrowUpRight className="ml-1 h-4 w-4" />
          </Button>
        ) : null
      }
    >
      {isLoading || !invoice ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin text-navy/50" />
        </div>
      ) : (
        <ModalState>
          {orderTotal != null && <DivergenceNote orderTotal={orderTotal} invoicedTotal={total} />}
          <LineTable rows={rows} />
          <div className="flex justify-end">
            <dl className="w-56 space-y-1 text-sm">
              <div className="flex justify-between text-navy/70">
                <dt>Subtotal</dt>
                <dd>{fmt(Number(invoice.subtotal))}</dd>
              </div>
              <div className="flex justify-between text-navy/70">
                <dt>Tax</dt>
                <dd>{fmt(Number(invoice.taxAmount ?? 0))}</dd>
              </div>
              <div className="flex justify-between border-t border-surface-border pt-1 font-semibold text-navy">
                <dt>Invoice total</dt>
                <dd>{fmt(total)}</dd>
              </div>
              <div className="flex justify-between text-navy/70">
                <dt>Paid</dt>
                <dd>{fmt(paid)}</dd>
              </div>
              <div className="flex justify-between font-semibold text-navy">
                <dt>Balance due</dt>
                <dd>{fmt(balance)}</dd>
              </div>
            </dl>
          </div>
        </ModalState>
      )}
    </Modal>
  );
}

/** Small helper so both link-buttons render identically. */
export function PreviewLinkButton({
  onClick,
  children,
}: {
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center gap-1 text-sm font-medium text-brand-600 hover:text-brand-700 hover:underline"
    >
      {children}
    </button>
  );
}

// Re-export for consumers that want the raw Link (e.g. keyboard users bypassing the modal).
export const OrderDeepLink = ({
  orderId,
  children,
}: {
  orderId: string;
  children: React.ReactNode;
}) => (
  <Link href={`/orders/${orderId}`} className="text-brand-600 hover:underline">
    {children}
  </Link>
);
