import { CostingMethod, CreditNoteStatus, InvoiceStatus } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";
import { CONFIRMED_PAYMENT } from "../invoices/payment-predicates";

/**
 * Invoiced-sales sourcing for the analytics / forecasting / COGS readers.
 *
 * Source of truth for "what sold" is INVOICED SALES, not `StockMovement
 * type:"SALE"`: the only SALE writer (the route-delivery path's
 * `InventoryService.recordSale` call) was removed in c5f579c2 (2026-07-16),
 * so no flow writes SALE rows anymore — and a tenant that invoices directly
 * never had them at all. Invoices cover both flows (route deliveries are
 * invoiced too, via delivered-basis invoicing).
 *
 * ⚠️ Always query THROUGH `invoice.findMany`, never top-level
 * `invoiceItem.findMany`: invoice lines are created as NESTED writes, which
 * bypass the tenant extension's `data.tenantId` injection, so historical /
 * imported lines can carry `tenantId = null` — and `forTenant()` injects
 * `where.tenantId`, silently dropping every one of them. Same guard as
 * `analytics.service.ts getProductDemand` and `bookkeeping getSalesByItem`.
 *
 * Conventions (see @routeflow/pricing):
 * - units = `Number(item.qty)` AS-IS — the same denomination order-create
 *   decrements `Product.currentStock` by; never re-derive from boxes/pieces.
 * - revenue = `Number(item.subtotal)` — NEVER `qty × unitPrice` (re-introduces
 *   the boxed-line overcharge by unitsPerBox).
 * - Ad-hoc lines (`productId = null`) are excluded from per-product
 *   aggregates and contribute $0 to COGS.
 *
 * Known limitation: returns / credit notes are not netted out of units or
 * COGS (parity with getProductDemand); VOID / WRITTEN_OFF invoices drop out
 * wholesale via the status filter.
 * net sales: see `fetchAccrualNetSales`.
 */

/**
 * Invoice statuses that represent a real sale — mirrors the tobacco report
 * services. Uses the generated enum rather than string literals so a schema
 * change can't silently drift the filter (the sibling copies use `as any` on
 * a string array).
 */
export const REAL_INVOICE_STATUSES = {
  notIn: [InvoiceStatus.DRAFT, InvoiceStatus.VOID, InvoiceStatus.WRITTEN_OFF],
};

/**
 * Revenue/net-sales predicate (B440) — WRITTEN_OFF *is* revenue at issue (bad
 * debt is a later expense, see `fetchBadDebtExpense`); only DRAFT/VOID are
 * excluded. Deliberately different from `REAL_INVOICE_STATUSES` (the units/
 * COGS-lines predicate, which excludes WRITTEN_OFF too) — do not merge them.
 */
export const ACCRUAL_REVENUE_STATUSES = {
  notIn: [InvoiceStatus.DRAFT, InvoiceStatus.VOID],
} as const;

/**
 * Quantities are `Decimal(10,3)`, so they round to 3dp — NOT through `roundMoney`,
 * which is 2dp and would silently truncate a fractional imported qty. Money still
 * goes through `roundMoney` per the repo's money discipline.
 */
export function roundQty(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round((n + Number.EPSILON) * 1000) / 1000;
}

/**
 * Narrow structural surface of `prisma.forTenant()` — callers pass the real
 * tenant-scoped client; tests pass a stub with just these models.
 */
export interface InvoicedSalesDb {
  invoice: { findMany(args: any): Promise<any[]> };
  stockMovement: { findMany(args: any): Promise<any[]> };
  product: { findMany(args: any): Promise<any[]> };
}

/**
 * Additive surface for the B440 accrual-net-sales helpers — extends
 * `InvoicedSalesDb` rather than widening it, so `fetchInvoicedSaleLines`'s own
 * (narrower) callers/stubs are untouched. Return types are `any`, matching
 * `InvoicedSalesDb`'s own convention — a stricter structural `_sum` shape
 * makes the REAL Prisma delegate (whose `.aggregate()`/`.groupBy()` return
 * types are far richer) fail assignability against this interface.
 */
export interface AccrualSalesDb extends InvoicedSalesDb {
  invoice: InvoicedSalesDb["invoice"] & {
    aggregate(args: any): Promise<any>;
    groupBy(args: any): Promise<any[]>;
  };
  creditNote: {
    aggregate(args: any): Promise<any>;
    groupBy(args: any): Promise<any[]>;
  };
  return: {
    aggregate(args: any): Promise<any>;
    groupBy(args: any): Promise<any[]>;
  };
}

/** One flattened invoice line of a real sale. qty/subtotal already Number()ed. */
export interface InvoicedSaleLine {
  /** null = ad-hoc "unlisted" line. */
  productId: string | null;
  /** `Number(item.qty)` as-is — normalized base units for box-split lines. */
  qty: number;
  /** `Number(item.subtotal)` — authoritative, never qty × unitPrice. */
  subtotal: number;
  productName: string | null;
  isTobacco: boolean;
  /** The sale's business date (from the parent invoice). */
  issueDate: Date;
  paidAt: Date | null;
}

export async function fetchInvoicedSaleLines(
  db: InvoicedSalesDb,
  opts: {
    from: Date;
    /** Inclusive `lte` — matches the `dateRange()` callers. */
    to: Date;
    /** Which Invoice field the window filters. Cost lookups always use issueDate. */
    dateBasis: "issueDate" | "paidAt";
    /** Default REAL_INVOICE_STATUSES; the P&L passes ACCRUAL_REVENUE_STATUSES
     *  (B440) for its COGS fetch, sharing revenue's accrual basis. */
    status?: InvoiceStatus | typeof REAL_INVOICE_STATUSES | typeof ACCRUAL_REVENUE_STATUSES;
  },
): Promise<InvoicedSaleLine[]> {
  const invoices = await db.invoice.findMany({
    where: {
      status: opts.status ?? REAL_INVOICE_STATUSES,
      [opts.dateBasis]: { gte: opts.from, lte: opts.to },
    },
    select: {
      issueDate: true,
      paidAt: true,
      items: {
        select: {
          productId: true,
          qty: true,
          subtotal: true,
          product: { select: { name: true, isTobacco: true } },
        },
      },
    },
  });

  const lines: InvoicedSaleLine[] = [];
  for (const inv of invoices) {
    for (const item of inv.items ?? []) {
      lines.push({
        productId: item.productId ?? null,
        qty: Number(item.qty),
        subtotal: Number(item.subtotal),
        productName: item.product?.name ?? null,
        isTobacco: item.product?.isTobacco ?? false,
        issueDate: inv.issueDate,
        paidAt: inv.paidAt ?? null,
      });
    }
  }
  return lines;
}

// ─── Accrual net sales (B440/B455/B456) ─────────────────────────────────────
//
// Revenue/sales is booked at ISSUE, never at PAYMENT — `getCashFlow` and the
// three other legitimate cash consumers (analytics.service.ts,
// buyer/statement.service.ts, customers.service.ts) keep reading `paidAt`;
// nothing here ever does. `gross` excludes sales tax collected (standard
// accounting) via one `total - taxAmount` subtraction — `Invoice.taxAmount`
// already folds in category/excise tax, so a second term is never needed;
// shipping and discount stay IN revenue.

export interface AccrualNetSales {
  gross: number;
  creditNotes: number;
  externalRefunds: number;
  net: number;
}

/** Inclusive date window — `lte` matches the `dateRange()` callers. */
export interface AccrualWindow {
  gte: Date;
  lte: Date;
}

/**
 * Accrual net sales for one tenant-window: `net = gross - creditNotes -
 * externalRefunds`, never clamped (a CN-heavy period legitimately nets
 * negative). Every component is keyed on its OWN event date — issueDate for
 * the invoice, `createdAt` for the credit note (never `appliedAt`, a
 * settlement event — the same trap as `paidAt`), `refundedAt` for the return
 * — never `paidAt` anywhere in this function.
 */
export async function fetchAccrualNetSales(
  db: AccrualSalesDb,
  // B440 fix-round finding 2: fails CLOSED, not ambient. `forTenant()` under
  // a null tenant context returns the UNSCOPED client, so relying on it
  // alone to inject `where.tenantId` would sum across every tenant; every
  // caller must resolve a non-null tenantId (throw if null) and this
  // function puts it in every where-clause explicitly.
  tenantId: string,
  window: AccrualWindow,
  opts?: { customerId?: string },
): Promise<AccrualNetSales> {
  const customerFilter = opts?.customerId ? { customerId: opts.customerId } : {};

  const [invoiceAgg, creditNoteAgg, returnAgg] = await Promise.all([
    db.invoice.aggregate({
      where: { tenantId, status: ACCRUAL_REVENUE_STATUSES, issueDate: window, ...customerFilter },
      _sum: { total: true, taxAmount: true },
    }),
    // TODO B459 (returns-in-orders lane): once CreditNote.taxAmount ships,
    // subtract (amount - taxAmount) here instead of amount — a freeform/
    // lump-sum credit (no line selected) has no cap tying it to an invoice
    // figure and may include tax in practice; a line-based credit is
    // provably pre-tax (UI caps each line at InvoiceItem.subtotal). A CN
    // issued against an invoice that is LATER voided/written-off is still
    // counted here as-is — netting a credit note's own lifecycle against a
    // separate invoice status change is out of this helper's scope.
    db.creditNote.aggregate({
      where: {
        tenantId,
        createdAt: window,
        status: { not: CreditNoteStatus.VOID },
        ...customerFilter,
      },
      _sum: { amount: true },
    }),
    // Already pre-tax (`priceReturn` prices from `subtotal` only) — no
    // exclusion term needed here. `refundMethod` is load-bearing: a
    // CN-method return is already netted via the CreditNote read above.
    db.return.aggregate({
      where: { tenantId, refundMethod: "EXTERNAL_REFUND", refundedAt: window, ...customerFilter },
      _sum: { refundAmount: true },
    }),
  ]);

  const sumTotal = Number(invoiceAgg._sum.total ?? 0);
  const sumTaxAmount = Number(invoiceAgg._sum.taxAmount ?? 0);
  const gross = roundMoney(sumTotal - sumTaxAmount);
  const creditNotes = roundMoney(Number(creditNoteAgg._sum.amount ?? 0));
  const externalRefunds = roundMoney(Number(returnAgg._sum.refundAmount ?? 0));
  const net = roundMoney(gross - creditNotes - externalRefunds);

  return { gross, creditNotes, externalRefunds, net };
}

/** Per-customer accrual net sales for one tenant-window — union of customers
 *  appearing in any of the three underlying reads. */
export async function fetchAccrualNetSalesByCustomer(
  db: AccrualSalesDb,
  tenantId: string,
  window: AccrualWindow,
): Promise<Map<string, AccrualNetSales>> {
  const [invoiceRows, creditNoteRows, returnRows] = await Promise.all([
    db.invoice.groupBy({
      by: ["customerId"],
      where: { tenantId, status: ACCRUAL_REVENUE_STATUSES, issueDate: window },
      _sum: { total: true, taxAmount: true },
    }),
    db.creditNote.groupBy({
      by: ["customerId"],
      where: { tenantId, createdAt: window, status: { not: CreditNoteStatus.VOID } },
      _sum: { amount: true },
    }),
    db.return.groupBy({
      by: ["customerId"],
      where: { tenantId, refundMethod: "EXTERNAL_REFUND", refundedAt: window },
      _sum: { refundAmount: true },
    }),
  ]);

  const gross = new Map<string, number>();
  for (const row of invoiceRows) {
    gross.set(
      row.customerId,
      roundMoney(Number(row._sum.total ?? 0) - Number(row._sum.taxAmount ?? 0)),
    );
  }
  const creditNotes = new Map<string, number>();
  for (const row of creditNoteRows) {
    creditNotes.set(row.customerId, roundMoney(Number(row._sum.amount ?? 0)));
  }
  const externalRefunds = new Map<string, number>();
  for (const row of returnRows) {
    externalRefunds.set(row.customerId, roundMoney(Number(row._sum.refundAmount ?? 0)));
  }

  const customerIds = new Set([...gross.keys(), ...creditNotes.keys(), ...externalRefunds.keys()]);
  const result = new Map<string, AccrualNetSales>();
  for (const customerId of customerIds) {
    const g = gross.get(customerId) ?? 0;
    const cn = creditNotes.get(customerId) ?? 0;
    const er = externalRefunds.get(customerId) ?? 0;
    result.set(customerId, {
      gross: g,
      creditNotes: cn,
      externalRefunds: er,
      net: roundMoney(g - cn - er),
    });
  }
  return result;
}

/**
 * Bad-debt expense (B456): the pre-tax share of the unpaid balance — `(total
 * - paid) × (total - taxAmount) / total` — of every invoice WRITTEN_OFF
 * inside `window`, keyed on `writtenOffAt`, NEVER `issueDate` (a write-off
 * can land in a period long after the sale). Uncollected sales tax is a
 * liability reversal, not an expense (owner ruling 2026-09-15, tax
 * exclusion) — only the pre-tax portion of an unpaid invoice is a genuine
 * cost to the business, consistent with `fetchAccrualNetSales`'s own
 * pre-tax `gross`. `paid` sums only CONFIRMED (PAID) payments — a VOIDed
 * (bounced) or DRAFT (unconfirmed) payment row is not recovered money, same
 * predicate as `getBadDebtsReport`'s own read; a credit-note application is
 * still counted (`applyCreditInTx` writes a CONFIRMED `method:CREDIT_NOTE`
 * payment row) — the same relation `getBadDebtsReport` already reads,
 * extracted here so both share one expression.
 */
export async function fetchBadDebtExpense(
  db: AccrualSalesDb,
  tenantId: string,
  window: AccrualWindow,
): Promise<number> {
  const invoices = await db.invoice.findMany({
    where: { tenantId, status: InvoiceStatus.WRITTEN_OFF, writtenOffAt: window },
    select: {
      total: true,
      taxAmount: true,
      payments: { where: CONFIRMED_PAYMENT, select: { amount: true } },
    },
  });

  let total = 0;
  for (const inv of invoices) {
    const paid = (inv.payments ?? []).reduce((s: number, p: any) => s + Number(p.amount ?? 0), 0);
    const invTotal = Number(inv.total ?? 0);
    // Fable review of #791: an overpaid write-off (paid > total) must never
    // contribute a NEGATIVE expense — clamp at 0, same as every other
    // balance computation in this file.
    const unpaid = Math.max(0, invTotal - paid);
    const taxAmount = Number(inv.taxAmount ?? 0);
    const preTaxShare = invTotal > 0 ? (invTotal - taxAmount) / invTotal : 0;
    total += unpaid * preTaxShare;
  }
  return roundMoney(total);
}

/** Distinct non-null productIds of a line set (cost-resolver input). */
export function soldProductIds(lines: { productId: string | null }[]): string[] {
  return [...new Set(lines.map((l) => l.productId).filter((x): x is string => x != null))];
}

// ─── Point-in-time COGS estimation ──────────────────────────────────────────
//
// Invoice lines carry no unit cost, so COGS is an ESTIMATE: each line is
// costed at the product's point-in-time average cost — the `avgCostAfter`
// snapshot of the latest StockMovement (any type) at or before the sale's
// issueDate. This is the exact pattern the schema comment on StockMovement
// documents ("Point-in-time average cost = avgCostAfter of the latest
// movement <= T"), and it is stable: a future restock never restates a past
// period. FIFO/LIFO/LAST_COST cannot be honored retroactively — this is an
// AVCO-style estimate regardless of the product's costing method.

/** productId → ascending `[{ t: epochMs, cost }]` built from avgCostAfter snapshots. */
export type CostIndex = Map<string, { t: number; cost: number }[]>;

/** Pure: group + sort snapshot rows (rows with null avgCostAfter are skipped). */
export function buildCostIndex(
  rows: { productId: string; createdAt: Date; avgCostAfter: unknown }[],
): CostIndex {
  const index: CostIndex = new Map();
  for (const r of rows) {
    if (r.avgCostAfter == null) continue;
    const arr = index.get(r.productId) ?? [];
    arr.push({ t: r.createdAt.getTime(), cost: Number(r.avgCostAfter) });
    index.set(r.productId, arr);
  }
  for (const arr of index.values()) arr.sort((a, b) => a.t - b.t);
  return index;
}

/** Pure: binary search — latest snapshot with `t <= at` (inclusive); null when none. */
export function costAt(index: CostIndex, productId: string, at: Date): number | null {
  const arr = index.get(productId);
  if (!arr || arr.length === 0) return null;
  const t = at.getTime();
  let lo = 0;
  let hi = arr.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].t <= t) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans >= 0 ? arr[ans].cost : null;
}

export interface ProductCostFacts {
  costingMethod: CostingMethod;
  standardCost: unknown;
  averageCost: unknown;
}

/**
 * Fallback ladder for a line's estimated unit cost at `at`:
 *   1. point-in-time snapshot (`costAt`)
 *   2. costingMethod STANDARD → standardCost
 *   3. current averageCost
 *   4. 0 (no cost basis at all — contributes nothing to COGS)
 */
export function resolveUnitCost(
  index: CostIndex,
  productId: string,
  at: Date,
  facts: ProductCostFacts | undefined,
): number {
  const snapshot = costAt(index, productId, at);
  if (snapshot != null) return snapshot;
  if (!facts) return 0;
  if (facts.costingMethod === CostingMethod.STANDARD && facts.standardCost != null) {
    return Number(facts.standardCost);
  }
  if (facts.averageCost != null) return Number(facts.averageCost);
  return 0;
}

/**
 * Pure: Σ qty × unit cost over lines, each costed at its own issueDate.
 * Ad-hoc lines (productId = null) contribute $0. Caller wraps in roundMoney.
 */
export function estimateCogs(
  lines: Pick<InvoicedSaleLine, "productId" | "qty" | "issueDate" | "isTobacco">[],
  index: CostIndex,
  facts: Map<string, ProductCostFacts>,
  opts?: { excludeTobacco?: boolean },
): number {
  let total = 0;
  for (const line of lines) {
    if (!line.productId) continue;
    if (opts?.excludeTobacco && line.isTobacco) continue;
    total +=
      line.qty * resolveUnitCost(index, line.productId, line.issueDate, facts.get(line.productId));
  }
  return total;
}

/**
 * One bounded snapshot query for exactly the sold products. Snapshot volume is
 * restock-rate-bounded (SALE rows are no longer written), so this stays small;
 * if a tenant ever makes it heavy, the escape hatch is a raw
 * `DISTINCT ON (productId)` lateral query — not built until needed.
 */
export async function fetchCostIndex(
  db: InvoicedSalesDb,
  productIds: string[],
  until: Date,
): Promise<CostIndex> {
  if (productIds.length === 0) return new Map();
  const rows = await db.stockMovement.findMany({
    where: {
      productId: { in: productIds },
      avgCostAfter: { not: null },
      createdAt: { lte: until },
    },
    select: { productId: true, createdAt: true, avgCostAfter: true },
    orderBy: { createdAt: "asc" },
  });
  return buildCostIndex(rows);
}

/** Cost-fallback facts for the sold products, keyed by product id. */
export async function fetchProductCostFacts(
  db: InvoicedSalesDb,
  productIds: string[],
): Promise<Map<string, ProductCostFacts>> {
  if (productIds.length === 0) return new Map();
  const products = await db.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, costingMethod: true, standardCost: true, averageCost: true },
  });
  return new Map(
    products.map((p) => [
      p.id,
      { costingMethod: p.costingMethod, standardCost: p.standardCost, averageCost: p.averageCost },
    ]),
  );
}
