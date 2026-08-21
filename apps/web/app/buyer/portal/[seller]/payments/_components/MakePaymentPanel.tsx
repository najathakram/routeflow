"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { useQueryClient } from "@tanstack/react-query";
import { CreditCard, Banknote, Clock, Loader2, AlertCircle, CheckCircle2 } from "lucide-react";
import { Badge, Button, useToast } from "@routeflow/ui/web";
import { useBuyerAuth } from "@/lib/buyer-auth-context";
import {
  useBuyerPaymentContext,
  useBuyerPaymentPreview,
  useStartCardPayment,
  useDeclareCashPayment,
  useCancelPaymentRequest,
  type BuyerPaymentAllocationLine,
  type BuyerPaymentRequestRow,
} from "@/lib/api/buyer-payments";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function fmt(n: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(n);
}

function fmtDate(dateStr: string): string {
  return new Date(dateStr).toLocaleDateString("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
}

function errorMessage(err: unknown, fallback: string): string {
  const msg = (err as { response?: { data?: { message?: string } } })?.response?.data?.message;
  if (!msg) return fallback;
  return Array.isArray(msg) ? msg.join(", ") : msg;
}

// ─── Allocation preview ───────────────────────────────────────────────────────

function AllocationPreview({
  lines,
  excess,
  isFetching,
}: {
  lines: BuyerPaymentAllocationLine[];
  excess: number;
  isFetching: boolean;
}) {
  if (lines.length === 0) {
    return (
      <p className="py-2 text-xs text-navy/60">
        {isFetching ? "Calculating…" : "Enter an amount to see which invoices it settles."}
      </p>
    );
  }
  return (
    <div className="overflow-hidden rounded-lg border border-surface-border">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[420px]">
          <thead>
            <tr className="border-b border-surface-border bg-surface-raised">
              <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-navy/70">
                Invoice
              </th>
              <th className="px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wider text-navy/70">
                Issued
              </th>
              <th className="px-3 py-2 text-right text-[11px] font-semibold uppercase tracking-wider text-navy/70">
                Applied
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-border">
            {lines.map((l) => (
              <tr key={l.invoiceId}>
                <td className="px-3 py-2 text-sm font-medium text-navy">{l.invoiceNumber}</td>
                <td className="px-3 py-2 text-xs text-navy/60">{fmtDate(l.issueDate)}</td>
                <td className="px-3 py-2 text-right text-sm">
                  <span className="font-medium text-navy">{fmt(l.applied)}</span>
                  {l.applied < l.balanceDue && (
                    <Badge variant="warning" label="Partial" className="ml-2" />
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {excess > 0.001 && (
        <p className="border-t border-surface-border bg-surface-raised px-3 py-2 text-xs text-navy/70">
          The remaining {fmt(excess)} will be left on your account as credit.
        </p>
      )}
    </div>
  );
}

// ─── "I've paid cash" inline form ─────────────────────────────────────────────

function CashForm({
  amount,
  onDone,
  onCancel,
}: {
  amount: number;
  onDone: () => void;
  onCancel: () => void;
}) {
  const declareCash = useDeclareCashPayment();
  const { toast } = useToast();
  const [note, setNote] = React.useState("");
  const [reference, setReference] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    declareCash.mutate(
      { amount, note: note.trim() || undefined, reference: reference.trim() || undefined },
      {
        onSuccess: () => {
          toast({
            title: "Cash payment declared",
            description: "We'll let you know once the seller confirms it.",
            variant: "success",
          });
          onDone();
        },
        onError: (err) => setError(errorMessage(err, "Could not submit — try again.")),
      },
    );
  };

  return (
    <form onSubmit={onSubmit} className="mt-3 space-y-3 border-t border-surface-border pt-3">
      <div>
        <label className="mb-1 block text-xs font-medium text-navy/70">Reference (optional)</label>
        <input
          type="text"
          value={reference}
          onChange={(e) => setReference(e.target.value)}
          placeholder="e.g. receipt or check number"
          maxLength={120}
          className="w-full rounded-lg border border-surface-border px-3 py-2 text-sm text-navy focus:border-buyer-500 focus:outline-none focus:ring-1 focus:ring-buyer-500"
        />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium text-navy/70">Note (optional)</label>
        <textarea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          rows={2}
          maxLength={500}
          placeholder="Anything the seller should know"
          className="w-full rounded-lg border border-surface-border px-3 py-2 text-sm text-navy focus:border-buyer-500 focus:outline-none focus:ring-1 focus:ring-buyer-500"
        />
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex items-center gap-2 pt-1">
        <Button type="submit" size="sm" loading={declareCash.isPending}>
          Confirm I&apos;ve paid {fmt(amount)}
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// ─── Pending request status ───────────────────────────────────────────────────

/** Cancelling a CARD request used to be able to strand a charge: the API
 *  flipped the row straight to CANCELLED, so a webhook that landed afterward
 *  found no PENDING row to claim, read itself as a replay and recorded
 *  nothing — a card that DID charge would never reach an invoice. That hole
 *  is closed server-side (not just hidden here): cancel always tries to
 *  expire the Stripe Checkout session first, and if the session turns out to
 *  already be paid, the cancel is REFUSED and the request stays PENDING for
 *  the webhook to settle normally — only a genuinely-still-open (now
 *  expired) or already-expired session can flip the row to
 *  CANCELLED/EXPIRED. The Cancel button below is still hidden while a
 *  webhook is expected (and always for SETTLING, which means the money is
 *  actively being written) purely so the buyer is never invited to click
 *  something that a moment ago would have been refused anyway. */
function PendingRequestStatus({
  request,
  sellerName,
  awaitingWebhook,
  onStartAgain,
}: {
  request: BuyerPaymentRequestRow;
  sellerName: string;
  /** True for the first minute after Stripe redirected the buyer back. */
  awaitingWebhook: boolean;
  /** EXPIRED rows don't block a new request (server excludes them from the
   *  open-request check) — this just clears the row from view so the amount
   *  form comes back. */
  onStartAgain: () => void;
}) {
  const cancel = useCancelPaymentRequest();
  const { toast } = useToast();
  const [error, setError] = React.useState<string | null>(null);

  const isCard = request.kind === "CARD";
  const isSettling = request.status === "SETTLING";
  const isExpired = request.status === "EXPIRED";
  const label = isExpired
    ? "Your payment link expired"
    : isSettling
      ? "Processing your payment…"
      : isCard
        ? "Card payment in progress"
        : `Waiting for ${sellerName} to confirm your cash payment`;

  const onCancel = () => {
    if (
      isCard &&
      !window.confirm(
        "Only cancel if you did NOT complete the card payment.\n\n" +
          "If you already paid, close this and wait a moment — your balance updates on its own once your bank confirms.",
      )
    ) {
      return;
    }
    setError(null);
    cancel.mutate(request.id, {
      onSuccess: () => toast({ title: "Payment request cancelled", variant: "info" }),
      onError: (err) => setError(errorMessage(err, "Could not cancel — try again.")),
    });
  };

  return (
    <div className="rounded-lg border border-surface-border bg-surface-raised px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          {isSettling ? (
            <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-buyer-500" />
          ) : (
            <Clock className="h-4 w-4 flex-shrink-0 text-warning" />
          )}
          <div>
            <p className="text-sm font-medium text-navy">{label}</p>
            <p className="text-xs text-navy/60">
              {isExpired
                ? "No charge was made — you can try again."
                : `${fmt(request.amount)} · requested ${fmtDate(request.createdAt)}`}
            </p>
          </div>
        </div>
        {isExpired ? (
          <Button size="sm" variant="secondary" onClick={onStartAgain}>
            Start again
          </Button>
        ) : isSettling || (isCard && awaitingWebhook) ? (
          <p className="text-xs text-navy/60">Confirming your payment…</p>
        ) : (
          <Button size="sm" variant="secondary" onClick={onCancel} loading={cancel.isPending}>
            Cancel
          </Button>
        )}
      </div>
      {error && <p className="mt-2 text-xs text-danger">{error}</p>}
    </div>
  );
}

// ─── Panel ────────────────────────────────────────────────────────────────────

export interface MakePaymentPanelProps {
  /** Seeds the amount input (e.g. a specific invoice's balance from WP4's "Pay
   *  this invoice" link). Falls back to the full account balance due. */
  defaultAmount?: number;
}

export function MakePaymentPanel({ defaultAmount }: MakePaymentPanelProps) {
  const { activeSeller } = useBuyerAuth();
  const sellerName = activeSeller?.tenant.name ?? "your seller";
  const searchParams = useSearchParams();
  /** Stripe just sent the buyer back from Checkout — settlement is webhook-only,
   *  so the PENDING card row is expected to clear on its own within seconds. */
  const returnedFromCheckout = searchParams.get("payment") === "processing";

  const qc = useQueryClient();
  const { data: context, isLoading, isError, refetch } = useBuyerPaymentContext();

  const [amount, setAmount] = React.useState<number | null>(defaultAmount ?? null);
  const [touched, setTouched] = React.useState(defaultAmount != null);
  const [cashFormOpen, setCashFormOpen] = React.useState(false);
  const [cardError, setCardError] = React.useState<string | null>(null);
  const [awaitingWebhook, setAwaitingWebhook] = React.useState(returnedFromCheckout);
  /** An EXPIRED request isn't blocking (server excludes it from the
   *  open-request check) — "Start again" just dismisses it locally by id so
   *  the amount form reappears without waiting for it to drop out of the
   *  context query. */
  const [dismissedRequestId, setDismissedRequestId] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!touched && context) setAmount(context.balanceDue);
  }, [context, touched]);

  React.useEffect(() => {
    if (!returnedFromCheckout) return;
    setAwaitingWebhook(true);
    const t = setTimeout(() => setAwaitingWebhook(false), 60_000);
    return () => clearTimeout(t);
  }, [returnedFromCheckout]);

  const preview = useBuyerPaymentPreview(amount ?? 0);

  const startCard = useStartCardPayment();

  const rawPendingRequest = context?.pendingRequests[0] ?? null;
  const pendingRequest =
    rawPendingRequest &&
    rawPendingRequest.status === "EXPIRED" &&
    rawPendingRequest.id === dismissedRequestId
      ? null
      : rawPendingRequest;
  const balanceDue = context?.balanceDue ?? 0;
  const cardEnabled = context?.cardEnabled ?? false;
  const nothingOwed = balanceDue <= 0.001;

  // Poll while the webhook is still expected so the panel clears itself rather
  // than looking stuck — a stuck-looking panel is what tempts a buyer into
  // cancelling a card payment they have already been charged for. The moment the
  // PENDING card row disappears the money is on the invoices, so refresh the rest
  // of the page too (wallet tiles, payment history) — those queries have no
  // polling of their own, and the redirect banner promised the balance updates.
  // Only a PENDING card row is still waiting on a webhook — an EXPIRED one (the
  // notice the API hands back when nothing is open) never settles, so polling on
  // it would just spin for the full minute and never invalidate anything.
  const settlingCard =
    pendingRequest?.status === "SETTLING" ||
    (awaitingWebhook && pendingRequest?.kind === "CARD" && pendingRequest.status === "PENDING");
  React.useEffect(() => {
    if (!settlingCard) return;
    const t = setInterval(() => {
      void refetch().then((r) => {
        // No data = the poll itself failed; nothing has settled, so leave it be.
        if (!r.data || r.data.pendingRequests.some((p) => p.kind === "CARD")) return;
        void qc.invalidateQueries({ queryKey: ["buyer", "statement"] });
        void qc.invalidateQueries({ queryKey: ["buyer", "payments"] });
      });
    }, 5000);
    return () => clearInterval(t);
  }, [settlingCard, refetch, qc]);

  const amountValid = amount != null && amount >= 0.5;
  const cardAmountValid = amountValid && amount != null && amount <= balanceDue + 0.001;

  const onAmountChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    setTouched(true);
    const v = e.target.value;
    setAmount(v === "" ? null : Number(v));
  };

  const onPayByCard = () => {
    if (!cardAmountValid || amount == null) return;
    setCardError(null);
    startCard.mutate(
      { amount },
      {
        onSuccess: (data) => {
          window.location.href = data.url;
        },
        onError: (err) => setCardError(errorMessage(err, "Could not start the card payment.")),
      },
    );
  };

  return (
    <div className="rounded-xl border border-surface-border bg-white p-5 shadow-sm sm:p-6">
      <div className="mb-4 flex items-center gap-2">
        <CreditCard className="h-4 w-4 text-buyer-500" />
        <h2 className="text-sm font-semibold text-navy">Make a payment</h2>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-10">
          <Loader2 className="h-6 w-6 animate-spin text-buyer-500" />
        </div>
      ) : isError || !context ? (
        <div className="flex items-center gap-2 rounded-lg bg-danger-bg px-4 py-3 text-sm text-danger">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          Couldn&apos;t load your balance. Please refresh the page.
        </div>
      ) : (
        <>
          <div className="mb-1">
            <p className="text-xs font-semibold uppercase tracking-wider text-navy/70">
              Balance due
            </p>
            <p className="mt-1 text-3xl font-bold text-navy">{fmt(balanceDue)}</p>
            {nothingOwed && !pendingRequest && (
              <p className="mt-1 flex items-center gap-1.5 text-xs text-success">
                <CheckCircle2 className="h-3.5 w-3.5 flex-shrink-0" />
                You&apos;re all paid up — enter an amount only to pay ahead.
              </p>
            )}
          </div>
          <p className="mb-4 text-xs text-navy/60">
            Payments are applied to your oldest invoices first.
          </p>

          {pendingRequest ? (
            <PendingRequestStatus
              request={pendingRequest}
              sellerName={sellerName}
              awaitingWebhook={awaitingWebhook}
              onStartAgain={() => setDismissedRequestId(pendingRequest.id)}
            />
          ) : (
            <>
              <div className="mb-3">
                <label className="mb-1 block text-xs font-medium text-navy/70">Amount</label>
                <div className="relative">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-navy/60">
                    $
                  </span>
                  <input
                    type="number"
                    inputMode="decimal"
                    step="0.01"
                    min="0"
                    value={amount ?? ""}
                    onChange={onAmountChange}
                    className="w-full rounded-lg border border-surface-border py-2 pl-7 pr-3 text-sm font-medium text-navy focus:border-buyer-500 focus:outline-none focus:ring-1 focus:ring-buyer-500"
                  />
                </div>
                {touched && amount != null && amount > 0 && !amountValid && (
                  <p className="mt-1 text-xs text-danger">Enter at least $0.50.</p>
                )}
                {amountValid && amount != null && amount > balanceDue + 0.001 && (
                  <p className="mt-1 text-xs text-navy/60">
                    Card payments can&apos;t exceed your balance due. Pay by cash to leave the extra
                    as credit on your account.
                  </p>
                )}
              </div>

              <div className="mb-4">
                {/* The preview query is disabled below $0.50 but still resolves the
                    previous amount's data via `placeholderData`, so drop it here —
                    a table for an amount that isn't being paid contradicts the input. */}
                <AllocationPreview
                  lines={amountValid ? (preview.data?.lines ?? []) : []}
                  excess={amountValid ? (preview.data?.excess ?? 0) : 0}
                  isFetching={preview.isFetching}
                />
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {cardEnabled ? (
                  <Button
                    onClick={onPayByCard}
                    disabled={!cardAmountValid}
                    loading={startCard.isPending}
                    leftIcon={<CreditCard className="h-4 w-4" />}
                  >
                    Pay by card
                  </Button>
                ) : (
                  <p className="text-xs text-navy/60">
                    This seller doesn&apos;t accept card payments yet.
                  </p>
                )}
                {!cashFormOpen && (
                  <Button
                    variant="secondary"
                    disabled={!amountValid}
                    onClick={() => setCashFormOpen(true)}
                    leftIcon={<Banknote className="h-4 w-4" />}
                  >
                    I&apos;ve paid cash
                  </Button>
                )}
              </div>
              {cardError && <p className="mt-2 text-xs text-danger">{cardError}</p>}

              {cashFormOpen && amount != null && (
                <CashForm
                  amount={amount}
                  onDone={() => setCashFormOpen(false)}
                  onCancel={() => setCashFormOpen(false)}
                />
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}

export default MakePaymentPanel;
