import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  UseGuards,
  UseInterceptors,
} from "@nestjs/common";
import { ApiTags, ApiOperation, ApiBearerAuth, ApiHeader } from "@nestjs/swagger";
import { UserRole, UserStatus } from "@prisma/client";
import { BuyerService } from "./buyer.service";
import { BuyerJwtAuthGuard, PublicBuyer } from "./guards/buyer-jwt-auth.guard";
import { BuyerSellerContextGuard } from "./guards/buyer-seller-context.guard";
import { BuyerTenantInterceptor } from "./buyer-tenant.interceptor";
import { CurrentBuyer, CurrentBuyerCustomer } from "./decorators/current-buyer.decorator";
import type { BuyerJwtPayload } from "./interfaces/buyer-jwt-payload.interface";
import type { JwtPayload } from "../auth/jwt-payload.interface";
import { RequestSellerDto } from "./dto/request-seller.dto";
import { OrdersService } from "../orders/orders.service";
import { InvoicesService } from "../invoices/invoices.service";
import { CustomersService } from "../customers/customers.service";
import { ListOrdersDto } from "../orders/dto/list-orders.dto";
import { ListInvoicesDto } from "../invoices/dto/list-invoices.dto";

/**
 * Builds a JwtPayload that looks like a CUSTOMER user.
 * Used so existing tenant services can scope their queries correctly:
 *   - `sub`      → User.id (the Customer's user account)
 *   - `role`     → CUSTOMER (triggers per-customer filtering in services)
 *   - `tenantId` → from BuyerSellerContextGuard (set by BuyerTenantInterceptor ALS run)
 */
function makePseudoUser(ctx: {
  userId: string;
  tenantId: string;
  tenantSlug: string;
}): JwtPayload {
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
    private readonly ordersService: OrdersService,
    private readonly invoicesService: InvoicesService,
    private readonly customersService: CustomersService,
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

  @Get("statement")
  @UseGuards(BuyerSellerContextGuard)
  @UseInterceptors(BuyerTenantInterceptor)
  @ApiHeader({ name: "X-Tenant-Slug", required: true })
  @ApiOperation({ summary: "Get buyer's account statement at the selected seller" })
  getStatement(@CurrentBuyerCustomer() ctx: any) {
    return this.customersService.getStatementForOperator(ctx.customerId);
  }
}
