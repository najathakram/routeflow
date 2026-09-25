import { JwtPayload } from "../auth/jwt-payload.interface";
import { PrismaService } from "../prisma/prisma.service";

/**
 * P5-08: append one immutable OrderRevision row capturing the order's line set + money totals
 * AFTER an edit. The snapshot COPIES stored, already-rounded values verbatim — it never re-prices
 * (no `qty*unitPrice`, no re-derived discounts). The per-order `revisionNumber` (max+1) is
 * computed inside a tenant transaction so rapid autosaves can't collide on the
 * `@@unique([orderId, revisionNumber])`.
 *
 * Extracted verbatim from `OrdersService` (SA-065 size-ratchet prefactor); the service keeps a
 * thin private delegate of the same name so its callers and the guard spec's spy are unchanged.
 */
export type AppendOrderRevisionArgs = [
  orderId: string,
  user: JwtPayload | undefined,
  totals: { subtotal: number; tax: number; total: number; shippingFee?: number },
  source: string,
  reason?: string | null,
];

export async function appendOrderRevision(
  prisma: PrismaService,
  ...[orderId, user, totals, source, reason]: AppendOrderRevisionArgs
): Promise<void> {
  const tenantId = prisma.getTenantId();
  const lines = await prisma.forTenant().orderItem.findMany({
    where: { orderId, status: { not: "CANCELLED" } },
    include: { product: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  const snapshot = {
    subtotal: totals.subtotal,
    tax: totals.tax,
    total: totals.total,
    shippingFee: totals.shippingFee ?? 0,
    lineItems: lines.map((li) => ({
      productId: li.productId,
      name: li.name ?? li.product?.name ?? null,
      qty: Number(li.qty),
      unitPrice: Number(li.unitPrice),
      subtotal: Number(li.subtotal),
      originalPrice: li.originalPrice != null ? Number(li.originalPrice) : null,
      priceType: li.priceType,
      boxes: li.boxes,
      pieces: li.pieces,
      unitsPerBox: li.unitsPerBox,
      trackedCategoryId: li.trackedCategoryId,
      trackedSubcategoryId: li.trackedSubcategoryId,
      notes: li.notes,
      status: li.status,
    })),
  };
  await prisma.tenantTransaction(async (tx) => {
    const max = await tx.orderRevision.aggregate({
      where: { orderId },
      _max: { revisionNumber: true },
    });
    await tx.orderRevision.create({
      data: {
        tenantId,
        orderId,
        revisionNumber: (max._max.revisionNumber ?? 0) + 1,
        editedById: user?.sub ?? null,
        editedByName: user?.username ?? null,
        editedByRole: user?.role ?? null,
        source,
        reason: reason ?? null,
        snapshot,
      },
    });
  });
}
