"use client";

import * as React from "react";
import Link from "next/link";
import { useQueryClient } from "@tanstack/react-query";
import { Button, Modal, cn } from "@routeflow/ui/web";
import type { AccountStatement } from "@routeflow/types";
import { fmt, fmtCalendarDate } from "@/lib/formatting";
import { accountStatementKey, useAccountStatement } from "@/lib/api/account-statement";
import { paymentMethodLabel } from "@/lib/payment-methods";
import {
  STATEMENT_COPY,
  daysLateLabel,
  showingLabel,
  statementShape,
} from "@/lib/account-statement-display";
import { useBackToClose } from "@/lib/use-back-to-close";
import { StatementPrintButton } from "./StatementPrintButton";
import { StatementEmailButton } from "./StatementEmailButton";

/** The sheet rests on the right from 768 and fills the screen at 390 (AddFullAddressSheet's side-sheet form). */
const SHEET_CLASS =
  "left-auto right-0 top-0 h-full max-h-full w-full max-w-2xl translate-x-0 translate-y-0 rounded-none data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100 motion-reduce:data-[state=closed]:animate-none motion-reduce:data-[state=open]:animate-none";

function Line({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 text-sm">
      <dt className="text-navy/70">{label}</dt>
      <dd className={cn("font-medium tabular-nums", danger ? "text-danger" : "text-navy")}>
        {fmt(value)}
      </dd>
    </div>
  );
}

function InvoiceNumber({ id, number, link }: { id: string; number: string; link: boolean }) {
  return link ? (
    <Link
      href={`/invoices/${id}`}
      className="inline-flex items-center font-medium text-brand-600 hover:underline max-sm:min-h-[44px] max-sm:min-w-[44px]"
    >
      {number}
    </Link>
  ) : (
    <span className="font-medium text-navy">{number}</span>
  );
}

/**
 * SA-1078 W-1096 PR-2: the statement view. Pure over a loaded statement, so the buyer twin (PR-6) renders the same body.
 * Invoice numbers are same-tab links where leaving is safe (`linkInvoices`) and plain text on the counter and New order.
 */
export function AccountStatementBody({
  statement,
  linkInvoices,
}: {
  statement: AccountStatement;
  linkInvoices: boolean;
}) {
  const shape = statementShape(statement);
  // every date on the statement is already the tenant's day ("YYYY-MM-DD", SA-1078 A-3): no zone is run over it
  const asOf = fmtCalendarDate(statement.asOf);
  return (
    <div className="space-y-5" data-testid="account-statement-body">
      <div>
        <p className="text-sm text-navy/70" data-testid="account-statement-subtitle">
          {statement.customer.businessName} · As of {asOf}
        </p>
        <p className="mt-2 text-xs font-semibold uppercase tracking-wider text-navy/70">
          {STATEMENT_COPY.openBalance}
        </p>
        <p
          className={cn(
            "text-3xl font-bold tabular-nums",
            statement.openBalance > 0 ? "text-danger" : "text-success",
          )}
          data-testid="account-statement-open-balance"
        >
          {fmt(statement.openBalance)}
        </p>
      </div>

      <dl className="space-y-1.5 rounded-lg border border-surface-border px-4 py-3">
        <Line
          label={STATEMENT_COPY.overdue}
          value={statement.overdue}
          danger={statement.overdue > 0}
        />
        {shape.showCreditLines && (
          <>
            <Line label={STATEMENT_COPY.creditAvailable} value={statement.creditAvailable} />
            <Line label={STATEMENT_COPY.afterCredit} value={statement.afterCredit} />
          </>
        )}
        {shape.showWaiting && (
          <Line label={STATEMENT_COPY.waitingToClear} value={statement.waitingToClear} />
        )}
      </dl>

      <section aria-labelledby="statement-open-heading" className="space-y-2">
        <h3 id="statement-open-heading" className="text-sm font-semibold text-navy">
          {STATEMENT_COPY.openInvoices}
        </h3>
        {shape.empty ? (
          <p className="text-sm text-navy/70" data-testid="account-statement-none">
            {STATEMENT_COPY.noOpenInvoices}
          </p>
        ) : (
          <>
            <table className="w-full text-sm" data-testid="account-statement-invoices">
              <thead>
                <tr className="text-left text-xs font-semibold uppercase tracking-wider text-navy/70">
                  <th scope="col" className="py-2 pr-2">
                    Invoice
                  </th>
                  <th scope="col" className="hidden px-2 py-2 sm:table-cell">
                    Due
                  </th>
                  <th scope="col" className="hidden px-2 py-2 text-right sm:table-cell">
                    Total
                  </th>
                  <th scope="col" className="hidden px-2 py-2 text-right sm:table-cell">
                    Paid
                  </th>
                  {shape.showCreditColumn && (
                    <th scope="col" className="hidden px-2 py-2 text-right sm:table-cell">
                      Credit
                    </th>
                  )}
                  <th scope="col" className="py-2 pl-2 text-right">
                    Unpaid
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {shape.rows.map((r) => (
                  <tr key={r.id} data-testid="account-statement-invoice-row">
                    <td className="py-2 pr-2 align-top">
                      <InvoiceNumber id={r.id} number={r.invoiceNumber} link={linkInvoices} />
                      <div
                        className="text-xs text-navy/70 sm:hidden"
                        data-testid="statement-row-detail"
                      >
                        Due {fmtCalendarDate(r.dueDate)}
                        {r.daysLate > 0 ? ` · ${daysLateLabel(r.daysLate)}` : ""}
                      </div>
                    </td>
                    <td className="hidden px-2 py-2 align-top sm:table-cell">
                      {fmtCalendarDate(r.dueDate)}
                      {r.daysLate > 0 && (
                        <span className="block text-xs text-danger">
                          {daysLateLabel(r.daysLate)}
                        </span>
                      )}
                    </td>
                    <td className="hidden px-2 py-2 text-right tabular-nums sm:table-cell">
                      {fmt(r.total)}
                    </td>
                    <td className="hidden px-2 py-2 text-right tabular-nums sm:table-cell">
                      {fmt(r.paid)}
                    </td>
                    {shape.showCreditColumn && (
                      <td className="hidden px-2 py-2 text-right tabular-nums sm:table-cell">
                        {r.credit > 0 ? fmt(r.credit) : "—"}
                      </td>
                    )}
                    <td className="py-2 pl-2 text-right align-top font-semibold tabular-nums text-navy">
                      {fmt(r.unpaid)}
                      <div
                        className="text-xs font-normal text-navy/70 sm:hidden"
                        data-testid="statement-row-paid"
                      >
                        {`Paid ${fmt(r.paid)}`}
                        {shape.showCreditColumn && r.credit > 0 ? ` · Credit ${fmt(r.credit)}` : ""}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="border-t border-surface-border" data-testid="account-statement-foot">
                  <th
                    scope="row"
                    colSpan={shape.showCreditColumn ? 5 : 4}
                    className="hidden py-2 pr-2 text-left text-sm font-semibold text-navy sm:table-cell"
                  >
                    {STATEMENT_COPY.openBalance}
                  </th>
                  <th
                    scope="row"
                    className="py-2 pr-2 text-left text-sm font-semibold text-navy sm:hidden"
                  >
                    {STATEMENT_COPY.openBalance}
                  </th>
                  <td
                    className="py-2 pl-2 text-right text-sm font-bold tabular-nums text-navy"
                    data-testid="account-statement-foot-total"
                  >
                    {fmt(statement.openBalance)}
                  </td>
                </tr>
              </tfoot>
            </table>
            {shape.cut && (
              <p className="text-xs text-navy/70" data-testid="account-statement-cut">
                {showingLabel(shape.rows.length, shape.total)}
              </p>
            )}
          </>
        )}
      </section>

      {statement.recentPayments.length > 0 && (
        <section aria-labelledby="statement-paid-heading" className="space-y-2">
          <h3 id="statement-paid-heading" className="text-sm font-semibold text-navy">
            {STATEMENT_COPY.recentPayments}
          </h3>
          <ul
            className="divide-y divide-surface-border text-sm"
            data-testid="account-statement-payments"
          >
            {statement.recentPayments.map((p, i) => (
              <li
                key={`${p.date}-${p.invoiceNumber}-${i}`}
                className="flex justify-between gap-3 py-2"
              >
                <span>
                  {fmtCalendarDate(p.date)} · {paymentMethodLabel(p.method)}
                  {p.reference ? ` ${p.reference}` : ""} · {p.invoiceNumber}
                </span>
                <span className="font-medium tabular-nums">{fmt(p.amount)}</span>
              </li>
            ))}
          </ul>
          {statement.recentPaymentsTruncated && (
            <p className="text-xs text-navy/70">The PDF has them all.</p>
          )}
        </section>
      )}

      {statement.credits.length > 0 && (
        <section aria-labelledby="statement-credits-heading" className="space-y-2">
          <h3 id="statement-credits-heading" className="text-sm font-semibold text-navy">
            {STATEMENT_COPY.credits}
          </h3>
          <ul
            className="divide-y divide-surface-border text-sm"
            data-testid="account-statement-credits"
          >
            {statement.credits.map((c) => (
              <li key={c.id} className="flex justify-between gap-3 py-2">
                <span>
                  {c.number ?? (c.kind === "ADVANCE" ? "Advance" : "Credit")} ·{" "}
                  {fmtCalendarDate(c.date)}
                  {c.reason ? ` · ${c.reason}` : ""}
                  {c.expiresAt ? ` · Expires ${fmtCalendarDate(c.expiresAt)}` : ""}
                </span>
                <span className="font-medium tabular-nums">{fmt(c.remaining)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

/**
 * The staff sheet: one `Modal` in side-sheet form over `GET /customers/:id/account-statement`. The footer carries Email (PR-4)
 * and Print (PR-3). A failed read says so with Try Again, never a $0.00.
 */
export function AccountStatementSheet({
  customerId,
  open,
  onClose,
  linkInvoices = true,
}: {
  customerId: string;
  open: boolean;
  onClose: () => void;
  linkInvoices?: boolean;
}) {
  const q = useAccountStatement(customerId, open);
  useBackToClose(open, onClose);
  // U9: a sheet that read a fresher figure leaves the figures behind it fresh too, and the next open reads again
  const qc = useQueryClient();
  const loaded = React.useRef(false);
  React.useEffect(() => {
    if (open && q.data) loaded.current = true;
  }, [open, q.data]);
  React.useEffect(() => {
    if (open || !loaded.current) return;
    loaded.current = false;
    const own = accountStatementKey(customerId);
    void qc.invalidateQueries({
      queryKey: ["customers", customerId],
      predicate: (query) => query.queryKey[3] !== own[3],
    });
    void qc.invalidateQueries({ queryKey: ["invoices"] });
    void qc.invalidateQueries({ queryKey: ["reports"] });
    qc.removeQueries({ queryKey: own });
  }, [open, customerId, qc]);
  // U17: the sheet has no Radix trigger, so it hands focus back to the figure that was tapped.
  const tapped = React.useRef<HTMLElement | null>(null);
  // The sheet is a React child of the figure that opened it, and React bubbles events through a portal: without this, a tap
  // inside the sheet reaches the row it sits in (AR aging, Customer Balance Summary) and navigates the page behind it.
  const stop = (e: React.SyntheticEvent) => e.stopPropagation();
  return (
    <span className="contents" onClick={stop} onKeyDown={stop}>
      <Modal
        open={open}
        onClose={onClose}
        title={STATEMENT_COPY.title}
        scroll
        anchor="top"
        className={SHEET_CLASS}
        closeClassName="max-sm:flex max-sm:min-h-11 max-sm:min-w-11 max-sm:items-center max-sm:justify-center"
        onOpenAutoFocus={() => {
          tapped.current = document.activeElement as HTMLElement | null;
        }}
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          tapped.current?.focus();
        }}
        footer={
          q.data ? (
            <div
              data-testid="account-statement-actions"
              className="flex flex-wrap items-center gap-2"
            >
              <StatementEmailButton
                customerId={customerId}
                emailOnFile={q.data.emailOnFile ?? null}
              />
              <StatementPrintButton customerId={customerId} />
            </div>
          ) : undefined
        }
      >
        <div data-testid="account-statement-sheet">
          {q.data ? (
            <AccountStatementBody statement={q.data} linkInvoices={linkInvoices} />
          ) : q.isError ? (
            <div role="alert" className="space-y-3">
              <p className="text-sm text-navy">{STATEMENT_COPY.loadFailed}</p>
              <Button type="button" variant="secondary" size="sm" onClick={() => void q.refetch()}>
                {STATEMENT_COPY.tryAgain}
              </Button>
            </div>
          ) : (
            <p role="status" className="text-sm text-navy/70">
              Loading…
            </p>
          )}
        </div>
      </Modal>
    </span>
  );
}
