import { BadRequestException, NotFoundException } from "@nestjs/common";
import { InvoiceStatus } from "@prisma/client";
import { roundMoney } from "@routeflow/pricing";
import type { AfterCommit } from "../common/after-commit";
import { recomputeInvoiceStatus } from "./invoice-status";
import { CONFIRMED_PAYMENT, sumConfirmed } from "./payment-predicates";

/** The collaborators the single-payment void needs, bound by the caller (InvoicesService passes its own). */
export interface PaymentVoidTxDeps {
  reverseRunAdvancesInTx: (
    tx: any,
    args: { runId: string | null | undefined; stopId: string; reason: string },
  ) => Promise<number>;
  /** The realtime gateway: its emits are queued on the caller's AfterCommit, never fired inside the tx. */
  gateway: { emitInvoiceUpdated(tenantId: string | null | undefined, payload: unknown): unknown };
  commissionEngine: { syncInvoiceCommissionSafe(invoiceId: string, db?: any): Promise<unknown> };
  tenantId: string | null | undefined;
}

/**
 * Void ONE payment inside the caller's transaction (SA-762r: the tx variant of InvoicesService.voidPayment, moved
 * VERBATIM so there is one writer): the invoice row lock, the VOID status write, the advance-wallet inverse, the
 * run-advance reversal, the invoice status recompute and the queued gateway emit. `tz` is the tenant's zone, read
 * once by the caller before opening the transaction. voidPayment wraps it in its own tx; the counter-sale void
 * calls it for every counter tender row inside the void's Serializable tx.
 */
export async function voidPaymentInTx(
  deps: PaymentVoidTxDeps,
  tx: any,
  after: AfterCommit,
  invoiceId: string,
  paymentId: string,
  tz: string | null,
) {
  // PR-2 review (routeflow-Lead, 2026-09-16): same Invoice FOR UPDATE lock as
  // updatePayment/recordPayment/deletePayment, taken BEFORE touching the
  // payment row, and in the same order — voidPayment previously took no lock
  // at all, so a concurrent updatePayment/recordPayment/deletePayment on the
  // same invoice could deadlock against it or race on a stale balance read.
  await tx.$executeRaw`SELECT id FROM "Invoice" WHERE id = ${invoiceId} FOR UPDATE`;
  const payment = await tx.invoicePayment.findFirst({
    where: { id: paymentId, invoiceId },
  });
  if (!payment) throw new NotFoundException("Payment not found");
  if (payment.status === "VOID") throw new BadRequestException("Payment already voided");
  if ((payment.method as any) === "CREDIT_NOTE") {
    throw new BadRequestException(
      "This payment is an applied credit note. Un-apply it from the credit note instead (POST /credit-notes/:id/unapply) so the credit's balance is restored.",
    );
  }

  // ADVANCE applications debited AdvancePayment.balance when applied
  // (customers.service.applyAdvancePaymentToInvoice). Voiding the
  // application returns those dollars to the customer's advance wallet —
  // advances have no status machinery, so a balance increment is the complete
  // inverse. Without this the wallet is silently understated (the bug credit
  // notes had before their unapply primitive).
  if ((payment.method as any) === "ADVANCE" && (payment as any).advancePaymentId) {
    await tx.advancePayment.update({
      where: { id: (payment as any).advancePaymentId },
      data: { balance: { increment: roundMoney(Number(payment.amount)) } },
    });
  }

  await tx.invoicePayment.update({
    where: { id: paymentId },
    data: { status: "VOID" as any },
  });

  // Recompute invoice status treating this payment as $0. F03/R1: CONFIRMED
  // (PAID) rows only — an unconfirmed DRAFT payment left on the invoice must
  // not be counted as paid.
  const invoice = await tx.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      payments: { where: CONFIRMED_PAYMENT },
      order: { select: { routeRunId: true, routeRunStopId: true } },
    },
  });
  if (!invoice) throw new NotFoundException("Invoice not found");

  // B306: a driver's at-door over-collection on this stop is booked as an
  // AdvancePayment tagged RUN:<runId>:STOP:<stopId> (recordDeliveryPaymentInTx).
  // Once every confirmed door payment for the stop is voided, that advance
  // no longer reflects real collected money — reverse it too, or the run's
  // cash reconciliation keeps summing it forever.
  const runStopId = (invoice as any).order?.routeRunStopId;
  const runIdForAdvance = (invoice as any).order?.routeRunId;
  if (runStopId) {
    const remainingConfirmed = await tx.invoicePayment.count({
      where: { ...CONFIRMED_PAYMENT, invoice: { order: { routeRunStopId: runStopId } } },
    });
    if (remainingConfirmed === 0) {
      await deps.reverseRunAdvancesInTx(tx, {
        runId: runIdForAdvance,
        stopId: runStopId,
        reason: "door payments voided",
      });
    }
  }

  const totalPaid = sumConfirmed(invoice.payments.filter((p) => p.id !== paymentId));
  const newStatus = recomputeInvoiceStatus(
    totalPaid,
    Number(invoice.total),
    invoice.dueDate,
    invoice.status,
    tz,
  );
  await tx.invoice.update({
    where: { id: invoiceId },
    data: {
      status: newStatus,
      paidAt: newStatus === InvoiceStatus.PAID ? invoice.paidAt : null,
    },
  });

  after.defer(deps.gateway).emitInvoiceUpdated(deps.tenantId, {
    invoiceId,
    invoiceNumber: invoice.invoiceNumber,
    customerId: invoice.customerId,
    status: newStatus,
    total: Number(invoice.total),
  });
  await deps.commissionEngine.syncInvoiceCommissionSafe(invoiceId, tx);
  return { success: true };
}
