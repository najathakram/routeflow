import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { RegulatedService } from "./regulated.service";
import { buildAggregateReport } from "./filing-csv";
import { serializeReportCsv } from "./report-csv";
import {
  buildTxReport,
  TxCategoryConfig,
  TxCustomerInfo,
  TxInvoiceInfo,
  TxLedgerRow,
} from "./tx-report";
import { RegulatedReport } from "./report-types";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const MAX_RANGE_DAYS = 366;

/**
 * WP11: stateless regulated reporting — computes a `RegulatedReport` over an
 * ARBITRARY date range and persists nothing (filings stay period-keyed and
 * remain the compliance archive; see regulated-filing.service.ts). One row model
 * (report-types.ts) feeds both the in-app JSON preview and the CSV download, so
 * what the operator sees is literally the downloaded file.
 */
@Injectable()
export class RegulatedReportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly regulated: RegulatedService,
  ) {}

  /**
   * Validate `from`/`to` as YYYY-MM-DD, `from <= to`, and an inclusive span of at
   * most 366 days (a full leap year), then return the half-open UTC window
   * `[from 00:00Z, to+1day 00:00Z)` a `soldAt` query should use.
   */
  private parseRange(from: string, to: string): { fromDate: Date; toExclusive: Date } {
    if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
      throw new BadRequestException("from/to must be YYYY-MM-DD");
    }
    const fromDate = new Date(`${from}T00:00:00.000Z`);
    const toDate = new Date(`${to}T00:00:00.000Z`);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      throw new BadRequestException("from/to must be valid dates");
    }
    if (fromDate.getTime() > toDate.getTime()) {
      throw new BadRequestException("from must be on or before to");
    }
    const inclusiveDays = Math.round((toDate.getTime() - fromDate.getTime()) / DAY_MS) + 1;
    if (inclusiveDays > MAX_RANGE_DAYS) {
      throw new BadRequestException(
        `Range too large — max ${MAX_RANGE_DAYS} days, got ${inclusiveDays}`,
      );
    }
    return { fromDate, toExclusive: new Date(toDate.getTime() + DAY_MS) };
  }

  /**
   * Compute the report for an arbitrary [from, to] inclusive-date range. The TX
   * path does a manual three-step join (RegulatedSalesLedger has no Prisma
   * relations — `invoiceId` is a plain indexed scalar, so `include` is
   * impossible): ledger rows → invoices → customers (+ addresses + this
   * category's authorizations). Non-TX templates reuse
   * RegulatedService.getLedger (half-open) and feed buildAggregateReport.
   */
  async buildReport(params: {
    category: string;
    from: string;
    to: string;
    template?: string;
  }): Promise<RegulatedReport> {
    const { fromDate, toExclusive } = this.parseRange(params.from, params.to);

    const category = await this.prisma
      .forTenant()
      .trackedCategory.findUnique({ where: { id: params.category } });
    if (!category) throw new NotFoundException("Tracked category not found");

    const template = params.template || category.reportTemplate;

    if (template === "TX_COMPTROLLER") {
      return this.buildTxReportForRange(
        {
          id: category.id,
          name: category.name,
          wholesalerLicenseNo: category.wholesalerLicenseNo,
          txItemType: category.txItemType,
          txUom: category.txUom,
        },
        fromDate,
        toExclusive,
        { from: params.from, to: params.to },
      );
    }

    const ledger = await this.regulated.getLedger(
      { category: params.category, from: fromDate.toISOString(), to: toExclusive.toISOString() },
      { exclusiveTo: true },
    );
    const totals = ledger.rows.reduce(
      (t, r) => ({
        qty: t.qty + r.qty,
        unitBasisQty: t.unitBasisQty + r.unitBasisQty,
        netSales: t.netSales + r.netSales,
        categoryTax: t.categoryTax + r.categoryTax,
      }),
      { qty: 0, unitBasisQty: 0, netSales: 0, categoryTax: 0 },
    );

    return buildAggregateReport(template, {
      categoryName: category.name,
      unitBasis: category.unitBasis,
      periodKey: `${params.from} to ${params.to}`,
      periodLabel: `${params.from} to ${params.to}`,
      rows: ledger.rows.map((r) => ({
        periodBucket: r.periodBucket,
        qty: r.qty,
        unitBasisQty: r.unitBasisQty,
        netSales: r.netSales,
        categoryTax: r.categoryTax,
      })),
      totals,
      categoryId: category.id,
      from: params.from,
      to: params.to,
    });
  }

  /**
   * The TX manual three-step join, factored out so `regulated-filing.service.ts`
   * (prepareFiling's TX-templated filing storage) can reuse it against the
   * filing's already-resolved period `[from, toExclusive)` Date bounds, without
   * round-tripping through YYYY-MM-DD strings (and this class's 366-day cap,
   * which does not apply to a filing period).
   */
  async buildTxReportForRange(
    category: TxCategoryConfig,
    fromDate: Date,
    toExclusive: Date,
    labels: { from: string; to: string },
  ): Promise<RegulatedReport> {
    const ledgerRows = await this.prisma.forTenant().regulatedSalesLedger.findMany({
      where: { trackedCategoryId: category.id, soldAt: { gte: fromDate, lt: toExclusive } },
      select: { invoiceId: true, unitBasisQty: true, netSales: true },
    });
    const txLedgerRows: TxLedgerRow[] = ledgerRows.map((r) => ({
      invoiceId: r.invoiceId,
      unitBasisQty: Number(r.unitBasisQty),
      netSales: Number(r.netSales),
    }));

    const invoiceIds = [
      ...new Set(txLedgerRows.map((r) => r.invoiceId).filter((id): id is string => !!id)),
    ];
    const invoices = invoiceIds.length
      ? await this.prisma.forTenant().invoice.findMany({
          where: { id: { in: invoiceIds } },
          select: { id: true, invoiceNumber: true, issueDate: true, customerId: true },
        })
      : [];
    const invoicesById = new Map<string, TxInvoiceInfo>(invoices.map((i) => [i.id, i]));

    const customerIds = [...new Set(invoices.map((i) => i.customerId))];
    const customers = customerIds.length
      ? await this.prisma.forTenant().customer.findMany({
          where: { id: { in: customerIds } },
          select: {
            id: true,
            businessName: true,
            taxId: true,
            tobaccoLicenseNo: true,
            addresses: true,
            authorizations: {
              where: { trackedCategoryId: category.id },
              select: { licenseNumber: true },
            },
          },
        })
      : [];
    const customersById = new Map<string, TxCustomerInfo>(
      customers.map((c: any) => [
        c.id,
        {
          id: c.id,
          businessName: c.businessName,
          taxId: c.taxId,
          tobaccoLicenseNo: c.tobaccoLicenseNo,
          authLicenseNumber: c.authorizations[0]?.licenseNumber ?? null,
          addresses: c.addresses.map((a: any) => ({
            line1: a.line1,
            line2: a.line2,
            city: a.city,
            state: a.state,
            zip: a.zip,
            isDefault: a.isDefault,
            addressType: a.addressType,
          })),
        },
      ]),
    );

    return buildTxReport({
      category,
      ledgerRows: txLedgerRows,
      invoicesById,
      customersById,
      from: labels.from,
      to: labels.to,
    });
  }

  /** Slugify a category name for the download filename (never renders — filename only). */
  private slugify(s: string): string {
    return (
      s
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "") || "category"
    );
  }

  /**
   * Filename-safe token for the template, which is caller-supplied (`?template=`)
   * and echoed back by buildAggregateReport even on the unknown → GENERIC
   * fallback. The filename lands in a quoted `Content-Disposition` header, so
   * quotes, semicolons and CR/LF must never survive. Case is preserved — the
   * template codes are uppercase (GENERIC, TX_COMPTROLLER).
   */
  private safeToken(s: string): string {
    return s.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "report";
  }

  async buildReportCsv(params: {
    category: string;
    from: string;
    to: string;
    template?: string;
  }): Promise<{ csv: string; filename: string }> {
    const report = await this.buildReport(params);
    const csv = serializeReportCsv(report);
    const filename = `${this.slugify(report.categoryName)}-${this.safeToken(report.template)}-${params.from}-${params.to}.csv`;
    return { csv, filename };
  }
}
