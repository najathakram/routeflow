import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
} from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { InjectQueue } from "@nestjs/bull";
import type { Queue } from "bull";
import { PrismaService } from "../prisma/prisma.service";
import { JwtPayload } from "../auth/jwt-payload.interface";
import {
  computeLineSubtotal,
  roundMoney,
  normalizeBoxesPieces,
  applyBestPromotion,
  type PromotionRule,
} from "../common/pricing";
import {
  OrderStatus,
  UserRole,
  ItemStatus,
  TxnStatus,
  MutationType,
  InvoiceStatus,
  PriceType,
  Prisma,
} from "@prisma/client";
import { ListOrdersDto } from "./dto/list-orders.dto";
import { CreateOrderDto } from "./dto/create-order.dto";
import { CreateSaleDto } from "./dto/create-sale.dto";
import { ChangeOrderStatusDto } from "./dto/change-order-status.dto";
import { UpdateOrderItemsDto } from "./dto/update-order-items.dto";
import { UpdateShipmentDto } from "./dto/update-shipment.dto";
import { CompleteStopDto } from "./dto/complete-stop.dto";
import {
  assertRegulatedDeliverySatisfied,
  deriveStopRegulatedRequirements,
  loadAgeIdCategorySets,
  type RegulatedDeliveryDb,
} from "../common/regulated-delivery";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { getTierPrice } from "../utils/pricing";
import { NotificationsService } from "../notifications/notifications.service";
import { InvoicesService } from "../invoices/invoices.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { InventoryService } from "../inventory/inventory.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { PromotionsService } from "../promotions/promotions.service";

@Injectable()
export class OrdersService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue("invoices") private readonly invoiceQueue: Queue,
    private readonly gateway: RouteFlowGateway,
    private readonly notifications: NotificationsService,
    private readonly invoicesService: InvoicesService,
    private readonly systemConfig: SystemConfigService,
    private readonly inventoryService: InventoryService,
    private readonly authGuard: AuthorizationGuardService,
    private readonly promotionsService: PromotionsService,
  ) {}

  /**
   * P5-04: active promotions for the current tenant (window + isActive filtered).
   * Only loaded for the buyer (CUSTOMER) self-service path; empty for staff so
   * operator/driver order pricing is byte-for-byte unchanged.
   */
  private async loadActivePromotions(role: UserRole): Promise<PromotionRule[]> {
    if (role !== UserRole.CUSTOMER) return [];
    const promos = await this.promotionsService.activeForCatalog();
    return promos.map((p) => ({
      id: p.id,
      type: p.type as PromotionRule["type"],
      value: Number(p.value),
      minQty: p.minQty,
      scope: p.scope as PromotionRule["scope"],
      category: p.category,
      productIds: p.productIds,
    }));
  }

  /**
   * P5-04: resolve a buyer catalog line's price = tier price, then the best
   * applicable promotion (net unitPrice + originalPrice strikethrough, priceType
   * PROMO). With no promo it reproduces the standard ladder (SPECIAL for tier≠1
   * with the list price as the strikethrough, else STANDARD). Boxed proration is
   * left to computeLineSubtotal by the caller — this only sets the SELLING-UNIT
   * price. `promos` is empty for staff, so this is a no-op tier resolver there.
   */
  private resolveBuyerLinePrice(
    product: { id: string; category: string | null; pricePerUnit: unknown },
    tierForProduct: number,
    promos: PromotionRule[],
    qtyPieces: number,
  ): { unitPrice: number; originalPrice: number | null; priceType: PriceType } {
    const listPrice = Number(product.pricePerUnit);
    const base = getTierPrice(product, tierForProduct);
    const promo = applyBestPromotion(base, promos, {
      productId: product.id,
      category: product.category,
      qtyPieces,
    });
    if (promo.appliedPromoId) {
      return {
        unitPrice: promo.unitPrice,
        originalPrice: promo.originalPrice,
        priceType: PriceType.PROMO,
      };
    }
    if (tierForProduct !== 1) {
      return { unitPrice: base, originalPrice: listPrice, priceType: PriceType.SPECIAL };
    }
    return { unitPrice: base, originalPrice: null, priceType: PriceType.STANDARD };
  }

  /**
   * Read the tax rate from the tenant's Settings (SystemConfig) at request time.
   * Falls back to 0 so that unconfigured tenants don't get a surprise 10% charge.
   */
  private async getTaxRate(): Promise<number> {
    const stored = await this.systemConfig.get("settings.taxRate");
    if (stored !== null && stored !== "") return parseFloat(stored);
    return 0;
  }

  async findAll(query: ListOrdersDto, user: JwtPayload) {
    const {
      customerId,
      search,
      status,
      urgent,
      page = 1,
      limit = 20,
      deliveryDateFrom,
      deliveryDateTo,
    } = query;
    const skip = (page - 1) * limit;
    const where: any = {};

    if (user.role === UserRole.CUSTOMER) {
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer) throw new ForbiddenException("Customer record not found");
      where.customerId = customer.id;
    } else if (customerId) {
      where.customerId = customerId;
    } else if (search) {
      where.customer = { businessName: { contains: search, mode: "insensitive" } };
    }

    if (status) where.status = status;
    if (urgent !== undefined) where.urgent = urgent;
    if (deliveryDateFrom || deliveryDateTo) {
      where.requestedDeliveryDate = {
        ...(deliveryDateFrom ? { gte: new Date(deliveryDateFrom) } : {}),
        ...(deliveryDateTo ? { lte: new Date(deliveryDateTo) } : {}),
      };
    }

    const [data, total] = await Promise.all([
      this.prisma.forTenant().order.findMany({
        where,
        include: {
          customer: { select: { id: true, businessName: true } },
          lineItems: { include: { product: { select: { id: true, name: true, unit: true } } } },
        },
        skip,
        take: limit,
        orderBy: { createdAt: "desc" },
      }),
      this.prisma.forTenant().order.count({ where }),
    ]);

    return { data, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
  }

  async findOne(id: string, user: JwtPayload) {
    const order = await this.prisma.forTenant().order.findUnique({
      where: { id },
      include: {
        customer: {
          select: {
            id: true,
            businessName: true,
            contactName: true,
            phone: true,
            mobile: true,
            email: true,
          },
        },
        // Include `unitsPerBox` + `pricePerUnit` so the mobile/web edit UIs
        // can render the boxes/pieces split for boxed products and recompute
        // line subtotals locally without a second roundtrip. `averageCost` +
        // `category` feed the live cost/margin hint + floor in the edit builder
        // (pos-cost-roles-spec §1).
        lineItems: {
          include: {
            product: {
              select: {
                id: true,
                name: true,
                unit: true,
                unitsPerBox: true,
                pricePerUnit: true,
                averageCost: true,
                category: true,
              },
            },
          },
          // Stable creation order so newly scanned items append at the bottom.
          orderBy: { createdAt: "asc" },
        },
        transaction: true,
        invoices: { select: { id: true, invoiceNumber: true, status: true, total: true } },
      },
    });
    if (!order) throw new NotFoundException("Order not found");

    if (user.role === UserRole.CUSTOMER) {
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer || customer.id !== order.customerId) throw new ForbiddenException();
    }

    return order;
  }

  /**
   * Return the last-given (discounted) unitPrice per product for a customer.
   * Only lines where originalPrice is set are returned — those are the lines
   * where an operator gave a one-time price below the catalog price.
   * Used by the order-creation UI to pre-fill the price field on scan.
   *
   * P5-04: PROMO lines are excluded — a promotion's net price is transient
   * (window-bound) and must NOT become the customer's remembered operator price,
   * or an expired promo price would silently pre-fill future operator orders.
   */
  async getCustomerPriceHistory(
    tenantId: string,
    customerId: string,
  ): Promise<Record<string, { lastPrice: number; listPriceAtTime: number }>> {
    const items = await this.prisma.orderItem.findMany({
      where: {
        order: {
          customerId,
          tenantId,
          status: { notIn: [OrderStatus.CANCELLED] },
        },
        originalPrice: { not: null },
        priceType: { not: PriceType.PROMO },
      },
      // Order by updatedAt so the MOST RECENTLY SAVED override wins — editing a
      // line's price on any order and saving makes it the customer's remembered
      // price for future orders (and re-editing later supersedes it).
      orderBy: { updatedAt: "desc" },
      distinct: ["productId"],
      select: {
        productId: true,
        unitPrice: true,
        originalPrice: true,
      },
    });

    return Object.fromEntries(
      items.map((item) => [
        item.productId,
        {
          lastPrice: roundMoney(Number(item.unitPrice)),
          listPriceAtTime: roundMoney(Number(item.originalPrice)),
        },
      ]),
    );
  }

  /**
   * Find the most recent active (DRAFT/PENDING) order for a customer.
   * Used by the buyer portal to merge new items into an existing order.
   */
  async findActiveOrder(customerId: string) {
    // Orders flagged skipAutoMerge are intentionally kept separate by an operator —
    // do NOT propose them as a merge target. The next operator-initiated create for
    // the same customer should still see no "active" order to merge into.
    return this.prisma.forTenant().order.findFirst({
      where: {
        customerId,
        status: { in: [OrderStatus.DRAFT, OrderStatus.PENDING] },
        skipAutoMerge: false,
      },
      include: {
        lineItems: {
          where: { status: { not: ItemStatus.CANCELLED } },
          include: { product: { select: { id: true, name: true, unit: true } } },
        },
        customer: { select: { id: true, businessName: true } },
      },
      orderBy: { createdAt: "desc" },
    });
  }

  /**
   * Consolidate every unassigned PENDING order for a customer into a single
   * "winner" order. The most-recent order is the winner so its unitPrices are
   * the latest. Older orders' line items are folded in (qtys summed when the
   * productId already exists on the winner; new productIds copied over with
   * the most-recent older order's price/metadata). Older orders are then
   * deleted.
   *
   * Skips orders already attached to a route run, with invoices, transactions,
   * or returns — those are already part of an in-flight delivery flow and
   * must not be silently consolidated.
   *
   * Idempotent: when there is 0 or 1 mergeable order, returns it (or null)
   * without writing.
   */

  /**
   * Combine one or more contributing order lines for the SAME product into a
   * single merged line total. Boxed products price by the BOX, so every
   * contribution is normalized to a total PIECE count first, then re-split and
   * priced via `computeLineSubtotal` — a plain `qty * unitPrice` over-charges a
   * boxed line by `unitsPerBox`. Handles mixed denominations: a box-split line
   * (`boxes`/`pieces` set) stores `qty` as pieces; a selling-unit boxed line
   * (`boxes==null`, from the box-unaware mobile cart) stores `qty` as a box
   * count, so its pieces are `qty * unitsPerBox`. The merged line is always
   * emitted piece-denominated (heals the inconsistency). Non-boxed products fall
   * back to a simple qty sum × unit price.
   */
  private mergeBoxedContributions(
    contributions: Array<{ qty: unknown; boxes: number | null; pieces: number | null }>,
    unitPrice: number,
    unitsPerBox: number | null | undefined,
  ): { qty: number; boxes: number | null; pieces: number | null; subtotal: number } {
    const upb = Number(unitsPerBox ?? 0);
    const totalPieces = contributions.reduce((sum, c) => {
      const q = Number(c.qty);
      const sellingUnit = upb > 1 && c.boxes == null && c.pieces == null;
      return sum + (sellingUnit ? q * upb : q);
    }, 0);
    if (upb > 1) {
      const split = normalizeBoxesPieces({ qty: totalPieces, unitsPerBox: upb });
      return {
        qty: split.qty,
        boxes: split.boxes,
        pieces: split.pieces,
        subtotal: computeLineSubtotal({
          unitPrice,
          qty: split.qty,
          boxes: split.boxes,
          pieces: split.pieces,
          unitsPerBox: upb,
        }),
      };
    }
    return {
      qty: totalPieces,
      boxes: null,
      pieces: null,
      subtotal: computeLineSubtotal({ unitPrice, qty: totalPieces }),
    };
  }

  async mergeAllPendingForCustomer(customerId: string) {
    const pendingOrders = await this.prisma.forTenant().order.findMany({
      where: {
        customerId,
        status: OrderStatus.PENDING,
        routeRunId: null,
        routeRunStopId: null,
        transaction: { is: null },
        invoices: { none: {} },
        returns: { none: {} },
        skipAutoMerge: false,
      },
      include: {
        lineItems: {
          where: { status: { not: ItemStatus.CANCELLED } },
        },
      },
      orderBy: { updatedAt: "desc" },
    });

    if (pendingOrders.length <= 1) {
      return pendingOrders[0] ?? null;
    }

    const [winner, ...losers] = pendingOrders;
    const winnerProductIds = new Set(winner.lineItems.map((li) => li.productId));

    // Collect each loser catalog line's raw fields per product so boxed lines
    // can be re-prorated by piece count (see mergeBoxedContributions), not a
    // naive qty sum. Iteration is updatedAt DESC so the first occurrence wins on
    // price/metadata.
    const loserContribsByProduct = new Map<
      string,
      Array<{ qty: unknown; boxes: number | null; pieces: number | null }>
    >();
    const newItemMetaByProduct = new Map<
      string,
      {
        unitPrice: number;
        priceType: PriceType;
        originalPrice: number | null;
        overrideReason: string | null;
        overriddenBy: string | null;
        notes: string | null;
        trackedCategoryId: string | null;
      }
    >();
    // Unlisted (catalog-free) loser lines can't be keyed by product — each is
    // appended to the winner as its own new line (never boxed).
    const unlistedNewItems: Array<{
      name: string | null;
      qty: number;
      unitPrice: number;
      priceType: PriceType;
      originalPrice: number | null;
      overrideReason: string | null;
      overriddenBy: string | null;
      notes: string | null;
    }> = [];

    for (const loser of losers) {
      for (const li of loser.lineItems) {
        if (!li.productId) {
          unlistedNewItems.push({
            name: li.name,
            qty: Number(li.qty),
            unitPrice: Number(li.unitPrice),
            priceType: li.priceType,
            originalPrice: li.originalPrice !== null ? Number(li.originalPrice) : null,
            overrideReason: li.overrideReason,
            overriddenBy: li.overriddenBy,
            notes: li.notes,
          });
          continue;
        }
        const contribs = loserContribsByProduct.get(li.productId) ?? [];
        contribs.push({ qty: li.qty, boxes: li.boxes, pieces: li.pieces });
        loserContribsByProduct.set(li.productId, contribs);
        if (!winnerProductIds.has(li.productId) && !newItemMetaByProduct.has(li.productId)) {
          newItemMetaByProduct.set(li.productId, {
            unitPrice: Number(li.unitPrice),
            priceType: li.priceType,
            originalPrice: li.originalPrice !== null ? Number(li.originalPrice) : null,
            overrideReason: li.overrideReason,
            overriddenBy: li.overriddenBy,
            notes: li.notes,
            // Carry the loser line's sale-time regulated-category snapshot so the
            // new winner line keeps it (invoice split + ledger depend on it).
            trackedCategoryId: li.trackedCategoryId ?? null,
          });
        }
      }
    }

    // unitsPerBox for every product involved so boxed lines prorate by the box.
    const involvedProductIds = [
      ...new Set(
        [...winner.lineItems, ...losers.flatMap((l) => l.lineItems)]
          .map((li) => li.productId)
          .filter((id): id is string => !!id),
      ),
    ];
    const upbByProduct = new Map<string, number>();
    if (involvedProductIds.length > 0) {
      const prods = await this.prisma.forTenant().product.findMany({
        where: { id: { in: involvedProductIds } },
        select: { id: true, unitsPerBox: true },
      });
      for (const p of prods) upbByProduct.set(p.id, Number(p.unitsPerBox ?? 0));
    }

    const taxRate = await this.getTaxRate();

    await this.prisma.tenantTransaction(async (tx) => {
      // 1. Bump winner catalog lines that overlap losers — re-prorate boxed lines
      //    from the combined piece count (never a naive newQty * unitPrice).
      for (const li of winner.lineItems) {
        if (!li.productId) continue;
        const loserContribs = loserContribsByProduct.get(li.productId);
        if (!loserContribs || loserContribs.length === 0) continue;
        const merged = this.mergeBoxedContributions(
          [{ qty: li.qty, boxes: li.boxes, pieces: li.pieces }, ...loserContribs],
          Number(li.unitPrice),
          upbByProduct.get(li.productId),
        );
        await tx.orderItem.update({
          where: { id: li.id },
          data: {
            qty: merged.qty,
            boxes: merged.boxes,
            pieces: merged.pieces,
            subtotal: merged.subtotal,
          },
        });
      }

      // 2. Create winner items for productIds that were only on losers.
      for (const [productId, meta] of newItemMetaByProduct.entries()) {
        const merged = this.mergeBoxedContributions(
          loserContribsByProduct.get(productId) ?? [],
          meta.unitPrice,
          upbByProduct.get(productId),
        );
        await tx.orderItem.create({
          data: {
            orderId: winner.id,
            productId,
            qty: merged.qty,
            boxes: merged.boxes,
            pieces: merged.pieces,
            unitPrice: meta.unitPrice,
            subtotal: merged.subtotal,
            status: ItemStatus.PENDING,
            priceType: meta.priceType,
            originalPrice: meta.originalPrice,
            overrideReason: meta.overrideReason,
            overriddenBy: meta.overriddenBy,
            notes: meta.notes,
            // Preserve the regulated-category snapshot through the merge (was
            // dropped, so a merged regulated line invoiced as standard).
            trackedCategoryId: meta.trackedCategoryId,
          },
        });
      }

      // 2b. Append unlisted loser lines as fresh winner lines.
      for (const data of unlistedNewItems) {
        await tx.orderItem.create({
          data: {
            orderId: winner.id,
            productId: null,
            name: data.name,
            qty: data.qty,
            unitPrice: data.unitPrice,
            subtotal: roundMoney(data.qty * data.unitPrice),
            status: ItemStatus.PENDING,
            priceType: data.priceType,
            originalPrice: data.originalPrice,
            overrideReason: data.overrideReason,
            overriddenBy: data.overriddenBy,
            notes: data.notes,
          },
        });
      }

      // 3. Drop loser orders and their items.
      for (const loser of losers) {
        await tx.orderItem.deleteMany({ where: { orderId: loser.id } });
        await tx.order.delete({ where: { id: loser.id } });
      }

      // 4. Recompute winner totals.
      const activeItems = await tx.orderItem.findMany({
        where: { orderId: winner.id, status: { not: ItemStatus.CANCELLED } },
      });
      const subtotal = roundMoney(
        activeItems.reduce((s: number, li: any) => s + Number(li.subtotal), 0),
      );
      const tax = roundMoney(subtotal * taxRate);
      await tx.order.update({
        where: { id: winner.id },
        data: {
          subtotal,
          tax,
          total: roundMoney(subtotal + tax),
          // A merged-in regulated line flips the denormalized flag on.
          hasRegulated: activeItems.some((li: any) => li.trackedCategoryId != null),
        },
      });
    });

    this.logger.log(
      `Merged ${losers.length} PENDING order(s) into ${winner.id} for customer ${customerId}`,
    );

    return this.prisma.forTenant().order.findUnique({
      where: { id: winner.id },
      include: {
        customer: { select: { id: true, businessName: true } },
        lineItems: {
          include: { product: { select: { id: true, name: true, unit: true } } },
        },
      },
    });
  }

  async forceConsolidateCustomer(customerId: string) {
    const orders = await this.prisma.forTenant().order.findMany({
      where: { customerId, status: OrderStatus.PENDING },
      include: { lineItems: { where: { status: { not: ItemStatus.CANCELLED } } } },
      orderBy: { updatedAt: "desc" },
    });
    if (orders.length <= 1) return orders[0] ?? null;

    const [winner, ...losers] = orders;

    // If winner has no route assignment but losers do, promote the first loser's assignment.
    const routeAssignment =
      winner.routeRunId == null ? (losers.find((o) => o.routeRunId != null) ?? null) : null;

    const winnerProductIds = new Set(winner.lineItems.map((li) => li.productId));
    const loserContribsByProduct = new Map<
      string,
      Array<{ qty: unknown; boxes: number | null; pieces: number | null }>
    >();
    const newItemMetaByProduct = new Map<
      string,
      {
        unitPrice: number;
        priceType: PriceType;
        originalPrice: number | null;
        overrideReason: string | null;
        overriddenBy: string | null;
        notes: string | null;
        trackedCategoryId: string | null;
      }
    >();
    // Unlisted (catalog-free) loser lines are appended as their own winner lines.
    const unlistedNewItems: Array<{
      name: string | null;
      qty: number;
      unitPrice: number;
      priceType: PriceType;
      originalPrice: number | null;
      overrideReason: string | null;
      overriddenBy: string | null;
      notes: string | null;
    }> = [];

    for (const loser of losers) {
      for (const li of loser.lineItems) {
        if (!li.productId) {
          unlistedNewItems.push({
            name: li.name,
            qty: Number(li.qty),
            unitPrice: Number(li.unitPrice),
            priceType: li.priceType,
            originalPrice: li.originalPrice !== null ? Number(li.originalPrice) : null,
            overrideReason: li.overrideReason,
            overriddenBy: li.overriddenBy,
            notes: li.notes,
          });
          continue;
        }
        const contribs = loserContribsByProduct.get(li.productId) ?? [];
        contribs.push({ qty: li.qty, boxes: li.boxes, pieces: li.pieces });
        loserContribsByProduct.set(li.productId, contribs);
        if (!winnerProductIds.has(li.productId) && !newItemMetaByProduct.has(li.productId)) {
          newItemMetaByProduct.set(li.productId, {
            unitPrice: Number(li.unitPrice),
            priceType: li.priceType,
            originalPrice: li.originalPrice !== null ? Number(li.originalPrice) : null,
            overrideReason: li.overrideReason,
            overriddenBy: li.overriddenBy,
            notes: li.notes,
            // Carry the loser line's sale-time regulated-category snapshot so the
            // new winner line keeps it (invoice split + ledger depend on it).
            trackedCategoryId: li.trackedCategoryId ?? null,
          });
        }
      }
    }

    // unitsPerBox for every product involved so boxed lines prorate by the box.
    const involvedProductIds = [
      ...new Set(
        [...winner.lineItems, ...losers.flatMap((l) => l.lineItems)]
          .map((li) => li.productId)
          .filter((id): id is string => !!id),
      ),
    ];
    const upbByProduct = new Map<string, number>();
    if (involvedProductIds.length > 0) {
      const prods = await this.prisma.forTenant().product.findMany({
        where: { id: { in: involvedProductIds } },
        select: { id: true, unitsPerBox: true },
      });
      for (const p of prods) upbByProduct.set(p.id, Number(p.unitsPerBox ?? 0));
    }

    const taxRate = await this.getTaxRate();

    await this.prisma.tenantTransaction(async (tx) => {
      for (const li of winner.lineItems) {
        if (!li.productId) continue;
        const loserContribs = loserContribsByProduct.get(li.productId);
        if (!loserContribs || loserContribs.length === 0) continue;
        const merged = this.mergeBoxedContributions(
          [{ qty: li.qty, boxes: li.boxes, pieces: li.pieces }, ...loserContribs],
          Number(li.unitPrice),
          upbByProduct.get(li.productId),
        );
        await tx.orderItem.update({
          where: { id: li.id },
          data: {
            qty: merged.qty,
            boxes: merged.boxes,
            pieces: merged.pieces,
            subtotal: merged.subtotal,
          },
        });
      }
      for (const [productId, meta] of newItemMetaByProduct.entries()) {
        const merged = this.mergeBoxedContributions(
          loserContribsByProduct.get(productId) ?? [],
          meta.unitPrice,
          upbByProduct.get(productId),
        );
        await tx.orderItem.create({
          data: {
            orderId: winner.id,
            productId,
            qty: merged.qty,
            boxes: merged.boxes,
            pieces: merged.pieces,
            unitPrice: meta.unitPrice,
            subtotal: merged.subtotal,
            status: ItemStatus.PENDING,
            priceType: meta.priceType,
            originalPrice: meta.originalPrice,
            overrideReason: meta.overrideReason,
            overriddenBy: meta.overriddenBy,
            notes: meta.notes,
            // Preserve the regulated-category snapshot through the merge (was
            // dropped, so a merged regulated line invoiced as standard).
            trackedCategoryId: meta.trackedCategoryId,
          },
        });
      }
      for (const data of unlistedNewItems) {
        await tx.orderItem.create({
          data: {
            orderId: winner.id,
            productId: null,
            name: data.name,
            qty: data.qty,
            unitPrice: data.unitPrice,
            subtotal: roundMoney(data.qty * data.unitPrice),
            status: ItemStatus.PENDING,
            priceType: data.priceType,
            originalPrice: data.originalPrice,
            overrideReason: data.overrideReason,
            overriddenBy: data.overriddenBy,
            notes: data.notes,
          },
        });
      }
      for (const loser of losers) {
        // Remove a loser's pending mirror draft (and its items) before deleting
        // the order so the Invoice→Order FK doesn't block. A SENT invoice on a
        // loser is a real bill — leave it, so order.delete FK-fails rather than
        // silently dropping a billed order (preserves prior safety).
        const loserDraft = await this.invoicesService.findOpenOrderDraft(loser.id, tx);
        if (loserDraft) {
          await tx.invoiceItem.deleteMany({ where: { invoiceId: loserDraft.id } });
          await tx.invoice.delete({ where: { id: loserDraft.id } });
        }
        await tx.orderItem.deleteMany({ where: { orderId: loser.id } });
        await tx.order.delete({ where: { id: loser.id } });
      }
      const activeItems = await tx.orderItem.findMany({
        where: { orderId: winner.id, status: { not: ItemStatus.CANCELLED } },
      });
      const subtotal = roundMoney(
        activeItems.reduce((s: number, li: any) => s + Number(li.subtotal), 0),
      );
      const tax = roundMoney(subtotal * taxRate);
      const routeUpdate = routeAssignment
        ? { routeRunId: routeAssignment.routeRunId, routeRunStopId: routeAssignment.routeRunStopId }
        : {};
      await tx.order.update({
        where: { id: winner.id },
        data: {
          subtotal,
          tax,
          total: roundMoney(subtotal + tax),
          // A merged-in regulated line flips the denormalized flag on.
          hasRegulated: activeItems.some((li: any) => li.trackedCategoryId != null),
          ...routeUpdate,
        },
      });
      // If the winner carries a pending mirror draft, re-sync it to the merged lines.
      await this.invoicesService.reconcileOrderDraftInvoice(winner.id, { basis: "order", tx });
    });

    this.logger.log(
      `forceConsolidateCustomer: merged ${losers.length} order(s) into ${winner.id} for customer ${customerId}`,
    );
    return this.prisma.forTenant().order.findUnique({
      where: { id: winner.id },
      include: {
        customer: { select: { id: true, businessName: true } },
        lineItems: {
          include: { product: { select: { id: true, name: true, unit: true } } },
        },
      },
    });
  }

  async sweepAllPendingOrders(): Promise<{ customers: number; merged: number }> {
    const groups = await this.prisma.forTenant().order.groupBy({
      by: ["customerId"],
      where: {
        status: OrderStatus.PENDING,
        routeRunId: null,
        routeRunStopId: null,
        transaction: { is: null },
        invoices: { none: {} },
        returns: { none: {} },
        skipAutoMerge: false,
      },
      _count: { _all: true },
      having: { customerId: { _count: { gt: 1 } } },
    });

    let merged = 0;
    for (const g of groups) {
      const winner = await this.mergeAllPendingForCustomer(g.customerId);
      if (winner) merged++;
    }
    this.logger.log(
      `sweepAllPendingOrders: swept ${groups.length} customer(s), merged into ${merged} winner(s)`,
    );
    return { customers: groups.length, merged };
  }

  onApplicationBootstrap() {
    // Fire-and-forget: don't block HTTP server startup while sweeping.
    this.sweepAllPendingOrders()
      .then((result) => {
        if (result.customers > 0) {
          this.logger.log(
            `Startup sweep: merged duplicate PENDING orders for ${result.customers} customer(s)`,
          );
        }
      })
      .catch((err) => {
        this.logger.error("Startup sweep failed", err instanceof Error ? err.stack : String(err));
      });
  }

  @Cron("0 * * * *")
  async cronSweepPendingOrders() {
    try {
      await this.sweepAllPendingOrders();
    } catch (err) {
      this.logger.error("Hourly sweep failed", err instanceof Error ? err.stack : String(err));
    }
  }

  async create(dto: CreateOrderDto, user: JwtPayload, options: { skipAutoMerge?: boolean } = {}) {
    // Resolve which customer this order is for
    let customerId: string;

    const isStaffRole = user.role === UserRole.OPERATOR || user.role === UserRole.TENANT_ADMIN;
    if (isStaffRole) {
      // Operator/TENANT_ADMIN creates on behalf of a customer — customerId comes from the DTO
      if (!dto.customerId) throw new BadRequestException("customerId is required");
      const customer = await this.prisma.forTenant().customer.findUnique({
        where: { id: dto.customerId },
        include: { user: { select: { status: true } } },
      });
      if (!customer) throw new BadRequestException("Customer not found");
      if (customer.user.status === "SUSPENDED")
        throw new BadRequestException("Cannot create orders for a suspended customer");
      customerId = customer.id;
    } else if (user.role === UserRole.DRIVER) {
      // Driver creates on behalf of a customer (e.g. at a stop) — customerId must be supplied
      if (!dto.customerId) throw new BadRequestException("customerId is required");
      const customer = await this.prisma
        .forTenant()
        .customer.findUnique({ where: { id: dto.customerId } });
      if (!customer) throw new BadRequestException("Customer not found");
      customerId = customer.id;
    } else {
      // Customer creates their own order
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer) throw new ForbiddenException("Customer record not found");
      customerId = customer.id;
    }

    const isDraft = dto.status === "DRAFT";
    const items = dto.items ?? [];

    // Non-draft orders require at least one item
    if (!isDraft && items.length === 0) {
      throw new BadRequestException("At least one item is required");
    }

    // Load customer's pricing tier
    const customerRecord = await this.prisma
      .forTenant()
      .customer.findUnique({ where: { id: customerId }, select: { pricingTier: true } });
    const defaultTier = customerRecord?.pricingTier ?? 1;

    // Unlisted (ad-hoc) lines have no productId — only fetch catalog rows for the
    // lines that reference a real product.
    const catalogIds = items.map((i) => i.productId).filter(Boolean) as string[];
    const products =
      catalogIds.length > 0
        ? await this.prisma.forTenant().product.findMany({
            where: { id: { in: catalogIds } },
          })
        : [];

    const productMap = new Map(products.map((p) => [p.id, p]));

    // Unlisted lines are operator/driver-only corrections — never accept them from a buyer.
    if (user.role === UserRole.CUSTOMER && items.some((i) => !i.productId)) {
      throw new BadRequestException("Custom (unlisted) items can only be added by staff");
    }

    // Load any per-product tier overrides for this customer
    const customerPrices =
      catalogIds.length > 0
        ? await this.prisma.forTenant().customerPrice.findMany({
            where: {
              customerId,
              productId: { in: catalogIds },
            },
          })
        : [];
    const cpMap = new Map(customerPrices.map((cp) => [cp.productId, cp.pricingTier]));

    // P5-04: active promotions — only for the buyer (CUSTOMER) self-service path.
    const activePromos = await this.loadActivePromotions(user.role);

    // RF-198: price-race check — buyer cart may have been built with a stale price.
    // Re-fetch (already done above) and compare against the cart unitPrice for each item.
    // Only applies when the CUSTOMER role sends unitPrice values (buyer portal checkout).
    if (user.role === UserRole.CUSTOMER && items.some((i) => i.unitPrice != null)) {
      const changedItems: Array<{
        productId: string;
        name: string;
        cartPrice: number;
        currentPrice: number;
      }> = [];
      for (const item of items) {
        if (item.unitPrice == null || !item.productId) continue;
        const product = productMap.get(item.productId);
        if (!product) continue; // missing product caught in lineItemsData.map below
        const tierForProduct = cpMap.get(item.productId) ?? defaultTier;
        const currentPrice = Number(getTierPrice(product, tierForProduct));
        if (Math.abs(currentPrice - item.unitPrice) > 0.01) {
          changedItems.push({
            productId: item.productId,
            name: product.name,
            cartPrice: item.unitPrice,
            currentPrice,
          });
        }
      }
      if (changedItems.length > 0) {
        throw new ConflictException({
          message: "Prices have been updated. Please review your cart.",
          changedItems,
        });
      }
    }

    let subtotal = 0;
    const lineItemsData = items.map((item) => {
      // Unlisted (ad-hoc) line: no catalog product. The operator supplies a
      // free-text name + unitPrice; we store it as a MANUAL-priced line with no
      // stock impact and no boxed proration.
      if (!item.productId) {
        const name = (item.name ?? "").trim();
        if (!name) throw new BadRequestException("Unlisted item requires a name");
        if (item.unitPrice == null)
          throw new BadRequestException("Unlisted item requires a unit price");
        const itemSubtotal = computeLineSubtotal({ unitPrice: item.unitPrice, qty: item.qty });
        subtotal += itemSubtotal;
        return {
          productId: null as string | null,
          name,
          qty: item.qty,
          boxes: null as number | null,
          pieces: null as number | null,
          unitPrice: item.unitPrice,
          priceType: PriceType.MANUAL,
          originalPrice: null as number | null,
          subtotal: itemSubtotal,
          notes: (item as any).itemNote || item.notes,
          // Phase 4 (W4): unlisted lines are never catalog products → never regulated.
          trackedCategoryId: null as string | null,
          categoryTaxAmount: 0,
          tenantId: this.prisma.getTenantId(),
        };
      }

      const product = productMap.get(item.productId);
      if (!product) throw new BadRequestException(`Product ${item.productId} not found`);

      // Recompute qty from boxes/pieces when provided (backend is authoritative).
      // Normalize to integers and roll loose pieces >= unitsPerBox into boxes.
      let qty = item.qty;
      let boxes = item.boxes ?? null;
      let pieces = item.pieces ?? null;
      if (item.boxes != null || item.pieces != null) {
        const split = normalizeBoxesPieces({
          boxes: item.boxes,
          pieces: item.pieces,
          unitsPerBox: product.unitsPerBox,
        });
        qty = split.qty;
        boxes = split.boxes;
        pieces = split.pieces;
      }

      // Resolve tier: per-product override > customer default tier
      const tierForProduct = cpMap.get(item.productId) ?? defaultTier;
      const listPrice = Number(product.pricePerUnit); // tier 1 = list price
      const overridePrice = item.unitPrice;

      let unitPrice: number;
      let priceType: PriceType;
      let originalPrice: number | null = null;

      // Price priority: operator one-time override (DISCOUNTED) > best buyer
      // promotion (PROMO) / tier price (SPECIAL) / list price (STANDARD). Promos
      // populate `activePromos` only on the buyer (CUSTOMER) path (P5-04); staff
      // orders get [] so this reproduces the prior tier/standard ladder exactly.
      // `qty` here is the normalized total PIECES — the QTY_BREAK threshold basis.
      if (overridePrice != null && overridePrice < listPrice) {
        unitPrice = overridePrice;
        priceType = PriceType.DISCOUNTED;
        originalPrice = listPrice;
      } else {
        const resolved = this.resolveBuyerLinePrice(product, tierForProduct, activePromos, qty);
        unitPrice = resolved.unitPrice;
        priceType = resolved.priceType;
        originalPrice = resolved.originalPrice;
      }

      // For boxed products `unitPrice` is the BOX price; loose pieces are
      // prorated. See apps/api/src/common/pricing.ts for the full reasoning.
      const itemSubtotal = computeLineSubtotal({
        unitPrice,
        qty,
        boxes,
        pieces,
        unitsPerBox: product.unitsPerBox,
      });
      subtotal += itemSubtotal;
      return {
        productId: item.productId as string | null,
        name: null as string | null,
        qty,
        boxes,
        pieces,
        unitPrice,
        priceType,
        originalPrice,
        subtotal: itemSubtotal,
        notes: (item as any).itemNote || item.notes,
        // Phase 4 (W4): snapshot the product's regulated category at sale time so
        // invoice generation can split by it (never re-read the live product —
        // categories can be reassigned/deactivated after sale, spec §7).
        // categoryTaxAmount stays 0 until the order-total follow-up lifts the
        // rate>0 invoice guard (tobacco, the only current category, is rate=0).
        trackedCategoryId: (product.trackedCategoryId ?? null) as string | null,
        categoryTaxAmount: 0,
        tenantId: this.prisma.getTenantId(), // nested creates bypass forTenant() extension
      };
    });

    subtotal = roundMoney(subtotal);
    const orderDiscount = dto.discountAmount ?? 0;
    const tax = roundMoney(subtotal * (await this.getTaxRate()));
    const total = roundMoney(subtotal + tax - orderDiscount);

    // W6: license guard — a real (non-draft) sale of a license-required category to
    // a customer without a VERIFIED authorization (or active §8 override) throws a
    // structured 409 BEFORE the stock transaction, so nothing is half-committed.
    // Tobacco (requiresLicense=false) is never gated — its warn-only flow is intact.
    if (!isDraft) {
      await this.authGuard.assertAuthorizedOrThrow({
        customerId,
        lines: lineItemsData.map((li) => ({ trackedCategoryId: li.trackedCategoryId })),
      });
    }

    // RF-017 + RF-014: create the order inside a transaction so we can
    // (a) hold a pessimistic lock on product rows while checking/decrementing
    //     stock, preventing concurrent oversell, and
    // (b) retry on P2002 if two requests race to the same order number.
    const MAX_RETRIES = 3;
    let order: any;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        order = await this.prisma.tenantTransaction(async (tx) => {
          // RF-017: stock validation — only for non-draft orders that have items.
          // Lock product rows first so concurrent requests serialise here.
          // Operators (and TENANT_ADMINs) are explicitly allowed to oversell — they may
          // be backordering or knowingly placing an order that will be fulfilled when
          // restocked. The customer / driver paths still hard-block on insufficient stock.
          // Unlisted lines have no productId — they never touch stock.
          const stockLines = lineItemsData.filter(
            (li): li is typeof li & { productId: string } => !!li.productId,
          );
          if (!isDraft && stockLines.length > 0) {
            const productIds = stockLines.map((li) => li.productId);
            // SELECT … FOR UPDATE acquires row-level locks in the current transaction.
            await tx.$executeRaw`
              SELECT id FROM "Product"
              WHERE id IN (${Prisma.join(productIds)})
              FOR UPDATE
            `;

            const lockedProducts = await tx.product.findMany({
              where: { id: { in: productIds } },
              select: { id: true, name: true, currentStock: true },
            });

            const oosItems: string[] = [];
            for (const li of stockLines) {
              const p = lockedProducts.find((lp) => lp.id === li.productId);
              if (p && Number(p.currentStock) < li.qty) {
                oosItems.push(
                  `${productMap.get(li.productId)?.name ?? li.productId}` +
                    ` (available: ${Number(p.currentStock)}, requested: ${li.qty})`,
                );
              }
            }
            if (oosItems.length > 0) {
              if (isStaffRole) {
                this.logger.warn(
                  `Operator-initiated order will go below stock: ${oosItems.join("; ")}`,
                );
              } else {
                throw new ConflictException(`Insufficient stock: ${oosItems.join("; ")}`);
              }
            }

            // Decrement stock atomically while the lock is held. For operator-initiated
            // overselling, this lets currentStock go negative — the inventory page can
            // surface that and the operator can reconcile after restock.
            for (const li of stockLines) {
              await tx.product.update({
                where: { id: li.productId },
                data: { currentStock: { decrement: li.qty } },
              });
            }
          }

          // RF-014: generate order number inside the transaction so a P2002 on
          // the @@unique([tenantId, orderNumber]) constraint can be caught and
          // retried with a fresh sequence value.
          const lastOrder = await tx.order.findFirst({
            where: { orderNumber: { startsWith: "ORD-" } },
            orderBy: { orderNumber: "desc" },
            select: { orderNumber: true },
          });
          const seq = lastOrder?.orderNumber
            ? parseInt(lastOrder.orderNumber.replace("ORD-", ""), 10) + 1
            : 1;
          const orderNumber = `ORD-${String(Number.isFinite(seq) ? seq : 1).padStart(5, "0")}`;

          return tx.order.create({
            data: {
              customerId,
              orderNumber,
              status: isDraft ? OrderStatus.DRAFT : OrderStatus.PENDING,
              subtotal,
              tax,
              total,
              discountAmount: orderDiscount,
              notes: dto.notes,
              urgent: dto.urgent ?? false,
              skipAutoMerge: options.skipAutoMerge ?? false,
              // Phase 4 (W4): denormalized flag — true when any line is regulated.
              hasRegulated: lineItemsData.some((li) => li.trackedCategoryId != null),
              requestedDeliveryDate: dto.requestedDeliveryDate
                ? new Date(dto.requestedDeliveryDate)
                : undefined,
              lineItems: { create: lineItemsData },
            },
            include: {
              customer: { select: { id: true, businessName: true } },
              lineItems: {
                include: { product: { select: { id: true, name: true, unit: true } } },
              },
            },
          });
        });
        break; // transaction succeeded
      } catch (e: any) {
        // Retry only on orderNumber unique-constraint violations (RF-014);
        // propagate all other errors immediately (including ConflictException
        // for OOS items from RF-017).
        if (e?.code === "P2002" && attempt < MAX_RETRIES - 1) continue;
        throw e;
      }
    }

    // If driver is creating at a stop, link order to route run and optionally confirm it
    if (dto.routeRunId || dto.routeRunStopId) {
      await this.prisma.forTenant().order.update({
        where: { id: order.id },
        data: {
          routeRunId: dto.routeRunId ?? null,
          routeRunStopId: dto.routeRunStopId ?? null,
          status: dto.immediateDelivery ? OrderStatus.CONFIRMED : order.status,
        },
      });
      if (dto.immediateDelivery) {
        order.status = OrderStatus.CONFIRMED;
      }
    }

    // Don't emit real-time events for draft orders
    if (!isDraft) {
      this.gateway.emitOrderCreated(this.prisma.getTenantId(), {
        orderId: order.id,
        orderNumber: order.orderNumber ?? "",
        customerId: order.customerId,
        customerName: order.customer.businessName,
        total: Number(order.total),
        urgent: order.urgent,
        createdAt: order.createdAt.toISOString(),
      });

      if (order.urgent) {
        this.gateway.emitUrgentOrder(this.prisma.getTenantId(), {
          orderId: order.id,
          orderNumber: order.orderNumber ?? "",
          customerId: order.customerId,
          customerName: order.customer.businessName,
          placedAt: order.createdAt.toISOString(),
        });
      }
    }

    return order;
  }

  /**
   * Create a "sale" = an Order plus its Invoice in one step (the operator "bill now" flow).
   * This is what backs the invoice screen's "New sale" option, guaranteeing that every such
   * invoice is tied to an order (no floating invoices).
   *
   *  - deliveredNow=true  → mark the order DELIVERED and issue the invoice (SENT) — van/cash sale.
   *  - deliveredNow=false → leave the order PENDING with a DRAFT invoice linked; send now only if
   *                         dto.send is set, otherwise it stays a draft until the order is delivered.
   *
   * The order is always created in isolation (skipAutoMerge) so a discrete sale never folds into an
   * existing open order.
   */
  async createSale(dto: CreateSaleDto, user: JwtPayload) {
    // 1. Create the backing order (reuses pricing tiers/overrides + stock lock/decrement).
    const order = await this.create(
      {
        customerId: dto.customerId,
        items: dto.items,
        notes: dto.notes,
        discountAmount: dto.discountAmount,
        requestedDeliveryDate: dto.requestedDeliveryDate,
        status: "PENDING",
      },
      user,
      { skipAutoMerge: true },
    );

    // 2. Van sale: mark the order DELIVERED *directly*. We intentionally bypass changeStatus()
    //    here — changeStatus fires a fire-and-forget DRAFT invoice on DELIVERED, which would
    //    double-invoice this sale. (It also sidesteps the PENDING->DELIVERED transition guard.)
    if (dto.deliveredNow) {
      await this.prisma.forTenant().order.update({
        where: { id: order.id },
        data: { status: OrderStatus.DELIVERED, deliveredAt: new Date() },
      });
    }

    // 3. Generate the invoice from the order — sets Invoice.orderId and increments
    //    OrderItem.invoicedQty (so a later delivery of a not-yet-delivered sale won't
    //    create a second invoice).
    // W4: may return >1 sibling invoice for a mixed regulated order (standard + category).
    const invoices = await this.invoicesService.createInvoiceFromOrder(order.id);
    if (!invoices || invoices.length === 0) {
      // Unreachable for a freshly-created order (nothing is invoiced yet), but keep the
      // order intact and surface a clear error so the operator can retry from the order page.
      throw new InternalServerErrorException(
        "The order was created but its invoice could not be generated. Open the order and use “Generate Invoice”.",
      );
    }

    // 4. Van sale (delivered now) → issue immediately (SENT). Deliver-later →
    //    NEVER auto-send: this draft is the order's "pending mirror" — it stays a
    //    DRAFT, auto-syncs to order edits, and is reconciled to the delivered qty
    //    at delivery, after which staff review & send it. (dto.send is ignored
    //    for deliver-later; sending before delivery is blocked server-side.)
    if (dto.deliveredNow) {
      // Issue every sibling; return the primary (standard/first) invoice.
      let primary: any = null;
      for (const inv of invoices) {
        const sent = await this.invoicesService.send(inv.id);
        if (primary === null) primary = sent;
      }
      return primary;
    }
    return invoices[0];
  }

  async changeStatus(id: string, dto: ChangeOrderStatusDto, user: JwtPayload) {
    const order = await this.findOneOrThrow(id);

    if (user.role === UserRole.CUSTOMER) {
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer || order.customerId !== customer.id) throw new ForbiddenException();
      // Customers may only cancel their own PENDING or DRAFT orders
      if (
        dto.status !== OrderStatus.CANCELLED ||
        (order.status !== OrderStatus.PENDING && order.status !== OrderStatus.DRAFT)
      ) {
        throw new ForbiddenException("Customers can only cancel their own pending orders");
      }
    } else if (user.role === UserRole.DRIVER) {
      // Drivers may only confirm PENDING orders (PENDING → CONFIRMED)
      if (dto.status !== OrderStatus.CONFIRMED || order.status !== OrderStatus.PENDING) {
        throw new ForbiddenException("Drivers can only confirm pending orders");
      }
    } else if (user.role !== UserRole.OPERATOR && user.role !== UserRole.TENANT_ADMIN) {
      throw new ForbiddenException("Only operators can change order status");
    }

    const allowed: Record<string, string[]> = {
      DRAFT: ["PENDING", "CANCELLED"],
      PENDING: ["CONFIRMED", "CANCELLED"],
      CONFIRMED: ["OUT_FOR_DELIVERY", "DELIVERED", "PENDING", "CANCELLED"],
      OUT_FOR_DELIVERY: ["DELIVERED", "PARTIALLY_DELIVERED", "CONFIRMED", "CANCELLED"],
      PARTIALLY_DELIVERED: ["OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"],
      DELIVERED: [],
    };
    if (!(allowed[order.status] ?? []).includes(dto.status)) {
      throw new BadRequestException(`Cannot transition from ${order.status} to ${dto.status}`);
    }

    // Demotions require a reason
    const isDemotion =
      (order.status === "CONFIRMED" && dto.status === "PENDING") ||
      (order.status === "OUT_FOR_DELIVERY" &&
        (dto.status === "PENDING" || dto.status === "CONFIRMED")) ||
      (order.status === "PARTIALLY_DELIVERED" && dto.status === "OUT_FOR_DELIVERY");
    if (isDemotion && !dto.reason?.trim()) {
      throw new BadRequestException("A reason is required when demoting an order");
    }

    const noteAppend = dto.reason
      ? `\n[${new Date().toLocaleDateString()} – status changed to ${dto.status}: ${dto.reason}]`
      : undefined;

    // W6: promoting a DRAFT into a live order is when it becomes a real sale, so
    // re-run the license guard (drafts are created/edited without it — that's the
    // "draft escape"). Categories resolve from each line's snapshot or its product.
    if (order.status === "DRAFT" && dto.status !== OrderStatus.CANCELLED) {
      const items = await this.prisma.forTenant().orderItem.findMany({
        where: { orderId: id, status: { not: "CANCELLED" } },
        select: { productId: true, trackedCategoryId: true },
      });
      const pids = items.map((li) => li.productId).filter(Boolean) as string[];
      const products = pids.length
        ? await this.prisma.forTenant().product.findMany({
            where: { id: { in: pids } },
            select: { id: true, trackedCategoryId: true },
          })
        : [];
      const catByProduct = new Map(products.map((p) => [p.id, p.trackedCategoryId]));
      await this.authGuard.assertAuthorizedOrThrow({
        customerId: order.customerId,
        lines: items.map((li) => ({
          trackedCategoryId:
            li.trackedCategoryId ??
            (li.productId ? (catByProduct.get(li.productId) ?? null) : null),
        })),
        orderId: id,
      });
    }

    const updated = await this.prisma.forTenant().order.update({
      where: { id },
      data: {
        status: dto.status,
        ...(noteAppend ? { notes: (order.notes ?? "") + noteAppend } : {}),
      },
    });

    this.gateway.emitOrderStatusChanged(this.prisma.getTenantId(), {
      orderId: id,
      orderNumber: order.orderNumber ?? "",
      customerId: order.customerId,
      status: dto.status,
      previousStatus: order.status,
    });

    // Settle the order's invoice on a manual status change.
    if (dto.status === OrderStatus.DELIVERED) {
      // Manual "mark delivered" = fully delivered. If the order has a pending
      // mirror draft, reconcile it to the order and leave it DRAFT for staff to
      // review & send (awaited so it runs inside the tenant context). Otherwise
      // keep the old behaviour: fire-and-forget auto-create (explicit tenantId).
      const draft = await this.invoicesService.findOpenOrderDraft(id);
      if (draft) {
        await this.invoicesService.reconcileOrderDraftInvoice(id, { basis: "order" });
      } else {
        const capturedTenantId = this.prisma.getTenantId();
        this.invoicesService.createInvoiceFromOrderWithTenant(id, capturedTenantId).catch((err) => {
          this.logger.error(
            `Failed to auto-create invoice for order ${id}: ${err?.message ?? err}`,
          );
        });
      }
    } else if (dto.status === OrderStatus.CANCELLED) {
      // Cancelling an order voids its pending mirror draft (releases invoicedQty).
      const draft = await this.invoicesService.findOpenOrderDraft(id);
      if (draft) await this.invoicesService.voidInvoice(draft.id);
    }

    // Fire-and-forget push notifications for key status transitions
    const notifMap: Partial<Record<OrderStatus, { title: string; body: string }>> = {
      [OrderStatus.CONFIRMED]: {
        title: "Order Confirmed ✓",
        body: `Your order #${order.orderNumber} has been confirmed.`,
      },
      [OrderStatus.OUT_FOR_DELIVERY]: {
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
    const notif = notifMap[dto.status];
    if (notif) {
      this.notifications
        .sendToCustomer(order.customerId, notif.title, notif.body, { orderId: id })
        .catch(() => {});
    }

    return updated;
  }

  async reopenOrder(id: string) {
    const order = await this.prisma.forTenant().order.findUnique({
      where: { id },
      include: { lineItems: true },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (order.status !== OrderStatus.CANCELLED) {
      throw new BadRequestException(
        `Only CANCELLED orders can be reopened. Current status: ${order.status}`,
      );
    }

    // Block reopen if any PAID invoices exist for this order (avoid duplicate billing)
    const paidInvoice = await this.prisma.forTenant().invoice.findFirst({
      where: { orderId: id, status: { in: ["PAID", "PARTIAL", "WRITTEN_OFF"] } },
      select: { invoiceNumber: true, status: true },
    });
    if (paidInvoice) {
      throw new BadRequestException(
        `Cannot reopen order: invoice ${paidInvoice.invoiceNumber} is ${paidInvoice.status}. Void or credit the invoice before reopening.`,
      );
    }
    return this.prisma.tenantTransaction(async (tx) => {
      // Revert cancelled line items back to PENDING
      await tx.orderItem.updateMany({
        where: { orderId: id, status: ItemStatus.CANCELLED },
        data: { status: ItemStatus.PENDING },
      });
      return tx.order.update({
        where: { id },
        data: {
          status: OrderStatus.PENDING,
          notes: order.notes
            ? `${order.notes}\n[Reopened ${new Date().toLocaleDateString()}]`
            : `[Reopened ${new Date().toLocaleDateString()}]`,
        },
        include: {
          lineItems: { include: { product: true } },
          customer: { select: { id: true, businessName: true } },
        },
      });
    });
  }

  async updateOrderItems(orderId: string, dto: UpdateOrderItemsDto, user?: JwtPayload) {
    const order = await this.prisma.forTenant().order.findUnique({
      where: { id: orderId },
      include: { lineItems: true },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (!["DRAFT", "PENDING", "CONFIRMED"].includes(order.status)) {
      throw new BadRequestException(
        "Items can only be edited on DRAFT, PENDING, or CONFIRMED orders",
      );
    }

    // W6: license guard on edits. A regulated line added on edit (or via a buyer
    // merge into an existing order) must be authorized just like at create — else
    // it's a bypass. Non-draft only (a draft edit isn't a sale yet). Run BEFORE any
    // mutation so a block can't leave a half-edited order. Categories resolve from
    // the incoming products — the same snapshot the created/substituted lines now
    // persist below. orderId is passed so ORDER-scoped §8 overrides apply.
    if (order.status !== "DRAFT") {
      const pids = (dto.items ?? []).map((i) => i.productId).filter(Boolean) as string[];
      const products = pids.length
        ? await this.prisma.forTenant().product.findMany({
            where: { id: { in: pids } },
            select: { id: true, trackedCategoryId: true },
          })
        : [];
      const catByProduct = new Map(products.map((p) => [p.id, p.trackedCategoryId]));
      await this.authGuard.assertAuthorizedOrThrow({
        customerId: order.customerId,
        lines: (dto.items ?? []).map((i) => ({
          trackedCategoryId: i.productId ? (catByProduct.get(i.productId) ?? null) : null,
        })),
        orderId,
      });
    }

    // Customer/Driver path: replace items by productId
    if (user?.role === UserRole.CUSTOMER || user?.role === UserRole.DRIVER) {
      if (user.role === UserRole.CUSTOMER) {
        const customer = await this.prisma
          .forTenant()
          .customer.findFirst({ where: { userId: user.sub } });
        if (!customer || order.customerId !== customer.id) throw new ForbiddenException();
      }

      // Customers send items as { productId, qty } — replace all line items
      const productIds = dto.items.map((i) => i.productId).filter(Boolean) as string[];
      const products = await this.prisma
        .forTenant()
        .product.findMany({ where: { id: { in: productIds } } });
      const productMap = new Map(products.map((p) => [p.id, p]));

      // P5-04: buyer pricing context (tier + per-product override + active promos).
      // Loaded only for the buyer (CUSTOMER) merge path; DRIVER edits keep the
      // legacy list pricing unchanged. This also corrects a pre-existing bug where
      // the buyer merge billed LIST price, ignoring the customer's tier.
      const isBuyerEdit = user.role === UserRole.CUSTOMER;
      const buyerTierCtx = isBuyerEdit
        ? await this.prisma
            .forTenant()
            .customer.findUnique({ where: { id: order.customerId }, select: { pricingTier: true } })
        : null;
      const buyerDefaultTier = buyerTierCtx?.pricingTier ?? 1;
      const buyerCustomerPrices =
        isBuyerEdit && productIds.length > 0
          ? await this.prisma.forTenant().customerPrice.findMany({
              where: { customerId: order.customerId, productId: { in: productIds } },
            })
          : [];
      const buyerCpMap = new Map(buyerCustomerPrices.map((cp) => [cp.productId, cp.pricingTier]));
      const buyerPromos = await this.loadActivePromotions(user.role);

      // Denomination gate: a boxed line's incoming `qty` is only PIECES when the
      // existing line was stored with a box/piece split (box-aware create). Lines
      // created box-UNAWARE (mobile cart, operator add-line) store `qty` as a
      // selling-unit/box count with boxes=null — for those we must NOT re-split,
      // or a $120 (2-box) line would drop to $20 (2-piece) on any edit.
      const pieceDenominated = new Set(
        (order.lineItems ?? [])
          .filter((li) => li.productId && (li.boxes != null || li.pieces != null))
          .map((li) => li.productId as string),
      );

      await this.prisma.forTenant().orderItem.deleteMany({ where: { orderId } });
      for (const item of dto.items) {
        if (!item.productId) {
          // Preserve an operator-added unlisted (catalog-free) line carried
          // through a buyer's cart merge. Buyers can't author these themselves.
          const name = (item.name ?? "").trim();
          const qty = item.qty ?? 0;
          if (!name || qty <= 0 || item.unitPrice == null) continue;
          const unitPrice = Number(item.unitPrice);
          await this.prisma.forTenant().orderItem.create({
            data: {
              orderId,
              productId: null,
              name,
              qty,
              unitPrice,
              subtotal: computeLineSubtotal({ unitPrice, qty }),
              status: "PENDING",
              notes: item.notes,
              priceType: PriceType.MANUAL,
            },
          });
          continue;
        }
        if (!item.qty) continue;
        const product = productMap.get(item.productId);
        if (!product) throw new BadRequestException(`Product ${item.productId} not found`);
        // Boxed + piece-denominated line: `qty` is the piece count, so re-split it
        // and prorate by the BOX price (mirrors createOrder + the operator path).
        // Without this a plain qty*unitPrice over-charges boxed lines by
        // unitsPerBox. Selling-unit lines (see pieceDenominated) keep qty*price.
        const upb = Number(product.unitsPerBox ?? 0);
        const shouldSplit = upb > 1 && pieceDenominated.has(item.productId);
        const split = shouldSplit
          ? normalizeBoxesPieces({ qty: item.qty, unitsPerBox: upb })
          : null;
        const boxes = split ? split.boxes : null;
        const pieces = split ? split.pieces : null;
        const qty = split ? split.qty : item.qty;
        // P5-04: buyers get their tier price + best active promotion. The
        // QTY_BREAK threshold is measured in PIECES: split.qty when re-split, else
        // box-count × unitsPerBox for boxed selling-unit lines, else the piece qty.
        // DRIVER edits keep the legacy list price (unchanged).
        const qtyPieces = split ? split.qty : upb > 1 ? item.qty * upb : item.qty;
        const priced = isBuyerEdit
          ? this.resolveBuyerLinePrice(
              product,
              buyerCpMap.get(item.productId) ?? buyerDefaultTier,
              buyerPromos,
              qtyPieces,
            )
          : {
              unitPrice: Number(product.pricePerUnit),
              originalPrice: null as number | null,
              priceType: PriceType.STANDARD,
            };
        await this.prisma.forTenant().orderItem.create({
          data: {
            orderId,
            productId: item.productId,
            qty,
            unitPrice: priced.unitPrice,
            subtotal: computeLineSubtotal({
              unitPrice: priced.unitPrice,
              qty,
              boxes,
              pieces,
              unitsPerBox: upb,
            }),
            boxes,
            pieces,
            originalPrice: priced.originalPrice,
            priceType: priced.priceType,
            status: "PENDING",
            notes: item.notes,
            // Snapshot the regulated category so an edited-in line invoices/ledgers
            // correctly (mirrors orders.service.create; spec §7).
            trackedCategoryId: product.trackedCategoryId ?? null,
          },
        });
      }
    } else {
      // Operator/admin path.
      // Whether to wipe + recreate (mobile "replace-all") vs. merge incrementally.
      // Explicit `replaceAll` wins; otherwise fall back to the legacy heuristic so
      // existing mobile clients (which omit the flag and send a full id-less list)
      // keep working. The web edit UI sends `replaceAll: false`, so adding a new
      // item there merges/appends instead of deleting the untouched lines.
      const allNewItems = dto.items.every((i) => !i.id);
      const replaceAll = dto.replaceAll ?? allNewItems;

      if (replaceAll) {
        // Replace-all: client sends the full item list. Delete existing items then
        // re-create, honoring any per-line price override and any boxes/pieces
        // split (boxed products use BOX-price proration).
        const productIds = dto.items.map((i) => i.productId).filter(Boolean) as string[];
        const products = await this.prisma
          .forTenant()
          .product.findMany({ where: { id: { in: productIds } } });
        const productMap = new Map(products.map((p) => [p.id, p]));

        await this.prisma.forTenant().orderItem.deleteMany({ where: { orderId } });
        for (const item of dto.items) {
          if (!item.productId) {
            // Unlisted (ad-hoc) line — free-text name + unitPrice, no product
            // lookup, no stock, no boxed proration. Stored as MANUAL-priced.
            const name = (item.name ?? "").trim();
            const qty = item.qty ?? 0;
            if (!name || qty <= 0 || item.unitPrice == null) continue;
            const unitPrice = Number(item.unitPrice);
            await this.prisma.forTenant().orderItem.create({
              data: {
                orderId,
                productId: null,
                name,
                qty,
                unitPrice,
                subtotal: computeLineSubtotal({ unitPrice, qty }),
                status: "PENDING",
                notes: item.notes,
                priceType: PriceType.MANUAL,
              },
            });
            continue;
          }
          const product = productMap.get(item.productId);
          if (!product) throw new BadRequestException(`Product ${item.productId} not found`);

          // Recompute qty from boxes/pieces when the operator split a boxed
          // product (matches createOrder's authority). Normalize to integers and
          // roll loose pieces >= unitsPerBox into boxes. Falls back to plain qty.
          let qty = item.qty ?? 0;
          let boxes = item.boxes ?? null;
          let pieces = item.pieces ?? null;
          if (item.boxes != null || item.pieces != null) {
            const split = normalizeBoxesPieces({
              boxes: item.boxes,
              pieces: item.pieces,
              unitsPerBox: product.unitsPerBox,
            });
            qty = split.qty;
            boxes = split.boxes;
            pieces = split.pieces;
          }
          if (qty <= 0) continue;

          const catalogPrice = Number(product.pricePerUnit);
          const overridePrice = item.unitPrice !== undefined ? Number(item.unitPrice) : null;
          const isManualOverride = overridePrice !== null && overridePrice !== catalogPrice;
          const unitPrice = isManualOverride ? overridePrice : catalogPrice;
          const subtotal = computeLineSubtotal({
            unitPrice,
            qty,
            boxes,
            pieces,
            unitsPerBox: product.unitsPerBox,
          });
          await this.prisma.forTenant().orderItem.create({
            data: {
              orderId,
              productId: item.productId,
              qty,
              boxes,
              pieces,
              unitPrice,
              subtotal,
              status: "PENDING",
              notes: item.notes,
              priceType: isManualOverride ? PriceType.MANUAL : PriceType.STANDARD,
              originalPrice: isManualOverride ? catalogPrice : null,
              overrideReason: isManualOverride ? (item.overrideReason ?? null) : null,
              overriddenBy: isManualOverride ? (user?.sub ?? null) : null,
              // Snapshot the regulated category (spec §7).
              trackedCategoryId: product.trackedCategoryId ?? null,
            },
          });
        }
      } else {
        // Individual item updates (dispatcher workflow with explicit item IDs)
        for (const item of dto.items) {
          // New unlisted item (no id, no productId, has name + unitPrice).
          if (!item.id && !item.productId && (item.name ?? "").trim() && (item.qty ?? 0) > 0) {
            if (item.unitPrice == null) continue;
            const name = (item.name as string).trim();
            const qty = item.qty as number;
            const unitPrice = Number(item.unitPrice);
            await this.prisma.forTenant().orderItem.create({
              data: {
                orderId,
                productId: null,
                name,
                qty,
                unitPrice,
                subtotal: computeLineSubtotal({ unitPrice, qty }),
                status: "PENDING",
                notes: item.notes,
                priceType: PriceType.MANUAL,
              },
            });
            continue;
          }
          // New item (no id, has productId; qty OR boxes/pieces)
          const newQtyHint = item.boxes != null || item.pieces != null ? 1 : (item.qty ?? 0);
          if (!item.id && item.productId && newQtyHint > 0) {
            const product = await this.prisma
              .forTenant()
              .product.findUnique({ where: { id: item.productId } });
            if (!product) continue;
            // Recompute qty from boxes/pieces when present.
            let qty = item.qty ?? 0;
            if (item.boxes != null || item.pieces != null) {
              const upb = Number(product.unitsPerBox ?? 0);
              qty = (item.boxes ?? 0) * upb + (item.pieces ?? 0);
            }
            if (qty <= 0) continue;
            const catalogPrice = Number(product.pricePerUnit);
            const overridePrice = item.unitPrice !== undefined ? Number(item.unitPrice) : null;
            const isManualOverride = overridePrice !== null && overridePrice !== catalogPrice;
            const unitPrice = isManualOverride ? overridePrice : catalogPrice;
            const subtotal = computeLineSubtotal({
              unitPrice,
              qty,
              boxes: item.boxes ?? null,
              pieces: item.pieces ?? null,
              unitsPerBox: product.unitsPerBox,
            });
            await this.prisma.forTenant().orderItem.create({
              data: {
                orderId,
                productId: item.productId,
                qty,
                boxes: item.boxes ?? null,
                pieces: item.pieces ?? null,
                unitPrice,
                subtotal,
                status: "PENDING",
                notes: item.notes,
                priceType: isManualOverride ? PriceType.MANUAL : PriceType.STANDARD,
                originalPrice: isManualOverride ? catalogPrice : null,
                overrideReason: isManualOverride ? (item.overrideReason ?? null) : null,
                overriddenBy: isManualOverride ? (user?.sub ?? null) : null,
                // Snapshot the regulated category (spec §7).
                trackedCategoryId: product.trackedCategoryId ?? null,
              },
            });
            continue;
          }
          if (item.action === "DELETE" && item.id) {
            // Hard-remove a line added by mistake. Only safe when nothing
            // downstream references it — a billed or delivered line is struck
            // off instead so invoice/delivery history stays intact.
            const li = order.lineItems.find((l) => l.id === item.id);
            const hasDeliveries = await this.prisma
              .forTenant()
              .deliveryMutation.count({ where: { orderItemId: item.id } });
            if ((li && Number(li.invoicedQty ?? 0) > 0) || hasDeliveries > 0) {
              await this.prisma.forTenant().orderItem.update({
                where: { id: item.id },
                data: { status: "CANCELLED", qty: 0, subtotal: 0, boxes: null, pieces: null },
              });
            } else {
              await this.prisma.forTenant().orderItem.delete({ where: { id: item.id } });
            }
          } else if (item.action === "CANCEL") {
            await this.prisma.forTenant().orderItem.update({
              where: { id: item.id },
              data: { status: "CANCELLED", qty: 0, subtotal: 0, boxes: null, pieces: null },
            });
          } else if (item.substituteProductId) {
            const product = await this.prisma.forTenant().product.findUniqueOrThrow({
              where: { id: item.substituteProductId },
            });
            const existingQty = order.lineItems.find((li) => li.id === item.id)?.qty ?? 1;
            // Substitution may also carry a box/piece split when the substitute
            // is itself a boxed product. Honor it the same way as a fresh add.
            let qtyVal = item.qty ?? Number(existingQty);
            if (item.boxes != null || item.pieces != null) {
              const upb = Number(product.unitsPerBox ?? 0);
              qtyVal = (item.boxes ?? 0) * upb + (item.pieces ?? 0);
            }
            const unitPrice = Number(product.pricePerUnit);
            const subtotal = computeLineSubtotal({
              unitPrice,
              qty: qtyVal,
              boxes: item.boxes ?? null,
              pieces: item.pieces ?? null,
              unitsPerBox: product.unitsPerBox,
            });
            await this.prisma.forTenant().orderItem.update({
              where: { id: item.id },
              data: {
                productId: item.substituteProductId,
                unitPrice,
                qty: qtyVal,
                boxes: item.boxes ?? null,
                pieces: item.pieces ?? null,
                subtotal,
                status: "PENDING",
                notes: item.notes,
                priceType: PriceType.STANDARD,
                originalPrice: null,
                overrideReason: null,
                overriddenBy: null,
                // The product changed — re-snapshot the substitute's category so
                // it doesn't keep the replaced product's (spec §7).
                trackedCategoryId: product.trackedCategoryId ?? null,
              },
            });
          } else if (item.qty !== undefined || item.boxes != null || item.pieces != null) {
            const li = order.lineItems.find((li) => li.id === item.id);
            if (!li) continue;
            // For qty math we need the product's unitsPerBox even if it's not
            // changing — the caller may have edited boxes/pieces only.
            const isUnlisted = !li.productId;
            let unitsPerBox: number | null = null;
            if ((item.boxes != null || item.pieces != null) && li.productId) {
              const product = await this.prisma.forTenant().product.findUnique({
                where: { id: li.productId },
                select: { unitsPerBox: true },
              });
              unitsPerBox = product?.unitsPerBox ?? null;
            }
            let qty = item.qty ?? Number(li.qty);
            if (item.boxes != null || item.pieces != null) {
              qty = (item.boxes ?? 0) * Number(unitsPerBox ?? 0) + (item.pieces ?? 0);
            }
            if (qty <= 0) continue;
            const existingUnitPrice = Number(li.unitPrice);
            const overridePrice = item.unitPrice !== undefined ? Number(item.unitPrice) : null;
            const isManualOverride = overridePrice !== null && overridePrice !== existingUnitPrice;
            const unitPrice = isManualOverride ? overridePrice : existingUnitPrice;
            const subtotal = computeLineSubtotal({
              unitPrice,
              qty,
              boxes: item.boxes ?? null,
              pieces: item.pieces ?? null,
              unitsPerBox,
            });
            await this.prisma.forTenant().orderItem.update({
              where: { id: item.id },
              data: {
                qty,
                ...(item.boxes != null ? { boxes: item.boxes } : {}),
                ...(item.pieces != null ? { pieces: item.pieces } : {}),
                // Allow renaming an unlisted line; catalog lines keep name null.
                ...(isUnlisted && item.name !== undefined ? { name: item.name } : {}),
                unitPrice,
                subtotal,
                ...(item.notes !== undefined ? { notes: item.notes } : {}),
                ...(isManualOverride
                  ? isUnlisted
                    ? // Unlisted lines have no catalog "list price" — a price change is
                      // just the new MANUAL price, no struck-through original.
                      { priceType: PriceType.MANUAL, originalPrice: null }
                    : {
                        priceType: PriceType.MANUAL,
                        originalPrice: existingUnitPrice,
                        overrideReason: item.overrideReason ?? null,
                        overriddenBy: user?.sub ?? null,
                      }
                  : {}),
              },
            });
          }
        }
      }
    }

    // Recalculate order totals from all non-cancelled items
    const activeItems = await this.prisma.forTenant().orderItem.findMany({
      where: { orderId, status: { not: "CANCELLED" } },
    });
    const subtotal = roundMoney(activeItems.reduce((s, li) => s + Number(li.subtotal), 0));
    const tax = roundMoney(subtotal * (await this.getTaxRate()));

    // Revert CONFIRMED (or later) orders back to PENDING when items are edited
    // so the operator must re-confirm the updated pick list before dispatch.
    const shouldRevert =
      !["DRAFT", "PENDING"].includes(order.status) &&
      user?.role !== UserRole.CUSTOMER &&
      user?.role !== UserRole.DRIVER;
    const revertNote = shouldRevert
      ? `\n[${new Date().toLocaleDateString()} – items edited, reverted to PENDING]`
      : undefined;

    await this.prisma.forTenant().order.update({
      where: { id: orderId },
      data: {
        subtotal,
        tax,
        total: roundMoney(subtotal + tax),
        // Recompute the denormalized regulated flag from the edited line set.
        hasRegulated: activeItems.some((li) => li.trackedCategoryId != null),
        ...(shouldRevert ? { status: "PENDING" } : {}),
        ...(dto.orderNotes !== undefined
          ? { notes: (order.notes ?? "") + (revertNote ?? "") + "\n" + dto.orderNotes }
          : revertNote
            ? { notes: (order.notes ?? "") + revertNote }
            : {}),
      },
    });

    // Keep the order's pending-mirror draft invoice (if any) in lockstep with the
    // edit. updateOrderItems only runs on undelivered orders, so a basis="order"
    // re-sync is always appropriate. No-op when the order has no open draft.
    await this.invoicesService.reconcileOrderDraftInvoice(orderId, { basis: "order" });

    if (shouldRevert) {
      this.gateway.emitOrderStatusChanged(this.prisma.getTenantId(), {
        orderId,
        orderNumber: order.orderNumber ?? "",
        status: "PENDING",
        previousStatus: order.status,
        customerId: order.customerId,
      });
    }

    return this.prisma.forTenant().order.findUnique({
      where: { id: orderId },
      include: {
        customer: { select: { id: true, businessName: true, contactName: true } },
        lineItems: {
          include: { product: { select: { id: true, name: true, unit: true } } },
          // Stable creation order so newly added items appear at the bottom.
          orderBy: { createdAt: "asc" },
        },
        transaction: true,
      },
    });
  }

  /**
   * Set or clear carrier shipment tracking on an order (carrier shipped, not
   * route-delivered). Sending blank values clears the field; clearing the
   * tracking number also clears `shippedAt`. The values are mirrored onto the
   * order's non-void invoices so the shipment shows on the customer's invoice.
   */
  async updateShipment(orderId: string, dto: UpdateShipmentDto, _user?: JwtPayload) {
    const order = await this.prisma
      .forTenant()
      .order.findUnique({ where: { id: orderId }, select: { id: true, shippedAt: true } });
    if (!order) throw new NotFoundException("Order not found");

    const carrier = dto.shippingCarrier?.trim() || null;
    const tracking = dto.shippingTrackingNumber?.trim() || null;
    // Stamp shippedAt the first time a tracking number is set; clear it when the
    // tracking number is removed; otherwise keep the original ship date.
    const shippedAt = tracking ? (order.shippedAt ?? new Date()) : null;

    const updated = await this.prisma.forTenant().order.update({
      where: { id: orderId },
      data: { shippingCarrier: carrier, shippingTrackingNumber: tracking, shippedAt },
    });

    // Mirror onto every non-void invoice generated from this order.
    await this.prisma.forTenant().invoice.updateMany({
      where: { orderId, status: { not: "VOID" } },
      data: { shippingCarrier: carrier, shippingTrackingNumber: tracking, shippedAt },
    });

    return updated;
  }

  async toggleUrgent(id: string, user: JwtPayload, urgent?: boolean) {
    const order = await this.findOneOrThrow(id);
    if (user.role === UserRole.CUSTOMER) {
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer || customer.id !== order.customerId) throw new ForbiddenException();
    }
    // If caller provides an explicit value, SET it; otherwise toggle (legacy web clients)
    const newValue = urgent !== undefined ? urgent : !order.urgent;
    return this.prisma.forTenant().order.update({ where: { id }, data: { urgent: newValue } });
  }

  async completeStop(runId: string, stopId: string, dto: CompleteStopDto, user: JwtPayload) {
    // Resolve default invoice terms BEFORE the transaction (avoids nested async DB reads inside tx)
    const { terms: invoiceTerms, dueDays: invoiceDueDays } =
      await this.invoicesService.resolveDefaultTerms();

    // Capture IDs of transactions created/updated so we can enqueue PDF jobs after commit
    const invoiceTransactionIds: string[] = [];

    await this.prisma.tenantTransaction(async (tx) => {
      const stop = await tx.routeRunStop.findFirst({
        where: { id: stopId, routeRunId: runId },
        include: { orders: { include: { lineItems: true } } },
      });
      if (!stop) throw new NotFoundException("Route run stop not found");

      // Phase 4 (W7b): regulated-delivery POD gate. Re-derive the age/ID
      // requirement from the stop's current orders and block/normalise BEFORE any
      // DeliveryBatch / SALE / invoice write, so a blocked regulated delivery
      // persists nothing (the throw rolls the whole transaction back).
      const regDb = tx as unknown as RegulatedDeliveryDb;
      const regSets = await loadAgeIdCategorySets(regDb);
      const regRequirements = await deriveStopRegulatedRequirements(
        regDb,
        { stopId, orderItemIds: dto.deliveries?.map((d) => d.orderItemId) },
        regSets,
      );
      const regulatedPatch = assertRegulatedDeliverySatisfied({
        requirements: regRequirements,
        capture: dto,
        existingSignatureUrl: stop.signatureUrl,
      });

      // Resolve driver ID once
      const driverId =
        user.role === UserRole.DRIVER
          ? ((await tx.driver.findFirst({ where: { userId: user.sub } }))?.id ?? undefined)
          : undefined;

      // Create a DeliveryBatch grouping all mutations in this stop completion.
      // Used to link the per-delivery invoice back to this event.
      const customerId = stop.orders[0]?.customerId ?? stop.customerId;
      const batch = await tx.deliveryBatch.create({
        data: {
          customerId: customerId!,
          routeRunStopId: stopId,
          driverId,
          deliveredAt: new Date(),
        },
      });

      // Track which items were delivered in this batch, grouped by orderId
      const batchDeliveredItems = new Map<
        string,
        Array<{
          orderItemId: string;
          productId: string;
          qty: number;
          unitPrice: number;
          productName: string;
          priceType: string;
          originalPrice: number | null;
          unitsPerBox: number;
        }>
      >();

      for (const delivery of dto.deliveries) {
        const orderItem = await tx.orderItem.findUnique({
          where: { id: delivery.orderItemId },
          include: { product: { select: { name: true, unitsPerBox: true } } },
        });
        if (!orderItem) throw new NotFoundException(`Order item ${delivery.orderItemId} not found`);

        await tx.deliveryMutation.create({
          data: {
            orderId: orderItem.orderId,
            orderItemId: delivery.orderItemId,
            productId: orderItem.productId,
            routeRunStopId: stopId,
            deliveryBatchId: batch.id,
            type: delivery.type,
            quantityDelivered: delivery.quantityDelivered,
            note: delivery.note,
            driverId,
          },
        });

        // Record SALE stock movement (stock can go negative — never blocked)
        let saleQty: Prisma.Decimal | null = null;
        if (delivery.type === MutationType.DELIVERED) {
          saleQty = new Prisma.Decimal(orderItem.qty.toString());
        } else if (delivery.type === MutationType.PARTIAL && delivery.quantityDelivered != null) {
          saleQty = new Prisma.Decimal(delivery.quantityDelivered.toString());
        }
        if (saleQty !== null && saleQty.gt(0)) {
          const order = stop.orders.find((o) => o.id === orderItem.orderId);
          // Single sale-costing path: writes the SALE movement WITH unit cost
          // (COGS), snapshots, stock decrement, and FIFO/LIFO lot consumption
          const { stockAfter } = await this.inventoryService.recordSale(
            orderItem.productId,
            saleQty,
            order?.orderNumber ?? null,
            user.sub,
            tx,
          );
          // Warn if stock went negative — log for operator review but don't block delivery
          if (stockAfter.lt(0)) {
            this.logger.warn(
              `Stock went negative for product ${orderItem.productId}: ` +
                `currentStock=${stockAfter.toString()} after delivery of ${String(saleQty)}`,
            );
          }
        }

        // Determine new item status and update deliveredQty
        let newItemStatus: ItemStatus = ItemStatus.DELIVERED;
        let deliveredQtyIncrement = new Prisma.Decimal(0);

        if (delivery.type === MutationType.DELIVERED) {
          newItemStatus = ItemStatus.DELIVERED;
          deliveredQtyIncrement = orderItem.qty; // full delivery
        } else if (delivery.type === MutationType.PARTIAL) {
          newItemStatus = ItemStatus.PARTIAL;
          deliveredQtyIncrement =
            delivery.quantityDelivered != null
              ? new Prisma.Decimal(delivery.quantityDelivered.toString())
              : new Prisma.Decimal(0);
        } else if (delivery.type === MutationType.REFUSED) {
          newItemStatus = ItemStatus.CANCELLED;
        }

        await tx.orderItem.update({
          where: { id: delivery.orderItemId },
          data: {
            status: newItemStatus,
            deliveredQty: { increment: deliveredQtyIncrement },
          },
        });

        // Track delivered items for per-batch invoice generation
        if (delivery.type === MutationType.DELIVERED || delivery.type === MutationType.PARTIAL) {
          const deliveredQty =
            delivery.type === MutationType.DELIVERED
              ? Number(orderItem.qty)
              : Number(delivery.quantityDelivered ?? 0);
          if (deliveredQty > 0) {
            const items = batchDeliveredItems.get(orderItem.orderId) ?? [];
            items.push({
              orderItemId: orderItem.id,
              productId: orderItem.productId,
              qty: deliveredQty,
              unitPrice: Number(orderItem.unitPrice),
              productName: orderItem.product?.name ?? "Product",
              priceType: orderItem.priceType ?? PriceType.STANDARD,
              originalPrice:
                orderItem.originalPrice != null ? Number(orderItem.originalPrice) : null,
              unitsPerBox: Number(orderItem.product?.unitsPerBox ?? 0),
            });
            batchDeliveredItems.set(orderItem.orderId, items);
          }
        }
      }

      // Determine order status and create per-batch invoices
      for (const order of stop.orders) {
        const updatedItems = await tx.orderItem.findMany({ where: { orderId: order.id } });

        // Check if ALL items are fully delivered (deliveredQty >= qty)
        const allFullyDelivered = updatedItems.every(
          (i) =>
            i.status === ItemStatus.DELIVERED ||
            i.status === ItemStatus.CANCELLED ||
            i.deliveredQty.gte(i.qty),
        );
        const anyDelivered = updatedItems.some(
          (i) =>
            i.status === ItemStatus.DELIVERED ||
            i.status === ItemStatus.PARTIAL ||
            i.deliveredQty.gt(0),
        );
        const allCancelledOrRefused = updatedItems.every((i) => i.status === ItemStatus.CANCELLED);

        let newOrderStatus: OrderStatus;
        if (allCancelledOrRefused) {
          newOrderStatus = OrderStatus.CANCELLED;
        } else if (allFullyDelivered) {
          newOrderStatus = OrderStatus.DELIVERED;
        } else if (anyDelivered) {
          newOrderStatus = OrderStatus.PARTIALLY_DELIVERED;
        } else {
          newOrderStatus = order.status; // no change
        }

        await tx.order.update({
          where: { id: order.id },
          data: {
            status: newOrderStatus,
            ...(newOrderStatus === OrderStatus.DELIVERED ? { deliveredAt: new Date() } : {}),
          },
        });

        // Create Transaction only when order is fully DELIVERED
        if (newOrderStatus === OrderStatus.DELIVERED) {
          const createdTxn = await tx.transaction.upsert({
            where: { orderId: order.id },
            create: {
              orderId: order.id,
              customerId: order.customerId,
              totalOwed: order.total,
              status: TxnStatus.UNPAID,
            },
            update: {},
          });
          invoiceTransactionIds.push(createdTxn.id);
        }

        // Per-batch invoicing. If the order has an open "pending mirror" draft
        // (created via the deliver-later flow), reconcile THAT draft to the
        // cumulative delivered qty and leave it DRAFT for staff to review & send —
        // do NOT also create a separate SENT per-batch invoice (that would
        // double-bill). Normal route orders (no pending draft) keep auto-SENT.
        const openDraft = await tx.invoice.findFirst({
          where: { orderId: order.id, status: InvoiceStatus.DRAFT, deliveryBatchId: null },
        });
        const deliveredInBatch = batchDeliveredItems.get(order.id);
        if (openDraft) {
          await this.invoicesService.reconcileOrderDraftInvoice(order.id, {
            basis: "delivered",
            tx,
          });
        } else if (deliveredInBatch && deliveredInBatch.length > 0) {
          // Generate invoice number
          const year = new Date().getFullYear();
          const invPrefix = `INV-${year}-`;
          const lastInv = await tx.invoice.findFirst({
            where: { invoiceNumber: { startsWith: invPrefix } },
            orderBy: { invoiceNumber: "desc" },
          });
          const seq = lastInv ? parseInt(lastInv.invoiceNumber.split("-")[2], 10) + 1 : 1;
          const invoiceNumber = `${invPrefix}${String(seq).padStart(4, "0")}`;

          const dueDate = new Date();
          dueDate.setDate(dueDate.getDate() + invoiceDueDays);

          // Compute totals from delivered items only. For boxed products `unitPrice`
          // is the BOX price and `qty` is in pieces — re-split through the shared
          // helper so we don't multiply the box price by the piece count.
          const lineSubtotal = (li: { qty: number; unitPrice: number; unitsPerBox: number }) => {
            const split = normalizeBoxesPieces({ qty: li.qty, unitsPerBox: li.unitsPerBox });
            return computeLineSubtotal({
              unitPrice: li.unitPrice,
              qty: split.qty,
              boxes: split.boxes,
              pieces: split.pieces,
              unitsPerBox: li.unitsPerBox,
            });
          };
          const invoiceSubtotal = roundMoney(
            deliveredInBatch.reduce((sum, li) => sum + lineSubtotal(li), 0),
          );

          await tx.invoice.create({
            data: {
              invoiceNumber,
              customerId: order.customerId,
              orderId: order.id,
              deliveryBatchId: batch.id,
              status: InvoiceStatus.SENT,
              sentAt: new Date(),
              subtotal: invoiceSubtotal,
              taxAmount: 0,
              discount: 0,
              shippingFee: 0,
              total: invoiceSubtotal,
              dueDate,
              terms: invoiceTerms,
              issueDate: new Date(),
              notes: order.orderNumber
                ? `Order #${order.orderNumber} — delivery batch`
                : "Delivery batch invoice",
              items: {
                create: deliveredInBatch.map((li) => ({
                  description: li.productName,
                  productId: li.productId,
                  qty: li.qty,
                  unitPrice: li.unitPrice,
                  // `unitPrice` is already the net (post-override) price; `originalPrice`
                  // carries the strikethrough. Re-deriving a discount here would
                  // double-count the override (bill 80 for a 100→90 line).
                  discount: 0,
                  originalPrice: li.originalPrice,
                  priceType: li.priceType as any,
                  taxRate: 0,
                  subtotal: lineSubtotal(li),
                })),
              },
            },
          });
        }
      }

      await tx.routeRunStop.update({
        where: { id: stopId },
        data: {
          status: "COMPLETED",
          completedAt: new Date(),
          driverNote: dto.driverNote,
          podPhotoUrls: dto.podPhotoUrls ?? [],
          signatureUrl: dto.signatureUrl ?? null,
          safeDropEnabled: dto.safeDropEnabled ?? false,
          ...regulatedPatch,
        },
      });

      // Auto-complete the run when all stops are COMPLETED or SKIPPED
      const allStops = await tx.routeRunStop.findMany({
        where: { routeRunId: runId },
        select: { status: true },
      });
      const allDone =
        allStops.length > 0 &&
        allStops.every((s) => s.status === "COMPLETED" || s.status === "SKIPPED");
      if (allDone) {
        await tx.routeRun.update({
          where: { id: runId },
          data: { status: "COMPLETED", completedAt: new Date() },
        });
      }
    });

    // Emit real-time updates for each affected order/customer + push notifications
    const stop = await this.prisma.forTenant().routeRunStop.findFirst({
      where: { id: stopId, routeRunId: runId },
      include: {
        orders: { select: { id: true, customerId: true, orderNumber: true, status: true } },
      },
    });
    if (stop) {
      for (const order of stop.orders) {
        this.gateway.emitStopCompleted(this.prisma.getTenantId(), {
          runId,
          stopId,
          customerId: order.customerId,
          orderId: order.id,
          completedAt: new Date().toISOString(),
        });
        if (order.status === OrderStatus.DELIVERED) {
          this.notifications
            .sendToCustomer(
              order.customerId,
              "Order Delivered ✓",
              `Your order #${order.orderNumber} has been delivered.`,
              { orderId: order.id },
            )
            .catch(() => {});
        } else if (order.status === OrderStatus.PARTIALLY_DELIVERED) {
          this.notifications
            .sendToCustomer(
              order.customerId,
              "Partial Delivery 📦",
              `Some items from order #${order.orderNumber} have been delivered. Remaining items will follow.`,
              { orderId: order.id },
            )
            .catch(() => {});
        }
      }
    }

    // Check for low stock on products that were just delivered
    const deliveredProductIds: string[] = [];
    for (const delivery of dto.deliveries) {
      if (delivery.type === MutationType.DELIVERED || delivery.type === MutationType.PARTIAL) {
        const item = await this.prisma.forTenant().orderItem.findUnique({
          where: { id: delivery.orderItemId },
          select: { productId: true },
        });
        // Unlisted lines have no product → nothing to low-stock check.
        if (item?.productId) deliveredProductIds.push(item.productId);
      }
    }
    if (deliveredProductIds.length > 0) {
      const products = await this.prisma.forTenant().product.findMany({
        where: { id: { in: deliveredProductIds }, reorderPoint: { not: null } },
        select: { id: true, name: true, sku: true, currentStock: true, reorderPoint: true },
      });
      for (const p of products) {
        if (p.reorderPoint !== null && Number(p.currentStock) <= Number(p.reorderPoint)) {
          this.gateway.emitLowStock(this.prisma.getTenantId(), {
            productId: p.id,
            productName: p.name,
            sku: p.sku ?? "",
            stockLevel: Number(p.currentStock),
          });
        }
      }
    }

    // Enqueue PDF generation for each new invoice (after DB transaction commits).
    // Retry up to 3x with exponential back-off (5s -> 10s -> 20s).
    for (const txnId of invoiceTransactionIds) {
      await this.invoiceQueue.add(
        "generate-invoice",
        { transactionId: txnId },
        { attempts: 3, backoff: { type: "exponential", delay: 5000 } },
      );
    }

    return { success: true };
  }

  async getOrderTracking(orderId: string, user: JwtPayload) {
    const order = await this.prisma.forTenant().order.findUnique({
      where: { id: orderId },
      include: {
        customer: { select: { deliveryWindowStart: true, deliveryWindowEnd: true } },
        routeRunStop: {
          include: {
            routeRun: {
              include: {
                driver: { select: { id: true, contactName: true } },
                route: { select: { id: true, name: true } },
                stops: { orderBy: { stopNumber: "asc" } },
              },
            },
          },
        },
      },
    });
    if (!order) throw new NotFoundException("Order not found");

    if (!order.routeRunStop) {
      return { status: order.status, tracking: null };
    }

    const stop = order.routeRunStop;
    const run = stop.routeRun;
    const allStops = run.stops ?? [];
    const currentStopNumber = stop.stopNumber;

    // Count PENDING stops before this customer's stop
    const stopsAhead = allStops.filter(
      (s) => s.stopNumber < currentStopNumber && s.status === "PENDING",
    ).length;

    return {
      status: order.status,
      tracking: {
        runId: run.id,
        routeName: run.route?.name ?? null,
        driverName: run.driver?.contactName ?? null,
        runStatus: run.status,
        stopNumber: currentStopNumber,
        stopStatus: stop.status,
        stopsAhead,
        estimatedArrivalWindow: {
          start: order.customer?.deliveryWindowStart ?? null,
          end: order.customer?.deliveryWindowEnd ?? null,
        },
      },
    };
  }

  async deleteOrder(id: string) {
    const order = await this.prisma.forTenant().order.findUnique({
      where: { id },
      include: { invoices: { select: { id: true } }, transaction: { select: { id: true } } },
    });
    if (!order) throw new NotFoundException("Order not found");

    const deletableStatuses: OrderStatus[] = [
      OrderStatus.DRAFT,
      OrderStatus.PENDING,
      OrderStatus.CANCELLED,
    ];
    if (!deletableStatuses.includes(order.status)) {
      throw new BadRequestException(
        `Only DRAFT, PENDING, or CANCELLED orders can be deleted. This order is ${order.status}.`,
      );
    }

    await this.prisma.tenantTransaction(async (tx) => {
      // Delete all invoices associated with this order
      for (const inv of order.invoices) {
        await tx.invoicePayment.deleteMany({ where: { invoiceId: inv.id } });
        await tx.invoiceItem.deleteMany({ where: { invoiceId: inv.id } });
        await tx.invoice.delete({ where: { id: inv.id } });
      }
      if (order.transaction) {
        await tx.transactionItem.deleteMany({ where: { transactionId: order.transaction.id } });
        await tx.payment.deleteMany({ where: { transactionId: order.transaction.id } });
        await tx.transaction.delete({ where: { id: order.transaction.id } });
      }
      await tx.deliveryMutation.deleteMany({ where: { orderId: id } });
      await tx.orderItem.deleteMany({ where: { orderId: id } });
      await tx.order.delete({ where: { id } });
    });

    return { success: true };
  }

  async bulkDeleteOrders(ids: string[]) {
    const results = await Promise.allSettled(ids.map((id) => this.deleteOrder(id)));
    const deleted = results.filter((r) => r.status === "fulfilled").length;
    const errors = results
      .map((r, i) => (r.status === "rejected" ? `${ids[i]}: ${r.reason?.message}` : null))
      .filter(Boolean) as string[];
    return { deleted, errors };
  }

  private async findOneOrThrow(id: string) {
    const order = await this.prisma.forTenant().order.findUnique({ where: { id } });
    if (!order) throw new NotFoundException("Order not found");
    return order;
  }
}
