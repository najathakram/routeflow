"use client";

// POS-7b-2: the counter's "Today's sales" sheet. Own file so CounterSaleScreen takes one mount line.
import * as React from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, Modal, cn } from "@routeflow/ui/web";
import type { CounterSalePaymentMethod } from "@routeflow/types";
import { apiClient } from "@/lib/api-client";
import { useOrder } from "@/lib/api/orders";
import {
  COUNTER_SALE_TODAY_KEY,
  useCounterSaleToday,
  type CounterSaleTodayRow,
  type CounterSaleTodaySummary,
} from "@/lib/api/counter-sale-today";
import { useTenant } from "@/components/tenant-provider";
import { useOptionalAuth } from "@/lib/auth-context";
import {
  formatReceiptMoney as money,
  receiptModelFromOrder,
  type ReceiptBusinessProfile,
} from "@/lib/counter-receipt";
import { CounterReceiptView } from "./CounterReceiptView";
import { CounterReturnAction } from "./CounterReturnAction";

const METHOD_LABEL: Record<CounterSalePaymentMethod, string> = {
  CASH: "Cash",
  CARD: "Card",
  CHECK: "Check",
  ON_ACCOUNT: "On account",
};
const TAP = "min-h-11 inline-flex items-center justify-center rounded border px-3 text-sm";
const timeOf = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

function Stat({ label, value, testId }: { label: string; value: string; testId?: string }) {
  return (
    <div className="flex justify-between gap-2" data-testid={testId}>
      <dt>{label}</dt>
      <dd className="tabular-nums">{value}</dd>
    </div>
  );
}

function Summary({ s }: { s: CounterSaleTodaySummary }) {
  const r = s.refunds;
  const refundTotal = r.cash + r.card + r.check + r.other;
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
        <Stat label="Refunds" value={money(refundTotal)} testId="today-refunds" />
        {r.tenderKnown ? (
          <>
            <Stat label="Cash refunds" value={money(r.cash)} testId="today-refunds-cash" />
            <Stat label="Card refunds" value={money(r.card)} testId="today-refunds-card" />
            <Stat label="Check refunds" value={money(r.check)} testId="today-refunds-check" />
          </>
        ) : null}
        <Stat
          label="Cash expected in drawer"
          value={money(s.cashExpected)}
          testId="today-cash-expected"
        />
      </dl>
    </section>
  );
}

function Reprint({ row, onBack }: { row: CounterSaleTodayRow; onBack: () => void }) {
  const { branding } = useTenant();
  const cashier = useOptionalAuth()?.user?.username ?? null;
  const { data: order, isError, isLoading, refetch } = useOrder(row.orderId);
  const { data: settings } = useQuery<ReceiptBusinessProfile>({
    queryKey: ["settings"],
    queryFn: () => apiClient.get("/settings").then((r) => r.data),
  });
  const model = order
    ? receiptModelFromOrder({
        order,
        cashier,
        profile: { ...settings, businessName: branding?.businessName || settings?.businessName },
        sale: {
          invoiceId: row.invoiceId,
          invoiceNumber: row.invoiceNumber,
          paid: row.paid,
          balanceDue: row.balanceDue,
          methods: row.methods,
          soldAt: row.soldAt,
        },
      })
    : null;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2 print:hidden">
        <Button className="min-h-11" onClick={() => window.print()} disabled={!model}>
          Print
        </Button>
        <Button className="min-h-11" variant="secondary" onClick={onBack}>
          Back to sales
        </Button>
      </div>
      {model ? (
        <CounterReceiptView
          model={model}
          logoUrl={branding?.logoUrl ?? null}
          reprintLabel={`Reprint · sold ${new Date(row.soldAt).toLocaleString("en-US", {
            dateStyle: "medium",
            timeStyle: "short",
          })}`}
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
  row,
  onReprint,
  onDone,
}: {
  row: CounterSaleTodayRow;
  onReprint: () => void;
  onDone: () => void;
}) {
  const who = row.walkIn ? "Walk-in" : (row.customerName ?? "Customer");
  const methods = row.methods.length
    ? row.methods.map((m) => METHOD_LABEL[m]).join(" + ")
    : "On account";
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
        {timeOf(row.soldAt)} · {who} · {methods}
        {row.voided ? <strong className="ml-2 text-red-700">Voided</strong> : null}
        {!row.voided && row.returnState !== "NONE" ? (
          <strong className="ml-2">
            {row.returnState === "FULL" ? "Returned" : "Part returned"}
          </strong>
        ) : null}
        {!row.voided && row.balanceDue > 0 ? (
          <strong className="ml-2">{money(row.balanceDue)} due</strong>
        ) : null}
      </p>
      <div className="flex flex-wrap gap-2">
        {row.voided ? null : (
          <>
            <button type="button" className={TAP} onClick={onReprint}>
              Reprint
            </button>
            <CounterReturnAction orderId={row.orderId} onDone={onDone} />
          </>
        )}
        <Link href={`/orders/${row.orderId}`} className={cn(TAP, "text-brand-700")}>
          View order
        </Link>
      </div>
    </li>
  );
}

export function CounterTodaysSales() {
  const [open, setOpen] = React.useState(false);
  const [reprint, setReprint] = React.useState<CounterSaleTodayRow | null>(null);
  const qc = useQueryClient();
  const q = useCounterSaleToday(open);
  const refetchList = React.useCallback(
    () => void qc.invalidateQueries({ queryKey: COUNTER_SALE_TODAY_KEY }),
    [qc],
  );
  const rows = q.data?.pages.flatMap((p) => p.rows) ?? [];
  const summary = q.data?.pages[0]?.summary;

  return (
    <>
      <Button className="min-h-11" variant="secondary" onClick={() => setOpen(true)}>
        Today&apos;s sales
      </Button>
      <Modal
        open={open}
        onClose={() => {
          setOpen(false);
          setReprint(null);
        }}
        title={reprint ? "Reprint receipt" : "Today's sales"}
        scroll
        className="max-w-2xl print:static print:max-h-none print:max-w-none print:translate-x-0 print:translate-y-0 print:overflow-visible print:p-0 print:shadow-none"
      >
        {reprint ? (
          <Reprint row={reprint} onBack={() => setReprint(null)} />
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
