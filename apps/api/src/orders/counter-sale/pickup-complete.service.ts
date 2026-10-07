import {
  BadRequestException,
  ServiceUnavailableException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { createHash } from "crypto";
import { roundMoney, remainingCapacity } from "@routeflow/pricing";
import type { PickupCompleteResponse } from "@routeflow/types";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import { LockTimeoutError, LockUnavailableError, withAdvisoryLock } from "../../common/db-locks";
import { PrismaService } from "../../prisma/prisma.service";
import { InvoicesService } from "../../invoices/invoices.service";
import type { JwtPayload } from "../../auth/jwt-payload.interface";
import { OrdersService } from "../orders.service";
import { settleOrderInvoice } from "../order-status-invoicing";
import {
  autoApplyCandidateWhere,
  creditAutoApplyOnSend,
  hasOpenCreditBalance,
} from "../../credit-notes/auto-apply-candidates";
import {
  allocateOldestFirst,
  assertPaymentShape,
  planCounterPayment,
  toPrismaMethod,
  type CounterPaymentInput,
} from "./counter-sale-payment";
import { isHandOverTender, tenderFigures, type InvoiceRow } from "./pickup-tender";
import type { PickupCompleteDto } from "./pickup-complete.dto";

type OrderRow = {
  id: string;
  orderNumber: string | null;
  status: string;
  fulfillPath: string;
  deliveredAt: Date | null;
  customerId: string | null;
  customer: { isWalkIn: boolean | null } | null;
};

/**
 * POST /orders/:id/pickup-complete: staff hand a PICKUP order over at the till. Order ahead, pick up: the
 * buyer's order was created PENDING (stock taken once, at create), staff confirmed it and marked it "Ready
 * for pickup" (OUT_FOR_DELIVERY); this call is "Picked up".
 *
 * Sequenced like the counter sale, no new transaction (each service owns its own):
 *  1. the order is read under the tenant scope (another tenant's id is simply not found) and judged from
 *     the row alone: not PICKUP -> 400 PICKUP_ONLY; DRAFT / PENDING / PARTIALLY_DELIVERED / CANCELLED ->
 *     409 PICKUP_NOT_READY; the payment shape is judged from the request alone. All of it BEFORE a write;
 *  2. `OrdersService.changeStatus(DELIVERED)` is the EXISTING transition: it moves NO stock (pinned in
 *     orders.pickup-complete-status.spec.ts) and takes exactly one invoice path, so no second invoice;
 *  3. every DRAFT invoice is sent (no INVOICE_SENT message for the walk-in);
 *  4. the tender runs under the shared `counter-tender` advisory lock keyed on the order, through the SAME
 *     payment helpers the counter sale uses (planner, oldest-first allocation, shortfall resume, cents).
 *
 * REPLAY = TRANSITION OWNER. The invoice pre-exists (deposits, portal payments), so "a tender is stored"
 * cannot mean "this request already paid". Only a tender payment created at or after the order's
 * `deliveredAt` (the moment THIS hand-over moved it to DELIVERED) is this request's; a deposit before it is
 * never counted. A call that finds the order already DELIVERED therefore records only the SHORTFALL between
 * this hand-over's planned tender and what is stored for it, never a second full tender, and answers the
 * stored outcome with `alreadyPickedUp`. The balance the plan is judged against is the invoice total less
 * everything that is NOT this hand-over's tender, so a replay computes the SAME plan the first call did.
 * The Idempotency-Key is required of the caller (a keyless client could not retry safely) and normalised at
 * the edge; replay safety comes from the order's own state and the stored payments, not from the key.
 * A payment that cannot be recorded (a lock not taken included) leaves the order DELIVERED with an open
 * invoice and answers 200 `paymentRecorded: false`; the retry finishes it.
 */
@Injectable()
export class PickupCompleteService {
  private readonly logger = new Logger(PickupCompleteService.name);

  constructor(
    private readonly orders: OrdersService,
    private readonly invoices: InvoicesService,
    private readonly prisma: PrismaService,
  ) {}

  async complete(
    id: string,
    dto: PickupCompleteDto,
    user: JwtPayload,
    _idempotencyKey: string,
  ): Promise<PickupCompleteResponse> {
    // 1. The order, tenant-scoped, and everything judged from the row and the request alone.
    let order = await this.readOrder(id);
    if (!order) throw new NotFoundException("Order not found");
    if (order.fulfillPath !== "PICKUP") {
      throw new BadRequestException({
        code: API_ERROR_CODES.PICKUP_ONLY,
        message: "Only a pickup order can be handed over this way",
      });
    }
    let alreadyPickedUp = order.status === "DELIVERED";
    if (!alreadyPickedUp && order.status !== "CONFIRMED" && order.status !== "OUT_FOR_DELIVERY") {
      throw new ConflictException({
        code: API_ERROR_CODES.PICKUP_NOT_READY,
        message: "This order is not ready for pickup yet, or it was cancelled",
      });
    }
    const walkIn = !!order.customer?.isWalkIn;
    // The request's real payment: never overwritten. Absent + nothing owed (same invoice set and capacity
    // rule as the tender below) = EXCUSED: no shape check, no row. Absent + owing = on account (a walk-in
    // has none: 400 before any write). Re-judged on the invoices FINAL after the hand-over (step 3).
    const sent = dto.payment;
    const preRows = await this.readInvoices(id);
    const preOwed = this.owedBalance(
      preRows,
      alreadyPickedUp ? isHandOverTender(order.deliveredAt) : undefined,
    );
    const excused = !sent && preRows.length > 0 && preOwed <= 0;
    if (sent) assertPaymentShape(sent, walkIn);
    else if (!excused) assertPaymentShape({ method: "ON_ACCOUNT" }, walkIn);
    if (walkIn) {
      // A walk-in leaves no partial on account and takes no credit: the counter sale's two guards.
      if (
        sent &&
        sent.method !== "ON_ACCOUNT" &&
        sent.amount != null &&
        preRows.length > 0 &&
        roundMoney(sent.amount) < preOwed
      ) {
        throw new BadRequestException({
          code: API_ERROR_CODES.COUNTER_TENDER_SHORT,
          message: "A walk-in customer must pay the full balance",
        });
      }
      await this.assertNoOpenCredit(order.customerId);
    }
    try {
      await this.claimHandOver(id, _idempotencyKey, sent, user);
    } catch (e) {
      // A lock timeout or outage before any write is a coded, retryable 503 (never a 500).
      if (e instanceof LockTimeoutError || e instanceof LockUnavailableError) {
        throw this.claimUnavailable();
      }
      throw e;
    }

    // 2. The hand-over: the existing status change (invoice + no stock). Its own refusals propagate,
    // except the race loser's: a concurrent call that delivered it first makes this one the replay.
    if (!alreadyPickedUp) {
      try {
        await this.orders.changeStatus(id, { status: "DELIVERED" } as never, user);
      } catch (e) {
        const now = await this.readOrder(id);
        if (now?.status !== "DELIVERED") throw e;
        alreadyPickedUp = true;
      }
      order = (await this.readOrder(id)) ?? order;
    }
    const handedOverAt = order.deliveredAt ?? null;

    // 3. Issue every draft invoice.
    let invoices = await this.readInvoices(id);
    if (invoices.length === 0) {
      // Delivered with no invoice (the settle failed at the hand-over): create it through the SAME settle
      // changeStatus(DELIVERED) uses, so a retry never strands the order.
      const failure = await settleOrderInvoice(this.orders, id, this.logger, "delivered");
      if (failure) this.logger.warn(`pickup complete ${id}: invoice repair failed`);
      invoices = await this.readInvoices(id);
      if (invoices.length === 0) {
        throw new ConflictException({
          code: API_ERROR_CODES.PICKUP_INVOICE_MISSING,
          message:
            "The order is picked up but has no invoice yet. Retry, or use Generate Invoice on the order page.",
        });
      }
    }
    const sendOpts = walkIn ? [{ suppressNotify: true }] : [];
    let issued = false;
    for (const inv of invoices) {
      if (inv.status !== "DRAFT") continue;
      try {
        await this.invoices.send(inv.id, ...sendOpts);
        issued = true;
      } catch (e) {
        // A concurrent call may have issued it first: only a still-DRAFT invoice is a real failure.
        const fresh = (await this.readInvoices(id)).find((i) => i.id === inv.id);
        if (!fresh || fresh.status === "DRAFT") throw e;
        issued = true;
      }
    }
    if (issued) invoices = await this.readInvoices(id);

    // 4. The tender, against what is STORED now. ON_ACCOUNT takes no money: no lock. Owed is re-judged on
    // the final invoices (a remainder / rebuild at DELIVERED can differ from before the hand-over).
    const owedNow =
      this.owedBalance(invoices, alreadyPickedUp ? isHandOverTender(handedOverAt) : undefined) > 0;
    let planError: string | undefined;
    let shown: { method: string; amount?: number } = sent ?? { method: "ON_ACCOUNT" };
    if (!sent && excused) {
      // Excused before the hand-over; never report a forced ON_ACCOUNT as settled when money is owed now.
      shown = { method: "NONE" };
      if (owedNow) planError = API_ERROR_CODES.PICKUP_PAYMENT_REQUIRED;
    } else if (sent && sent.method !== "ON_ACCOUNT" && owedNow) {
      try {
        const locked = await withAdvisoryLock(
          { family: "counter-tender", key: id, mode: "wait" },
          () => this.tender(id, sent, handedOverAt, walkIn),
        );
        if (!locked.acquired) throw new LockTimeoutError("counter-tender", id, 0);
        ({ invoices, planError } = locked.value);
      } catch (e) {
        // The hand-over is already committed: a contended or unavailable lock must not turn into a 500
        // over a finished hand-over. It reads as an unrecorded payment (the retry finishes it). Errors
        // from inside the locked section are not lock errors and still propagate.
        if (!(e instanceof LockTimeoutError || e instanceof LockUnavailableError)) throw e;
        this.logger.warn(`pickup complete ${id}: tender lock not taken (${e.message})`);
        planError = API_ERROR_CODES.COUNTER_PAYMENT_NOT_RECORDED;
        invoices = await this.readInvoices(id);
      }
    }

    return this.respond(order, invoices, shown, handedOverAt, planError, alreadyPickedUp);
  }

  /**
   * The hand-over key, persisted as an AuditLog row (action is free text: no schema change). Its OWN short
   * section under the per-order `counter-tender` lock (released before the tender takes it again): read the
   * claim; none -> write it BEFORE changeStatus (a crash after the commit keeps it); same key + same body
   * (an earlier no-payment claim may be completed by a retry that sends one) -> proceed as the replay; any
   * other key, or the same key with a different payment -> 409 PICKUP_KEY_CONFLICT before any write.
   */
  private async claimHandOver(
    orderId: string,
    key: string,
    payment: CounterPaymentInput | undefined,
    user: JwtPayload,
  ): Promise<void> {
    const bodyHash = payment
      ? createHash("sha256")
          .update(
            JSON.stringify([payment.method, payment.amount ?? null, payment.reference ?? null]),
          )
          .digest("hex")
      : null;
    const db = this.prisma.forTenant();
    const locked = await withAdvisoryLock(
      { family: "counter-tender", key: orderId, mode: "wait" },
      async () => {
        const row = await db.auditLog.findFirst({
          where: {
            tenantId: user.tenantId,
            entityType: "Order",
            entityId: orderId,
            action: "PICKUP_COMPLETE_CLAIM",
          },
          orderBy: { createdAt: "asc" },
        });
        if (!row) {
          await db.auditLog.create({
            data: {
              tenantId: user.tenantId,
              userId: user.sub,
              action: "PICKUP_COMPLETE_CLAIM",
              entityType: "Order",
              entityId: orderId,
              meta: { idempotencyKey: key, bodyHash },
            },
          });
          return;
        }
        const meta = (row.meta ?? {}) as { idempotencyKey?: string; bodyHash?: string | null };
        if (meta.idempotencyKey !== key || (meta.bodyHash && meta.bodyHash !== bodyHash)) {
          // Unified claim rule (SA-710a + lead): a different key or body REPLACES the claim while no tender for
          // this hand-over is stored (a refused hand-over, or a walk-in short / planner refusal found after
          // it, must never lock the order out); recordings stay capped by remainingCapacity. Only a STORED
          // hand-over tender makes a different request a conflict.
          const now = await db.order.findFirst({
            where: { id: orderId },
            select: { status: true, deliveredAt: true },
          });
          const tendered =
            now?.status === "DELIVERED" &&
            (await this.readInvoices(orderId)).some((i) =>
              (i.payments ?? []).some(isHandOverTender(now.deliveredAt ?? null)),
            );
          if (tendered) {
            throw new ConflictException({
              code: API_ERROR_CODES.PICKUP_KEY_CONFLICT,
              message: "Already picked up. Record any payment on the invoice.",
            });
          }
          await db.auditLog.update({
            where: { id: row.id },
            data: { meta: { idempotencyKey: key, bodyHash } },
          });
          return;
        }
        // A same-key retry that ADDS the payment the first call lacked (PICKUP_PAYMENT_REQUIRED) is adopted
        // on the claim, so a later, different payment under this key is a conflict, not a second tender.
        if (!meta.bodyHash && bodyHash) {
          await db.auditLog.update({
            where: { id: row.id },
            data: { meta: { ...meta, bodyHash } },
          });
        }
      },
    );
    if (!locked.acquired) throw this.claimUnavailable();
  }

  /** The claim section could not take its per-order lock: a coded, retryable 503 (nothing was written). */
  private claimUnavailable(): ServiceUnavailableException {
    return new ServiceUnavailableException({
      code: API_ERROR_CODES.LOCK_UNAVAILABLE,
      message: "The hand-over is busy. Try again in a moment.",
    });
  }

  /** The counter sale's guard: a walk-in must not receive an open credit that send() would auto-apply. */
  private async assertNoOpenCredit(customerId: string | null): Promise<void> {
    if (!customerId) return;
    if (!(await creditAutoApplyOnSend(this.prisma.forTenant(), this.prisma.getTenantId()))) return;
    const notes = await this.prisma.forTenant().creditNote.findMany({
      where: autoApplyCandidateWhere({ customerId, now: new Date() }),
      select: { amount: true, amountUsed: true },
    });
    if (notes.some((n: any) => hasOpenCreditBalance(n))) {
      throw new ConflictException({
        code: API_ERROR_CODES.WALK_IN_OPEN_CREDIT,
        message:
          "The walk-in customer holds open credit, which would be applied to this sale. Resolve it first.",
      });
    }
  }

  /**
   * The locked half of the tender. The plan is made against each invoice's balance BEFORE this hand-over's
   * tender (its total less every payment that is not this hand-over's), so a replay computes the SAME
   * allocation the first call did; what is already stored for this hand-over per invoice is then subtracted
   * and only the SHORTFALL is recorded (a first call that paid sibling 1 and failed on sibling 2 is resumed,
   * never repeated). Each recording is also capped at the invoice's live remaining capacity: never over-collects.
   */
  private async tender(
    orderId: string,
    payment: CounterPaymentInput,
    handedOverAt: Date | null,
    walkIn: boolean,
  ): Promise<{ invoices: InvoiceRow[]; planError?: string }> {
    let invoices = await this.readInvoices(orderId);
    let planError: string | undefined;
    const mine = isHandOverTender(handedOverAt);
    const balances = invoices.map((i) => ({
      id: i.id,
      balance: remainingCapacity(
        Number(i.total),
        (i.payments ?? []).filter((p) => !mine(p)),
      ),
    }));
    const plan = planCounterPayment({
      method: payment.method,
      amount: payment.amount,
      balance: roundMoney(balances.reduce((sum, b) => sum + b.balance, 0)),
    });
    if (
      plan.kind === "pay" &&
      walkIn &&
      plan.amount < roundMoney(balances.reduce((t, b) => t + b.balance, 0))
    ) {
      // A walk-in cannot leave a partial on account (the final balance can differ from the pre-check's).
      if (!invoices.some((i) => (i.payments ?? []).some(mine))) {
        planError = API_ERROR_CODES.COUNTER_TENDER_SHORT;
      }
    } else if (plan.kind === "refuse") {
      // A refusal only stands when this hand-over took nothing yet: a stored tender means a payment went in.
      if (!invoices.some((i) => (i.payments ?? []).some(mine))) planError = plan.code;
    } else if (plan.kind === "pay") {
      try {
        for (const part of allocateOldestFirst(balances, plan.amount)) {
          const row = invoices.find((i) => i.id === part.invoiceId)!;
          const stored = roundMoney(
            (row.payments ?? []).filter(mine).reduce((sum, p) => sum + Number(p.amount), 0),
          );
          const due = roundMoney(
            Math.min(part.amount - stored, remainingCapacity(Number(row.total), row.payments)),
          );
          if (due <= 0) continue;
          await this.invoices.recordPayment(part.invoiceId, {
            amount: due,
            method: toPrismaMethod(payment.method)!,
            reference: payment.reference,
          } as never);
        }
      } catch (e) {
        this.logger.warn(
          `pickup complete ${orderId}: payment not recorded (${(e as Error)?.message ?? e})`,
        );
        planError = API_ERROR_CODES.COUNTER_PAYMENT_NOT_RECORDED;
      }
      invoices = await this.readInvoices(orderId);
    }
    return { invoices, planError };
  }

  /**
   * What the non-void invoices still leave to collect (cents). Before the hand-over every stored payment is
   * pre-existing; on a replay `mine` leaves this hand-over's own tender out, so the answer is the one the
   * first call saw.
   */
  private owedBalance(rows: InvoiceRow[], mine: (p: any) => boolean = () => false): number {
    return roundMoney(
      rows.reduce(
        (sum, i) =>
          sum +
          remainingCapacity(
            Number(i.total),
            (i.payments ?? []).filter((p) => !mine(p)),
          ),
        0,
      ),
    );
  }

  private async readOrder(id: string): Promise<OrderRow | null> {
    return this.prisma.forTenant().order.findFirst({
      where: { id },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        fulfillPath: true,
        deliveredAt: true,
        customerId: true,
        customer: { select: { isWalkIn: true } },
      },
    });
  }

  private async readInvoices(orderId: string): Promise<InvoiceRow[]> {
    return this.prisma.forTenant().invoice.findMany({
      // A VOID / WRITTEN_OFF invoice is not part of the sale (recordPayment refuses both): reading it back
      // would put its id, total and balance into the response and the tender plan.
      where: { orderId, status: { notIn: ["VOID", "WRITTEN_OFF"] } },
      include: { payments: true },
      orderBy: { createdAt: "asc" },
    });
  }

  private respond(
    order: { id: string; orderNumber: string | null },
    invoices: InvoiceRow[],
    payment: { method: string; amount?: number },
    handedOverAt: Date | null,
    planError: string | undefined,
    alreadyPickedUp: boolean,
  ): PickupCompleteResponse {
    const first = invoices[0];
    if (!first) {
      throw new ConflictException({
        code: API_ERROR_CODES.PICKUP_INVOICE_MISSING,
        message:
          "The order was handed over but its invoice could not be found. Retry, or open the order from the orders list.",
      });
    }
    return {
      orderId: order.id,
      orderNumber: order.orderNumber ?? "",
      invoiceId: first.id,
      invoiceNumber: first.invoiceNumber ?? "",
      ...tenderFigures(invoices, payment, isHandOverTender(handedOverAt), planError),
      ...(alreadyPickedUp ? { alreadyPickedUp: true } : {}),
    };
  }
}
