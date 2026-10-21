import { BadRequestException, Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { round4, roundMoney } from "@routeflow/pricing";
import { AuditService } from "../audit/audit.service";
import {
  addCalendarDays,
  InsightWindowError,
  resolveInsightRange,
} from "../analytics/demand-range";
import { CSV_BOM, csvRow } from "../common/csv";
import { roundQty } from "../common/invoiced-sales";
import { PrismaService } from "../prisma/prisma.service";
import { tenantSafeParent } from "./product-parent";
import { SalesFactsService } from "../sales-facts/sales-facts.service";
import { ExportProductsDto } from "./dto/export-products.dto";
import { buildProductListWhere } from "./product-list-where";
import { API_ERROR_CODES } from "../common/api-error-codes";

/** Most product rows one export streams before the trailing truncation row. */
export const PRODUCTS_EXPORT_MAX_ROWS = 50_000;
/** DI tokens so a spec can inject a small cap / batch; production uses the defaults. */
export const PRODUCTS_EXPORT_CAP = "PRODUCTS_EXPORT_CAP";
export const PRODUCTS_EXPORT_BATCH = "PRODUCTS_EXPORT_BATCH";
const DEFAULT_BATCH = 500;
/** "Last 30 days" = today and the 29 days before it. */
const DEFAULT_WINDOW_DAYS = 30;

export const PRODUCTS_EXPORT_HEADER = [
  "Name",
  "SKU",
  "Unit SKU",
  "Barcode",
  "Category",
  "Unit",
  "Price per unit",
  "Avg cost",
  "Units per case",
  "Stock",
  "Active",
  "Tobacco",
  "Family / Variant of (parent product name)",
  "Units sold",
  "Net sales",
  "Last sold date",
  // SA-823 (row 655): the stable key the product import's Family columns match on.
  "Product ID",
];

const num = (v: unknown) => (v == null ? null : Number(v));
const yesNo = (b: boolean) => (b ? "Yes" : "No");

const SELECT = {
  id: true,
  name: true,
  sku: true,
  unitSku: true,
  barcode: true,
  category: true,
  unit: true,
  pricePerUnit: true,
  averageCost: true,
  unitsPerBox: true,
  currentStock: true,
  isActive: true,
  isTobacco: true,
  // tenantId only for the cross-tenant check (B1211); it is never written to the file.
  parent: { select: { name: true, tenantId: true } },
} as const;

/**
 * `GET /products/export.csv` — the catalog as a streamed, injection-safe CSV, with the period's
 * accrual stats per product. No storage or presign call: a file of 50k rows must not fan out to
 * 50k signed URLs. Filters come from the list's own where-builder; sales figures come from the
 * sales-facts layer (invoices on the accrual basis — never an order or a payment status).
 */
@Injectable()
export class ProductsExportService {
  private readonly logger = new Logger(ProductsExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly facts: SalesFactsService,
    private readonly audit: AuditService,
    @Optional()
    @Inject(PRODUCTS_EXPORT_CAP)
    private readonly cap: number = PRODUCTS_EXPORT_MAX_ROWS,
    @Optional() @Inject(PRODUCTS_EXPORT_BATCH) private readonly batch: number = DEFAULT_BATCH,
  ) {}

  /** Validates the window BEFORE any byte is streamed (a refused request stays a JSON 400). */
  async prepare(
    query: ExportProductsDto,
    actor: { userId: string | null; ip?: string | null },
  ): Promise<{ csv: AsyncIterable<string>; filename: string }> {
    const tenantId = this.facts.requireTenantId();
    const timezone = await this.facts.tenantTimezone(tenantId);
    const today = this.facts.today(timezone);
    const blank = (v?: string | null) => (v == null || v.trim() === "" ? null : v.trim());
    let range: { fromDay: string; toDay: string };
    try {
      const to = blank(query.to) ?? today;
      const from = blank(query.from) ?? addCalendarDays(to, -(DEFAULT_WINDOW_DAYS - 1));
      range = resolveInsightRange({ from, to }, today);
    } catch (err) {
      if (err instanceof InsightWindowError) {
        throw new BadRequestException({
          code: API_ERROR_CODES.INSIGHT_WINDOW_INVALID,
          message: err.message,
          reason: err.reason,
          ...err.params,
        });
      }
      throw err;
    }
    return {
      filename: `products-${today}.csv`,
      csv: this.stream(tenantId, timezone, range, query, actor),
    };
  }

  private async *stream(
    tenantId: string,
    timezone: string | null,
    range: { fromDay: string; toDay: string },
    query: ExportProductsDto,
    actor: { userId: string | null; ip?: string | null },
  ): AsyncGenerator<string> {
    const base = buildProductListWhere(query);
    const issueWindow = this.facts.issueWindow(range.fromDay, range.toDay);
    let credits: Map<string, number> | null = null;
    let written = 0;
    let truncated = false;
    let failed = false;
    // Keyset cursor on the list's order (name asc, id as the tie-break): stable across batches.
    let last: { id: string; name: string } | undefined;

    yield CSV_BOM + csvRow(PRODUCTS_EXPORT_HEADER);
    try {
      for (;;) {
        const remaining = this.cap - written;
        const take = Math.min(this.batch, remaining + 1);
        // eslint-disable-next-line no-await-in-loop
        let rows: any[] = await this.prisma.forTenant().product.findMany({
          where: last
            ? {
                ...base,
                AND: [
                  ...(base.AND ?? []),
                  { OR: [{ name: { gt: last.name } }, { name: last.name, id: { gt: last.id } }] },
                ],
              }
            : base,
          select: SELECT,
          orderBy: [{ name: "asc" }, { id: "asc" }],
          take,
        });
        const fetched = rows.length;
        if (fetched > remaining) {
          truncated = true;
          rows = rows.slice(0, remaining);
        }
        if (rows.length > 0) {
          // eslint-disable-next-line no-await-in-loop
          const stats = await this.facts.periodProductStats(
            tenantId,
            rows.map((r) => r.id),
            issueWindow,
            new Map(rows.map((r) => [r.id as string, (r.unitsPerBox as number | null) ?? null])),
          );
          if (!credits) {
            // eslint-disable-next-line no-await-in-loop
            credits = (
              await this.facts.tenantCreditBreakdown(
                tenantId,
                this.facts.instantWindow(range.fromDay, range.toDay, timezone),
              )
            ).byProduct;
          }
          let chunk = "";
          for (const r of rows) {
            const s = stats.get(r.id);
            chunk += csvRow([
              r.name,
              r.sku,
              r.unitSku,
              r.barcode,
              r.category,
              r.unit,
              roundMoney(Number(r.pricePerUnit)),
              r.averageCost == null ? null : round4(Number(r.averageCost)),
              r.unitsPerBox,
              roundQty(Number(r.currentStock ?? 0)),
              yesNo(r.isActive),
              yesNo(r.isTobacco),
              tenantSafeParent(r.parent, tenantId)?.name ?? null,
              roundQty(s?.pieces ?? 0),
              roundMoney((s?.gross ?? 0) - (credits.get(r.id) ?? 0)),
              s?.lastSold ? s.lastSold.toISOString().slice(0, 10) : null,
              r.id,
            ]);
          }
          yield chunk;
          written += rows.length;
          last = { id: rows[rows.length - 1].id, name: rows[rows.length - 1].name };
        }
        if (truncated || fetched < take) break;
      }
    } catch (err) {
      failed = true;
      this.logger.error(`Products CSV export failed mid-stream: ${(err as Error)?.message}`);
      yield "# export failed: the file is incomplete\r\n";
    } finally {
      const { page: _page, limit: _limit, from: _from, to: _to, ...filters } = query as any;
      await this.audit.log({
        tenantId,
        userId: actor.userId,
        ip: actor.ip ?? null,
        action: "PRODUCTS_EXPORT_CSV",
        entityType: "Product",
        meta: {
          rowCount: written,
          filters: Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined)),
          from: range.fromDay,
          to: range.toDay,
          truncated,
          ...(failed ? { failed: true } : {}),
        },
      });
    }
    if (truncated) yield `# truncated at ${this.cap} rows\r\n`;
  }
}
