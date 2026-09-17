/**
 * Restocks a return's items at the current average cost — extracted from
 * `ReturnsService.receive()` (Returns Inside Order Creation PR-1c, design.md §5) so the
 * STANDARD post-delivery flow and the INLINE at-order-entry capture flow
 * (`InlineReturnsService.capture()`) share ONE writer instead of two copies drifting apart.
 * Runs INSIDE the caller's own transaction — never opens its own. Skips any item whose
 * `restock` flag is false (unsellable goods, or the caller already decided not to keep
 * them), same as the code this was lifted from.
 */
import { Prisma } from "@prisma/client";

export interface RestockableReturnItem {
  productId: string;
  qty: unknown;
  restock: boolean;
}

export async function restockReturnItems(
  tx: Prisma.TransactionClient,
  ret: { id: string; items: RestockableReturnItem[] },
  userId: string | null,
): Promise<void> {
  for (const item of ret.items) {
    if (!item.restock) continue;
    // Restock at the current average — leaves the average unchanged but records the
    // cost so COGS/valuation reporting stays complete.
    const product = await (tx as any).product.findFirst({
      where: { id: item.productId },
      select: { currentStock: true, averageCost: true },
    });
    const qty = new Prisma.Decimal(item.qty as any);
    await (tx as any).stockMovement.create({
      data: {
        productId: item.productId,
        type: "RETURN",
        quantity: qty,
        unitCost: product?.averageCost ?? null,
        avgCostAfter: product?.averageCost ?? null,
        stockAfter: (product?.currentStock ?? new Prisma.Decimal(0)).add(qty),
        performedById: userId,
        reference: `RET-${ret.id.slice(0, 8)}`,
      },
    });
    await (tx as any).product.update({
      where: { id: item.productId },
      data: { currentStock: { increment: qty } },
    });
  }
}
