import {
  InvoiceStatus,
  OrderStatus,
  PaymentStatus,
  ReturnStatus,
  type Prisma,
} from "@prisma/client";
import { roundMoney, sumConfirmed } from "@routeflow/pricing";
import type {
  TodaysSaleMethod,
  TodaysSalePaymentState,
  TodaysSaleReturn,
  TodaysSaleReturnResolution,
  TodaysSaleReturnState,
  TodaysSaleRow,
  TodaysSalesSummary,
} from "@routeflow/types";
import { saleTaxRatePercent } from "./counter-sale-tax-rate";
import { ACCRUAL_CREDIT_NOTE_FILTER } from "../../common/invoiced-sales";
import { counterMethodOf, storedChange } from "./counter-sale-readback";

/**
 * Today's sales (GET /orders/counter-sale/today): the PURE half. Everything that decides a figure lives here
 * so the unit specs can pin it without a database: the where-builders (ONE definition of "a counter sale of the
 * day", shared by the page, the count and every summary query: L-167), the per-sale row fold and the
 * whole-day summary fold. Every money figure goes through roundMoney; PAID payments only (sumConfirmed rule:
 * DRAFT / PENDING / VOID never count).
 */

export const TODAYS_SALES_DEFAULT_LIMIT = 50;
/** A till page, far below the shared MAX_LIST_LIMIT (1000). */
export const TODAYS_SALES_MAX_LIMIT = 100;

/** `Return.refundMethod` values (a String column, validated at the DTO edge): see schema `Return.refundMethod`. */
export const REFUND_METHOD_EXTERNAL = "EXTERNAL_REFUND";
export const REFUND_METHOD_CREDIT_NOTE = "CREDIT_NOTE";

/**
 * Is the TENDER of an external refund stored in a column? Not yet: it lives only in the audit row's meta. While
 * false the summary reports every refund by AMOUNT only (in `refunds.other`) and `cashExpectedInDrawer` does not
 * subtract it. Flip together with a `Return.refundTender` column (its own migration), then split the fold below.
 */
export const REFUND_TENDER_KNOWN = false;

export interface DayWindow {
  /** inclusive */
  start: Date;
  /** exclusive */
  end: Date;
}

const DEAD_INVOICE_STATUSES = [InvoiceStatus.VOID, InvoiceStatus.WRITTEN_OFF];
/** Returns that moved no money and never will; shared with the invoice void guard (`CASH_REFUNDED_RETURN_WHERE`). */
export const DEAD_RETURN_STATUSES = [ReturnStatus.REJECTED, ReturnStatus.CANCELLED];

const isDeadInvoice = (status: string) =>
  (DEAD_INVOICE_STATUSES as readonly string[]).includes(status);
const isDeadReturn = (status: string) =>
  (DEAD_RETURN_STATUSES as readonly string[]).includes(status);

/** Every counter sale rung in the window (cancelled / void ones included: the page lists them, flagged). */
export function counterSalesWhere(tenantId: string, w: DayWindow) {
  return { tenantId, counterSale: true, createdAt: { gte: w.start, lt: w.end } };
}

/**
 * The sales the SUMMARY counts: not cancelled, with at least one invoice that is not VOID / WRITTEN_OFF. A
 * half-written sale with NO invoice row at all (the first attempt stopped before the invoice step) is therefore
 * LISTED on the page (flagged unpaid) but NOT counted in `sales`: nothing was invoiced, so there is no sale to
 * total yet (a re-POST with the same key finishes it).
 */
export function liveCounterSalesWhere(tenantId: string, w: DayWindow) {
  return {
    ...counterSalesWhere(tenantId, w),
    status: { not: OrderStatus.CANCELLED },
    invoices: { some: { status: { notIn: DEAD_INVOICE_STATUSES } } },
  };
}

/** A counter sale of ANY day that is still a sale: not cancelled (its invoices are filtered separately). */
function liveCounterOrderAnyDayWhere(tenantId: string) {
  return { tenantId, counterSale: true, status: { not: OrderStatus.CANCELLED } };
}

/**
 * MONEY IN, keyed to the day the money CAME IN: PAID payments whose `paidAt` falls in the window, on the live
 * invoices of live counter sales of ANY day (mirrors `windowReturnsWhere`, which keys refunds the same way). A
 * day-1 sale left on account and paid in cash on day 2 counts in day 2's `moneyIn.cash` and
 * `cashExpectedInDrawer`, never in day 1's. `paidAt` is NOT NULL (defaults to now()), so there is no
 * `createdAt` fallback to apply. Belt-and-braces `tenantId` on the nested filters.
 */
export function salePaymentsWhere(tenantId: string, w: DayWindow) {
  return {
    tenantId,
    status: PaymentStatus.PAID,
    paidAt: { gte: w.start, lt: w.end },
    invoice: {
      tenantId,
      status: { notIn: DEAD_INVOICE_STATUSES },
      order: liveCounterOrderAnyDayWhere(tenantId),
    },
  };
}

/**
 * Everything PAID, on any date, on the live invoices of the day's own live sales: what `onAccount` (the day's
 * sales still owed) is measured against. NOT money in (that is `salePaymentsWhere`, by paid date).
 */
export function paidOnDaysSalesWhere(tenantId: string, w: DayWindow) {
  return {
    tenantId,
    status: PaymentStatus.PAID,
    invoice: {
      tenantId,
      status: { notIn: DEAD_INVOICE_STATUSES },
      order: liveCounterSalesWhere(tenantId, w),
    },
  };
}

/**
 * The credit notes CREATED in the window (ids only): the instant a store-credit return was RESOLVED is when its credit
 * note was minted (`returnNettingDate`, sales-facts), not when the return was captured: "Give store credit instead" on a
 * pending refund mints the credit later than the capture. The same accrual predicate as net sales (a VOID note is no credit).
 */
export function creditNotesInWindowWhere(tenantId: string, w: DayWindow) {
  return { tenantId, ...ACCRUAL_CREDIT_NOTE_FILTER, createdAt: { gte: w.start, lt: w.end } };
}

/**
 * Returns on counter-sale orders of ANY day that count in THIS window, each by the day it was RESOLVED: an external
 * refund by `refundedAt` (a PENDING refund, `refundedAt` still null, counts nowhere); a store-credit return by the day its
 * credit note was created (`creditNoteIds` = `creditNotesInWindowWhere`'s ids; `Return.creditNoteId` has no Prisma
 * relation, so the service reads the ids first). A legacy store-credit return with no credit note id keeps the day it
 * was captured (`createdAt`), the only date it has. A return that was rejected or cancelled counts nowhere.
 */
export function windowReturnsWhere(
  tenantId: string,
  w: DayWindow,
  creditNoteIds: readonly string[] = [],
) {
  return {
    tenantId,
    status: { notIn: DEAD_RETURN_STATUSES },
    order: { tenantId, counterSale: true },
    OR: [
      { refundMethod: REFUND_METHOD_EXTERNAL, refundedAt: { gte: w.start, lt: w.end } },
      {
        refundMethod: REFUND_METHOD_CREDIT_NOTE,
        creditNoteId: null,
        createdAt: { gte: w.start, lt: w.end },
      },
      ...(creditNoteIds.length > 0
        ? [{ refundMethod: REFUND_METHOD_CREDIT_NOTE, creditNoteId: { in: [...creditNoteIds] } }]
        : []),
    ],
  };
}

/**
 * The page query, ONE definition: the service sends it and the EXPLAIN spec captures the SQL of exactly it.
 * `select`, never `include`: no line items, no cost or margin field.
 */
export function pageQuery(tenantId: string, w: DayWindow, page: number, limit: number) {
  return {
    where: counterSalesWhere(tenantId, w),
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * limit,
    take: limit,
    select: {
      id: true,
      orderNumber: true,
      status: true,
      total: true,
      createdAt: true,
      customerId: true,
      counterCashTendered: true,
      customer: { select: { businessName: true, isWalkIn: true } },
      invoices: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          invoiceNumber: true,
          status: true,
          payments: { select: { method: true, amount: true, status: true } },
          items: { select: { taxRate: true } },
        },
      },
      returns: {
        select: {
          id: true,
          returnNumber: true,
          status: true,
          refundMethod: true,
          refundedAt: true,
          creditNoteId: true,
          refundAmount: true,
          creditSubtotal: true,
          creditTax: true,
          creditCategoryTax: true,
        },
      },
    },
  } satisfies Prisma.OrderFindManyArgs;
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));

// ─── Row ──────────────────────────────────────────────────────────────────────────────────────

/** The page query's row, read with `select` (no line items, no cost / margin fields). */
export interface TodayOrderRecord {
  id: string;
  orderNumber: string | null;
  status: string;
  total: unknown;
  createdAt: Date;
  customerId: string;
  /** SA-764: the cash handed over (null = not a cash sale / rung before it was stored) */
  counterCashTendered?: unknown;
  customer: { businessName: string | null; isWalkIn: boolean | null } | null;
  invoices: Array<{
    id: string;
    invoiceNumber: string | null;
    status: string;
    payments: Array<{ method: string; amount: unknown; status: string }>;
    /** SA-764: each line's stored tax rate (a fraction, 0.0825) */
    items?: Array<{ taxRate: unknown }>;
  }>;
  returns: Array<{
    id: string;
    returnNumber: string | null;
    status: string;
    refundMethod: string | null;
    /** The page query always selects it (null = not recorded yet); `undefined` (a hand-built record) is not read as pending. */
    refundedAt?: Date | null;
    creditNoteId: string | null;
    refundAmount: unknown;
    creditSubtotal: unknown;
    creditTax: unknown;
    creditCategoryTax: unknown;
  }>;
}

/** The sale's money labels, in the order a receipt lists them. */
const METHOD_ORDER: TodaysSaleMethod[] = ["CASH", "CARD", "CHECK", "OTHER", "STORE_CREDIT"];

/** A stored payment method as the till names it: CASH / CARD / CHECK, a credit application, anything else. */
export function todaysMethodOf(prismaMethod: string): TodaysSaleMethod {
  if (prismaMethod === "CREDIT_NOTE" || prismaMethod === "ADVANCE") return "STORE_CREDIT";
  const method = counterMethodOf(prismaMethod);
  // ON_ACCOUNT is not money taken at the till; anything the till does not name is OTHER.
  return method && method !== "ON_ACCOUNT" ? method : "OTHER";
}

function resolutionOf(r: TodayOrderRecord["returns"][number]): TodaysSaleReturnResolution {
  // A refund chosen at capture but not recorded yet (`refundedAt` null): the clerk still has to hand the money back.
  if (r.refundMethod === REFUND_METHOD_EXTERNAL && r.refundedAt === null) return "PENDING";
  if (r.refundMethod === REFUND_METHOD_EXTERNAL) return "REFUND";
  if (r.refundMethod === REFUND_METHOD_CREDIT_NOTE || r.creditNoteId) return "STORE_CREDIT";
  // Settled with no stored resolution (a legacy return): nothing is waiting on the clerk.
  if (r.status === ReturnStatus.PROCESSED || r.status === ReturnStatus.REFUNDED) return null;
  return "PENDING";
}

/** The money fields a return's priced amount reads (a page row's return and the summary's return query both carry them). */
export interface ReturnMoney {
  refundAmount: unknown;
  creditSubtotal: unknown;
  creditTax: unknown;
  creditCategoryTax: unknown;
}

/**
 * THE one rule for what a return is worth (L-119): its priced credit (subtotal + tax + category tax); a legacy
 * return with no priced split is worth its stored refund amount. Applied PER RETURN by the page rows and by the
 * summary's `storeCreditIssued`, so the two can never disagree.
 */
export function returnAmount(r: ReturnMoney): number {
  const credit = roundMoney(num(r.creditSubtotal) + num(r.creditTax) + num(r.creditCategoryTax));
  return credit > 0 ? credit : roundMoney(num(r.refundAmount));
}

export function toTodaysSaleRow(o: TodayOrderRecord): TodaysSaleRow {
  const live = o.invoices.filter((i) => !isDeadInvoice(i.status));
  const voided = o.status === OrderStatus.CANCELLED || (o.invoices.length > 0 && live.length === 0);
  const payments = live.flatMap((i) => i.payments);
  const total = roundMoney(num(o.total));
  const paid = roundMoney(
    sumConfirmed(payments.map((p) => ({ amount: p.amount, status: p.status }))),
  );
  const balanceDue = Math.max(0, roundMoney(total - paid));
  const isWalkIn = !!o.customer?.isWalkIn;

  const methods = METHOD_ORDER.flatMap((method) => {
    const amount = roundMoney(
      sumConfirmed(payments.filter((p) => todaysMethodOf(p.method) === method)),
    );
    return amount > 0 ? [{ method, amount }] : [];
  });

  // Nothing paid: a named customer left it on account by choice; a walk-in must pay, so no tender is the
  // "payment not recorded" case. Something paid but short is partly paid (the receipt makes the same split).
  let paymentState: TodaysSalePaymentState;
  if (balanceDue <= 0) paymentState = "PAID";
  else if (paid > 0) paymentState = "PARTLY_PAID";
  else paymentState = isWalkIn ? "UNPAID" : "ON_ACCOUNT";

  const liveReturns = o.returns.filter((r) => !isDeadReturn(r.status));
  const returns: TodaysSaleReturn[] = liveReturns.map((r) => ({
    id: r.id,
    returnNumber: r.returnNumber ?? null,
    status: r.status,
    resolution: resolutionOf(r),
    amount: returnAmount(r),
  }));
  const returnedAmount = roundMoney(returns.reduce((s, r) => roundMoney(s + r.amount), 0));
  let returnState: TodaysSaleReturnState;
  if (returns.length === 0) returnState = "NONE";
  else if (returns.some((r) => r.resolution === "PENDING")) returnState = "PENDING";
  else returnState = total > 0 && returnedAmount >= total ? "FULL" : "PARTLY";

  const shown = live[0] ?? o.invoices[0];
  return {
    orderId: o.id,
    orderNumber: o.orderNumber ?? "",
    invoiceId: shown?.id ?? null,
    invoiceNumber: shown?.invoiceNumber ?? null,
    createdAt: o.createdAt.toISOString(),
    customerId: o.customerId,
    customerName: o.customer?.businessName ?? "",
    isWalkIn,
    status: o.status,
    total,
    paid,
    balanceDue,
    methods,
    paymentState,
    cashTendered: o.counterCashTendered == null ? null : roundMoney(num(o.counterCashTendered)),
    change: storedChange(o.counterCashTendered, payments),
    taxRatePercent: saleTaxRatePercent(live.flatMap((i) => i.items ?? [])),
    returned: { amount: returnedAmount, state: returnState, returns },
    voided,
  };
}

// ─── Summary ──────────────────────────────────────────────────────────────────────────────────

/** `order.aggregate` over the live sales. */
export interface SalesAggregate {
  _count?: { _all?: number } | number | null;
  _sum?: { total?: unknown } | null;
}
/** `invoicePayment.groupBy(["method"])` over the PAID payments that came in during the window. */
export interface PaymentGroup {
  method: string;
  _sum?: { amount?: unknown } | null;
}
/** `invoicePayment.aggregate` over everything paid, any date, on the day's own live sales. */
export interface PaidAggregate {
  _sum?: { amount?: unknown } | null;
}
/**
 * One return counted in the window (`return.findMany` over `windowReturnsWhere`: a day's returns are few, and
 * `returnAmount` must apply per return, which a grouped sum cannot do).
 */
export interface WindowReturn extends ReturnMoney {
  refundMethod: string | null;
}

const countOf = (c: { _all?: number } | number | null | undefined): number =>
  typeof c === "number" ? c : (c?._all ?? 0);

/** The whole-day figures, folded from the summary queries (never from the page's rows). */
export function foldSummary(input: {
  sales: SalesAggregate;
  /** money that CAME IN in the window, by payment method */
  payments: readonly PaymentGroup[];
  /** everything paid (any date) on the day's own sales: the `onAccount` measure */
  paidOnSales: PaidAggregate;
  returns: readonly WindowReturn[];
}): TodaysSalesSummary {
  const by: Record<TodaysSaleMethod, number> = {
    CASH: 0,
    CARD: 0,
    CHECK: 0,
    OTHER: 0,
    STORE_CREDIT: 0,
  };
  for (const g of input.payments) {
    const m = todaysMethodOf(g.method);
    by[m] = roundMoney(by[m] + num(g._sum?.amount));
  }
  const moneyIn = {
    cash: by.CASH,
    card: by.CARD,
    check: by.CHECK,
    other: by.OTHER,
    total: roundMoney(by.CASH + by.CARD + by.CHECK + by.OTHER),
  };
  const salesTotal = roundMoney(num(input.sales._sum?.total));

  let refundCount = 0;
  let refundTotal = 0;
  let creditCount = 0;
  let creditAmount = 0;
  for (const r of input.returns) {
    if (r.refundMethod === REFUND_METHOD_EXTERNAL) {
      refundCount += 1;
      refundTotal = roundMoney(refundTotal + num(r.refundAmount));
    } else if (r.refundMethod === REFUND_METHOD_CREDIT_NOTE) {
      creditCount += 1;
      creditAmount = roundMoney(creditAmount + returnAmount(r));
    }
  }
  // Tender not stored (REFUND_TENDER_KNOWN): the whole refund is untendered, so `other`; the drawer figure
  // below cannot subtract it and says so through `tenderKnown`.
  const refunds = {
    count: refundCount,
    cash: 0,
    card: 0,
    check: 0,
    other: refundTotal,
    total: refundTotal,
    tenderKnown: REFUND_TENDER_KNOWN,
  };

  return {
    sales: { count: countOf(input.sales._count), total: salesTotal },
    moneyIn,
    storeCreditUsed: by.STORE_CREDIT,
    onAccount: Math.max(
      0,
      roundMoney(salesTotal - roundMoney(num(input.paidOnSales._sum?.amount))),
    ),
    refunds,
    storeCreditIssued: { count: creditCount, amount: creditAmount },
    cashExpectedInDrawer: roundMoney(moneyIn.cash - refunds.cash),
    netCollected: roundMoney(moneyIn.total - refunds.total),
  };
}
