import { OrderStatus } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";
import { CREDIT_EXPOSURE_EXCLUDED, CREDIT_NOT_APPLICABLE } from "./invoice-status-sets";

/**
 * ONE derivation of a customer's credit exposure (D6 / B462, owner ruling "option B").
 *
 * Consumed by BOTH the hard credit-limit block (`OrdersService.assertWithinCreditLimit`)
 * and the operator statement (`CustomersService.getStatementForOperator`), so the
 * panel can never disagree with the block (lesson L-119: both halves of one money
 * figure derive from ONE collection). Do NOT re-derive any of this at a call site —
 * `credit-exposure-coverage.spec.ts` fails the build if a caller stops using it.
 *
 * Intent: a standalone unissued draft is not a receivable, but DELIVERED goods must never
 * become unguarded. The rules:
 *   1. A DRAFT invoice whose order is OPEN or DELIVERED counts in the hard block — through
 *      its order value, or its draft value where no order value exists — never pending-only.
 *   2. A partially invoiced order counts max(order total, issued + draft for that order)
 *      ONCE, never both (implemented per balance, see the algorithm below).
 *   3. ONLY drafts with NO open or delivered order behind them (standalone / orderId null,
 *      order CANCELLED or DRAFT-status, quotes, bank-import drafts) are excluded from the
 *      block and reported as `pendingExposure`. `isUnbackedDraft` is the single place that
 *      decides this — the customers list Receivables and the CSV export sum `receivableBalance`
 *      (which calls it), so every surface follows the same basis.
 *
 * READ THIS BEFORE "SIMPLIFYING": the unbilled REMAINDER (order total minus what its invoices
 * cover) is counted only for an order that is OPEN or that carries a counted DRAFT. A DELIVERED
 * order with only ISSUED invoices counts its plain balance (master's behaviour, kept on purpose —
 * a short-delivered order's total may never have been reduced), so adding a 1-cent DRAFT to such
 * an order flips it into the max rule and counts the whole remainder. That cliff is the ruling
 * (partially invoiced ⇒ max(order total, issued + draft)) and always errs toward guarding.
 *
 * `creditExposure` is the credit-BLOCK basis. It is NOT `outstandingAmount + pendingExposure`:
 * a backed draft is inside creditExposure and inside neither of the other two, so a UI must
 * label it as the figure the hard limit is checked against.
 *
 * Payment basis is deliberately UNCHANGED from the pre-D6 block: every non-VOID
 * InvoicePayment reduces an invoice's balance (a DRAFT bank-import payment counts as
 * paid). D6 resolves the DRAFT-INVOICE half only; the DRAFT-PAYMENT half stays a
 * tracked follow-up (owner ruling pending) — `invoiceBalance` below is the ONE place that basis
 * lives now: the customers list/CSV no longer carry their own copy of it.
 */

/** Orders whose value is still to be billed — the statement's `pendingOrdersAmount` set. */
export const OPEN_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.PENDING,
  OrderStatus.CONFIRMED,
  OrderStatus.OUT_FOR_DELIVERY,
];

/** Goods already handed over: a draft behind one of these must stay inside the hard block. */
export const DELIVERED_ORDER_STATUSES: OrderStatus[] = [
  OrderStatus.PARTIALLY_DELIVERED,
  OrderStatus.DELIVERED,
];

/**
 * Orders that BACK a draft invoice (open ∪ delivered). OrderStatus.DRAFT and CANCELLED are
 * deliberately NOT backing: a draft behind them is not a receivable.
 */
export const BACKING_ORDER_STATUSES: OrderStatus[] = [
  ...OPEN_ORDER_STATUSES,
  ...DELIVERED_ORDER_STATUSES,
];

/**
 * The statuses that do NOT back a draft. Together with BACKING_ORDER_STATUSES this must cover
 * EVERY `OrderStatus` exactly once — `credit-exposure.spec.ts` pins that (B584), so a NEW order
 * status can never silently fall on the wrong side of the credit block.
 */
export const NON_BACKING_ORDER_STATUSES: OrderStatus[] = [OrderStatus.DRAFT, OrderStatus.CANCELLED];

const BACKING_ORDER_STATUS_SET: ReadonlySet<string> = new Set(BACKING_ORDER_STATUSES);

/** "Not an ISSUED invoice": settled/dead/forgiven statuses AND DRAFT. */
const NOT_ISSUED_STATUSES: ReadonlySet<string> = new Set(CREDIT_EXPOSURE_EXCLUDED);

export interface ExposureInvoice {
  /** number | numeric string | Prisma Decimal — coerced with Number(). */
  total: unknown;
  status: string;
  orderId: string | null;
  payments: { amount: unknown; status: string }[];
  /**
   * The invoice's order (Invoice.order); decides whether a DRAFT is backed. REQUIRED (B584): a
   * caller that forgets `order` in its select must fail to COMPILE, not quietly treat every draft
   * as unbacked (an under-count). `null` = no order (orderId null).
   */
  order: { id: string; status: string; total: unknown } | null;
}

export interface ExposureOrder {
  id: string;
  total: unknown;
}

/**
 * The slice of a (tenant-scoped or transaction) Prisma client the reader needs. Structural on
 * purpose: the hard block passes its transaction client, the statement passes
 * `prisma.forTenant()`, and neither is a nameable single type.
 */
export interface ExposureDb {
  invoice: { findMany(args: any): PromiseLike<any[]> };
  order: { findMany(args: any): PromiseLike<any[]> };
}

export interface CreditExposure {
  /** Σ balance of COUNTED invoices (issued, unsettled, plus drafts backed by an open/delivered order). */
  invoiceExposure: number;
  /** Σ value of orders not yet covered by their counted invoices (order total − Σ invoice totals, floored at 0, per order). */
  uninvoicedOrderExposure: number;
  /** invoiceExposure + uninvoicedOrderExposure — the figure the hard limit is checked against. */
  counted: number;
  /** Σ balance of UNBACKED drafts only (no open/delivered order behind them) — never in `counted`. */
  pendingExposure: number;
}

/**
 * True for a DRAFT invoice that no open or delivered order stands behind: standalone
 * (orderId null), its order CANCELLED or DRAFT-status, a quote, a bank-import draft.
 * The ONE place that decides whether a draft is excluded from credit exposure (the option
 * A/B flip point) — the hard block, the statement, the customers list and the CSV export
 * all go through it. A non-DRAFT invoice is never "unbacked".
 */
export function isUnbackedDraft(inv: {
  status: string;
  /** Required on purpose (B584): omitting it from a select is a compile error, not a silent under-count. */
  order: { status: string } | null;
}): boolean {
  return (
    inv.status === "DRAFT" && !(inv.order != null && BACKING_ORDER_STATUS_SET.has(inv.order.status))
  );
}

/** Number() that can never leak NaN/Infinity into a money figure (null/undefined => 0). */
function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** The slice of an invoice a balance needs (`ExposureInvoice` satisfies it). */
interface BalancedInvoice {
  /** number | numeric string | Prisma Decimal — coerced with Number(). */
  total: unknown;
  payments: { amount: unknown; status: string }[];
}

/** total − Σ non-VOID payments (the pre-D6 block/list/CSV payment basis, kept as-is). */
function invoiceBalance(inv: BalancedInvoice): number {
  // Exclude VOID payments: a bounced check (P5-12) flips its InvoicePayment to VOID and
  // reverts the invoice to OPEN/PARTIAL, so a reversed payment must NOT reduce the
  // customer's credit exposure — otherwise a bounce lets them slip under the limit.
  // PR-2 review (routeflow-Lead, 2026-09-16): the earlier sumConfirmed conversion was
  // reverted because it silently changed credit-limit behavior (a DRAFT bank-import row
  // would start producing a 409 CREDIT_LIMIT_EXCEEDED) with no sign-off. That is a real,
  // separate decision, flagged to the owner as a follow-up — master's not-void basis is
  // kept as-is. D6 resolved the DRAFT-INVOICE half only, never this payment half.
  const paid = (inv.payments ?? [])
    // scan-ok: draft-payment-not-void — see comment above.
    .filter((p) => p.status !== "VOID")
    .reduce((sum, p) => sum + toNumber(p.amount), 0);
  return toNumber(inv.total) - paid;
}

/** The invoice slice `receivableBalance` reads — the `select` for every receivables read. */
export const RECEIVABLE_INVOICE_SELECT = {
  total: true,
  status: true,
  order: { select: { status: true } },
  payments: { select: { amount: true, status: true } },
} as const;

/**
 * What ONE invoice adds to a receivables total (customers list Receivables + CSV export): 0 for
 * an unbacked DRAFT (`isUnbackedDraft`), else its balance on the same non-VOID payment basis the
 * hard block uses. Both surfaces sum THIS instead of filtering/netting on their own
 * (`credit-exposure-coverage.spec.ts` fails the build if either stops calling it).
 */
export function receivableBalance(
  inv: BalancedInvoice & { status: string; order: { status: string } | null },
): number {
  return isUnbackedDraft(inv) ? 0 : invoiceBalance(inv);
}

/**
 * Pure core (no I/O).
 *
 * Algorithm (`excludeOrderId` first drops that order's row and its invoices from EVERYTHING):
 *   1. pendingExposure = Σ balance of UNBACKED drafts (`isUnbackedDraft`).
 *   2. COUNTED invoices = issued invoices (status ∉ CREDIT_EXPOSURE_EXCLUDED) + BACKED drafts.
 *   3. Group the counted invoices by orderId. An order uses the MAX RULE when it is OPEN (it is
 *      in `openOrders`) OR its group holds ≥ 1 backed draft. For such an order with total T
 *      (the `openOrders` row if present, else the invoices' `order.total`):
 *        counted_o = Σ balance(counted invoices of o) + max(0, T − Σ total(counted invoices of o))
 *      — equals max(T, issued + draft) when nothing is paid, and keeps netting payments. An
 *      OPEN order with NO counted invoice counts T (the whole remainder).
 *   4. Counted invoices outside a max-rule group (orderId null, or a delivered order with only
 *      issued invoices, or an order that is neither open nor carries a backed draft) count by
 *      plain balance — pre-D6 behaviour, no remainder added.
 *
 * @param input.invoices  every NON-SETTLED invoice, drafts included, each with its `order`.
 *   Settled statuses (PAID/VOID/WRITTEN_OFF) are tolerated and ignored, so a caller that
 *   over-fetches can never inflate the figure.
 * @param input.openOrders  orders in OPEN_ORDER_STATUSES.
 * @param input.excludeOrderId  the order being edited: its invoices and its order row
 *   are dropped from every bucket — the caller represents it by its projected total.
 */
export function computeCreditExposure(input: {
  invoices: ExposureInvoice[];
  openOrders: ExposureOrder[];
  excludeOrderId?: string | null;
}): CreditExposure {
  const { excludeOrderId } = input;
  const isExcludedOrder = (id: string | null | undefined): boolean =>
    excludeOrderId != null && id === excludeOrderId;

  // JS-side exclusion of the edited order's invoices (avoids SQL null semantics of
  // `not` on the nullable orderId column).
  const invoices = input.invoices.filter((inv) => !isExcludedOrder(inv.orderId));
  const openOrders = input.openOrders.filter((o) => !isExcludedOrder(o.id));

  // Steps 1-2: split into pending (unbacked drafts) and counted (issued + backed drafts).
  let pendingExposure = 0;
  const counted: ExposureInvoice[] = [];
  for (const inv of invoices) {
    if (isUnbackedDraft(inv)) {
      pendingExposure += invoiceBalance(inv);
    } else if (inv.status === "DRAFT" || !NOT_ISSUED_STATUSES.has(inv.status)) {
      // A backed draft, or an issued invoice. Settled statuses fall through and are ignored.
      counted.push(inv);
    }
  }

  // Step 3 prep: group counted invoices by order; the rest count by plain balance (step 4).
  const byOrder = new Map<string, ExposureInvoice[]>();
  let invoiceExposure = 0;
  const plain: ExposureInvoice[] = [];
  for (const inv of counted) {
    if (inv.orderId == null) {
      plain.push(inv);
      continue;
    }
    const group = byOrder.get(inv.orderId);
    if (group) group.push(inv);
    else byOrder.set(inv.orderId, [inv]);
  }

  const openOrderTotals = new Map(openOrders.map((o) => [o.id, toNumber(o.total)]));
  const maxRuleOrderIds = new Set<string>(openOrderTotals.keys());
  for (const [orderId, group] of byOrder) {
    if (group.some((inv) => inv.status === "DRAFT")) maxRuleOrderIds.add(orderId);
  }

  // Step 3: the max rule, once per order.
  let uninvoicedOrderExposure = 0;
  for (const orderId of maxRuleOrderIds) {
    const group = byOrder.get(orderId) ?? [];
    const orderTotal =
      openOrderTotals.get(orderId) ??
      toNumber(group.find((inv) => inv.order != null)?.order?.total);
    const groupBalance = group.reduce((sum, inv) => sum + invoiceBalance(inv), 0);
    const groupTotal = group.reduce((sum, inv) => sum + toNumber(inv.total), 0);
    invoiceExposure += groupBalance;
    uninvoicedOrderExposure += Math.max(0, orderTotal - groupTotal);
  }

  // Step 4: everything outside a max-rule group counts by plain balance.
  for (const inv of plain) invoiceExposure += invoiceBalance(inv);
  for (const [orderId, group] of byOrder) {
    if (maxRuleOrderIds.has(orderId)) continue;
    for (const inv of group) invoiceExposure += invoiceBalance(inv);
  }

  return {
    invoiceExposure: roundMoney(invoiceExposure),
    uninvoicedOrderExposure: roundMoney(uninvoicedOrderExposure),
    counted: roundMoney(invoiceExposure + uninvoicedOrderExposure),
    pendingExposure: roundMoney(pendingExposure),
  };
}

/**
 * The ONLY reader. `db` is the (tenant-scoped) client the caller passes — the hard
 * block passes its transaction client, the statement passes `prisma.forTenant()`.
 * Reads non-settled invoices INCLUDING drafts, each with its order (the pure core splits
 * counted vs pending on it) and the customer's open orders, then derives everything through
 * `computeCreditExposure`.
 */
export async function loadCreditExposure(
  db: ExposureDb,
  customerId: string,
  opts?: { excludeOrderId?: string | null },
): Promise<CreditExposure> {
  const invoices = (await db.invoice.findMany({
    where: { customerId, status: { notIn: CREDIT_NOT_APPLICABLE } },
    select: {
      total: true,
      status: true,
      orderId: true,
      order: { select: { id: true, status: true, total: true } },
      payments: { select: { amount: true, status: true } },
    },
  })) as ExposureInvoice[];
  const openOrders = (await db.order.findMany({
    where: { customerId, status: { in: OPEN_ORDER_STATUSES } },
    select: { id: true, total: true },
  })) as ExposureOrder[];
  return computeCreditExposure({
    invoices,
    openOrders,
    excludeOrderId: opts?.excludeOrderId ?? null,
  });
}
