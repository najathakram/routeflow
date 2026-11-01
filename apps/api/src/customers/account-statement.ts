import { roundMoney } from "@routeflow/pricing";
import type {
  AccountStatement,
  AccountStatementCredit,
  AccountStatementInvoice,
  AccountStatementPayment,
} from "@routeflow/types";
import type { PrismaService } from "../prisma/prisma.service";
import {
  ADVANCE_METHOD,
  CONFIRMED_PAYMENT,
  CREDIT_NOTE_METHOD,
  collectedDateOf,
  splitConfirmed,
} from "../invoices/payment-predicates";
import { KPI_SUMMARY_EXCLUDED, OPEN_INVOICE_STATUSES } from "../invoices/invoice-status-sets";
import { classifyInvoiceBalance } from "../invoices/invoice-balance-classify";
import { toCollectState } from "../invoices/to-collect";
import {
  addCalendarDays,
  calendarDateFromIso,
  overdueCutoff,
  startOfCalendarDay,
  tenantTodayDay,
} from "../common/calendar-date";
import { tenantTimeZone } from "../common/tenant-time-zone";
import { statementOutstandingAmount, statementOverdueAmount } from "./customer-statement";

/**
 * SA-1078 (W-1096) PR-1: the customer account statement read. One function over Prisma-by-parameter (like the
 * other statement builders), so the PDF service can call it later with no module cycle. Every figure is the
 * server's, in cents; the screens never add, net or clamp. The open balance and the overdue figure come from the
 * same helpers as `outstandingAmount` / `overdueAmount` on the older statements, so they can never disagree.
 *
 * Nothing here is capped except the payments list: the open invoices and the credits are the customer's whole
 * open set (REG-B110), so the total always covers every row.
 */

/** Payments older than this many calendar days (tenant zone) are not listed. Day 30 is in, day 31 is out. */
export const RECENT_PAYMENTS_WINDOW_DAYS = 30;
/** The payments list is cut here, newest first; `recentPaymentsTruncated` says when rows were left out. */
export const RECENT_PAYMENTS_MAX = 50;

/**
 * Whole calendar days past the due date on the tenant's own calendar. `tenantDay` is the tenant's "today"
 * (YYYY-MM-DD) and `dueDate` the stored UTC-midnight calendar date. 0 = due today, not yet due, or no due date.
 * Same count as web's `daysPastDue` (apps/web/lib/days-past-due.ts).
 */
export function daysLateOn(tenantDay: string, dueDate: Date | string | null | undefined): number {
  const due = calendarDateFromIso(dueDate);
  if (!due) return 0;
  const diff = Math.round(
    (Date.parse(`${tenantDay}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / 86_400_000,
  );
  return diff > 0 ? diff : 0;
}

const isoOf = (d: Date | string): string => (d instanceof Date ? d : new Date(d)).toISOString();

/**
 * `staff` adds `emailOnFile` and each invoice's `toCollect`; the buyer's own view leaves both keys out.
 * The caller resolves the customer first (staff: `findCustomerOrThrow`, 404 on another tenant's id).
 */
export async function buildAccountStatement(
  prisma: PrismaService,
  customer: { id: string; businessName: string; email?: string | null },
  opts: { staff: boolean },
): Promise<AccountStatement> {
  const now = new Date();
  const zone = await tenantTimeZone(prisma);
  const tenantDay = tenantTodayDay(zone, now);
  const since = addCalendarDays(startOfCalendarDay(now, zone), -RECENT_PAYMENTS_WINDOW_DAYS);

  const [invoices, creditNotes, advances, payments] = await Promise.all([
    prisma.forTenant().invoice.findMany({
      // The same set as the older statements: DRAFT, PAID, VOID and WRITTEN_OFF are never receivable.
      where: { customerId: customer.id, status: { notIn: KPI_SUMMARY_EXCLUDED } },
      orderBy: [{ issueDate: "asc" }, { createdAt: "asc" }],
      select: {
        id: true,
        invoiceNumber: true,
        total: true,
        status: true,
        issueDate: true,
        dueDate: true,
        createdAt: true,
        expectedPaymentMethod: true,
        payments: { select: { amount: true, status: true, method: true } },
      },
    }),
    prisma.forTenant().creditNote.findMany({
      where: { customerId: customer.id, status: { not: "VOID" } },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        creditNoteNumber: true,
        amount: true,
        amountUsed: true,
        reason: true,
        createdAt: true,
        expiresAt: true,
      },
    }),
    prisma.forTenant().advancePayment.findMany({
      where: { customerId: customer.id, balance: { gt: 0 } },
      orderBy: { receivedAt: "asc" },
      select: { id: true, balance: true, reference: true, notes: true, receivedAt: true },
    }),
    // Confirmed money on any invoice of this customer, dated by when it was collected (`settledAt ?? paidAt`).
    // The window is applied here; the newest-first order and the cap in code, because that date is a coalesce.
    prisma.forTenant().invoicePayment.findMany({
      where: {
        ...CONFIRMED_PAYMENT,
        invoice: { customerId: customer.id },
        OR: [{ settledAt: { gte: since } }, { settledAt: null, paidAt: { gte: since } }],
      },
      select: {
        amount: true,
        method: true,
        reference: true,
        paidAt: true,
        settledAt: true,
        invoice: { select: { invoiceNumber: true } },
      },
    }),
  ]);

  const cutoff = overdueCutoff(now, zone);
  const openBalance = statementOutstandingAmount(invoices, zone);
  const overdue = statementOverdueAmount(invoices, zone);

  const openInvoices: AccountStatementInvoice[] = [];
  let waitingToClear = 0;
  for (const inv of invoices) {
    for (const p of inv.payments) if (p.status === "PENDING") waitingToClear += Number(p.amount);
    if (!(OPEN_INVOICE_STATUSES as readonly string[]).includes(inv.status)) continue;
    const { balanceDue } = classifyInvoiceBalance(inv, cutoff);
    if (balanceDue <= 0) continue;
    const split = splitConfirmed(inv.payments);
    openInvoices.push({
      id: inv.id,
      invoiceNumber: inv.invoiceNumber,
      issueDate: isoOf(inv.issueDate),
      dueDate: inv.dueDate ? isoOf(inv.dueDate) : null,
      total: roundMoney(Number(inv.total)),
      paid: roundMoney(split.cash),
      credit: roundMoney(split.creditApplied + split.advanceApplied),
      unpaid: balanceDue,
      daysLate: daysLateOn(tenantDay, inv.dueDate),
      ...(opts.staff ? { toCollect: toCollectState(inv) } : {}),
    });
  }

  // The wallet rule of the older statements: open, non-expired notes with something left, plus advances with a balance.
  const credits: AccountStatementCredit[] = [];
  for (const c of creditNotes) {
    const remaining = roundMoney(Number(c.amount) - Number(c.amountUsed));
    if (remaining <= 0.001 || (c.expiresAt && c.expiresAt <= now)) continue;
    credits.push({
      kind: "CREDIT_NOTE",
      id: c.id,
      number: c.creditNoteNumber,
      date: isoOf(c.createdAt),
      reason: c.reason ?? null,
      remaining,
      expiresAt: c.expiresAt ? isoOf(c.expiresAt) : null,
    });
  }
  for (const a of advances) {
    credits.push({
      kind: "ADVANCE",
      id: a.id,
      number: a.reference ?? null,
      date: isoOf(a.receivedAt),
      reason: a.notes ?? null,
      remaining: roundMoney(Number(a.balance)),
      expiresAt: null,
    });
  }
  const creditAvailable = roundMoney(credits.reduce((sum, c) => sum + c.remaining, 0));

  const dated = payments
    .map((p) => ({ p, at: new Date(collectedDateOf(p) as Date) }))
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  const recentPayments: AccountStatementPayment[] = dated
    .slice(0, RECENT_PAYMENTS_MAX)
    .map(({ p, at }) => ({
      date: at.toISOString(),
      // A credit-note or advance application reduces the invoice like money but is not a new payment.
      kind:
        p.method === CREDIT_NOTE_METHOD || p.method === ADVANCE_METHOD
          ? ("CREDIT" as const)
          : ("PAYMENT" as const),
      method: p.method,
      reference: p.reference ?? null,
      invoiceNumber: p.invoice.invoiceNumber,
      amount: roundMoney(Number(p.amount)),
    }));

  return {
    asOf: tenantDay,
    customer: { id: customer.id, businessName: customer.businessName },
    ...(opts.staff ? { emailOnFile: customer.email ?? null } : {}),
    openBalance,
    overdue,
    creditAvailable,
    afterCredit: Math.max(0, roundMoney(openBalance - creditAvailable)),
    waitingToClear: roundMoney(waitingToClear),
    openInvoices,
    recentPayments,
    recentPaymentsTruncated: dated.length > RECENT_PAYMENTS_MAX,
    credits,
  };
}
