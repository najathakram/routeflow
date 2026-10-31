import { FulfillPath, NotificationEvent, OrderStatus } from "@prisma/client";
import type { PrismaService } from "../prisma/prisma.service";
import type { NotificationsService } from "../notifications/notifications.service";
import type { MessagingService } from "../messaging/messaging.service";
import { formatDate, formatMoney } from "../messaging/messaging.helpers";
import { orderConfirmedVars } from "../messaging/order-confirmed-copy";
import {
  isPickupHandover,
  notifyPickupHandover,
  pickupOutForDeliveryPush,
} from "./order-pickup-wording";
import { readyRecord, recordPatchSend } from "./ready-for-pickup.record";
import { isFirstShipment, notifyOrderShipped } from "./shipment-notifications";
import { shippedPushCopy } from "./shipped-push-copy";

/** `OrdersService.changeStatus`'s options (I-120, SA-861 rules 5-6). Set only by the counter hand-over. */
export interface ChangeStatusOpts {
  /** Skip BOTH customer messages of this transition (the push and the messaging event, every kind). */
  silent?: boolean;
  /** What the till takes now, for the B585 delivery gate (`creditProjectedTotal`): the S1 netting. */
  creditPaidNow?: (total: number) => number;
}

/**
 * The customer notifications of an order status change: the push (`notifMap`) and the messaging event (the rules
 * matrix), fire-and-forget AFTER the status write. Moved verbatim out of `OrdersService.changeStatus` (SA-861 commit 1,
 * behaviour-neutral, SA-065: orders.service.ts was at its size ceiling). The firing sites stay outside `messaging/`, so
 * default-on-is-wired / notification-triggers see them here.
 */
export async function notifyOrderStatusChange(
  deps: {
    prisma: PrismaService;
    notifications: NotificationsService;
    messaging: MessagingService;
  },
  p: { order: any; updated: any; status: OrderStatus; userSub: string | null | undefined },
): Promise<void> {
  const { order, updated, status, userSub } = p;
  // SA-1070 (W-1060): a pickup handover tells the customer once. A SENT `order.ready_for_pickup` row (the Ready press
  // writes it too) means neither the push nor the email goes again; the status has already moved.
  if (isPickupHandover(order, status)) {
    const told = await readyRecord(deps.prisma, deps.prisma.getTenantId?.(), order.id);
    if (told.lastSent) return;
  }
  // Fire-and-forget push notifications for key status transitions
  const notifMap: Partial<Record<OrderStatus, { title: string; body: string }>> = {
    [OrderStatus.CONFIRMED]: {
      title: "Order Confirmed ✓",
      body: `Your order #${order.orderNumber} has been confirmed.`,
    },
    [OrderStatus.OUT_FOR_DELIVERY]: pickupOutForDeliveryPush(order) ?? {
      title: "Out for Delivery 🚚",
      body: `Your order #${order.orderNumber} is on its way!`,
    },
    [OrderStatus.PARTIALLY_DELIVERED]: {
      title: "Partial Delivery 📦",
      body: `Some items from order #${order.orderNumber} have been delivered.`,
    },
    [OrderStatus.DELIVERED]: {
      title: "Order Delivered ✓",
      body: `Your order #${order.orderNumber} has been delivered.`,
    },
    [OrderStatus.CANCELLED]: {
      title: "Order Cancelled",
      body: `Your order #${order.orderNumber} has been cancelled.`,
    },
  };
  // SHIP orders say "shipped", not "Out for Delivery" (PICKUP wording: #3211, not touched here).
  const notif =
    status === OrderStatus.OUT_FOR_DELIVERY && order.fulfillPath === FulfillPath.SHIP
      ? // told once, like the email: an unmark + re-mark keeps shippedAt and sends nothing
        isFirstShipment(order)
        ? shippedPushCopy(order)
        : undefined
      : notifMap[status];
  if (notif) {
    deps.notifications
      .sendToCustomer(order.customerId, notif.title, notif.body, { orderId: order.id })
      .catch(() => {});
  }

  // P6-5: customer notification via the rules matrix (fire-and-forget AFTER
  // the status write; notify() no-ops on a disabled cell + meters itself).
  const messagingEventMap: Partial<Record<OrderStatus, NotificationEvent>> = {
    [OrderStatus.CONFIRMED]: NotificationEvent.ORDER_CONFIRMED,
    [OrderStatus.OUT_FOR_DELIVERY]: NotificationEvent.OUT_FOR_DELIVERY,
    [OrderStatus.DELIVERED]: NotificationEvent.DELIVERED,
    // N1 (2026-09-16): CANCELLED gains a real messaging-engine event — the
    // older push-notification `notifMap` above already covered it; this adds
    // the (now real, via EmailChannelProvider) EMAIL/PORTAL/WA/SMS channels.
    [OrderStatus.CANCELLED]: NotificationEvent.CANCELLED,
  };
  // A PICKUP handover fires READY_FOR_PICKUP instead of the driver-named template (order-pickup-wording.ts).
  const pickupHandled = notifyPickupHandover(
    deps.messaging,
    order,
    status,
    userSub || null,
    (outcomes) => recordPatchSend(deps, order, userSub, outcomes),
  );
  const messagingEvent = pickupHandled ? undefined : messagingEventMap[status];
  if (
    messagingEvent === NotificationEvent.OUT_FOR_DELIVERY &&
    order.fulfillPath === FulfillPath.SHIP
  ) {
    // Carrier-shipped: ORDER_SHIPPED, not "out for delivery today" (customised wording kept per channel).
    // E-c: an unmark + re-ship keeps shippedAt, so the customer is told once.
    if (isFirstShipment(order)) void notifyOrderShipped(deps, order, userSub || null);
  } else if (messagingEvent) {
    let driverName = "your driver";
    if (messagingEvent === NotificationEvent.OUT_FOR_DELIVERY && order.routeRunId) {
      const run = await deps.prisma.forTenant().routeRun.findFirst({
        where: { id: order.routeRunId },
        select: { driver: { select: { contactName: true } } },
      });
      driverName = run?.driver?.contactName ?? "your driver";
    }
    const vars: Record<string, string> = {
      orderNumber: order.orderNumber ?? "",
      ...(messagingEvent === NotificationEvent.ORDER_CONFIRMED
        ? orderConfirmedVars(order, updated.total) // B1127: SHIP wording, no dangling date
        : {}),
      ...(messagingEvent === NotificationEvent.OUT_FOR_DELIVERY ? { driverName } : {}),
      ...(messagingEvent === NotificationEvent.DELIVERED
        ? { orderTotal: formatMoney(updated.total), deliveredAt: formatDate(new Date()) }
        : {}),
    };
    deps.messaging
      .notifyEvent(messagingEvent, {
        customerId: order.customerId,
        senderId: userSub || null,
        vars,
      })
      .catch(() => {});
  }
}
