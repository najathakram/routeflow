import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiHeader } from "@nestjs/swagger";
import { Throttle } from "@nestjs/throttler";
import { OrderStatus, UserRole, UserStatus } from "@prisma/client";
import { BuyerService } from "./buyer.service";
import { BuyerCatalogService } from "./buyer-catalog.service";
import { BuyerDashboardService } from "./buyer-dashboard.service";
import { ReplenishmentService } from "./replenishment.service";
import { ShelfService } from "./shelf.service";
import { StockAlertService } from "../stock-alerts/stock-alert.service";
import { PromotionsService } from "../promotions/promotions.service";
import { BuyerJwtAuthGuard, PublicBuyer } from "./guards/buyer-jwt-auth.guard";
import { BuyerSellerContextGuard } from "./guards/buyer-seller-context.guard";
import { BuyerTenantInterceptor } from "./buyer-tenant.interceptor";
import { CurrentBuyer, CurrentBuyerCustomer } from "./decorators/current-buyer.decorator";
import type { BuyerJwtPayload } from "./interfaces/buyer-jwt-payload.interface";
import { ForbiddenException, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { RequestSellerDto } from "./dto/request-seller.dto";
import { PrismaService } from "../prisma/prisma.service";
import { BuyerCreateOrderDto } from "./dto/buyer-create-order.dto";
import { UpdateBuyerProfileDto } from "./dto/update-buyer-profile.dto";
import { OrdersService } from "../orders/orders.service";
import { ChangeRequestsService } from "../orders/change-requests.service";
import { CreateChangeRequestDto } from "../orders/dto/create-change-request.dto";
import { InvoicesService } from "../invoices/invoices.service";
import { InvoicePdfService } from "../invoices/invoice-pdf.service";
import { StatementService } from "./statement.service";
import { StatementPdfService } from "./statement-pdf.service";
import { CustomersService } from "../customers/customers.service";
import { OrderTemplatesService } from "../order-templates/order-templates.service";
import { AuthorizationsService } from "../authorizations/authorizations.service";
import { SystemConfigService } from "../system-config/system-config.service";
import { ListOrdersDto } from "../orders/dto/list-orders.dto";
import { ListInvoicesDto } from "../invoices/dto/list-invoices.dto";
import { UpdateOrderItemsDto } from "../orders/dto/update-order-items.dto";
import { SubmitAuthorizationDto } from "../authorizations/dto/submit-authorization.dto";
import { normalizeScanCode, pickBestScanMatch } from "../common/barcode-normalize";
import { redactUpsellForCustomer } from "../common/upsell-redaction";
import {
  foldMergeItems,
  normalizeBareIncomingSellingUnits,
  normalizeBoxUnawareSnapshots,
} from "../orders/merge-items";
import { withAdvisoryLock } from "../common/db-locks";
import {
  LOCK_UNAVAILABLE,
  LOCK_UNAVAILABLE_MESSAGE,
  isMergeContention,
  mapLockError,
} from "../orders/merge-contention";

/** Upper bound on `GET /buyer/products?ids=` — a cart is far smaller than this. */
const MAX_PRODUCT_IDS = 200;

/**
 * Builds a JwtPayload that looks like a tenant user.
 * Used so existing tenant services can scope their queries correctly:
 *   - `sub`      → User.id (the Customer's user account; may be null for portal-only buyers)
 *   - `role`     → defaults to CUSTOMER; pass OPERATOR to skip userId-lookup paths in services
 *   - `tenantId` → from BuyerSellerContextGuard (set by BuyerTenantInterceptor ALS run)
 */
function makePseudoUser(ctx: {
  userId?: string | null;
  tenantId: string;
  tenantSlug: string;
  role?: UserRole;
}): JwtPayload {
  return {
    sub: ctx.userId ?? "",
    username: "",
    role: ctx.role ?? UserRole.CUSTOMER,
    status: UserStatus.ACTIVE,
    forcePasswordChange: false,
    tenantId: ctx.tenantId,
    tenantSlug: ctx.tenantSlug,
  };
}

@ApiTags("buyer")
@Controller("buyer")
@UseGuards(BuyerJwtAuthGuard)
@ApiBearerAuth()
export class BuyerController {
  private readonly logger = new Logger(BuyerController.name);

  constructor(
    private readonly buyerService: BuyerService,
    private readonly catalogService: BuyerCatalogService,
    private readonly dashboardService: BuyerDashboardService,
    private readonly replenishmentService: ReplenishmentService,
    private readonly shelfService: ShelfService,
    private readonly stockAlertService: StockAlertService,
    private readonly promotionsService: PromotionsService,
    private readonly ordersService: OrdersService,
    private readonly changeRequestsService: ChangeRequestsService,
    private readonly invoicesService: InvoicesService,
    private readonly invoicePdfService: InvoicePdfService,
    private readonly statementService: StatementService,
    private readonly statementPdfService: StatementPdfService,
    private readonly customersService: CustomersService,
    private readonly templatesService: OrderTemplatesService,
    private readonly authorizationsService: AuthorizationsService,
    private readonly prisma: PrismaService,
    private readonly systemConfigService: SystemConfigService,
  ) {}

  // ─── Unscoped endpoints (no seller context needed) ────────────────────────────

  @Get("sellers")
  @ApiOperation({ summary: "List all sellers the buyer is connected or invited to" })
  getSellers(@CurrentBuyer() buyer: BuyerJwtPayload) {
    return this.buyerService.getSellers(buyer.sub);
  }

  @Get("invites/:token/details")
  @PublicBuyer()
  @ApiOperation({ summary: "Preview invite details before accepting (no auth required)" })
  getInviteDetails(@Param("token") token: string) {
    return this.buyerService.getInviteDetails(token);
  }

  @Post("invites/:token/accept")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Accept a seller invite and link the buyer account" })
  acceptInvite(@Param("token") token: string, @CurrentBuyer() buyer: BuyerJwtPayload) {
    return this.buyerService.acceptInvite(token, buyer.sub);
  }

  @Post("sellers/request")
  @HttpCode(HttpStatus.OK)
  // F4: this endpoint is an email-enumeration surface (a matching customer at the
  // seller is a connect request; a non-match is a 404). Tighten beyond the global
  // throttle. 10/min still comfortably covers a buyer connecting to several sellers.
  @Throttle({ default: { ttl: 60_000, limit: 10 } })
  @ApiOperation({ summary: "Request to connect with a seller by slug" })
  requestSeller(@CurrentBuyer() buyer: BuyerJwtPayload, @Body() dto: RequestSellerDto) {
    return this.buyerService.requestSeller(buyer.sub, dto);
  }

  @Delete("sellers/:sellerSlug")
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: "Disconnect self from a seller" })
  disconnectFromSeller(
    @CurrentBuyer() buyer: BuyerJwtPayload,
    @Param("sellerSlug") sellerSlug: string,
  ) {
    return this.buyerService.disconnectSelf(buyer.sub, sellerSlug);
  }

  // ─── Seller-scoped endpoints (require X-Tenant-Slug + active CustomerLink) ────

  @Get("profile")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Get buyer's customer profile at the selected seller" })
  getProfile(@CurrentBuyerCustomer() ctx: any) {
    return ctx.customer;
  }

  @Get("orders")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "List buyer's orders at the selected seller" })
  async getOrders(@CurrentBuyerCustomer() ctx: any, @Query() query: ListOrdersDto) {
    // Inject customerId directly so ordersService.findAll() doesn't need to look
    // up the customer by userId (which is null for buyer-portal-only accounts).
    const result = await this.ordersService.findAll(
      { ...query, customerId: ctx.customerId },
      makePseudoUser({ ...ctx, role: UserRole.OPERATOR }),
    );
    // findAll runs as an OPERATOR pseudo-user, so the service-layer customer
    // redaction never fires — strip upsell bases here at the buyer boundary.
    result.data.forEach((order) => redactUpsellForCustomer(order));
    return result;
  }

  @Get("invoices")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "List buyer's invoices at the selected seller" })
  getInvoices(@CurrentBuyerCustomer() ctx: any, @Query() query: ListInvoicesDto) {
    // Inject customerId directly; pass OPERATOR role so invoicesService.findAll()
    // uses the where.customerId path rather than the userId-lookup path.
    // Buyers must never see DRAFT invoices — exclude them unless caller specified a status.
    const buyerQuery: ListInvoicesDto = { ...query, customerId: ctx.customerId };
    if (!buyerQuery.status && (!buyerQuery.statuses || buyerQuery.statuses.length === 0)) {
      buyerQuery.statuses = [
        "SENT",
        "VIEWED",
        "PARTIAL",
        "OVERDUE",
        "PAID",
        "VOID",
        "WRITTEN_OFF",
      ] as any;
    }
    return this.invoicesService.findAll(
      buyerQuery,
      makePseudoUser({ ...ctx, role: UserRole.OPERATOR }),
    );
  }

  @Get("invoices/:id")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Get invoice detail with items and payments" })
  async getInvoice(@Param("id") id: string, @CurrentBuyerCustomer() ctx: any) {
    const invoice = await this.invoicesService.findOne(id);
    // Ownership check: invoice must belong to this buyer's customer
    if ((invoice as any).customerId !== ctx.customerId) {
      throw new ForbiddenException("This invoice does not belong to your account");
    }
    // Mark as viewed if not already
    if (!(invoice as any).viewedAt) {
      await this.prisma.forTenant().invoice.update({
        where: { id },
        data: { viewedAt: new Date() },
      });
    }
    if ((invoice as any).pdfUrl) {
      (invoice as any).pdfUrl = await this.invoicePdfService.getOrGenerate(id);
    }
    // findOne was called without a user, so its customer redaction didn't fire —
    // strip upsell bases here at the buyer boundary.
    redactUpsellForCustomer(invoice as any);
    return invoice;
  }

  @Get("statement")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Get buyer's account statement at the selected seller" })
  getStatement(@CurrentBuyerCustomer() ctx: any) {
    return this.customersService.getStatementForOperator(ctx.customerId);
  }

  @Get("statements")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "List month buckets available for statement PDFs (P5-15)" })
  getStatementMonths(@CurrentBuyerCustomer() ctx: any) {
    return this.statementService.listAvailableMonths(ctx.customerId);
  }

  @Get("statements/:month")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({
    summary: "Generate the monthly statement PDF + return its presigned URL (P5-15)",
  })
  async getStatementPdf(@Param("month") month: string, @CurrentBuyerCustomer() ctx: any) {
    // The URL is presigned (R2 GET or local HMAC) — browser downloads it WITHOUT
    // a JWT (no 401). Month format validated inside buildMonthlyStatement (400).
    const url = await this.statementPdfService.generateAndUpload(ctx.customerId, month);
    return { url };
  }

  @Get("payments")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Paginated payment history across the buyer's invoices (P5-14)" })
  async getPayments(
    @CurrentBuyerCustomer() ctx: any,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
  ) {
    const parsedPage = Number(page);
    const parsedLimit = Number(limit);
    const pageNum = Number.isFinite(parsedPage) && parsedPage >= 1 ? Math.floor(parsedPage) : 1;
    const limitNum =
      Number.isFinite(parsedLimit) && parsedLimit >= 1
        ? Math.min(Math.floor(parsedLimit), 100)
        : 20;

    const db = this.prisma.forTenant();
    const where = { invoice: { customerId: ctx.customerId } };
    const [rows, total] = await Promise.all([
      db.invoicePayment.findMany({
        where,
        include: { invoice: { select: { invoiceNumber: true } } },
        orderBy: { paidAt: "desc" },
        skip: (pageNum - 1) * limitNum,
        take: limitNum,
      }),
      db.invoicePayment.count({ where }),
    ]);

    return {
      // Stored money only — amounts read back, never computed here.
      data: rows.map((p) => ({
        id: p.id,
        invoiceId: p.invoiceId,
        invoiceNumber: p.invoice.invoiceNumber,
        amount: Number(p.amount),
        method: p.method,
        status: p.status,
        checkStatus: p.checkStatus ?? null,
        nsfFeeAmount: p.nsfFeeAmount != null ? Number(p.nsfFeeAmount) : null,
        paidAt: p.paidAt.toISOString(),
      })),
      meta: {
        total,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.max(1, Math.ceil(total / limitNum)),
      },
    };
  }

  @Get("remittance")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Seller's how-to-pay / remittance instructions (P5-14)" })
  getRemittance() {
    // Tenant set by BuyerTenantInterceptor → SystemConfigService.get()'s
    // forTenant() resolves the SELLER's config. Buyer-visible by design.
    return this.systemConfigService.getRemittanceConfig();
  }

  // ─── Product catalog ──────────────────────────────────────────────────────────

  @Get("products/categories")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "List distinct product categories for filter dropdowns" })
  getCategories() {
    return this.catalogService.getCategories();
  }

  @Get("products/counts")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Category-rail counts: per-category + smart collections + locked" })
  getCatalogCounts(@CurrentBuyer() buyer: BuyerJwtPayload, @CurrentBuyerCustomer() ctx: any) {
    return this.catalogService.getCatalogCounts(ctx.customerId, buyer.sub);
  }

  @Get("products")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Browse product catalog with buyer-specific pricing" })
  getProducts(
    @CurrentBuyer() buyer: BuyerJwtPayload,
    @CurrentBuyerCustomer() ctx: any,
    @Query("search") search?: string,
    @Query("category") category?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("sort") sort?: string,
    @Query("collection") collection?: string,
    @Query("ids") ids?: string,
  ) {
    const parsedPage = page ? Number(page) : undefined;
    const parsedLimit = limit ? Number(limit) : undefined;
    const validCollections = ["usuals", "favorites", "new", "deals"];
    // Explicit id filter (cart pricing): resolve exactly these products rather
    // than paging the catalog. Capped so a crafted query can't fetch-all.
    const parsedIds = ids
      ? [
          ...new Set(
            ids
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean),
          ),
        ].slice(0, MAX_PRODUCT_IDS)
      : undefined;
    return this.catalogService.getCatalog(
      {
        search,
        category,
        ids: parsedIds?.length ? parsedIds : undefined,
        page: Number.isFinite(parsedPage) && parsedPage! >= 1 ? parsedPage : undefined,
        limit: Number.isFinite(parsedLimit) && parsedLimit! >= 1 ? parsedLimit : undefined,
        sort,
        collection: validCollections.includes(collection ?? "")
          ? (collection as "usuals" | "favorites" | "new" | "deals")
          : undefined,
      },
      ctx.customerId,
      buyer.sub,
    );
  }

  @Get("products/:id")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Get single product detail with buyer-specific pricing" })
  async getProduct(@Param("id") id: string, @CurrentBuyerCustomer() ctx: any) {
    const detail = await this.catalogService.getProductDetail(id, ctx.customerId);
    const alertSubscribed = await this.stockAlertService.isSubscribed(ctx.customerId, id);
    return { ...detail, alertSubscribed };
  }

  // F30/R12 (B200): customer-role scanning had NO reachable rung at all —
  // GET /products and GET /products/barcode are @Roles(OPERATOR, DRIVER), so
  // every buyer-side scan attempt 403'd on both. This reuses the SAME
  // normalize/match functions ProductsService.findByBarcode is built on
  // (normalizeScanCode's candidate-set match across barcode/sku/unitSku, so a
  // scan resolves regardless of which symbology the decoder picked, then
  // pickBestScanMatch's deterministic tie-break) — called here directly
  // against this.prisma (already injected) rather than via ProductsService,
  // so this endpoint adds no new constructor dependency. The result is routed
  // through getProductDetail — the SAME isActive + regulated-category
  // visibility gate every other buyer-catalog surface on this controller
  // already enforces — so a scan can never surface a product this buyer isn't
  // allowed to see.
  @Get("products/scan/:code")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Resolve a scanned barcode/sku/unitSku against the buyer's catalog" })
  async scanProduct(@Param("code") code: string, @CurrentBuyerCustomer() ctx: any) {
    const candidates = normalizeScanCode(code);
    if (candidates.length === 0) throw new NotFoundException("Product not found");

    const db = this.prisma.forTenant();
    // Tier 1 — exact (mirrors ProductsService.findByBarcode).
    let matches = await db.product.findMany({
      where: {
        OR: [
          { barcode: { in: candidates } },
          { sku: { in: candidates } },
          { unitSku: { in: candidates } },
        ],
      },
    });
    // Tier 2 — case-insensitive, MISS ONLY (typed/lowercased alpha SKUs).
    if (matches.length === 0) {
      matches = await db.product.findMany({
        where: {
          OR: candidates.flatMap((c) => [
            { barcode: { equals: c, mode: "insensitive" as const } },
            { sku: { equals: c, mode: "insensitive" as const } },
            { unitSku: { equals: c, mode: "insensitive" as const } },
          ]),
        },
        take: 25,
      });
    }
    if (matches.length === 0) throw new NotFoundException("Product not found");
    const match = pickBestScanMatch(matches, candidates);

    const detail = await this.catalogService.getProductDetail(match.id, ctx.customerId);
    const alertSubscribed = await this.stockAlertService.isSubscribed(ctx.customerId, match.id);
    return { ...detail, alertSubscribed };
  }

  // ─── Licenses (W7b expiry bell) ───────────────────────────────────────────────

  @Get("authorizations/expiring")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "The buyer's own expiring/expired licenses at this seller" })
  expiringAuthorizations(@CurrentBuyerCustomer() ctx: any) {
    return this.authorizationsService.findExpiringForCustomer(ctx.customerId);
  }

  // ─── Order CRUD ───────────────────────────────────────────────────────────────

  @Get("orders/active")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Get the buyer's active DRAFT/PENDING order (or null)" })
  async getActiveOrder(@CurrentBuyerCustomer() ctx: any) {
    const order = await this.ordersService.findActiveOrder(ctx.customerId);
    return redactUpsellForCustomer(order);
  }

  @Get("orders/:id")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Get order detail with line items" })
  getOrder(@Param("id") id: string, @CurrentBuyerCustomer() ctx: any) {
    return this.ordersService.findOne(id, makePseudoUser(ctx));
  }

  @Get("orders/:id/tracking")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Get live delivery tracking (route/stop/ETA) for an order" })
  getOrderTrackingForBuyer(@Param("id") id: string, @CurrentBuyerCustomer() ctx: any) {
    // Reuses the SAME service method + ownership-check shape as the staff-side
    // GET /orders/:id/tracking (orders.controller.ts) — zero new business logic.
    // makePseudoUser(ctx) defaults role: CUSTOMER, matching getOrder() directly
    // above — NOT the role: OPERATOR workaround getTemplates() uses further
    // down. That workaround is specific to OrderTemplatesService's own
    // customerId-based lookup path; getOrderTracking()'s ownership gate is the
    // IDENTICAL userId-based check findOne() already uses for getOrder()'s own
    // ordersService.findOne(id, makePseudoUser(ctx)) call one method up, which
    // buyer order reads already rely on in production. No new risk introduced.
    return this.ordersService.getOrderTracking(id, makePseudoUser(ctx));
  }

  @Post("orders")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Create a new order or merge into existing active order" })
  async createOrder(@Body() dto: BuyerCreateOrderDto, @CurrentBuyerCustomer() ctx: any) {
    // Check if buyer has an active DRAFT/PENDING order (unless forceNew is set)
    if (!dto.forceNew) {
      // IMP-02 (R2 companion): this is the SAME read-fold-absolute-write critical
      // section the staff merge guards, over the SAME rows — findActiveOrder →
      // foldMergeItems → updateOrderItems({ replaceAll: true }) writes ABSOLUTE
      // totals folded from the snapshot read at the top. Without the lock a staff
      // merge (or a second buyer submit) committing between that read and this
      // write is silently overwritten — a lost update on money, on ONE replica.
      // Same family + customer key as the staff path and OrdersService's sweeps,
      // so all of them serialize against each other across replicas.
      //
      // ⚠️ The sibling sweep and the response read below stay OUTSIDE the lock on
      // purpose: `mergeAllPendingForCustomer` takes this very (family, key) itself,
      // and a nested acquire runs on a DIFFERENT pooled connection — nested, it can
      // only lose to the lock this call already holds (under `wait`, by blocking until
      // lock_timeout and 409-ing every buyer merge; under the `try` the sweep now uses,
      // by deferring every single time, so the sweep would never run at all). This
      // mirrors the staff controller, which likewise sweeps and re-reads after its lock
      // has been released.
      let mergedOrderId: string | null = null;
      try {
        const lock = await withAdvisoryLock(
          // 10s, not the module default of 20s: the mobile api client aborts every request
          // at 15s (apps/mobile/lib/api-client.ts), so a 20s wait can only ever be seen by
          // the operator as a client-side timeout — the 409 that tells them to retry must be
          // reachable inside that budget. This PRE-commit acquire is the only one on this path
          // that waits at all: both POST-COMMIT consolidations below pass `{ lockMode: "try" }`,
          // and only the sweep/force paths (no client attached) take the service's 20s wait.
          { family: "order-merge", key: ctx.customerId, mode: "wait", waitMs: 10_000 },
          async () => {
            const activeOrder = await this.ordersService.findActiveOrder(ctx.customerId);
            if (!activeOrder) return null;
            // REG-B47: denomination-aware fold (F30's staff exemplar, shared module) over
            // LIVE-normalized snapshots — a box-unaware line of a boxed product counts
            // selling units, so give the fold its real box split before summing.
            // REG-B51: unlisted lines are server-preserved by updateOrderItems now —
            // filter them out of the payload entirely (single owner).
            const lineItems = activeOrder.lineItems ?? [];
            const incomingItems = dto.items ?? [];
            // REG-B47, denomination convention: on every BUYER path a bare `{productId,
            // qty}` counts SELLING UNITS, never loose pieces — create() stores such a
            // line box-unaware and bills qty x the BOX price, and both cart builders say
            // so out loud (shelf.service.ts lowItems(), mobile shelf-logic.ts's header).
            // foldMergeItems was written for the STAFF scan path, where a bare incoming
            // qty IS a loose piece, so the two halves of the fold must be reconciled per
            // denomination pair (see merge-items.ts): a box-UNAWARE stored line is
            // rewritten only when its incoming counterpart carries a split, and a bare
            // incoming item is expanded only when the STORED line is box-split (where
            // the accumulator is in pieces). Where both sides are bare they already
            // agree in selling units and neither is touched.
            const boxAwareIncoming = new Set(
              incomingItems
                .filter((i) => i.boxes != null || i.pieces != null)
                .map((i) => i.productId),
            );
            const productIds = lineItems
              .map((li: { productId?: string | null }) => li.productId)
              .filter((id: string | null | undefined): id is string => !!id);
            const products = productIds.length
              ? await this.prisma.forTenant().product.findMany({
                  where: { id: { in: productIds } },
                  select: { id: true, unitsPerBox: true },
                })
              : [];
            const upbByProduct = new Map(products.map((p) => [p.id, Number(p.unitsPerBox ?? 0)]));
            const upbForStoredSnapshots = new Map(
              [...upbByProduct].filter(([id]) => boxAwareIncoming.has(id)),
            );
            // ⚠️ The fold's R0/R11 price-survival contract ("a merge is never where an
            // operator's price override silently disappears") does NOT hold on THIS
            // caller, and not because of anything here: `updateOrderItems`' CUSTOMER
            // branch re-prices every catalog line through `resolveBuyerLinePrice` and
            // never reads `item.unitPrice`, so a preserved MANUAL override is dropped
            // and the line re-prices at the tier ladder. That is pre-existing (the
            // naive merge dropped it too) and B13-correct in posture — a buyer payload
            // must never set a price — but it means an operator's courtesy price on the
            // buyer's active order does not survive the buyer adding to it. Filed as a
            // register entry rather than fixed here: the fix belongs in the CUSTOMER
            // branch (honour a STORED override, still never a client-supplied one),
            // which is F07's file region.
            const mergedItems = foldMergeItems(
              normalizeBoxUnawareSnapshots(lineItems, upbForStoredSnapshots),
              normalizeBareIncomingSellingUnits(incomingItems, lineItems, upbByProduct),
            ).filter((i) => i.productId);
            await this.ordersService.updateOrderItems(
              activeOrder.id,
              { items: mergedItems, replaceAll: true } as UpdateOrderItemsDto,
              makePseudoUser(ctx),
            );
            // REG-B78: carry the buyer's header fields onto the merged order (append/OR/set
            // semantics) BEFORE the sibling-order sweep, so they land on the surviving order.
            // BEST-EFFORT ON PURPOSE: the line write above has already COMMITTED (it runs in
            // its own transaction), so a throw here would report a merge that DID land as a
            // failure. The cart clears only on success, so the buyer would re-submit — and
            // the fold above computes ABSOLUTE totals, so the same cart would be added a
            // second time. Losing a note/urgent flag is far cheaper than a double order; the
            // realistic failure is a concurrent sweep consolidating this order away between
            // the two calls, which the sweep below reconciles anyway.
            try {
              await this.ordersService.applyBuyerMergeHeader(
                activeOrder.id,
                {
                  notes: dto.notes,
                  urgent: dto.urgent,
                  requestedDeliveryDate: dto.requestedDeliveryDate,
                },
                makePseudoUser(ctx),
              );
            } catch (err) {
              this.logger.error(
                `Buyer merge header (notes/urgent/date) not applied to order ${activeOrder.id}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
              );
            }

            return activeOrder.id;
          },
        );
        // `wait` mode either acquires or throws, so this is defensive only — but it must NOT
        // collapse into `null`. That is the same value "this customer has no active order"
        // produces, and it would fall through to the create path below: a buyer whose merge
        // never ran would silently get a SECOND order instead of the retryable signal. Same
        // coded body as mapLockError's 503, so `isMergeContention` recognises it downstream
        // exactly as it does on the staff path and in the service.
        if (!lock.acquired) {
          throw new ServiceUnavailableException({
            code: LOCK_UNAVAILABLE,
            message: LOCK_UNAVAILABLE_MESSAGE,
          });
        }
        mergedOrderId = lock.value;
      } catch (lockErr) {
        mapLockError(lockErr);
      }

      if (mergedOrderId) {
        // Sweep any other PENDING orders for this customer into the winner. The
        // buyer drove this, so a merged BUY_N_GET_M line earns the free units the
        // combined quantity qualifies for (split carts keep the promo).
        //
        // POST-COMMIT (see ../orders/merge-contention.ts): the fold inside the lock has already
        // committed and the buyer's cart clears on success, so a 409 here would send them back
        // to a cart they already submitted — and the fold is ABSOLUTE, so re-submitting doubles
        // the order. Contention is deferred: warn and return the merged order.
        // `lockMode: "try"`: this consolidation is deferrable by construction, so it must not
        // wait out another holder's turn inside a request whose write already landed.
        try {
          await this.ordersService.mergeAllPendingForCustomer(
            ctx.customerId,
            { buyerInitiated: true },
            { lockMode: "try" },
          );
        } catch (e) {
          if (!isMergeContention(e)) throw e;
          this.logger.warn(
            `post-commit consolidation deferred (merge in progress) tenant=${ctx.tenantId} customer=${ctx.customerId}`,
          );
        }

        // Return the updated order
        return this.ordersService.findOne(mergedOrderId, makePseudoUser(ctx));
      }
    }

    // No active order or forceNew — create a new one
    const createDto = {
      items: dto.items.map((item) => ({
        productId: item.productId,
        qty: item.qty,
        boxes: item.boxes,
        pieces: item.pieces,
        notes: item.notes,
      })),
      notes: dto.notes,
      urgent: dto.urgent,
      requestedDeliveryDate: dto.requestedDeliveryDate,
      status: dto.status ?? "PENDING",
    };
    const created = await this.ordersService.create(createDto as any, makePseudoUser(ctx));
    // Newly-created order may share a customer with pre-existing PENDINGs —
    // consolidate them so the customer ends up with a single PENDING (buyer-driven,
    // so the merged quantity earns its own BUY_N_GET_M free units).
    //
    // POST-COMMIT (see ../orders/merge-contention.ts): `created` exists already, so contention
    // must not become the response — the buyer would be told their order failed and would place
    // a second one. Return the unconsolidated order; the hourly sweep folds it later.
    let merged: Awaited<ReturnType<OrdersService["mergeAllPendingForCustomer"]>> | null = null;
    try {
      merged = await this.ordersService.mergeAllPendingForCustomer(
        ctx.customerId,
        { buyerInitiated: true },
        // POST-COMMIT: never wait — see the sibling sweep above.
        { lockMode: "try" },
      );
    } catch (e) {
      if (!isMergeContention(e)) throw e;
      this.logger.warn(
        `post-commit consolidation deferred (merge in progress) tenant=${ctx.tenantId} customer=${ctx.customerId}`,
      );
    }
    return merged ?? created;
  }

  @Patch("orders/:id/items")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Edit items on a DRAFT/PENDING order" })
  updateOrderItems(
    @Param("id") id: string,
    @Body() dto: UpdateOrderItemsDto,
    @CurrentBuyerCustomer() ctx: any,
  ) {
    return this.ordersService.updateOrderItems(id, dto, makePseudoUser(ctx));
  }

  @Post("orders/:id/change-requests")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "File a post-dispatch change request against an order" })
  createChangeRequest(
    @Param("id") id: string,
    @Body() dto: CreateChangeRequestDto,
    @CurrentBuyerCustomer() ctx: any,
  ) {
    return this.changeRequestsService.create(id, dto, makePseudoUser(ctx));
  }

  @Get("orders/:id/change-requests")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "List change requests filed against an order" })
  listChangeRequests(@Param("id") id: string, @CurrentBuyerCustomer() ctx: any) {
    return this.changeRequestsService.listForOrder(id, makePseudoUser(ctx));
  }

  @Post("orders/:id/cancel")
  @HttpCode(HttpStatus.OK)
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Cancel a DRAFT or PENDING order" })
  async cancelOrder(@Param("id") id: string, @CurrentBuyerCustomer() ctx: any) {
    await this.ordersService.changeStatus(
      id,
      { status: OrderStatus.CANCELLED },
      makePseudoUser(ctx),
    );
    return { message: "Order cancelled" };
  }

  // ─── Dashboard ────────────────────────────────────────────────────────────────

  @Get("dashboard")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Dashboard data: recent orders, frequent items, spend stats" })
  getDashboard(@CurrentBuyerCustomer() ctx: any, @Query("frequentWindow") frequentWindow?: string) {
    const validWindows = ["30d", "90d", "all"];
    const window = validWindows.includes(frequentWindow ?? "")
      ? (frequentWindow as "30d" | "90d" | "all")
      : "all";
    return this.dashboardService.getDashboard(ctx.customerId, window);
  }

  @Get("replenishment")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({
    summary: "Per-product replenishment estimates (cadence, days-left, suggested qty)",
  })
  getReplenishment(@CurrentBuyerCustomer() ctx: any) {
    return this.replenishmentService.estimates(ctx.customerId);
  }

  // ─── Your Shelf (P5-06/07) ────────────────────────────────────────────────────
  // NOTE: the route-day/cutoff delivery calendar from the P5-06 acceptance is
  // DEFERRED — there is no delivery-schedule model in schema.prisma. The
  // data-backed portion (the open-order card via `activeOrder`) is served here.

  @Get("shelf")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({
    summary: "Your Shelf: snooze-overlaid replenishment estimates + open-order summary",
  })
  async getShelf(@CurrentBuyerCustomer() ctx: any) {
    const [estimates, active] = await Promise.all([
      this.shelfService.shelf(ctx.customerId),
      this.ordersService.findActiveOrder(ctx.customerId),
    ]);
    return {
      estimates,
      // Stored money only — total is read back, never computed here.
      activeOrder: active
        ? {
            id: active.id,
            orderNumber: active.orderNumber ?? null,
            itemCount: active.lineItems.length,
            total: Number(active.total),
          }
        : null,
    };
  }

  @Post("replenishment/:productId/snooze")
  @HttpCode(HttpStatus.OK)
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Snooze a replenishment suggestion for one cycle" })
  snoozeReplenishment(@Param("productId") productId: string, @CurrentBuyerCustomer() ctx: any) {
    return this.shelfService.snooze(ctx.customerId, productId, ctx.tenantId);
  }

  @Delete("replenishment/:productId/snooze")
  @HttpCode(HttpStatus.OK)
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Remove a replenishment snooze" })
  unsnoozeReplenishment(@Param("productId") productId: string, @CurrentBuyerCustomer() ctx: any) {
    return this.shelfService.unsnooze(ctx.customerId, productId);
  }

  @Post("shelf/add-all-low")
  @HttpCode(HttpStatus.OK)
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Seed the cart with every running-low item at its suggested qty" })
  async addAllLow(@CurrentBuyerCustomer() ctx: any) {
    const items = await this.shelfService.lowItems(ctx.customerId);
    if (items.length === 0) {
      // No low items — no-op: return the active order (or null) unchanged.
      const active = await this.ordersService.findActiveOrder(ctx.customerId);
      return redactUpsellForCustomer(active);
    }
    // Delegate to the EXACT create/merge path the buyer cart uses (@Post("orders")):
    // pricing, active-order merge and the pending-sweep are inherited, never re-implemented.
    return this.createOrder({ items } as BuyerCreateOrderDto, ctx);
  }

  @Get("promotions")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Active merchandising promotions at the selected seller" })
  getPromotions() {
    // Tenant is set by the interceptor; returns only in-window active promos.
    return this.promotionsService.activeForCatalog();
  }

  // ─── Buyer self-profile ───────────────────────────────────────────────────────

  @Get("me")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Get authenticated buyer's own profile" })
  getMe(@CurrentBuyerCustomer() ctx: any) {
    return ctx.customer;
  }

  @Patch("me")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Update authenticated buyer's own profile" })
  updateMe(@CurrentBuyerCustomer() ctx: any, @Body() dto: UpdateBuyerProfileDto) {
    // SECURITY (F4-001): dto is a strict buyer-profile DTO — seller-controlled
    // commercial fields (pricingTier/creditLimit/isTaxExempt/...) are not part of
    // it, so the ValidationPipe rejects them and update() can only touch profile.
    return this.customersService.update(ctx.customerId, dto);
  }

  // ─── Order templates ──────────────────────────────────────────────────────────

  @Get("templates")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "List buyer's standing order templates" })
  getTemplates(@CurrentBuyerCustomer() ctx: any) {
    // Pass OPERATOR role + customerId to avoid userId-based customer lookup
    // (buyer-portal-only accounts may have userId=null on the Customer record).
    return this.templatesService.findAllForUser(
      makePseudoUser({ ...ctx, role: UserRole.OPERATOR }),
      ctx.customerId,
    );
  }

  @Get("standing-orders")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({
    summary: "Alias: list buyer's standing order templates (same as /buyer/templates)",
  })
  getStandingOrders(@CurrentBuyerCustomer() ctx: any) {
    // Pass OPERATOR role + customerId to avoid userId-based customer lookup.
    return this.templatesService.findAllForUser(
      makePseudoUser({ ...ctx, role: UserRole.OPERATOR }),
      ctx.customerId,
    );
  }

  @Post("templates/:id/reorder")
  @HttpCode(HttpStatus.OK)
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Generate a new order from a standing order template" })
  async reorderFromTemplate(@Param("id") id: string, @CurrentBuyerCustomer() ctx: any) {
    // Ownership check: verify the template belongs to this buyer's customer
    const template = await this.prisma
      .forTenant()
      .orderTemplate.findFirst({ where: { id }, select: { customerId: true } });
    if (!template) throw new NotFoundException("Template not found");
    if (template.customerId !== ctx.customerId) {
      throw new ForbiddenException("This template does not belong to your account");
    }
    return this.templatesService.generateOrder(id);
  }

  @Patch("templates/:id")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Update a standing order template (e.g. pause/resume)" })
  async updateTemplate(
    @Param("id") id: string,
    @Body() dto: { isActive?: boolean },
    @CurrentBuyerCustomer() ctx: any,
  ) {
    const template = await this.prisma
      .forTenant()
      .orderTemplate.findFirst({ where: { id }, select: { customerId: true } });
    if (!template) throw new NotFoundException("Template not found");
    if (template.customerId !== ctx.customerId) {
      throw new ForbiddenException("This template does not belong to your account");
    }
    return this.templatesService.updateForUser(id, dto, makePseudoUser(ctx));
  }

  // ─── Analytics ───────────────────────────────────────────────────────────────

  @Get("analytics")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({
    summary: "Buyer financial analytics: monthly spend, invoice breakdown, payments",
  })
  async getAnalytics(@CurrentBuyerCustomer() ctx: any) {
    const db = this.prisma.forTenant();
    const customerId: string = ctx.customerId;

    // Monthly spend — last 12 months of non-cancelled orders
    const twelveMonthsAgo = new Date();
    twelveMonthsAgo.setMonth(twelveMonthsAgo.getMonth() - 11);
    twelveMonthsAgo.setDate(1);
    twelveMonthsAgo.setHours(0, 0, 0, 0);

    const orders = await db.order.findMany({
      where: {
        customerId,
        status: { notIn: ["CANCELLED", "DRAFT"] },
        createdAt: { gte: twelveMonthsAgo },
      },
      select: { createdAt: true, total: true },
      orderBy: { createdAt: "asc" },
    });

    // Aggregate by month (YYYY-MM)
    const monthMap = new Map<string, { spend: number; orderCount: number }>();
    for (const o of orders) {
      const key = `${o.createdAt.getFullYear()}-${String(o.createdAt.getMonth() + 1).padStart(2, "0")}`;
      const existing = monthMap.get(key) ?? { spend: 0, orderCount: 0 };
      monthMap.set(key, {
        spend: existing.spend + Number(o.total),
        orderCount: existing.orderCount + 1,
      });
    }
    const monthlySpend = Array.from(monthMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, v]) => ({ month, spend: v.spend, orderCount: v.orderCount }));

    // Summary — all time
    const allOrders = await db.order.findMany({
      where: { customerId, status: { notIn: ["CANCELLED", "DRAFT"] } },
      select: { total: true },
    });
    const totalOrders = allOrders.length;
    const totalSpend = allOrders.reduce((s, o) => s + Number(o.total), 0);
    const avgOrderValue = totalOrders > 0 ? totalSpend / totalOrders : 0;

    // Invoice breakdown
    const invoices = await db.invoice.findMany({
      where: { customerId },
      select: { status: true, total: true, dueDate: true },
    });
    const now = new Date();
    let paidCount = 0,
      unpaidCount = 0,
      overdueCount = 0,
      unpaidTotal = 0;
    for (const inv of invoices) {
      if (inv.status === "PAID") {
        paidCount++;
      } else if (
        inv.status === "SENT" ||
        inv.status === "VIEWED" ||
        inv.status === "PARTIAL" ||
        inv.status === "OVERDUE"
      ) {
        if (inv.status === "OVERDUE" || (inv.dueDate && inv.dueDate < now)) {
          overdueCount++;
        } else {
          unpaidCount++;
        }
        unpaidTotal += Number(inv.total);
      }
    }

    // Recent payments (last 20)
    const payments = await db.invoicePayment.findMany({
      where: { invoice: { customerId } },
      include: { invoice: { select: { invoiceNumber: true } } },
      orderBy: { paidAt: "desc" },
      take: 20,
    });
    const recentPayments = payments.map((p) => ({
      date: p.paidAt.toISOString(),
      amount: Number(p.amount),
      method: p.method,
      invoiceNumber: p.invoice.invoiceNumber,
    }));

    return {
      monthlySpend,
      summary: {
        totalOrders,
        totalSpend,
        avgOrderValue,
        unpaidInvoiceCount: unpaidCount + overdueCount,
        unpaidInvoiceTotal: unpaidTotal,
      },
      invoiceBreakdown: { paid: paidCount, unpaid: unpaidCount, overdue: overdueCount },
      recentPayments,
    };
  }

  // ─── Favorites ──────────────────────────────────────────────────────────────

  @Get("favorites")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "List buyer's favorite products at this seller" })
  getFavorites(@CurrentBuyer() buyer: BuyerJwtPayload, @CurrentBuyerCustomer() ctx: any) {
    return this.catalogService.getFavorites(buyer.sub, ctx.customerId);
  }

  @Post("favorites/:productId")
  @HttpCode(HttpStatus.CREATED)
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Add a product to favorites" })
  addFavorite(
    @Param("productId") productId: string,
    @CurrentBuyer() buyer: BuyerJwtPayload,
    @CurrentBuyerCustomer() ctx: any,
  ) {
    return this.catalogService.addFavorite(buyer.sub, ctx.customerId, productId, ctx.tenantId);
  }

  @Delete("favorites/:productId")
  @HttpCode(HttpStatus.OK)
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Remove a product from favorites" })
  removeFavorite(
    @Param("productId") productId: string,
    @CurrentBuyer() buyer: BuyerJwtPayload,
    @CurrentBuyerCustomer() ctx: any,
  ) {
    return this.catalogService.removeFavorite(buyer.sub, ctx.customerId, productId);
  }

  // ─── Stock alerts / Notify-me (P5-03) ────────────────────────────────────────

  @Get("stock-alerts")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Product ids the buyer has a PENDING restock alert on" })
  getStockAlerts(@CurrentBuyerCustomer() ctx: any) {
    return this.stockAlertService.subscriptionsFor(ctx.customerId);
  }

  @Post("products/:productId/stock-alert")
  @HttpCode(HttpStatus.OK)
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Subscribe to a restock alert (idempotent upsert)" })
  subscribeStockAlert(@Param("productId") productId: string, @CurrentBuyerCustomer() ctx: any) {
    return this.stockAlertService.subscribe(ctx.customerId, productId, ctx.tenantId);
  }

  @Delete("products/:productId/stock-alert")
  @HttpCode(HttpStatus.OK)
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Cancel a restock alert" })
  unsubscribeStockAlert(@Param("productId") productId: string, @CurrentBuyerCustomer() ctx: any) {
    return this.stockAlertService.unsubscribe(ctx.customerId, productId);
  }

  // ─── Licenses & Authorizations (W6b — buyer self-serve) ────────────────────────

  @Get("authorizations")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({
    summary: "List this seller's license-required categories with the buyer's status for each",
  })
  listAuthorizations(@CurrentBuyerCustomer() ctx: any) {
    return this.authorizationsService.listForBuyer(ctx.customerId);
  }

  @Post("authorizations")
  @HttpCode(HttpStatus.OK)
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({
    summary: "Submit or renew a license for review (RETAILER_SUBMITTED → PENDING_REVIEW)",
  })
  submitAuthorization(@CurrentBuyerCustomer() ctx: any, @Body() dto: SubmitAuthorizationDto) {
    return this.authorizationsService.submit(ctx.customerId, dto);
  }
}
