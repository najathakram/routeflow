import { BadRequestException, ConflictException } from "@nestjs/common";
import { InvoiceStatus } from "@prisma/client";
import { API_ERROR_CODES } from "../common/api-error-codes";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import type { RegulatedSettleResult } from "../regulated/regulated-ledger.service";
import type { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import type { CommissionEngineService } from "../sales-agents/commission-engine.service";
import * as du from "./invoice-display-unit"; // SA-827 display units
import * as iGate from "./invoice-restriction-gate";
import * as uGate from "./invoice-unvoid-gate";
import { loadReopenableInvoice } from "./invoice-reopen-guard";
import { lockInvoiceRow, REVERTABLE_STATUSES, revertRefusal } from "./invoice-send-guard";
import { assertUnvoidOrderNotCancelled } from "./unvoid-billing-refusal";

/**
 * The collaborators the three DRAFT-return routes (revert, reopen, unvoid) need, bound by the caller
 * (InvoicesService passes its own; the private members arrive as closures so a spy on the service
 * still lands).
 */
export interface InvoiceDraftReturnDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PrismaService and its test mock both fit
  prisma: any;
  commissionEngine: CommissionEngineService;
  sellingRestrictions: SellingRestrictionsService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the invoice row, as the service reads it
  findOneOrThrow: (id: string) => Promise<any>;
  adjustInvoicedQtyForInvoice: (
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the open transaction client
    tx: any,
    invoiceId: string,
    orderId: string | null,
    direction: -1 | 1,
  ) => Promise<void>;
  resyncInvoiceLedger: (
    invoiceId: string,
    orderId: string | null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- invoice item rows
    items: any[],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the open transaction client
    db: any,
    opts?: { restoresVoid?: boolean },
  ) => Promise<RegulatedSettleResult>;
}

export async function revertInvoiceToDraftFlow(deps: InvoiceDraftReturnDeps, id: string) {
  const inv = await deps.findOneOrThrow(id);
  // Fast refusal on the pre-read; the authoritative one is re-judged on the LOCKED row below.
  const refused = revertRefusal(
    inv.status,
    // Block if there are any LIVE payments. B314: a VOID (bounced) payment carries no money —
    // counting it here made a bounced check permanently block the revert with no way out.
    // This is an EXISTENCE check ("is any payment record still live?"), not a money sum — a
    // DRAFT payment must still block: it is an unconfirmed but real payment record, and
    // reverting out from under it would orphan it once it is later confirmed.
    // CONFIRMED_PAYMENT (status: "PAID" only) would be WRONG here.
    await deps.prisma
      .forTenant()
      // scan-ok: draft-payment-not-void — existence check, not a money sum; see comment above.
      .invoicePayment.count({ where: { invoiceId: id, status: { not: "VOID" } } }),
  );
  if (refused) throw new BadRequestException(refused);
  // Sales agents & commissions: revert + resync are one atomic unit — a
  // DRAFT invoice targets zero commission.
  return deps.prisma.tenantTransaction(async (tx: any) => {
    // SA-1508 (R-197-D F2): (Order →) Invoice locked FIRST; the status and the live payments are
    // re-judged on the locked row, so a void or a payment committed since the pre-read wins.
    const locked = await lockInvoiceRow(tx, id, inv.orderId);
    const lockedRefusal = locked
      ? revertRefusal(
          locked.status,
          // scan-ok: draft-payment-not-void — existence check on the locked row, not a money sum.
          locked.payments.filter((p: any) => p.status !== "VOID").length,
        )
      : "Invoice not found";
    if (lockedRefusal) throw new BadRequestException(lockedRefusal);
    const reverted = await tx.invoice.update({
      where: { id, status: { in: REVERTABLE_STATUSES } },
      data: { status: InvoiceStatus.DRAFT, sentAt: null, pdfUrl: null },
    });
    await du.clearIssueDisplayUnits(tx, id); // SA-827: a DRAFT renders live; a re-issue freezes afresh
    await deps.commissionEngine.syncInvoiceCommissionSafe(id, tx);
    return reverted;
  });
}

export async function unvoidInvoiceFlow(
  deps: InvoiceDraftReturnDeps,
  id: string,
  actor?: JwtPayload,
  ack?: iGate.Ack,
) {
  const inv = await deps.findOneOrThrow(id);
  if (inv.status !== InvoiceStatus.VOID) {
    throw new BadRequestException(
      `Only VOID invoices can be unvoided. Current status: ${inv.status}`,
    );
  }
  // Row 460 (SA-272): unvoid is a new sale of the whole invoice: every line judged (STAFF) before any write.
  const gate = await uGate.unvoidParams(deps.prisma, inv, actor, ack);
  const restriction = await deps.sellingRestrictions.assertLinesSellable({
    ...gate.params,
    channel: "STAFF",
  });
  // Voiding RELEASED this invoice's invoicedQty back to the order; bringing it
  // back to DRAFT re-claims that qty so a later invoice can't double-bill the
  // same lines, and re-books the regulated ledger (SA-839 / B706). Atomic with the status flip.
  return deps.prisma.tenantTransaction(async (tx: any) => {
    // SA-760 R-1: Order -> Invoice before the invoicedQty write; the VOID check is re-read under them.
    const locked = await lockInvoiceRow(tx, id, inv.orderId);
    if (locked?.status !== InvoiceStatus.VOID)
      throw new ConflictException({
        code: API_ERROR_CODES.ORDER_BILLING_CHANGED,
        message: "The invoice changed while it was being restored. Refresh and try again.",
      });
    await assertUnvoidOrderNotCancelled(tx, inv.orderId); // B693: 409 before any write
    const held = await uGate.lockedUnvoidHeld(tx, id, gate.judged); // row 460: the judged lines, under the lock
    const overridden = restriction?.recheck(held);
    // B299 / SA-814 R4-5: the re-claim runs FIRST and is not clamped - if another invoice now bills these
    // goods (or the line is CANCELLED) it throws 409 ORDER_BILLING_CHANGED before the status flip writes.
    await deps.adjustInvoicedQtyForInvoice(tx, id, inv.orderId, 1);
    const restored = await tx.invoice.update({
      where: { id },
      data: { status: InvoiceStatus.DRAFT },
    });
    await overridden?.stamp(tx, id); // row 460: the staff override of a restricted line
    await du.clearIssueDisplayUnits(tx, id); // SA-827 rule 5 / B1275: a DRAFT renders live
    // SA-839 F2 (B706): re-book from the items read in this tx, in the UNVOID's period (§3); the void's
    // rows stay. `amendedPeriod` (never a refusal): the void sat in a FILED month (SA-182 shape).
    const items = await tx.invoiceItem.findMany({ where: { invoiceId: id } });
    const { amendedPeriod } = await deps.resyncInvoiceLedger(id, inv.orderId, items, tx, {
      restoresVoid: true,
    });
    return { ...restored, amendedPeriod };
  });
}

export async function reopenInvoiceFlow(deps: InvoiceDraftReturnDeps, id: string) {
  await loadReopenableInvoice(deps.prisma.forTenant(), id); // PAID only; W-861: never a paid walk-in sale

  // Sales agents & commissions: PAID→DRAFT is the nastiest clawback path —
  // if commission was already claimed, sync emits the negative adjustment
  // atomically with the status flip.
  return deps.prisma.tenantTransaction(async (tx: any) => {
    await du.clearIssueDisplayUnits(tx, id); // SA-827 rule 5 / B1275: BEFORE the update, whose items must not carry the old word
    const reopened = await tx.invoice.update({
      where: { id },
      data: { status: InvoiceStatus.DRAFT, paidAt: null },
      include: {
        customer: { select: { id: true, businessName: true } },
        items: true,
        payments: { orderBy: { createdAt: "desc" } },
      },
    });
    await deps.commissionEngine.syncInvoiceCommissionSafe(id, tx);
    return reopened;
  });
}
