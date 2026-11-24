"use client";

import React from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Ban, Printer } from "lucide-react";
import { usePageTitle } from "@/lib/page-title-context";
import {
  useInvoice,
  usePaymentDetail,
  useVoidPayment,
  useGetPaymentImageUrl,
} from "@/lib/api/invoices";
import { Badge, Button, Card, cn, useToast } from "@routeflow/ui/web";
import { dayClosedCopy } from "@/lib/day-closed-copy";
import { fmt, fmtDate } from "@/lib/formatting";
import { paymentMethodLabel } from "@/lib/payment-methods";
import { paidInAdvance } from "@/lib/invoice-pending-mirror";
import {
  receiptStatusText,
  type PaymentStatus,
  type ReceiptGroupView,
  type ReceiptHeader,
  type ReceiptTender,
} from "@routeflow/types";
import { roundMoney } from "@routeflow/pricing";

const BANK_DATE_HELP =
  "When the funds actually landed in your account — e.g. a post-dated check's clearing date. Leave blank if unknown.";

/** "(Check #1001)" beside the figure: the instrument the server named, never a label that calls it the check's amount. */
function receiptTenderHint(h: ReceiptHeader): string | null {
  const method = h.method ? paymentMethodLabel(h.method) : null;
  if (h.reference) return `(${method ? `${method} ` : ""}#${h.reference})`;
  return method ? `(${method})` : null;
}

/** One line (an invoice row or a tender): the server's status word, never read as money received unless PAID (L-119). */
function ReceiptLine({ status, amount }: { status: PaymentStatus; amount: number }) {
  const text = receiptStatusText(status);
  return (
    <span className="flex items-center gap-2">
      {text && (
        <span className={cn("text-xs", status === "VOID" ? "text-navy/70" : "text-warning")}>
          {text}
        </span>
      )}
      <span
        className={cn(
          "money",
          status === "VOID" ? "text-navy/40 line-through" : text ? "text-navy/50" : "text-navy",
        )}
      >
        {fmt(amount)}
      </span>
    </span>
  );
}

function BankDateRow({ settledAt }: { settledAt: string }) {
  return (
    <div className="flex items-center justify-between gap-3 border-b border-surface-border py-2.5 text-[13px]">
      <span className="text-navy/70" title={BANK_DATE_HELP}>
        Money received in bank
      </span>
      <span className="text-right font-medium text-navy">{fmtDate(settledAt)}</span>
    </div>
  );
}

/** "· 1 draft ($1,000.00) not counted": what sits outside the total, summed from the server's tender amounts. */
function notCounted(tenders: ReceiptTender[]): string {
  return (["DRAFT", "PENDING"] as const)
    .map((s) => ({ s, ts: tenders.filter((t) => t.status === s) }))
    .filter(({ ts }) => ts.length > 0)
    .map(({ s, ts }) => {
      const sum = fmt(roundMoney(ts.reduce((n, t) => n + t.amount, 0)));
      return `· ${ts.length} ${s.toLowerCase()} (${sum}) not counted`;
    })
    .join(" ");
}

/** The invoices one check covered and what it was paid with: the server's figures, printed as given. */
function ReceiptGroupBody({ view }: { view: ReceiptGroupView }) {
  const h = view.header!;
  return (
    <div className="mt-6 space-y-5">
      {view.kind === "PICKUP_TENDERS" && h.orderNumber && (
        <p className="text-sm font-medium text-navy">Pickup payments for order {h.orderNumber}</p>
      )}
      {h.partlyVoided && (
        <p className="text-[12.5px] font-medium text-warning">
          {`${h.method === "CHECK" ? "Check" : "Payment"} partly voided`}
        </p>
      )}
      <div>
        <p className="eyebrow-label mb-1">Invoices</p>
        <ul aria-label="Invoices on this receipt" className="divide-y divide-surface-border">
          {view.applications.map((a) => (
            <li
              key={a.paymentId}
              className="flex items-center justify-between gap-3 py-2 text-[13px]"
            >
              <Link
                href={`/invoices/${a.invoiceId}`}
                className="font-medium text-brand-600 hover:underline"
              >
                {a.invoiceNumber}
              </Link>
              <ReceiptLine status={a.status} amount={a.amount} />
            </li>
          ))}
        </ul>
      </div>
      <div>
        <p className="eyebrow-label mb-1">Paid with</p>
        <ul aria-label="Tenders on this receipt" className="divide-y divide-surface-border">
          {view.tenders.map((t) => (
            <li
              key={t.paymentIds.join("-")}
              className="flex items-center justify-between gap-3 py-2 text-[13px]"
            >
              <span className="text-navy">
                {paymentMethodLabel(t.method)}
                {t.reference ? ` #${t.reference}` : ""}
              </span>
              <ReceiptLine status={t.status} amount={t.amount} />
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default function PaymentDetailPage() {
  const { setTitle } = usePageTitle();
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const { toast } = useToast();

  const { data: payment, isLoading } = usePaymentDetail(id);
  const voidPayment = useVoidPayment();

  React.useEffect(() => {
    setTitle("Payment Receipt");
  }, [setTitle]);

  // Enrich the "Applied invoice" card with the invoice's own total / balance /
  // status. Guarded below for loading/undefined so the card degrades gracefully.
  const { data: invoice } = useInvoice(payment?.invoice.id ?? "");

  // Receipt image (expense-viewer pattern): resolve the presigned URL once we
  // know the payment has one attached. Called unconditionally (before the
  // loading/not-found early returns) to respect the Rules of Hooks.
  const getPaymentImageUrl = useGetPaymentImageUrl();
  const [receiptUrl, setReceiptUrl] = React.useState<string | null>(null);

  React.useEffect(() => {
    setReceiptUrl(null);
    if (payment?.id && payment.imageKey) {
      getPaymentImageUrl
        .mutateAsync(payment.id)
        .then((r) => setReceiptUrl(r.url))
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [payment?.id, payment?.imageKey]);

  const handleVoid = async () => {
    if (!payment) return;
    if (
      !confirm("Void this payment? This reverses its effect on the invoice and cannot be undone.")
    )
      return;
    try {
      await voidPayment.mutateAsync({ invoiceId: payment.invoice.id, paymentId: payment.id });
      toast({ title: "Payment voided", variant: "success" });
    } catch (err: unknown) {
      // The global toast is quiet for a closed-day refusal (the hook's meta): this one says why, once.
      toast({
        title: "Failed to void payment",
        description: dayClosedCopy(err) ?? undefined,
        variant: "error",
      });
    }
  };

  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center p-6">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-brand-500 border-t-transparent" />
      </div>
    );
  }

  if (!payment) {
    return (
      <div className="p-6 text-center space-y-3">
        <p className="text-navy/70">Payment not found.</p>
        <button onClick={() => router.back()} className="text-brand-500 hover:underline text-sm">
          ← Back
        </button>
      </div>
    );
  }

  const status = payment.status ?? "PAID";
  // M1-03: an office check or a pickup hand-over reads as ONE receipt, built by the server. Every figure below is printed as
  // given: nothing here adds or subtracts money. A one-row payment (or an older server) keeps today's receipt.
  const rc = payment.receipt;
  const group =
    rc?.header && (rc.kind === "OFFICE_GROUP" || rc.kind === "PICKUP_TENDERS") ? rc : null;
  // SA-1242: on a group receipt the top is the RECEIPT's (the header); a field only the clicked row has sits under
  // "This payment", and a field that varies between tenders is printed per tender (never one method/reference pair).
  const date = fmtDate(group ? group.header?.receivedAt : (payment.paidAt ?? payment.createdAt));
  const rowStatusText = group && status !== "PAID" ? receiptStatusText(status) : null;
  const rowOnly = group && (payment.settledAt || payment.notes);
  const method = group ? group.header?.method : payment.method;
  const reference = group ? group.header?.reference : payment.reference;
  const rcNumber = group?.header?.number ?? payment.paymentNumber;
  const hasBankCharges = !group && payment.bankCharges != null && payment.bankCharges > 0;

  return (
    <div className="space-y-5 p-6">
      {/* Back */}
      <Link
        href="/finance/payments"
        className="flex items-center gap-1.5 text-sm text-navy/70 hover:text-navy transition-colors"
      >
        <ArrowLeft className="h-4 w-4" />
        Payments
      </Link>

      {/* Header (ph-row) */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="font-mono text-2xl font-bold text-navy">
              {group?.header?.number ?? payment.paymentNumber ?? "Payment"}
            </h2>
            <Badge
              status={(group?.header?.confirmed ? "PAID" : status) as "PAID" | "DRAFT" | "VOID"}
            />
          </div>
          <p className="mt-1 text-sm text-navy/70">
            Payment received · {payment.invoice.customer?.businessName ?? "—"} · {date}
          </p>
          {rowStatusText && (
            <p className="mt-0.5 text-[12.5px] text-warning">{`This payment: ${rowStatusText}`}</p>
          )}
        </div>

        {/* Actions */}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<Printer className="h-4 w-4" />}
            onClick={() => window.print()}
          >
            Print receipt
          </Button>
        </div>
      </div>

      {/* Body: doc (1.5fr) + sidebar (1fr) */}
      <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-[1.5fr_1fr]">
        {/* ── Receipt document ── */}
        <Card className="p-8">
          <div className="mb-6">
            <h2 className="display text-[26px]">Payment Receipt</h2>
            <p className="mono mt-1 text-[12.5px] text-navy/70">
              {rcNumber ? `${rcNumber} · ` : ""}
              {date}
            </p>
          </div>

          {/* KV grid */}
          <div className="grid grid-cols-1 gap-x-10 sm:grid-cols-2">
            <div className="flex items-center justify-between gap-3 border-b border-surface-border py-2.5 text-[13px]">
              <span className="text-navy/70">Received from</span>
              <span className="text-right font-medium text-navy">
                {payment.invoice.customer?.businessName ?? "—"}
              </span>
            </div>
            <div className="flex items-center justify-between gap-3 border-b border-surface-border py-2.5 text-[13px]">
              <span className="text-navy/70">Payment date</span>
              <span className="text-right font-medium text-navy">{date}</span>
            </div>
            {!group && payment.settledAt && <BankDateRow settledAt={payment.settledAt} />}
            {(!group || method) && (
              <div className="flex items-center justify-between gap-3 border-b border-surface-border py-2.5 text-[13px]">
                <span className="text-navy/70">Payment method</span>
                <span className="text-right font-medium text-navy">
                  {paymentMethodLabel(method ?? "")}
                </span>
              </div>
            )}
            {reference && (
              <div className="flex items-center justify-between gap-3 border-b border-surface-border py-2.5 text-[13px]">
                <span className="text-navy/70">Reference</span>
                <span className="mono text-right font-medium text-navy">{reference}</span>
              </div>
            )}
            {!group && (
              <div className="flex items-center justify-between gap-3 border-b border-surface-border py-2.5 text-[13px]">
                <span className="text-navy/70">Applied to</span>
                <Link
                  href={`/invoices/${payment.invoice.id}`}
                  className="text-right font-medium text-brand-600 hover:underline"
                >
                  {payment.invoice.invoiceNumber}
                </Link>
              </div>
            )}
          </div>
          {group && <ReceiptGroupBody view={group} />}

          {rowOnly && (
            <div className="mt-6 border-t border-surface-border pt-4">
              <p className="eyebrow-label mb-1">This payment</p>
              {payment.settledAt && <BankDateRow settledAt={payment.settledAt} />}
              {payment.notes && (
                <p className="pt-2 text-sm text-navy/70 whitespace-pre-line">{payment.notes}</p>
              )}
            </div>
          )}

          {/* Notes */}
          {!group && payment.notes && (
            <div className="mt-6 border-t border-surface-border pt-4">
              <p className="eyebrow-label mb-1">Notes</p>
              <p className="text-sm text-navy/70 whitespace-pre-line">{payment.notes}</p>
            </div>
          )}

          {/* Totals */}
          <div className="mt-6 flex justify-end">
            <div className="w-full max-w-[300px]">
              {group?.header ? (
                <div className="flex justify-between gap-3 py-1.5 text-base font-semibold text-navy">
                  <span>
                    Received on this receipt
                    {receiptTenderHint(group.header) && (
                      <span className="ml-1 text-[12.5px] font-normal text-navy/70">
                        {receiptTenderHint(group.header)}
                      </span>
                    )}
                    <span className="ml-1 text-[12.5px] font-normal text-navy/70">
                      {notCounted(group.tenders)}
                    </span>
                  </span>
                  {group.header.confirmed ? (
                    <span className="money">{fmt(group.header.total)}</span>
                  ) : (
                    <span className="text-warning">Not confirmed</span>
                  )}
                </div>
              ) : (
                <div className="flex justify-between py-1.5 text-[13.5px] text-navy/70">
                  <span>Amount received</span>
                  <span className="money text-navy">{fmt(payment.amount)}</span>
                </div>
              )}
              {hasBankCharges && (
                <div className="flex justify-between py-1.5 text-[13.5px] text-navy/70">
                  <span>Bank charges</span>
                  <span className="money text-danger">− {fmt(payment.bankCharges!)}</span>
                </div>
              )}
              {!group && (
                <div className="mt-1.5 flex justify-between border-t border-navy pt-3 text-base font-semibold text-navy">
                  <span>Total applied</span>
                  <span className="money">{fmt(payment.amount)}</span>
                </div>
              )}
              {group?.unapplied.amount != null && group.unapplied.advancePaymentId && (
                <div
                  data-testid="kept-as-credit"
                  className="mt-1.5 flex items-center justify-between gap-3 border-t border-surface-border pt-3 text-[13.5px] text-navy/70"
                >
                  <span>
                    Kept as credit{" "}
                    <Link
                      href={`/customers/${group.header?.customerId}?tab=billing`}
                      className="text-brand-600 hover:underline"
                    >
                      See credit
                    </Link>
                  </span>
                  <span className="money text-navy">{fmt(group.unapplied.amount)}</span>
                </div>
              )}
            </div>
          </div>
        </Card>

        {/* ── Sidebar ── */}
        <div className="space-y-4">
          {!group && (
            <Card title="Applied invoice">
              <dl className="space-y-3 text-sm">
                <div className="flex items-center justify-between">
                  <dt className="text-navy/70">Invoice</dt>
                  <dd>
                    <Link
                      href={`/invoices/${payment.invoice.id}`}
                      className="mono text-brand-600 hover:underline"
                    >
                      {payment.invoice.invoiceNumber}
                    </Link>
                  </dd>
                </div>
                <div className="flex items-center justify-between">
                  <dt className="text-navy/70">Applied</dt>
                  <dd className="money text-success">{fmt(payment.amount)}</dd>
                </div>
                {invoice && (
                  <>
                    <div className="flex items-center justify-between">
                      <dt className="text-navy/70">Invoice total</dt>
                      <dd className="money text-navy">{fmt(invoice.total)}</dd>
                    </div>
                    {invoice.balanceDue != null && (
                      <div className="flex items-center justify-between">
                        <dt className="text-navy/70">Remaining balance</dt>
                        <dd className="money text-navy">{fmt(invoice.balanceDue)}</dd>
                      </div>
                    )}
                    <div className="flex items-center justify-between">
                      <dt className="text-navy/70">Invoice status</dt>
                      <dd>
                        <Badge status={invoice.status} />
                        {paidInAdvance(invoice) !== "none" && (
                          <span className="ml-2 inline-flex items-center rounded-full bg-surface-raised px-2 text-[11px] font-medium text-navy/70">
                            {paidInAdvance(invoice) === "full"
                              ? "Paid in advance"
                              : "Part paid in advance"}
                          </span>
                        )}
                      </dd>
                    </div>
                  </>
                )}
              </dl>
            </Card>
          )}

          {payment.imageKey && (
            <Card title="Receipt image">
              {receiptUrl ? (
                <a href={receiptUrl} target="_blank" rel="noopener noreferrer">
                  <img
                    src={receiptUrl}
                    alt="Payment receipt"
                    className="max-h-80 w-full rounded-lg border border-surface-border object-contain"
                  />
                </a>
              ) : (
                <p className="text-sm text-navy/70">Loading receipt…</p>
              )}
            </Card>
          )}

          {status !== "VOID" && (
            <Card className="border border-danger-bg">
              <h3 className="mb-2 text-base font-semibold text-danger">Void</h3>
              <p className="text-[12.5px] leading-relaxed text-navy/70">
                {group && group.applications.length > 1
                  ? `Voids only the ${fmt(payment.amount)} on ${payment.invoice.invoiceNumber}; the rest of this receipt stays. It returns that invoice to its prior balance and keeps the row for the audit trail.`
                  : "Voiding reverses the application, returns the invoice to its prior balance, and keeps this receipt for the audit trail."}
              </p>
              <Button
                variant="danger"
                size="sm"
                className="mt-3 w-full"
                leftIcon={<Ban className="h-4 w-4" />}
                onClick={handleVoid}
                loading={voidPayment.isPending}
              >
                Void payment
              </Button>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}
