"use client";

import * as React from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, ExternalLink } from "lucide-react";
import { Button, cn } from "@routeflow/ui/web";
import { fmt, fmtCalendarDate } from "@/lib/formatting";
import { useAuth } from "@/lib/auth-context";
import { useInvoices } from "@/lib/api/invoices";
import { useCounterCustomerCredit } from "@/lib/api/counter-customer-credit";
import { COUNTER_CUSTOMER_LOAD_FAILED_COPY } from "@/lib/counter-customer-credit";
import { OPEN_INVOICE_STATUS_LIST } from "@/lib/open-invoice-status";
import { useTenantTimeZoneQuery } from "@/lib/tenant-timezone";
import { calendarDayInZone } from "@/lib/calendar-date";
import { daysPastDue } from "@/lib/days-past-due";
import { isStaffRole } from "@/lib/default-unit-line";
import { WriteButton } from "@/lib/read-only-gate";
import { CustomerRecordPaymentModal } from "@/components/CustomerRecordPaymentModal";

/** Shown instead of the figures when a read failed. The load-failed wording is the counter's, reused. */
export const ACCOUNT_STRIP_FAILED_COPY = "Couldn't load account info";
const COLLAPSED_ROWS = 5;
const LIST_LIMIT = 100;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Row 661 (Ask 1): what the picked customer owes, right under the customer on New order. It INFORMS and OFFERS and never
 * blocks (the tenant's credit-limit switch stays the only gate). Money comes from the counter's hook (the statement's
 * own figures, L-119): this component computes no amount. The open list is `GET /invoices?customerId=&statuses=`; the
 * counts and days are counts, not money. Nothing renders without a customer. A failed read never shows $0.
 */
export function CustomerAccountStrip({
  customerId,
  customerName,
}: {
  customerId: string | null | undefined;
  customerName?: string;
}) {
  const id = customerId || null;
  const qc = useQueryClient();
  const { user } = useAuth();
  const canPay = isStaffRole(user?.role);
  const { view } = useCounterCustomerCredit(id);
  const zoneQ = useTenantTimeZoneQuery(!!id);
  const list = useInvoices(
    id
      ? {
          customerId: id,
          statuses: [...OPEN_INVOICE_STATUS_LIST],
          sortBy: "issueDate",
          sortOrder: "asc",
          page: 1,
          limit: LIST_LIMIT,
        }
      : undefined,
    { enabled: !!id },
  );
  // #3724 review (a): the overdue count and the oldest overdue invoice are the SERVER's (its isOverdue filter, in the
  // tenant's zone), never counted from the one page above: oldest due date first, one row.
  const overdueQ = useInvoices(
    id
      ? { customerId: id, isOverdue: true, sortBy: "dueDate", sortOrder: "asc", page: 1, limit: 1 }
      : undefined,
    { enabled: !!id },
  );
  const [expanded, setExpanded] = React.useState(false);
  const [showAll, setShowAll] = React.useState(false);
  const [pay, setPay] = React.useState<{ focusInvoiceId?: string } | null>(null);

  if (!id) return null;

  // (d) the time zone only dates the rows: a failed read drops the day counts, never the strip.
  const failed =
    view.openBalance.state === "failed" ||
    view.creditLimit.state === "failed" ||
    list.isError ||
    overdueQ.isError;
  const zoneReady = !!zoneQ.zone;
  const loading =
    !failed &&
    (view.openBalance.state === "loading" ||
      view.creditLimit.state === "loading" ||
      !list.data ||
      !overdueQ.data ||
      (!zoneReady && !zoneQ.isError));

  const shell = "min-h-[2.25rem] rounded-lg border px-3 py-2 text-sm";

  if (failed) {
    return (
      <div
        role="status"
        data-testid="account-strip"
        className={cn(
          shell,
          "flex items-center justify-between gap-3 border-surface-border text-navy/70",
        )}
      >
        <span title={COUNTER_CUSTOMER_LOAD_FAILED_COPY}>{ACCOUNT_STRIP_FAILED_COPY}</span>
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            void qc.invalidateQueries({ queryKey: ["customers", id] });
            void qc.invalidateQueries({ queryKey: ["invoices"] });
            void qc.invalidateQueries({ queryKey: ["settings"] });
          }}
        >
          Retry
        </Button>
      </div>
    );
  }
  if (loading || view.openBalance.state !== "ready" || view.creditLimit.state !== "ready") {
    return (
      <div
        role="status"
        data-testid="account-strip"
        className={cn(shell, "border-surface-border text-navy/60")}
      >
        Checking account…
      </div>
    );
  }

  const tenantDay = zoneQ.zone ? calendarDayInZone(zoneQ.zone) : null;
  const page = list.data?.data ?? [];
  const rows = [...page]
    .filter((r) => (r.balanceDue ?? 0) > 0.001)
    .sort((a, b) => {
      const ad = a.issueDate ?? "";
      const bd = b.issueDate ?? "";
      return ad !== bd
        ? ad.localeCompare(bd)
        : (a.createdAt ?? "").localeCompare(b.createdAt ?? "");
    })
    .map((r) => ({ inv: r, late: tenantDay ? daysPastDue(tenantDay, r.dueDate) : 0 }));
  const overdueCount = overdueQ.data?.meta?.total ?? 0;
  const oldestOverdue = overdueQ.data?.data?.[0];
  const oldestLate = tenantDay && oldestOverdue ? daysPastDue(tenantDay, oldestOverdue.dueDate) : 0;
  const owed = view.openBalance.value;
  const overLimitBy = view.overLimitBy;
  const warn =
    overdueCount > 0 ||
    overLimitBy > 0 ||
    (view.overdue.state === "ready" && view.overdue.value > 0);
  // The list is one page (LIST_LIMIT): the open count is the server's total, never the page's length (Opus review).
  // (b) like with like: the server's total against the page it returned (zero-balance rows included), not the
  // balance-filtered rows, so a zero-balance open invoice never reads as "more than one page".
  const openCount = Math.max(list.data?.meta?.total ?? page.length, page.length);
  const truncated = openCount > page.length;
  const nothing = openCount === 0 && owed <= 0;
  // (c) an opening balance with no open invoice: the amount alone, with nothing to expand.
  const listable = rows.length > 0;

  const parts: string[] = [`Owes ${fmt(owed)}`];
  if (openCount > 0) parts.push(`${openCount} open`);
  if (overdueCount > 0) {
    parts.push(
      oldestLate > 0
        ? `${overdueCount} overdue, oldest ${plural(oldestLate, "day", "days")}`
        : `${overdueCount} overdue`,
    );
  }
  if (overLimitBy > 0) parts.push(`${fmt(overLimitBy)} over limit`);

  const shown = showAll ? rows : rows.slice(0, COLLAPSED_ROWS);
  const afterPayment = () => {
    void qc.invalidateQueries({ queryKey: ["customers", id] });
    void qc.invalidateQueries({ queryKey: ["invoices"] });
  };

  return (
    <div data-testid="account-strip" className="space-y-2">
      <div
        data-testid="account-strip-bar"
        data-tone={warn ? "warn" : "neutral"}
        className={cn(
          shell,
          "flex items-center justify-between gap-3",
          warn ? "border-amber-300 bg-amber-50 text-amber-900" : "border-surface-border text-navy",
        )}
      >
        {nothing ? (
          <p data-testid="account-strip-line" className="text-navy/60">
            No open invoices
          </p>
        ) : (
          <>
            <p data-testid="account-strip-line" className="font-medium">
              {parts.join(" · ")}
            </p>
            {listable ? (
              <button
                type="button"
                aria-expanded={expanded}
                onClick={() => setExpanded((v) => !v)}
                className="inline-flex shrink-0 items-center gap-1 text-xs font-medium underline-offset-2 hover:underline"
              >
                {expanded ? "Hide" : "View"}
                {expanded ? (
                  <ChevronUp className="h-3.5 w-3.5" />
                ) : (
                  <ChevronDown className="h-3.5 w-3.5" />
                )}
              </button>
            ) : null}
          </>
        )}
      </div>

      {expanded && listable ? (
        <div className="rounded-lg border border-surface-border bg-white">
          <ul className="divide-y divide-surface-border">
            {shown.map(({ inv, late }) => (
              <li
                key={inv.id}
                data-testid="account-strip-row"
                className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-sm"
              >
                <span className="min-w-0 text-navy">
                  <span data-testid="account-strip-number" className="font-medium">
                    {inv.invoiceNumber}
                  </span>
                  <span className="text-navy/70">
                    {" · "}issued {fmtCalendarDate(inv.issueDate)}
                    {late > 0 ? (
                      <>
                        {" · "}
                        <span className="text-amber-800">
                          {plural(late, "day", "days")} overdue
                        </span>
                      </>
                    ) : null}
                    {" · "}
                    {fmt(inv.balanceDue ?? 0)} due
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {canPay ? (
                    <WriteButton
                      type="button"
                      size="sm"
                      variant="secondary"
                      onClick={() => setPay({ focusInvoiceId: inv.id })}
                    >
                      Mark paid
                    </WriteButton>
                  ) : null}
                  <a
                    href={`/invoices/${inv.id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline"
                  >
                    Open
                    <ExternalLink className="h-3 w-3" aria-hidden />
                  </a>
                </span>
              </li>
            ))}
          </ul>
          <div className="flex items-center justify-between gap-3 border-t border-surface-border px-3 py-2">
            {truncated ? (
              <a
                href={`/customers/${id}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs font-medium text-brand-600 hover:underline"
              >
                {`See all ${openCount} on the customer page`}
              </a>
            ) : !showAll && rows.length > COLLAPSED_ROWS ? (
              <button
                type="button"
                onClick={() => setShowAll(true)}
                className="text-xs font-medium text-brand-600 hover:underline"
              >
                {`Show all ${rows.length}`}
              </button>
            ) : (
              <span />
            )}
            {canPay ? (
              <WriteButton type="button" size="sm" onClick={() => setPay({})}>
                Record payment
              </WriteButton>
            ) : null}
          </div>
        </div>
      ) : null}

      {pay ? (
        <CustomerRecordPaymentModal
          customerId={id}
          customerName={customerName}
          focusInvoiceId={pay.focusInvoiceId}
          onClose={() => setPay(null)}
          onSuccess={afterPayment}
        />
      ) : null}
    </div>
  );
}
