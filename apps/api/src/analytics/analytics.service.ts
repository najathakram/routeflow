import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { roundMoney } from "../common/pricing";
import {
  REAL_INVOICE_STATUSES,
  estimateCogs,
  fetchCostIndex,
  fetchInvoicedSaleLines,
  fetchProductCostFacts,
  roundQty,
  soldProductIds,
} from "../common/invoiced-sales";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";
import {
  type DemandGranularity,
  type DemandRange,
  bucketIndexOf,
  demandWindow,
} from "./demand-range";

export const TOBACCO_ADDON_KEY = "tobacco_dealer";
export const TOBACCO_EXCLUDE_KEY = "tobacco.excludeFromMainAnalytics";

/** One bucket of the per-product demand series. Both metrics ship together. */
export interface ProductDemandBucket {
  /** Bucket START, "YYYY-MM-DD". Never an ISO timestamp — see demand-range.ts. */
  date: string;
  /** Total base units (pieces) invoiced in this bucket. */
  units: number;
  /** Net invoiced sales in this bucket (line subtotals, pre-tax). */
  revenue: number;
}

export interface ProductDemandSeries {
  productId: string;
  range: DemandRange;
  granularity: DemandGranularity;
  /** ISO, inclusive. */
  from: string;
  /** ISO, EXCLUSIVE. */
  to: string;
  buckets: ProductDemandBucket[];
  totals: { units: number; revenue: number };
  /** False ⇒ never invoiced at any date: "never sold", not "zero this window". */
  hasAnySales: boolean;
  /** "YYYY-MM-DD" of this product's first / most recent invoiced sale. */
  firstSaleAt: string | null;
  lastSaleAt: string | null;
}

/** Invoice line slice needed to subtract tobacco revenue from an invoice total. */
const TOBACCO_LINE_SELECT = {
  items: {
    select: {
      subtotal: true,
      taxRate: true,
      product: { select: { isTobacco: true } },
    },
  },
} as const;

@Injectable()
export class AnalyticsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly addonService: AddonService,
    private readonly systemConfig: SystemConfigService,
  ) {}

  /**
   * Tenant-choosable presentation toggle: when the tobacco_dealer addon is
   * active AND the tenant enabled tobacco.excludeFromMainAnalytics, tobacco
   * items are excluded from the MAIN analytics surfaces (they still appear in
   * the dedicated Tobacco section). Deliberately NOT applied to bookkeeping /
   * P&L — accounting records always reflect real financials — nor to
   * routes/driver performance, DSO, cost history, or list pages.
   */
  private async tobaccoExclusionActive(): Promise<boolean> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) return false;
    if (!(await this.addonService.hasAddon(tenantId, TOBACCO_ADDON_KEY))) return false;
    return (await this.systemConfig.get(TOBACCO_EXCLUDE_KEY)) === "true";
  }

  /** Tobacco portion (subtotal + line tax) of an invoice's items, for subtraction. */
  private tobaccoPortion(
    items: { subtotal: unknown; taxRate: unknown; product: { isTobacco: boolean } | null }[],
  ): number {
    let portion = 0;
    for (const item of items) {
      if (item.product?.isTobacco) {
        portion += Number(item.subtotal) * (1 + Number(item.taxRate));
      }
    }
    return portion;
  }

  private dateRange(from?: string, to?: string) {
    const fromDate = from ? new Date(from) : new Date(new Date().getFullYear(), 0, 1);
    const toDate = to
      ? (() => {
          const d = new Date(to);
          d.setUTCHours(23, 59, 59, 999);
          return d;
        })()
      : new Date();
    return { fromDate, toDate };
  }

  async getRevenueTrend(from?: string, to?: string, groupBy = "month") {
    const { fromDate, toDate } = this.dateRange(from, to);
    const excludeTobacco = await this.tobaccoExclusionActive();
    const invoices = await this.prisma.forTenant().invoice.findMany({
      where: {
        issueDate: { gte: fromDate, lte: toDate },
        status: { notIn: ["DRAFT", "VOID", "WRITTEN_OFF"] },
      },
      orderBy: { issueDate: "asc" },
      select: { issueDate: true, total: true, ...(excludeTobacco ? TOBACCO_LINE_SELECT : {}) },
    });
    const grouped: Record<string, number> = {};
    for (const inv of invoices) {
      const key =
        groupBy === "month"
          ? `${inv.issueDate.getFullYear()}-${String(inv.issueDate.getMonth() + 1).padStart(2, "0")}`
          : inv.issueDate.toISOString().split("T")[0];
      // Invoice-level discount/shippingFee stay attributed to the remainder
      const total = excludeTobacco
        ? Number(inv.total) - this.tobaccoPortion((inv as { items?: any[] }).items ?? [])
        : Number(inv.total);
      grouped[key] = (grouped[key] ?? 0) + total;
    }
    return Object.entries(grouped)
      .map(([period, revenue]) => ({ period, revenue: roundMoney(revenue) }))
      .sort((a, b) => a.period.localeCompare(b.period));
  }

  /**
   * Top products for the analytics page. Source is invoiced sales (see
   * common/invoiced-sales.ts — the old sources are both dead: SALE stock
   * movements have no writer, and TransactionItem never had one). Both
   * metrics are computed in one pass and returned on every row, so the
   * client's revenue/units toggle only changes the sort; `metric` picks the
   * sort key. Windowed on Invoice.issueDate via dateRange (defaults
   * Jan 1 of the current year → now — previously all-time, which only ever
   * returned an empty list in production anyway).
   */
  async getTopProducts(metric = "revenue", limit = 10, from?: string, to?: string) {
    const { fromDate, toDate } = this.dateRange(from, to);
    const excludeTobacco = await this.tobaccoExclusionActive();
    const lines = await fetchInvoicedSaleLines(this.prisma.forTenant(), {
      from: fromDate,
      to: toDate,
      dateBasis: "issueDate",
    });
    const map = new Map<string, { name: string; unitsSold: number; totalRevenue: number }>();
    for (const line of lines) {
      if (!line.productId) continue; // ad-hoc lines have no product identity
      if (excludeTobacco && line.isTobacco) continue;
      const entry = map.get(line.productId) ?? {
        name: line.productName ?? "",
        unitsSold: 0,
        totalRevenue: 0,
      };
      entry.unitsSold += line.qty;
      entry.totalRevenue += line.subtotal;
      map.set(line.productId, entry);
    }
    return [...map.entries()]
      .map(([id, v]) => ({
        id,
        name: v.name,
        unitsSold: roundQty(v.unitsSold),
        totalRevenue: roundMoney(v.totalRevenue),
      }))
      .sort((a, b) =>
        metric === "units" ? b.unitsSold - a.unitsSold : b.totalRevenue - a.totalRevenue,
      )
      .slice(0, limit);
  }

  async getTopCustomers(metric = "revenue", limit = 10, from?: string, to?: string) {
    const excludeTobacco = await this.tobaccoExclusionActive();
    const where: any = { status: { notIn: ["DRAFT", "VOID", "WRITTEN_OFF"] } };
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to + "T23:59:59.999Z");
    }
    const invoices = await this.prisma.forTenant().invoice.findMany({
      where,
      include: {
        customer: { select: { id: true, businessName: true } },
        ...(excludeTobacco ? TOBACCO_LINE_SELECT : {}),
      },
    });
    const map: Record<string, { name: string; totalRevenue: number; orderCount: number }> = {};
    for (const inv of invoices) {
      const id = inv.customerId;
      if (!map[id]) map[id] = { name: inv.customer.businessName, totalRevenue: 0, orderCount: 0 };
      const total = excludeTobacco
        ? Number(inv.total) - this.tobaccoPortion((inv as { items?: any[] }).items ?? [])
        : Number(inv.total);
      map[id].totalRevenue += total;
      map[id].orderCount += 1;
    }
    const arr = Object.entries(map).map(([id, v]) => ({ id, ...v }));
    return arr
      .sort((a, b) =>
        metric === "orders" ? b.orderCount - a.orderCount : b.totalRevenue - a.totalRevenue,
      )
      .slice(0, limit);
  }

  async getRoutePerformance() {
    const runs = await this.prisma.forTenant().routeRun.findMany({
      include: {
        route: { select: { id: true, name: true } },
        orders: { select: { id: true } },
      },
    });
    const map: Record<string, { name: string; totalRuns: number; completedRuns: number }> = {};
    for (const run of runs) {
      const id = run.routeId;
      if (!map[id]) map[id] = { name: run.route.name, totalRuns: 0, completedRuns: 0 };
      map[id].totalRuns += 1;
      if (run.status === "COMPLETED") map[id].completedRuns += 1;
    }
    return Object.entries(map).map(([id, v]) => ({
      id,
      name: v.name,
      totalRuns: v.totalRuns,
      completedRuns: v.completedRuns,
      completionRate: v.totalRuns > 0 ? (v.completedRuns / v.totalRuns) * 100 : 0,
    }));
  }

  async getDriverPerformance() {
    const runs = await this.prisma.forTenant().routeRun.findMany({
      where: { driverId: { not: null } },
      include: {
        driver: { include: { user: { select: { username: true } } } },
        orders: { select: { id: true } },
      },
    });
    const map: Record<
      string,
      { name: string; totalDeliveries: number; completedDeliveries: number }
    > = {};
    for (const run of runs) {
      if (!run.driver) continue;
      const id = run.driver.id;
      if (!map[id])
        map[id] = {
          name: run.driver.contactName ?? run.driver.user.username,
          totalDeliveries: 0,
          completedDeliveries: 0,
        };
      map[id].totalDeliveries += run.orders.length;
      if (run.status === "COMPLETED") map[id].completedDeliveries += run.orders.length;
    }
    return Object.entries(map).map(([id, v]) => ({
      id,
      name: v.name,
      totalDeliveries: v.totalDeliveries,
      completedDeliveries: v.completedDeliveries,
      completionRate: v.totalDeliveries > 0 ? (v.completedDeliveries / v.totalDeliveries) * 100 : 0,
    }));
  }

  /**
   * Units sold per active product over the window, from invoiced sales (see
   * common/invoiced-sales.ts — SALE stock movements are dead). The tobacco
   * exclusion is governed by the products list: excluded products never
   * appear in the output, so stray tobacco keys in salesMap are inert.
   */
  async getInventoryTurnover(from?: string, to?: string) {
    const { fromDate, toDate } = this.dateRange(from, to);
    const excludeTobacco = await this.tobaccoExclusionActive();
    const products = await this.prisma.forTenant().product.findMany({
      where: { isActive: true, ...(excludeTobacco ? { isTobacco: false } : {}) },
    });
    const lines = await fetchInvoicedSaleLines(this.prisma.forTenant(), {
      from: fromDate,
      to: toDate,
      dateBasis: "issueDate",
    });
    const salesMap: Record<string, number> = {};
    for (const line of lines) {
      if (line.productId) salesMap[line.productId] = (salesMap[line.productId] ?? 0) + line.qty;
    }
    return products.map((p) => ({
      id: p.id,
      name: p.name,
      unitsSold: roundQty(salesMap[p.id] ?? 0),
      currentStock: Number(p.currentStock),
      turnoverRate: Number(p.currentStock) > 0 ? (salesMap[p.id] ?? 0) / Number(p.currentStock) : 0,
    }));
  }

  /**
   * Stocked products with no recent activity. "Activity" is a stock movement
   * OR an invoiced sale — movement recency alone is wrong now that SALE
   * movements are dead (a daily-selling but rarely-restocked product would
   * read as dead stock; see common/invoiced-sales.ts). `lastMovement` /
   * `daysInactive` report the most recent of the two signals.
   */
  async getDeadStock(daysInactive = 30) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysInactive);
    const excludeTobacco = await this.tobaccoExclusionActive();
    const activeProducts = await this.prisma.forTenant().product.findMany({
      where: {
        isActive: true,
        currentStock: { gt: 0 },
        ...(excludeTobacco ? { isTobacco: false } : {}),
      },
    });
    if (activeProducts.length === 0) return [];
    const productIds = activeProducts.map((p) => p.id);

    // Last-sale dates in one pass over invoice history (through Invoice —
    // never invoiceItem.findMany; see common/invoiced-sales.ts).
    const invoices = await this.prisma.forTenant().invoice.findMany({
      where: { status: REAL_INVOICE_STATUSES },
      select: { issueDate: true, items: { select: { productId: true } } },
    });
    const lastSaleAt = new Map<string, Date>();
    for (const inv of invoices) {
      for (const item of inv.items ?? []) {
        if (!item.productId) continue;
        const prev = lastSaleAt.get(item.productId);
        if (!prev || inv.issueDate > prev) lastSaleAt.set(item.productId, inv.issueDate);
      }
    }

    // Products with any stock movement since the cutoff are active.
    const recentMovements = await this.prisma.forTenant().stockMovement.findMany({
      where: { productId: { in: productIds }, createdAt: { gte: cutoff } },
      select: { productId: true },
      distinct: ["productId"],
    });
    const recentlyMoved = new Set(recentMovements.map((m: { productId: string }) => m.productId));

    const deadCandidates = activeProducts.filter((p) => {
      const sale = lastSaleAt.get(p.id);
      return !recentlyMoved.has(p.id) && (!sale || sale < cutoff);
    });
    if (deadCandidates.length === 0) return [];

    // Last movement dates only for the dead candidates — a small set, which
    // replaces the old per-product findFirst over EVERY stocked product.
    const movementRows = await this.prisma.forTenant().stockMovement.findMany({
      where: { productId: { in: deadCandidates.map((p) => p.id) } },
      orderBy: { createdAt: "desc" },
      select: { productId: true, createdAt: true },
    });
    const lastMovementAt = new Map<string, Date>();
    for (const m of movementRows) {
      if (!lastMovementAt.has(m.productId)) lastMovementAt.set(m.productId, m.createdAt);
    }

    return deadCandidates.map((p) => {
      const moved = lastMovementAt.get(p.id) ?? null;
      const sold = lastSaleAt.get(p.id) ?? null;
      const last = moved && sold ? (moved > sold ? moved : sold) : (moved ?? sold);
      return {
        id: p.id,
        name: p.name,
        currentStock: Number(p.currentStock),
        lastMovement: last,
        daysInactive: last ? Math.floor((Date.now() - last.getTime()) / 86400000) : null,
      };
    });
  }

  async getMarginAlerts() {
    const excludeTobacco = await this.tobaccoExclusionActive();
    const products = await this.prisma.forTenant().product.findMany({
      where: { isActive: true, ...(excludeTobacco ? { isTobacco: false } : {}) },
    });
    const alerts: { id: string; name: string; price: number; cost: number; marginPct: number }[] =
      [];
    for (const p of products) {
      const price = Number(p.pricePerUnit);
      const cost = Number(p.averageCost ?? 0);
      if (price <= 0 || cost <= 0) continue;
      const margin = ((price - cost) / price) * 100;
      if (margin < 20)
        alerts.push({
          id: p.id,
          name: p.name,
          price,
          cost,
          marginPct: Math.round(margin * 100) / 100,
        });
    }
    return alerts;
  }

  async getDso() {
    const paidInvoices = await this.prisma.forTenant().invoice.findMany({
      where: { status: "PAID", paidAt: { not: null } },
      select: { issueDate: true, paidAt: true },
    });
    if (paidInvoices.length === 0) return { dso: 0, count: 0 };
    const totalDays = paidInvoices.reduce((s, inv) => {
      const days =
        inv.paidAt && inv.issueDate
          ? Math.floor((inv.paidAt.getTime() - inv.issueDate.getTime()) / 86400000)
          : 0;
      return s + days;
    }, 0);
    return { dso: totalDays / paidInvoices.length, count: paidInvoices.length };
  }

  async getPriceHistory(productId: string) {
    const items = await this.prisma.forTenant().orderItem.findMany({
      where: { productId },
      include: { order: { select: { createdAt: true } } },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    return items.map((i) => ({ date: i.order.createdAt, unitPrice: Number(i.unitPrice) }));
  }

  async getCostHistory(productId: string) {
    const movements = await this.prisma.forTenant().stockMovement.findMany({
      where: { productId, type: { in: ["PURCHASE", "COST_BASIS"] } },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    return movements.map((m) => ({
      date: m.createdAt,
      unitCost: Number(m.unitCost ?? 0),
      avgCostAfter: m.avgCostAfter != null ? Number(m.avgCostAfter) : null,
      type: m.type,
    }));
  }

  /**
   * Per-product demand series for the product-detail chart. Units AND revenue ship in
   * one payload so the card's metric toggle never refetches.
   *
   * Source is invoiced sales: `InvoiceItem` has no business date of its own, so the
   * window filters `Invoice.issueDate`. `StockMovement type:"SALE"` — the source the
   * inventory forecasting tab uses — is not viable here: it is only written on the
   * route-delivery path, so a tenant that invoices directly has none at all.
   *
   * ⚠️ Queried THROUGH Invoice, never `invoiceItem.findMany`. Invoice lines are created
   * as NESTED writes, which bypass the tenant extension's `data.tenantId` injection, so
   * historical/imported lines can carry `tenantId = null` — and `forTenant()` injects
   * `where.tenantId`, which would silently drop every one of them. On this dataset that
   * is the large majority of the history the 6m/1y/5y ranges exist to show. Same guard
   * and rationale as `bookkeeping.service.ts getSalesByItem`. A spec pins it.
   *
   * The tobacco exclusion toggle is deliberately NOT applied: this is a per-product
   * drill-down the operator reached by opening that exact product, same carve-out as
   * price/cost history (see the `tobaccoExclusionActive` doc comment above).
   */
  async getProductDemand(
    productId: string,
    range: DemandRange = "30d",
  ): Promise<ProductDemandSeries> {
    const win = demandWindow(new Date(), range);
    // Equality on productId can never match NULL, so ad-hoc "unlisted" lines
    // (productId = null) are excluded by this filter for free.
    const soldWhere = { status: REAL_INVOICE_STATUSES, items: { some: { productId } } };

    const [invoices, firstSale, lastSale] = await Promise.all([
      this.prisma.forTenant().invoice.findMany({
        where: { ...soldWhere, issueDate: { gte: win.from, lt: win.to } },
        select: {
          issueDate: true,
          items: { where: { productId }, select: { qty: true, subtotal: true } },
        },
      }),
      this.prisma.forTenant().invoice.findFirst({
        where: soldWhere,
        orderBy: { issueDate: "asc" },
        select: { issueDate: true },
      }),
      this.prisma.forTenant().invoice.findFirst({
        where: soldWhere,
        orderBy: { issueDate: "desc" },
        select: { issueDate: true },
      }),
    ]);

    // Buckets are materialized up front and indexed into, so empty periods stay in the
    // series as explicit zeros (getRevenueTrend's Record+Object.entries approach drops
    // them and hands the client a chart with holes).
    const units = new Array<number>(win.buckets.length).fill(0);
    const revenue = new Array<number>(win.buckets.length).fill(0);

    for (const inv of invoices) {
      const idx = bucketIndexOf(win, inv.issueDate);
      if (idx < 0) continue; // defensive — the half-open filter already excludes these
      for (const item of inv.items) {
        // qty is ALREADY the normalized base-unit total (a "2 cases + 3 packs" line
        // with unitsPerBox 12 stores qty 27) — never re-derive it from boxes/pieces.
        units[idx] += Number(item.qty);
        // subtotal is authoritative. NEVER qty × unitPrice: that re-introduces the
        // boxed-line overcharge by unitsPerBox that common/pricing.ts exists to prevent.
        revenue[idx] += Number(item.subtotal);
      }
    }

    const day = (d: Date | null | undefined) => (d ? d.toISOString().slice(0, 10) : null);

    return {
      productId,
      range,
      granularity: win.granularity,
      from: win.from.toISOString(),
      to: win.to.toISOString(),
      buckets: win.buckets.map((b, i) => ({
        date: b.date,
        units: roundQty(units[i]),
        revenue: roundMoney(revenue[i]),
      })),
      totals: {
        units: roundQty(units.reduce((s, v) => s + v, 0)),
        revenue: roundMoney(revenue.reduce((s, v) => s + v, 0)),
      },
      hasAnySales: firstSale != null,
      firstSaleAt: day(firstSale?.issueDate),
      lastSaleAt: day(lastSale?.issueDate),
    };
  }

  async getSalesByCategory(from?: string, to?: string) {
    const { fromDate, toDate } = this.dateRange(from, to);
    const excludeTobacco = await this.tobaccoExclusionActive();
    const items = await this.prisma.forTenant().orderItem.findMany({
      where: { order: { createdAt: { gte: fromDate, lte: toDate }, status: "DELIVERED" } },
      include: { product: { select: { category: true, isTobacco: true } } },
    });
    const map: Record<string, number> = {};
    for (const i of items) {
      if (excludeTobacco && i.product?.isTobacco) continue;
      // Unlisted lines have no product → bucket under Uncategorized.
      const cat = i.product?.category ?? "Uncategorized";
      map[cat] = (map[cat] ?? 0) + Number(i.subtotal);
    }
    return Object.entries(map)
      .map(([category, revenue]) => ({ category, revenue }))
      .sort((a, b) => b.revenue - a.revenue);
  }

  /**
   * Gross margin for the window. Revenue = invoice totals (real statuses,
   * issueDate window) — unchanged. COGS is estimated from the SAME invoices'
   * lines, each costed at qty × the product's point-in-time average cost at
   * the invoice's issueDate (see common/invoiced-sales.ts — invoice lines
   * carry no cost of their own, and SALE stock movements are dead). Basis
   * alignment between revenue and COGS is true by construction: one fetch
   * feeds both.
   */
  async getGrossMarginTrend(from?: string, to?: string) {
    const { fromDate, toDate } = this.dateRange(from, to);
    const excludeTobacco = await this.tobaccoExclusionActive();
    const invoices = await this.prisma.forTenant().invoice.findMany({
      where: {
        issueDate: { gte: fromDate, lte: toDate },
        status: REAL_INVOICE_STATUSES,
      },
      select: {
        total: true,
        issueDate: true,
        items: {
          select: {
            productId: true,
            qty: true,
            subtotal: true,
            taxRate: true,
            product: { select: { isTobacco: true } },
          },
        },
      },
    });
    const revenue = roundMoney(
      invoices.reduce(
        (s, inv) =>
          s +
          (excludeTobacco
            ? Number(inv.total) - this.tobaccoPortion(inv.items ?? [])
            : Number(inv.total)),
        0,
      ),
    );
    const cogsLines = invoices.flatMap((inv) =>
      (inv.items ?? []).map((item: any) => ({
        productId: (item.productId ?? null) as string | null,
        qty: Number(item.qty),
        issueDate: inv.issueDate,
        isTobacco: item.product?.isTobacco ?? false,
      })),
    );
    const productIds = soldProductIds(cogsLines);
    const [costIndex, costFacts] = await Promise.all([
      fetchCostIndex(this.prisma.forTenant(), productIds, toDate),
      fetchProductCostFacts(this.prisma.forTenant(), productIds),
    ]);
    const cogs = roundMoney(estimateCogs(cogsLines, costIndex, costFacts, { excludeTobacco }));
    const grossProfit = roundMoney(revenue - cogs);
    return {
      revenue,
      cogs,
      grossProfit,
      grossMarginPct: revenue > 0 ? (grossProfit / revenue) * 100 : 0,
      period: { from: fromDate, to: toDate },
    };
  }

  async getAverageOrderValue(from?: string, to?: string) {
    const { fromDate, toDate } = this.dateRange(from, to);
    const excludeTobacco = await this.tobaccoExclusionActive();
    const invoices = await this.prisma.forTenant().invoice.findMany({
      where: {
        issueDate: { gte: fromDate, lte: toDate },
        status: { notIn: ["DRAFT", "VOID", "WRITTEN_OFF"] },
      },
      select: { total: true, ...(excludeTobacco ? TOBACCO_LINE_SELECT : {}) },
    });
    // Invoice COUNT stays unchanged under exclusion — only the tobacco value
    // portion is removed, so AOV = non-tobacco revenue / all invoices
    const total = roundMoney(
      invoices.reduce(
        (s, inv) =>
          s +
          (excludeTobacco
            ? Number(inv.total) - this.tobaccoPortion((inv as { items?: any[] }).items ?? [])
            : Number(inv.total)),
        0,
      ),
    );
    return {
      count: invoices.length,
      total,
      aov: invoices.length > 0 ? total / invoices.length : 0,
      period: { from: fromDate, to: toDate },
    };
  }
}
