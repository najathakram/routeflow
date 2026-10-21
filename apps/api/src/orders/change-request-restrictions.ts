import { ConflictException } from "@nestjs/common";
import type { SaleFulfilmentKind } from "../selling-restrictions/sale-fulfilment";
import type { StaffWriteDecision } from "../selling-restrictions/restriction-warning";
import {
  sellableLinesForChangeRequest,
  type ChangeRequestFacts,
  type EditLine,
} from "../selling-restrictions/order-edit-lines";
import {
  checkableProductIds,
  type ChannelPrincipal,
} from "../selling-restrictions/selling-restrictions.core";
import type {
  SellableLinesArgs,
  SellableLinesParams,
} from "../selling-restrictions/selling-restrictions.service";
import { API_ERROR_CODES } from "../common/api-error-codes";
import type { HeldEditLine } from "./order-edit-restrictions";

/**
 * Selling restrictions at `OrdersService.approveChangeRequestAtStop` (lane R 2a-8), the same shape as
 * `order-edit-restrictions.ts`: the service keeps the choke-point CALL; this module decides what to
 * judge. The merge runs under the order row lock, the choke point uses its own pooled connection, so
 * it is called BEFORE the transaction on the lines read before the lock, and the plan is re-checked
 * under the lock against the lock-time read (`heldItems`): a pure recompute that refuses with a
 * retryable 409 when a product now needs a check the pre-lock judgment never made.
 *
 * Row 510: the plan carries the choke point's parameters (`params`, the line keyed `cr:<changeRequestId>`), the
 * staff-write `decision` once the service has it, the override re-judged under the lock (`assertHeld`) and the stamp
 * written in the same transaction (`stamp`). A DRIVER resolving a change request at the door is hard-blocked
 * ("Ask the office to approve this sale"); the office (OPERATOR / TENANT_ADMIN) is warned and may override.
 */
export interface ChangeRequestRestrictionPlan {
  /** The choke point's parameters (the call site states the channel), from the order rows read BEFORE the lock. */
  params: SellableLinesArgs;
  /** The choke point's answer, set by the service. */
  decision?: StaffWriteDecision;
  /** Inside the transaction, after the lock-time read: refuses (409, retryable) when a product now needs a check, and re-judges the override. */
  assertHeld(lockTimeRows: readonly HeldEditLine[]): void;
  /** Inside the transaction, after the line writes: stamps the acknowledged line. */
  stamp(tx: any, orderId: string): Promise<number>;
}

export function planChangeRequestRestrictions(p: {
  tenantId: string;
  customerId: string;
  existing: readonly HeldEditLine[];
  cr: ChangeRequestFacts & { id: string };
  /** The resolver: the channel and the override right. */
  principal: ChannelPrincipal | null | undefined;
  fulfilmentKind: SaleFulfilmentKind;
  ack?: SellableLinesParams["ack"];
}): ChangeRequestRestrictionPlan {
  const lineKey = `cr:${p.cr.id}`;
  const lines: EditLine[] = sellableLinesForChangeRequest(p.cr, p.existing);
  const judged = new Set(checkableProductIds(lines));
  const plan: ChangeRequestRestrictionPlan = {
    params: {
      tenantId: p.tenantId,
      customerId: p.customerId,
      lines: lines.map((l) => ({ ...l, lineKey })),
      fulfilmentKind: p.fulfilmentKind,
      principal: p.principal,
      ack: p.ack,
      held: p.existing,
      document: "ORDER",
    },
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
      plan.decision = plan.decision?.recheck(lockTimeRows);
    },
    stamp: async (tx, orderId) => (await plan.decision?.stamp(tx, orderId)) ?? 0,
  };
  return plan;
}
