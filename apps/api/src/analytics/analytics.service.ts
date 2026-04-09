import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

@Injectable()
export class AnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

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
    const invoices = await this.prisma.forTenant().invoice.findMany({
      where: {
        issueDate: { gte: fromDate, lte: toDate },
        status: { notIn: ["DRAFT", "VOID", "WRITTEN_OFF"] },
      },
      orderBy: { issueDate: "asc" },
      select: { issueDate: true, total: true },
    });
    const grouped: Record<string, number> = {};
    for (const inv of invoices) {
      const key =
        groupBy === "month"
          ? `${inv.issueDate.getFullYear()}-${String(inv.issueDate.getMonth() + 1).padStart(2, "0")}`
          : inv.issueDate.toISOString().split("T")[0];
      grouped[key] = (grouped[key] ?? 0) + Number(inv.total);
    }
    return Object.entries(grouped)
      .map(([period, revenue]) => ({ period, revenue }))
      .sort((a, b) => a.period.localeCompare(b.period));
  }

  async getTopProducts(metric = "revenue", limit = 10) {
    if (metric === "revenue") {
      const items = await this.prisma.forTenant().transactionItem.findMany({
        include: { orderItem: { include: { product: { select: { id: true, name: true } } } } },
      });
      const map: Record<string, { name: string; value: number }> = {};
      for (const i of items) {
        const prod = i.orderItem?.product;
        if (!prod) continue;
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
      where: { type: "SALE" },
      include: { product: { select: { id: true, name: true } } },
    });
    const map: Record<string, { name: string; value: number }> = {};
    for (const m of movements) {
      if (!map[m.productId]) map[m.productId] = { name: m.product.name, value: 0 };
      map[m.productId].value += Math.abs(Number(m.quantity));
    }
    return Object.entries(map)
      .map(([id, v]) => ({ id, name: v.name, value: v.value }))
      .sort((a, b) => b.value - a.value)
      .slice(0, limit);
  }

  async getTopCustomers(metric = "revenue", limit = 10, from?: string, to?: string) {
    const where: any = { status: { notIn: ["DRAFT", "VOID", "WRITTEN_OFF"] } };
    if (from || to) {
      where.createdAt = {};
      if (from) where.createdAt.gte = new Date(from);
      if (to) where.createdAt.lte = new Date(to + "T23:59:59.999Z");
    }
    const invoices = await this.prisma.forTenant().invoice.findMany({
      where,
      include: { customer: { select: { id: true, businessName: true } } },
    });
    const map: Record<string, { name: string; totalRevenue: number; orderCount: number }> = {};
    for (const inv of invoices) {
      const id = inv.customerId;
      if (!map[id]) map[id] = { name: inv.customer.businessName, totalRevenue: 0, orderCount: 0 };
      map[id].totalRevenue += Number(inv.total);
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
    const products = await this.prisma.forTenant().product.findMany({ where: { isActive: true } });
    const sales = await this.prisma.forTenant().stockMovement.findMany({
      where: { type: "SALE", createdAt: { gte: fromDate, lte: toDate } },
      select: { productId: true, quantity: true },
    });
    const salesMap: Record<string, number> = {};
    for (const s of sales)
      salesMap[s.productId] = (salesMap[s.productId] ?? 0) + Math.abs(Number(s.quantity));
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
    const activeProducts = await this.prisma.forTenant().product.findMany({
      where: { isActive: true, currentStock: { gt: 0 } },
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
    const products = await this.prisma.forTenant().product.findMany({ where: { isActive: true } });
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
      where: { productId, type: "PURCHASE" },
      orderBy: { createdAt: "asc" },
      take: 100,
    });
    return movements.map((m) => ({ date: m.createdAt, unitCost: Number(m.unitCost ?? 0) }));
  }

  async getSalesByCategory(from?: string, to?: string) {
    const { fromDate, toDate } = this.dateRange(from, to);
    const items = await this.prisma.forTenant().orderItem.findMany({
      where: { order: { createdAt: { gte: fromDate, lte: toDate }, status: "DELIVERED" } },
      include: { product: { select: { category: true } } },
    });
    const map: Record<string, number> = {};
    for (const i of items) {
      const cat = i.product.category ?? "Uncategorized";
      map[cat] = (map[cat] ?? 0) + Number(i.subtotal);
    }
    return Object.entries(map)
      .map(([category, revenue]) => ({ category, revenue }))
      .sort((a, b) => b.revenue - a.revenue);
  }

  async getGrossMarginTrend(from?: string, to?: string) {
    const { fromDate, toDate } = this.dateRange(from, to);
    const invoices = await this.prisma.forTenant().invoice.findMany({
      where: {
        issueDate: { gte: fromDate, lte: toDate },
        status: { notIn: ["DRAFT", "VOID", "WRITTEN_OFF"] },
      },
      select: { total: true },
    });
    const movements = await this.prisma.forTenant().stockMovement.findMany({
      where: { type: "SALE", createdAt: { gte: fromDate, lte: toDate } },
    });
    const revenue = invoices.reduce((s, inv) => s + Number(inv.total), 0);
    const cogs = movements.reduce(
      (s, m) => s + Math.abs(Number(m.quantity)) * Number(m.unitCost ?? 0),
      0,
    );
    const grossProfit = revenue - cogs;
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
    const invoices = await this.prisma.forTenant().invoice.findMany({
      where: {
        issueDate: { gte: fromDate, lte: toDate },
        status: { notIn: ["DRAFT", "VOID", "WRITTEN_OFF"] },
      },
      select: { total: true },
    });
    const total = invoices.reduce((s, inv) => s + Number(inv.total), 0);
    return {
      count: invoices.length,
      total,
      aov: invoices.length > 0 ? total / invoices.length : 0,
      period: { from: fromDate, to: toDate },
    };
  }
}
