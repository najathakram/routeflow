import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { roundMoney, remainingCapacity } from "@routeflow/pricing";
import type { PickupCompleteResponse } from "@routeflow/types";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import { LockTimeoutError, LockUnavailableError, withAdvisoryLock } from "../../common/db-locks";
import { PrismaService } from "../../prisma/prisma.service";
import { InvoicesService } from "../../invoices/invoices.service";
import type { JwtPayload } from "../../auth/jwt-payload.interface";
import { OrdersService } from "../orders.service";
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
    const payment: CounterPaymentInput = dto.payment ?? { method: "ON_ACCOUNT" };
    assertPaymentShape(payment, walkIn);

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
      throw new ConflictException(
        "The order is picked up but has no invoice. Use Generate Invoice on the order page.",
      );
    }
    const sendOpts = walkIn ? [{ suppressNotify: true }] : [];
    let sent = false;
    for (const inv of invoices) {
      if (inv.status !== "DRAFT") continue;
      try {
        await this.invoices.send(inv.id, ...sendOpts);
        sent = true;
      } catch (e) {
        // A concurrent call may have issued it first: only a still-DRAFT invoice is a real failure.
        const fresh = (await this.readInvoices(id)).find((i) => i.id === inv.id);
        if (!fresh || fresh.status === "DRAFT") throw e;
        sent = true;
      }
    }
    if (sent) invoices = await this.readInvoices(id);

    // 4. The tender, against what is STORED now. ON_ACCOUNT takes no money: no lock.
    let planError: string | undefined;
    if (payment.method !== "ON_ACCOUNT") {
      try {
        const locked = await withAdvisoryLock(
          { family: "counter-tender", key: id, mode: "wait" },
          () => this.tender(id, payment, handedOverAt),
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

    return this.respond(order, invoices, payment, handedOverAt, planError, alreadyPickedUp);
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
    if (plan.kind === "refuse") {
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

  private async readOrder(id: string): Promise<OrderRow | null> {
    return this.prisma.forTenant().order.findFirst({
      where: { id },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        fulfillPath: true,
        deliveredAt: true,
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
    payment: CounterPaymentInput,
    handedOverAt: Date | null,
    planError: string | undefined,
    alreadyPickedUp: boolean,
  ): PickupCompleteResponse {
    const first = invoices[0];
    if (!first) {
      throw new InternalServerErrorException(
        "The order was handed over but its invoice could not be found. Open the order from the orders list.",
      );
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
