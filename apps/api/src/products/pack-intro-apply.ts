import { ConflictException } from "@nestjs/common";
import { AdjustmentReason, MovementType, Prisma } from "@prisma/client";
import { AUDIT_ACTIONS } from "../audit/audit-actions.constant";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { advisoryXactLock } from "../common/db-locks";
import { lockProductsForStock } from "../common/product-locks";
import {
  productInOpenCount,
  STOCK_COUNT_PRODUCT_LOCK_FAMILY,
} from "../inventory/stock-count-commit";
import { findOpenCountConflicts } from "../inventory/stock-count-seed";
import { needsLivePack, STOCK_LINE_UNIT_SELECT } from "../orders/order-stock";
import { CANCEL_CREDITS_FROM } from "../orders/order-status-transitions";
import { applyStockMovements, type StockMovementRow } from "../inventory/stock-movements";
import {
  holdsStockOrCost,
  packConversionTooLargeError,
  packIntroChanges,
  packReadingRequiredError,
  type PackReading,
} from "./pack-intro";

const TYPED_WINS = ["reorderPoint", "reorderQty", "standardCost"] as const;

/**
 * SA-1093 Rule 6: a line with its own unit or box split never reads the live pack, so a cancel after the answer would credit
 * the old unit into converted stock, and a stored line is never rewritten. Read under the stock lock, so a sale that holds it
 * has committed. From Order, because a child row's tenant may be null.
 */
async function refuseOpenOwnUnitLines(
  tx: Prisma.TransactionClient,
  tenantId: string,
  productId: string,
): Promise<void> {
  const orders = await tx.order.findMany({
    where: {
      tenantId,
      status: { in: CANCEL_CREDITS_FROM },
      lineItems: {
        some: {
          productId,
          status: { not: "CANCELLED" },
          OR: [
            { unitLabel: { not: null } },
            { boxes: { not: null } },
            { pieces: { not: null } },
            { unitsPerBox: { not: null } },
          ],
        },
      },
    },
    select: {
      id: true,
      orderNumber: true,
      lineItems: {
        where: { productId, status: { not: "CANCELLED" } },
        select: STOCK_LINE_UNIT_SELECT,
      },
    },
    orderBy: { createdAt: "asc" },
  });
  const held = orders.find((o) => o.lineItems.some((li) => !needsLivePack(li)));
  if (!held) return;
  throw new ConflictException({
    code: API_ERROR_CODES.PACK_OPEN_LINES,
    orderId: held.id,
    orderNumber: held.orderNumber,
    message: `Order ${held.orderNumber ?? ""} has a line in its own unit. Finish or cancel the order first, or choose pieces.`,
  });
}

/**
 * SA-946 MUST 2: a product's first pack, in `update()`'s transaction. Takes the stock lock, so the caller has already
 * taken its code locks. With no answer and stock or cost held, 409 before any write. The box answer writes through the
 * one stock writer: one adjustment for the stock, and one COST_BASIS row so the ledger's fold (and a later cost recompute)
 * lands on the new cost too. History is never rewritten. A reorder level or standard cost typed in the same save stays
 * as typed; the rest go into the caller's `data`. Prices are never touched (L-332). One audit row either way.
 */
export async function applyPackIntroduction(
  tx: Prisma.TransactionClient,
  input: {
    tenantId: string;
    productId: string;
    from: number | null | undefined;
    to: number;
    reading: PackReading | undefined;
    data: Record<string, unknown>;
    actorId: string | null | undefined;
  },
): Promise<void> {
  const { tenantId, productId, from, to, data } = input;
  if (input.reading === "box") {
    // SA-1093 Rule 5: a count's lines are in the old unit. The count's own lock, before the stock lock, as a seed takes it.
    await advisoryXactLock(tx, STOCK_COUNT_PRODUCT_LOCK_FAMILY, `${tenantId}:${productId}`);
    const taken = await findOpenCountConflicts(tx, [productId]);
    if (taken.length > 0) throw productInOpenCount(taken);
  }
  await lockProductsForStock(tx, tenantId, [productId]);
  if (input.reading === "box") await refuseOpenOwnUnitLines(tx, tenantId, productId);
  const stored = await tx.product.findUniqueOrThrow({
    where: { id: productId },
    select: {
      currentStock: true,
      reorderPoint: true,
      reorderQty: true,
      averageCost: true,
      standardCost: true,
    },
  });
  const stockLots = await tx.stockLot.findMany({
    where: { productId, remainingQty: { gt: 0 } },
    select: { id: true, qty: true, remainingQty: true, unitCost: true },
  });
  const held = { ...stored, unitsPerBox: from, stockLots };
  if (!input.reading && holdsStockOrCost(held)) throw packReadingRequiredError();

  const reading = input.reading ?? "piece";
  const changes = packIntroChanges(held, to, reading);
  if (changes && changes.overflow.length > 0) throw packConversionTooLargeError();

  const stockBefore = Number(stored.currentStock);
  const costBefore = stored.averageCost == null ? null : Number(stored.averageCost);
  const stockAfter = changes?.product.currentStock ?? stockBefore;
  const costAfter = changes?.product.averageCost ?? costBefore;

  if (changes) {
    const note = `Units per box set to ${to}`;
    const rows: StockMovementRow[] = [
      {
        productId,
        type: MovementType.ADJUSTMENT,
        target: stockAfter,
        reason: AdjustmentReason.OTHER,
        reasonNote: note,
        performedById: input.actorId ?? null,
      },
    ];
    if (costAfter != null && costAfter !== costBefore) {
      const cost = new Prisma.Decimal(costAfter);
      rows.push({
        productId,
        type: MovementType.COST_BASIS,
        quantity: 0,
        unitCost: cost,
        average: { set: cost },
        notes: note,
        performedById: input.actorId ?? null,
      });
    }
    await applyStockMovements(tx, tenantId, rows);
    for (const { id, ...lot } of changes.lots) {
      await tx.stockLot.update({ where: { id }, data: lot });
    }
    for (const field of TYPED_WINS) {
      const scaled = changes.product[field];
      if (scaled !== undefined && data[field] === undefined) data[field] = scaled;
    }
  }

  await tx.auditLog.create({
    data: {
      tenantId,
      userId: input.actorId ?? null,
      action: AUDIT_ACTIONS.PRODUCT_PACK_INTRODUCED,
      entityType: "Product",
      entityId: productId,
      meta: { from: from ?? null, to, reading, stockBefore, stockAfter, costBefore, costAfter },
    },
  });
}
