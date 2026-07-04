import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { AuditService } from "../audit/audit.service";
import { roundMoney } from "../common/pricing";
import { TOBACCO_EXCLUDE_KEY } from "../analytics/analytics.service";
import { TobaccoRangeDto } from "./dto/tobacco-range.dto";
import { UpdateTobaccoSettingsDto } from "./dto/update-tobacco-settings.dto";

/** Sales that count for tobacco reporting — mirrors analytics revenue rules. */
const REAL_INVOICE_STATUSES = { notIn: ["DRAFT", "VOID", "WRITTEN_OFF"] as any };

@Injectable()
export class TobaccoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly systemConfig: SystemConfigService,
    private readonly audit: AuditService,
  ) {}

  private rangeOf(dto: TobaccoRangeDto) {
    const from = dto.from ? new Date(dto.from) : new Date(new Date().getFullYear(), 0, 1);
    const to = dto.to
      ? (() => {
          const d = new Date(dto.to);
          d.setUTCHours(23, 59, 59, 999);
          return d;
        })()
      : new Date();
    return { from, to };
  }

  private monthRange(month?: string) {
    // month = "YYYY-MM"; default the current month (UTC boundaries)
    const now = new Date();
    const [y, m] = month
      ? month.split("-").map(Number)
      : [now.getUTCFullYear(), now.getUTCMonth() + 1];
    return {
      from: new Date(Date.UTC(y, m - 1, 1)),
      to: new Date(Date.UTC(y, m, 1) - 1),
    };
  }

  // ─── Overview / inventory ───────────────────────────────────────────────────

  async getOverview(month?: string) {
    const { from, to } = this.monthRange(month);
    const [inventory, purchases, sales] = await Promise.all([
      this.getInventory(),
      this.getPurchases({ from: from.toISOString(), to: to.toISOString() }),
      this.getSales({ from: from.toISOString(), to: to.toISOString() }),
    ]);

    return {
      period: { from, to },
      flaggedProductCount: inventory.length,
      inventory: {
        totalQty: inventory.reduce((s, p) => s + p.currentStock, 0),
        totalValue: roundMoney(inventory.reduce((s, p) => s + (p.totalValue ?? 0), 0)),
      },
      purchases: {
        count: purchases.length,
        totalQty: purchases.reduce((s, p) => s + p.quantity, 0),
        totalValue: roundMoney(purchases.reduce((s, p) => s + p.value, 0)),
      },
      sales: {
        count: sales.length,
        totalQty: sales.reduce((s, i) => s + i.qty, 0),
        totalValue: roundMoney(sales.reduce((s, i) => s + i.subtotal, 0)),
        totalTax: roundMoney(sales.reduce((s, i) => s + i.tax, 0)),
      },
    };
  }

  async getInventory() {
    const products = await this.prisma.forTenant().product.findMany({
      where: { isTobacco: true },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        sku: true,
        unit: true,
        isActive: true,
        currentStock: true,
        averageCost: true,
      },
    });
    return products.map((p) => {
      const stock = Number(p.currentStock);
      const cost = p.averageCost != null ? Number(p.averageCost) : null;
      return {
        ...p,
        currentStock: stock,
        averageCost: cost,
        totalValue: cost != null ? roundMoney(stock * cost) : null,
      };
    });
  }

  // ─── Purchases / sales detail ───────────────────────────────────────────────

  async getPurchases(dto: TobaccoRangeDto) {
    const { from, to } = this.rangeOf(dto);
    const movements = await this.prisma.forTenant().stockMovement.findMany({
      where: {
        type: "PURCHASE",
        createdAt: { gte: from, lte: to },
        product: { isTobacco: true },
      },
      orderBy: { createdAt: "desc" },
      include: {
        product: { select: { id: true, name: true, sku: true, unit: true } },
        supplier: { select: { id: true, name: true, tobaccoLicenseNo: true } },
      },
    });
    return movements.map((m) => ({
      id: m.id,
      date: m.createdAt,
      product: m.product,
      supplier: m.supplier,
      reference: m.reference,
      quantity: Number(m.quantity),
      unitCost: m.unitCost != null ? Number(m.unitCost) : null,
      value: roundMoney(Number(m.quantity) * Number(m.unitCost ?? 0)),
    }));
  }

  async getSales(dto: TobaccoRangeDto) {
    const { from, to } = this.rangeOf(dto);
    const items = await this.prisma.forTenant().invoiceItem.findMany({
      where: {
        product: { isTobacco: true },
        invoice: { issueDate: { gte: from, lte: to }, status: REAL_INVOICE_STATUSES },
      },
      orderBy: { createdAt: "desc" },
      include: {
        product: { select: { id: true, name: true, sku: true, unit: true } },
        invoice: {
          select: {
            id: true,
            invoiceNumber: true,
            issueDate: true,
            customer: {
              select: {
                id: true,
                businessName: true,
                tobaccoLicenseNo: true,
                tobaccoLicenseExpiry: true,
              },
            },
          },
        },
      },
    });
    return items.map((i) => ({
      id: i.id,
      date: i.invoice.issueDate,
      invoiceId: i.invoice.id,
      invoiceNumber: i.invoice.invoiceNumber,
      customer: i.invoice.customer,
      product: i.product,
      qty: Number(i.qty),
      unitPrice: Number(i.unitPrice),
      subtotal: Number(i.subtotal),
      tax: roundMoney(Number(i.subtotal) * Number(i.taxRate)),
    }));
  }

  /** 12 monthly buckets of purchases/sales for the trend chart. */
  async getMonthlyTotals(year?: number) {
    const y = year ?? new Date().getUTCFullYear();
    const from = new Date(Date.UTC(y, 0, 1));
    const to = new Date(Date.UTC(y + 1, 0, 1) - 1);

    const [purchases, sales] = await Promise.all([
      this.prisma.forTenant().stockMovement.findMany({
        where: {
          type: "PURCHASE",
          createdAt: { gte: from, lte: to },
          product: { isTobacco: true },
        },
        select: { createdAt: true, quantity: true, unitCost: true },
      }),
      this.prisma.forTenant().invoiceItem.findMany({
        where: {
          product: { isTobacco: true },
          invoice: { issueDate: { gte: from, lte: to }, status: REAL_INVOICE_STATUSES },
        },
        select: { subtotal: true, taxRate: true, invoice: { select: { issueDate: true } } },
      }),
    ]);

    const months = Array.from({ length: 12 }, (_, i) => ({
      month: `${y}-${String(i + 1).padStart(2, "0")}`,
      purchaseValue: 0,
      salesValue: 0,
      taxCollected: 0,
    }));
    for (const p of purchases) {
      const idx = p.createdAt.getUTCMonth();
      months[idx].purchaseValue += Number(p.quantity) * Number(p.unitCost ?? 0);
    }
    for (const s of sales) {
      const idx = s.invoice.issueDate.getUTCMonth();
      months[idx].salesValue += Number(s.subtotal);
      months[idx].taxCollected += Number(s.subtotal) * Number(s.taxRate);
    }
    return months.map((m) => ({
      ...m,
      purchaseValue: roundMoney(m.purchaseValue),
      salesValue: roundMoney(m.salesValue),
      taxCollected: roundMoney(m.taxCollected),
    }));
  }

  // ─── Settings ────────────────────────────────────────────────────────────────

  async getSettings() {
    const value = await this.systemConfig.get(TOBACCO_EXCLUDE_KEY);
    return { excludeFromMainAnalytics: value === "true" };
  }

  async updateSettings(dto: UpdateTobaccoSettingsDto, userId: string) {
    await this.systemConfig.set(
      TOBACCO_EXCLUDE_KEY,
      dto.excludeFromMainAnalytics ? "true" : "false",
    );
    await this.audit.log({
      tenantId: this.prisma.getTenantId(),
      userId,
      action: "tobacco_settings.updated",
      entityType: "SystemConfig",
      meta: { excludeFromMainAnalytics: dto.excludeFromMainAnalytics },
    });
    return this.getSettings();
  }
}
