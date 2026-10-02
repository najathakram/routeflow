import { ConflictException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import {
  sellableLinesForMergeEdit,
  sellableLinesForReplaceEdit,
  type EditItem,
  type EditLine,
  type ExistingLine,
  type LiveUnitsPerBox,
  type ReplaceActor,
} from "../selling-restrictions/order-edit-lines";
import { checkableProductIds } from "../selling-restrictions/selling-restrictions.core";
import type { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * Selling restrictions at `OrdersService.updateOrderItems` (lane R 2a-7). The service keeps the
 * choke-point CALL (`assertLinesSellable`, literally in the method, so both coverage ratchets see it);
 * this module decides everything around it.
 *
 * The edit runs under a row lock in ONE transaction and the choke point uses its own pooled
 * connection, so it is called BEFORE the transaction on the lines read before the lock. A pre-lock
 * read can be stale under a concurrent edit, so the plan is RE-CHECKED inside the transaction against
 * the lock-time read the service already makes (`heldItems`): a pure recompute (no query) that refuses
 * with a retryable 409 when a product now needs a check the pre-lock judgment never made. OFF costs
 * exactly ONE read (the tenant policy), before the transaction; nothing here runs inside it. ON costs a
 * second policy read (in `evaluate`) and one product query more than the license guard.
 *
 * Known edges (fail closed or vanishingly narrow; pinned by review, not fixed here): a re-check refusal
 * rolls back the item writes but not the earlier `revertLinkedInvoicesForOrderEdit` (every in-tx guard
 * shares that shape); `heldItems` is tenant-scoped and `order.lineItems` is not, so a legacy NULL-tenant
 * line would refuse every retry (none exist); the catalog box size is read once, pre-lock.
 */

/** The `OrderItem` columns the edit decision reads; the service's lock-time read selects the same. */
export const EXISTING_LINE_SELECT = {
  id: true,
  productId: true,
  qty: true,
  boxes: true,
  pieces: true,
  unitsPerBox: true,
  status: true,
  // units_v1 (A1): the post-lock unit-resolution recompute needs the line's own snapshot.
  unitLabel: true,
} as const;

/** How `updateOrderItems` applies this payload for this principal (mirrors its branches). */
export type OrderEditMode = { kind: "merge" } | { kind: "replace"; actor: ReplaceActor };

export function orderEditMode(
  role: string | undefined,
  replaceAll: boolean | undefined,
  isDiffPayload: boolean,
): OrderEditMode {
  // SA-407: a buyer's per-line diff (a unit line's count / a removal) is merged like staff's.
  if (role === UserRole.CUSTOMER)
    return isDiffPayload ? { kind: "merge" } : { kind: "replace", actor: "buyer" };
  if (role === UserRole.DRIVER)
    return isDiffPayload ? { kind: "merge" } : { kind: "replace", actor: "driver" };
  return replaceAll === true ? { kind: "replace", actor: "staff" } : { kind: "merge" };
}

export interface OrderEditRestrictionPlan {
  /** The lines for the choke point, from the order rows read BEFORE the lock. */
  lines: EditLine[];
  /** Inside the transaction, after the lock-time read: refuses (409, retryable) when a product now needs a check. */
  assertHeld(lockTimeRows: readonly ExistingLine[]): void;
}

export async function planOrderEditRestrictions(
  deps: {
    restrictions: Pick<SellingRestrictionsService, "getPolicy">;
    prisma: Pick<PrismaService, "forTenant">;
  },
  p: {
    tenantId: string;
    existing: readonly ExistingLine[];
    items: readonly EditItem[];
    mode: OrderEditMode;
  },
): Promise<OrderEditRestrictionPlan | null> {
  if (!(await deps.restrictions.getPolicy(p.tenantId)).enabled) return null; // OFF: one read, nothing else

  const ids = [
    ...new Set(
      [...p.items.map((i) => i.productId), ...p.existing.map((l) => l.productId)].filter(
        (id): id is string => !!id,
      ),
    ),
  ];
  const products: Array<{ id: string; unitsPerBox: number | null }> = ids.length
    ? await deps.prisma.forTenant().product.findMany({
        where: { tenantId: p.tenantId, id: { in: ids } },
        select: { id: true, unitsPerBox: true },
      })
    : [];
  const live: LiveUnitsPerBox = new Map(products.map((r) => [r.id, r.unitsPerBox]));

  const linesFor = (rows: readonly ExistingLine[]): EditLine[] =>
    p.mode.kind === "merge"
      ? sellableLinesForMergeEdit(rows, p.items, { liveUnitsPerBox: live })
      : sellableLinesForReplaceEdit(rows, p.items, { actor: p.mode.actor, liveUnitsPerBox: live });

  const lines = linesFor(p.existing);
  const judged = new Set(checkableProductIds(lines));
  return {
    lines,
    assertHeld(lockTimeRows) {
      if (checkableProductIds(linesFor(lockTimeRows)).some((id) => !judged.has(id)))
        throw new ConflictException({
          code: API_ERROR_CODES.ORDER_CHANGED_DURING_EDIT,
          message: "The order changed while your edit was being applied — review it and try again.",
        });
    },
  };
}
