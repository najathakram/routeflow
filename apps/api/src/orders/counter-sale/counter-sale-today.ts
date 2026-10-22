import {
  FulfillPath,
  InvoiceStatus,
  OrderStatus,
  PaymentStatus,
  ReturnStatus,
  type Prisma,
} from "@prisma/client";
import {
  COUNTER_DEFAULT_REGISTER,
  ROW_ITEM_NAMES_MAX,
  billedChargeLines,
  cashierNameOf,
  counterTenderSplit,
  isOwnReturn,
  returnSettlement,
  settlementTotals,
  type SettlementCreditNote,
  foldItemNames,
  roundMoney,
  storedTaxRatePercent,
  sumConfirmed,
} from "@routeflow/pricing";
import type {
  TodaysHandOverRow,
  TodaysSaleMethod,
  TodaysSalePaymentState,
  TodaysSaleReturn,
  TodaysSaleReturnResolution,
  TodaysSaleReturnState,
  TodaysSaleRow,
  TodaysSalesSummary,
} from "@routeflow/types";
import { ACCRUAL_CREDIT_NOTE_FILTER } from "../../common/invoiced-sales";
import { counterMethodOf, servedChange } from "./counter-sale-readback";
import { DEAD_RETURN_STATUSES } from "../../returns/return-statuses";
import { refundTenderOfColumn } from "../../returns/refund-tender";
import { isCounterTenderRow } from "./counter-tender-row";

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

export interface DayWindow {
  /** inclusive */
  start: Date;
  /** exclusive */
  end: Date;
}

const DEAD_INVOICE_STATUSES = [InvoiceStatus.VOID, InvoiceStatus.WRITTEN_OFF];
/** Returns that moved no money and never will; shared with the invoice void guard (`CASH_REFUNDED_RETURN_WHERE`). */
export { DEAD_RETURN_STATUSES };

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
      // ONE rule with the day close (row 374): cash that was taken stays in the day when the office later WRITES the invoice
      // off; only a VOID invoice drops its payments. (The day's SALES count still treats a written-off sale as dead.)
      status: { not: InvoiceStatus.VOID },
      order: liveCounterOrderAnyDayWhere(tenantId),
    },
  };
}

/**
 * HAND-OVERS (SA-763r R7): the PAID payments that CAME IN in the window on the tender of a POS-mode pickup
 * hand-over: invoices of a PICKUP order that is NOT a counter sale (a counter sale is `salePaymentsWhere`'s,
 * so the two sets are disjoint and nothing is counted twice). This is only the CANDIDATE query: whether a
 * payment is the hand-over's own tender (not a deposit or a later payment on the same invoice) is the v5
 * group id, which no SQL predicate can express, so `handOverPayments` filters in code. Bounded by the day's
 * PICKUP payments.
 */
export function handOverCandidatesWhere(tenantId: string, w: DayWindow) {
  return {
    tenantId,
    status: PaymentStatus.PAID,
    paidAt: { gte: w.start, lt: w.end },
    paymentGroupId: { not: null },
    invoice: {
      tenantId,
      // the day close's own rules (row 374 b): cash taken stays in the day when the office later WRITES the invoice off (only
      // a VOID invoice drops its payments), and a CANCELLED order's money is not the day's
      status: { not: InvoiceStatus.VOID },
      order: {
        tenantId,
        fulfillPath: FulfillPath.PICKUP,
        counterSale: false,
        status: { not: OrderStatus.CANCELLED },
      },
    },
  };
}

/**
 * The fields the shared classification (`groupWindowPayments`) reads off a counter sale's payment row: the same predicate
 * the Z report folds with, so Today's money in and the Z cannot disagree about what is till money (row 374 a).
 */
export const salePaymentSelect = {
  amount: true,
  method: true,
  status: true,
  paymentGroupId: true,
  checkStatus: true,
  invoice: { select: { orderId: true } },
} as const;

/**
 * What a hand-over ROW needs on top of the summary's method / amount / group id: when the tender came in and the
 * order's number, register, cashier (the username only: row 317's rule, never an email) and customer name. ONE
 * read for both the summary and the rows (row 342): no extra query.
 */
export const handOverCandidateSelect = {
  method: true,
  amount: true,
  paidAt: true,
  paymentGroupId: true,
  status: true,
  checkStatus: true,
  invoice: {
    select: {
      orderId: true,
      order: {
        select: {
          orderNumber: true,
          registerKey: true,
          soldBy: { select: { username: true } },
          customer: { select: { businessName: true } },
        },
      },
    },
  },
} satisfies Prisma.InvoicePaymentSelect;

/** The order a hand-over tender sits on, as the candidate select reads it (all optional: a hand-built record may omit it). */
export interface HandOverOrder {
  orderNumber?: string | null;
  registerKey?: string | null;
  soldBy?: { username?: string | null } | null;
  customer?: { businessName?: string | null } | null;
}

/** One payment that is a hand-over's own tender. */
export interface HandOverPayment {
  method: string;
  amount: unknown;
  orderId: string;
  /** when the tender was recorded (absent on a hand-built record) */
  paidAt?: Date;
  order?: HandOverOrder | null;
}

/**
 * The candidates that ARE a hand-over's own tender: the ONE tender predicate the day close folds with (`isCounterTenderRow`,
 * told the order is a POS pickup, not a counter sale), never a second group-id rule. A deposited / cleared check or a method
 * the till does not take reads as foreign here exactly as it does in the Z report.
 */
export function handOverPayments(
  rows: ReadonlyArray<{
    method: string;
    amount: unknown;
    paymentGroupId: string | null;
    /** absent on a hand-built record: the candidate query is PAID-only, so absent reads PAID */
    status?: string;
    checkStatus?: string | null;
    paidAt?: Date;
    invoice: { orderId: string | null; order?: HandOverOrder | null } | null;
  }>,
): HandOverPayment[] {
  return rows.flatMap((r) => {
    const orderId = r.invoice?.orderId;
    return orderId &&
      isCounterTenderRow(
        orderId,
        {
          method: r.method,
          status: r.status ?? "PAID",
          paymentGroupId: r.paymentGroupId,
          checkStatus: r.checkStatus ?? null,
        },
        { counterSale: false },
      )
      ? [
          {
            method: r.method,
            amount: r.amount,
            orderId,
            ...(r.paidAt ? { paidAt: r.paidAt } : {}),
            ...(r.invoice?.order ? { order: r.invoice.order } : {}),
          },
        ]
      : [];
  });
}

/** The most hand-over rows one response carries (a day's few hand-overs; `summary.handOvers` is the whole-day figure). */
export const HAND_OVER_ROWS_MAX = 200;

/**
 * The day's hand-overs as ROWS (row 342): one per order, folded from the SAME filtered tenders `foldSummary` totals
 * (`handOverPayments`' output), so the rows' order count is `summary.handOvers.count` and their amounts sum to
 * `summary.handOvers.total` (until the 200-row bound). The method split uses the till's own mapping
 * (`todaysMethodOf`); `paidAt` is the latest tender in the window; an unstamped register reads as "main"; an
 * unstamped or email-like cashier is null (`cashierNameOf`). Newest first, then order id (a stable tie-break).
 */
export function toHandOverRows(handOvers: readonly HandOverPayment[]): TodaysHandOverRow[] {
  const byOrder = new Map<
    string,
    {
      order: HandOverOrder | null | undefined;
      amount: number;
      paidAt: number;
      methods: Map<TodaysSaleMethod, number>;
    }
  >();
  for (const h of handOvers) {
    const g = byOrder.get(h.orderId) ?? {
      order: h.order,
      amount: 0,
      paidAt: Number.NEGATIVE_INFINITY,
      methods: new Map<TodaysSaleMethod, number>(),
    };
    const amount = num(h.amount);
    g.amount = roundMoney(g.amount + amount);
    const m = todaysMethodOf(h.method);
    g.methods.set(m, roundMoney((g.methods.get(m) ?? 0) + amount));
    if (h.paidAt && h.paidAt.getTime() > g.paidAt) g.paidAt = h.paidAt.getTime();
    g.order ??= h.order;
    byOrder.set(h.orderId, g);
  }
  return (
    [...byOrder.entries()]
      // a tender with no recorded time is no row (never an invented 1970 one); the query's own window filter means a real one has it
      .filter(([, g]) => Number.isFinite(g.paidAt))
      .map(([orderId, g]): TodaysHandOverRow => {
        const registerKey = (g.order?.registerKey ?? "").trim();
        return {
          orderId,
          orderNumber: g.order?.orderNumber ?? "",
          customerName: g.order?.customer?.businessName ?? "",
          paidAt: new Date(g.paidAt).toISOString(),
          amount: g.amount,
          methods: METHOD_ORDER.flatMap((method) => {
            const a = g.methods.get(method) ?? 0;
            return a > 0 ? [{ method, amount: a }] : [];
          }),
          registerKey: registerKey || COUNTER_DEFAULT_REGISTER,
          handedOverBy: cashierNameOf(g.order?.soldBy),
        };
      })
      .sort((a, b) =>
        a.paidAt === b.paidAt
          ? a.orderId < b.orderId
            ? -1
            : a.orderId > b.orderId
              ? 1
              : 0
          : a.paidAt < b.paidAt
            ? 1
            : -1,
      )
      .slice(0, HAND_OVER_ROWS_MAX)
  );
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
 * `select`, never `include`: only each line's description and qty (the row's item names), no cost or margin field.
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
      // row 317: the cashier's username only (their display name); never the email or any other user column
      soldBy: { select: { username: true } },
      invoices: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true,
          invoiceNumber: true,
          status: true,
          payments: {
            orderBy: { createdAt: "asc" },
            // B1262 / SA-838: the credit note each payment applied and the invoice that NOTE was issued against: the
            // first link of "this payment is the sale's own return credit" (same query: no extra read).
            select: {
              method: true,
              amount: true,
              status: true,
              creditNoteId: true,
              creditNote: { select: { invoiceId: true } },
            },
          },
          // the stored line rates the sale's tax rate is read from (pricing's storedTaxRatePercent), and the
          // levy each line billed with its category (CQ-03: named charges on the reprint)
          // R7b 2.1: description + qty name the sale on its row (the snapshot taken at sale time); the fold keeps the first few.
          // No `take` here: the same items feed the tax-rate and levy reads above, which need every line.
          items: {
            select: {
              description: true,
              qty: true,
              boxes: true,
              pieces: true,
              unitLabel: true,
              taxRate: true,
              categoryTaxAmount: true,
              trackedCategoryId: true,
              categoryTaxType: true,
              trackedCategory: { select: { id: true, name: true, taxType: true } },
            },
          },
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
          // B1262 / SA-838: the second link. An INLINE return counts as this order's only through an item sold on it.
          kind: true,
          // plus each item's priced amount: an INLINE return is worth its items (returnSettlement), never a proration
          items: {
            select: { sourceOrderId: true, subtotal: true, taxAmount: true, categoryTax: true },
          },
        },
      },
    },
  } satisfies Prisma.OrderFindManyArgs;
}

/**
 * B1262 / SA-838 (e): the returns behind the page's credit-note payments, ONE batched read after the page query. Neither
 * `Return.creditNoteId` nor `ReturnItem.sourceOrderId` has a Prisma relation, so an INLINE return carried on ANOTHER order and
 * sold on a page sale is only reachable by the credit note it made. The ids list must be a real, non-empty array: an
 * undefined `in` would be dropped by Prisma and widen this to every return of the tenant.
 */
export function carriedReturnWhere(tenantId: string, creditNoteIds: readonly string[]) {
  if (!creditNoteIds || creditNoteIds.length === 0) {
    throw new Error("carriedReturnWhere needs at least one credit note id");
  }
  return { tenantId, creditNoteId: { in: [...creditNoteIds] } };
}

export const carriedReturnSelect = {
  id: true,
  creditNoteId: true,
  orderId: true,
  kind: true,
  status: true,
  refundMethod: true,
  refundedAt: true,
  items: {
    select: { sourceOrderId: true, subtotal: true, taxAmount: true, categoryTax: true },
  },
} satisfies Prisma.ReturnSelect;

/** The distinct credit note ids the page's PAID-or-not payments applied (dead invoices included: provenance decides). */
export function pageCreditNoteIds(rows: readonly TodayOrderRecord[]): string[] {
  const ids = new Set<string>();
  for (const o of rows) {
    for (const i of o.invoices) {
      for (const p of i.payments) if (p.creditNoteId) ids.add(p.creditNoteId);
    }
  }
  return [...ids];
}

/**
 * SA-838a I2: every credit note id the page's returns and payments refer to, for the ONE batched read of the notes: the
 * page payments' notes, each page return's own note and each carried return's note. A kept credit is reachable only through
 * its return's `creditNoteId`, a spent one through the note's payments.
 */
export function creditNoteIdsToRead(
  rows: readonly TodayOrderRecord[],
  carried: readonly ReturnProvenance[],
): string[] {
  const ids = new Set(pageCreditNoteIds(rows));
  for (const o of rows) for (const r of o.returns) if (r.creditNoteId) ids.add(r.creditNoteId);
  for (const r of carried) if (r.creditNoteId) ids.add(r.creditNoteId);
  return [...ids];
}

/** The note read: tenant-scoped, one id list. An undefined `in` would be dropped by Prisma and widen it to every note. */
export function creditNoteReadWhere(tenantId: string, ids: readonly string[]) {
  if (!ids || ids.length === 0) throw new Error("creditNoteReadWhere needs at least one id");
  return { tenantId, id: { in: [...ids] } };
}

/** status + amount + the invoice, and the PAID payments applied to the note on ANY sale (same select: no second query). */
export const creditNoteReadSelect = {
  id: true,
  status: true,
  amount: true,
  invoiceId: true,
  invoicePayments: { where: { status: "PAID" }, select: { amount: true, invoiceId: true } },
} satisfies Prisma.CreditNoteSelect;

/** A credit note as the read saw it, with where each PAID application sits (the row decides which are on its own invoices). */
export interface CreditNoteFact extends SettlementCreditNote {
  applications?: ReadonlyArray<{ amount: unknown; invoiceId: string | null }>;
}

/** The fact as `returnSettlement` takes it: how much of the note's application sits on this order's own invoices. */
function settlementNote(
  fact: CreditNoteFact | undefined,
  orderInvoiceIds: ReadonlySet<string>,
): SettlementCreditNote | null {
  if (!fact) return null;
  const { status, appliedAnywhere, applications } = fact;
  return {
    status,
    appliedAnywhere,
    ...(applications
      ? {
          appliedOnThisOrder: roundMoney(
            applications
              .filter((a) => !!a.invoiceId && orderInvoiceIds.has(a.invoiceId))
              .reduce((s, a) => s + num(a.amount), 0),
          ),
        }
      : {}),
  };
}

/** The read's rows as facts: status, the PAID amount applied anywhere in cents, and each application's invoice. */
export function creditNoteFacts(
  rows: ReadonlyArray<{
    id: string;
    status: string;
    invoicePayments?: ReadonlyArray<{ amount: unknown; invoiceId?: string | null }>;
  }>,
): Map<string, CreditNoteFact> {
  return new Map(
    rows.map((n) => [
      n.id,
      {
        status: n.status,
        appliedAnywhere: roundMoney(
          (n.invoicePayments ?? []).reduce((s, p) => s + num(p.amount), 0),
        ),
        applications: (n.invoicePayments ?? []).map((p) => ({
          amount: p.amount,
          invoiceId: p.invoiceId ?? null,
        })),
      },
    ]),
  );
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));

// ─── Row ──────────────────────────────────────────────────────────────────────────────────────

/** The page query's row, read with `select` (line descriptions and qty only; no cost / margin fields). */
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
  /** row 317: the staff user who rang the sale (`Order.soldBy`); null/absent on a sale rung before it was stamped */
  soldBy?: { username: string | null } | null;
  invoices: Array<{
    id: string;
    invoiceNumber: string | null;
    status: string;
    payments: Array<{
      method: string;
      amount: unknown;
      status: string;
      /** B1262 / SA-838: the credit note this payment applied, and the invoice that note was issued against */
      creditNoteId?: string | null;
      creditNote?: { invoiceId: string | null } | null;
    }>;
    /** SA-764: each line's stored tax rate (a fraction, 0.0825); CQ-03: its billed levy and category */
    items?: Array<{
      /** R7b 2.1: the line's snapshotted description and qty (the row's item names) */
      description?: string | null;
      qty?: unknown;
      /** N4: the line's own boxed split and selling unit, so the row reads "2 Cases" like the receipt */
      boxes?: number | null;
      pieces?: number | null;
      unitLabel?: string | null;
      taxRate: unknown;
      categoryTaxAmount?: unknown;
      trackedCategoryId?: string | null;
      categoryTaxType?: string | null;
      trackedCategory?: {
        id?: string | null;
        name?: string | null;
        taxType?: string | null;
      } | null;
    }>;
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
    /** B1262 / SA-838: STANDARD (absent reads STANDARD) or INLINE, and its items' source orders */
    kind?: string;
    items?: ReadonlyArray<{
      sourceOrderId?: string | null;
      subtotal?: unknown;
      taxAmount?: unknown;
      categoryTax?: unknown;
    }>;
  }>;
}

/**
 * The sale's money labels, in the order a receipt lists them (prepaid advance first). The shared list in
 * @routeflow/types (`TODAYS_SALE_METHOD_VALUES`) is the twin the API never value-imports (L-261); a parity spec pins the two equal.
 */
export const TODAYS_SALE_METHOD_ORDER: readonly TodaysSaleMethod[] = [
  "ADVANCE",
  "CASH",
  "CARD",
  "CHECK",
  "OTHER",
  "STORE_CREDIT",
];
const METHOD_ORDER = TODAYS_SALE_METHOD_ORDER;

/**
 * A stored payment method as the till names it: CASH / CARD / CHECK, a credit-note application (STORE_CREDIT), an advance
 * application (ADVANCE: the customer's prepaid money, its own label since SA-838), anything else.
 */
export function todaysMethodOf(prismaMethod: string): TodaysSaleMethod {
  if (prismaMethod === "ADVANCE") return "ADVANCE";
  if (prismaMethod === "CREDIT_NOTE") return "STORE_CREDIT";
  const method = counterMethodOf(prismaMethod);
  // ON_ACCOUNT is not money taken at the till; anything the till does not name is OTHER.
  return method && method !== "ON_ACCOUNT" ? method : "OTHER";
}

function resolutionOf(r: {
  status: string;
  refundMethod?: string | null;
  refundedAt?: Date | null;
  creditNoteId?: string | null;
}): TodaysSaleReturnResolution {
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

/** One return, as far as "whose return is this, and what is it worth" needs it. */
export interface ReturnProvenance {
  /** absent on a hand-built record; when set, a return seen twice (the page's own and the batched read) counts once */
  id?: string;
  creditNoteId: string | null;
  /** SA-838a: that note as the batched read saw it (absent = not seen = not settled; VOID = dead) */
  creditNote?: SettlementCreditNote | null;
  /** the order the return is filed on (for an INLINE return, the CARRYING order) */
  orderId: string;
  /** STANDARD (absent reads STANDARD) or INLINE */
  kind?: string;
  status: string;
  /** how it was settled, for the "Refunded" label (`resolutionOf`) */
  refundMethod?: string | null;
  refundedAt?: Date | null;
  /** a STANDARD return's worth (`returnAmount`); an INLINE return is worth its items' amounts instead */
  amount?: unknown;
  /** the return's items; an INLINE one is sold per line through `sourceOrderId` and priced per item */
  items?: ReadonlyArray<{
    sourceOrderId?: string | null;
    subtotal?: unknown;
    taxAmount?: unknown;
    categoryTax?: unknown;
  }>;
}

/**
 * B1262 / SA-838: which credit notes applied to this sale are its OWN return credit (the return settling the invoice).
 * BOTH links must agree or the payment stays a tender (never hide money):
 *   1. the payment's credit note was made by a live return of THIS order (`isOwnReturn` in pricing, the ONE predicate: a
 *      STANDARD return filed on it, or an INLINE return, filed on any order, with an item sold on it); and
 *   2. that credit note was issued against one of this order's invoices (`CreditNote.invoiceId`).
 * A rejected or cancelled return proves nothing. `Return.creditNoteId` has no Prisma relation, so the caller supplies the
 * returns (this order's own, plus the INLINE ones the batched read finds).
 */
export function ownReturnCreditNoteIds(input: {
  orderId: string;
  invoiceIds: readonly string[];
  payments: ReadonlyArray<{
    creditNoteId?: string | null;
    creditNote?: { invoiceId: string | null } | null;
  }>;
  returns: readonly ReturnProvenance[];
}): Set<string> {
  const madeByThisOrder = new Set(
    input.returns
      .filter((r) => r.creditNoteId && !isDeadReturn(r.status) && isOwnReturn(input.orderId, r))
      .map((r) => r.creditNoteId as string),
  );
  const own = new Set<string>();
  for (const p of input.payments) {
    const invoiceId = p.creditNote?.invoiceId;
    if (
      p.creditNoteId &&
      madeByThisOrder.has(p.creditNoteId) &&
      invoiceId &&
      input.invoiceIds.includes(invoiceId)
    ) {
      own.add(p.creditNoteId);
    }
  }
  return own;
}

export function toTodaysSaleRow(
  o: TodayOrderRecord,
  /** the tenant's configured rate in percent (`settings.taxRate`): a stored line rate is named only when it equals this */
  configuredTaxPercent: number | null = null,
  /** INLINE returns filed on OTHER orders that may have been sold on this one (see `ownReturnCreditNoteIds`) */
  carriedReturns: readonly ReturnProvenance[] = [],
  /** SA-838a: the ONE batched credit-note read, by note id (see `creditNoteFacts`) */
  creditNotes: ReadonlyMap<string, CreditNoteFact> = new Map(),
): TodaysSaleRow {
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

  // B1262 / SA-838 + SA-838a: the sale's own return credit is not a tender. One provenance read, ONE settlement per own
  // return (pricing's returnSettlement), then the ONE pricing split over those settlements. Nothing else derives these figures.
  // EVERY invoice of this order, live or dead: an application on any of them is never "elsewhere"
  const thisOrderInvoiceIds = new Set(o.invoices.map((i) => i.id));
  const provenance = dedupeById<ReturnProvenance>([
    ...o.returns.map((r) => ({ ...r, orderId: o.id, amount: returnAmount(r) })),
    ...carriedReturns,
  ]).map((r) => ({
    ...r,
    // the batched read's answer; a note it did not return stays absent (returnSettlement: not settled, never kept)
    creditNote: r.creditNoteId
      ? settlementNote(creditNotes.get(r.creditNoteId), thisOrderInvoiceIds)
      : null,
  }));
  const ownCreditNoteIds = ownReturnCreditNoteIds({
    orderId: o.id,
    invoiceIds: o.invoices.map((i) => i.id),
    payments,
    returns: provenance,
  });
  // the payments PROVEN to be this order's own return credit (both links agree); every other payment is a tender
  const ownCreditPayments = payments.filter(
    (p) => !!p.creditNoteId && ownCreditNoteIds.has(p.creditNoteId),
  );
  const settlements = provenance
    .filter((r) => isOwnReturn(o.id, r))
    .map((r) => returnSettlement(r, ownCreditPayments, o.id));
  const split = counterTenderSplit(
    payments.map((p) => ({ ...p, method: todaysMethodOf(p.method) })),
    settlements,
    METHOD_ORDER,
  );
  const totals = settlementTotals(settlements);

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
  // a voided sale has no live invoice: its names still come from the invoices it had (tax and levy reads stay on live)
  const names = itemNamesOf((live.length > 0 ? live : o.invoices).flatMap((i) => i.items ?? []));
  return {
    orderId: o.id,
    orderNumber: o.orderNumber ?? "",
    invoiceId: shown?.id ?? null,
    invoiceNumber: shown?.invoiceNumber ?? null,
    createdAt: o.createdAt.toISOString(),
    customerId: o.customerId,
    customerName: o.customer?.businessName ?? "",
    isWalkIn,
    cashierName: cashierNameOf(o.soldBy),
    status: o.status,
    total,
    paid,
    balanceDue,
    methods,
    tenderPaid: split.tenderPaid,
    returnCredit: split.returnCredit,
    tenderMethods: split.methods,
    returnLines: {
      applied: totals.applied,
      refunded: totals.refunded,
      kept: totals.kept,
      used: totals.used,
      pending: totals.pending,
    },
    paymentState,
    cashTendered: o.counterCashTendered == null ? null : roundMoney(num(o.counterCashTendered)),
    change: servedChange(o.counterCashTendered, payments, balanceDue),
    // ONE home for the rate (pricing): a STORED line rate, corroborated by the configured rate; never inferred
    taxRatePercent: storedTaxRatePercent(
      live.map((i) => ({ lines: i.items ?? [] })),
      configuredTaxPercent,
    ),
    // CQ-03: the deposit / excise the live invoices billed, each its own named charge
    charges: billedChargeLines(live.flatMap((i) => i.items ?? [])),
    returned: { amount: returnedAmount, state: returnState, returns },
    voided,
    ...names,
  };
}

/** A return the page and the batched read both carry counts once (by id); a record with no id is kept as is. */
function dedupeById<T extends { id?: string }>(rows: T[]): T[] {
  const seen = new Set<string>();
  return rows.filter((r) => {
    if (!r.id) return true;
    if (seen.has(r.id)) return false;
    seen.add(r.id);
    return true;
  });
}

/** The first few line names + qty and the line count (one shared fold with the parked list); `{}` when no lines are named. */
function itemNamesOf(
  lines: ReadonlyArray<{
    description?: string | null;
    qty?: unknown;
    boxes?: unknown;
    pieces?: unknown;
    unitLabel?: string | null;
  }>,
) {
  return foldItemNames(
    lines.map((l) => ({ ...l, name: l.description })),
    ROW_ITEM_NAMES_MAX,
  );
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
  /** SA-740r2: `Return.refundTender` (PaymentMethod) of a recorded refund; null = no tender recorded. The ONLY tender source. */
  refundTender?: string | null;
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
  /** the hand-over tenders that came in in the window (already filtered by `handOverPayments`) */
  handOvers?: readonly HandOverPayment[];
}): TodaysSalesSummary {
  const by: Record<TodaysSaleMethod, number> = {
    ADVANCE: 0,
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
  // SA-763r R7: a POS-mode hand-over's tender is money in and cash in the drawer, like a counter sale's.
  const handOvers = input.handOvers ?? [];
  let handOverTotal = 0;
  for (const h of handOvers) {
    const m = todaysMethodOf(h.method);
    by[m] = roundMoney(by[m] + num(h.amount));
    handOverTotal = roundMoney(handOverTotal + num(h.amount));
  }
  const moneyIn = {
    cash: by.CASH,
    card: by.CARD,
    check: by.CHECK,
    other: by.OTHER,
    total: roundMoney(by.CASH + by.CARD + by.CHECK + by.OTHER),
  };
  const salesTotal = roundMoney(num(input.sales._sum?.total));

  // SA-740r2: a refund's tender is READ ONLY from `Return.refundTender` (no audit-meta read). A null / unknown tender is
  // `other`, never guessed to be cash; `tenderKnown` is computed per window: no refund in it lacks a tender.
  const refunds = { count: 0, cash: 0, card: 0, check: 0, other: 0, total: 0, tenderKnown: true };
  let creditCount = 0;
  let creditAmount = 0;
  for (const r of input.returns) {
    if (r.refundMethod === REFUND_METHOD_EXTERNAL) {
      const amount = num(r.refundAmount);
      const tender = refundTenderOfColumn(r.refundTender);
      refunds.count += 1;
      refunds.total = roundMoney(refunds.total + amount);
      if (tender === "CASH") refunds.cash = roundMoney(refunds.cash + amount);
      else if (tender === "CARD") refunds.card = roundMoney(refunds.card + amount);
      else if (tender === "CHECK") refunds.check = roundMoney(refunds.check + amount);
      else {
        refunds.other = roundMoney(refunds.other + amount);
        refunds.tenderKnown = false;
      }
    } else if (r.refundMethod === REFUND_METHOD_CREDIT_NOTE) {
      creditCount += 1;
      creditAmount = roundMoney(creditAmount + returnAmount(r));
    }
  }
  return {
    sales: { count: countOf(input.sales._count), total: salesTotal },
    moneyIn,
    handOvers: { count: new Set(handOvers.map((h) => h.orderId)).size, total: handOverTotal },
    // credit-note and advance applications together, as before ADVANCE became its own display method (SA-838)
    storeCreditUsed: roundMoney(by.STORE_CREDIT + by.ADVANCE),
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
