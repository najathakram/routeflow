import { CostingMethod, MovementType, Prisma } from "@prisma/client";
import { costDecimal } from "./costing";
import { pairedReceiptIds } from "./bill-revert";
import type { StockMovementRow } from "./stock-movements";

/**
 * B562 PR-2 (SA-136 §2): the ONE SALE-side StockMovement row builder. Extracted from
 * `InventoryService.recordSale` so the order stock paths (orders/order-stock.ts) and the inventory
 * service book a sale through the same cost resolver — never a second one.
 *
 * SA-927: the row goes through `applyStockMovements` (stock-movements.ts), which moves the counter and
 * stamps stockAfter; this file only builds the row and resolves its cost.
 */

export interface SaleCost {
  /** Cost per piece for the moved quantity, 4dp (costDecimal). */
  unitCost: Prisma.Decimal;
  /** The product's running average — a sale never moves it, so it is also `avgCostAfter`. */
  avgCost: Prisma.Decimal | null;
}

/**
 * The cost of `quantity` pieces of a product sold now, by its costing method:
 * AVCO → averageCost; STANDARD → standardCost (else average); LAST_COST → the latest PURCHASE's unit
 * cost in accounting order (else average). A stored FIFO/LIFO is RETIRED (SA-804 (1), B1233) and is costed
 * as AVCO: the average cost, matching valuation and reports. No method consumes lots on a sale any more;
 * the lots stay as history and for expiry. Reads only.
 */
export async function resolveSaleCost(
  tx: Prisma.TransactionClient,
  productId: string,
  _quantity: Prisma.Decimal,
): Promise<SaleCost> {
  const product = await tx.product.findFirst({
    where: { id: productId },
    select: { costingMethod: true, averageCost: true, standardCost: true },
  });

  const avgCost = product?.averageCost ?? null;
  const fallback = costDecimal(avgCost ?? 0);
  let unitCost = fallback;

  // AVCO, and a stored (retired) FIFO/LIFO, cost at the average: `unitCost` already is.
  if (product?.costingMethod === CostingMethod.STANDARD) {
    unitCost = costDecimal(product.standardCost ?? avgCost ?? 0);
  } else if (product?.costingMethod === CostingMethod.LAST_COST) {
    // Last cost — cost the sale at the most recent PURCHASE's unit cost
    // (pos-cost-roles-spec §1: "most recent bill's unit cost"). Read the typed
    // PURCHASE movement, NOT the latest StockLot: positive adjustments and
    // stock-counts create lots stamped at the AVERAGE cost, which would poison
    // the last-cost source. Order by effectiveAt (the bill/purchase date — B562:
    // what createdAt carried before it became write-once), then createdAt + id so
    // the pick is deterministic when same-day bills share a date. Falls back to the
    // average cost when the product has no purchases yet. Not lot-consuming.
    // B846: a vendor-bill revert appends a negative PURCHASE row — only positive rows count, and a
    // receipt a reversal has paired is no longer "last" (shared rule: inventory/bill-revert.ts).
    const paired = await pairedReceiptIds(tx, productId);
    const lastPurchase = await tx.stockMovement.findFirst({
      where: {
        productId,
        type: MovementType.PURCHASE,
        quantity: { gt: 0 },
        ...(paired.length > 0 ? { id: { notIn: paired } } : {}),
      },
      orderBy: [{ effectiveAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      select: { unitCost: true },
    });
    unitCost = costDecimal(lastPurchase?.unitCost ?? avgCost ?? 0);
  }

  return { unitCost, avgCost };
}

export interface SaleMovementInput {
  productId: string;
  /** Signed pieces: negative = out (a sale), positive = back (a reversal). */
  quantity: Prisma.Decimal | number;
  /** `ORDER:<orderId>` for order paths. */
  reference: string | null;
  /** The stock event: CREATE | EDIT | CANCEL | UNCANCEL | PROMOTE | DEMOTE | TEMPLATE:<id>. */
  notes?: string | null;
  performedById: string | null;
  /** A cost already resolved by the caller (recordSale); resolved here otherwise. */
  cost?: SaleCost;
}

/**
 * The SALE row for one product's stock event, for `applyStockMovements` (SA-927 §1: the helper moves the
 * counter and stamps stockAfter). A zero quantity gives null (no row). Call it inside the helper's plan
 * function, so the cost is resolved under the product lock. Sales never move the average ("keep").
 */
export async function saleMovementRow(
  tx: Prisma.TransactionClient,
  input: SaleMovementInput,
): Promise<StockMovementRow | null> {
  const quantity = new Prisma.Decimal(input.quantity);
  if (quantity.isZero()) return null;
  const cost = input.cost ?? (await resolveSaleCost(tx, input.productId, quantity.abs()));
  return {
    productId: input.productId,
    type: MovementType.SALE,
    quantity,
    unitCost: cost.unitCost,
    average: "keep",
    reference: input.reference,
    notes: input.notes ?? null,
    performedById: input.performedById,
  };
}
