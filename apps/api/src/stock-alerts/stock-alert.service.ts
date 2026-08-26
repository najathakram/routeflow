import { Injectable, Logger, NotFoundException } from "@nestjs/common";
import { StockAlertStatus } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { NotificationsService } from "../notifications/notifications.service";

/**
 * Phase 5 (P5-03): buyer "Notify me when back in stock".
 *
 * One StockAlert row per (tenant, customer, product). Subscribing upserts the
 * row to PENDING (idempotent; re-subscribing after a NOTIFIED restock re-arms
 * it). Restocks call {@link fireForProducts} AFTER the inventory transaction
 * commits: for each product with on-hand > 0, every PENDING alert gets exactly
 * one push (NotificationsService.sendToCustomer — push-only per G9) and is
 * flipped PENDING → NOTIFIED. Because only PENDING rows ever fire, calling
 * this from multiple restock paths is idempotent — a second call finds no
 * PENDING rows and fires nothing.
 *
 * Tenant scoping rides forTenant() on every read/write (callers run inside a
 * tenant ALS context). No costing/lot/pricing math lives here.
 */
@Injectable()
export class StockAlertService {
  private readonly logger = new Logger(StockAlertService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {}

  /**
   * Subscribe (idempotent upsert on the unique key). Only meaningful when the
   * product is OOS, but an in-stock subscribe is NOT hard-blocked — the row is
   * simply kept and fires on the next restock-from-zero.
   */
  async subscribe(
    customerId: string,
    productId: string,
    tenantId: string,
  ): Promise<{ subscribed: true }> {
    const product = await this.prisma.forTenant().product.findFirst({
      where: { id: productId, isActive: true },
      select: { id: true },
    });
    if (!product) throw new NotFoundException("Product not found");

    await this.prisma.forTenant().stockAlert.upsert({
      where: { tenantId_customerId_productId: { tenantId, customerId, productId } },
      create: { tenantId, customerId, productId, status: StockAlertStatus.PENDING },
      // Re-subscribing after a NOTIFIED restock re-arms the alert.
      update: { status: StockAlertStatus.PENDING, notifiedAt: null },
    });
    return { subscribed: true };
  }

  /** Unsubscribe (deleteMany → no-op safe when none exists). */
  async unsubscribe(customerId: string, productId: string): Promise<{ subscribed: false }> {
    await this.prisma.forTenant().stockAlert.deleteMany({
      where: { customerId, productId },
    });
    return { subscribed: false };
  }

  /** Product ids this buyer has a PENDING alert on (tile subscribed-state). */
  async subscriptionsFor(customerId: string): Promise<{ productIds: string[] }> {
    const rows = await this.prisma.forTenant().stockAlert.findMany({
      where: { customerId, status: StockAlertStatus.PENDING },
      select: { productId: true },
    });
    return { productIds: rows.map((r) => r.productId) };
  }

  /** Whether this buyer has a PENDING alert on the product (detail DTO flag). */
  async isSubscribed(customerId: string, productId: string): Promise<boolean> {
    const row = await this.prisma.forTenant().stockAlert.findFirst({
      where: { customerId, productId, status: StockAlertStatus.PENDING },
      select: { id: true },
    });
    return row != null;
  }

  /**
   * Restock fire. For each (deduped) product: if current on-hand > 0, send
   * exactly one push per PENDING alert, then flip it PENDING → NOTIFIED.
   * A push failure is swallowed per-alert and the entry is STILL cleared
   * ("fires exactly one notification and clears the entry" — a broken push
   * channel must not turn into an infinite re-fire loop).
   */
  async fireForProducts(productIds: string[]): Promise<{ notified: number }> {
    const unique = [...new Set(productIds)];
    if (unique.length === 0) return { notified: 0 };

    let notified = 0;
    for (const productId of unique) {
      const product = await this.prisma.forTenant().product.findFirst({
        where: { id: productId },
        select: { id: true, name: true, currentStock: true },
      });
      // In-stock guard: never fire while on-hand is still 0 or negative.
      if (!product || Number(product.currentStock) <= 0) continue;

      const pending = await this.prisma.forTenant().stockAlert.findMany({
        where: { productId, status: StockAlertStatus.PENDING },
      });

      for (const alert of pending) {
        // Claim the alert atomically BEFORE pushing: updateMany is guarded on
        // status: PENDING, so a concurrent restock of the same product can only
        // win the claim once. Losers (count === 0) skip the push, which keeps the
        // "exactly one notification" guarantee under concurrent restock paths.
        const { count } = await this.prisma.forTenant().stockAlert.updateMany({
          where: { id: alert.id, status: StockAlertStatus.PENDING },
          data: { status: StockAlertStatus.NOTIFIED, notifiedAt: new Date() },
        });
        if (count !== 1) continue;

        try {
          await this.notifications.sendToCustomer(
            alert.customerId,
            "Back in stock",
            `${product.name} is back in stock — order now before it sells out.`,
            { type: "STOCK_ALERT", productId: product.id },
          );
        } catch {
          // The entry is already claimed/cleared, so a broken push channel
          // can't turn into an infinite re-fire loop.
          this.logger.warn(`Stock-alert push failed for alert ${alert.id} (entry still cleared)`);
        }
        notified += 1;
      }
    }
    return { notified };
  }
}
