import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { API_ERROR_CODES } from "../common/api-error-codes";
import { OrderStatus } from "@prisma/client";
import { formatMoney } from "../messaging/messaging.helpers";
import { isBlockingPayment, roundMoney } from "@routeflow/pricing";
import type { CreditNotesService } from "../credit-notes/credit-notes.service";
import type { PrismaService } from "../prisma/prisma.service";
import {
  cancelBlockedByMissingQuantities,
  throwDeliveryQuantitiesMissing,
} from "./order-pd-quantities";

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
/**
 * The external money that blocks a cancel, per invoice — the ONE predicate the pre-check
 * (cancelImpact) and the in-lock re-check (lockOrderForCancel, #2255 / SA-404d) share.
 */
export function cancelBlockers(
  invoices: Array<{
    invoiceNumber: string | null;
    payments?: Array<{ method: unknown; amount: unknown; status?: string }>;
  }>,
): Array<{ invoiceNumber: string; amount: number }> {
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
  return blockers;
}

/** B56 (REG-B56): the refusal for delivered goods (the text assertCancellableOrThrow always used; shared with the in-lock re-check). */
export function deliveredUnitsBlockedMessage(deliveredUnits: number) {
  return (
    `This order has delivered items (${deliveredUnits} unit(s) already delivered). ` +
    `Cancelling would erase revenue for goods the customer already has. Record a return for ` +
    `the delivered goods, or edit the order down to the undelivered items instead.`
  );
}

/** The refusal for external money on the order (the text assertCancellableOrThrow always used). */
export function cancelBlockedMessage(blockers: Array<{ invoiceNumber: string; amount: number }>) {
  const detail = blockers
    .map((b) => `${formatMoney(b.amount)} on ${b.invoiceNumber || "an invoice"}`)
    .join(", ");
  return `This order has payments that must be refunded before it can be cancelled: ${detail}. Reverse or refund them, then cancel.`;
}

/**
 * The lock half of the cancel tx's first statements (SA-762r F1, extracted from `lockOrderForCancel`): lock
 * the Order, then every non-VOID Invoice (SA-214 order, stable id order) in ONE statement that also lists
 * them. Returns the locked invoice ids. No refusal: the counter-sale void reuses it before it voids the
 * counter tender, `lockOrderForCancel` adds the blocking-payment refusal on top.
 */
export async function lockOrderAndInvoicesInTx(tx: any, orderId: string): Promise<string[]> {
  await tx.$executeRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
  // Lock AND list the live invoices in one statement, stable id order.
  const rows: Array<{ id: string }> =
    await tx.$queryRaw`SELECT id FROM "Invoice" WHERE "orderId" = ${orderId} AND status <> 'VOID' ORDER BY id FOR UPDATE`;
  return rows.map((r) => r.id);
}

/**
 * #2255 / SA-404d R1: the cancel tx's FIRST statements — lock the Order, then every non-VOID
 * Invoice (SA-214 order, stable id order), re-read their payments and re-run the same blocking
 * predicate before any write. A payment committed after this tx's snapshot updates its Invoice row
 * (the #2258 writer invariant), so the voids below conflict (40001) and the retry lands here fresh.
 */
export async function lockOrderForCancel(tx: any, orderId: string): Promise<void> {
  const invoiceIds = await lockOrderAndInvoicesInTx(tx, orderId);
  if (invoiceIds.length === 0) return;
  const locked = await tx.invoice.findMany({
    where: { id: { in: invoiceIds } },
    select: {
      invoiceNumber: true,
      payments: { select: { method: true, amount: true, status: true } },
    },
  });
  const blockers = cancelBlockers(locked);
  if (blockers.length > 0) throw new BadRequestException(cancelBlockedMessage(blockers));
}

/**
 * The status read under the Order lock. B1053: a merge that committed first folded this order away — a
 * coded 409, never a TypeError (500) on the missing row.
 */
export async function lockedOrderStatus(tx: any, id: string): Promise<OrderStatus> {
  // #2472 (2): decided from the status UNDER the lock, never the unlocked pre-read.
  const row = await tx.order.findUnique({ where: { id }, select: { status: true } });
  if (!row) {
    throw new ConflictException({
      code: API_ERROR_CODES.ORDER_CHANGED_DURING_EDIT,
      message: "This order was merged into another order — review and try again.",
    });
  }
  return row.status;
}

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
  // B692 (SA-814 R4-3): a DELIVERED / PARTIALLY_DELIVERED order with no recorded quantity is not "undelivered".
  const quantitiesMissing = await cancelBlockedByMissingQuantities(deps.prisma.forTenant(), order);
  const deliveredUnits =
    Math.round(activeLines.reduce((s, li) => s + Number(li.deliveredQty ?? 0), 0) * 1000) / 1000;

  // External money can't be un-taken by software; it blocks the cancel until a
  // human refunds it. Wallet money (credit notes, advances) is simply returned.
  // PR-2 (check-payments B1 hardening, N4 owner ruling): isBlockingPayment (NOT
  // isHeldPayment) — a DRAFT external payment is money in flight and must keep
  // blocking the cancel exactly as it does today; HELD (PAID ∪ PENDING) is for
  // money TOTALS only, never an existence/blocking check.
  const blockers = cancelBlockers(invoices);

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
    /** B692: delivered but no delivery quantity recorded (legacy rows): the cancel is refused, never read as undelivered. */
    deliveryQuantitiesMissing: quantitiesMissing,
    canCancel: blockers.length === 0 && deliveredUnits <= 0.001 && !quantitiesMissing,
  };
}

/** The cancel refusal for a delivered order whose quantities were never recorded (409, after the payments check). */
export function assertQuantitiesKnown(impact: { deliveryQuantitiesMissing: boolean }): void {
  if (impact.deliveryQuantitiesMissing) throwDeliveryQuantitiesMissing();
}
