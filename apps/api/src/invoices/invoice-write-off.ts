import { BadRequestException, NotFoundException } from "@nestjs/common";
import { InvoiceStatus } from "@prisma/client";
import type { WriteOffDto } from "./dto/create-invoice.dto";
import { lockInvoiceRow, writeOffRefusal } from "./invoice-send-guard";

/** The collaborators the write-off needs, bound by the caller (InvoicesService passes its own). */
export interface WriteOffDeps {
  prisma: { tenantTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> };
  commissionEngine: { syncInvoiceCommissionSafe(invoiceId: string, db?: any): Promise<unknown> };
}

/**
 * The write-off inside the caller's transaction (SA-1050 PR-1 commit 1: moved VERBATIM out of InvoicesService so
 * the bad-debt rules have ONE home, and to give invoices.service.ts its ratchet headroom back). #2472 (3): (Order →)
 * Invoice locked FIRST and re-checked there — a void since the caller's pre-read wins. Sales agents & commissions:
 * materially a no-op for money (payable derives from payments, and WRITTEN_OFF releases nothing beyond cash already
 * collected) but wrapped atomically to refresh the accrual's display status alongside the write-off.
 */
export async function writeOffInTx(
  deps: WriteOffDeps,
  tx: any,
  id: string,
  orderId: string | null,
  dto: WriteOffDto,
) {
  const locked = await lockInvoiceRow(tx, id, orderId);
  if (!locked) throw new NotFoundException("Invoice not found");
  const refused = writeOffRefusal(locked.status);
  if (refused) throw new BadRequestException(refused);
  const written = await tx.invoice.update({
    where: { id },
    data: {
      status: InvoiceStatus.WRITTEN_OFF,
      writeOffReason: dto.reason,
      writtenOffAt: new Date(),
    },
    include: {
      customer: { select: { id: true, businessName: true } },
      items: true,
      payments: { orderBy: { createdAt: "desc" } },
    },
  });
  await deps.commissionEngine.syncInvoiceCommissionSafe(id, tx);
  return written;
}

/** The whole write-off: the pre-read refusal, then the locked transaction. `inv` is the caller's unlocked read. */
export async function writeOffInvoice(
  deps: WriteOffDeps,
  inv: { id: string; status: InvoiceStatus; orderId: string | null },
  dto: WriteOffDto,
) {
  const early = writeOffRefusal(inv.status);
  if (early) throw new BadRequestException(early);
  return deps.prisma.tenantTransaction((tx) => writeOffInTx(deps, tx, inv.id, inv.orderId, dto));
}
