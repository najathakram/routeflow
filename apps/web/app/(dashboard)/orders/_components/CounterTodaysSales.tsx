"use client";

// POS-7b-2: the counter's "Today's sales" sheet. Own file so CounterSaleScreen takes one mount line.
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { cashierNameOf, roundMoney } from "@routeflow/pricing";
import { Button, Modal, cn } from "@routeflow/ui/web";
import { apiClient } from "@/lib/api-client";
import { useOrder } from "@/lib/api/orders";
import type { TodaysSaleRow, TodaysSalesSummary } from "@routeflow/types";
import {
  COUNTER_SALE_TODAY_KEY,
  useCounterSaleToday,
  useCounterSaleWeek,
} from "@/lib/api/counter-sale-today";
import { lastDays, sumWeek, weekCsv } from "@/lib/counter-week";
import { itemNamesLine } from "@/lib/counter-item-names";
import { useTenant } from "@/components/tenant-provider";
import { useOptionalAuth } from "@/lib/auth-context";
import { guardCounterLeave } from "@/lib/counter-cart-signal";
import {
  formatReceiptMoney as money,
  formatSaleDayTime,
  receiptCustomerName,
  receiptModelFromOrder,
  type ReceiptBusinessProfile,
} from "@/lib/counter-receipt";
import { CounterDayClose } from "./CounterDayClose";
import { HandOverRows, METHOD_LABEL, handOverFigure } from "./HandOverRows";
import { receiptEmailPrefill } from "@/lib/email-receipt";
import { CounterReceiptView } from "./CounterReceiptView";
import { CounterReturnAction } from "./CounterReturnAction";
import { EmailReceiptButton, EmailReceiptRow } from "./EmailReceipt";
import { useEmailReceipt } from "./useEmailReceipt";
import {
  CounterVoidSaleAction,
  CounterVoidSaleDialog,
  TodaysSalesReadOnlyLine,
} from "./CounterVoidSaleDialog";

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

function Stat({
  label,
  value,
  testId,
  note,
}: {
  label: string;
  value: string;
  testId?: string;
  /** a hand-overs line: says the figure is already inside Money in and the cash expected */
  note?: boolean;
}) {
  return (
    <div className="flex flex-wrap justify-between gap-x-2" data-testid={testId}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
      {note ? (
        <dd className="basis-full text-xs text-navy/60">
          These are already counted in money in and cash expected.
        </dd>
      ) : null}
    </div>
  );
}

const SHOW_ALL_KEY = "rf:counter:summary:showAll";
const readShowAll = (): boolean => {
  try {
    return window.localStorage.getItem(SHOW_ALL_KEY) === "1";
  } catch {
    return false;
  }
};
const writeShowAll = (on: boolean) => {
  try {
    window.localStorage.setItem(SHOW_ALL_KEY, on ? "1" : "0");
  } catch {
    /* storage unavailable: the choice just is not remembered */
  }
};

/** One summary figure. `amount` is the number the zero test reads; `always` rows show even at $0.00. */
interface SummaryRow {
  key: string;
  label: string;
  amount: number;
  value: string;
  testId: string;
  always?: boolean;
  /** a row that is not an amount (hand-overs): shown while it has any count, even at $0.00 */
  keep?: boolean;
  note?: boolean;
}

/**
 * Server numbers only: nothing here adds, subtracts or derives a figure. With `collapsible` (the Today view) it leads with
 * the header, the three anchor rows (Money in, On account, Cash expected: even at $0.00) and every other row that is non-zero
 * to the cent; a "Show all figures" disclosure reveals only the $0.00 rows. The week view lists every row, unchanged.
 */
function Summary({
  s,
  label = "Today's summary",
  testId = "today-summary",
  prefix = "today",
  cashExpectedSuffix = "",
  handOverNote = true,
  collapsible = false,
}: {
  s: TodaysSalesSummary;
  /** the region's accessible name */
  label?: string;
  testId?: string;
  /** test-id prefix of the stats (`${prefix}-in-cash`) */
  prefix?: string;
  /** appended to the cash-expected label (the week total says it is a sum of the days) */
  cashExpectedSuffix?: string;
  /** the "already counted" note under the hand-overs line (the per-day week blocks leave it to the total) */
  handOverNote?: boolean;
  /** the Today view: every non-zero row + the anchors; a remembered "Show all figures" reveals the $0.00 rows */
  collapsible?: boolean;
}) {
  const [showAll, setShowAll] = React.useState(false);
  React.useEffect(() => setShowAll(readShowAll()), []);
  const r = s.refunds;
  // SA-740r2: a window can hold refunds with a recorded method AND refunds without one (the tender is optional on STANDARD
  // refunds until the mobile minimum moves): then the breakdown shows and the labels say which figure lacks a method. A
  // comparison only; no figure is derived here.
  const someTenderRecorded = !r.tenderKnown && (r.cash > 0 || r.card > 0 || r.check > 0);
  const ho = s.handOvers ?? { count: 0, total: 0 };
  const row = (
    key: string,
    label: string,
    amount: number,
    extra: Partial<SummaryRow> = {},
  ): SummaryRow => ({
    key,
    label,
    amount,
    value: money(amount),
    testId: `${prefix}-${key}`,
    ...extra,
  });
  const rows: SummaryRow[] = [
    row("in-cash", "Cash in", s.moneyIn.cash),
    row("in-card", "Card in", s.moneyIn.card),
    row("in-check", "Check in", s.moneyIn.check),
    row("in-other", "Other in", s.moneyIn.other),
    row("in-total", "Money in", s.moneyIn.total, { always: true }),
    row("hand-overs", "Pickup hand-overs", ho.total, {
      value: handOverFigure(ho),
      keep: ho.count > 0,
      note: handOverNote && ho.count > 0,
    }),
    row("store-credit-used", "Store credit used", s.storeCreditUsed),
    row("on-account", "On account", s.onAccount, { always: true }),
    row(
      "refunds",
      r.tenderKnown
        ? "Refunds"
        : someTenderRecorded
          ? "Refunds (some without a recorded method)"
          : "Refunds (method not recorded)",
      r.total,
    ),
    ...(r.tenderKnown || someTenderRecorded
      ? [
          row("refunds-cash", "Cash refunds", r.cash),
          row("refunds-card", "Card refunds", r.card),
          row("refunds-check", "Check refunds", r.check),
          row("refunds-other", "Other refunds", r.other),
        ]
      : []),
    row("store-credit-issued", "Store credit issued", s.storeCreditIssued.amount),
    row("net-collected", "Net collected", s.netCollected),
    row(
      "cash-expected",
      `${
        r.tenderKnown
          ? "Cash expected in drawer"
          : someTenderRecorded
            ? "Cash expected, before refunds with no method recorded"
            : "Cash expected, before refunds"
      }${cashExpectedSuffix}`,
      s.cashExpectedInDrawer,
      { always: true },
    ),
  ];
  // The week view lists every row as before. The Today view always shows the anchor rows and every row that is non-zero to
  // the cent (a refund or a card takings never hides); "Show all figures" reveals only the $0.00 rows.
  const isZero = (x: SummaryRow) => !x.always && !x.keep && roundMoney(x.amount) === 0;
  const zeros = collapsible ? rows.filter(isZero) : [];
  const shown = collapsible ? rows.filter((x) => !isZero(x) || showAll) : rows;
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
        {shown.map((x) => (
          <Stat key={x.key} label={x.label} value={x.value} testId={x.testId} note={x.note} />
        ))}
      </dl>
      {collapsible && zeros.length > 0 ? (
        <button
          type="button"
          className="mt-2 min-h-11 text-sm font-medium text-navy underline"
          aria-expanded={showAll}
          onClick={() => {
            writeShowAll(!showAll);
            setShowAll(!showAll);
          }}
        >
          {showAll ? "Show fewer figures" : "Show all figures"}
        </button>
      ) : null}
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
            // B1262 / SA-838: the server's tender split (absent on an older server) and the return it settled
            tenderPaid: row.tenderPaid,
            tenderMethods: row.tenderMethods,
            ownReturned: row.ownReturned,
            cashTendered: row.cashTendered,
            change: row.change,
            customerName: receiptCustomerName({
              businessName: row.customerName,
              isWalkIn: row.isWalkIn,
            }),
            taxRatePercent: row.taxRatePercent,
            charges: row.charges,
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
          reprintLabel={`Reprint · Sold ${formatSaleDayTime(row.createdAt, timezone)}`}
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
            handOverNote={false}
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
  const itemNames = itemNamesLine(row.items, row.itemCount);
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
      {itemNames ? (
        <p data-testid="today-row-items" className="truncate text-xs text-navy/70">
          {itemNames}
        </p>
      ) : null}
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
  const [voidRow, setVoidRow] = React.useState<TodaysSaleRow | null>(null);
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
        {/* CQ-21: the list and week sheets print with real page margins (the receipt view sets its own 80 mm page) */}
        {reprint ? null : <style>{`@media print { @page { margin: 10mm; } }`}</style>}
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
            {view === "week" ? null : summary ? <Summary s={summary} collapsible /> : null}
            {view === "week" || !summary ? null : (
              <HandOverRows
                rows={q.data?.pages[0]?.handOverRows}
                summary={summary.handOvers ?? { count: 0, total: 0 }}
                timeOf={(iso) => timeOf(iso, timezone)}
              />
            )}
            {view === "week" ? null : <TodaysSalesReadOnlyLine />}
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
                    onVoid={() => setVoidRow(r)}
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
          total={voidRow.total}
          methodsText={voidRow.methods.map((m) => METHOD_LABEL[m.method]).join(" + ")}
          items={voidRow.items}
          itemCount={voidRow.itemCount}
          onClose={() => setVoidRow(null)}
          onVoided={refetchList}
        />
      ) : null}
    </>
  );
}
