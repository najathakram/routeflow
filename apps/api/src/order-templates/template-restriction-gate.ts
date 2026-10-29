import type { RestrictionAck } from "@routeflow/types";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import type { SellableLinesArgs } from "../selling-restrictions/selling-restrictions.service";
import type { StaffWriteDecision } from "../selling-restrictions/restriction-warning";

/**
 * Row 510: the restriction gate of a standing order's MANUAL STAFF run ("Generate" on a template). The service keeps the
 * choke-point CALL (`assertLinesSellable`, so the coverage ratchets see it) and states the channel and the sale's kind
 * (L8: `saleFulfilmentKind` of the order's resolved fulfil path); the keys and the stamp target live here.
 *
 *  - A manual run by a staff member is a staff member deciding: a restricted line answers 409 RESTRICTION_WARNING; the
 *    resubmit carries `{ restrictionOverrides, warningHash }` and the order is created with the stamps written for THAT
 *    user (`decision.stamp(tx, orderId)` in the order's own transaction).
 *  - A buyer's Reorder (CUSTOMER role) keeps the hard 409 and the customer-safe body: the same call, channel BUYER_PORTAL.
 *  - The SCHEDULED run never reaches this: it follows #2093 (skip the banned line, order the rest, notify once, suspend
 *    the template line) in `createOrderFromTemplate`'s unattended branch, and never stamps.
 *  - A template line carries no override: nothing is auto-applied or carried forward from an earlier run.
 *
 * `n:<index>` is the line's position among the template's LIVE (unsuspended) lines, stable for the same template.
 */

/** Who generated the order and what they acknowledged (absent on the cron and on any internal caller). */
export interface TemplateStaffRun {
  actor: Pick<JwtPayload, "sub" | "role" | "impersonatedBy">;
  ack?: RestrictionAck | null;
}

export type TemplateDecision = StaffWriteDecision;

/**
 * The choke-point parameters (without the channel and the kind, which the call site states) for a manual run. The
 * order is judged at its own fulfil path: a PICKUP template order at the STORE's state, a delivered or shipped one at
 * the customer's address (`sale-fulfilment.ts`).
 */
export function manualArgs(a: {
  tenantId: string;
  customerId: string;
  live: ReadonlyArray<{ productId: string }>;
  run?: TemplateStaffRun;
}): Omit<SellableLinesArgs, "fulfilmentKind"> {
  return {
    tenantId: a.tenantId,
    customerId: a.customerId,
    lines: a.live.map((i, idx) => ({ productId: i.productId, lineKey: `n:${idx}` })),
    principal: a.run?.actor,
    ack: a.run?.ack ?? undefined,
    document: "ORDER",
  };
}

/** The scheduled run's read (the call site states the kind: a PICKUP customer is judged at the store). */
export function scheduledArgs(a: {
  tenantId: string;
  customerId: string;
  live: ReadonlyArray<{ productId: string }>;
}): Pick<SellableLinesArgs, "tenantId" | "customerId" | "lines"> {
  return {
    tenantId: a.tenantId,
    customerId: a.customerId,
    lines: a.live.map((i) => ({ productId: i.productId })),
  };
}

/** The final decision, stamped inside the order's own transaction. Nothing to write means nothing is written. */
export async function stampOrder(
  tx: Parameters<TemplateDecision["stamp"]>[0],
  decision: TemplateDecision | undefined,
  orderId: string,
): Promise<void> {
  if (decision) await decision.stamp(tx, orderId);
}
