import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { roundMoney } from "../common/pricing";
import { AddonService } from "../billing/addon.service";
import { SystemConfigService } from "../system-config/system-config.service";

export const TOBACCO_ADDON_KEY = "tobacco_dealer";
export const TOBACCO_EXCLUDE_KEY = "tobacco.excludeFromMainAnalytics";

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

  async getTopProducts(metric = "revenue", limit = 10) {
    const excludeTobacco = await this.tobaccoExclusionActive();
    if (metric === "revenue") {
      const items = await this.prisma.forTenant().transactionItem.findMany({
        include: {
          orderItem: {
            include: { product: { select: { id: true, name: true, isTobacco: true } } },
          },
        },
      });
      const map: Record<string, { name: string; value: number }> = {};
      for (const i of items) {
        const prod = i.orderItem?.product;
        if (!prod) continue;
        if (excludeTobacco && prod.isTobacco) continue;
        if (!map[prod.id]) map[prod.id] = { name: prod.name, value: 0 };
        map[prod.id].value += Number(i.subtotal);
      }
      return Object.entries(map)
        .map(([id, v]) => ({ id, name: v.name, value: v.value }))
        .sort((a, b) => b.value - a.value)
        .slice(0, limit);
    }
    // units sold
    const movements = await this.prisma.forTenant().stockMovement.findMany({
      where: { type: "SALE", ...(excludeTobacco ? { product: { isTobacco: false } } : {}) },
      include: { product: { select: { id: true, name: true } } },
    });
    const map: Record<string, { name: string; value: number }> = {};
    for (const m of movements) {
      if (!map[m.productId]) map[m.productId] = { name: m.product.name, value: 0 };
      // SALE rows are negative; positive SALE rows are reopen-reversals that
      // must net out — signed sum, not abs
      map[m.productId].value += -Number(m.quantity);
    }
    return Object.entries(map)
      .map(([id, v]) => ({ id, name: v.name, value: v.value }))
      .sort((a, b) => b.value - a.value)
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

  async getInventoryTurnover(from?: string, to?: string) {
    const { fromDate, toDate } = this.dateRange(from, to);
    const excludeTobacco = await this.tobaccoExclusionActive();
    const products = await this.prisma.forTenant().product.findMany({
      where: { isActive: true, ...(excludeTobacco ? { isTobacco: false } : {}) },
    });
    const sales = await this.prisma.forTenant().stockMovement.findMany({
      where: {
        type: "SALE",
        createdAt: { gte: fromDate, lte: toDate },
        ...(excludeTobacco ? { product: { isTobacco: false } } : {}),
      },
      select: { productId: true, quantity: true },
    });
    const salesMap: Record<string, number> = {};
    // Signed: reopen-reversals (positive SALE rows) net out of units sold
    for (const s of sales)
      salesMap[s.productId] = (salesMap[s.productId] ?? 0) + -Number(s.quantity);
    return products.map((p) => ({
      id: p.id,
      name: p.name,
      unitsSold: salesMap[p.id] ?? 0,
      currentStock: Number(p.currentStock),
      turnoverRate: Number(p.currentStock) > 0 ? (salesMap[p.id] ?? 0) / Number(p.currentStock) : 0,
    }));
  }

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
    const result: {
      id: string;
      name: string;
      currentStock: number;
      lastMovement: Date | null;
      daysInactive: number | null;
    }[] = [];
    for (const p of activeProducts) {
      const lastMovement = await this.prisma.forTenant().stockMovement.findFirst({
        where: { productId: p.id },
        orderBy: { createdAt: "desc" },
      });
      if (!lastMovement || lastMovement.createdAt < cutoff) {
        result.push({
          id: p.id,
          name: p.name,
          currentStock: Number(p.currentStock),
          lastMovement: lastMovement?.createdAt ?? null,
          daysInactive: lastMovement
            ? Math.floor((Date.now() - lastMovement.createdAt.getTime()) / 86400000)
            : null,
        });
      }
    }
    return result;
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

  async getGrossMarginTrend(from?: string, to?: string) {
    const { fromDate, toDate } = this.dateRange(from, to);
    const excludeTobacco = await this.tobaccoExclusionActive();
    const invoices = await this.prisma.forTenant().invoice.findMany({
      where: {
        issueDate: { gte: fromDate, lte: toDate },
        status: { notIn: ["DRAFT", "VOID", "WRITTEN_OFF"] },
      },
      select: { total: true, ...(excludeTobacco ? TOBACCO_LINE_SELECT : {}) },
    });
    const movements = await this.prisma.forTenant().stockMovement.findMany({
      where: {
        type: "SALE",
        createdAt: { gte: fromDate, lte: toDate },
        ...(excludeTobacco ? { product: { isTobacco: false } } : {}),
      },
    });
    const revenue = roundMoney(
      invoices.reduce(
        (s, inv) =>
          s +
          (excludeTobacco
            ? Number(inv.total) - this.tobaccoPortion((inv as { items?: any[] }).items ?? [])
            : Number(inv.total)),
        0,
      ),
    );
    // Signed COGS: SALE quantities are negative, so -qty × unitCost adds cost;
    // reopen-reversals are positive SALE rows and subtract their cost back out
    const cogs = roundMoney(
      movements.reduce((s, m) => s + -Number(m.quantity) * Number(m.unitCost ?? 0), 0),
    );
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
