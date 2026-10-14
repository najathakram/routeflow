import { saleFulfilmentKind } from "../selling-restrictions/sale-fulfilment";
import type { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";

/**
 * F-05 (SA-205): the sell check for a recurring-invoice template. Custom (productless) lines are exempt by
 * owner ruling, so only catalog lines are asked about; a tenant-owned template sells as STAFF.
 *  - `unattended` (the midnight cron): returns the blocking reasons (BLOCK / INDETERMINATE — fail closed) or
 *    null when the template may issue; the caller skips the cycle and suspends the template.
 *  - otherwise ("Run now" is an operator deciding): throws the 409 SELLING_RESTRICTED and returns null.
 * A standalone function (not a class method) because the template itself writes no invoice line — the
 * invoice is created by `InvoicesService.create`, which asks again; this is the pre-claim skip.
 */
export async function blockedTemplateLines(
  restrictions: Pick<SellingRestrictionsService, "assertLinesSellable" | "checkLinesSellable">,
  tenantId: string,
  ri: { customerId: string; items: ReadonlyArray<{ productId?: string | null }> },
  unattended: boolean,
) {
  const lines = ri.items.flatMap((it) => (it.productId ? [{ productId: it.productId }] : []));
  if (!unattended) {
    await restrictions.assertLinesSellable({
      tenantId,
      customerId: ri.customerId,
      lines,
      channel: "STAFF",
      fulfilmentKind: saleFulfilmentKind(null), // a recurring invoice has no fulfilment of its own: the customer-address rule
    });
    return null;
  }
  const verdict = await restrictions.checkLinesSellable({
    tenantId,
    customerId: ri.customerId,
    lines,
    channel: "STAFF",
    fulfilmentKind: saleFulfilmentKind(null), // as above: no fulfilment of its own
  });
  return verdict.outcome === "BLOCK" || verdict.outcome === "INDETERMINATE"
    ? verdict.reasons
    : null;
}
