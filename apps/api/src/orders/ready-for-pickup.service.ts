import { ConflictException, Injectable } from "@nestjs/common";
import { FulfillPath, OrderStatus } from "@prisma/client";
import type { ReadyForPickupDone, ReadyForPickupResponse } from "@routeflow/types";
import { API_ERROR_CODES } from "../common/api-error-codes";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { AuditService } from "../audit/audit.service";
import { MessagingService } from "../messaging/messaging.service";
import { NotificationsService } from "../notifications/notifications.service";
import { PrismaService } from "../prisma/prisma.service";
import { OrdersService } from "./orders.service";
import { pickupOutForDeliveryPush, sendPickupReady } from "./order-pickup-wording";
import { pickupLineOf, readPickupAddress } from "./pickup-line";
import { readyNoticeOf } from "./ready-for-pickup.notice";

/**
 * POST /orders/:id/ready-for-pickup (W-1043, SA-1062 MUST 15-18): a PICKUP, non-counter order at PENDING or
 * CONFIRMED goes to OUT_FOR_DELIVERY ("Ready for pickup") through the existing `changeStatus`, silent, so the credit
 * gate, the stop check and the status claim stay there and nothing moves stock or writes an invoice. PENDING goes
 * to CONFIRMED silently first (the customer never gets the order-confirmed email as well). The status commits
 * first; then the ONE Ready email is sent and awaited so staff are told what really happened. A repeat press at
 * OUT_FOR_DELIVERY sends nothing. No new status write path: both steps are `changeStatus`.
 */
@Injectable()
export class ReadyForPickupService {
  constructor(
    private readonly orders: OrdersService,
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly messaging: MessagingService,
    private readonly audit: AuditService,
  ) {}

  async markReady(id: string, user: JwtPayload): Promise<ReadyForPickupResponse> {
    const order = await this.orders.findOneOrThrow(id);
    if (order.fulfillPath !== FulfillPath.PICKUP || order.counterSale) throw this.notReadyable();
    if (order.status === OrderStatus.OUT_FOR_DELIVERY) return { alreadyReady: true };
    if (order.status !== OrderStatus.PENDING && order.status !== OrderStatus.CONFIRMED) {
      throw this.notReadyable();
    }

    if (order.status === OrderStatus.PENDING) {
      await this.orders.changeStatus(id, { status: OrderStatus.CONFIRMED }, user, {
        silent: true,
      });
    }
    await this.orders.changeStatus(id, { status: OrderStatus.OUT_FOR_DELIVERY }, user, {
      silent: true,
    });

    // `silent` skipped the push too: it still fires, in pickup wording (fire-and-forget, as on the status path).
    const push = pickupOutForDeliveryPush(order);
    if (push) {
      this.notifications
        .sendToCustomer(order.customerId, push.title, push.body, { orderId: id })
        .catch(() => {});
    }

    const db = this.prisma.forTenant();
    const customer = await db.customer.findFirst({
      where: { id: order.customerId },
      select: { businessName: true, email: true, orderStatusEmails: true },
    });
    const pickupLine = pickupLineOf(await readPickupAddress(this.prisma, user.tenantId));
    const sent = await sendPickupReady(this.messaging, order, {
      senderId: user.sub,
      customerName: customer?.businessName ?? "Customer",
      pickupLine,
    });
    const result: ReadyForPickupDone =
      sent === "FAILED"
        ? { notice: "FAILED" }
        : readyNoticeOf(sent, {
            email: customer?.email ?? null,
            orderStatusEmails: customer?.orderStatusEmails ?? true,
          });

    await this.audit.log({
      tenantId: user.tenantId ?? null,
      userId: user.sub,
      action: "order.ready_for_pickup",
      entityType: "order",
      entityId: id,
      meta: { notice: result.notice, ...(result.email ? { email: result.email } : {}) },
    });
    return result;
  }

  private notReadyable(): ConflictException {
    return new ConflictException({
      code: API_ERROR_CODES.ORDER_NOT_READYABLE,
      message: "Only a pickup order that is pending or confirmed can be marked ready for pickup.",
    });
  }
}
