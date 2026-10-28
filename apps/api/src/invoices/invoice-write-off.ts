import { BadRequestException, NotFoundException } from "@nestjs/common";
import { InvoiceStatus } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";
import type { WriteOffDto } from "./dto/create-invoice.dto";
import { confirmedBalance } from "./invoice-balance-classify";
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

/**
 * SA-1050 A-2: the bad-debt ledger's invariant broke, or a caller broke its contract. Thrown INSIDE the caller's
 * transaction, so the whole write rolls back and nothing is written.
 */
export class WriteOffLedgerError extends Error {
  constructor(message: string) {
    super(`write-off ledger: ${message}`);
    this.name = "WriteOffLedgerError";
  }
}

/** The one input of an append, by kind. A REINSTATE carries no amount and no preTax, so a caller cannot pass one. */
export type WriteOffEventInput =
  | {
      kind: "WRITE_OFF";
      amount: number;
      preTax: number;
      /** The accounting moment (server now); null only for an undated legacy or imported write-off. */
      at: Date | null;
      byId: string | null;
      reason: string;
    }
  | { kind: "REINSTATE"; at: Date; byId: string | null; reason: string };

/** What the append reads from the tenant context: `PrismaService.getTenantId()` (null for a super admin or a script). */
export interface WriteOffAppendDeps {
  prisma: { getTenantId(): string | null };
}

/** The invoice row the CALLER locked (`lockInvoiceRow`): the append takes its tenant from here, never from the input. */
export interface LockedInvoiceRef {
  id: string;
  tenantId: string | null;
}

const toCents = (n: number) => Math.round(n * 100);

/** Σ amount and Σ preTax over the invoice's events, as cents-rounded numbers (0 when it has none). */
async function openSums(tx: any, invoiceId: string): Promise<{ amount: number; preTax: number }> {
  const agg = await tx.invoiceWriteOffEvent.aggregate({
    where: { invoiceId },
    _sum: { amount: true, preTax: true },
  });
  return {
    amount: roundMoney(Number(agg?._sum?.amount ?? 0)),
    preTax: roundMoney(Number(agg?._sum?.preTax ?? 0)),
  };
}

/**
 * SA-1050 A-2: the ONLY `invoiceWriteOffEvent.create` in apps/api (write-off-ledger.pin.spec). What the database cannot
 * enforce (PR-0's CHECKs admit a -10.66 against a 10.67, a cross-tenant row, a figure the DECIMAL column rounds
 * silently), this one writer enforces by construction. Call it INSIDE the caller's transaction, after `lockInvoiceRow`.
 *
 *  (a) The exact negative. A REINSTATE writes `roundMoney(-Σ)` of the open sums, read here under the caller's lock, and
 *      the input has no amount to pass. After EVERY append the sums are re-read and rule 2's invariant is asserted:
 *      while WRITTEN_OFF, Σ amount = confirmedBalance; after a REINSTATE, Σ amount = Σ preTax = 0.00. A miss throws and
 *      the transaction rolls back.
 *  (b) The tenant comes from the LOCKED row. It throws when that is null, or when a tenant context is set and differs.
 *      Under a scoped transaction the create injection then writes the context tenant, which this has just proven equal.
 *  (c) Cents. amount and preTax pass through `roundMoney` here, after the REINSTATE negation; a non-finite value throws.
 */
export async function appendWriteOffEvent(
  deps: WriteOffAppendDeps,
  tx: any,
  locked: LockedInvoiceRef,
  input: WriteOffEventInput,
) {
  if (!locked.tenantId) throw new WriteOffLedgerError(`invoice ${locked.id} has no tenant`);
  const contextTenant = deps.prisma.getTenantId();
  if (contextTenant && contextTenant !== locked.tenantId)
    throw new WriteOffLedgerError(`invoice ${locked.id} is not in the calling tenant`);
  if (!input.reason || input.reason.trim().length === 0)
    throw new WriteOffLedgerError("a reason is required");

  let amount: number;
  let preTax: number;
  if (input.kind === "REINSTATE") {
    const open = await openSums(tx, locked.id);
    if (open.amount <= 0)
      throw new WriteOffLedgerError(`invoice ${locked.id} has nothing to reinstate`);
    amount = roundMoney(-open.amount);
    preTax = roundMoney(-open.preTax);
  } else {
    amount = input.amount;
    preTax = input.preTax;
  }
  if (!Number.isFinite(amount) || !Number.isFinite(preTax))
    throw new WriteOffLedgerError("amount and preTax must be finite numbers");
  amount = roundMoney(amount);
  preTax = roundMoney(preTax);

  const event = await tx.invoiceWriteOffEvent.create({
    data: {
      tenantId: locked.tenantId,
      invoiceId: locked.id,
      kind: input.kind,
      amount,
      preTax,
      at: input.at,
      byId: input.byId,
      reason: input.reason,
    },
  });

  const after = await openSums(tx, locked.id);
  if (input.kind === "REINSTATE") {
    if (toCents(after.amount) !== 0 || toCents(after.preTax) !== 0)
      throw new WriteOffLedgerError(
        `invoice ${locked.id} still carries ${after.amount} / ${after.preTax} after a reinstate`,
      );
  } else {
    const fresh = await tx.invoice.findUnique({
      where: { id: locked.id },
      select: { status: true, total: true, payments: { select: { amount: true, status: true } } },
    });
    if (!fresh || fresh.status !== InvoiceStatus.WRITTEN_OFF)
      throw new WriteOffLedgerError(
        `invoice ${locked.id} is not WRITTEN_OFF at its write-off event`,
      );
    const due = confirmedBalance(fresh.total, fresh.payments);
    if (toCents(after.amount) !== toCents(due))
      throw new WriteOffLedgerError(
        `invoice ${locked.id}: events sum to ${after.amount}, its confirmed balance is ${due}`,
      );
  }
  return event;
}
