import { ForbiddenException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { OrderStatus } from "@prisma/client";
import type { CounterSaleHandBack, CounterSaleVoidResponse } from "@routeflow/types";
import { AfterCommit } from "../../common/after-commit";
import { LockTimeoutError, LockUnavailableError, withAdvisoryLock } from "../../common/db-locks";
import { retryOnTxConflict, txConflictState } from "../../common/tx-retry";
import { tenantTimeZone } from "../../common/tenant-time-zone";
import type { JwtPayload } from "../../auth/jwt-payload.interface";
import {
  COUNTER_VOID_WINDOW,
  staffMay,
  voidWindowAllows,
} from "../../auth/permissions/staff-capabilities";
import { AUDIT_ACTIONS } from "../../audit/audit-actions.constant";
import { RouteFlowGateway } from "../../gateways/routeflow.gateway";
import { assertNoCashRefundOnOrder } from "../../invoices/invoice-cash-refund-guard";
import { InvoicesService } from "../../invoices/invoices.service";
import { PrismaService } from "../../prisma/prisma.service";
import { clearUnevidencedDelivered } from "../delivered-stamp";
import { lockOrderAndInvoicesInTx } from "../order-cancel-impact";
import { OrdersService } from "../orders.service";
import { saleVoidedConflict, storedSaleState } from "../sale-replay-guard";
import type { CounterSaleVoidDto } from "./counter-sale-void.dto";
import {
  counterVoidBusy,
  counterVoidForeignPayment,
  counterVoidHasReturn,
  counterVoidNotToday,
} from "./counter-sale-void-errors";
import { handBackOf } from "./counter-sale-void-handback";
import { tenantDayWindow } from "./counter-sale-void-window";
import { isCounterTenderRow, isForeignPaymentRow } from "./counter-tender-row";

/** How long a void waits for the sale's counter-tender lock before answering 503 (SA-762r F2, G6). */
const VOID_LOCK_WAIT_MS = 10_000;

/**
 * POST /orders/counter-sale/:orderId/void (SA-762r Ruling B): void today's counter sale in ONE Serializable
 * transaction: its counter tender payments, its invoices and the order (stock goes back), with one audit row.
 * Nothing new is implemented here: the payment void is `InvoicesService.voidPaymentInTx` (the one payment-void
 * writer) and the order unwind is `OrdersService.cancelOrderInTx` (the same body the office cancel runs).
 *
 * Locks: `counter-tender` advisory lock keyed on the order (the SAME lock the tender takes, so a void and a
 * same-key tender replay serialize) wraps `retryOnTxConflict(tenantTransaction(Serializable))`; inside the tx the row
 * order is Order -> Invoice -> Product. A lock timeout or an unavailable lock connection is a 503
 * COUNTER_SALE_VOID_BUSY with nothing written. No in-process lock, no order-merge/customer lock, and no tx is
 * threaded into updateOrderItems. Gateway emits are queued and flushed after the commit.
 *
 * Idempotent: a sale that is CANCELLED with a COUNTER_SALE_VOIDED audit row answers 200 {replayed:true} with that
 * row's handBack; a sale dead any other way (cancelled in the office, every invoice VOID) is 409 COUNTER_SALE_VOIDED.
 */
@Injectable()
export class CounterSaleVoidService {
  private readonly logger = new Logger(CounterSaleVoidService.name);

  constructor(
    private readonly orders: OrdersService,
    private readonly invoices: InvoicesService,
    private readonly prisma: PrismaService,
    private readonly gateway: RouteFlowGateway,
  ) {}

  async voidSale(
    orderId: string,
    dto: CounterSaleVoidDto,
    user: JwtPayload,
  ): Promise<CounterSaleVoidResponse> {
    // forTenant() and the tx scoping are UNSCOPED without a tenant: refuse, like ring() and by-key.
    if (!this.prisma.getTenantId()) {
      throw new ForbiddenException("Voiding a counter sale requires a tenant-scoped session");
    }
    if (!staffMay(user.role, "VOID_SALE")) {
      throw new ForbiddenException("You are not allowed to void a sale");
    }
    // A tenant-scoped read BEFORE any lock: another tenant's id (or an ordinary order) is a plain 404 and never
    // takes a lock. The same checks run again under the lock below.
    const known = await this.prisma
      .forTenant()
      .order.findFirst({ where: { id: orderId, counterSale: true }, select: { id: true } });
    if (!known) throw saleNotFound();

    try {
      const locked = await withAdvisoryLock(
        { family: "counter-tender", key: orderId, mode: "wait", waitMs: VOID_LOCK_WAIT_MS },
        () => this.voidLocked(orderId, dto.reason, user),
      );
      if (!locked.acquired)
        throw new LockTimeoutError("counter-tender", orderId, VOID_LOCK_WAIT_MS);
      return locked.value;
    } catch (e) {
      // Nothing was written in any of these: the clerk retries the same call. Errors from inside the locked
      // section (the coded refusals) are not lock errors and propagate untouched.
      if (
        e instanceof LockTimeoutError ||
        e instanceof LockUnavailableError ||
        txConflictState(e)
      ) {
        this.logger.warn(`counter sale void ${orderId}: not completed (${(e as Error).message})`);
        throw counterVoidBusy();
      }
      throw e;
    }
  }

  private async voidLocked(
    orderId: string,
    reason: string,
    user: JwtPayload,
  ): Promise<CounterSaleVoidResponse> {
    const after = new AfterCommit();
    const result = await retryOnTxConflict(`counter sale void order=${orderId}`, () =>
      this.prisma.tenantTransaction(
        (tx) => {
          after.reset(); // a retried attempt never re-sends the emits of one that rolled back
          return this.voidInTx(tx, after, orderId, reason, user);
        },
        { isolationLevel: "Serializable", timeout: 15_000 },
      ),
    );
    after.flush();
    return result;
  }

  private async voidInTx(
    tx: any,
    after: AfterCommit,
    orderId: string,
    reason: string,
    user: JwtPayload,
  ): Promise<CounterSaleVoidResponse> {
    // 1. Lock the Order, then its live Invoices (id order).
    const invoiceIds = await lockOrderAndInvoicesInTx(tx, orderId);

    // 2. Under the lock: a counter sale of this tenant (tx is tenant-scoped), else 404.
    const order = await tx.order.findFirst({
      where: { id: orderId },
      select: {
        id: true,
        orderNumber: true,
        customerId: true,
        status: true,
        counterSale: true,
        createdAt: true,
      },
    });
    if (!order || order.counterSale !== true) throw saleNotFound();

    // 3. Dead already: voided here (replay the stored answer) or any other way (definitive 409).
    const allInvoices: Array<{ status: string }> = await tx.invoice.findMany({
      where: { orderId },
      select: { status: true },
    });
    if (
      storedSaleState(
        order.status,
        allInvoices.map((i) => i.status),
      ) === "voided"
    ) {
      const prior = await tx.auditLog.findFirst({
        where: {
          action: AUDIT_ACTIONS.COUNTER_SALE_VOIDED,
          entityType: "Order",
          entityId: orderId,
        },
        orderBy: { createdAt: "desc" },
        select: { meta: true },
      });
      if (order.status === OrderStatus.CANCELLED && prior) {
        const handBack = (prior.meta as { handBack?: CounterSaleHandBack } | null)?.handBack;
        return { voided: true, replayed: true, handBack: handBack ?? {} };
      }
      throw saleVoidedConflict();
    }

    // 4. W21b guard: money already handed back in cash cannot be reversed again (409 ORDER_HAS_CASH_REFUND). It reads
    // every live invoice's lines and the order's standard returns, so it covers the invoice-level refusal too.
    await assertNoCashRefundOnOrder(tx, orderId);

    // 5. Any return on the sale (as the carrying order, or as the order its goods were sold on).
    const hasReturn = await tx.return.findFirst({
      where: { OR: [{ orderId }, { items: { some: { sourceOrderId: orderId } } }] },
      select: { id: true },
    });
    if (hasReturn) throw counterVoidHasReturn();

    // 6. Money the counter did not take (credit note, advance, office payment, deposited check) is for the office.
    const payments: Array<{
      id: string;
      invoiceId: string;
      method: string;
      status: string;
      amount: unknown;
      paymentGroupId: string | null;
      checkStatus: string | null;
    }> =
      invoiceIds.length === 0
        ? []
        : // EVERY live row on purpose (PAID, PENDING, DRAFT): a DRAFT or other non-tender row is FOREIGN and
          // refuses the void (isForeignPaymentRow), it is never skipped.
          // scan-ok: draft-payment-not-void — all non-VOID rows are read deliberately, see above.
          await tx.invoicePayment.findMany({
            where: { invoiceId: { in: invoiceIds }, status: { not: "VOID" } },
            select: {
              id: true,
              invoiceId: true,
              method: true,
              status: true,
              amount: true,
              paymentGroupId: true,
              checkStatus: true,
            },
            orderBy: [{ invoiceId: "asc" }, { createdAt: "asc" }, { id: "asc" }],
          });
    if (payments.some((p) => isForeignPaymentRow(orderId, p))) throw counterVoidForeignPayment();

    // 7. The window: the sale's createdAt on today's day in the tenant zone, read again here in the tx.
    const tz = await tenantTimeZone({
      getTenantId: () => this.prisma.getTenantId(),
      tenantConfig: tx.tenantConfig,
    });
    const allowed = voidWindowAllows(COUNTER_VOID_WINDOW, {
      saleCreatedAt: order.createdAt,
      nowTenantDay: tenantDayWindow(new Date(), tz),
      windowClosed: false, // the SA-750 day close feeds this when it lands
    });
    if (!allowed) throw counterVoidNotToday();

    // 8. Void the counter tender rows with the one payment-void writer (split legs each voided).
    const tender = payments.filter((p) => isCounterTenderRow(orderId, p));
    for (const p of tender) await this.invoices.voidPaymentInTx(tx, after, p.invoiceId, p.id, tz);
    const handBack = handBackOf(tender);

    // 9. The void undoes the hand-over: a line that reads delivered with no DeliveryMutation row behind it goes back to
    // undelivered, so the cancel below restocks it in full (see delivered-stamp.ts). Order lock held (step 1).
    await clearUnevidencedDelivered(tx, orderId);

    // 10. The office cancel's unwind (stock back, credits and wallet released, every live invoice VOID, lines
    // CANCELLED) from DELIVERED; its inner lock no longer sees a non-VOID tender (step 8 ran first).
    await this.orders.cancelOrderInTx(tx, order, {
      fromStatuses: [OrderStatus.DELIVERED],
      statusUpdateData: { status: OrderStatus.CANCELLED },
      carrier: null,
      user,
      notes: "CANCEL",
    });

    // 11. The audit row, in the same tx: step 3's replay reads it back.
    await tx.auditLog.create({
      data: {
        tenantId: this.prisma.getTenantId(),
        userId: user.sub,
        impersonatedBy: user.impersonatedBy ?? null,
        action: AUDIT_ACTIONS.COUNTER_SALE_VOIDED,
        entityType: "Order",
        entityId: orderId,
        meta: { orderId, reason, handBack, actor: user.sub },
      },
    });
    after.defer(this.gateway).emitOrderStatusChanged(this.prisma.getTenantId(), {
      orderId,
      orderNumber: order.orderNumber ?? "",
      customerId: order.customerId,
      status: OrderStatus.CANCELLED,
      previousStatus: order.status,
    });
    return { voided: true, handBack };
  }
}

const saleNotFound = () => new NotFoundException("Sale not found");
