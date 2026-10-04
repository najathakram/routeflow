import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";
import type { PriceHistoryResponse, PriceHistoryRow, PriceHistorySummary } from "@routeflow/types";
import {
  ACCRUAL_REVENUE_STATUSES,
  buildCostIndex,
  costAt,
  roundQty,
  type CostIndex,
} from "../common/invoiced-sales";
import { BACKING_ORDER_STATUSES } from "../invoices/credit-exposure";
import { PrismaService } from "../prisma/prisma.service";
import { salePackOf } from "../sales-facts/sales-facts.rules";

/** Invoices that were actually issued: DRAFT/VOID are not sales, a WRITTEN_OFF invoice was billed. */
const ISSUED_STATUSES = { notIn: [...ACCRUAL_REVENUE_STATUSES.notIn] };

export const PRICE_HISTORY_DEFAULT_LIMIT = 25;
export const PRICE_HISTORY_MAX_LIMIT = 100;

/** `?limit=` -> 1..100, default 25; anything non-numeric falls back to the default. */
export function clampHistoryLimit(raw: unknown): number {
  const n = Math.trunc(Number(raw));
  if (raw == null || raw === "" || !Number.isFinite(n)) return PRICE_HISTORY_DEFAULT_LIMIT;
  return Math.min(PRICE_HISTORY_MAX_LIMIT, Math.max(1, n));
}

/**
 * Who may see cost on this endpoint. There is no per-user cost permission in the schema: staff
 * (the roles that can set order prices) see cost, the web masks it behind "Show cost". The
 * endpoint itself is OPERATOR-only (TENANT_ADMIN passes the RolesGuard hierarchy), so a DRIVER or
 * CUSTOMER never reaches the service — this is the server-side backstop that keeps cost out of the
 * payload for any role that is not staff, should the route's role list ever widen.
 */
export function canSeeCost(role: UserRole | null | undefined): boolean {
  return (
    role === UserRole.OPERATOR || role === UserRole.TENANT_ADMIN || role === UserRole.SUPER_ADMIN
  );
}

/** Shape shared by an InvoiceItem and an OrderItem line. */
interface LineFacts {
  unitPrice: unknown;
  priceType?: string | null;
  boxes?: number | null;
  pieces?: number | null;
  unitsPerBox?: number | null;
  unitLabel?: string | null;
}

interface Candidate {
  row: Omit<PriceHistoryRow, "avgCostAtSale">;
  /** The line's selling unit in pieces: >1 = pack, 1 = piece, null = cannot be known (no cost shown). */
  pack: number | null;
  at: Date;
  tie: string;
}

const nz = (v: unknown): number | null => (v == null ? null : Number(v));

@Injectable()
export class CustomerPriceHistoryService {
  constructor(private readonly prisma: PrismaService) {}

  async getHistory(
    customerId: string,
    productId: string,
    opts: { limit?: unknown; role?: UserRole | null },
  ): Promise<PriceHistoryResponse> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("A tenant context is required.");
    const limit = clampHistoryLimit(opts.limit);
    const costVisible = canSeeCost(opts.role);
    const db = this.prisma.forTenant();

    const [customer, product] = await Promise.all([
      db.customer.findFirst({
        where: { id: customerId, tenantId },
        select: { id: true, businessName: true },
      }),
      db.product.findFirst({
        where: { id: productId, tenantId },
        select: {
          id: true,
          name: true,
          unit: true,
          unitsPerBox: true,
          averageCost: true,
          costingMethod: true,
          standardCost: true,
        },
      }),
    ]);
    if (!customer) throw new NotFoundException("Customer not found");
    if (!product) throw new NotFoundException("Product not found");

    const lineSelect = {
      unitPrice: true,
      priceType: true,
      boxes: true,
      pieces: true,
      unitsPerBox: true,
      unitLabel: true,
      qty: true,
    } as const;

    // Invoiced sales: read THROUGH Invoice with an explicit tenantId (InvoiceItem rows can carry a
    // null tenantId). `take` counts invoices; each has >= 1 line of the product, so the newest
    // `limit` rows always come from the newest `limit` invoices.
    const [invoices, openOrders] = await Promise.all([
      db.invoice.findMany({
        where: {
          tenantId,
          customerId,
          status: ISSUED_STATUSES,
          items: { some: { productId } },
        },
        orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
        take: limit,
        select: {
          id: true,
          invoiceNumber: true,
          issueDate: true,
          orderId: true,
          order: { select: { orderNumber: true } },
          items: { where: { productId }, select: { id: true, ...lineSelect } },
        },
      }),
      // Orders that can still owe an invoice (open + delivered). Over-read: billed lines are dropped below.
      db.order.findMany({
        where: {
          tenantId,
          customerId,
          status: { in: BACKING_ORDER_STATUSES },
          lineItems: { some: { productId } },
        },
        orderBy: [
          { orderDate: { sort: "desc", nulls: "last" } },
          { createdAt: "desc" },
          { id: "desc" },
        ],
        take: limit * 2,
        select: {
          id: true,
          orderNumber: true,
          orderDate: true,
          createdAt: true,
          lineItems: {
            where: { productId, status: { not: "CANCELLED" } },
            select: { id: true, ...lineSelect },
          },
        },
      }),
    ]);

    // Billed qty per order line from invoices that were actually issued (a written-off invoice WAS
    // billed; only DRAFT/VOID are not). OrderItem.invoicedQty is bumped when a DRAFT invoice is
    // created, so it cannot be used. Read THROUGH Invoice (never top-level invoiceItem.findMany:
    // lines with a null tenantId would be dropped and the line would show twice).
    const lineIds = (openOrders as any[]).flatMap((o) => (o.lineItems ?? []).map((l: any) => l.id));
    const billed = new Map<string, number>();
    if (lineIds.length > 0) {
      const billedInvoices = await db.invoice.findMany({
        where: {
          tenantId,
          status: ISSUED_STATUSES,
          items: { some: { orderItemId: { in: lineIds } } },
        },
        select: {
          items: {
            where: { orderItemId: { in: lineIds } },
            select: { orderItemId: true, qty: true },
          },
        },
      });
      for (const inv of billedInvoices as any[]) {
        for (const b of inv.items ?? []) {
          billed.set(b.orderItemId, (billed.get(b.orderItemId) ?? 0) + Number(b.qty));
        }
      }
    }

    const productPackNow = product.unitsPerBox == null ? null : Number(product.unitsPerBox);
    const unitName = (product.unit ?? "").trim();
    const candidates: Candidate[] = [];

    const build = (
      line: LineFacts,
      qtyPieces: number,
      split: boolean,
      meta: {
        at: Date;
        tie: string;
        source: "INVOICE" | "OPEN_ORDER";
        invoiceId: string | null;
        invoiceNumber: string | null;
        orderId: string;
        orderNumber: string;
      },
    ): Candidate => {
      // The pack comes from the line's OWN evidence (split + snapshot), never the live product.
      const pack = salePackOf(
        { boxes: line.boxes, pieces: line.pieces, unitsPerBox: nz(line.unitsPerBox) },
        productPackNow,
      );
      const snapshot = Number(line.unitsPerBox ?? 0);
      const boxedLabel = (pack ?? 0) > 1 || snapshot > 1;
      const unitLabel = (line.unitLabel ?? "").trim() || (boxedLabel ? "Box" : unitName || "Each");
      const qty = roundQty(pack != null && pack > 1 ? qtyPieces / pack : qtyPieces);
      return {
        at: meta.at,
        tie: meta.tie,
        pack,
        row: {
          date: meta.at.toISOString(),
          source: meta.source,
          unitPrice: roundMoney(Number(line.unitPrice)),
          unitLabel,
          unitsPerBox: pack != null && pack > 1 ? pack : null,
          qty,
          boxes: split ? (line.boxes ?? null) : null,
          pieces: split ? (line.pieces ?? null) : null,
          invoiceId: meta.invoiceId,
          invoiceNumber: meta.invoiceNumber,
          orderId: meta.orderId,
          orderNumber: meta.orderNumber,
          priceType: line.priceType ?? null,
        },
      };
    };

    for (const inv of invoices as any[]) {
      for (const it of inv.items ?? []) {
        candidates.push(
          build(it, Number(it.qty), true, {
            at: new Date(inv.issueDate),
            tie: `${inv.id}:${it.id}`,
            source: "INVOICE",
            invoiceId: inv.id,
            invoiceNumber: inv.invoiceNumber ?? null,
            orderId: inv.orderId ?? "",
            orderNumber: inv.order?.orderNumber ?? "",
          }),
        );
      }
    }

    for (const ord of openOrders as any[]) {
      for (const it of ord.lineItems ?? []) {
        // Qty on real invoices is already a row above, as INVOICE; show only what is not billed yet.
        const billedQty = billed.get(it.id) ?? 0;
        const remainder = roundQty(Number(it.qty) - billedQty);
        if (!(remainder > 0)) continue;
        const untouched = billedQty <= 0;
        candidates.push(
          build(it, untouched ? Number(it.qty) : remainder, untouched, {
            at: new Date(ord.orderDate ?? ord.createdAt),
            tie: `${ord.id}:${it.id}`,
            source: "OPEN_ORDER",
            invoiceId: null,
            invoiceNumber: null,
            orderId: ord.id,
            orderNumber: ord.orderNumber ?? "",
          }),
        );
      }
    }

    candidates.sort(
      (a, b) => b.at.getTime() - a.at.getTime() || (a.tie < b.tie ? 1 : a.tie > b.tie ? -1 : 0),
    );
    const kept = candidates.slice(0, limit);

    // Cost: only for roles that may see it — the movement history is not even read otherwise.
    // Bounded to the kept rows' date span, plus one opening snapshot at or before the oldest row.
    let costIndex: CostIndex = new Map();
    const currentAvg = nz(product.averageCost);
    if (costVisible && kept.length > 0) {
      const oldest = kept.reduce((m, c) => (c.at < m ? c.at : m), kept[0].at);
      const newest = kept.reduce((m, c) => (c.at > m ? c.at : m), kept[0].at);
      const [span, opening] = await Promise.all([
        db.stockMovement.findMany({
          where: {
            productId,
            avgCostAfter: { not: null },
            effectiveAt: { gte: oldest, lte: newest },
          },
          select: { productId: true, effectiveAt: true, avgCostAfter: true },
          orderBy: [{ effectiveAt: "asc" }, { createdAt: "asc" }, { id: "asc" }],
        }),
        db.stockMovement.findFirst({
          where: { productId, avgCostAfter: { not: null }, effectiveAt: { lt: oldest } },
          select: { productId: true, effectiveAt: true, avgCostAfter: true },
          orderBy: [{ effectiveAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
        }),
      ]);
      costIndex = buildCostIndex([...(opening ? [opening] : []), ...(span as any[])]);
    }
    // The resolveUnitCost ladder minus the current-average fallback: a sale before any recorded
    // movement is unknown (null) unless the product is on STANDARD costing. Zero/negative = unknown.
    const standard =
      product.costingMethod === "STANDARD" && product.standardCost != null
        ? Number(product.standardCost)
        : null;
    const pieceCostAt = (at: Date): number | null => {
      const snap = costAt(costIndex, productId, at);
      const cost = snap != null ? snap : standard;
      return cost != null && cost > 0 ? cost : null;
    };
    const perUnit = (pieceCost: number | null, pack: number | null): number | null =>
      pieceCost == null || pack == null ? null : roundMoney(pieceCost * (pack > 1 ? pack : 1));

    const rows: PriceHistoryRow[] = kept.map((c) => ({
      ...c.row,
      avgCostAtSale: costVisible ? perUnit(pieceCostAt(c.at), c.pack) : null,
    }));

    // One summary per unit, in order of first (newest) appearance — units are never mixed.
    const order: string[] = [];
    const groups = new Map<string, { rows: Candidate[] }>();
    for (const c of kept) {
      const g = groups.get(c.row.unitLabel);
      if (g) g.rows.push(c);
      else {
        groups.set(c.row.unitLabel, { rows: [c] });
        order.push(c.row.unitLabel);
      }
    }
    const summaries: PriceHistorySummary[] = order.map((unitLabel) => {
      const g = groups.get(unitLabel)!.rows;
      const prices = g.map((c) => c.row.unitPrice);
      const qtySold = g
        .filter((c) => c.row.source === "INVOICE")
        .reduce((s, c) => s + c.row.qty, 0);
      return {
        unitLabel,
        last: prices[0] ?? null,
        low: prices.length ? Math.min(...prices) : null,
        high: prices.length ? Math.max(...prices) : null,
        qtySold: roundQty(qtySold),
        currentAvgCost:
          costVisible && currentAvg != null && currentAvg > 0
            ? perUnit(currentAvg, g.find((c) => c.pack != null)?.pack ?? null)
            : null,
      };
    });

    return {
      customerId: customer.id,
      customerName: customer.businessName,
      productId: product.id,
      productName: product.name,
      costVisible,
      rows,
      summaries,
    };
  }
}
