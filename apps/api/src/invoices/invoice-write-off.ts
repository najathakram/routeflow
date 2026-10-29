import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { InvoiceStatus } from "@prisma/client";
import { badDebtPreTax, roundMoney } from "@routeflow/pricing";
import { API_ERROR_CODES } from "../common/api-error-codes";
import type { WriteOffDto } from "./dto/create-invoice.dto";
import { confirmedBalance } from "./invoice-balance-classify";
import { auditInvoiceWrittenOff } from "./invoice-audit";
import { lockInvoiceRow, writeOffRefusal } from "./invoice-send-guard";

/** The collaborators the write-off needs, bound by the caller (InvoicesService passes its own). */
export interface WriteOffDeps {
  prisma: {
    tenantTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T>;
    getTenantId(): string | null;
  };
  commissionEngine: { syncInvoiceCommissionSafe(invoiceId: string, db?: any): Promise<unknown> };
}

/** 409 for a write-off of an already WRITTEN_OFF invoice (a lost-reply replay: the web treats it as done and refetches). */
function alreadyWrittenOff(): ConflictException {
  return new ConflictException({
    code: API_ERROR_CODES.INVOICE_ALREADY_WRITTEN_OFF,
    message: "This invoice is already written off.",
  });
}

/** The status refusal, in order: WRITTEN_OFF is the replay (409), any other non-open status is a 400. */
function refuseStatus(status: InvoiceStatus): void {
  if (status === InvoiceStatus.WRITTEN_OFF) throw alreadyWrittenOff();
  const refused = writeOffRefusal(status);
  if (refused) throw new BadRequestException(refused);
}

/**
 * The write-off inside the caller's transaction. #2472 (3): (Order →) Invoice locked FIRST and re-checked there — a
 * void since the caller's pre-read wins. SA-1050 PR-1: the actor is threaded in, and the write-off is the first WRITER
 * of the bad-debt ledger: the event (amount = the confirmed balance, preTax = its pre-tax share, `at` = the moment the
 * invoice is stamped), the `writtenOffById` column and the `invoice.written_off` audit row all land in this one
 * transaction. An invoice that owes nothing is refused (409 WRITE_OFF_NOTHING_DUE: master booked a 0), a replay is
 * 409 INVOICE_ALREADY_WRITTEN_OFF. Sales agents & commissions: materially a no-op for money (payable derives from
 * payments, and WRITTEN_OFF releases nothing beyond cash already collected) but wrapped atomically to refresh the
 * accrual's display status alongside the write-off.
 */
export async function writeOffInTx(
  deps: WriteOffDeps,
  tx: any,
  id: string,
  orderId: string | null,
  dto: WriteOffDto,
  actorId: string | null,
) {
  const reason = dto.reason?.trim() ?? "";
  if (reason.length === 0) throw new BadRequestException("A reason is required");
  const locked = await lockInvoiceRow(tx, id, orderId);
  if (!locked) throw new NotFoundException("Invoice not found");
  refuseStatus(locked.status);
  const due = confirmedBalance(locked.total, locked.payments);
  if (due <= 0)
    throw new ConflictException({
      code: API_ERROR_CODES.WRITE_OFF_NOTHING_DUE,
      message: "This invoice has nothing left to write off.",
    });
  const at = new Date();
  const written = await tx.invoice.update({
    where: { id },
    data: {
      status: InvoiceStatus.WRITTEN_OFF,
      writeOffReason: reason,
      writtenOffAt: at,
      writtenOffById: actorId,
    },
    include: {
      customer: { select: { id: true, businessName: true } },
      items: true,
      payments: { orderBy: { createdAt: "desc" } },
    },
  });
  const preTax = badDebtPreTax(due, locked.total, locked.taxAmount);
  await appendWriteOffEvent(
    deps,
    tx,
    { id, tenantId: locked.tenantId },
    { kind: "WRITE_OFF", amount: due, preTax, at, byId: actorId, reason },
  );
  await auditInvoiceWrittenOff(tx, { invoiceId: id, actor: actorId, amount: due, preTax, reason });
  await deps.commissionEngine.syncInvoiceCommissionSafe(id, tx);
  return written;
}

/** The whole write-off: the pre-read refusal, then the locked transaction. `inv` is the caller's unlocked read. */
export async function writeOffInvoice(
  deps: WriteOffDeps,
  inv: { id: string; status: InvoiceStatus; orderId: string | null },
  dto: WriteOffDto,
  actorId: string | null,
) {
  refuseStatus(inv.status);
  return deps.prisma.tenantTransaction((tx) =>
    writeOffInTx(deps, tx, inv.id, inv.orderId, dto, actorId),
  );
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

/** Why `ensureWriteOffEvent` wrote nothing (it is idempotent and never guesses). */
export type EnsureWriteOffResult =
  | { written: true; eventId: string }
  | { written: false; skipped: "NOT_WRITTEN_OFF" | "HAS_EVENT" | "NOTHING_DUE" };

/**
 * SA-1050 rule 3: for a WRITTEN_OFF invoice with NO event, write the WRITE_OFF from today's live figure:
 * `confirmedBalance` and its `badDebtPreTax`, `at = writtenOffAt` (possibly null: an undated legacy or imported
 * write-off sits in no window, exactly like today), a null `byId`, and `reason = writeOffReason ?? "Imported as written
 * off"`. Callers: the importer after it creates (or flips) a WRITTEN_OFF invoice, PR-2's reinstate, and the backfill
 * (which calls this and never runs its own SQL). It locks (Order →) Invoice itself, in the caller's transaction, so a
 * concurrent payment or void cannot move the balance between the read and the append. An invoice that owes nothing
 * writes no row (an event is `amount > 0` by CHECK): it is reported `NOTHING_DUE`, never a zero event.
 */
export async function ensureWriteOffEvent(
  deps: WriteOffAppendDeps,
  tx: any,
  invoiceId: string,
): Promise<EnsureWriteOffResult> {
  const peek = await tx.invoice.findUnique({ where: { id: invoiceId }, select: { orderId: true } });
  if (!peek) throw new NotFoundException("Invoice not found");
  const inv = await lockInvoiceRow(tx, invoiceId, peek.orderId);
  if (!inv || inv.status !== InvoiceStatus.WRITTEN_OFF)
    return { written: false, skipped: "NOT_WRITTEN_OFF" };
  const existing = await tx.invoiceWriteOffEvent.findFirst({
    where: { invoiceId },
    select: { id: true },
  });
  if (existing) return { written: false, skipped: "HAS_EVENT" };
  const amount = confirmedBalance(inv.total, inv.payments);
  if (amount <= 0) return { written: false, skipped: "NOTHING_DUE" };
  const event = await appendWriteOffEvent(
    deps,
    tx,
    { id: invoiceId, tenantId: inv.tenantId },
    {
      kind: "WRITE_OFF",
      amount,
      preTax: badDebtPreTax(amount, inv.total, inv.taxAmount),
      at: inv.writtenOffAt ?? null,
      byId: null,
      reason: inv.writeOffReason?.trim() || "Imported as written off",
    },
  );
  return { written: true, eventId: event.id };
}
