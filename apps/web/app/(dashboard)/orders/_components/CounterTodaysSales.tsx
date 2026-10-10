"use client";

// POS-7b-2: the counter's "Today's sales" sheet. Own file so CounterSaleScreen takes one mount line.
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Modal, cn } from "@routeflow/ui/web";
import { apiClient } from "@/lib/api-client";
import { useOrder } from "@/lib/api/orders";
import type { TodaysSaleMethod, TodaysSaleRow, TodaysSalesSummary } from "@routeflow/types";
import { COUNTER_SALE_TODAY_KEY, useCounterSaleToday } from "@/lib/api/counter-sale-today";
import { useTenant } from "@/components/tenant-provider";
import { useOptionalAuth } from "@/lib/auth-context";
import { guardCounterLeave } from "@/lib/counter-cart-signal";
import {
  formatReceiptMoney as money,
  formatSaleTime,
  receiptModelFromOrder,
  type ReceiptBusinessProfile,
} from "@/lib/counter-receipt";
import { receiptEmailPrefill } from "@/lib/email-receipt";
import { CounterReceiptView } from "./CounterReceiptView";
import { CounterReturnAction } from "./CounterReturnAction";
import { EmailReceiptButton, EmailReceiptRow } from "./EmailReceipt";
import { useEmailReceipt } from "./useEmailReceipt";

const METHOD_LABEL: Record<TodaysSaleMethod, string> = {
  CASH: "Cash",
  CARD: "Card",
  CHECK: "Check",
  OTHER: "Other",
  STORE_CREDIT: "Store credit",
};
const PAYMENT_LABEL: Record<TodaysSaleRow["paymentState"], string> = {
  PAID: "Paid",
  PARTLY_PAID: "Partly paid",
  ON_ACCOUNT: "On account",
  UNPAID: "Unpaid",
};
const RETURN_LABEL: Record<TodaysSaleRow["returned"]["state"], string | null> = {
  NONE: null,
  PARTLY: "Partly returned",
  FULL: "Returned",
  PENDING: "Return pending",
};
const TAP = "min-h-11 inline-flex items-center justify-center rounded border px-3 text-sm";
const BADGE = "rounded bg-navy/10 px-2 py-0.5 text-xs font-semibold";
const timeOf = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit", timeZone }).format(
    new Date(iso),
  );

function Stat({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="flex justify-between gap-2" data-testid={testId}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

/** Server numbers only: nothing here adds, subtracts or derives a figure. */
function Summary({ s }: { s: TodaysSalesSummary }) {
  const r = s.refunds;
  return (
    <section
      aria-label="Today's summary"
      className="rounded border bg-navy/5 p-3 text-sm"
      data-testid="today-summary"
    >
      <p className="flex justify-between font-semibold">
        <span>{s.sales.count === 1 ? "1 sale" : `${s.sales.count} sales`}</span>
        <span className="tabular-nums">{money(s.sales.total)}</span>
      </p>
      <dl className="mt-2 space-y-1">
        <Stat label="Cash in" value={money(s.moneyIn.cash)} testId="today-in-cash" />
        <Stat label="Card in" value={money(s.moneyIn.card)} testId="today-in-card" />
        <Stat label="Check in" value={money(s.moneyIn.check)} testId="today-in-check" />
        <Stat label="Other in" value={money(s.moneyIn.other)} testId="today-in-other" />
        <Stat label="Money in" value={money(s.moneyIn.total)} testId="today-in-total" />
        <Stat
          label="Store credit used"
          value={money(s.storeCreditUsed)}
          testId="today-store-credit-used"
        />
        <Stat label="On account" value={money(s.onAccount)} testId="today-on-account" />
        <Stat
          label={r.tenderKnown ? "Refunds" : "Refunds (method not recorded)"}
          value={money(r.total)}
          testId="today-refunds"
        />
        {r.tenderKnown ? (
          <>
            <Stat label="Cash refunds" value={money(r.cash)} testId="today-refunds-cash" />
            <Stat label="Card refunds" value={money(r.card)} testId="today-refunds-card" />
            <Stat label="Check refunds" value={money(r.check)} testId="today-refunds-check" />
            <Stat label="Other refunds" value={money(r.other)} testId="today-refunds-other" />
          </>
        ) : null}
        <Stat
          label="Store credit issued"
          value={money(s.storeCreditIssued.amount)}
          testId="today-store-credit-issued"
        />
        <Stat label="Net collected" value={money(s.netCollected)} testId="today-net-collected" />
        <Stat
          label={r.tenderKnown ? "Cash expected in drawer" : "Cash expected, before refunds"}
          value={money(s.cashExpectedInDrawer)}
          testId="today-cash-expected"
        />
      </dl>
    </section>
  );
}

function Reprint({
  row,
  timezone,
  onBack,
}: {
  row: TodaysSaleRow;
  timezone: string;
  onBack: () => void;
}) {
  const { branding } = useTenant();
  // While this view is open the page prints ONLY the receipt: app/shell.css hides the counter screen
  // (`[data-counter-screen]`) under `@media print` for as long as this body class is set.
  React.useEffect(() => {
    document.body.classList.add("counter-reprint-open");
    return () => document.body.classList.remove("counter-reprint-open");
  }, []);
  const reprintedBy = useOptionalAuth()?.user?.username ?? null;
  const { data: order, isError, isLoading, refetch } = useOrder(row.orderId);
  const { data: settings } = useQuery<ReceiptBusinessProfile>({
    queryKey: ["settings"],
    queryFn: () => apiClient.get("/settings").then((r) => r.data),
  });
  // SA-751r: Email receipt beside Print. A walk-in opens empty; a named customer's address is the suggestion, never an auto-send.
  const email = useEmailReceipt({
    orderId: row.orderId,
    prefill: row.isWalkIn ? "" : receiptEmailPrefill(order?.customer),
  });
  const model =
    order && row.invoiceId && row.invoiceNumber
      ? receiptModelFromOrder({
          order,
          profile: { ...settings, businessName: branding?.businessName || settings?.businessName },
          sale: {
            invoiceId: row.invoiceId,
            invoiceNumber: row.invoiceNumber,
            paid: row.paid,
            balanceDue: row.balanceDue,
            methods: row.methods,
            createdAt: row.createdAt,
            timezone,
          },
        })
      : null;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 print:hidden">
        <Button className="min-h-11" onClick={() => window.print()} disabled={!model}>
          Print
        </Button>
        <EmailReceiptButton email={email} disabled={!model} />
        <Button className="min-h-11" variant="secondary" onClick={onBack}>
          Back to sales
        </Button>
      </div>
      <EmailReceiptRow email={email} />
      {model ? (
        <CounterReceiptView
          model={model}
          logoUrl={branding?.logoUrl ?? null}
          reprintedBy={reprintedBy}
          reprintLabel={`Reprint · sold ${formatSaleTime(row.createdAt, timezone)}`}
        />
      ) : isError ? (
        <div role="alert" className="space-y-2 text-sm">
          <p>Could not load this receipt.</p>
          <Button className="min-h-11" variant="secondary" onClick={() => void refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        <p role="status" className="text-sm text-navy/70">
          Loading receipt
        </p>
      )}
    </div>
  );
}

function SaleRow({
  focusReprint,
  onFocused,
  row,
  timezone,
  onReprint,
  onDone,
}: {
  focusReprint: boolean;
  onFocused: () => void;
  row: TodaysSaleRow;
  timezone: string;
  onReprint: () => void;
  onDone: () => void;
}) {
  const reprintRef = React.useRef<HTMLButtonElement>(null);
  React.useEffect(() => {
    if (focusReprint) {
      reprintRef.current?.focus();
      onFocused();
    }
  }, [focusReprint, onFocused]);
  const who = row.isWalkIn ? "Walk-in" : (row.customerName ?? "Customer");
  const methods = row.methods.map((m) => METHOD_LABEL[m.method]).join(" + ");
  const returnLabel = row.voided ? null : RETURN_LABEL[row.returned.state];
  const router = useRouter();
  return (
    <li className="space-y-2 py-3" data-testid={`today-row-${row.orderId}`}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className={cn("font-medium", row.voided && "text-navy/50 line-through")}>
          {row.orderNumber}
        </span>
        <span className={cn("tabular-nums", row.voided && "text-navy/50 line-through")}>
          {money(row.total)}
        </span>
      </div>
      <p className="text-xs text-navy/70">
        {timeOf(row.createdAt, timezone)} · {who}
        {methods ? ` · ${methods}` : ""}
      </p>
      <div className="flex flex-wrap gap-1">
        {row.voided ? (
          <span className={cn(BADGE, "bg-red-100 text-red-700")}>Voided</span>
        ) : (
          <span className={BADGE}>{PAYMENT_LABEL[row.paymentState]}</span>
        )}
        {returnLabel ? <span className={BADGE}>{returnLabel}</span> : null}
      </div>
      <div className="flex flex-wrap gap-2">
        {row.voided ? null : (
          <>
            {row.invoiceId && row.invoiceNumber ? (
              <button ref={reprintRef} type="button" className={TAP} onClick={onReprint}>
                Reprint
              </button>
            ) : null}
            <CounterReturnAction
              orderId={row.orderId}
              onDone={onDone}
              canReturn={row.returned.state !== "FULL"}
            />
          </>
        )}
        <Link
          href={`/orders/${row.orderId}`}
          className={cn(TAP, "text-brand-700")}
          onClick={(e) => {
            // a cart with lines asks "Discard this sale?" first; Discard runs the raw push (no second ask)
            if (guardCounterLeave(() => router.push(`/orders/${row.orderId}`))) e.preventDefault();
          }}
        >
          View order
        </Link>
      </div>
    </li>
  );
}

export function CounterTodaysSales() {
  const [open, setOpen] = React.useState(false);
  const [reprint, setReprint] = React.useState<TodaysSaleRow | null>(null);
  // the row whose Reprint button gets focus back after "Back to sales"
  const [refocusId, setRefocusId] = React.useState<string | null>(null);
  const clearRefocus = React.useCallback(() => setRefocusId(null), []);
  const openerRef = React.useRef<HTMLButtonElement>(null);
  const qc = useQueryClient();
  const q = useCounterSaleToday(open);
  const refetchList = React.useCallback(
    () => void qc.invalidateQueries({ queryKey: COUNTER_SALE_TODAY_KEY }),
    [qc],
  );
  const rows = q.data?.pages.flatMap((p) => p.data) ?? [];
  const summary = q.data?.pages[0]?.summary;
  const timezone = q.data?.pages[0]?.meta.timezone ?? "UTC";

  return (
    <>
      <Button
        ref={openerRef}
        className="min-h-[44px]"
        variant="secondary"
        onClick={() => setOpen(true)}
      >
        Today&apos;s sales
      </Button>
      <Modal
        open={open}
        onClose={() => {
          setOpen(false);
          setReprint(null);
        }}
        onEscapeKeyDown={(e) => {
          // Escape closes only the top layer: the reprint view goes back to the list first
          if (!reprint) return;
          e.preventDefault();
          // ...and an open Email receipt row is above the reprint view: Escape closes that row (its own handler) and nothing else
          if ((e.target as Element | null)?.closest?.("[data-email-receipt-row]")) return;
          setRefocusId(reprint.orderId);
          setReprint(null);
        }}
        onCloseAutoFocus={(e) => {
          if (!openerRef.current) return;
          e.preventDefault();
          openerRef.current.focus();
        }}
        closeClassName="min-h-11 min-w-11 flex items-center justify-center"
        title={reprint ? "Reprint receipt" : "Today's sales"}
        scroll
        className={cn(
          "max-w-2xl print:static print:max-h-none print:max-w-none print:translate-x-0 print:translate-y-0 print:overflow-visible print:p-0 print:shadow-none",
          // the modal's title row is not part of the receipt
          reprint && "print:[&>div:first-child]:hidden",
        )}
      >
        {reprint ? (
          <Reprint
            row={reprint}
            timezone={timezone}
            onBack={() => {
              setRefocusId(reprint.orderId);
              setReprint(null);
            }}
          />
        ) : q.isError ? (
          <div role="alert" className="space-y-2 text-sm">
            <p>Could not load today&apos;s sales.</p>
            <Button className="min-h-11" variant="secondary" onClick={() => void q.refetch()}>
              Retry
            </Button>
          </div>
        ) : q.isLoading || !q.data ? (
          <p role="status" className="text-sm text-navy/70">
            Loading today&apos;s sales
          </p>
        ) : (
          <div className="space-y-3">
            {summary ? <Summary s={summary} /> : null}
            {rows.length === 0 ? (
              <p className="py-6 text-center text-sm text-navy/70">No sales yet today</p>
            ) : (
              <ul className="divide-y" aria-label="Today's sales">
                {rows.map((r) => (
                  <SaleRow
                    key={r.orderId}
                    row={r}
                    timezone={timezone}
                    focusReprint={refocusId === r.orderId}
                    onFocused={clearRefocus}
                    onReprint={() => setReprint(r)}
                    onDone={refetchList}
                  />
                ))}
              </ul>
            )}
            {q.hasNextPage ? (
              <Button
                className="min-h-11 w-full"
                variant="secondary"
                disabled={q.isFetchingNextPage}
                onClick={() => void q.fetchNextPage()}
              >
                Show more
              </Button>
            ) : null}
          </div>
        )}
      </Modal>
    </>
  );
}
