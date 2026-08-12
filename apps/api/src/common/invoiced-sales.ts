import { CostingMethod, InvoiceStatus } from "@prisma/client";

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
 * Conventions (see common/pricing.ts):
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
    /** Default REAL_INVOICE_STATUSES; the P&L passes InvoiceStatus.PAID. */
    status?: InvoiceStatus | typeof REAL_INVOICE_STATUSES;
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
