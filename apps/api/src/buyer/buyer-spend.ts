import { roundMoney } from "@routeflow/pricing";
import { CreditNoteStatus, InvoiceStatus } from "@prisma/client";
import {
  addCalendarDays,
  calendarDateFromIso,
  startOfLocalDay,
  tenantTodayDay,
} from "../common/calendar-date";

/**
 * SA-1211 A1.3: what a buyer has SPENT. The ONE definition, read by the portal's analytics
 * (`GET /buyer/analytics`) and the portal dashboard's spend strip:
 *
 *   spend = roundMoney(Σ total of the buyer's ISSUED invoices) less roundMoney(Σ posted, non-void credit notes)
 *
 * - Orders are never summed. An order that became an invoice is counted once, through the invoice, and a
 *   counter sale is counted through the one invoice it writes.
 * - ISSUED means SENT, VIEWED, PARTIAL, PAID, OVERDUE or WRITTEN_OFF (the owner: "non-void"). VOID and DRAFT
 *   were never a sale. A written-off invoice was still a sale; the write-off is a loss, not a refund.
 * - A posted credit note (ISSUED or APPLIED, not VOID) comes off: a $40 return later spent as credit would
 *   otherwise count $140 against $100 actually spent.
 * - Days are the TENANT's days. `Invoice.issueDate` is already the tenant's calendar day (a UTC-midnight stamp);
 *   a credit note's `createdAt` and an order's `createdAt` are real instants, read in the tenant's zone.
 */
export const SPEND_INVOICE_STATUSES = [
  InvoiceStatus.SENT,
  InvoiceStatus.VIEWED,
  InvoiceStatus.PARTIAL,
  InvoiceStatus.PAID,
  InvoiceStatus.OVERDUE,
  InvoiceStatus.WRITTEN_OFF,
] as const;

export const SPEND_CREDIT_NOTE_STATUSES = [
  CreditNoteStatus.ISSUED,
  CreditNoteStatus.APPLIED,
] as const;

/** Orders that count as orders (Avg order value, the order count): not cancelled, not a draft. */
const COUNTED_ORDER_STATUSES = ["CANCELLED", "DRAFT"] as const;

/** The slice of the tenant-scoped client the spend readers use. Structural, like `ExposureDb`. */
export interface SpendTotalsDb {
  invoice: { aggregate(args: any): PromiseLike<any> };
  creditNote: { aggregate(args: any): PromiseLike<any> };
}
export interface SpendDb {
  invoice: SpendTotalsDb["invoice"] & { findMany(args: any): PromiseLike<any[]> };
  creditNote: SpendTotalsDb["creditNote"] & { findMany(args: any): PromiseLike<any[]> };
  order: { aggregate(args: any): PromiseLike<any>; findMany(args: any): PromiseLike<any[]> };
}

export interface MonthlySpend {
  /** YYYY-MM in the tenant's zone. */
  month: string;
  spend: number;
  /** Orders placed that month (counted, never summed); the chart does not draw it. */
  orderCount: number;
}

const sumOf = (agg: any, field: string): number => Number(agg?._sum?.[field] ?? 0);

/** The tenant calendar day `days` before `now` (YYYY-MM-DD). */
export function tenantDayBefore(zone: string | null, days: number, now: Date = new Date()): string {
  const today = new Date(`${tenantTodayDay(zone, now)}T00:00:00.000Z`);
  return addCalendarDays(today, -days).toISOString().slice(0, 10);
}

/**
 * Spend from `sinceDay` (a tenant calendar day, inclusive) to now; all time when omitted.
 * Invoices are floored on the issue day, credit notes on the instant their day starts in the zone.
 */
export async function buyerSpendTotal(
  db: SpendTotalsDb,
  customerId: string,
  zone: string | null,
  sinceDay?: string,
): Promise<number> {
  const [invoices, notes] = await Promise.all([
    db.invoice.aggregate({
      where: {
        customerId,
        status: { in: [...SPEND_INVOICE_STATUSES] },
        ...(sinceDay ? { issueDate: { gte: new Date(`${sinceDay}T00:00:00.000Z`) } } : {}),
      },
      _sum: { total: true },
    }),
    db.creditNote.aggregate({
      where: {
        customerId,
        status: { in: [...SPEND_CREDIT_NOTE_STATUSES] },
        ...(sinceDay ? { createdAt: { gte: startOfLocalDay(sinceDay, zone) } } : {}),
      },
      _sum: { amount: true },
    }),
  ]);
  return roundMoney(roundMoney(sumOf(invoices, "total")) - roundMoney(sumOf(notes, "amount")));
}

/**
 * Everything `GET /buyer/analytics` says about spend and orders: the all-time spend, the last 12 months
 * (this month and the 11 before it, in the tenant's zone, oldest first) and the order-based figures.
 * "Avg order value" is order total over order count; it is never spend divided by anything.
 */
export async function buyerAnalyticsSpend(
  db: SpendDb,
  customerId: string,
  zone: string | null,
  now: Date = new Date(),
) {
  const [year, month] = tenantTodayDay(zone, now).split("-").map(Number);
  const first = new Date(Date.UTC(year, month - 1 - 11, 1));
  const sinceDay = first.toISOString().slice(0, 10);
  const sinceInstant = startOfLocalDay(sinceDay, zone);
  const countedOrders = { customerId, status: { notIn: [...COUNTED_ORDER_STATUSES] } };

  const [totalSpend, invoices, notes, orders, orderTotals] = await Promise.all([
    buyerSpendTotal(db, customerId, zone),
    db.invoice.findMany({
      where: {
        customerId,
        status: { in: [...SPEND_INVOICE_STATUSES] },
        issueDate: { gte: new Date(`${sinceDay}T00:00:00.000Z`) },
      },
      select: { issueDate: true, total: true },
    }),
    db.creditNote.findMany({
      where: {
        customerId,
        status: { in: [...SPEND_CREDIT_NOTE_STATUSES] },
        createdAt: { gte: sinceInstant },
      },
      select: { createdAt: true, amount: true },
    }),
    db.order.findMany({
      where: { ...countedOrders, createdAt: { gte: sinceInstant } },
      select: { createdAt: true },
    }),
    db.order.aggregate({ where: countedOrders, _sum: { total: true }, _count: true }),
  ]);

  const months = new Map<string, { spend: number; orderCount: number }>();
  const bucket = (key: string) => {
    const hit = months.get(key) ?? { spend: 0, orderCount: 0 };
    months.set(key, hit);
    return hit;
  };
  for (const i of invoices)
    bucket(calendarDateFromIso(i.issueDate).slice(0, 7)).spend += Number(i.total);
  for (const n of notes)
    bucket(tenantTodayDay(zone, n.createdAt).slice(0, 7)).spend -= Number(n.amount);
  for (const o of orders) bucket(tenantTodayDay(zone, o.createdAt).slice(0, 7)).orderCount += 1;

  const monthlySpend: MonthlySpend[] = [...months.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([m, v]) => ({ month: m, spend: roundMoney(v.spend), orderCount: v.orderCount }));

  const totalOrders = Number(orderTotals?._count) || 0;
  const avgOrderValue = totalOrders > 0 ? roundMoney(sumOf(orderTotals, "total") / totalOrders) : 0;
  return { totalSpend, monthlySpend, totalOrders, avgOrderValue };
}
