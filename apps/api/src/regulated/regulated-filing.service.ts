import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { AuditService } from "../audit/audit.service";
import { RegulatedService } from "./regulated.service";
import { RegulatedReportService } from "./regulated-report.service";
import { roundMoney } from "../common/pricing";
import { filingPeriod, FilingCadence } from "./period";
import { buildFilingCsv } from "./filing-csv";
import { serializeReportCsv } from "./report-csv";

/** Round a quantity to 3 decimals — matches Decimal(12,3) + the CSV's .toFixed(3). */
const roundQty = (n: number) => Math.round(n * 1000) / 1000;

/** One persisted filing row: a per-(category, periodBucket) signed net snapshot. */
interface FilingRow {
  trackedCategoryId: string;
  categoryName: string;
  periodBucket: string;
  qty: number;
  unitBasisQty: number;
  netSales: number;
  categoryTax: number;
}

/**
 * Phase 4 (W5b): prepares regulatory filings — the generic superset of
 * TobaccoReportService. A filing is computed from the pre-signed
 * RegulatedSalesLedger (via RegulatedService.getLedger) for one category + period,
 * persisted with denormalized signed totals, and exported as a CSV artifact whose
 * columns are driven by the category's reportTemplate. TobaccoReportService is left
 * untouched — this lives beside it.
 */
@Injectable()
export class RegulatedFilingService {
  private readonly logger = new Logger(RegulatedFilingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly audit: AuditService,
    private readonly regulated: RegulatedService,
    // WP11: TX_COMPTROLLER filings store a per-invoice TX report instead of the
    // (category, period) aggregate — see the branch in prepareFiling below.
    private readonly reports: RegulatedReportService,
  ) {}

  /** Tenant-scoped list of prepared filings, newest period first. */
  async listFilings(categoryId?: string) {
    return this.prisma.forTenant().regulatedFiling.findMany({
      where: categoryId ? { trackedCategoryId: categoryId } : {},
      orderBy: [{ periodKey: "desc" }],
    });
  }

  /** Presigned URL for a filing's stored CSV/PDF artifact. */
  async downloadUrl(id: string, format: "csv" | "pdf") {
    const filing = await this.prisma.forTenant().regulatedFiling.findUnique({ where: { id } });
    if (!filing) throw new NotFoundException("Filing not found");
    const key = format === "csv" ? filing.csvKey : filing.pdfKey;
    if (!key) throw new NotFoundException(`No ${format.toUpperCase()} stored for this filing`);
    return { url: await this.storage.presignedUrl(key) };
  }

  /**
   * (Re)generate the filing for a PAST period. Upserts the (tenant, category,
   * period) row — regeneration overwrites the CSV at a deterministic key, bumps
   * generationCount, and is audit-logged. Totals are the ledger's pre-signed nets,
   * so a reversal-heavy period legitimately nets down (never re-signed/clamped).
   */
  async prepareFiling(params: {
    trackedCategoryId: string;
    cadence?: FilingCadence;
    year: number;
    index?: number;
    userId?: string | null;
  }) {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("Filings are tenant-scoped");

    const category = await this.prisma
      .forTenant()
      .trackedCategory.findUnique({ where: { id: params.trackedCategoryId } });
    if (!category) throw new NotFoundException("Tracked category not found");

    const cadence = (params.cadence ?? category.reportCadence) as FilingCadence;
    const index = params.index ?? 1; // ANNUAL ignores it
    // Cadence-specific range → a clean 400 rather than filingPeriod's RangeError.
    if (cadence === "QUARTERLY" && (index < 1 || index > 4))
      throw new BadRequestException("index (quarter) must be 1-4 for a QUARTERLY filing");
    if (cadence === "MONTHLY" && (index < 1 || index > 12))
      throw new BadRequestException("index (month) must be 1-12 for a MONTHLY filing");

    const { periodKey, buckets, from, to } = filingPeriod(cadence, params.year, index);

    // `to` is the exclusive end; the period is complete once now >= to.
    if (to > new Date()) {
      throw new BadRequestException(
        "Filings can only be prepared for completed periods — the period must be in the past.",
      );
    }

    // Reuse the netting-correct read model, then defensively keep only rows whose
    // periodBucket is in this filing's bucket set. getLedger's from/to is a soldAt
    // window, so a cross-period reversal (booked in a later period) could otherwise
    // leak in; filtering by bucket honors the pre-signed per-period netting.
    // Exact half-open [from, to) window (exclusiveTo) — no `to − 1ms` reconstruction
    // that could drop a sub-millisecond boundary sale and under-report the filing.
    const ledger = await this.regulated.getLedger(
      {
        category: params.trackedCategoryId,
        from: from.toISOString(),
        to: to.toISOString(),
      },
      { exclusiveTo: true },
    );
    const bucketSet = new Set(buckets);
    const rows: FilingRow[] = ledger.rows
      .filter((r) => bucketSet.has(r.periodBucket))
      .map((r) => ({
        trackedCategoryId: r.trackedCategoryId,
        categoryName: r.categoryName,
        periodBucket: r.periodBucket,
        qty: roundQty(Number(r.qty)),
        unitBasisQty: roundQty(Number(r.unitBasisQty)),
        netSales: roundMoney(Number(r.netSales)),
        categoryTax: roundMoney(Number(r.categoryTax)),
      }));

    // Round every persisted surface so the JSON rows, the DB Decimal columns, and
    // the CSV all agree exactly (qty→3dp, money→2dp). Pre-signed nets are never
    // re-signed/clamped — a reversal-heavy period legitimately totals negative.
    const totals = rows.reduce(
      (t, r) => ({
        qty: t.qty + r.qty,
        unitBasisQty: t.unitBasisQty + r.unitBasisQty,
        netSales: t.netSales + r.netSales,
        categoryTax: t.categoryTax + r.categoryTax,
      }),
      { qty: 0, unitBasisQty: 0, netSales: 0, categoryTax: 0 },
    );
    totals.qty = roundQty(totals.qty);
    totals.unitBasisQty = roundQty(totals.unitBasisQty);
    totals.netSales = roundMoney(totals.netSales);
    totals.categoryTax = roundMoney(totals.categoryTax);

    // CSV artifact — columns driven by the category's reportTemplate. TX_COMPTROLLER
    // stores a per-invoice TX report instead of the (category, period) aggregate; the
    // Decimal totals above are ALWAYS the ledger aggregate, regardless of template —
    // only the CSV bytes + the persisted `rows` Json shape differ for TX.
    let csv: string;
    let rowsJson: Prisma.InputJsonValue;
    if (category.reportTemplate === "TX_COMPTROLLER") {
      const txReport = await this.reports.buildTxReportForRange(
        {
          id: category.id,
          name: category.name,
          wholesalerLicenseNo: category.wholesalerLicenseNo,
          txItemType: category.txItemType,
          txUom: category.txUom,
        },
        from,
        to,
        { from: periodKey, to: periodKey },
      );
      csv = serializeReportCsv(txReport);
      rowsJson = {
        txRows: txReport.rows,
        warnings: txReport.warnings,
      } as unknown as Prisma.InputJsonValue;
    } else {
      csv = buildFilingCsv(category.reportTemplate, {
        categoryName: category.name,
        unitBasis: category.unitBasis,
        periodKey,
        rows: rows.map((r) => ({
          periodBucket: r.periodBucket,
          qty: r.qty,
          unitBasisQty: r.unitBasisQty,
          netSales: r.netSales,
          categoryTax: r.categoryTax,
        })),
        totals,
      });
      rowsJson = rows as unknown as Prisma.InputJsonValue;
    }
    // Deterministic, tenant-scoped key — regeneration overwrites in place.
    const csvKey = `regulated-filings/${tenantId}/${params.trackedCategoryId}/${periodKey}.csv`;
    await this.storage.upload(csvKey, Buffer.from(csv, "utf8"), "text/csv");

    // forTenant() can't inject into a composite-unique upsert — findFirst + create/update.
    const existing = await this.prisma.forTenant().regulatedFiling.findFirst({
      where: { trackedCategoryId: params.trackedCategoryId, periodKey },
    });
    const generationCount = existing ? existing.generationCount + 1 : 1;

    const data = {
      trackedCategoryId: params.trackedCategoryId,
      reportTemplate: category.reportTemplate,
      cadence,
      periodKey,
      periodStart: from,
      periodEnd: to,
      status: "GENERATED" as const,
      totalQty: totals.qty,
      totalUnitBasisQty: totals.unitBasisQty,
      totalNetSales: totals.netSales,
      totalCategoryTax: totals.categoryTax,
      rows: rowsJson,
      csvKey,
      pdfKey: null,
      generatedAt: new Date(),
      generatedById: params.userId ?? null,
      generationCount,
      errorMessage: null,
    };

    // On a concurrent prepare both callers can miss `existing`; the loser then
    // hits the @@unique constraint. Retry it as an update so a double-submit or a
    // cron/manual overlap regenerates cleanly instead of surfacing a raw 500.
    let filing;
    try {
      filing = existing
        ? await this.prisma.forTenant().regulatedFiling.update({ where: { id: existing.id }, data })
        : await (this.prisma.forTenant().regulatedFiling.create as any)({ data });
    } catch (err: any) {
      if (err?.code !== "P2002") throw err;
      const raced = await this.prisma.forTenant().regulatedFiling.findFirst({
        where: { trackedCategoryId: params.trackedCategoryId, periodKey },
      });
      if (!raced) throw err;
      filing = await this.prisma.forTenant().regulatedFiling.update({
        where: { id: raced.id },
        data: { ...data, generationCount: raced.generationCount + 1 },
      });
    }

    await this.audit.log({
      tenantId,
      userId: params.userId ?? null,
      action: "regulated_filing.prepared",
      entityType: "RegulatedFiling",
      entityId: filing.id,
      meta: {
        trackedCategoryId: params.trackedCategoryId,
        reportTemplate: category.reportTemplate,
        cadence,
        periodKey,
        regenerated: !!existing,
        generationCount,
        trigger: params.userId ? "manual" : "cron",
      },
    });

    return filing;
  }
}
