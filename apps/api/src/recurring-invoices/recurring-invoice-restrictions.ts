import type { RestrictionAck } from "@routeflow/types";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import * as iGate from "../invoices/invoice-restriction-gate";
import type { SaleFulfilmentKind } from "../selling-restrictions/sale-fulfilment";
import type { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

/**
 * F-05 (SA-205) + row 510: the sell check for a recurring-invoice template. Custom (productless) lines are exempt by
 * owner ruling, so only catalog lines are asked about; a tenant-owned template sells as STAFF.
 *  - `unattended` (the midnight cron): returns the blocking reasons (BLOCK / INDETERMINATE: fail closed) or null when
 *    the template may issue; the caller skips the WHOLE cycle (never a partial invoice), notifies and suspends. No
 *    override exists for a scheduled run, and no stamp is ever written for one.
 *  - otherwise ("Run now" is a staff member deciding): the choke point warns with a 409 RESTRICTION_WARNING; the
 *    clicker resubmits with `{ restrictionOverrides, warningHash }` and the invoice is generated with the stamps
 *    written for THAT user. A principal who may not override (SUPER_ADMIN) gets the hard 409 SELLING_RESTRICTED.
 *    Returns null either way: the stamps are written by `InvoicesService.create`, which asks again with the same keys.
 * A standalone function (not a class method) because the template itself writes no invoice line: the invoice is
 * created by `InvoicesService.create`, which asks again; this is the pre-claim skip. Line keys come from the invoice
 * create's own builder (`n:<index in the template's items>`), so the warning here and the create's gate agree.
 */
export async function blockedTemplateLines(
  restrictions: Pick<SellingRestrictionsService, "assertLinesSellable" | "checkLinesSellable">,
  tenantId: string,
  ri: { customerId: string; items: ReadonlyArray<{ productId?: string | null }> },
  unattended: boolean,
  sale: { fulfilmentKind: SaleFulfilmentKind }, // L8: from `defaultSaleFulfilmentKind` (a template has no order)
  run?: {
    actor?: Pick<JwtPayload, "sub" | "role" | "impersonatedBy">;
    ack?: RestrictionAck | null;
  },
) {
  if (!unattended) {
    await restrictions.assertLinesSellable({
      ...iGate.create(tenantId, ri.customerId, ri.items, run?.actor, run?.ack ?? undefined, sale),
      channel: "STAFF",
    });
    return null;
  }
  const lines = ri.items.flatMap((it) => (it.productId ? [{ productId: it.productId }] : []));
  const verdict = await restrictions.checkLinesSellable({
    tenantId,
    customerId: ri.customerId,
    lines,
    channel: "STAFF",
    fulfilmentKind: sale.fulfilmentKind,
  });
  return verdict.outcome === "BLOCK" || verdict.outcome === "INDETERMINATE"
    ? verdict.reasons
    : null;
}
