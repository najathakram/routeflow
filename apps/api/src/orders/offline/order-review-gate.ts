import { ConflictException } from "@nestjs/common";
import { OrderReviewFlagKind } from "@prisma/client";
import { API_ERROR_CODES } from "../../common/api-error-codes";

/**
 * SA-1124 PR-1b: the ONE guard behind invoice send and staff payments. While an order carries an open price-drift flag
 * (an offline order whose lines were quoted at a price that has since moved), nothing may be issued or collected
 * against it until a person has reviewed the drift (SA-817 section 5). Every other flag kind is informational or
 * clears at promotion, so only the kinds in `REVIEW_BLOCKING_KINDS` block. A second blocking kind is a decision for the
 * architect, not a drive-by edit: the count is pinned in `order-review-gate.spec.ts`.
 *
 * The guard takes the db handle of the caller (the tenant-scoped client or an open transaction), so it reads inside the
 * same snapshot as the write it protects and never opens a second connection.
 */
export const REVIEW_BLOCKING_KINDS: readonly OrderReviewFlagKind[] = [
  OrderReviewFlagKind.PRICE_CHANGED_OFFLINE,
];

/** The slice of a Prisma client (or transaction) the gate reads. */
export interface ReviewGateDb {
  orderReviewFlag: {
    findMany(args: {
      where: {
        orderId: string;
        kind: { in: OrderReviewFlagKind[] };
        resolvedAt: null;
      };
      select: { kind: true };
    }): Promise<{ kind: OrderReviewFlagKind }[]>;
  };
}

async function openBlockingKinds(
  db: ReviewGateDb,
  orderId: string,
): Promise<OrderReviewFlagKind[]> {
  const rows = await db.orderReviewFlag.findMany({
    where: { orderId, kind: { in: [...REVIEW_BLOCKING_KINDS] }, resolvedAt: null },
    select: { kind: true },
  });
  return [...new Set(rows.map((r) => r.kind))];
}

/** 409 `ORDER_REVIEW_REQUIRED { orderId, openKinds }` while the order has an open blocking flag. */
export async function assertOrderReviewed(db: ReviewGateDb, orderId: string): Promise<void> {
  const openKinds = await openBlockingKinds(db, orderId);
  if (openKinds.length === 0) return;
  throw new ConflictException({
    code: API_ERROR_CODES.ORDER_REVIEW_REQUIRED,
    message: "This order has a price change to review. Review it, then try again.",
    orderId,
    openKinds,
  });
}

/**
 * The non-throwing form, for a step that must leave a DRAFT behind instead of failing (the deposit invoice mirror
 * written while an offline order is created, or while a delivered order reconciles).
 */
export async function hasOpenReviewBlock(db: ReviewGateDb, orderId: string): Promise<boolean> {
  return (await openBlockingKinds(db, orderId)).length > 0;
}
