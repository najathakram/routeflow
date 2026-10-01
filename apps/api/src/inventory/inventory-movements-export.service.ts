import { BadRequestException, Inject, Injectable, Logger, Optional } from "@nestjs/common";
import { round4 } from "@routeflow/pricing";
import { AuditService } from "../audit/audit.service";
import { CSV_BOM, csvRow } from "../common/csv";
import { roundQty } from "../common/invoiced-sales";
import { PrismaService } from "../prisma/prisma.service";
import { ExportMovementsDto } from "./dto/export-movements.dto";
import { buildMovementsWhere } from "./movements-where";

/** Most movement rows one export streams before the trailing truncation row. */
export const MOVEMENTS_EXPORT_MAX_ROWS = 50_000;
/** DI tokens so a spec can inject a small cap / batch; production uses the defaults. */
export const MOVEMENTS_EXPORT_CAP = "MOVEMENTS_EXPORT_CAP";
export const MOVEMENTS_EXPORT_BATCH = "MOVEMENTS_EXPORT_BATCH";
const DEFAULT_BATCH = 1000;

export const MOVEMENTS_EXPORT_HEADER = [
  "Date",
  "Type",
  "Product",
  "SKU",
  "Unit",
  "Quantity",
  "Unit cost",
  "Stock after",
  "Supplier",
  "Reference",
  "Performed by",
  "Notes",
];

const num = (v: unknown) => (v == null ? null : Number(v));
const ORDER = [
  { effectiveAt: "desc" as const },
  { createdAt: "desc" as const },
  { id: "desc" as const },
];

/**
 * `GET /inventory/movements/export.csv` — the movements list's own filters (ONE shared where builder)
 * as a streamed, injection-safe CSV: 1,000-row keyset chunks on the list's order, a cap with a
 * truncation row, a failure row inside the file, one audit row. Nothing is buffered whole.
 */
@Injectable()
export class InventoryMovementsExportService {
  private readonly logger = new Logger(InventoryMovementsExportService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    @Optional()
    @Inject(MOVEMENTS_EXPORT_CAP)
    private readonly cap: number = MOVEMENTS_EXPORT_MAX_ROWS,
    @Optional() @Inject(MOVEMENTS_EXPORT_BATCH) private readonly batch: number = DEFAULT_BATCH,
  ) {}

  /** Validates the window BEFORE any byte is streamed (a refused request stays a JSON 400). */
  async prepare(
    query: ExportMovementsDto,
    actor: { userId: string | null; ip?: string | null },
  ): Promise<{ csv: AsyncIterable<string>; filename: string }> {
    if (query.from && query.to && new Date(query.from) > new Date(query.to)) {
      throw new BadRequestException("from must be on or before to");
    }
    return {
      filename: `inventory-movements-${new Date().toISOString().slice(0, 10)}.csv`,
      csv: this.stream(query, actor),
    };
  }

  private async *stream(
    query: ExportMovementsDto,
    actor: { userId: string | null; ip?: string | null },
  ): AsyncGenerator<string> {
    const tenantId = this.prisma.getTenantId();
    const base = buildMovementsWhere(query);
    let written = 0;
    let truncated = false;
    let failed = false;
    let last: { effectiveAt: Date; createdAt: Date; id: string } | undefined;

    yield CSV_BOM + csvRow(MOVEMENTS_EXPORT_HEADER);
    try {
      for (;;) {
        const remaining = this.cap - written;
        const take = Math.min(this.batch, remaining + 1);
        // eslint-disable-next-line no-await-in-loop
        let rows: any[] = await this.prisma.forTenant().stockMovement.findMany({
          where: last
            ? {
                AND: [
                  base,
                  {
                    OR: [
                      { effectiveAt: { lt: last.effectiveAt } },
                      { effectiveAt: last.effectiveAt, createdAt: { lt: last.createdAt } },
                      {
                        effectiveAt: last.effectiveAt,
                        createdAt: last.createdAt,
                        id: { lt: last.id },
                      },
                    ],
                  },
                ],
              }
            : base,
          orderBy: ORDER,
          take,
          include: {
            product: { select: { id: true, name: true, sku: true, unit: true } },
            supplier: { select: { id: true, name: true } },
            performedBy: { select: { id: true, username: true } },
          },
        });
        const fetched = rows.length;
        if (fetched > remaining) {
          truncated = true;
          rows = rows.slice(0, remaining);
        }
        if (rows.length > 0) {
          let chunk = "";
          for (const m of rows) {
            chunk += csvRow([
              m.effectiveAt.toISOString(),
              m.type,
              m.product?.name ?? null,
              m.product?.sku ?? null,
              m.product?.unit ?? null,
              roundQty(Number(m.quantity)),
              m.unitCost == null ? null : round4(Number(m.unitCost)),
              m.stockAfter == null ? null : roundQty(Number(num(m.stockAfter))),
              m.supplier?.name ?? null,
              m.reference,
              m.performedBy?.username ?? null,
              m.notes,
            ]);
          }
          yield chunk;
          written += rows.length;
          const tail = rows[rows.length - 1];
          last = { effectiveAt: tail.effectiveAt, createdAt: tail.createdAt, id: tail.id };
        }
        if (truncated || fetched < take) break;
      }
    } catch (err) {
      failed = true;
      this.logger.error(`Movements CSV export failed mid-stream: ${(err as Error)?.message}`);
      yield "# export failed: the file is incomplete\r\n";
    } finally {
      const { page: _page, limit: _limit, ...filters } = query as any;
      await this.audit.log({
        tenantId,
        userId: actor.userId,
        ip: actor.ip ?? null,
        action: "INVENTORY_MOVEMENTS_EXPORT_CSV",
        entityType: "StockMovement",
        meta: {
          rowCount: written,
          filters: Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== undefined)),
          truncated,
          ...(failed ? { failed: true } : {}),
        },
      });
    }
    if (truncated) yield `# truncated at ${this.cap} rows\r\n`;
  }
}
