import { ConflictException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { requireRestrictionTenantId } from "../selling-restrictions/restriction-tenant";
import type { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

type Restrictions = Pick<SellingRestrictionsService, "assertLinesSellable">;

const uniqueIds = (ids: ReadonlyArray<string | null | undefined>): string[] => [
  ...new Set(ids.filter((id): id is string => !!id)),
];

/**
 * F2: a DRAFT order has not been judged by the selling-restrictions engine for these lines since it was placed, so
 * billing it is a sale (the staff channel, like every writer in invoices.service). Any other status keeps F-05's
 * flag-not-block. Runs BEFORE the transaction and the number reservation. Returns the product ids it judged (null for
 * a non-DRAFT order) so `rejudgeDraftOrderInTx` can tell whether the order moved afterwards. Read-only.
 */
export async function assertDraftOrderSellable(
  restrictions: Restrictions,
  tenantId: string | null | undefined,
  order: { status?: string | null; customerId: string | null },
  productIds: ReadonlyArray<string | null | undefined>,
): Promise<ReadonlySet<string> | null> {
  if (order.status !== "DRAFT") return null;
  const ids = uniqueIds(productIds);
  await restrictions.assertLinesSellable({
    tenantId: requireRestrictionTenantId(tenantId),
    customerId: order.customerId,
    lines: ids.map((productId) => ({ productId })),
    channel: "STAFF",
  });
  return new Set(ids);
}

/**
 * F2b: the pre-check above runs outside the transaction, so a DRAFT edited between it and the write (a banned product
 * added or swapped) must not be billed on the strength of that stale verdict. INSIDE the transaction, right after the
 * Order row lock and before the invoice row is written, re-read the order's status and the billed lines' CURRENT
 * products and only COMPARE them with the set the pre-check judged. The engine is never called here: it opens its own
 * connection, and doing that while this transaction holds the Order row lock is the nested open the promotion path
 * avoids too (REG-B100-C). A changed set is a retryable 409 ORDER_CHANGED_DURING_EDIT (the promotion path's code); the
 * client retries and the retry re-runs the pre-check. Skipped when the order is no longer a DRAFT (its promotion judged
 * it). A billed line that vanished is the same 409. Read-only; throws before any write.
 */
export async function rejudgeDraftOrderInTx(
  tx: {
    order: { findFirst(args: any): Promise<any> };
    orderItem: { findMany(args: any): Promise<any[]> };
  },
  order: { id: string },
  billedLineIds: readonly string[],
  judged: ReadonlySet<string> | null,
): Promise<void> {
  const row = await tx.order.findFirst({ where: { id: order.id }, select: { status: true } });
  if (row?.status !== "DRAFT") return;
  const lines =
    (await tx.orderItem.findMany({
      where: { id: { in: [...billedLineIds] } },
      select: { id: true, productId: true },
    })) ?? [];
  const changed = () =>
    new ConflictException({
      code: API_ERROR_CODES.ORDER_CHANGED_DURING_EDIT,
      message: "The order changed while the invoice was being created — review it and try again.",
    });
  if (lines.length !== new Set(billedLineIds).size) throw changed();
  const ids = uniqueIds(lines.map((l) => l.productId));
  if (judged && ids.length === judged.size && ids.every((id) => judged.has(id))) return;
  throw changed();
}
