import { resolveConfirmedAmounts } from "@routeflow/pricing";
import type { Invoice } from "@/lib/api/invoices";
import { calendarDaysUntil } from "@/lib/formatting";

/**
 * B421: the list row's Balance Due figure. The old inline version
 * (`inv.paidAmount ?? (inv.payments ?? []).reduce((s, p) => s + Number(p.amount), 0)`)
 * had no status OR method filter at all — it summed DRAFT/VOID rows and
 * counted a CREDIT_NOTE/ADVANCE application as cash, both inflating "paid"
 * and understating the balance. Delegates entirely to the shared
 * `resolveConfirmedAmounts` (same helper the PDF/detail page use) — no local
 * re-derivation. Exported for direct unit testing.
 */
export function resolveInvoiceListBalance(
  inv: Pick<
    Invoice,
    "total" | "balanceDue" | "paidAmount" | "creditApplied" | "advanceApplied" | "payments"
  >,
): number {
  if (inv.balanceDue !== undefined) return Number(inv.balanceDue);
  const { cash, creditApplied, advanceApplied } = resolveConfirmedAmounts(
    {
      totalPaid: inv.paidAmount,
      creditApplied: inv.creditApplied,
      advanceApplied: inv.advanceApplied,
    },
    inv.payments ?? [],
  );
  return Math.max(0, Number(inv.total) - cash - creditApplied - advanceApplied);
}

/**
 * The page's own overdue rule, the one `renderStatus` prints as "Overdue by N days": an OVERDUE
 * invoice, or a PARTIAL one whose due date has passed. A SENT or VIEWED invoice prints its plain
 * status, so it is not overdue here. Exported for direct unit testing.
 */
export function isInvoiceOverdue(inv: Pick<Invoice, "status" | "dueDate">): boolean {
  if (inv.status === "OVERDUE") return true;
  if (inv.status !== "PARTIAL") return false;
  const diffDays = calendarDaysUntil(inv.dueDate);
  return diffDays !== null && diffDays < 0;
}

/**
 * UXG-R10-A1 D3: the balance is danger only when money is owed on an overdue invoice. A balance
 * not yet due, a draft and a zero balance use the default tone. The phone card and the table cell
 * both read this, so they agree at every width.
 */
export function resolveInvoiceListBalanceTone(
  inv: Parameters<typeof resolveInvoiceListBalance>[0] & Pick<Invoice, "status" | "dueDate">,
): "default" | "danger" {
  return resolveInvoiceListBalance(inv) > 0 && isInvoiceOverdue(inv) ? "danger" : "default";
}
