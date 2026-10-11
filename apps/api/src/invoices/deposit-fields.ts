import type { Prisma } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";

/**
 * The deposit schedule's read-time math (Tier 1, deliberately minimal): the deposit dollar amount is
 * ALWAYS derived from depositPercent × total at read time — never stored — and depositOverdue is a
 * computed signal, never a status flip. No InvoiceInstallment table / deposit-aware statuses.
 *
 * #1529 / SA-517: extracted from InvoicesService as a PURE function so the invoice list, the invoice
 * detail and AR aging share one rule. `todayIso` (YYYY-MM-DD) is the caller's "today": the invoice
 * list, the detail and AR aging all pass the tenant's day (the UTC day when the tenant has no zone). A deposit due TODAY
 * is never overdue (RF-202: the whole due day is grace — ISO date strings compare, never instants).
 */
export function computeDepositFields(
  inv: {
    total: number | string | Prisma.Decimal;
    depositPercent: number | string | Prisma.Decimal | null;
    depositDueDate: Date | string | null;
  },
  totalPaid: number,
  todayIso: string,
): { depositAmount: number | null; depositOverdue: boolean } {
  if (inv.depositPercent == null) return { depositAmount: null, depositOverdue: false };
  const depositAmount = roundMoney((Number(inv.total) * Number(inv.depositPercent)) / 100);
  const depositDueIso = inv.depositDueDate
    ? new Date(inv.depositDueDate).toISOString().slice(0, 10)
    : null;
  const depositOverdue =
    depositDueIso != null && depositDueIso < todayIso && totalPaid < depositAmount;
  return { depositAmount, depositOverdue };
}
