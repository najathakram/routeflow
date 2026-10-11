"use client";

// POS-7b-2: the counter's "Today's sales" sheet. Own file so CounterSaleScreen takes one mount line.
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cashierNameOf } from "@routeflow/pricing";
import { Button, Modal, cn } from "@routeflow/ui/web";
import { apiClient } from "@/lib/api-client";
import { useOrder } from "@/lib/api/orders";
import type { TodaysSaleMethod, TodaysSaleRow, TodaysSalesSummary } from "@routeflow/types";
import {
  COUNTER_SALE_TODAY_KEY,
  useCounterSaleToday,
  useCounterSaleWeek,
} from "@/lib/api/counter-sale-today";
import { lastDays, sumWeek, weekCsv } from "@/lib/counter-week";
import { useTenant } from "@/components/tenant-provider";
import { useOptionalAuth } from "@/lib/auth-context";
import { guardCounterLeave } from "@/lib/counter-cart-signal";
import {
  formatReceiptMoney as money,
  formatSaleTime,
  receiptCustomerName,
  receiptModelFromOrder,
  type ReceiptBusinessProfile,
} from "@/lib/counter-receipt";
import { CounterDayClose } from "./CounterDayClose";
import { receiptEmailPrefill } from "@/lib/email-receipt";
import { CounterReceiptView } from "./CounterReceiptView";
import { CounterReturnAction } from "./CounterReturnAction";
import { EmailReceiptButton, EmailReceiptRow } from "./EmailReceipt";
import { useEmailReceipt } from "./useEmailReceipt";
import { CounterVoidSaleAction, CounterVoidSaleDialog } from "./CounterVoidSaleDialog";

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
function Summary({
  s,
  label = "Today's summary",
  testId = "today-summary",
  prefix = "today",
  cashExpectedSuffix = "",
}: {
  s: TodaysSalesSummary;
  /** the region's accessible name */
  label?: string;
  testId?: string;
  /** test-id prefix of the stats (`${prefix}-in-cash`) */
  prefix?: string;
  /** appended to the cash-expected label (the week total says it is a sum of the days) */
  cashExpectedSuffix?: string;
}) {
  const r = s.refunds;
  // SA-740r2: a window can hold refunds with a recorded method AND refunds without one (the tender is optional on STANDARD
  // refunds until the mobile minimum moves): then the breakdown shows and the labels say which figure lacks a method. A
  // comparison only; no figure is derived here.
  const someTenderRecorded = !r.tenderKnown && (r.cash > 0 || r.card > 0 || r.check > 0);
  return (
    <section
      aria-label={label}
      className="rounded border bg-navy/5 p-3 text-sm"
      data-testid={testId}
    >
      <p className="flex justify-between font-semibold">
        <span>{s.sales.count === 1 ? "1 sale" : `${s.sales.count} sales`}</span>
        <span className="tabular-nums">{money(s.sales.total)}</span>
      </p>
      <dl className="mt-2 space-y-1">
        <Stat label="Cash in" value={money(s.moneyIn.cash)} testId={`${prefix}-in-cash`} />
        <Stat label="Card in" value={money(s.moneyIn.card)} testId={`${prefix}-in-card`} />
        <Stat label="Check in" value={money(s.moneyIn.check)} testId={`${prefix}-in-check`} />
        <Stat label="Other in" value={money(s.moneyIn.other)} testId={`${prefix}-in-other`} />
        <Stat label="Money in" value={money(s.moneyIn.total)} testId={`${prefix}-in-total`} />
        <Stat
          label="Store credit used"
          value={money(s.storeCreditUsed)}
          testId={`${prefix}-store-credit-used`}
        />
        <Stat label="On account" value={money(s.onAccount)} testId={`${prefix}-on-account`} />
        <Stat
          label={
            r.tenderKnown
              ? "Refunds"
              : someTenderRecorded
                ? "Refunds (some without a recorded method)"
                : "Refunds (method not recorded)"
          }
          value={money(r.total)}
          testId={`${prefix}-refunds`}
        />
        {r.tenderKnown || someTenderRecorded ? (
          <>
            <Stat label="Cash refunds" value={money(r.cash)} testId={`${prefix}-refunds-cash`} />
            <Stat label="Card refunds" value={money(r.card)} testId={`${prefix}-refunds-card`} />
            <Stat label="Check refunds" value={money(r.check)} testId={`${prefix}-refunds-check`} />
            <Stat label="Other refunds" value={money(r.other)} testId={`${prefix}-refunds-other`} />
          </>
        ) : null}
        <Stat
          label="Store credit issued"
          value={money(s.storeCreditIssued.amount)}
          testId={`${prefix}-store-credit-issued`}
        />
        <Stat
          label="Net collected"
          value={money(s.netCollected)}
          testId={`${prefix}-net-collected`}
        />
        <Stat
          label={`${
            r.tenderKnown
              ? "Cash expected in drawer"
              : someTenderRecorded
                ? "Cash expected, before refunds with no method recorded"
                : "Cash expected, before refunds"
          }${cashExpectedSuffix}`}
          value={money(s.cashExpectedInDrawer)}
          testId={`${prefix}-cash-expected`}
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
  const reprintedBy = cashierNameOf(useOptionalAuth()?.user);
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
          cashier: row.cashierName,
          profile: { ...settings, businessName: branding?.businessName || settings?.businessName },
          sale: {
            invoiceId: row.invoiceId,
            invoiceNumber: row.invoiceNumber,
            paid: row.paid,
            balanceDue: row.balanceDue,
            methods: row.methods,
            createdAt: row.createdAt,
            cashTendered: row.cashTendered,
            change: row.change,
            customerName: receiptCustomerName({
              businessName: row.customerName,
              isWalkIn: row.isWalkIn,
            }),
            taxRatePercent: row.taxRatePercent,
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

const dayLabel = (day: string) =>
  new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${day}T00:00:00Z`));

/**
 * "Last 7 days": the tenant's last seven calendar days, one server summary per day (the same endpoint with `?day=`), a week
 * total (the sum of those daily figures, in cents) and the same labelled block for each day. Print and CSV. While it is
 * open the page prints ONLY this report (the counter screen is hidden for the print, like a reprint).
 */
function WeekReport({ today }: { today: string }) {
  React.useEffect(() => {
    document.body.classList.add("counter-reprint-open");
    return () => document.body.classList.remove("counter-reprint-open");
  }, []);
  const days = React.useMemo(() => lastDays(today), [today]);
  const results = useCounterSaleWeek(days);
  const failed = results.some((r) => r.isError);
  const summaries = results.map((r) => r.data?.summary ?? null);
  const ready = summaries.every((x) => x !== null);
  if (failed) {
    return (
      <div role="alert" className="space-y-2 text-sm">
        <p>Could not load the last 7 days.</p>
        <Button
          className="min-h-11"
          variant="secondary"
          onClick={() => results.forEach((r) => r.isError && void r.refetch())}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (!ready) {
    return (
      <p role="status" className="text-sm text-navy/70">
        Loading the last 7 days
      </p>
    );
  }
  const rows = days.map((day, i) => ({ day, summary: summaries[i] as TodaysSalesSummary }));
  const total = sumWeek(rows.map((r) => r.summary));
  const oldest = days[days.length - 1];
  const download = () => {
    const url = URL.createObjectURL(new Blob([weekCsv(rows)], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `counter-sales-${oldest}-to-${days[0]}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 print:hidden">
        <Button className="min-h-11" onClick={() => window.print()}>
          Print
        </Button>
        <Button className="min-h-11" variant="secondary" onClick={download}>
          Download CSV
        </Button>
      </div>
      <p className="text-xs text-navy/70">
        {dayLabel(oldest as string)} to {dayLabel(days[0] as string)}
      </p>
      <Summary
        s={total}
        label="Last 7 days total"
        testId="week-total"
        prefix="week-total"
        cashExpectedSuffix=" (sum of days)"
      />
      {rows.map((r) => (
        <div key={r.day} className="space-y-1 break-inside-avoid">
          <h3 className="text-sm font-semibold">{dayLabel(r.day)}</h3>
          <Summary
            s={r.summary}
            label={`${dayLabel(r.day)} summary`}
            testId={`week-day-${r.day}`}
            prefix={`week-day-${r.day}`}
          />
        </div>
      ))}
    </div>
  );
}

function SaleRow({
  focusReprint,
  onFocused,
  row,
  timezone,
  onReprint,
  onVoid,
  onDone,
}: {
  focusReprint: boolean;
  onFocused: () => void;
  row: TodaysSaleRow;
  timezone: string;
  onReprint: () => void;
  onVoid: () => void;
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
        {row.cashierName ? (
          <span data-testid="today-row-cashier"> · Cashier: {row.cashierName}</span>
        ) : null}
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
            {row.returned.state === "NONE" ? (
              <CounterVoidSaleAction orderNumber={row.orderNumber} onOpen={onVoid} />
            ) : null}
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
  // SA-762r: the sale being voided. The dialog sits here (not on the row) so it outlives the row turning Voided.
  const [voidRow, setVoidRow] = React.useState<{ orderId: string; orderNumber: string } | null>(
    null,
  );
  // "today" = the live list; "week" = the last-7-days report
  const [view, setView] = React.useState<"today" | "week">("today");
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
  const tenantDay = q.data?.pages[0]?.meta.day;

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
          setView("today");
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
        title={reprint ? "Reprint receipt" : view === "week" ? "Last 7 days" : "Today's sales"}
        scroll
        className={cn(
          "max-w-2xl print:static print:max-h-none print:max-w-none print:translate-x-0 print:translate-y-0 print:overflow-visible print:p-0 print:shadow-none",
          // the modal's title row is not part of the receipt
          (reprint || view === "week") && "print:[&>div:first-child]:hidden",
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
            <div className="flex gap-2 print:hidden" role="group" aria-label="Range">
              <Button
                className="min-h-11"
                variant={view === "today" ? "primary" : "secondary"}
                aria-pressed={view === "today"}
                onClick={() => setView("today")}
              >
                Today
              </Button>
              <Button
                className="min-h-11"
                variant={view === "week" ? "primary" : "secondary"}
                aria-pressed={view === "week"}
                disabled={!tenantDay}
                onClick={() => setView("week")}
              >
                Last 7 days
              </Button>
            </div>
            {view === "week" ? null : <CounterDayClose />}
            {view === "week" && tenantDay ? <WeekReport today={tenantDay} /> : null}
            {view === "week" ? null : summary ? <Summary s={summary} /> : null}
            {view === "week" ? null : rows.length === 0 ? (
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
                    onVoid={() => setVoidRow({ orderId: r.orderId, orderNumber: r.orderNumber })}
                    onDone={refetchList}
                  />
                ))}
              </ul>
            )}
            {view === "today" && q.hasNextPage ? (
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
      {voidRow ? (
        <CounterVoidSaleDialog
          open
          orderId={voidRow.orderId}
          orderNumber={voidRow.orderNumber}
          onClose={() => setVoidRow(null)}
          onVoided={refetchList}
        />
      ) : null}
    </>
  );
}
