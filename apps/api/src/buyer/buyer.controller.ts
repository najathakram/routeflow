import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiHeader } from "@nestjs/swagger";
import { OrderStatus, UserRole, UserStatus } from "@prisma/client";
import { BuyerService } from "./buyer.service";
import { BuyerCatalogService } from "./buyer-catalog.service";
import { BuyerDashboardService } from "./buyer-dashboard.service";
import { BuyerJwtAuthGuard, PublicBuyer } from "./guards/buyer-jwt-auth.guard";
import { BuyerSellerContextGuard } from "./guards/buyer-seller-context.guard";
import { BuyerTenantInterceptor } from "./buyer-tenant.interceptor";
import { CurrentBuyer, CurrentBuyerCustomer } from "./decorators/current-buyer.decorator";
import type { BuyerJwtPayload } from "./interfaces/buyer-jwt-payload.interface";
import { ForbiddenException, NotFoundException } from "@nestjs/common";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { RequestSellerDto } from "./dto/request-seller.dto";
import { PrismaService } from "../prisma/prisma.service";
import { BuyerCreateOrderDto } from "./dto/buyer-create-order.dto";
import { OrdersService } from "../orders/orders.service";
import { InvoicesService } from "../invoices/invoices.service";
import { CustomersService } from "../customers/customers.service";
import { OrderTemplatesService } from "../order-templates/order-templates.service";
import { ListOrdersDto } from "../orders/dto/list-orders.dto";
import { ListInvoicesDto } from "../invoices/dto/list-invoices.dto";
import { UpdateOrderItemsDto } from "../orders/dto/update-order-items.dto";

/**
 * Builds a JwtPayload that looks like a CUSTOMER user.
 * Used so existing tenant services can scope their queries correctly:
 *   - `sub`      → User.id (the Customer's user account)
 *   - `role`     → CUSTOMER (triggers per-customer filtering in services)
 *   - `tenantId` → from BuyerSellerContextGuard (set by BuyerTenantInterceptor ALS run)
 */
function makePseudoUser(ctx: { userId: string; tenantId: string; tenantSlug: string }): JwtPayload {
  return {
    sub: ctx.userId,
    username: "",
    role: UserRole.CUSTOMER,
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
  constructor(
    private readonly buyerService: BuyerService,
    private readonly catalogService: BuyerCatalogService,
    private readonly dashboardService: BuyerDashboardService,
    private readonly ordersService: OrdersService,
    private readonly invoicesService: InvoicesService,
    private readonly customersService: CustomersService,
    private readonly templatesService: OrderTemplatesService,
    private readonly prisma: PrismaService,
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
  getOrders(@CurrentBuyerCustomer() ctx: any, @Query() query: ListOrdersDto) {
    return this.ordersService.findAll(query, makePseudoUser(ctx));
  }

  @Get("invoices")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "List buyer's invoices at the selected seller" })
  getInvoices(@CurrentBuyerCustomer() ctx: any, @Query() query: ListInvoicesDto) {
    return this.invoicesService.findAll(query, makePseudoUser(ctx));
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

  // ─── Product catalog ──────────────────────────────────────────────────────────

  @Get("products/categories")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "List distinct product categories for filter dropdowns" })
  getCategories() {
    return this.catalogService.getCategories();
  }

  @Get("products")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Browse product catalog with buyer-specific pricing" })
  getProducts(
    @CurrentBuyerCustomer() ctx: any,
    @Query("search") search?: string,
    @Query("category") category?: string,
    @Query("page") page?: string,
    @Query("limit") limit?: string,
    @Query("sort") sort?: string,
  ) {
    const parsedPage = page ? Number(page) : undefined;
    const parsedLimit = limit ? Number(limit) : undefined;
    return this.catalogService.getCatalog(
      {
        search,
        category,
        page: Number.isFinite(parsedPage) && parsedPage! >= 1 ? parsedPage : undefined,
        limit: Number.isFinite(parsedLimit) && parsedLimit! >= 1 ? parsedLimit : undefined,
        sort,
      },
      ctx.customerId,
    );
  }

  @Get("products/:id")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Get single product detail with buyer-specific pricing" })
  getProduct(@Param("id") id: string, @CurrentBuyerCustomer() ctx: any) {
    return this.catalogService.getProductDetail(id, ctx.customerId);
  }

  // ─── Order CRUD ───────────────────────────────────────────────────────────────

  @Get("orders/active")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Get the buyer's active DRAFT/PENDING order (or null)" })
  getActiveOrder(@CurrentBuyerCustomer() ctx: any) {
    return this.ordersService.findActiveOrder(ctx.customerId);
  }

  @Get("orders/:id")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Get order detail with line items" })
  getOrder(@Param("id") id: string, @CurrentBuyerCustomer() ctx: any) {
    return this.ordersService.findOne(id, makePseudoUser(ctx));
  }

  @Post("orders")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Create a new order or merge into existing active order" })
  async createOrder(@Body() dto: BuyerCreateOrderDto, @CurrentBuyerCustomer() ctx: any) {
    // Check if buyer has an active DRAFT/PENDING order (unless forceNew is set)
    if (!dto.forceNew) {
      const activeOrder = await this.ordersService.findActiveOrder(ctx.customerId);
      if (activeOrder) {
        // Merge: combine existing items with new cart items
        const mergedMap = new Map<string, number>();
        for (const li of activeOrder.lineItems) {
          mergedMap.set(li.productId, Number(li.qty));
        }
        for (const item of dto.items) {
          mergedMap.set(item.productId, (mergedMap.get(item.productId) ?? 0) + item.qty);
        }
        const mergedItems = Array.from(mergedMap.entries()).map(([productId, qty]) => ({
          productId,
          qty,
        }));

        // Update existing order items with merged list
        await this.ordersService.updateOrderItems(
          activeOrder.id,
          { items: mergedItems } as any,
          makePseudoUser(ctx),
        );

        // Return the updated order
        return this.ordersService.findOne(activeOrder.id, makePseudoUser(ctx));
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
    return this.ordersService.create(createDto as any, makePseudoUser(ctx));
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

  @Post("orders/:id/cancel")
  @HttpCode(HttpStatus.OK)
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Cancel a DRAFT or PENDING order" })
  async cancelOrder(@Param("id") id: string, @CurrentBuyerCustomer() ctx: any) {
    // Cancel then immediately delete — buyer-cancelled orders shouldn't linger
    await this.ordersService.changeStatus(
      id,
      { status: OrderStatus.CANCELLED },
      makePseudoUser(ctx),
    );
    await this.ordersService.deleteOrder(id);
    return { message: "Order cancelled and removed" };
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

  // ─── Order templates ──────────────────────────────────────────────────────────

  @Get("templates")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "List buyer's standing order templates" })
  getTemplates(@CurrentBuyerCustomer() ctx: any) {
    return this.templatesService.findAllForUser(makePseudoUser(ctx));
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
      .orderTemplate.findUnique({ where: { id }, select: { customerId: true } });
    if (!template) throw new NotFoundException("Template not found");
    if (template.customerId !== ctx.customerId) {
      throw new ForbiddenException("This template does not belong to your account");
    }
    return this.templatesService.generateOrder(id);
  }

  // ─── Analytics ───────────────────────────────────────────────────────────────

  @Get("analytics")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Buyer financial analytics: monthly spend, invoice breakdown, payments" })
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
      monthMap.set(key, { spend: existing.spend + Number(o.total), orderCount: existing.orderCount + 1 });
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
    let paidCount = 0, unpaidCount = 0, overdueCount = 0, unpaidTotal = 0;
    for (const inv of invoices) {
      if (inv.status === "PAID") {
        paidCount++;
      } else if (inv.status === "SENT" || inv.status === "VIEWED" || inv.status === "PARTIAL" || inv.status === "OVERDUE") {
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
      summary: { totalOrders, totalSpend, avgOrderValue, unpaidInvoiceCount: unpaidCount + overdueCount, unpaidInvoiceTotal: unpaidTotal },
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
}
