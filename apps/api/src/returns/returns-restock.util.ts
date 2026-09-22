/**
 * Restocks a return's items at the current average cost — extracted from
 * `ReturnsService.receive()` (Returns Inside Order Creation PR-1c, design.md §5) so the
 * STANDARD post-delivery flow and the INLINE at-order-entry capture flow
 * (`InlineReturnsService.capture()`) share ONE writer instead of two copies drifting apart.
 * Runs INSIDE the caller's own transaction — never opens its own. Skips any item whose
 * `restock` flag is false (unsellable goods, or the caller already decided not to keep
 * them), same as the code this was lifted from.
 *
 * B665: without `resolvePieces` an item restocks its raw `qty` (INLINE captures already store TRUE pieces).
 * A STANDARD return stores the qty in the order line's own unit (boxes for a box-unaware boxed line), so
 * `ReturnsService.receive()` passes a resolver that converts it. An `unknown` result books NO stock movement
 * and PARKS the item in ReturnParkedRestock (parked while resolvedAt IS NULL) with an error log: the return
 * and the credit still go through, only the stock waits for an operator to supply the split.
 */
import { Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";

const logger = new Logger("restockReturnItems");

export interface RestockableReturnItem {
  id?: string;
  productId: string;
  qty: unknown;
  restock: boolean;
}

/**
 * What a return item restocks, in PIECES (stock is counted in pieces): a known piece count, or `unknown`
 * when the sold line's pack cannot be established without guessing (B665, Senior Architect ruling
 * 2026-09-21). Never the live product's pack.
 */
export type RestockPieces = { pieces: number } | { unknown: true; reason: string };

export async function restockReturnItems(
  tx: Prisma.TransactionClient,
  ret: { id: string; items: RestockableReturnItem[] },
  userId: string | null,
  resolvePieces?: (item: RestockableReturnItem) => Promise<RestockPieces>,
): Promise<void> {
  for (const item of ret.items) {
    if (!item.restock) continue;
    const resolved = resolvePieces ? await resolvePieces(item) : null;
    if (resolved && "unknown" in resolved) {
      await (tx as any).returnParkedRestock.createMany({
        data: [
          {
            returnId: ret.id,
            returnItemId: item.id,
            productId: item.productId,
            returnedQty: new Prisma.Decimal(item.qty as any),
            reason: resolved.reason,
          },
        ],
        skipDuplicates: true, // a retried receive parks it once (UNIQUE returnItemId)
      });
      logger.error(
        `restockReturnItems: return ${ret.id} item ${item.id ?? item.productId} has an unknown pack (${resolved.reason}); restock PARKED (needs basis)`,
      );
      continue;
    }
    await bookRestockMovement(tx, {
      returnId: ret.id,
      productId: item.productId,
      pieces: new Prisma.Decimal((resolved ? resolved.pieces : item.qty) as any),
      userId,
    });
  }
}

/**
 * Books ONE restock in PIECES: the RETURN stock movement (reference `RET-<id8>`, which `cancel()` sums per
 * product to undo exactly what was booked) and the stock increment. Restocks at the current average: it leaves
 * the average unchanged but records the cost so COGS/valuation reporting stays complete. The ONE writer for
 * `receive()`, the INLINE capture and the operator resolution of a parked restock (B665 follow-up), so they
 * cannot drift. Returns the movement's id.
 */
export async function bookRestockMovement(
  tx: Prisma.TransactionClient,
  params: { returnId: string; productId: string; pieces: Prisma.Decimal; userId: string | null },
): Promise<string | null> {
  const product = await (tx as any).product.findFirst({
    where: { id: params.productId },
    select: { currentStock: true, averageCost: true },
  });
  const qty = params.pieces;
  const movement = await (tx as any).stockMovement.create({
    data: {
      productId: params.productId,
      type: "RETURN",
      quantity: qty,
      unitCost: product?.averageCost ?? null,
      avgCostAfter: product?.averageCost ?? null,
      stockAfter: (product?.currentStock ?? new Prisma.Decimal(0)).add(qty),
      performedById: params.userId,
      reference: `RET-${params.returnId.slice(0, 8)}`,
    },
  });
  await (tx as any).product.update({
    where: { id: params.productId },
    data: { currentStock: { increment: qty } },
  });
  return movement?.id ?? null;
}
