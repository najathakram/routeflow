import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import type { PickupCompleteResponse } from "@routeflow/types";
import { API_ERROR_CODES } from "../../common/api-error-codes";
import { PrismaService } from "../../prisma/prisma.service";
import { InvoicesService } from "../../invoices/invoices.service";
import type { JwtPayload } from "../../auth/jwt-payload.interface";
import { OrdersService } from "../orders.service";
import { assertPaymentShape, type CounterPaymentInput } from "./counter-sale-payment";
import { recordTender, tenderFigures, type InvoiceRow } from "./tender";
import type { PickupCompleteDto } from "./pickup-complete.dto";

type InvoiceWithStatus = InvoiceRow & { status?: string };

/**
 * POST /orders/:id/pickup-complete (SA-655 item 11): staff hand a PICKUP order over at the till.
 * Order ahead, pick up: the buyer's order was created PENDING (stock taken once, at create), staff
 * confirmed it and marked it "Ready for pickup" (OUT_FOR_DELIVERY); this call is "Picked up".
 *
 * Sequenced like the counter sale, no new transaction and no new lock (each service owns its own):
 *  1. the order is read under the tenant scope (another tenant's id is simply not found) and judged from
 *     the row alone: not PICKUP -> 400 PICKUP_ONLY; not yet confirmed or cancelled -> 409 PICKUP_NOT_READY;
 *  2. the payment shape is judged from the request alone: everything refused is refused BEFORE a write;
 *  3. `OrdersService.changeStatus(DELIVERED)` is the EXISTING transition: it moves NO stock (pinned in
 *     orders.pickup-complete-status.spec.ts) and takes exactly one invoice path (reconcile the pending
 *     mirror, else auto-create), so there is never a second invoice;
 *  4. any DRAFT invoice is sent (no INVOICE_SENT message for the walk-in), then the tender is recorded
 *     exactly as the counter sale does (tender.ts): only when none is stored, against the POST-send
 *     balance, never above it. A payment that cannot be recorded leaves the order DELIVERED with an open
 *     invoice and answers 200 `paymentRecorded: false`.
 * A call on an order that is already DELIVERED skips step 3 and reads the figures back
 * (`alreadyPickedUp`); a first call whose payment failed is finished by the retry.
 * The Idempotency-Key is accepted and normalised for client symmetry; replay safety comes from the
 * order's own state and the stored tender, not from the key.
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
    _idempotencyKey?: string,
  ): Promise<PickupCompleteResponse> {
    // 1. The order, tenant-scoped.
    const order = await this.prisma.forTenant().order.findFirst({
      where: { id },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        fulfillPath: true,
        customer: { select: { isWalkIn: true } },
      },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (order.fulfillPath !== "PICKUP") {
      throw new BadRequestException({
        code: API_ERROR_CODES.PICKUP_ONLY,
        message: "Only a pickup order can be handed over this way",
      });
    }
    const alreadyPickedUp = order.status === "DELIVERED";
    if (!alreadyPickedUp && order.status !== "CONFIRMED" && order.status !== "OUT_FOR_DELIVERY") {
      throw new ConflictException({
        code: API_ERROR_CODES.PICKUP_NOT_READY,
        message: "This order is not ready for pickup yet, or it was cancelled",
      });
    }

    // 2. Request-only validation: nothing is written until it passes. No payment = on account.
    const walkIn = !!order.customer?.isWalkIn;
    const payment: CounterPaymentInput = dto.payment ?? { method: "ON_ACCOUNT" };
    assertPaymentShape(payment, walkIn);

    // 3. The hand-over: the existing status change (invoice + no stock). Its own refusals propagate.
    if (!alreadyPickedUp) {
      await this.orders.changeStatus(id, { status: "DELIVERED" } as never, user);
    }

    // 4. Issue every draft invoice, then the tender against what is STORED now.
    let invoices = await this.readInvoices(id);
    if (invoices.length === 0) {
      throw new ConflictException(
        "The order is picked up but has no invoice. Use Generate Invoice on the order page.",
      );
    }
    let sent = false;
    for (const inv of invoices) {
      if (inv.status !== "DRAFT") continue;
      await this.invoices.send(inv.id, ...(walkIn ? [{ suppressNotify: true }] : []));
      sent = true;
    }
    if (sent) invoices = await this.readInvoices(id);
    const tender = await recordTender(
      this.invoices,
      invoices,
      payment,
      this.logger,
      `pickup complete ${id}`,
    );
    if (tender.attempted) invoices = await this.readInvoices(id);

    return this.respond(order, invoices, payment, tender.planError, alreadyPickedUp);
  }

  private async readInvoices(orderId: string): Promise<InvoiceWithStatus[]> {
    return this.prisma.forTenant().invoice.findMany({
      where: { orderId, status: { not: "VOID" } },
      include: { payments: true },
      orderBy: { createdAt: "asc" },
    });
  }

  private respond(
    order: { id: string; orderNumber: string | null },
    invoices: InvoiceWithStatus[],
    payment: CounterPaymentInput,
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
      ...tenderFigures(invoices, payment, planError),
      ...(alreadyPickedUp ? { alreadyPickedUp: true } : {}),
    };
  }
}
