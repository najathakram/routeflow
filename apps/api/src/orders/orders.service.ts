import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  ServiceUnavailableException,
} from "@nestjs/common";
import { LeaderCron } from "../common/cron-lock";
import { InjectQueue } from "@nestjs/bull";
import type { Queue } from "bull";
import { PrismaService } from "../prisma/prisma.service";
import { JwtPayload } from "../auth/jwt-payload.interface";
import {
  applyBestPromotion,
  computeCategoryTax,
  computeLineSubtotal,
  effectiveBuyerPrice,
  getTierPrice,
  normalizeBoxesPieces,
  promotionMatchesProduct,
  roundMoney,
  isBlockingPayment,
  type CategoryTaxType,
  type PromoContext,
  type PromotionRule,
} from "@routeflow/pricing";
import { lockRowsNoWait, withAdvisoryLock, type LockMode } from "../common/db-locks";
import { assertMoneyInvariantsOrThrow } from "../common/money-invariants.util";
import {
  LOCK_UNAVAILABLE,
  LOCK_UNAVAILABLE_MESSAGE,
  isMergeContention,
  mapLockError,
} from "./merge-contention";
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
  FulfillPath,
  RouteRunStatus,
  RouteRunStopStatus,
} from "@prisma/client";
import { ListOrdersDto } from "./dto/list-orders.dto";
import { AppliedCreditNoteDto, CreateOrderDto } from "./dto/create-order.dto";
import {
  IDEMPOTENCY_KEY_CONFLICT,
  IDEMPOTENCY_REPLAY_NEEDS_RECONCILE,
  shouldSkipInPlaceResync,
} from "./merge-idempotency";
import { CreateSaleDto } from "./dto/create-sale.dto";
import { ChangeOrderStatusDto } from "./dto/change-order-status.dto";
import { UpdateOrderItemsDto } from "./dto/update-order-items.dto";
import { UpdateShipmentDto } from "./dto/update-shipment.dto";
import { UpdateFulfillPathDto } from "./dto/update-fulfill-path.dto";
import {
  assertRegulatedDeliverySatisfied,
  deriveStopRegulatedRequirements,
  loadAgeIdCategorySets,
  type RegulatedDeliveryDb,
} from "../common/regulated-delivery";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { TenantContextService } from "../tenant/tenant-context.service";
import { redactUpsellForCustomer } from "../common/upsell-redaction";
import { currentTaxRate } from "../common/tax-rate";
import { NotificationsService } from "../notifications/notifications.service";
import { InvoicesService } from "../invoices/invoices.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { InventoryService } from "../inventory/inventory.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { PromotionsService } from "../promotions/promotions.service";
import { MessagingService } from "../messaging/messaging.service";
import { formatDate, formatMoney } from "../messaging/messaging.helpers";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { assertNoUnspentSourcedCredits } from "../credit-notes/sourced-credit-guard";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { sumInlineReturnCredit } from "../returns/inline-return-credit.util";

/**
 * B63 (REG-B63): the statuses past which a BUYER may no longer self-edit an
 * order's items. `updateOrderItems`'s write gate and the read-side `editWindow`
 * descriptor (`computeEditWindow`) both read THIS list, so a buyer client is
 * never told the window is open on an order the API is about to refuse.
 * Operators and drivers keep editing at every live stage.
 */
const BUYER_EDIT_CLOSED_STATUSES: OrderStatus[] = [
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.PARTIALLY_DELIVERED,
  OrderStatus.DELIVERED,
];

/**
 * B215: the statuses whose linked invoice(s) are re-synced IN PLACE after an item edit
 * (`postDeliveryEdit`) instead of reconciled as an open pending-mirror draft. Read by
 * `updateOrderItems` AND by `replayMergeReconcile`, so a replayed merge routes the
 * convergent reconcile exactly as the fold that landed did — the list may not drift
 * between the two callers.
 */
const POST_DELIVERY_EDIT_STATUSES: string[] = [
  OrderStatus.OUT_FOR_DELIVERY,
  OrderStatus.PARTIALLY_DELIVERED,
  OrderStatus.DELIVERED,
];

/** B465: a tier different from 1 (list/STANDARD) is this customer's documented
 * contract price for the product — shared by every call site that must decide
 * whether a line is a SPECIAL-tier line, never re-derived ad hoc. A module-level
 * pure function (not a class method) so it works when called detached from an
 * OrdersService instance — e.g. `(OrdersService.prototype as any).resolveBuyerLinePrice(...)`
 * in order-templates.service.spec.ts, where `this` inside resolveBuyerLinePrice
 * is undefined and `this.isSpecialTier(...)` would throw (#815 verify finding). */
export const isSpecialTier = (tierForProduct: number): boolean => tierForProduct !== 1;

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
    private readonly creditNotes: CreditNotesService,
    private readonly commissionEngine: CommissionEngineService,
    private readonly entitlements: EntitlementsService,
    // B65 (REG-B65): reverses regulated-ledger entries in deleteOrder's
    // per-invoice teardown — the two sibling paths (voidInvoiceInTx,
    // deleteInvoice) already do this.
    private readonly ledger: RegulatedLedgerService,
    // B323: the hourly/boot-time pending-order sweep has no HTTP request, so ALS is
    // empty — sweepAllPendingOrders() re-enters each customer's own tenant scope
    // via tenantCtx.run() (the RF-008 pattern already used by recurring-invoices,
    // tobacco-report, order-templates, authorization-expiry, commission-reconciliation
    // and regulated-filing-cron) so every forTenant() call inside the merge resolves
    // that tenant's own config/data, never another tenant's.
    private readonly tenantCtx: TenantContextService,
  ) {}

  /**
   * P5-04: active promotions for the current tenant (window + isActive filtered).
   * Only loaded for the buyer (CUSTOMER) self-service path; empty for staff so
   * operator/driver order pricing is byte-for-byte unchanged.
   * Shared with OrderTemplatesService (REG-B48): a standing order is priced as
   * the customer's own buyer checkout, whoever triggers it.
   */
  async loadActivePromotions(role: UserRole): Promise<PromotionRule[]> {
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
   * Shared with OrderTemplatesService (REG-B48): a standing order is priced as
   * the customer's own buyer checkout, whoever triggers it.
   */
  resolveBuyerLinePrice(
    product: { id: string; category: string | null; pricePerUnit: unknown },
    tierForProduct: number,
    promos: PromotionRule[],
    qtyPieces: number,
    qtyUnits: number,
    rememberedPrice?: number | null,
    /**
     * REG-B109: the line's box/piece denomination — the SAME values the caller
     * then feeds `computeLineSubtotal` — so promo SELECTION compares candidates
     * by the money this line will actually be billed, loose pieces included.
     * Without it, a mixed line (whole boxes + loose pieces) is compared on whole
     * boxes only and a BUY_N_GET_M can beat a deeper price promo that in fact
     * bills less. Optional and defaulted: omitting it keeps the whole-selling-unit
     * approximation, which is already exact for any line with no loose pieces.
     */
    denomination?: {
      boxes: number | null;
      pieces: number | null;
      unitsPerBox: number | null;
    },
  ): {
    unitPrice: number;
    originalPrice: number | null;
    priceType: PriceType;
    /** BUY_N_GET_M: whole free selling units this line earned. 0 for every other case. */
    freeUnits: number;
  } {
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
        freeUnits: 0,
      };
    }
    const base = tierBase;
    const promo = applyBestPromotion(base, promos, {
      productId: product.id,
      category: product.category,
      qtyPieces,
      qtyUnits,
      boxes: denomination?.boxes ?? null,
      pieces: denomination?.pieces ?? null,
      unitsPerBox: denomination?.unitsPerBox ?? null,
    });
    if (promo.appliedPromoId) {
      return {
        unitPrice: promo.unitPrice,
        originalPrice: promo.originalPrice,
        priceType: PriceType.PROMO,
        freeUnits: promo.freeUnits,
      };
    }
    if (isSpecialTier(tierForProduct)) {
      return {
        unitPrice: base,
        originalPrice: listPrice,
        priceType: PriceType.SPECIAL,
        freeUnits: 0,
      };
    }
    return { unitPrice: base, originalPrice: null, priceType: PriceType.STANDARD, freeUnits: 0 };
  }

  /**
   * Read the tax rate from the tenant's Settings (SystemConfig) at request time.
   * Falls back to 0 so that unconfigured tenants don't get a surprise 10% charge.
   */
  private async getTaxRate(): Promise<number> {
    // Extracted to common/tax-rate.ts (Returns Inside Order Creation PR-1c) so
    // InlineReturnsQuoteService's unreferenced-chunk pricing shares this exact reader
    // instead of a second hand-rolled percent→fraction parse — same rule, one place.
    return currentTaxRate(this.systemConfig);
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
      productId,
      search,
      status,
      urgent,
      page = 1,
      limit = 20,
      deliveryDateFrom,
      deliveryDateTo,
      fulfillPath,
    } = query;
    const skip = (page - 1) * limit;
    const where: any = {};

    if (user.role === UserRole.CUSTOMER) {
      // REG-B131: `deletedAt: null` here — a removal deactivates the user but an access token
      // minted just before it stays valid for up to 15 minutes, so a removed customer's own
      // in-flight session must fall into the existing refusal below.
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub, deletedAt: null } });
      if (!customer) throw new ForbiddenException("Customer record not found");
      where.customerId = customer.id;
    } else if (customerId) {
      where.customerId = customerId;
    }

    // B144: `search` composes with the role/customerId scope above instead of
    // being swallowed by an `else if` — matches order NUMBER as well as the
    // customer's businessName.
    if (search) {
      where.OR = [
        { orderNumber: { contains: search, mode: "insensitive" } },
        { customer: { businessName: { contains: search, mode: "insensitive" } } },
      ];
    }

    // PR-B: "which orders had this item?" — an AND-ed relation filter, so it
    // narrows whatever customer/status/date filters are already set instead of
    // replacing them. Equality can never match NULL, so ad-hoc unlisted lines
    // (productId = null) are excluded for free.
    if (productId) where.lineItems = { some: { productId } };

    if (status) where.status = status;
    if (urgent !== undefined) where.urgent = urgent;
    // Ad-hoc trips + fulfillment mode: filter by ROUTE/SHIP. Omitted ⇒ no where
    // key at all (every existing order stays visible either way).
    if (fulfillPath) where.fulfillPath = fulfillPath;
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
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
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
          // Scan/insertion order (R2): all lines in one create share the same
          // createdAt (tx clock), so createdAt alone can't order them — `position`
          // carries the scanned order. Legacy/appended lines have null position and
          // sort LAST (NULLS LAST), with createdAt as the final tiebreak.
          orderBy: [{ position: "asc" }, { createdAt: "asc" }],
        },
        transaction: true,
        invoices: {
          select: {
            id: true,
            invoiceNumber: true,
            status: true,
            total: true,
            // Applied credit-note payments, so clients can show per-credit dollars
            // actually applied without a second roundtrip.
            // Classification pending: whether this credit-note-application read
            // should count DRAFT rows is decided by campaign batch F03's
            // confirmed-payment sweep (sums go PAID-only, listings keep not-VOID
            // with visible status). F03 converts this site or writes the reasoned
            // exemption here.
            // scan-ok: draft-payment-not-void — pending F03 classification, see above.
            payments: {
              where: { method: "CREDIT_NOTE", status: { not: "VOID" } },
              select: { id: true, amount: true, creditNoteId: true },
            },
          },
        },
        // Credit-note INTENTS selected for this order (join table) — the reason/
        // amount/status render at read time via the relation so an edit to the
        // credit note's reason shows up everywhere automatically.
        orderCreditNotes: {
          include: {
            creditNote: {
              select: {
                id: true,
                creditNoteNumber: true,
                reason: true,
                amount: true,
                amountUsed: true,
                status: true,
                expiresAt: true,
              },
            },
          },
        },
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
      // REG-B131: `deletedAt: null` here — a removal deactivates the user but an access token
      // minted just before it stays valid for up to 15 minutes, so a removed customer's own
      // in-flight session must fall into the existing refusal below.
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub, deletedAt: null } });
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
    (order as any).editWindow = this.computeEditWindow(order, user.role);

    return order;
  }

  /**
   * P5-08 / R1: derive the non-persisted edit-window descriptor from an order.
   * editable ⟺ the order isn't CANCELLED — items can now be edited at every live
   * stage (incl. OUT_FOR_DELIVERY / DELIVERED, on dispatched runs), with the write
   * gate re-syncing any linked invoice + ledger. Single source of truth shared by
   * the read and the write gate. `dispatched` no longer closes the window.
   *
   * B63 (REG-B63): for a CUSTOMER the window DOES close once the order is out the
   * door — the same `BUYER_EDIT_CLOSED_STATUSES` the write gate refuses on, so the
   * descriptor never reports "nothing is wrong" while `updateOrderItems` answers
   * 403. `closedReason: "DISPATCHED"` is what buyer clients read to explain it.
   */
  private computeEditWindow(
    order: {
      status: string;
      routeRunId?: string | null;
      routeRun?: { status: string } | null;
    },
    role?: UserRole,
  ): { editable: boolean; editableUntil: string | null; closedReason: string | null } {
    if (
      role === UserRole.CUSTOMER &&
      BUYER_EDIT_CLOSED_STATUSES.includes(order.status as OrderStatus)
    ) {
      return { editable: false, editableUntil: null, closedReason: "DISPATCHED" };
    }
    const editable = order.status !== "CANCELLED";
    return {
      editable,
      editableUntil: null,
      closedReason: editable ? null : "STATUS",
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
   * BUY_N_GET_M free units for a line whose QUANTITY changed while its stored
   * (agreed) unitPrice is kept — pending-order merges and every stored-price qty
   * edit. Reusing the sale-time snapshot verbatim is wrong in BOTH directions: a
   * merged (bigger) line loses the units it just earned and bills at full price,
   * and a shrunk line keeps free units it no longer earns (a 12→2 box door edit
   * billed $0.00). Lines that never earned free units return 0 untouched, so no
   * operator/driver line can gain a promo it never had — UNLESS `canEarnNew` says
   * this is a buyer's own consolidation of buyer-priced lines, where the combined
   * quantity must earn what a single cart of the same size would have (3 + 3 boxes
   * under a live buy-5-get-1 = 1 free, not 0).
   *
   * Preference order: re-run the LIVE BUY_N_GET_M rule against the new whole-unit
   * count (exact — `floor(qtyUnits / (N + M)) * M`); if no active rule still
   * covers the product (the promo ended after the sale) rescale the earned
   * snapshot at the rate it was earned at, capped at the snapshot, so an
   * already-agreed discount is never silently revoked by a later qty tweak.
   */
  private rescaleBogoFreeUnits(input: {
    /** Active promo rules (any type — only BUY_N_GET_M ones are consulted). */
    promos: PromotionRule[];
    productId: string | null;
    category: string | null;
    /** The line's stored selling-unit price — BOGO never alters it, so it IS the base. */
    unitPrice: number;
    storedFreeUnits: number | null | undefined;
    /** Whole selling units the snapshot was earned at. */
    oldUnits: number;
    /** Whole selling units after the change. */
    newUnits: number;
    /**
     * Allow a line with NO snapshot to earn free units from the live rule. Only a
     * buyer-driven merge of buyer-priced lines sets this; every staff qty edit and
     * the hourly sweep leave it false, so an operator/driver line is never silently
     * discounted by a customer promo it never had.
     */
    canEarnNew?: boolean;
  }): number {
    const stored = Math.max(0, Math.trunc(Number(input.storedFreeUnits ?? 0) || 0));
    if (stored <= 0 && !input.canEarnNew) return 0;
    const newUnits = Math.max(0, Math.trunc(Number(input.newUnits) || 0));
    if (newUnits <= 0) return 0;
    // A line is never entirely free — the buyer always pays the N in every (N + M).
    const ceiling = Math.max(0, newUnits - 1);
    if (input.productId) {
      const ctx: PromoContext = {
        productId: input.productId,
        category: input.category,
        // BUY_N_GET_M reads only qtyUnits; qtyPieces gates QTY_BREAK, which the
        // filtered list below cannot contain.
        qtyPieces: newUnits,
        qtyUnits: newUnits,
      };
      const live = input.promos.filter(
        (p) => p.type === "BUY_N_GET_M" && promotionMatchesProduct(p, ctx),
      );
      if (live.length > 0) {
        return Math.min(ceiling, applyBestPromotion(input.unitPrice, live, ctx).freeUnits);
      }
    }
    const oldUnits = Math.max(0, Math.trunc(Number(input.oldUnits) || 0));
    if (oldUnits <= 0) return 0;
    return Math.min(ceiling, stored, Math.floor((stored * newUnits) / oldUnits));
  }

  /**
   * Is this line's price the buyer's own (the tier/promo ladder), rather than an
   * operator-set one? Only such a line may EARN BUY_N_GET_M free units it never had
   * when a buyer-driven merge grows its quantity — a MANUAL upsell or a DISCOUNTED
   * override is a deliberate operator price and is never discounted further by a
   * customer promo (same rule as the manual-override branch in updateOrderItems).
   * A missing priceType counts as NOT buyer-priced (money-safe default).
   */
  private isBuyerPricedLine(li: {
    priceType?: PriceType | null;
    overriddenBy?: string | null;
  }): boolean {
    return (
      li.overriddenBy == null &&
      (li.priceType === PriceType.STANDARD ||
        li.priceType === PriceType.SPECIAL ||
        li.priceType === PriceType.PROMO)
    );
  }

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
   *
   * BUY_N_GET_M: the merged quantity earns its OWN free units — the contributing
   * snapshots are re-derived against the combined whole-unit count (see
   * `rescaleBogoFreeUnits`) and returned so the caller persists `promoFreeUnits`
   * alongside the subtotal. Without this a merged BOGO line silently repriced to
   * full price while the row kept a stale, contradicting `promoFreeUnits`.
   * `bogo.canEarnNew` additionally lets the combined quantity earn free units none
   * of the contributions had (a buyer's split carts) — granted only when EVERY
   * contribution is buyer-priced, so one operator-priced contribution keeps the
   * whole merged line on the conservative "never gain a promo it never had" path.
   */
  private mergeBoxedContributions(
    contributions: Array<{
      qty: unknown;
      boxes: number | null;
      pieces: number | null;
      promoFreeUnits?: number | null;
      priceType?: PriceType | null;
      overriddenBy?: string | null;
    }>,
    unitPrice: number,
    unitsPerBox: number | null | undefined,
    bogo?: {
      promos: PromotionRule[];
      productId: string | null;
      category: string | null;
      canEarnNew?: boolean;
      /**
       * The merged line's surviving unitPrice already carries a price-promo
       * discount (winner/meta line is PROMO with a strikethrough). Promotions
       * never stack — a buyer splitting one cart in two must not merge back to
       * a percent discount PLUS free units — so both the stored-snapshot rescale
       * and canEarnNew are suppressed and the merged line keeps price-off only.
       */
      pricePromoApplied?: boolean;
    },
  ): {
    qty: number;
    boxes: number | null;
    pieces: number | null;
    subtotal: number;
    freeUnits: number;
    /** Σ of the contributions' BUY_N_GET_M snapshots — 0 when no line carried one. */
    storedFreeUnits: number;
  } {
    const upb = Number(unitsPerBox ?? 0);
    const totalPieces = contributions.reduce((sum, c) => {
      const q = Number(c.qty);
      const sellingUnit = upb > 1 && c.boxes == null && c.pieces == null;
      return sum + (sellingUnit ? q * upb : q);
    }, 0);
    // Free-unit snapshots and the whole selling units they were earned at. A
    // box-split line counts its BOXES (its `qty` is pieces); every other shape
    // already stores selling units in `qty`.
    const storedFreeUnits = contributions.reduce(
      (sum, c) => sum + Math.max(0, Number(c.promoFreeUnits ?? 0) || 0),
      0,
    );
    const oldUnits = contributions.reduce(
      (sum, c) => sum + (c.boxes != null ? Number(c.boxes) : Number(c.qty)),
      0,
    );
    const canEarnNew =
      bogo?.canEarnNew === true && contributions.every((c) => this.isBuyerPricedLine(c));
    const freeUnitsFor = (newUnits: number) =>
      bogo?.pricePromoApplied === true
        ? 0
        : this.rescaleBogoFreeUnits({
            promos: bogo?.promos ?? [],
            productId: bogo?.productId ?? null,
            category: bogo?.category ?? null,
            unitPrice,
            storedFreeUnits,
            oldUnits,
            newUnits,
            canEarnNew,
          });
    if (upb > 1) {
      const split = normalizeBoxesPieces({ qty: totalPieces, unitsPerBox: upb });
      const freeUnits = freeUnitsFor(Number(split.boxes ?? 0));
      return {
        qty: split.qty,
        boxes: split.boxes,
        pieces: split.pieces,
        freeUnits,
        storedFreeUnits,
        subtotal: computeLineSubtotal({
          unitPrice,
          qty: split.qty,
          boxes: split.boxes,
          pieces: split.pieces,
          unitsPerBox: upb,
          freeUnits,
        }),
      };
    }
    const freeUnits = freeUnitsFor(totalPieces);
    return {
      qty: totalPieces,
      boxes: null,
      pieces: null,
      freeUnits,
      storedFreeUnits,
      subtotal: computeLineSubtotal({ unitPrice, qty: totalPieces, freeUnits }),
    };
  }

  /**
   * `buyerInitiated`: the customer themselves triggered this consolidation from the
   * buyer portal / their own app. Only then may a merged BUY_N_GET_M line earn free
   * units none of the contributing lines had — the buyer splitting one cart in two
   * must not lose the promo the combined quantity qualifies for. Left false for the
   * hourly sweep and every staff path so operator/driver pricing stays untouched.
   *
   * `opts.lockMode`: `"wait"` (the default) blocks up to 20 s for the customer's merge lock —
   * right for the sweep/force paths, which have no client attached. Every POST-COMMIT caller on
   * a request path passes `"try"` instead: their row has already committed, so their only use
   * for the lock is opportunistic consolidation, and waiting would spend a request's remaining
   * budget (and pin one of the 8 lock-pool slots) on work that is already deferrable. In `try`
   * mode a held lock returns `{ acquired: false }` → the coded 503 below → `isMergeContention`
   * → the caller's "deferred" warning, with the hourly sweep folding the leftover.
   */
  async mergeAllPendingForCustomer(
    customerId: string,
    options: { buyerInitiated?: boolean } = {},
    opts?: { lockMode?: LockMode },
  ) {
    try {
      const result = await withAdvisoryLock(
        {
          family: "order-merge",
          key: customerId,
          mode: opts?.lockMode ?? "wait",
          // Inert under `try` (pg_try_advisory_lock never blocks); it is the 20 s budget the
          // sweep/force paths wait on.
          waitMs: 20_000,
        },
        async () => {
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
            Array<{
              qty: unknown;
              boxes: number | null;
              pieces: number | null;
              // BUY_N_GET_M snapshot so the merged line re-derives its free units.
              promoFreeUnits: number | null;
              // Whether the contribution is buyer-priced — gates earning NEW free units.
              priceType: PriceType;
              overriddenBy: string | null;
            }>
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
              contribs.push({
                qty: li.qty,
                boxes: li.boxes,
                pieces: li.pieces,
                promoFreeUnits: (li as any).promoFreeUnits ?? null,
                priceType: li.priceType,
                overriddenBy: li.overriddenBy,
              });
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
          const contributingLines = [...winner.lineItems, ...losers.flatMap((l) => l.lineItems)];
          const involvedProductIds = [
            ...new Set(
              contributingLines.map((li) => li.productId).filter((id): id is string => !!id),
            ),
          ];
          const upbByProduct = new Map<string, number>();
          // Category feeds scope=CATEGORY matching when a merged line's BUY_N_GET_M
          // free units are re-derived below.
          const catByProduct = new Map<string, string | null>();
          if (involvedProductIds.length > 0) {
            const prods = await this.prisma.forTenant().product.findMany({
              where: { id: { in: involvedProductIds } },
              select: { id: true, unitsPerBox: true, category: true },
            });
            for (const p of prods) {
              upbByProduct.set(p.id, Number(p.unitsPerBox ?? 0));
              catByProduct.set(p.id, p.category ?? null);
            }
          }

          const taxRate = await this.getTaxRate();
          // BUY_N_GET_M: a merged line earns its own free units for the COMBINED
          // quantity, so the live rule is re-run below. Loaded on a separate pooled
          // connection before the tx (pool-starvation guard) and ONLY when a
          // contributing line carries a free-unit snapshot, or the BUYER drove this
          // merge and a buyer-priced line could newly earn one (split carts) — every
          // other merge issues no extra query and is byte-for-byte unchanged.
          const bogoPromos =
            contributingLines.some((li: any) => Number(li.promoFreeUnits ?? 0) > 0) ||
            (options.buyerInitiated === true &&
              contributingLines.some((li) => this.isBuyerPricedLine(li)))
              ? await this.loadActivePromotions(UserRole.CUSTOMER)
              : [];

          await this.prisma.tenantTransaction(async (tx) => {
            // 1. Bump winner catalog lines that overlap losers — re-prorate boxed lines
            //    from the combined piece count (never a naive newQty * unitPrice).
            for (const li of winner.lineItems) {
              if (!li.productId) continue;
              const loserContribs = loserContribsByProduct.get(li.productId);
              if (!loserContribs || loserContribs.length === 0) continue;
              const merged = this.mergeBoxedContributions(
                [
                  {
                    qty: li.qty,
                    boxes: li.boxes,
                    pieces: li.pieces,
                    promoFreeUnits: (li as any).promoFreeUnits ?? null,
                    priceType: li.priceType,
                    overriddenBy: li.overriddenBy,
                  },
                  ...loserContribs,
                ],
                Number(li.unitPrice),
                upbByProduct.get(li.productId),
                {
                  promos: bogoPromos,
                  productId: li.productId,
                  category: catByProduct.get(li.productId) ?? null,
                  canEarnNew: options.buyerInitiated === true,
                  // The winner line's unitPrice survives the merge — if it is already
                  // price-promo discounted, free units must not stack on top of it.
                  pricePromoApplied: li.priceType === PriceType.PROMO && li.originalPrice != null,
                },
              );
              await tx.orderItem.update({
                where: { id: li.id },
                data: {
                  qty: merged.qty,
                  boxes: merged.boxes,
                  pieces: merged.pieces,
                  subtotal: merged.subtotal,
                  // Keep the snapshot and the money consistent — a merged line that no
                  // longer earns free units must not keep a stale count. Untouched when
                  // no contribution carried one, so non-BOGO merges write exactly as before.
                  ...(merged.freeUnits > 0 || merged.storedFreeUnits > 0
                    ? { promoFreeUnits: merged.freeUnits > 0 ? merged.freeUnits : null }
                    : {}),
                },
              });
            }

            // 2. Create winner items for productIds that were only on losers.
            for (const [productId, meta] of newItemMetaByProduct.entries()) {
              const merged = this.mergeBoxedContributions(
                loserContribsByProduct.get(productId) ?? [],
                meta.unitPrice,
                upbByProduct.get(productId),
                {
                  promos: bogoPromos,
                  productId,
                  category: catByProduct.get(productId) ?? null,
                  canEarnNew: options.buyerInitiated === true,
                  // The new line is created at meta.unitPrice with meta.originalPrice —
                  // an already price-discounted PROMO line must not also earn free units.
                  pricePromoApplied:
                    meta.priceType === PriceType.PROMO && meta.originalPrice != null,
                },
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
                  // Carry the loser line's BUY_N_GET_M discount onto the new winner
                  // line, re-derived for the merged quantity (was dropped entirely).
                  promoFreeUnits: merged.freeUnits > 0 ? merged.freeUnits : null,
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
                  // scan-ok: money-rederive — custom line (productId: null), never boxed, so there's no unitsPerBox proration to lose; per-piece price x qty (Decimal(10,3) — the order-edit path allows fractional qty), rounded on write.
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

            // 3. Drop loser orders and their items — carrying a loser's Idempotency-
            //    Key onto the winner FIRST when the winner's slot is free (R6): the
            //    loser's cart just landed in the winner, so a still-queued retry of
            //    that request must replay onto the winner, not re-create a deleted
            //    order. Single-column storage means only one carried key can survive
            //    a multi-loser sweep — the ELDEST loser's (they merge updatedAt DESC,
            //    so iterate from the tail); the residual (two keyed losers, one slot)
            //    is a recorded Low limitation, bounded further by R4's content check.
            const winnerRow = await tx.order.findUnique({
              where: { id: winner.id },
              select: { idempotencyKey: true },
            });
            let slotFree = winnerRow?.idempotencyKey == null;
            for (const loser of [...losers].reverse()) {
              const loserKey = (loser as { idempotencyKey?: string | null }).idempotencyKey;
              if (slotFree && loserKey) {
                // Free the unique before re-pointing it at the winner.
                await tx.order.update({ where: { id: loser.id }, data: { idempotencyKey: null } });
                await tx.order.update({
                  where: { id: winner.id },
                  data: { idempotencyKey: loserKey },
                });
                slotFree = false;
              }
            }
            for (const loser of losers) {
              // B215: a loser's merge keys follow its cart onto the winner. The FK cascade would
              // otherwise delete them with the loser, and a retry of that merge would fold the
              // same cart into the winner a second time.
              await tx.orderIdempotencyKey.updateMany({
                where: { orderId: loser.id },
                data: { orderId: winner.id },
              });
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
                // Winner keeps ITS OWN stored fee; loser fees drop with the losers (the merged
                // order is one delivery → one fee). Same asymmetry as discountAmount.
                total: roundMoney(subtotal + tax + categoryTax + Number(winner.shippingFee ?? 0)),
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
        },
      );
      // Under `try` this is the NORMAL "someone else holds this customer's lock" outcome; under
      // `wait` it is defensive only (that mode either acquires or throws). Either way it carries
      // the same coded body as mapLockError's 503, so `isMergeContention` (the sweep, every
      // post-commit caller) recognises it identically and defers.
      if (!result.acquired) {
        throw new ServiceUnavailableException({
          code: LOCK_UNAVAILABLE,
          message: LOCK_UNAVAILABLE_MESSAGE,
        });
      }
      return result.value;
    } catch (e) {
      mapLockError(e);
    }
  }

  async forceConsolidateCustomer(customerId: string) {
    try {
      const result = await withAdvisoryLock(
        { family: "order-merge", key: customerId, mode: "wait", waitMs: 20_000 },
        async () => {
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
            Array<{
              qty: unknown;
              boxes: number | null;
              pieces: number | null;
              // BUY_N_GET_M snapshot so the merged line re-derives its free units.
              promoFreeUnits: number | null;
            }>
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
              contribs.push({
                qty: li.qty,
                boxes: li.boxes,
                pieces: li.pieces,
                promoFreeUnits: (li as any).promoFreeUnits ?? null,
              });
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
          // Category feeds scope=CATEGORY matching when a merged line's BUY_N_GET_M
          // free units are re-derived below.
          const catByProduct = new Map<string, string | null>();
          if (involvedProductIds.length > 0) {
            const prods = await this.prisma.forTenant().product.findMany({
              where: { id: { in: involvedProductIds } },
              select: { id: true, unitsPerBox: true, category: true },
            });
            for (const p of prods) {
              upbByProduct.set(p.id, Number(p.unitsPerBox ?? 0));
              catByProduct.set(p.id, p.category ?? null);
            }
          }

          const taxRate = await this.getTaxRate();
          // BUY_N_GET_M: a merged line earns its own free units for the COMBINED
          // quantity, so the live rule is re-run below. Loaded on a separate pooled
          // connection before the tx (pool-starvation guard) and ONLY when a
          // contributing line actually carries a free-unit snapshot — every non-BOGO
          // merge issues no extra query and is byte-for-byte unchanged.
          const bogoPromos = [...winner.lineItems, ...losers.flatMap((l) => l.lineItems)].some(
            (li: any) => Number(li.promoFreeUnits ?? 0) > 0,
          )
            ? await this.loadActivePromotions(UserRole.CUSTOMER)
            : [];

          await this.prisma.tenantTransaction(async (tx) => {
            for (const li of winner.lineItems) {
              if (!li.productId) continue;
              const loserContribs = loserContribsByProduct.get(li.productId);
              if (!loserContribs || loserContribs.length === 0) continue;
              const merged = this.mergeBoxedContributions(
                [
                  {
                    qty: li.qty,
                    boxes: li.boxes,
                    pieces: li.pieces,
                    promoFreeUnits: (li as any).promoFreeUnits ?? null,
                  },
                  ...loserContribs,
                ],
                Number(li.unitPrice),
                upbByProduct.get(li.productId),
                {
                  promos: bogoPromos,
                  productId: li.productId,
                  category: catByProduct.get(li.productId) ?? null,
                  // Non-stacking: a price-discounted winner line keeps its discount
                  // for the merged qty but never adds free units on top.
                  pricePromoApplied: li.priceType === PriceType.PROMO && li.originalPrice != null,
                },
              );
              await tx.orderItem.update({
                where: { id: li.id },
                data: {
                  qty: merged.qty,
                  boxes: merged.boxes,
                  pieces: merged.pieces,
                  subtotal: merged.subtotal,
                  // Keep the snapshot and the money consistent — a merged line that no
                  // longer earns free units must not keep a stale count. Untouched when
                  // no contribution carried one, so non-BOGO merges write exactly as before.
                  ...(merged.freeUnits > 0 || merged.storedFreeUnits > 0
                    ? { promoFreeUnits: merged.freeUnits > 0 ? merged.freeUnits : null }
                    : {}),
                },
              });
            }
            for (const [productId, meta] of newItemMetaByProduct.entries()) {
              const merged = this.mergeBoxedContributions(
                loserContribsByProduct.get(productId) ?? [],
                meta.unitPrice,
                upbByProduct.get(productId),
                {
                  promos: bogoPromos,
                  productId,
                  category: catByProduct.get(productId) ?? null,
                  // Non-stacking: the new line keeps meta's price discount only.
                  pricePromoApplied:
                    meta.priceType === PriceType.PROMO && meta.originalPrice != null,
                },
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
                  // Carry the loser line's BUY_N_GET_M discount onto the new winner
                  // line, re-derived for the merged quantity (was dropped entirely).
                  promoFreeUnits: merged.freeUnits > 0 ? merged.freeUnits : null,
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
                  // scan-ok: money-rederive — custom line (productId: null), never boxed, so there's no unitsPerBox proration to lose; per-piece price x qty (Decimal(10,3) — the order-edit path allows fractional qty), rounded on write.
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
                // B214 (REG-B214): a DRAFT mirror can source a credit note; refuse before the FK
                // SET NULL orphans it.
                await assertNoUnspentSourcedCredits(tx, [loserDraft.id]);
                await tx.invoiceItem.deleteMany({ where: { invoiceId: loserDraft.id } });
                await tx.invoice.delete({ where: { id: loserDraft.id } });
              }
              // B215: a loser's merge keys follow its cart onto the winner. The FK cascade would
              // otherwise delete them with the loser, and a retry of that merge would fold the
              // same cart into the winner a second time.
              await tx.orderIdempotencyKey.updateMany({
                where: { orderId: loser.id },
                data: { orderId: winner.id },
              });
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
              ? {
                  routeRunId: routeAssignment.routeRunId,
                  routeRunStopId: routeAssignment.routeRunStopId,
                }
              : {};
            await tx.order.update({
              where: { id: winner.id },
              data: {
                subtotal,
                tax,
                // Winner keeps ITS OWN stored fee; loser fees drop with the losers (the merged
                // order is one delivery → one fee). Same asymmetry as discountAmount.
                total: roundMoney(subtotal + tax + categoryTax + Number(winner.shippingFee ?? 0)),
                // A merged-in regulated line flips the denormalized flag on.
                hasRegulated: activeItems.some((li: any) => li.trackedCategoryId != null),
                ...routeUpdate,
              },
            });
            // If the winner carries a pending mirror draft, re-sync it to the merged lines.
            await this.invoicesService.reconcileOrderDraftInvoice(winner.id, {
              basis: "order",
              tx,
            });
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
        },
      );
      // Defensive: see mergeAllPendingForCustomer — same coded 503 body.
      if (!result.acquired) {
        throw new ServiceUnavailableException({
          code: LOCK_UNAVAILABLE,
          message: LOCK_UNAVAILABLE_MESSAGE,
        });
      }
      return result.value;
    } catch (e) {
      mapLockError(e);
    }
  }

  async sweepAllPendingOrders(): Promise<{ customers: number; merged: number; skipped: number }> {
    // B323: no HTTP request context runs this (cron tick / boot), so ALS is empty and
    // forTenant() used to fall through to the UNSCOPED client — every forTenant() call
    // deeper in mergeAllPendingForCustomer (SystemConfigService.get for the tax rate,
    // product lookups, ...) then resolved against whichever tenant's row a bare
    // findFirst/findMany happened to return first, not the customer's own tenant.
    // Group by tenantId alongside customerId so each group carries the tenant to
    // re-enter below.
    const pendingMergeCandidateWhere = {
      status: OrderStatus.PENDING,
      routeRunId: null,
      routeRunStopId: null,
      transaction: { is: null },
      invoices: { none: {} },
      returns: { none: {} },
      skipAutoMerge: false,
    };

    const groups = await this.prisma.forTenant().order.groupBy({
      by: ["customerId", "tenantId"],
      where: pendingMergeCandidateWhere,
      _count: { _all: true },
      having: { customerId: { _count: { gt: 1 } } },
    });

    // F1 (B323 review): a customer with, say, one pending order under a real tenant AND
    // one legacy null-tenant order lands in two SEPARATE one-row (customerId, tenantId)
    // groups above — neither clears `having customerId._count > 1`, so the pair was
    // silently invisible to both the merge loop AND the warn below it. Run one extra
    // query on the same (unscoped, deliberate) client, over the identical filter but
    // restricted to tenantId: null, so every customer with a null-tenant pending order
    // is found and counted whether or not their real-tenant group individually cleared
    // the >1 threshold.
    const nullTenantRows = await this.prisma.forTenant().order.groupBy({
      by: ["customerId"],
      where: { ...pendingMergeCandidateWhere, tenantId: null },
      _count: { _all: true },
    });
    for (const r of nullTenantRows) {
      this.logger.warn(
        `sweepAllPendingOrders: customer ${r.customerId} has ${r._count._all} pending order(s) without tenantId — not merged (B323)`,
      );
    }
    const skipped = nullTenantRows.length;

    // Null-tenant groups are fully accounted for by the pass above (count + warn) —
    // exclude them here so the same customer is never double-logged, and so `customers`
    // below reflects only the groups actually eligible to merge.
    const mergeCandidateGroups = groups.filter((g) => g.tenantId);

    let merged = 0;
    for (const g of mergeCandidateGroups) {
      try {
        // RF-008: re-enter this group's OWN tenant's ALS scope before calling into
        // anything that relies on ambient forTenant() scoping (same pattern as
        // recurring-invoices.generateDueRecurringInvoices / tobacco-report /
        // order-templates / authorization-expiry / commission-reconciliation /
        // regulated-filing-cron).
        const winner = await this.tenantCtx.run(g.tenantId as string, () =>
          this.mergeAllPendingForCustomer(g.customerId),
        );
        if (winner) merged++;
      } catch (e) {
        // Skip by CAUSE, not by exception type: only the two coded lock-contention errors mean
        // "someone else holds this customer's lock, try again next hour". A 409/503 raised for
        // any OTHER reason inside the merge (a credit-limit conflict, a genuinely dead
        // dependency) is a real fault and must still stop the sweep — swallowing it by type
        // would hide a broken merge behind an hourly "skipped" line forever.
        if (isMergeContention(e)) {
          this.logger.warn(
            `sweepAllPendingOrders: skipped customer ${g.customerId} — ${(e as Error)?.message ?? e}`,
          );
          continue;
        }
        throw e;
      }
    }
    this.logger.log(
      `sweepAllPendingOrders: swept ${mergeCandidateGroups.length} customer(s), merged into ${merged} winner(s), skipped ${skipped} without tenantId`,
    );
    return { customers: mergeCandidateGroups.length, merged, skipped };
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

  @LeaderCron("0 * * * *", "orders.cronSweepPendingOrders")
  async cronSweepPendingOrders() {
    try {
      await this.sweepAllPendingOrders();
    } catch (err) {
      this.logger.error("Hourly sweep failed", err instanceof Error ? err.stack : String(err));
    }
  }

  /**
   * Resolve the staff-supplied business date of an order. A bare "YYYY-MM-DD"
   * parses to midnight UTC, matching how requestedDeliveryDate/issueDate are handled.
   * The upper bound is the END of the current UTC day so an operator in a timezone
   * ahead of UTC can still enter today.
   */
  private parseOrderDate(raw: string | undefined, role: UserRole): Date | undefined {
    if (raw == null) return undefined;
    // POST /orders is reachable by CUSTOMER and DRIVER — only staff may backdate.
    if (role !== UserRole.OPERATOR && role !== UserRole.TENANT_ADMIN) {
      throw new ForbiddenException("Only staff can set an order date");
    }

    const parsed = new Date(raw);
    if (Number.isNaN(parsed.getTime())) throw new BadRequestException("Invalid order date");

    const now = new Date();
    const endOfToday = Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      23,
      59,
      59,
      999,
    );
    if (parsed.getTime() > endOfToday) {
      throw new BadRequestException("Order date cannot be in the future");
    }
    const earliest = new Date(now);
    earliest.setUTCFullYear(earliest.getUTCFullYear() - 2);
    if (parsed.getTime() < earliest.getTime()) {
      throw new BadRequestException("Order date cannot be more than 2 years in the past");
    }
    return parsed;
  }

  /**
   * Sales agents & commissions: staff-only per-order commission-rate override.
   * `0` IS a valid value ("exempt"); `undefined` means "no override given"
   * (falls back to customer/agent default rates). Gated exactly like
   * parseOrderDate — CUSTOMER/DRIVER callers may never set this.
   */
  private parseCommissionRatePct(
    raw: number | null | undefined,
    role: UserRole,
  ): number | null | undefined {
    if (raw === undefined) return undefined;
    if (role !== UserRole.OPERATOR && role !== UserRole.TENANT_ADMIN) {
      throw new ForbiddenException("Only staff can set a commission rate");
    }
    if (raw === null) return null;
    if (typeof raw !== "number" || Number.isNaN(raw) || raw < 0 || raw > 100) {
      throw new BadRequestException("commissionRatePct must be between 0 and 100");
    }
    return raw;
  }

  /**
   * F30/R8 (B196): the order that already applied this Idempotency-Key for
   * THIS customer, if any.
   *
   * `create()` does its own inline lookup (it needs the full order to return);
   * this is the lookup for the staff create-MERGE branch, which never reaches
   * `create()` and only needs to know whether the key was already applied.
   * Tenant-scoped through `forTenant()`, matching the `@@unique([tenantId,
   * idempotencyKey])` the column is stored under — and scoped to `customerId`
   * on top of that, because the key is client-chosen: a bare key match would
   * let one client's string replay onto a DIFFERENT customer's order.
   *
   * B215/R1 (round 2): returns `verified` alongside the id. `verified: true` means the hit came
   * from the key TABLE and its stored `responseHash` matched this request's fingerprint — i.e.
   * the retry's body is provably the SAME cart the fold applied, so the caller may re-apply that
   * body's credit-note selection on replay. A hit on the Order COLUMN carries no fingerprint
   * (nothing is stored to compare), so it is `verified: false`: the body may be a different cart
   * that merely reuses the key, and its `appliedCreditNotes` must NOT be applied to the order the
   * replay hands back — see `replayMergeReconcile` / `reconcileOrderAfterEdit`.
   */
  async findOrderIdByIdempotencyKey(
    idempotencyKey: string,
    customerId: string,
    requestHash?: string,
  ): Promise<{ orderId: string; verified: boolean } | null> {
    // B215: `forTenant()` hands back the UNSCOPED client when the session carries no tenant
    // (prisma.service.ts `forTenant`), so for such a caller the lookups below would search
    // every tenant's rows. Refuse up front — before any read and before the controller enters
    // the fold — mirroring the identical guard in `create()`. `recordMergeIdempotencyKey`
    // keeps the same check as the fail-closed backstop inside the fold's transaction.
    if (!this.prisma.getTenantId()) {
      this.logger.warn(`idempotency key refused: no tenant scope key=${idempotencyKey}`);
      throw new ForbiddenException("Idempotency-Key requires a tenant-scoped session");
    }
    // B215: every staff merge wave records its OWN key in OrderIdempotencyKey (written inside
    // the fold's transaction by recordMergeIdempotencyKey), so that table is the authoritative
    // replay store for the merge branch. Scoped to THIS customer through the order relation —
    // the key is client-chosen, so a bare match could replay onto another customer's order.
    const keyed = await this.prisma.forTenant().orderIdempotencyKey.findFirst({
      where: { key: idempotencyKey, order: { customerId } },
      select: { orderId: true, responseHash: true },
    });
    if (keyed) {
      if (requestHash !== undefined && keyed.responseHash !== requestHash) {
        this.logger.warn(
          `idempotency replay refused: cart mismatch tenant=${this.prisma.getTenantId()} ` +
            `customer=${customerId} order=${keyed.orderId} key=${idempotencyKey}`,
        );
        // B215: machine-readable body — the mobile client cannot mint a fresh key without
        // abandoning the cart, so it needs `orderId` to offer "Open order" instead of wedging
        // the screen on a bare message.
        throw new ConflictException({
          code: IDEMPOTENCY_KEY_CONFLICT,
          reason: "CART_MISMATCH",
          orderId: keyed.orderId,
          message:
            "Idempotency-Key reused with a different cart — open the existing order to edit it, or retry it unchanged",
        });
      }
      // VERIFIED only when a fingerprint was supplied AND matched: a caller that passes no
      // `requestHash` (the db-spec's bare two-argument probe, any future keyless caller) has
      // proven nothing about the body, so it gets the same unverified treatment as a column hit.
      return { orderId: keyed.orderId, verified: requestHash !== undefined };
    }
    // The single Order column: keys stamped by create() and by recordIdempotencyKey. Unchanged.
    // B215: deliberately NOT compared against `requestHash` — the column stores no fingerprint,
    // and its main producer is the create -> retry path (the first POST creates the order and
    // stamps the key; the retry finds it pending and enters the merge branch). Refusing that
    // replay for want of a hash would re-open the double-write this fix exists to close, so a
    // column-only hit is replay-eligible. The key TABLE, which does store the hash, is the only
    // path that refuses on a mismatch. Pinned by P5.
    //
    // B215 (lookup ORDER, D3): this customer-scoped column read runs BEFORE the tenant-wide
    // `heldByAnotherOrder` check below. Both are "the key exists somewhere in this tenant", but
    // only this one proves it is THIS customer's own order — checking the tenant-wide table
    // first refused a legitimate replay of the caller's own key with a 409 whenever the key sat
    // on the Order column here and any other customer happened to hold a key-table row.
    const existing = await this.prisma.forTenant().order.findFirst({
      where: { idempotencyKey, customerId },
      select: { id: true },
    });
    // UNVERIFIED by construction: the column stores no fingerprint, so this hit proves only
    // "this customer's order already used this key", never "with this cart".
    if (existing) return { orderId: existing.id, verified: false };
    // B215: the key may already belong to ANOTHER customer's order in this tenant. The in-tx
    // insert catches that through `@@unique([tenantId, key])`, but only after
    // `revertLinkedInvoicesForOrderEdit` has committed on its own connection (outside the fold)
    // and the whole fold has run — so a 409 there leaves a linked invoice flipped SENT -> DRAFT
    // for an edit that never landed. Refuse here instead: this lookup runs inside the customer
    // advisory lock, before any write. The P2002 branch of `recordMergeIdempotencyKey` stays as
    // the backstop for a true race (a customer-keyed lock does not serialize against another
    // customer's fold).
    const heldByAnotherOrder = await this.prisma.forTenant().orderIdempotencyKey.findFirst({
      where: { key: idempotencyKey },
      select: { orderId: true },
    });
    if (heldByAnotherOrder) {
      this.logger.warn(
        `idempotency key already held by another order: refused before the fold ` +
          `tenant=${this.prisma.getTenantId()} customer=${customerId} ` +
          `order=${heldByAnotherOrder.orderId} key=${idempotencyKey}`,
      );
      throw new ConflictException({
        code: IDEMPOTENCY_KEY_CONFLICT,
        reason: "HELD_BY_OTHER_ORDER",
        orderId: heldByAnotherOrder.orderId,
        message: "Idempotency-Key already used for a different order",
      });
    }
    return null;
  }

  /**
   * B215: `create()`'s replay candidate for `idempotencyKey`, loaded with the include its
   * caller's ownership + cart checks read.
   *
   * Consults the OrderIdempotencyKey TABLE first and the Order COLUMN only as a fallback: a
   * keyed request that reached the merge branch has its key in the table alone (the fold writes
   * it there), and such a request CAN fall through to `create()` — the merge target vanishing
   * before the advisory lock is the live path — so a column-only lookup would miss the replay
   * and mint a duplicate order.
   *
   * B215/R4 (round 2): the CALLER'S OWN row wins. Lookup order is (1) a key-TABLE row on an
   * order belonging to `customerId`, (2) this customer's key-stamped Order COLUMN, (3) only then
   * the tenant-wide table row — which the caller's ownership gate still turns into a 409. Without
   * step 1/2 a key-table row belonging to ANOTHER customer was fetched first and 409'd a caller
   * whose own column-stamped order was sitting right there (the same D3 ordering bug already
   * fixed in `findOrderIdByIdempotencyKey`).
   */
  private async findReplayCandidateByKey(idempotencyKey: string, customerId: string) {
    const include = {
      customer: { select: { id: true, businessName: true } },
      lineItems: { include: { product: { select: { id: true, name: true, unit: true } } } },
    };
    const load = (where: Record<string, unknown>) =>
      this.prisma.forTenant().order.findFirst({ where, include });
    // (1) a key-table row on an order that is THIS customer's.
    const owned = await this.prisma.forTenant().orderIdempotencyKey.findFirst({
      where: { key: idempotencyKey, order: { customerId } },
      select: { orderId: true },
    });
    if (owned) return load({ id: owned.orderId });
    // (2) this customer's own key-stamped Order column.
    const ownColumn = await load({ idempotencyKey, customerId });
    if (ownColumn) return ownColumn;
    // (3) the tenant-wide key-table row — the caller's ownership gate turns this into a 409.
    const keyed = await this.prisma
      .forTenant()
      .orderIdempotencyKey.findFirst({ where: { key: idempotencyKey }, select: { orderId: true } });
    // (4) and finally the tenant-wide column, which is likewise gated by ownership. Unchanged
    // behaviour for a key stamped on another customer's order: found, then refused.
    return load(keyed ? { id: keyed.orderId } : { idempotencyKey });
  }

  /**
   * F30/R8 (B196): stamp the replay key onto the order a staff merge landed on,
   * so a re-delivery of that same request replays instead of folding the same
   * items in again.
   *
   * An order holds at most one key, so a merge overwrites whatever key created
   * the order. That is deliberate: replays arrive within seconds/minutes of the
   * request they duplicate, so the MOST RECENT operation on the order is the one
   * whose replay window is still open. A concurrent claim from another API
   * replica loses the unique-constraint race (P2002) — the merge it raced has
   * already been written, so swallow it rather than fail a completed write.
   */
  async recordIdempotencyKey(orderId: string, idempotencyKey: string): Promise<void> {
    try {
      // First key wins (R1): an order can absorb several queued requests (auto-
      // merge waves); the EARLIEST key is the one a stuck client will retry
      // with, so never let a later wave clobber it — the later request's own
      // replay is answered by content comparison against the same order anyway,
      // for `create()`; the merge path's replay is a bare key lookup, so a key
      // that was already set leaves that fold unguarded (campaign candidate).
      await this.prisma.forTenant().order.updateMany({
        where: { id: orderId, idempotencyKey: null },
        data: { idempotencyKey },
      });
    } catch (e: any) {
      if (e?.code !== "P2002") throw e;
    }
  }

  /**
   * B215: record a staff merge's Idempotency-Key in OrderIdempotencyKey through the FOLD's own
   * transaction client `tx`, so the key and the fold commit — or roll back — together. Called
   * only from updateOrderItems' transaction callback. A P2002 means the key already belongs to
   * another request (every same-customer retry is answered by the replay pre-check before the
   * fold), so it aborts the fold with a 409: swallowing an error inside a Postgres transaction
   * would leave the transaction aborted anyway. Uses only this.prisma (the DB lane builds this
   * service without DI).
   */
  async recordMergeIdempotencyKey(
    tx: any,
    orderId: string,
    idem: { key: string; responseHash: string },
  ): Promise<void> {
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) {
      this.logger.warn(`idempotency key refused: no tenant scope key=${idem.key}`);
      throw new ForbiddenException("Idempotency-Key requires a tenant-scoped session");
    }
    try {
      await tx.orderIdempotencyKey.create({
        data: { tenantId, key: idem.key, orderId, responseHash: idem.responseHash },
      });
    } catch (e: any) {
      if (e?.code === "P2002") {
        this.logger.warn(
          `idempotency key already held by another order: fold rolled back ` +
            `tenant=${tenantId} order=${orderId} key=${idem.key}`,
        );
        throw new ConflictException("Idempotency-Key already used for a different order");
      }
      throw e;
    }
  }

  async create(
    dto: CreateOrderDto,
    user: JwtPayload,
    options: { skipAutoMerge?: boolean; allowArchived?: boolean } = {},
  ) {
    // F30/R8: Idempotency-Key replay. `idempotencyKey` isn't on CreateOrderDto
    // (the controller threads it in from the `Idempotency-Key` header, never
    // client body input) — a client-generated uuid per cart session so a
    // duplicate POST /orders (queue self-duplication, a timed-out request that
    // actually completed server-side) returns the ORIGINAL order instead of
    // creating a second one. The pre-check runs below, once the caller's own
    // customer is known; the P2002 branch further down catches the narrow
    // concurrent-race window that pre-check can't.
    const idempotencyKey = (dto as any).idempotencyKey as string | undefined;
    // The key is stored under @@unique([tenantId, idempotencyKey]) and every
    // lookup rides forTenant(), which hands back the UNSCOPED client when the
    // caller carries no tenant (SUPER_ADMIN — admitted here by RolesGuard's
    // role hierarchy). Refuse the key path outright for such a caller rather
    // than let a replay lookup match another tenant's order.
    if (idempotencyKey && !this.prisma.getTenantId()) {
      throw new ForbiddenException("Idempotency-Key requires a tenant-scoped session");
    }

    // Resolve which customer this order is for
    let customerId: string;
    // REG-B309: set by the DRIVER branch below when only routeRunStopId was
    // supplied, so the link block after the order write still persists
    // routeRunId (resolved from the validated stop).
    let resolvedRouteRunId: string | null = null;

    const orderDate = this.parseOrderDate(dto.orderDate, user.role);
    // Sales agents & commissions: staff-gated per-order rate override.
    const commissionRatePct = this.parseCommissionRatePct(dto.commissionRatePct, user.role);

    const isStaffRole = user.role === UserRole.OPERATOR || user.role === UserRole.TENANT_ADMIN;
    if (isStaffRole) {
      // Operator/TENANT_ADMIN creates on behalf of a customer — customerId comes from the DTO
      if (!dto.customerId) throw new BadRequestException("customerId is required");
      const customer = await this.prisma.forTenant().customer.findUnique({
        where: { id: dto.customerId },
        include: { user: { select: { status: true } } },
      });
      if (!customer) throw new BadRequestException("Customer not found");
      // B131: a removed (soft-deleted) customer is not an order target. Removal
      // writes Customer.deletedAt (+ User.status = INACTIVE), which the
      // SUSPENDED check below does not catch, so a stale detail page or a
      // queued request could still create — and later invoice — an order for a
      // customer the operator removed. Reuse the missing-customer message so no
      // customer state leaks.
      if (customer.deletedAt) throw new BadRequestException("Customer not found");
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
      // B131: same removed-customer refusal as the staff branch above.
      if (customer.deletedAt) throw new BadRequestException("Customer not found");
      customerId = customer.id;

      // B309: a driver may only link a new order to a stop/run that is their own
      // and currently active — mirrors routes.service.ts's completeWithPayment /
      // reopenStop driver-isolation guard (B72). This runs BEFORE any order row
      // is written, so a rejected link never leaves an orphan order.
      if (dto.routeRunId || dto.routeRunStopId) {
        const driver = await this.prisma
          .forTenant()
          .driver.findFirst({ where: { userId: user.sub } });

        let stop: { id: string; status: RouteRunStopStatus; routeRunId: string } | null = null;
        let runId = dto.routeRunId ?? null;
        if (dto.routeRunStopId) {
          stop = await this.prisma.forTenant().routeRunStop.findFirst({
            where: { id: dto.routeRunStopId },
            select: { id: true, status: true, routeRunId: true },
          });
          if (!stop) throw new BadRequestException("Stop not found");
          if (dto.routeRunId && dto.routeRunId !== stop.routeRunId) {
            throw new BadRequestException("Stop does not belong to the supplied route run");
          }
          runId = stop.routeRunId;
        }

        const run = await this.prisma.forTenant().routeRun.findFirst({
          where: { id: runId as string },
          select: { id: true, driverId: true, status: true },
        });
        if (!driver || !run || run.driverId !== driver.id) {
          throw new ForbiddenException("You do not have access to this route run");
        }
        if (run.status !== RouteRunStatus.IN_PROGRESS) {
          throw new BadRequestException("Route run is not in progress");
        }
        if (
          stop &&
          (stop.status === RouteRunStopStatus.COMPLETED ||
            stop.status === RouteRunStopStatus.SKIPPED)
        ) {
          throw new BadRequestException("Stop is already completed or skipped");
        }
        resolvedRouteRunId = runId;
      }
    } else {
      // Customer creates their own order
      // B309 (Opus MAJOR): the routeRunId/routeRunStopId link block later in
      // create() is role-agnostic and the controller admits CUSTOMER — without
      // this a buyer could POST either field directly and attach their own
      // order to a driver's manifest, bypassing the DRIVER-only
      // ownership/in-progress checks in the branch above entirely. Refuse
      // before any read or write; the OPERATOR/TENANT_ADMIN path is untouched.
      if (dto.routeRunId || dto.routeRunStopId) {
        throw new BadRequestException("Route run linkage is not allowed for customer orders");
      }
      // REG-B131: `deletedAt: null` here, not a second check below — a removal deactivates the
      // user but an access token minted just before it stays valid for up to 15 minutes, so a
      // removed customer's own in-flight session must fall into the existing refusal.
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub, deletedAt: null } });
      if (!customer) throw new ForbiddenException("Customer record not found");
      customerId = customer.id;
    }

    // F30/R8: the replay lookup runs HERE — after the caller's own customer is
    // resolved — never on the bare key. The key is entirely client-chosen, so
    // matching on it alone would hand buyer B the order buyer A created with
    // the same string (business name, every line, every unit price) while B's
    // own order is silently never written. A key already held by someone else
    // is a client-side collision, not a replay: refuse it, rather than replay
    // another caller's order or fall through to a write that would P2002 on
    // the same constraint anyway.
    if (idempotencyKey) {
      // B215: table first, then the Order column (findReplayCandidateByKey).
      const existing = await this.findReplayCandidateByKey(idempotencyKey, customerId);
      if (existing) {
        if (existing.customerId !== customerId) {
          throw new ConflictException("Idempotency-Key already used for a different order");
        }
        // R4 (close-out): a replay must be a replay OF THE SAME CART. A client
        // that edited its cart after a timed-out-but-committed submit and
        // reused the key would otherwise get the STALE order back as if the
        // edit had been saved. Compare the incoming line multiset against the
        // stored order; a mismatch is a client bug surfaced loudly, never a
        // silent wrong-cart acknowledgment.
        {
          const norm = (
            rows: Array<{ productId?: string | null; name?: string | null; qty: unknown }>,
          ) =>
            rows
              .map((r) => (r.productId ?? `unlisted:${r.name ?? ""}`) + "×" + Number(r.qty))
              .sort()
              .join("|");
          const incomingNorm = norm((dto.items ?? []) as never[]);
          const storedNorm = norm(
            (existing.lineItems ?? []).filter(
              (li: { status?: string }) => li.status !== "CANCELLED",
            ) as never[],
          );
          if (incomingNorm !== storedNorm) {
            throw new ConflictException(
              "Idempotency-Key reused with a different cart — submit the edited cart as a new order (new key), or retry the original unchanged",
            );
          }
        }
        return existing;
      }
    }

    // An auto-merge folds these items into an EXISTING order whose own business
    // date stays authoritative, so a supplied orderDate would be silently dropped.
    // Refuse instead — the operator can re-submit as a separate order.
    if (orderDate && !options.skipAutoMerge) {
      const mergeTarget = await this.findActiveOrder(customerId);
      if (mergeTarget) {
        throw new BadRequestException(
          "This customer has an open order. Enter a backdated order as a separate order.",
        );
      }
    }

    // Credit-note selections: validate up-front (bad/expired/cross-customer/VOID
    // selections reject before any stock mutation). Fully-consumed re-submissions
    // are deliberately accepted (idempotent resubmit).
    if (dto.appliedCreditNotes?.length) {
      await this.creditNotes.validateSelectionsForCustomer(
        this.prisma.forTenant(),
        customerId,
        dto.appliedCreditNotes,
      );
    }

    const isDraft = dto.status === "DRAFT";
    const items = dto.items ?? [];

    // Non-draft orders require at least one item
    if (!isDraft && items.length === 0) {
      throw new BadRequestException("At least one item is required");
    }

    // Load customer's pricing tier (+ default fulfillment path for new orders)
    const customerRecord = await this.prisma.forTenant().customer.findFirst({
      where: { id: customerId },
      select: { pricingTier: true, fulfillPath: true },
    });
    const defaultTier = customerRecord?.pricingTier ?? 1;
    // Ad-hoc trips + fulfillment mode: an explicit dto value always wins, else
    // fall back to the customer's own default, else ROUTE (byte-identical to
    // today for every existing order/customer, which default to ROUTE too).
    const fulfillPath = dto.fulfillPath ?? customerRecord?.fulfillPath ?? FulfillPath.ROUTE;

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

    // B142 (cause-ruling.md §2/§3, D3): staff AND buyer order create share this
    // one branch (cause-refutation.md §2 row 1) — reject a NEW order carrying an
    // archived product line at this interactive edge.
    // Fable train-2 fix round, item 4: EXEMPT via `options.allowArchived` —
    // the ONLY caller that passes it is the driver change-request draft path
    // (ChangeRequestsService.approve → :350ish `this.ordersService.create(...,
    // { allowArchived: true })`), which drafts a NEXT_DELIVERY order for a
    // product the customer already has on an existing (possibly since
    // archived) line; every other caller — staff create, buyer createOrder —
    // still rejects a new archived line (REG-B142-E/F).
    if (!options.allowArchived) {
      const archivedCreate = products.find((p: any) => p.isActive === false);
      if (archivedCreate) {
        throw new BadRequestException(
          `Product ${archivedCreate.sku ?? archivedCreate.name} is archived`,
        );
      }
    }

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
    const lineItemsData = items.map((item, index) => {
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
          // R2: preserve scan/insertion order (array index) for read-back.
          position: index,
          tenantId: this.prisma.getTenantId(),
        };
      }

      const product = productMap.get(item.productId);
      if (!product) throw new BadRequestException(`Product ${item.productId} not found`);

      // Recompute qty from boxes/pieces when provided (backend is authoritative).
      // Normalize to integers and roll loose pieces >= unitsPerBox into boxes.
      const upb = Number(product.unitsPerBox ?? 0);
      let qty = item.qty;
      let boxes: number | null = null;
      let pieces: number | null = null;
      // A zero boxes+pieces payload is "not using box entry", not "zero quantity" —
      // the web sale screen sends boxes:0/pieces:0 for plain-qty lines, and the old
      // non-null check let that overwrite a valid qty with 0 (live money bug: lines
      // stored qty 0.000 at full unitPrice, order total $0, invoice ungeneratable).
      // `qty` is threaded through so a product that isn't case-packed (unitsPerBox
      // 0/1 — the web still sends boxes:1 for unitsPerBox:1) keeps the operator's
      // qty instead of falling into normalizeBoxesPieces' non-boxed branch with no
      // qty at all, which derives 0 and trips the invariant below.
      if ((item.boxes ?? 0) > 0 || (item.pieces ?? 0) > 0) {
        const split = normalizeBoxesPieces({
          boxes: item.boxes,
          pieces: item.pieces,
          qty: item.qty,
          unitsPerBox: upb,
        });
        qty = split.qty;
        boxes = split.boxes;
        pieces = split.pieces;
      }

      // Every catalog line must persist a positive quantity — a zero-qty line can
      // only come from an invalid box/piece payload (e.g. boxes/pieces sent for a
      // product that isn't case-packed), and must fail loudly rather than silently
      // billing $0 for a real product (the exact shape of the live money bug above).
      if (!(Number(qty) > 0)) {
        throw new BadRequestException(
          `Line quantity must be greater than zero${product?.name ? ` (${product.name})` : ""}.`,
        );
      }

      // Resolve tier: per-product override > customer default tier
      const tierForProduct = cpMap.get(item.productId) ?? defaultTier;
      const listPrice = Number(product.pricePerUnit); // tier 1 = list price
      // B13: non-staff never set prices. POST /orders is reachable by DRIVER and
      // CUSTOMER as well as staff, and this DISCOUNTED-branch price had no role
      // gate — a hand-crafted driver request could bill any below-list price.
      // Mirrors the isStaffCaller posture already enforced in updateOrderItems;
      // this function already carries an identical `isStaffRole` flag (used by
      // the upsell/MANUAL branch below), so reuse it instead of a duplicate.
      const overridePrice = isStaffRole && item.unitPrice != null ? item.unitPrice : null;

      let unitPrice: number;
      let priceType: PriceType;
      let originalPrice: number | null = null;
      // BUY_N_GET_M: whole free selling units this line earned. Only ever set by
      // resolveBuyerLinePrice (buyer path); a staff override never combines with a
      // promo, so it stays 0 on the DISCOUNTED/upsell branches below.
      let freeUnits = 0;

      // QTY_BREAK promo threshold is measured in PIECES. A box-split line stores qty
      // in pieces already; a box-UNAWARE boxed line (boxes==null) stores qty as a
      // SELLING-UNIT (box) count, so expand it — mirrors the merge path so the same
      // buyer line prices identically at create vs edit.
      const qtyPieces = boxes != null ? qty : upb > 1 ? qty * upb : qty;
      // BUY_N_GET_M threshold is measured in whole SELLING units — a box for a
      // boxed line, a piece otherwise. `boxes` already holds the whole-box count
      // once split; a box-unaware boxed line's `qty` IS the box count (no split
      // was provided); a non-boxed line's `qty` is already in pieces = units.
      const qtyUnits = boxes != null ? boxes : qty;

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
          qtyUnits,
          rememberedForLine,
          // REG-B109: the exact denomination this line bills with below.
          { boxes, pieces, unitsPerBox: upb },
        );
        unitPrice = resolved.unitPrice;
        priceType = resolved.priceType;
        originalPrice = resolved.originalPrice;
        freeUnits = resolved.freeUnits;
      }

      // For boxed products `unitPrice` is the BOX price; loose pieces are
      // prorated. BUY_N_GET_M's `freeUnits` subtracts whole selling units from the
      // subtotal BEFORE pricing — never a rounded net-unit-price (a $35 line split
      // 5-for-1-free would drift cents as 35*5/6=29.1667). See pricing.ts.
      const itemSubtotal = computeLineSubtotal({
        unitPrice,
        qty,
        boxes,
        pieces,
        unitsPerBox: upb,
        freeUnits,
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
        // BUY_N_GET_M sale-time snapshot; null for every other line (unaffected).
        promoFreeUnits: freeUnits > 0 ? freeUnits : null,
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
        // R2: preserve scan/insertion order (array index) for read-back.
        position: index,
        tenantId: this.prisma.getTenantId(), // nested creates bypass forTenant() extension
      };
    });

    subtotal = roundMoney(subtotal);
    // Opus review of 942d5d69: rounded here (not left raw) so the
    // discount-vs-subtotal comparison inside assertMoneyInvariantsOrThrow
    // below compares two cents-rounded values, never a raw client float
    // against an already-rounded subtotal.
    const orderDiscount = roundMoney(dto.discountAmount ?? 0);
    // Optional shipping fee — never taxed; added after tax like Invoice.shippingFee.
    const orderShippingFee = roundMoney(Math.max(0, dto.shippingFee ?? 0));
    const tax = roundMoney(subtotal * (await this.getTaxRate()));
    // RF-4: fold the regulated category tax (Σ per-line) into the order total. The
    // `tax` column stays REGULAR tax only; category tax is reconstructable from the
    // line snapshots (Σ categoryTaxAmount), so no dedicated Order column is needed.
    const categoryTax = roundMoney(
      lineItemsData.reduce((s, li) => s + Number(li.categoryTaxAmount ?? 0), 0),
    );
    const total = roundMoney(subtotal + tax + categoryTax - orderDiscount + orderShippingFee);

    // B451 gap 4: reject a bounded-but-oversized discountAmount before it can
    // drive the persisted total negative. Fails fast, before any stock lock
    // or transaction opens.
    assertMoneyInvariantsOrThrow({
      subtotal,
      discount: orderDiscount,
      tax: tax + categoryTax,
      shipping: orderShippingFee,
      total,
    });

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
        order = await this.prisma.tenantTransaction(
          async (tx) => {
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
              // B283: extracted to `decrementStockForSale` — changeStatus()'s
              // DRAFT→PENDING promotion is the SAME "becomes a real sale" moment
              // as a non-draft create(), so it calls the identical helper (no
              // second implementation of the lock/oversell-check/decrement).
              await this.decrementStockForSale(tx, stockLines, isStaffRole);
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
                // F30/R8: persist the replay key (null for every caller that
                // doesn't send one — untouched by the compound unique below,
                // since Postgres treats NULLs as distinct).
                idempotencyKey: idempotencyKey ?? null,
                status: isDraft ? OrderStatus.DRAFT : OrderStatus.PENDING,
                subtotal,
                tax,
                total,
                discountAmount: orderDiscount,
                shippingFee: orderShippingFee,
                notes: dto.notes,
                urgent: dto.urgent ?? false,
                // A dated order records a past business day, so it must stay out of the
                // merge set in BOTH directions regardless of what the caller asked for:
                // as a loser the sweep hard-deletes it (its orderDate and order number
                // are gone), as a winner it absorbs items that belong to another day.
                skipAutoMerge: orderDate != null || (options.skipAutoMerge ?? false),
                // Phase 4 (W4): denormalized flag — true when any line is regulated.
                hasRegulated: lineItemsData.some((li) => li.trackedCategoryId != null),
                requestedDeliveryDate: dto.requestedDeliveryDate
                  ? new Date(dto.requestedDeliveryDate)
                  : undefined,
                orderDate,
                // Sales agents & commissions: staff-gated per-order rate override
                // (0 = exempt; null/undefined = no override, fall back to the
                // customer/agent default). Validated by parseCommissionRatePct above.
                commissionRatePct,
                fulfillPath,
                lineItems: { create: lineItemsData },
              },
              include: {
                customer: { select: { id: true, businessName: true } },
                lineItems: {
                  include: { product: { select: { id: true, name: true, unit: true } } },
                },
              },
            });
          },
          // B116 (REG-B116): bound the stock transaction instead of leaving it
          // uncapped — an unbounded interactive transaction can hold the
          // product row lock indefinitely under contention.
          { timeout: 20000, maxWait: 5000 },
        );
        break; // transaction succeeded
      } catch (e: any) {
        if (e?.code === "P2002") {
          // F30/R8: a concurrent request carrying the SAME idempotency key won
          // the race between our pre-check above and this write — fetch and
          // return the order IT just created instead of retrying (retrying
          // would mint a fresh order number and create a genuine duplicate,
          // exactly what the key exists to prevent).
          const target = e?.meta?.target;
          const hitIdempotencyConstraint =
            idempotencyKey != null &&
            (Array.isArray(target)
              ? target.some((t: unknown) => String(t).toLowerCase().includes("idempotencykey"))
              : String(target ?? "")
                  .toLowerCase()
                  .includes("idempotencykey"));
          if (hitIdempotencyConstraint) {
            // B215: same table-then-column lookup as the pre-check above, so the row that won
            // the race is found whether it was stamped on the column or written to the table.
            const existing = await this.findReplayCandidateByKey(idempotencyKey!, customerId);
            // Same ownership gate as the pre-check above: the row that won the
            // race is only OUR replay if it belongs to this caller.
            if (existing && existing.customerId !== customerId) {
              throw new ConflictException("Idempotency-Key already used for a different order");
            }
            if (existing) return existing;
          }
          // Retry only on orderNumber unique-constraint violations (RF-014);
          // propagate all other errors immediately (including ConflictException
          // for OOS items from RF-017).
          if (attempt < MAX_RETRIES - 1) continue;
        }
        throw e;
      }
    }

    // If driver is creating at a stop, link order to route run and optionally confirm it
    if (dto.routeRunId || dto.routeRunStopId) {
      await this.prisma.forTenant().order.update({
        where: { id: order.id },
        data: {
          // B309: a driver who supplied only routeRunStopId still gets routeRunId
          // written, resolved from the validated stop above.
          routeRunId: dto.routeRunId ?? resolvedRouteRunId ?? null,
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

    // Credit-note intents: store the operator's selection against the FINAL order
    // id, then settle (a harmless no-op until an invoice exists — settle bails
    // early when the order has no invoices yet). Short, dedicated Serializable tx
    // — NOT inside the stock/create transaction above.
    if (dto.appliedCreditNotes !== undefined) {
      await this.prisma.tenantTransaction(
        async (tx) => {
          await this.creditNotes.syncOrderCreditSelections(
            tx,
            order.id,
            customerId,
            dto.appliedCreditNotes,
          );
          await this.creditNotes.settleOrderCreditsInTx(tx, order.id);
        },
        { isolationLevel: "Serializable" },
      );
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
   *  - deliveredOn        → the delivery-date picker; when present it replaces the binary above
   *                         (past/today = delivered on that date, future = scheduled for it).
   *
   * The order is always created in isolation (skipAutoMerge) so a discrete sale never folds into an
   * existing open order.
   */
  async createSale(dto: CreateSaleDto, user: JwtPayload) {
    const orderDate = this.parseOrderDate(dto.orderDate, user.role);

    // Delivery-date picker (owner 2026-08-25): `deliveredOn` REPLACES
    // `deliveredNow`'s binary when present — past/today is a (back)dated
    // delivered sale, a future date is a scheduled deliver-later order carrying
    // that requested date. `deliveredNow` is still honoured on its own for older
    // clients; when both are sent, `deliveredOn` wins.
    let deliveredNow = dto.deliveredNow;
    let deliveredAt = orderDate;
    let requestedDeliveryDate = dto.requestedDeliveryDate;
    if (dto.deliveredOn != null) {
      const parsed = new Date(dto.deliveredOn);
      if (Number.isNaN(parsed.getTime())) throw new BadRequestException("Invalid delivery date");
      const now = new Date();
      const endOfToday = Date.UTC(
        now.getUTCFullYear(),
        now.getUTCMonth(),
        now.getUTCDate(),
        23,
        59,
        59,
        999,
      );
      if (parsed.getTime() > endOfToday) {
        deliveredNow = false;
        requestedDeliveryDate = dto.deliveredOn;
      } else {
        // Past/today: the sale happened on that day, so it goes through the same
        // staff-only gate and 2-year floor backdating has always had.
        deliveredNow = true;
        deliveredAt = this.parseOrderDate(dto.deliveredOn, user.role);
      }
    }

    // 1. Create the backing order (reuses pricing tiers/overrides + stock lock/decrement).
    const order = await this.create(
      {
        customerId: dto.customerId,
        items: dto.items,
        notes: dto.notes,
        discountAmount: dto.discountAmount,
        shippingFee: dto.shippingFee,
        requestedDeliveryDate,
        orderDate: dto.orderDate,
        status: "PENDING",
        appliedCreditNotes: dto.appliedCreditNotes,
        // Sales agents & commissions: threaded through so a "bill now" sale
        // honors the same per-order override as a plain order create.
        commissionRatePct: dto.commissionRatePct,
      },
      user,
      { skipAutoMerge: true },
    );

    // 2. Van sale: mark the order DELIVERED *directly*. We intentionally bypass changeStatus()
    //    here — changeStatus fires a fire-and-forget DRAFT invoice on DELIVERED, which would
    //    double-invoice this sale. (It also sidesteps the PENDING->DELIVERED transition guard.)
    if (deliveredNow) {
      await this.prisma.forTenant().order.update({
        where: { id: order.id },
        data: { status: OrderStatus.DELIVERED, deliveredAt: deliveredAt ?? new Date() },
      });
    }

    // 3. Generate the invoice from the order — sets Invoice.orderId and increments
    //    OrderItem.invoicedQty (so a later delivery of a not-yet-delivered sale won't
    //    create a second invoice).
    // W4: may return >1 sibling invoice for a mixed regulated order (standard + category).
    // Thread the operator's chosen due date / terms through so the invoice matches what
    // was shown on the "New sale" screen instead of silently falling back to the
    // tenant default (client-blocking bug: label said one term, math used another).
    const invoices = await this.invoicesService.createInvoiceFromOrder(order.id, undefined, {
      dueDate: dto.dueDate,
      terms: dto.terms,
      paymentTermsLabel: dto.paymentTermsLabel,
    });
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
    if (deliveredNow) {
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
      // REG-B131: `deletedAt: null` here — a removal deactivates the user but an access token
      // minted just before it stays valid for up to 15 minutes, so a removed customer's own
      // in-flight session must fall into the existing refusal below.
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub, deletedAt: null } });
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

    // Owner reversed policy 2026-08-25: EVERY state may step back one stage, so
    // `PENDING → DRAFT` and `DELIVERED → CONFIRMED` (the "Reopen Order" action,
    // previously removed as BUG-ORD-01) / `DELIVERED → PARTIALLY_DELIVERED`
    // ("it wasn't fully delivered after all") are legal. The role gates above
    // already make them staff-only — CUSTOMER may only cancel, DRIVER may only
    // confirm. Mirrored EXACTLY by `apps/mobile/lib/order-status-flow.ts`.
    const allowed: Record<string, string[]> = {
      DRAFT: ["PENDING", "CANCELLED"],
      PENDING: ["CONFIRMED", "CANCELLED", "DRAFT"],
      CONFIRMED: ["OUT_FOR_DELIVERY", "DELIVERED", "PENDING", "CANCELLED"],
      OUT_FOR_DELIVERY: ["DELIVERED", "PARTIALLY_DELIVERED", "CONFIRMED", "CANCELLED"],
      PARTIALLY_DELIVERED: ["OUT_FOR_DELIVERY", "DELIVERED", "CANCELLED"],
      DELIVERED: ["CONFIRMED", "PARTIALLY_DELIVERED"],
    };
    if (!(allowed[order.status] ?? []).includes(dto.status)) {
      throw new BadRequestException(`Cannot transition from ${order.status} to ${dto.status}`);
    }

    // Demotions require a reason
    const isDeliveredDemotion =
      order.status === OrderStatus.DELIVERED &&
      (dto.status === OrderStatus.CONFIRMED || dto.status === OrderStatus.PARTIALLY_DELIVERED);
    const isDemotion =
      (order.status === "CONFIRMED" && dto.status === "PENDING") ||
      (order.status === "OUT_FOR_DELIVERY" &&
        (dto.status === "PENDING" || dto.status === "CONFIRMED")) ||
      (order.status === "PARTIALLY_DELIVERED" && dto.status === "OUT_FOR_DELIVERY") ||
      (order.status === "PENDING" && dto.status === "DRAFT") ||
      isDeliveredDemotion;
    if (isDemotion && !dto.reason?.trim()) {
      throw new BadRequestException("A reason is required when demoting an order");
    }

    // Reopening a route-delivered order from here would leave the run stop
    // COMPLETED while the order says otherwise — the stop owns the stock and
    // payment reversal, so send staff there instead. One extra lookup, and only
    // on this transition.
    if (isDeliveredDemotion && order.routeRunStopId) {
      const stop = await this.prisma.forTenant().routeRunStop.findUnique({
        where: { id: order.routeRunStopId },
        select: { status: true },
      });
      if (stop?.status === "COMPLETED") {
        throw new ConflictException(
          "This order was delivered on a route run. Reopen its stop from the run instead — that reverses stock and payments correctly.",
        );
      }
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

    // Refuse the cancel BEFORE writing the status — a rejection must leave the
    // order exactly as it was, not cancelled-but-not-unwound.
    if (dto.status === OrderStatus.CANCELLED) await this.assertCancellableOrThrow(id);

    const statusUpdateData = {
      status: dto.status,
      // A backdated order was delivered on its business date, not on the day
      // staff got around to marking it.
      ...(dto.status === OrderStatus.DELIVERED
        ? { deliveredAt: order.deliveredAt ?? order.orderDate ?? new Date() }
        : {}),
      // A reopened order is no longer delivered — a stale deliveredAt would
      // keep it in delivered-on-date reports and reconcile passes.
      ...(isDeliveredDemotion ? { deliveredAt: null } : {}),
      ...(noteAppend ? { notes: (order.notes ?? "") + noteAppend } : {}),
    };

    const isDraftToPendingPromotion =
      order.status === OrderStatus.DRAFT && dto.status === OrderStatus.PENDING;
    const isPendingToDraftDemotion =
      order.status === OrderStatus.PENDING && dto.status === OrderStatus.DRAFT;

    // B283 (REG-B283) round 1 (F1): for the DRAFT<->PENDING transitions, the
    // status write happens INSIDE the same transaction as the stock settle
    // below — not as a separate, already-committed update — so a failure
    // between the decrement/credit and the status change can never leave a
    // live status with no matching stock movement (the narrower window that
    // let a later cancel credit phantom stock). Every other transition keeps
    // its own already-committed update, untouched.
    const updated = await (async () => {
      if (isDraftToPendingPromotion) {
        // B283 (REG-B283): promoting a DRAFT into a live PENDING order is when
        // it becomes a real sale — reserve stock now, via the SAME decrement
        // helper create() uses for a non-draft order (no second
        // implementation). Without this, cancel's `cancelReturnsStock =
        // order.status !== DRAFT` (below) credited stock back for a
        // promotion that never took any — a phantom stock credit on
        // DRAFT → PENDING → CANCELLED.
        const isStaffRole = user.role === UserRole.OPERATOR || user.role === UserRole.TENANT_ADMIN;
        return this.prisma.tenantTransaction(
          async (tx) => {
            // B283 (REG-B283) round 2 (F2): claim the row with a compare-and-set
            // BEFORE touching stock — an out-of-transaction read followed by a
            // plain `update` let two concurrent promotions of the same draft
            // both pass the pre-check and both decrement stock. `updateMany`'s
            // `where` re-checks status atomically against the current row; a
            // second promotion loses the race and gets `count: 0` here instead
            // of a second decrement.
            const claimed = await tx.order.updateMany({
              where: { id, status: OrderStatus.DRAFT },
              data: statusUpdateData,
            });
            if (claimed.count === 0) {
              throw new ConflictException(
                "This order is no longer DRAFT — someone else already changed its status.",
              );
            }
            const activeItems: Array<{ productId: string | null; qty: any }> =
              await tx.orderItem.findMany({
                where: { orderId: id, status: { not: "CANCELLED" } },
                select: { productId: true, qty: true },
              });
            const stockLines = activeItems
              .filter((li): li is { productId: string; qty: any } => !!li.productId)
              .map((li) => ({ productId: li.productId, qty: Number(li.qty) }));
            await this.decrementStockForSale(tx, stockLines, isStaffRole);
            return tx.order.findUniqueOrThrow({ where: { id } });
          },
          { isolationLevel: "Serializable", timeout: 15_000 },
        );
      }
      if (isPendingToDraftDemotion) {
        // Symmetric reverse: demoting a PENDING order back to DRAFT gives back
        // exactly what the DRAFT→PENDING promotion above took. Reuses the SAME
        // edit-delta helper the operator-edit and cancel paths already use
        // (heldItems = the order's current lines, final = none — an empty
        // target credits back the undelivered remainder, same call shape as
        // the cancel branch above).
        return this.prisma.tenantTransaction(
          async (tx) => {
            // B283 round 2 (F2): same compare-and-set claim, mirrored for the
            // reverse transition — see the DRAFT→PENDING branch above.
            const claimed = await tx.order.updateMany({
              where: { id, status: OrderStatus.PENDING },
              data: statusUpdateData,
            });
            if (claimed.count === 0) {
              throw new ConflictException(
                "This order is no longer PENDING — someone else already changed its status.",
              );
            }
            const activeItems = await tx.orderItem.findMany({
              where: { orderId: id, status: { not: "CANCELLED" } },
              select: { productId: true, qty: true, deliveredQty: true, status: true },
            });
            await this.settleStockForEdit(tx, { id, status: OrderStatus.PENDING }, activeItems, []);
            return tx.order.findUniqueOrThrow({ where: { id } });
          },
          { isolationLevel: "Serializable", timeout: 15_000 },
        );
      }
      return this.prisma.forTenant().order.update({ where: { id }, data: statusUpdateData });
    })();

    this.gateway.emitOrderStatusChanged(this.prisma.getTenantId(), {
      orderId: id,
      orderNumber: order.orderNumber ?? "",
      customerId: order.customerId,
      status: dto.status,
      previousStatus: order.status,
    });

    // B105 (REG-B105): a failed auto-invoice is reported to the operator, but only
    // AFTER the delivery notifications below have fired — the delivery itself
    // happened and the customer must still hear about it.
    let invoiceFailure: ConflictException | undefined;

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
        // B105 (REG-B105): genuinely awaited, with up to 3 attempts retrying
        // ONLY a ConflictException (the order-number race
        // createInvoiceFromOrderWithTenant regenerates internally on the next
        // attempt). The old `.catch()` fired the request and never inspected
        // the outcome — a failed auto-create silently left the order
        // DELIVERED with nothing billed and no one told. A non-Conflict error
        // breaks the loop immediately and surfaces through the same throw
        // below. The status write above is NOT reverted: the order stays
        // DELIVERED and staff retries invoicing from the order page.
        const capturedTenantId = this.prisma.getTenantId();
        const MAX_INVOICE_ATTEMPTS = 3;
        let lastErr: any;
        let attemptsMade = 0;
        for (let attempt = 0; attempt < MAX_INVOICE_ATTEMPTS; attempt++) {
          attemptsMade = attempt + 1;
          try {
            await this.invoicesService.createInvoiceFromOrderWithTenant(id, capturedTenantId);
            lastErr = undefined;
            break;
          } catch (err: any) {
            lastErr = err;
            if (!(err instanceof ConflictException)) break;
          }
        }
        if (lastErr) {
          this.logger.error(
            `Failed to auto-create invoice for order ${id} after ${attemptsMade} attempt(s): ${lastErr?.message ?? lastErr}`,
          );
          // Raised AFTER the notification block below, not here: the goods
          // physically arrived, so the customer's "Order Delivered" push and
          // messaging event must still fire. Throwing inline would make an
          // invoicing failure silently suppress the delivery notification.
          invoiceFailure = new ConflictException(
            `The order was marked delivered, but its invoice could not be created ` +
              `(${lastErr?.message ?? "unknown error"}). Use "Generate Invoice (full order)" on ` +
              `the order page to retry — the order stays delivered and nothing has been billed yet.`,
          );
        }
      }

      // B108 (REG-B108): retry transient contention (serializable-isolation
      // write conflicts) up to 3 times with a short backoff before giving up.
      // The old single-attempt try/catch swallowed the FIRST failure behind a
      // comment claiming send()/sendEmail()'s auto-apply would catch up —
      // that catch-up is real now that R13 wires settleOrderCreditsInTx into
      // both of those methods (WP-API-INVOICES), which is what makes a
      // survived final failure here safe: delivery must still never fail on
      // a settle failure, but giving up now logs at ERROR (not warn) so an
      // operator can find and manually settle the order.
      const MAX_SETTLE_ATTEMPTS = 3;
      for (let attempt = 1; attempt <= MAX_SETTLE_ATTEMPTS; attempt++) {
        try {
          await this.prisma.tenantTransaction(
            async (tx) => {
              await this.creditNotes.settleOrderCreditsInTx(tx, id);
            },
            { isolationLevel: "Serializable" },
          );
          break;
        } catch (err) {
          if (attempt === MAX_SETTLE_ATTEMPTS) {
            this.logger.error(`Credit settle after delivery failed for order ${id}: ${err}`);
          } else {
            await new Promise((r) => setTimeout(r, attempt === 1 ? 100 : 300));
          }
        }
      }
    } else if (dto.status === OrderStatus.CANCELLED) {
      // Cancelling means the customer owes nothing for this order, so EVERY live
      // invoice on it is voided — not just the pending mirror draft, which is all
      // this used to do. A SENT invoice left behind stayed collectible against a
      // cancelled order, and any credit applied to it stayed consumed forever
      // (settle skips VOID invoices, so nothing could ever give it back).
      //
      // Wallet money is returned first, inside the same transaction as the voids,
      // so a crash can't leave the credit spent and the invoice dead. External
      // payments already blocked this in assertCancellableOrThrow above.
      // B64 (REG-B64): a DRAFT never took a creation-time decrement, so a DRAFT
      // cancel neither credits stock NOR marks its lines. The credit and the mark
      // are ONE decision, not two: `reopenOrder` re-decrements exactly the lines
      // this cancel marked, so marking a line we did not credit would make reopen
      // take stock the order never held (understating it by the full quantity).
      const cancelReturnsStock = order.status !== OrderStatus.DRAFT;
      await this.prisma.tenantTransaction(
        async (tx) => {
          if (cancelReturnsStock) {
            const activeItems = await tx.orderItem.findMany({
              where: { orderId: id, status: { not: "CANCELLED" } },
              select: { productId: true, qty: true, deliveredQty: true, status: true },
            });
            // Return the creation-time decrement, clamped to the undelivered
            // remainder (settleStockForEdit with an empty final set). `order` here
            // is the PRE-cancel record (status not yet CANCELLED in memory).
            await this.settleStockForEdit(tx, order, activeItems, []);
          }

          const invoices = await tx.invoice.findMany({
            where: { orderId: id, status: { not: "VOID" } },
            select: { id: true },
          });
          await this.creditNotes.releaseOrderCreditsInTx(tx, id);
          for (const inv of invoices) {
            await this.invoicesService.releaseWalletPaymentsInTx(tx, inv.id);
            await this.invoicesService.voidInvoiceInTx(tx, inv.id, id);
          }
          if (cancelReturnsStock) {
            // Mark what this cancel released. Pre-F07 cancels left items untouched
            // and got no stock credit — reopenOrder re-decrements ONLY item-CANCELLED
            // lines, so both eras stay conservation-consistent.
            await tx.orderItem.updateMany({
              where: { orderId: id, status: { not: "CANCELLED" } },
              data: { status: "CANCELLED" },
            });
          }
        },
        // Headroom over Prisma's 5s default, matching every other
        // settleStockForEdit call site (:3053, :4755): this transaction now runs
        // that helper's per-product lock/read/write loop alongside the voids.
        { isolationLevel: "Serializable", timeout: 15_000 },
      );
    }
    // DRAFT→PENDING and PENDING→DRAFT (B283 F1) are handled above, atomically
    // with the status write, inside the `updated` transaction — nothing left
    // to do for them here.

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
      // N1 (2026-09-16): CANCELLED gains a real messaging-engine event — the
      // older push-notification `notifMap` above already covered it; this adds
      // the (now real, via EmailChannelProvider) EMAIL/PORTAL/WA/SMS channels.
      [OrderStatus.CANCELLED]: NotificationEvent.CANCELLED,
    };
    const messagingEvent = messagingEventMap[dto.status];
    if (messagingEvent) {
      let driverName = "your driver";
      if (messagingEvent === NotificationEvent.OUT_FOR_DELIVERY && order.routeRunId) {
        const run = await this.prisma.forTenant().routeRun.findFirst({
          where: { id: order.routeRunId },
          select: { driver: { select: { contactName: true } } },
        });
        driverName = run?.driver?.contactName ?? "your driver";
      } else if (
        messagingEvent === NotificationEvent.OUT_FOR_DELIVERY &&
        order.fulfillPath === FulfillPath.SHIP
      ) {
        // Ad-hoc trips + fulfillment mode: a SHIP order has no route run, so the
        // "Out for Delivery" notification names the carrier instead of a driver.
        driverName = order.shippingCarrier ?? "the carrier";
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
          ? { orderTotal: formatMoney(updated.total), deliveredAt: formatDate(new Date()) }
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

    // B105 (REG-B105): the delivery is persisted and everyone has been told;
    // NOW surface the invoicing failure so the operator can retry it instead of
    // seeing a success toast over a delivered, never-billed order.
    if (invoiceFailure) throw invoiceFailure;

    return updated;
  }

  /**
   * What cancelling this order will actually do to its money. Read-only — it backs
   * both the confirmation the operator sees ("INV-12 will be voided, $50.00 goes
   * back to CN-7") and the guard that refuses the cancel, so the warning and the
   * rule can never disagree.
   */
  async cancelImpact(id: string) {
    const order = await this.prisma.forTenant().order.findFirst({
      where: { id },
      select: { id: true, status: true, orderNumber: true },
    });
    if (!order) throw new NotFoundException("Order not found");

    const invoices = await this.prisma.forTenant().invoice.findMany({
      where: { orderId: id, status: { not: "VOID" } },
      select: {
        id: true,
        invoiceNumber: true,
        status: true,
        total: true,
        payments: { select: { method: true, amount: true, status: true } },
      },
    });

    // B56 (REG-B56): delivered goods block a cancel — the same signal
    // settleStockForEdit already refuses to treat as returnable.
    const activeLines = await this.prisma.forTenant().orderItem.findMany({
      where: { orderId: id, status: { not: "CANCELLED" } },
      select: { qty: true, deliveredQty: true },
    });
    const deliveredUnits =
      Math.round(activeLines.reduce((s, li) => s + Number(li.deliveredQty ?? 0), 0) * 1000) / 1000;

    // External money can't be un-taken by software; it blocks the cancel until a
    // human refunds it. Wallet money (credit notes, advances) is simply returned.
    // PR-2 (check-payments B1 hardening, N4 owner ruling): isBlockingPayment (NOT
    // isHeldPayment) — a DRAFT external payment is money in flight and must keep
    // blocking the cancel exactly as it does today; HELD (PAID ∪ PENDING) is for
    // money TOTALS only, never an existence/blocking check.
    const blockers: Array<{ invoiceNumber: string; amount: number }> = [];
    for (const inv of invoices) {
      const external = roundMoney(
        (inv.payments ?? [])
          .filter(
            (p: any) =>
              isBlockingPayment(p) && p.method !== "CREDIT_NOTE" && p.method !== "ADVANCE",
          )
          .reduce((s: number, p: any) => s + Number(p.amount), 0),
      );
      if (external > 0.001)
        blockers.push({ invoiceNumber: inv.invoiceNumber ?? "", amount: external });
    }

    const credits = await this.creditNotes.previewOrderCreditRelease(id);
    // scan-ok: draft-payment-not-void — method-scoped to ADVANCE; a CHECK/PENDING row
    // can never match, so PR-2's PENDING concern doesn't apply here.
    const advances = roundMoney(
      invoices
        .flatMap((i) => i.payments ?? [])
        .filter((p: any) => p.status !== "VOID" && p.method === "ADVANCE")
        .reduce((s: number, p: any) => s + Number(p.amount), 0),
    );

    return {
      orderId: order.id,
      orderNumber: order.orderNumber ?? "",
      alreadyCancelled: order.status === OrderStatus.CANCELLED,
      invoicesToVoid: invoices.map((i) => ({
        id: i.id,
        invoiceNumber: i.invoiceNumber ?? "",
        status: i.status,
        total: roundMoney(Number(i.total)),
      })),
      creditsToRestore: credits,
      advanceToRestore: advances,
      blockingPayments: blockers,
      deliveredUnits,
      canCancel: blockers.length === 0 && deliveredUnits <= 0.001,
    };
  }

  /**
   * Throws when an order can't be cancelled — either because real money was
   * taken for it, or (B56 / REG-B56) because some of it has already been
   * delivered. The payments refusal is checked FIRST and its message stays
   * byte-identical to before: a cancel blocked by both must still name the
   * money, since that's the more urgent problem for an operator to act on.
   */
  private async assertCancellableOrThrow(id: string) {
    const impact = await this.cancelImpact(id);
    if (impact.canCancel) return;
    if (impact.blockingPayments.length > 0) {
      const detail = impact.blockingPayments
        .map((b) => `${formatMoney(b.amount)} on ${b.invoiceNumber || "an invoice"}`)
        .join(", ");
      throw new BadRequestException(
        `This order has payments that must be refunded before it can be cancelled: ${detail}. Reverse or refund them, then cancel.`,
      );
    }
    // B56 (REG-B56): delivered goods can't be un-delivered by cancelling the
    // order out from under them — that would erase the revenue for goods the
    // customer already has. Record a return, or edit the order down instead.
    throw new BadRequestException(
      `This order has delivered items (${impact.deliveredUnits} unit(s) already delivered). ` +
        `Cancelling would erase revenue for goods the customer already has. Record a return for ` +
        `the delivered goods, or edit the order down to the undelivered items instead.`,
    );
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
    return this.prisma.tenantTransaction(
      async (tx) => {
        // B64 (REG-B64): read the item-CANCELLED lines BEFORE they flip below —
        // this is exactly the set an F07 cancel credited stock back for (a
        // pre-F07 cancel left lines untouched, so this reads empty and
        // re-decrements nothing — era consistency, not a regression).
        const cancelledLines = await tx.orderItem.findMany({
          where: { orderId: id, status: ItemStatus.CANCELLED },
          select: { productId: true, qty: true, deliveredQty: true },
        });

        // Revert cancelled line items back to PENDING
        await tx.orderItem.updateMany({
          where: { orderId: id, status: ItemStatus.CANCELLED },
          data: { status: ItemStatus.PENDING },
        });

        if (cancelledLines.length > 0) {
          // Model the delivered portion as already-held so the settle delta is
          // exactly qty − deliveredQty per product (what the cancel credited
          // back). Staff-only path → `user` undefined → warn-only oversell,
          // matching create()'s own staff behavior.
          await this.settleStockForEdit(
            tx,
            { id, status: OrderStatus.PENDING },
            cancelledLines.map((li) => ({
              productId: li.productId,
              qty: Number(li.deliveredQty ?? 0),
              deliveredQty: Number(li.deliveredQty ?? 0),
              status: "PENDING",
            })),
            cancelledLines.map((li) => ({ productId: li.productId, qty: Number(li.qty) })),
          );
        }

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
        // Headroom over Prisma's 5s default, matching every other
        // settleStockForEdit call site (:3053, :4755) — the re-decrement above runs
        // that helper's per-product lock/read/write loop.
      },
      { timeout: 15_000 },
    );
  }

  async updateOrderItems(
    orderId: string,
    dto: UpdateOrderItemsDto,
    user?: JwtPayload,
    // B215/B465: set ONLY by the staff create-merge branch (OrdersController.create). Not
    // reachable from a request body — the PATCH routes and the buyer merge call with three
    // arguments. isCreateMerge: this replace-all IS the create path's own auto-merge, so a
    // line NEW to the order (no existing counterpart) skips the reason-required guard below,
    // matching separate create's own unchecked behavior — never inferred from the DTO/order
    // state, only ever set here by the one call site that means it.
    opts?: {
      idempotency?: { key: string; responseHash: string };
      isCreateMerge?: boolean;
    },
  ) {
    const order = await this.prisma.forTenant().order.findUnique({
      where: { id: orderId },
      include: {
        lineItems: true,
        routeRun: { select: { status: true, startedAt: true } },
      },
    });
    if (!order) throw new NotFoundException("Order not found");
    // R1: items are editable at ANY live stage — DRAFT/PENDING/CONFIRMED and now
    // OUT_FOR_DELIVERY / PARTIALLY_DELIVERED / DELIVERED too (operator + driver). Only
    // a CANCELLED order is off-limits (nothing to edit). Post-delivery edits re-sync
    // the linked invoice(s) + regulated ledger and surface the new balance (see the
    // reconcile routing after the mutation). The former dispatch gate (EDIT_WINDOW_CLOSED
    // once the RouteRun left SCHEDULED) is removed: dispatched/out-for-delivery orders
    // now edit directly instead of forcing the post-dispatch change-request flow.
    if (order.status === "CANCELLED") {
      throw new BadRequestException("Items can't be edited on a cancelled order");
    }

    // B63 (REG-B63): buyers self-edit only pre-dispatch orders — the post-dispatch
    // relaxation in the comment above is operator + driver only. Thrown BEFORE any
    // side effect (invoice revert, line writes, revision, status event); buyers use
    // the change-request flow once the order is out the door.
    // Ownership is settled FIRST: this message names the order's dispatch state,
    // so a non-owner must keep meeting the same bare 403 the in-transaction
    // ownership check below already gives them on every other status — otherwise
    // an authenticated buyer could read another customer's order status off the
    // response body. The extra read only runs on the path about to throw anyway.
    if (user?.role === UserRole.CUSTOMER && BUYER_EDIT_CLOSED_STATUSES.includes(order.status)) {
      // REG-B131: `deletedAt: null` — a removed customer's still-valid token resolves to no
      // owner and takes the bare 403 below, never the dispatch-state message.
      const owner = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub, deletedAt: null } });
      if (!owner || order.customerId !== owner.id) throw new ForbiddenException();
      throw new ForbiddenException(
        "This order is already out for delivery. Send a change request instead.",
      );
    }

    // A4: the mobile item editor is SHARED between the operator and driver screens
    // and always sends an incremental diff — {id, action} entries with
    // replaceAll:false — while the CUSTOMER/DRIVER branch below is a full replace
    // (deleteMany, then re-create only productId-carrying entries). A diff routed
    // through the replace branch therefore deleted every untouched line on the
    // order. Diff-shaped DRIVER payloads go through the operator merge branch
    // instead (price fields stripped just below), and a diff-shaped CUSTOMER
    // payload is rejected outright: no buyer client sends one (web+mobile buyer
    // portals send full {productId, qty} lists), and failing loudly beats
    // silently destroying the order's lines.
    const isDiffPayload =
      dto.replaceAll === false ||
      (dto.items ?? []).some(
        (i) => i.id != null || i.action != null || i.substituteProductId != null,
      );
    if (user?.role === UserRole.CUSTOMER && isDiffPayload) {
      throw new BadRequestException(
        "Buyer edits must send the full item list as {productId, qty} entries; incremental item diffs are not supported on this path",
      );
    }
    const driverDiffEdit = user?.role === UserRole.DRIVER && isDiffPayload;
    if (driverDiffEdit) {
      // B13: non-staff never set prices. The merge branch honors per-line
      // unitPrice overrides for operators, so strip price fields from every
      // catalog-linked driver entry before it gets there — a fresh add prices
      // from the catalog and a qty edit keeps the line's stored price (which
      // may be an operator's override; a driver edit must not disturb it).
      // Unlisted (catalog-free) lines keep their client price: they have no
      // catalog price to fall back to, matching the replace branch's
      // long-standing unlisted handling.
      const unlistedLineIds = new Set(
        (order.lineItems ?? []).filter((li) => !li.productId).map((li) => li.id),
      );
      dto.items = (dto.items ?? []).map((i) => {
        const isUnlistedLine = i.id
          ? unlistedLineIds.has(i.id)
          : !i.productId && (i.name ?? "").trim() !== "";
        if (isUnlistedLine) return i;
        const { unitPrice: _unitPrice, overrideReason: _overrideReason, ...rest } = i;
        return rest;
      });
    }

    // R1: a POST-DELIVERY edit (order already OUT_FOR_DELIVERY / PARTIALLY_DELIVERED /
    // DELIVERED) re-syncs its finalized / paid / delivery-batch invoice(s) IN PLACE
    // after the mutation (resyncOrderInvoicesForEdit) — keeping payments and surfacing
    // the new balance, never blocking. So skip the pre-mutation revert here (which
    // throws when a SENT invoice has payments). Undelivered edits keep the auto-revert:
    // a SENT pending-mirror flips to DRAFT so the reconcile below re-syncs into it, and
    // a paid one throws cleanly before any mutation so money never detaches from a sent
    // document. No-op when there's no such invoice.
    const postDeliveryEdit = POST_DELIVERY_EDIT_STATUSES.includes(order.status);
    if (!postDeliveryEdit) {
      await this.invoicesService.revertLinkedInvoicesForOrderEdit(orderId);
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
    // BUY_N_GET_M: the stored-price qty edit below re-derives a line's free units
    // for the NEW quantity. Loaded (on its own pooled connection, like the reads
    // above) ONLY when a line already carries a free-unit snapshot, so no
    // operator/driver edit gains a promo it never had and non-BOGO edits issue
    // no extra query.
    const bogoPromos = (order.lineItems ?? []).some((li: any) => Number(li.promoFreeUnits ?? 0) > 0)
      ? await this.loadActivePromotions(UserRole.CUSTOMER)
      : [];

    // WP3: resolved on its own pooled connection BEFORE the tx opens, like the
    // reference reads above — the credit guard runs inside the transaction and
    // must not issue a non-transactional query from in there.
    const creditCheckEnabled = await this.isCreditLimitCheckEnabled();

    // P5-08b: the entire mutation phase — item writes, totals recompute, the
    // stock/credit guards, and the order-header update — runs in ONE tenant
    // transaction. A guard violation (or any failure) rolls back every item
    // write, so a blocked edit leaves the order byte-identical and appends no
    // revision. The guards intentionally consume the AUTHORITATIVE recomputed
    // totals/line set (not a pre-mutation simulation), so there is no second
    // pricing formula to drift. reconcileOrderDraftInvoice and
    // appendOrderRevision stay OUTSIDE (after commit), unchanged.
    const { subtotal, tax, total, shouldRevert, shippingFee } = await this.prisma.tenantTransaction(
      async (tx: any) => {
        // WP1/F2: serialize concurrent edits of ONE order, then snapshot its
        // pre-edit lines INSIDE the transaction. `order` above was read before
        // the tx opened, so under a concurrent edit (this web PATCH racing an
        // at-door approve of the same order) its lineItems are stale and the
        // stock delta computed from them is the WRONG MAGNITUDE — a permanent
        // inventory error, not just a lost update. The row lock makes the
        // second writer wait; heldItems is then read post-lock and BEFORE any
        // orderItem write below, so it is the true pre-edit state.
        await tx.$executeRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
        const heldItems = await tx.orderItem.findMany({
          where: { orderId },
          select: { productId: true, qty: true, deliveredQty: true, status: true },
        });

        // Customer/Driver path: replace items by productId. A4: a DRIVER diff
        // payload skips this branch entirely — it merges below like an operator
        // edit (with prices already stripped), so untouched lines survive.
        if (
          user?.role === UserRole.CUSTOMER ||
          (user?.role === UserRole.DRIVER && !isDiffPayload)
        ) {
          if (user.role === UserRole.CUSTOMER) {
            // REG-B131: `deletedAt: null` — the buyer replace-all path is the last door a
            // removed customer's still-valid session could mutate an order through.
            const customer = await tx.customer.findFirst({
              where: { userId: user.sub, deletedAt: null },
            });
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
            ? await tx.customer.findFirst({
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

          // B51 (REG-B51): buyers can neither author, reprice, nor drop unlisted
          // (catalog-free) lines — create()'s staff-only rule, mirrored. Stored
          // unlisted rows are preserved IN PLACE (same row ids — invoice/delivery
          // references survive); client-supplied unlisted input is ignored on the
          // buyer path. Drivers keep today's authoring behavior.
          await tx.orderItem.deleteMany({
            where: { orderId, ...(isBuyerEdit ? { productId: { not: null } } : {}) },
          });
          // R2: full replace — the client's item array IS the desired order, so
          // stamp position from a counter that only advances on a real create
          // (skipped/invalid items `continue` before it).
          let pos = 0;
          for (const item of dto.items) {
            if (!item.productId) {
              // B51: buyers never author/rename/drop an unlisted line — the
              // stored row above already survived the scoped delete; a buyer's
              // own unlisted payload entry is simply ignored.
              if (isBuyerEdit) continue;
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
                  position: pos++,
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
                // REG-B47: a folded merge payload carries an explicit box/piece split —
                // treat it as piece-denominated and re-split server-side from qty + LIVE
                // unitsPerBox (B13 posture: the split is a signal, never trusted verbatim).
                (isBuyerEdit && (item.boxes != null || item.pieces != null)) ||
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
            // BUY_N_GET_M threshold: whole SELLING units (boxes for a boxed line,
            // pieces otherwise) — mirrors create()'s qtyUnits derivation.
            const qtyUnits = boxes != null ? boxes : qty;
            const priced = isBuyerEdit
              ? this.resolveBuyerLinePrice(
                  product,
                  buyerCpMap.get(item.productId) ?? buyerDefaultTier,
                  buyerPromos,
                  qtyPieces,
                  qtyUnits,
                  buyerPriceHistory[item.productId]?.lastPrice ?? null,
                  // REG-B109: the exact denomination this line bills with below.
                  { boxes, pieces, unitsPerBox: upb },
                )
              : {
                  unitPrice: Number(product.pricePerUnit),
                  originalPrice: null as number | null,
                  priceType: PriceType.STANDARD,
                  freeUnits: 0,
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
                  freeUnits: priced.freeUnits,
                }),
                boxes,
                pieces,
                // Snapshot the sale-time box size on box-split lines (see create()).
                unitsPerBox: boxes != null && upb > 1 ? upb : null,
                originalPrice: priced.originalPrice,
                priceType: priced.priceType,
                // BUY_N_GET_M sale-time snapshot; null for every other line.
                promoFreeUnits: priced.freeUnits > 0 ? priced.freeUnits : null,
                status: "PENDING",
                notes: item.notes,
                // Snapshot the regulated category so an edited-in line invoices/ledgers
                // correctly (mirrors orders.service.create; spec §7).
                trackedCategoryId: product.trackedCategoryId ?? null,
                // RF-3: reporting-only subcategory snapshot (mirrors trackedCategoryId).
                trackedSubcategoryId: product.trackedSubcategoryId ?? null,
                // R2: preserve the client's line order on full replace.
                position: pos++,
              },
            });
          }
          if (isBuyerEdit) {
            // B51: the buyer's payload never mentions preserved unlisted rows,
            // so they were never re-stamped by the loop above — re-stamp them
            // to continue the position sequence after the client's own lines,
            // keeping R2's "client array order" contract for a mixed order.
            const preservedUnlisted = await tx.orderItem.findMany({
              where: { orderId, productId: null },
              orderBy: { position: "asc" },
            });
            for (const row of preservedUnlisted) {
              await tx.orderItem.update({ where: { id: row.id }, data: { position: pos++ } });
            }
          }
        } else {
          // Operator/admin path.
          // Whether to wipe + recreate (mobile "replace-all") vs. merge incrementally.
          // R10/B198: explicit `replaceAll: true` ONLY — the old shape-inference
          // heuristic ("every item lacks an id" ⇒ replace) is gone. That
          // heuristic wiped an order on any id-less "just add these" PATCH that
          // omitted the flag (the real mobile per-scan/edit shape), 200-ing a
          // catastrophic silent line loss keyed on an incidental payload
          // property. Every other caller (web, mobile, queued replays) now
          // defaults to the SAFE branch — an incremental add — unless it says
          // replaceAll:true out loud.
          // A4: a driver only ever reaches this branch with a diff payload —
          // never let one replace-all (that path deletes lines wholesale).
          const replaceAll = user?.role === UserRole.DRIVER ? false : dto.replaceAll === true;

          // WP1: tier pricing context for this operator/admin edit — loaded ONCE for
          // the whole call (not per sub-branch, not per item) so both the replace-all
          // and individual-item-update sub-branches below can resolve an un-priced
          // new/replaced line through the customer's tier ladder instead of billing
          // flat catalog price (mirrors create() + the isBuyerEdit branch above).
          // Post-MSRP hazard: CustomerPrice.pricingTier is nullable (an MSRP-only
          // row) — every lookup falls back to the customer's default tier below.
          // STAFF ONLY, same posture as the substitute branch's isStaffCaller: a
          // DRIVER also lands in this branch (A4 routes its diff payload here, with
          // prices stripped) and driver edits keep the legacy list pricing — so no
          // tier is resolved and no extra query is issued for them.
          const isStaffEdit =
            user?.role === UserRole.OPERATOR || user?.role === UserRole.TENANT_ADMIN;
          // B465 fix round (Opus BLOCK): an id-only UPDATE entry (web/mobile send
          // {id, action, qty, unitPrice} with no productId of their own) must resolve
          // tier pricing for the EXISTING line's product too — not just products
          // present in the payload — or a per-product CustomerPrice override never
          // gets fetched and the line silently falls back to the customer's DEFAULT
          // tier instead of a genuinely SPECIAL per-product row (or vice versa).
          const existingLineProductIds = dto.items
            .map((i) => (i.id ? order.lineItems.find((li) => li.id === i.id)?.productId : null))
            .filter((id): id is string => !!id);
          // B466: a substitution's NEW product id must resolve tier pricing too — it
          // was missing from this collection entirely (neither a fresh add's productId
          // nor an existing line's OLD productId covers it), so the substitute branch's
          // CustomerPrice lookup always fell back to the customer's DEFAULT tier even
          // when a per-product SPECIAL row existed for the substitute specifically.
          const substituteProductIds = dto.items.map((i) => i.substituteProductId).filter(Boolean);
          const operatorProductIds = isStaffEdit
            ? ([
                ...new Set([
                  ...dto.items.map((i) => i.productId).filter(Boolean),
                  ...existingLineProductIds,
                  ...substituteProductIds,
                ]),
              ] as string[])
            : [];
          const operatorTierCtx = isStaffEdit
            ? await tx.customer.findFirst({
                where: { id: order.customerId },
                select: { pricingTier: true },
              })
            : null;
          const operatorDefaultTier = operatorTierCtx?.pricingTier ?? 1;
          const operatorCustomerPrices = operatorProductIds.length
            ? await tx.customerPrice.findMany({
                where: { customerId: order.customerId, productId: { in: operatorProductIds } },
              })
            : [];
          const operatorCpMap = new Map<string, number | null>(
            operatorCustomerPrices.map((cp: any) => [cp.productId, cp.pricingTier]),
          );

          if (replaceAll) {
            // Replace-all: client sends the full item list. Delete existing items then
            // re-create, honoring any per-line price override and any boxes/pieces
            // split (boxed products use BOX-price proration).
            const productIds = dto.items.map((i) => i.productId).filter(Boolean) as string[];
            const products = await tx.product.findMany({ where: { id: { in: productIds } } });
            const productMap = new Map<string, any>(products.map((p: any) => [p.id, p]));

            // B60 (REG-B60): a staff replaceAll at an unchanged/echoed price must
            // land exactly where a qty edit of the same line lands — reuse the
            // stored price + priceType and RESCALE (never drop) the line's
            // BUY_N_GET_M snapshot instead of silently re-creating it at full
            // price. Built once from the PRE-edit lines, before the delete below
            // erases them.
            //
            // ⚠️ UNAMBIGUOUS PAIRS ONLY. A replaceAll payload carries no line ids,
            // and an order may legitimately hold SEVERAL lines of one product (the
            // diff-add branch creates a new row for an id-less item even when a line
            // for that product exists). Keying a counterpart by productId alone then
            // hands the snapshot — and its override attribution — to every echoed
            // line of that product, including a sibling that never earned one: two
            // lines of prod-X (qty 10 with 2 free units, qty 5 with none) echoed by a
            // no-op save would bill the second 5.00 x (5-1) = 20.00 instead of 25.00
            // and stamp it with the first line's overrideReason/overriddenBy. The
            // qty-edit oracle this arm copies yields 0 free units for that sibling
            // (storedFreeUnits 0, canEarnNew false), and rescaleBogoFreeUnits' own
            // contract is that no operator line gains a promo it never had.
            // There is no sound N-to-N mapping to recover here, so preservation is
            // registered ONLY when the pairing is unambiguous: exactly one pre-edit
            // non-cancelled line for that product AND exactly one incoming line for
            // it. Any other shape falls through to the pre-F06 behavior (re-created
            // at the resolved price, snapshot dropped) — that shape is not fixed by
            // F06, but it is never granted a snapshot it did not earn.
            const preEditLinesByProduct = new Map<string, number>();
            for (const li of order.lineItems ?? []) {
              if (!li.productId || li.status === "CANCELLED") continue;
              preEditLinesByProduct.set(
                li.productId,
                (preEditLinesByProduct.get(li.productId) ?? 0) + 1,
              );
            }
            const incomingLinesByProduct = new Map<string, number>();
            for (const it of dto.items ?? []) {
              if (!it.productId) continue;
              incomingLinesByProduct.set(
                it.productId,
                (incomingLinesByProduct.get(it.productId) ?? 0) + 1,
              );
            }
            const bogoCounterparts = new Map<string, any>();
            for (const li of order.lineItems ?? []) {
              if (
                li.productId &&
                li.status !== "CANCELLED" &&
                Number((li as any).promoFreeUnits ?? 0) > 0 &&
                preEditLinesByProduct.get(li.productId) === 1 &&
                incomingLinesByProduct.get(li.productId) === 1 &&
                !bogoCounterparts.has(li.productId)
              ) {
                bogoCounterparts.set(li.productId, {
                  qty: Number(li.qty),
                  boxes: li.boxes ?? null,
                  unitPrice: Number(li.unitPrice),
                  priceType: li.priceType,
                  // A counterpart is ANY line carrying a free-unit snapshot — it can
                  // be SPECIAL (tier strikethrough) or MANUAL (operator override), not
                  // only PROMO. Its strikethrough base and override attribution are
                  // captured too: the qty-edit oracle writes originalPrice /
                  // overrideReason / overriddenBy ONLY under isManualOverride, so at an
                  // unchanged price they must survive this re-create untouched.
                  originalPrice: li.originalPrice != null ? Number(li.originalPrice) : null,
                  overrideReason: (li as any).overrideReason ?? null,
                  overriddenBy: (li as any).overriddenBy ?? null,
                  promoFreeUnits: Number((li as any).promoFreeUnits ?? 0),
                });
              }
            }

            // B465 fix round 3 (Opus BLOCK item 2): the SAME unambiguous-pairing
            // rule as bogoCounterparts, generalized to every line (not gated on
            // promoFreeUnits) — the reason-required guard below must compare a
            // repriced SPECIAL line against what it ALREADY billed, never treat
            // every price on the wire as a fresh reprice attempt. An ambiguous
            // pairing (0 or 2+ pre-edit/incoming lines for the product) has no
            // sound "existing price" to compare against, so it falls through to
            // requiring a reason like a brand-new line would.
            const existingLineByProduct = new Map<
              string,
              { unitPrice: number; overrideReason: string | null }
            >();
            for (const li of order.lineItems ?? []) {
              if (
                li.productId &&
                li.status !== "CANCELLED" &&
                preEditLinesByProduct.get(li.productId) === 1 &&
                incomingLinesByProduct.get(li.productId) === 1 &&
                !existingLineByProduct.has(li.productId)
              ) {
                existingLineByProduct.set(li.productId, {
                  unitPrice: Number(li.unitPrice),
                  overrideReason: (li as any).overrideReason ?? null,
                });
              }
            }

            await tx.orderItem.deleteMany({ where: { orderId } });
            // R2: full replace — stamp position from the client's array order.
            let pos = 0;
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
                    position: pos++,
                  },
                });
                continue;
              }
              const product = productMap.get(item.productId);
              if (!product) throw new BadRequestException(`Product ${item.productId} not found`);

              // Recompute qty from boxes/pieces when the operator split a boxed
              // product (matches createOrder's authority). Normalize to integers and
              // roll loose pieces >= unitsPerBox into boxes. Falls back to plain qty.
              // A zero boxes+pieces payload is "not using box entry", not "zero
              // quantity" (see create()) — a POSITIVE check keeps it from zeroing a
              // real qty, and boxes/pieces stay null (box-unaware) instead of 0.
              let qty = item.qty ?? 0;
              let boxes: number | null = null;
              let pieces: number | null = null;
              if ((item.boxes ?? 0) > 0 || (item.pieces ?? 0) > 0) {
                const split = normalizeBoxesPieces({
                  boxes: item.boxes,
                  pieces: item.pieces,
                  qty,
                  unitsPerBox: product.unitsPerBox,
                });
                qty = split.qty;
                boxes = split.boxes;
                pieces = split.pieces;
              }
              if (qty <= 0) continue;

              const catalogPrice = Number(product.pricePerUnit);
              const overridePrice = item.unitPrice !== undefined ? Number(item.unitPrice) : null;
              // B60 (REG-B60): a client price that is ABSENT or merely ECHOES this
              // line's pre-edit BOGO snapshot price (tolerance 0.005 — float/decimal
              // round-trip, not an override decision) is not a repricing decision —
              // land where a qty edit of the same line lands (:3529-3675 is the
              // semantic oracle), never a bare re-create at full price.
              const bogoCounterpart = bogoCounterparts.get(item.productId);
              const bogoPriceUnchanged =
                bogoCounterpart != null &&
                (overridePrice === null ||
                  Math.abs(overridePrice - bogoCounterpart.unitPrice) <= 0.005);
              // Not a repricing decision ⇒ the line's override attribution survives
              // the re-create, exactly as the qty-edit oracle leaves it untouched.
              const preservedOverride = bogoPriceUnchanged ? bogoCounterpart : null;
              // B465 fix round 3 (Opus BLOCK item 2, HIGH): the same guard as the
              // diff-add/diff-update branches — a bare PRICE CHANGE on a
              // SPECIAL-tier line needs a documented reason, or the request is
              // refused before any mutation. Scoped to an ACTUAL change: skip
              // entirely when the price isn't moving relative either to the BOGO
              // snapshot (bogoPriceUnchanged) or to the general unambiguous
              // existing line for this product (replaceAllExisting) — an echoed
              // MANUAL line saved earlier with no reason, or ANY untouched line,
              // must round-trip unchanged, never retroactively demand a reason
              // for a price nobody is repricing. `foldMergeItems` (the staff
              // auto-merge's own caller) carries a surviving MANUAL override's
              // reason forward as `item.overrideReason`; when the payload omits
              // one anyway, fall back to the existing line's own stored reason
              // before refusing (mirrors the UPDATE branch's same fallback).
              const replaceAllExisting = existingLineByProduct.get(item.productId);
              const replaceAllPriceUnchanged =
                replaceAllExisting != null &&
                (overridePrice === null ||
                  Math.abs(overridePrice - replaceAllExisting.unitPrice) <= 0.005);
              const replaceAllTierForProduct = isStaffEdit
                ? (operatorCpMap.get(item.productId) ?? operatorDefaultTier)
                : 1;
              const replaceAllIsSpecialTier = isSpecialTier(replaceAllTierForProduct);
              const replaceAllHasOverrideReason = !!(
                (item.overrideReason && item.overrideReason.trim()) ||
                (replaceAllExisting?.overrideReason && replaceAllExisting.overrideReason.trim())
              );
              // B465 fix round 4 (Opus BLOCK item 1, HIGH), comment fixed round 5
              // (NIT): `replaceAllExisting == null` is null both for a line
              // genuinely NEW to the order and for an AMBIGUOUS pre-edit/incoming
              // pairing (0 or 2+ lines of that product — the same "no sound
              // mapping" shape bogoCounterparts/existingLineByProduct both refuse
              // above). Skipping the reason check for either shape here is safe:
              // this is the STAFF CREATE PATH's own auto-merge (gated on the
              // explicit isCreateMerge flag from the ONE call site that means it),
              // and `foldMergeItems` only ever forwards a stored price for an
              // EXISTING line whose priceType is MANUAL (R0's own contract) — an
              // ambiguous pairing here never carries a SPECIAL/derived price
              // forward to under-check, only ever a brand-new or MANUAL one, both
              // of which this PR's create path already leaves unchecked. Never
              // inferred from replaceAllExisting being null alone: an operator's
              // own replaceAll:true edit of an EXISTING order (isCreateMerge
              // unset) still needs the guard for a brand-new OR ambiguous line.
              const skipAsCreateMergeNewLine = !!opts?.isCreateMerge && replaceAllExisting == null;
              if (
                !bogoPriceUnchanged &&
                !replaceAllPriceUnchanged &&
                !skipAsCreateMergeNewLine &&
                overridePrice !== null &&
                replaceAllIsSpecialTier &&
                !replaceAllHasOverrideReason
              ) {
                throw new BadRequestException(
                  `A reason is required to change ${product.name ?? "this"} — it's this customer's special price`,
                );
              }
              // An explicit price DIFFERENT from catalog is a genuine operator override
              // (MANUAL); one that EQUALS catalog is still an operator-typed price and is
              // stored verbatim as STANDARD/list — unchanged behavior, and the only way to
              // sell a tiered customer at list for one order. WP1: ONLY a line carrying no
              // price at all falls through to the tier ladder, and only for staff. A price
              // the BOGO branch above already treated as unchanged is never a MANUAL
              // override either, even if it differs from today's catalog list price.
              const isManualOverride =
                !bogoPriceUnchanged && overridePrice !== null && overridePrice !== catalogPrice;
              const upb = Number(product.unitsPerBox ?? 0);
              const qtyPieces = boxes != null ? qty : upb > 1 ? qty * upb : qty;
              const qtyUnits = boxes != null ? boxes : qty;
              const priced: {
                unitPrice: number;
                originalPrice: number | null;
                priceType: PriceType;
                freeUnits: number;
              } = bogoPriceUnchanged
                ? {
                    unitPrice: bogoCounterpart.unitPrice,
                    // The stored strikethrough base, NOT null — a SPECIAL counterpart
                    // carries the list price here and dropping it erases the "was $x"
                    // from the order page, the invoice and every savings report.
                    originalPrice: bogoCounterpart.originalPrice,
                    priceType: bogoCounterpart.priceType,
                    // Copies the stored-price qty-edit branch's rescale shape
                    // verbatim (:3615-3632 is the oracle) — same promos context,
                    // same product row, oldUnits/newUnits in whole selling units.
                    freeUnits: this.rescaleBogoFreeUnits({
                      promos: bogoPromos,
                      productId: item.productId,
                      category: product.category ?? null,
                      unitPrice: bogoCounterpart.unitPrice,
                      storedFreeUnits: bogoCounterpart.promoFreeUnits,
                      oldUnits:
                        bogoCounterpart.boxes != null ? bogoCounterpart.boxes : bogoCounterpart.qty,
                      newUnits: boxes != null ? boxes : qty,
                    }),
                  }
                : overridePrice !== null
                  ? {
                      unitPrice: overridePrice,
                      originalPrice: isManualOverride ? catalogPrice : null,
                      priceType: isManualOverride ? PriceType.MANUAL : PriceType.STANDARD,
                      freeUnits: 0,
                    }
                  : isStaffEdit
                    ? this.resolveBuyerLinePrice(
                        product,
                        operatorCpMap.get(item.productId) ?? operatorDefaultTier,
                        buyerPromos,
                        qtyPieces,
                        qtyUnits,
                        null,
                        // REG-B109: the exact denomination this line bills with below.
                        { boxes, pieces, unitsPerBox: upb },
                      )
                    : {
                        // Non-staff caller: legacy list pricing, no tier resolution.
                        unitPrice: catalogPrice,
                        originalPrice: null as number | null,
                        priceType: PriceType.STANDARD,
                        freeUnits: 0,
                      };
              const unitPrice = priced.unitPrice;
              const subtotal = computeLineSubtotal({
                unitPrice,
                qty,
                boxes,
                pieces,
                unitsPerBox: product.unitsPerBox,
                freeUnits: priced.freeUnits,
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
                  priceType: priced.priceType,
                  originalPrice: priced.originalPrice,
                  // BUY_N_GET_M sale-time snapshot; null for every other line.
                  promoFreeUnits: priced.freeUnits > 0 ? priced.freeUnits : null,
                  // B60: on the preservation arm the attribution of WHO authorized
                  // this price is carried over, not erased by a no-op save.
                  // B465 fix round 3 (Opus BLOCK item 3): a blank incoming reason on
                  // a genuine override falls back to the existing line's own stored
                  // reason (the same unambiguous-pairing lookup the reason-required
                  // guard above uses) rather than clearing it — mirrors the diff/
                  // incremental UPDATE branch's identical fix.
                  overrideReason: isManualOverride
                    ? item.overrideReason?.trim()
                      ? item.overrideReason
                      : (replaceAllExisting?.overrideReason ?? null)
                    : (preservedOverride?.overrideReason ?? null),
                  overriddenBy: isManualOverride
                    ? (user?.sub ?? null)
                    : (preservedOverride?.overriddenBy ?? null),
                  // Snapshot the regulated category (spec §7).
                  trackedCategoryId: product.trackedCategoryId ?? null,
                  // RF-3: reporting-only subcategory snapshot (mirrors trackedCategoryId).
                  trackedSubcategoryId: product.trackedSubcategoryId ?? null,
                  // R2: preserve the client's line order on full replace.
                  position: pos++,
                },
              });
            }
          } else {
            // Individual item updates (dispatcher workflow with explicit item IDs).
            // R2: existing lines keep their position (updated by id); NEW lines
            // append after the current max so an added item lands at the bottom.
            // Legacy lines with null position count as -1 → new lines start at 0.
            let nextPos =
              Math.max(-1, ...(order.lineItems ?? []).map((li) => li.position ?? -1)) + 1;

            // R9/B197: resolve every NEW catalog-linked add BEFORE writing
            // anything in this loop. The old `if (!product) continue` let an
            // unresolvable id (stale cache, cross-tenant id post-filtered to
            // null) silently skip while its siblings landed — HTTP 200 with a
            // dropped line, invisible anywhere. Failing loudly here, before any
            // orderItem.create() below, means a bad id aborts the WHOLE add —
            // no partial write of the good lines alongside the missing one.
            // One batched read (the same shape the replace-all branch above
            // uses), not a findUnique per line: this runs inside the
            // transaction already holding SELECT … FOR UPDATE on the order, so
            // a 30-line scan batch must not spend 30 sequential round-trips
            // widening that window — and the Map it builds serves the add loop
            // below too, which used to re-read every one of these rows again.
            const addProductIds = [
              ...new Set(
                dto.items
                  .filter((item) => {
                    const hasBoxSplitCheck = (item.boxes ?? 0) > 0 || (item.pieces ?? 0) > 0;
                    const newQtyHintCheck = hasBoxSplitCheck ? 1 : (item.qty ?? 0);
                    return !item.id && item.productId && newQtyHintCheck > 0;
                  })
                  .map((item) => item.productId as string),
              ),
            ];
            const addProducts =
              addProductIds.length > 0
                ? await tx.product.findMany({ where: { id: { in: addProductIds } } })
                : [];
            const addProductMap = new Map<string, any>(addProducts.map((p: any) => [p.id, p]));
            const unresolvedAddIds = addProductIds.filter((id) => !addProductMap.has(id));
            if (unresolvedAddIds.length > 0) {
              throw new BadRequestException(
                `Product${unresolvedAddIds.length > 1 ? "s" : ""} not found: ${unresolvedAddIds.join(", ")}`,
              );
            }
            // B142 (cause-ruling.md §2/§3, D3): reject a NEW line for an archived
            // product at this interactive edge only — a qty/price edit or removal
            // of a line that already exists never reaches `addProductIds` (it has
            // an `item.id`), so archived lines already on the order keep working.
            const archivedAdd = addProducts.find((p: any) => p.isActive === false);
            if (archivedAdd) {
              throw new BadRequestException(
                `Product ${archivedAdd.sku ?? archivedAdd.name} is archived`,
              );
            }

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
                    // R2: append this newly-added line after the existing lines.
                    position: nextPos++,
                  },
                });
                continue;
              }
              // New item (no id, has productId; qty OR boxes/pieces). A zero
              // boxes+pieces payload is "not using box entry", not "zero quantity"
              // (see create()) — a POSITIVE check keeps it from masking/zeroing a
              // real qty or falling into box-priced math with an empty split.
              const hasBoxSplit = (item.boxes ?? 0) > 0 || (item.pieces ?? 0) > 0;
              const newQtyHint = hasBoxSplit ? 1 : (item.qty ?? 0);
              if (!item.id && item.productId && newQtyHint > 0) {
                // R9/B197: served from the pre-scan's batched read above, which
                // covers exactly this set of ids and already aborted the whole
                // request if any of them failed to resolve. The guard stays as
                // a belt-and-braces invariant — never silently drop a line.
                const product = addProductMap.get(item.productId);
                if (!product) throw new BadRequestException(`Product ${item.productId} not found`);
                // Recompute qty from boxes/pieces when present.
                let qty = item.qty ?? 0;
                if (hasBoxSplit) {
                  const upb = Number(product.unitsPerBox ?? 0);
                  qty = (item.boxes ?? 0) * upb + (item.pieces ?? 0);
                }
                if (qty <= 0) continue;
                // Store null (box-unaware), never 0, when box entry wasn't used.
                const boxesForLine = hasBoxSplit ? (item.boxes ?? null) : null;
                const piecesForLine = hasBoxSplit ? (item.pieces ?? null) : null;
                const catalogPrice = Number(product.pricePerUnit);
                const overridePrice = item.unitPrice !== undefined ? Number(item.unitPrice) : null;
                const unitsPerBoxNum = Number(product.unitsPerBox ?? 0);
                const qtyPieces =
                  boxesForLine != null ? qty : unitsPerBoxNum > 1 ? qty * unitsPerBoxNum : qty;
                const qtyUnits = boxesForLine != null ? boxesForLine : qty;
                const tierForProduct = isStaffEdit
                  ? (operatorCpMap.get(item.productId) ?? operatorDefaultTier)
                  : 1;
                // B465: a customer/product that resolves to SPECIAL tier is a documented
                // contract price. A bare staff-typed price must never override it — that
                // included a typed price equal to CATALOG, the original hole: the client
                // pre-fills the price field with the list price for a fresh add, and that
                // silently saved as STANDARD even though this customer's real price for the
                // product is the SPECIAL tier rate. Only a genuine documented override (a
                // price change WITH a reason — the same path `applyPriceOverride` uses on
                // the client) is honored. Fix-round-2 (Opus BLOCK): a price with no reason
                // on a SPECIAL line is REFUSED outright, before any mutation — never
                // silently dropped/ignored, which would 200 the request while quietly
                // keeping the tier price with no record the caller even tried to change it.
                const lineIsSpecialTier = isSpecialTier(tierForProduct);
                const hasOverrideReason = !!(item.overrideReason && item.overrideReason.trim());
                if (overridePrice !== null && lineIsSpecialTier && !hasOverrideReason) {
                  throw new BadRequestException(
                    `A reason is required to change ${product.name ?? "this"} — it's this customer's special price`,
                  );
                }
                // An explicit price DIFFERENT from catalog is a genuine operator override
                // (MANUAL); one that EQUALS catalog is stored verbatim as STANDARD/list
                // (unchanged behavior — selling at list for one order). WP1: ONLY a line
                // with no price at all falls through to the tier ladder, and only for
                // staff — a DRIVER diff add (prices stripped by B13) keeps list pricing.
                const isManualOverride = overridePrice !== null && overridePrice !== catalogPrice;
                const priced =
                  overridePrice !== null
                    ? {
                        unitPrice: overridePrice,
                        originalPrice: isManualOverride ? catalogPrice : null,
                        priceType: isManualOverride ? PriceType.MANUAL : PriceType.STANDARD,
                        freeUnits: 0,
                      }
                    : isStaffEdit
                      ? this.resolveBuyerLinePrice(
                          product,
                          tierForProduct,
                          buyerPromos,
                          qtyPieces,
                          qtyUnits,
                          null,
                          // REG-B109: the exact denomination this line bills with below.
                          {
                            boxes: boxesForLine,
                            pieces: piecesForLine,
                            unitsPerBox: unitsPerBoxNum,
                          },
                        )
                      : {
                          // Non-staff caller (driver diff add): legacy list pricing.
                          unitPrice: catalogPrice,
                          originalPrice: null as number | null,
                          priceType: PriceType.STANDARD,
                          freeUnits: 0,
                        };
                const unitPrice = priced.unitPrice;
                const subtotal = computeLineSubtotal({
                  unitPrice,
                  qty,
                  boxes: boxesForLine,
                  pieces: piecesForLine,
                  unitsPerBox: product.unitsPerBox,
                  freeUnits: priced.freeUnits,
                });
                await tx.orderItem.create({
                  data: {
                    orderId,
                    productId: item.productId,
                    qty,
                    boxes: boxesForLine,
                    pieces: piecesForLine,
                    // Snapshot the sale-time box size on box-split lines (see create()).
                    unitsPerBox:
                      boxesForLine != null && Number(product.unitsPerBox ?? 0) > 1
                        ? Number(product.unitsPerBox)
                        : null,
                    unitPrice,
                    subtotal,
                    status: "PENDING",
                    notes: item.notes,
                    priceType: priced.priceType,
                    originalPrice: priced.originalPrice,
                    // BUY_N_GET_M sale-time snapshot; null for every other line. A fresh
                    // add has no prior line to preserve a snapshot from (R9 plumbing only
                    // here — always 0 for staff, P5-04's promos-[] invariant).
                    promoFreeUnits: priced.freeUnits > 0 ? priced.freeUnits : null,
                    overrideReason: isManualOverride ? (item.overrideReason ?? null) : null,
                    overriddenBy: isManualOverride ? (user?.sub ?? null) : null,
                    // Snapshot the regulated category (spec §7).
                    trackedCategoryId: product.trackedCategoryId ?? null,
                    // RF-3: reporting-only subcategory snapshot (mirrors trackedCategoryId).
                    trackedSubcategoryId: product.trackedSubcategoryId ?? null,
                    // R2: append this newly-added line after the existing lines.
                    position: nextPos++,
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
                    data: {
                      status: "CANCELLED",
                      qty: 0,
                      subtotal: 0,
                      boxes: null,
                      pieces: null,
                      // A zeroed line has no free units left to show against it.
                      promoFreeUnits: null,
                    },
                  });
                } else {
                  await tx.orderItem.delete({ where: { id: item.id } });
                }
              } else if (item.action === "CANCEL") {
                await tx.orderItem.update({
                  where: { id: item.id },
                  data: {
                    status: "CANCELLED",
                    qty: 0,
                    subtotal: 0,
                    boxes: null,
                    pieces: null,
                    // A zeroed line has no free units left to show against it.
                    promoFreeUnits: null,
                  },
                });
              } else if (item.substituteProductId) {
                const product = await tx.product.findUniqueOrThrow({
                  where: { id: item.substituteProductId },
                });
                const existingQty = order.lineItems.find((li) => li.id === item.id)?.qty ?? 1;
                // Substitution may also carry a box/piece split when the substitute
                // is itself a boxed product. Honor it the same way as a fresh add —
                // but only when the SUBSTITUTE is case-packed: the incoming split is
                // denominated in the REPLACED product's box size, so multiplying it by
                // a loose substitute's unitsPerBox (null/1) would collapse the line to
                // its loose pieces (qty 0 on a whole-case line). Fall back to the piece
                // qty there, and normalize otherwise so a split sized to a different
                // case can't persist with pieces >= the substitute's unitsPerBox.
                const upb = Number(product.unitsPerBox ?? 0);
                const split =
                  (item.boxes != null || item.pieces != null) && upb > 1
                    ? normalizeBoxesPieces({
                        boxes: item.boxes,
                        pieces: item.pieces,
                        unitsPerBox: upb,
                      })
                    : null;
                const qtyVal = split ? split.qty : (item.qty ?? Number(existingQty));
                if (qtyVal <= 0) continue;
                // B3: staff (OPERATOR/TENANT_ADMIN) may re-price the substitute line —
                // same house override convention as create()'s operator-override ladder
                // and the operator update branches above: net unitPrice, DISCOUNTED
                // below the substitute's list price, MANUAL above it, originalPrice =
                // the displaced list price. This branch is only reachable via the
                // operator/admin path (drivers/customers replace-all above and never
                // carry substituteProductId), but the role check stays explicit so a
                // driver/customer DTO can never buy price control here — B13, non-staff
                // never set prices. No override (or one equal to the substitute's own
                // tier price) keeps today's SPECIAL/STANDARD tier-priced behavior.
                const isStaffCaller =
                  user?.role === UserRole.OPERATOR || user?.role === UserRole.TENANT_ADMIN;
                const listPrice = Number(product.pricePerUnit);
                // B466: this branch never checked tier at all — a bare unitPrice on a
                // substitute to a SPECIAL-tier product was compared only against LIST
                // price, so a correctly-priced substitute (typed at this customer's real
                // contract price) was silently stored as DISCOUNTED with no reason. Same
                // tier resolution as the ADD/UPDATE branches above (reuse isSpecialTier(),
                // operatorCpMap/operatorDefaultTier — operatorProductIds now also collects
                // substituteProductId so the per-product CustomerPrice row is fetched).
                const tierForProduct = isStaffCaller
                  ? (operatorCpMap.get(item.substituteProductId) ?? operatorDefaultTier)
                  : 1;
                const isSpecialTier = this.isSpecialTier(tierForProduct);
                const tierPrice = Number(getTierPrice(product, tierForProduct));
                const overridePrice =
                  isStaffCaller && item.unitPrice != null ? Number(item.unitPrice) : null;
                // The baseline is the SUBSTITUTE's own tier price (equals list when
                // tierForProduct is 1, so non-special behavior is unchanged) — a price
                // matching what this customer already pays for the new product is not a
                // repricing decision and needs no reason, same half-cent tolerance the
                // UPDATE branch's priceUnchangedFromStored uses.
                const priceUnchangedFromTier =
                  overridePrice != null && Math.abs(overridePrice - tierPrice) <= 0.005;
                const hasOverrideReason = !!(item.overrideReason && item.overrideReason.trim());
                if (
                  overridePrice != null &&
                  isSpecialTier &&
                  !priceUnchangedFromTier &&
                  !hasOverrideReason
                ) {
                  throw new BadRequestException(
                    `A reason is required to change ${product.name ?? "this"} — it's this customer's special price`,
                  );
                }
                let unitPrice = tierPrice;
                let priceType: PriceType = isSpecialTier ? PriceType.SPECIAL : PriceType.STANDARD;
                let originalPrice: number | null = isSpecialTier ? listPrice : null;
                const isOverridden = overridePrice != null && !priceUnchangedFromTier;
                if (isOverridden && overridePrice != null) {
                  // Opus MERGE-verdict fix: round the honored override, matching the
                  // UPDATE branch's convention — never persist a raw client float.
                  unitPrice = roundMoney(overridePrice);
                  priceType = overridePrice < listPrice ? PriceType.DISCOUNTED : PriceType.MANUAL;
                  originalPrice = listPrice;
                }
                const subtotal = computeLineSubtotal({
                  unitPrice,
                  qty: qtyVal,
                  boxes: split?.boxes ?? null,
                  pieces: split?.pieces ?? null,
                  unitsPerBox: product.unitsPerBox,
                });
                await tx.orderItem.update({
                  where: { id: item.id },
                  data: {
                    productId: item.substituteProductId,
                    unitPrice,
                    qty: qtyVal,
                    // Always set the split explicitly — a loose substitute must not
                    // keep the replaced product's boxes/pieces.
                    boxes: split?.boxes ?? null,
                    pieces: split?.pieces ?? null,
                    // Re-snapshot the substitute's box size on box-split lines.
                    unitsPerBox: split ? upb : null,
                    // The product changed — a BOGO discount computed for the REPLACED
                    // product doesn't carry to a different one (this branch never
                    // re-runs applyBestPromotion; B13 non-staff-price posture above).
                    promoFreeUnits: null,
                    subtotal,
                    status: "PENDING",
                    notes: item.notes,
                    priceType,
                    originalPrice,
                    overrideReason: isOverridden ? (item.overrideReason ?? null) : null,
                    overriddenBy: isOverridden ? (user?.sub ?? null) : null,
                    // The product changed — re-snapshot the substitute's category so
                    // it doesn't keep the replaced product's (spec §7).
                    trackedCategoryId: product.trackedCategoryId ?? null,
                    // RF-3: re-snapshot the reporting subcategory alongside the category.
                    trackedSubcategoryId: product.trackedSubcategoryId ?? null,
                  },
                });
              } else if (
                item.qty !== undefined ||
                item.boxes != null ||
                item.pieces != null ||
                // F3 (independent review, PR-2): a qty-less payload carrying ONLY
                // overrideReason/notes (mobile's "damaged, no qty change" edit) never
                // reached this branch at all — the gate was qty/split-only, so the
                // reason-only and notes-only writes below were unreachable dead code
                // for exactly the payload shape that needs them.
                item.overrideReason !== undefined ||
                item.notes !== undefined
              ) {
                const li = order.lineItems.find((li) => li.id === item.id);
                if (!li) continue;

                // N4 (independent review round 2, PR-2): a payload carrying ONLY
                // overrideReason/notes (no qty/boxes/pieces/unitPrice at all) must never fall
                // through into the qty/box normalization below — that logic can RE-DERIVE a
                // different boxes/pieces/subtotal than what is stored (e.g. a box-split line
                // with no unitsPerBox snapshot falls back to a LIVE product lookup, whose box
                // size can differ from what was used at sale time), silently mutating money
                // fields a reason-only edit was never meant to touch. This is its own minimal,
                // fully separate write.
                const isUnlisted = !li.productId;
                const isReasonOrNotesOnly =
                  item.qty === undefined &&
                  item.boxes == null &&
                  item.pieces == null &&
                  item.unitPrice === undefined &&
                  (item.overrideReason !== undefined || item.notes !== undefined);
                if (isReasonOrNotesOnly) {
                  await tx.orderItem.update({
                    where: { id: item.id },
                    data: {
                      // Round 3 finding 1 (independent review, PR-2): `name` is not a pricing
                      // field — an unlisted line's rename must survive this fast path exactly
                      // like the full path below allows it, or a payload combining a rename
                      // with a reason/notes edit silently drops the rename.
                      ...(isUnlisted && item.name !== undefined ? { name: item.name } : {}),
                      ...(item.notes !== undefined ? { notes: item.notes } : {}),
                      ...(item.overrideReason !== undefined
                        ? {
                            overrideReason: item.overrideReason ?? null,
                            overriddenBy: user?.sub ?? null,
                          }
                        : {}),
                    },
                  });
                  continue;
                }
                // A zero boxes+pieces payload is "not using box entry", not "zero
                // quantity" (see create()) — a POSITIVE check keeps it from
                // silently discarding a real item.qty typed alongside it (the
                // `if (editHasSplit)` branch below ignores item.qty entirely).
                const editHasSplit = (item.boxes ?? 0) > 0 || (item.pieces ?? 0) > 0;
                const wasBoxSplit = li.boxes != null;
                // Resolve the box size for a catalog line even on a qty-ONLY edit —
                // prefer the line's sale-time snapshot, fall back to the live product.
                // Without this a qty-only edit of a box-split line dropped to non-boxed
                // math (per-piece × BOX price → overcharge) and left stale boxes/pieces.
                let unitsPerBox: number | null = (li as any).unitsPerBox ?? null;
                if (unitsPerBox == null && li.productId && (editHasSplit || wasBoxSplit)) {
                  const product = await tx.product.findFirst({
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
                    qty: item.qty ?? Number(li.qty),
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
                const tierForProduct =
                  isStaffEdit && li.productId
                    ? (operatorCpMap.get(li.productId) ?? operatorDefaultTier)
                    : 1;
                // B465: same guard as the new-item branch above — a SPECIAL-tier line
                // (this customer's contract price) can only be repriced through a
                // genuine documented override (a price change WITH a reason), which is
                // exactly the hole R9 found: typing a value over a stored SPECIAL price
                // was accepted and attributed, but never refused. Fix-round-2 (Opus
                // BLOCK): a price with no reason on a SPECIAL line is REFUSED outright —
                // never silently dropped. A payload that omits overrideReason still
                // counts as documented when the LINE ALREADY carries one (the client is
                // re-saving under its existing reason) — only a line with no reason
                // anywhere, old or new, is refused. Fix-round-3 (Opus BLOCK item 2):
                // scoped to an ACTUAL price change — a carried-over/echoed price equal
                // to what is already stored is not a repricing decision and must never
                // demand a reason, matching the replace-all branch's same guard.
                const lineIsSpecialTier = isSpecialTier(tierForProduct);
                const priceUnchangedFromStored =
                  overridePrice !== null && Math.abs(overridePrice - existingUnitPrice) <= 0.005;
                const storedOverrideReason = (li as any).overrideReason ?? null;
                const hasOverrideReason = !!(
                  (item.overrideReason && item.overrideReason.trim()) ||
                  (storedOverrideReason && String(storedOverrideReason).trim())
                );
                if (
                  overridePrice !== null &&
                  !priceUnchangedFromStored &&
                  lineIsSpecialTier &&
                  !hasOverrideReason
                ) {
                  const priceProduct = li.productId
                    ? await tx.product.findFirst({
                        where: { id: li.productId },
                        select: { name: true },
                      })
                    : null;
                  throw new BadRequestException(
                    `A reason is required to change ${priceProduct?.name ?? "this line"} — it's this customer's special price`,
                  );
                }
                // B465 fix round 4 (Opus BLOCK item 4, LOW): the SAME half-cent
                // tolerance as priceUnchangedFromStored above — a strict `!==` here
                // disagreed with that check on a float-rounding-only difference
                // (e.g. 8.000000001 vs 8), so a price the reason-guard correctly
                // treated as unchanged still got stamped MANUAL/originalPrice/
                // overriddenBy as if the operator had genuinely repriced it.
                const isManualOverride = overridePrice !== null && !priceUnchangedFromStored;
                // B465 fix round 5 (Opus BLOCK item 2, LOW): keyed on
                // isManualOverride, not "a price was sent" — a within-tolerance
                // echo (e.g. 8.004 against a stored 8) is NOT a manual override
                // (round-4's own fix above), so it must persist the EXISTING
                // clean value, never the incoming near-miss float, or repeated
                // saves could drift the stored price by fractions of a cent.
                // roundMoney on the genuine-override branch matches every other
                // money-write path in this file (never store a raw client float).
                const unitPrice = isManualOverride ? roundMoney(overridePrice!) : existingUnitPrice;
                // Anchor the struck-through original to the CATALOG list price (like the
                // replace-all / new-item branches), never the line's prior net price —
                // otherwise re-editing an override (e.g. an upsell nudged down but still
                // above list) would flip its derived upsell/discount direction and show a
                // bogus "was" price to the customer/operator.
                let catalogPrice = existingUnitPrice;
                if (isManualOverride && !isUnlisted && li.productId) {
                  const prod = await tx.product.findFirst({
                    where: { id: li.productId },
                    select: { pricePerUnit: true },
                  });
                  if (prod) catalogPrice = Number(prod.pricePerUnit);
                }
                // This branch keeps the line's stored (agreed) price — it never
                // re-runs applyBestPromotion for the UNIT PRICE, same as every other
                // promo type. The line's BUY_N_GET_M free units, though, are a
                // function of the QUANTITY, so they are RE-DERIVED for the new qty
                // (`rescaleBogoFreeUnits`) and written back: reusing the snapshot
                // verbatim under-billed a shrunk line (12 → 2 boxes billed $0.00) and
                // left the column contradicting the subtotal. A manual price override
                // replaces the promo price outright, so the free units earned under it
                // do not survive — they would discount the operator's own price.
                const storedFreeUnits = Number((li as any).promoFreeUnits ?? 0);
                let promoCategory: string | null = null;
                if (storedFreeUnits > 0 && !isManualOverride && li.productId) {
                  const prod = await tx.product.findFirst({
                    where: { id: li.productId },
                    select: { category: true },
                  });
                  promoCategory = prod?.category ?? null;
                }
                const freeUnits = isManualOverride
                  ? 0
                  : this.rescaleBogoFreeUnits({
                      promos: bogoPromos,
                      productId: li.productId,
                      category: promoCategory,
                      unitPrice,
                      storedFreeUnits,
                      oldUnits: li.boxes != null ? Number(li.boxes) : Number(li.qty),
                      newUnits: boxes != null ? boxes : qty,
                    });
                const subtotal = computeLineSubtotal({
                  unitPrice,
                  qty,
                  boxes,
                  pieces,
                  unitsPerBox: upb,
                  freeUnits,
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
                    // Keep the snapshot and the money consistent (see above).
                    // Untouched on a line that never earned free units, so every
                    // non-BOGO edit writes exactly the same payload as before.
                    ...(freeUnits > 0 || storedFreeUnits > 0
                      ? { promoFreeUnits: freeUnits > 0 ? freeUnits : null }
                      : {}),
                    ...(item.notes !== undefined ? { notes: item.notes } : {}),
                    ...(isManualOverride
                      ? isUnlisted
                        ? // Unlisted lines have no catalog "list price" — a price change is
                          // just the new MANUAL price, no struck-through original.
                          { priceType: PriceType.MANUAL, originalPrice: null }
                        : {
                            priceType: PriceType.MANUAL,
                            originalPrice: catalogPrice,
                            overriddenBy: user?.sub ?? null,
                          }
                      : {}),
                    // F2 server half: independent of isManualOverride/isUnlisted — a
                    // reason-only edit (price unchanged, so isManualOverride is false)
                    // was silently dropped because this field lived inside that branch.
                    // Written whenever the payload carries the key at all, empty string
                    // included, mirroring order-item-diff.ts's client-side fix.
                    // F4 (independent review, PR-2): overriddenBy must move WITH
                    // overrideReason — writing the reason alone left the attribution
                    // stale (whoever last touched the isManualOverride branch, or null),
                    // so an audit/dispute of THIS edit pointed at the wrong operator.
                    // B465 fix round 3 (Opus BLOCK item 3, LOW): a blank incoming
                    // reason that rides along with a GENUINE price change (mobile's
                    // order-item-diff.ts now always sends overrideReason whenever
                    // unitPrice changes) must never silently clear a reason already
                    // on file — fall back to the stored value instead. A reason-only
                    // edit (isManualOverride false — price unchanged) keeps F2's
                    // original contract: an explicit blank there is a deliberate
                    // clear and is written verbatim.
                    // B465 fix round 4 (Opus BLOCK item 3, LOW): `?.trim()` — a
                    // caller sending overrideReason: null explicitly (defined,
                    // not undefined, so this branch runs) would 500 on a bare
                    // `.trim()`; treat null the same as blank.
                    ...(item.overrideReason !== undefined
                      ? {
                          overrideReason:
                            isManualOverride && !item.overrideReason?.trim()
                              ? storedOverrideReason
                              : (item.overrideReason ?? null),
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
        // Staff may set/change the fee on edit; everyone else keeps the stored fee.
        // Reading the STORED fee here is what stops an ordinary item edit from
        // silently zeroing shipping (the fee-wipe regression).
        const isStaffFeeEdit =
          (user?.role === UserRole.OPERATOR || user?.role === UserRole.TENANT_ADMIN) &&
          dto.shippingFee !== undefined;
        const shippingFee = isStaffFeeEdit
          ? roundMoney(Math.max(0, dto.shippingFee!))
          : roundMoney(Number((order as any).shippingFee ?? 0));
        const total = roundMoney(subtotal + tax + categoryTax + shippingFee);

        // B451 gap 4: defense-in-depth — UpdateOrderItemsDto carries no
        // discountAmount today (only create() does), so this path has no
        // live negative-total vector yet, but the shared guard keeps it
        // covered against a future field addition without a second review.
        assertMoneyInvariantsOrThrow({
          subtotal,
          tax: tax + categoryTax,
          shipping: shippingFee,
          total,
        });

        // Returns Inside Order Creation PR-1c (design.md §4/§6.4, M7): a DRIVER edit that
        // drops this order's gross below the credit already issued/held against its own
        // inline returns is refused — a driver could otherwise erase (by editing the sale
        // down) the very goods the driver-cap check measured against. Read AFTER the
        // `Order FOR UPDATE` above (:3587 in the pre-PR-1c line numbering) so it sees every
        // inline return committed before this edit's lock was granted. Staff (OPERATOR/
        // TENANT_ADMIN) edits are NOT capped here — they can also approve/reduce a held
        // return, so they're trusted with the same edit CUSTOMER/system flows already allow.
        if (user?.role === UserRole.DRIVER) {
          const inlineReturnCredit = await sumInlineReturnCredit(tx, orderId);
          if (inlineReturnCredit > 0.001 && total < inlineReturnCredit - 0.001) {
            throw new BadRequestException({
              statusCode: 400,
              code: "ORDER_BELOW_RETURN_CREDIT",
              message:
                `Order total (${total}) cannot drop below the credit already issued/held ` +
                `against its inline returns (${roundMoney(inlineReturnCredit)}).`,
            });
          }
        }

        // P5-08b + WP1 inline guards (completes P5-08 "credit / regulated /
        // stock-violating edit blocked inline"). DRAFT edits are exempt,
        // matching the regulated guard above and create()'s !isDraft stock
        // gate — a draft edit isn't a sale yet (settleStockForEdit also
        // no-ops on DRAFT internally — belt and suspenders for the other call
        // site, which can't reach DRAFT). Order: stock first (more actionable
        // message), then credit. A throw here rolls back the whole
        // transaction, so no stock delta from this settle survives a
        // subsequent credit-limit rejection. Applies on DELIVERED/
        // OUT_FOR_DELIVERY orders too (R1 allows editing them) — a qty
        // increase there means more goods physically went out, symmetric with
        // create()'s decrement at order time.
        if (order.status !== "DRAFT") {
          await this.settleStockForEdit(tx, order, heldItems, activeItems, user);
          await this.assertWithinCreditLimit(
            tx,
            order.customerId,
            orderId,
            // The exact total the order.update below writes — Σ of stored
            // computeLineSubtotal results + regular tax + category tax, cents-
            // rounded. Note: mirrors the existing edit recompute, which
            // (pre-existing) does not subtract Order.discountAmount.
            total,
            creditCheckEnabled,
          );
        }

        // Revert a CONFIRMED order back to PENDING when items are edited so the office
        // must re-confirm the updated pick list before dispatch. R1: scope this to a
        // CONFIRMED order whose run has NOT dispatched — once the run is out (dispatched
        // / OUT_FOR_DELIVERY / DELIVERED) the edit is an in-place correction and a
        // revert to PENDING would rewind the delivery lifecycle. F10-002: a CUSTOMER
        // editing their own (pre-dispatch) CONFIRMED order still forces re-confirmation.
        // DRIVER edits never revert (drivers don't own the pick list).
        const runDispatched = order.routeRun != null && order.routeRun.status !== "SCHEDULED";
        const shouldRevert =
          order.status === "CONFIRMED" && !runDispatched && user?.role !== UserRole.DRIVER;
        const revertNote = shouldRevert
          ? `\n[${new Date().toLocaleDateString()} – items edited, reverted to PENDING]`
          : undefined;

        await tx.order.update({
          where: { id: orderId },
          data: {
            subtotal,
            tax,
            total,
            ...(isStaffFeeEdit ? { shippingFee } : {}),
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
        // B215: the merge's replay key commits in THIS transaction, atomically with the fold —
        // never a second, later commit that a crash or a post-commit throw can split off.
        if (opts?.idempotency) {
          await this.recordMergeIdempotencyKey(tx, orderId, opts.idempotency);
        }
        return { subtotal, tax, total, shouldRevert, shippingFee };
      },
      // Headroom over Prisma's 5s default: the merge branch issues per-line
      // queries inside the transaction (same shape as create()'s in-tx per-line work).
      { timeout: 15_000 },
    );

    // R1b SAFETY (two adversarial-review catches): a PARTIALLY-invoiced order must NOT
    // be auto-resynced — rebuilding its finalized/paid invoice at the full order qty
    // would inflate an already-issued document with units/lines it never billed.
    // "Partial" is CROSS-LINE, not just within a line: it covers both a line billed for
    // only part of its qty (createPartialFromOrder qty subset) AND a subset of LINES
    // billed at full qty while sibling lines are entirely un-invoiced (line subset).
    // So: skip when SOMETHING is invoiced but NOT everything is fully invoiced. The two
    // safe states still proceed — nothing invoiced yet (pure pending-mirror) and every
    // line fully invoiced (safe to expand for a qty increase / added line). Read from
    // the PRE-EDIT snapshot (reliable cumulative invoicedQty — the replace-all edit path
    // resets it to 0 on recreated rows, so a post-mutation read would miss it). When
    // partial, skip the in-place resync entirely; the operator reconciles it manually.
    //
    // B215: computed HERE, never inside reconcileOrderAfterEdit, precisely because it reads
    // the pre-edit snapshot this scope still holds — a replay has no access to it.
    //
    // B215/R2 (round 2): the RULE itself is `shouldSkipInPlaceResync` (merge-idempotency.ts), so
    // the replay path evaluates the same predicate over the rows it can see rather than
    // hard-coding one side of this decision. Only the ROWS differ (pre-edit snapshot here).
    const skipInPlaceResync = postDeliveryEdit
      ? shouldSkipInPlaceResync(order.lineItems ?? [])
      : false;

    // Staff-only credit intents: apply the same role gate as the shipping fee — when the
    // caller is NOT OPERATOR/TENANT_ADMIN, treat dto.appliedCreditNotes as undefined
    // (drivers/customers can't manage credits).
    const isStaffCreditEdit =
      user?.role === UserRole.OPERATOR || user?.role === UserRole.TENANT_ADMIN;

    // B215: the CONVERGENT tail — invoice resync/reconcile + credit sync/settle. Extracted so a
    // REPLAYED merge can re-run exactly this and nothing else (replayMergeReconcile): the fold
    // above runs at most once per key, while everything in here is idempotent and may run N
    // times. The status event and the revision append BELOW stay fold-only.
    await this.reconcileOrderAfterEdit(
      orderId,
      order.customerId,
      isStaffCreditEdit ? dto.appliedCreditNotes : undefined,
      { postDeliveryEdit, skipInPlaceResync },
    );

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
      { subtotal, tax, total, shippingFee },
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
   * B215: the CONVERGENT post-fold tail of an item edit. Exactly what `updateOrderItems` ran
   * after its fold transaction, in the same order: the invoice resync / draft-invoice reconcile
   * choice, then the Serializable credit-note sync + settle. Every step here is idempotent, so
   * this may run N times for ONE fold — which is the point: a replayed merge re-runs it (see
   * `replayMergeReconcile`) instead of leaving the order's invoice and applied credits out of
   * sync forever. The two steps that are NOT convergent — the status event and the
   * `appendOrderRevision` snapshot — deliberately stay in `updateOrderItems`.
   *
   * `appliedCreditNotes === undefined` means "DO NOT call syncOrderCreditSelections at all — leave
   * the stored selection exactly as it is": a non-staff caller, a request that sent no selection,
   * or (B215/R1, round 2) an UNVERIFIED replay, whose body is not provably the cart the fold
   * applied and therefore must not re-point this order's credits. The settle still runs in every
   * case, since credits are payment-level and settling is convergent. The skip is explicit here
   * (the `!== undefined` guard below) rather than delegated to `syncOrderCreditSelections`'s own
   * `undefined` early-return, so the contract is readable at the call site that depends on it.
   *
   * `routing` is passed in rather than derived here: `skipInPlaceResync` depends on which line
   * rows the caller can see (the fold holds the PRE-EDIT snapshot; a replay has only current
   * rows), even though the RULE is shared — `shouldSkipInPlaceResync` in merge-idempotency.ts.
   */
  private async reconcileOrderAfterEdit(
    orderId: string,
    customerId: string,
    appliedCreditNotes: AppliedCreditNoteDto[] | undefined,
    routing: { postDeliveryEdit: boolean; skipInPlaceResync: boolean },
  ): Promise<void> {
    // Keep the order's linked invoice(s) in lockstep with the edit.
    //  - Undelivered edit: re-sync the open pending-mirror draft at order basis
    //    (no-op when there's no open draft) — unchanged.
    //  - Post-delivery edit (R1): the order may carry SENT / PAID / delivery-batch
    //    invoices, not just an open draft. Rebuild each in place from the edited
    //    lines at order basis, KEEP payments, recompute status/balance, and re-sync
    //    the regulated ledger — so the invoice tracks the correction and simply shows
    //    the new balance. Never blocks (bails on an unclean partition).
    if (routing.postDeliveryEdit) {
      if (!routing.skipInPlaceResync) {
        await this.invoicesService.resyncOrderInvoicesForEdit(orderId);
      }
    } else {
      await this.invoicesService.reconcileOrderDraftInvoice(orderId, { basis: "order" });
    }

    // Credit-note intents: sync operator selection changes, then settle (shrink or
    // top-up) against the order's current invoices. Runs even when line-resync was
    // skipped for partial billing — the credits are payment-level, not line-level.
    await this.prisma.tenantTransaction(
      async (tx) => {
        // EXPLICIT skip: `undefined` means "never touch the stored selection" (see the doc
        // comment) — an unverified replay lands here and must not re-point this order's credits.
        if (appliedCreditNotes !== undefined) {
          await this.creditNotes.syncOrderCreditSelections(
            tx,
            orderId,
            customerId,
            appliedCreditNotes,
          );
        }
        await this.creditNotes.settleOrderCreditsInTx(tx, orderId);
      },
      { isolationLevel: "Serializable" },
    );
  }

  /**
   * B215: re-run the convergent tail above for a merge that was REPLAYED rather than folded.
   *
   * The replay key now commits inside the fold's own transaction, so a retry that arrives after
   * the fold committed but before (or during) the tail is answered by the replay lookup and
   * returns immediately — leaving the order's linked invoice and applied credits permanently
   * unreconciled unless the replay re-runs this. Invariant: the fold runs AT MOST ONCE per key;
   * this reconcile is idempotent and may run on every replay. Called by the controller's merge
   * branch on its `replayed: true` path, still inside the customer advisory lock.
   *
   * Tenant guard mirrors `findOrderIdByIdempotencyKey`: `forTenant()` hands back the UNSCOPED
   * client for a session with no tenant, so refuse before any read.
   *
   * B215/R2 (round 2): a POST-DELIVERY replay either reconciles or REFUSES LOUDLY — it never
   * silently skips the invoice work (the previous unconditional `skipInPlaceResync: true` left a
   * dispatched order's finalized invoice permanently out of step with the merged lines). The
   * partial-billing rule is re-evaluated over the CURRENT lines with the fold's own predicate
   * (`shouldSkipInPlaceResync`); only the case where those rows genuinely cannot carry the answer
   * throws 409 `IDEMPOTENCY_REPLAY_NEEDS_RECONCILE`.
   */
  async replayMergeReconcile(
    orderId: string,
    customerId: string,
    appliedCreditNotes: AppliedCreditNoteDto[] | undefined,
  ): Promise<void> {
    if (!this.prisma.getTenantId()) {
      this.logger.warn(`replay reconcile refused: no tenant scope order=${orderId}`);
      throw new ForbiddenException("Replay reconcile requires a tenant-scoped session");
    }
    // Customer-scoped, so a replay can never reconcile another customer's order.
    const order = await this.prisma.forTenant().order.findFirst({
      where: { id: orderId, customerId },
      select: {
        status: true,
        lineItems: { select: { qty: true, invoicedQty: true } },
      },
    });
    if (!order) {
      this.logger.warn(`replay reconcile skipped: order not found order=${orderId}`);
      return;
    }
    // Derived from the CURRENT status, which is provably the same routing the fold used: the
    // only status the fold itself changes is CONFIRMED -> PENDING, and both are outside
    // POST_DELIVERY_EDIT_STATUSES.
    const postDeliveryEdit = POST_DELIVERY_EDIT_STATUSES.includes(order.status);
    let skipInPlaceResync = false;
    if (postDeliveryEdit) {
      // Same BILLABLE filter the predicate itself applies (`shouldSkipInPlaceResync`,
      // merge-idempotency.ts): a zero-qty row cannot carry the partial-billing answer, so it must
      // not make this gate read as "invoiced" either — otherwise the two disagree on exactly the
      // rows that decide the branch.
      const lines = (order.lineItems ?? []).filter((li) => Number(li.qty ?? 0) > 0.001);
      const anyInvoiced = lines.some((li) => Number(li.invoicedQty ?? 0) > 0.001);
      if (anyInvoiced) {
        // The cumulative `invoicedQty` survived on these rows (an incremental edit, or a
        // re-stamp by a later invoice sync), so the fold's own predicate answers over the
        // current lines: resync when the order is wholly invoiced, skip when partially.
        skipInPlaceResync = shouldSkipInPlaceResync(lines);
      } else {
        // Nothing shows as invoiced. Two indistinguishable states produce that:
        //   (a) the order genuinely has nothing billed — then `resyncOrderInvoicesForEdit` is a
        //       provable no-op (it returns null when the order has no non-VOID invoice), and the
        //       fold's guard would also have been false, so routing the resync is faithful; or
        //   (b) the replace-all fold RESET `invoicedQty` to 0 on every recreated row, erasing the
        //       pre-edit cumulative billing the guard reads — in which case partial vs wholly
        //       invoiced is unknowable from current state, and BOTH branches are unsafe (a resync
        //       could expand an already-issued invoice to units it never billed; a skip leaves the
        //       finalized invoice out of step with the merge forever).
        // A surviving non-VOID invoice is what separates them: (a) has none.
        const invoiceCount = await this.prisma
          .forTenant()
          .invoice.count({ where: { orderId, status: { not: InvoiceStatus.VOID } } });
        if (invoiceCount > 0) {
          this.logger.warn(
            `replay reconcile cannot reproduce the partial-billing guard: refusing ` +
              `tenant=${this.prisma.getTenantId()} customer=${customerId} order=${orderId} ` +
              `status=${order.status} invoices=${invoiceCount}`,
          );
          throw new ConflictException({
            code: IDEMPOTENCY_REPLAY_NEEDS_RECONCILE,
            orderId,
            message:
              "This order was already submitted and later dispatched; open it to reconcile its invoice",
          });
        }
      }
    }
    await this.reconcileOrderAfterEdit(orderId, customerId, appliedCreditNotes, {
      postDeliveryEdit,
      skipInPlaceResync,
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
    totals: { subtotal: number; tax: number; total: number; shippingFee?: number },
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
      shippingFee: totals.shippingFee ?? 0,
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
   * B283: the ONE stock-decrement code path for turning a set of order lines
   * into a real (non-draft) sale — locks the touched product rows FOR UPDATE,
   * blocks (customer/driver) or warns (staff) on insufficient stock, then
   * applies ONE aggregated UPDATE. Extracted out of create()'s non-draft
   * branch so changeStatus()'s DRAFT→PENDING promotion (the same "becomes a
   * real sale" moment) calls the IDENTICAL logic instead of a second
   * implementation — see REG-B283. Must be called from inside the caller's
   * transaction (the FOR UPDATE lock is only meaningful there).
   */
  private async decrementStockForSale(
    tx: any,
    stockLines: Array<{ productId: string; qty: number }>,
    isStaffRole: boolean,
  ): Promise<void> {
    if (stockLines.length === 0) return;
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
      const p = lockedProducts.find((lp: any) => lp.id === li.productId);
      if (p && Number(p.currentStock) < li.qty) {
        oosItems.push(
          `${p.name ?? li.productId} (available: ${Number(p.currentStock)}, requested: ${li.qty})`,
        );
      }
    }
    if (oosItems.length > 0) {
      if (isStaffRole) {
        this.logger.warn(`Operator-initiated order will go below stock: ${oosItems.join("; ")}`);
      } else {
        throw new ConflictException(`Insufficient stock: ${oosItems.join("; ")}`);
      }
    }

    // Decrement stock atomically while the lock is held. For operator-initiated
    // overselling, this lets currentStock go negative — the inventory page can
    // surface that and the operator can reconcile after restock.
    //
    // B116 (REG-B116): ONE aggregated, set-based UPDATE instead of a per-line
    // ORM call — a per-line write ordering is why multiple lines for the same
    // product used to touch it twice instead of once. Aggregate first:
    // `UPDATE … FROM (VALUES …)` applies at most one row per join key, so
    // summing qty per product BEFORE the statement is load-bearing.
    //
    // Raw SQL bypasses the tenant proxy that scoped the ORM call it replaces,
    // so the tenant predicate is re-stated explicitly here — a cross-tenant
    // productId must not be able to move another tenant's stock. Null
    // tenantId (SUPER_ADMIN context) keeps the unscoped behaviour the ORM
    // call had in that same context.
    const stockTenantId = this.prisma.getTenantId();
    const qtyByProduct = new Map<string, number>();
    for (const li of stockLines) {
      qtyByProduct.set(li.productId, (qtyByProduct.get(li.productId) ?? 0) + li.qty);
    }
    const stockValues = Prisma.join(
      [...qtyByProduct.entries()].map(
        ([productId, qty]) => Prisma.sql`(${productId}::text, ${qty}::numeric)`,
      ),
    );
    await tx.$executeRaw`
      UPDATE "Product" AS p
      SET "currentStock" = p."currentStock" - v.qty
      FROM (VALUES ${stockValues}) AS v(id, qty)
      WHERE p.id = v.id
        ${stockTenantId ? Prisma.sql`AND p."tenantId" = ${stockTenantId}` : Prisma.empty}
    `;
  }

  /**
   * P5-08b + WP1 stock settle — validates the delta between the order's
   * pre-edit line set and the edited (post-edit) active line set, THEN
   * applies it to `Product.currentStock`.
   *
   * Lifecycle (why delta, not absolute): create() already decremented
   * Product.currentStock for every non-draft line under a row lock (RF-017,
   * create() ~line 1850-1902), so the order's existing lines are already "out
   * of" currentStock. NOTHING ELSE decrements for delivery — completeStop
   * writes no stock and InventoryService.recordSale has no caller — so
   * `currentStock` is settled at order time and re-settled here on edit, and
   * nowhere else. An edit therefore only needs to settle the
   * CHANGE against what the order already holds:
   *   - a product whose requested qty EXCEEDS its held qty needs the increase
   *     validated against currentStock (same guard as before), then that
   *     increase decremented;
   *   - a product whose requested qty is LESS than held (line reduced,
   *     removed, or zeroed) returns the difference to currentStock, CLAMPED
   *     to the undelivered remainder (`held − deliveredQty`) — delivered
   *     goods are gone and never come back via an edit. This is new; the
   *     pre-refactor version only validated increases, it never wrote
   *     anything.
   * Held/requested are compared over the UNION of product ids on both sides
   * (not just `requested`'s keys) so a product that disappears from the
   * edited set entirely (line removed) still gets its stock credited back.
   * A product with a ZERO delta (unchanged line) never enters the delta map
   * at all — no lock, no read, no write for it (see the DELTA_MAP short
   * circuit below), which is also why a same-qty edit never re-queries stock.
   *
   * Role semantics mirror create(): CUSTOMER/DRIVER hard-block (409
   * INSUFFICIENT_STOCK) with NO write on a violation; everyone else
   * (operator/admin/undefined = internal caller) may knowingly oversell —
   * warn-only log, and then (unlike the old validate-only guard) the write
   * still proceeds, matching create()'s oversell-writes-anyway posture.
   * Quantities compare in each line's own stored denomination (pieces for
   * box-split lines, selling units otherwise) — the same mixed-denomination
   * convention create() uses against currentStock.
   *
   * `SELECT ... FOR UPDATE` locks the touched product rows FIRST, before
   * reading currentStock — mirroring create()'s lock (:1863-1867). The old
   * validate-only assert read unlocked because it reserved nothing; now that
   * this method WRITES currentStock, the lock is load-bearing (closes the
   * same concurrent-oversell race create() closes). No StockMovement rows are
   * written — matches create(), which tracks currentStock only.
   *
   * Applies to DELIVERED/OUT_FOR_DELIVERY orders too: a qty increase on an
   * already-dispatched order means more goods physically went out the door,
   * symmetric with create() decrementing at order time.
   *
   * Skips ENTIRELY — no validation, no write, no query — when
   * `order.status === "DRAFT"`: creation never decremented stock for a draft,
   * so an edit of one must not either.
   *
   * Unknown/missing product rows and non-numeric quantities fail OPEN (skip)
   * for VALIDATION only — same posture as create()'s `if (p && ...)`; the
   * write still applies for every non-zero delta regardless (mirrors
   * create()'s unconditional decrement loop).
   *
   * `heldItems` is the pre-edit line set and MUST be read INSIDE the caller's
   * transaction, after that transaction has locked the order row
   * (`SELECT id FROM "Order" … FOR UPDATE`) and BEFORE it writes any
   * orderItem. Reading it from a pre-transaction `order.lineItems` snapshot
   * made the delta stale under a concurrent edit of the same order (web PATCH
   * racing an at-door approve), which settles a wrong-MAGNITUDE stock write —
   * far worse than a lost update, because the error persists in inventory.
   */
  private async settleStockForEdit(
    db: any,
    order: { id: string; status: string },
    heldItems: Array<{ productId: string | null; qty: any; deliveredQty?: any; status?: string }>,
    finalActiveItems: Array<{ productId: string | null; qty: any }>,
    user?: JwtPayload,
  ): Promise<void> {
    if (order.status === "DRAFT") return;

    // Qty the order already holds per product (pre-edit, non-cancelled lines),
    // plus — over the SAME line set — how much of it has already gone out the
    // door. Delivered goods are physically gone: an edit that shrinks or drops
    // a delivered line must NOT put them back on the shelf. This mirrors the
    // at-door precedent, where a CHANGE_QTY/REMOVE_ITEM request against a line
    // with deliveredQty > 0 is refused outright (LINE_ALREADY_DELIVERED,
    // ~:4205) — the operator edit path allows the edit but credits back only
    // the UNDELIVERED remainder.
    const held = new Map<string, number>();
    const deliveredHeld = new Map<string, number>();
    for (const li of heldItems ?? []) {
      if (li.productId && li.status !== "CANCELLED") {
        held.set(li.productId, (held.get(li.productId) ?? 0) + Number(li.qty));
        deliveredHeld.set(
          li.productId,
          (deliveredHeld.get(li.productId) ?? 0) + Number(li.deliveredQty ?? 0),
        );
      }
    }
    // Qty the edit requests per product (post-edit active line set).
    const requested = new Map<string, number>();
    for (const li of finalActiveItems) {
      if (li.productId) {
        requested.set(li.productId, (requested.get(li.productId) ?? 0) + Number(li.qty));
      }
    }

    // Delta per product over the UNION of both sides — a product present only
    // in `held` (its line was removed/zeroed in the edit) still gets an entry
    // here (delta = 0 − held < 0) so its stock is returned. Zero-delta
    // products (untouched lines) are dropped, so they never trigger a lock, a
    // stock read, or a write (DELTA_MAP short circuit).
    // Qty is Decimal(10,3): subtracting two float-converted Decimals leaves
    // binary residue (36 − 12.1 = 23.900000000000002), which `!== 0` reads as
    // a real delta and would write a phantom 1e-15 stock adjustment. Round to
    // the column's 3 decimals BEFORE the zero check, and write the ROUNDED
    // value.
    const deltas = new Map<string, number>();
    for (const productId of new Set([...held.keys(), ...requested.keys()])) {
      const raw = (requested.get(productId) ?? 0) - (held.get(productId) ?? 0);
      const delta = Math.round(raw * 1000) / 1000;
      if (delta !== 0) deltas.set(productId, delta);
    }
    if (deltas.size === 0) return;

    const productIds = [...deltas.keys()];
    // RF-017 parity: lock the touched product rows BEFORE reading
    // currentStock, mirroring create()'s lock (:1863-1867).
    await db.$executeRaw`
      SELECT id FROM "Product"
      WHERE id IN (${Prisma.join(productIds)})
      FOR UPDATE
    `;
    const products = await db.product.findMany({
      where: { id: { in: productIds } },
      select: { id: true, name: true, currentStock: true },
    });

    const increases = [...deltas.entries()]
      .filter(([, delta]) => delta > 0)
      .map(([productId, delta]) => ({
        productId,
        requested: requested.get(productId) ?? 0,
        delta,
      }));

    if (increases.length > 0) {
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
      if (violations.length > 0) {
        if (user?.role !== UserRole.CUSTOMER && user?.role !== UserRole.DRIVER) {
          // Operators/admins may oversell — matches create()'s warn-only path.
          // Unlike the old validate-only guard, this does NOT return: the
          // write below still applies so the oversell lands in currentStock,
          // exactly like create()'s oversell write.
          this.logger.warn(
            `Operator edit of order ${order.id} will go below stock: ` +
              violations
                .map((v) => `${v.name} (available: ${v.available}, requested increase: ${v.delta})`)
                .join("; "),
          );
        } else {
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
      }
    }

    // Apply: an increase decrements currentStock by the delta; a
    // decrease/removal increments back only the UNDELIVERED portion of what
    // the order held. Delivered goods never come back through an edit — the
    // at-door path makes the same call by refusing the change outright
    // (LINE_ALREADY_DELIVERED, ~:4205); crediting a delivered line's full qty
    // would invent inventory that physically left the warehouse. Cap =
    // max(0, held − deliveredHeld); a fully-delivered line's cap is 0, so it
    // is skipped entirely (no write at all). No StockMovement rows — matches
    // create(), which tracks currentStock only.
    for (const [productId, delta] of deltas) {
      if (delta > 0) {
        await db.product.update({
          where: { id: productId },
          data: { currentStock: { decrement: delta } },
        });
        continue;
      }
      const undelivered = Math.max(
        0,
        (held.get(productId) ?? 0) - (deliveredHeld.get(productId) ?? 0),
      );
      const credit = Math.min(-delta, undelivered);
      if (credit <= 0) continue;
      await db.product.update({
        where: { id: productId },
        data: { currentStock: { increment: credit } },
      });
    }
  }

  /**
   * WP3: resolves whether the credit-limit check applies to this tenant.
   *
   * MUST be called BEFORE opening an interactive transaction (pool-starvation
   * guard, :1660-1672): EntitlementsService reads the tenant row on its OWN
   * pooled connection, so a cache miss inside an open tx would check out a
   * second connection while the first is held — N concurrent edits on a cold
   * cache then deadlock the pool (P2024) and every edit rolls back.
   *
   * Both fallbacks resolve to TRUE (run the check) because the legacy,
   * pre-flag behavior is that the check ALWAYS runs, and assertWithinCreditLimit
   * throws inside the order-edit transaction: a catalog/DB hiccup must degrade
   * to the money guard staying ON, never to a rolled-back edit reporting a
   * billing-catalog error. (PlanFlagGuard fails CLOSED instead — it can deny a
   * request cleanly; this call site cannot.)
   */
  private async isCreditLimitCheckEnabled(): Promise<boolean> {
    // Release toggle (REMOVE by 2026-10-01): plan-flag enforcement ships dark.
    // "on" = enforce; anything else = legacy behavior (always check).
    if ((process.env.PLAN_FLAG_ENFORCEMENT ?? "off") !== "on") return true;
    const tenantId = this.prisma.getTenantId();
    if (!tenantId) return true;
    try {
      return await this.entitlements.hasFlag(tenantId, "flag.credit_limits");
    } catch (err) {
      this.logger.error(
        `Entitlement resolution failed for tenant ${tenantId}; running the credit check (legacy)`,
        err as Error,
      );
      return true;
    }
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
   *
   * flag.credit_limits gates the CHECK itself, not customer CRUD — an
   * unflagged tenant's stored creditLimit values persist but are inert. Same
   * PLAN_FLAG_ENFORCEMENT kill switch as PlanFlagGuard (see plan-flag.guard.ts):
   * legacy behavior (kill switch off) is that this check ALWAYS runs, so the
   * off-path must keep running it, not skip it. The decision is resolved by
   * isCreditLimitCheckEnabled OUTSIDE the transaction and passed in — this
   * method issues NO query on the non-transactional client.
   */
  private async assertWithinCreditLimit(
    db: any,
    customerId: string,
    currentOrderId: string,
    projectedOrderTotal: number,
    creditCheckEnabled: boolean,
  ): Promise<void> {
    if (!creditCheckEnabled) return;

    const customer = await db.customer.findFirst({
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
    // PR-2 review (routeflow-Lead, 2026-09-16): reverted the earlier sumConfirmed
    // conversion here — it silently changed credit-limit behavior (a DRAFT
    // bank-import row would start producing a 409 CREDIT_LIMIT_EXCEEDED) with no
    // sign-off. That behavior change is a real, separate decision out of PR-2's
    // scope; flagged to the owner as a follow-up rather than made silently.
    // Master's not-void basis kept as-is.
    const invoiceExposure = openInvoices.reduce(
      (sum: number, inv: any) =>
        sum +
        (Number(inv.total) -
          // scan-ok: draft-payment-not-void — see comment above.
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
      await this.isCreditLimitCheckEnabled(),
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
      const prod = await this.prisma.forTenant().product.findFirst({
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

    // P5-08b posture: reference reads on separate pooled connections are
    // hoisted BEFORE the interactive tx (pool-starvation guard, :1660-1672).
    const taxRate = await this.getTaxRate();
    // Also loaded for a qty change when a line carries a BUY_N_GET_M snapshot —
    // the door edit re-derives that line's free units for the new quantity.
    const buyerPromos =
      cr.type === ChangeRequestType.ADD_ITEM ||
      (order.lineItems ?? []).some((li: any) => Number(li.promoFreeUnits ?? 0) > 0)
        ? await this.loadActivePromotions(UserRole.CUSTOMER)
        : [];
    const priceHistory =
      cr.type === ChangeRequestType.ADD_ITEM
        ? await this.getCustomerPriceHistory(order.customerId)
        : {};
    // WP3: hoisted for the same reason — the credit guard below runs inside the tx.
    const creditCheckEnabled = await this.isCreditLimitCheckEnabled();

    const { subtotal, tax, total, shippingFee } = await this.prisma.tenantTransaction(
      async (tx: any) => {
        // WP1/F2: same in-transaction snapshot as updateOrderItems — lock the
        // order row so a concurrent web PATCH of this order serializes behind
        // (or ahead of) this at-door merge, then read the pre-edit lines
        // inside the tx. `order` above was fetched before the tx opened; its
        // lineItems drive the stock delta and would otherwise be stale.
        await tx.$executeRaw`SELECT id FROM "Order" WHERE id = ${order.id} FOR UPDATE`;

        // B135 (REG-B135): the ORDER is locked first (above), then the stop — and this tx NEVER
        // waits on a stop row. Order→stop is the acquisition order the rest of the repo already
        // uses (reopenStop, routes.service.ts: order.update then routeRunStop.update; the
        // customers.service merge and purge paths: order writes then routeRunStop writes), so
        // taking a blocking stop lock first would invert it and could deadlock (40P01). NOWAIT
        // means the Order row is this tx's only blocking acquisition — the only way it could
        // close a cycle with the stop→order writers (completeWithPayment / completeStop, which
        // write the stop then the orders) is gone. NO KEY UPDATE, not FOR UPDATE, so a
        // transaction merely holding an FK KEY SHARE on the stop (a DeliveryMutation insert) does
        // not trip it, while a stop completion's own UPDATE does: an in-flight completion
        // surfaces as an immediate 409 instead of merging an edit into a delivered order, and a
        // committed one is still caught by the `live` re-read below.
        // The refusal is CONCURRENT_UPDATE, not CHANGE_WINDOW_CLOSED: the stop is merely BUSY for
        // this instant, so presenting it as a terminal "the window has closed" sent the resolver
        // away from an edit that would succeed on a retry a second later.
        if (order.routeRunStopId) {
          await lockRowsNoWait(tx, "RouteRunStop", [order.routeRunStopId], "STOP_BUSY");
        }

        // B135 (REG-B135): the window guards above ran on a pre-tx snapshot. Re-assert them on
        // the row we now hold locked — a stop completed (completeWithPayment) between that read
        // and this lock must refuse, never merge into a delivered order. `select` (not include)
        // with routeRunStop: the unit tests key the in-tx re-read on that shape.
        const live = await tx.order.findUnique({
          where: { id: order.id },
          select: {
            tenantId: true,
            status: true,
            // Money input to the total below — read here, under the Order FOR UPDATE lock, so a
            // shipping-fee edit that landed after the pre-tx snapshot is not billed away.
            shippingFee: true,
            routeRun: { select: { status: true } },
            routeRunStop: { select: { status: true } },
          },
        });
        if (!live) throw new NotFoundException("Order not found");
        if (!["PENDING", "CONFIRMED", "OUT_FOR_DELIVERY"].includes(live.status)) {
          throw new ConflictException({ code: "CHANGE_WINDOW_CLOSED", reason: "ORDER_STATUS" });
        }
        if (live.routeRun == null || live.routeRun.status !== "IN_PROGRESS") {
          throw new ConflictException({ code: "CHANGE_WINDOW_CLOSED", reason: "RUN_NOT_ACTIVE" });
        }
        if (
          live.routeRunStop != null &&
          ["COMPLETED", "SKIPPED"].includes(live.routeRunStop.status)
        ) {
          throw new ConflictException({ code: "STOP_ALREADY_COMPLETED" });
        }

        // B134 (REG-B134): auto-revert a SENT pending-mirror invoice to DRAFT INSIDE the merge tx
        // (plain queries, no nested tx), so any later throw here — lost claim, stock, credit —
        // rolls the un-send back with the merge. Before the claim: a payments-throw aborts
        // before any mutation. Throws if it carries payments (money never detaches).
        // `lockRows`: the un-send's payment count is read under the same Invoice row lock
        // recordPayment takes, so a payment can't land between that count and the DRAFT flip.
        await this.invoicesService.revertLinkedInvoicesForOrderEdit(order.id, tx, {
          lockRows: true,
        });

        const heldItems = await tx.orderItem.findMany({
          where: { orderId: order.id },
          select: { id: true, productId: true, qty: true, deliveredQty: true, status: true },
        });

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
          // B135 (REG-B135): judge cancel/delivery — AND price — on the LOCKED in-tx row, not the
          // pre-tx snapshot; the snapshot is the fallback only when the held read has no such row.
          const held = heldItems.find((h: any) => h.id === targetId);
          if (!li || li.status === "CANCELLED" || held?.status === "CANCELLED") {
            throw new BadRequestException("Order line not found or already cancelled");
          }
          if (Number((held ?? li).deliveredQty ?? 0) > 0) {
            throw new ConflictException({ code: "LINE_ALREADY_DELIVERED" });
          }
          // `heldItems` is a narrow select (status/qty/deliveredQty), so the money fields come
          // from a full re-read of the same locked row — the ADD_ITEM idiom below. `src` is what
          // every priced input is taken from; `li` (the pre-tx snapshot) survives only as the
          // fallback for a line the held read never saw.
          const liveLine = held ? await tx.orderItem.findUnique({ where: { id: targetId } }) : null;
          if (held && !liveLine) {
            // Defensive, and deliberately FAIL CLOSED: a row held under the Order lock cannot
            // vanish inside this same tx, so a null re-read means the lock did not hold — never
            // a licence to price the edit off the stale snapshot.
            throw new ConflictException({
              code: "CONCURRENT_UPDATE",
              reason: "LINE_VANISHED",
              retryable: true,
              message: "Another update changed this order line. Try again.",
            });
          }
          const src: any = liveLine ?? li;
          if (cr.type === ChangeRequestType.REMOVE_ITEM) {
            // CANCEL semantics, never hard-delete post-dispatch — a mirror
            // invoice line may reference it (mirrors updateOrderItems :2003-2007).
            await tx.orderItem.update({
              where: { id: li.id },
              data: {
                status: "CANCELLED",
                qty: 0,
                subtotal: 0,
                boxes: null,
                pieces: null,
                // A zeroed line has no free units left to show against it.
                promoFreeUnits: null,
              },
            });
            mutationRow = {
              orderItemId: li.id,
              productId: li.productId,
              qty: -Number(src.qty),
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
            let upb = Number(src.unitsPerBox ?? 0);
            if (upb === 0 && li.productId && src.boxes != null) {
              const p = await tx.product.findFirst({
                where: { id: li.productId },
                select: { unitsPerBox: true },
              });
              upb = Number(p?.unitsPerBox ?? 0);
            }
            const wasBoxSplit = src.boxes != null;
            const split =
              wasBoxSplit && upb > 1
                ? normalizeBoxesPieces({ qty: newQty, unitsPerBox: upb })
                : { qty: newQty, boxes: null as number | null, pieces: null as number | null };
            const unitPrice = Number(src.unitPrice);
            // Agreed price wins (never re-runs applyBestPromotion for the unit
            // price), but BUY_N_GET_M free units are a function of the QUANTITY —
            // re-derive them for the new qty and write them back. Re-applying the
            // snapshot verbatim billed a 12 → 2 box door edit at $0.00.
            const storedFreeUnits = Number(src.promoFreeUnits ?? 0);
            let promoCategory: string | null = null;
            if (storedFreeUnits > 0 && li.productId) {
              const prod = await tx.product.findFirst({
                where: { id: li.productId },
                select: { category: true },
              });
              promoCategory = prod?.category ?? null;
            }
            const freeUnits = this.rescaleBogoFreeUnits({
              promos: buyerPromos,
              productId: li.productId,
              category: promoCategory,
              unitPrice,
              storedFreeUnits,
              oldUnits: src.boxes != null ? Number(src.boxes) : Number(src.qty),
              newUnits: split.boxes != null ? split.boxes : split.qty,
            });
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
                  freeUnits,
                }),
                // Keep the snapshot and the money consistent; untouched on a line
                // that never earned free units.
                ...(freeUnits > 0 || storedFreeUnits > 0
                  ? { promoFreeUnits: freeUnits > 0 ? freeUnits : null }
                  : {}),
              },
            });
            mutationRow = {
              orderItemId: li.id,
              productId: li.productId,
              qty: split.qty - Number(src.qty),
              note: `Qty ${Number(src.qty)} -> ${split.qty} via approved change request ${cr.id}`,
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

          // B135 (REG-B135): pick the merge target from the row held under the Order FOR UPDATE
          // lock, then read its authoritative qty/price through the tx — the pre-tx snapshot can
          // name a line a concurrent edit has since cancelled, delivered or re-quantified.
          const heldMatch = heldItems.find(
            (h: any) =>
              h.productId === product.id &&
              h.status !== "CANCELLED" &&
              Number(h.deliveredQty) === 0,
          );
          const existing = heldMatch
            ? await tx.orderItem.findUnique({ where: { id: heldMatch.id } })
            : null;
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
            // Agreed price wins (never re-runs applyBestPromotion for the unit
            // price) — but the bigger quantity earns its OWN free units, so they
            // are re-derived here, same as the CHANGE_QTY branch above.
            const storedFreeUnits = Number((existing as any).promoFreeUnits ?? 0);
            const freeUnits = this.rescaleBogoFreeUnits({
              promos: buyerPromos,
              productId: product.id,
              category: product.category ?? null,
              unitPrice,
              storedFreeUnits,
              oldUnits: existing.boxes != null ? Number(existing.boxes) : Number(existing.qty),
              newUnits: split.boxes != null ? split.boxes : split.qty,
            });
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
                  freeUnits,
                }),
                // Keep the snapshot and the money consistent; untouched on a line
                // that never earned free units.
                ...(freeUnits > 0 || storedFreeUnits > 0
                  ? { promoFreeUnits: freeUnits > 0 ? freeUnits : null }
                  : {}),
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
                await tx.customer.findFirst({
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
                  qty: addQty,
                  unitsPerBox: upb,
                })
              : { qty: addQty, boxes: null as number | null, pieces: null as number | null };
            const qtyPieces = split.boxes != null ? split.qty : upb > 1 ? addQty * upb : addQty;
            // BUY_N_GET_M threshold: whole SELLING units — mirrors create()/the buyer
            // edit branch's qtyUnits derivation.
            const qtyUnits = split.boxes != null ? split.boxes : split.qty;
            const priced = this.resolveBuyerLinePrice(
              product,
              cp?.pricingTier ?? buyerTier,
              buyerPromos,
              qtyPieces,
              qtyUnits,
              priceHistory[product.id]?.lastPrice ?? null,
              // REG-B109: the exact denomination this line bills with below.
              { boxes: split.boxes, pieces: split.pieces, unitsPerBox: upb },
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
                // BUY_N_GET_M sale-time snapshot; null for every other line.
                promoFreeUnits: priced.freeUnits > 0 ? priced.freeUnits : null,
                subtotal: computeLineSubtotal({
                  unitPrice: priced.unitPrice,
                  qty: split.qty,
                  boxes: split.boxes,
                  pieces: split.pieces,
                  unitsPerBox: upb,
                  freeUnits: priced.freeUnits,
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
        const shippingFee = Number((live as any).shippingFee ?? 0);
        const total = roundMoney(subtotal + tax + categoryTax + shippingFee);

        // ── G6: stock + credit guards RE-RUN inside the tx (:2175-2187).
        // A throw rolls back the claim AND the merge. Resolver role drives the
        // stock guard's block/warn semantics (DRIVER hard-blocks; operators
        // warn-only, matching create()/edit posture). Credit blocks all roles.
        // WP1: this now also SETTLES the delta into currentStock (order.status
        // is always PENDING/CONFIRMED/OUT_FOR_DELIVERY here — see the
        // CHANGE_WINDOW_CLOSED guard above — so settleStockForEdit's internal
        // DRAFT no-op never triggers on this call site).
        await this.settleStockForEdit(tx, order, heldItems, activeItems, resolver);
        await this.assertWithinCreditLimit(
          tx,
          order.customerId,
          order.id,
          total,
          creditCheckEnabled,
        );

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
        // shippingFee rides out of the tx (updateOrderItems :4284 idiom) so the post-commit
        // revision snapshots the value the total was actually built from.
        return { subtotal, tax, total, shippingFee };
      },
      { timeout: 15_000 },
    );

    // Post-commit, mirrors updateOrderItems :2222-2246: mirror draft invoice in
    // lockstep + immutable revision. Never a new money formula.
    await this.invoicesService.reconcileOrderDraftInvoice(order.id, { basis: "order" });
    await this.appendOrderRevision(
      order.id,
      resolver,
      { subtotal, tax, total, shippingFee },
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
      .order.findFirst({ where: { id: orderId }, select: { id: true, shippedAt: true } });
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

  /**
   * Ad-hoc trips + fulfillment mode: change an order's fulfillment path
   * (ROUTE ↔ SHIP) while it's still open. Locked once the order has left the
   * "open" states — a shipped/delivered/cancelled order's fulfillment history
   * shouldn't move out from under its trip/shipment records after the fact —
   * and locked toward SHIP while the order sits on a live run.
   */
  async updateFulfillPath(orderId: string, dto: UpdateFulfillPathDto, _user?: JwtPayload) {
    // `findFirst`, NOT `findUnique`: forTenant()'s findUnique can only POST-filter
    // on the returned row's `tenantId`, and an exclusive `select` that omits it
    // silently disables that check — which would leak another tenant's order
    // status and driver name through the 400 messages below. findFirst gets
    // `tenantId` injected into the `where`, so a foreign id simply 404s here.
    const order = await this.prisma.forTenant().order.findFirst({
      where: { id: orderId },
      select: {
        id: true,
        status: true,
        routeRunStopId: true,
        routeRunStop: {
          select: {
            routeRun: { select: { status: true, driver: { select: { contactName: true } } } },
          },
        },
      },
    });
    if (!order) throw new NotFoundException("Order not found");
    if (
      order.status === OrderStatus.OUT_FOR_DELIVERY ||
      order.status === OrderStatus.DELIVERED ||
      order.status === OrderStatus.CANCELLED
    ) {
      throw new BadRequestException("Fulfillment path can only be changed while the order is open");
    }
    // Status alone isn't enough: the dispatch sweep attaches orders to a run
    // while they're still CONFIRMED, so a freshly dispatched order would flip
    // to SHIP and render as "Shipped" while still standing as a stop on the
    // driver's live run. Stale attachments are harmless, so only ACTIVE runs
    // block, mirroring TripsService.checkEligibility's ON_ACTIVE_RUN predicate.
    // Since F11 a run going terminal RELEASES the orders of every stop that
    // recorded no work, so a stale attachment now only survives on a COMPLETED
    // stop — or on a row stranded before that deploy, until the D4 repair runs.
    const run = order.routeRunStop?.routeRun ?? null;
    const onActiveRun =
      order.routeRunStopId != null &&
      run != null &&
      (run.status === RouteRunStatus.SCHEDULED || run.status === RouteRunStatus.IN_PROGRESS);
    if (dto.fulfillPath === FulfillPath.SHIP && onActiveRun) {
      throw new BadRequestException(
        `This order is out on an active delivery run${
          run?.driver?.contactName ? ` with ${run.driver.contactName}` : ""
        }. Remove it from the run before switching it to shipping.`,
      );
    }
    return this.prisma.forTenant().order.update({
      where: { id: orderId },
      data: { fulfillPath: dto.fulfillPath },
    });
  }

  async toggleUrgent(id: string, user: JwtPayload, urgent?: boolean) {
    const order = await this.findOneOrThrow(id);
    if (user.role === UserRole.CUSTOMER) {
      // REG-B131: `deletedAt: null` here — a removal deactivates the user but an access token
      // minted just before it stays valid for up to 15 minutes, so a removed customer's own
      // in-flight session must fall into the existing refusal below.
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub, deletedAt: null } });
      if (!customer || customer.id !== order.customerId) throw new ForbiddenException();
    }
    // If caller provides an explicit value, SET it; otherwise toggle (legacy web clients)
    const newValue = urgent !== undefined ? urgent : !order.urgent;
    return this.prisma.forTenant().order.update({ where: { id }, data: { urgent: newValue } });
  }

  /**
   * REG-B78: header fields a buyer's cart merge must carry onto the EXISTING
   * order — merge semantics, not create semantics: notes APPEND (never clobber),
   * urgent only ever SETS true (a non-urgent add never clears an urgent order),
   * requestedDeliveryDate sets when provided and never clears.
   */
  async applyBuyerMergeHeader(
    orderId: string,
    header: { notes?: string; urgent?: boolean; requestedDeliveryDate?: string },
    user: JwtPayload,
  ): Promise<void> {
    const order = await this.prisma.forTenant().order.findFirst({ where: { id: orderId } });
    if (!order) throw new NotFoundException("Order not found");
    if (user.role === UserRole.CUSTOMER) {
      // REG-B131: `deletedAt: null` here — a removal deactivates the user but an access token
      // minted just before it stays valid for up to 15 minutes, so a removed customer's own
      // in-flight session must fall into the existing refusal below.
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub, deletedAt: null } });
      if (!customer || order.customerId !== customer.id) throw new ForbiddenException();
    }
    const data: Record<string, unknown> = {};
    const notes = (header.notes ?? "").trim();
    if (notes) data.notes = order.notes ? `${order.notes}\n${notes}` : notes;
    if (header.urgent === true) data.urgent = true;
    if (header.requestedDeliveryDate) {
      // Mirrors create()'s exact parse (:2107-2109) so merge and create agree
      // on timezone handling.
      data.requestedDeliveryDate = new Date(header.requestedDeliveryDate);
    }
    if (Object.keys(data).length) {
      await this.prisma.forTenant().order.update({ where: { id: orderId }, data });
    }
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
      // REG-B131: `deletedAt: null` here — a removal deactivates the user but an access token
      // minted just before it stays valid for up to 15 minutes, so a removed customer's own
      // in-flight session must fall into the existing refusal below.
      const customer = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub, deletedAt: null } });
      if (!customer || customer.id !== order.customerId) throw new ForbiddenException();
    }

    if (!order.routeRunStop) {
      return { status: order.status, tracking: null };
    }

    // F11 (B129 / B146 contract, spec R5): a CANCELLED run is not tracking —
    // the buyer card must never show a driver, a stop number or "you're next"
    // for a called-off run. After F11 the release nulls the pointer at cancel
    // time, so this branch serves rows stranded BEFORE the deploy until the D4
    // repair frees them, and stays as the written contract. A SKIPPED own-stop
    // on a live or completed run keeps the FULL payload (stopStatus: "SKIPPED",
    // stopsAhead exactly as computed below) — the client branches on
    // stopStatus; the server invents no "skipped shape".
    if (order.routeRunStop.routeRun.status === RouteRunStatus.CANCELLED) {
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

  /**
   * Delete-any (owner 2026-08-25): staff may delete an order in ANY status —
   * DELIVERED included — behind the client's explicit warning. Money, not
   * status, is the gate now. `user` is optional so internal callers keep
   * working (change-requests' abandoned-draft cleanup passes none).
   */
  async deleteOrder(id: string, user?: JwtPayload) {
    const order = await this.prisma.forTenant().order.findUnique({
      where: { id },
      include: { invoices: { select: { id: true } }, transaction: { select: { id: true } } },
    });
    if (!order) throw new NotFoundException("Order not found");

    const isStaff =
      user == null || user.role === UserRole.OPERATOR || user.role === UserRole.TENANT_ADMIN;
    if (!isStaff) {
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
    }

    // Every other child row either cascades (revisions, change requests, order
    // credit notes) or is deleted in the transaction below — `Return` is the one
    // restrict-linked relation, and a DELIVERED order is exactly the kind that
    // has one. Refuse with an explanation instead of a raw FK error.
    const returnCount = await this.prisma.forTenant().return.count({ where: { orderId: id } });
    if (returnCount > 0) {
      throw new ConflictException(
        "This order has returns recorded against it. Delete those returns first.",
      );
    }

    // Deleting used to hard-delete every InvoicePayment below, including applied
    // credit notes — the credit stayed consumed with nothing left pointing at it,
    // so the customer's money vanished with no audit trail. Give wallet money back
    // first; external payments block the delete for the same reason they block a
    // cancel (software can't un-take cash). Wallet-only invoices (credit notes,
    // advances) still delete and hand the money back — that is #341's behaviour
    // and it is preserved for the newly-deletable statuses too.
    const impact = await this.cancelImpact(id);
    if (impact.blockingPayments.length > 0) {
      const detail = impact.blockingPayments
        .map((b) => `${formatMoney(b.amount)} on ${b.invoiceNumber || "an invoice"}`)
        .join(", ");
      throw new ConflictException(
        `This order's invoice has recorded payments (${detail}) — void the invoice first.`,
      );
    }

    await this.prisma.tenantTransaction(async (tx) => {
      // B214 (REG-B214): this loop hard-deletes invoices WITHOUT going through
      // InvoicesService.deleteInvoice (ledger-reversal duplication, see below), so it must refuse
      // on its own — same shared guard, before any write (L-072, L-081).
      await assertNoUnspentSourcedCredits(
        tx,
        order.invoices.map((inv) => inv.id),
      );
      await this.creditNotes.releaseOrderCreditsInTx(tx, id);
      for (const inv of order.invoices) {
        await this.invoicesService.releaseWalletPaymentsInTx(tx, inv.id);
      }
      // B214: re-assert on post-release state — the releases above revive
      // (un-spend/un-expire/un-VOID) notes sourced by these invoices; a throw here rolls the
      // releases back with the tx.
      // `lockRows` only HERE: the releases above already hold the InvoicePayment/CreditNote rows,
      // so taking Invoice now puts it LAST — the order voidInvoice uses. Taking it on the
      // pre-release call would make Invoice first and re-open the 40P01 cycle.
      await assertNoUnspentSourcedCredits(
        tx,
        order.invoices.map((inv) => inv.id),
        { afterRelease: true, lockRows: true },
      );
      // Delete all invoices associated with this order
      for (const inv of order.invoices) {
        // B65 (REG-B65): reverse this invoice's regulated-ledger entries
        // before deleting it — the two sibling teardown paths
        // (InvoicesService.voidInvoiceInTx, InvoicesService.deleteInvoice)
        // already do this; this loop hard-deletes invoices directly and was
        // the one path that skipped it. No preserveReturns (mirrors
        // deleteInvoice, not the partial-void path).
        await this.ledger.reverseInvoiceEntries({ invoiceId: inv.id, db: tx });
        await tx.invoicePayment.deleteMany({ where: { invoiceId: inv.id } });
        await tx.invoiceItem.deleteMany({ where: { invoiceId: inv.id } });
        // Sales agents & commissions: this loop hard-deletes invoices WITHOUT
        // going through InvoicesService.deleteInvoice — without this call an
        // order-cascade delete would strand or silently destroy accruals.
        // Throws when claimedAmount > 0 (same guard deleteInvoice enforces).
        await this.commissionEngine.removeInvoiceCommission(inv.id, tx);
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

  /**
   * Sales agents & commissions: staff-set (or clear, via `null`) per-order
   * commission-rate override. `0` is a valid value ("exempt"). Update + engine
   * resync run in ONE transaction so a resolved-rate change is atomic with the
   * order write. Does NOT touch updateOrderItems / item money — the existing
   * rebuildSiblingDrafts hook already covers item-edit money changes.
   */
  async setCommissionRate(orderId: string, ratePct: number | null, user: JwtPayload) {
    if (user.role !== UserRole.OPERATOR && user.role !== UserRole.TENANT_ADMIN) {
      throw new ForbiddenException("Only staff can set a commission rate");
    }
    if (
      ratePct !== null &&
      (typeof ratePct !== "number" || Number.isNaN(ratePct) || ratePct < 0 || ratePct > 100)
    ) {
      throw new BadRequestException(
        "commissionRatePct must be between 0 and 100, or null to clear",
      );
    }
    await this.findOneOrThrow(orderId);
    return this.prisma.tenantTransaction(async (tx) => {
      const order = await tx.order.update({
        where: { id: orderId },
        data: { commissionRatePct: ratePct },
      });
      await this.commissionEngine.syncOrderInvoices(orderId, tx);
      return order;
    });
  }

  async bulkDeleteOrders(ids: string[], user?: JwtPayload) {
    const results = await Promise.allSettled(ids.map((id) => this.deleteOrder(id, user)));
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
