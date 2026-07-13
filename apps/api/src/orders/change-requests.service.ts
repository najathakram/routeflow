import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { JwtPayload } from "../auth/jwt-payload.interface";
import { OrdersService } from "./orders.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import {
  ChangeRequestStatus,
  ChangeRequestType,
  Prisma,
  UserRole,
  UserStatus,
} from "@prisma/client";
import { CreateChangeRequestDto } from "./dto/create-change-request.dto";
import {
  ChangeRequestResolveAction,
  ResolveChangeRequestDto,
} from "./dto/resolve-change-request.dto";

/**
 * P5-09: post-dispatch change-request lifecycle (G6/G7).
 * Creation opens exactly where the P5-08 edit window closes (order's RouteRun
 * dispatched); resolution: driver-at-stop primary, office only while PENDING,
 * FIRST resolution wins + locks (atomic conditional updateMany — count!==1 is
 * the lost race, 409). The at-stop money merge is delegated to
 * OrdersService.approveChangeRequestAtStop (the one money path).
 */
@Injectable()
export class ChangeRequestsService {
  private readonly logger = new Logger(ChangeRequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly ordersService: OrdersService,
    private readonly notifications: NotificationsService,
    private readonly authGuard: AuthorizationGuardService,
  ) {}

  async create(orderId: string, dto: CreateChangeRequestDto, user: JwtPayload) {
    const order = await this.prisma.forTenant().order.findUnique({
      where: { id: orderId },
      include: {
        lineItems: { select: { id: true, productId: true, status: true, qty: true } },
        routeRun: { select: { status: true } },
      },
    });
    if (!order) throw new NotFoundException("Order not found");

    // Ownership: a CUSTOMER may only file against their own order (mirrors
    // updateOrderItems' check). Buyer-portal calls arrive as a CUSTOMER
    // pseudo-user (buyer.controller makePseudoUser), so the same check covers both.
    if (user.role === UserRole.CUSTOMER) {
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer || customer.id !== order.customerId) throw new ForbiddenException();
    }

    // G7 inverse gate: change requests exist ONLY where direct editing ended.
    if (order.routeRun == null || order.routeRun.status === "SCHEDULED") {
      throw new ConflictException({
        code: "EDIT_WINDOW_OPEN",
        message: "This order is still directly editable — use PATCH /orders/:id/items.",
      });
    }
    if (
      order.routeRun.status !== "IN_PROGRESS" ||
      !["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY"].includes(order.status)
    ) {
      throw new ConflictException({
        code: "CHANGE_WINDOW_CLOSED",
        message: "This order's delivery run is no longer active.",
      });
    }

    // Type-specific validation + typed payload build (name snapshots so the
    // request renders even after a product/line is later deleted).
    let payload: Record<string, unknown>;
    let orderItemId: string | null = null;
    let productId: string | null = null;
    switch (dto.type) {
      case ChangeRequestType.ADD_ITEM: {
        if (!dto.productId || !dto.qty) {
          throw new BadRequestException("ADD_ITEM requires productId and qty");
        }
        const product = await this.prisma
          .forTenant()
          .product.findUnique({ where: { id: dto.productId }, select: { id: true, name: true } });
        if (!product) throw new BadRequestException("Product not found");
        productId = product.id;
        payload = {
          productId: product.id,
          qty: dto.qty,
          boxes: dto.boxes ?? null,
          pieces: dto.pieces ?? null,
          productName: product.name,
        };
        break;
      }
      case ChangeRequestType.CHANGE_QTY:
      case ChangeRequestType.REMOVE_ITEM: {
        if (!dto.orderItemId) throw new BadRequestException("orderItemId is required");
        const li = order.lineItems.find(
          (l) => l.id === dto.orderItemId && l.status !== "CANCELLED",
        );
        if (!li) throw new BadRequestException("Order line not found");
        if (dto.type === ChangeRequestType.CHANGE_QTY && !dto.qty) {
          throw new BadRequestException("CHANGE_QTY requires qty (the new absolute qty)");
        }
        orderItemId = li.id;
        productId = li.productId;
        payload =
          dto.type === ChangeRequestType.CHANGE_QTY
            ? { orderItemId: li.id, newQty: dto.qty }
            : { orderItemId: li.id };
        break;
      }
      case ChangeRequestType.NOTE: {
        if (!dto.note?.trim()) throw new BadRequestException("NOTE requires note text");
        payload = { text: dto.note.trim() };
        break;
      }
      default:
        throw new BadRequestException("Unknown change request type");
    }

    return this.prisma.forTenant().changeRequest.create({
      data: {
        tenantId: this.prisma.getTenantId(),
        orderId: order.id,
        orderItemId,
        productId,
        routeRunStopId: order.routeRunStopId ?? null,
        type: dto.type,
        payload: payload as Prisma.InputJsonValue,
        note: dto.note ?? null,
        requestedById: user.sub || null,
        requestedByName: user.username || null,
        requestedByRole: user.role ?? null,
      },
    });
    // P6-5: wire MessagingService.notify(ORDER_CHANGED_AT_DOOR, ...) here once
    // the trigger/rule plumbing exists; P5-11 adds the operator/driver surfacing.
  }

  async listForOrder(orderId: string, user: JwtPayload) {
    const order = await this.prisma
      .forTenant()
      .order.findUnique({ where: { id: orderId }, select: { id: true, customerId: true } });
    if (!order) throw new NotFoundException("Order not found");
    if (user.role === UserRole.CUSTOMER) {
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer || customer.id !== order.customerId) throw new ForbiddenException();
    }
    return this.prisma.forTenant().changeRequest.findMany({
      where: { orderId },
      orderBy: { createdAt: "desc" },
    });
  }

  async resolve(orderId: string, crId: string, dto: ResolveChangeRequestDto, user: JwtPayload) {
    const cr = await this.prisma
      .forTenant()
      .changeRequest.findFirst({ where: { id: crId, orderId } });
    if (!cr) throw new NotFoundException("Change request not found");
    const order = await this.prisma.forTenant().order.findUnique({
      where: { id: orderId },
      include: { routeRun: { select: { driverId: true, status: true } } },
    });
    if (!order) throw new NotFoundException("Order not found");

    // G6 authority: a DRIVER may resolve only if they are the run's assigned
    // driver (driver-at-stop). Operators/TENANT_ADMIN act as "the office" and
    // may resolve only while PENDING — which the atomic claim enforces anyway.
    if (user.role === UserRole.DRIVER) {
      const driver = await this.prisma
        .forTenant()
        .driver.findFirst({ where: { userId: user.sub } });
      if (!driver || order.routeRun?.driverId !== driver.id) {
        throw new ForbiddenException("Only the run's assigned driver can resolve at the stop");
      }
    }
    // Fast-path (the atomic claim in each branch remains authoritative).
    if (cr.status !== ChangeRequestStatus.PENDING) {
      throw new ConflictException({ code: "CHANGE_REQUEST_ALREADY_RESOLVED", status: cr.status });
    }

    switch (dto.action) {
      case ChangeRequestResolveAction.DECLINE:
        return this.decline(cr, order, dto.reason, user);
      case ChangeRequestResolveAction.APPROVE_AT_STOP: {
        await this.ordersService.approveChangeRequestAtStop(cr.id, user, dto.reason ?? null);
        await this.notifyRequester(
          cr,
          order,
          "approved",
          "Your change was applied to today's delivery.",
        );
        return this.prisma.forTenant().changeRequest.findUnique({ where: { id: cr.id } });
      }
      case ChangeRequestResolveAction.APPROVE_NEXT_DELIVERY:
        return this.approveNextDelivery(cr, order, dto.reason, user);
      default:
        throw new BadRequestException("Unknown resolve action");
    }
  }

  /** Decline — atomic claim (G6 first-resolution-wins), then notify with reason. */
  private async decline(cr: any, order: any, reason: string | undefined, user: JwtPayload) {
    if (!reason?.trim()) throw new BadRequestException("A decline reason is required");
    const claimed = await this.prisma.forTenant().changeRequest.updateMany({
      where: { id: cr.id, status: ChangeRequestStatus.PENDING },
      data: {
        status: ChangeRequestStatus.DECLINED,
        resolution: "DECLINED",
        resolutionReason: reason.trim(),
        resolvedById: user.sub || null,
        resolvedByName: user.username || null,
        resolvedByRole: user.role ?? null,
        resolvedAt: new Date(),
      },
    });
    if (claimed.count !== 1) {
      throw new ConflictException({ code: "CHANGE_REQUEST_ALREADY_RESOLVED" });
    }
    await this.notifyRequester(cr, order, "declined", `Reason: ${reason.trim()}`);
    return this.prisma.forTenant().changeRequest.findUnique({ where: { id: cr.id } });
  }

  /**
   * Not-on-truck approval: the requested item rolls to the customer's next
   * delivery as a line on a NEW DRAFT order, created through OrdersService.create
   * (the battle-tested customer pricing path — tier → sticky upsell → promo —
   * never a second pricing formula). Valid only for ADD_ITEM and for CHANGE_QTY
   * increases (the positive delta rolls; the dispatched order is untouched).
   *
   * Guards re-run on approval (G6): regulated license before creating; credit
   * re-checked against the draft's total via the ONE exposure formula. Stock is
   * deliberately NOT checked — nothing ships now (the item is by definition not
   * on the truck); stock enforcement happens when the draft goes live/delivers,
   * matching the codebase's DRAFT posture.
   *
   * Ordering: create draft → guards → atomic claim. A lost claim race or a
   * guard failure deletes the just-created draft (compensation); the worst
   * crash artifact is a harmless empty DRAFT order the operator can delete —
   * never an APPROVED CR without its draft.
   */
  private async approveNextDelivery(
    cr: any,
    order: any,
    reason: string | undefined,
    user: JwtPayload,
  ) {
    const payload = cr.payload as any;
    let productId: string;
    let qty: number;
    if (cr.type === ChangeRequestType.ADD_ITEM) {
      productId = cr.productId ?? payload.productId;
      qty = Number(payload.qty);
    } else if (cr.type === ChangeRequestType.CHANGE_QTY) {
      const li = await this.prisma
        .forTenant()
        .orderItem.findFirst({ where: { id: cr.orderItemId ?? payload.orderItemId } });
      if (!li?.productId) throw new BadRequestException("Order line not found");
      const delta = Number(payload.newQty) - Number(li.qty);
      if (delta <= 0) {
        throw new BadRequestException({
          code: "INVALID_RESOLUTION_FOR_TYPE",
          message: "Only a qty increase can roll to the next delivery",
        });
      }
      productId = li.productId;
      qty = delta;
    } else {
      throw new BadRequestException({
        code: "INVALID_RESOLUTION_FOR_TYPE",
        message: "Only ADD_ITEM / CHANGE_QTY-increase requests can roll to the next delivery",
      });
    }

    const product = await this.prisma.forTenant().product.findUnique({
      where: { id: productId },
      select: { id: true, trackedCategoryId: true },
    });
    if (!product) throw new BadRequestException("Product no longer exists");
    // Regulated license guard re-runs on approval (G6).
    await this.authGuard.assertAuthorizedOrThrow({
      customerId: order.customerId,
      lines: [{ trackedCategoryId: product.trackedCategoryId ?? null }],
      orderId: order.id,
    });

    // Customer pseudo-user so create() prices via the buyer effective path.
    const customer = await this.prisma
      .forTenant()
      .customer.findUnique({ where: { id: order.customerId }, select: { userId: true } });
    if (!customer?.userId) throw new BadRequestException("Customer record not found");
    const pseudo: JwtPayload = {
      sub: customer.userId,
      username: "",
      role: UserRole.CUSTOMER,
      status: UserStatus.ACTIVE,
      forcePasswordChange: false,
      tenantId: this.prisma.getTenantId(),
    } as JwtPayload;

    const draft = await this.ordersService.create(
      {
        items: [{ productId, qty }],
        status: "DRAFT",
        notes: `From change request on order #${order.orderNumber ?? order.id} (not on truck)`,
      } as any,
      pseudo,
      { skipAutoMerge: false },
    );

    try {
      // Credit re-check on approval (G6) — the ONE exposure formula, with the
      // draft excluded from the buckets and represented by its own total.
      await this.ordersService.assertCreditForProjectedOrder(
        order.customerId,
        draft.id,
        Number(draft.total),
      );
      // G6 atomic claim — first resolution wins and locks.
      const claimed = await this.prisma.forTenant().changeRequest.updateMany({
        where: { id: cr.id, status: ChangeRequestStatus.PENDING },
        data: {
          status: ChangeRequestStatus.APPROVED,
          resolution: "NEXT_DELIVERY",
          resolutionReason: reason ?? null,
          nextOrderId: draft.id,
          resolvedById: user.sub || null,
          resolvedByName: user.username || null,
          resolvedByRole: user.role ?? null,
          resolvedAt: new Date(),
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException({ code: "CHANGE_REQUEST_ALREADY_RESOLVED" });
      }
    } catch (e) {
      // Compensation: never leave an orphan draft behind a failed approval.
      await this.ordersService.deleteOrder(draft.id).catch(() => {});
      throw e;
    }

    await this.notifyRequester(
      cr,
      order,
      "approved",
      "The item wasn't on the truck — it was added to your next delivery.",
    );
    return this.prisma.forTenant().changeRequest.findUnique({ where: { id: cr.id } });
  }

  /**
   * Notify the requester of the outcome. Push via NotificationsService — the
   * mechanism completeStop already uses. Never fails the resolution.
   * (MessagingService.notify is NOT used: it requires per-tenant
   * NotificationRule/MessageTemplate rows that nothing seeds yet — P6-5 wires it.)
   */
  private async notifyRequester(cr: any, order: any, outcome: string, detail: string) {
    const title = `Change request ${outcome}`;
    const body = `Order #${order.orderNumber ?? ""}: ${detail}`.trim();
    const data = { orderId: order.id, changeRequestId: cr.id };
    try {
      if (cr.requestedByRole === UserRole.CUSTOMER || !cr.requestedById) {
        await this.notifications.sendToCustomer(order.customerId, title, body, data);
      } else {
        await this.notifications.sendToUser(cr.requestedById, { title, body, data });
      }
    } catch {
      this.logger.warn(`Change-request notification failed for ${cr.id}`);
    }
  }
}
