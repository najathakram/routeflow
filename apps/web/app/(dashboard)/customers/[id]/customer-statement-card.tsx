"use client";

import * as React from "react";
import { Download } from "lucide-react";
import { Button, cn, useToast } from "@routeflow/ui/web";
import { fetchCustomerStatementPdf, useCustomerStatementMonths } from "@/lib/api/customers";
import type { CustomerStatement } from "@/lib/api/customers";
import { statementMoney } from "@/lib/customer-statement-display";
import { genericToastCopy } from "@/lib/generic-toast-copy";
import { fmt } from "@/lib/formatting";
import { LedgerTruncationNote } from "./ledger-truncation-note";

/**
 * B1005 (option A): the customer's "Statement of Accounts" card. It has NO letterhead and NO opening balance of its own: the
 * tenant's own letterhead and the real opening balance live in the SERVER's monthly statement PDF, which this card downloads.
 * What stays on screen is a plain activity ledger plus the lifetime totals, each of which is a real figure or an em dash (never a
 * made-up $0.00 while loading or after a failure).
 */
export function CustomerStatementCard({
  customerId,
  statement,
  statementFailed,
}: {
  customerId: string;
  statement: CustomerStatement | undefined;
  statementFailed: boolean;
}) {
  const { toast } = useToast();
  const { data: monthsData } = useCustomerStatementMonths(customerId);
  const months = monthsData?.months ?? [];
  const [picked, setPicked] = React.useState<string>("");
  const month = picked && months.includes(picked) ? picked : (months[0] ?? "");
  const [downloading, setDownloading] = React.useState(false);

  const money = (pick: (s: CustomerStatement) => number | null | undefined) =>
    statementMoney(statement, statementFailed, pick, fmt);
  const balanceDue = money((s) => s.outstandingAmount);

  async function downloadPdf() {
    if (!month) return;
    setDownloading(true);
    try {
      const { blob } = await fetchCustomerStatementPdf(customerId, month);
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `statement-${month}.pdf`;
      a.rel = "noopener noreferrer";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(blobUrl), 60_000);
    } catch (err) {
      toast({
        title: "Couldn't download the statement",
        description: genericToastCopy(err),
        variant: "error",
      });
    } finally {
      setDownloading(false);
    }
  }

  return (
    <div className="space-y-4 lg:col-span-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3 className="text-base font-semibold text-navy">Statement of Accounts</h3>
        <div className="flex flex-wrap items-center gap-2">
          {months.map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={m === month}
              onClick={() => setPicked(m)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                m === month
                  ? "border-brand-500 bg-brand-50 text-brand-700"
                  : "border-surface-border bg-white text-navy/70 hover:bg-gray-50",
              )}
            >
              {m}
            </button>
          ))}
          <Button
            size="sm"
            variant="secondary"
            leftIcon={<Download className="h-4 w-4" />}
            disabled={!month || downloading}
            onClick={() => void downloadPdf()}
          >
            Download statement (PDF)
          </Button>
        </div>
      </div>

      <div className="rounded-xl border border-surface-border bg-white p-8 shadow-[0_2px_12px_0_rgb(0,0,0,0.06)]">
        <div
          data-testid="statement-tiles"
          className="mb-6 grid grid-cols-3 gap-px overflow-hidden rounded-lg border border-surface-border bg-surface-border"
        >
          {[
            {
              // B110/M1: lifetime totals come from the server's DB-side aggregate over the WHOLE invoice/payment history,
              // never a reduce over the capped `transactions` ledger below (which stops at one page).
              label: "Invoiced Amount",
              value: money((s) => s.lifetimeInvoiced),
              valueClass: "text-navy",
            },
            {
              label: "Amount Received",
              value: money((s) => s.lifetimeReceived),
              valueClass: "text-success",
            },
            {
              label: "Balance Due",
              value: balanceDue,
              valueClass:
                (statement?.outstandingAmount ?? 0) > 0 && !statementFailed
                  ? "text-danger"
                  : "text-success",
            },
          ].map((item) => (
            <div
              key={item.label}
              className="flex flex-col items-center gap-1 bg-white px-4 py-3 text-center"
            >
              <span className="text-xs font-semibold uppercase tracking-wider text-navy/70">
                {item.label}
              </span>
              <span className={cn("text-base font-bold", item.valueClass)}>{item.value}</span>
            </div>
          ))}
        </div>

        <LedgerTruncationNote truncated={statement?.transactionsTruncated} />

        {!statement || statement.transactions.length === 0 ? (
          <p className="text-sm text-navy/70">No transactions on record.</p>
        ) : (
          <div className="-mx-8 overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead>
                <tr className="bg-[#1B3A5C]">
                  <th className="px-8 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-white/80">
                    Date
                  </th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-white/80">
                    Type
                  </th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-white/80">
                    Details
                  </th>
                  <th className="px-4 py-2.5 text-right text-xs font-semibold uppercase tracking-wider text-white/80">
                    Amount
                  </th>
                  <th className="px-8 py-2.5 text-right text-xs font-semibold uppercase tracking-wider text-white/80">
                    Remaining
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-surface-border">
                {statement.transactions.map((tx, i) => {
                  // Server rows: INVOICE / CREDIT_NOTE / ADVANCE_PAYMENT
                  // (payments fold into invoices). `runningBalance` is
                  // per-row remaining: owed / unused / in wallet.
                  const isInvoice = tx.type === "INVOICE";
                  const meta = isInvoice
                    ? { label: "Invoice", cls: "bg-blue-100 text-blue-700" }
                    : tx.type === "CREDIT_NOTE"
                      ? { label: "Credit note", cls: "bg-green-100 text-green-700" }
                      : { label: "Advance", cls: "bg-purple-100 text-purple-700" };
                  const remainingLabel = isInvoice
                    ? "owed"
                    : tx.type === "CREDIT_NOTE"
                      ? "unused"
                      : "in wallet";
                  return (
                    <tr key={tx.id ?? i} className={i % 2 === 0 ? "bg-white" : "bg-gray-50/60"}>
                      <td className="px-8 py-2.5 text-xs text-navy/70">
                        {new Date(tx.date).toLocaleDateString("en-US", {
                          month: "short",
                          day: "numeric",
                          year: "numeric",
                        })}
                      </td>
                      <td className="px-4 py-2.5">
                        <span
                          className={cn(
                            "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold",
                            meta.cls,
                          )}
                        >
                          {meta.label}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-sm text-navy">
                        <span className="text-xs text-navy/70">{tx.description}</span>
                      </td>
                      <td className="px-4 py-2.5 text-right text-sm">
                        <span
                          className={cn("font-medium", isInvoice ? "text-navy" : "text-success")}
                        >
                          {fmt(Math.abs(tx.amount))}
                        </span>
                      </td>
                      <td className="px-8 py-2.5 text-right text-sm">
                        <span className="font-semibold text-navy">
                          {fmt(Math.abs(tx.runningBalance))}
                        </span>
                        <span className="ml-1 text-xs text-navy/50">{remainingLabel}</span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="border-t-2 border-surface-border bg-gray-50">
                  <td colSpan={3} className="px-8 py-3 text-sm font-bold text-navy">
                    Balance Due
                  </td>
                  <td />
                  <td
                    className={cn(
                      "px-8 py-3 text-right text-sm font-bold",
                      (statement?.outstandingAmount ?? 0) > 0 ? "text-danger" : "text-success",
                    )}
                  >
                    {balanceDue}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
