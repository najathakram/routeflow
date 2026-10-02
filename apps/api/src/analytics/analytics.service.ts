import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { roundMoney } from "@routeflow/pricing";
import { endOfCalendarDay } from "../common/calendar-date";
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
import { ProductInsightsService } from "../sales-facts/product-insights.service";
import type {
  ProductDemandSeries,
  ProductSalesHistory,
} from "../sales-facts/legacy-product-shapes";
import type { DemandRange } from "./demand-range";

const TOBACCO_ADDON_KEY = "tobacco_dealer";
export const TOBACCO_EXCLUDE_KEY = "tobacco.excludeFromMainAnalytics";

// #2118: the per-product read shapes moved with their producer (the sales-facts layer).
export type {
  ProductDemandSeries,
  ProductSalesHistory,
} from "../sales-facts/legacy-product-shapes";

/**
 * Per-group (route or driver) accumulator for the stop-level operational
 * metrics shared by getRoutePerformance / getDriverPerformance. "Valid" runs
 * are those with a positive startedAt→completedAt span — the only ones that
 * may enter the duration / stops-per-hour math.
 */
interface RunMetricAgg {
  completedStops: number;
  onTimeStops: number;
  validRunCount: number;
  validRunMs: number;
  /** Completed stops belonging to valid-duration runs only. */
  validRunStops: number;
}

/** The run slice the shared stop-metric accumulator needs. */
interface RunMetricSource {
  scheduledDate: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  stops: { completedAt: Date | null }[];
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
    private readonly productInsights: ProductInsightsService,
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

  /**
   * The default `fromDate` is UTC-anchored (`Date.UTC(...getUTCFullYear(), 0, 1)`),
   * NOT `new Date(year, 0, 1)` — the two-argument constructor reads HOST-LOCAL
   * calendar components, so on any host west of UTC the window opened hours
   * after UTC midnight of January 1 and the `gte` filter silently dropped every
   * invoice dated January 1 (they are stored at UTC midnight — see
   * `common/calendar-date.ts`). Same defect class as the `getRevenueTrend`
   * month key below; pinned in `analytics.service.calendar.spec.ts`.
   */
  private dateRange(from?: string, to?: string) {
    const fromDate = from ? new Date(from) : new Date(Date.UTC(new Date().getUTCFullYear(), 0, 1));
    const toDate = to
      ? (() => {
          const d = new Date(to);
          d.setUTCHours(23, 59, 59, 999);
          return d;
        })()
      : new Date();
    return { fromDate, toDate };
  }

  /**
   * Prisma where-fragment windowing invoices on their business date
   * (Invoice.issueDate). No bounds ⇒ no filter, preserving the endpoints'
   * historical all-time behavior for parameterless callers (mobile). With
   * either bound present the shared dateRange defaults fill the other side
   * (from → Jan 1 of the current year, to → now; `to` is end-of-day inclusive).
   */
  private issueDateFilter(from?: string, to?: string) {
    if (!from && !to) return {};
    const { fromDate, toDate } = this.dateRange(from, to);
    return { issueDate: { gte: fromDate, lte: toDate } };
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
          ? inv.issueDate.toISOString().slice(0, 7)
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

  /**
   * Prisma where-fragment windowing route runs on their business date
   * (RouteRun.scheduledDate). No bounds ⇒ no filter, preserving the endpoints'
   * historical all-time behavior for parameterless callers (mobile). With
   * either bound present the shared dateRange defaults fill the other side
   * (from → Jan 1 of the current year, to → now; `to` is end-of-day inclusive).
   */
  private runDateFilter(from?: string, to?: string) {
    if (!from && !to) return {};
    const { fromDate, toDate } = this.dateRange(from, to);
    return { scheduledDate: { gte: fromDate, lte: toDate } };
  }

  private newRunMetricAgg(): RunMetricAgg {
    return { completedStops: 0, onTimeStops: 0, validRunCount: 0, validRunMs: 0, validRunStops: 0 };
  }

  /**
   * Folds one run's stop timings into the group accumulator.
   *
   * "On-time" definition: RouteRunStop carries no promised ETA (the schema has
   * no eta / time-window field anywhere), so a completed stop counts as
   * on-time when its completedAt falls on or before the END of its run's
   * scheduledDate calendar day, in the tenant's configured timezone (falling
   * back to UTC when unset). Completing early is on-time; anything after the
   * scheduled day is late. Stops never completed are not "late" — they're
   * incomplete, which completionRate already captures — so they stay out of
   * the on-time denominator entirely.
   *
   * Duration metrics admit only runs with a positive startedAt→completedAt
   * span; runs missing either stamp (or with a non-positive span) are excluded
   * from BOTH the stops-per-hour numerator and denominator so they can't
   * poison the averages.
   */
  private accumulateRunMetrics(
    agg: RunMetricAgg,
    run: RunMetricSource,
    tenantTimezone: string | null,
  ) {
    const dayEnd = endOfCalendarDay(run.scheduledDate, tenantTimezone);
    let runCompletedStops = 0;
    for (const stop of run.stops) {
      if (!stop.completedAt) continue;
      runCompletedStops += 1;
      if (stop.completedAt <= dayEnd) agg.onTimeStops += 1;
    }
    agg.completedStops += runCompletedStops;
    if (run.startedAt && run.completedAt) {
      const ms = run.completedAt.getTime() - run.startedAt.getTime();
      if (ms > 0) {
        agg.validRunCount += 1;
        agg.validRunMs += ms;
        agg.validRunStops += runCompletedStops;
      }
    }
  }

  /**
   * Resolves the current tenant's configured timezone ONCE per call (not per
   * row) for the on-time day-end check above. It passes `cfg?.timezone ?? null`
   * straight through and relies on `endOfCalendarDay`'s own UTC fallback: an
   * unconfigured tenant (no `TenantConfig` row) must keep today's exact UTC
   * day-end boundary, never a silently-substituted America/New_York default.
   */
  private async resolveCurrentTenantTimezone(): Promise<string | null> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) return null;
    const cfg = await this.prisma.tenantConfig.findUnique({
      where: { tenantId },
      select: { timezone: true },
    });
    return cfg?.timezone ?? null;
  }

  /** Ratios from the accumulator — null (never 0 or NaN) when a window has no data. */
  private finalizeRunMetrics(agg: RunMetricAgg): {
    onTimeRate: number | null;
    stopsPerHour: number | null;
    avgRunDurationMinutes: number | null;
  } {
    const hours = agg.validRunMs / 3_600_000;
    return {
      onTimeRate: agg.completedStops > 0 ? (agg.onTimeStops / agg.completedStops) * 100 : null,
      stopsPerHour: hours > 0 ? agg.validRunStops / hours : null,
      avgRunDurationMinutes:
        agg.validRunCount > 0 ? agg.validRunMs / agg.validRunCount / 60_000 : null,
    };
  }

  /**
   * Per-route run counts, completion rate, and the stop-level operational
   * metrics (see accumulateRunMetrics for the on-time definition and the
   * valid-duration rule). from/to window on RouteRun.scheduledDate via
   * runDateFilter; omitted ⇒ all history.
   */
  async getRoutePerformance(from?: string, to?: string) {
    const tenantTimezone = await this.resolveCurrentTenantTimezone();
    const runs = await this.prisma.forTenant().routeRun.findMany({
      where: this.runDateFilter(from, to),
      include: {
        route: { select: { id: true, name: true } },
        orders: { select: { id: true } },
        stops: { select: { completedAt: true } },
      },
    });
    const map: Record<
      string,
      { name: string; totalRuns: number; completedRuns: number; metrics: RunMetricAgg }
    > = {};
    for (const run of runs) {
      const id = run.routeId;
      if (!map[id])
        map[id] = {
          name: run.route.name,
          totalRuns: 0,
          completedRuns: 0,
          metrics: this.newRunMetricAgg(),
        };
      map[id].totalRuns += 1;
      if (run.status === "COMPLETED") map[id].completedRuns += 1;
      this.accumulateRunMetrics(map[id].metrics, run, tenantTimezone);
    }
    return Object.entries(map).map(([id, v]) => ({
      id,
      name: v.name,
      totalRuns: v.totalRuns,
      completedRuns: v.completedRuns,
      completionRate: v.totalRuns > 0 ? (v.completedRuns / v.totalRuns) * 100 : 0,
      ...this.finalizeRunMetrics(v.metrics),
    }));
  }

  /**
   * Per-driver delivery counts (orders on the run, as before) plus the same
   * stop-level operational metrics as getRoutePerformance. from/to window on
   * RouteRun.scheduledDate via runDateFilter; omitted ⇒ all history.
   */
  async getDriverPerformance(from?: string, to?: string) {
    const tenantTimezone = await this.resolveCurrentTenantTimezone();
    const runs = await this.prisma.forTenant().routeRun.findMany({
      where: { driverId: { not: null }, ...this.runDateFilter(from, to) },
      include: {
        driver: { include: { user: { select: { username: true } } } },
        orders: { select: { id: true } },
        stops: { select: { completedAt: true } },
      },
    });
    const map: Record<
      string,
      {
        name: string;
        totalDeliveries: number;
        completedDeliveries: number;
        metrics: RunMetricAgg;
      }
    > = {};
    for (const run of runs) {
      if (!run.driver) continue;
      const id = run.driver.id;
      if (!map[id])
        map[id] = {
          name: run.driver.contactName ?? run.driver.user.username,
          totalDeliveries: 0,
          completedDeliveries: 0,
          metrics: this.newRunMetricAgg(),
        };
      map[id].totalDeliveries += run.orders.length;
      if (run.status === "COMPLETED") map[id].completedDeliveries += run.orders.length;
      this.accumulateRunMetrics(map[id].metrics, run, tenantTimezone);
    }
    return Object.entries(map).map(([id, v]) => ({
      id,
      name: v.name,
      totalDeliveries: v.totalDeliveries,
      completedDeliveries: v.completedDeliveries,
      completionRate: v.totalDeliveries > 0 ? (v.completedDeliveries / v.totalDeliveries) * 100 : 0,
      ...this.finalizeRunMetrics(v.metrics),
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
   * `daysInactive` report the most recent of the two signals (relative to
   * now, whatever the window).
   *
   * Windowing: with from/to the analytics-page picker range REPLACES the
   * rolling window — dead ⇔ no activity anywhere inside [from, to] — so
   * "last 7 days" means exactly that, and daysInactive is ignored. Without
   * bounds the historical rolling behavior stands: no activity in the
   * daysInactive days up to now (mobile's parameterless call). Stock levels
   * are always CURRENT state — a past-dated range asks "which of today's
   * stocked products didn't move back then", not a point-in-time snapshot.
   */
  async getDeadStock(daysInactive = 30, from?: string, to?: string) {
    const ranged = Boolean(from || to);
    const rollingCutoff = new Date();
    rollingCutoff.setDate(rollingCutoff.getDate() - daysInactive);
    const { fromDate, toDate } = this.dateRange(from, to);
    const windowStart = ranged ? fromDate : rollingCutoff;
    const windowEnd = ranged ? toDate : null; // rolling mode stays open-ended
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
    const soldInWindow = new Set<string>();
    for (const inv of invoices) {
      const inWindow = inv.issueDate >= windowStart && (!windowEnd || inv.issueDate <= windowEnd);
      for (const item of inv.items ?? []) {
        if (!item.productId) continue;
        if (inWindow) soldInWindow.add(item.productId);
        const prev = lastSaleAt.get(item.productId);
        if (!prev || inv.issueDate > prev) lastSaleAt.set(item.productId, inv.issueDate);
      }
    }

    // Products with any stock movement inside the window are active.
    const recentMovements = await this.prisma.forTenant().stockMovement.findMany({
      where: {
        productId: { in: productIds },
        // B562: the movement's accounting date (effectiveAt), not its insertion time.
        effectiveAt: windowEnd ? { gte: windowStart, lte: windowEnd } : { gte: windowStart },
      },
      select: { productId: true },
      distinct: ["productId"],
    });
    const recentlyMoved = new Set(recentMovements.map((m: { productId: string }) => m.productId));

    const deadCandidates = activeProducts.filter(
      (p) => !recentlyMoved.has(p.id) && !soldInWindow.has(p.id),
    );
    if (deadCandidates.length === 0) return [];

    // Last movement dates only for the dead candidates — a small set, which
    // replaces the old per-product findFirst over EVERY stocked product.
    const movementRows = await this.prisma.forTenant().stockMovement.findMany({
      where: { productId: { in: deadCandidates.map((p) => p.id) } },
      orderBy: [{ effectiveAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      select: { productId: true, effectiveAt: true },
    });
    const lastMovementAt = new Map<string, Date>();
    for (const m of movementRows) {
      if (!lastMovementAt.has(m.productId)) lastMovementAt.set(m.productId, m.effectiveAt);
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

  /**
   * Products currently priced under a 20% margin. Deliberately takes NO
   * from/to: it compares today's pricePerUnit to today's averageCost — pure
   * current state with no history to window (B40 decision: the web card
   * says so instead of pretending to filter).
   */
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

  /**
   * Average days from issue to payment across PAID invoices. from/to window
   * on Invoice.issueDate via issueDateFilter — the range selects WHICH
   * invoices count (by when they were raised); the payment itself may land
   * after `to` and still be measured. Omitted ⇒ all history (mobile's
   * parameterless call).
   */
  async getDso(from?: string, to?: string) {
    const paidInvoices = await this.prisma.forTenant().invoice.findMany({
      where: { status: "PAID", paidAt: { not: null }, ...this.issueDateFilter(from, to) },
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
      // B562: accounting order (effectiveAt), insertion time and id break ties.
      orderBy: [{ effectiveAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
      take: 100,
    });
    return movements.map((m) => ({
      date: m.effectiveAt,
      unitCost: Number(m.unitCost ?? 0),
      avgCostAfter: m.avgCostAfter != null ? Number(m.avgCostAfter) : null,
      type: m.type,
    }));
  }

  /**
   * PR-B: "who bought this, when, and at what price" — the per-buyer sales history behind
   * the product Sales tab: the newest `limit` invoiced LINES, and their summary.
   *
   * #2118: one-line delegate into the sales-facts layer (`ProductInsightsService`), which
   * reads THROUGH `Invoice` on the accrual basis (plan A2: a written-off invoice's lines are
   * sales, badged `writtenOff`) and pages by line. Callers and the response shape are
   * unchanged. The tobacco-exclusion toggle deliberately does NOT apply: the operator reached
   * this by opening that exact product.
   */
  async getProductSales(productId: string, limit = 200): Promise<ProductSalesHistory> {
    return this.productInsights.getSalesHistory(productId, limit);
  }

  /**
   * Per-product demand series for the product-detail chart — units AND revenue in one
   * payload so the card's metric toggle never refetches.
   *
   * #2118: one-line delegate into `ProductInsightsService` (same through-Invoice read,
   * accrual basis, UTC-anchored `demandWindow`). Callers and the response shape are
   * unchanged; the tobacco toggle does not apply (per-product drill-down).
   */
  async getProductDemand(
    productId: string,
    range: DemandRange = "30d",
  ): Promise<ProductDemandSeries> {
    return this.productInsights.getDemandSeries(productId, range);
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
