import React from "react";
import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { renderToBuffer } from "@react-pdf/renderer";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { AuditService } from "../audit/audit.service";
import { TenantContextService } from "../tenant/tenant-context.service";
import { roundMoney } from "../common/pricing";
import { TobaccoReportPdf } from "./tobacco-report-pdf";
import type { TobaccoReportRow, TobaccoReportTotals } from "./tobacco-report.types";

const REAL_INVOICE_STATUSES = { notIn: ["DRAFT", "VOID", "WRITTEN_OFF"] as any };

@Injectable()
export class TobaccoReportService {
  private readonly logger = new Logger(TobaccoReportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly tenantCtx: TenantContextService,
  ) {}

  async listReports() {
    return this.prisma.forTenant().tobaccoReport.findMany({
      orderBy: [{ periodYear: "desc" }, { periodMonth: "desc" }],
    });
  }

  async downloadUrl(id: string, format: "csv" | "pdf") {
    const report = await this.prisma.forTenant().tobaccoReport.findUnique({ where: { id } });
    if (!report) throw new NotFoundException("Report not found");
    const key = format === "csv" ? report.csvKey : report.pdfKey;
    if (!key) throw new NotFoundException(`No ${format.toUpperCase()} stored for this report`);
    return { url: await this.storage.presignedUrl(key) };
  }

  /**
   * (Re)generate the report for a PAST month. Upserts the (tenant, period)
   * row — regeneration overwrites the CSV/PDF at deterministic keys, bumps
   * generationCount, and is audit-logged.
   */
  async generateForPeriod(year: number, month: number, opts?: { userId?: string | null }) {
    const periodStart = new Date(Date.UTC(year, month - 1, 1));
    const periodEnd = new Date(Date.UTC(year, month, 1) - 1);
    if (periodEnd >= new Date()) {
      throw new BadRequestException(
        "Reports can only be generated for completed months — the period must be in the past.",
      );
    }

    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("Tobacco reports are tenant-scoped");

    const { rows, totals } = await this.buildRows(periodStart, periodEnd);
    const periodLabel = `${year}-${String(month).padStart(2, "0")}`;

    // Business name for the PDF header
    const config = await this.prisma.tenantConfig.findUnique({
      where: { tenantId },
      select: { businessName: true },
    });
    const businessName = config?.businessName ?? "RouteFlow tenant";

    // Deterministic storage keys — regeneration overwrites in place
    const csvKey = `tobacco-reports/${tenantId}/${periodLabel}.csv`;
    const pdfKey = `tobacco-reports/${tenantId}/${periodLabel}.pdf`;

    // forTenant() can't inject into composite-unique upserts — findFirst + create/update
    const existing = await this.prisma.forTenant().tobaccoReport.findFirst({
      where: { periodYear: year, periodMonth: month },
    });
    const generationCount = existing ? existing.generationCount + 1 : 1;

    const csv = this.buildCsv(rows, totals, periodLabel);
    await this.storage.upload(csvKey, Buffer.from(csv, "utf8"), "text/csv");

    const pdfBuffer = await renderToBuffer(
      React.createElement(TobaccoReportPdf as any, {
        businessName,
        periodLabel,
        rows,
        totals,
        generatedAt: new Date().toISOString().slice(0, 10),
        generationCount,
      }) as any,
    );
    await this.storage.upload(pdfKey, pdfBuffer, "application/pdf");

    const data = {
      periodYear: year,
      periodMonth: month,
      periodStart,
      periodEnd,
      status: "GENERATED" as const,
      totalQtyPurchased: totals.totalQtyPurchased,
      totalPurchaseValue: totals.totalPurchaseValue,
      totalQtySold: totals.totalQtySold,
      totalSalesValue: totals.totalSalesValue,
      totalTaxCollected: totals.totalTaxCollected,
      endingStockQty: totals.endingStockQty,
      endingStockValue: totals.endingStockValue,
      rows: rows as unknown as Prisma.InputJsonValue,
      csvKey,
      pdfKey,
      generatedAt: new Date(),
      generatedById: opts?.userId ?? null,
      generationCount,
      errorMessage: null,
    };

    const report = existing
      ? await this.prisma.forTenant().tobaccoReport.update({ where: { id: existing.id }, data })
      : await (this.prisma.forTenant().tobaccoReport.create as any)({ data });

    await this.audit.log({
      tenantId,
      userId: opts?.userId ?? null,
      action: "tobacco_report.generated",
      entityType: "TobaccoReport",
      entityId: report.id,
      meta: {
        year,
        month,
        regenerated: !!existing,
        generationCount,
        trigger: opts?.userId ? "manual" : "cron",
      },
    });

    return report;
  }

  /** Per-product purchases/sales/tax + ending stock for the period. */
  private async buildRows(
    periodStart: Date,
    periodEnd: Date,
  ): Promise<{ rows: TobaccoReportRow[]; totals: TobaccoReportTotals }> {
    const [products, purchases, sales, afterMovements] = await Promise.all([
      this.prisma.forTenant().product.findMany({
        where: { isTobacco: true },
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          sku: true,
          unit: true,
          currentStock: true,
          averageCost: true,
        },
      }),
      this.prisma.forTenant().stockMovement.findMany({
        where: {
          type: "PURCHASE",
          createdAt: { gte: periodStart, lte: periodEnd },
          product: { isTobacco: true },
        },
        select: { productId: true, quantity: true, unitCost: true },
      }),
      this.prisma.forTenant().invoiceItem.findMany({
        where: {
          product: { isTobacco: true },
          invoice: {
            issueDate: { gte: periodStart, lte: periodEnd },
            status: REAL_INVOICE_STATUSES,
          },
        },
        select: { productId: true, qty: true, subtotal: true, taxRate: true },
      }),
      // Movements AFTER the period: ending stock = currentStock − Σ(after).
      // Works because SALE quantities are stored negative, PURCHASE positive.
      this.prisma.forTenant().stockMovement.findMany({
        where: { createdAt: { gt: periodEnd }, product: { isTobacco: true } },
        select: { productId: true, quantity: true },
      }),
    ]);

    const zero = () => new Prisma.Decimal(0);
    const byProduct = new Map<
      string,
      {
        qtyP: Prisma.Decimal;
        valP: Prisma.Decimal;
        qtyS: Prisma.Decimal;
        valS: Prisma.Decimal;
        tax: Prisma.Decimal;
      }
    >();
    const bucket = (id: string) => {
      let b = byProduct.get(id);
      if (!b) {
        b = { qtyP: zero(), valP: zero(), qtyS: zero(), valS: zero(), tax: zero() };
        byProduct.set(id, b);
      }
      return b;
    };

    for (const p of purchases) {
      const b = bucket(p.productId);
      const qty = new Prisma.Decimal(p.quantity);
      b.qtyP = b.qtyP.add(qty);
      b.valP = b.valP.add(qty.mul(new Prisma.Decimal(p.unitCost ?? 0)));
    }
    for (const s of sales) {
      if (!s.productId) continue;
      const b = bucket(s.productId);
      const subtotal = new Prisma.Decimal(s.subtotal);
      b.qtyS = b.qtyS.add(new Prisma.Decimal(s.qty));
      b.valS = b.valS.add(subtotal);
      b.tax = b.tax.add(subtotal.mul(new Prisma.Decimal(s.taxRate)));
    }

    const afterByProduct = new Map<string, Prisma.Decimal>();
    for (const m of afterMovements) {
      afterByProduct.set(
        m.productId,
        (afterByProduct.get(m.productId) ?? zero()).add(new Prisma.Decimal(m.quantity)),
      );
    }

    const rows: TobaccoReportRow[] = [];
    const totals: TobaccoReportTotals = {
      totalQtyPurchased: 0,
      totalPurchaseValue: 0,
      totalQtySold: 0,
      totalSalesValue: 0,
      totalTaxCollected: 0,
      endingStockQty: 0,
      endingStockValue: 0,
    };

    for (const p of products) {
      const b = byProduct.get(p.id) ?? {
        qtyP: zero(),
        valP: zero(),
        qtyS: zero(),
        valS: zero(),
        tax: zero(),
      };
      const endingQty = new Prisma.Decimal(p.currentStock).sub(afterByProduct.get(p.id) ?? zero());
      // v1 approximation, disclosed on the report: CURRENT average cost
      const endingValue = endingQty.mul(new Prisma.Decimal(p.averageCost ?? 0));

      // Skip products with zero activity AND zero ending stock to keep filings lean
      if (b.qtyP.eq(0) && b.qtyS.eq(0) && endingQty.eq(0)) continue;

      rows.push({
        productId: p.id,
        name: p.name,
        sku: p.sku,
        unit: p.unit,
        qtyPurchased: b.qtyP.toString(),
        purchaseValue: roundMoney(Number(b.valP)).toFixed(2),
        qtySold: b.qtyS.toString(),
        salesValue: roundMoney(Number(b.valS)).toFixed(2),
        taxCollected: roundMoney(Number(b.tax)).toFixed(2),
        endingStockQty: endingQty.toString(),
        endingStockValue: roundMoney(Number(endingValue)).toFixed(2),
      });
      totals.totalQtyPurchased += Number(b.qtyP);
      totals.totalPurchaseValue += Number(b.valP);
      totals.totalQtySold += Number(b.qtyS);
      totals.totalSalesValue += Number(b.valS);
      totals.totalTaxCollected += Number(b.tax);
      totals.endingStockQty += Number(endingQty);
      totals.endingStockValue += Number(endingValue);
    }

    totals.totalPurchaseValue = roundMoney(totals.totalPurchaseValue);
    totals.totalSalesValue = roundMoney(totals.totalSalesValue);
    totals.totalTaxCollected = roundMoney(totals.totalTaxCollected);
    totals.endingStockValue = roundMoney(totals.endingStockValue);

    return { rows, totals };
  }

  private buildCsv(rows: TobaccoReportRow[], totals: TobaccoReportTotals, period: string): string {
    const esc = (v: string | null) => {
      const s = v ?? "";
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [
      `Monthly Tobacco Report,${period}`,
      "Product,SKU,Unit,Qty Purchased,Purchase Value,Qty Sold,Sales Value,Tax Collected,Ending Stock Qty,Ending Stock Value",
      ...rows.map((r) =>
        [
          esc(r.name),
          esc(r.sku),
          esc(r.unit),
          r.qtyPurchased,
          r.purchaseValue,
          r.qtySold,
          r.salesValue,
          r.taxCollected,
          r.endingStockQty,
          r.endingStockValue,
        ].join(","),
      ),
      [
        "TOTALS",
        "",
        "",
        totals.totalQtyPurchased,
        totals.totalPurchaseValue.toFixed(2),
        totals.totalQtySold,
        totals.totalSalesValue.toFixed(2),
        totals.totalTaxCollected.toFixed(2),
        totals.endingStockQty,
        totals.endingStockValue.toFixed(2),
      ].join(","),
    ];
    return lines.join("\n") + "\n";
  }

  // ─── Monthly cron — 02:00 UTC on the 1st, for the month just ended ─────────

  @Cron("0 2 1 * *")
  async generateMonthlyReports() {
    // One query for all active tobacco_dealer addons, intersect active tenants
    const [activeTenants, tobaccoAddons] = await Promise.all([
      this.prisma.tenant.findMany({ where: { status: "ACTIVE" }, select: { id: true } }),
      this.prisma.tenantAddon.findMany({
        where: { addonKey: "tobacco_dealer", active: true },
        select: { tenantId: true },
      }),
    ]);
    const enabled = new Set(tobaccoAddons.map((a) => a.tenantId));
    const tenants = activeTenants.filter((t) => enabled.has(t.id));
    if (tenants.length === 0) return;

    const now = new Date();
    const prev = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
    const year = prev.getUTCFullYear();
    const month = prev.getUTCMonth() + 1;

    let ok = 0;
    let failed = 0;
    for (const tenant of tenants) {
      // Cron has no HTTP context — run each tenant in its own ALS scope
      await this.tenantCtx.run(tenant.id, async () => {
        try {
          // Idempotent: skip if this period already generated (deploy restarts)
          const existing = await this.prisma.forTenant().tobaccoReport.findFirst({
            where: { periodYear: year, periodMonth: month, status: "GENERATED" },
          });
          if (existing) return;
          await this.generateForPeriod(year, month, { userId: null });
          ok++;
        } catch (err) {
          failed++;
          this.logger.error(
            `[tenant:${tenant.id}] Tobacco report ${year}-${month} failed: ${err instanceof Error ? err.message : err}`,
          );
          // Record the failure so the tenant sees it in their report list
          try {
            const failedExisting = await this.prisma.forTenant().tobaccoReport.findFirst({
              where: { periodYear: year, periodMonth: month },
            });
            const failData = {
              status: "FAILED" as const,
              errorMessage: err instanceof Error ? err.message : String(err),
            };
            if (failedExisting) {
              await this.prisma
                .forTenant()
                .tobaccoReport.update({ where: { id: failedExisting.id }, data: failData });
            } else {
              await (this.prisma.forTenant().tobaccoReport.create as any)({
                data: {
                  periodYear: year,
                  periodMonth: month,
                  periodStart: new Date(Date.UTC(year, month - 1, 1)),
                  periodEnd: new Date(Date.UTC(year, month, 1) - 1),
                  rows: [],
                  ...failData,
                },
              });
            }
          } catch {
            // best-effort failure record
          }
        }
      });
    }
    this.logger.log(
      `Tobacco reports ${year}-${String(month).padStart(2, "0")}: ${ok} generated, ${failed} failed across ${tenants.length} tenant(s).`,
    );
  }
}
