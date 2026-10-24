import { ConflictException, ForbiddenException, Logger } from "@nestjs/common";
import { InvoiceStatus } from "@prisma/client";
import * as carrierGuard from "./order-carrier-guard";
import { IDEMPOTENCY_REPLAY_NEEDS_RECONCILE, shouldSkipInPlaceResync } from "./merge-idempotency";
import type { AppliedCreditNoteDto } from "./dto/create-order.dto";

/**
 * `OrdersService.replayMergeReconcile`'s body, lifted VERBATIM (the service sits at its size ratchet and S19 must grow it).
 * `deps` carries the four things it reached through `this`; the service keeps a same-signature delegator.
 */
export async function replayMergeReconcile(
  deps: {
    prisma: any;
    featureConfig?: Parameters<typeof carrierGuard.carrierEditGuard>[0]["featureConfig"];
    logger: Logger;
    reconcile: (
      orderId: string,
      customerId: string,
      appliedCreditNotes: AppliedCreditNoteDto[] | undefined,
      opts: { postDeliveryEdit: boolean; skipInPlaceResync: boolean },
    ) => Promise<unknown>;
  },
  orderId: string,
  customerId: string,
  appliedCreditNotes: AppliedCreditNoteDto[] | undefined,
): Promise<void> {
  if (!deps.prisma.getTenantId()) {
    deps.logger.warn(`replay reconcile refused: no tenant scope order=${orderId}`);
    throw new ForbiddenException("Replay reconcile requires a tenant-scoped session");
  }
  // Customer-scoped, so a replay can never reconcile another customer's order.
  const order = await deps.prisma.forTenant().order.findFirst({
    where: { id: orderId, customerId },
    select: {
      status: true,
      ...{ id: true, tenantId: true, fulfillPath: true, shippedAt: true }, // #3219 S4: carrier routing
      lineItems: { select: { qty: true, invoicedQty: true } },
    },
  });
  if (!order) {
    deps.logger.warn(`replay reconcile skipped: order not found order=${orderId}`);
    return;
  }
  // Routed by the SAME rule as the fold (`resyncsInPlace`, order-carrier-guard.ts), on the order's
  // CURRENT state. That matches the fold's routing unless the state moved in between (a ship /
  // unmark after the fold committed changes `withCarrier`); then the current state decides.
  const carrierNow = await carrierGuard.carrierEditGuard(deps, order); // #3219 S4: as the fold routed
  const postDeliveryEdit = carrierGuard.resyncsInPlace(order.status, carrierNow);
  let skipInPlaceResync = false;
  if (postDeliveryEdit) {
    // Same BILLABLE filter the predicate itself applies (`shouldSkipInPlaceResync`,
    // merge-idempotency.ts): a zero-qty row cannot carry the partial-billing answer, so it must
    // not make this gate read as "invoiced" either — otherwise the two disagree on exactly the
    // rows that decide the branch.
    const lines = (order.lineItems ?? []).filter((li) => Number(li.qty ?? 0) > 0.001);
    const anyInvoiced = lines.some((li) => Number(li.invoicedQty ?? 0) > 0.001);
    if (anyInvoiced) {
      // The cumulative `invoicedQty` survived on these rows (an incremental edit, or a
      // re-stamp by a later invoice sync), so the fold's own predicate answers over the
      // current lines: resync when the order is wholly invoiced, skip when partially.
      skipInPlaceResync = shouldSkipInPlaceResync(lines);
    } else {
      // Nothing shows as invoiced. Two indistinguishable states produce that:
      //   (a) the order genuinely has nothing billed — then `resyncOrderInvoicesForEdit` is a
      //       provable no-op (it returns null when the order has no non-VOID invoice), and the
      //       fold's guard would also have been false, so routing the resync is faithful; or
      //   (b) the replace-all fold RESET `invoicedQty` to 0 on every recreated row, erasing the
      //       pre-edit cumulative billing the guard reads — in which case partial vs wholly
      //       invoiced is unknowable from current state, and BOTH branches are unsafe (a resync
      //       could expand an already-issued invoice to units it never billed; a skip leaves the
      //       finalized invoice out of step with the merge forever).
      // A surviving non-VOID invoice is what separates them: (a) has none.
      const invoiceCount = await deps.prisma
        .forTenant()
        .invoice.count({ where: { orderId, status: { not: InvoiceStatus.VOID } } });
      if (invoiceCount > 0) {
        deps.logger.warn(
          `replay reconcile cannot reproduce the partial-billing guard: refusing ` +
            `tenant=${deps.prisma.getTenantId()} customer=${customerId} order=${orderId} ` +
            `status=${order.status} invoices=${invoiceCount}`,
        );
        throw new ConflictException({
          code: IDEMPOTENCY_REPLAY_NEEDS_RECONCILE,
          orderId,
          message:
            "This order was already submitted and later dispatched; open it to reconcile its invoice",
        });
      }
    }
  }
  await deps.reconcile(orderId, customerId, appliedCreditNotes, {
    postDeliveryEdit,
    skipInPlaceResync,
  });
}
