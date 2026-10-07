import { API_ERROR_CODES } from "../common/api-error-codes";
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnApplicationBootstrap,
  Optional,
  ServiceUnavailableException,
} from "@nestjs/common";
import { assertBuyerLines, portalGateArgs } from "../buyer/buyer-product-visibility";
import { assertSellableLines } from "../products/sellable-lines";
import { randomUUID } from "crypto";
import { LeaderCron } from "../common/cron-lock";
import { withAfterCommit } from "../common/after-commit";
import { InlineReturnsService } from "../returns/inline-returns.service";
import * as inlineReturn from "./order-inline-return";
import {
  attachPaymentCreditNotes,
  ORDER_CREDIT_PAYMENT_SELECT,
} from "./order-payment-credit-notes";
import { attachInvoicesNeedReview } from "./order-invoices-review";
import { prepareInlineReturn, replayAfterCheck } from "./order-inline-return";
import { reserveInlineReturnNumber as reserveReturnNo } from "./order-inline-return";
import { applyInlineReturnInTx as applyReturn } from "./order-inline-return";
import { InjectQueue } from "@nestjs/bull";
import type { Queue } from "bull";
import { PrismaService } from "../prisma/prisma.service";
import { JwtPayload } from "../auth/jwt-payload.interface";
import {
  appendOrderRevision as appendOrderRevisionImpl,
  AppendOrderRevisionArgs,
} from "./order-revisions";
import {
  isSpecialTier,
  categoryTaxSnapshotOf,
  computeCategoryTax,
  computeLineSubtotal,
  getTierPrice,
  normalizeBoxesPieces,
  regulatedUnitBasis,
  roundMoney,
  withinStaffOverrideTolerance,
  type CategoryTaxType,
  type PromotionRule,
} from "@routeflow/pricing";
import { lockRowsNoWait, withAdvisoryLock, type LockMode } from "../common/db-locks";
import { retryCreditTx, retryOnTxConflict, txConflictState } from "../common/tx-retry";
import { lockOrderRow } from "../credit-notes/credit-note-locks";
import { assertMoneyInvariantsOrThrow } from "../common/money-invariants.util";
import {
  atStopConflict,
  CHANGE_WINDOW_ORDER_STATUS,
  CHANGE_WINDOW_RUN_NOT_ACTIVE,
} from "./at-stop-conflicts";
import { sourceLineFor } from "./source-line";
import type { CreateOrderOptions } from "./order-create-options";
import {
  oldestFirst,
  resolveSaleDelivery,
  saleCreateOptions,
  type SaleOptions,
} from "./sale-options";
import { notifyPickupHandover, pickupOutForDeliveryPush } from "./order-pickup-wording";
import { decideTierOverride } from "./staff-override";
import { assertMergeLockAcquired, isMergeContention, mapLockError } from "./merge-contention";
import {
  deleteLoserGuarded,
  lockAndRecheckMergeInputs,
  readMergeGroup,
} from "./merge-lock-recheck";
import {
  OrderStatus,
  UserRole,
  ItemStatus,
  MutationType,
  InvoiceStatus,
  PriceType,
  ChangeRequestStatus,
  ChangeRequestType,
  NotificationEvent,
  FulfillPath,
  RouteRunStatus,
  RouteRunStopStatus,
  type Prisma,
} from "@prisma/client";
import { ListOrdersDto } from "./dto/list-orders.dto";
import { nextOrderNumberFor } from "./order-number";
import * as unitAware from "./unit-aware-guard";
import { resolveFulfilPath } from "./fulfil-path-resolver";
import {
  assertNoBackdatedMerge,
  findActiveOrderImpl,
  sameFulfilPathAsWinner,
  unshipped,
  type MergeSearchOpts,
} from "./merge-candidates";
import * as cancelledLines from "./order-edit-cancelled";
import * as driverAccess from "./driver-edit-access";
import { assertRemovalsNameALine, writeLineRemoval, writeLineUpdate } from "./order-line-removal";
import { ORDER_STATUS_TRANSITIONS, assertOrderStatusTransition } from "./order-status-transitions";
import { buildStatusUpdateData } from "./order-status-claim";
import { AppliedCreditNoteDto, CreateOrderDto } from "./dto/create-order.dto";
import { assertSaleReplayable } from "./sale-replay-guard";
import { assertReplaySameCart, isIdempotencyKeyViolation } from "./replay-same-cart";
import { savedCreditsPending, withCreditsPendingHint } from "./create-credit-tail";
import {
  IDEMPOTENCY_KEY_CONFLICT,
  otherOrderConflict,
  IDEMPOTENCY_REPLAY_NEEDS_RECONCILE,
  shouldSkipInPlaceResync,
  findOrderIdByKeyCheckingReturn as findOrderIdByKey,
  insertMergeIdempotencyKey,
  loadReplayCandidateByKey,
  stampOrderIdempotencyKey,
  type IdempotencyLookupDeps,
} from "./merge-idempotency";
import { BUYER_EDIT_CLOSED_STATUSES, computeEditWindow } from "./edit-window";
import {
  cancelBlockedMessage,
  cancelImpact,
  lockedOrderStatus,
  lockOrderForCancel,
} from "./order-cancel-impact";
import { assertBuyerDiffShape, classifyEditPayload } from "./order-edit-payload";
import {
  applyBuyerMergeHeaderImpl,
  bulkDeleteOrdersImpl,
  findOneOrThrowImpl,
  setCommissionRateImpl,
  toggleUrgentImpl,
  updateFulfillPathImpl,
  updateShipmentImpl,
} from "./order-lifecycle";
import {
  EXISTING_LINE_SELECT,
  orderEditMode,
  planOrderEditRestrictions,
  type OrderEditRestrictionPlan,
} from "./order-edit-restrictions";
import { planChangeRequestRestrictions } from "./change-request-restrictions";
import { parseCommissionRatePct, parseOrderDate } from "./order-parsers";
import { getOrderTracking } from "./order-tracking";
import { CreateSaleDto } from "./dto/create-sale.dto";
import { ChangeOrderStatusDto } from "./dto/change-order-status.dto";
import { UpdateOrderItemsDto } from "./dto/update-order-items.dto";
import { UpdateShipmentDto } from "./dto/update-shipment.dto";
import { UpdateFulfillPathDto } from "./dto/update-fulfill-path.dto";
import { RouteFlowGateway } from "../gateways/routeflow.gateway";
import { TenantContextService } from "../tenant/tenant-context.service";
import { redactUpsellForCustomer } from "../common/upsell-redaction";
import { orderFor, ordersFor } from "../common/staff-only-fields";
import { currentTaxRate } from "../common/tax-rate";
import { NotificationsService } from "../notifications/notifications.service";
import { InvoicesService } from "../invoices/invoices.service";
import { dueStamp } from "../invoices/invoice-due-dates";
import {
  decrementStockForSale,
  restoreStockForReopen,
  settleStockForEdit,
  STOCK_LINE_UNIT_SELECT,
  STOCK_SETTLE_SELECT,
  type StockArgs,
  type StockLine,
  type StockLineUnits,
} from "./order-stock";
import { linePieceQty } from "./line-piece-qty";
import { resolveOversellAllowed } from "./oversell-policy";
import { PolicyOversellReader } from "./policy-oversell-reader";
import {
  isBuyerPricedLine,
  mergeBoxedContributions,
  rescaleBogoFreeUnits,
  resolveBuyerLinePrice,
} from "./buyer-merge-pricing";
import { buildMergeLineWrites, type MergeLine, type MergeWarning } from "./merge-line-writes";
import { assertReplaceAllPackMatchesLive } from "./replace-all-pack-resolution";
import { decideAddedLinePrice, decideEditedLinePrice, isOverride } from "./staff-line-price";
import {
  buildExistingLineMaps,
  buildReplaceAllLineData,
  buildReplaceAllPairing,
  type ReplaceAllLineBuildCtx,
} from "./replace-all-line-build";
import {
  assertCreditAtEnforcementPoint,
  assertWithinCreditLimit,
  isCreditLimitCheckEnabled,
  type CreditPointParams,
} from "./credit-limit-guard";
import { SystemConfigService } from "../system-config/system-config.service";
import { InventoryService } from "../inventory/inventory.service";
import { AuthorizationGuardService } from "../authorizations/authorization-guard.service";
import { resolveLineUnits } from "../products/line-units";
import * as unitLines from "./unit-line-build";
import * as unitEdit from "./unit-line-edit";
import { loadCategoryMapForProducts } from "./category-map";
import { assertBuyerCartPricesCurrent } from "./buyer-cart-price-check";
import { compositionStampOf, syncOrderLineCompositions } from "./order-composition";
import { withComponentViews } from "./component-view";
import { captureCompositionCarry } from "./order-edit-composition";
import { loadActivePromotionRules } from "./promotion-rules";
import { FeatureConfigService } from "../billing/feature-config.service";
import { reportPackWarnings } from "./merge-pack-warnings";
import {
  warnBannedMergedLines,
  type MergeLosers,
  type MergePush,
  type MergeWarnOpts,
  type MergeWinner,
} from "./merge-restriction-warning";
import { collectUnlistedLoserItems } from "./merge-unlisted-lines";
import { restrictionChannelForPrincipal } from "../selling-restrictions/selling-restrictions.core";
import { SellingRestrictionsService } from "../selling-restrictions/selling-restrictions.service";
import { PromotionsService } from "../promotions/promotions.service";
import { MessagingService } from "../messaging/messaging.service";
import type { OrderCancelBlockedField } from "@routeflow/types";
import { isFirstShipment, notifyOrderShipped } from "./shipment-notifications";
import { shippedPushCopy } from "./shipped-push-copy";
import { attachInvoiceStages } from "./order-invoice-stage";
import { EDIT_REVISIONS, updateStatusWithShipMarker } from "./order-ship-state";
import * as carrierGuard from "./order-carrier-guard";
import {
  throwIfWithCarrier,
  invoicesAtShipment,
  settleOrderInvoice,
  settledAtShipment,
} from "./order-status-invoicing";
import { formatDate, formatMoney } from "../messaging/messaging.helpers";
import { orderConfirmedVars } from "../messaging/order-confirmed-copy";
import { CreditNotesService } from "../credit-notes/credit-notes.service";
import { assertNoUnspentSourcedCredits } from "../credit-notes/sourced-credit-guard";
import { CommissionEngineService } from "../sales-agents/commission-engine.service";
import { EntitlementsService } from "../billing/entitlements.service";
import { RegulatedLedgerService } from "../regulated/regulated-ledger.service";
import { sumInlineReturnCredit } from "../returns/inline-return-credit.util";

@Injectable()
export class OrdersService implements OnApplicationBootstrap {
  private readonly logger = new Logger(OrdersService.name);

  constructor(
    // Not `private`: order-lifecycle.ts's verbatim-extracted methods AND unit-line-edit.ts (units_v1
    // A1) read this off an explicit `self: OrdersService` from outside the class — TS `private` is
    // compile-time only, so this is byte-identical at runtime.
    readonly prisma: PrismaService,
    @InjectQueue("invoices") private readonly invoiceQueue: Queue,
    private readonly gateway: RouteFlowGateway,
    private readonly notifications: NotificationsService,
    readonly invoicesService: InvoicesService,
    private readonly systemConfig: SystemConfigService,
    private readonly inventoryService: InventoryService,
    private readonly authGuard: AuthorizationGuardService,
    // Lane R: the selling-restrictions choke point. Required (never @Optional) — a missing
    // provider must be a DI error, not a silent bypass of a jurisdiction ban.
    private readonly sellingRestrictions: SellingRestrictionsService,
    private readonly promotionsService: PromotionsService,
    readonly messaging: MessagingService, // not `private`: shipment-notifications.ts / order-lifecycle.ts read it off `self`
    readonly creditNotes: CreditNotesService,
    readonly commissionEngine: CommissionEngineService,
    readonly entitlements: EntitlementsService,
    // B65 (REG-B65): reverses regulated-ledger entries in deleteOrder's
    // per-invoice teardown — the two sibling paths (voidInvoiceInTx,
    // deleteInvoice) already do this.
    readonly ledger: RegulatedLedgerService,
    // B323: the hourly/boot-time pending-order sweep has no HTTP request, so ALS is
    // empty — sweepAllPendingOrders() re-enters each customer's own tenant scope
    // via tenantCtx.run() (the RF-008 pattern already used by recurring-invoices,
    // tobacco-report, order-templates, authorization-expiry, commission-reconciliation
    // and regulated-filing-cron) so every forTenant() call inside the merge resolves
    // that tenant's own config/data, never another tenant's.
    private readonly tenantCtx: TenantContextService,
    // WS9: the backorder policy reader behind resolveOversellAllowed (resolved once per request,
    // before the transaction). Required (never @Optional): a missing provider is a DI error.
    private readonly oversellReader: PolicyOversellReader,
    // #2094: optional so unrelated specs build; `inlineReturn` without it fails closed.
    @Optional() private readonly inlineReturns?: InlineReturnsService,
    // #2717 M3: the `mixed_packs` mode read; absent = off (no composition work at all).
    @Optional() readonly featureConfig?: FeatureConfigService,
  ) {}

  /**
   * Tenant scope for the selling-restrictions choke point: the row being written's own tenant
   * when there is one (authoritative for an existing order), else the caller's, else the ambient
   * one. None of them means the check cannot be evaluated — refuse (fail closed, 403) rather than
   * skip: a tenant-less caller must act inside a tenant-scoped session.
   */
  private restrictionTenantId(user: JwtPayload | undefined, rowTenantId?: string | null): string {
    const tenantId = rowTenantId ?? user?.tenantId ?? this.prisma.getTenantId();
    if (tenantId) return tenantId;
    throw new ForbiddenException("Selling restrictions require a tenant-scoped session");
  }

  /**
   * P5-04: active promotions for the current tenant (window + isActive filtered).
   * Only loaded for the buyer (CUSTOMER) self-service path; empty for staff so
   * operator/driver order pricing is byte-for-byte unchanged.
   * Shared with OrderTemplatesService (REG-B48): a standing order is priced as
   * the customer's own buyer checkout, whoever triggers it.
   */
  async loadActivePromotions(role: UserRole): Promise<PromotionRule[]> {
    return loadActivePromotionRules(this.promotionsService, role);
  }

  private syncCompositions(tx: Prisma.TransactionClient, orderId: string) {
    return syncOrderLineCompositions(tx, orderId, this.prisma.getTenantId(), this.featureConfig);
  }

  /** Extracted verbatim to `buyer-merge-pricing.ts` (B585 prefactor #2); thin delegator. */
  resolveBuyerLinePrice(...args: Parameters<typeof resolveBuyerLinePrice>) {
    return resolveBuyerLinePrice(...args);
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
            unitBasisQty: linePieceQty(li, upbMap.get(li.productId)),
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
      if (!customer)
        throw new ForbiddenException({
          code: API_ERROR_CODES.CUSTOMER_NOT_LINKED,
          message: "Customer record not found",
        });
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
          // P5-11: pending change-request count for the orders-list badge. Filtered relation count
          // — additive; clients that don't know `_count` ignore it.
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

    const rows = ordersFor(user, data); // customer-facing fields only for the customer
    return { data: rows, meta: { total, page, limit, totalPages: Math.ceil(total / limit) } };
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
            isWalkIn: true,
          },
        },
        // Include `unitsPerBox` + `pricePerUnit` so the mobile/web edit UIs can render the boxes/pieces
        // split for boxed products and recompute line subtotals locally without a second roundtrip.
        // `averageCost` + `category` feed the live cost/margin hint + floor in the edit builder
        // (pos-cost-roles-spec §1).
        lineItems: {
          include: {
            components: { orderBy: { position: "asc" } }, // #2717 M3: frozen FIXED-line components
            product: {
              select: {
                id: true,
                name: true,
                unit: true,
                unitsPerBox: true,
                pricePerUnit: true,
                // units_v1 (SA-085f #2): pack tier prices for the picker's ladder, OPERATOR-ONLY
                // — a buyer (this same findOne, buyer.controller.ts) must never see another
                // customer's pricing tier; redactUpsellForCustomer never touched these columns.
                ...(user.role !== UserRole.CUSTOMER
                  ? { priceTier2: true, priceTier3: true, priceTier4: true, priceTier5: true }
                  : {}),
                averageCost: true,
                category: true,
                // Read-site name composition + SKU line (order-ui-redesign-spec §2/§4): a catalog
                // variant stores only its own flavor in `name`, so the reader needs the parent.
                sku: true,
                unitSku: true,
                variantName: true,
                parentProductId: true,
                parent: { select: { name: true } },
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
            deliveryBatchId: true, // the invoice stage (pdfVariant) keys on it
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
              // #2404: autoApplied (SA-436 PR-1) labels each credit Automatic / Manual.
              select: ORDER_CREDIT_PAYMENT_SELECT,
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
        revisions: EDIT_REVISIONS, // ship-state markers are not edits ("Edited N×")
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
    (order as any).editWindow = computeEditWindow(order, user.role);
    // B1083: the web disables Cancel from this (one server predicate, never re-derived client-side).
    Object.assign(order, {
      cancelBlockedReason: await carrierGuard.carrierBlocked(this, order),
    } satisfies OrderCancelBlockedField);
    await attachInvoiceStages(this.featureConfig, order); // fold 4: each invoice's pdfVariant
    order.lineItems = withComponentViews(order.lineItems) as typeof order.lineItems; // #2717 M3

    await attachPaymentCreditNotes(this.prisma.forTenant(), order); // #2404
    await attachInvoicesNeedReview(this.prisma.forTenant(), order, user); // B1116 (staff only)

    return orderFor(user, order); // customer-facing fields only for the customer
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
   *
   * B606: unit-aware lines (`unitLabel` set) are excluded for the same reason — a Case line's
   * price is per-CASE money that only means something with its unit. Remembered as the
   * product's price it would price a plain pack line at the Case price (2 boxes at $450 each),
   * and `distinct: productId` would let a newer Case row shadow a real pack override.
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
        unitLabel: null,
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

  private fulfilDeps() {
    return {
      featureConfig: this.featureConfig,
      tenantId: this.prisma.getTenantId(),
      logger: this.logger,
    };
  }

  /** The most recent active (DRAFT/PENDING) order for a customer: see `merge-candidates.ts`. */
  async findActiveOrder(customerId: string, opts: MergeSearchOpts = {}) {
    // units_v1: a unit-aware order is never a MERGE target; display reads keep it visible.
    const guard = opts.forMerge ? unitAware.ORDER_HAS_NO_UNIT_AWARE_LINE : {};
    return findActiveOrderImpl(this.prisma, customerId, opts, guard, this.fulfilDeps());
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

  private rescaleBogoFreeUnits(...args: Parameters<typeof rescaleBogoFreeUnits>) {
    return rescaleBogoFreeUnits(...args);
  }

  private isBuyerPricedLine(...args: Parameters<typeof isBuyerPricedLine>) {
    return isBuyerPricedLine(...args);
  }

  private mergeBoxedContributions(...args: Parameters<typeof mergeBoxedContributions>) {
    return mergeBoxedContributions(...args);
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
    options: { buyerInitiated?: boolean; focusOrderId?: string } = {},
    opts?: {
      lockMode?: LockMode;
      onPackMismatch?: (warnings: MergeWarning[]) => void;
      onLivePackFallback?: (warnings: MergeWarning[]) => void;
    } & MergeWarnOpts,
  ) {
    let after: MergePush; // F-05: the push runs after the lock is released
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
          // B1053: the ONE shared predicate (merge-lock-recheck.ts); the tx re-reads it under lock.
          const { group: pendingOrders } = await readMergeGroup(
            this.prisma.forTenant(),
            customerId,
            "auto",
            options.focusOrderId,
          );

          if (pendingOrders.length <= 1) {
            return pendingOrders[0] ?? null;
          }
          // units_v1: fold nothing and return NO order (a survivor would be someone else's order).
          if (pendingOrders.some((o) => o.lineItems.some(unitAware.isUnitAwareLine))) return null;

          const [winner, ...losers] = pendingOrders;
          // Unlisted (catalog-free) loser lines can't be keyed by product — each is
          // appended to the winner as its own new line (never boxed, unaffected by B776).
          const unlistedNewItems = collectUnlistedLoserItems(losers);

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

          // B776 (SA-101(1)): group every contributing line by the PACK it was actually priced
          // at (never the live product row) before folding — a disagreeing pack never merges
          // into another, it gets its own line, at its own snapshot and price, with a warn.
          const { writes: mergeWrites, warnings: packWarnings } = buildMergeLineWrites(
            winner.lineItems.filter((li) => li.productId) as unknown as MergeLine[],
            losers
              .flatMap((l) => l.lineItems)
              .filter((li) => li.productId) as unknown as MergeLine[],
            {
              promos: bogoPromos,
              canEarnNew: options.buyerInitiated === true,
              categoryFor: (productId) => catByProduct.get(productId) ?? null,
              liveUnitsPerBoxFor: (productId) => upbByProduct.get(productId) ?? 0,
            },
          );
          // SA-124: split by kind — a genuine disagreement (packMismatch) and a box-unaware
          // contribution with no snapshot resolved via the live product pack (livePackFallback,
          // SA-101(a) branch 4) are independent conditions with their own message and counter.
          reportPackWarnings(this.logger, "merge", winner.id, packWarnings, opts);

          await this.prisma.tenantTransaction(async (tx) => {
            await lockAndRecheckMergeInputs(tx, {
              customerId,
              kind: "auto",
              focusOrderId: options.focusOrderId,
              pre: pendingOrders,
            });
            // 1/2. Apply every pack-group write: an UPDATE onto the winner's own existing line
            // for its own pack group, a CREATE for every other group (SA-101(1)(b)/(c)).
            for (const write of mergeWrites) {
              if (write.kind === "update") {
                await tx.orderItem.update({ where: { id: write.lineId }, data: write.data });
              } else {
                // SA-100: explicit inline keys (never a `...write.data` spread) — the mandatory
                // trioVia AST check finds a regulated writer by scanning for a literal
                // `trackedCategoryId:` property in the object passed to `create()`; a spread
                // hides it behind a variable reference and makes this row invisible.
                await tx.orderItem.create({
                  data: {
                    orderId: winner.id,
                    status: ItemStatus.PENDING,
                    productId: write.data.productId,
                    qty: write.data.qty,
                    boxes: write.data.boxes,
                    pieces: write.data.pieces,
                    unitsPerBox: write.data.unitsPerBox,
                    unitPrice: write.data.unitPrice,
                    subtotal: write.data.subtotal,
                    promoFreeUnits: write.data.promoFreeUnits,
                    priceType: write.data.priceType,
                    originalPrice: write.data.originalPrice,
                    overrideReason: write.data.overrideReason,
                    overriddenBy: write.data.overriddenBy,
                    notes: write.data.notes,
                    trackedCategoryId: write.data.trackedCategoryId,
                    categoryTaxType: write.data.categoryTaxType,
                    categoryTaxRate: write.data.categoryTaxRate,
                    categoryPriceIncludesTax: write.data.categoryPriceIncludesTax,
                    ...compositionStampOf(write.data),
                  },
                });
              }
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
              await deleteLoserGuarded(tx, loser.id, "auto"); // items + the guarded order delete
            }

            // 4. Recompute winner totals.
            await this.syncCompositions(tx, winner.id);
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
          after = await this.warnMergedBanned(winner, losers, customerId, {
            ...opts,
            actor: opts?.actor ?? (options.buyerInitiated ? { type: "BUYER" } : null),
          });

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
      assertMergeLockAcquired(result);
      // The push runs here, after the lock is released. If the winner's post-warn re-read (inside the lock)
      // throws, `after` is never assigned and the push is lost: the AuditLog row is then the durable trace.
      await after?.();
      return result.value;
    } catch (e) {
      mapLockError(e);
    }
  }

  /** F-05 (SA-255): merge-and-warn — never blocks, see merge-restriction-warning.ts. */
  private warnMergedBanned(
    winner: MergeWinner,
    losers: MergeLosers,
    customerId: string,
    o: MergeWarnOpts = {},
  ) {
    const deps = {
      restrictions: this.sellingRestrictions,
      prisma: this.prisma,
      notifications: this.notifications,
      warn: (m: string) => this.logger.warn(m),
    };
    const tenantId = () => this.restrictionTenantId(undefined, winner.tenantId);
    return warnBannedMergedLines(deps, { tenantId, customerId, winner, losers, ...o });
  }

  async forceConsolidateCustomer(customerId: string, opts?: MergeWarnOpts) {
    let after: MergePush;
    try {
      const result = await withAdvisoryLock(
        { family: "order-merge", key: customerId, mode: "wait", waitMs: 20_000 },
        async () => {
          const { group: orders } = await readMergeGroup(
            this.prisma.forTenant(),
            customerId,
            "force",
          );
          if (orders.length <= 1) return orders[0] ?? null;
          unitAware.assertNoUnitAwareLines(
            orders.flatMap((o) => o.lineItems),
            "consolidated",
          );

          const [winner, ...losers] = orders;

          // If winner has no route assignment but losers do, promote the first loser's assignment.
          const routeAssignment =
            winner.routeRunId == null ? (losers.find((o) => o.routeRunId != null) ?? null) : null;

          // Unlisted (catalog-free) loser lines are appended as their own winner lines
          // (never boxed, unaffected by B776).
          const unlistedNewItems = collectUnlistedLoserItems(losers);

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

          // B776 (SA-101(1)): group every contributing line by the PACK it was actually priced
          // at (never the live product row) before folding — see mergeAllPendingForCustomer.
          const { writes: mergeWrites, warnings: packWarnings } = buildMergeLineWrites(
            winner.lineItems.filter((li) => li.productId) as unknown as MergeLine[],
            losers
              .flatMap((l) => l.lineItems)
              .filter((li) => li.productId) as unknown as MergeLine[],
            {
              promos: bogoPromos,
              canEarnNew: false,
              categoryFor: (productId) => catByProduct.get(productId) ?? null,
              liveUnitsPerBoxFor: (productId) => upbByProduct.get(productId) ?? 0,
            },
          );
          // SA-124: see mergeAllPendingForCustomer — split by kind, independent conditions.
          const counts = reportPackWarnings(this.logger, "consolidate", winner.id, packWarnings);

          await withAfterCommit(this.prisma, async (tx, after) => {
            await lockAndRecheckMergeInputs(tx, { customerId, kind: "force", pre: orders });
            for (const write of mergeWrites) {
              if (write.kind === "update") {
                await tx.orderItem.update({ where: { id: write.lineId }, data: write.data });
              } else {
                // SA-100: explicit inline keys (never a `...write.data` spread) — the mandatory
                // trioVia AST check finds a regulated writer by scanning for a literal
                // `trackedCategoryId:` property in the object passed to `create()`; a spread
                // hides it behind a variable reference and makes this row invisible.
                await tx.orderItem.create({
                  data: {
                    orderId: winner.id,
                    status: ItemStatus.PENDING,
                    productId: write.data.productId,
                    qty: write.data.qty,
                    boxes: write.data.boxes,
                    pieces: write.data.pieces,
                    unitsPerBox: write.data.unitsPerBox,
                    unitPrice: write.data.unitPrice,
                    subtotal: write.data.subtotal,
                    promoFreeUnits: write.data.promoFreeUnits,
                    priceType: write.data.priceType,
                    originalPrice: write.data.originalPrice,
                    overrideReason: write.data.overrideReason,
                    overriddenBy: write.data.overriddenBy,
                    notes: write.data.notes,
                    trackedCategoryId: write.data.trackedCategoryId,
                    categoryTaxType: write.data.categoryTaxType,
                    categoryTaxRate: write.data.categoryTaxRate,
                    categoryPriceIncludesTax: write.data.categoryPriceIncludesTax,
                    ...compositionStampOf(write.data),
                  },
                });
              }
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
              // Remove a loser's pending mirror draft (and its items) before deleting the order. The
              // Invoice→Order FK is ON DELETE SET NULL, so it would NOT block: a loser with a billed
              // Invoice or a Transaction never reaches here (mergeEligibleWhere("force") skips it, and
              // deleteLoserGuarded re-checks the same predicate on the delete itself).
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
              await deleteLoserGuarded(tx, loser.id, "force"); // items + the guarded order delete
            }
            await this.syncCompositions(tx, winner.id);
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
              after,
            });
          });

          this.logger.log(
            `forceConsolidateCustomer: merged ${losers.length} order(s) into ${winner.id} for customer ${customerId}, ${counts.mismatch} pack mismatch(es), ${counts.livePack} live-pack fallback(s)`,
          );
          after = await this.warnMergedBanned(winner, losers, customerId, opts);
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
      assertMergeLockAcquired(result);
      await after?.();
      return result.value;
    } catch (e) {
      mapLockError(e);
    }
  }

  async sweepAllPendingOrders(): Promise<{
    customers: number;
    merged: number;
    skipped: number;
    /** B776: customers whose merge folded 2+ disagreeing packs for a product this sweep run. */
    packMismatches: number;
    /** SA-124: customers whose merge resolved a box-unaware, no-snapshot contribution via the
     * live product pack this sweep run (SA-101(a) branch 4) — independent of packMismatches. */
    livePackFallbacks: number;
  }> {
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
    let packMismatches = 0;
    let livePackFallbacks = 0;
    for (const g of mergeCandidateGroups) {
      try {
        // RF-008: re-enter this group's OWN tenant's ALS scope before calling into
        // anything that relies on ambient forTenant() scoping (same pattern as
        // recurring-invoices.generateDueRecurringInvoices / tobacco-report /
        // order-templates / authorization-expiry / commission-reconciliation /
        // regulated-filing-cron).
        const winner = await this.tenantCtx.run(g.tenantId as string, () =>
          this.mergeAllPendingForCustomer(
            g.customerId,
            {},
            {
              onPackMismatch: () => packMismatches++,
              onLivePackFallback: () => livePackFallbacks++,
            },
          ),
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
      `sweepAllPendingOrders: swept ${mergeCandidateGroups.length} customer(s), merged into ${merged} winner(s), skipped ${skipped} without tenantId, ${packMismatches} pack mismatch(es), ${livePackFallbacks} live-pack fallback(s) (B776)`,
    );
    return {
      customers: mergeCandidateGroups.length,
      merged,
      skipped,
      packMismatches,
      livePackFallbacks,
    };
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
    requestHash: string | undefined,
    inlineReturn: { returnKey?: string; items?: any[]; reason?: string | null } | undefined, // #2424
    cart: { items?: ReadonlyArray<unknown> | null; status?: string | null }, // BUG-A
  ): Promise<{ orderId: string; verified: boolean } | null> {
    return findOrderIdByKey(
      this.idemDeps(),
      idempotencyKey,
      customerId,
      requestHash,
      inlineReturn,
      cart,
    );
  }

  /** B215/F30: replay-key lookup + stamping live in merge-idempotency.ts (size ratchet). */
  async findReplayCandidateByKey(idempotencyKey: string, customerId: string) {
    return loadReplayCandidateByKey(this.idemDeps(), idempotencyKey, customerId);
  }

  async recordIdempotencyKey(orderId: string, idempotencyKey: string): Promise<void> {
    return stampOrderIdempotencyKey(this.idemDeps(), orderId, idempotencyKey);
  }

  async recordMergeIdempotencyKey(
    tx: any,
    orderId: string,
    idem: { key: string; responseHash: string },
  ): Promise<void> {
    return insertMergeIdempotencyKey(this.idemDeps(), tx, orderId, idem);
  }

  private idemDeps(): IdempotencyLookupDeps {
    return { prisma: this.prisma, logger: this.logger };
  }

  async create(
    dto: CreateOrderDto,
    user: JwtPayload,
    // `sourceLines`: INTERNAL only, never a DTO field (source-line.ts).
    options: CreateOrderOptions = {},
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
    const inlineRet = await prepareInlineReturn(this.inlineReturns, dto.inlineReturn, user);
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

    const orderDate = parseOrderDate(dto.orderDate, user.role);
    // Sales agents & commissions: staff-gated per-order rate override.
    const commissionRatePct = parseCommissionRatePct(dto.commissionRatePct, user.role);

    const isStaffRole = user.role === UserRole.OPERATOR || user.role === UserRole.TENANT_ADMIN;
    // B318: the edit path (updateOrderItems' isStaffCreditEdit) already strips
    // appliedCreditNotes for non-staff callers — a buyer or driver token could
    // otherwise spend a customer's credit notes on create, a right the edit path
    // denies them. Same gate here so the two paths agree.
    const appliedCreditNotes = isStaffRole ? dto.appliedCreditNotes : undefined;
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
      if (!customer)
        throw new ForbiddenException({
          code: API_ERROR_CODES.CUSTOMER_NOT_LINKED,
          message: "Customer record not found",
        });
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
          throw otherOrderConflict();
        }
        // R4 + BUG-A: a replay must be of the SAME cart and kind (replay-same-cart.ts).
        assertReplaySameCart(existing, dto);
        options.onReplay?.(existing);
        const replay = await replayAfterCheck(this.prisma.forTenant(), inlineRet, existing);
        return withCreditsPendingHint(this.prisma, replay, appliedCreditNotes);
      }
    }

    // An auto-merge folds these items into an EXISTING order whose own business
    // date stays authoritative, so a supplied orderDate would be silently dropped.
    // Refuse instead — the operator can re-submit as a separate order.
    if (orderDate && !options.skipAutoMerge) {
      await assertNoBackdatedMerge(this, customerId, dto.fulfillPath);
    }

    // Credit-note selections: validate up-front (bad/expired/cross-customer/VOID
    // selections reject before any stock mutation). Fully-consumed re-submissions
    // are deliberately accepted (idempotent resubmit).
    if (appliedCreditNotes?.length) {
      await this.creditNotes.validateSelectionsForCustomer(
        this.prisma.forTenant(),
        customerId,
        appliedCreditNotes,
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
    // Counter sale (#3211): an INTERNAL `options.fulfillPath` (PICKUP) wins; every other caller goes
    // through the ONE resolver (#3210).
    const fulfillPath =
      options.fulfillPath ??
      (await resolveFulfilPath(this.fulfilDeps(), {
        explicit: dto.fulfillPath,
        stored: customerRecord?.fulfillPath,
        audience: user.role === UserRole.CUSTOMER ? "buyer" : "staff",
      }));

    // Unlisted (ad-hoc) lines have no productId — only fetch catalog rows for the
    // lines that reference a real product.
    const catalogIds = items.map((i) => i.productId).filter(Boolean) as string[];
    const products =
      catalogIds.length > 0
        ? await this.prisma.forTenant().product.findMany(portalGateArgs(catalogIds))
        : [];
    assertBuyerLines(user.role, products, { skip: options.allowArchived }); // buyer 409 before the staff FAMILY 400

    const productMap = new Map(products.map((p) => [p.id, p]));
    assertSellableLines(products); // WS8: a FAMILY is never a line

    // units_v1 (4b-2b): the gate (staff, flag.units_v1) + the server ladder of the named units.
    const unitsByProduct = await unitLines.prepareUnitLadders(items, {
      isStaff: isStaffRole,
      prisma: this.prisma,
      entitlements: this.entitlements,
    });

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

    // RF-198: buyer cart price-race check — see buyer-cart-price-check.ts.
    assertBuyerCartPricesCurrent({
      role: user.role,
      items,
      productMap,
      cpMap,
      defaultTier,
      priceHistory,
    });

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

      // units_v1 (4b-2b): a non-pack unit is built from the SERVER ladder; the pack falls through.
      const ladder = unitsByProduct.get(product.id) ?? [];
      const resolvedUnits = resolveLineUnits(product, ladder, item);
      if (unitLines.isUnitAware(resolvedUnits)) {
        const category = categoryMap.get(product.trackedCategoryId ?? "");
        const unitLine = unitLines.buildUnitLine({
          product,
          units: ladder,
          resolved: resolvedUnits,
          item: { ...item, productId: product.id },
          tier: cpMap.get(product.id) ?? defaultTier,
          taxFor: (qty, sub) => unitLines.categoryTaxForLine(category, qty, sub),
          position: index,
          tenantId: this.prisma.getTenantId(),
        });
        subtotal += unitLine.subtotal;
        return unitLine;
      }

      // Recompute qty from boxes/pieces when provided (backend is authoritative).
      // Normalize to integers and roll loose pieces >= unitsPerBox into boxes.
      const source = sourceLineFor(item.productId, options.sourceLines, items);
      const upb = source?.unitsPerBox ?? Number(product.unitsPerBox ?? 0);
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
      let staffOverride: { overrideReason: string | null; overriddenBy: string } | null = null;

      // QTY_BREAK promo threshold is measured in PIECES. A box-split line stores qty
      // in pieces already; a box-UNAWARE boxed line (boxes==null) stores qty as a
      // SELLING-UNIT (box) count, so expand it — mirrors the merge path so the same
      // buyer line prices identically at create vs edit.
      // B679/Opus: the tax basis is derived through regulatedUnitBasis — the ONE place this
      // design allows a box-unaware qty*pack expansion — never an inline copy of it. This is
      // always resolvedUnits.unitLabel (null here — unitLines.isUnitAware(resolvedUnits)
      // already returned its own unitLine above for a genuine unit line), never the RAW
      // item.unitLabel: a staff request can name the pack's own label ("Case") with no split
      // and still resolve to a plain pack line — regulatedUnitBasis would then read that
      // non-blank label as "qty is already the count" and under-tax by a factor of upb.
      const qtyPieces = regulatedUnitBasis(
        { qty, boxes, pieces, unitLabel: resolvedUnits.unitLabel },
        upb,
      ).unitBasisQty;
      // BUY_N_GET_M threshold is measured in whole SELLING units — a box for a
      // boxed line, a piece otherwise. `boxes` already holds the whole-box count
      // once split; a box-unaware boxed line's `qty` IS the box count (no split
      // was provided); a non-boxed line's `qty` is already in pieces = units.
      const qtyUnits = boxes != null ? boxes : qty;

      // Price priority: operator one-time override (DISCOUNTED) > best buyer
      // promotion (PROMO) / tier price (SPECIAL) / list price (STANDARD). Promos
      // populate `activePromos` only on the buyer (CUSTOMER) path (P5-04); staff
      // orders get [] so this reproduces the prior tier/standard ladder exactly.
      // #2696(c) rule A: a staff price is decided against this customer's TIER price (a special
      // line needs a reason to move, 400 otherwise); DISCOUNTED < list, MANUAL ≥ list (an upsell —
      // its base is redacted for the customer, upsell-redaction.ts). Within ½¢ of tier ⇒ the ladder.
      const staff =
        overridePrice != null
          ? decideTierOverride(product, tierForProduct, Number(overridePrice), item.overrideReason)
          : null;
      if (staff?.overridden) {
        ({ unitPrice, originalPrice } = staff);
        priceType = PriceType[staff.priceType];
        staffOverride = {
          overrideReason: item.overrideReason?.trim() || null,
          overriddenBy: user.sub,
        };
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

      // D-20 (SA-330): a rolled-over line keeps its SOURCE line's agreed price, type and original price (never
      // relabelled) and earns no promo units; the subtotal is still derived below at the carried pack and price.
      if (source) {
        ({ unitPrice, priceType, originalPrice } = source);
        freeUnits = 0;
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
      // B297 (SA-088): the trio this line was priced under — a later rate edit must never re-price it.
      const categorySnapshot = categoryTaxSnapshotOf(category ?? null);

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
        // D-20: a carried override keeps its audit trail (source-line.ts); #2696(c) a staff one's.
        ...(source
          ? { overrideReason: source.overrideReason, overriddenBy: source.overriddenBy }
          : (staffOverride ?? {})),
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
        // B297 (SA-088): the rate trio — recompute (PR3) reads THESE, never the live category.
        ...categorySnapshot,
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
      // Lane R: selling restrictions — a banned product refuses (409 SELLING_RESTRICTED) BEFORE the
      // stock transaction, like the license guard above; a DRAFT is checked at its promotion.
      await this.sellingRestrictions.assertLinesSellable({
        tenantId: this.restrictionTenantId(user),
        customerId,
        lines: lineItemsData.flatMap((li) => (li.productId ? [{ productId: li.productId }] : [])),
        channel: restrictionChannelForPrincipal(user), // judged at ENTRY time, like the license guard
      });
      // B585: credit check for a NEW order (nothing runs unless the tenant switch is set).
      await this.creditGate({ customerId, projectedTotal: total, principal: user });
    }

    // WS9: the oversell policy is resolved ONCE, here, before the transaction (so before any
    // FOR UPDATE); only the resulting boolean enters the locked stock section below.
    const allowOversell = isDraft
      ? false
      : await resolveOversellAllowed(this.oversellReader, {
          tenantId: (user.tenantId ?? this.prisma.getTenantId()) as string,
          role: user.role,
          source: user.role === UserRole.CUSTOMER ? "buyer" : "staff_entry",
          customerId,
        });

    // RF-017 + RF-014: create the order inside a transaction so we can
    // (a) hold a pessimistic lock on product rows while checking/decrementing
    //     stock, preventing concurrent oversell, and
    // (b) retry on P2002 if two requests race to the same order number.
    const MAX_RETRIES = 3;
    const unitOrder = lineItemsData.some((li) => "unitLabel" in li); // units_v1: never auto-merged
    let order: any;
    let inlineMinted: any = null;
    // B1186: this reserve is a NON-transactional numbering write that runs before the retry loop. A
    // request that then loses the same-key race (the P2002 exit below, now replayed) has burned its
    // number: a GAP in the return / credit-note series, never a duplicate. Gaps are accepted for these
    // documents (lead ruling 2026-10-06) - do not "fix" this by moving the reserve into the tx.
    const twin = await reserveReturnNo(inlineRet, customerId, user, idempotencyKey, this as any);
    if (twin) return twin;
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        order = await this.prisma.tenantTransaction(
          async (tx) => {
            await inlineReturn.lockInlineReturnCustomer(tx, inlineRet, customerId); // advisory FIRST
            // RF-014: generate the order number inside the transaction so a P2002 on
            // @@unique([tenantId, orderNumber]) is retried with a fresh value. B587: the NUMERIC
            // maximum over conforming `ORD-<digits>` numbers only (see order-number.ts). Minted BEFORE the
            // product-row locks below: the scan is O(tenant orders), so it must not run under them.
            const orderNumber = await nextOrderNumberFor(tx, this.prisma.getTenantId());

            // RF-017: stock validation — only for non-draft orders that have items.
            // Lock product rows first so concurrent requests serialise here.
            // Operators (and TENANT_ADMINs) are explicitly allowed to oversell — they may
            // be backordering or knowingly placing an order that will be fulfilled when
            // restocked. The customer / driver paths still hard-block on insufficient stock.
            // Unlisted lines have no productId — they never touch stock.
            const stockLines = lineItemsData.filter(
              (li): li is typeof li & { productId: string } => !!li.productId,
            );
            // B562 PR-2: the id is minted here so the SALE rows can reference the order.
            const orderId = randomUUID();
            if (!isDraft && stockLines.length > 0) {
              // B283: extracted to `decrementStockForSale` — changeStatus()'s
              // DRAFT→PENDING promotion is the SAME "becomes a real sale" moment
              // as a non-draft create(), so it calls the identical helper (no
              // second implementation of the lock/oversell-check/decrement).
              await this.decrementStockForSale(tx, stockLines, allowOversell, {
                orderId,
                notes: "CREATE",
                performedById: user.sub,
                customerFacing: user.role === UserRole.CUSTOMER,
              });
            }

            const created = await tx.order.create({
              data: {
                id: orderId,
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
                skipAutoMerge:
                  orderDate != null || !!options.skipAutoMerge || unitOrder || !!inlineRet,
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
                // SA-672e: only the counter-sale POST passes this; every other order keeps the column default.
                ...(options.counterSale ? { counterSale: true } : {}),
                lineItems: { create: lineItemsData },
              },
              include: {
                customer: { select: { id: true, businessName: true } },
                lineItems: {
                  include: { product: { select: { id: true, name: true, unit: true } } },
                },
              },
            });
            await this.syncCompositions(tx, created.id);
            inlineMinted = await applyReturn(tx, inlineRet, {
              customerId,
              orderId: created.id,
              user,
              orderRouteRunId: resolvedRouteRunId ?? dto.routeRunId,
            });
            return created;
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
          const hitIdempotencyConstraint = idempotencyKey != null && isIdempotencyKeyViolation(e);
          if (hitIdempotencyConstraint) {
            // B215: same table-then-column lookup as the pre-check above, so the row that won
            // the race is found whether it was stamped on the column or written to the table.
            const existing = await this.findReplayCandidateByKey(idempotencyKey!, customerId);
            // Same ownership gate as the pre-check above: the row that won the
            // race is only OUR replay if it belongs to this caller.
            if (existing && existing.customerId !== customerId) {
              throw otherOrderConflict();
            }
            if (existing) {
              assertReplaySameCart(existing, dto); // BUG-A: the race exit compares too
              options.onReplay?.(existing);
              const replay = await replayAfterCheck(this.prisma.forTenant(), inlineRet, existing);
              return withCreditsPendingHint(this.prisma, replay, appliedCreditNotes);
            }
          }
          // Retry only on orderNumber unique-constraint violations (RF-014);
          // propagate all other errors immediately (including ConflictException
          // for OOS items from RF-017).
          if (attempt < MAX_RETRIES - 1) continue;
        }
        if (inlineRet && txConflictState(e) && attempt < MAX_RETRIES - 1) {
          await inlineReturn.conflictBackoff(attempt);
          continue;
        }
        throw e;
      }
    }

    inlineReturn.emitInlineReturnCredit(inlineRet, this.prisma.getTenantId(), inlineMinted);
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

    // Credit-note intents: store the selection against the FINAL order id, then settle (a no-op
    // until an invoice exists). Short Serializable tx - NOT inside the create transaction above.
    await this.syncCreateCredits(order.id, customerId, appliedCreditNotes);

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
  async createSale(dto: CreateSaleDto, user: JwtPayload, sale: SaleOptions = {}) {
    // #2493: refuse a due date that names no real day (the DTO's @IsDateString passes
    // `2026-02-31`) BEFORE the order is created and stock decremented; the invoice step would
    // otherwise 400 and leave a DELIVERED order with no invoice.
    dueStamp(dto.dueDate, "dueDate");
    const { deliveredNow, deliveredAt, requestedDeliveryDate } = resolveSaleDelivery(dto, user);

    // 1. Create the backing order (reuses pricing tiers/overrides + stock lock/decrement). With an
    //    Idempotency-Key (counter sale only) a replay hands back the ORIGINAL order and `replay` is
    //    set, so steps 2-4 RESUME wherever the first attempt stopped instead of starting over.
    let replay = false as boolean;
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
        ...(dto.idempotencyKey ? { idempotencyKey: dto.idempotencyKey } : {}),
      },
      user,
      saleCreateOptions(sale, dto.idempotencyKey, () => (replay = true)),
    );
    // A replayed sale that was voided or cancelled must never be resumed (no invoice, send, charge or status write).
    if (replay) await assertSaleReplayable(this.prisma.forTenant(), order);

    // 2. Van sale: mark the order DELIVERED *directly*. We intentionally bypass changeStatus()
    //    here — changeStatus fires a fire-and-forget DRAFT invoice on DELIVERED, which would
    //    double-invoice this sale. (It also sidesteps the PENDING->DELIVERED transition guard.)
    //    No deliveredQty stamp (B1050): a correction goes through a return/credit until that lands.
    if (deliveredNow && !(replay && order.status === OrderStatus.DELIVERED)) {
      await this.prisma.forTenant().order.update({
        where: { id: order.id },
        data: { status: OrderStatus.DELIVERED, deliveredAt: deliveredAt ?? new Date() },
      });
    }

    // 3. Generate the invoice from the order — sets Invoice.orderId and increments
    //    OrderItem.invoicedQty (so a later delivery of a not-yet-delivered sale won't
    //    create a second invoice; on a replay it returns the existing invoices instead).
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
      // Issue every sibling; return the primary (standard/first) invoice. A replay sends only what
      // is still a DRAFT, with the OLDEST invoice as the primary.
      const sendOpts = sale.suppressInvoiceNotify ? [{ suppressNotify: true }] : [];
      let primary: any = null;
      for (const inv of replay ? oldestFirst(invoices) : invoices) {
        const sent =
          replay && inv.status && inv.status !== InvoiceStatus.DRAFT
            ? inv
            : await this.invoicesService.send(inv.id, ...sendOpts);
        if (primary === null) primary = sent;
      }
      return primary;
    }
    return invoices[0];
  }

  async changeStatus(id: string, dto: ChangeOrderStatusDto, user: JwtPayload) {
    await driverAccess.assertDriverMayEditOrder(this.prisma.forTenant(), id, user); // SA-434: FIRST, before any read
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

    // Transition table + demotion-reason rule: order-status-transitions.ts (SA-065 slice, verbatim).
    const { isDeliveredDemotion } = assertOrderStatusTransition(
      order.status,
      dto.status,
      dto.reason,
    );

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
    let checkedProductIds: ReadonlySet<string> | undefined; // what the Lane R check saw
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
      // Lane R: the same "becomes a real sale" moment — a banned product refuses (409
      // SELLING_RESTRICTED) BEFORE the status write / stock reservation. Drafts are created and
      // edited without the check; this is the draft escape's second half.
      await this.sellingRestrictions.assertLinesSellable({
        tenantId: this.restrictionTenantId(user, order.tenantId),
        customerId: order.customerId,
        lines: items.flatMap((li) => (li.productId ? [{ productId: li.productId }] : [])),
        channel: restrictionChannelForPrincipal(user), // judged at ENTRY time, like the license guard
      });
      checkedProductIds = new Set(pids);
    }

    // B585: goods leaving is the enforcement moment (operators only, by the role gates above; before
    // any write): OUT_FOR_DELIVERY, or a counter hand-over straight to DELIVERED (the van-sale flow never
    // sets OUT_FOR_DELIVERY). An order whose goods already left (PARTIALLY_DELIVERED, or OUT_FOR_DELIVERY
    // going on to DELIVERED) was gated on its way out. A driver's stop completion is not gated. Nothing
    // runs unless the tenant's `credit_limit.enforce_delivery` is set.
    const alreadyOut =
      order.status === OrderStatus.OUT_FOR_DELIVERY ||
      order.status === OrderStatus.PARTIALLY_DELIVERED;
    const goodsLeaving =
      (dto.status === OrderStatus.OUT_FOR_DELIVERY &&
        order.status !== OrderStatus.PARTIALLY_DELIVERED) ||
      (dto.status === OrderStatus.DELIVERED && !alreadyOut);
    if (goodsLeaving) {
      const p = { customerId: order.customerId, projectedTotal: Number(order.total) };
      await this.creditGate({ ...p, excludeOrderId: id, action: "delivery", principal: user });
    }

    // Refuse the cancel BEFORE writing the status — a rejection must leave the order exactly as it
    // was. A DRAFT demotion is refused the same way (#3207 D1): it credits all the stock back and a
    // DRAFT can then be cancelled or deleted, with the goods still out.
    const demote = dto.status === OrderStatus.CANCELLED || dto.status === OrderStatus.DRAFT;
    const carrier = demote ? await carrierGuard.carrierEditGuard(this, order) : null; // + S5 re-check
    // L6: a parcel with the carrier returns, it is not cancelled (ship-billing businesses only)
    if (carrier?.withCarrier) throwIfWithCarrier("WITH_CARRIER");
    if (dto.status === OrderStatus.CANCELLED) await this.assertCancellableOrThrow(id);

    const statusUpdateData = buildStatusUpdateData(order, dto.status, {
      isDeliveredDemotion,
      noteAppend,
    });

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
        // WS9: resolved once, BEFORE the transaction; only the boolean enters the locked section.
        const allowOversell = await resolveOversellAllowed(this.oversellReader, {
          tenantId: (user.tenantId ?? this.prisma.getTenantId()) as string,
          role: user.role,
          source: "promotion",
          customerId: order.customerId,
        });
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
            const activeItems: Array<StockLineUnits & { productId: string | null; qty: any }> =
              await tx.orderItem.findMany({
                where: { orderId: id, status: { not: "CANCELLED" } },
                select: { productId: true, qty: true, ...STOCK_LINE_UNIT_SELECT },
              });
            // The Lane R check ran outside this tx: a product added since (a concurrent draft
            // edit) was never judged — roll back (the claim above included) and promote again.
            if (activeItems.some((li) => li.productId && !checkedProductIds?.has(li.productId))) {
              throw new ConflictException(
                "The order's items changed while it was being promoted — review it and promote again.",
              );
            }
            const stockLines = activeItems.filter((li): li is StockLine => !!li.productId);
            await this.decrementStockForSale(tx, stockLines, allowOversell, {
              orderId: id,
              notes: "PROMOTE",
              performedById: user.sub,
              customerFacing: user.role === UserRole.CUSTOMER,
            });
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
              select: STOCK_SETTLE_SELECT,
            });
            const demoted = { id, status: OrderStatus.PENDING };
            await this.settleStockForEdit(tx, demoted, activeItems, [], user, { notes: "DEMOTE" });
            return tx.order.findUniqueOrThrow({ where: { id } });
          },
          { isolationLevel: "Serializable", timeout: 15_000 },
        );
      }
      if (dto.status === OrderStatus.CANCELLED) {
        // Cancelling means the customer owes nothing for this order, so EVERY live
        // invoice on it is voided — not just the pending mirror draft, which is all
        // this used to do. A SENT invoice left behind stayed collectible against a
        // cancelled order, and any credit applied to it stayed consumed forever
        // (settle skips VOID invoices, so nothing could ever give it back).
        //
        // Wallet money is returned first, inside the same transaction as the voids,
        // so a crash can't leave the credit spent and the invoice dead. External
        // payments are refused by assertCancellableOrThrow above AND re-checked under
        // the Order → Invoice locks (lockOrderForCancel, SA-404d R1) before any write.
        // B64 (REG-B64): a DRAFT never took a creation-time decrement, so a DRAFT
        // cancel neither credits stock NOR marks its lines. The credit and the mark
        // are ONE decision, not two: `reopenOrder` re-decrements exactly the lines
        // this cancel marked, so marking a line we did not credit would make reopen
        // take stock the order never held (understating it by the full quantity).
        // #2255 / SA-404d: re-run on a write conflict (SA-269). The CANCELLED status write sits in this
        // locked tx, so a refusal under the lock leaves the order exactly as it was — never
        // cancelled-but-not-unwound — and voidInvoiceInTx's claim keeps a re-run from voiding twice.
        return retryOnTxConflict(`order cancel void order=${id}`, () =>
          this.prisma.tenantTransaction(
            async (tx) => {
              await lockOrderForCancel(tx, id);
              // #2472 (2): decided from the status UNDER the lock, never the unlocked pre-read.
              const lockedStatus = await lockedOrderStatus(tx, id);
              carrierGuard.throwIfInTransitUnderLock(carrier, lockedStatus); // #3219 S5
              const cancelReturnsStock = lockedStatus !== OrderStatus.DRAFT;
              const lockedOrder = { ...order, status: lockedStatus };
              // SA-404f F2: compare-and-set on the cancellable set the pre-check used — a retry after
              // a 40001 caused by a concurrent DELIVERED must never cancel a delivered order.
              const cancellable = Object.keys(ORDER_STATUS_TRANSITIONS).filter((k) =>
                ORDER_STATUS_TRANSITIONS[k].includes("CANCELLED"),
              );
              const claimed = await tx.order.updateMany({
                where: { id, status: { in: cancellable as OrderStatus[] } },
                data: statusUpdateData,
              });
              if (claimed.count === 0)
                throw new ConflictException({
                  code: API_ERROR_CODES.ORDER_CHANGED_DURING_EDIT,
                  message:
                    "The order changed while it was being cancelled — review it and try again.",
                });
              const row = (await tx.order.findUnique({ where: { id } }))!; // the locked row, never gone
              if (cancelReturnsStock) {
                const activeItems = await tx.orderItem.findMany({
                  where: { orderId: id, status: { not: "CANCELLED" } },
                  select: STOCK_SETTLE_SELECT,
                });
                // Return the creation-time decrement, clamped to the undelivered remainder (empty final
                // set), AS the status read under the lock (#2472: a stale DRAFT pre-read would no-op).
                await this.settleStockForEdit(tx, lockedOrder, activeItems, [], user, {
                  notes: "CANCEL",
                });
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
              return row;
            },
            // Headroom over Prisma's 5s default, matching every other
            // settleStockForEdit call site (:3053, :4755): this transaction now runs
            // that helper's per-product lock/read/write loop alongside the voids.
            { isolationLevel: "Serializable", timeout: 15_000 },
          ),
        );
      }
      // SA-434: the DRIVER's PENDING → CONFIRMED is a locked, re-derived compare-and-set.
      if (user.role === UserRole.DRIVER)
        return driverAccess.confirmPendingAsDriver(this.prisma, id, user, statusUpdateData);
      // B1095: CAS on the status validated against (a cancel committed since the pre-read = 409), in the
      // SAME tx as the ship-state marker when there is one (SA-689): order-ship-state.ts.
      return updateStatusWithShipMarker(this, order, dto, user, statusUpdateData);
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

    // Settle the order's invoice on a manual status change: at DELIVERED, and (carrier orders of a
    // shipping tenant) at SHIPPED. Same body for both: order-status-invoicing.ts.
    if (
      await invoicesAtShipment(this.featureConfig, this.prisma.getTenantId(), order, dto.status)
    ) {
      invoiceFailure = await settleOrderInvoice(this, id, this.logger, "shipped");
    }
    if (dto.status === OrderStatus.DELIVERED) {
      invoiceFailure = await settleOrderInvoice(
        this,
        id,
        this.logger,
        "delivered",
        await settledAtShipment(this.featureConfig, this.prisma.getTenantId(), order),
      );

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
      dto.status === OrderStatus.OUT_FOR_DELIVERY && order.fulfillPath === FulfillPath.SHIP
        ? // told once, like the email: an unmark + re-mark keeps shippedAt and sends nothing
          isFirstShipment(order)
          ? shippedPushCopy(order)
          : undefined
        : notifMap[dto.status];
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
    // A PICKUP handover fires READY_FOR_PICKUP instead of the driver-named template (order-pickup-wording.ts).
    const pickupHandled = notifyPickupHandover(this.messaging, order, dto.status, user.sub || null);
    const messagingEvent = pickupHandled ? undefined : messagingEventMap[dto.status];
    if (
      messagingEvent === NotificationEvent.OUT_FOR_DELIVERY &&
      order.fulfillPath === FulfillPath.SHIP
    ) {
      // Carrier-shipped: ORDER_SHIPPED, not "out for delivery today" (customised wording kept per channel).
      // E-c: an unmark + re-ship keeps shippedAt, so the customer is told once.
      if (isFirstShipment(order)) void notifyOrderShipped(this, order, user.sub || null);
    } else if (messagingEvent) {
      let driverName = "your driver";
      if (messagingEvent === NotificationEvent.OUT_FOR_DELIVERY && order.routeRunId) {
        const run = await this.prisma.forTenant().routeRun.findFirst({
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

  /** What cancelling this order will do to its money (read-only) — see `order-cancel-impact.ts`. */
  cancelImpact(id: string) {
    return cancelImpact({ prisma: this.prisma, creditNotes: this.creditNotes }, id);
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
    if (impact.blockingPayments.length > 0)
      throw new BadRequestException(cancelBlockedMessage(impact.blockingPayments));
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
    // F-05 (SA-272): reopening moves the ORDER to PENDING, so EVERY line goes live — a new sale of the whole order,
    // not only of the item-CANCELLED lines (cancelling a DRAFT never marks its lines CANCELLED, and drafts are
    // written without the check). Staff-only path; no delta, so every catalog line is checked, before any write.
    await this.sellingRestrictions.assertLinesSellable({
      tenantId: this.restrictionTenantId(undefined, order.tenantId),
      customerId: order.customerId,
      lines: order.lineItems.flatMap((li) => (li.productId ? [{ productId: li.productId }] : [])),
      channel: "STAFF",
    });
    return this.prisma.tenantTransaction(
      async (tx) => {
        // B64 (REG-B64): read the item-CANCELLED lines BEFORE they flip below —
        // this is exactly the set an F07 cancel credited stock back for (a
        // pre-F07 cancel left lines untouched, so this reads empty and
        // re-decrements nothing — era consistency, not a regression).
        const cancelledLines = await tx.orderItem.findMany({
          where: { orderId: id, status: ItemStatus.CANCELLED },
          select: { productId: true, qty: true, deliveredQty: true, ...STOCK_LINE_UNIT_SELECT },
        });

        // Revert cancelled line items back to PENDING
        await tx.orderItem.updateMany({
          where: { orderId: id, status: ItemStatus.CANCELLED },
          data: { status: ItemStatus.PENDING },
        });

        // Re-take exactly what the cancel credited back (order-stock.ts).
        await restoreStockForReopen(this.stockDeps(), tx, id, cancelledLines);

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
    // B215/B465: `isCreateMerge` is set ONLY by the staff create-merge branch (OrdersController.create),
    // never reachable from a request body (the PATCH routes call with three arguments). B1094: the
    // buyer merge adds a fourth argument carrying ONLY `idempotency`. isCreateMerge: this replace-all IS the create path's own auto-merge, so a
    // line NEW to the order (no existing counterpart) skips the reason-required guard below,
    // matching separate create's own unchecked behavior — never inferred from the DTO/order
    // state, only ever set here by the one call site that means it.
    opts?: {
      idempotency?: { key: string; responseHash: string };
      isCreateMerge?: boolean;
    },
  ) {
    assertRemovalsNameALine(dto.items); // #2563: an id-less CANCEL/DELETE, before any read or write
    // SA-429: a DRIVER edits only an order on their own IN_PROGRESS run — FIRST, before any state leaks.
    await driverAccess.assertDriverMayEditOrder(this.prisma.forTenant(), orderId, user);
    const order = await this.prisma.forTenant().order.findUnique({
      where: { id: orderId },
      include: {
        lineItems: true,
        routeRun: { select: { status: true, startedAt: true } },
      },
    });
    if (!order) throw new NotFoundException("Order not found");
    // #2565: a buyer's ownership is settled FIRST, unconditionally — before any status or shape
    // answer and before any side effect (the linked-invoice revert below commits on its own
    // connection). The later buyer checks were each conditional, so a non-owner's diff could revert
    // another customer's invoice and only then meet the 403. A non-owner gets the bare 403 here.
    if (user?.role === UserRole.CUSTOMER) {
      const owner = await this.prisma
        .forTenant()
        .customer.findFirst({ where: { userId: user.sub, deletedAt: null } });
      if (!owner || owner.id !== order.customerId) throw new ForbiddenException();
    }
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
    const isDiffPayload = classifyEditPayload(order, dto, user); // A4/B13: see order-edit-payload.ts
    // SA-422: never revive a seller-CANCELLED line (409 before any write; a strike-off of one is a
    // no-op). SA-422b: BEFORE every unit check, so a cancelled line's id gets this answer first.
    if (
      (await cancelledLines.planCancelledLines(this.prisma, order, dto, user, isDiffPayload)).noop
    )
      return cancelledLines.readEditedOrder(this.prisma, orderId);
    const inlineRet = await prepareInlineReturn(this.inlineReturns, dto.inlineReturn, user);
    let inlineMinted: any = null; // #2094: emitted after the commit
    // units_v1: every branch below re-derives factor + price from the LIVE product (see the guard).
    const findOwner = () =>
      this.prisma.forTenant().customer.findFirst({ where: { userId: user?.sub, deletedAt: null } });
    await unitAware.assertOrderEditAllowed(order, dto, user, findOwner);
    // SA-507a/b: the buyer-diff 400 runs AFTER the guard (ownership, then the 409 shapes).
    await assertBuyerDiffShape(order, dto, user, isDiffPayload, findOwner);

    // units_v1 (A1): resolve every dto item's unit-awareness ONCE, up front — see unit-line-edit.ts.
    // Hoisted here, BEFORE the restriction plan and the un-tx'd revertLinkedInvoicesForOrderEdit
    // below (which commits on its own connection): a refused unit edit must never let that revert
    // commit and then throw, stranding a SENT invoice's pending mirror in DRAFT with nothing left
    // to re-sync it. Re-verified under the row lock inside the transaction (see heldItems below) —
    // this pre-lock pass is only what a REFUSAL must see before any commit happens.
    const unitCtx = await unitEdit.prepareUnitEditContext(this, order, dto, user);
    const unitRows = new Map<object, ReturnType<typeof resolveLineUnits>>();
    for (const item of dto.items ?? []) {
      const li = item.id ? unitCtx.existingById.get(item.id) : undefined;
      unitEdit.assertUnitLabelNamed(li, item);
      const pid = item.substituteProductId ?? item.productId ?? li?.productId;
      const product = pid ? unitCtx.products.get(pid) : undefined;
      if (product)
        unitRows.set(item, resolveLineUnits(product, unitCtx.ladders.get(pid!) ?? [], item, li));
      unitEdit.assertNoPackRedenomination(li, item, unitRows.get(item)); // SA-474
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
      throw new ForbiddenException(await carrierGuard.buyerEditClosedMessage(this, order)); // B1135
    }

    // Lane R: a banned product added by this edit refuses (409 SELLING_RESTRICTED) BEFORE the invoice
    // revert and any write. Non-draft only (a draft is judged at its promotion). OFF = one policy read
    // here and nothing else; the plan is re-checked under the row lock below (order-edit-restrictions.ts).
    let restrictionPlan: OrderEditRestrictionPlan | null = null;
    if (order.status !== "DRAFT") {
      const tenantId = this.restrictionTenantId(user, order.tenantId);
      restrictionPlan = await planOrderEditRestrictions(
        { restrictions: this.sellingRestrictions, prisma: this.prisma },
        {
          tenantId,
          existing: order.lineItems ?? [],
          items: dto.items ?? [],
          mode: orderEditMode(user?.role, dto.replaceAll, isDiffPayload),
        },
      );
      if (restrictionPlan)
        await this.sellingRestrictions.assertLinesSellable({
          tenantId,
          customerId: order.customerId,
          lines: restrictionPlan.lines,
          channel: restrictionChannelForPrincipal(user),
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
    // B1083 (D2): with the carrier, the shipment invoice is the bill: re-synced in place, never reverted
    const carrier = await carrierGuard.carrierEditGuard(this, order);
    const postDeliveryEdit = carrierGuard.resyncsInPlace(order.status, carrier); // B215 + D2
    await inlineReturn.preflightInlineReturn(inlineRet, order, user, !postDeliveryEdit); // #2178
    if (!postDeliveryEdit && !carrier.billsShip) {
      await this.invoicesService.revertLinkedInvoicesForOrderEdit(orderId); // ship-billing: under the lock (S2)
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

    // WS9: resolved ONCE, before the tx opens (so before any FOR UPDATE); only the boolean enters
    // the locked settleStockForEdit. A DRAFT edit never settles stock, so it reads no policy.
    const allowOversell =
      order.status !== "DRAFT"
        ? await resolveOversellAllowed(this.oversellReader, {
            tenantId: (user?.tenantId ?? this.prisma.getTenantId()) as string,
            role: user?.role,
            source: "edit",
            customerId: order.customerId,
          })
        : false;

    await inlineReturn.reserveEditReturnNumber(inlineRet); // #2094: after every refusal above

    // P5-08b: the entire mutation phase — item writes, totals recompute, the
    // stock/credit guards, and the order-header update — runs in ONE tenant
    // transaction. A guard violation (or any failure) rolls back every item
    // write, so a blocked edit leaves the order byte-identical and appends no
    // revision. The guards intentionally consume the AUTHORITATIVE recomputed
    // totals/line set (not a pre-mutation simulation), so there is no second
    // pricing formula to drift. reconcileOrderDraftInvoice and
    // appendOrderRevision stay OUTSIDE (after commit), unchanged.
    const { subtotal, tax, total, shouldRevert, shippingFee } = await inlineReturn.runEditTx(
      inlineRet,
      this.prisma,
      async (tx: any) => {
        // WP1/F2: serialize concurrent edits of ONE order, then snapshot its
        // pre-edit lines INSIDE the transaction. `order` above was read before
        // the tx opened, so under a concurrent edit (this web PATCH racing an
        // at-door approve of the same order) its lineItems are stale and the
        // stock delta computed from them is the WRONG MAGNITUDE — a permanent
        // inventory error, not just a lost update. The row lock makes the
        // second writer wait; heldItems is then read post-lock and BEFORE any
        // orderItem write below, so it is the true pre-edit state.
        await inlineReturn.lockInlineReturnCustomer(tx, inlineRet, order.customerId); // advisory FIRST
        await tx.$executeRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
        let lineIdentity: "stable" | "recreated" = "stable"; // B1050: deleteMany + re-create flips it
        const carrierLocked = await carrierGuard.carrierRevertUnderLock(
          tx,
          orderId,
          carrier,
          postDeliveryEdit,
          () =>
            this.invoicesService.revertLinkedInvoicesForOrderEdit(orderId, tx, { lockRows: true }),
        );
        const heldItems = await tx.orderItem.findMany({
          where: { orderId },
          // B709: plus every column the diff branch reads off an existing line (see heldOrSnapshot).
          select: {
            ...EXISTING_LINE_SELECT,
            deliveredQty: true,
            invoicedQty: true,
            unitPrice: true,
            promoFreeUnits: true,
            overrideReason: true,
          },
        });
        restrictionPlan?.assertHeld(heldItems);
        await driverAccess.assertDriverMayEditOrder(tx, orderId, user); // SA-429: re-derived under the Order lock
        cancelledLines.assertHeldCancelledLines(heldItems, dto.items, user, isDiffPayload); // SA-422

        // units_v1 (A1, #1102 precedent): the pre-lock resolution above can go stale under a
        // concurrent edit of the SAME line — re-run it against the just-locked, authoritative
        // heldItems (never the pre-tx `order.lineItems`) before any write. `unitRows.set` keys
        // by the same `item` object reference, so this simply overwrites each entry in place.
        const heldById = new Map<string, any>(heldItems.map((h: any) => [h.id, h]));
        // B709: the diff branch reads every existing line from the LOCKED rows, never from the
        // pre-tx `order.lineItems` snapshot another writer may have replaced while this tx waited
        // on the lock. The `?? snapshot` arm is the B135 interim (`liveLine ?? li`): a row the held
        // read lacks was hard-deleted under the lock, and its write then fails loudly on P2025. The
        // items[].expectedQty follow-up turns that arm into a CONCURRENT_UPDATE 409.
        const heldOrSnapshot = (id: string): any =>
          heldById.get(id) ?? order.lineItems.find((l) => l.id === id);
        for (const item of dto.items ?? []) {
          const li = item.id ? heldById.get(item.id) : undefined;
          unitEdit.assertUnitLabelNamed(li, item);
          const pid = item.substituteProductId ?? item.productId ?? li?.productId;
          const product = pid ? unitCtx.products.get(pid) : undefined;
          if (product)
            unitRows.set(
              item,
              resolveLineUnits(product, unitCtx.ladders.get(pid!) ?? [], item, li),
            );
          unitEdit.assertNoPackRedenomination(li, item, unitRows.get(item)); // SA-474
        }

        // Customer/Driver path: replace items by productId. A4: a DRIVER diff payload skips this branch
        // entirely (merges below, prices stripped). Only the DRIVER half recreates unlisted rows' ids.
        // SA-407: a buyer's per-line diff (a unit line's count / a removal) merges like staff's too.
        // SA-696a (decided, fail closed): this path recreates every line (new ids), so a carrier order with an
        // unlisted line reads as a removal and is refused NO_REDUCE even when nothing changed; nothing written.
        if (
          (user?.role === UserRole.CUSTOMER || user?.role === UserRole.DRIVER) &&
          !isDiffPayload
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
          const products = await tx.product.findMany(portalGateArgs(productIds));
          assertBuyerLines(user.role, products, { held: heldItems }); // the LOCKED held lines (n1)
          const productMap = new Map<string, any>(products.map((p: any) => [p.id, p]));
          assertSellableLines(products); // WS8
          // B297 (SA-098a): this pack-line create() is disconnected from `uctx.categoryMap`
          // (which only covers unit-aware `unitCtx.products`) — its own scoped load.
          const buyerCategoryMap = await loadCategoryMapForProducts(tx, productMap);

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
          // SA-422 (3): a buyer's fresh add is never denominated by a seller-CANCELLED line.
          const denomLines = isBuyerEdit
            ? cancelledLines.liveLines(order.lineItems ?? [])
            : (order.lineItems ?? []);
          const pieceDenominated = new Set(
            denomLines
              .filter((li) => li.productId && (li.boxes != null || li.pieces != null))
              .map((li) => li.productId as string),
          );
          // B51 (REG-B51): buyers can neither author, reprice, nor drop unlisted
          // (catalog-free) lines — create()'s staff-only rule, mirrored. Stored
          // unlisted rows are preserved IN PLACE (same row ids — invoice/delivery
          // references survive); client-supplied unlisted input is ignored on the
          // buyer path. Drivers keep today's authoring behavior.
          // SA-422 (1): a buyer save never deletes the seller's CANCELLED rows (F07 reopen marks).
          const carry = await captureCompositionCarry(tx, order.lineItems ?? [], dto.items); // #2717 SA-591(b)
          lineIdentity = "recreated";
          await tx.orderItem.deleteMany({
            where: {
              orderId,
              ...(isBuyerEdit ? { productId: { not: null }, status: { not: "CANCELLED" } } : {}),
            },
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
            // An explicit boxes/pieces split (and DRIVER pieceDenominated lines) carry qty as
            // PIECES: re-split and prorate by the BOX price, else qty*unitPrice over-charges
            // by unitsPerBox. A PLAIN buyer qty (pre-existing or new) is the default selling
            // unit (the pack), NOT pieces: it is never re-split and keeps qty*price.
            // DRIVER edits keep the strict pieceDenominated gate.
            const upb = Number(product.unitsPerBox ?? 0);
            const shouldSplit =
              upb > 1 &&
              (pieceDenominated.has(item.productId) ||
                // REG-B47: a folded merge payload carries an explicit box/piece split —
                // treat it as piece-denominated and re-split server-side from qty + LIVE
                // unitsPerBox (B13 posture: the split is a signal, never trusted verbatim).
                (isBuyerEdit && (item.boxes != null || item.pieces != null)));
            // SA-601 / #2780 (PACK ONLY): a PLAIN buyer qty (no boxes/pieces/unitLabel) on a
            // product NEW to the order is NOT re-split as pieces — it is the DEFAULT SELLING
            // UNIT (the pack: qty N = N packs), exactly as create() stores it. It falls through
            // to the box-unaware branch below (qty as selling units, boxes/pieces/unitsPerBox
            // null). An explicit boxes/pieces (clause above) still wins.
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
            // B661-sweep: box-unaware multiply, converts to regulatedUnitBasis in a follow-up PR.
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
            const made = await tx.orderItem.create({
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
                // B297 (SA-098a): a fresh/re-created line is a new sale — stamp the rate
                // trio from the live category, never leave it null (recompute only ever
                // fixes the amount, never the trio).
                ...categoryTaxSnapshotOf(
                  product.trackedCategoryId
                    ? (buyerCategoryMap.get(product.trackedCategoryId) ?? null)
                    : null,
                ),
                // R2: preserve the client's line order on full replace.
                position: pos++,
              },
            });
            await carry.restore(tx, made.id, item);
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
          await unitEdit.assertBuyerOwnsOrder(tx, user, order.customerId); // SA-407: buyer diff
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
          const atCustomerTier = isStaffEdit || user?.role === UserRole.CUSTOMER; // SA-407: unit counts
          // B465 fix round (Opus BLOCK): an id-only UPDATE entry (web/mobile send
          // {id, action, qty, unitPrice} with no productId of their own) must resolve
          // tier pricing for the EXISTING line's product too — not just products
          // present in the payload — or a per-product CustomerPrice override never
          // gets fetched and the line silently falls back to the customer's DEFAULT
          // tier instead of a genuinely SPECIAL per-product row (or vice versa).
          const existingLineProductIds = dto.items
            .map((i) => (i.id ? heldOrSnapshot(i.id)?.productId : null)) // B709: locked row
            .filter((id): id is string => !!id);
          // B466: a substitution's NEW product id must resolve tier pricing too — it
          // was missing from this collection entirely (neither a fresh add's productId
          // nor an existing line's OLD productId covers it), so the substitute branch's
          // CustomerPrice lookup always fell back to the customer's DEFAULT tier even
          // when a per-product SPECIAL row existed for the substitute specifically.
          const substituteProductIds = dto.items.map((i) => i.substituteProductId).filter(Boolean);
          const operatorProductIds = atCustomerTier
            ? ([
                ...new Set([
                  ...dto.items.map((i) => i.productId).filter(Boolean),
                  ...existingLineProductIds,
                  ...substituteProductIds,
                ]),
              ] as string[])
            : [];
          const operatorTierCtx = atCustomerTier
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
          const uctx: unitEdit.UnitWriteContext = {
            tx,
            orderId,
            ladders: unitCtx.ladders,
            tenantId: this.prisma.getTenantId(),
            tier: (pid) => (atCustomerTier ? (operatorCpMap.get(pid) ?? operatorDefaultTier) : 1),
            categoryMap: await loadCategoryMapForProducts(tx, unitCtx.products), // B297
          };

          if (replaceAll) {
            // SA-696a (decided, fail closed): recreates every line (new ids), so a carrier order with an unlisted
            // line is refused NO_REDUCE even when nothing changed. Replace-all: the client sends the full list;
            // delete then re-create, honoring per-line price overrides and boxes/pieces splits (BOX proration).
            const productIds = dto.items.map((i) => i.productId).filter(Boolean) as string[];
            const products = await tx.product.findMany({ where: { id: { in: productIds } } });
            const productMap = new Map<string, any>(products.map((p: any) => [p.id, p]));
            assertSellableLines(products); // WS8
            // B297 (SA-098a): a superset of `uctx.categoryMap` (unit-aware products only) —
            // this pack-line create() below needs every product this replaceAll touches.
            const operatorReplaceCategoryMap = await loadCategoryMapForProducts(tx, productMap);

            // B60 (REG-B60): the pre-edit BOGO counterparts and per-product line counts (see
            // buildReplaceAllPairing) — built once from the PRE-edit lines, before the delete below.
            const { preEditLinesByProduct, incomingLinesByProduct, bogoCounterparts } =
              buildReplaceAllPairing(order, dto);

            // B465 fix round 3 (Opus BLOCK item 2) / SA-124i (option i, #938): both existingLine*
            // maps updateOrderItems' replaceAll rebuild needs — existingLineByProduct keeps the
            // original unambiguous-pairing gate (exactly one pre-edit AND one incoming line for
            // that product); existingLineById (keyed by the line's own id, never ambiguous) is
            // what a folded payload's `sourceLineId` resolves against instead. Extracted to
            // replace-all-line-build.ts (round 5) to keep the size ratchet's ceiling.
            const { existingLineByProduct, existingLineById } = buildExistingLineMaps(
              order.lineItems ?? [],
              preEditLinesByProduct,
              incomingLinesByProduct,
            );

            const itemCtx: ReplaceAllLineBuildCtx = {
              bogoCounterparts,
              bogoPromos,
              existingLineByProduct,
              existingLineById,
              isStaffEdit,
              operatorCpMap,
              operatorDefaultTier,
              isCreateMerge: opts?.isCreateMerge,
              buyerPromos,
              userId: user?.sub ?? null,
              operatorReplaceCategoryMap,
            };

            // SA-124i (non-blocking): validate every item's own pack against the live product
            // for ALL items BEFORE deleteMany runs, rather than interleaved with it per-item —
            // a mid-loop refusal was already rolled back by the surrounding transaction either
            // way, but this keeps the delete from ever starting on a payload that's going to
            // refuse.
            for (const item of dto.items) {
              if (!item.productId) continue;
              const product = productMap.get(item.productId);
              if (!product) throw new BadRequestException(`Product ${item.productId} not found`);
              assertReplaceAllPackMatchesLive(item, Number(product.unitsPerBox ?? 0));
            }

            // #2717 SA-591(b): a surviving FIXED line keeps its stamp + components (I11).
            const carry = await captureCompositionCarry(tx, order.lineItems ?? [], dto.items);
            lineIdentity = "recreated";
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
              const unitRow = unitRows.get(item);
              if (unitRow && unitLines.isUnitAware(unitRow)) {
                await unitEdit.createUnitLine(uctx, orderId, product, unitRow, item, pos++);
                continue;
              }

              const lineData = buildReplaceAllLineData(itemCtx, item, product);
              if (!lineData) continue;
              const made = await tx.orderItem.create({
                data: { orderId, ...lineData, position: pos++ },
              });
              await carry.restore(tx, made.id, item);
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
                ? await tx.product.findMany(portalGateArgs(addProductIds))
                : [];
            assertBuyerLines(user?.role, addProducts);
            const addProductMap = new Map<string, any>(addProducts.map((p: any) => [p.id, p]));
            assertSellableLines(addProducts); // WS8
            // B297 (SA-098a): `uctx.categoryMap` only covers unit-aware `unitCtx.products` —
            // a diff-add's own pack-line create() below needs its own scoped load.
            const addCategoryMap = await loadCategoryMapForProducts(tx, addProductMap);
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
                const unitRow = unitRows.get(item);
                if (unitRow && unitLines.isUnitAware(unitRow)) {
                  await unitEdit.createUnitLine(uctx, orderId, product, unitRow, item, nextPos++);
                  continue;
                }
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
                // #2716c: ONE rule (staff-line-price.ts -> decideStaffOverride). A special-tier
                // line (B465) refuses a changed price with no reason; a price within half a cent
                // of the customer's tier price is no override; otherwise below list is DISCOUNTED,
                // at/above list MANUAL, originalPrice = list. WP1: ONLY a line with no price at
                // all falls through to the tier ladder, and only for staff — a DRIVER diff add
                // (prices stripped by B13) keeps list pricing.
                const addDecision =
                  overridePrice !== null
                    ? decideAddedLinePrice({
                        overridePrice,
                        tierPrice: Number(getTierPrice(product, tierForProduct)),
                        listPrice: catalogPrice,
                        isSpecialTier: isSpecialTier(tierForProduct),
                        hasReason: !!(item.overrideReason && item.overrideReason.trim()),
                        productName: product.name,
                      })
                    : null;
                const isManualOverride = !!addDecision && isOverride(addDecision);
                const priced = addDecision
                  ? { ...addDecision, freeUnits: 0 }
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
                    // B297 (SA-098a): a diff-added line is a new sale — stamp the trio.
                    ...categoryTaxSnapshotOf(
                      product.trackedCategoryId
                        ? (addCategoryMap.get(product.trackedCategoryId) ?? null)
                        : null,
                    ),
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
                const li = heldOrSnapshot(item.id);
                const hasDeliveries = await tx.deliveryMutation.count({
                  where: { orderItemId: item.id },
                });
                const keep = (li && Number(li.invoicedQty ?? 0) > 0) || hasDeliveries > 0;
                // #2563: scoped to THIS order ({ id, orderId }); a foreign line id is a 404.
                await writeLineRemoval(tx, orderId, item.id, keep ? "strike-off" : "delete");
              } else if (item.action === "CANCEL") {
                await writeLineRemoval(tx, orderId, item.id, "strike-off");
              } else if (item.substituteProductId) {
                const product = await tx.product.findUniqueOrThrow({
                  where: { id: item.substituteProductId },
                });
                assertSellableLines([product]); // WS8: a FAMILY is never a substitute line
                const unitRow = unitRows.get(item);
                if (unitRow && unitLines.isUnitAware(unitRow)) {
                  // updateUnitLine re-stamps from uctx.categoryMap itself (isSubstitute flag) —
                  // this branch never needs its own category load.
                  await unitEdit.updateUnitLine(uctx, item.id!, product, unitRow, item, true);
                  continue;
                }
                // B297 (SA-098a): the pack-line substitute path only — its own scoped load.
                const substituteCategoryMap = await loadCategoryMapForProducts(tx, [product]);
                const existingQty = heldOrSnapshot(item.id!)?.qty ?? 1;
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
                // The baseline is the SUBSTITUTE's own tier price (list at tier 1, so non-special
                // behavior is unchanged); within ½¢ of it is not a repricing and needs no reason.
                // #2696(c): the ONE rule A, shared with create (decideTierOverride → pricing's
                // decideStaffOverride, rounded) — pinned byte-identical to this branch's B466 shape.
                const overridePrice =
                  isStaffCaller && item.unitPrice != null ? Number(item.unitPrice) : null;
                const decided = decideTierOverride(
                  product,
                  tierForProduct,
                  overridePrice ?? Number(getTierPrice(product, tierForProduct)),
                  item.overrideReason,
                );
                const { unitPrice, originalPrice, overridden: isOverridden } = decided;
                const priceType: PriceType = PriceType[decided.priceType];
                const subtotal = computeLineSubtotal({
                  unitPrice,
                  qty: qtyVal,
                  boxes: split?.boxes ?? null,
                  pieces: split?.pieces ?? null,
                  unitsPerBox: product.unitsPerBox,
                });
                // #2577: scoped to THIS order ({ id, orderId }) — a foreign line id is a 404.
                await writeLineUpdate(tx, orderId, item.id, {
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
                  // B297 (SA-098a): the product changed — re-stamp the trio from the
                  // NEW product's live category, same substance as updateUnitLine's
                  // isSubstitute:true arm.
                  ...categoryTaxSnapshotOf(
                    product.trackedCategoryId
                      ? (substituteCategoryMap.get(product.trackedCategoryId) ?? null)
                      : null,
                  ),
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
                const li = item.id ? heldOrSnapshot(item.id) : undefined;
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
                const unitRow = unitRows.get(item);
                if (unitRow && unitLines.isUnitAware(unitRow)) {
                  const p = unitCtx.products.get(li.productId!)!;
                  // B297: same product, not a substitute — updateUnitLine must PRESERVE the trio.
                  await unitEdit.updateUnitLine(uctx, item.id!, p, unitRow, item, false);
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
                const storedOverrideReason = (li as any).overrideReason ?? null;
                // #2716c: ONE rule (staff-line-price.ts -> decideStaffOverride); reason baseline =
                // STORED price (echo = untouched, no re-stamp); the TIER price typed back restores
                // SPECIAL/STANDARD, reason cleared (SA-592). Else DISCOUNTED < list <= MANUAL, original = LIST.
                let editProduct: Awaited<ReturnType<typeof tx.product.findFirst>> = null;
                if (
                  overridePrice !== null &&
                  !withinStaffOverrideTolerance(overridePrice, existingUnitPrice) &&
                  !isUnlisted &&
                  li.productId
                ) {
                  editProduct = await tx.product.findFirst({
                    where: { id: li.productId },
                  });
                }
                const repriced = decideEditedLinePrice({
                  overridePrice,
                  storedPrice: existingUnitPrice,
                  tierPrice: editProduct ? getTierPrice(editProduct, tierForProduct) : 0,
                  listPrice: editProduct ? Number(editProduct.pricePerUnit) : existingUnitPrice,
                  isSpecialTier: isSpecialTier(tierForProduct),
                  hasReason: !!(
                    (item.overrideReason && item.overrideReason.trim()) ||
                    (storedOverrideReason && String(storedOverrideReason).trim())
                  ),
                  isUnlisted,
                  productName: editProduct?.name ?? null,
                });
                const isManualOverride = !!repriced && isOverride(repriced);
                const unitPrice = repriced ? repriced.unitPrice : existingUnitPrice;
                // This branch keeps the line's stored (agreed) price — it never re-runs
                // applyBestPromotion for the UNIT PRICE. BUY_N_GET_M free units are a function of
                // the QUANTITY, so they are RE-DERIVED for the new qty (`rescaleBogoFreeUnits`):
                // reusing the snapshot verbatim under-billed a shrunk line (12 → 2 boxes billed
                // $0.00). A manual price override replaces the promo price outright, so the free
                // units earned under it do not survive.
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
                    ...(repriced
                      ? {
                          priceType: repriced.priceType,
                          originalPrice: repriced.originalPrice,
                          ...(isUnlisted ? {} : { overriddenBy: user?.sub ?? null }),
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
                    ...(repriced && !isManualOverride
                      ? { overrideReason: null, overriddenBy: null }
                      : {}),
                  },
                });
              }
            }
          }
        }

        await this.syncCompositions(tx, orderId);
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
              code: API_ERROR_CODES.ORDER_BELOW_RETURN_CREDIT,
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
        let creditGate: (() => Promise<void>) | null = null; // re-run after an inline return (SA-221)
        if (order.status !== "DRAFT") {
          await this.settleStockForEdit(tx, order, heldItems, activeItems, user, undefined, {
            allowOversell,
            blockCredits: carrierLocked,
            lineIdentity,
          });
          creditGate = () =>
            assertWithinCreditLimit(
              tx,
              order.customerId,
              orderId,
              // The exact total the order.update below writes — Σ of stored
              // computeLineSubtotal results + regular tax + category tax, cents-
              // rounded. Note: mirrors the existing edit recompute, which
              // (pre-existing) does not subtract Order.discountAmount.
              total,
              creditCheckEnabled,
              // B577: do the issued invoices survive this edit? Only a delivered, partially invoiced
              // order (re-sync skipped) is SURE to; pre-delivery a deposit mirror is rewritten.
              {
                invoicesSurviveEdit:
                  postDeliveryEdit && shouldSkipInPlaceResync(order.lineItems ?? []),
              },
            );
          await creditGate();
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
        // #2094: the return lands in THIS tx after the new total; the gate re-reads (SA-221 c3).
        inlineMinted = await applyReturn(tx, inlineRet, {
          customerId: order.customerId,
          orderId,
          user,
        });
        if (inlineRet && creditGate) await creditGate();
        return { subtotal, tax, total, shouldRevert, shippingFee };
      },
      // Headroom over Prisma's 5s default: the merge branch issues per-line
      // queries inside the transaction (same shape as create()'s in-tx per-line work).
      { timeout: 15_000 },
    );
    inlineReturn.emitInlineReturnCredit(inlineRet, this.prisma.getTenantId(), inlineMinted);

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

    return cancelledLines.readEditedOrder(this.prisma, orderId);
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
    await this.syncAndSettleOrderCredits(orderId, customerId, appliedCreditNotes);
  }

  private async syncCreateCredits(id: string, cId: string, n?: AppliedCreditNoteDto[]) {
    if (n === undefined) return;
    await savedCreditsPending(id, () => this.syncAndSettleOrderCredits(id, cId, n));
  }

  /**
   * The credit tx shared by create() and reconcileOrderAfterEdit (SA-706 MUST 2): the Order row
   * FIRST (SA-218 house order; tenant-less sessions lock by id), so the sync's OrderCreditNote insert
   * (FK KEY SHARE on the Order and the note) never upgrades against a second create applying the same
   * note. SA-269: the WHOLE tx re-runs on a 40001/40P01 conflict (bounded); every step is idempotent.
   * `undefined` skips the sync (an unverified replay must not re-point credits); settle still runs.
   */
  private async syncAndSettleOrderCredits(
    orderId: string,
    customerId: string,
    appliedCreditNotes: AppliedCreditNoteDto[] | undefined,
  ): Promise<void> {
    const tenantId = this.prisma.getTenantId();
    await retryCreditTx(`credit sync order=${orderId}`, () =>
      this.prisma.tenantTransaction(
        async (tx) => {
          await lockOrderRow(tx, tenantId, orderId);
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
      ),
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
        ...{ id: true, tenantId: true, fulfillPath: true, shippedAt: true }, // #3219 S4: carrier routing
        lineItems: { select: { qty: true, invoicedQty: true } },
      },
    });
    if (!order) {
      this.logger.warn(`replay reconcile skipped: order not found order=${orderId}`);
      return;
    }
    // Routed by the SAME rule as the fold (`resyncsInPlace`, order-carrier-guard.ts), on the order's
    // CURRENT state. That matches the fold's routing unless the state moved in between (a ship /
    // unmark after the fold committed changes `withCarrier`); then the current state decides.
    const carrierNow = await carrierGuard.carrierEditGuard(this, order); // #3219 S4: as the fold routed
    const postDeliveryEdit = carrierGuard.resyncsInPlace(order.status, carrierNow);
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

  /** P5-08: extracted verbatim to `order-revisions.ts` (SA-065 prefactor); thin delegator, same name. */
  private appendOrderRevision(...args: AppendOrderRevisionArgs) {
    return appendOrderRevisionImpl(this.prisma, ...args);
  }

  /** B283 / stock: extracted verbatim to `order-stock.ts` (B585 prefactor); thin delegators, same names. */
  private stockDeps() {
    return { logger: this.logger, tenantId: this.prisma.getTenantId() };
  }

  private decrementStockForSale(...args: StockArgs<typeof decrementStockForSale>) {
    return decrementStockForSale(this.stockDeps(), ...args);
  }

  private settleStockForEdit(...args: StockArgs<typeof settleStockForEdit>) {
    return settleStockForEdit(this.stockDeps(), ...args);
  }

  /**
   * WP3: whether the credit-limit check applies to this tenant — see `credit-limit-guard.ts`
   * (B585 prefactor). MUST be called BEFORE opening an interactive transaction (pool starvation).
   */
  private isCreditLimitCheckEnabled(): Promise<boolean> {
    return isCreditLimitCheckEnabled({
      prisma: this.prisma,
      entitlements: this.entitlements,
      logger: this.logger,
    });
  }

  /** B585: the credit check at an enforcement point; MUST run before any write / stock tx. */
  private creditGate(p: CreditPointParams): Promise<void> {
    return assertCreditAtEnforcementPoint(
      { prisma: this.prisma, entitlements: this.entitlements, logger: this.logger },
      { ...p, tenantId: this.prisma.getTenantId() },
    );
  }

  /**
   * P5-09: public credit re-check for the change-request next-delivery path.
   * Reuses the ONE exposure derivation (assertWithinCreditLimit →
   * loadCreditExposure) — never a second balance formula.
   */
  async assertCreditForProjectedOrder(
    customerId: string,
    excludeOrderId: string,
    projectedTotal: number,
  ): Promise<void> {
    await assertWithinCreditLimit(
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
      throw new ConflictException({
        code: API_ERROR_CODES.CHANGE_REQUEST_ALREADY_RESOLVED,
        status: cr.status,
      });
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
      throw atStopConflict(CHANGE_WINDOW_ORDER_STATUS);
    }
    if (order.routeRun == null || order.routeRun.status !== "IN_PROGRESS") {
      throw atStopConflict(CHANGE_WINDOW_RUN_NOT_ACTIVE);
    }
    if (
      order.routeRunStop != null &&
      ["COMPLETED", "SKIPPED"].includes(order.routeRunStop.status)
    ) {
      throw atStopConflict(API_ERROR_CODES.STOP_ALREADY_COMPLETED);
    }

    // NOTE-type requests carry no money delta: claim + return, nothing else.
    if (cr.type === ChangeRequestType.NOTE) {
      // SA-434: claimed under the Order lock with the driver predicate re-derived.
      const claimed = await driverAccess.underOrderLockForDriver(
        this.prisma,
        order.id,
        resolver,
        (tx) =>
          tx.changeRequest.updateMany({
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
          }),
      );
      if (claimed.count !== 1) {
        throw new ConflictException({ code: API_ERROR_CODES.CHANGE_REQUEST_ALREADY_RESOLVED });
      }
      const subtotal = Number(order.subtotal);
      const tax = Number(order.tax);
      return { merged: true, subtotal, tax, total: Number(order.total) };
    }

    // units_v1: refuse only when the request TARGETS a unit-aware line.
    unitAware.assertChangeTargetAllowed(order.lineItems, cr, payload);

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

    // Lane R: an at-door add / qty raise of a banned product refuses (409 SELLING_RESTRICTED) BEFORE
    // the tx; OFF = one policy read. Re-checked under the row lock below (change-request-restrictions.ts).
    const tenantId = this.restrictionTenantId(resolver, order.tenantId);
    const restrictionPlan = await planChangeRequestRestrictions(
      { restrictions: this.sellingRestrictions },
      { tenantId, existing: order.lineItems ?? [], cr },
    );
    if (restrictionPlan)
      await this.sellingRestrictions.assertLinesSellable({
        tenantId,
        customerId: order.customerId,
        lines: restrictionPlan.lines,
        channel: restrictionChannelForPrincipal(resolver),
      });

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
    const carrier = await carrierGuard.carrierEditGuard(this, order); // SA-696, read off the tx's connection

    const { subtotal, tax, total, shippingFee } = await this.prisma.tenantTransaction(
      async (tx: any) => {
        // WP1/F2: same in-transaction snapshot as updateOrderItems — lock the
        // order row so a concurrent web PATCH of this order serializes behind
        // (or ahead of) this at-door merge, then read the pre-edit lines
        // inside the tx. `order` above was fetched before the tx opened; its
        // lineItems drive the stock delta and would otherwise be stale.
        await tx.$executeRaw`SELECT id FROM "Order" WHERE id = ${order.id} FOR UPDATE`;
        await driverAccess.assertDriverMayEditOrder(tx, order.id, resolver); // SA-434: re-derived under the lock

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
          throw atStopConflict(CHANGE_WINDOW_ORDER_STATUS);
        }
        if (live.routeRun == null || live.routeRun.status !== "IN_PROGRESS") {
          throw atStopConflict(CHANGE_WINDOW_RUN_NOT_ACTIVE);
        }
        if (
          live.routeRunStop != null &&
          ["COMPLETED", "SKIPPED"].includes(live.routeRunStop.status)
        ) {
          throw atStopConflict(API_ERROR_CODES.STOP_ALREADY_COMPLETED);
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
          select: { ...EXISTING_LINE_SELECT, deliveredQty: true },
        });
        restrictionPlan?.assertHeld(heldItems);

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
          throw new ConflictException({ code: API_ERROR_CODES.CHANGE_REQUEST_ALREADY_RESOLVED });
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
            throw new ConflictException({ code: API_ERROR_CODES.LINE_ALREADY_DELIVERED });
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
              code: API_ERROR_CODES.CONCURRENT_UPDATE,
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
          assertSellableLines([product]); // WS8: a door ADD_ITEM never lands a FAMILY line
          // B297 (SA-098a): only reached below when this is a genuinely NEW line —
          // an existing-line quantity bump preserves its stored trio untouched.
          const addItemCategoryMap = await loadCategoryMapForProducts(tx, [product]);
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
                // B297 (SA-098a): a fresh at-door line is a new sale — stamp the trio.
                ...categoryTaxSnapshotOf(
                  product.trackedCategoryId
                    ? (addItemCategoryMap.get(product.trackedCategoryId) ?? null)
                    : null,
                ),
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

        await this.syncCompositions(tx, order.id);
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
        const blockCredits = await carrierGuard.blockCreditsUnderLock(tx, order.id, carrier); // SA-696
        await this.settleStockForEdit(tx, order, heldItems, activeItems, resolver, undefined, {
          blockCredits,
        });
        await assertWithinCreditLimit(tx, order.customerId, order.id, total, creditCheckEnabled);

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
  /** Extracted verbatim to `order-lifecycle.ts` (size-ratchet headroom move); thin delegator. */
  async updateShipment(orderId: string, dto: UpdateShipmentDto, _user?: JwtPayload) {
    return updateShipmentImpl(this, orderId, dto, _user);
  }

  /** Extracted verbatim to `order-lifecycle.ts` (size-ratchet headroom move); thin delegator. */
  async updateFulfillPath(orderId: string, dto: UpdateFulfillPathDto, _user?: JwtPayload) {
    return updateFulfillPathImpl(this, orderId, dto, _user);
  }

  /** Extracted verbatim to `order-lifecycle.ts` (size-ratchet headroom move); thin delegator. */
  async toggleUrgent(id: string, user: JwtPayload, urgent?: boolean) {
    return toggleUrgentImpl(this, id, user, urgent);
  }

  /** Extracted verbatim to `order-lifecycle.ts` (size-ratchet headroom move); thin delegator. */
  async applyBuyerMergeHeader(
    orderId: string,
    header: { notes?: string; urgent?: boolean; requestedDeliveryDate?: string },
    user: JwtPayload,
  ): Promise<void> {
    return applyBuyerMergeHeaderImpl(this, orderId, header, user);
  }

  /** The order-tracking card (route / driver / stop / delivery window) — see `order-tracking.ts`. */
  getOrderTracking(orderId: string, user: JwtPayload) {
    return getOrderTracking({ prisma: this.prisma }, orderId, user);
  }

  /**
   * Delete-any (owner 2026-08-25): staff may delete an order in ANY status —
   * DELIVERED included — behind the client's explicit warning. Money, not
   * status, is the gate now. `user` is optional so internal callers keep
   * working (change-requests' abandoned-draft cleanup passes none).
   *
   * NOT extracted to `order-lifecycle.ts` with its siblings below — it is the one
   * method in that region with a direct `orderItem`/`invoiceItem` write, which
   * `unit-line-writers.ast.spec.ts`'s AST scanner only tracks inside a CLASS
   * method (`ts.isClassDeclaration`); a top-level function in a sibling file is
   * invisible to it. Kept here so the guard's coverage stays intact.
   */
  async deleteOrder(id: string, user?: JwtPayload) {
    const order = await this.prisma.forTenant().order.findUnique({
      where: { id },
      include: { invoices: { select: { id: true } }, transaction: { select: { id: true } } },
    });
    if (!order) throw new NotFoundException("Order not found");
    // B1082: a parcel with the carrier is returned, not deleted (credits its stock back otherwise).
    throwIfWithCarrier(await carrierGuard.carrierBlocked(this, order));

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

  /** Extracted verbatim to `order-lifecycle.ts` (size-ratchet headroom move); thin delegator. */
  async setCommissionRate(orderId: string, ratePct: number | null, user: JwtPayload) {
    return setCommissionRateImpl(this, orderId, ratePct, user);
  }

  /** Extracted verbatim to `order-lifecycle.ts` (size-ratchet headroom move); thin delegator. */
  async bulkDeleteOrders(ids: string[], user?: JwtPayload) {
    return bulkDeleteOrdersImpl(this, ids, user);
  }

  /** Extracted verbatim to `order-lifecycle.ts` (size-ratchet headroom move); thin delegator. Not
   * `private`: called from sibling extracted functions (toggleUrgent/setCommissionRate) there. */
  async findOneOrThrow(id: string) {
    return findOneOrThrowImpl(this, id);
  }
}
