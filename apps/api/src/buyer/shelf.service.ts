import { Injectable, NotFoundException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { StorageService } from "../storage/storage.service";
import { ReplenishmentService, ReplenishmentEstimate } from "./replenishment.service";

/** A replenishment estimate overlaid with the buyer's snooze state (P5-06). */
export interface ShelfEstimate extends ReplenishmentEstimate {
  /** Presigned URL for `imageKey` (renderable by <img>); null when no image. */
  imageUrl: string | null;
  snoozed: boolean;
  /** ISO timestamp the snooze lapses; null when not snoozed. */
  snoozedUntil: string | null;
}

/** Fallback cycle length when a product has no inferred cadence. */
const DEFAULT_SNOOZE_DAYS = 14;
const DAY_MS = 86_400_000;

/**
 * Phase 5 (P5-06/07): Your Shelf. Thin overlay on ReplenishmentService — the
 * pure estimate computation is untouched; this service only (a) marks rows
 * snoozed from ReplenishmentSnooze, (b) presigns tile thumbnails, and (c)
 * derives the add-all-low seed list. Snoozed rows are KEPT in the payload
 * (the shelf shows them under a "Snoozed" section); the shop strip and the
 * dashboard chips filter `state === "low" && !snoozed` client-side, so all
 * three surfaces read one payload and can never disagree. Tenant scoping
 * rides `forTenant()` (BuyerTenantInterceptor sets the tenant).
 */
@Injectable()
export class ShelfService {
  constructor(
    private readonly replenishment: ReplenishmentService,
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
  ) {}

  /** Estimates overlaid with active snoozes + presigned image URLs. */
  async shelf(customerId: string, now: Date = new Date()): Promise<ShelfEstimate[]> {
    const estimates = await this.replenishment.estimates(customerId, now);

    // Only ACTIVE snoozes suppress — lapsed rows are ignored (and left in
    // place; the next snooze upserts over them).
    const snoozes = await this.prisma.forTenant().replenishmentSnooze.findMany({
      where: { customerId, snoozedUntil: { gt: now } },
    });
    const snoozeByProduct = new Map(snoozes.map((s) => [s.productId, s.snoozedUntil] as const));

    // Presign tile thumbnails in one batch (mirrors buyer-catalog's tile presign).
    const keys = Array.from(
      new Set(estimates.map((e) => e.imageKey).filter((k): k is string => !!k)),
    );
    const urls = keys.length > 0 ? await this.storage.presignedUrls(keys) : [];
    const urlByKey = new Map(keys.map((k, i) => [k, urls[i]] as const));

    return estimates.map((e) => {
      const until = snoozeByProduct.get(e.productId) ?? null;
      return {
        ...e,
        imageUrl: e.imageKey ? (urlByKey.get(e.imageKey) ?? null) : null,
        snoozed: until != null,
        snoozedUntil: until ? until.toISOString() : null,
      };
    });
  }

  /** The add-all-low seed list: low AND not snoozed, at the suggested qty. */
  async lowItems(
    customerId: string,
    now: Date = new Date(),
  ): Promise<Array<{ productId: string; qty: number; boxes?: number; pieces?: number }>> {
    const shelf = await this.shelf(customerId, now);
    return shelf
      .filter((e) => e.state === "low" && !e.snoozed)
      .map((e) => {
        // Boxed products: carry the same {qty: totalPieces, boxes, pieces} split the
        // buyer cart sends (suggestedQty is already whole boxes in PIECES), so the
        // createOrder path prices by the BOX. Sending qty alone would be read as a
        // box COUNT and over-order/over-charge boxed lines by unitsPerBox.
        if (e.unitsPerBox && e.unitsPerBox > 1) {
          const boxes = Math.max(1, Math.round(e.suggestedQty / e.unitsPerBox));
          return { productId: e.productId, qty: boxes * e.unitsPerBox, boxes, pieces: 0 };
        }
        return { productId: e.productId, qty: e.suggestedQty };
      });
  }

  /**
   * Snooze one product for ONE cycle: snoozedUntil = now + cadenceDays, falling
   * back to 14 days when the product has no inferred cadence (or is a real product
   * not in the estimate list). An unknown productId is rejected with 404 before the
   * FK-constrained write. Upsert keyed on (tenantId, customerId, productId).
   */
  async snooze(
    customerId: string,
    productId: string,
    tenantId: string,
    now: Date = new Date(),
  ): Promise<{ snoozedUntil: string }> {
    const estimates = await this.replenishment.estimates(customerId, now);
    const match = estimates.find((e) => e.productId === productId);
    if (!match) {
      // Not in the estimate list — confirm it's a real (tenant-scoped) product
      // before writing the FK-constrained snooze row, so a bogus productId returns
      // a clean 404 instead of a raw Prisma P2003 → 500.
      const product = await this.prisma
        .forTenant()
        .product.findFirst({ where: { id: productId }, select: { id: true } });
      if (!product) throw new NotFoundException(`Product ${productId} not found`);
    }
    const cadence = match?.cadenceDays ?? DEFAULT_SNOOZE_DAYS;
    const snoozedUntil = new Date(now.getTime() + cadence * DAY_MS);

    await this.prisma.forTenant().replenishmentSnooze.upsert({
      where: { tenantId_customerId_productId: { tenantId, customerId, productId } },
      create: { tenantId, customerId, productId, snoozedUntil },
      update: { snoozedUntil },
    });
    return { snoozedUntil: snoozedUntil.toISOString() };
  }

  /** Remove a snooze (deleteMany → no-op safe when none exists). */
  async unsnooze(customerId: string, productId: string): Promise<{ ok: boolean }> {
    await this.prisma.forTenant().replenishmentSnooze.deleteMany({
      where: { customerId, productId },
    });
    return { ok: true };
  }
}
