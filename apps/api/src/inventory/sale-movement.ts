import { CostingMethod, MovementType, Prisma } from "@prisma/client";
import { costDecimal } from "./costing";

/**
 * B562 PR-2 (SA-136 §2): the ONE SALE-side StockMovement writer. Extracted from
 * `InventoryService.recordSale` so the order stock paths (orders/order-stock.ts) and the inventory
 * service book a sale through the same cost resolver — never a second one.
 *
 * Invariant (SA-136 §1): every write to `Product.currentStock` appends exactly one StockMovement for
 * that product in the same transaction, carrying the signed quantity that moved the counter and
 * `stockAfter` = the counter after the write. Callers therefore write the row AFTER the counter update
 * and pass the counter the update RETURNED — never a pre-read.
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
    const lastPurchase = await tx.stockMovement.findFirst({
      where: { productId, type: MovementType.PURCHASE },
      orderBy: [{ effectiveAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
      select: { unitCost: true },
    });
    unitCost = costDecimal(lastPurchase?.unitCost ?? avgCost ?? 0);
  }

  return { unitCost, avgCost };
}

export interface SaleMovementInput {
  productId: string;
  /** Signed pieces that moved the counter: negative = out (a sale), positive = back (a reversal). */
  quantity: Prisma.Decimal | number;
  /** The counter AFTER the write that moved it — read from that write's own result. */
  stockAfter: Prisma.Decimal | number;
  /** `ORDER:<orderId>` for order paths. */
  reference: string | null;
  /** The stock event: CREATE | EDIT | CANCEL | UNCANCEL | PROMOTE | DEMOTE | TEMPLATE:<id>. */
  notes?: string | null;
  performedById: string | null;
  /** A cost already resolved by the caller (recordSale); resolved here otherwise. */
  cost?: SaleCost;
}

/**
 * Append the SALE row for one product's stock event. A zero quantity writes nothing (a row that moved
 * no stock would break "one row per write"). Does NOT touch `currentStock` or the lots: the caller has
 * already moved the counter, and lot consumption for order sales is out of PR-2's scope (SA-149 D-11).
 */
export async function recordSaleMovement(
  tx: Prisma.TransactionClient,
  input: SaleMovementInput,
): Promise<{ id: string } | null> {
  const quantity = new Prisma.Decimal(input.quantity);
  if (quantity.isZero()) return null;
  const cost = input.cost ?? (await resolveSaleCost(tx, input.productId, quantity.abs()));
  return tx.stockMovement.create({
    data: {
      productId: input.productId,
      type: MovementType.SALE,
      quantity,
      unitCost: cost.unitCost,
      // Sales never move the average — the snapshot carries it forward.
      avgCostAfter: cost.avgCost,
      stockAfter: new Prisma.Decimal(input.stockAfter),
      reference: input.reference,
      notes: input.notes ?? null,
      performedById: input.performedById,
    },
    select: { id: true },
  });
}
