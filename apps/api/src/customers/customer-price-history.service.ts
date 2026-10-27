import { BadRequestException, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import {
  baseLabelOf,
  getTierPrice,
  namesPack,
  packFromOwnSplit,
  priceInUnit,
  pricePerBaseUnit,
  roundMoney,
  unitNameKey,
} from "@routeflow/pricing";
import { asLadderProduct } from "../products/line-units";
import type {
  PriceHistoryAggregate,
  PriceHistoryComparisonLine,
  PriceHistoryReferences,
  PriceHistoryResponse,
  PriceHistoryRow,
  PriceHistorySummary,
  PriceSummaryResponse,
  PRICE_SUMMARY_MAX_PRODUCTS as SHARED_PRICE_SUMMARY_MAX_PRODUCTS,
} from "@routeflow/types";
import {
  ACCRUAL_REVENUE_STATUSES,
  buildCostIndex,
  costAt,
  roundQty,
  type CostIndex,
} from "../common/invoiced-sales";
import { BACKING_ORDER_STATUSES } from "../invoices/credit-exposure";
import { PrismaService } from "../prisma/prisma.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { customerPricing } from "../orders/units-prices-v2";
import { openOrderLinesForProduct } from "../orders/open-order-lines";
import { salePackOf } from "../sales-facts/sales-facts.rules";
import {
  comparisonLines,
  mostCommonPack,
  plotUnitsOf,
  type ComparisonSale,
  type PlotUnit,
} from "./price-history-comparison";

/** Invoices that were actually issued: DRAFT/VOID are not sales, a WRITTEN_OFF invoice was billed. */
const ISSUED_STATUSES = { notIn: [...ACCRUAL_REVENUE_STATUSES.notIn] };

export const PRICE_HISTORY_DEFAULT_LIMIT = 25;
export const PRICE_HISTORY_MAX_LIMIT = 100;
/**
 * The API-side copy of the shared `PRICE_SUMMARY_MAX_PRODUCTS` (the API never imports `@routeflow/types`
 * at runtime). Typed as the shared constant's literal type, so a change there fails to compile here;
 * the parity spec pins the values equal.
 */
export const PRICE_SUMMARY_MAX_PRODUCTS: typeof SHARED_PRICE_SUMMARY_MAX_PRODUCTS = 50;
/** `?compare=all` looks back this far over every customer's invoiced sales (this customer's own included, see the cap). */
export const COMPARE_WINDOW_DAYS = 180;
/** Fewer distinct other customers than this and the aggregate is withheld (cannot be anonymised). */
export const COMPARE_MIN_CUSTOMERS = 3;
/**
 * The one compare read takes the newest this-many invoices of the product across ALL customers, this one's own too (SA-954
 * D7: one read, split in memory). Own invoices therefore share the cap with everyone else's. Own rows feed line 3's mean and
 * nothing else: they never enter `others`, a buyer count or the aggregate, so a heavy buyer can crowd the window but never
 * trip or lift a floor.
 */
export const COMPARE_INVOICE_CAP = 2000;
/**
 * The price-summary scan reads the customer's newest 500 issued invoices that contain at least one
 * requested product (honouring `excludeOrderId`), NOT 500 per product, so a rarely-sold product can be
 * hidden behind frequent ones (a per-product cap is a later change). Each request of <= 50 ids scans
 * separately: a caller that chunks a longer list gets one independent scan per chunk.
 */
const SUMMARY_INVOICE_CAP = 500;

/** `?productIds=a,b,a` -> ["a","b"] (trimmed, de-duplicated, order kept). */
export function parseProductIds(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return [
    ...new Set(
      raw
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean),
    ),
  ];
}

/** 4dp ratio, no float dust. */
const round4 = (n: number): number => Math.round((n + Number.EPSILON) * 10000) / 10000;

function medianOf(sorted: number[]): number {
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : roundMoney((sorted[mid - 1] + sorted[mid]) / 2);
}

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

interface CandidateMeta {
  at: Date;
  tie: string;
  source: "INVOICE" | "OPEN_ORDER";
  invoiceId: string | null;
  invoiceNumber: string | null;
  orderId: string;
  orderNumber: string;
}

/** Turn one invoice/order line into a history row in its OWN unit (pack from the line's evidence, never the live product). */
function buildCandidate(
  ctx: { productPackNow: number | null; unitName: string },
  line: LineFacts & { qty?: unknown },
  qtyPieces: number,
  split: boolean,
  meta: CandidateMeta,
): Candidate {
  const pack = salePackOf(
    { boxes: line.boxes, pieces: line.pieces, unitsPerBox: nz(line.unitsPerBox) },
    ctx.productPackNow,
  );
  const snapshot = Number(line.unitsPerBox ?? 0);
  const boxedLabel = (pack ?? 0) > 1 || snapshot > 1;
  const unitLabel = (line.unitLabel ?? "").trim() || (boxedLabel ? "Box" : ctx.unitName || "Each");
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
      salePack: pack, // SA-1004: salePackOf's own answer (1 = piece, > 1 = pack, null = unknown)
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
}

@Injectable()
export class CustomerPriceHistoryService {
  constructor(
    private readonly prisma: PrismaService,
    // S19b: the reference price is the customer layer's when flag.units_prices_v2 is on (billing's own resolver).
    @Optional() private readonly entitlements?: EntitlementsService,
  ) {}

  async getHistory(
    customerId: string,
    productId: string,
    opts: {
      limit?: unknown;
      role?: UserRole | null;
      compare?: unknown;
      excludeOrderId?: string | null;
    },
  ): Promise<PriceHistoryResponse> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("A tenant context is required.");
    const limit = clampHistoryLimit(opts.limit);
    const costVisible = canSeeCost(opts.role);
    const db = this.prisma.forTenant();
    // The order being edited is not its own history: drop its open lines and its invoices (an
    // invoice with no order stays), so "Last" and the summary never show the price being edited.
    const ex = opts.excludeOrderId || null;

    const [customer, product] = await Promise.all([
      db.customer.findFirst({
        where: { id: customerId, tenantId },
        select: { id: true, businessName: true, pricingTier: true },
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
          pricePerUnit: true,
          priceTier2: true,
          priceTier3: true,
          priceTier4: true,
          priceTier5: true,
          packLabel: true,
          baseUnitLabel: true,
          orderUnitRef: true,
          packAuto: true,
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
          ...(ex ? { OR: [{ orderId: null }, { orderId: { not: ex } }] } : {}),
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
      // Orders that can still owe an invoice (open + delivered). Over-read: billed lines are dropped by the helper.
      openOrderLinesForProduct(db, {
        tenantId,
        productId,
        customerId,
        statuses: BACKING_ORDER_STATUSES,
        take: limit * 2,
        excludeOrderId: ex,
      }),
    ]);

    const productPackNow = product.unitsPerBox == null ? null : Number(product.unitsPerBox);
    const unitName = (product.unit ?? "").trim();
    const candidates: Candidate[] = [];

    const build = (
      line: LineFacts,
      qtyPieces: number,
      split: boolean,
      meta: CandidateMeta,
    ): Candidate => buildCandidate({ productPackNow, unitName }, line, qtyPieces, split, meta);

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

    for (const it of openOrders) {
      // Qty on real invoices is already a row above, as INVOICE; show only what is not billed yet.
      const untouched = it.billedQty <= 0;
      candidates.push(
        build(it, untouched ? it.qty : it.remainingQty, untouched, {
          at: it.orderDate,
          tie: `${it.orderId}:${it.orderItemId}`,
          source: "OPEN_ORDER",
          invoiceId: null,
          invoiceNumber: null,
          orderId: it.orderId,
          orderNumber: it.orderNumber ?? "",
        }),
      );
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
      pieceCost == null || pack == null ? null : priceInUnit(pieceCost, pack > 1 ? pack : 1);

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

    // v1.1 references, in the NEWEST row's unit. Tier = the order-create rule: the customer's
    // per-product CustomerPrice tier, else their default tier, priced by the shared getTierPrice.
    let references: PriceHistoryReferences = {
      listPrice: null,
      tierPrice: null,
      changeSinceLast: null,
    };
    if (kept.length > 0) {
      const newest = kept[0];
      const cp = await db.customerPrice.findFirst({
        where: { customerId, productId },
        select: { productId: true, pricingTier: true, orderUnitRef: true },
      });
      const pc = await customerPricing(
        { prisma: this.prisma, entitlements: this.entitlements },
        customerId,
        [productId],
        customer,
        cp ? [{ ...cp, productId }] : [],
        db,
      );
      const tier = pc.cpMap.get(productId) ?? pc.defaultTier;
      // The newest sale's unit as a layer label: the pack (null), the base (its name), or the named unit.
      const newestLabel =
        productPackNow != null && productPackNow > 1
          ? newest.pack === productPackNow
            ? null
            : newest.pack === 1
              ? baseLabelOf(asLadderProduct(product))
              : newest.row.unitLabel
          : newest.pack === 1 || newest.pack == null
            ? null
            : newest.row.unitLabel;
      // After a pack-size change the old sale's "Box" label would resolve to the CURRENT pack: that is not its unit, so no layer
      // (master shows null there too).
      const layerOfNewest =
        newestLabel != null && namesPack(asLadderProduct(product), newestLabel)
          ? null
          : pc.layer(product, newestLabel);
      const inUnit = (price: number): number | null => {
        const p = newest.pack;
        if (productPackNow != null && productPackNow > 1) {
          if (p === productPackNow) return roundMoney(price);
          if (p === 1) {
            const perBase = pricePerBaseUnit(price, productPackNow);
            return perBase == null ? null : priceInUnit(perBase, 1);
          }
          return null;
        }
        return p === 1 || p == null ? roundMoney(price) : null;
      };
      const sameUnit = kept.filter((c) => c.row.unitLabel === newest.row.unitLabel);
      const prev = sameUnit[1]?.row.unitPrice;
      references = {
        listPrice: inUnit(Number(product.pricePerUnit) || 0),
        tierPrice: layerOfNewest?.price ?? inUnit(Number(getTierPrice(product, tier))),
        changeSinceLast:
          prev != null && prev > 0 ? round4((newest.row.unitPrice - prev) / prev) : null,
      };
    }

    const response: PriceHistoryResponse = {
      customerId: customer.id,
      customerName: customer.businessName,
      productId: product.id,
      productName: product.name,
      costVisible,
      rows,
      summaries,
      references,
    };
    if (opts.compare === "all") {
      Object.assign(
        response,
        await this.compare(
          db,
          tenantId,
          customerId,
          productId,
          { productPackNow, unitName },
          plotUnitsOf(kept.map((c) => ({ unitLabel: c.row.unitLabel, pack: c.pack }))),
        ),
      );
    }
    return response;
  }

  /**
   * `?compare=all`: ONE read of every customer's invoiced sales of the product (180 days, newest 2000), split in
   * memory (SA-954 D7). OTHER customers feed `aggregate` (the most-sold unit's low / median / high) and line 2;
   * everyone feeds line 3. Reads through Invoice with the tenant. The buyer is selected only to count DISTINCT
   * buyers and is never returned; the aggregate is null under 3 distinct other buyers (too few to anonymise).
   */
  private async compare(
    db: any,
    tenantId: string,
    customerId: string,
    productId: string,
    ctx: { productPackNow: number | null; unitName: string },
    ownPlots: PlotUnit[],
  ): Promise<{
    aggregate: PriceHistoryAggregate | null;
    comparison: PriceHistoryComparisonLine[];
  }> {
    const since = new Date(Date.now() - COMPARE_WINDOW_DAYS * 86_400_000);
    const invoices = (await db.invoice.findMany({
      where: {
        tenantId,
        status: ISSUED_STATUSES,
        issueDate: { gte: since },
        items: { some: { productId } },
      },
      orderBy: [{ issueDate: "desc" }, { id: "desc" }],
      take: COMPARE_INVOICE_CAP,
      select: {
        id: true,
        customerId: true,
        issueDate: true,
        items: {
          where: { productId },
          select: {
            unitPrice: true,
            boxes: true,
            pieces: true,
            unitsPerBox: true,
            unitLabel: true,
            qty: true,
          },
        },
      },
    })) as any[];

    const sales: ComparisonSale[] = [];
    type UnitGroup = { prices: number[]; buyers: Set<string>; packs: Array<number | null> };
    const byUnit = new Map<string, UnitGroup>();
    for (const inv of invoices) {
      const own = inv.customerId === customerId;
      for (const it of inv.items ?? []) {
        const c = buildCandidate(ctx, it, Number(it.qty), true, {
          at: new Date(inv.issueDate),
          tie: inv.id,
          source: "INVOICE",
          invoiceId: null,
          invoiceNumber: null,
          orderId: "",
          orderNumber: "",
        });
        sales.push({
          price: c.row.unitPrice,
          buyer: inv.customerId,
          own,
          month: c.row.date.slice(0, 7),
          unitLabel: c.row.unitLabel,
          pack: c.pack,
        });
        if (own) continue;
        const g: UnitGroup = byUnit.get(c.row.unitLabel) ?? {
          prices: [],
          buyers: new Set<string>(),
          packs: [],
        };
        g.prices.push(c.row.unitPrice);
        g.buyers.add(inv.customerId);
        g.packs.push(c.pack);
        byUnit.set(c.row.unitLabel, g);
      }
    }
    let best: [string, UnitGroup] | null = null;
    for (const e of byUnit) if (!best || e[1].prices.length > best[1].prices.length) best = e;

    let aggregate: PriceHistoryAggregate | null = null;
    if (best && best[1].buyers.size >= COMPARE_MIN_CUSTOMERS) {
      const sorted = [...best[1].prices].sort((a, b) => a - b);
      aggregate = {
        low: sorted[0],
        median: medianOf(sorted),
        high: sorted[sorted.length - 1],
        customers: best[1].buyers.size,
        unitLabel: best[0],
      };
    }

    // D2: this customer's own units; with none, the summary's unit (the most bought by others) at its most common pack.
    let plots = ownPlots;
    if (plots.length === 0 && best) {
      const pack = mostCommonPack(best[1].packs);
      if (pack != null) plots = [{ unitLabel: best[0], pack }];
    }
    return { aggregate, comparison: comparisonLines(sales, plots, COMPARE_MIN_CUSTOMERS) };
  }

  /**
   * Inline-chip / prefetch batch: last 3 invoiced prices + low/high per product, for ONE customer,
   * in a single invoice read (tenant-scoped through Invoice, like getProductSales). Open orders are
   * not included (chips show what was actually billed). Staff-only, enforced at the controller.
   */
  async getPriceSummary(
    customerId: string,
    rawProductIds: unknown,
    opts: { role?: UserRole | null; excludeOrderId?: string | null } = {},
  ): Promise<PriceSummaryResponse> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) throw new BadRequestException("A tenant context is required.");
    const ids = parseProductIds(rawProductIds);
    if (ids.length === 0) throw new BadRequestException("productIds is required.");
    if (ids.length > PRICE_SUMMARY_MAX_PRODUCTS) {
      throw new BadRequestException(`At most ${PRICE_SUMMARY_MAX_PRODUCTS} products per request.`);
    }
    const db = this.prisma.forTenant();
    const customer = await db.customer.findFirst({
      where: { id: customerId, tenantId },
      select: { id: true },
    });
    if (!customer) throw new NotFoundException("Customer not found");

    // The order being edited is not its own history (hunt2 F6): same rule as getHistory, an invoice
    // with no order stays.
    const ex = opts.excludeOrderId || null;
    const invoices = (await db.invoice.findMany({
      where: {
        tenantId,
        customerId,
        status: ISSUED_STATUSES,
        items: { some: { productId: { in: ids } } },
        ...(ex ? { OR: [{ orderId: null }, { orderId: { not: ex } }] } : {}),
      },
      orderBy: [{ issueDate: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      take: SUMMARY_INVOICE_CAP,
      select: {
        id: true,
        issueDate: true,
        items: {
          where: { productId: { in: ids } },
          // Row 607: a fixed order (newest line first), so the chip's "newest sale" never depends on row order.
          orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          select: {
            id: true,
            productId: true,
            unitPrice: true,
            priceType: true,
            boxes: true,
            pieces: true,
            unitsPerBox: true,
            unitLabel: true,
            qty: true,
            product: { select: { unit: true, unitsPerBox: true } },
          },
        },
      },
    })) as any[];

    const out: PriceSummaryResponse = {};
    // low/high are over ONE unit group per product (never a $2 piece mixed with a $24 case): the group is
    // the NEWEST sale's (unitLabel, unitsPerBox), and the entry reports it so the figures carry their unit.
    const sold = new Map<
      string,
      Array<{ key: string; price: number; label: string; pack: number | null }>
    >();
    for (const id of ids) {
      out[id] = { last3: [], low: null, high: null, unitLabel: null, unitsPerBox: null };
      sold.set(id, []);
    }
    for (const inv of invoices) {
      for (const it of inv.items ?? []) {
        const e = out[it.productId];
        if (!e) continue;
        const packNow = it.product?.unitsPerBox == null ? null : Number(it.product.unitsPerBox);
        // Row 607: a pre-snapshot split line carries no `unitsPerBox` but its own boxes/qty give the pack back.
        const recovered =
          it.unitsPerBox == null && (it.boxes != null || it.pieces != null)
            ? packFromOwnSplit({ qty: Number(it.qty), boxes: it.boxes, pieces: it.pieces })
            : null;
        const c = buildCandidate(
          { productPackNow: packNow, unitName: (it.product?.unit ?? "").trim() },
          recovered != null ? { ...it, unitsPerBox: recovered } : it,
          Number(it.qty),
          true,
          {
            at: new Date(inv.issueDate),
            tie: `${inv.id}:${it.id}`,
            source: "INVOICE",
            invoiceId: inv.id,
            invoiceNumber: null,
            orderId: "",
            orderNumber: "",
          },
        );
        // Row 607: a line whose unit cannot be known (an unsplit legacy box line) is no chip price: its total would
        // read as a per-piece price.
        if (c.pack == null) continue;
        sold.get(it.productId)!.push({
          key: `${unitNameKey(c.row.unitLabel)}|${c.row.unitsPerBox ?? ""}`,
          price: c.row.unitPrice,
          label: c.row.unitLabel,
          pack: c.row.unitsPerBox,
        });
        if (e.last3.length < 3) {
          e.last3.push({
            date: c.row.date,
            unitPrice: c.row.unitPrice,
            unitLabel: c.row.unitLabel,
            unitsPerBox: c.row.unitsPerBox,
          });
        }
      }
    }
    for (const id of ids) {
      const rows = sold.get(id)!;
      if (rows.length === 0) continue;
      const ps = rows.filter((r) => r.key === rows[0].key).map((r) => r.price);
      out[id].low = Math.min(...ps);
      out[id].high = Math.max(...ps);
      out[id].unitLabel = rows[0].label;
      out[id].unitsPerBox = rows[0].pack;
    }
    return out;
  }
}
