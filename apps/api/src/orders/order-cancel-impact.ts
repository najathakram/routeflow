import { NotFoundException } from "@nestjs/common";
import { OrderStatus } from "@prisma/client";
import { isBlockingPayment, roundMoney } from "@routeflow/pricing";
import type { CreditNotesService } from "../credit-notes/credit-notes.service";
import type { PrismaService } from "../prisma/prisma.service";

/** What `cancelImpact` reads: the tenant-scoped client and the credit-note release preview. */
export interface CancelImpactDeps {
  prisma: PrismaService;
  creditNotes: CreditNotesService;
}

/**
 * What cancelling this order will actually do to its money. Read-only — it backs
 * both the confirmation the operator sees ("INV-12 will be voided, $50.00 goes
 * back to CN-7") and the guard that refuses the cancel, so the warning and the
 * rule can never disagree.
 */
export async function cancelImpact(deps: CancelImpactDeps, id: string) {
  const order = await deps.prisma.forTenant().order.findFirst({
    where: { id },
    select: { id: true, status: true, orderNumber: true },
  });
  if (!order) throw new NotFoundException("Order not found");

  const invoices = await deps.prisma.forTenant().invoice.findMany({
    where: { orderId: id, status: { not: "VOID" } },
    select: {
      id: true,
      invoiceNumber: true,
      status: true,
      total: true,
      payments: { select: { method: true, amount: true, status: true } },
    },
  });

  // B56 (REG-B56): delivered goods block a cancel — the same signal
  // settleStockForEdit already refuses to treat as returnable.
  const activeLines = await deps.prisma.forTenant().orderItem.findMany({
    where: { orderId: id, status: { not: "CANCELLED" } },
    select: { qty: true, deliveredQty: true },
  });
  const deliveredUnits =
    Math.round(activeLines.reduce((s, li) => s + Number(li.deliveredQty ?? 0), 0) * 1000) / 1000;

  // External money can't be un-taken by software; it blocks the cancel until a
  // human refunds it. Wallet money (credit notes, advances) is simply returned.
  // PR-2 (check-payments B1 hardening, N4 owner ruling): isBlockingPayment (NOT
  // isHeldPayment) — a DRAFT external payment is money in flight and must keep
  // blocking the cancel exactly as it does today; HELD (PAID ∪ PENDING) is for
  // money TOTALS only, never an existence/blocking check.
  const blockers: Array<{ invoiceNumber: string; amount: number }> = [];
  for (const inv of invoices) {
    const external = roundMoney(
      (inv.payments ?? [])
        .filter(
          (p: any) => isBlockingPayment(p) && p.method !== "CREDIT_NOTE" && p.method !== "ADVANCE",
        )
        .reduce((s: number, p: any) => s + Number(p.amount), 0),
    );
    if (external > 0.001)
      blockers.push({ invoiceNumber: inv.invoiceNumber ?? "", amount: external });
  }

  const credits = await deps.creditNotes.previewOrderCreditRelease(id);
  // scan-ok: draft-payment-not-void — method-scoped to ADVANCE; a CHECK/PENDING row
  // can never match, so PR-2's PENDING concern doesn't apply here.
  const advances = roundMoney(
    invoices
      .flatMap((i) => i.payments ?? [])
      .filter((p: any) => p.status !== "VOID" && p.method === "ADVANCE")
      .reduce((s: number, p: any) => s + Number(p.amount), 0),
  );

  return {
    orderId: order.id,
    orderNumber: order.orderNumber ?? "",
    alreadyCancelled: order.status === OrderStatus.CANCELLED,
    invoicesToVoid: invoices.map((i) => ({
      id: i.id,
      invoiceNumber: i.invoiceNumber ?? "",
      status: i.status,
      total: roundMoney(Number(i.total)),
    })),
    creditsToRestore: credits,
    advanceToRestore: advances,
    blockingPayments: blockers,
    deliveredUnits,
    canCancel: blockers.length === 0 && deliveredUnits <= 0.001,
  };
}
