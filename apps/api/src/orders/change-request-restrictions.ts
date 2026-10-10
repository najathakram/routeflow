import { ConflictException } from "@nestjs/common";
import {
  sellableLinesForChangeRequest,
  type ChangeRequestFacts,
  type EditLine,
  type ExistingLine,
} from "../selling-restrictions/order-edit-lines";
import { checkableProductIds } from "../selling-restrictions/selling-restrictions.core";
import type { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { API_ERROR_CODES } from "../common/api-error-codes";

/**
 * Selling restrictions at `OrdersService.approveChangeRequestAtStop` (lane R 2a-8), the same shape as
 * `order-edit-restrictions.ts`: the service keeps the choke-point CALL; this module decides what to
 * judge. The merge runs under the order row lock, the choke point uses its own pooled connection, so
 * it is called BEFORE the transaction on the lines read before the lock, and the plan is re-checked
 * under the lock against the lock-time read (`heldItems`): a pure recompute that refuses with a
 * retryable 409 when a product now needs a check the pre-lock judgment never made.
 * OFF costs exactly ONE read (the tenant policy), before the transaction; nothing runs inside it.
 */
export interface ChangeRequestRestrictionPlan {
  /** The lines for the choke point, from the order rows read BEFORE the lock. */
  lines: EditLine[];
  /** Inside the transaction, after the lock-time read: refuses (409, retryable) when a product now needs a check. */
  assertHeld(lockTimeRows: readonly ExistingLine[]): void;
}

export async function planChangeRequestRestrictions(
  deps: { restrictions: Pick<SellingRestrictionsService, "getPolicy"> },
  p: { tenantId: string; existing: readonly ExistingLine[]; cr: ChangeRequestFacts },
): Promise<ChangeRequestRestrictionPlan | null> {
  if (!(await deps.restrictions.getPolicy(p.tenantId)).enabled) return null; // OFF: one read, nothing else
  const lines = sellableLinesForChangeRequest(p.cr, p.existing);
  const judged = new Set(checkableProductIds(lines));
  return {
    lines,
    assertHeld(lockTimeRows) {
      if (
        checkableProductIds(sellableLinesForChangeRequest(p.cr, lockTimeRows)).some(
          (id) => !judged.has(id),
        )
      )
        throw new ConflictException({
          code: API_ERROR_CODES.ORDER_CHANGED_DURING_EDIT,
          message:
            "The order changed while the change was being applied — review it and try again.",
        });
    },
  };
}
