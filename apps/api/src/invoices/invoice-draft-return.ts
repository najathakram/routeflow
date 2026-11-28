import { BadRequestException, NotFoundException } from "@nestjs/common";
import { InvoiceStatus } from "@prisma/client";
import type { CommissionEngineService } from "../sales-agents/commission-engine.service";
import * as du from "./invoice-display-unit"; // SA-827 display units
import { loadReopenableInvoice } from "./invoice-reopen-guard";
import { lockInvoiceRow, REVERTABLE_STATUSES, revertRefusal } from "./invoice-send-guard";

/**
 * The collaborators the two DRAFT-return routes (revert, reopen) need, bound by the caller
 * (InvoicesService passes its own; the private members arrive as closures so a spy on the service
 * still lands).
 *
 * Rule (SA-1532, pinned in order-lock-callers.guard.spec.ts): every transaction callback in this file takes its client as
 * `tx`, every write goes through it, and the lock comes first.
 */
export interface InvoiceDraftReturnDeps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- PrismaService and its test mock both fit
  prisma: any;
  commissionEngine: CommissionEngineService;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the invoice row, as the service reads it
  findOneOrThrow: (id: string) => Promise<any>;
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
    if (!locked) throw new NotFoundException("Invoice not found"); // R-302: gone since the pre-read
    const lockedRefusal = revertRefusal(
      locked.status,
      // scan-ok: draft-payment-not-void — existence check on the locked row, not a money sum.
      locked.payments.filter((p: any) => p.status !== "VOID").length,
    );
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

/**
 * Known gap (W-1458, SA-1532 LOW-2): reopen takes no row lock and its update has no status predicate; its
 * PAID check is a pre-read outside the transaction (invoice-reopen-guard.ts). Moved unchanged from
 * InvoicesService. Hardening it is its own item and needs its own ROW_LOCK_SITES row.
 */
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
