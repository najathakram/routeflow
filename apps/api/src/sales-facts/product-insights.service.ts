import { Injectable, NotFoundException } from "@nestjs/common";
import { InvoiceStatus } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";
import type {
  InsightWindow,
  ProductInsightSaleLine,
  ProductInsightsProduct,
  ProductInsightsResponse,
  ProductSalesPage,
} from "@routeflow/types";
import { roundQty } from "../common/invoiced-sales";
import { CSV_BOM, csvRow } from "../common/csv";
import {
  type DemandRange,
  type InsightGrain,
  bucketIndexOf,
  demandWindow,
  rangeWindow,
  resolveInsightRange,
} from "../analytics/demand-range";
import { type LineNetting, type ProductRow, SalesFactsService } from "./sales-facts.service";
import { aggregateProductInsights } from "./product-insights.aggregate";
import {
  type LineKey,
  decodeLineCursor,
  encodeLineCursor,
  lineKeyOf,
  perPieceOf,
  salePiecesOf,
} from "./sales-facts.rules";
import {
  INSIGHT_CSV_MAX_LINES,
  INSIGHT_TOP_BUYERS,
  SALES_PAGE_DEFAULT_LIMIT,
  SALES_PAGE_MAX_LIMIT,
} from "./sales-facts.constants";
import type {
  ProductDemandSeries,
  ProductSaleLine,
  ProductSalesHistory,
} from "./legacy-product-shapes";
import type { ProductSaleFact } from "./sales-facts.types";
import type {
  ProductInsightsCsvQueryDto,
  ProductInsightsQueryDto,
  ProductSalesQueryDto,
} from "./dto/product-insights-query.dto";

/** Lines per CSV chunk: one line read + one netting read per chunk. */
const CSV_CHUNK_LINES = 1_000;

const CSV_HEADER = [
  "Date",
  "Invoice",
  "Written off",
  "Order",
  "Customer",
  "Qty (pieces)",
  "Qty as stored",
  "Boxes",
  "Loose pieces",
  "Pack at sale",
  "Unit",
  "Unit price",
  "Line total",
  "Per piece",
  "List price",
  "Re-priced",
  "Credited",
  "Returned (pieces)",
];

function toProductDto(p: ProductRow): ProductInsightsProduct {
  return {
    id: p.id,
    name: p.name,
    sku: p.sku ?? null,
    unitSku: p.unitSku ?? null,
    barcode: p.barcode ?? null,
    unitsPerBox: p.unitsPerBox ?? null,
    unitLabel: p.unit,
    isActive: p.isActive,
  };
}

/** The legacy line (`/analytics/product-sales`) — identical fields, plus the written-off badge. */
function toLegacySaleLine(f: ProductSaleFact): ProductSaleLine {
  return {
    date: f.issueDate.toISOString(),
    invoiceId: f.invoiceId,
    invoiceNumber: f.invoiceNumber,
    orderId: f.orderId,
    orderNumber: f.orderNumber,
    customerId: f.customerId,
    // A deleted/renamed customer still renders the name stored on the row.
    customerName: f.customerName ?? "—",
    qty: roundQty(f.qty),
    boxes: f.boxes,
    pieces: f.pieces,
    unitsPerBox: f.unitsPerBox,
    unitPrice: roundMoney(f.unitPrice),
    // Authoritative — never qty × unitPrice (a boxed line's unitPrice is a BOX price).
    lineTotal: roundMoney(f.subtotal),
    originalPrice: f.originalPrice != null ? roundMoney(f.originalPrice) : null,
    overridden: f.priceType !== "STANDARD",
    writtenOff: f.invoiceStatus === InvoiceStatus.WRITTEN_OFF,
  };
}

/**
 * A sales-page / CSV line. `perPiece` divides by the line's PIECES from its own stored evidence
 * (`salePiecesOf`, the pack-snapshot rule) — null when those are unknown, never subtotal ÷ a qty
 * that may count boxes. `productPackNow` is only the gate for a snapshot-less line.
 */
function toInsightSaleLine(
  f: ProductSaleFact,
  productPackNow: number | null,
  netting?: LineNetting,
): ProductInsightSaleLine {
  const pieces = salePiecesOf(f, productPackNow);
  return {
    ...toLegacySaleLine(f),
    lineId: f.lineId,
    unitLabel: f.unitLabel,
    perPiece: pieces == null ? null : perPieceOf(f.subtotal, pieces),
    creditedAmount: netting?.creditedAmount ?? 0,
    returnedQty: netting?.returnedQty ?? 0,
  };
}

/** A filename-safe token (letters, digits, dash, underscore; ≤ 40 chars). */
const fileToken = (s: string) => s.replace(/[^A-Za-z0-9_-]+/g, "-").slice(0, 40) || "product";

/**
 * #2118 (plan §B) — shapes the sales facts of ONE product: insights (totals, price facts, a
 * zero-filled series, buyers), line pages, the CSV export, and the two legacy analytics reads
 * (`getProductSales`/`getProductDemand` delegate here). Every figure comes from
 * `SalesFactsService`; the pure aggregation lives in `product-insights.aggregate.ts`.
 */
@Injectable()
export class ProductInsightsService {
  constructor(private readonly facts: SalesFactsService) {}

  /** Tenant, product (404 when missing) and zone — the first round trip of every endpoint. */
  private async context(productId: string) {
    const tenantId = this.facts.requireTenantId();
    const [product, timezone] = await Promise.all([
      this.facts.product(tenantId, productId),
      this.facts.tenantTimezone(tenantId),
    ]);
    if (!product) throw new NotFoundException("Product not found");
    return { tenantId, product, timezone };
  }

  private windowDto(
    range: { fromDay: string; toDay: string; grain: InsightGrain },
    timezone: string | null,
  ): InsightWindow {
    return {
      from: range.fromDay,
      to: range.toDay,
      grain: range.grain,
      timezone: timezone || "UTC",
    };
  }

  async getProductInsights(
    productId: string,
    query: ProductInsightsQueryDto,
  ): Promise<ProductInsightsResponse> {
    const { tenantId, product, timezone } = await this.context(productId);
    const range = resolveInsightRange(query, this.facts.today(timezone));
    return this.insightsFor(tenantId, product, timezone, range, query.buyers === "all");
  }

  private async insightsFor(
    tenantId: string,
    product: ProductRow,
    timezone: string | null,
    range: { fromDay: string; toDay: string; grain: InsightGrain },
    allBuyers: boolean,
  ): Promise<ProductInsightsResponse> {
    const win = rangeWindow(range.fromDay, range.toDay, range.grain);
    const [lines, lifetime, credits] = await Promise.all([
      this.facts.productSaleFacts(tenantId, product.id, {
        issueWindow: { gte: win.dataFrom, lt: win.dataTo },
        orderNumber: false, // insights never show one; skipping it saves a query per read
      }),
      this.facts.productLifetime(tenantId, product.id),
      this.facts.productCreditEvents(
        tenantId,
        product.id,
        this.facts.instantWindow(win.fromDay, win.toDay, timezone),
      ),
    ]);
    return aggregateProductInsights({
      product: toProductDto(product),
      window: win,
      timezone,
      lines,
      lifetime,
      credits,
      productPackNow: product.unitsPerBox ?? null,
      topBuyers: allBuyers ? "all" : INSIGHT_TOP_BUYERS,
    });
  }

  /** One page of sold lines, newest first, paged by LINE (plan §B) — never by invoice count. */
  async getProductSalesPage(
    productId: string,
    query: ProductSalesQueryDto,
  ): Promise<ProductSalesPage> {
    const { tenantId, product, timezone } = await this.context(productId);
    const range = resolveInsightRange(
      { from: query.from, to: query.to },
      this.facts.today(timezone),
    );
    const limit = Math.min(
      SALES_PAGE_MAX_LIMIT,
      Math.max(1, Math.trunc(query.limit ?? SALES_PAGE_DEFAULT_LIMIT)),
    );
    const after = query.cursor ? decodeLineCursor(query.cursor) : undefined;
    const facts = await this.facts.productSaleFacts(tenantId, productId, {
      issueWindow: this.facts.issueWindow(range.fromDay, range.toDay),
      customerId: query.customerId?.trim() || undefined,
      after,
      take: limit + 2,
    });
    const page = facts.slice(0, limit);
    const netting = await this.facts.lineNetting(
      tenantId,
      page.map((f) => f.lineId),
    );
    return {
      productId,
      window: this.windowDto(range, timezone),
      lines: page.map((f) =>
        toInsightSaleLine(f, product.unitsPerBox ?? null, netting.get(f.lineId)),
      ),
      nextCursor: facts.length > limit ? encodeLineCursor(lineKeyOf(page[page.length - 1])) : null,
    };
  }

  /**
   * Validates, 404s and resolves the window BEFORE any byte is streamed; the returned iterable
   * then streams the lines in chunks, a truncation row past `INSIGHT_CSV_MAX_LINES`, and the
   * footer: the sums of the rows above, plus (without a buyer filter) the window's
   * accrual-net totals from the insights computation.
   */
  async prepareCsvExport(
    productId: string,
    query: ProductInsightsCsvQueryDto,
  ): Promise<{ csv: AsyncIterable<string>; filename: string }> {
    const { tenantId, product, timezone } = await this.context(productId);
    const range = resolveInsightRange(
      { from: query.from, to: query.to },
      this.facts.today(timezone),
    );
    const customerId = query.customerId?.trim() || undefined;
    const summary = customerId
      ? null
      : await this.insightsFor(tenantId, product, timezone, range, false);
    const filename = `product-sales-${fileToken(product.sku || product.id)}-${range.fromDay}-to-${range.toDay}.csv`;
    return {
      filename,
      csv: this.csvStream(tenantId, product, range, customerId, summary),
    };
  }

  private async *csvStream(
    tenantId: string,
    product: ProductRow,
    range: { fromDay: string; toDay: string; grain: InsightGrain },
    customerId: string | undefined,
    summary: ProductInsightsResponse | null,
  ): AsyncGenerator<string> {
    const productId = product.id;
    const packNow = product.unitsPerBox ?? null;
    yield CSV_BOM + csvRow(CSV_HEADER);
    const issueWindow = this.facts.issueWindow(range.fromDay, range.toDay);
    let after: LineKey | undefined;
    let written = 0;
    let truncated = false;
    const sums = { qty: 0, gross: 0, credited: 0, returned: 0 };

    for (;;) {
      const room = INSIGHT_CSV_MAX_LINES - written;
      if (room <= 0) {
        const more = await this.facts.productSaleFacts(tenantId, productId, {
          issueWindow,
          customerId,
          after,
          take: 2,
        });
        truncated = more.length > 0;
        break;
      }
      const take = Math.min(CSV_CHUNK_LINES, room);
      const facts = await this.facts.productSaleFacts(tenantId, productId, {
        issueWindow,
        customerId,
        after,
        take: take + 2,
      });
      const page = facts.slice(0, take);
      if (page.length === 0) break;
      const netting = await this.facts.lineNetting(
        tenantId,
        page.map((f) => f.lineId),
      );
      let chunk = "";
      for (const f of page) {
        const line = toInsightSaleLine(f, packNow, netting.get(f.lineId));
        // Pieces only when the stored line can say; the stored qty is its own column.
        const pieces = salePiecesOf(f, packNow);
        sums.qty += pieces ?? 0;
        sums.gross += line.lineTotal;
        sums.credited += line.creditedAmount;
        sums.returned += line.returnedQty;
        chunk += csvRow([
          line.date.slice(0, 10),
          line.invoiceNumber,
          line.writtenOff ? "yes" : "",
          line.orderNumber,
          line.customerName,
          pieces == null ? null : roundQty(pieces),
          line.qty,
          line.boxes,
          line.pieces,
          line.unitsPerBox,
          line.unitLabel,
          line.unitPrice,
          line.lineTotal,
          line.perPiece,
          line.originalPrice,
          line.overridden ? "yes" : "",
          line.creditedAmount,
          line.returnedQty,
        ]);
      }
      yield chunk;
      written += page.length;
      after = lineKeyOf(page[page.length - 1]);
      if (facts.length <= take) break;
    }

    let footer = "\r\n";
    if (truncated) {
      footer += csvRow([
        `# truncated at ${INSIGHT_CSV_MAX_LINES} lines: narrow the window to export the rest`,
      ]);
    }
    footer += csvRow([
      "Rows total",
      "",
      "",
      "",
      "",
      roundQty(sums.qty),
      "",
      "",
      "",
      "",
      "",
      "",
      roundMoney(sums.gross),
      "",
      "",
      "",
      roundMoney(sums.credited),
      roundQty(sums.returned),
    ]);
    if (summary) {
      const t = summary.totals;
      footer += "\r\n";
      footer += csvRow([
        "Window totals (accrual net)",
        summary.window.from,
        summary.window.to,
        summary.window.timezone,
      ]);
      footer += csvRow(["Invoiced pieces", t.invoicedQtyPieces]);
      footer += csvRow(["Sale lines with unknown pieces (revenue only)", t.unresolvedSaleLines]);
      footer += csvRow(["Returned pieces", t.returnedQtyPieces]);
      footer += csvRow(["Return lines with unknown pieces", t.unresolvedReturnLines]);
      footer += csvRow(["Net pieces", t.netQtyPieces]);
      footer += csvRow(["Line gross", t.lineGross]);
      footer += csvRow(["Attributed credits", t.attributedCredits]);
      footer += csvRow(["Line net", t.lineNet]);
      // Beside the net, never subtracted from it or prorated (SA-289).
      footer += csvRow(["Unattributed credits (not subtracted)", t.unattributedCredits]);
    }
    footer += csvRow([
      "# Row order: newest issue date first, then entry time. Not the invoice's printed line order.",
    ]);
    yield footer;
  }

  // ─── Legacy reads (`AnalyticsService` delegates; shapes unchanged) ─────────

  /**
   * `GET /analytics/product-sales/:productId` — the newest `limit` LINES (all time), and their
   * summary. #2118: accrual basis (a written-off invoice's lines are sales, badged), and the
   * limit counts lines, not invoices. `minPrice`/`maxPrice` keep their original meaning (raw
   * `unitPrice`); the per-piece extremes live on the insights endpoint.
   */
  async getSalesHistory(productId: string, limit = 200): Promise<ProductSalesHistory> {
    const tenantId = this.facts.requireTenantId();
    const facts = await this.facts.productSaleFacts(tenantId, productId, { take: limit + 2 });
    const lines = facts.slice(0, limit).map(toLegacySaleLine);

    const totalQty = roundQty(lines.reduce((s, l) => s + l.qty, 0));
    const totalRevenue = roundMoney(lines.reduce((s, l) => s + l.lineTotal, 0));
    const prices = lines.map((l) => l.unitPrice);
    return {
      productId,
      lines,
      summary: {
        count: lines.length,
        buyers: new Set(lines.map((l) => l.customerId)).size,
        totalQty,
        totalRevenue,
        minPrice: prices.length ? Math.min(...prices) : null,
        maxPrice: prices.length ? Math.max(...prices) : null,
        // Revenue-weighted: Σsubtotal / Σqty, so volume moves it more than a one-off.
        avgPrice: totalQty > 0 ? roundMoney(totalRevenue / totalQty) : null,
      },
    };
  }

  /**
   * `GET /analytics/demand/:productId?range=` — units and revenue per bucket (invoiced, gross of
   * credits, as before). #2118: accrual basis; the window stays UTC-anchored `demandWindow`.
   */
  async getDemandSeries(
    productId: string,
    range: DemandRange = "30d",
  ): Promise<ProductDemandSeries> {
    const tenantId = this.facts.requireTenantId();
    const win = demandWindow(new Date(), range);
    const [facts, lifetime] = await Promise.all([
      this.facts.productSaleFacts(tenantId, productId, {
        issueWindow: { gte: win.from, lt: win.to },
        orderNumber: false,
        customerName: false,
      }),
      this.facts.productLifetime(tenantId, productId),
    ]);

    // Materialized up front so empty periods stay explicit zeros.
    const units = new Array<number>(win.buckets.length).fill(0);
    const revenue = new Array<number>(win.buckets.length).fill(0);
    for (const f of facts) {
      const idx = bucketIndexOf(win, f.issueDate);
      if (idx < 0) continue; // defensive — the half-open filter already excludes these
      // The STORED qty as-is — legacy parity with this endpoint's pre-#2118 shape, NOT pieces: a
      // boxed line stored without a split may count boxes (B644). The insights endpoints count
      // pieces through `salePiecesOf` instead.
      units[idx] += f.qty;
      revenue[idx] += f.subtotal; // authoritative — never qty × unitPrice
    }
    const day = (d: Date | null) => (d ? d.toISOString().slice(0, 10) : null);

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
      hasAnySales: lifetime.first != null,
      firstSaleAt: day(lifetime.first),
      lastSaleAt: day(lifetime.last),
    };
  }
}
