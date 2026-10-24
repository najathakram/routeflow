/**
 * SA-740 §1 (row 190): the source sale of an inline return.
 *
 * The walk-in is ONE shared customer row, so a customer-scoped matching set lets a return from receipt B
 * be allocated to the newest sale A: priced at A's line and judged on A's tender (the F4 "paid with store
 * credit, so no cash" check reads the wrong invoice). A return is therefore PINNED to a source sale:
 *   - a WALK-IN (decided server-side from `customer.isWalkIn`, never from the client) must name one: the
 *     quote requires it (400 SOURCE_SALE_REQUIRED), the capture defaults it to the carrying order;
 *   - a NAMED customer keeps the cross-order spill (a driver at a stop, "Record return" on an order) unless
 *     the caller sends one, which is then pinned too;
 *   - whoever names it, the source must be this customer's own counter sale or delivered order in this
 *     tenant (400 SOURCE_SALE_INVALID);
 *   - a walk-in never gets an unreferenced (no source line) chunk: an account-less over-return priced from
 *     the product list is cash out with no sale behind it (409 RETURN_EXCEEDS_SALE).
 */
import { BadRequestException, ConflictException } from "@nestjs/common";
import { OrderStatus } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";

/** The refusals of this module (nothing is written). The mobile capture classifier settles its offline nonce on them. */
export const SOURCE_SALE_ERROR_CODES = {
  SOURCE_SALE_REQUIRED: API_ERROR_CODES.SOURCE_SALE_REQUIRED,
  SOURCE_SALE_INVALID: API_ERROR_CODES.SOURCE_SALE_INVALID,
  RETURN_EXCEEDS_SALE: API_ERROR_CODES.RETURN_EXCEEDS_SALE,
} as const;

const DELIVERED_STATUSES: readonly string[] = [
  OrderStatus.DELIVERED,
  OrderStatus.PARTIALLY_DELIVERED,
];

/**
 * Decides the source sale of one pricing run. Returns the order id the matching set is pinned to, or null
 * for an unpinned named-customer run. `db` is the tenant-scoped client (or the capture tx, whose proxy
 * injects the tenant), so a foreign tenant's order reads as missing: 400, never a probe.
 */
export async function resolveSourceSale(
  db: any,
  input: {
    customerId: string;
    isWalkIn: boolean;
    /** What the caller sent (`sourceOrderId` on the quote / capture). */
    requested?: string | null;
    /** The capture's carrying order: the walk-in default (the counter flow carries the return on the sale). */
    defaultSourceOrderId?: string | null;
  },
): Promise<string | null> {
  const wanted =
    input.requested || (input.isWalkIn ? (input.defaultSourceOrderId ?? null) : null) || null;
  if (!wanted) {
    if (input.isWalkIn) {
      throw new BadRequestException({
        code: API_ERROR_CODES.SOURCE_SALE_REQUIRED,
        message: "Choose the sale this return is from.",
      });
    }
    return null;
  }
  const order = await db.order.findFirst({
    where: { id: wanted, customerId: input.customerId },
    select: { id: true, status: true, counterSale: true },
  });
  const usable =
    order != null &&
    order.status !== OrderStatus.CANCELLED &&
    (order.counterSale === true || DELIVERED_STATUSES.includes(order.status));
  if (!usable) {
    throw new BadRequestException({
      code: API_ERROR_CODES.SOURCE_SALE_INVALID,
      message:
        "That sale cannot be returned from: it is not this customer's counter sale or delivered order.",
    });
  }
  return order.id;
}

/**
 * A walk-in's allocation must be fully covered by the source sale: any chunk with no source line is the
 * account-less over-return. `requestedPieces` / the allocation are in pieces.
 */
export function assertWalkInCoveredBySale(
  productId: string,
  productName: string,
  allocated: ReadonlyArray<{ line: unknown; pieces: number }>,
): void {
  const over = allocated.filter((c) => !c.line).reduce((n, c) => n + c.pieces, 0);
  if (over <= 0) return;
  const covered = allocated.filter((c) => c.line).reduce((n, c) => n + c.pieces, 0);
  throw new ConflictException({
    code: API_ERROR_CODES.RETURN_EXCEEDS_SALE,
    message:
      `${productName}: that is more than this sale had left to return` +
      (covered > 0 ? ` (at most ${covered} pieces)` : "") +
      ". Check the quantity or the receipt.",
    productId,
    availablePieces: covered,
    requestedPieces: covered + over,
  });
}
