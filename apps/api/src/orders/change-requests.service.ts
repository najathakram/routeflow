import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import * as unitAware from "./unit-aware-guard";
import { normalizeBoxesPieces } from "@routeflow/pricing";
import { PrismaService } from "../prisma/prisma.service";
import { JwtPayload } from "../auth/jwt-payload.interface";
import { OrdersService } from "./orders.service";
import { NotificationsService } from "../notifications/notifications.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { MessagingService } from "../messaging/messaging.service";
import { formatMoney } from "../messaging/messaging.helpers";
import {
  ChangeRequestStatus,
  ChangeRequestType,
  NotificationEvent,
  Prisma,
  type PriceType,
  UserRole,
  UserStatus,
} from "@prisma/client";
import { assertSellableLines } from "../products/sellable-lines";
import {
  buyerVisibilityFor,
  isBuyerVisibleProduct,
  PORTAL_PARENT_INCLUDE,
} from "../buyer/buyer-product-visibility";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { requireRestrictionTenantId } from "../selling-restrictions/restriction-tenant";
import { CreateChangeRequestDto } from "./dto/create-change-request.dto";
import {
  ChangeRequestResolveAction,
  ResolveChangeRequestDto,
} from "./dto/resolve-change-request.dto";
import { assertDriverMayEditOrder, underOrderLockForDriver } from "./driver-edit-access";
import { throwIfWithCarrierChangeRequest } from "./order-carrier-guard";
import { API_ERROR_CODES } from "../common/api-error-codes";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * B673: reconcile a next-delivery ADD_ITEM's FILED box split against the product's LIVE pack.
 *
 * A driver's door add is filed as `{ qty: total pieces, boxes, pieces }`. The pack at filing is not
 * stored, but it is fixed by the payload itself: `(qty - pieces) / boxes`. The split is handed to
 * create() unchanged when that pack still matches the live one; otherwise the approval is REFUSED,
 * naming both packs, so the operator can re-quote. Re-splitting against a changed pack would change
 * either the price or the quantity the customer agreed to, and falling back to the bare `qty` is
 * the 12x overcharge itself (create() reads a bare qty on a boxed product as a BOX count).
 * An inconsistent split is refused as INVALID_LINE_SPLIT — never reinterpreted.
 *
 * Every refusal is thrown before any write, so the change request stays PENDING. The message
 * points the operator at DECLINE + a fresh add on the next order — never at approve-at-stop: the
 * item was not on the truck, approve-at-stop fails once the stop is done, and on an order holding
 * an old box-unaware line its merge re-prices at 12x (B753(a): $520 for $80). Revisit once B753
 * is fixed.
 */
export function reconcileFiledAddSplit(args: {
  qty: number;
  boxes: unknown;
  pieces: unknown;
  liveUnitsPerBox: number;
  productName: string;
}): { boxes: number; pieces: number } {
  const { qty, liveUnitsPerBox: liveUpb, productName } = args;
  const b = args.boxes ?? 0;
  const p = args.pieces ?? 0;
  const invalid = (message: string) =>
    new BadRequestException({ code: API_ERROR_CODES.INVALID_LINE_SPLIT, message });

  if (
    typeof b !== "number" ||
    typeof p !== "number" ||
    !Number.isInteger(b) ||
    !Number.isInteger(p) ||
    b < 0 ||
    p < 0
  ) {
    throw invalid("boxes and pieces must be non-negative whole numbers");
  }
  if (b === 0 && p === 0) throw invalid("a split of 0 boxes and 0 pieces adds nothing");
  if (!Number.isFinite(qty) || p > qty) {
    throw invalid(`${plural(p, "loose piece", "loose pieces")} exceed the request's qty (${qty})`);
  }

  const filed = `${plural(b, "box", "boxes")} + ${plural(p, "piece", "pieces")}`;
  const refuse = (reason: string) =>
    new BadRequestException({
      code: API_ERROR_CODES.CHANGE_REQUEST_PACK_CHANGED,
      message: `Change request filed as ${filed}${reason}. Decline it and re-add the item to the next order.`,
    });

  if (b === 0) {
    // Loose pieces only: no filed pack to compare, but the qty must be exactly those pieces.
    if (qty !== p) throw invalid(`qty (${qty}) does not match ${plural(p, "piece", "pieces")}`);
    if (liveUpb <= 1) throw refuse(`, but ${productName} is no longer sold by the box`);
    return { boxes: 0, pieces: p };
  }

  const filedUpb = (qty - p) / b;
  if (!Number.isInteger(filedUpb) || filedUpb <= 1) {
    throw invalid(`qty (${qty}) is not ${filed} of any whole pack size`);
  }
  if (liveUpb <= 1) {
    throw refuse(` at ${filedUpb} per box, but ${productName} is no longer sold by the box`);
  }
  if (filedUpb !== liveUpb) {
    throw refuse(` at ${filedUpb} per box, but ${productName} now sells at ${liveUpb} per box`);
  }
  return { boxes: b, pieces: p };
}

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
    private readonly messaging: MessagingService,
    // F1(iii): required (never @Optional): a buyer's ADD_ITEM filing is judged at filing time (L-247).
    private readonly sellingRestrictions: SellingRestrictionsService,
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
      // B1135: a with-carrier order never reaches a route run and its lines are frozen (SA-696).
      await throwIfWithCarrierChangeRequest(
        { featureConfig: this.ordersService.featureConfig, prisma: this.prisma },
        order,
      );
      throw new ConflictException({
        code: API_ERROR_CODES.EDIT_WINDOW_OPEN,
        message: "This order is still directly editable — use PATCH /orders/:id/items.",
      });
    }
    if (
      order.routeRun.status !== "IN_PROGRESS" ||
      !["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY"].includes(order.status)
    ) {
      throw new ConflictException({
        code: API_ERROR_CODES.CHANGE_WINDOW_CLOSED,
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
        const product = await this.prisma.forTenant().product.findFirst({
          where: { id: dto.productId },
          select: {
            id: true,
            name: true,
            kind: true,
            isActive: true,
            portalVisible: true,
            ...PORTAL_PARENT_INCLUDE,
          },
        });
        if (!product) throw new BadRequestException("Product not found");
        assertSellableLines([product]); // WS8: refuse at filing time, not only at approval
        if (user.role === UserRole.CUSTOMER) await this.assertBuyerMayFile(product, order);
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

    const created = await this.prisma.forTenant().changeRequest.create({
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

    // P6-5: customer notification via the rules matrix (fire-and-forget AFTER
    // the write commits; notify() no-ops on a disabled cell + meters itself).
    this.messaging
      .notifyEvent(NotificationEvent.ORDER_CHANGED_AT_DOOR, {
        customerId: order.customerId,
        senderId: user.sub || null,
        vars: {
          orderNumber: order.orderNumber ?? "",
          changeSummary: this.summarizeChange(dto.type, payload),
          orderTotal: formatMoney(order.total),
        },
      })
      .catch(() => {});

    return created;
  }

  /**
   * F1(iii): a BUYER's ADD_ITEM is judged when it is FILED, on the buyer channel, not only when staff approve it.
   * A product this buyer cannot see in the portal (hidden, inactive, under a hidden parent, or banned for them) is
   * the plain 404 every hidden-product read gives: no name, no reason. A visible one still goes through the
   * choke point on BUYER_PORTAL (a rule the visibility set does not cover refuses with the buyer 409).
   */
  private async assertBuyerMayFile(
    product: Parameters<typeof isBuyerVisibleProduct>[1],
    order: { customerId: string },
  ): Promise<void> {
    const tenantId = requireRestrictionTenantId(this.prisma.getTenantId());
    const visibility = await buyerVisibilityFor(
      this.sellingRestrictions,
      tenantId,
      order.customerId,
    );
    if (!isBuyerVisibleProduct(visibility, product))
      throw new NotFoundException("Product not found");
    await this.sellingRestrictions.assertLinesSellable({
      tenantId,
      customerId: order.customerId,
      lines: [{ productId: product.id }],
      channel: "BUYER_PORTAL",
    });
  }

  /** Human-readable one-liner for the ORDER_CHANGED_AT_DOOR {{changeSummary}} var. */
  private summarizeChange(type: ChangeRequestType, payload: Record<string, unknown>): string {
    switch (type) {
      case ChangeRequestType.ADD_ITEM:
        return `add ${payload.qty as number} × ${(payload.productName as string | undefined) ?? "item"}`;
      case ChangeRequestType.CHANGE_QTY:
        return `quantity changed to ${payload.newQty as number}`;
      case ChangeRequestType.REMOVE_ITEM:
        return "item removed";
      case ChangeRequestType.NOTE:
        return (payload.text as string | undefined) ?? "note added";
      default:
        return "order changed";
    }
  }

  async listForOrder(orderId: string, user: JwtPayload) {
    const order = await this.prisma
      .forTenant()
      .order.findFirst({ where: { id: orderId }, select: { id: true, customerId: true } });
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
    // SA-434: a DRIVER may resolve only on an order of their own IN_PROGRESS run with a PENDING or
    // IN_PROGRESS stop (the SA-429 predicate, the order's own stop chain) — FIRST, before the change
    // request and order reads, so an unassigned driver learns nothing. Re-derived under the Order
    // lock at every claim below.
    await assertDriverMayEditOrder(this.prisma.forTenant(), orderId, user);
    const cr = await this.prisma
      .forTenant()
      .changeRequest.findFirst({ where: { id: crId, orderId } });
    if (!cr) throw new NotFoundException("Change request not found");
    const order = await this.prisma.forTenant().order.findUnique({
      where: { id: orderId },
      include: { routeRun: { select: { driverId: true, status: true } } },
    });
    if (!order) throw new NotFoundException("Order not found");

    // G6 authority: the DRIVER check is SA-434's predicate above (it replaced the order-level
    // routeRun.driverId compare, which read no run or stop status). Operators/TENANT_ADMIN act as
    // "the office" and may resolve only while PENDING — which the atomic claim enforces anyway.
    // Fast-path (the atomic claim in each branch remains authoritative).
    if (cr.status !== ChangeRequestStatus.PENDING) {
      throw new ConflictException({
        code: API_ERROR_CODES.CHANGE_REQUEST_ALREADY_RESOLVED,
        status: cr.status,
      });
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
    // SA-434: claimed under the Order lock with the driver predicate re-derived (CAS on PENDING).
    const claimed = await underOrderLockForDriver(this.prisma, order.id, user, (tx) =>
      tx.changeRequest.updateMany({
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
      }),
    );
    if (claimed.count !== 1) {
      throw new ConflictException({ code: API_ERROR_CODES.CHANGE_REQUEST_ALREADY_RESOLVED });
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
    // B655: set only for a CHANGE_QTY delta on a BOX-AWARE line (li.boxes != null), where the
    // delta is in PIECES and needs the pack size to split. Left null otherwise.
    let boxes: number | null = null;
    let pieces: number | null = null;
    // D-20 (#1808, SA-330): the SOURCE line's denomination for a CHANGE_QTY rollover — its price ALWAYS, its pack
    // only when box-aware — carried onto the draft line so a repack or a price change since the sale cannot re-split
    // or re-quote the copy (see orders/source-line.ts). ADD_ITEM has no source line: a new sale at today's price.
    let sourceItem: {
      unitPrice: unknown;
      priceType: PriceType;
      originalPrice: unknown;
      overrideReason: string | null;
      overriddenBy: string | null;
    } | null = null;
    let sourceUpb: number | null = null;
    // B673: an ADD_ITEM filed WITH a box split (a driver's door add: qty = total pieces, plus
    // boxes/pieces) is reconciled against the LIVE pack below. A bare qty (the buyer portal's
    // selling-unit count, stored with boxes/pieces null) is passed to create() untouched.
    let filedSplit: { boxes: unknown; pieces: unknown } | null = null;
    if (cr.type === ChangeRequestType.ADD_ITEM) {
      productId = cr.productId ?? payload.productId;
      qty = Number(payload.qty);
      if (payload.boxes != null || payload.pieces != null) {
        filedSplit = { boxes: payload.boxes, pieces: payload.pieces };
      }
    } else if (cr.type === ChangeRequestType.CHANGE_QTY) {
      const li = await this.prisma
        .forTenant()
        .orderItem.findFirst({ where: { id: cr.orderItemId ?? payload.orderItemId } });
      if (!li?.productId) throw new BadRequestException("Order line not found");
      // units_v1: the delta is in the line's own unit axis but is re-created through create() as
      // pack selling units at the live price — wrong for a unit-aware line.
      unitAware.assertNoUnitAwareLines([li], "rolled to the next delivery");
      const delta = Number(payload.newQty) - Number(li.qty);
      if (delta <= 0) {
        throw new BadRequestException({
          code: API_ERROR_CODES.INVALID_RESOLUTION_FOR_TYPE,
          message: "Only a qty increase can roll to the next delivery",
        });
      }
      productId = li.productId;
      sourceItem = li; // the price is carried ALWAYS; the pack (sourceUpb) only when the line is box-aware

      // B655: an EXISTING line's rewrite never re-derives its factor from the LIVE product (SA
      // ruling) — only the line's own stored shape decides how the delta is read.
      //
      // Box-AWARE line (li.boxes != null): OrderItem.qty is TOTAL PIECES (create()'s split sets
      // it that way), so `delta` is a pieces delta. Split it with the line's own unitsPerBox
      // snapshot; if that snapshot predates the column, derive the pack EXACTLY from the line's
      // own stored split — (qty - pieces) / boxes — accepted only when it comes out to a whole
      // number > 1. Anything else (no derivable pack) refuses rather than guessing.
      //
      // Box-UNAWARE line (li.boxes == null — the template/buyer bare-qty convention): OrderItem.qty
      // IS ALREADY the line's own selling-unit count (a box count for a boxed product with no
      // split stored, a piece count otherwise — see the "box-unaware boxed line's qty IS the box
      // count" comment in orders.service.ts). So `delta` is already in that unit, and today's bare
      // `{ productId, qty }` — which create() reads as selling units — is CORRECT for this shape.
      // Splitting it against any pack (live or snapshot) would misread a boxes delta as pieces and
      // under-charge (a 3-box delta split against upb 24 becomes 0 boxes + 3 pieces).
      if (li.boxes != null) {
        // A snapshot of <= 1 is not a real pack (it's the "not case-packed" value) — treat it as
        // absent and fall through to deriving one, same as a null snapshot, rather than letting
        // it reach normalizeBoxesPieces' non-boxed branch, which posts the pieces delta as a bare
        // qty (the exact B655 shape this whole fix exists to close).
        const snapshotUpb = li.unitsPerBox != null ? Number(li.unitsPerBox) : null;
        let upb = snapshotUpb != null && snapshotUpb > 1 ? snapshotUpb : null;
        if (upb == null) {
          const boxesNum = Number(li.boxes);
          const piecesNum = Number(li.pieces ?? 0);
          const derived = boxesNum > 0 ? (Number(li.qty) - piecesNum) / boxesNum : NaN;
          upb = Number.isInteger(derived) && derived > 1 ? derived : null;
        }
        if (upb == null) {
          throw new BadRequestException({
            code: API_ERROR_CODES.LINE_PACK_UNDERIVABLE,
            message: `Order line ${li.id} has no derivable pack size — it can't be rolled to the next delivery.`,
          });
        }
        sourceUpb = upb;
        const split = normalizeBoxesPieces({ qty: delta, unitsPerBox: upb });
        qty = split.qty;
        boxes = split.boxes;
        pieces = split.pieces;
      } else {
        qty = delta;
      }
    } else {
      throw new BadRequestException({
        code: API_ERROR_CODES.INVALID_RESOLUTION_FOR_TYPE,
        message: "Only ADD_ITEM / CHANGE_QTY-increase requests can roll to the next delivery",
      });
    }

    const product = await this.prisma.forTenant().product.findFirst({
      where: { id: productId },
      select: { id: true, trackedCategoryId: true },
    });
    if (!product) throw new BadRequestException("Product no longer exists");
    if (filedSplit) {
      // The live pack is read ONLY for an ADD_ITEM that carries a filed split — a new draft line's
      // correct contract. CHANGE_QTY never reads it (B655's SA ruling: an existing line's rewrite
      // uses only what the line itself stored), so the shared product read above stays as it was.
      const liveProduct = await this.prisma.forTenant().product.findFirst({
        where: { id: productId },
        select: { unitsPerBox: true, name: true },
      });
      ({ boxes, pieces } = reconcileFiledAddSplit({
        qty,
        boxes: filedSplit.boxes,
        pieces: filedSplit.pieces,
        liveUnitsPerBox: Number(liveProduct?.unitsPerBox ?? 0),
        productName: liveProduct?.name ?? payload.productName ?? "this product",
      }));
    }
    // Regulated license guard re-runs on approval (G6).
    await this.authGuard.assertAuthorizedOrThrow({
      customerId: order.customerId,
      lines: [{ trackedCategoryId: product.trackedCategoryId ?? null }],
      orderId: order.id,
    });

    // Customer pseudo-user so create() prices via the buyer effective path.
    const customer = await this.prisma
      .forTenant()
      .customer.findFirst({ where: { id: order.customerId }, select: { userId: true } });
    if (!customer?.userId) throw new BadRequestException("Customer record not found");
    const pseudo: JwtPayload = {
      sub: customer.userId,
      username: "",
      role: UserRole.CUSTOMER,
      status: UserStatus.ACTIVE,
      forcePasswordChange: false,
      tenantId: this.prisma.getTenantId(),
      type: "BUYER",
    } as JwtPayload;

    // This split is handed to create() for a NEW draft line. For a CHANGE_QTY rollover the SOURCE line's price
    // (always) and pack (when box-aware) ride along as `options.sourceLines` (orders/source-line.ts), so create()
    // splits at the SOURCE pack and bills at the SOURCE's agreed price instead of re-splitting at the live pack
    // and re-quoting; the subtotal is derived from that pack and price by computeLineSubtotal. An ADD_ITEM has no
    // source line: create() re-splits its filed split against the LIVE pack and prices it today (a new sale).
    // SA-434a: a locked re-derive BEFORE the draft is created, so a refused driver writes nothing.
    await underOrderLockForDriver(this.prisma, order.id, user, async () => undefined);
    const draft = await this.ordersService.create(
      {
        items: [{ productId, qty, ...(boxes != null ? { boxes, pieces } : {}) }],
        status: "DRAFT",
        notes: `From change request on order #${order.orderNumber ?? order.id} (not on truck)`,
      } as any,
      pseudo,
      // B142/REG-B142-G: this draft moves an existing (possibly since
      // archived) line to the customer's next delivery — the archived-line
      // guard is for NEW interactive lines, not this internal draft path.
      {
        skipAutoMerge: false,
        allowArchived: true,
        internalCustomerDraft: true, // F1(ii): the one deliberate draft under the buyer pseudo-user
        ...(sourceItem
          ? {
              sourceLines: {
                [productId]: {
                  unitsPerBox: sourceUpb,
                  unitPrice: Number(sourceItem.unitPrice),
                  priceType: sourceItem.priceType,
                  originalPrice:
                    sourceItem.originalPrice != null ? Number(sourceItem.originalPrice) : null,
                  overrideReason: sourceItem.overrideReason ?? null,
                  overriddenBy: sourceItem.overriddenBy ?? null,
                },
              },
            }
          : {}),
      },
    );

    try {
      // Credit re-check on approval (G6) — the ONE exposure formula, with the
      // draft excluded from the buckets and represented by its own total.
      await this.ordersService.assertCreditForProjectedOrder(
        order.customerId,
        draft.id,
        Number(draft.total),
      );
      // G6 atomic claim — first resolution wins and locks. SA-434a: under the Order lock with the
      // driver predicate re-derived; a 403 or the 409 both fall to the compensation below.
      const claimed = await underOrderLockForDriver(this.prisma, order.id, user, (tx) =>
        tx.changeRequest.updateMany({
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
        }),
      );
      if (claimed.count !== 1) {
        throw new ConflictException({ code: API_ERROR_CODES.CHANGE_REQUEST_ALREADY_RESOLVED });
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
   * Notify the requester (whoever filed the change request — driver or office
   * staff) of a resolution outcome. Push via NotificationsService — the
   * mechanism completeStop already uses. Never fails the resolution.
   * Distinct from the customer-facing MessagingService.notifyEvent
   * (ORDER_CHANGED_AT_DOOR), which fires at request creation, above (P6-5).
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
