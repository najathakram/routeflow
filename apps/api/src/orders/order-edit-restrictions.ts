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
import {
  checkableProductIds,
  restrictionChannelForPrincipal,
  restrictionsApply,
  type ChannelPrincipal,
} from "../selling-restrictions/selling-restrictions.core";
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
 * with a retryable 409 when a product now needs a check the pre-lock judgment never made. A STAFF edit with
 * the switch off costs exactly ONE read (the tenant policy), before the transaction; nothing here runs inside
 * it. A buyer's edit is always planned (the portal ignores the switch) and, in a tenant with no active rule,
 * `evaluate` ends after one more read; otherwise it costs a second policy read and one product query more
 * than the license guard.
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
    /** Who is editing: the switch gates the STAFF channel only, so a buyer's edit is always judged. */
    principal: ChannelPrincipal | null | undefined;
  },
): Promise<OrderEditRestrictionPlan | null> {
  // OFF (staff channel, switch off): one read, nothing else. The portal channel always applies its rules.
  const channel = restrictionChannelForPrincipal(p.principal);
  if (!restrictionsApply(await deps.restrictions.getPolicy(p.tenantId), channel)) return null;

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

/**
 * A DRAFT edit skips the restriction plan only while the order has no live (non-VOID) linked invoice; the reconcile
 * after the edit copies the order's lines onto a SENT deposit mirror. That answer is read BEFORE the Order row lock, so
 * re-ask it under the lock: if a mirror appeared meanwhile (a concurrent bill with a deposit), the edit was never
 * judged, so refuse with the retryable 409 (the retry re-runs the pre-check and judges). Read-only.
 */
export async function assertNoMirrorAppearedUnderLock(
  tx: { invoice: { findFirst(args: any): Promise<any> } },
  orderId: string,
  // The PRE-lock answer: true when the pre-check already saw a live mirror (or the order is not a DRAFT), i.e. the
  // edit was judged (or the switch is off) on that basis. Only a mirror the pre-check did NOT see refuses here.
  precheckJudged: boolean,
  status: string | null | undefined,
): Promise<void> {
  if (precheckJudged || status !== "DRAFT") return;
  const live = await tx.invoice.findFirst({
    where: { orderId, status: { not: "VOID" } },
    select: { id: true },
  });
  if (live)
    throw new ConflictException({
      code: API_ERROR_CODES.ORDER_CHANGED_DURING_EDIT,
      message: "The order was billed while you were editing it — review it and try again.",
    });
}
