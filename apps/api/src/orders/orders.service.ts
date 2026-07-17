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
  computeCategoryTax,
  roundMoney,
  normalizeBoxesPieces,
  applyBestPromotion,
  effectiveBuyerPrice,
  type PromotionRule,
  type CategoryTaxType,
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
  ChangeRequestStatus,
  ChangeRequestType,
  NotificationEvent,
} from "@prisma/client";
import { ListOrdersDto } from "./dto/list-orders.dto";
import { CreateOrderDto } from "./dto/create-order.dto";
import { CreateSaleDto } from "./dto/create-sale.dto";
import { ChangeOrderStatusDto } from "./dto/change-order-status.dto";
import { UpdateOrderItemsDto } from "./dto/update-order-items.dto";
import { UpdateShipmentDto } from "./dto/update-shipment.dto";
import {
  assertRegulatedDeliverySatisfied,
  deriveStopRegulatedRequirements,
  loadAgeIdCategorySets,
  type RegulatedDeliveryDb,
} from "../common/regulated-delivery";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { getTierPrice } from "../utils/pricing";
import { redactUpsellForCustomer } from "../common/upsell-redaction";
import { NotificationsService } from "../notifications/notifications.service";
import { InvoicesService } from "../invoices/invoices.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { InventoryService } from "../inventory/inventory.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { PromotionsService } from "../promotions/promotions.service";
import { MessagingService } from "../messaging/messaging.service";
import { formatDate, formatMoney } from "../messaging/messaging.helpers";

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
    private readonly messaging: MessagingService,
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
    rememberedPrice?: number | null,
  ): { unitPrice: number; originalPrice: number | null; priceType: PriceType } {
    const listPrice = Number(product.pricePerUnit);
    const tierBase = getTierPrice(product, tierForProduct);
    const remembered = rememberedPrice ?? null;
    // Sticky upsell: ONLY a remembered ABOVE-LIST price becomes a MANUAL upsell.
    // It overrides the tier AND takes precedence over promotions (a deliberate
    // above-market price is never auto-discounted). Stored as MANUAL with the list
    // base so the operator sees the upsell and the customer's read is redacted
    // (upsell-redaction.ts). A premium tier (tierBase > list) is the customer's
    // normal price, NOT an upsell — it must not trip this branch.
    if (remembered != null && Number(remembered) > listPrice) {
      return {
        unitPrice: roundMoney(Number(remembered)),
        originalPrice: listPrice,
        priceType: PriceType.MANUAL,
      };
    }
    const base = tierBase;
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

  /**
   * RF-4: the piece count a per-unit category tax multiplies. Box-split lines
   * store `qty` already in pieces; a boxed selling-unit line (boxes null) stores
   * `qty` in SELLING UNITS, so expand it by the snapshot `unitsPerBox`. PER_VOLUME
   * stays approximate (pieces, not true volume) until a `Product.volumePerUnit`
   * field lands — see computeCategoryTax's contract.
   */
  private linePieceQty(
    li: { qty: unknown; boxes: unknown; unitsPerBox?: unknown },
    unitsPerBoxFallback?: number,
  ): number {
    const qty = Number(li.qty) || 0;
    if (li.boxes != null) return qty; // already pieces
    // A boxed product ordered as SELLING UNITS stores unitsPerBox:null on the line
    // (create only snapshots it for box-split lines), so fall back to the product's
    // unitsPerBox — otherwise a per-unit levy collapses by a factor of unitsPerBox on
    // any later edit (create expanded qty→pieces but the recompute couldn't).
    const upb = Number(li.unitsPerBox ?? unitsPerBoxFallback ?? 0);
    return upb > 1 ? qty * upb : qty;
  }

  /**
   * RF-4: recompute + persist each regulated line's `categoryTaxAmount` from its
   * STORED subtotal + piece qty and the line's section (TrackedCategory) tax
   * config, and return the order-level Σ (rounded). Non-regulated lines are 0.
   * Category tax is a SECTION-level levy — the reporting subcategory never taxes.
   * Mirrors create()'s per-line computation so an edited / merged order's total
   * and per-line snapshots stay consistent with the invoice split. Runs inside
   * the caller's transaction (uses `tx.trackedCategory` — the tx's own pooled
   * connection, so it's safe to co-locate with the other in-tx writes).
   */
  private async recomputeLineCategoryTaxes(tx: any, lines: any[]): Promise<number> {
    const catIds = [
      ...new Set(lines.map((li) => li.trackedCategoryId).filter(Boolean)),
    ] as string[];
    const cats = catIds.length
      ? await tx.trackedCategory.findMany({ where: { id: { in: catIds } } })
      : [];
    const catMap = new Map<string, any>(cats.map((c: any) => [c.id, c]));
    // Fetch each regulated line's product unitsPerBox so linePieceQty can expand a
    // selling-unit boxed line (which didn't snapshot unitsPerBox) to real pieces.
    const prodIds = [
      ...new Set(
        lines.filter((li) => li.trackedCategoryId && li.productId).map((li) => li.productId),
      ),
    ] as string[];
    const prods = prodIds.length
      ? await tx.product.findMany({
          where: { id: { in: prodIds } },
          select: { id: true, unitsPerBox: true },
        })
      : [];
    const upbMap = new Map<string, number>(
      prods.map((p: any) => [p.id, Number(p.unitsPerBox ?? 0)]),
    );
    let sum = 0;
    for (const li of lines) {
      const cat = li.trackedCategoryId ? catMap.get(li.trackedCategoryId) : null;
      const amount = cat
        ? computeCategoryTax({
            taxType: cat.taxType as CategoryTaxType,
            rate: Number(cat.rate),
            unitBasisQty: this.linePieceQty(li, upbMap.get(li.productId)),
            lineSubtotal: Number(li.subtotal),
            priceIncludesTax: cat.priceIncludesTax,
          })
        : 0;
      if (roundMoney(Number(li.categoryTaxAmount ?? 0)) !== amount) {
        await tx.orderItem.update({ where: { id: li.id }, data: { categoryTaxAmount: amount } });
      }
      sum += amount;
    }
    return roundMoney(sum);
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
          // P5-11: pending change-request count for the orders-list badge.
          // Filtered relation count — additive; clients that don't know
          // `_count` ignore it.
          _count: {
            select: {
              changeRequests: { where: { status: ChangeRequestStatus.PENDING } },
            },
          },
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
        // P5-08: version history + the run state that governs the edit window.
        revisions: { orderBy: { revisionNumber: "asc" } },
        // P5-09: post-dispatch change requests, newest first.
        changeRequests: { orderBy: { createdAt: "desc" } },
        // `driverId` feeds the F2-005 driver-ownership gate below.
        routeRun: { select: { status: true, startedAt: true, driverId: true } },
      },
    });
    if (!order) throw new NotFoundException("Order not found");

    if (user.role === UserRole.CUSTOMER) {
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer || customer.id !== order.customerId) throw new ForbiddenException();
      // A customer must never see an upsell's base price / that they were upsold.
      redactUpsellForCustomer(order);
    }

    // F2-005: a DRIVER may only read an order that is on a run they are the
    // driver of — otherwise they could enumerate any order's full detail.
    // Orders not yet on a run (routeRun null) are never driver-readable.
    if (user.role === UserRole.DRIVER) {
      const driver = await this.prisma
        .forTenant()
        .driver.findFirst({ where: { userId: user.sub } });
      if (!driver || order.routeRun?.driverId !== driver.id) throw new ForbiddenException();
    }

    // P5-08 edit window (G7): free editing is open until the order's run dispatches.
    // `editableUntil` (the soft cutoff countdown) stays null until the per-weekday
    // routes-cutoff config lands — the HARD close is dispatch, which is authoritative.
    (order as any).editWindow = this.computeEditWindow(order);

    return order;
  }

  /**
   * P5-08: derive the non-persisted edit-window descriptor from an order + its run.
   * editable ⟺ status is DRAFT/PENDING/CONFIRMED AND the order isn't on a dispatched
   * run. Single source of truth shared by the read and the write gate.
   */
  private computeEditWindow(order: {
    status: string;
    routeRunId?: string | null;
    routeRun?: { status: string } | null;
  }): { editable: boolean; editableUntil: string | null; closedReason: string | null } {
    const statusEditable = ["DRAFT", "PENDING", "CONFIRMED"].includes(order.status);
    const dispatched = order.routeRun != null && order.routeRun.status !== "SCHEDULED";
    return {
      editable: statusEditable && !dispatched,
      editableUntil: null,
      closedReason: dispatched ? "DISPATCHED" : statusEditable ? null : "STATUS",
    };
  }

  /**
   * Return the last-given override unitPrice per product for a customer — a prior
   * DISCOUNT (below catalog) OR UPSELL (above catalog). Only lines where
   * originalPrice is set are returned. Used to pre-fill the operator price field
   * on scan and to resolve a customer's sticky effective buyer price.
   *
   * Tenant scoping comes from `forTenant()` (the request ALS tenant) — every
   * caller is request-scoped, so no tenantId argument is needed.
   *
   * P5-04: PROMO lines are excluded — a promotion's net price is transient
   * (window-bound) and must NOT become the customer's remembered operator price,
   * or an expired promo price would silently pre-fill future operator orders.
   */
  async getCustomerPriceHistory(
    customerId: string,
  ): Promise<Record<string, { lastPrice: number; listPriceAtTime: number }>> {
    const items = await this.prisma.forTenant().orderItem.findMany({
      where: {
        order: {
          customerId,
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
      // RF-4: re-derive + persist each line's category tax from the merged set,
      // and fold Σ into the total (a merged-in regulated line keeps its levy).
      const categoryTax = await this.recomputeLineCategoryTaxes(tx, activeItems);
      await tx.order.update({
        where: { id: winner.id },
        data: {
          subtotal,
          tax,
          total: roundMoney(subtotal + tax + categoryTax),
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
      // RF-4: re-derive + persist each line's category tax from the merged set,
      // and fold Σ into the total (a merged-in regulated line keeps its levy).
      const categoryTax = await this.recomputeLineCategoryTaxes(tx, activeItems);
      const routeUpdate = routeAssignment
        ? { routeRunId: routeAssignment.routeRunId, routeRunStopId: routeAssignment.routeRunStopId }
        : {};
      await tx.order.update({
        where: { id: winner.id },
        data: {
          subtotal,
          tax,
          total: roundMoney(subtotal + tax + categoryTax),
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

    // RF-4: load the regulated section (TrackedCategory) tax config for every
    // catalog product that carries one, so each regulated line's category tax is
    // computed + folded into the order total at sale time (snapshotted per line).
    const orderCatIds = [
      ...new Set(products.map((p) => p.trackedCategoryId).filter(Boolean)),
    ] as string[];
    const categoryMap = new Map<string, any>(
      (orderCatIds.length > 0
        ? await this.prisma.forTenant().trackedCategory.findMany({
            where: { id: { in: orderCatIds } },
          })
        : []
      ).map((c: any) => [c.id, c]),
    );

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

    // Sticky upsell: the customer's remembered above-list price is their effective
    // price. Loaded once, applied via effectiveBuyerPrice in the price-race check
    // and resolveBuyerLinePrice below.
    const priceHistory =
      catalogIds.length > 0 ? await this.getCustomerPriceHistory(customerId) : {};

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
        // Compare against the customer's EFFECTIVE price (tier or sticky upsell) so
        // a legitimately-upsold cart doesn't 409 at checkout.
        const currentPrice = effectiveBuyerPrice(
          Number(getTierPrice(product, tierForProduct)),
          Number(product.pricePerUnit),
          priceHistory[item.productId]?.lastPrice ?? null,
        );
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
          trackedSubcategoryId: null as string | null,
          categoryTaxAmount: 0,
          tenantId: this.prisma.getTenantId(),
        };
      }

      const product = productMap.get(item.productId);
      if (!product) throw new BadRequestException(`Product ${item.productId} not found`);

      // Recompute qty from boxes/pieces when provided (backend is authoritative).
      // Normalize to integers and roll loose pieces >= unitsPerBox into boxes.
      const upb = Number(product.unitsPerBox ?? 0);
      let qty = item.qty;
      let boxes = item.boxes ?? null;
      let pieces = item.pieces ?? null;
      if (item.boxes != null || item.pieces != null) {
        const split = normalizeBoxesPieces({
          boxes: item.boxes,
          pieces: item.pieces,
          unitsPerBox: upb,
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

      // QTY_BREAK promo threshold is measured in PIECES. A box-split line stores qty
      // in pieces already; a box-UNAWARE boxed line (boxes==null) stores qty as a
      // SELLING-UNIT (box) count, so expand it — mirrors the merge path so the same
      // buyer line prices identically at create vs edit.
      const qtyPieces = boxes != null ? qty : upb > 1 ? qty * upb : qty;

      // Price priority: operator one-time override (DISCOUNTED) > best buyer
      // promotion (PROMO) / tier price (SPECIAL) / list price (STANDARD). Promos
      // populate `activePromos` only on the buyer (CUSTOMER) path (P5-04); staff
      // orders get [] so this reproduces the prior tier/standard ladder exactly.
      if (overridePrice != null && overridePrice < listPrice) {
        unitPrice = overridePrice;
        priceType = PriceType.DISCOUNTED;
        originalPrice = listPrice;
      } else if (isStaffRole && overridePrice != null && overridePrice > listPrice) {
        // Upsell: an operator deliberately sells ABOVE catalog. Stored as a MANUAL
        // override with the catalog base as originalPrice (< unitPrice). The base
        // is redacted before the order reaches the customer (upsell-redaction.ts);
        // the operator sees a green "Upsell" indicator. Staff-only — buyers never
        // send unitPrice, and the price-race check below guards their path anyway.
        unitPrice = overridePrice;
        priceType = PriceType.MANUAL;
        originalPrice = listPrice;
      } else {
        // Apply the customer's sticky upsell when no explicit staff price was typed
        // (buyers never type one). A staff member who enters a price — even == list —
        // is honored verbatim, so they can still sell at list for one order.
        const rememberedForLine =
          user.role === UserRole.CUSTOMER || overridePrice == null
            ? (priceHistory[item.productId]?.lastPrice ?? null)
            : null;
        const resolved = this.resolveBuyerLinePrice(
          product,
          tierForProduct,
          activePromos,
          qtyPieces,
          rememberedForLine,
        );
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
        unitsPerBox: upb,
      });
      subtotal += itemSubtotal;

      // RF-4: regulated per-category (section) tax, snapshotted per line and folded
      // into the order total below. `qtyPieces` is the true piece count — the basis
      // for per-unit levies (EXCISE/DEPOSIT; PER_VOLUME approximates via pieces until
      // Product.volumePerUnit lands). PERCENT_OF_SALE ignores it and uses the subtotal.
      const category = product.trackedCategoryId
        ? categoryMap.get(product.trackedCategoryId)
        : null;
      const categoryTaxAmount = category
        ? computeCategoryTax({
            taxType: category.taxType as CategoryTaxType,
            rate: Number(category.rate),
            unitBasisQty: qtyPieces,
            lineSubtotal: itemSubtotal,
            priceIncludesTax: category.priceIncludesTax,
          })
        : 0;

      return {
        productId: item.productId as string | null,
        name: null as string | null,
        qty,
        boxes,
        pieces,
        // Snapshot the sale-time box size on box-split lines so invoicing and later
        // recompute use it instead of the (mutable) live product size. Selling-unit
        // lines (boxes==null) leave it null — their qty already carries the unit.
        unitsPerBox: boxes != null && upb > 1 ? upb : null,
        unitPrice,
        priceType,
        originalPrice,
        subtotal: itemSubtotal,
        notes: (item as any).itemNote || item.notes,
        // Phase 4 (W4): snapshot the product's regulated category at sale time so
        // invoice generation can split by it (never re-read the live product —
        // categories can be reassigned/deactivated after sale, spec §7).
        trackedCategoryId: (product.trackedCategoryId ?? null) as string | null,
        // RF-3: reporting-only subcategory snapshot at sale time (mirrors the category).
        trackedSubcategoryId: (product.trackedSubcategoryId ?? null) as string | null,
        // RF-4: per-line regulated category tax, snapshotted (folded into the order total).
        categoryTaxAmount,
        tenantId: this.prisma.getTenantId(), // nested creates bypass forTenant() extension
      };
    });

    subtotal = roundMoney(subtotal);
    const orderDiscount = dto.discountAmount ?? 0;
    const tax = roundMoney(subtotal * (await this.getTaxRate()));
    // RF-4: fold the regulated category tax (Σ per-line) into the order total. The
    // `tax` column stays REGULAR tax only; category tax is reconstructable from the
    // line snapshots (Σ categoryTaxAmount), so no dedicated Order column is needed.
    const categoryTax = roundMoney(
      lineItemsData.reduce((s, li) => s + Number(li.categoryTaxAmount ?? 0), 0),
    );
    const total = roundMoney(subtotal + tax + categoryTax - orderDiscount);

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

    // P6-5: customer notification via the rules matrix (fire-and-forget AFTER
    // the status write; notify() no-ops on a disabled cell + meters itself).
    const messagingEventMap: Partial<Record<OrderStatus, NotificationEvent>> = {
      [OrderStatus.CONFIRMED]: NotificationEvent.ORDER_CONFIRMED,
      [OrderStatus.OUT_FOR_DELIVERY]: NotificationEvent.OUT_FOR_DELIVERY,
      [OrderStatus.DELIVERED]: NotificationEvent.DELIVERED,
    };
    const messagingEvent = messagingEventMap[dto.status];
    if (messagingEvent) {
      let driverName = "your driver";
      if (messagingEvent === NotificationEvent.OUT_FOR_DELIVERY && order.routeRunId) {
        const run = await this.prisma.forTenant().routeRun.findUnique({
          where: { id: order.routeRunId },
          select: { driver: { select: { contactName: true } } },
        });
        driverName = run?.driver?.contactName ?? "your driver";
      }
      const vars: Record<string, string> = {
        orderNumber: order.orderNumber ?? "",
        ...(messagingEvent === NotificationEvent.ORDER_CONFIRMED
          ? {
              deliveryDate: formatDate(order.requestedDeliveryDate),
              orderTotal: formatMoney(updated.total),
            }
          : {}),
        ...(messagingEvent === NotificationEvent.OUT_FOR_DELIVERY ? { driverName } : {}),
        ...(messagingEvent === NotificationEvent.DELIVERED
          ? { orderTotal: formatMoney(updated.total) }
          : {}),
      };
      this.messaging
        .notifyEvent(messagingEvent, {
          customerId: order.customerId,
          senderId: user.sub || null,
          vars,
        })
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
      include: {
        lineItems: true,
        routeRun: { select: { status: true, startedAt: true } },
      },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (!["DRAFT", "PENDING", "CONFIRMED"].includes(order.status)) {
      throw new BadRequestException(
        "Items can only be edited on DRAFT, PENDING, or CONFIRMED orders",
      );
    }
    // P5-08 edit window (decision G7): free editing closes the moment the order's
    // stop's RouteRun DISPATCHES (SCHEDULED → IN_PROGRESS, stamped once at
    // RouteRun.startedAt). Past that, edits become post-dispatch change-requests
    // (P5-09), not direct edits. Keys off the RUN, not order.status (run-start
    // never flips the order off CONFIRMED). A CANCELLED run auto-unbinds its orders,
    // so they revert to the freely-editable null-run state — no special case here.
    if (order.routeRun != null && order.routeRun.status !== "SCHEDULED") {
      throw new ConflictException({
        code: "EDIT_WINDOW_CLOSED",
        reason: "DISPATCHED",
        message: "This order is out for delivery and can no longer be edited directly.",
      });
    }

    // If this order already has a SENT pending-mirror invoice, revert it to DRAFT
    // first so the edit below re-syncs into it (auto-revert policy). Runs before any
    // mutation: a paid invoice throws here and the edit is aborted cleanly, so money
    // never detaches from a sent document. No-op when there's no such invoice.
    await this.invoicesService.revertLinkedInvoicesForOrderEdit(orderId);

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

    // P5-08b: reference-data reads (tax rate, active promotions, buyer price
    // history) are hoisted OUT of the transaction below. Each hits the DB on a
    // SEPARATE pooled connection (systemConfig / promotionsService /
    // forTenant().orderItem), so issuing them while the interactive tx holds its
    // own connection risks connection-pool starvation under concurrent edits.
    // Mirrors create(), which loads these before opening its transaction.
    const taxRate = await this.getTaxRate();
    const buyerPromos =
      user?.role === UserRole.CUSTOMER || user?.role === UserRole.DRIVER
        ? await this.loadActivePromotions(user.role)
        : [];
    const buyerPriceHistory =
      user?.role === UserRole.CUSTOMER ? await this.getCustomerPriceHistory(order.customerId) : {};

    // P5-08b: the entire mutation phase — item writes, totals recompute, the
    // stock/credit guards, and the order-header update — runs in ONE tenant
    // transaction. A guard violation (or any failure) rolls back every item
    // write, so a blocked edit leaves the order byte-identical and appends no
    // revision. The guards intentionally consume the AUTHORITATIVE recomputed
    // totals/line set (not a pre-mutation simulation), so there is no second
    // pricing formula to drift. reconcileOrderDraftInvoice and
    // appendOrderRevision stay OUTSIDE (after commit), unchanged.
    const { subtotal, tax, total, shouldRevert } = await this.prisma.tenantTransaction(
      async (tx: any) => {
        // Customer/Driver path: replace items by productId
        if (user?.role === UserRole.CUSTOMER || user?.role === UserRole.DRIVER) {
          if (user.role === UserRole.CUSTOMER) {
            const customer = await tx.customer.findFirst({ where: { userId: user.sub } });
            if (!customer || order.customerId !== customer.id) throw new ForbiddenException();
          }

          // Customers send items as { productId, qty } — replace all line items
          const productIds = dto.items.map((i) => i.productId).filter(Boolean) as string[];
          const products = await tx.product.findMany({ where: { id: { in: productIds } } });
          const productMap = new Map<string, any>(products.map((p: any) => [p.id, p]));

          // P5-04: buyer pricing context (tier + per-product override + active promos).
          // Loaded only for the buyer (CUSTOMER) merge path; DRIVER edits keep the
          // legacy list pricing unchanged. This also corrects a pre-existing bug where
          // the buyer merge billed LIST price, ignoring the customer's tier.
          const isBuyerEdit = user.role === UserRole.CUSTOMER;
          const buyerTierCtx = isBuyerEdit
            ? await tx.customer.findUnique({
                where: { id: order.customerId },
                select: { pricingTier: true },
              })
            : null;
          const buyerDefaultTier = buyerTierCtx?.pricingTier ?? 1;
          const buyerCustomerPrices =
            isBuyerEdit && productIds.length > 0
              ? await tx.customerPrice.findMany({
                  where: { customerId: order.customerId, productId: { in: productIds } },
                })
              : [];
          const buyerCpMap = new Map<string, number>(
            buyerCustomerPrices.map((cp: any) => [cp.productId, cp.pricingTier]),
          );
          // buyerPromos + buyerPriceHistory (sticky upsell) are hoisted above the
          // transaction (pool-starvation fix) and closed over here.

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
          // Every product already carrying a line on this order. A boxed product
          // that is NOT here is being ADDED fresh — on the buyer path its incoming
          // `qty` is always PIECES (the portal create/merge is piece-denominated by
          // design), so it must be split like a box-aware create. Only pre-existing
          // box-UNAWARE lines (above) are protected from re-splitting.
          const existingProductIds = new Set(
            (order.lineItems ?? [])
              .filter((li) => li.productId)
              .map((li) => li.productId as string),
          );

          await tx.orderItem.deleteMany({ where: { orderId } });
          for (const item of dto.items) {
            if (!item.productId) {
              // Preserve an operator-added unlisted (catalog-free) line carried
              // through a buyer's cart merge. Buyers can't author these themselves.
              const name = (item.name ?? "").trim();
              const qty = item.qty ?? 0;
              if (!name || qty <= 0 || item.unitPrice == null) continue;
              const unitPrice = Number(item.unitPrice);
              await tx.orderItem.create({
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
            // Boxed line: `qty` is the piece count, so re-split it and prorate by the
            // BOX price (mirrors createOrder + the operator path). Without this a plain
            // qty*unitPrice over-charges boxed lines by unitsPerBox. Split when the line
            // is already piece-denominated OR (buyer path only) the product is brand-new
            // to the order — a NEW boxed line added via the buyer create/merge path
            // arrives piece-denominated too. Pre-existing box-UNAWARE selling-unit lines
            // keep qty*price, and DRIVER edits keep the strict pieceDenominated gate.
            const upb = Number(product.unitsPerBox ?? 0);
            const shouldSplit =
              upb > 1 &&
              (pieceDenominated.has(item.productId) ||
                (isBuyerEdit && !existingProductIds.has(item.productId)));
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
                  buyerPriceHistory[item.productId]?.lastPrice ?? null,
                )
              : {
                  unitPrice: Number(product.pricePerUnit),
                  originalPrice: null as number | null,
                  priceType: PriceType.STANDARD,
                };
            await tx.orderItem.create({
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
                // Snapshot the sale-time box size on box-split lines (see create()).
                unitsPerBox: boxes != null && upb > 1 ? upb : null,
                originalPrice: priced.originalPrice,
                priceType: priced.priceType,
                status: "PENDING",
                notes: item.notes,
                // Snapshot the regulated category so an edited-in line invoices/ledgers
                // correctly (mirrors orders.service.create; spec §7).
                trackedCategoryId: product.trackedCategoryId ?? null,
                // RF-3: reporting-only subcategory snapshot (mirrors trackedCategoryId).
                trackedSubcategoryId: product.trackedSubcategoryId ?? null,
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
            const products = await tx.product.findMany({ where: { id: { in: productIds } } });
            const productMap = new Map<string, any>(products.map((p: any) => [p.id, p]));

            await tx.orderItem.deleteMany({ where: { orderId } });
            for (const item of dto.items) {
              if (!item.productId) {
                // Unlisted (ad-hoc) line — free-text name + unitPrice, no product
                // lookup, no stock, no boxed proration. Stored as MANUAL-priced.
                const name = (item.name ?? "").trim();
                const qty = item.qty ?? 0;
                if (!name || qty <= 0 || item.unitPrice == null) continue;
                const unitPrice = Number(item.unitPrice);
                await tx.orderItem.create({
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
              await tx.orderItem.create({
                data: {
                  orderId,
                  productId: item.productId,
                  qty,
                  boxes,
                  pieces,
                  // Snapshot the sale-time box size on box-split lines (see create()).
                  unitsPerBox:
                    boxes != null && Number(product.unitsPerBox ?? 0) > 1
                      ? Number(product.unitsPerBox)
                      : null,
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
                  // RF-3: reporting-only subcategory snapshot (mirrors trackedCategoryId).
                  trackedSubcategoryId: product.trackedSubcategoryId ?? null,
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
                await tx.orderItem.create({
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
                const product = await tx.product.findUnique({ where: { id: item.productId } });
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
                await tx.orderItem.create({
                  data: {
                    orderId,
                    productId: item.productId,
                    qty,
                    boxes: item.boxes ?? null,
                    pieces: item.pieces ?? null,
                    // Snapshot the sale-time box size on box-split lines (see create()).
                    unitsPerBox:
                      item.boxes != null && Number(product.unitsPerBox ?? 0) > 1
                        ? Number(product.unitsPerBox)
                        : null,
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
                    // RF-3: reporting-only subcategory snapshot (mirrors trackedCategoryId).
                    trackedSubcategoryId: product.trackedSubcategoryId ?? null,
                  },
                });
                continue;
              }
              if (item.action === "DELETE" && item.id) {
                // Hard-remove a line added by mistake. Only safe when nothing
                // downstream references it — a billed or delivered line is struck
                // off instead so invoice/delivery history stays intact.
                const li = order.lineItems.find((l) => l.id === item.id);
                const hasDeliveries = await tx.deliveryMutation.count({
                  where: { orderItemId: item.id },
                });
                if ((li && Number(li.invoicedQty ?? 0) > 0) || hasDeliveries > 0) {
                  await tx.orderItem.update({
                    where: { id: item.id },
                    data: { status: "CANCELLED", qty: 0, subtotal: 0, boxes: null, pieces: null },
                  });
                } else {
                  await tx.orderItem.delete({ where: { id: item.id } });
                }
              } else if (item.action === "CANCEL") {
                await tx.orderItem.update({
                  where: { id: item.id },
                  data: { status: "CANCELLED", qty: 0, subtotal: 0, boxes: null, pieces: null },
                });
              } else if (item.substituteProductId) {
                const product = await tx.product.findUniqueOrThrow({
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
                await tx.orderItem.update({
                  where: { id: item.id },
                  data: {
                    productId: item.substituteProductId,
                    unitPrice,
                    qty: qtyVal,
                    boxes: item.boxes ?? null,
                    pieces: item.pieces ?? null,
                    // Re-snapshot the substitute's box size on box-split lines.
                    unitsPerBox:
                      item.boxes != null && Number(product.unitsPerBox ?? 0) > 1
                        ? Number(product.unitsPerBox)
                        : null,
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
                    // RF-3: re-snapshot the reporting subcategory alongside the category.
                    trackedSubcategoryId: product.trackedSubcategoryId ?? null,
                  },
                });
              } else if (item.qty !== undefined || item.boxes != null || item.pieces != null) {
                const li = order.lineItems.find((li) => li.id === item.id);
                if (!li) continue;
                const isUnlisted = !li.productId;
                const editHasSplit = item.boxes != null || item.pieces != null;
                const wasBoxSplit = li.boxes != null;
                // Resolve the box size for a catalog line even on a qty-ONLY edit —
                // prefer the line's sale-time snapshot, fall back to the live product.
                // Without this a qty-only edit of a box-split line dropped to non-boxed
                // math (per-piece × BOX price → overcharge) and left stale boxes/pieces.
                let unitsPerBox: number | null = (li as any).unitsPerBox ?? null;
                if (unitsPerBox == null && li.productId && (editHasSplit || wasBoxSplit)) {
                  const product = await tx.product.findUnique({
                    where: { id: li.productId },
                    select: { unitsPerBox: true },
                  });
                  unitsPerBox = product?.unitsPerBox ?? null;
                }
                const upb = Number(unitsPerBox ?? 0);

                // Resolve qty + the box/piece split, PRESERVING the line's denomination:
                //  - an explicit boxes/pieces edit wins;
                //  - else a box-split line re-derives its split from the new qty (box
                //    price prorated, stale boxes/pieces refreshed);
                //  - else a selling-unit / non-boxed line keeps boxes/pieces null.
                let qty: number;
                let boxes: number | null;
                let pieces: number | null;
                if (editHasSplit) {
                  const split = normalizeBoxesPieces({
                    boxes: item.boxes,
                    pieces: item.pieces,
                    unitsPerBox: upb,
                  });
                  qty = split.qty;
                  boxes = split.boxes;
                  pieces = split.pieces;
                } else if (wasBoxSplit && upb > 1) {
                  const split = normalizeBoxesPieces({
                    qty: item.qty ?? Number(li.qty),
                    unitsPerBox: upb,
                  });
                  qty = split.qty;
                  boxes = split.boxes;
                  pieces = split.pieces;
                } else {
                  qty = item.qty ?? Number(li.qty);
                  boxes = null;
                  pieces = null;
                }
                if (qty <= 0) continue;

                const existingUnitPrice = Number(li.unitPrice);
                const overridePrice = item.unitPrice !== undefined ? Number(item.unitPrice) : null;
                const isManualOverride =
                  overridePrice !== null && overridePrice !== existingUnitPrice;
                const unitPrice = isManualOverride ? overridePrice : existingUnitPrice;
                // Anchor the struck-through original to the CATALOG list price (like the
                // replace-all / new-item branches), never the line's prior net price —
                // otherwise re-editing an override (e.g. an upsell nudged down but still
                // above list) would flip its derived upsell/discount direction and show a
                // bogus "was" price to the customer/operator.
                let catalogPrice = existingUnitPrice;
                if (isManualOverride && !isUnlisted && li.productId) {
                  const prod = await tx.product.findUnique({
                    where: { id: li.productId },
                    select: { pricePerUnit: true },
                  });
                  if (prod) catalogPrice = Number(prod.pricePerUnit);
                }
                const subtotal = computeLineSubtotal({
                  unitPrice,
                  qty,
                  boxes,
                  pieces,
                  unitsPerBox: upb,
                });
                await tx.orderItem.update({
                  where: { id: item.id },
                  data: {
                    qty,
                    // Always set the split explicitly so a qty-only edit can't leave
                    // stale boxes/pieces behind (the reverse-divergence class).
                    boxes,
                    pieces,
                    unitsPerBox: boxes != null && upb > 1 ? upb : null,
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
                            originalPrice: catalogPrice,
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
        const activeItems = await tx.orderItem.findMany({
          where: { orderId, status: { not: "CANCELLED" } },
        });
        const subtotal = roundMoney(activeItems.reduce((s, li) => s + Number(li.subtotal), 0));
        const tax = roundMoney(subtotal * taxRate);
        // RF-4: re-derive + persist each regulated line's category tax from the
        // edited set and fold Σ into the total (kept out of the `tax` column, which
        // stays regular tax only). `total` is reused by the credit guard + revision.
        const categoryTax = await this.recomputeLineCategoryTaxes(tx, activeItems);
        const total = roundMoney(subtotal + tax + categoryTax);

        // P5-08b inline guards (completes P5-08 "credit / regulated / stock-
        // violating edit blocked inline"). DRAFT edits are exempt, matching the
        // regulated guard above and create()'s !isDraft stock gate — a draft
        // edit isn't a sale yet. Order: stock first (more actionable message),
        // then credit. A throw here rolls back the whole transaction.
        if (order.status !== "DRAFT") {
          await this.assertStockAvailableForEdit(tx, order, activeItems, user);
          await this.assertWithinCreditLimit(
            tx,
            order.customerId,
            orderId,
            // The exact total the order.update below writes — Σ of stored
            // computeLineSubtotal results + regular tax + category tax, cents-
            // rounded. Note: mirrors the existing edit recompute, which
            // (pre-existing) does not subtract Order.discountAmount.
            total,
          );
        }

        // Revert CONFIRMED (or later) orders back to PENDING when items are edited
        // so the office must re-confirm the updated pick list before dispatch.
        // F10-002: a CUSTOMER editing their own CONFIRMED order MUST also force
        // re-confirmation — otherwise a buyer could silently mutate the items and
        // totals of an already-confirmed order. DRIVER edits still don't revert
        // (drivers don't own the pick list; their change-request flow is separate).
        const shouldRevert =
          !["DRAFT", "PENDING"].includes(order.status) && user?.role !== UserRole.DRIVER;
        const revertNote = shouldRevert
          ? `\n[${new Date().toLocaleDateString()} – items edited, reverted to PENDING]`
          : undefined;

        await tx.order.update({
          where: { id: orderId },
          data: {
            subtotal,
            tax,
            total,
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
        return { subtotal, tax, total, shouldRevert };
      },
      // Headroom over Prisma's 5s default: the merge branch issues per-line
      // queries inside the transaction (same shape as create()'s in-tx per-line work).
      { timeout: 15_000 },
    );

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

    // P5-08: append an immutable revision snapshot of the post-edit state. Runs
    // last — only after guards passed and every write committed — so a blocked or
    // failed edit never records a revision. Totals copied verbatim (never recomputed).
    await this.appendOrderRevision(
      orderId,
      user,
      { subtotal, tax, total },
      "EDIT",
      dto.orderNotes ?? null,
    );

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
   * P5-08: append one immutable OrderRevision row capturing the order's line set +
   * money totals AFTER an edit. The snapshot COPIES stored, already-rounded values
   * verbatim — it never re-prices (no `qty*unitPrice`, no re-derived discounts). The
   * per-order `revisionNumber` (max+1) is computed inside a tenant transaction so
   * rapid autosaves can't collide on the `@@unique([orderId, revisionNumber])`.
   */
  private async appendOrderRevision(
    orderId: string,
    user: JwtPayload | undefined,
    totals: { subtotal: number; tax: number; total: number },
    source: string,
    reason?: string | null,
  ) {
    const tenantId = this.prisma.getTenantId();
    const lines = await this.prisma.forTenant().orderItem.findMany({
      where: { orderId, status: { not: "CANCELLED" } },
      include: { product: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
    });
    const snapshot = {
      subtotal: totals.subtotal,
      tax: totals.tax,
      total: totals.total,
      lineItems: lines.map((li) => ({
        productId: li.productId,
        name: li.name ?? li.product?.name ?? null,
        qty: Number(li.qty),
        unitPrice: Number(li.unitPrice),
        subtotal: Number(li.subtotal),
        originalPrice: li.originalPrice != null ? Number(li.originalPrice) : null,
        priceType: li.priceType,
        boxes: li.boxes,
        pieces: li.pieces,
        unitsPerBox: li.unitsPerBox,
        trackedCategoryId: li.trackedCategoryId,
        trackedSubcategoryId: li.trackedSubcategoryId,
        notes: li.notes,
        status: li.status,
      })),
    };
    await this.prisma.tenantTransaction(async (tx) => {
      const max = await tx.orderRevision.aggregate({
        where: { orderId },
        _max: { revisionNumber: true },
      });
      await tx.orderRevision.create({
        data: {
          tenantId,
          orderId,
          revisionNumber: (max._max.revisionNumber ?? 0) + 1,
          editedById: user?.sub ?? null,
          editedByName: user?.username ?? null,
          editedByRole: user?.role ?? null,
          source,
          reason: reason ?? null,
          snapshot,
        },
      });
    });
  }

  /**
   * P5-08b stock guard — VALIDATE-ONLY, delta-based. Never decrements stock.
   *
   * Lifecycle (why delta, not absolute): create() already decremented
   * Product.currentStock for every non-draft line under a row lock (RF-017,
   * create() ~line 1196-1249), so the order's existing lines are already "out
   * of" currentStock; delivery decrements separately via
   * InventoryService.recordSale. Edits never touch stock. An edit therefore
   * only needs the INCREASE over what the order already holds to be coverable;
   * requiring the absolute qty would false-block any edit of an order whose
   * own creation emptied the shelf (stock 10 → order of 10 → currentStock 0 →
   * a same-qty edit would 409). Brand-new lines have held = 0, so they need
   * full coverage — identical to create()'s check.
   *
   * Role semantics mirror create(): CUSTOMER/DRIVER hard-block (409
   * INSUFFICIENT_STOCK), everyone else (operator/admin/undefined = internal
   * caller) may knowingly oversell — warn-only log. Quantities compare in each
   * line's own stored denomination (pieces for box-split lines, selling units
   * otherwise) — the same mixed-denomination convention create() uses against
   * currentStock. No SELECT ... FOR UPDATE: this guard reserves nothing, so a
   * lock would close no race. Unknown/missing product rows and non-numeric
   * quantities fail OPEN (skip) — same posture as create()'s `if (p && ...)`.
   */
  private async assertStockAvailableForEdit(
    db: any,
    order: { id: string; status: string; lineItems: any[] },
    finalActiveItems: Array<{ productId: string | null; qty: any }>,
    user?: JwtPayload,
  ): Promise<void> {
    // Qty the order already holds per product (pre-edit, non-cancelled lines).
    const held = new Map<string, number>();
    for (const li of order.lineItems ?? []) {
      if (li.productId && li.status !== "CANCELLED") {
        held.set(li.productId, (held.get(li.productId) ?? 0) + Number(li.qty));
      }
    }
    // Qty the edit requests per product (post-edit active line set).
    const requested = new Map<string, number>();
    for (const li of finalActiveItems) {
      if (li.productId) {
        requested.set(li.productId, (requested.get(li.productId) ?? 0) + Number(li.qty));
      }
    }
    const increases = [...requested.entries()]
      .map(([productId, req]) => ({
        productId,
        requested: req,
        delta: req - (held.get(productId) ?? 0),
      }))
      .filter((x) => x.delta > 0);
    if (increases.length === 0) return;

    const products = await db.product.findMany({
      where: { id: { in: increases.map((x) => x.productId) } },
      select: { id: true, name: true, currentStock: true },
    });
    const violations: Array<{
      productId: string;
      name: string;
      available: number;
      requested: number;
      delta: number;
    }> = [];
    for (const inc of increases) {
      const p = products.find((lp: any) => lp.id === inc.productId);
      if (p && Number(p.currentStock) < inc.delta) {
        violations.push({
          productId: inc.productId,
          name: p.name,
          available: Number(p.currentStock),
          requested: inc.requested,
          delta: inc.delta,
        });
      }
    }
    if (violations.length === 0) return;

    if (user?.role !== UserRole.CUSTOMER && user?.role !== UserRole.DRIVER) {
      // Operators/admins may oversell — matches create()'s warn-only path.
      this.logger.warn(
        `Operator edit of order ${order.id} will go below stock: ` +
          violations
            .map((v) => `${v.name} (available: ${v.available}, requested increase: ${v.delta})`)
            .join("; "),
      );
      return;
    }
    const first = violations[0];
    throw new ConflictException({
      code: "INSUFFICIENT_STOCK",
      message:
        `Not enough stock for ${first.name} ` +
        `(available: ${first.available}, requested: ${first.requested}).`,
      productId: first.productId,
      available: first.available,
      requested: first.requested,
    });
  }

  /**
   * P5-08b credit-limit guard — the FIRST credit enforcement in the codebase
   * (verified: no other creditLimit read exists in apps/api/src outside DTOs).
   *
   * Exposure mirrors customers.service.ts getStatementForOperator (the
   * authoritative statement derivation — do NOT invent a second balance
   * formula):
   *   • open invoice balances: status ∉ {PAID, VOID, WRITTEN_OFF}, each worth
   *     Number(total) − Σ payments.amount (statement's `outstanding`);
   *   • open-order totals: status ∈ {PENDING, CONFIRMED, OUT_FOR_DELIVERY}
   *     (statement's `pendingOrdersAmount`) — but ONLY orders with no counted
   *     open invoice, else every order carrying a draft/sent mirror invoice
   *     (reconcileOrderDraftInvoice keeps one in lockstep) counts twice;
   *   • the order being edited is EXCLUDED from both buckets and represented
   *     by projectedOrderTotal instead. Exact, not approximate: an editable
   *     order's linked invoice can never carry payments —
   *     revertLinkedInvoicesForOrderEdit (already called by updateOrderItems)
   *     throws if it does;
   *   • credit notes / advance payments are NOT netted (the statement reports
   *     them separately from outstandingAmount; netting loosens a money guard);
   *   • the Transaction model is NOT read — delivered orders have BOTH a
   *     Transaction and an invoice, so mixing the two double-counts.
   *
   * creditLimit == null (or customer row not found) → no limit → no check.
   * Blocks ALL roles — money exposure is stricter than stock (operators may
   * oversell, they may not silently extend credit); the shared error code
   * leaves room for a future explicit operator-override flow.
   *
   * Runs INSIDE the updateOrderItems transaction, after the totals recompute:
   * projectedOrderTotal is the SAME roundMoney(subtotal + tax) the order.update
   * persists. A throw rolls the whole edit back.
   */
  private async assertWithinCreditLimit(
    db: any,
    customerId: string,
    currentOrderId: string,
    projectedOrderTotal: number,
  ): Promise<void> {
    const customer = await db.customer.findUnique({
      where: { id: customerId },
      select: { creditLimit: true },
    });
    if (customer?.creditLimit == null) return;
    const limit = Number(customer.creditLimit);

    // JS-side exclusion of the edited order's invoices (avoids SQL null
    // semantics of `not` on the nullable orderId column).
    const openInvoices = (
      await db.invoice.findMany({
        where: {
          customerId,
          status: {
            notIn: [InvoiceStatus.PAID, InvoiceStatus.VOID, InvoiceStatus.WRITTEN_OFF],
          },
        },
        select: {
          total: true,
          orderId: true,
          payments: { select: { amount: true, status: true } },
        },
      })
    ).filter((inv: any) => inv.orderId !== currentOrderId);

    // Exclude VOID payments: a bounced check (P5-12) flips its InvoicePayment to VOID
    // and reverts the invoice to OPEN/PARTIAL, so a reversed payment must NOT reduce the
    // customer's credit exposure — otherwise a bounce lets them slip under the limit.
    const invoiceExposure = openInvoices.reduce(
      (sum: number, inv: any) =>
        sum +
        (Number(inv.total) -
          inv.payments
            .filter((p: any) => p.status !== "VOID")
            .reduce((s: number, p: any) => s + Number(p.amount), 0)),
      0,
    );

    const invoicedOrderIds = new Set(openInvoices.map((inv: any) => inv.orderId).filter(Boolean));
    const openOrders = await db.order.findMany({
      where: {
        customerId,
        status: {
          in: [OrderStatus.PENDING, OrderStatus.CONFIRMED, OrderStatus.OUT_FOR_DELIVERY],
        },
      },
      select: { id: true, total: true },
    });
    const uninvoicedOrderExposure = openOrders
      .filter((o: any) => o.id !== currentOrderId && !invoicedOrderIds.has(o.id))
      .reduce((sum: number, o: any) => sum + Number(o.total), 0);

    const exposure = roundMoney(invoiceExposure + uninvoicedOrderExposure + projectedOrderTotal);
    if (exposure > limit) {
      throw new ConflictException({
        code: "CREDIT_LIMIT_EXCEEDED",
        message:
          `This edit would take the customer's exposure to ${exposure.toFixed(2)}, ` +
          `over their credit limit of ${limit.toFixed(2)}.`,
        limit,
        exposure,
      });
    }
  }

  /**
   * P5-09: public credit re-check for the change-request next-delivery path.
   * Reuses the ONE exposure derivation (assertWithinCreditLimit) — never a
   * second balance formula.
   */
  async assertCreditForProjectedOrder(
    customerId: string,
    excludeOrderId: string,
    projectedTotal: number,
  ): Promise<void> {
    await this.assertWithinCreditLimit(
      this.prisma.forTenant(),
      customerId,
      excludeOrderId,
      projectedTotal,
    );
  }

  /**
   * P5-09 (G6): approve a PENDING ChangeRequest at the stop and merge its delta
   * into the dispatched order's live line set. The invoice merge is indirect and
   * reuses the existing money path end-to-end: the delta lands on OrderItem rows
   * (stored, already-rounded computeLineSubtotal results), the pending-mirror
   * draft invoice is re-synced via reconcileOrderDraftInvoice, and the eventual
   * completeStop bills delivered lines by copying/prorating those stored
   * subtotals. No new pricing/invoice formula exists here.
   *
   * Concurrency (G6): the conditional updateMany(status=PENDING) INSIDE the
   * transaction is the lock — first resolution wins; count===0 → 409; any later
   * throw (guards, validation) rolls the claim back with the merge.
   *
   * Guards re-run on approval (G6): regulated license BEFORE the tx (mirrors
   * updateOrderItems :1642-1658), stock + credit INSIDE the tx on the
   * authoritative recomputed line set (mirrors :2175-2187).
   */
  async approveChangeRequestAtStop(
    crId: string,
    resolver: JwtPayload,
    reason?: string | null,
  ): Promise<{ merged: true; subtotal: number; tax: number; total: number }> {
    const cr = await this.prisma.forTenant().changeRequest.findUnique({ where: { id: crId } });
    if (!cr) throw new NotFoundException("Change request not found");
    if (cr.status !== ChangeRequestStatus.PENDING) {
      throw new ConflictException({ code: "CHANGE_REQUEST_ALREADY_RESOLVED", status: cr.status });
    }
    const payload = cr.payload as any;

    const order = await this.prisma.forTenant().order.findUnique({
      where: { id: cr.orderId },
      include: {
        lineItems: true,
        routeRun: { select: { id: true, status: true, driverId: true } },
        routeRunStop: { select: { id: true, status: true } },
      },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (!["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY"].includes(order.status)) {
      throw new ConflictException({ code: "CHANGE_WINDOW_CLOSED", reason: "ORDER_STATUS" });
    }
    if (order.routeRun == null || order.routeRun.status !== "IN_PROGRESS") {
      throw new ConflictException({ code: "CHANGE_WINDOW_CLOSED", reason: "RUN_NOT_ACTIVE" });
    }
    if (
      order.routeRunStop != null &&
      ["COMPLETED", "SKIPPED"].includes(order.routeRunStop.status)
    ) {
      // The at-door authority window is over — resolve as next-delivery instead.
      throw new ConflictException({ code: "STOP_ALREADY_COMPLETED" });
    }

    // NOTE-type requests carry no money delta: claim + return, nothing else.
    if (cr.type === ChangeRequestType.NOTE) {
      const claimed = await this.prisma.forTenant().changeRequest.updateMany({
        where: { id: cr.id, status: ChangeRequestStatus.PENDING },
        data: {
          status: ChangeRequestStatus.APPROVED,
          resolution: "MERGED_AT_STOP",
          resolutionReason: reason ?? null,
          resolvedById: resolver.sub ?? null,
          resolvedByName: resolver.username ?? null,
          resolvedByRole: resolver.role ?? null,
          resolvedAt: new Date(),
        },
      });
      if (claimed.count !== 1) {
        throw new ConflictException({ code: "CHANGE_REQUEST_ALREADY_RESOLVED" });
      }
      const subtotal = Number(order.subtotal);
      const tax = Number(order.tax);
      return { merged: true, subtotal, tax, total: Number(order.total) };
    }

    // Regulated license guard re-runs on approval for the incoming product
    // (mirrors updateOrderItems :1642-1658; ORDER-scoped §8 overrides apply).
    if (cr.type === ChangeRequestType.ADD_ITEM) {
      const prod = await this.prisma.forTenant().product.findUnique({
        where: { id: (cr.productId ?? payload.productId) as string },
        select: { id: true, trackedCategoryId: true },
      });
      if (!prod) throw new BadRequestException("Product no longer exists");
      await this.authGuard.assertAuthorizedOrThrow({
        customerId: order.customerId,
        lines: [{ trackedCategoryId: prod.trackedCategoryId ?? null }],
        orderId: order.id,
      });
    }

    // Auto-revert a SENT pending-mirror invoice to DRAFT so the merge re-syncs
    // into it; throws if it carries payments (money never detaches). Mirrors
    // updateOrderItems :1630-1634.
    await this.invoicesService.revertLinkedInvoicesForOrderEdit(order.id);

    // P5-08b posture: reference reads on separate pooled connections are
    // hoisted BEFORE the interactive tx (pool-starvation guard, :1660-1672).
    const taxRate = await this.getTaxRate();
    const buyerPromos =
      cr.type === ChangeRequestType.ADD_ITEM
        ? await this.loadActivePromotions(UserRole.CUSTOMER)
        : [];
    const priceHistory =
      cr.type === ChangeRequestType.ADD_ITEM
        ? await this.getCustomerPriceHistory(order.customerId)
        : {};

    const { subtotal, tax, total } = await this.prisma.tenantTransaction(
      async (tx: any) => {
        // ── G6 atomic claim: FIRST resolution wins and LOCKS ─────────────────
        const claimed = await tx.changeRequest.updateMany({
          where: { id: cr.id, status: ChangeRequestStatus.PENDING },
          data: {
            status: ChangeRequestStatus.APPROVED,
            resolution: "MERGED_AT_STOP",
            resolutionReason: reason ?? null,
            resolvedById: resolver.sub ?? null,
            resolvedByName: resolver.username ?? null,
            resolvedByRole: resolver.role ?? null,
            resolvedAt: new Date(),
          },
        });
        if (claimed.count !== 1) {
          throw new ConflictException({ code: "CHANGE_REQUEST_ALREADY_RESOLVED" });
        }

        let mutationRow: {
          orderItemId: string | null;
          productId: string | null;
          qty: number;
          note: string;
        } | null = null;

        if (cr.type === ChangeRequestType.CHANGE_QTY || cr.type === ChangeRequestType.REMOVE_ITEM) {
          const targetId = (cr.orderItemId ?? payload.orderItemId) as string;
          const li = order.lineItems.find((l) => l.id === targetId);
          if (!li || li.status === "CANCELLED") {
            throw new BadRequestException("Order line not found or already cancelled");
          }
          if (Number(li.deliveredQty) > 0) {
            throw new ConflictException({ code: "LINE_ALREADY_DELIVERED" });
          }
          if (cr.type === ChangeRequestType.REMOVE_ITEM) {
            // CANCEL semantics, never hard-delete post-dispatch — a mirror
            // invoice line may reference it (mirrors updateOrderItems :2003-2007).
            await tx.orderItem.update({
              where: { id: li.id },
              data: { status: "CANCELLED", qty: 0, subtotal: 0, boxes: null, pieces: null },
            });
            mutationRow = {
              orderItemId: li.id,
              productId: li.productId,
              qty: -Number(li.qty),
              note: `Line removed via approved change request ${cr.id}`,
            };
          } else {
            // Qty change — EXACTLY the operator qty-edit math (:2053-2157):
            // preserve denomination, keep the line's stored (agreed) unitPrice,
            // recompute subtotal via computeLineSubtotal. NEVER qty*unitPrice
            // on a boxed line.
            const newQty = Number(payload.newQty);
            if (!(newQty > 0)) {
              throw new BadRequestException("newQty must be > 0 — use REMOVE_ITEM instead");
            }
            let upb = Number((li as any).unitsPerBox ?? 0);
            if (upb === 0 && li.productId && li.boxes != null) {
              const p = await tx.product.findUnique({
                where: { id: li.productId },
                select: { unitsPerBox: true },
              });
              upb = Number(p?.unitsPerBox ?? 0);
            }
            const wasBoxSplit = li.boxes != null;
            const split =
              wasBoxSplit && upb > 1
                ? normalizeBoxesPieces({ qty: newQty, unitsPerBox: upb })
                : { qty: newQty, boxes: null as number | null, pieces: null as number | null };
            const unitPrice = Number(li.unitPrice);
            await tx.orderItem.update({
              where: { id: li.id },
              data: {
                qty: split.qty,
                boxes: split.boxes,
                pieces: split.pieces,
                unitsPerBox: split.boxes != null && upb > 1 ? upb : null,
                subtotal: computeLineSubtotal({
                  unitPrice,
                  qty: split.qty,
                  boxes: split.boxes,
                  pieces: split.pieces,
                  unitsPerBox: upb,
                }),
              },
            });
            mutationRow = {
              orderItemId: li.id,
              productId: li.productId,
              qty: split.qty - Number(li.qty),
              note: `Qty ${Number(li.qty)} -> ${split.qty} via approved change request ${cr.id}`,
            };
          }
        } else if (cr.type === ChangeRequestType.ADD_ITEM) {
          const product = await tx.product.findUnique({
            where: { id: (cr.productId ?? payload.productId) as string },
          });
          if (!product) throw new BadRequestException("Product no longer exists");
          const upb = Number(product.unitsPerBox ?? 0);
          const addQty = Number(payload.qty);
          if (!(addQty > 0)) throw new BadRequestException("qty must be > 0");

          const existing = order.lineItems.find(
            (l) =>
              l.productId === product.id &&
              l.status !== "CANCELLED" &&
              Number(l.deliveredQty) === 0,
          );
          if (existing) {
            // Same product already on the order → increase THAT line at its
            // stored (agreed) unitPrice; the agreed price always wins.
            const lineUpb = Number((existing as any).unitsPerBox ?? upb);
            const wasBoxSplit = existing.boxes != null;
            const newQty = Number(existing.qty) + addQty;
            const split =
              wasBoxSplit && lineUpb > 1
                ? normalizeBoxesPieces({ qty: newQty, unitsPerBox: lineUpb })
                : { qty: newQty, boxes: null as number | null, pieces: null as number | null };
            const unitPrice = Number(existing.unitPrice);
            await tx.orderItem.update({
              where: { id: existing.id },
              data: {
                qty: split.qty,
                boxes: split.boxes,
                pieces: split.pieces,
                unitsPerBox: split.boxes != null && lineUpb > 1 ? lineUpb : null,
                subtotal: computeLineSubtotal({
                  unitPrice,
                  qty: split.qty,
                  boxes: split.boxes,
                  pieces: split.pieces,
                  unitsPerBox: lineUpb,
                }),
              },
            });
            mutationRow = {
              orderItemId: existing.id,
              productId: product.id,
              qty: addQty,
              note: `Added ${addQty} at the door via approved change request ${cr.id}`,
            };
          } else {
            // New line → the CUSTOMER's effective price (tier → sticky upsell →
            // promo), the exact buyer create/merge pricing path (:1775-1787).
            // The buyer pays regardless of who requested, so customer pricing
            // applies uniformly.
            const buyerTier =
              (
                await tx.customer.findUnique({
                  where: { id: order.customerId },
                  select: { pricingTier: true },
                })
              )?.pricingTier ?? 1;
            const cp = await tx.customerPrice.findFirst({
              where: { customerId: order.customerId, productId: product.id },
            });
            const hasSplit = payload.boxes != null || payload.pieces != null;
            const split = hasSplit
              ? normalizeBoxesPieces({
                  boxes: payload.boxes,
                  pieces: payload.pieces,
                  unitsPerBox: upb,
                })
              : { qty: addQty, boxes: null as number | null, pieces: null as number | null };
            const qtyPieces = split.boxes != null ? split.qty : upb > 1 ? addQty * upb : addQty;
            const priced = this.resolveBuyerLinePrice(
              product,
              cp?.pricingTier ?? buyerTier,
              buyerPromos,
              qtyPieces,
              priceHistory[product.id]?.lastPrice ?? null,
            );
            const created = await tx.orderItem.create({
              data: {
                orderId: order.id,
                productId: product.id,
                qty: split.qty,
                boxes: split.boxes,
                pieces: split.pieces,
                unitsPerBox: split.boxes != null && upb > 1 ? upb : null,
                unitPrice: priced.unitPrice,
                originalPrice: priced.originalPrice,
                priceType: priced.priceType,
                subtotal: computeLineSubtotal({
                  unitPrice: priced.unitPrice,
                  qty: split.qty,
                  boxes: split.boxes,
                  pieces: split.pieces,
                  unitsPerBox: upb,
                }),
                status: "PENDING",
                notes: cr.note ?? null,
                trackedCategoryId: product.trackedCategoryId ?? null,
                // RF-3: reporting-only subcategory snapshot (mirrors trackedCategoryId).
                trackedSubcategoryId: product.trackedSubcategoryId ?? null,
              },
            });
            mutationRow = {
              orderItemId: created.id,
              productId: product.id,
              qty: split.qty,
              note: `Added at the door via approved change request ${cr.id}`,
            };
          }
        }

        // ── Totals recompute — identical to updateOrderItems :2163-2168 ──────
        const activeItems = await tx.orderItem.findMany({
          where: { orderId: order.id, status: { not: "CANCELLED" } },
        });
        const subtotal = roundMoney(activeItems.reduce((s, l) => s + Number(l.subtotal), 0));
        const tax = roundMoney(subtotal * taxRate);
        // RF-4: re-derive + persist each regulated line's category tax from the
        // post-change set and fold Σ into the total (kept out of the `tax` column).
        const categoryTax = await this.recomputeLineCategoryTaxes(tx, activeItems);
        const total = roundMoney(subtotal + tax + categoryTax);

        // ── G6: stock + credit guards RE-RUN inside the tx (:2175-2187).
        // A throw rolls back the claim AND the merge. Resolver role drives the
        // stock guard's block/warn semantics (DRIVER hard-blocks; operators
        // warn-only, matching create()/edit posture). Credit blocks all roles.
        await this.assertStockAvailableForEdit(tx, order, activeItems, resolver);
        await this.assertWithinCreditLimit(tx, order.customerId, order.id, total);

        // NO status revert here — post-dispatch orders must NOT flip to PENDING
        // (the shouldRevert logic in updateOrderItems is pre-dispatch-only).
        await tx.order.update({
          where: { id: order.id },
          data: {
            subtotal,
            tax,
            total,
            hasRegulated: activeItems.some((l) => l.trackedCategoryId != null),
          },
        });

        // ── Provenance: the DeliveryMutation row recording the at-door merge
        // (the P5-09 primitive; same table completeStop writes :2638-2650).
        if (mutationRow) {
          const driverId =
            resolver.role === UserRole.DRIVER
              ? ((await tx.driver.findFirst({ where: { userId: resolver.sub } }))?.id ?? null)
              : null;
          await tx.deliveryMutation.create({
            data: {
              orderId: order.id,
              orderItemId: mutationRow.orderItemId,
              productId: mutationRow.productId,
              routeRunStopId: order.routeRunStopId ?? cr.routeRunStopId ?? null,
              type:
                cr.type === ChangeRequestType.REMOVE_ITEM
                  ? MutationType.REFUSED
                  : MutationType.ADD_ON,
              qty: mutationRow.qty,
              note: mutationRow.note,
              driverId,
            },
          });
        }
        return { subtotal, tax, total };
      },
      { timeout: 15_000 },
    );

    // Post-commit, mirrors updateOrderItems :2222-2246: mirror draft invoice in
    // lockstep + immutable revision. Never a new money formula.
    await this.invoicesService.reconcileOrderDraftInvoice(order.id, { basis: "order" });
    await this.appendOrderRevision(
      order.id,
      resolver,
      { subtotal, tax, total },
      "CHANGE_REQUEST",
      cr.note ?? null,
    );

    return { merged: true, subtotal, tax, total };
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

    // Ownership gate (security F2-002): this route has no RolesGuard, so without
    // this any authenticated CUSTOMER could enumerate order ids and read another
    // customer's route/driver/stop/delivery-window. Mirror findOne's CUSTOMER gate.
    if (user.role === UserRole.CUSTOMER) {
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub } });
      if (!customer || customer.id !== order.customerId) throw new ForbiddenException();
    }

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
