import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { normalizeBoxesPieces } from "@routeflow/pricing";

/** Where a product sits against its inferred reorder cadence. */
export type ReplenishmentState = "low" | "due-soon" | "ok";

/** One buyer-facing "you usually reorder this" estimate, computed from order history. */
export interface ReplenishmentEstimate {
  productId: string;
  name: string;
  unit: string;
  /** Box size when the product is boxed (unitsPerBox > 1), else null. */
  unitsPerBox: number | null;
  /** First image key (focal-encoded) for the tile, if any. */
  imageKey: string | null;
  /** ISO timestamp of the most recent non-cancelled order containing this product. */
  lastOrderedAt: string;
  /** Distinct orders (in the look-back window) that contained this product. */
  orderCount: number;
  /** Median days between consecutive orders of this product; null when < 2 orders. */
  cadenceDays: number | null;
  daysSinceLast: number;
  /** cadenceDays - daysSinceLast (negative = overdue); null when cadence unknown. */
  estDaysLeft: number | null;
  /** Median per-order quantity (pieces), integer-hygiene'd. */
  typicalQty: number;
  /** Suggested reorder quantity, rounded to the buyer's usual pack (whole boxes when boxed). */
  suggestedQty: number;
  state: ReplenishmentState;
}

/** A selected product shape (matches the Prisma select below). */
interface EstProduct {
  id: string;
  name: string;
  unit: string;
  unitsPerBox: number | null;
  imageKeys: string[];
  isActive: boolean;
}

/**
 * Phase 5 (P5-05): per-product replenishment estimates for a buyer at the selected
 * seller. Pure read-only computation over the customer's Order/OrderItem history — no
 * new model, no money write. Inferred cadence (median inter-order gap) drives a
 * "usually reorder this" list that feeds Your Shelf, the shop running-low strip, and
 * dashboard chips. Tenant scoping rides `forTenant()` (the BuyerTenantInterceptor sets
 * the tenant), so this is scoped to the active seller.
 */
@Injectable()
export class ReplenishmentService {
  constructor(private readonly prisma: PrismaService) {}

  /** Look-back window for cadence inference (days). */
  private static readonly WINDOW_DAYS = 180;
  /** est-days-left at/under this => "low" (overdue or due today). */
  private static readonly LOW_THRESHOLD_DAYS = 0;
  /** est-days-left within this band above low => "due-soon". */
  private static readonly DUE_SOON_DAYS = 3;

  async estimates(customerId: string, now: Date = new Date()): Promise<ReplenishmentEstimate[]> {
    const dayMs = 86_400_000;
    const since = new Date(now.getTime() - ReplenishmentService.WINDOW_DAYS * dayMs);

    const orders = await this.prisma.forTenant().order.findMany({
      where: { customerId, status: { not: "CANCELLED" }, createdAt: { gte: since } },
      select: {
        createdAt: true,
        lineItems: {
          select: {
            productId: true,
            qty: true,
            product: {
              select: {
                id: true,
                name: true,
                unit: true,
                unitsPerBox: true,
                imageKeys: true,
                isActive: true,
              },
            },
          },
        },
      },
      orderBy: { createdAt: "asc" },
    });

    // Group per product: one order-date + one summed qty per order that contains it.
    interface Agg {
      product: EstProduct;
      dates: number[];
      qtys: number[];
    }
    const byProduct = new Map<string, Agg>();
    for (const o of orders) {
      const t = o.createdAt.getTime();
      // A product can appear on several lines of one order — sum its qty for that order
      // so cadence counts orders, not lines.
      const perOrder = new Map<string, { product: EstProduct; qty: number }>();
      for (const li of o.lineItems) {
        const product = li.product as EstProduct | null;
        if (!li.productId || !product || !product.isActive) continue;
        const prev = perOrder.get(li.productId);
        perOrder.set(li.productId, { product, qty: (prev?.qty ?? 0) + Number(li.qty) });
      }
      for (const [pid, { product, qty }] of perOrder) {
        const agg = byProduct.get(pid) ?? { product, dates: [], qtys: [] };
        agg.dates.push(t);
        agg.qtys.push(qty);
        byProduct.set(pid, agg);
      }
    }

    const estimates: ReplenishmentEstimate[] = [];
    for (const [productId, agg] of byProduct) {
      const dates = [...agg.dates].sort((a, b) => a - b);
      const lastMs = dates[dates.length - 1];
      const daysSinceLast = Math.floor((now.getTime() - lastMs) / dayMs);

      // Cadence = median gap between consecutive order dates (needs >= 2 orders).
      let cadenceDays: number | null = null;
      if (dates.length >= 2) {
        const gaps: number[] = [];
        for (let i = 1; i < dates.length; i++) gaps.push((dates[i] - dates[i - 1]) / dayMs);
        cadenceDays = Math.max(1, Math.round(this.median(gaps)));
      }
      const estDaysLeft = cadenceDays == null ? null : cadenceDays - daysSinceLast;

      const upb = Number(agg.product.unitsPerBox ?? 0);
      const typicalQty = normalizeBoxesPieces({
        qty: Math.round(this.median(agg.qtys)),
        unitsPerBox: upb,
      }).qty;

      estimates.push({
        productId,
        name: agg.product.name,
        unit: agg.product.unit,
        unitsPerBox: upb > 1 ? upb : null,
        imageKey: agg.product.imageKeys.length > 0 ? agg.product.imageKeys[0] : null,
        lastOrderedAt: new Date(lastMs).toISOString(),
        orderCount: dates.length,
        cadenceDays,
        daysSinceLast,
        estDaysLeft,
        typicalQty,
        suggestedQty: this.roundToPack(typicalQty, upb),
        state: this.classify(estDaysLeft),
      });
    }

    // Surface the most urgent first: low → due-soon → ok, then soonest est-days-left,
    // then alphabetical for stable ordering.
    const rank: Record<ReplenishmentState, number> = { low: 0, "due-soon": 1, ok: 2 };
    estimates.sort((a, b) => {
      if (rank[a.state] !== rank[b.state]) return rank[a.state] - rank[b.state];
      const ax = a.estDaysLeft ?? Number.POSITIVE_INFINITY;
      const bx = b.estDaysLeft ?? Number.POSITIVE_INFINITY;
      if (ax !== bx) return ax - bx;
      return a.name.localeCompare(b.name);
    });
    return estimates;
  }

  private classify(estDaysLeft: number | null): ReplenishmentState {
    if (estDaysLeft == null) return "ok";
    if (estDaysLeft <= ReplenishmentService.LOW_THRESHOLD_DAYS) return "low";
    if (estDaysLeft <= ReplenishmentService.DUE_SOON_DAYS) return "due-soon";
    return "ok";
  }

  private median(nums: number[]): number {
    if (nums.length === 0) return 0;
    const s = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  /** Round a piece-qty to the buyer's usual pack: nearest whole box (>= 1) when boxed. */
  private roundToPack(qty: number, unitsPerBox: number): number {
    const upb = Math.trunc(unitsPerBox);
    if (upb > 1) return Math.max(1, Math.round(qty / upb)) * upb;
    return Math.max(1, Math.round(qty));
  }
}
